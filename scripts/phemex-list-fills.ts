#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-list-fills.ts  —  List trade fills for a symbol via the Phemex API.
 *
 * Endpoint:  GET /exchange/order/v2/tradingList
 *
 * Usage:
 *   ./phemex-list-fills.ts --symbol XBRUSDT
 *   ./phemex-list-fills.ts --symbol XBRUSDT --limit 50
 *   ./phemex-list-fills.ts --symbol XBRUSDT --days 7
 *   ./phemex-list-fills.ts --symbol XBRUSDT --days 30 --limit 200
 *   ./phemex-list-fills.ts --help, -h
 */

import { request, base64UrlDecode } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentialsLocal } from "../src/credentials.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-list-fills.ts --symbol <symbol> [--limit <n>] [--days <n>] [--dry-run]

List trade fills (executed trades) via /exchange/order/v2/tradingList.

Options:
  --symbol <symbol>   Trading pair (e.g. XBRUSDT, BTCUSDT) — defaults to XBRUSDT
  --limit <n>         Max results (default 50, max 200)
  --days <n>          Look back days (default 7)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-list-fills.ts --symbol XBRUSDT
  ./phemex-list-fills.ts --symbol XBRUSDT --limit 100 --days 30
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Mappings                                                           */
/* ------------------------------------------------------------------ */

const actionMap: Record<number, string> = {
  1: "Buy",
  2: "Sell",
};

const tradeTypeMap: Record<number, string> = {
  0: "Maker",
  1: "Taker",
};

const ordTypeMap: Record<number, string> = {
  1: "Market",
  2: "Limit",
  3: "Stop",
  4: "StopLimit",
  5: "MarketIfTouched",
  6: "LimitIfTouched",
};

const posSideMap: Record<number, string> = {
  1: "Long",
  2: "Short",
};

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol") || "XBRUSDT";
  const limit = Math.min(Math.max(parseInt(getArg("--limit") || "50", 10) || 50, 1), 200);
  const days = parseInt(getArg("--days") || "7", 10) || 7;
  const dryRun = hasFlag("--dry-run");

  const now = Date.now();
  const start = now - days * 86_400_000;

  const query = `symbol=${symbol}&currency=USDT&start=${start}&end=${now}&offset=0&limit=${limit}&withCount=true`;

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  GET /exchange/order/v2/tradingList?${query}`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  Fetching fills for ${symbol} (last ${days} days, limit ${limit}) …`);

  const resp = await request("GET", "/exchange/order/v2/tradingList", query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    const rows = (data?.rows as Record<string, unknown>[] | undefined) ?? [];
    const total = (data?.total as number | undefined) ?? rows.length;

    if (rows.length === 0) {
      console.log("  ℹ  No fills found.");
    } else {
      console.log(`  ✓  Found ${total} fill(s), showing ${rows.length}:\n`);

      // Header
      console.log(
        `${"Time".padEnd(26)} ${"ExecId".padEnd(10)} ${"Action".padEnd(5)} ` +
        `${"Qty".padStart(10)} ${"Price".padStart(12)} ${"Type".padEnd(10)} ` +
        `${"PosSide".padEnd(8)} ${"Fee".padStart(10)}`
      );
      console.log("─".repeat(100));

      for (const f of rows) {
        const execId = String(f.execId ?? "?");
        const action = actionMap[Number(f.action)] ?? String(f.action ?? "?");
        const tradeType = tradeTypeMap[Number(f.tradeType)] ?? String(f.tradeType ?? "?");
        const ordType = ordTypeMap[Number(f.ordType)] ?? String(f.ordType ?? "?");
        const posSide = posSideMap[Number(f.posSide)] ?? String(f.posSide ?? "?");
        const qty = String(f.execQtyRq ?? "?");
        const price = String(f.execPriceRp ?? "?");
        const fee = String(f.execFeeRv ?? "-");
        const created = f.createdAt ? new Date(Number(f.createdAt)).toISOString() : "?";

        const typeLabel = `${ordType}/${tradeType}`;

        console.log(
          `${created}  ${execId.padEnd(8)} ${action.padEnd(5)} ` +
          `${qty.padStart(10)} ${price.padStart(12)} ${typeLabel.padEnd(10)} ` +
          `${posSide.padEnd(8)} ${fee.padStart(10)}`
        );
      }
      console.log("─".repeat(100));
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