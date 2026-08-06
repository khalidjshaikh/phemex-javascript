#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-close-limit-order.ts — Close part of an open USDT-M position with
 * reduce-only limit order(s).
 *
 * Single order (--price): place one reduce-only limit order that rests until
 * filled (GoodTillCancel) — it is NOT auto-cancelled.
 *   ./phemex-close-limit-order.ts --qty 0.01 --price 84.00
 *
 * Range mode (--from/--to): sweep a reduce-only close order across a price
 * range — place at each rung, wait --delay ms, cancel, then move to the next.
 * Stops early if a rung fills or an API call errors, so no stale orders are
 * left on the book.
 *   ./phemex-close-limit-order.ts --qty 0.01 --from 79 --to 80
 *   ./phemex-close-limit-order.ts --qty 0.01 --from 80 --to 79 --step 0.01 --delay 500 --dry-run
 *
 * The position side is auto-detected from the live account (order side is the
 * opposite of the open position: closing a long sells), or can be pinned with
 * --pos-side / --side.
 *
 * Endpoint:  PUT /g-orders/create   (ordType=Limit, reduceOnly=true)
 *
 * Usage:
 *   ./phemex-close-limit-order.ts --qty <size> --price <price> [options]
 *   ./phemex-close-limit-order.ts --qty <size> --from <price> --to <price> [options]
 *
 * Options:
 *   --symbol <pair>   Trading pair (default: XBRUSDT)
 *   --qty <size>      Quantity to close (required)
 *   --price <price>   Limit price for a single resting close order
 *   --from <price>    Range mode: first rung (requires --to; excludes --price)
 *   --to <price>      Range mode: last rung, inclusive; direction follows
 *                     --from → --to (downward allowed)
 *   --step <price>    Range mode: step between rungs, as a magnitude (default: 0.01)
 *   --delay <ms>      Range mode: wait between place and cancel (default: 1000)
 *   --pos-side <Side> Long or Short (default: live position side)
 *   --side <Buy|Sell> Order side (default: opposite of pos-side)
 *   --dry-run         Log what would be sent without executing
 *   --help, -h        Show this help message
 */

import { base64UrlDecode, request } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { fetchPositions } from "../src/positions.js";
import { uuid } from "../src/uuid.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_SYMBOL = "XBRUSDT";
const DEFAULT_STEP = 0.01;
const DEFAULT_DELAY_MS = 1000;

function usage(): never {
  console.log(`
Usage: ./phemex-close-limit-order.ts --qty <size> --price <price> [options]
       ./phemex-close-limit-order.ts --qty <size> --from <price> --to <price> [options]

Close part of an open USDT-M position with reduce-only limit orders.
With --price, one order is placed and rests until filled (GoodTillCancel).
With --from/--to, close orders are swept across the range: place at each
rung, wait --delay ms, cancel, then move to the next — stopping early on a
fill or an API error, so no stale orders are left on the book.

Options:
  --symbol <pair>   Trading pair (default: XBRUSDT)
  --qty <size>      Quantity to close (required)
  --price <price>   Limit price for a single resting close order
  --from <price>    Range mode: first rung (requires --to; excludes --price)
  --to <price>      Range mode: last rung, inclusive; direction follows
                    --from → --to (downward allowed)
  --step <price>    Range mode: step between rungs, as a magnitude (default: 0.01)
  --delay <ms>      Range mode: wait between place and cancel (default: 1000)
  --pos-side <Side> Long or Short (default: live position side)
  --side <Buy|Sell> Order side (default: opposite of pos-side)
  --dry-run         Log what would be sent without executing
  --help, -h        Show this help message

Examples:
  ./phemex-close-limit-order.ts --qty 0.01 --price 84.00
  ./phemex-close-limit-order.ts --qty 0.01 --price 84.00 --dry-run
  ./phemex-close-limit-order.ts --qty 0.01 --from 79 --to 80
  ./phemex-close-limit-order.ts --qty 0.01 --from 80 --to 79 --step 0.01 --delay 500 --dry-run
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleTimeString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CloseOrderParams {
  symbol: string;
  side: "Buy" | "Sell";
  posSide: "Long" | "Short";
  price: number;
  qty: number;
}

/** Build the PUT /g-orders/create query for a reduce-only limit order. */
function buildCloseQuery(params: CloseOrderParams): string {
  return [
    `symbol=${params.symbol}`,
    `side=${params.side}`,
    `posSide=${params.posSide}`,
    `ordType=Limit`,
    `timeInForce=GoodTillCancel`,
    `priceRp=${params.price}`,
    `orderQtyRq=${params.qty}`,
    `clOrdID=${uuid()}`,
    `reduceOnly=true`,
  ].join("&");
}

/** Place a reduce-only USDT-M limit order (closes, never opens). */
async function placeCloseOrder(
  params: CloseOrderParams,
  apiKey: string,
  secretRaw: Buffer,
): Promise<Record<string, unknown>> {
  const resp = (await request("PUT", "/g-orders/create", buildCloseQuery(params), apiKey, secretRaw, "")) as Record<string, unknown>;
  if (resp.code !== 0) throw new Error(String(resp.msg ?? `API code ${resp.code}`));
  const data = resp.data as Record<string, unknown> | undefined;
  if (!data) throw new Error("Empty response data");
  return data;
}

/**
 * Cancel a close order by ID.  Returns a status string:
 *   "cancelled"  — successfully cancelled
 *   "filled"     — order not found (already filled / does not exist)
 *   "error: …"   — something went wrong
 */
async function cancelCloseOrder(
  symbol: string,
  orderId: string,
  posSide: "Long" | "Short",
  apiKey: string,
  secretRaw: Buffer,
): Promise<string> {
  const qp = new URLSearchParams({ orderID: orderId, symbol, posSide });
  qp.set("untriggered", "true"); // reduce-only close orders cancel via untriggered path

  const endpoint = symbol.toUpperCase().endsWith("USDT") ? "/g-orders" : "/orders";
  const resp = (await request("DELETE", endpoint, qp.toString(), apiKey, secretRaw, "")) as Record<string, unknown>;

  // code 0 + no bizError = success
  if (resp.code === 0) {
    const data = resp.data as { bizError?: number }[] | undefined;
    const bizError = data?.[0]?.bizError;
    if (bizError === undefined || bizError === 0) return "cancelled";
  }

  // Order not found (20001 / 60017 / 10002 / "not found") → already filled
  const msg = String(resp.msg ?? "");
  const code = String(resp.code ?? "?");
  const data = resp.data as { bizError?: number }[] | undefined;
  const bizError = data?.[0]?.bizError;
  if (
    /not.?found/i.test(msg) ||
    /20001/.test(msg) || /60017/.test(msg) || /10002/.test(msg) ||
    bizError === 60017 || bizError === 10002
  ) return "filled";

  const biz = bizError === undefined ? "" : ` bizError=${bizError}`;
  return `error: code=${code} msg="${msg}"${biz}`;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = (getArg("--symbol") ?? DEFAULT_SYMBOL).toUpperCase();
  const qty = parseFloat(getArg("--qty") ?? "");
  const priceRaw = getArg("--price");
  const fromRaw = getArg("--from");
  const toRaw = getArg("--to");
  const stepRaw = getArg("--step");
  const delayRaw = getArg("--delay");
  const posSideArg = getArg("--pos-side");
  const sideArg = getArg("--side");
  const dryRun = hasFlag("--dry-run");

  if (!Number.isFinite(qty) || qty <= 0) {
    console.error("✗  --qty must be a positive number");
    process.exit(1);
  }

  // Range (sweep) mode vs single resting order
  const sweep = fromRaw !== undefined || toRaw !== undefined;
  if (sweep && (fromRaw === undefined || toRaw === undefined)) {
    console.error("✗  --from and --to are both required for range mode");
    process.exit(1);
  }
  if (sweep && priceRaw !== undefined) {
    console.error("✗  --price cannot be combined with --from/--to (range mode)");
    process.exit(1);
  }
  const price = parseFloat(priceRaw ?? "");
  if (!sweep) {
    if (!Number.isFinite(price) || price <= 0) {
      console.error("✗  --price must be a positive number (or use --from/--to for a range)");
      process.exit(1);
    }
  }
  const from = parseFloat(fromRaw ?? "");
  const to = parseFloat(toRaw ?? "");
  if (sweep && (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0)) {
    console.error("✗  --from and --to must be positive numbers");
    process.exit(1);
  }
  const step = stepRaw !== undefined ? parseFloat(stepRaw) : DEFAULT_STEP;
  if (sweep && (!Number.isFinite(step) || step <= 0)) {
    console.error("✗  --step must be a positive number (default: 0.01)");
    process.exit(1);
  }
  const delay = delayRaw !== undefined ? parseFloat(delayRaw) : DEFAULT_DELAY_MS;
  if (sweep && (!Number.isFinite(delay) || delay < 0)) {
    console.error("✗  --delay must be a non-negative number of ms (default: 1000)");
    process.exit(1);
  }
  if (posSideArg !== undefined && !["Long", "Short"].includes(posSideArg)) {
    console.error(`✗  --pos-side must be 'Long' or 'Short', got "${posSideArg}"`);
    process.exit(1);
  }
  if (sideArg !== undefined && !["Buy", "Sell"].includes(sideArg)) {
    console.error(`✗  --side must be 'Buy' or 'Sell', got "${sideArg}"`);
    process.exit(1);
  }

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  /* -- Resolve position side from the live account if not pinned ---- */
  let posSide: "Long" | "Short" | undefined = posSideArg as "Long" | "Short" | undefined;
  if (!posSide) {
    const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
    const livePos = positions.find((p) => p.symbol === symbol) ?? null;
    if (!livePos) {
      console.error(`✗  No open ${symbol} position found — pass --pos-side to override`);
      process.exit(1);
    }
    posSide = livePos.side === "Buy" ? "Long" : "Short";
    console.log(`[${fmtTime()}] ⟐  Live ${symbol} position: side=${posSide} size=${livePos.size} entry=${livePos.avgEntryPriceRp ?? "?"}`);
  }

  const side = (sideArg ?? (posSide === "Long" ? "Sell" : "Buy")) as "Buy" | "Sell";

  /* -- Single resting close order ---------------------------------- */
  if (!sweep) {
    console.log(`[${fmtTime()}] ═ Close ${qty} ${symbol} @ ${price.toFixed(2)} ═${dryRun ? "  DRY RUN" : ""}`);
    console.log(`[${fmtTime()}]   ${side} ${qty} ${symbol} (posSide ${posSide}) limit ${price.toFixed(2)}, reduceOnly, GoodTillCancel`);
    if (dryRun) {
      console.log(`[${fmtTime()}]      [DRY-RUN] PUT /g-orders/create?${buildCloseQuery({ symbol, side, posSide, price, qty })}`);
      console.log(`[${fmtTime()}]   DRY RUN — nothing sent.`);
      return;
    }
    const data = await placeCloseOrder({ symbol, side, posSide, price, qty }, creds.PHEMEX_API_KEY, secretRaw);
    console.log(`[${fmtTime()}]   ✓  Order placed: orderID=${data.orderID ?? "?"}  status=${data.ordStatus ?? "?"}`);
    return;
  }

  /* -- Range sweep: place → wait → cancel across from..to ----------- */
  const dir = to >= from ? 1 : -1;
  const prices: number[] = [];
  for (let p = from; dir > 0 ? p <= to + 1e-9 : p >= to - 1e-9; p += dir * step) {
    prices.push(Math.round(p * 10_000) / 10_000);
  }

  console.log(`[${fmtTime()}] ═ Sweep-close ${qty} ${symbol} ${side} ${from.toFixed(2)} → ${to.toFixed(2)} ═${dryRun ? "  DRY RUN" : ""}`);
  console.log(`[${fmtTime()}]   ${side} ${qty} ${symbol} (posSide ${posSide}) reduceOnly — ${prices.length} rung(s), step ${step}, place → wait ${delay}ms → cancel`);
  if (dryRun) {
    for (const p of prices) console.log(`[${fmtTime()}]      [DRY-RUN] ${side} ${qty} ${symbol} @ $${p.toFixed(4)}`);
    console.log(`[${fmtTime()}]   DRY RUN — nothing sent.`);
    return;
  }

  let filled = false;
  let aborted: string | null = null;
  let swept = 0;

  for (const p of prices) {
    // --- Place ---
    process.stdout.write(`[${fmtTime()}]   ${side} ${qty} ${symbol} @ $${p.toFixed(4)}  →  placing …  `);
    let orderId: string;
    try {
      const data = await placeCloseOrder({ symbol, side, posSide, price: p, qty }, creds.PHEMEX_API_KEY, secretRaw);
      orderId = String(data.orderID ?? data.clOrdID ?? "");
      if (!orderId) throw new Error("No orderID in response");
      console.log(`✓  orderID: ${orderId.slice(0, 8)}…`);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${reason}`);
      aborted = reason;
      break;
    }

    // --- Wait ---
    if (delay > 0) {
      process.stdout.write(`[${fmtTime()}]       waiting ${delay}ms …  `);
      await sleep(delay);
      console.log("✓");
    }

    // --- Cancel ---
    process.stdout.write(`[${fmtTime()}]       cancelling ${orderId.slice(0, 8)}…  `);
    try {
      const status = await cancelCloseOrder(symbol, orderId, posSide, creds.PHEMEX_API_KEY, secretRaw);
      if (status === "cancelled") {
        console.log("✓  cancelled");
      } else if (status === "filled") {
        console.log("⚡  already filled — sweep stopped");
        filled = true;
        break;
      } else {
        console.log(`✗  ${status}`);
        aborted = status;
        break;
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${reason}`);
      aborted = reason;
      break;
    }
    swept++;
  }

  console.log(`[${fmtTime()}] ───────────────────────────────────────────────`);
  if (filled) {
    console.log(`[${fmtTime()}] ✔  Sweep filled at rung ${swept + 1}/${prices.length} — position closed.`);
  } else if (aborted) {
    console.log(`[${fmtTime()}] ✗  Sweep aborted at rung ${swept + 1}/${prices.length} — ${aborted}`);
  } else {
    console.log(`[${fmtTime()}] ✔  Sweep complete — ${swept}/${prices.length} rung(s) swept, none filled.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
