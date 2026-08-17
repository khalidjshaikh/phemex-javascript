#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ws-auto-trader.ts — Autonomous trading bot for Phemex USDT-M perps.
 *
 * Streams ask, bid, index, mark, last via WebSocket and trades when the
 * index-last spread exceeds a threshold.
 *
 * Strategy:
 *   Long entry:  index - last > threshold  → market buy at ask
 *   Short entry: index - last < -threshold → market sell at bid
 *   Long exit:   bid > entryPrice          → market sell (reduceOnly)
 *   Short exit:  ask < entryPrice          → market buy (reduceOnly)
 *
 * Usage:
 *   npx tsx phemex-ws-auto-trader.ts --symbol XTIUSDT --qty 0.01
 *   npx tsx phemex-ws-auto-trader.ts --symbol XTIUSDT --qty 0.01 --leverage 50 --threshold 0.3
 */

import { ReconnectingWs } from "../src/ws-client.js";
import { getArg, hasFlag, findSymbolRow } from "../src/cli-utils.js";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import {
  placeMarketOrder,
  setLeverageUsdtM,
} from "../src/place-limit-order.js";
import { fetchPositions } from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  CLI                                                                */
/* ------------------------------------------------------------------ */

const USAGE = `Usage: npx tsx phemex-ws-auto-trader.ts [options]

Autonomous trading bot for Phemex USDT-M perpetuals.

Options:
  --symbol <SYM>      Symbol to trade (default: XTIUSDT)
  --qty <num>         Contract quantity per trade (default: 0.01)
  --leverage <num>    Leverage (default: 100)
  --threshold <num>   Index-last spread threshold for entry (default: 0.2)
  --bias <num>        Index-last spread bias (default: 0)
  --dry-run           Show signals without placing orders
  --debug             Print raw WebSocket messages
  --help              Show this help and exit
`;

if (hasFlag("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const SYMBOL = getArg("--symbol") ?? "XTIUSDT";
const QTY = parseFloat(getArg("--qty") ?? "0.01");
const LEVERAGE = parseInt(getArg("--leverage") ?? "100", 10);
const DRY_RUN = hasFlag("--dry-run");
const DEBUG = hasFlag("--debug");
const WS_URL = "wss://ws.phemex.com";

const SYMBOL_CONFIG: Record<string, { bias: number; threshold: number }> = {
  XTRUSDT: { bias: -0.1, threshold: 0.2 },
  XBRUSDT: { bias: -0.01753, threshold: 0.2 },
};

const config = SYMBOL_CONFIG[SYMBOL] ?? {
  bias: parseFloat(getArg("--bias") ?? "0"),
  threshold: parseFloat(getArg("--threshold") ?? "0.2"),
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TickerData {
  ask: number;
  bid: number;
  index: number;
  mark: number;
  last: number;
  timestamp: number;
}

interface Deltas {
  ask: number;
  bid: number;
  index: number;
  mark: number;
  last: number;
}

type State = "IDLE" | "LONG" | "SHORT";

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let state: State = "IDLE";
let entryPrice = 0;
let bestAsk = Infinity;
let bestBid = 0;
let lastTicker: TickerData | null = null;
let prevTicker: TickerData | null = null;

const credentials = loadCredentialsLocal();
const secretRaw = base64UrlDecode(credentials.PHEMEX_API_SECRET);
const apiKey = credentials.PHEMEX_API_KEY;

/* ------------------------------------------------------------------ */
/*  Display                                                            */
/* ------------------------------------------------------------------ */

function fmt(v: number): string {
  return v >= 0 ? `+${v.toFixed(4)}` : v.toFixed(4);
}

function printTicker(t: TickerData, deltas: Deltas | null): void {
  const tsMs = t.timestamp > 1e12 ? t.timestamp / 1_000_000 : t.timestamp;
  const d = new Date(tsMs);
  const now = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  const spread = fmt(t.index - t.last);
  const aSpread = fmt(t.ask - t.last);
  const bSpread = fmt(t.bid - t.last);
  const abSpread = (t.ask - t.bid).toFixed(4);

  let line = `${now}  ${SYMBOL}  ask:${t.ask.toFixed(4)}  bid:${t.bid.toFixed(4)}  ab:${abSpread}  idx:${t.index.toFixed(4)}  mark:${t.mark.toFixed(4)}  last:${t.last.toFixed(4)}  I-L:${spread}  A-L:${aSpread}  B-L:${bSpread}`;

  if (deltas) {
    line += `  Δa:${fmt(deltas.ask)} Δb:${fmt(deltas.bid)} Δi:${fmt(deltas.index)} Δm:${fmt(deltas.mark)} Δl:${fmt(deltas.last)}`;
  }

  line += `  [${state}${state !== "IDLE" ? ` @${entryPrice.toFixed(4)}` : ""}]`;

  const inProfit = (state === "LONG" && t.bid > entryPrice) || (state === "SHORT" && t.ask < entryPrice);
  if (inProfit) line += " *";

  console.log(line);
}

/* ------------------------------------------------------------------ */
/*  Trading actions                                                    */
/* ------------------------------------------------------------------ */

async function openLong(): Promise<void> {
  if (DRY_RUN) {
    console.log(`   DRY RUN: open long ${SYMBOL} qty:${QTY} at ask`);
    return;
  }
  console.log(`   ⟐  Opening long ${SYMBOL}  qty: ${QTY}  at ask`);
  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", apiKey, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Buy", price: 0, qty: QTY, posSide: "Long" },
    apiKey,
    secretRaw,
  );
  console.log(`   ✓  Long opened  OrderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

async function closeLong(): Promise<void> {
  if (DRY_RUN) {
    console.log(`   DRY RUN: close long ${SYMBOL} qty:${QTY} at bid`);
    return;
  }
  console.log(`   ⟐  Closing long ${SYMBOL}  qty: ${QTY}  at bid`);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Sell", price: 0, qty: QTY, posSide: "Long", reduceOnly: true },
    apiKey,
    secretRaw,
  );
  console.log(`   ✓  Long closed  OrderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

async function openShort(): Promise<void> {
  if (DRY_RUN) {
    console.log(`   DRY RUN: open short ${SYMBOL} qty:${QTY} at bid`);
    return;
  }
  console.log(`   ⟐  Opening short ${SYMBOL}  qty: ${QTY}  at bid`);
  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Short", apiKey, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Sell", price: 0, qty: QTY, posSide: "Short" },
    apiKey,
    secretRaw,
  );
  console.log(`   ✓  Short opened  OrderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

async function closeShort(): Promise<void> {
  if (DRY_RUN) {
    console.log(`   DRY RUN: close short ${SYMBOL} qty:${QTY} at ask`);
    return;
  }
  console.log(`   ⟐  Closing short ${SYMBOL}  qty: ${QTY}  at ask`);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Buy", price: 0, qty: QTY, posSide: "Short", reduceOnly: true },
    apiKey,
    secretRaw,
  );
  console.log(`   ✓  Short closed  OrderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

/* ------------------------------------------------------------------ */
/*  Strategy evaluation                                                */
/* ------------------------------------------------------------------ */

async function evaluate(ticker: TickerData): Promise<void> {
  const spread = ticker.index - ticker.last + config.bias;

  if (state === "IDLE") {
    // Verify no existing position before opening
    try {
      const positions = await fetchPositions(apiKey, secretRaw);
      const existing = positions.find((p) => p.symbol === SYMBOL && parseFloat(p.size || "0") !== 0);
      if (existing) {
        const posSide = existing.side === "Buy" ? "LONG" : "SHORT";
        entryPrice = parseFloat(existing.avgEntryPriceRp || "0");
        state = posSide as State;
        bestAsk = Infinity;
        bestBid = 0;
        console.log(`   ℹ  Found existing ${posSide} position, syncing state`);
        return;
      }
    } catch {
      // Ignore position check errors, proceed with signal
    }
    if (spread > config.threshold) {
      console.log(`\n   ▲  SIGNAL: index-last+bias (${spread.toFixed(4)}) > ${config.threshold} → OPEN LONG`);
      state = "LONG";
      entryPrice = ticker.ask;
      bestBid = ticker.bid;
      await openLong();
    } else if (spread < -config.threshold) {
      console.log(`\n   ▼  SIGNAL: index-last+bias (${spread.toFixed(4)}) < -${config.threshold} → OPEN SHORT`);
      state = "SHORT";
      entryPrice = ticker.bid;
      bestAsk = ticker.ask;
      await openShort();
    }
  } else if (state === "LONG") {
    bestBid = Math.max(bestBid, ticker.bid);
    if (ticker.bid < bestBid) {
      console.log(`\n   ▲  TAKE PROFIT: bid (${ticker.bid.toFixed(4)}) < best (${bestBid.toFixed(4)}) → CLOSE LONG`);
      try {
        await closeLong();
        state = "IDLE";
        entryPrice = 0;
        bestBid = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("REDUCE_ONLY_ABORT")) {
          console.log(`   ℹ  Position already closed, resetting to IDLE`);
          state = "IDLE";
          entryPrice = 0;
          bestBid = 0;
        } else {
          console.error(`   ✗  Failed to close long, keeping state LONG: ${msg}`);
        }
      }
    }
  } else if (state === "SHORT") {
    bestAsk = Math.min(bestAsk, ticker.ask);
    if (ticker.ask > bestAsk) {
      console.log(`\n   ▼  TAKE PROFIT: ask (${ticker.ask.toFixed(4)}) > best (${bestAsk.toFixed(4)}) → CLOSE SHORT`);
      try {
        await closeShort();
        state = "IDLE";
        entryPrice = 0;
        bestAsk = Infinity;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("REDUCE_ONLY_ABORT")) {
          console.log(`   ℹ  Position already closed, resetting to IDLE`);
          state = "IDLE";
          entryPrice = 0;
          bestAsk = Infinity;
        } else {
          console.error(`   ✗  Failed to close short, keeping state SHORT: ${msg}`);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  USDT-M ticker extraction                                           */
/* ------------------------------------------------------------------ */

let cachedFields: string[] | null = null;

function extractTicker(msg: Record<string, unknown>): TickerData | null {
  if (msg.method === "market24h_p.update" && msg.data) {
    const d = msg.data as Record<string, unknown>;
    if (d.symbol !== SYMBOL) return null;
    return {
      ask: Number(d.askRp ?? 0),
      bid: Number(d.bidRp ?? 0),
      index: Number(d.indexRp ?? 0),
      mark: Number(d.markRp ?? 0),
      last: Number(d.lastRp ?? 0),
      timestamp: Number(d.timestamp ?? Date.now() * 1_000_000),
    };
  }

  if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
    if (Array.isArray(msg.fields)) {
      cachedFields = msg.fields as string[];
    }
    if (!cachedFields) return null;

    const ticker = findSymbolRow(msg.data as unknown[][], cachedFields, SYMBOL);
    if (!ticker) return null;
    return {
      ask: Number(ticker.askRp ?? 0),
      bid: Number(ticker.bidRp ?? 0),
      index: Number(ticker.indexRp ?? 0),
      mark: Number(ticker.markRp ?? 0),
      last: Number(ticker.lastRp ?? 0),
      timestamp: Number(ticker.timestamp ?? Date.now() * 1_000_000),
    };
  }

  return null;
}

function computeDeltas(current: TickerData, previous: TickerData): Deltas {
  return {
    ask: current.ask - previous.ask,
    bid: current.bid - previous.bid,
    index: current.index - previous.index,
    mark: current.mark - previous.mark,
    last: current.last - previous.last,
  };
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  // Check existing position on startup
  const positions = await fetchPositions(apiKey, secretRaw);
  const existing = positions.find((p) => p.symbol === SYMBOL);
  if (existing) {
    const posSide = existing.side === "Buy" ? "LONG" : "SHORT";
    entryPrice = parseFloat(existing.avgEntryPriceRp || "0");
    state = posSide as State;
    bestAsk = Infinity;
    bestBid = 0;
    console.log(`⟐  Found existing ${posSide} position on ${SYMBOL}  entry: ${entryPrice}  size: ${existing.size}`);
  }

  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
    },
    onMessage: async (msg) => {
      if (DEBUG) {
        console.log(JSON.stringify(msg).slice(0, 500));
      }

      const ticker = extractTicker(msg);
      if (!ticker) return;

      const deltas = lastTicker ? computeDeltas(ticker, lastTicker) : null;

      printTicker(ticker, deltas);

      // Update history
      prevTicker = lastTicker;
      lastTicker = ticker;

      // Evaluate strategy
      try {
        await evaluate(ticker);
      } catch (err) {
        console.error(`   ✗  Trade error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    onReconnect: (delayMs) => {
      console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
      cachedFields = null;
    },
  });

  console.log(`⟐  Auto-trading ${SYMBOL}  qty: ${QTY}  leverage: ${LEVERAGE}x  threshold: ${config.threshold}  bias: ${config.bias}  ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`⟐  Connecting to ${WS_URL} …`);
  ws.connect();
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
