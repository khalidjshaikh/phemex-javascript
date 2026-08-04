#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-limit-rungs.ts — Place resting limit orders on XBRUSDT (USDT-M) at
 * every rung between two prices, e.g. $50 → $70 (inclusive) with a step of $1,
 * one order per rung, qty 0.01 each, at 100x leverage. All values are
 * command-line arguments. Defaults to a Long (Buy) ladder; pass --side short
 * for a Short (Sell) ladder, --close-short for a reduce-only Buy ladder that
 * closes an open short, or --close-long for a reduce-only Sell ladder that
 * closes an open long.
 *
 * Uses placeLinear directly instead of placeLimitOrder because the shared
 * wrapper auto-cancels every limit order after 60s — a resting ladder must
 * stay live until filled. Close-mode rungs go through placeLinearReduceOnly,
 * which sends the same PUT /g-orders/create shape plus reduceOnly=true
 * (pattern borrowed from phemex-add-conditional-orders.ts).
 *
 * In close mode the open position's size is read from the API (read-only GET)
 * and each rung's qty is capped at the remaining size, so the ladder can never
 * over-close; it errors out if no position of that side is open.
 *
 * Usage:
 *   ./phemex-limit-rungs.ts --from 50 --to 70 --step 1
 *   ./phemex-limit-rungs.ts --from 50 --to 70 --step 1 --dry-run
 *   ./phemex-limit-rungs.ts --from 50 --to 70 --step 1 --close-short
 *   ./phemex-limit-rungs.ts --from 50 --to 70 --step 1 --close-long
 *
 * Options:
 *   --symbol <symbol>   Contract symbol (default: XBRUSDT)
 *   --from <price>      Ladder start price (default: 50)
 *   --to <price>        Ladder end price, inclusive (default: 70)
 *   --step <price>      Price step between rungs (default: 1)
 *   --qty <quantity>    Quantity per order (default: 0.01)
 *   --leverage <n>      Leverage (default: 100; ignored in close mode)
 *   --side <long|short> Order side (default: long; not allowed in close mode)
 *   --close-short       Reduce-only Buy ladder that closes an open short
 *   --close-long        Reduce-only Sell ladder that closes an open long
 *   --dry-run           Print the ladder without placing any orders
 *   --help, -h          Show this help message
 */

import { base64UrlDecode, request } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import {
  placeLinear,
  setLeverageUsdtM,
  PlaceOrderResult,
} from "../src/place-limit-order.js";
import { fetchPositions } from "../src/positions.js";
import { uuid } from "../src/uuid.js";

const CREDS_FILE = ".phemex-credentials.json";

// Defaults
const SYMBOL = "XBRUSDT";
const FROM = 50;
const TO = 70;
const STEP = 1;
const QTY = 0.01;
const LEVERAGE = 100;
const ORDER_DELAY_MS = 300; // small pause between order placements

type CloseMode = "short" | "long" | "none";

function usage(): never {
  console.log(`
Usage: ./phemex-limit-rungs.ts [options]

Place resting limit orders on ${SYMBOL} (USDT-M), one order per rung
from \$${FROM} to \$${TO} (inclusive), qty ${QTY} each, at ${LEVERAGE}x leverage.

Options:
  --symbol <symbol>   Contract symbol (default: ${SYMBOL})
  --from <price>      Ladder start price (default: ${FROM})
  --to <price>        Ladder end price, inclusive (default: ${TO})
  --step <price>      Price step between rungs (default: ${STEP})
  --qty <quantity>    Quantity per order (default: ${QTY})
  --leverage <n>      Leverage (default: ${LEVERAGE}; ignored in close mode)
  --side <long|short> Order side (default: long; not allowed in close mode)
  --close-short       Reduce-only Buy ladder that closes an open short
  --close-long        Reduce-only Sell ladder that closes an open long
  --dry-run           Print the ladder without placing any orders
  --help, -h          Show this help message

Examples:
  ./phemex-limit-rungs.ts --from 50 --to 70 --step 1
  ./phemex-limit-rungs.ts --from 50 --to 70 --step 1 --dry-run
  ./phemex-limit-rungs.ts --from 50 --to 70 --step 1 --close-short
  ./phemex-limit-rungs.ts --from 50 --to 70 --step 1 --close-long
  ./phemex-limit-rungs.ts --from 100 --to 90 --step -1 --side short
  ./phemex-limit-rungs.ts --symbol XBRUSDT --qty 0.05
`);
  process.exit(0);
}

function fmtTime(): string {
  return new Date().toLocaleString();
}

function getArgValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function numArg(name: string, fallback: number): number {
  const raw = getArgValue(name);
  if (raw === undefined) return fallback;
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) {
    console.error(`✗  Invalid value for ${name}: "${raw}"`);
    process.exit(1);
  }
  return v;
}

interface ReduceOnlyOrderParams {
  symbol: string;
  side: "Buy" | "Sell";
  price: number;
  qty: number;
  posSide: "Long" | "Short";
}

/**
 * Place a reduce-only USDT-M limit order (closes, never opens).
 * Same PUT /g-orders/create shape as placeLinear, plus reduceOnly=true.
 */
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

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
  // No options at all → show usage instead of silently placing the default
  // long ladder from $50 → $70.
  if (process.argv.length <= 2) usage();
  const dryRun = process.argv.includes("--dry-run");
  const closeShort = process.argv.includes("--close-short");
  const closeLong = process.argv.includes("--close-long");
  if (closeShort && closeLong) {
    console.error(`✗  Cannot combine --close-short with --close-long`);
    process.exit(1);
  }
  const closeMode: CloseMode = closeShort ? "short" : closeLong ? "long" : "none";
  const closing = closeMode !== "none";
  const closeLabel = closeMode === "none" ? "" : closeMode; // "short" | "long"

  const symbol = getArgValue("--symbol") ?? SYMBOL;
  const from = numArg("--from", FROM);
  const to = numArg("--to", TO);
  const step = numArg("--step", STEP);
  const qty = numArg("--qty", QTY);
  const leverage = numArg("--leverage", LEVERAGE);

  const sideArg = (getArgValue("--side") ?? "long").toLowerCase();
  if (closing && getArgValue("--side") !== undefined) {
    console.error(`✗  Cannot combine --close-short/--close-long with --side`);
    process.exit(1);
  }
  if (sideArg !== "long" && sideArg !== "short") {
    console.error(`✗  Invalid --side "${sideArg}" — expected "long" or "short"`);
    process.exit(1);
  }

  // Order direction: close-short = Buy/Short, close-long = Sell/Long,
  // otherwise the --side ladder (long = Buy/Long, short = Sell/Short).
  let side: "Buy" | "Sell";
  let posSide: "Long" | "Short";
  if (closeMode === "short") {
    side = "Buy";
    posSide = "Short";
  } else if (closeMode === "long") {
    side = "Sell";
    posSide = "Long";
  } else {
    side = sideArg === "long" ? "Buy" : "Sell";
    posSide = sideArg === "long" ? "Long" : "Short";
  }

  if (step === 0) {
    console.error(`✗  --step must be non-zero (got ${step})`);
    process.exit(1);
  }
  if ((to - from) * step < 0) {
    console.error(`✗  --to (${to}) is not reachable from --from (${from}) with step ${step}`);
    process.exit(1);
  }
  if (qty <= 0) {
    console.error(`✗  --qty must be > 0 (got ${qty})`);
    process.exit(1);
  }

  // Build the ladder (rounded to 4 dp so prices are valid Rp values).
  const prices: number[] = [];
  for (let p = from; step > 0 ? p <= to + 1e-9 : p >= to - 1e-9; p += step) {
    prices.push(Math.round(p * 10_000) / 10_000);
  }

  // Close mode needs the open position's size to cap the ladder, so
  // credentials load even in dry-run (the position fetch is a read-only GET).
  // Plain open dry-runs stay credential-free, as before.
  let creds: ReturnType<typeof loadCredentialsPath> | null = null;
  let secretRaw: Buffer | null = null;
  if (closing || !dryRun) {
    creds = loadCredentialsPath(CREDS_FILE);
    secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);
  }

  let closeSize = 0;
  let closeEntry = 0;
  if (closing) {
    // API reports a short position with side "Sell", a long with side "Buy".
    const expectedPosSide = closeMode === "short" ? "Sell" : "Buy";
    const positions = await fetchPositions(creds!.PHEMEX_API_KEY, secretRaw!);
    const open = positions.find((p) => p.symbol === symbol && p.side === expectedPosSide);
    if (!open) {
      console.error(`✗  No open ${closeLabel} position on ${symbol} — nothing to close.`);
      process.exit(1);
    }
    closeSize = parseFloat(open.size || "0");
    closeEntry = parseFloat(open.avgEntryPriceRp || "0");
    if (!(closeSize > 0)) {
      console.error(`✗  Open ${closeLabel} on ${symbol} has non-positive size (${closeSize}).`);
      process.exit(1);
    }
  }

  const modeLabel = closeMode === "short"
    ? "CLOSE-SHORT — reduce-only Buy ladder, capped at open short size"
    : closeMode === "long"
      ? "CLOSE-LONG — reduce-only Sell ladder, capped at open long size"
      : dryRun
        ? "DRY-RUN — no orders will be placed"
        : "LIVE — placing orders";

  const modeTitle = closeMode === "short" ? "Close Short" : closeMode === "long" ? "Close Long" : posSide;

  console.log(`[${fmtTime()}] ═ ${symbol} ${modeTitle} Limit Rungs ═════════════════════════`);
  console.log(`[${fmtTime()}]   Range:     $${from} → $${to} (inclusive)`);
  console.log(`[${fmtTime()}]   Step:      $${step}   orders: ${prices.length}`);
  console.log(`[${fmtTime()}]   Qty/order: ${qty}   leverage: ${closing ? "n/a (closing)" : `${leverage}x`}   side: ${side} / ${posSide}${closing ? " reduceOnly" : ""}`);
  console.log(`[${fmtTime()}]   Mode:      ${modeLabel}`);
  if (closing) {
    const posTitle = closeMode === "short" ? "Short" : "Long";
    console.log(`[${fmtTime()}]   ${posTitle}:     ${symbol} size ${closeSize} @ entry $${closeEntry.toFixed(4)}`);
    const total = qty * prices.length;
    if (total > closeSize) {
      console.log(`[${fmtTime()}]   ⚠  Ladder total ${total} > ${closeLabel} size ${closeSize} — rung qty capped at remaining size`);
    }
  }
  console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════`);

  if (dryRun) {
    let remaining = closing ? closeSize : Infinity;
    for (const price of prices) {
      const rungQty = closing ? Math.min(qty, Math.round(remaining * 10_000) / 10_000) : qty;
      if (rungQty <= 0) {
        console.log(`  ·  (remaining ${closeLabel} size exhausted — skipping $${price.toFixed(4)} and below)`);
        break;
      }
      console.log(`  ·  ${side} ${rungQty} ${symbol} @ $${price.toFixed(4)}  (dry-run${closing ? `, close-${closeLabel}` : ""})`);
      remaining -= rungQty;
    }
    console.log(`[${fmtTime()}] ✔  ${prices.length} rung(s) would be placed — nothing sent to the exchange.`);
    return;
  }

  if (closing) {
    console.log(`[${fmtTime()}]   ℹ  Closing — leverage not changed.`);
  } else {
    await setLeverageUsdtM(symbol, leverage, posSide, creds!.PHEMEX_API_KEY, secretRaw!);
    console.log(`[${fmtTime()}]   ✓  Leverage set to ${leverage}x on ${symbol} (${posSide})`);
  }

  let placed = 0;
  let failed = 0;
  let remaining = closing ? closeSize : Infinity;
  for (const price of prices) {
    const rungQty = closing ? Math.min(qty, Math.round(remaining * 10_000) / 10_000) : qty;
    if (rungQty <= 0) {
      console.log(`[${fmtTime()}]   –  Remaining ${closeLabel} size exhausted — skipping $${price.toFixed(4)} and the rest.`);
      break;
    }
    try {
      const result = closing
        ? await placeLinearReduceOnly({ symbol, side, price, qty: rungQty, posSide }, creds!.PHEMEX_API_KEY, secretRaw!)
        : await placeLinear(
            { account: "usdt-m", symbol, side, price, qty: rungQty, posSide },
            creds!.PHEMEX_API_KEY,
            secretRaw!,
          );
      console.log(
        `[${fmtTime()}]   ✓  ${side} ${rungQty} ${symbol} @ $${price.toFixed(4)}${closing ? ` (close-${closeLabel})` : ""} — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`,
      );
      placed++;
    } catch (err: unknown) {
      console.error(
        `[${fmtTime()}]   ✗  ${side} ${rungQty} ${symbol} @ $${price.toFixed(4)} — ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
    remaining -= rungQty;
    await new Promise((r) => setTimeout(r, ORDER_DELAY_MS));
  }

  console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════`);
  console.log(`[${fmtTime()}] ✔  Done — ${placed} placed, ${failed} failed (of ${prices.length} rungs).`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
