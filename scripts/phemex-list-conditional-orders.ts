#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-list-conditional-orders.ts  —  List conditional (trigger) orders
 * for a given symbol via the Phemex API.
 *
 * Conditional orders are the stop-loss / take-profit trigger orders created
 * by phemex-add-conditional-orders.ts (ordType=Stop and ordType=LimitIfTouched).
 * They are returned by the active-order list endpoint filtered by the
 * "Untriggered" status — there is no dedicated conditional-order list endpoint.
 *
 * The API call lives in src/untriggered-orders.ts
 * (fetchUntriggeredOrders → GET /orders/activeList?ordStatus=Untriggered&symbol=<symbol>,
 *  GET /g-orders/activeList for *USDT symbols).
 *
 * Usage:
 *   npx tsx phemex-list-conditional-orders.ts --symbol XBRUSDT
 *   npx tsx phemex-list-conditional-orders.ts --symbol XTIUSDT --side Sell
 *   npx tsx phemex-list-conditional-orders.ts --symbol XTIUSDT --dry-run
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
Usage: ./phemex-list-conditional-orders.ts --symbol <symbol> [--side <Buy|Sell>] [--dry-run]

List conditional (untriggered trigger) orders for a symbol
via GET /orders/activeList?ordStatus=Untriggered.

Options:
  --symbol <symbol>   Trading pair (e.g. BTCUSD, ETHUSD, BTCUSDT)
  --side <Buy|Sell>   Only show orders on this side (optional)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-list-conditional-orders.ts --symbol XBRUSDT
  ./phemex-list-conditional-orders.ts --symbol XTIUSDT --side Sell
  ./phemex-list-conditional-orders.ts --symbol BTCUSD --dry-run
`);
  process.exit(0);
}

/** Format a number for display, trimming trailing zeros. */
function fmtPrice(v: string): string {
  if (v === "" || v === "0") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}

/**
 * Order type name: prefer the normalized ordType from the library; USDT-M
 * activeList rows expose the type as `orderType` (e.g. "Limit") instead of
 * the numeric `ordType`, so fall back to the raw field.
 */
function orderTypeName(o: UntriggeredOrder): string {
  return o.ordType || String(o.raw.orderType ?? "?");
}

/**
 * Trigger level: standalone conditional orders carry it in `stopPx`;
 * bracket orders (limit/stop with attached stop-loss or take-profit) keep
 * it in `stopLossRp` / `takeProfitRp` on the raw row.
 */
function triggerLevel(o: UntriggeredOrder): string {
  if (o.stopPx && o.stopPx !== "0") return o.stopPx;
  return String(o.raw.stopLossRp ?? o.raw.takeProfitRp ?? "0");
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  if (!symbol) usage();

  const sideFilter = getArg("--side");
  if (sideFilter && !["Buy", "Sell"].includes(sideFilter)) {
    console.error("✗  --side must be 'Buy' or 'Sell'");
    process.exit(1);
  }

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

  console.log(`⟐  Fetching conditional orders for ${symbol} (${isUsdtM ? "USDT-M" : "Coin-M"}) …`);

  let rows: UntriggeredOrder[];
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

  const filtered = sideFilter ? rows.filter((o) => o.side === sideFilter) : rows;

  if (filtered.length === 0) {
    console.log(`  ℹ  No conditional orders found${sideFilter ? ` (side=${sideFilter})` : ""}.`);
    return;
  }

  console.log(`  ✓  Found ${filtered.length} conditional order(s)${sideFilter ? ` (side=${sideFilter})` : ""}:\n`);
  for (const o of filtered) {
    console.log(
      `    ${orderTypeName(o).padEnd(14)} ${(o.side || "?").padEnd(4)} qty ${(o.qty || "?").padStart(10)}  ` +
        `trigger @ ${fmtPrice(triggerLevel(o)).padStart(10)}  limit @ ${fmtPrice(o.price).padStart(10)}  ${o.orderID || "?"}`,
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
