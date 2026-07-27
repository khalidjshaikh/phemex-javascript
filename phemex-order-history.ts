#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-order-history.ts  —  Query full order history for a symbol
 * via the Phemex API (closed orders, including triggered conditionals).
 *
 * Endpoint:  GET /exchange/order/v2/orderList
 *
 * Usage:
 *   npx tsx phemex-order-history.ts --symbol XTIUSDT
 *   npx tsx phemex-order-history.ts --symbol XTIUSDT --limit 50
 *   npx tsx phemex-order-history.ts --symbol XTIUSDT --days 7
 */

import { request, base64UrlDecode } from "./src/http-client.js";
import { getArg, hasFlag } from "./src/cli-utils.js";
import { loadCredentialsLocal } from "./src/credentials.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-order-history.ts --symbol <symbol> [--limit <n>] [--days <n>] [--dry-run]

Query closed order history (including triggered conditionals) via /exchange/order/v2/orderList.

Options:
  --symbol <symbol>   Trading pair (e.g. XTIUSDT, BTCUSDT)
  --limit <n>         Max results (default 50, max 200)
  --days <n>          Look back days (default 7)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-order-history.ts --symbol XTIUSDT
  ./phemex-order-history.ts --symbol XTIUSDT --limit 100 --days 30
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

  const limit = Math.min(Math.max(parseInt(getArg("--limit") || "50", 10) || 50, 1), 200);
  const days = parseInt(getArg("--days") || "7", 10) || 7;
  const dryRun = hasFlag("--dry-run");

  const now = Date.now();
  const start = now - days * 86_400_000;

  const query = `symbol=${symbol}&currency=USDT&start=${start}&end=${now}&offset=0&limit=${limit}&withCount=true`;

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  GET /exchange/order/v2/orderList?${query}`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  Fetching order history for ${symbol} (last ${days} days, limit ${limit}) …`);

  const resp = await request("GET", "/exchange/order/v2/orderList", query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    const rows = (data?.rows as Record<string, unknown>[] | undefined) ?? [];
    const total = (data?.total as number | undefined) ?? rows.length;

    if (rows.length === 0) {
      console.log("  ℹ  No order history found.");
    } else {
      console.log(`  ✓  Found ${total} order(s), showing ${rows.length}:\n`);

      // Map ordStatus codes to labels
      const statusMap: Record<number, string> = {
        1: "Untriggered",
        5: "New",
        6: "PartiallyFilled",
        7: "Filled",
        8: "Canceled",
      };

      const typeMap: Record<number, string> = {
        1: "Market",
        2: "Limit",
        3: "Stop",
        4: "StopLimit",
        5: "MarketIfTouched",
        6: "LimitIfTouched",
      };

      for (const o of rows) {
        const orderID = String(o.orderID ?? "?");
        const side = String(o.side ?? "?");
        const ordStatus = statusMap[Number(o.ordStatus)] ?? String(o.ordStatus ?? "?");
        const ordType = typeMap[Number(o.ordType)] ?? String(o.ordType ?? "?");
        const qty = String(o.orderQtyRq ?? o.qty ?? "?");
        const price = String(o.priceRp ?? o.price ?? "?");
        const stopPx = String(o.stopPxRp ?? o.stopPx ?? "-");
        const created = o.createdAt ? new Date(Number(o.createdAt)).toISOString() : "?";

        const triggerInfo = stopPx !== "-" ? ` trigger @ ${stopPx}` : "";
        console.log(`${created}  ${orderID.slice(0, 8)}…  ${side.padEnd(4)} ${qty.padStart(8)} @ ${price.padStart(10)}${triggerInfo}  [${ordType}] ${ordStatus}`);
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
