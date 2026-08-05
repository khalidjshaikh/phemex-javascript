#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-list-untriggered-orders.ts  —  List untriggered trigger orders
 * for a given symbol via the Phemex API.
 *
 * The API call lives in src/untriggered-orders.ts
 * (fetchUntriggeredOrders → GET /orders/activeList?ordStatus=Untriggered&symbol=<symbol>).
 *
 * Each order is classified from its own reduce-only flag (execInst=ReduceOnly
 * in the raw row): a reduce-only Buy is "close short" and a reduce-only Sell
 * is "close long"; an order that is not reduce-only opens a position (Buy →
 * open long, Sell → open short).
 *
 * Usage:
 *   npx tsx phemex-list-untriggered-orders.ts --symbol BTCUSD
 *   npx tsx phemex-list-untriggered-orders.ts --symbol ETHUSD  --dry-run
 *   npx tsx phemex-list-untriggered-orders.ts --symbol XBRUSDT,XTIUSDT
 *   npx tsx phemex-list-untriggered-orders.ts --symbol XBRUSDT --loop
 *   npx tsx phemex-list-untriggered-orders.ts --symbol XBRUSDT --loop --interval 5000
 */

import { base64UrlDecode } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentialsLocal } from "../src/credentials.js";
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
Usage: ./phemex-list-untriggered-orders.ts --symbol <symbol[,symbol...]> [options]

List untriggered trigger orders for one or more symbols via GET /orders/activeList.

Options:
  --symbol <symbols>  Trading pair(s), comma-separated (e.g. BTCUSD, ETHUSD, XBRUSDT,XTIUSDT)
  --dry-run           Show what would be sent without executing
  --loop              Continuously poll every <interval> ms
  --interval <ms>     Polling interval in ms (default 5000, with --loop)
  --once              With --loop: single poll, then exit
  --help, -h          Show this help message

Examples:
  ./phemex-list-untriggered-orders.ts --symbol BTCUSD
  ./phemex-list-untriggered-orders.ts --symbol ETHUSD  --dry-run
  ./phemex-list-untriggered-orders.ts --symbol XBRUSDT,XTIUSDT
  ./phemex-list-untriggered-orders.ts --symbol XBRUSDT --loop
  ./phemex-list-untriggered-orders.ts --symbol XBRUSDT --loop --interval 5000
  ./phemex-list-untriggered-orders.ts --symbol XBRUSDT --loop --once
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

/* ------------------------------------------------------------------ */
/*  Fetch & print                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fetch untriggered orders for all given symbols, print the table.
 * Returns the number of orders found.
 */
async function fetchAndPrint(
  symbols: string[],
  apiKey: string,
  secretRaw: Buffer,
): Promise<number> {
  const collected: { symbol: string; order: UntriggeredOrder }[] = [];
  for (const symbol of symbols) {
    const isUsdtM = symbol.toUpperCase().endsWith("USDT");
    process.stdout.write(`⟐  Fetching untriggered orders for ${symbol} (${isUsdtM ? "USDT-M" : "Coin-M"}) … `);

    let rows;
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

    console.log(`${rows.length} order(s)`);
    for (const order of rows) collected.push({ symbol, order });
  }

  if (collected.length === 0) {
    console.log("  ℹ  No untriggered orders found.");
    return 0;
  }

  // Sort by symbol, then by price (descending) so the highest rung prints first
  collected.sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol) || parseFloat(b.order.price) - parseFloat(a.order.price),
  );

  const symbolWidth = Math.max(...collected.map((c) => c.symbol.length), 6);

  console.log(`  ✓  ${collected.length} untriggered order(s) (classified by reduce-only flag):\n`);
  for (const { symbol, order: o } of collected) {
    const action = classifyOrder(o.side, isReduceOnly(o));
    console.log(
      `${symbol.padEnd(symbolWidth)}  ${(o.orderID || "?").padEnd(36)}  ${(o.side || "?").padEnd(4)} qty ` +
      `${(o.qty || "?").padStart(6)} limit @ ${(o.price ? Number(o.price).toFixed(2) : "?").padStart(5)}  →  ${action}`,
    );
  }
  return collected.length;
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

  const dryRun = hasFlag("--dry-run");

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    for (const symbol of symbols) {
      console.log(`  GET ${untriggeredEndpoint(symbol)}?${untriggeredQuery(symbol)}`);
    }
    console.log();
    process.exit(0);
  }

  const LOOP_MODE = hasFlag("--loop");
  const LOOP_ONCE = hasFlag("--once");
  const loopIdx = process.argv.indexOf("--interval");
  const LOOP_INTERVAL = loopIdx !== -1
    ? Math.max(parseInt(process.argv[loopIdx + 1], 10) || 5000, 1000)
    : 5000;

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  if (LOOP_MODE) {
    process.stdout.write(`Loop mode — polling every ${LOOP_INTERVAL} ms`);
    if (LOOP_ONCE) process.stdout.write(" (once)");
    process.stdout.write("\n\n");
    while (true) {
      await fetchAndPrint(symbols, creds.PHEMEX_API_KEY, secretRaw);
      if (LOOP_ONCE) break;
      await sleep(LOOP_INTERVAL);
    }
    process.exit(0);
  }

  // Single run
  await fetchAndPrint(symbols, creds.PHEMEX_API_KEY, secretRaw);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
