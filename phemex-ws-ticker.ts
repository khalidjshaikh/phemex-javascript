#!/usr/bin/env npx tsx

/**
 * Phemex WebSocket Ticker — subscribes to the BTCUSD 24h ticker channel and
 * prints a compact ticker line every time the price updates (~1s intervals).
 *
 * Output format:
 *   [time]  BTCUSD  $XX,XXX.XX  H: $XX,XXX  L: $XX,XXX  Chg: ±X.XX%  Vol: XXXX
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s.
 *
 * Usage:  ./phemex-ws-ticker.ts
 */

import { ReconnectingWs } from "./src/ws-client.js";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "BTCUSD";
const PRICE_SCALE = 10_000;

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    ws.send({ method: "market24h.subscribe", params: [], id: 1 });
  },
  onMessage: (msg) => {
    // 24h ticker channel — updated every ~1s
    const ticker = (msg as Record<string, unknown>).market24h as Record<string, unknown> | undefined;
    if (ticker?.symbol === SYMBOL) {
      const close = Number(ticker.close) / PRICE_SCALE;
      const high = Number(ticker.high) / PRICE_SCALE;
      const low = Number(ticker.low) / PRICE_SCALE;
      const open = Number(ticker.open) / PRICE_SCALE;
      const volume = ticker.volume;
      const changePct = open > 0 ? ((close - open) / open) * 100 : 0;

      const now = new Date().toLocaleString();
      const sign = changePct >= 0 ? "+" : "";
      const priceStr = `$${close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const highStr = `H: $${high.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      const lowStr = `L: $${low.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      const chgStr = `Chg: ${sign}${changePct.toFixed(2)}%`;
      const volStr = `Vol: ${Number(volume).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

      process.stdout.write(`\r\x1b[K`);
      process.stdout.write(`${now}  ${SYMBOL}  ${priceStr}  ${highStr}  ${lowStr}  ${chgStr}  ${volStr}`);
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
  },
});

console.log(`⟐  Connecting to ${WS_URL} …`);
ws.connect();