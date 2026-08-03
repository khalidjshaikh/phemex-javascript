#!/usr/bin/env npx tsx

import fs from "node:fs";
import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow } from "../src/cli-utils.js";

const PRICE_FILE = "xtiusdt-last-price.txt";
const TICK_LOG = "xtiusdt-ticks.log";
const LONG_PID_FILE = ".long-limit.pid";
const SHORT_PID_FILE = ".short-limit.pid";

/**
 * Phemex WebSocket XTIUSDT Ticker — subscribes to the XTIUSDT 24h ticker
 * channel on the USDT-M perpetual endpoint and prints a compact ticker line
 * every time the price updates (~1s intervals).
 *
 * Uses the USDT-M-specific WebSocket subscription methods:
 *   - perp_market24h_pack_p.subscribe  (24h ticker for all USDT-M symbols)
 *   - trade_p.subscribe                (real-time trade prices)
 *
 * Prices are in real-value (Rp) format — no EP scaling needed.
 *
 * Output format:
 *   [time]  XTIUSDT  $XX.XX
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s.
 *
 * Usage:  ./phemex-ws-xti-ticker.ts [--symbol <SYMBOL>]
 *   --symbol <SYMBOL>   Contract symbol to track (default: XTIUSDT)
 */

const WS_URL = "wss://ws.phemex.com";

/* Parse CLI flags like --symbol XTIUSDT */
function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const SYMBOL = parseArg("symbol") ?? "XTIUSDT";

// Cache the last known ticker values so we can do incremental updates
let lastPrice = 0;

// Track consecutive same-direction price moves
let direction: '↑' | '↓' = '↑';
let streak = 0;
let streakStartPrice = 0;
let streakStartTime = Date.now();
let prevTime: number = 0;


function updateDirection(last: number, prev: number, ts: Date | number = Date.now()): void {
  const tsMs = ts instanceof Date ? ts.getTime() : ts;
  // First tick after startup — seed the streak baseline from the first real
  // price instead of measuring the delta from the 0 sentinel.
  if (prev === 0) {
    streakStartPrice = last;
    streakStartTime = tsMs;
    streak = 1;
    return;
  }
  if (last > prev) {
    if (direction === '↑') streak++;
    else { direction = '↑'; streak = 1; streakStartPrice = prev; streakStartTime = tsMs; }
  } else if (last < prev) {
    if (direction === '↓') streak++;
    else { direction = '↓'; streak = 1; streakStartPrice = prev; streakStartTime = tsMs; }
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

function printTicker(symbol: string, ticker: Record<string, unknown>): void {
  const last = Number(ticker.lastRp ?? 0);

  const now = new Date().toLocaleString();
  const priceStr = `$${last.toFixed(2)}`;

  const line = `${now}  ${symbol}  ${priceStr}`;

  if (last !== lastPrice) {
    updateDirection(last, lastPrice);
    const elapsed = Math.floor((Date.now() - streakStartTime) / 1000);
    const durationStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
    const delta = last - streakStartPrice;
    const deltaStr = delta >= 0 ? `Δ+$${delta.toFixed(2)}` : `Δ-$${Math.abs(delta).toFixed(2)}`;
    const streakStr = ` (${direction}×${streak}, ${deltaStr}, ${durationStr})`;
    const tickLine = line + streakStr;
    process.stdout.write(tickLine);
    console.log();
    lastPrice = last;
    fs.writeFileSync(PRICE_FILE, String(last), "utf8");
    fs.appendFileSync(TICK_LOG, tickLine + "\n", "utf8");
    notifyLimitScripts();
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    // Subscribe to all USDT-M 24h tickers (columnar format)
    ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });

    // Also subscribe to real-time trades for XTIUSDT
    ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
  },
  onMessage: (msg) => {
    const m = msg as Record<string, unknown>;

    // ---------------------------------------------------------------
    // USDT-M 24h ticker (columnar format)
    // ---------------------------------------------------------------
    if (m.method === "perp_market24h_pack_p.update" && Array.isArray(m.fields) && Array.isArray(m.data)) {
      const ticker = findSymbolRow(m.data as unknown[][], m.fields as string[], SYMBOL);
      if (ticker) {
        console.log("printTicker")
        printTicker(SYMBOL, ticker);
      }
      return;
    }

    // ---------------------------------------------------------------
    // USDT-M trade channel — real-time trade price
    // ---------------------------------------------------------------
    if (m.trades_p && m.symbol === SYMBOL) {
      // console.log(m)
      const trades = m.trades_p as unknown[][];
      const sortedTrades = trades.slice().sort((a, b) => Number(a[0]) - Number(b[0]));
      let streakStartTime: number = sortedTrades.length > 0 ? Number(sortedTrades[0][0]) / 1e6 : 0; // first trade timestamp in ms
      if (sortedTrades.length > 0) {
        for (const trade of sortedTrades) {
          // console.log(trade)
          if (trade.length >= 3) {
            const last: number = Number(trade[2]); 
            const side: string = String(trade[1]); // 'Buy' or 'Sell'
            const size: number = Number(trade[3]); // trade size
            const tradeTs: number = Number(trade[0]); // trade timestamp in ms
            const now: Date = new Date(tradeTs/1e6);
            const arrow: String = direction === '↑' ? '↑' : '↓';
            // if (last !== lastPrice) {
              updateDirection(last, lastPrice, tradeTs);
              // const elapsed = tradeTs/1e6 - prevTime/1e6;
              // let durationStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
              // console.log([now.getTime(), now, now.toLocaleString()])
              // console.log([tradeTs/1e6, new Date(tradeTs/1e6), (new Date(tradeTs/1e6)).toLocaleString()])
              // console.log([prevTime/1e6, new Date(prevTime/1e6), (new Date(prevTime/1e6)).toLocaleString()])
              // console.log(elapsed)
              const elapsed: float = (new Date(tradeTs/1e6) - new Date(prevTime/1e6))/1e3
              let durationStr : String = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toFixed(0)}s` : `${elapsed.toFixed(0)}s`;
              const delta = last - streakStartPrice;
              const deltaStr = delta >= 0 ? `Δ+$${delta.toFixed(2)}` : `Δ-$${Math.abs(delta).toFixed(2)}`;
              const streakStr = ` (${direction}×${streak}, ${deltaStr}, ${durationStr})`;
              const tradeLine = `[${now.toLocaleString()}] ${SYMBOL} ${side.padStart(4)} ${size} ${arrow}$${last.toFixed(2)}${streakStr}`;
              process.stdout.write(tradeLine);
              console.log();
              lastPrice = last;
              fs.writeFileSync(PRICE_FILE, String(last), "utf8");
              fs.appendFileSync(TICK_LOG, tradeLine + "\n", "utf8");
              notifyLimitScripts();
            // }
            prevTime = tradeTs;
          }
        }
      }
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
  },
});

console.log(`⟐  Connecting to ${WS_URL} (USDT-M) …`);
ws.connect();