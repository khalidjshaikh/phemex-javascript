#!/usr/bin/env npx tsx

/**
 * phemex-ws-ema-crossover.ts  —  EMA20/EMA50 crossover trading bot with
 * EMA200 trend filter for BTCUSD.
 *
 * Listens to the Phemex WebSocket 24h ticker channel, maintains a rolling
 * price history, and computes EMA20, EMA50, and EMA200 on every update.
 *
 * When both EMAs are seeded (≥50 ticks) crossover detection activates:
 *
 *   NONE + EMA20 ↑ EMA50 + Price > EMA200  →  go LONG
 *   NONE + EMA20 ↓ EMA50 + Price < EMA200  →  go SHORT
 *   LONG + EMA20 ↓ EMA50                   →  close LONG
 *       + Price < EMA200                   →  open SHORT  (→ SHORT)
 *       + Price ≥ EMA200                   →  go flat     (→ NONE)
 *   SHORT + EMA20 ↑ EMA50                  →  close SHORT
 *       + Price > EMA200                   →  open LONG   (→ LONG)
 *       + Price ≤ EMA200                   →  go flat     (→ NONE)
 *
 * Price history is persisted to disk on shutdown and reloaded on startup.
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 *
 * Usage:  ./phemex-ws-ema-crossover.ts
 */

import path from "node:path";
import fs from "node:fs";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "BTCUSD";
const PRICE_SCALE = 10_000;
const HEARTBEAT_INTERVAL = 20_000; // 20s
const DISPLAY_INTERVAL = 1_000;    // 1s
const PERSIST_PATH = path.resolve(import.meta.dirname, ".phemex-ws-ema-prices.json");
const POSITION_PATH = path.resolve(import.meta.dirname, ".phemex-ws-ema-position.json");

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Position = "NONE" | "LONG" | "SHORT";

/* ------------------------------------------------------------------ */
/*  EMA Calculator                                                     */
/* ------------------------------------------------------------------ */

class EMACalculator {
  private prices: number[] = [];
  private ema20: number | null = null;
  private ema50: number | null = null;
  private ema200: number | null = null;

  addPrice(price: number): void {
    this.prices.push(price);
    this.ema20 = this.computeEMA(20, this.ema20, price);
    this.ema50 = this.computeEMA(50, this.ema50, price);
    this.ema200 = this.computeEMA(200, this.ema200, price);
  }

  /** Replace the price history and recompute all EMAs (used on startup restore). */
  loadPrices(prices: number[]): void {
    this.prices = [];
    this.ema20 = null;
    this.ema50 = null;
    this.ema200 = null;
    for (const p of prices) {
      this.addPrice(p);
    }
  }

  /** Return a copy of the price history for persistence. */
  getPrices(): number[] {
    return [...this.prices];
  }

  private computeEMA(period: number, prevEMA: number | null, price: number): number {
    const len = this.prices.length;
    if (len <= period) {
      // Not enough data for EMA yet — return SMA as the running estimate
      const slice = this.prices.slice(0, len);
      return slice.reduce((a, b) => a + b, 0) / len;
    }
    // prevEMA was set to SMA(prices[0..period-1]) on the (period)th tick,
    // so this is the first real EMA step onward
    const k = 2 / (period + 1);
    return price * k + (prevEMA ?? price) * (1 - k);
  }

  getEMA20(): number | null {
    return this.prices.length >= 20 ? this.ema20 : null;
  }

  getEMA50(): number | null {
    return this.prices.length >= 50 ? this.ema50 : null;
  }

  getEMA200(): number | null {
    return this.prices.length >= 200 ? this.ema200 : null;
  }

  get count(): number {
    return this.prices.length;
  }
}

/* ------------------------------------------------------------------ */
/*  Crossover strategy                                                  */
/* ------------------------------------------------------------------ */

let position: Position = "NONE";
let prevEma20: number | null = null;
let prevEma50: number | null = null;
let lastPosition: Position = "NONE";

function evaluateCrossover(price: number, ema20: number, ema50: number, ema200: number): void {
  // Need previous values to detect crossover
  if (prevEma20 === null || prevEma50 === null) {
    prevEma20 = ema20;
    prevEma50 = ema50;
    return;
  }

  const crossedAbove = prevEma20 < prevEma50 && ema20 >= ema50;
  const crossedBelow = prevEma20 > prevEma50 && ema20 <= ema50;

  // Update stored previous values for next tick
  prevEma20 = ema20;
  prevEma50 = ema50;

  if (!crossedAbove && !crossedBelow) return;

  const timestamp = new Date().toLocaleString();
  const actionParts: string[] = [];

  switch (position) {
    case "NONE":
      if (crossedAbove && price > ema200) {
        actionParts.push("go LONG");
        position = "LONG";
      } else if (crossedBelow && price < ema200) {
        actionParts.push("go SHORT");
        position = "SHORT";
      }
      break;

    case "LONG":
      if (crossedBelow) {
        actionParts.push("close LONG");
        if (price < ema200) {
          actionParts.push("open SHORT");
          position = "SHORT";
        } else {
          position = "NONE";
        }
      }
      break;

    case "SHORT":
      if (crossedAbove) {
        actionParts.push("close SHORT");
        if (price > ema200) {
          actionParts.push("open LONG");
          position = "LONG";
        } else {
          position = "NONE";
        }
      }
      break;
  }

  if (actionParts.length > 0) {
    const actions = actionParts.join(" / ");
    const crossedDir = crossedAbove ? "↑" : "↓";
    console.log(
      `· ${timestamp}  ` +
      `Price: ${price.toFixed(2)}  EMA20: ${ema20.toFixed(2)}  EMA50: ${ema50.toFixed(2)}  EMA200: ${ema200.toFixed(2)} ` +
      `(EMA20 ${crossedDir} EMA50) ` +
      `${actions.padEnd(22)} ${prevPositionLabel(lastPosition, actionParts)} `
    );
  }
}

/** Derive the "old → new" position label for the signal line. */
function prevPositionLabel(current: Position, actions: string[]): string {
  // Determine what the new position will be based on the actions performed
  // This is a helper for display only — position has already been updated
  return `${current} → ${position}`;
}

/* ------------------------------------------------------------------ */
/*  Reconnecting WebSocket wrapper                                     */
/* ------------------------------------------------------------------ */

let ws: WebSocket;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let reconnectDelay = 1_000; // start at 1s
const MAX_RECONNECT_DELAY = 30_000;

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
    `Position: ${position.padEnd(5)}  ` +
    `[ticks: ${ema.count}]`
  );
  lastPosition = position;
}

/* ------------------------------------------------------------------ */
/*  WebSocket                                                          */
/* ------------------------------------------------------------------ */

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    reconnectDelay = 1_000; // reset backoff on successful connection

    // Subscribe to 24h ticker channel (~1s updates)
    ws.send(JSON.stringify({ method: "market24h.subscribe", params: [], id: 2 }));

    // Start server heartbeat (keepalive ping)
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      ws.send(JSON.stringify({ method: "server.ping", params: [], id: Date.now() }));
    }, HEARTBEAT_INTERVAL);
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    const msg = JSON.parse(event.data as string);

    // Pong — heartbeat response
    if (msg.result === "pong") {
      return;
    }

    if (msg.error != null) {
      console.error("Subscription error:", msg.error);
      return;
    }

    // Ignore subscription ack
    if (msg.result?.status === "success") return;

    // 24h ticker channel — update price, EMAs, and evaluate crossover
    if (msg.market24h?.symbol === SYMBOL) {
      const { close: lastEp } = msg.market24h;
      lastPrice = lastEp / PRICE_SCALE;
      ema.addPrice(lastPrice);

      // Only evaluate crossover once all EMAs are seeded
      const ema20 = ema.getEMA20();
      const ema50 = ema.getEMA50();
      const ema200 = ema.getEMA200();
      if (ema20 !== null && ema50 !== null && ema200 !== null) {
        evaluateCrossover(lastPrice, ema20, ema50, ema200);
      }
    }
  });

  ws.addEventListener("close", () => {
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    /* error event is always followed by close, so reconnect handles it */
  });
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return; // already scheduled
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

/*  Graceful shutdown on Ctrl+C                                        */

function saveState(): void {
  try {
    const data = JSON.stringify(ema.getPrices());
    fs.writeFileSync(PERSIST_PATH, data, "utf8");
  } catch (e) {
    console.error("Failed to save price history:", e);
  }
  try {
    fs.writeFileSync(POSITION_PATH, JSON.stringify({ position }), "utf8");
  } catch (e) {
    console.error("Failed to save position:", e);
  }
}

process.on("SIGINT", () => {
  saveState();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stopHeartbeat();
  ws?.close();
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

// Restore persisted position
try {
  if (fs.existsSync(POSITION_PATH)) {
    const raw = fs.readFileSync(POSITION_PATH, "utf8");
    const data = JSON.parse(raw);
    if (data.position === "NONE" || data.position === "LONG" || data.position === "SHORT") {
      position = data.position;
      lastPosition = data.position;
      console.log(`⟐  Restored position: ${position}`);
    }
  }
} catch (e) {
  console.error("Failed to load position:", e);
}

connect();
setInterval(tickDisplay, DISPLAY_INTERVAL);
