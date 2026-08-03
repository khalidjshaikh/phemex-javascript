#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-list-untriggered-orders.ts  —  List untriggered trigger orders
 * for a given symbol via the Phemex API.
 *
 * The API call lives in src/untriggered-orders.ts
 * (fetchUntriggeredOrders → GET /orders/activeList?ordStatus=Untriggered&symbol=<symbol>).
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
  } else {
    console.log(`  ✓  Found ${rows.length} untriggered order(s):\n`);
    for (const o of rows) {
      console.log(`${o.orderID || "?"} ${o.side || "?"} qty ${o.qty || "?"} limit @ ${o.price || "?"}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
