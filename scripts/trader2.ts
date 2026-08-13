#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * trader.ts — Config-driven multi-symbol trader.
 *
 * Combines ticker polling, index-based entry, and ask/bid-based exit into a
 * single process. Each symbol's parameters (threshold, size, hedge, profit)
 * come from a JSON config passed via --config or --configfile.
 *
 * Usage:
 *   npx tsx scripts/trader.ts --configfile config/config.json
 *   npx tsx scripts/trader.ts --config '{
 *     "XBRUSDT": { "threshold": 0.5, "size": 0.01, "hedge": true, "profit": 0 },
 *     "BTCUSDT": { "threshold": 50, "size": 0.001, "hedge": true, "profit": 35 }
 *   }'
 */

import fs from "node:fs";
import { resolve } from "node:path";
import { ReconnectingWs } from "../src/ws-client.js";
import { getArg, findSymbolRow } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM } from "../src/place-limit-order.js";
import { fetchPositions, closePosition, type Position } from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SymbolConfig {
  threshold?: number;
  longThreshold?: number;
  shortThreshold?: number;
  size?: number;
  leverage?: number;
  hedge?: boolean;
  profit?: number;
}

type Config = Record<string, SymbolConfig>;

/* ------------------------------------------------------------------ */
/*  Config & credentials                                               */
/* ------------------------------------------------------------------ */

const rawConfig = getArg("--config");
const configFile = getArg("--configfile");
if (!rawConfig && !configFile) {
  console.error("Usage: npx tsx scripts/trader.ts --configfile config/config.json");
  console.error("       npx tsx scripts/trader.ts --config '<JSON>'");
  process.exit(1);
}

const config: Config = configFile
  ? JSON.parse(fs.readFileSync(resolve(process.cwd(), configFile), "utf8"))
  : JSON.parse(rawConfig!);
const symbols = Object.keys(config);
if (symbols.length === 0) {
  console.error("No symbols in config");
  process.exit(1);
}

const creds = loadCredentials();
const secretRaw = Buffer.from(creds.PHEMEX_API_SECRET, "base64");
const leverageSet = new Set<string>();

/* ------------------------------------------------------------------ */
/*  WebSocket                                                          */
/* ------------------------------------------------------------------ */

const WS_URL = "wss://ws.phemex.com";
let cachedFields: string[] | null = null;

interface TickerData {
  symbol: string;
  ask: number;
  bid: number;
  index: number;
  mark: number;
  last: number;
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/*  WebSocket ticker extraction                                        */
/* ------------------------------------------------------------------ */

function handleUsdtmTicker(msg: Record<string, unknown>): TickerData[] {
  const results: TickerData[] = [];

  if (msg.method === "market24h_p.update" && msg.data) {
    const d = msg.data as Record<string, unknown>;
    const sym = String(d.symbol ?? "");
    if (!config[sym]) return results;
    results.push({
      symbol: sym,
      ask: Number(d.askRp ?? 0),
      bid: Number(d.bidRp ?? 0),
      index: Number(d.indexRp ?? 0),
      mark: Number(d.markRp ?? 0),
      last: Number(d.lastRp ?? 0),
      timestamp: Number(d.timestamp ?? Date.now() * 1_000_000),
    });
    return results;
  }

  if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
    if (Array.isArray(msg.fields)) {
      cachedFields = msg.fields as string[];
    }
    if (!cachedFields) return results;

    for (const row of msg.data as unknown[][]) {
      if (row.length < 1) continue;
      const sym = String(row[0]);
      if (!config[sym]) continue;
      const ticker = findSymbolRow([row], cachedFields, sym);
      if (!ticker) continue;
      results.push({
        symbol: sym,
        ask: Number(ticker.askRp ?? 0),
        bid: Number(ticker.bidRp ?? 0),
        index: Number(ticker.indexRp ?? 0),
        mark: Number(ticker.markRp ?? 0),
        last: Number(ticker.lastRp ?? 0),
        timestamp: Number(ticker.timestamp ?? Date.now() * 1_000_000),
      });
    }
    return results;
  }

  return results;
}

const PRICE_SCALE = 10_000;

function handleCoinmTicker(msg: Record<string, unknown>): TickerData[] {
  const results: TickerData[] = [];
  const ticker = msg.market24h as Record<string, unknown> | undefined;
  if (!ticker) return results;
  const sym = String(ticker.symbol ?? "");
  if (!config[sym]) return results;

  const last = Number(ticker.close ?? 0) / PRICE_SCALE;
  const index = Number(ticker.indexPrice ?? 0) / PRICE_SCALE;
  const mark = Number(ticker.markPrice ?? 0) / PRICE_SCALE;

  results.push({
    symbol: sym,
    ask: last,
    bid: last,
    index,
    mark,
    last,
    timestamp: Number(ticker.timestamp ?? Date.now() * 1_000_000),
  });
  return results;
}

function persistTickerFromWs(d: TickerData): void {
  fs.writeFileSync(valuePath(d.symbol, "ask.txt"), fmtExact(d.ask), "utf8");
  fs.writeFileSync(valuePath(d.symbol, "bid.txt"), fmtExact(d.bid), "utf8");
  fs.writeFileSync(valuePath(d.symbol, "index.txt"), fmtExact(d.index), "utf8");
  fs.writeFileSync(valuePath(d.symbol, "last.txt"), fmtExact(d.last), "utf8");
  fs.writeFileSync(valuePath(d.symbol, "mark.txt"), fmtExact(d.mark), "utf8");
  fs.writeFileSync(valuePath(d.symbol, "indexLast.txt"),
    fmtExact(d.index - d.last), "utf8");
  fs.writeFileSync(valuePath(d.symbol, "markLast.txt"),
    fmtExact(d.mark - d.last), "utf8");
}

function startWebSocket(): ReconnectingWs {
  const isUsdtM = symbols.every((s) => s.endsWith("USDT"));

  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      if (isUsdtM) {
        ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
      } else {
        ws.send({ method: "market24h.subscribe", params: [], id: 1 });
      }
    },
    onMessage: (msg) => {
      const tickers = isUsdtM ? handleUsdtmTicker(msg) : handleCoinmTicker(msg);
      for (const d of tickers) {
        persistTickerFromWs(d);
      }
    },
    onReconnect: () => {
      cachedFields = null;
    },
  });

  ws.connect();
  return ws;
}

/* ------------------------------------------------------------------ */
/*  Per-symbol helpers                                                 */
/* ------------------------------------------------------------------ */

function cfg(symbol: string): Required<SymbolConfig> {
  const c = config[symbol] ?? {};
  return {
    threshold:       c.threshold ?? 0.2,
    longThreshold:   c.longThreshold ?? c.threshold ?? 0.2,
    shortThreshold:  c.shortThreshold ?? c.threshold ?? 0.2,
    size:            c.size ?? 0.01,
    leverage:        c.leverage ?? 100,
    hedge:           c.hedge ?? false,
    profit:          c.profit ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/*  Value files (data/${symbol}-*.txt)                                 */
/* ------------------------------------------------------------------ */

const DATA_DIR = resolve(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function valuePath(symbol: string, name: string): string {
  return resolve(DATA_DIR, `${symbol}-${name}`);
}

function fmtExact(v: unknown): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Math.round(n * 1e8) / 1e8);
}

/* ------------------------------------------------------------------ */
/*  Positions                                                          */
/* ------------------------------------------------------------------ */

async function symbolPositions(symbol: string): Promise<{ longSize: number; shortSize: number }> {
  const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
  let longSize = 0;
  let shortSize = 0;
  for (const p of positions) {
    if (p.symbol !== symbol) continue;
    const size = parseFloat(p.size || "0");
    if (p.side === "Buy") longSize += size;
    else if (p.side === "Sell") shortSize += size;
  }
  return { longSize, shortSize };
}

/* ------------------------------------------------------------------ */
/*  Open orders                                                        */
/* ------------------------------------------------------------------ */

const pending = new Map<string, number>(); // symbol → pending qty

async function openOrder(
  side: "Buy" | "Sell",
  posSide: "Long" | "Short",
  symbol: string,
  qty: number,
): Promise<void> {
  const s = cfg(symbol);
  await setLeverageUsdtM(symbol, s.leverage, posSide, creds.PHEMEX_API_KEY, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol, side, price: 0, qty, posSide },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );
  console.log(`[${new Date().toLocaleTimeString()}]  ✓  ${symbol} ${posSide} opened — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`);
  pending.set(symbol, (pending.get(symbol) ?? 0) + qty);
}

async function openLong(symbol: string, qty: number): Promise<void> {
  return openOrder("Buy", "Long", symbol, qty);
}

async function openShort(symbol: string, qty: number): Promise<void> {
  return openOrder("Sell", "Short", symbol, qty);
}

/* ------------------------------------------------------------------ */
/*  Close position                                                     */
/* ------------------------------------------------------------------ */

async function closePos(pos: Position): Promise<void> {
  return closePosition(pos, creds.PHEMEX_API_KEY, secretRaw);
}

/* ------------------------------------------------------------------ */
/*  Index trading                                                      */
/* ------------------------------------------------------------------ */

async function indexTrade(
  symbol: string,
  longSize: number,
  shortSize: number,
): Promise<void> {
  const s = cfg(symbol);
  if (!leverageSet.has(symbol)) {
    await setLeverageUsdtM(symbol, s.leverage, "Long", creds.PHEMEX_API_KEY, secretRaw);
    leverageSet.add(symbol);
  }

  let signal: number;
  try {
    signal = parseFloat(fs.readFileSync(valuePath(symbol, "indexLast.txt"), "utf8").trim());
  } catch {
    return;
  }
  if (!Number.isFinite(signal)) return;

  const pendingQ = pending.get(symbol) ?? 0;

  if (signal >= s.longThreshold) {
    if (!s.hedge && shortSize > 0) return;
    if (longSize + pendingQ >= s.size) return;
    const qty = Math.round((s.size - longSize - pendingQ) * 10000) / 10000;
    if (qty > 0) await openLong(symbol, qty);
  } else if (signal <= -s.shortThreshold) {
    if (!s.hedge && longSize > 0) return;
    if (shortSize + pendingQ >= s.size) return;
    const qty = Math.round((s.size - shortSize - pendingQ) * 10000) / 10000;
    if (qty > 0) await openShort(symbol, qty);
  }
}

/* ------------------------------------------------------------------ */
/*  Ask/bid closing                                                    */
/* ------------------------------------------------------------------ */

function readVal(file: string): number | null {
  try {
    const v = parseFloat(fs.readFileSync(file, "utf8").trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function askBidClose(
  positions: Position[],
  symbol: string,
): Promise<void> {
  const s = cfg(symbol);
  const ask = readVal(valuePath(symbol, "ask.txt"));
  const bid = readVal(valuePath(symbol, "bid.txt"));

  for (const pos of positions) {
    if (pos.symbol !== symbol) continue;
    const entry = parseFloat(pos.avgEntryPriceRp || "0");

    if (pos.side === "Buy" && bid !== null && bid >= entry + s.profit) {
      await closePos(pos);
    } else if (pos.side === "Sell" && ask !== null && ask <= entry - s.profit) {
      await closePos(pos);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`[${new Date().toLocaleTimeString()}] ═ Trader — ${symbols.join(", ")} ══════════════════`);

  startWebSocket();

  process.on("SIGINT", () => {
    console.log(`\n[${new Date().toLocaleTimeString()}] ⏹  Stopped.`);
    process.exit(0);
  });

  for (;;) {
    const started = Date.now();
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);

      for (const symbol of symbols) {
        try {
          const pendingQ = pending.get(symbol) ?? 0;
          let longSize = 0;
          let shortSize = 0;
          for (const p of positions) {
            if (p.symbol !== symbol) continue;
            const size = parseFloat(p.size || "0");
            if (p.side === "Buy") longSize += size;
            else if (p.side === "Sell") shortSize += size;
          }

          if (longSize >= pendingQ) pending.delete(symbol);
          if (shortSize >= pendingQ) pending.delete(symbol);

          await indexTrade(symbol, longSize, shortSize);
          await askBidClose(positions, symbol);
        } catch {
          // per-symbol error — continue with others
        }
      }
    } catch {
      // cycle error — continue
    }
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - elapsed)));
  }
}

main().catch((e) => {
  console.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
