#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-list-untriggered-range.ts  —  List untriggered trigger orders for
 * a given symbol, optionally narrowed to a price range, showing order IDs.
 *
 * Same API call as phemex-list-untriggered-orders.ts
 * (fetchUntriggeredOrders → GET /orders/activeList?ordStatus=Untriggered&symbol=<symbol>),
 * but filters the result locally: --from / --to are inclusive bounds on the
 * order's limit price (the "price" column printed below).
 *
 * Each order is classified from its own reduce-only flag (execInst=ReduceOnly
 * in the raw row): a reduce-only Buy is "close short" and a reduce-only Sell
 * is "close long"; an order that is not reduce-only opens a position (Buy →
 * open long, Sell → open short).
 *
 * Usage:
 *   npx tsx phemex-list-untriggered-range.ts --symbol XBRUSDT
 *   npx tsx phemex-list-untriggered-range.ts --symbol XBRUSDT --from 60 --to 100
 *   npx tsx phemex-list-untriggered-range.ts --symbol XBRUSDT --from 60
 *   npx tsx phemex-list-untriggered-range.ts --symbol XBRUSDT --to 100 --dry-run
 *   npx tsx phemex-list-untriggered-range.ts --symbol XBRUSDT --from 79 --to 80 --cancel
 *   npx tsx phemex-list-untriggered-range.ts --symbol XBRUSDT --from 79 --to 80 --cancel --loop
 *   npx tsx phemex-list-untriggered-range.ts --symbol XBRUSDT --from 79 --to 80 --cancel --loop --interval 5000
 */

import { base64UrlDecode } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import { cancelOrder } from "../src/place-limit-order.js";
import {
  fetchUntriggeredOrders,
  untriggeredEndpoint,
  untriggeredQuery,
  ApiError,
  type UntriggeredOrder,
} from "../src/untriggered-orders.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage(): never {
  console.log(`
Usage: ./phemex-list-untriggered-range.ts --symbol <symbol[,symbol...]> [options]

List untriggered trigger orders via GET /orders/activeList, optionally
narrowed to a price range (inclusive bounds on the limit price).

Options:
  --symbol <symbols>  Trading pair(s), comma-separated (e.g. XBRUSDT, XTIUSDT)
  --from <price>      Lower price bound, inclusive (default: none)
  --to <price>        Upper price bound, inclusive (default: none)
  --cancel            Cancel every order in the filtered range
  --loop              Continuously poll every <interval> ms
  --interval <ms>     Polling interval in ms (default 5000, with --loop)
  --once              With --loop: single poll, then exit
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-list-untriggered-range.ts --symbol XBRUSDT
  ./phemex-list-untriggered-range.ts --symbol XBRUSDT --from 60 --to 100
  ./phemex-list-untriggered-range.ts --symbol XBRUSDT --from 60
  ./phemex-list-untriggered-range.ts --symbol XBRUSDT --from 79 --to 80 --cancel
  ./phemex-list-untriggered-range.ts --symbol XBRUSDT --from 79 --to 80 --cancel --loop --interval 5000
  ./phemex-list-untriggered-range.ts --symbol XBRUSDT,XTIUSDT --to 100 --dry-run
`);
  process.exit(0);
}

/** True when the order is reduce-only (execInst=ReduceOnly, or reduceOnly=true). */
function isReduceOnly(o: UntriggeredOrder): boolean {
  return /reduceonly/i.test(String(o.raw.execInst ?? "")) || o.raw.reduceOnly === true;
}

/** Classify an order from its side and reduce-only flag. */
function classifyOrder(side: string, reduceOnly: boolean): string {
  if (reduceOnly) return side === "Buy" ? "close short" : "close long";
  return side === "Buy" ? "open long" : "open short";
}

/** Parse an inclusive price bound; missing arg means "open" on that side. */
function parseBound(name: string): number | undefined {
  const raw = getArg(`--${name}`);
  if (raw === undefined) return undefined;
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) {
    console.error(`  ✗ Invalid --${name} value: "${raw}" (expected a number)`);
    process.exit(1);
  }
  return value;
}

/** Order limit price as a number, or NaN when unparseable. */
function orderPrice(o: UntriggeredOrder): number {
  return parseFloat(o.price);
}

/** Position side implied by the order side (USDT-M cancels require it). */
function posSideFor(side: string): string {
  return side.toLowerCase() === "buy" ? "Long" : "Short";
}

/* ------------------------------------------------------------------ */
/*  Fetch & print                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fetch untriggered orders for all given symbols, keep only those whose
 * price falls inside [from, to] (inclusive; undefined bound = open side),
 * print the table with full order IDs, and — when `cancel` is set — cancel
 * every order in the filtered range (DELETE /orders?orderID=…&symbol=…).
 *
 * Returns the number of orders whose cancellation failed (0 when nothing
 * was cancelled or everything succeeded).
 */
async function fetchAndPrint(
  symbols: string[],
  apiKey: string,
  secretRaw: Buffer,
  from: number | undefined,
  to: number | undefined,
  cancel: boolean,
): Promise<number> {
  const collected: { symbol: string; order: UntriggeredOrder }[] = [];
  const totalBySymbol = new Map<string, number>();

  for (const symbol of symbols) {
    const isUsdtM = symbol.toUpperCase().endsWith("USDT");
    process.stdout.write(`⟐  Fetching untriggered orders for ${symbol} (${isUsdtM ? "USDT-M" : "Coin-M"}) … `);

    let rows: UntriggeredOrder[];
    try {
      rows = await fetchUntriggeredOrders(symbol, apiKey, secretRaw);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        console.log(`✗ ${err.message}`);
      } else {
        console.log(`✗ ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    totalBySymbol.set(symbol, rows.length);
    console.log(`${rows.length} order(s)`);
    for (const order of rows) {
      const price = orderPrice(order);
      if (from !== undefined && !(price >= from)) continue;
      if (to !== undefined && !(price <= to)) continue;
      collected.push({ symbol, order });
    }
  }

  const rangeNote =
    from !== undefined && to !== undefined
      ? `[${from} – ${to}]`
      : from !== undefined
        ? `[≥ ${from}]`
        : to !== undefined
          ? `[≤ ${to}]`
          : "(no range filter)";

  if (collected.length === 0) {
    console.log(`  ℹ  No untriggered orders in range ${rangeNote}.`);
    return 0;
  }

  // Sort by symbol, then by price (descending) so the highest rung prints first
  collected.sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol) || parseFloat(b.order.price) - parseFloat(a.order.price),
  );

  const symbolWidth = Math.max(...collected.map((c) => c.symbol.length), 6);
  const total = [...totalBySymbol.values()].reduce((n, c) => n + c, 0);

  console.log(
    `  ✓  ${collected.length} of ${total} untriggered order(s) in range ${rangeNote} (classified by reduce-only flag):\n`,
  );
  for (const { symbol, order: o } of collected) {
    const action = classifyOrder(o.side, isReduceOnly(o));
    console.log(
      `${symbol.padEnd(symbolWidth)}  ${(o.orderID || "?").padEnd(36)}  ${(o.side || "?").padEnd(4)} qty ` +
      `${(o.qty || "?").padStart(6)} limit @ ${(o.price ? Number(o.price).toFixed(2) : "?").padStart(5)}  →  ${action}`,
    );
  }

  if (!cancel) return 0;

  console.log(`\n  ✓  Cancelling ${collected.length} order(s) …\n`);

  const results = await Promise.all(
    collected.map(async ({ symbol, order: o }) => {
      const orderId = o.orderID;
      const side = o.side || "Buy";
      const price = o.price ? Number(o.price).toFixed(2) : "?";
      const posSide = posSideFor(side);

      process.stdout.write(`  ${orderId}  ${side} @ ${price}  …  `);

      try {
        const r = await cancelOrder({ symbol, orderId, posSide }, apiKey, secretRaw);
        if (r.code === 0) {
          console.log("✓");
          return { ok: 1, fail: 0 };
        }
        console.log(`✗  ${String(r.msg ?? r.code)}`);
        return { ok: 0, fail: 1 };
      } catch (err: unknown) {
        console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
        return { ok: 0, fail: 1 };
      }
    }),
  );

  const ok = results.reduce((s, r) => s + r.ok, 0);
  const fail = results.reduce((s, r) => s + r.fail, 0);

  console.log(`\n  Done — ${ok} cancelled, ${fail} failed`);
  return fail;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbolArg = getArg("--symbol");
  if (!symbolArg) usage();

  // Support a comma-separated list of symbols (e.g. --symbol XBRUSDT,XTIUSDT)
  const symbols = symbolArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length === 0) usage();

  const from = parseBound("from");
  const to = parseBound("to");
  const cancel = hasFlag("--cancel");

  if (hasFlag("--dry-run")) {
    console.log(`\n  DRY RUN — Would send:\n`);
    for (const symbol of symbols) {
      console.log(`  GET ${untriggeredEndpoint(symbol)}?${untriggeredQuery(symbol)}`);
    }
    console.log(`\n  Range filter (applied locally to the price column):`);
    console.log(`    --from ${from ?? "-"}   --to ${to ?? "-"}   --cancel ${cancel ? "yes" : "no"}`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const LOOP_MODE = hasFlag("--loop");
  const LOOP_ONCE = hasFlag("--once");
  const loopIdx = process.argv.indexOf("--interval");
  const LOOP_INTERVAL = loopIdx !== -1
    ? Math.max(parseInt(process.argv[loopIdx + 1], 10) || 5000, 1000)
    : 5000;

  if (LOOP_MODE) {
    process.stdout.write(`Loop mode — polling every ${LOOP_INTERVAL} ms`);
    if (LOOP_ONCE) process.stdout.write(" (once)");
    process.stdout.write("\n\n");
    let failed = 0;
    while (true) {
      failed = await fetchAndPrint(symbols, creds.PHEMEX_API_KEY, secretRaw, from, to, cancel);
      if (LOOP_ONCE) break;
      await sleep(LOOP_INTERVAL);
    }
    if (failed > 0) process.exit(1);
    return;
  }

  // Single run
  const failures = await fetchAndPrint(symbols, creds.PHEMEX_API_KEY, secretRaw, from, to, cancel);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
