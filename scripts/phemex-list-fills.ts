#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-list-fills.ts  —  List trade fills via the Phemex API.
 *
 * Endpoint:  GET /exchange/order/v2/tradingList
 *
 * Usage:
 *   ./phemex-list-fills.ts                                  # all symbols
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
Usage: ./phemex-list-fills.ts [--symbol <symbol>] [--limit <n>] [--days <n>] [--loop] [--interval <sec>] [--dry-run]

List trade fills (executed trades) via /exchange/order/v2/tradingList.

Options:
  --symbol <symbol>   Trading pair (e.g. XBRUSDT, BTCUSDT) — omit to list ALL symbols
  --limit <n>         Max results per symbol (default 50; values >200 are paged in batches of 200)
  --days <n>          Look back days (default 7)
  --credential <name> Credential profile from .credentials.json (e.g. A02, meta, gmail)
  --loop              Repeat the listing every --interval seconds until Ctrl+C
  --interval <sec>    Poll period in seconds (default 2; used with --loop)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-list-fills.ts                          # all symbols
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
/*  Fetch fills for a single symbol                                    */
/* ------------------------------------------------------------------ */

async function fetchFillsForSymbol(
  symbol: string | undefined,
  limit: number,
  days: number,
  creds: { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string },
  secretRaw: Buffer,
  pageSize: number,
): Promise<Record<string, unknown>[]> {
  const now = Date.now();
  const start = now - days * 86_400_000;
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  const label = symbol ?? "ALL";

  while (rows.length < limit) {
    const pageLimit = Math.min(pageSize, limit - rows.length);
    const symParam = symbol ? `symbol=${symbol}&` : "";
    const query = `${symParam}currency=USDT&start=${start}&end=${now}&offset=${offset}&limit=${pageLimit}&withCount=true`;

    console.log(`⟐  Fetching fills for ${label} (last ${days} days, limit ${limit}) — offset ${offset} …`);

    const resp = await request("GET", "/exchange/order/v2/tradingList", query, creds.PHEMEX_API_KEY, secretRaw, "");
    if (resp.code !== 0) {
      console.error(`  ✗  API error for ${label}: ${String(resp.msg ?? resp.code)}`);
      return [];
    }

    const data = resp.data as Record<string, unknown> | undefined;
    const pageRows = (data?.rows as Record<string, unknown>[] | undefined) ?? [];
    rows.push(...pageRows);

    if (pageRows.length < pageLimit) break;
    offset += pageLimit;
  }

  return rows;
}

/* ------------------------------------------------------------------ */
/*  Display fills table                                                */
/* ------------------------------------------------------------------ */

function displayFills(rows: Record<string, unknown>[], symbol: string, totalOverride?: number): void {
  if (rows.length === 0) {
    console.log(`  ℹ  ${symbol}: No fills found.`);
    return;
  }

  const total = totalOverride ?? rows.length;
  console.log(`  ✓  ${symbol}: Found ${total} fill(s), showing ${rows.length}:\n`);

  type Row = { time: string; sym: string; execId: string; qty: string; price: string; fee: string; feePerQty: string; sideLabel: string; mismatch: string };
  const formatted: Row[] = rows.map((f) => {
    const execId = String(f.execId ?? "?");
    const side = sideMap[Number(f.side)] ?? String(f.side ?? "?");
    const qty = String(f.execQtyRq ?? "?");
    const price = f.execPriceRp != null ? Number(f.execPriceRp).toFixed(2) : "?";
    const fee = f.execFeeRv != null ? Number(f.execFeeRv).toFixed(8) : "-";
    const feePerQty =
      f.execFeeRv != null && f.execQtyRq != null && Number(f.execQtyRq) !== 0
        ? (Number(f.execFeeRv) / Number(f.execQtyRq)).toFixed(8)
        : "-";
    const created = f.createdAt ? new Date(Number(f.createdAt)).toLocaleTimeString() : "?";
    const sym = String(f.symbol ?? symbol);

    const sideLabel = side === "Buy" ? "Buy/Open Long" : side === "Sell" ? "Sell/Close Long" : "";
    const feeQty3 = feePerQty !== "-" ? feePerQty.slice(2, 5) : "";
    const cls = feeQty3 === "048" ? "Sell/Close Long" : feeQty3 === "008" ? "Buy/Open Long" : "?";
    const mismatch = cls !== sideLabel ? "*" : "";

    return { time: created, sym, execId, qty, price, fee, feePerQty, sideLabel, mismatch };
  });

  const wTime = Math.max("Time".length, ...formatted.map((r) => r.time.length));
  const wSym = Math.max("Symbol".length, ...formatted.map((r) => r.sym.length));
  const wExecId = Math.max("ExecId".length, ...formatted.map((r) => r.execId.length));
  const wQty = Math.max("Qty".length, ...formatted.map((r) => r.qty.length));
  const wPrice = Math.max("Price".length, ...formatted.map((r) => r.price.length));
  const wFee = Math.max("Fee".length, ...formatted.map((r) => r.fee.length));
  const wFeeQty = Math.max("Fee/Qty".length, ...formatted.map((r) => r.feePerQty.length));
  const wSide = Math.max("Side".length, ...formatted.map((r) => r.sideLabel.length));

  console.log(
    `${"Time".padEnd(wTime)} ${"Symbol".padEnd(wSym)} ${"ExecId".padEnd(wExecId)} ` +
    `${"Qty".padEnd(wQty)} ${"Price".padEnd(wPrice)} ${"Fee".padEnd(wFee)} ${"Fee/Qty".padEnd(wFeeQty)} ${"Side".padEnd(wSide)} ${"*"}`
  );
  const totalWidth = wTime + wSym + wExecId + wQty + wPrice + wFee + wFeeQty + wSide + 9;
  console.log("─".repeat(totalWidth));

  let totalQty = 0;
  let totalFee = 0;
  let totalFeeClose = 0;
  let totalFeeOpen = 0;
  let countClose = 0;
  let countOpen = 0;
  for (const r of formatted) {
    totalQty += Number(r.qty) || 0;
    totalFee += Number(r.fee) || 0;

    if (r.sideLabel === "Sell/Close Long") {
      totalFeeClose += Number(r.fee) || 0;
      countClose++;
    } else if (r.sideLabel === "Buy/Open Long") {
      totalFeeOpen += Number(r.fee) || 0;
      countOpen++;
    }

    console.log(
      `${r.time.padEnd(wTime)} ${r.sym.padEnd(wSym)} ${r.execId.padEnd(wExecId)} ` +
      `${r.qty.padEnd(wQty)} ${r.price.padEnd(wPrice)} ${r.fee.padEnd(wFee)} ${r.feePerQty.padEnd(wFeeQty)} ${r.sideLabel.padEnd(wSide)} ${r.mismatch}`
    );
  }
  console.log("─".repeat(totalWidth));
  console.log(
    `Rows: ${rows.length} | Σ Total Qty: ${Math.round(totalQty * 1e8) / 1e8}  |  Total Fee: ${Math.round(totalFee * 1e8) / 1e8}  |  ` +
    `Sell/Close: ${countClose} rows, fee ${Math.round(totalFeeClose * 1e8) / 1e8}  |  Buy/Open: ${countOpen} rows, fee ${Math.round(totalFeeOpen * 1e8) / 1e8}`
  );
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbolArg = getArg("--symbol");
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

  const pageSize = 200;

  // Resolve symbols: single or all listed
  let symbols: string[] | undefined;
  if (symbolArg) {
    symbols = [symbolArg];
  }

  if (dryRun) {
    const now = Date.now();
    const start = now - days * 86_400_000;
    const pages = Math.ceil(limit / pageSize);
    const symCount = symbols ? symbols.length : 1;
    console.log(`\n  DRY RUN — Would send ${pages} request(s)${symCount > 1 ? ` × ${symCount} symbols` : ""}${loopMode ? ` per cycle (--loop, every ${intervalSec}s until Ctrl+C)` : ""}:\n`);
    const showSymbols = symbols ?? ["<all>"];
    for (const sym of showSymbols.slice(0, 10)) {
      const symParam = sym === "<all>" ? "" : `symbol=${sym}&`;
      for (let off = 0; off < limit; off += pageSize) {
        const lim = Math.min(pageSize, limit - off);
        console.log(
          `  GET /exchange/order/v2/tradingList?${symParam}currency=USDT&start=${start}&end=${now}&offset=${off}&limit=${lim}&withCount=true`
        );
      }
    }
    if (showSymbols.length > 10) console.log(`  … and ${showSymbols.length - 10} more symbols`);
    console.log();
    process.exit(0);
  }

  const creds = credential ? loadCredentialProfile(credential) : loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  let cycle = 0;
  for (;;) {
    cycle++;
    if (loopMode) {
      const label = symbols ? `${symbols.length} symbol(s)` : "all symbols";
      console.log(`\n${"─".repeat(80)}`);
      console.log(`  [${new Date().toLocaleString()}] cycle #${cycle} — ${label}, last ${days} days, limit ${limit}, poll every ${intervalSec}s (Ctrl+C to stop)`);
    }

    if (symbols) {
      for (const sym of symbols) {
        const rows = await fetchFillsForSymbol(sym, limit, days, creds, secretRaw, pageSize);
        displayFills(rows, sym);
      }
    } else {
      const rows = await fetchFillsForSymbol(undefined, limit, days, creds, secretRaw, pageSize);
      displayFills(rows, "ALL");
    }

    if (!loopMode) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
