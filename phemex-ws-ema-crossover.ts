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
import { exec } from "node:child_process";
import { ReconnectingWs } from "./src/ws-client.js";
import { EMACalculator } from "./src/ema-calculator.js";

function runCommand(cmd: string): void {
  exec(cmd, (error, stdout, stderr) => {
    if (stdout) console.log(stdout.trimEnd());
    if (stderr) console.error(stderr.trimEnd());
    if (error) console.error(`  ✗ Command failed: ${error.message}`);
  });
}

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "BTCUSD";
const PRICE_SCALE = 10_000;
const DISPLAY_INTERVAL = 1_000;    // 1s
const PERSIST_PATH = path.resolve(import.meta.dirname, ".phemex-ws-ema-prices.json");
const POSITION_PATH = path.resolve(import.meta.dirname, ".phemex-ws-ema-position.json");

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Position = "NONE" | "LONG" | "SHORT";

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const ema = new EMACalculator();
let lastPrice: number | null = null;
let position: Position = "NONE";
let prevEma20: number | null = null;
let prevEma50: number | null = null;
let lastPosition: Position = "NONE";

/* ------------------------------------------------------------------ */
/*  Crossover strategy                                                  */
/* ------------------------------------------------------------------ */

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

  // if (!crossedAbove && !crossedBelow) return;

  const timestamp = new Date().toLocaleString();
  const actionParts: string[] = [];

  switch (position) {
    case "NONE":
      if (crossedAbove && price > ema200) {
        actionParts.push("go LONG");
        runCommand("./phemex-market-order.ts --side Long --qty 1 --leverage 100");
        position = "LONG";
        break;
      } else if (crossedAbove && price <= ema200) {
        actionParts.push("BLOCKED: go LONG (price ≤ EMA200)");
      } else if (crossedBelow && price < ema200) {
        actionParts.push("go SHORT");
        runCommand("./phemex-market-order.ts --side Short --qty 1 --leverage 100");
        position = "SHORT";
        break;
      } else if (crossedBelow && price >= ema200) {
        actionParts.push("BLOCKED: go SHORT (price ≥ EMA200)");
      }
      if(ema20 > ema50 && price > ema200) {
        actionParts.push("go LONG");
        runCommand("./phemex-market-order.ts --side Long --qty 1 --leverage 100");
        position = "LONG";
      }
      if(ema20 < ema50 && price < ema200) {
        actionParts.push("go SHORT");
        runCommand("./phemex-market-order.ts --side Short --qty 1 --leverage 100");
        position = "SHORT";
      }
      break;

    case "LONG":
      if (crossedBelow) {
        actionParts.push("close LONG");
        runCommand("./phemex-market-order.ts --side Short --qty 1 --leverage 100");
        if (price < ema200) {
          actionParts.push("open SHORT");
          position = "SHORT";
          runCommand("./phemex-market-order.ts --side Short --qty 1 --leverage 100");
        } else {
          position = "NONE";
        }
      }
      break;

    case "SHORT":
      if (crossedAbove) {
        actionParts.push("close SHORT");
        runCommand("./phemex-market-order.ts --side Long --qty 1 --leverage 100");
        if (price > ema200) {
          actionParts.push("open LONG");
          position = "LONG";
          runCommand("./phemex-market-order.ts --side Long --qty 1 --leverage 100");
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
      `Price: ${price.toFixed(2)}  EMA20: ${ema20.toFixed(2)}  EMA50: ${ema50.toFixed(2)}  EMA200: ${ema200.toFixed(2)}  ` +
      `(EMA20 ${crossedDir} EMA50) ` +
      `${actions.padEnd(22)} ${prevPositionLabel(lastPosition)} `
    );
  }
}

/** Derive the "old → new" position label for the signal line. */
function prevPositionLabel(prevPos: Position): string {
  return `${prevPos} → ${position}`;
}

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

  const emaComparison =
    ema20 !== null && ema50 !== null
      ? ema20 > ema50
        ? "(EMA20 ↑ EMA50)"
        : "(EMA20 ↓ EMA50)"
      : "";

  const priceVsEma200 =
    lastPrice !== null && ema200 !== null
      ? lastPrice > ema200
        ? "(Price ↑ EMA200)"
        : "(Price ↓ EMA200)"
      : "";

  console.log(
    `· ${now}  ` +
    `Price: ${priceStr}  ` +
    `EMA20: ${ema20s}  EMA50: ${ema50s}  EMA200: ${ema200s}  ` +
    `${emaComparison}  ${priceVsEma200}  ` +
    `Position: ${position.padEnd(5)}  ` +
    `[ticks: ${ema.count}]`
  );
  lastPosition = position;
}

/* ------------------------------------------------------------------ */
/*  WebSocket                                                          */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    // Subscribe to 24h ticker channel (~1s updates)
    ws.send({ method: "market24h.subscribe", params: [], id: 2 });
  },
  onMessage: (msg) => {
    const m = msg as Record<string, unknown>;

    // 24h ticker channel — update price, EMAs, and evaluate crossover
    const ticker = m.market24h as Record<string, unknown> | undefined;
    if (ticker?.symbol === SYMBOL) {
      const lastEp = Number(ticker.close);
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
  },
});

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

ws.connect();
setInterval(tickDisplay, DISPLAY_INTERVAL);
