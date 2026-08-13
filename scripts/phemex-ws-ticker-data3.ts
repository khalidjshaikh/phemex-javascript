#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ws-ticker-data.ts — Subscribe to one or more Phemex symbols'
 * tickers via a single WebSocket and stream ask, bid, index, mark, last.
 *
 * A single WS connection already receives ALL USDT-M (or Coin-M) tickers
 * in batch — this script filters to the symbols you care about.
 *
 * Usage:
 *   npx tsx phemex-ws-ticker-data.ts --symbols ETHUSDT,XBRUSDT,XTIUSDT,BTCUSDT
 *   npx tsx phemex-ws-ticker-data.ts --symbol BTCUSDT
 *   npx tsx phemex-ws-ticker-data.ts --symbols XBRUSDT,XTIUSDT --csv ticker-data.csv
 *   npx tsx phemex-ws-ticker-data.ts --symbols XBRUSDT,XTIUSDT --json
 */

import fs from "node:fs";
import { ReconnectingWs } from "../src/ws-client.js";
import { getArg, hasFlag, findSymbolRow } from "../src/cli-utils.js";

/* ------------------------------------------------------------------ */
/*  CLI                                                                */
/* ------------------------------------------------------------------ */

const USAGE = `Usage: npx tsx phemex-ws-ticker-data.ts [options]

Subscribe to one or more Phemex symbols' tickers via a single WebSocket
and stream ask, bid, index, mark, and last prices.

Options:
  --symbols <A,B,C>   Comma-separated symbols to track (default: XBRUSDT)
  --symbol <SYMBOL>   Single symbol shorthand (alias for --symbols)
  --csv <FILE>        Append a CSV row per symbol per tick to FILE
  --json              Output one JSON line per symbol per update
  --debug             Print raw WebSocket messages for debugging
  --help              Show this help and exit
`;

if (hasFlag("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const symbolsRaw = getArg("--symbols") ?? getArg("--symbol") ?? "XBRUSDT";
const SYMBOLS = new Set(symbolsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
const CSV_FILE = getArg("--json") ? undefined : getArg("--csv");
const JSON_MODE = hasFlag("--json");
const DEBUG = hasFlag("--debug");
const WS_URL = "wss://ws.phemex.com";

const IS_USDT_M = [...SYMBOLS].every((s) => s.endsWith("USDT"));

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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
/*  Per-symbol dedup                                                   */
/* ------------------------------------------------------------------ */

const lastSig = new Map<string, string>();

function dataChanged(d: TickerData): boolean {
  const sig = `${d.ask}|${d.bid}|${d.index}|${d.mark}|${d.last}`;
  const prev = lastSig.get(d.symbol);
  if (sig === prev) return false;
  lastSig.set(d.symbol, sig);
  return true;
}

/* ------------------------------------------------------------------ */
/*  CSV logging                                                        */
/* ------------------------------------------------------------------ */

const CSV_HEADER = "time,symbol,ask,bid,index,mark,last\n";

function appendCsvRow(file: string, d: TickerData): void {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fs.appendFileSync(file, CSV_HEADER, "utf8");
  }
  const tsMs = d.timestamp > 1e12 ? d.timestamp / 1_000_000 : d.timestamp;
  const ts = new Date(tsMs).toISOString().replace("T", " ").replace(/\.\d{3}Z/, "");
  const row = [ts, d.symbol, d.ask, d.bid, d.index, d.mark, d.last]
    .map((v) => (typeof v === "number" ? v.toFixed(8) : v))
    .join(",");
  fs.appendFileSync(file, `${row}\n`, "utf8");
}

/* ------------------------------------------------------------------ */
/*  Display                                                            */
/* ------------------------------------------------------------------ */

function printTicker(data: TickerData): void {
  if (!dataChanged(data)) return;
  const now = new Date().toLocaleString();
  console.log(
    `${now}  ${data.symbol}  ask: $${data.ask.toFixed(2)}  bid: $${data.bid.toFixed(2)}  index: $${data.index.toFixed(2)}  mark: $${data.mark.toFixed(2)}  last: $${data.last.toFixed(2)}`
  );
}

function printJson(data: TickerData): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function emit(d: TickerData): void {
  if (JSON_MODE) {
    printJson(d);
  } else {
    printTicker(d);
  }
  if (CSV_FILE) {
    appendCsvRow(CSV_FILE, d);
  }
}

/* ------------------------------------------------------------------ */
/*  USDT-M ticker extraction                                           */
/* ------------------------------------------------------------------ */

let cachedFields: string[] | null = null;

function handleUsdtmTicker(msg: Record<string, unknown>): TickerData[] {
  const results: TickerData[] = [];

  if (msg.method === "market24h_p.update" && msg.data) {
    const d = msg.data as Record<string, unknown>;
    const sym = String(d.symbol ?? "");
    if (!SYMBOLS.has(sym)) return results;
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
      if (!SYMBOLS.has(sym)) continue;
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

/* ------------------------------------------------------------------ */
/*  Coin-M ticker extraction                                           */
/* ------------------------------------------------------------------ */

const PRICE_SCALE = 10_000;

function handleCoinmTicker(msg: Record<string, unknown>): TickerData[] {
  const results: TickerData[] = [];
  const ticker = msg.market24h as Record<string, unknown> | undefined;
  if (!ticker) return results;
  const sym = String(ticker.symbol ?? "");
  if (!SYMBOLS.has(sym)) return results;

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

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    if (IS_USDT_M) {
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
    } else {
      ws.send({ method: "market24h.subscribe", params: [], id: 1 });
    }
  },
  onMessage: (msg) => {
    if (DEBUG) {
      console.log(JSON.stringify(msg).slice(0, 500));
    }

    const tickers = IS_USDT_M ? handleUsdtmTicker(msg) : handleCoinmTicker(msg);
    for (const d of tickers) {
      emit(d);
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
    lastSig.clear();
    cachedFields = null;
  },
});

const type = IS_USDT_M ? "USDT-M" : "Coin-M";
const list = [...SYMBOLS].join(", ");
console.log(`⟐  Connecting to ${WS_URL} (${type}) — tracking ${list} …`);
ws.connect();
