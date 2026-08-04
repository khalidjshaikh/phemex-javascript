#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-closed-positions.ts  —  List fully closed USDT-M positions from Phemex.
 *
 * The /g-accounts/accountPositions endpoint returns closed positions with
 * side="None" and size="0".  This script fetches all positions and filters
 * for those that are closed, showing the realized P&L and close price.
 *
 * Usage:
 *   ./phemex-closed-positions.ts
 *   ./phemex-closed-positions.ts --symbol XBRUSDT
 *   ./phemex-closed-positions.ts --symbol XBRUSDT --loop
 *   ./phemex-closed-positions.ts --loop --interval 5000
 *   ./phemex-closed-positions.ts --help, -h
 */

import { base64UrlDecode, request } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";

const CREDS_FILE = ".phemex-credentials.json";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface RawPosition {
  symbol: string;
  currency: string;
  side: "Buy" | "Sell" | "None";
  positionStatus: string;
  size: string;
  avgEntryPrice: string;
  avgEntryPriceRp: string;
  markPriceRp: string;
  valueRv: string;
  posCostRv: string;
  leverageRr: string;
  liquidationPriceRp: string;
  unrealisedPnl?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function usage(): never {
  console.log(`
Usage:  ./phemex-closed-positions.ts [options]

List fully closed USDT-M positions from Phemex.
Credentials are read from .phemex-credentials.json.

Options:
  --symbol <symbol>   Filter by symbol (e.g. XBRUSDT, BTCUSDT)
  --loop              Continuously poll every <interval> ms
  --interval <ms>     Polling interval in ms (default 5000, with --loop)
  --once              With --loop: single poll, then exit
  --help, -h          Show this help message

Examples:
  ./phemex-closed-positions.ts                        Show all closed positions
  ./phemex-closed-positions.ts --symbol XBRUSDT        Show closed positions for XBRUSDT
  ./phemex-closed-positions.ts --loop                  Poll every 5 s
  ./phemex-closed-positions.ts --loop --interval 2000  Poll every 2 s
`);
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convert a scaled Phemex value (Rv) to human-readable using the scale factor */
function toHuman(val: unknown, scale: number): number {
  if (val == null) return 0;
  return Number(val) / scale;
}

/** Perform one signed GET request and parse the JSON response */
async function get<T = unknown>(
  path: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
): Promise<T> {
  return request("GET", path, query, apiKey, secretRaw, "") as unknown as T;
}

/* ------------------------------------------------------------------ */
/*  Fetch closed positions                                             */
/* ------------------------------------------------------------------ */

interface ApiResponse {
  code: number;
  msg?: string;
  data?: {
    account?: Record<string, unknown>;
    positions?: RawPosition[];
  };
}

/**
 * Fetch all USDT-M positions from the API and return only closed ones
 * (side === "None" or positionStatus === "Closed").
 */
async function fetchClosedPositions(
  apiKey: string,
  secretRaw: Buffer,
  symbolFilter?: string,
): Promise<RawPosition[]> {
  const settlementCurrencies = ["USDT", "USD"];
  const allClosed: RawPosition[] = [];

  for (const cur of settlementCurrencies) {
    process.stdout.write(`⟐  USDT-M (${cur}) … `);
    try {
      const resp = await get<ApiResponse>(
        "/g-accounts/accountPositions",
        `currency=${cur}`,
        apiKey,
        secretRaw,
      );
      if (resp.code !== 0) {
        console.log(`API error: ${resp.msg ?? resp.code}`);
        continue;
      }
      const positions = resp.data?.positions ?? [];
      // Closed positions: side "None" or positionStatus "Closed"
      const closed = positions.filter(
        (p) => p.side === "None" || p.positionStatus === "Closed",
      );
      allClosed.push(...closed);
      console.log(`${closed.length} closed position(s)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`error: ${msg}`);
    }
  }

  if (symbolFilter) {
    const upper = symbolFilter.toUpperCase();
    return allClosed.filter((p) => p.symbol.toUpperCase() === upper);
  }
  return allClosed;
}

/* ------------------------------------------------------------------ */
/*  Print the table                                                    */
/* ------------------------------------------------------------------ */

function printTable(positions: RawPosition[]): void {
  if (positions.length === 0) {
    console.log("\nNo closed positions found.");
    return;
  }

  console.log(
    `\n${"Symbol".padEnd(12)} ${"Side".padEnd(7)} ${"Size".padStart(10)} ` +
    `${"Entry Price".padStart(14)} ${"Close Price".padStart(14)} ${"Closed P&L".padStart(14)} ` +
    `${"Status".padEnd(10)}`
  );
  console.log("─".repeat(97));

  for (const p of positions) {
    const entry = parseFloat(p.avgEntryPrice || "0");

    // Try to get close price from various API fields
    const closePriceRaw =
      (p as Record<string, unknown>)["avgClosePriceRp"] ??
      (p as Record<string, unknown>)["avgClosePrice"] ??
      (p as Record<string, unknown>)["closePriceRp"] ??
      (p as Record<string, unknown>)["closePrice"];
    const closePrice = parseFloat(String(closePriceRaw ?? "0"));

    // Try to get realized PnL from various API fields
    const closedPnlRaw =
      (p as Record<string, unknown>)["closedPnl"] ??
      (p as Record<string, unknown>)["realisedPnl"] ??
      (p as Record<string, unknown>)["realizedPnl"] ??
      (p as Record<string, unknown>)["closedPnlRv"];
    let closedPnl = 0;
    if (closedPnlRaw !== undefined && closedPnlRaw !== null) {
      // closedPnlRv is a scaled value (÷10000), closedPnl is already human-readable
      const rawStr = String(closedPnlRaw);
      closedPnl = rawStr.includes(".") ? parseFloat(rawStr) : toHuman(closedPnlRaw, 10000);
    }

    const size = parseFloat(p.size || "0");
    const status = p.positionStatus || (p.side === "None" ? "Closed" : "Unknown");

    // Determine the original side (Buy/Sell) before closure
    // The API may keep the original side even when closed, or it may be "None"
    const sideLabel = p.side === "None" ? "—" : p.side;

    // If closedPnl is 0 but we have no price data, try to calculate from entry/close prices
    if (closedPnl === 0 && closePrice > 0 && entry > 0 && size > 0) {
      const origSide = (p as Record<string, unknown>)["side"] ?? p.side;
      closedPnl = origSide === "Sell"
        ? (entry - closePrice) * Math.abs(size)
        : (closePrice - entry) * Math.abs(size);
    }

    const sideFmt = sideLabel.padEnd(6);
    const sizeFmt = Math.abs(size).toFixed(4).padStart(10);
    const entryFmt = entry.toFixed(2).padStart(14);
    const closeFmt = closePrice > 0 ? closePrice.toFixed(2).padStart(14) : "—".padStart(14);
    const pnlFmt = (closedPnl >= 0 ? "+" : "") + closedPnl.toFixed(2).padStart(13);
    const statusFmt = status.padEnd(10);

    console.log(
      `${p.symbol.padEnd(12)} ${sideFmt} ${sizeFmt} ${entryFmt} ${closeFmt} ` +
      `${pnlFmt} ${statusFmt}`
    );
  }
  console.log("─".repeat(97));
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const symbolIdx = process.argv.indexOf("--symbol");
  const symbolFilter = symbolIdx !== -1 ? process.argv[symbolIdx + 1] ?? "" : "";

  const LOOP_MODE = process.argv.includes("--loop");
  const LOOP_ONCE = process.argv.includes("--once");
  const loopIdx = process.argv.indexOf("--interval");
  const LOOP_INTERVAL = loopIdx !== -1
    ? Math.max(parseInt(process.argv[loopIdx + 1], 10) || 5000, 1000)
    : 5000;

  if (LOOP_MODE) {
    process.stdout.write(`Loop mode — polling every ${LOOP_INTERVAL} ms`);
    if (LOOP_ONCE) process.stdout.write(" (once)");
    process.stdout.write("\n\n");
    while (true) {
      const positions = await fetchClosedPositions(creds.PHEMEX_API_KEY, secretRaw, symbolFilter || undefined);
      printTable(positions);
      if (LOOP_ONCE) break;
      await sleep(LOOP_INTERVAL);
      console.clear();
    }
    process.exit(0);
  }

  const positions = await fetchClosedPositions(creds.PHEMEX_API_KEY, secretRaw, symbolFilter || undefined);
  printTable(positions);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});