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
import { getArg, hasFlag } from "../src/cli-utils.js";
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
  --symbol <SYM>      Symbol(s) to trade, comma-separated (default: XTIUSDT)
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

const SYMBOLS = (getArg("--symbol") ?? "XTIUSDT").split(",").map((s) => s.trim().toUpperCase());
const QTY_DEFAULT = parseFloat(getArg("--qty") ?? "0.01");
const LEVERAGE = parseInt(getArg("--leverage") ?? "100", 10);
const DRY_RUN = hasFlag("--dry-run");
const DEBUG = hasFlag("--debug");
const WS_URL = "wss://ws.phemex.com";

const SYMBOL_PRESETS: Record<string, { bias: number; threshold: number; qty: number; leverage: number }> = 
{
  BNBUSDT: { bias: 0.3, threshold: 0.35, qty: 0.01, leverage: 50 },
  BTCUSDT: { bias: -30, threshold: 50, qty: 0.001, leverage: 100 },
  DOGEUSDT: { bias: -0.000020, threshold: 0.000100, qty: 1, leverage: 50 },
  ETHUSDT: { bias: -0.85, threshold: 1.25, qty: 0.01, leverage: 100 },
  LINKUSDT: { bias: 0.000405155, threshold: 0.020279195, qty: 0.01, leverage: 50 },
  SOLUSDT: { bias: -0.04, threshold: 0.11, qty: 0.01, leverage: 50 },
  SUIUSDT: { bias: -0.0004, threshold: 0.0013, qty: 1, leverage: 50 },
  XAUUSDT: { bias: -2.3, threshold: 7, qty: 0.001, leverage: 100 },
  XBRUSDT: { bias: -0.02, threshold: 0.5, qty: 0.01, leverage: 100 },
  XRPUSDT: { bias: -0.000474535, threshold: 0.001286745, qty: 0.01, leverage: 50 },
  XTIUSDT: { bias: -0.125, threshold: 0.4, qty: 0.01, leverage: 100 },
};

function resolveConfig(symbol: string): { bias: number; threshold: number; qty: number; leverage: number } {
  if (SYMBOL_PRESETS[symbol]) return { ...SYMBOL_PRESETS[symbol] };
  return {
    bias: parseFloat(getArg("--bias") ?? "0"),
    threshold: parseFloat(getArg("--threshold") ?? "0.2"),
    qty: QTY_DEFAULT,
    leverage: LEVERAGE,
  };
}

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

interface SymbolState {
  state: State;
  entryPrice: number;
  bestAsk: number;
  bestBid: number;
  config: { bias: number; threshold: number; qty: number; leverage: number };
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const symbolStates = new Map<string, SymbolState>();
const lastTickers = new Map<string, TickerData>();

for (const sym of SYMBOLS) {
  symbolStates.set(sym, {
    state: "IDLE",
    entryPrice: 0,
    bestAsk: Infinity,
    bestBid: 0,
    config: resolveConfig(sym),
  });
}

const credentials = loadCredentialsLocal();
const secretRaw = base64UrlDecode(credentials.PHEMEX_API_SECRET);
const apiKey = credentials.PHEMEX_API_KEY;

/* ------------------------------------------------------------------ */
/*  Display                                                            */
/* ------------------------------------------------------------------ */

function fmt(v: number): string {
  return v >= 0 ? `+${v.toFixed(4)}` : v.toFixed(4);
}

function roundTo(v: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(v * factor) / factor;
}

const PRICE_PRECISION = 4;

function printTicker(symbol: string, t: TickerData, deltas: Deltas | null, symState: SymbolState): void {
  const tsMs = t.timestamp > 1e12 ? t.timestamp / 1_000_000 : t.timestamp;
  const d = new Date(tsMs);
  const now = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  const spread = fmt(t.index - t.last);
  const mSpread = fmt(t.mark - t.last);
  const aSpread = fmt(t.ask - t.last);
  const bSpread = fmt(t.bid - t.last);
  const abSpread = (t.ask - t.bid).toFixed(4);

  let line = `${now}  ${symbol}  ask:${t.ask.toFixed(4)}  bid:${t.bid.toFixed(4)}  ab:${abSpread}  idx:${t.index.toFixed(4)}  mark:${t.mark.toFixed(4)}  last:${t.last.toFixed(4)}  I-L:${spread}  M-L:${mSpread}  A-L:${aSpread}  B-L:${bSpread}`;

  if (deltas) {
    line += `  Δa:${fmt(deltas.ask)} Δb:${fmt(deltas.bid)} Δi:${fmt(deltas.index)} Δm:${fmt(deltas.mark)} Δl:${fmt(deltas.last)}`;
  }

  line += `  [${symState.state}${symState.state !== "IDLE" ? ` @${symState.entryPrice.toFixed(4)}` : ""}]`;

  const inProfit = (symState.state === "LONG" && t.bid > symState.entryPrice) || (symState.state === "SHORT" && t.ask < symState.entryPrice);
  if (inProfit) line += " *";

  console.log(line);
}

/* ------------------------------------------------------------------ */
/*  Trading actions                                                    */
/* ------------------------------------------------------------------ */

async function openLong(symbol: string, qty: number, leverage: number): Promise<void> {
  if (DRY_RUN) {
    console.log(`   DRY RUN: open long ${symbol} qty:${qty} leverage:${leverage}x at ask`);
    return;
  }
  console.log(`   ⟐  Opening long ${symbol}  qty: ${qty}  leverage: ${leverage}x  at ask`);
  await setLeverageUsdtM(symbol, leverage, "Long", apiKey, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol, side: "Buy", price: 0, qty, posSide: "Long" },
    apiKey,
    secretRaw,
  );
  console.log(`   ✓  Long opened  OrderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

async function closeLong(symbol: string, qty: number): Promise<void> {
  if (DRY_RUN) {
    console.log(`   DRY RUN: close long ${symbol} qty:${qty} at bid`);
    return;
  }
  console.log(`   ⟐  Closing long ${symbol}  qty: ${qty}  at bid`);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol, side: "Sell", price: 0, qty, posSide: "Long", reduceOnly: true },
    apiKey,
    secretRaw,
  );
  console.log(`   ✓  Long closed  OrderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

async function openShort(symbol: string, qty: number, leverage: number): Promise<void> {
  if (DRY_RUN) {
    console.log(`   DRY RUN: open short ${symbol} qty:${qty} leverage:${leverage}x at bid`);
    return;
  }
  console.log(`   ⟐  Opening short ${symbol}  qty: ${qty}  leverage: ${leverage}x  at bid`);
  await setLeverageUsdtM(symbol, leverage, "Short", apiKey, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol, side: "Sell", price: 0, qty, posSide: "Short" },
    apiKey,
    secretRaw,
  );
  console.log(`   ✓  Short opened  OrderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

async function closeShort(symbol: string, qty: number): Promise<void> {
  if (DRY_RUN) {
    console.log(`   DRY RUN: close short ${symbol} qty:${qty} at ask`);
    return;
  }
  console.log(`   ⟐  Closing short ${symbol}  qty: ${qty}  at ask`);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol, side: "Buy", price: 0, qty, posSide: "Short", reduceOnly: true },
    apiKey,
    secretRaw,
  );
  console.log(`   ✓  Short closed  OrderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

/* ------------------------------------------------------------------ */
/*  Strategy evaluation                                                */
/* ------------------------------------------------------------------ */

async function evaluate(symbol: string, ticker: TickerData, symState: SymbolState): Promise<void> {
  const spread = ticker.index - ticker.last + symState.config.bias;

  if (symState.state === "IDLE") {
    // Verify no existing position before opening
    try {
      const positions = await fetchPositions(apiKey, secretRaw);
      const existing = positions.find((p) => p.symbol === symbol && parseFloat(p.size || "0") !== 0);
      if (existing) {
        const posSide = existing.side === "Buy" ? "LONG" : "SHORT";
        symState.entryPrice = parseFloat(existing.avgEntryPriceRp || "0");
        symState.state = posSide as State;
        symState.bestAsk = Infinity;
        symState.bestBid = 0;
        console.log(`   ℹ  Found existing ${posSide} position on ${symbol}, syncing state`);
        return;
      }
    } catch {
      // Ignore position check errors, proceed with signal
    }
    if (spread > symState.config.threshold) {
      const il = ticker.index - ticker.last;
      console.log(`\n   ▲  SIGNAL [${symbol}]: I-L (${il.toFixed(4)}) + bias (${symState.config.bias}) = ${spread.toFixed(4)} > ${symState.config.threshold} → OPEN LONG`);
      symState.state = "LONG";
      symState.entryPrice = ticker.ask;
      symState.bestBid = ticker.bid;
      await openLong(symbol, symState.config.qty, symState.config.leverage);
    } else if (spread < -symState.config.threshold) {
      const il = ticker.index - ticker.last;
      console.log(`\n   ▼  SIGNAL [${symbol}]: I-L (${il.toFixed(4)}) + bias (${symState.config.bias}) = ${spread.toFixed(4)} < -${symState.config.threshold} → OPEN SHORT`);
      symState.state = "SHORT";
      symState.entryPrice = ticker.bid;
      symState.bestAsk = ticker.ask;
      await openShort(symbol, symState.config.qty, symState.config.leverage);
    }
  } else if (symState.state === "LONG") {
    const roundedBid = roundTo(ticker.bid, PRICE_PRECISION);
    const roundedBestBid = roundTo(symState.bestBid, PRICE_PRECISION);
    symState.bestBid = Math.max(symState.bestBid, ticker.bid);
    if (roundedBid < roundedBestBid) {
      const closeIL = (ticker.index - ticker.last).toFixed(4);
      const pnl = symState.entryPrice - ticker.bid;
      console.log(`\n   ▲  TAKE PROFIT [${symbol}]: bid (${ticker.bid.toFixed(4)}) < best (${symState.bestBid.toFixed(4)})  I-L:${closeIL}  entry:${symState.entryPrice.toFixed(4)}  entry-bid:${pnl.toFixed(4)} → CLOSE LONG`);
      try {
        await closeLong(symbol, symState.config.qty);
        symState.state = "IDLE";
        symState.entryPrice = 0;
        symState.bestBid = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("REDUCE_ONLY_ABORT")) {
          console.log(`   ℹ  Position already closed on ${symbol}, resetting to IDLE`);
          symState.state = "IDLE";
          symState.entryPrice = 0;
          symState.bestBid = 0;
        } else {
          console.error(`   ✗  Failed to close long on ${symbol}, keeping state LONG: ${msg}`);
        }
      }
    }
  } else if (symState.state === "SHORT") {
    const roundedAsk = roundTo(ticker.ask, PRICE_PRECISION);
    const roundedBestAsk = roundTo(symState.bestAsk, PRICE_PRECISION);
    symState.bestAsk = Math.min(symState.bestAsk, ticker.ask);
    if (roundedAsk > roundedBestAsk) {
      const closeIL = (ticker.index - ticker.last).toFixed(4);
      const pnl = ticker.ask - symState.entryPrice;
      console.log(`\n   ▼  TAKE PROFIT [${symbol}]: ask (${ticker.ask.toFixed(4)}) > best (${symState.bestAsk.toFixed(4)})  I-L:${closeIL}  entry:${symState.entryPrice.toFixed(4)}  ask-entry:${pnl.toFixed(4)} → CLOSE SHORT`);
      try {
        await closeShort(symbol, symState.config.qty);
        symState.state = "IDLE";
        symState.entryPrice = 0;
        symState.bestAsk = Infinity;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("REDUCE_ONLY_ABORT")) {
          console.log(`   ℹ  Position already closed on ${symbol}, resetting to IDLE`);
          symState.state = "IDLE";
          symState.entryPrice = 0;
          symState.bestAsk = Infinity;
        } else {
          console.error(`   ✗  Failed to close short on ${symbol}, keeping state SHORT: ${msg}`);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  USDT-M ticker extraction                                           */
/* ------------------------------------------------------------------ */

let cachedFields: string[] | null = null;

function extractTicker(msg: Record<string, unknown>): { symbol: string; ticker: TickerData } | null {
  if (msg.method === "market24h_p.update" && msg.data) {
    const d = msg.data as Record<string, unknown>;
    const sym = d.symbol as string;
    if (!symbolStates.has(sym)) return null;
    return {
      symbol: sym,
      ticker: {
        ask: Number(d.askRp ?? 0),
        bid: Number(d.bidRp ?? 0),
        index: Number(d.indexRp ?? 0),
        mark: Number(d.markRp ?? 0),
        last: Number(d.lastRp ?? 0),
        timestamp: Number(d.timestamp ?? Date.now() * 1_000_000),
      },
    };
  }

  if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
    if (Array.isArray(msg.fields)) {
      cachedFields = msg.fields as string[];
    }
    if (!cachedFields) return null;

    // Extract all matching tickers for tracked symbols
    const results: { symbol: string; ticker: TickerData }[] = [];
    for (const sym of symbolStates.keys()) {
      const row = (msg.data as unknown[][]).find((r) => String(r[0]) === sym);
      if (!row) continue;
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cachedFields.length && i < row.length; i++) {
        obj[cachedFields[i]] = row[i];
      }
      results.push({
        symbol: sym,
        ticker: {
          ask: Number(obj.askRp ?? 0),
          bid: Number(obj.bidRp ?? 0),
          index: Number(obj.indexRp ?? 0),
          mark: Number(obj.markRp ?? 0),
          last: Number(obj.lastRp ?? 0),
          timestamp: Number(obj.timestamp ?? Date.now() * 1_000_000),
        },
      });
    }
    // Return first match; main loop will call extractTicker again if needed
    return results.length > 0 ? results[0] : null;
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
  // Check existing positions on startup
  const positions = await fetchPositions(apiKey, secretRaw);
  for (const sym of SYMBOLS) {
    const existing = positions.find((p) => p.symbol === sym);
    const symState = symbolStates.get(sym)!;
    if (existing) {
      const posSide = existing.side === "Buy" ? "LONG" : "SHORT";
      symState.entryPrice = parseFloat(existing.avgEntryPriceRp || "0");
      symState.state = posSide as State;
      symState.bestAsk = Infinity;
      symState.bestBid = 0;
      console.log(`⟐  Found existing ${posSide} position on ${sym}  entry: ${symState.entryPrice}  size: ${existing.size}`);
    }
  }

  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
    },
    onMessage: async (msg) => {
      if (DEBUG) {
        console.log(JSON.stringify(msg).slice(0, 500));
      }

      // Handle pack updates with multiple symbols
      if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
        if (Array.isArray(msg.fields)) {
          cachedFields = msg.fields as string[];
        }
        if (!cachedFields) return;

        for (const sym of symbolStates.keys()) {
          const row = (msg.data as unknown[][]).find((r) => String(r[0]) === sym);
          if (!row) continue;
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < cachedFields.length && i < row.length; i++) {
            obj[cachedFields[i]] = row[i];
          }

          const ticker: TickerData = {
            ask: Number(obj.askRp ?? 0),
            bid: Number(obj.bidRp ?? 0),
            index: Number(obj.indexRp ?? 0),
            mark: Number(obj.markRp ?? 0),
            last: Number(obj.lastRp ?? 0),
            timestamp: Number(obj.timestamp ?? Date.now() * 1_000_000),
          };

          const symState = symbolStates.get(sym)!;
          const lastTicker = lastTickers.get(sym) ?? null;
          const deltas = lastTicker ? computeDeltas(ticker, lastTicker) : null;

          printTicker(sym, ticker, deltas, symState);
          lastTickers.set(sym, ticker);

          try {
            await evaluate(sym, ticker, symState);
          } catch (err) {
            console.error(`   ✗  Trade error on ${sym}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return;
      }

      // Handle single-symbol market24h updates
      const result = extractTicker(msg);
      if (!result) return;

      const { symbol, ticker } = result;
      const symState = symbolStates.get(symbol)!;
      const lastTicker = lastTickers.get(symbol) ?? null;
      const deltas = lastTicker ? computeDeltas(ticker, lastTicker) : null;

      printTicker(symbol, ticker, deltas, symState);
      lastTickers.set(symbol, ticker);

      try {
        await evaluate(symbol, ticker, symState);
      } catch (err) {
        console.error(`   ✗  Trade error on ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    onReconnect: (delayMs) => {
      console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
      cachedFields = null;
    },
  });

  console.log(`⟐  Auto-trading ${SYMBOLS.join(", ")}  ${DRY_RUN ? "(DRY RUN)" : ""}`);
  for (const sym of SYMBOLS) {
    const s = symbolStates.get(sym)!;
    console.log(`   ${sym}  qty: ${s.config.qty}  leverage: ${s.config.leverage}x  threshold: ${s.config.threshold}  bias: ${s.config.bias}`);
  }
  console.log(`⟐  Connecting to ${WS_URL} …`);
  ws.connect();
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
