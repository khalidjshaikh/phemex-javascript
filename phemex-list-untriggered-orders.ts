#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-list-untriggered-orders.ts  —  List untriggered trigger orders
 * for a given symbol via the Phemex API.
 *
 * Endpoint:  GET /orders/activeList?ordStatus=Untriggered&symbol=<symbol>
 *
 * Usage:
 *   npx tsx phemex-list-untriggered-orders.ts --symbol BTCUSD
 *   npx tsx phemex-list-untriggered-orders.ts --symbol ETHUSD  --dry-run
 */

import { request, base64UrlDecode } from "./src/http-client.js";
import { getArg, hasFlag } from "./src/cli-utils.js";
import { loadCredentialsLocal } from "./src/credentials.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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
  const query = `ordStatus=Untriggered&symbol=${symbol}`;

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  GET /orders/activeList?${query}`);
    console.log();
    process.exit(0);
  }

  // Determine the correct endpoint based on symbol suffix:
  //   *USDT  → USDT-M perpetual  → /g-orders/activeList
  //   *USD   → Coin-M perpetual   → /orders/activeList
  const isUsdtM = symbol.toUpperCase().endsWith("USDT");
  const endpoint = isUsdtM ? "/g-orders/activeList" : "/orders/activeList";

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  Fetching untriggered orders for ${symbol} (${isUsdtM ? "USDT-M" : "Coin-M"}) …`);

  const resp = await request("GET", endpoint, query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    const rows = (data?.rows as Record<string, unknown>[] | undefined) ?? [];

    if (rows.length === 0) {
      console.log("  ℹ  No untriggered orders found.");
    } else {
      console.log(`  ✓  Found ${rows.length} untriggered order(s):\n`);
      for (const o of rows) {
        const orderID = String(o.orderID ?? "?");
        const side = String(o.side ?? "?");
        // USDT-M uses orderQtyRq/priceRp, Coin-M uses orderQty/price
        const qty = String(o.orderQtyRq ?? o.orderQty ?? "?");
        const stopPx = String(o.stopPxRp ?? o.stopPx ?? "?");
        const price = String(o.priceRp ?? o.price ?? "?");
        console.log(`${orderID} ${side} qty ${qty} limit @ ${price}`);
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
