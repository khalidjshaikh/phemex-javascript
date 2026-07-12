#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cancel-orders-all.ts  —  Cancel ALL orders (including untriggered)
 * for a given symbol via the Phemex API.
 *
 * Endpoint:  DELETE /orders/all  (COIN-M)  or  DELETE /g-orders/all  (USDT-M)
 *           selected automatically based on symbol suffix (USDT → USDT-M, else COIN-M)
 *
 * Usage:
 *   npx tsx phemex-cancel-orders-all.ts --symbol BTCUSD
 *   npx tsx phemex-cancel-orders-all.ts --symbol ETHUSD  --dry-run
 */

import { request, base64UrlDecode } from "./src/http-client.js";
import { getArg, hasFlag, apiPath } from "./src/cli-utils.js";
import { loadCredentials } from "./src/credentials.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function loadCredentialsLocal(): ReturnType<typeof loadCredentials> {
  return loadCredentials(import.meta.dirname);
}

function usage(): never {
  console.log(`
Usage: ./phemex-cancel-orders-all.ts --symbol <symbol> [--dry-run]

Cancel ALL orders (including untriggered trigger orders) for a symbol.

Options:
  --symbol <symbol>   Trading pair (e.g. BTCUSD, ETHUSD, BTCUSDT)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-cancel-orders-all.ts --symbol BTCUSD       # COIN-M
  ./phemex-cancel-orders-all.ts --symbol XTIUSDT      # USDT-M
  ./phemex-cancel-orders-all.ts --symbol ETHUSD  --dry-run
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
  const path = apiPath(symbol);
  const query = `symbol=${symbol}&untriggered=false`;

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  DELETE ${path}?${query}`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const accountType = symbol.endsWith("USDT") ? "USDT-M" : "COIN-M";
  console.log(`⟐  [${accountType}] Cancelling ALL orders for ${symbol} (including untriggered) …`);

  const resp = await request("DELETE", path, query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    const closedOrders = (data?.closedOrders as Record<string, unknown>[] | undefined) ?? [];
    const untriggered = (data?.untriggered as Record<string, unknown>[] | undefined) ?? [];
    console.log(`  ✓  Done — ${closedOrders.length} open + ${untriggered.length} untriggered order(s) cancelled`);
    if (closedOrders.length > 0 || untriggered.length > 0) {
      console.log();
      for (const o of closedOrders) {
        console.log(`     Closed:   ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}  @ ${String(o.price ?? "?")}`);
      }
      for (const o of untriggered) {
        console.log(`     Untrig'd: ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}  @ ${String(o.stopPx ?? "?")}`);
      }
    }
  } else {
    console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
