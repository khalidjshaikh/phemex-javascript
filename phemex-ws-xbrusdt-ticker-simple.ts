#!/usr/bin/env npx tsx

import fs from "node:fs";
import { ReconnectingWs } from "./src/ws-client.js";
import { findSymbolRow } from "./src/cli-utils.js";

const PRICE_FILE = "xbrusdt-last-price.txt";
const LONG_PID_FILE = ".long-limit.pid";
const SHORT_PID_FILE = ".short-limit.pid";

/**
 * Phemex WebSocket XBRUSDT Ticker — subscribes to the XBRUSDT 24h ticker
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
 *   [time]  XBRUSDT  $XX.XX  H: $XX.XX  L: $XX.XX  Chg: ±X.XX%  Vol: XXXX
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s.
 *
 * Usage:  ./phemex-ws-xbrusdt-ticker-simple.ts
 */

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "XBRUSDT";

// Cache the last known ticker values so we can do incremental updates
let lastPrice = 0;

// Track consecutive same-direction price moves
let direction: '↑' | '↓' = '↑';
let streak = 0;
let streakStartPrice = 0;

function updateDirection(last: number, prev: number): void {
  if (last > prev) {
    if (direction === '↑') streak++;
    else { direction = '↑'; streak = 1; streakStartPrice = prev; }
  } else if (last < prev) {
    if (direction === '↓') streak++;
    else { direction = '↓'; streak = 1; streakStartPrice = prev; }
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
  const mark = Number(ticker.markRp ?? 0);
  const index = Number(ticker.indexRp ?? 0);
  const funding = Number(ticker.fundingRateRr ?? 0);
  const oi = Number(ticker.openInterestRq ?? 0);
  const last = Number(ticker.lastRp ?? 0);
  const volume = Number(ticker.volumeRq ?? 0);

  const now = new Date().toLocaleString();
  const markStr = mark > 0 ? `mark: $${mark.toFixed(2)}` : "";
  const indexStr = index > 0 ? `  index: $${index.toFixed(2)}` : "";
  const fundPct = (funding * 100).toFixed(4);
  const fundSign = funding >= 0 ? "+" : "";
  const fundStr = funding !== 0 ? `  funding: ${fundSign}${fundPct}%` : "";
  const oiStr = oi > 0 ? `  OI: ${oi.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "";
  const volStr = `Vol: ${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const line = `${now}  ${symbol}  ${markStr}${indexStr}${fundStr}${oiStr}  ${volStr}`;

  process.stdout.write(line);
  console.log();
  if (last !== lastPrice) {
    lastPrice = last;
    fs.writeFileSync(PRICE_FILE, String(last), "utf8");
    notifyLimitScripts();
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    // Subscribe to all USDT-M 24h tickers (columnar format)
    // ws.send({ method: "perp_market24h_pack_p.subscribe", params: [SYMBOL], id: 1 });
    ws.send({ method: "market24h_p.subscribe", params: [SYMBOL], id: 1 });

    // Also subscribe to real-time trades for XBRUSDT
    ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
  },
  onMessage: (msg) => {
    const m = msg as Record<string, unknown>;

    // ---------------------------------------------------------------
    // USDT-M 24h ticker (columnar format)
    // ---------------------------------------------------------------
    
    if (m.method === "perp_market24h_pack_p.update" && Array.isArray(m.fields) && Array.isArray(m.data)) {
      console.log("perp_market24h_pack_p")
      console.log(m)
      const ticker = findSymbolRow(m.data as unknown[][], m.fields as string[], SYMBOL);
      if (ticker) {
        printTicker(SYMBOL, ticker);
      }
      return;
    }

    // ---------------------------------------------------------------
    // USDT-M trade channel — real-time trade price
    // ---------------------------------------------------------------
    if (m.trades_p && m.symbol === SYMBOL) {
      const trades = m.trades_p as unknown[][];
      if (trades.length > 0 && trades[0].length >= 3) {
        const last = Number(trades[0][2]);
        if (last !== lastPrice) {
          updateDirection(last, lastPrice);
          const delta = last - streakStartPrice;
          const deltaStr = delta >= 0 ? `Δ+$${delta.toFixed(2)}` : `Δ-$${Math.abs(delta).toFixed(2)}`;
          const now = new Date().toLocaleString();
          const line = `${now}  ${SYMBOL}  ${direction} $${last.toFixed(2)} (${direction}×${streak}, ${deltaStr})`;
          process.stdout.write(line);
          console.log();
          lastPrice = last;
          fs.writeFileSync(PRICE_FILE, String(last), "utf8");
          notifyLimitScripts();
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
