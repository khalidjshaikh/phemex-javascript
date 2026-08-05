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
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --price last --close-long --qty 0.01
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --price mark --close-long --qty 0.01
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --price last --close-long --qty 0.01 --cancel
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --price last --close-long --qty 0.01 --delay 2000
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from last --to mark --step 0.01 --close-long
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from mark+0.20 --to mark-0.20 --step 0.01 --close-long
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1 --close-long
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1 --delay 500
 *   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from 50 --to 60 --step 1 --dry-run
 *
 * Options:
 *   --symbol <symbol>     Contract symbol (default: XBRUSDT)
 *   --price <n|last|mark> Single resting close order at <n>, or at the price
 *                         read from last.txt / mark.txt (project root).
 *                         Order stays resting until cancelled with --cancel.
 *   --cancel              Manually cancel the resting order tracked in
 *                         .phemex-last-close.json (placed via --price, or a
 *                         leftover from a sweep).
 *   --from <price>        Sweep start price (default: 50)
 *   --to <price>          Sweep end price, inclusive (default: 60)
 *                         Both accept a number, "last" (last.txt), "mark"
 *                         (mark.txt), or an offset like "mark+0.20" /
 *                         "mark-0.20" (mark.txt ± cents), resolved at
 *                         sweep start.
 *   --step <price>        Price step between rungs, as a magnitude (default: 1)
 *                         Direction follows --from → --to (downward allowed)
 *   --qty <quantity>      Quantity per order (default: 1)
 *   --delay <ms>          Sweep: wait between place and cancel (default: 1000).
 *                         With --price last|mark: loop period — keep
 *                         re-reading the price file, cancel + re-place the
 *                         close order as the price moves, until the user
 *                         exits (Ctrl+C).
 *   --close-short         Reduce-only Buy ladder closing an open short (default)
 *   --close-long          Reduce-only Sell ladder closing an open long
 *   --ignore-exception    On place/cancel API errors, log and continue
 *                         (loop keeps polling; sweep moves to the next
 *                         rung) instead of exiting the process.
 *   --dry-run             Print the sweep without placing any orders
 *   --help, -h            Show this help message
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { base64UrlDecode, request } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import {
  PlaceOrderResult,
} from "../src/place-limit-order.js";
import { fetchPositions } from "../src/positions.js";
import { uuid } from "../src/uuid.js";

const CREDS_FILE = ".phemex-credentials.json";
const ROOT = resolve(import.meta.dirname, ".."); // project root
const LAST_FILE = resolve(ROOT, "last.txt"); // written by phemex-mark-price2.ts
const MARK_FILE = resolve(ROOT, "mark.txt"); // written by phemex-mark-price2.ts
const STATE_FILE = resolve(ROOT, ".phemex-last-close.json"); // resting close order tracker

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

With --price <n|last|mark> a single resting reduce-only close order is
placed instead (no sweep); last/mark reads the price from last.txt /
mark.txt (project root).  With --price last|mark --delay <ms> the price
is re-read every <ms> and the close order is cancelled + re-placed as it
moves, until Ctrl+C.  Any resting order is tracked in
.phemex-last-close.json and can be cancelled manually with --cancel.
--from and --to also accept "last" / "mark" for sweep endpoints.

Options:
  --symbol <symbol>     Contract symbol (default: ${SYMBOL})
  --price <n|last|mark> Single resting close order at <n>, or at the price
                        read from last.txt / mark.txt.  Cancel with --cancel.
  --cancel              Manually cancel the tracked resting close order
  --from <price>        Sweep start price (default: ${FROM}); also "last"/"mark"
                        or offsets "mark+0.20" / "mark-0.20" (± cents)
  --to <price>          Sweep end price, inclusive (default: ${TO}); also "last"/"mark"
                        or offsets "mark+0.20" / "mark-0.20" (± cents)
  --step <price>        Price step between rungs, as a magnitude (default: ${STEP})
                        Direction follows --from → --to (downward allowed)
  --qty <quantity>      Quantity per order (default: ${QTY})
  --delay <ms>          Sweep: wait between place and cancel (default: ${DELAY_MS}).
                        With --price last|mark: loop period for re-reading the price file.
  --close-short         Reduce-only Buy ladder closing an open short (default)
  --close-long          Reduce-only Sell ladder closing an open long
  --ignore-exception    On place/cancel errors, log and continue instead of
                        exiting (loop keeps polling; sweep next rung)
  --dry-run             Print the sweep without placing any orders
  --help, -h            Show this help message

Examples:
   scripts/phemex-close-sweep.ts --symbol XBRUSDT --price last --close-long --qty 0.01
   scripts/phemex-close-sweep.ts --symbol XBRUSDT --price mark --close-long --qty 0.01 --delay 2000
   scripts/phemex-close-sweep.ts --symbol XBRUSDT --price last --close-long --qty 0.01 --cancel
   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from last --to mark --step 0.01 --close-long
   scripts/phemex-close-sweep.ts --symbol XBRUSDT --from mark+0.20 --to mark-0.20 --step 0.01 --close-long
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
  // Last occurrence wins — a later --qty/--from/--to/... overrides an earlier one.
  const i = process.argv.lastIndexOf(name);
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

/** Offset form: "mark+0.20" / "last-0.05" — price file ± delta (US-ASCII +/-). */
const PRICE_EXPR = /^(last|mark)([+-])(\d+(?:\.\d+)?)$/;

/**
 * Resolve a price arg that may be "last" (last.txt), "mark" (mark.txt),
 * "last/mark ± delta" (e.g. "mark+0.20"), or a plain number; falls back to
 * `fallback` when the arg is absent.  Used for --from / --to sweep endpoints.
 */
function priceArgValue(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;

  // Offset form: "mark+0.20" / "last-0.05" — price file ± delta
  const m = PRICE_EXPR.exec(raw);
  if (m) {
    let base: number;
    try {
      base = readPriceFile(m[1] === "last" ? LAST_FILE : MARK_FILE);
    } catch (err: unknown) {
      console.error(`✗  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const delta = parseFloat(m[3]);
    const price = m[2] === "+" ? base + delta : base - delta;
    if (!Number.isFinite(price) || price <= 0) {
      console.error(`✗  Invalid price for ${name}: "${raw}" → $${price}`);
      process.exit(1);
    }
    return Math.round(price * 10_000) / 10_000;
  }

  if (raw === "last" || raw === "mark") {
    try {
      return readPriceFile(raw === "last" ? LAST_FILE : MARK_FILE);
    } catch (err: unknown) {
      console.error(`✗  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  const v = parseFloat(raw);
  if (!Number.isFinite(v)) {
    console.error(`✗  Invalid value for ${name}: "${raw}" — use a number, "last", "mark", or "mark±delta"`);
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
/*  Resting-order state (--price last / --cancel)                      */
/* ------------------------------------------------------------------ */

/** A resting reduce-only close order placed via --price, tracked in STATE_FILE. */
interface RestingOrderState {
  symbol: string;
  side: "Buy" | "Sell";
  posSide: "Long" | "Short";
  price: number;
  qty: number;
  orderID: string;
  clOrdID: string;
  placedAt: string;
}

/** Read a price file (last.txt / mark.txt, project root). Throws if unavailable. */
function readPriceFile(file: string): number {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`Cannot read ${file} — run phemex-mark-price2.ts first, or pass --price <n>`);
  }
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid price in ${file}: "${raw}"`);
  return v;
}

/** Load the tracked resting order. Throws if none is tracked. */
function loadRestingState(): RestingOrderState {
  if (!existsSync(STATE_FILE)) {
    throw new Error(`No resting close order tracked (${STATE_FILE} missing) — place one first without --cancel`);
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as RestingOrderState;
  } catch {
    throw new Error(`Corrupt ${STATE_FILE} — delete it and place a fresh order`);
  }
}

function saveRestingState(state: RestingOrderState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function clearRestingState(): void {
  try {
    rmSync(STATE_FILE);
  } catch {
    /* already gone */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface LastLoopOptions {
  symbol: string;
  side: "Buy" | "Sell";
  posSide: "Long" | "Short";
  qty: number;
  delay: number;
  dryRun: boolean;
  ignore: boolean;
  priceFile: string;
  priceLabel: string;
}

/**
 * Loop mode (--price last|mark --delay <ms>): keep a resting reduce-only
 * close order at the current price-file value (last.txt / mark.txt).  Every
 * `delay` ms re-read the file; when the value moves, cancel the old order
 * and place a new one at the new price.  Runs until the process exits
 * (Ctrl+C).  The final resting order is tracked in STATE_FILE so it can be
 * cancelled later with --cancel.
 */
async function runLastLoop(
  opts: LastLoopOptions,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  const { symbol, side, posSide, qty, delay, dryRun, ignore, priceFile, priceLabel } = opts;
  const closeLabel = side === "Sell" ? "long" : "short";

  console.log(`[${fmtTime()}] ═ ${symbol} Close-${closeLabel} @ ${priceLabel} loop ══════════`);
  console.log(`[${fmtTime()}]   Qty:     ${qty}   side: ${side} / ${posSide}  reduceOnly`);
  console.log(`[${fmtTime()}]   Poll:    ${delay}ms  re-read ${priceLabel} → cancel + re-place on change`);
  console.log(`[${fmtTime()}]   Mode:    ${dryRun ? "DRY-RUN" : "LIVE"}  (Ctrl+C to exit; order stays resting, cancel with --cancel)`);
  if (ignore) console.log(`[${fmtTime()}]   Errors:  ignored (--ignore-exception) — loop keeps running on place/cancel errors`);
  console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════`);

  let orderID: string | null = null;
  let currentPrice: number | null = null;

  for (;;) {
    let newPrice: number;
    try {
      newPrice = readPriceFile(priceFile);
    } catch (err: unknown) {
      console.log(`[${fmtTime()}]   –  ${err instanceof Error ? err.message : String(err)} — retrying in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    if (currentPrice !== null && Math.abs(newPrice - currentPrice) < 1e-9) {
      console.log(`[${fmtTime()}]   –  last.txt still $${newPrice.toFixed(4)} — order @ $${currentPrice.toFixed(4)} unchanged, waiting ${delay}ms`);
      await sleep(delay);
      continue;
    }

    // Cancel the previous order before placing at the new price
    if (orderID !== null) {
      process.stdout.write(`[${fmtTime()}]     cancelling ${orderID.slice(0, 8)}…  `);
      try {
        const status = await cancelOrder(symbol, orderID, posSide, true, apiKey, secretRaw);
        if (status === "cancelled") {
          console.log("✓  cancelled");
        } else if (status === "filled") {
          console.log("⚡  already filled — position closed.");
          clearRestingState();
          return;
        } else {
          console.log(`✗  ${status}`);
          if (!ignore) return;
          console.log(`[${fmtTime()}]     --ignore-exception: continuing (order may still be resting — will retry on next move)`);
          await sleep(delay);
          continue;
        }
      } catch (err: unknown) {
        console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
        if (!ignore) return;
        console.log(`[${fmtTime()}]     --ignore-exception: continuing (order may still be resting — will retry on next move)`);
        await sleep(delay);
        continue;
      }
    }

    // Place at the new price
    process.stdout.write(`[${fmtTime()}]   ${side} ${qty} ${symbol} @ $${newPrice.toFixed(4)}  →  placing …  `);
    if (dryRun) {
      console.log("✓  (dry-run — not sent)");
      currentPrice = newPrice;
      orderID = null;
      await sleep(delay);
      continue;
    }

    try {
      const result = await placeReduceOnly({ symbol, side, price: newPrice, qty, posSide }, apiKey, secretRaw);
      const id = result.orderID ?? result.clOrdID ?? "";
      if (!id) throw new Error("No orderID in response");
      orderID = id;
      currentPrice = newPrice;
      saveRestingState({
        symbol,
        side,
        posSide,
        price: newPrice,
        qty,
        orderID: id,
        clOrdID: result.clOrdID ?? id,
        placedAt: new Date().toISOString(),
      });
      console.log(`✓  orderID: ${id.slice(0, 8)}…  (tracked in ${STATE_FILE})`);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${reason}`);
      if (!ignore) return;
      // The previous order was already cancelled — nothing is resting now.
      // Remember the attempted price so the loop idles instead of spinning;
      // the next price move triggers a fresh placement.
      orderID = null;
      currentPrice = newPrice;
      console.log(`[${fmtTime()}]     --ignore-exception: continuing (no order resting — will retry on next move)`);
      await sleep(delay);
      continue;
    }

    await sleep(delay);
  }
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
  const qty = numArg("--qty", QTY);
  const priceArg = getArgValue("--price");
  const cancel = process.argv.includes("--cancel");
  const ignore = process.argv.includes("--ignore-exception") || process.argv.includes("--ignore-exceptions");
  const delay = numArg("--delay", DELAY_MS);

  // Loop mode: --price last|mark with an explicit --delay keeps re-reading
  // the price file and re-placing the close order as the price moves.
  const priceLabel = priceArg === "mark" ? "mark.txt" : priceArg === "last" ? "last.txt" : null;
  const priceFile = priceLabel === null ? null : resolve(ROOT, priceLabel);
  const loopTrack = priceFile !== null && getArgValue("--delay") !== undefined && delay > 0;

  if (qty <= 0) {
    console.error(`✗  --qty must be > 0 (got ${qty})`);
    process.exit(1);
  }
  if (delay < 0) {
    console.error(`✗  --delay must be >= 0 (got ${delay})`);
    process.exit(1);
  }

  // Resolve order direction
  const side: "Buy" | "Sell" = closeMode === "short" ? "Buy" : "Sell";
  const posSide: "Long" | "Short" = closeMode === "short" ? "Short" : "Long";
  const closeLabel = closeMode === "short" ? "short" : "long";

  // Load credentials
  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  /* ------------------------------------------------------------------ */
  /*  Manual cancel of the resting order placed earlier via --price      */
  /*  (or left behind by a sweep) — tracked in STATE_FILE.               */
  /* ------------------------------------------------------------------ */
  if (cancel) {
    const state = loadRestingState();
    console.log(`[${fmtTime()}] ═ ${state.symbol} Cancel Resting Close ═════════════════════`);
    console.log(`[${fmtTime()}]   Offer:   ${state.side} ${state.qty} ${state.symbol} @ $${state.price.toFixed(4)}  (${state.posSide}, reduceOnly)`);
    console.log(`[${fmtTime()}]   orderID: ${state.orderID}`);
    console.log(`[${fmtTime()}]   Mode:    ${dryRun ? "DRY-RUN" : "LIVE"}`);
    console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════`);

    if (dryRun) {
      console.log(`[${fmtTime()}] ✔  Would cancel ${state.orderID.slice(0, 8)}… — nothing sent to the exchange.`);
      return;
    }

    try {
      const status = await cancelOrder(state.symbol, state.orderID, state.posSide, true, creds.PHEMEX_API_KEY, secretRaw);
      if (status === "cancelled") {
        console.log(`[${fmtTime()}] ✓  Cancelled ${state.orderID.slice(0, 8)}…`);
        clearRestingState();
      } else if (status === "filled") {
        console.log(`[${fmtTime()}] ⚡  Order already filled — position closed.`);
        clearRestingState();
      } else {
        console.error(`[${fmtTime()}] ✗  ${status}`);
        process.exit(1);
      }
    } catch (err: unknown) {
      console.error(`[${fmtTime()}] ✗  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  /* ------------------------------------------------------------------ */
  /*  Single resting close order at --price <n|last|mark>               */
  /* ------------------------------------------------------------------ */
  if (priceArg !== undefined) {
    // Loop mode: keep a close order at the current price-file value.
    if (loopTrack && priceFile !== null && priceLabel !== null) {
      await runLastLoop({ symbol, side, posSide, qty, delay, dryRun, ignore, priceFile, priceLabel }, creds.PHEMEX_API_KEY, secretRaw);
      return;
    }

    let price: number;
    let priceSrc: string;
    if (priceFile !== null && priceLabel !== null) {
      try {
        price = readPriceFile(priceFile);
        priceSrc = `${priceLabel} ($${price.toFixed(4)})`;
      } catch (err: unknown) {
        console.error(`✗  ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    } else {
      price = parseFloat(priceArg);
      if (!Number.isFinite(price) || price <= 0) {
        console.error(`✗  Invalid --price: "${priceArg}" — use a number, "last", or "mark"`);
        process.exit(1);
      }
      priceSrc = `--price $${price.toFixed(4)}`;
    }

    console.log(`[${fmtTime()}] ═ ${symbol} Close-${closeLabel} — single order ═══════════════`);
    console.log(`[${fmtTime()}]   Price:   $${price.toFixed(4)}  (${priceSrc})`);
    console.log(`[${fmtTime()}]   Qty:     ${qty}   side: ${side} / ${posSide}  reduceOnly`);
    console.log(`[${fmtTime()}]   Mode:    ${dryRun ? "DRY-RUN" : "LIVE"}  (resting — cancel later with --cancel)`);
    console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════`);

    if (dryRun) {
      console.log(`   ${side} ${qty} ${symbol} @ $${price.toFixed(4)}  →  resting reduce-only`);
      console.log(`[${fmtTime()}] ✔  Order would be placed and left resting — nothing sent to the exchange.`);
      return;
    }

    try {
      const result = await placeReduceOnly({ symbol, side, price, qty, posSide }, creds.PHEMEX_API_KEY, secretRaw);
      const orderID = result.orderID ?? result.clOrdID ?? "";
      if (!orderID) throw new Error("No orderID in response");
      saveRestingState({
        symbol,
        side,
        posSide,
        price,
        qty,
        orderID,
        clOrdID: result.clOrdID ?? orderID,
        placedAt: new Date().toISOString(),
      });
      console.log(`[${fmtTime()}] ✓  Placed resting ${side} ${qty} ${symbol} @ $${price.toFixed(4)} — orderID: ${orderID.slice(0, 8)}…`);
      console.log(`[${fmtTime()}] ✔  Tracked in ${STATE_FILE}. Cancel it later with:`);
      console.log(`        scripts/phemex-close-sweep.ts --symbol ${symbol} --cancel`);
    } catch (err: unknown) {
      console.error(`[${fmtTime()}] ✗  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  // --- Sweep mode ---
  const from = priceArgValue("--from", getArgValue("--from"), FROM);
  const to = priceArgValue("--to", getArgValue("--to"), TO);
  const step = numArg("--step", STEP);

  // Validation
  if (step === 0) {
    console.error(`✗  --step must be non-zero (got ${step})`);
    process.exit(1);
  }

  // Build the price list — direction follows --from → --to, step is a magnitude
  const dir = to >= from ? 1 : -1;
  const prices: number[] = [];
  for (let p = from; dir > 0 ? p <= to + 1e-9 : p >= to - 1e-9; p += dir * Math.abs(step)) {
    prices.push(Math.round(p * 10_000) / 10_000);
  }

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
      // Track the resting order so --cancel can clean up a sweep leftover
      saveRestingState({
        symbol,
        side,
        posSide,
        price,
        qty,
        orderID: orderId,
        clOrdID: result.clOrdID ?? orderId,
        placedAt: new Date().toISOString(),
      });
      console.log(`✓  orderID: ${orderId.slice(0, 8)}…`);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${reason}`);
      clearRestingState(); // previous rung's order is gone — nothing resting
      swept++;
      if (ignore) {
        console.log(`[${fmtTime()}]     --ignore-exception: continuing to next rung`);
        if (delay > 0) await sleep(delay);
        continue;
      }
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
        clearRestingState();
      } else if (status === "filled") {
        console.log("⚡  already filled — stopping sweep");
        filled = true;
        clearRestingState();
      } else {
        console.log(`✗  ${status}`);
        swept++;
        if (ignore) {
          console.log(`[${fmtTime()}]     --ignore-exception: continuing to next rung (order may still be resting)`);
          if (delay > 0) await sleep(delay);
          continue;
        }
        aborted = status;
        break;
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${reason}`);
      swept++;
      if (ignore) {
        console.log(`[${fmtTime()}]     --ignore-exception: continuing to next rung (order may still be resting)`);
        if (delay > 0) await sleep(delay);
        continue;
      }
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