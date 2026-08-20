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
 *   ./phemex-list-fills.ts --symbol XBRUSDT --loop --interval 5
 *   ./phemex-list-fills.ts --help, -h
 */

import { request, base64UrlDecode } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import JSON5 from "json5";
import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-list-fills.ts --symbol <symbol> [--limit <n>] [--days <n>] [--loop] [--interval <sec>] [--dry-run]

List trade fills (executed trades) via /exchange/order/v2/tradingList.

Options:
  --symbol <symbol>   Trading pair (e.g. XBRUSDT, BTCUSDT) — defaults to XBRUSDT
  --limit <n>         Max results (default 50; values >200 are paged in batches of 200)
  --days <n>          Look back days (default 7)
  --credential <name> Credential profile from .credentials.json (e.g. A02, meta, gmail)
  --loop              Repeat the listing every --interval seconds until Ctrl+C
  --interval <sec>    Poll period in seconds (default 2; used with --loop)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-list-fills.ts --symbol XBRUSDT
  ./phemex-list-fills.ts --symbol XBRUSDT --limit 100 --days 30
  ./phemex-list-fills.ts --symbol XBRUSDT --loop --interval 5
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

const sideMap: Record<number, string> = {
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
/*  Credential profile loader                                          */
/* ------------------------------------------------------------------ */

function loadCredentialProfile(name: string): { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string } {
  const credsPath = path.resolve(process.cwd(), ".credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error(`✗  Missing ${credsPath}`);
    process.exit(1);
  }
  const all = JSON5.parse(fs.readFileSync(credsPath, "utf8")) as Record<string, { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string }>;
  if (!all[name]) {
    console.error(`✗  Credential profile "${name}" not found in .credentials.json (available: ${Object.keys(all).join(", ")})`);
    process.exit(1);
  }
  return all[name];
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol") || "XBRUSDT";
  const limit = Math.max(parseInt(getArg("--limit") || "50", 10) || 50, 1);
  const days = parseInt(getArg("--days") || "7", 10) || 7;
  const dryRun = hasFlag("--dry-run");
  const loopMode = hasFlag("--loop");
  const intervalSec = parseInt(getArg("--interval") || "2", 10);
  const credential = getArg("--credential");
  if (!Number.isInteger(intervalSec) || intervalSec < 1) {
    console.error(`  ✗  Invalid --interval: "${getArg("--interval")}" — use a whole number of seconds >= 1`);
    process.exit(1);
  }

  const pageSize = 200; // Phemex caps tradingList at 200 rows per request

  if (dryRun) {
    const now = Date.now();
    const start = now - days * 86_400_000;
    const pages = Math.ceil(limit / pageSize);
    console.log(`\n  DRY RUN — Would send ${pages} request(s)${loopMode ? ` per cycle (--loop, every ${intervalSec}s until Ctrl+C)` : ""}:\n`);
    for (let off = 0; off < limit; off += pageSize) {
      const lim = Math.min(pageSize, limit - off);
      console.log(
        `  GET /exchange/order/v2/tradingList?symbol=${symbol}&currency=USDT&start=${start}&end=${now}&offset=${off}&limit=${lim}&withCount=true`
      );
    }
    console.log();
    process.exit(0);
  }

  const creds = credential ? loadCredentialProfile(credential) : loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  let cycle = 0;
  for (;;) {
    cycle++;
    const now = Date.now();
    const start = now - days * 86_400_000;

    if (loopMode) {
      console.log(`\n${"─".repeat(80)}`);
      console.log(`  [${new Date().toLocaleString()}] cycle #${cycle} — last ${days} days, limit ${limit}, poll every ${intervalSec}s (Ctrl+C to stop)`);
    }

    const rows: Record<string, unknown>[] = [];
    let total = 0;
    let offset = 0;

    while (rows.length < limit) {
      const pageLimit = Math.min(pageSize, limit - rows.length);
      const query = `symbol=${symbol}&currency=USDT&start=${start}&end=${now}&offset=${offset}&limit=${pageLimit}&withCount=true`;

      console.log(`⟐  Fetching fills for ${symbol} (last ${days} days, limit ${limit}) — offset ${offset} …`);

      const resp = await request("GET", "/exchange/order/v2/tradingList", query, creds.PHEMEX_API_KEY, secretRaw, "");
      if (resp.code !== 0) {
        console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
        process.exit(1);
      }

      const data = resp.data as Record<string, unknown> | undefined;
      const pageRows = (data?.rows as Record<string, unknown>[] | undefined) ?? [];
      total = (data?.total as number | undefined) ?? rows.length + pageRows.length;
      rows.push(...pageRows);

      // Stop on a short page (end of data) or once all matching fills are collected
      if (pageRows.length < pageLimit || (total > 0 && rows.length >= total)) break;
      offset += pageLimit;
    }

    if (rows.length === 0) {
      console.log("  ℹ  No fills found.");
    } else {
      console.log(`  ✓  Found ${total} fill(s), showing ${rows.length}:\n`);

      // Header
      console.log(
        `${"Time".padEnd(12)} ${"ExecId".padEnd(10)} ` +
        `${"Qty".padEnd(10)} ${"Price".padEnd(12)} ${"Fee".padEnd(12)} ${"Fee/Qty".padEnd(12)} ${"Side".padEnd(16)} ${"*".padEnd(2)}`
      );
      console.log("─".repeat(93));

      let totalQty = 0;
      let totalFee = 0;
      let totalFeeClose = 0;
      let totalFeeOpen = 0;
      let countClose = 0;
      let countOpen = 0;
      for (const f of rows) {
        // console.log(f)
        const execId = String(f.execId ?? "?");
        const side = sideMap[Number(f.side)] ?? String(f.side ?? "?");
        const qty = String(f.execQtyRq ?? "?");
        const price = f.execPriceRp != null ? Number(f.execPriceRp).toFixed(2) : "?";
        const fee = f.execFeeRv != null ? Number(f.execFeeRv).toFixed(8) : "-";
        const feePerQty =
          f.execFeeRv != null && f.execQtyRq != null && Number(f.execQtyRq) !== 0
            ? (Number(f.execFeeRv) / Number(f.execQtyRq)).toFixed(8)
            : "-";
        const created = f.createdAt ? new Date(Number(f.createdAt)).toLocaleString() : "?";
        totalQty += Number(f.execQtyRq) || 0;
        totalFee += Number(f.execFeeRv) || 0;

        const sideLabel = side === "Buy" ? "Buy/Open Long" : side === "Sell" ? "Sell/Close Long" : "";

        const feeQty3 = feePerQty !== "-" ? feePerQty.slice(2, 5) : "";
        const cls = feeQty3 === "048" ? "Sell/Close Long" : feeQty3 === "008" ? "Buy/Open Long" : "?";

        const mismatch = cls !== sideLabel ? "*" : "";

        if (cls === "Sell/Close Long") {
          totalFeeClose += Number(f.execFeeRv) || 0;
          countClose++;
        } else if (cls === "Buy/Open Long") {
          totalFeeOpen += Number(f.execFeeRv) || 0;
          countOpen++;
        }

        console.log(
          `${created.padEnd(12)} ${execId.padEnd(10)} ` +
          `${qty.padEnd(10)} ${price.padEnd(12)} ${fee.padEnd(12)} ${feePerQty.padEnd(12)} ${sideLabel.padEnd(16)} ${mismatch.padEnd(2)}`
        );
      }
      console.log("─".repeat(93));
      console.log(
        `Rows: ${rows.length} | Σ Total Qty: ${Math.round(totalQty * 1e8) / 1e8}  |  Total Fee: ${Math.round(totalFee * 1e8) / 1e8}  |  ` +
        `Sell/Close: ${countClose} rows, fee ${Math.round(totalFeeClose * 1e8) / 1e8}  |  Buy/Open: ${countOpen} rows, fee ${Math.round(totalFeeOpen * 1e8) / 1e8}`
      );
    }

    if (!loopMode) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
