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
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --price 79.4 --cancel
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --price last --close-long --qty 0.01
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 100 --to 100 --side short # OPEN SHORT # SELL
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 100 --to 100 --cancel-short --side short # CANCEL
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 61 --to 61 --close-short # CLOSE SHORT # BUY
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 61 --to 61 --cancel-close # CLOSE SHORT # CANCEL
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 100 --to 100 --close-long # CLOSE LONG # SELL
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 100 --to 100 --cancel-close # CANCEL
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --cancel --close-long --price 79.07 # WATCH: CANCEL CLOSE-LONG after 10s
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --cancel --close-long # WATCH: CANCEL ALL CLOSE-LONG at any price after 10s
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 69 --to 69 --side long # OPEN LONG # BUY
 *   scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 69 --to 69 --cancel-open # CANCEL
 *
 * Options:
 *   --symbol <symbol>   Contract symbol (default: XBRUSDT)
 *   --price <n|last|mark>  Single resting order at <n>, or at the price read
 *                        from last.txt / mark.txt — shorthand for
 *                        --from <p> --to <p>; composes with --cancel* flags.
 *                        Cannot be combined with --from/--to.
 *                        A price spec (--price, or both --from and --to) is
 *                        required — the $50 → $70 defaults are never assumed.
 *                        Optional in watch-close mode (--cancel --close-*):
 *                        omitting it watches close orders at any price.
 *   --from <price>      Ladder start price (default: 50)
 *   --to <price>        Ladder end price, inclusive (default: 70)
 *   --step <price>      Price step between rungs (default: 1)
 *   --qty <quantity>    Quantity per order (default: 0.01)
 *   --leverage <n>      Leverage (default: 100; ignored in close mode)
 *   --side <long|short> Order side (default: long; not allowed in close mode)
 *   --close-short       Reduce-only Buy ladder that closes an open short
 *   --close-long        Reduce-only Sell ladder that closes an open long
 *   --cancel            Cancel all active orders with price within [--from, --to]
 *   --cancel-close      Cancel only reduce-only (close) orders in [--from, --to]
 *   --cancel-open       Cancel only non-reduce-only (open) orders in [--from, --to]
 *   --cancel-short      Cancel only short-side (posSide=Short) orders in [--from, --to]
 *   --cancel-long       Cancel only long-side (posSide=Long) orders in [--from, --to]
 *   --dry-run           Print the ladder without placing any orders
 *   --help, -h          Show this help message
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
const ROOT = resolve(import.meta.dirname, ".."); // project root
const LAST_FILE = resolve(ROOT, "last.txt"); // written by phemex-mark-price2.ts
const MARK_FILE = resolve(ROOT, "mark.txt"); // written by phemex-mark-price2.ts

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
  --price <n|last|mark>  Single resting order at <n>, or at the price read
                        from last.txt / mark.txt — shorthand for
                        --from <p> --to <p>; composes with --cancel* flags.
                        Cannot be combined with --from/--to.
                        A price spec (--price, or both --from and --to) is
                        required — the $50 → $70 defaults are never assumed.
                        Optional in watch-close mode (--cancel --close-*):
                        omitting it watches close orders at any price.
  --from <price>      Ladder start price (default: ${FROM})
  --to <price>        Ladder end price, inclusive (default: ${TO})
  --step <price>      Price step between rungs (default: ${STEP})
  --qty <quantity>    Quantity per order (default: ${QTY})
  --leverage <n>      Leverage (default: ${LEVERAGE}; ignored in close mode)
  --side <long|short> Order side (default: long; not allowed in close mode)
  --close-short       Reduce-only Buy ladder that closes an open short
     --close-long        Reduce-only Sell ladder that closes an open long
     --cancel            Cancel all active orders with price within [--from, --to]
     --cancel-close      Cancel only reduce-only (close) orders in [--from, --to]
     --cancel-open       Cancel only non-reduce-only (open) orders in [--from, --to]
     --cancel-short      Cancel only short-side (posSide=Short) orders in [--from, --to]
     --cancel-long       Cancel only long-side (posSide=Long) orders in [--from, --to]
     --interval <sec>    Poll interval in seconds (default: 2; watch-close mode only)
     --age <sec>         Cancel close orders older than this, in seconds (default: 10)
     --once              Watch-close mode: single poll cycle, then exit
     --dry-run           Print the ladder without placing any orders
     --help, -h          Show this help message

   Examples:
       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --price 79.4 --cancel
       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --price 79.4 --close-long --qty 0.01
       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 100 --to 100 --side short # OPEN SHORT # SELL
       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 100 --to 100 --cancel-short --side short # CANCEL

       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 61 --to 61 --close-short # CLOSE SHORT # BUY
       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 61 --to 61 --cancel-close # CLOSE SHORT # CANCEL

       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 100 --to 100 --close-long # CLOSE LONG # SELL
       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 100 --to 100 --cancel-close # CANCEL
       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --cancel --close-long --price 79.07 # WATCH: CANCEL CLOSE-LONG after 10s
       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --cancel --close-long # WATCH: CANCEL ALL CLOSE-LONG at any price after 10s

       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 69 --to 69 --side long # OPEN LONG # BUY
       scripts/phemex-limit-rungs.ts --symbol XBRUSDT --from 69 --to 69 --cancel-open # CANCEL
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

/** Read a price file (last.txt / mark.txt, project root). Throws if unavailable. */
function readPriceFile(file: string): number {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`Cannot read ${file} — run phemex-mark-price2.ts first, or pass a number`);
  }
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid price in ${file}: "${raw}"`);
  return v;
}

/**
 * Resolve a price arg that may be "last" (last.txt), "mark" (mark.txt), or
 * a plain number; falls back to `fallback` when the arg is absent.
 */
function priceArgValue(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
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
    console.error(`✗  Invalid value for ${name}: "${raw}" — use a number, "last", or "mark"`);
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

/* ------------------------------------------------------------------ */
/*  Cancel mode — cancel active orders with price in [from, to]        */
/* ------------------------------------------------------------------ */

/**
 * Fetch all active orders for a symbol (ordStatus=New plus ordStatus=Untriggered,
 * merged and deduplicated by orderID). Returns raw API rows.
 */
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

/**
 * True when the order row is reduce-only (execInst=ReduceOnly, or reduceOnly=true).
 * Reduce-only orders are stored as conditional orders and need untriggered=true
 * on the cancel request.
 */
function isReduceOnlyRow(o: Record<string, unknown>): boolean {
  return /reduceonly/i.test(String(o.execInst ?? "")) || o.reduceOnly === true;
}

/**
 * Position side for a cancel request. Reduce-only Buy orders close a short
 * (posSide Short); reduce-only Sell orders close a long (posSide Long).
 * Plain orders: Buy → Long, Sell → Short.
 */
function posSideFor(o: Record<string, unknown>): string {
  const side = String(o.side ?? "Buy").toLowerCase();
  if (isReduceOnlyRow(o)) return side === "buy" ? "Short" : "Long";
  return side === "buy" ? "Long" : "Short";
}

/**
 * Cancel one order by ID. DELETE /g-orders (USDT-M) or /orders (Coin-M).
 * Success is reported in the response body's data[0].bizError (top-level
 * `code` is 0 even when the order was not found), so check both.
 */
async function cancelOrderRow(
  symbol: string,
  orderId: string,
  row: Record<string, unknown>,
  apiKey: string,
  secretRaw: Buffer,
): Promise<{ ok: boolean; detail: string }> {
  const qp = new URLSearchParams({ orderID: orderId, symbol });
  qp.set("posSide", posSideFor(row));
  if (isReduceOnlyRow(row)) qp.set("untriggered", "true");

  const endpoint = symbol.toUpperCase().endsWith("USDT") ? "/g-orders" : "/orders";
  const resp = (await request("DELETE", endpoint, qp.toString(), apiKey, secretRaw, "")) as Record<string, unknown>;
  const data = resp.data as { bizError?: number }[] | undefined;
  const bizError = data?.[0]?.bizError;
  const ok = resp.code === 0 && (bizError === undefined || bizError === 0);
  return ok ? { ok: true, detail: "" } : { ok: false, detail: String(resp.msg ?? `bizError ${bizError}`) };
}

/** Cancel every active order whose limit price falls within [from, to] (inclusive). */
async function runCancelMode(
  symbol: string,
  from: number,
  to: number,
  dryRun: boolean,
  cancelFilter: "close" | "open" | "all" = "all",
  cancelPosSide: "short" | "long" | "all" = "all",
): Promise<void> {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}] ⟐  Fetching active ${symbol} orders …`);
  const rows = await fetchActiveOrders(symbol, creds.PHEMEX_API_KEY, secretRaw);

  const targets = rows
    .filter((o) => {
      const price = parseFloat(String(o.priceRp ?? o.price ?? ""));
      return !Number.isNaN(price) && price >= lo && price <= hi;
    })
    .filter((o) => {
      if (cancelFilter === "close") return isReduceOnlyRow(o);
      if (cancelFilter === "open") return !isReduceOnlyRow(o);
      return true; // "all"
    })
    .filter((o) => {
      if (cancelPosSide === "all") return true;
      const ps = posSideFor(o).toLowerCase();
      return ps === cancelPosSide;
    })
    .sort((a, b) => parseFloat(String(b.priceRp ?? b.price)) - parseFloat(String(a.priceRp ?? a.price)));

  const filterLabel =
    (cancelFilter === "close" ? " close-only" : cancelFilter === "open" ? " open-only" : "") +
    (cancelPosSide === "short" ? " short-side" : cancelPosSide === "long" ? " long-side" : "");
  console.log(`[${fmtTime()}]   Found ${targets.length} active order(s) with price in [$${lo}, $${hi}]${filterLabel}.`);
  if (targets.length === 0) return;

  if (dryRun) {
    console.log(`[${fmtTime()}]   DRY RUN — would cancel:\n`);
    for (const o of targets) {
      console.log(
        `  ·  ${String(o.orderID ?? "?").padEnd(36)}  ${String(o.side ?? "?").padEnd(4)} qty ` +
        `${String(o.orderQtyRq ?? o.orderQty ?? "?").padStart(6)} limit @ ${String(o.priceRp ?? o.price ?? "?").padStart(8)}` +
        `  (posSide ${posSideFor(o)})`,
      );
    }
    console.log(`\n[${fmtTime()}]   DRY RUN — nothing cancelled.`);
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const o of targets) {
    const orderId = String(o.orderID ?? "");
    const side = String(o.side ?? "Buy");
    const price = String(o.priceRp ?? o.price ?? "?");
    process.stdout.write(`[${fmtTime()}]   ${orderId}  ${side} @ ${price}  …  `);
    try {
      const result = await cancelOrderRow(symbol, orderId, o, creds.PHEMEX_API_KEY, secretRaw);
      if (result.ok) {
        console.log("✓");
        ok++;
      } else {
        console.log(`✗  ${result.detail}`);
        fail++;
      }
    } catch (err: unknown) {
      console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
      fail++;
    }
    await new Promise((r) => setTimeout(r, ORDER_DELAY_MS));
  }
  console.log(`[${fmtTime()}] ✔  Done — ${ok} cancelled, ${fail} failed.`);
  if (fail > 0) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/*  Watch-close cancel mode — cancel close orders aged past a limit    */
/* ------------------------------------------------------------------ */

/**
 * Watch active orders and cancel close-side (reduce-only) orders whose
 * price falls within [from, to] once they have existed longer than --age
 * seconds. Each order ID is tracked in a Map<string, Date> holding the
 * time it was first seen (tested); orders still present on later polls
 * keep their original first-seen time, orders that vanished are dropped,
 * and any tracked order whose first-seen time is older than --age seconds
 * is cancelled. --close-long targets reduce-only Sell orders (posSide
 * Long), --close-short targets reduce-only Buy orders (posSide Short).
 */
async function runWatchCloseCancelMode(
  symbol: string,
  closeMode: "long" | "short",
  from: number,
  to: number,
  dryRun: boolean,
): Promise<void> {
  // NaN bounds mean "any price" — the price varies, so --price is optional.
  const lo = Number.isNaN(from) ? null : Math.min(from, to);
  const hi = Number.isNaN(to) ? null : Math.max(from, to);
  const rangeLabel = lo === null && hi === null ? "any price" : `$${lo}–$${hi}`;
  const intervalMs = Math.max(parseInt(getArgValue("--interval") ?? "", 10) || 2, 1) * 1000;
  const ageMs = Math.max(parseInt(getArgValue("--age") ?? "", 10) || 10, 1) * 1000;
  const once = process.argv.includes("--once");

  // close-long = reduce-only Sell (posSide Long); close-short = reduce-only Buy (posSide Short)
  const wantSide = closeMode === "long" ? "Sell" : "Buy";
  const wantLabel = closeMode === "long" ? "close-long" : "close-short";

  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  // orderID → time (Date) the order was first tested / first seen
  const firstSeen = new Map<string, Date>();

  console.log(`[${fmtTime()}] ═ Watch ${symbol} ${wantLabel} orders @ ${rangeLabel} ═${dryRun ? "  DRY RUN" : ""}`);
  console.log(`[${fmtTime()}]   Poll every ${intervalMs / 1000}s · cancel ${wantLabel} orders older than ${ageMs / 1000}s · ${dryRun ? "no cancels will be sent" : "cancels enabled"}`);
  console.log(`[${fmtTime()}] ═════════════════════════════════════════════════════════`);

  let cancelled = 0;
  let polls = 0;

  async function poll(): Promise<void> {
    polls++;
    let rows: Record<string, unknown>[];
    try {
      rows = await fetchActiveOrders(symbol, creds.PHEMEX_API_KEY, secretRaw);
    } catch (err: unknown) {
      console.error(`[${fmtTime()}] ✗  Fetch failed: ${err instanceof Error ? err.message : String(err)} — retrying next cycle`);
      return;
    }

    const now = new Date();

    // Only close-side orders of the target side, with price within [lo, hi]
    // (null bounds match any price)
    const targets = rows.filter((o) => {
      if (!isReduceOnlyRow(o)) return false;
      if (String(o.side ?? "").toLowerCase() !== wantSide.toLowerCase()) return false;
      const price = parseFloat(String(o.priceRp ?? o.price ?? ""));
      return !Number.isNaN(price) && (lo === null || price >= lo) && (hi === null || price <= hi);
    });

    const currentIds = new Set<string>();
    for (const o of targets) {
      const oid = String(o.orderID ?? "");
      if (!oid) continue;
      currentIds.add(oid);
      if (!firstSeen.has(oid)) {
        firstSeen.set(oid, now);
        console.log(
          `[${fmtTime()}]   ➕  tracked ${oid}  ${String(o.side ?? "?")} qty ` +
          `${String(o.orderQtyRq ?? o.orderQty ?? "?").padStart(6)} limit @ ${String(o.priceRp ?? o.price ?? "?")}  (${wantLabel})`,
        );
      }
    }

    // Drop orders that are no longer active (filled / cancelled elsewhere)
    for (const [oid, seen] of firstSeen) {
      if (!currentIds.has(oid)) {
        const ageSec = ((now.getTime() - seen.getTime()) / 1000).toFixed(1);
        console.log(`[${fmtTime()}]   🗑  dropped ${oid} (gone after ${ageSec}s)`);
        firstSeen.delete(oid);
      }
    }

    // Cancel tracked close orders that have existed longer than ageMs
    for (const o of targets) {
      const oid = String(o.orderID ?? "");
      const seen = firstSeen.get(oid);
      if (!seen) continue;
      const openMs = now.getTime() - seen.getTime();
      if (openMs < ageMs) continue;

      const side = String(o.side ?? "?");
      const price = String(o.priceRp ?? o.price ?? "?");
      const ageSec = (openMs / 1000).toFixed(1);

      if (dryRun) {
        console.log(`[${fmtTime()}]   ✂  DRY RUN — would cancel ${oid}  ${side} @ ${price}  (${wantLabel}, existed ${ageSec}s > ${ageMs / 1000}s)`);
        continue;
      }

      process.stdout.write(`[${fmtTime()}]   ✂  cancelling ${oid}  ${side} @ ${price}  (${wantLabel}, existed ${ageSec}s)  …  `);
      try {
        const result = await cancelOrderRow(symbol, oid, o, creds.PHEMEX_API_KEY, secretRaw);
        if (result.ok) {
          console.log("✓");
          cancelled++;
          firstSeen.delete(oid);
        } else {
          console.log(`✗  ${result.detail}`);
        }
      } catch (err: unknown) {
        console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, ORDER_DELAY_MS));
    }

    if (targets.length === 0) {
      console.log(`[${fmtTime()}]   ℹ  no ${wantLabel} orders at ${rangeLabel} (${firstSeen.size} tracked)`);
    }
  }

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Stopped — ${polls} poll(s), ${cancelled} order(s) cancelled.`);
    process.exit(0);
  });

  for (;;) {
    await poll();
    if (once) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  console.log(`[${fmtTime()}]   Done — ${polls} poll(s), ${cancelled} order(s) cancelled.`);
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
  // --cancel + --close-long/--close-short → watch-close mode (price optional)
  const watchCancel = process.argv.includes("--cancel") && closeMode !== "none";

  const symbol = getArgValue("--symbol") ?? SYMBOL;
  const priceArg = getArgValue("--price");
  if (priceArg !== undefined && (getArgValue("--from") !== undefined || getArgValue("--to") !== undefined)) {
    console.error(`✗  Cannot combine --price with --from/--to`);
    process.exit(1);
  }
  // Never assume the $50 → $70 defaults: without an explicit price spec
  // (--price, or both --from and --to) show usage instead. The watch-close
  // cancel mode is the exception — the price varies, so --price is optional
  // there and omitting it means "any price".
  const hasFrom = getArgValue("--from") !== undefined;
  const hasTo = getArgValue("--to") !== undefined;
  if (priceArg === undefined && !(hasFrom && hasTo) && !watchCancel) {
    console.error(`✗  No price specified — pass --price <n|last|mark>, or both --from and --to.`);
    usage();
  }
  // --price <n|last|mark> is shorthand for a single-rung ladder (--from p --to p),
  // so it composes with the cancel modes (cancel orders at exactly that price).
  // In watch-close mode a missing price spec leaves the bounds open (NaN = any price).
  const from = priceArg !== undefined ? priceArgValue("--price", priceArg, NaN) : hasFrom ? numArg("--from", FROM) : NaN;
  const to = priceArg !== undefined ? from : hasTo ? numArg("--to", TO) : NaN;

  // Cancel mode: ignore step/qty/leverage/side and cancel orders by price range
  const cancelClose = process.argv.includes("--cancel-close");
  const cancelOpen = process.argv.includes("--cancel-open");
  const cancelShort = process.argv.includes("--cancel-short");
  const cancelLong = process.argv.includes("--cancel-long");
  if (cancelClose && cancelOpen) {
    console.error(`✗  Cannot combine --cancel-close with --cancel-open`);
    process.exit(1);
  }
  if (cancelShort && cancelLong) {
    console.error(`✗  Cannot combine --cancel-short with --cancel-long`);
    process.exit(1);
  }
  let cancelFilter: "close" | "open" | "all" = "all";
  if (cancelClose) cancelFilter = "close";
  else if (cancelOpen) cancelFilter = "open";
  let cancelPosSide: "short" | "long" | "all" = "all";
  if (cancelShort) cancelPosSide = "short";
  else if (cancelLong) cancelPosSide = "long";
  if (process.argv.includes("--cancel") || cancelClose || cancelOpen || cancelShort || cancelLong) {
    // --cancel combined with --close-long/--close-short switches to the
    // watch mode: cancel those close orders only after they have existed
    // longer than --age seconds (tracked in a Map<orderID, firstSeen>).
    if (watchCancel) {
      await runWatchCloseCancelMode(symbol, closeMode, from, to, dryRun);
      return;
    }
    await runCancelMode(symbol, from, to, dryRun, cancelFilter, cancelPosSide);
    return;
  }

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
