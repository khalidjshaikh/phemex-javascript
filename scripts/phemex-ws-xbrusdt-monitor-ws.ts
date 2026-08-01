#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ws-xbrusdt-monitor-ws.ts — XBRUSDT WebSocket monitor: live ticker +
 *                                     trade feed + read-only position display.
 *
 * Data sources:
 *   1. WebSocket 24h ticker (perp_market24h_pack_p) — prints ticker line ~1s
 *   2. WebSocket trade feed (trade_p)                — prints trade arrows on each fill
 *   3. REST position polling (fetchPositions)         — displays open position, PnL %, margin
 *                                                      (read-only — no auto-trading)
 *
 * Usage:  ./phemex-ws-xbrusdt-monitor-ws.ts
 */

import fs from "node:fs";
import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow } from "../src/cli-utils.js";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentials } from "../src/credentials.js";
import {
  fetchPositions,
  calcPnlPct,
  Position,
} from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const PRICE_FILE = "xbrusdt-last-price.txt";
const LONG_PID_FILE = ".long-limit.pid";
const SHORT_PID_FILE = ".short-limit.pid";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "XBRUSDT";
const POLL_INTERVAL_MS = 2_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtNum(n: number, d: number = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

let lastTickerPrice = 0;
let direction: "↑" | "↓" = "↑";
let streak = 0;

function updateDirection(last: number, prev: number): void {
  if (last > prev) {
    if (direction === "↑") streak++;
    else { direction = "↑"; streak = 1; }
  } else if (last < prev) {
    if (direction === "↓") streak++;
    else { direction = "↓"; streak = 1; }
  }
}

function notifyLimitScripts(): void {
  for (const pidFile of [LONG_PID_FILE, SHORT_PID_FILE]) {
    try {
      const pidText = fs.readFileSync(pidFile, "utf8").trim();
      const pid = Number(pidText);
      if (!Number.isNaN(pid)) {
        process.kill(pid, "SIGUSR1");
      }
    } catch {
      // Ignore if the target process is not running or the PID file is absent.
    }
  }
}

function savePrice(price: number): void {
  fs.writeFileSync(PRICE_FILE, String(price), "utf8");
}

/* ------------------------------------------------------------------ */
/*  Ticker display (USDT-M Rp format, columnar data)                   */
/* ------------------------------------------------------------------ */

function printTicker(symbol: string, ticker: Record<string, unknown>): void {
  const open = Number(ticker.openRp ?? 0);
  const high = Number(ticker.highRp ?? 0);
  const low = Number(ticker.lowRp ?? 0);
  const last = Number(ticker.lastRp ?? 0);
  const volume = Number(ticker.volumeRq ?? 0);
  const changePct = open > 0 ? ((last - open) / open) * 100 : 0;

  const now = fmtTime();
  const sign = changePct >= 0 ? "+" : "";
  const priceStr = `$${last.toFixed(2)}`;
  const highStr = `H: $${high.toFixed(2)}`;
  const lowStr = `L: $${low.toFixed(2)}`;
  const chgStr = `Chg: ${sign}${changePct.toFixed(2)}%`;
  const volStr = `Vol: ${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const line = `${now}  ${symbol}  ${priceStr}  ${highStr}  ${lowStr}  ${chgStr}  ${volStr}`;

  // if (last !== lastTickerPrice) {
    updateDirection(last, lastTickerPrice);
    const streakStr = ` (${direction}×${streak})`;
    process.stdout.write(line + streakStr);
    console.log();
    lastTickerPrice = last;
    savePrice(last);
    notifyLimitScripts();
  // }
}

/* ------------------------------------------------------------------ */
/*  Trade print (from trade_p channel)                                 */
/* ------------------------------------------------------------------ */

function printTrade(symbol: string, price: number): void {
  if (price !== lastTickerPrice) {
    updateDirection(price, lastTickerPrice);
    const arrow = direction;
    const streakStr = ` (${arrow}×${streak})`;
    process.stdout.write(`${fmtTime()}  ${symbol}  ${arrow} $${price.toFixed(2)}${streakStr}`);
    console.log();
    lastTickerPrice = price;
    savePrice(price);
    notifyLimitScripts();
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`═ XBRUSDT WS Monitor (read-only) ═══════════════════════════`);
  console.log(`  Symbol:       ${SYMBOL}`);
  console.log(`  Position poll: every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`═════════════════════════════════════════════════════════════`);

  // ---------------------------------------------------------------
  // WebSocket — ticker + trade feed
  // ---------------------------------------------------------------
  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [SYMBOL], id: 1 });
      ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
    },
    onMessage: (msg) => {
      const m = msg as Record<string, unknown>;
      console.log(msg)

      // 24h ticker (columnar USDT-M format)
      if (
        m.method === "perp_market24h_pack_p.update" &&
        Array.isArray(m.fields) &&
        Array.isArray(m.data)
      ) {
        const ticker = findSymbolRow(m.data as unknown[][], m.fields as string[], SYMBOL);
        if (ticker) {
          printTicker(SYMBOL, ticker);
        }
        return;
      }

      // Real-time trades
      if (m.trades_p && m.symbol === SYMBOL) {
        const trades = m.trades_p as unknown[][];
        if (trades.length > 0 && trades[0].length >= 3) {
          const last = Number(trades[0][2]);
          printTrade(SYMBOL, last);
        }
      }
    },
    onReconnect: (delayMs) => {
      process.stdout.write("\n");
      console.log(`[${fmtTime()}]  ⟐  WebSocket reconnecting in ${delayMs / 1000}s …`);
    },
  });

  ws.connect();

  // ---------------------------------------------------------------
  // Position polling loop (REST)
  // ---------------------------------------------------------------
  let running = true;

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}]  ⏹  Shutting down …`);
    running = false;
    ws.shutdown();
    process.exit(0);
  });

  while (running) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (!running) break;

  //   try {
  //     const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
  //     const pos = positions.find((p) => p.symbol === SYMBOL);

  //     if (!pos) {
  //       continue;
  //     }

  //     const pnlPct = calcPnlPct(pos);
  //     const entry = parseFloat(pos.avgEntryPriceRp || "0");
  //     const mark = parseFloat(pos.markPriceRp || "0");
  //     const size = parseFloat(pos.size || "0");
  //     const margin = parseFloat(pos.posCostRv || "0");

  //     process.stdout.write(
  //       `[${fmtTime()}]  ${SYMBOL}  ${pos.side.padEnd(4)}  ` +
  //       `size: ${fmtNum(size, 4)}  entry: $${fmtNum(entry)}  mark: $${fmtNum(mark)}  ` +
  //       `PnL: ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%  ` +
  //       `margin: $${fmtNum(margin, 4)}`
  //     );
  //     console.log();
  //   } catch (err: unknown) {
  //     const msg = err instanceof Error ? err.message : String(err);
  //     console.error(`[${fmtTime()}]  ✗  Position poll error: ${msg}`);
  //   }
  }

  console.log(`[${fmtTime()}]  ✅  Monitor stopped`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
