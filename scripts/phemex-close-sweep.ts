#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-close-sweep.ts — Sweep close orders across a price range, placing
 * a reduce-only order at each price, waiting a delay, then cancelling it
 * before moving to the next rung.  Stops early if the order gets filled
 * (cancel returns "not found") or on any API error (e.g. TE_REDUCE_ONLY_ABORT).
 *
 * Purpose:  chase the price with a closing order without leaving stale
 * resting orders on the book.  Each rung is place → wait → cancel.
 *
 * Usage:
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1 --close-long
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1 --delay 500
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1 --dry-run
 *
 * Options:
 *   --symbol <symbol>     Contract symbol (default: XBRUSDT)
 *   --from <price>        Sweep start price (default: 50)
 *   --to <price>          Sweep end price, inclusive (default: 60)
 *   --step <price>        Price step between rungs, as a magnitude (default: 1)
 *                         Direction follows --from → --to (downward allowed)
 *   --qty <quantity>      Quantity per order (default: 1)
 *   --delay <ms>          Wait between place and cancel (default: 1000)
 *   --close-short         Reduce-only Buy ladder closing an open short (default)
 *   --close-long          Reduce-only Sell ladder closing an open long
 *   --dry-run             Print the sweep without placing any orders
 *   --help, -h            Show this help message
 */

import { base64UrlDecode, request } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import {
  PlaceOrderResult,
} from "../src/place-limit-order.js";
import { fetchPositions } from "../src/positions.js";
import { uuid } from "../src/uuid.js";

const CREDS_FILE = ".phemex-credentials.json";

// Defaults
const SYMBOL = "XBRUSDT";
const FROM = 50;
const TO = 60;
const STEP = 1;
const QTY = 1;
const DELAY_MS = 1000;

type CloseMode = "short" | "long";

/* ------------------------------------------------------------------ */
/*  Help                                                               */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: scripts/phemex-close-sweep.ts [options]

Sweep close orders across a price range — place at each price, wait,
cancel, then move to the next.  Stops early if an order gets filled or
an API call errors.

Options:
  --symbol <symbol>     Contract symbol (default: ${SYMBOL})
  --from <price>        Sweep start price (default: ${FROM})
  --to <price>          Sweep end price, inclusive (default: ${TO})
  --step <price>        Price step between rungs, as a magnitude (default: ${STEP})
                        Direction follows --from → --to (downward allowed)
  --qty <quantity>      Quantity per order (default: ${QTY})
  --delay <ms>          Wait between place and cancel (default: ${DELAY_MS})
  --close-short         Reduce-only Buy ladder closing an open short (default)
  --close-long          Reduce-only Sell ladder closing an open long
  --dry-run             Print the sweep without placing any orders
  --help, -h            Show this help message

Examples:
   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1
   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1 --close-long
   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1 --delay 500
   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1 --dry-run
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

/* ------------------------------------------------------------------ */
/*  API helpers                                                        */
/* ------------------------------------------------------------------ */

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
async function placeReduceOnly(
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

/**
 * Cancel an order by ID.  Returns a status string:
 *   "cancelled"  — successfully cancelled
 *   "filled"     — order not found (already filled / does not exist)
 *   "error: …"   — something went wrong
 */
async function cancelOrder(
  symbol: string,
  orderId: string,
  posSide: "Long" | "Short",
  isReduceOnly: boolean,
  apiKey: string,
  secretRaw: Buffer,
): Promise<string> {
  const qp = new URLSearchParams({ orderID: orderId, symbol, posSide });
  if (isReduceOnly) qp.set("untriggered", "true");

  const endpoint = symbol.toUpperCase().endsWith("USDT") ? "/g-orders" : "/orders";
  const resp = (await request("DELETE", endpoint, qp.toString(), apiKey, secretRaw, "")) as Record<string, unknown>;

  // code 0 + no bizError = success
  if (resp.code === 0) {
    const data = resp.data as { bizError?: number }[] | undefined;
    const bizError = data?.[0]?.bizError;
    if (bizError === undefined || bizError === 0) return "cancelled";
  }

  // 20001 / order not found → already filled
  const msg = String(resp.msg ?? "");
  if (/not.?found/i.test(msg) || /20001/.test(msg)) return "filled";

  return `error: ${msg}`;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
  if (process.argv.length <= 2) usage();

  const dryRun = process.argv.includes("--dry-run");
  const closeShort = process.argv.includes("--close-short") || !process.argv.includes("--close-long");
  const closeLong = process.argv.includes("--close-long");

  if (closeShort && closeLong) {
    console.error(`✗  Cannot combine --close-short with --close-long`);
    process.exit(1);
  }

  const closeMode: CloseMode = closeLong ? "long" : "short";

  const symbol = getArgValue("--symbol") ?? SYMBOL;
  const from = numArg("--from", FROM);
  const to = numArg("--to", TO);
  const step = numArg("--step", STEP);
  const qty = numArg("--qty", QTY);
  const delay = numArg("--delay", DELAY_MS);

  // Validation
  if (step === 0) {
    console.error(`✗  --step must be non-zero (got ${step})`);
    process.exit(1);
  }
  if (qty <= 0) {
    console.error(`✗  --qty must be > 0 (got ${qty})`);
    process.exit(1);
  }
  if (delay < 0) {
    console.error(`✗  --delay must be >= 0 (got ${delay})`);
    process.exit(1);
  }

  // Build the price list — direction follows --from → --to, step is a magnitude
  const dir = to >= from ? 1 : -1;
  const prices: number[] = [];
  for (let p = from; dir > 0 ? p <= to + 1e-9 : p >= to - 1e-9; p += dir * Math.abs(step)) {
    prices.push(Math.round(p * 10_000) / 10_000);
  }

  // Resolve order direction
  const side: "Buy" | "Sell" = closeMode === "short" ? "Buy" : "Sell";
  const posSide: "Long" | "Short" = closeMode === "short" ? "Short" : "Long";
  const closeLabel = closeMode === "short" ? "short" : "long";

  // Load credentials
  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  // Log header
  console.log(`[${fmtTime()}] ═ ${symbol} Close-${closeLabel} Sweep ═════════════════════════`);
  console.log(`[${fmtTime()}]   Range:     $${from} → $${to} (inclusive)`);
  console.log(`[${fmtTime()}]   Step:      $${Math.abs(step)}   rungs: ${prices.length}`);
  console.log(`[${fmtTime()}]   Qty/order: ${qty}   side: ${side} / ${posSide}  reduceOnly`);
  console.log(`[${fmtTime()}]   Delay:     ${delay}ms  place → wait → cancel`);
  console.log(`[${fmtTime()}]   Mode:      ${dryRun ? "DRY-RUN" : "LIVE"}`);
  console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════`);

  if (dryRun) {
    for (const price of prices) {
      console.log(`  ·  ${side} ${qty} ${symbol} @ $${price.toFixed(4)}  →  wait ${delay}ms  →  cancel`);
    }
    console.log(`[${fmtTime()}] ✔  ${prices.length} rung(s) would be swept — nothing sent to the exchange.`);
    return;
  }

  let swept = 0;
  let filled = false;
  let aborted: string | null = null;

  for (const price of prices) {
    if (filled || aborted) {
      console.log(`[${fmtTime()}]   –  Already ${filled ? "filled" : "aborted"} — skipping $${price.toFixed(4)} and the rest.`);
      break;
    }

    // --- Place ---
    process.stdout.write(`[${fmtTime()}]   ${side} ${qty} ${symbol} @ $${price.toFixed(4)}  →  placing …  `);
    let orderId: string;
    try {
      const result = await placeReduceOnly({ symbol, side, price, qty, posSide }, creds.PHEMEX_API_KEY, secretRaw);
      orderId = result.orderID ?? result.clOrdID ?? "";
      if (!orderId) throw new Error("No orderID in response");
      console.log(`✓  orderID: ${orderId.slice(0, 8)}…`);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${reason}`);
      swept++;
      aborted = reason;
      break;
    }

    // --- Wait ---
    if (delay > 0) {
      process.stdout.write(`[${fmtTime()}]     waiting ${delay}ms …  `);
      await new Promise((r) => setTimeout(r, delay));
      console.log("✓");
    }

    // --- Cancel ---
    process.stdout.write(`[${fmtTime()}]     cancelling ${orderId.slice(0, 8)}…  `);
    try {
      const status = await cancelOrder(symbol, orderId, posSide, true, creds.PHEMEX_API_KEY, secretRaw);
      if (status === "cancelled") {
        console.log("✓  cancelled");
      } else if (status === "filled") {
        console.log("⚡  already filled — stopping sweep");
        filled = true;
      } else {
        console.log(`✗  ${status}`);
        swept++;
        aborted = status;
        break;
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${reason}`);
      swept++;
      aborted = reason;
      break;
    }
    swept++;
  }

  console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════`);
  if (filled) {
    console.log(`[${fmtTime()}] ✔  Sweep filled at rung ${swept}/${prices.length} — position closed.`);
  } else if (aborted) {
    console.log(`[${fmtTime()}] ✗  Sweep aborted at rung ${swept}/${prices.length} — ${aborted}`);
  } else {
    console.log(`[${fmtTime()}] ✔  Sweep complete — ${swept}/${prices.length} rung(s) swept, none filled.`);
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});