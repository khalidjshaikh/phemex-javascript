#!/usr/bin/env npx tsx

/**
 * Phemex WebSocket EMA — subscribes to the BTCUSD 24h ticker channel,
 * maintains a rolling price history, and computes EMA20, EMA50, EMA200.
 *
 * A 1-second interval timer drives all output: every second it prints a
 * tick (`.`) and the current EMAs with the latest price.  The WebSocket
 * handler only updates the data — it never prints directly.
 *
 * Price history is persisted to disk on shutdown and reloaded on startup
 * so EMAs are immediately available after a restart.
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 *
 * Usage:  ./phemex-ws-ema.ts
 */

import path from "node:path";
import fs from "node:fs";
import { ReconnectingWs } from "./src/ws-client.js";
import { EMACalculator } from "./src/ema-calculator.js";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "BTCUSD";
const PRICE_SCALE = 10_000;
const DISPLAY_INTERVAL = 1_000;    // 1s
const PERSIST_PATH = path.resolve(import.meta.dirname, ".phemex-ws-ema-prices.json");

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const ema = new EMACalculator();
let lastPrice: number | null = null;

/* ------------------------------------------------------------------ */
/*  Display — runs every 1s                                            */
/* ------------------------------------------------------------------ */

let displayTicks = 0;

function tickDisplay(): void {
  displayTicks++;
  const now = new Date().toLocaleString();

  const priceStr = lastPrice !== null ? lastPrice.toFixed(2) : "—";
  const ema20 = ema.getEMA20();
  const ema50 = ema.getEMA50();
  const ema200 = ema.getEMA200();

  const ema20s = ema20 !== null ? ema20.toFixed(2) : "—";
  const ema50s = ema50 !== null ? ema50.toFixed(2) : "—";
  const ema200s = ema200 !== null ? ema200.toFixed(2) : "—";

  console.log(
    `· ${now}  ` +
    `Price: ${priceStr}  ` +
    `EMA20: ${ema20s}  EMA50: ${ema50s}  EMA200: ${ema200s}  ` +
    `[ticks: ${ema.count}] ` + 
    `[displayTicks: ${displayTicks}]`
  );
}

/* ------------------------------------------------------------------ */
/*  WebSocket                                                          */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  registerSigint: false, // script manages its own SIGINT (saves state before exit)
  onOpen: () => {
    // Subscribe to 24h ticker channel (~1s updates)
    ws.send({ method: "market24h.subscribe", params: [], id: 2 });
  },
  onMessage: (msg) => {
    const m = msg as Record<string, unknown>;

    // 24h ticker channel — update price and EMAs (display handles printing)
    const ticker = m.market24h as Record<string, unknown> | undefined;
    if (ticker?.symbol === SYMBOL) {
      const lastEp = Number(ticker.close);
      lastPrice = lastEp / PRICE_SCALE;
      ema.addPrice(lastPrice);
    }
  },
});

/*  Graceful shutdown on Ctrl+C                                        */

function savePrices(): void {
  try {
    const data = JSON.stringify(ema.getPrices());
    fs.writeFileSync(PERSIST_PATH, data, "utf8");
  } catch (e) {
    console.error("Failed to save price history:", e);
  }
}

process.on("SIGINT", () => {
  savePrices();
  ws.shutdown();
  process.exit(0);
});

/*  Start                                                              */

// Restore persisted price history so EMAs are available immediately
try {
  if (fs.existsSync(PERSIST_PATH)) {
    const raw = fs.readFileSync(PERSIST_PATH, "utf8");
    const prices: number[] = JSON.parse(raw);
    if (Array.isArray(prices) && prices.length > 0) {
      ema.loadPrices(prices);
      console.log(`⟐  Restored ${prices.length} prices from ${PERSIST_PATH}`);
    }
  }
} catch (e) {
  console.error("Failed to load price history:", e);
}

ws.connect();
setInterval(tickDisplay, DISPLAY_INTERVAL);
