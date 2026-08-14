#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-closed-positions.ts  —  List closed (fully exited) USDT-M positions.
 *
 * Closed positions are reconstructed from executed fills
 * (/exchange/order/v2/tradingList) via FIFO round-trip matching in
 * src/closed-positions.ts: each closing fill consumes the oldest open
 * lots of the same (symbol, posSide), producing one closed position with
 * avg entry price, exit price, realized PnL and fees.
 *
 * Usage:
 *   ./phemex-closed-positions.ts
 *   ./phemex-closed-positions.ts --symbol XBRUSDT
 *   ./phemex-closed-positions.ts --symbol XBRUSDT --days 30 --limit 500
 *   ./phemex-closed-positions.ts --json
 *   ./phemex-closed-positions.ts --help, -h
 */

import { base64UrlDecode } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import {
  ClosedPosition,
  fetchFills,
  reconstructClosedPositions,
} from "../src/closed-positions.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage:  ./phemex-closed-positions.ts [options]

List closed USDT-M positions, reconstructed from trade fills
(via /exchange/order/v2/tradingList) with FIFO round-trip matching.

Options:
  --symbol <symbol>   Restrict to one symbol (e.g. XBRUSDT, BTCUSDT)
  --days <n>          Look-back window in days (default 7)
  --limit <n>         Max fills to fetch (default 200; pages of 200)
  --json              Output raw JSON instead of the table
  --color             Color rows red when net PnL is negative
  --help, -h          Show this help message

Examples:
  ./phemex-closed-positions.ts                         All symbols, last 7 days
  ./phemex-closed-positions.ts --symbol XBRUSDT        Only XBRUSDT
  ./phemex-closed-positions.ts --days 30 --limit 1000  Longer window
  ./phemex-closed-positions.ts --json                  Machine-readable output
`);
  process.exit(0);
}

function fmtUsd(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return sign + n.toFixed(4);
}

function fmtQty(n: number): string {
  return n.toFixed(3);
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/* ------------------------------------------------------------------ */
/*  Table output                                                       */
/* ------------------------------------------------------------------ */

function printTable(positions: ClosedPosition[], color = false): void {
  if (positions.length === 0) {
    console.log("\nNo closed positions found in the requested window.");
    return;
  }

  // Sort: most recently closed first
  const rows = [...positions].sort((a, b) => b.closedAt - a.closedAt);

  const hdr =
    `${"#".padStart(3)} ` +
    `${"Opened At".padEnd(19)} ` +
    `${"Closed At".padEnd(19)} ` +
    `${"Duration".padEnd(9)} ` +
    `${"Symbol".padEnd(8)} ` +
    `${"Side".padEnd(6)}` +
    `${"Qty".padStart(7)} ` +
    `${"Entry".padStart(9)} ` +
    `${"Exit".padStart(9)} ` +
    `${"Spread".padStart(7)} ` +
    `${"Realized".padStart(10)} ` +
    `${"Net".padStart(10)} ` +
    `${"Fee".padStart(10)}`;
  console.log(`\n${hdr}`);
  console.log("─".repeat(hdr.length));

  let gross = 0;
  let net = 0;
  let fees = 0;
  let winners = 0;

  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    const realized = p.realizedPnl;
    if (realized >= 0) winners++;
    const pnlFmt = fmtUsd(realized).padStart(10);
    const netFmt = fmtUsd(p.netPnl).padStart(10);
    const feeFmt = fmtUsd(-(p.entryFee + p.exitFee)).padStart(10);
    const spread = Math.abs(p.avgExitPrice - p.avgEntryPrice).toFixed(2).padStart(7);
    const red = color && realized < 0 ? "\x1b[31m" : "";
    const reset = red ? "\x1b[0m" : "";
    console.log(
      `${red}${String(i + 1).padStart(3)} ` +
      `${fmtTime(p.openedAt).padEnd(19)} ` +
      `${fmtTime(p.closedAt).padEnd(19)} ` +
      `${fmtDuration(p.closedAt - p.openedAt).padEnd(9)} ` +
      `${p.symbol.padEnd(8)} ` +
      `${p.posSide.padEnd(6)}` +
      `${fmtQty(p.qty).padStart(7)} ` +
      `${p.avgEntryPrice.toFixed(2).padStart(9)} ` +
      `${p.avgExitPrice.toFixed(2).padStart(9)} ` +
      `${spread} ` +
      `${pnlFmt} ` +
      `${netFmt} ` +
      `${feeFmt}` +
      `${p.realizedPnl >= 0 ? " *" : "  "}${p.netPnl >= 0 ? " *" : "  "}${reset}`
    );
    gross += realized;
    fees += p.entryFee + p.exitFee;
    net += p.netPnl;
  }

  console.log("─".repeat(136));
  console.log(
    `Positions: ${rows.length}   ` +
    `Winners: ${winners}   ` +
    `Σ Realized PnL: ${fmtUsd(gross)}   ` +
    `Σ Fees: ${fees.toFixed(4)}   ` +
    `Σ Net PnL: ${fmtUsd(net)}`
  );
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  const days = Math.max(parseInt(getArg("--days") || "7", 10) || 7, 1);
  const limit = Math.max(parseInt(getArg("--limit") || "200", 10) || 200, 1);
  const asJson = hasFlag("--json");
  const useColor = hasFlag("--color");

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const label = symbol ? ` for ${symbol.toUpperCase()}` : "";
  console.log(
    `⟐  Fetching fills${label} — last ${days} day(s), limit ${limit} …`
  );

  const fills = await fetchFills(creds.PHEMEX_API_KEY, secretRaw, {
    symbol,
    days,
    limit,
  });
  const positions = reconstructClosedPositions(fills);

  if (asJson) {
    console.log(JSON.stringify(positions, null, 2));
    return;
  }
  printTable(positions, useColor);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
