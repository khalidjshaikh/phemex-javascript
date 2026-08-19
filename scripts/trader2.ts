#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * trader.ts — Config-driven multi-symbol trader.
 *
 * Combines ticker polling, index-based entry, and ask/bid-based exit into a
 * single process. Each symbol's parameters (threshold, size, hedge, profit)
 * come from a JSON5 config passed via --config or --configfile.
 *
 * Usage:
 *   npx tsx scripts/trader.ts --configfile config/config.json5
 *   npx tsx scripts/trader.ts --config '{
 *     XBRUSDT: { threshold: 0.5, size: 0.01, hedge: true, profit: 0 },
 *     BTCUSDT: { threshold: 50, size: 0.001, hedge: true, profit: 35 }
 *   }'
 */

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { ReconnectingWs } from "../src/ws-client.js";
import { getArg, hasFlag, findSymbolRow } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM } from "../src/place-limit-order.js";
import { fetchPositions, closePosition, type Position } from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SymbolConfig {
  threshold?: number;
  bias?: number;
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

function loadCredentialProfile(name: string): { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string } {
  const credsPath = path.resolve(process.cwd(), ".credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error(`✗  Missing ${credsPath}`);
    process.exit(1);
  }
  const all = JSON5.parse(fs.readFileSync(credsPath, "utf8")) as Record<string, { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string }>;
  if (!all[name]) {
    console.error(`✗  Credential profile "${name}" not found in .credentials.json (available: ${Object.keys(all).join(", ")})`);
    process.exit(1);
  }
  return all[name];
}

const rawConfig = getArg("--config");
const configFile = getArg("--configfile");
const credential = getArg("--credential");
const signalExit = hasFlag("--signalExit");
const verbose = hasFlag("--verbose");
if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`Usage: npx tsx scripts/trader.ts --configfile config/config.json5
       npx tsx scripts/trader.ts --config '<JSON>'

Options:
  --config <JSON>       Inline JSON5 config
  --configfile <path>   Config file path (JSON5)
  --credential <name>   Credential profile from .credentials.json (e.g. A02, meta, gmail)
  --signalExit          Exit positions when signal reverses
  --verbose             Log signals
  --help, -h            Show this help message`);
  process.exit(0);
}
if (!rawConfig && !configFile) {
  console.error("Error: --config or --configfile required");
  console.error("Run with --help for usage information");
  process.exit(1);
}

const config: Config = configFile
  ? JSON5.parse(fs.readFileSync(path.resolve(process.cwd(), configFile), "utf8"))
  : JSON5.parse(rawConfig!);
const symbols = Object.keys(config);
if (symbols.length === 0) {
  console.error("No symbols in config");
  process.exit(1);
}

const creds = credential ? loadCredentialProfile(credential) : loadCredentials();
const secretRaw = Buffer.from(creds.PHEMEX_API_SECRET, "base64");

/* ------------------------------------------------------------------ */
/*  WebSocket                                                          */
/* ------------------------------------------------------------------ */

const WS_URL = "wss://ws.phemex.com";
let cachedFields: string[] | null = null;
const tickerCache = new Map<string, TickerData>();

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
        tickerCache.set(d.symbol, d);
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
    bias:            c.bias ?? 0,
    longThreshold:   c.longThreshold ?? c.threshold ?? 0.2,
    shortThreshold:  c.shortThreshold ?? c.threshold ?? 0.2,
    size:            c.size ?? 0.01,
    leverage:        c.leverage ?? 100,
    hedge:           c.hedge ?? false,
    profit:          c.profit ?? 0,
  };
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
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol, side, price: 0, qty, posSide },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );
  console.log(`[${new Date().toLocaleTimeString()}]  ✓  ${symbol} ${posSide} opened — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`);
  if (result.ordStatus === "New" || result.ordStatus === "Filled") {
    pending.set(symbol, (pending.get(symbol) ?? 0) + qty);
  }
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
  const ticker = tickerCache.get(symbol);
  if (!ticker) return;

  const s = cfg(symbol);
  const signal = ticker.index - ticker.last;

  const pendingQ = pending.get(symbol) ?? 0;

  if (verbose) {
    const adjusted = signal + s.bias;
    console.log(`[${new Date().toLocaleTimeString()}]  📊  ${symbol} signal=${signal} bias=${s.bias} adjusted=${adjusted} longThresh=${s.longThreshold} shortThresh=${-s.shortThreshold}`);
  }

  if (signal + s.bias >= s.longThreshold) {
    if (!s.hedge && shortSize > 0) return;
    if (longSize + pendingQ >= s.size) return;
    const qty = Math.round((s.size - longSize - pendingQ) * 10000) / 10000;
    if (qty > 0) await openLong(symbol, qty);
  } else if (signal + s.bias <= -s.shortThreshold) {
    if (!s.hedge && longSize > 0) return;
    if (shortSize + pendingQ >= s.size) return;
    const qty = Math.round((s.size - shortSize - pendingQ) * 10000) / 10000;
    if (qty > 0) await openShort(symbol, qty);
  }
}

/* ------------------------------------------------------------------ */
/*  Ask/bid closing                                                    */
/* ------------------------------------------------------------------ */

async function askBidClose(
  positions: Position[],
  symbol: string,
): Promise<void> {
  const ticker = tickerCache.get(symbol);
  if (!ticker) return;

  const s = cfg(symbol);

  for (const pos of positions) {
    if (pos.symbol !== symbol) continue;
    const entry = parseFloat(pos.avgEntryPriceRp || "0");

    if (pos.side === "Buy" && ticker.bid >= entry + s.profit) {
      console.log(`[${new Date().toLocaleTimeString()}]  ✗  ${symbol} Long closed — bid ${ticker.bid} >= entry ${entry} + ${s.profit}`);
      await closePos(pos);
    } else if (pos.side === "Sell" && ticker.ask <= entry - s.profit) {
      console.log(`[${new Date().toLocaleTimeString()}]  ✗  ${symbol} Short closed — ask ${ticker.ask} <= entry ${entry} - ${s.profit}`);
      await closePos(pos);
    }
  }
}

async function signalClose(
  positions: Position[],
  symbol: string,
): Promise<void> {
  if (!signalExit) return;

  const ticker = tickerCache.get(symbol);
  if (!ticker) return;

  const s = cfg(symbol);
  const signal = ticker.index - ticker.last;
  const adjusted = signal + s.bias;

  for (const pos of positions) {
    if (pos.symbol !== symbol) continue;

    if (pos.side === "Buy" && adjusted < 0) {
      console.log(`[${new Date().toLocaleTimeString()}]  ✗  ${symbol} Long closed — signal ${adjusted} < 0`);
      await closePos(pos);
    } else if (pos.side === "Sell" && adjusted > 0) {
      console.log(`[${new Date().toLocaleTimeString()}]  ✗  ${symbol} Short closed — signal ${adjusted} > 0`);
      await closePos(pos);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`[${new Date().toLocaleTimeString()}] ═ Trader — ${symbols.join(", ")} ══════════════════`);
  const rows = Object.keys(config).map((sym) => {
    const s = cfg(sym);
    return { sym, ...s };
  });
  const cols = ["threshold", "bias", "size", "leverage", "profit"] as const;
  const widths = cols.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length)));
  const symWidth = Math.max(...rows.map((r) => r.sym.length));
  for (const r of rows) {
    const vals = cols.map((k, i) => `${k}=${String(r[k]).padStart(widths[i])}`);
    console.log(`${r.sym.padEnd(symWidth)}: ${vals.join(", ")}`);
  }

  startWebSocket();

  for (const symbol of symbols) {
    const s = cfg(symbol);
    await setLeverageUsdtM(symbol, s.leverage, "Long", creds.PHEMEX_API_KEY, secretRaw);
    await setLeverageUsdtM(symbol, s.leverage, "Short", creds.PHEMEX_API_KEY, secretRaw);
    console.log(`[${new Date().toLocaleTimeString()}]  ✓  ${symbol} leverage set to ${s.leverage}x`);
  }

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

          if (longSize + shortSize >= pendingQ) pending.delete(symbol);

          await indexTrade(symbol, longSize, shortSize);
          await askBidClose(positions, symbol);
          await signalClose(positions, symbol);
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
