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
  --decimals <N>      Decimal places for numbers (default 2)
  --help, -h          Show this help message

Examples:
  ./phemex-closed-positions.ts                         All symbols, last 7 days
  ./phemex-closed-positions.ts --symbol XBRUSDT        Only XBRUSDT
  ./phemex-closed-positions.ts --days 30 --limit 1000  Longer window
  ./phemex-closed-positions.ts --json                  Machine-readable output
  ./phemex-closed-positions.ts --decimals 4            4 decimal places
`);
  process.exit(0);
}

function fmtUsd(n: number, decimals = 4): string {
  const sign = n >= 0 ? "+" : "";
  return sign + n.toFixed(decimals);
}

function fmtQty(n: number, decimals = 2): string {
  return n.toFixed(decimals);
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

function printTable(positions: ClosedPosition[], color = false, decimals = 2): void {
  if (positions.length === 0) {
    console.log("\nNo closed positions found in the requested window.");
    return;
  }

  // Sort: most recently closed first
  const rows = [...positions].sort((a, b) => b.closedAt - a.closedAt);

  // Pre-compute formatted values and max widths for numeric columns
  type Row = { p: ClosedPosition; qty: string; entry: string; exit: string; spread: string; realized: string; net: string; fee: string };
  const formatted: Row[] = rows.map((p) => ({
    p,
    qty: fmtQty(p.qty, decimals),
    entry: p.avgEntryPrice.toFixed(decimals),
    exit: p.avgExitPrice.toFixed(decimals),
    spread: Math.abs(p.avgExitPrice - p.avgEntryPrice).toFixed(decimals),
    realized: fmtUsd(p.realizedPnl, decimals),
    net: fmtUsd(p.netPnl, decimals),
    fee: fmtUsd(-(p.entryFee + p.exitFee), decimals),
  }));

  const wQty = Math.max("Qty".length, ...formatted.map((r) => r.qty.length));
  const wEntry = Math.max("Entry".length, ...formatted.map((r) => r.entry.length));
  const wExit = Math.max("Exit".length, ...formatted.map((r) => r.exit.length));
  const wSpread = Math.max("Spread".length, ...formatted.map((r) => r.spread.length));
  const wRealized = Math.max("Realized".length, ...formatted.map((r) => r.realized.length));
  const wNet = Math.max("Net".length, ...formatted.map((r) => r.net.length));
  const wFee = Math.max("Fee".length, ...formatted.map((r) => r.fee.length));

  const hdr =
    `${"#".padStart(3)} ` +
    `${"Opened At".padEnd(19)} ` +
    `${"Closed At".padEnd(19)} ` +
    `${"Duration".padEnd(9)} ` +
    `${"Symbol".padEnd(8)} ` +
    `${"Side".padEnd(6)}` +
    `${"Qty".padStart(wQty)} ` +
    `${"Entry".padStart(wEntry)} ` +
    `${"Exit".padStart(wExit)} ` +
    `${"Spread".padStart(wSpread)} ` +
    `${"Realized".padStart(wRealized)} ` +
    `${"Net".padStart(wNet)} ` +
    `${"Fee".padStart(wFee)}`;
  console.log(`\n${hdr}`);
  console.log("─".repeat(hdr.length));

  let gross = 0;
  let net = 0;
  let fees = 0;
  let winners = 0;

  for (let i = 0; i < formatted.length; i++) {
    const { p, qty, entry, exit, spread, realized, net: netVal, fee } = formatted[i];
    if (p.realizedPnl >= 0) winners++;
    const red = color && p.realizedPnl < 0 ? "\x1b[31m" : "";
    const reset = red ? "\x1b[0m" : "";
    console.log(
      `${red}${String(i + 1).padStart(3)} ` +
      `${fmtTime(p.openedAt).padEnd(19)} ` +
      `${fmtTime(p.closedAt).padEnd(19)} ` +
      `${fmtDuration(p.closedAt - p.openedAt).padEnd(9)} ` +
      `${p.symbol.padEnd(8)} ` +
      `${p.posSide.padEnd(6)}` +
      `${qty.padStart(wQty)} ` +
      `${entry.padStart(wEntry)} ` +
      `${exit.padStart(wExit)} ` +
      `${spread.padStart(wSpread)} ` +
      `${realized.padStart(wRealized)} ` +
      `${netVal.padStart(wNet)} ` +
      `${fee.padStart(wFee)}` +
      `${p.realizedPnl >= 0 ? " *" : "  "}${p.netPnl >= 0 ? " *" : "  "}${reset}`
    );
    gross += p.realizedPnl;
    fees += p.entryFee + p.exitFee;
    net += p.netPnl;
  }

  const totalWidth = hdr.length;
  console.log("─".repeat(totalWidth));
  console.log(
    `Positions: ${rows.length}   ` +
    `Winners: ${winners}   ` +
    `Σ Realized PnL: ${fmtUsd(gross, decimals)}   ` +
    `Σ Fees: ${fees.toFixed(decimals)}   ` +
    `Σ Net PnL: ${fmtUsd(net, decimals)}`
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
  const decimals = Math.max(parseInt(getArg("--decimals") || "2", 10) || 2, 0);

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
  printTable(positions, useColor, decimals);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
