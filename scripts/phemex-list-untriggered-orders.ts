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

function usage(): never {
  console.log(`
Usage: ./phemex-list-untriggered-orders.ts --symbol <symbol> [--dry-run]

List untriggered trigger orders for a symbol via GET /orders/activeList.

Options:
  --symbol <symbol>   Trading pair (e.g. BTCUSD, ETHUSD, BTCUSDT)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-list-untriggered-orders.ts --symbol BTCUSD
  ./phemex-list-untriggered-orders.ts --symbol ETHUSD  --dry-run
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
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  if (!symbol) usage();

  const dryRun = hasFlag("--dry-run");

  // Both USDT-M and Coin-M use "Untriggered" as the ordStatus string value
  const isUsdtM = symbol.toUpperCase().endsWith("USDT");
  const query = untriggeredQuery(symbol);

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  GET ${untriggeredEndpoint(symbol)}?${query}`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  Fetching untriggered orders for ${symbol} (${isUsdtM ? "USDT-M" : "Coin-M"}) …`);

  let rows;
  try {
    rows = await fetchUntriggeredOrders(symbol, creds.PHEMEX_API_KEY, secretRaw);
  } catch (err: unknown) {
    // code 10002 / "OM_ORDER_NOT_FOUND" is handled inside the library as an empty result
    if (err instanceof ApiError) {
      console.error(`  ✗  API error: ${err.message}`);
    } else {
      console.error(`  ✗  Request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log("  ℹ  No untriggered orders found.");
    return;
  }

  console.log(`  ✓  Found ${rows.length} untriggered order(s) for ${symbol} (classified by reduce-only flag):\n`);
  for (const o of rows) {
    const action = classifyOrder(o.side, isReduceOnly(o));
    console.log(
      `${(o.orderID || "?").padEnd(36)}  ${(o.side || "?").padEnd(4)} qty ` +
      `${(o.qty || "?").padStart(6)} limit @ ${(o.price || "?").padStart(5)}  →  ${action}`,
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
