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
  return n.toFixed(4).replace(/\.?0+$/, "");
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

/* ------------------------------------------------------------------ */
/*  Table output                                                       */
/* ------------------------------------------------------------------ */

function printTable(positions: ClosedPosition[]): void {
  if (positions.length === 0) {
    console.log("\nNo closed positions found in the requested window.");
    return;
  }

  // Sort: most recently closed first
  const rows = [...positions].sort((a, b) => b.closedAt - a.closedAt);

  console.log(
    `\n${"Closed At".padEnd(20)} ${"Symbol".padEnd(10)} ${"Side".padEnd(6)} ` +
    `${"Qty".padStart(10)} ${"Entry".padStart(12)} ${"Exit".padStart(12)} ` +
    `${"Realized".padStart(12)} ${"Net".padStart(12)}`
  );
  console.log("─".repeat(110));

  let gross = 0;
  let net = 0;
  let fees = 0;

  for (const p of rows) {
    const realized = p.realizedPnl;
    const pnlFmt = fmtUsd(realized).padStart(12);
    const netFmt = fmtUsd(p.netPnl).padStart(12);
    console.log(
      `${fmtTime(p.closedAt).padEnd(20)} ${p.symbol.padEnd(10)} ${p.posSide.padEnd(6)} ` +
      `${fmtQty(p.qty).padStart(10)} ${p.avgEntryPrice.toFixed(4).padStart(12)} ` +
      `${p.avgExitPrice.toFixed(4).padStart(12)} ${pnlFmt} ${netFmt}`
    );
    gross += realized;
    fees += p.entryFee + p.exitFee;
    net += p.netPnl;
  }

  console.log("─".repeat(110));
  console.log(
    `Positions: ${rows.length}   ` +
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
  printTable(positions);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
