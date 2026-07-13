#!/usr/bin/env npx tsx

/**
 * Phemex WebSocket Price — subscribes to the BTCUSD 24h ticker and tick
 * channels, printing the last price to stdout on each update.
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s and prints the pong to stdout.
 *
 * Usage:  ./phemex-ws-price.ts
 */

import { ReconnectingWs } from "./src/ws-client.js";
import { logPriceIfChanged } from "./src/ws-utils.js";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "BTCUSD";
const PRICE_SCALE = 10_000;

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    ws.send({ method: "market24h.subscribe", params: [], id: 2 });
  },
  onMessage: (msg) => {
    const m = msg as Record<string, unknown>;

    // Pong — heartbeat response
    if (m.result === "pong") {
      process.stdout.write("♥");
      return;
    }

    // Ignore error messages
    if (m.error != null) {
      console.error("Subscription error:", m.error);
      return;
    }

    // Tick channel — real-time trade price
    if (m.tick) {
      const tick = m.tick as Record<string, unknown>;
      const lastEp = Number(tick.last);
      const price = lastEp / PRICE_SCALE;
      logPriceIfChanged(price);
      return;
    }

    // 24h ticker channel — updates every 1s
    const ticker = m.market24h as Record<string, unknown> | undefined;
    if (ticker?.symbol === SYMBOL) {
      const lastEp = Number(ticker.close);
      const price = lastEp / PRICE_SCALE;
      logPriceIfChanged(price);
    }
  },
});

ws.connect();
