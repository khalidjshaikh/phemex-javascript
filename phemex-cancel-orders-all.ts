#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cancel-orders-all.ts  —  Cancel ALL orders (including untriggered)
 * for a given symbol via the Phemex API.
 *
 * Endpoint:  DELETE /orders/all  (COIN-M)  or  DELETE /g-orders/all  (USDT-M)
 *           selected automatically based on symbol suffix (USDT → USDT-M, else COIN-M)
 *
 * Arguments:
 *   --symbol  <pair>   (required) Trading pair symbol, e.g. BTCUSD, ETHUSD, BTCUSDT
 *   --posSide <side>   (optional)  Position side: Long or Short (default: both sides)
 *   --dry-run          (optional)  Print the request without sending it
 *   --help, -h         (optional)  Show this help message and exit
 *
 * Examples:
 *   npx tsx phemex-cancel-orders-all.ts --symbol BTCUSD
 *   npx tsx phemex-cancel-orders-all.ts --symbol ETHUSD  --dry-run
 *   npx tsx phemex-cancel-orders-all.ts --symbol XTIUSDT  --posSide Long
 *   npx tsx phemex-cancel-orders-all.ts --symbol XTIUSDT  --posSide Short --dry-run
 *   npx tsx phemex-cancel-orders-all.ts --help
 */

import { request, base64UrlDecode } from "./src/http-client.js";
import { getArg, hasFlag, apiPath } from "./src/cli-utils.js";
import { loadCredentialsLocal } from "./src/credentials.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-cancel-orders-all.ts --symbol <pair> [options]

Cancel ALL orders (including untriggered trigger orders) for a symbol.

Arguments:
  --symbol  <pair>   (required) Trading pair symbol, e.g. BTCUSD, ETHUSD, BTCUSDT
  --posSide <side>   (optional)  Position side: Long or Short (default: both sides)
  --dry-run          (optional)  Print the request details without sending it
  --help, -h         (optional)  Show this help message and exit

Endpoint selection:
  Symbol ending in "USDT"  →  USDT-M  (DELETE /g-orders/all)
  All other symbols        →  COIN-M  (DELETE /orders/all)

Examples:
  ./phemex-cancel-orders-all.ts --symbol BTCUSD              # COIN-M
  ./phemex-cancel-orders-all.ts --symbol ETHUSD              # COIN-M
  ./phemex-cancel-orders-all.ts --symbol XTIUSDT             # USDT-M
  ./phemex-cancel-orders-all.ts --symbol XTIUSDT --posSide Long   # cancel only Long positions
  ./phemex-cancel-orders-all.ts --symbol ETHUSD  --dry-run   # dry run only
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
  const posSideRaw = getArg("--posSide");
  const posSide = posSideRaw
    ? posSideRaw.charAt(0).toUpperCase() + posSideRaw.slice(1).toLowerCase()
    : undefined;
  if (posSide && !["Long", "Short"].includes(posSide)) {
    console.error(`✗  Invalid --posSide "${posSideRaw}" — must be Long or Short`);
    process.exit(1);
  }

  const path = apiPath(symbol, "/all");
  const isUsdtM = symbol.endsWith("USDT");

  // USDT-M requires two API calls to cancel ALL orders (active + conditional):
  //   1. untriggered=false  — cancels active / already-triggered orders
  //   2. untriggered=true   — cancels conditional (untriggered) orders
  // USDT-M also requires posSide.
  const untriggeredValues = isUsdtM ? ["false", "true"] : ["false"];

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    for (const u of untriggeredValues) {
      let q = `symbol=${symbol}&untriggered=${u}`;
      if (posSide) q += `&posSide=${posSide}`;
      console.log(`  DELETE ${path}?${q}`);
    }
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const accountType = isUsdtM ? "USDT-M" : "COIN-M";
  console.log(`⟐  [${accountType}] Cancelling ALL orders for ${symbol} (including untriggered) …`);

  let totalClosed = 0;
  let totalUntriggered = 0;

  for (const u of untriggeredValues) {
    let query = `symbol=${symbol}&untriggered=${u}`;
    if (posSide) query += `&posSide=${posSide}`;

    const resp = await request("DELETE", path, query, creds.PHEMEX_API_KEY, secretRaw, "");

    if (resp.code === 0) {
      const data = resp.data as Record<string, unknown> | undefined;
      const closedOrders = (data?.closedOrders as Record<string, unknown>[] | undefined) ?? [];
      const untriggered = (data?.untriggered as Record<string, unknown>[] | undefined) ?? [];
      totalClosed += closedOrders.length;
      totalUntriggered += untriggered.length;
      if (closedOrders.length > 0 || untriggered.length > 0) {
        for (const o of closedOrders) {
          console.log(`  ✓  Cancelled: ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}`);
        }
        for (const o of untriggered) {
          console.log(`  ✓  Cancelled (conditional): ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}`);
        }
      }
    } else {
      console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
    }
  }

  console.log(`  ✓  Done — ${totalClosed} open + ${totalUntriggered} conditional order(s) cancelled`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
