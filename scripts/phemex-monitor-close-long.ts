#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-monitor-close-long.ts  —  Monitor XBRUSDT long position in an
 * infinite loop and ensure a reduce-only Sell limit order at $86 exists
 * to close it.
 *
 * Polls positions every 30s.  If there is an open long on XBRUSDT and no
 * active reduce-only Sell order at $86, places one.  Once the position is
 * closed (or the order fills) the loop logs the state and continues.
 *
 * Usage:
 *   ./phemex-monitor-close-long.ts
 *   ./phemex-monitor-close-long.ts --interval 60
 *   ./phemex-monitor-close-long.ts --price 88
 *   ./phemex-monitor-close-long.ts --dry-run
 *   ./phemex-monitor-close-long.ts --once          # single check, no loop
 *   ./phemex-monitor-close-long.ts --help, -h
 */

import fs from "node:fs";
import { base64UrlDecode, request } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import { fetchPositions } from "../src/positions.js";
import { fetchUntriggeredOrders } from "../src/untriggered-orders.js";
import { uuid } from "../src/uuid.js";

const CREDS_FILE = ".phemex-credentials.json";
const SYMBOL = "XBRUSDT";
const CLOSE_PRICE = 86;
const DEFAULT_INTERVAL_SEC = 30;
const LAST_TXT = "last.txt";
const ANCHOR_QTY = 1; // keep at least 1 XBR at the anchor price

// Track the last-known price so we can detect changes from last.txt
let _lastPrice: number | undefined;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

/** Read the close price from last.txt, or return undefined. */
function readLastPrice(): number | undefined {
  try {
    const raw = fs.readFileSync(LAST_TXT, "utf-8").trim();
    const v = parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function usage(): never {
  console.log(`
Usage: ./phemex-monitor-close-long.ts [options]

Monitor XBRUSDT long position and ensure a reduce-only Sell limit order
 at the price from last.txt is always active, subtracting any existing
 untriggered close-long qty from the position size.

Options:
  --price <n>       Close-order limit price (default: read from last.txt, then ${CLOSE_PRICE})
  --interval <sec>  Polling interval in seconds (default: ${DEFAULT_INTERVAL_SEC})
  --dry-run         Print what would be done without placing any orders
  --once            Run once and exit (no infinite loop)
  --help, -h        Show this help message

Examples:
  ./phemex-monitor-close-long.ts
  ./phemex-monitor-close-long.ts --interval 60 --price 85
  ./phemex-monitor-close-long.ts --once --dry-run
  echo 79.38 > last.txt && ./phemex-monitor-close-long.ts
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Active-orders fetch (same pattern as phemex-limit-rungs.ts)       */
/* ------------------------------------------------------------------ */

/** Fetch all active orders for a symbol (ordStatus=New + Untriggered). */
async function fetchActiveOrders(
  symbol: string,
  apiKey: string,
  secretRaw: Buffer,
): Promise<Record<string, unknown>[]> {
  const isUsdtM = symbol.toUpperCase().endsWith("USDT");
  const endpoint = isUsdtM ? "/g-orders/activeList" : "/orders/activeList";
  const merged = new Map<string, Record<string, unknown>>();

  for (const ordStatus of ["New", "Untriggered"]) {
    const resp = (await request(
      "GET",
      endpoint,
      `ordStatus=${ordStatus}&symbol=${symbol}`,
      apiKey,
      secretRaw,
      "",
    )) as Record<string, unknown>;

    // code 10002 / "OM_ORDER_NOT_FOUND" means no orders — not an error
    if (resp.code !== 0 && resp.code !== 10002) {
      console.error(`  ✗  API error fetching ${ordStatus} orders: ${String(resp.msg ?? resp.code)}`);
      continue;
    }
    const data = resp.data as Record<string, unknown> | undefined;
    const rows = (data?.rows as Record<string, unknown>[] | undefined) ?? [];
    for (const row of rows) {
      const oid = String(row.orderID ?? "");
      if (oid) merged.set(oid, row);
    }
  }
  return [...merged.values()];
}

/* ------------------------------------------------------------------ */
/*  Reduce-only order placement (same pattern as phemex-limit-rungs)  */
/* ------------------------------------------------------------------ */

interface ReduceOnlyOrderParams {
  symbol: string;
  side: "Buy" | "Sell";
  price: number;
  qty: number;
  posSide: "Long" | "Short";
}

interface PlaceOrderResult {
  orderID?: string;
  clOrdID?: string;
  ordStatus?: string;
  [key: string]: unknown;
}

/** Place a reduce-only USDT-M limit order (closes, never opens). */
async function placeLinearReduceOnly(
  params: ReduceOnlyOrderParams,
  apiKey: string,
  secretRaw: Buffer,
): Promise<PlaceOrderResult> {
  const clOrdID = uuid();
  const paramsList: string[] = [
    `symbol=${params.symbol}`,
    `side=${params.side}`,
    `posSide=${params.posSide}`,
    `ordType=Limit`,
    `timeInForce=GoodTillCancel`,
    `priceRp=${params.price}`,
    `orderQtyRq=${params.qty}`,
    `clOrdID=${clOrdID}`,
    `reduceOnly=true`,
  ];
  const query = paramsList.join("&");

  const resp = (await request(
    "PUT",
    "/g-orders/create",
    query,
    apiKey,
    secretRaw,
    "",
  )) as Record<string, unknown>;

  if (resp.code !== 0) throw new Error(String(resp.msg ?? `API code ${resp.code}`));
  const data = resp.data as PlaceOrderResult | undefined;
  if (!data) throw new Error("Empty response data");
  return data;
}

/* ------------------------------------------------------------------ */
/*  Cancel close-long orders                                          */
/* ------------------------------------------------------------------ */

/**
 * Cancel all reduce-only Sell (close-long) untriggered orders for the symbol,
 * optionally skipping orders at a given price (e.g. the $86 anchor).
 * Returns the total qty that was cancelled.
 */
async function cancelCloseLongs(
  apiKey: string,
  secretRaw: Buffer,
  skipPrice?: number,
): Promise<number> {
  const untriggered = await fetchUntriggeredOrders(SYMBOL, apiKey, secretRaw);
  const targets = untriggered.filter(
    (o) =>
      o.side === "Sell" &&
      (/reduceonly/i.test(String(o.raw.execInst ?? "")) || o.raw.reduceOnly === true) &&
      (skipPrice === undefined || Math.abs(parseFloat(o.price || "0") - skipPrice) >= 0.01),
  );
  if (targets.length === 0) return 0;

  const totalQty = targets.reduce((sum, o) => sum + parseFloat(o.qty || "0"), 0);
  const skipLabel = skipPrice !== undefined ? ` (keeping orders at $${skipPrice})` : "";
  console.log(`[${fmtTime()}]  ⟐  Cancelling ${targets.length} close-long order(s)${skipLabel} (total qty ${totalQty.toFixed(4)}) …`);

  let ok = 0;
  let fail = 0;
  for (const o of targets) {
    const orderId = o.orderID;
    const qp = new URLSearchParams({ orderID: orderId, symbol: SYMBOL });
    qp.set("posSide", "Long");
    qp.set("untriggered", "true");

    process.stdout.write(`[${fmtTime()}]    ${orderId}  …  `);
    try {
      const resp = (await request("DELETE", "/g-orders", qp.toString(), apiKey, secretRaw, "")) as Record<string, unknown>;
      const data = resp.data as { bizError?: number }[] | undefined;
      const bizError = data?.[0]?.bizError;
      if (resp.code === 0 && (bizError === undefined || bizError === 0)) {
        console.log("✓");
        ok++;
      } else {
        console.log(`✗  ${String(resp.msg ?? `bizError ${bizError}`)}`);
        fail++;
      }
    } catch (err: unknown) {
      console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
      fail++;
    }
  }
  console.log(`[${fmtTime()}]  ✔  ${ok} cancelled, ${fail} failed.`);
  return ok > 0 ? totalQty : 0;
}

/* ------------------------------------------------------------------ */
/*  Core logic: check and place                                       */
/* ------------------------------------------------------------------ */

/**
 * Check whether a reduce-only Sell order at the target price already
 * exists among the active orders.
 */
function hasCloseLongOrder(
  orders: Record<string, unknown>[],
  targetPrice: number,
): boolean {
  return orders.some((o) => {
    // Must be a reduce-only Sell order
    const isReduceOnly =
      /reduceonly/i.test(String(o.execInst ?? "")) || o.reduceOnly === true;
    if (!isReduceOnly) return false;
    if (String(o.side ?? "").toLowerCase() !== "sell") return false;
    // Price must match (within 1 cent to allow for rounding)
    const price = parseFloat(String(o.priceRp ?? o.price ?? ""));
    if (Number.isNaN(price)) return false;
    return Math.abs(price - targetPrice) < 0.01;
  });
}

/**
 * Run one check cycle: fetch positions, check for a close-long order,
 * and place one if missing.
 *
 * @returns true if a close-long order was placed (or would have been
 *          placed in dry-run mode), false otherwise.
 */
async function checkAndPlace(
  dryRun: boolean,
  closePrice: number,
): Promise<boolean> {
  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  // 1. Fetch positions
  const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
  // console.dir(positions, { depth: null, colors: true });

  // 1a. Print the position table
  if (positions.length === 0) {
    console.log(`[${fmtTime()}]  ℹ  No open positions.`);
  } else {
    console.log(
      `\n${"Symbol".padEnd(12)} ${"Side".padEnd(7)} ${"Size".padStart(10)} ` +
      `${"Entry Price".padStart(14)} ${"Mark Price".padStart(14)} ${"Value".padStart(14)} ` +
      `${"P&L".padStart(12)} ${"Leverage".padStart(9)} ${"Liq. Price".padStart(14)} ${"Margin".padStart(12)} ${"Mgn Ratio".padStart(10)}`
    );
    console.log("─".repeat(150));

    for (const p of positions) {
      const entry = parseFloat(p.avgEntryPrice || "0");
      const mark = parseFloat(p.markPriceRp || "0");
      const size = parseFloat(p.size || "0");
      const value = parseFloat(p.valueRv || "0") / 10000;
      const pnl = (mark - entry) * size;
      const lev = p.leverageRr ? Math.abs(parseFloat(p.leverageRr)) : 0;
      const liq = parseFloat(p.liqPriceRp || "0");
      const margin = parseFloat(p.posCostRv || "0") / 10000;

      const maintMargin = parseFloat(p.valueRv || "0") * parseFloat(p.maintMarginReqRr || "0");
      const marginRatio = maintMargin / parseFloat(p.assignedPosBalanceRv || "1");

      const sideFmt = p.side.padEnd(6);
      const sizeFmt = size.toFixed(4).padStart(10);
      const entryFmt = entry.toFixed(2).padStart(14);
      const markFmt = mark.toFixed(2).padStart(14);
      const valueFmt = value.toFixed(2).padStart(14);
      const pnlFmt = (pnl >= 0 ? "+" : "") + pnl.toFixed(2).padStart(11);
      const levFmt = (lev === 0 ? "∞" : lev.toFixed(1)).padStart(9);
      const liqFmt = liq.toFixed(2).padStart(14);
      const marginFmt = margin.toFixed(4).padStart(12);
      const ratioFmt = marginRatio.toFixed(4).padStart(10);

      console.log(
        `${p.symbol.padEnd(12)} ${sideFmt} ${sizeFmt} ${entryFmt} ${markFmt} ${valueFmt} ` +
        `${pnlFmt} ${levFmt} ${liqFmt} ${marginFmt} ${ratioFmt}`
      );
    }
    console.log("─".repeat(147));
  }

  const longPos = positions.find(
    (p) => p.symbol === SYMBOL && p.side === "Buy",
  );

  if (!longPos) {
    console.log(`[${fmtTime()}]  ℹ  No open long position on ${SYMBOL}.`);
    return false;
  }

  const posSize = parseFloat(longPos.size || "0");

  const ANCHOR_PRICE = 86;

  // 2. Determine existing close-long qty, cancelling if price changed
  const untriggered = await fetchUntriggeredOrders(SYMBOL, creds.PHEMEX_API_KEY, secretRaw);
  const nonAnchorCloseLongs = untriggered.filter(
    (o) =>
      o.side === "Sell" &&
      (/reduceonly/i.test(String(o.raw.execInst ?? "")) || o.raw.reduceOnly === true) &&
      Math.abs(parseFloat(o.price || "0") - ANCHOR_PRICE) >= 0.01,
  );

  // Price changed when _lastPrice differs, or on first run when non-anchor
  // orders exist at a price other than the current closePrice.
  const priceChanged =
    (_lastPrice !== undefined && Math.abs(closePrice - _lastPrice) >= 0.001) ||
    (_lastPrice === undefined && nonAnchorCloseLongs.some(
      (o) => Math.abs(parseFloat(o.price || "0") - closePrice) >= 0.01,
    ));

  let existingCloseQty: number;
  let anchorQty: number;

  if (priceChanged) {
    // Keep the anchor order at $86; cancel all other close-long orders
    console.log(`[${fmtTime()}]  ⟐  Price changed from $${(_lastPrice ?? "?").toString()} → $${closePrice.toFixed(2)} — cancelling non-anchor close-long orders …`);
    const cancelled = dryRun ? 0 : await cancelCloseLongs(creds.PHEMEX_API_KEY, secretRaw, ANCHOR_PRICE);
    if (dryRun) {
      console.log(`[${fmtTime()}]  🔷  DRY RUN — would cancel non-anchor close-long orders and re-place at $${closePrice}`);
    } else {
      console.log(`[${fmtTime()}]  ⟐  Cancelled ${cancelled.toFixed(4)} worth of close-long orders (keeping $${ANCHOR_PRICE} anchor).`);
    }
    // Re-fetch to get the anchor qty still active
    const remainingOrders = await fetchUntriggeredOrders(SYMBOL, creds.PHEMEX_API_KEY, secretRaw);
    anchorQty = remainingOrders
      .filter((o) => /reduceonly/i.test(String(o.raw.execInst ?? "")) || o.raw.reduceOnly === true)
      .filter((o) => o.side === "Sell")
      .filter((o) => Math.abs(parseFloat(o.price || "0") - ANCHOR_PRICE) < 0.01)
      .reduce((sum, o) => sum + parseFloat(o.qty || "0"), 0);
    existingCloseQty = anchorQty;
    console.log(`[${fmtTime()}]  ⟐  Anchor qty at $${ANCHOR_PRICE}: ${anchorQty.toFixed(4)}`);
  } else {
    existingCloseQty = untriggered
      .filter((o) => /reduceonly/i.test(String(o.raw.execInst ?? "")) || o.raw.reduceOnly === true)
      .filter((o) => o.side === "Sell")
      .reduce((sum, o) => sum + parseFloat(o.qty || "0"), 0);
    anchorQty = untriggered
      .filter((o) => /reduceonly/i.test(String(o.raw.execInst ?? "")) || o.raw.reduceOnly === true)
      .filter((o) => o.side === "Sell")
      .filter((o) => Math.abs(parseFloat(o.price || "0") - ANCHOR_PRICE) < 0.01)
      .reduce((sum, o) => sum + parseFloat(o.qty || "0"), 0);
  }

  _lastPrice = closePrice;

  const remaining = Math.max(0, Math.round((posSize - existingCloseQty) * 10_000) / 10_000);

  console.log(
    `[${fmtTime()}]  ⟐  posSize=${posSize.toFixed(4)}, existingCloseQty=${existingCloseQty.toFixed(4)}, remaining=${remaining.toFixed(4)}`,
  );

  if (remaining <= 0) {
    console.log(`[${fmtTime()}]  ✓  Close-long orders already cover the full position (${existingCloseQty.toFixed(4)} >= ${posSize.toFixed(4)}).`);
    return false;
  }

  // 3. Placement — ensure the $86 anchor exists first, then place the
  //    remainder at the last.txt price.

  if (dryRun) {
    const anchorShortfall = Math.max(0, ANCHOR_QTY - anchorQty);
    const anchorRung = Math.min(anchorShortfall, remaining);
    if (anchorRung > 0) {
      console.log(
        `[${fmtTime()}]  🔷  DRY RUN — would place anchor: reduce-only Sell ${anchorRung} ${SYMBOL} @ $${ANCHOR_PRICE}`,
      );
    }
    const followQty = Math.max(0, Math.round((remaining - anchorRung) * 10_000) / 10_000);
    if (followQty > 0) {
      console.log(
        `[${fmtTime()}]  🔷  DRY RUN — would place: reduce-only Sell ${followQty} ${SYMBOL} @ $${closePrice}`,
      );
    }
    return true;
  }

  // Top up the anchor rung at $86 up to ANCHOR_QTY
  const anchorShortfall = Math.max(0, ANCHOR_QTY - anchorQty);
  let anchorRung = 0;
  if (anchorShortfall > 0 && remaining > 0) {
    anchorRung = Math.min(anchorShortfall, remaining);
    try {
      const result = await placeLinearReduceOnly(
        {
          symbol: SYMBOL,
          side: "Sell",
          price: ANCHOR_PRICE,
          qty: anchorRung,
          posSide: "Long",
        },
        creds.PHEMEX_API_KEY,
        secretRaw,
      );
      console.log(
        `[${fmtTime()}]  ✓  Placed anchor: reduce-only Sell ${anchorRung} ${SYMBOL} @ $${ANCHOR_PRICE} — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`,
      );
    } catch (err: unknown) {
      console.error(
        `[${fmtTime()}]  ✗  Failed to place anchor at $${ANCHOR_PRICE}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Place the remainder at the last.txt price
  const followQty = Math.max(0, Math.round((remaining - anchorRung) * 10_000) / 10_000);
  if (followQty <= 0) {
    console.log(`[${fmtTime()}]  ✓  Anchor covers the remaining qty — nothing else to place.`);
    return true;
  }

  try {
    const result = await placeLinearReduceOnly(
      {
        symbol: SYMBOL,
        side: "Sell",
        price: closePrice,
        qty: followQty,
        posSide: "Long",
      },
      creds.PHEMEX_API_KEY,
      secretRaw,
    );
    console.log(
      `[${fmtTime()}]  ✓  Placed reduce-only Sell ${followQty} ${SYMBOL} @ $${closePrice} — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`,
    );
    return true;
  } catch (err: unknown) {
    console.error(
      `[${fmtTime()}]  ✗  Failed to place close-long: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const dryRun = process.argv.includes("--dry-run");
  const once = process.argv.includes("--once");

  const priceIdx = process.argv.indexOf("--price");
  const closePrice =
    priceIdx !== -1
      ? parseFloat(process.argv[priceIdx + 1])
      : readLastPrice() ?? CLOSE_PRICE;
  if (!Number.isFinite(closePrice) || closePrice <= 0) {
    console.error(
      `✗  Invalid --price or last.txt: got "${closePrice}". Provide a valid price via --price <n> or write to last.txt`,
    );
    process.exit(1);
  }

  const priceSource = priceIdx !== -1
    ? `--price ${closePrice}`
    : `last.txt (${closePrice})`;

  const intervalIdx = process.argv.indexOf("--interval");
  const intervalSec =
    intervalIdx !== -1 ? parseFloat(process.argv[intervalIdx + 1]) : DEFAULT_INTERVAL_SEC;
  if (!Number.isFinite(intervalSec) || intervalSec < 5) {
    console.error("✗  --interval must be >= 5 seconds");
    process.exit(1);
  }

  console.log(
    `[${fmtTime()}] ═ ${SYMBOL} Close-Long Monitor ════════════════════════════════════`,
  );
  console.log(
    `[${fmtTime()}]   Target:  reduce-only Sell @ $${closePrice}${dryRun ? " (DRY RUN)" : ""}  (from ${priceSource})`,
  );
  if (!once) {
    console.log(`[${fmtTime()}]   Polling: every ${intervalSec}s (infinite loop)`);
    console.log(`[${fmtTime()}]   Press Ctrl+C to stop.`);
  }
  console.log(
    `[${fmtTime()}] ════════════════════════════════════════════════════════════════════`,
  );

  const priceFromArg = priceIdx !== -1;

  if (once) {
    await checkAndPlace(dryRun, closePrice);
    return;
  }

  // Infinite loop — re-read last.txt each cycle when the source is the file
  while (true) {
    const currentPrice = priceFromArg ? closePrice : (readLastPrice() ?? CLOSE_PRICE);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      console.error(`[${fmtTime()}]  ✗  Invalid price in last.txt — skipping cycle.`);
    } else {
      try {
        await checkAndPlace(dryRun, currentPrice);
      } catch (err: unknown) {
        console.error(
          `[${fmtTime()}]  ✗  Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    console.log(`[${fmtTime()}]  –  Sleeping ${intervalSec}s …`);
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});