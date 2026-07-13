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
import { printTickerEp } from "./src/ws-utils.js";

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
      printTickerEp(SYMBOL, ticker, PRICE_SCALE);
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
  },
});

console.log(`⟐  Connecting to ${WS_URL} …`);
ws.connect();