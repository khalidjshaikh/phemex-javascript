#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-tp-to-index.ts — Review the open XBRUSDT position and adjust its
 * take-profit trigger price to the current Phemex index price (index.txt).
 *
 * The index price is written to index.txt by phemex-mark-price2.ts
 * (ticker.indexPriceRp, e.g. "82.27").
 *
 *   Long  position → reduce-only Sell LimitIfTouched @ index price
 *   Short position → reduce-only Buy  LimitIfTouched @ index price
 *
 * Any existing TP-type conditional orders (LimitIfTouched / MarketIfTouched)
 * for the symbol are cancelled first so the TP is adjusted rather than
 * stacked; stop-loss (Stop) orders are left untouched.
 *
 * Endpoint:  PUT /g-orders/create   (ordType=LimitIfTouched, reduceOnly=true)
 *
 * Usage:
 *   ./phemex-tp-to-index.ts
 *   ./phemex-tp-to-index.ts --loop
 *   ./phemex-tp-to-index.ts --symbol XBRUSDT --dry-run
 *   ./phemex-tp-to-index.ts --help, -h
 *
 * Options:
 *   --symbol <symbol>    Trading pair (default: XBRUSDT)
 *   --qty <size>         TP quantity (default: full position size)
 *   --loop               Repeat forever, waiting 1 second between runs
 *   --dry-run            Log what would be sent without sending anything
 *   --help, -h           Show this help message
 */

import fs from "node:fs";
import path from "node:path";
import { base64UrlDecode, request } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { cancelOrder } from "../src/place-limit-order.js";
import { fetchPositions, calcPnlPct } from "../src/positions.js";
import { fetchUntriggeredOrders, type UntriggeredOrder } from "../src/untriggered-orders.js";
import { uuid } from "../src/uuid.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_SYMBOL = "XBRUSDT";
const INDEX_FILE = path.resolve(__dirname, "..", "index.txt");
const LOOP_DELAY_MS = 1_000; // 1 second between runs (--loop)

function usage(): never {
  console.log(`
Usage: ./phemex-tp-to-index.ts [options]

Review the open position and adjust its take profit to the current Phemex
index price from index.txt (written by phemex-mark-price2.ts):

  Long  position → Sell  LimitIfTouched @ index price (reduce-only)
  Short position → Buy   LimitIfTouched @ index price (reduce-only)

Existing TP-type conditional orders for the symbol are replaced; stop-loss
orders are preserved. Trigger source: ByLastPrice.

Options:
  --symbol <symbol>    Trading pair (default: ${DEFAULT_SYMBOL})
  --qty <size>         TP quantity (default: full position size)
  --loop               Repeat forever, waiting ${LOOP_DELAY_MS / 1000} second between runs
  --dry-run            Log what would be sent without sending anything
  --help, -h           Show this help message

Examples:
  ./phemex-tp-to-index.ts
  ./phemex-tp-to-index.ts --loop
  ./phemex-tp-to-index.ts --symbol XBRUSDT --dry-run
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtNum(n: number, d: number = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the index price from index.txt (project root); null when unreadable. */
function readIndexPrice(): number | null {
  try {
    const value = parseFloat(fs.readFileSync(INDEX_FILE, "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  One review-and-adjust pass                                         */
/* ------------------------------------------------------------------ */

async function runOnce(
  symbol: string,
  qtyArg: string | undefined,
  dryRun: boolean,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  /* -- Review the open position ----------------------------------- */
  const positions = await fetchPositions(apiKey, secretRaw);
  const pos = positions.find((p) => p.symbol === symbol);
  if (!pos) {
    console.log(`[${fmtTime()}]   –  No open ${symbol} position — nothing to adjust.`);
    return;
  }

  const posSide = pos.side === "Buy" ? "Long" : "Short";
  const size = parseFloat(pos.size || "0");
  const entry = parseFloat(pos.avgEntryPriceRp || "0");
  const mark = parseFloat(pos.markPriceRp || "0");
  const pnlPct = calcPnlPct(pos);

  console.log(`[${fmtTime()}]   Position: ${posSide}  size: ${fmtNum(size, 4)}  entry: $${fmtNum(entry)}  mark: $${fmtNum(mark)}  PnL: ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%`);

  /* -- Read the target take-profit price from index.txt ------------ */
  const indexPrice = readIndexPrice();
  if (indexPrice === null) {
    console.warn(`[${fmtTime()}]   ⚠  Could not read a valid index price from ${INDEX_FILE} — skipping this run`);
    return;
  }
  console.log(`[${fmtTime()}]   index.txt → target take profit: $${fmtNum(indexPrice)}`);

  /* -- Sanity check: trigger must sit on the profitable side ------- */
  // Long:  TP Sell triggers as price rises → must be above mark.
  // Short: TP Buy triggers as price falls  → must be below mark.
  const side: "Buy" | "Sell" = posSide === "Long" ? "Sell" : "Buy";
  const invalid = posSide === "Long" ? indexPrice <= mark : indexPrice >= mark;
  if (invalid) {
    console.warn(
      `[${fmtTime()}]   ⚠  Index price $${fmtNum(indexPrice)} is on the wrong side of mark $${fmtNum(mark)} for a ${posSide} TP — skipping (Phemex would reject the crossed trigger).`,
    );
    return;
  }

  const qty = qtyArg !== undefined ? parseFloat(qtyArg) : size;
  if (!Number.isFinite(qty) || qty <= 0) {
    console.error(`[${fmtTime()}] ✗  Invalid qty: ${qtyArg ?? "position size"} — must be a positive number`);
    process.exit(1);
  }
  if (qty > size) {
    console.warn(`[${fmtTime()}]   ⚠  TP qty ${fmtNum(qty, 4)} exceeds position size ${fmtNum(size, 4)}`);
  }

  /* -- Review existing TP-type orders (keep stop-losses) ----------- */
  let tpLike: UntriggeredOrder[] = [];
  try {
    const open = await fetchUntriggeredOrders(symbol, apiKey, secretRaw);
    tpLike = open.filter((o) => (o.ordType === "LimitIfTouched" || o.ordType === "MarketIfTouched") && o.side === side);
  } catch (err: unknown) {
    console.warn(`[${fmtTime()}]   ⚠  Could not review existing TP orders: ${err instanceof Error ? err.message : String(err)}`);
  }

  // A TP at the same price/side/qty already exists → nothing to adjust this run.
  const alreadySet = tpLike.some(
    (o) =>
      Math.abs(parseFloat(o.stopPx || "0") - indexPrice) < 0.005 &&
      Math.abs(parseFloat(o.qty || "0") - qty) < 0.0001,
  );
  if (alreadySet) {
    console.log(`[${fmtTime()}]   –  TP already set at $${fmtNum(indexPrice)} — no change needed.`);
    return;
  }

  /* -- Replace existing TP-type orders ----------------------------- */
  if (!dryRun) {
    for (const o of tpLike) {
      console.log(`[${fmtTime()}]   –  cancelling old TP order ${o.orderID} (${o.ordType} @ ${o.stopPx})`);
      await cancelOrder({ symbol, orderId: o.orderID, posSide }, apiKey, secretRaw);
    }
  }

  /* -- Build the TP conditional order ------------------------------ */
  const params: string[] = [
    `clOrdID=${uuid()}`,
    `symbol=${symbol}`,
    `side=${side}`,
    `posSide=${posSide}`,
    `ordType=LimitIfTouched`,
    `stopPxRp=${indexPrice}`,
    `priceRp=${indexPrice}`,
    `orderQtyRq=${qty}`,
    `reduceOnly=true`,
    `closeOnTrigger=true`,
    `timeInForce=GoodTillCancel`,
    `triggerType=ByLastPrice`,
    `tpTrigger=ByLastPrice`,
    `slTrigger=ByLastPrice`,
  ];
  const query = params.join("&");

  console.log(`[${fmtTime()}] ⟐  Placing TP: ${side} ${fmtNum(qty, 4)} ${symbol} LimitIfTouched @ $${fmtNum(indexPrice)} (posSide ${posSide}, reduce-only)`);

  if (dryRun) {
    console.log(`[${fmtTime()}]   [DRY-RUN] PUT /g-orders/create?${query}`);
    console.log(`[${fmtTime()}]   DRY RUN — nothing sent.`);
    return;
  }

  const resp = (await request("PUT", "/g-orders/create", query, apiKey, secretRaw, "")) as Record<string, unknown>;
  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    console.log(`[${fmtTime()}]   ✓  TP order placed: orderID=${data?.orderID ?? "?"}  status=${data?.ordStatus ?? "?"}`);
  } else {
    console.error(`[${fmtTime()}]   ✗  API error: ${String(resp.msg ?? resp.code)}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();
  const dryRun = hasFlag("--dry-run");
  const loop = hasFlag("--loop");
  const symbol = (getArg("--symbol") ?? DEFAULT_SYMBOL).toUpperCase();
  const qtyArg = getArg("--qty");

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}] ═ ${symbol} TP → index.txt ${dryRun ? "(DRY RUN)" : ""}${loop ? "  (LOOP)" : ""} ═════════════════`);

  if (loop) {
    process.on("SIGINT", () => {
      console.log(`\n[${fmtTime()}] ⏹  Stopped. Position and TP left as-is.`);
      process.exit(0);
    });
    while (true) {
      try {
        await runOnce(symbol, qtyArg, dryRun, creds.PHEMEX_API_KEY, secretRaw);
      } catch (err: unknown) {
        console.error(`[${fmtTime()}] ✗  Run error: ${err instanceof Error ? err.message : String(err)} — retrying in ${LOOP_DELAY_MS / 1000}s`);
      }
      await sleep(LOOP_DELAY_MS);
    }
  }

  await runOnce(symbol, qtyArg, dryRun, creds.PHEMEX_API_KEY, secretRaw);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
