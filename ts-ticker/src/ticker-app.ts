#!/usr/bin/env npx tsx

/**
 * Phemex WebSocket Ticker App — subscribes to the BTCUSD 24h ticker channel
 * and displays a live-updating table of key market data (last price, 24h
 * change, high, low, volume, turnover).
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s.
 *
 * Usage:  ./src/ticker-app.ts   or  npm start
 */

import { ReconnectingWs } from "../../src/ws-client.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "BTCUSD";
const PRICE_SCALE = 10_000;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Market24hData {
  symbol: string;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  turnover: number;
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let lastSnapshot: string | undefined;

/* ------------------------------------------------------------------ */
/*  Display helpers                                                    */
/* ------------------------------------------------------------------ */

function formatPrice(ep: number): string {
  return (ep / PRICE_SCALE).toFixed(2);
}

function formatChange(close: number, open: number): string {
  const change = (close - open) / PRICE_SCALE;
  const pct    = open !== 0 ? ((change / (open / PRICE_SCALE)) * 100) : 0;
  const sign   = change >= 0 ? "+" : "";
  const color  = change >= 0 ? "\x1b[32m" : "\x1b[31m"; // green / red
  return `${color}${sign}${change.toFixed(2)} (${sign}${pct.toFixed(2)}%)\x1b[0m`;
}

function formatVolume(v: number): string {
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + "B";
  if (v >= 1_000_000)     return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000)         return (v / 1_000).toFixed(2) + "K";
  return v.toFixed(2);
}

function formatTurnover(ep: number): string {
  const usd = ep / PRICE_SCALE;
  if (usd >= 1_000_000_000) return "$" + (usd / 1_000_000_000).toFixed(2) + "B";
  if (usd >= 1_000_000)     return "$" + (usd / 1_000_000).toFixed(2) + "M";
  if (usd >= 1_000)         return "$" + (usd / 1_000).toFixed(2) + "K";
  return "$" + usd.toFixed(2);
}

function renderSnapshot(d: Market24hData): string {
  const now = new Date().toLocaleString();
  const lines = [
    `\x1b[1m\x1b[33m  Phemex BTCUSD Ticker\x1b[0m  ${now}\n`,
    `  ┌─────────────────────┬──────────────────────┐`,
    `  │ \x1b[1mLast Price\x1b[0m           │ ${formatPrice(d.close).padStart(20)} │`,
    `  │ \x1b[1m24h Change\x1b[0m           │ ${formatChange(d.close, d.open).padStart(30)} │`,
    `  │ \x1b[1m24h High\x1b[0m             │ ${formatPrice(d.high).padStart(20)} │`,
    `  │ \x1b[1m24h Low\x1b[0m              │ ${formatPrice(d.low).padStart(20)} │`,
    `  │ \x1b[1m24h Volume (BTC)\x1b[0m     │ ${formatVolume(d.volume).padStart(20)} │`,
    `  │ \x1b[1m24h Turnover (USD)\x1b[0m   │ ${formatTurnover(d.turnover).padStart(20)} │`,
    `  └─────────────────────┴──────────────────────┘`,
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    // Subscribe to the 24h ticker channel
    ws.send({ method: "market24h.subscribe", params: [], id: 1 });
  },
  onMessage: (msg) => {
    const m = msg as Record<string, unknown>;

    // Pong — heartbeat response
    if (m.result === "pong") {
      process.stdout.write("\x1b[2m♥\x1b[0m"); // dim heart
      return;
    }

    if (m.error != null) {
      console.error("  Subscription error:", m.error);
      return;
    }

    // 24h ticker update
    const ticker = m.market24h as Market24hData | undefined;
    if (ticker?.symbol === SYMBOL) {
      const snapshot = renderSnapshot(ticker);
      if (snapshot !== lastSnapshot) {
        // Clear terminal and re-draw
        process.stdout.write("\x1b[2J\x1b[H"); // clear screen, home cursor
        process.stdout.write(snapshot + "\n");
        lastSnapshot = snapshot;
      }
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write(`\n  \x1b[33mDisconnected — reconnecting in ${delayMs / 1000}s\x1b[0m\n`);
  },
});

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

connect();