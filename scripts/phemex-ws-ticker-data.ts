#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ws-ticker-data.ts — Subscribe to a Phemex symbol's ticker via
 * WebSocket and stream ask, bid, index, mark, and last prices.
 *
 * Auto-detects USDT-M vs Coin-M and subscribes to the correct channel.
 *
 * Designed for long-term use — one instance per symbol, or extend to
 * manage multiple symbols in a single process.
 *
 * Usage:
 *   npx tsx phemex-ws-ticker-data.ts --symbol XBRUSDT
 *   npx tsx phemex-ws-ticker-data.ts --symbol BTCUSD
 *   npx tsx phemex-ws-ticker-data.ts --symbol XBRUSDT --csv ticker-data.csv
 *   npx tsx phemex-ws-ticker-data.ts --symbol XBRUSDT --json
 */

import fs from "node:fs";
import { ReconnectingWs } from "../src/ws-client.js";
import { getArg, hasFlag, findSymbolRow } from "../src/cli-utils.js";

/* ------------------------------------------------------------------ */
/*  CLI                                                                */
/* ------------------------------------------------------------------ */

const USAGE = `Usage: npx tsx phemex-ws-ticker-data.ts [options]

Subscribe to a Phemex symbol's ticker via WebSocket and stream ask, bid,
index, mark, and last prices.

Options:
  --symbol <SYMBOL>   Symbol to track (default: XBRUSDT)
  --csv <FILE>        Append a CSV row (time,ask,bid,index,mark,last) to FILE
  --json              Output JSON lines to stdout (for downstream consumers)
  --debug             Print raw WebSocket messages for debugging
  --help              Show this help and exit
`;

if (hasFlag("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const SYMBOL = getArg("--symbol") ?? "XBRUSDT";
const CSV_FILE = getArg("--json") ? undefined : getArg("--csv");
const JSON_MODE = hasFlag("--json");
const DEBUG = hasFlag("--debug");
const IS_USDT_M = SYMBOL.endsWith("USDT");
const WS_URL = "wss://ws.phemex.com";

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
/*  CSV logging                                                        */
/* ------------------------------------------------------------------ */

const CSV_HEADER = "time,symbol,ask,bid,index,mark,last\n";

function appendCsvRow(file: string, data: TickerData): void {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fs.appendFileSync(file, CSV_HEADER, "utf8");
  }
  // Timestamp is in nanoseconds — convert to milliseconds for Date
  const tsMs = data.timestamp > 1e12 ? data.timestamp / 1_000_000 : data.timestamp;
  const ts = new Date(tsMs).toISOString().replace("T", " ").replace(/\.\d{3}Z/, "");
  const row = [ts, data.symbol, data.ask, data.bid, data.index, data.mark, data.last]
    .map((v) => (typeof v === "number" ? v.toFixed(8) : v))
    .join(",");
  fs.appendFileSync(file, `${row}\n`, "utf8");
}

/* ------------------------------------------------------------------ */
/*  Display                                                            */
/* ------------------------------------------------------------------ */

let lastPrintedSig = "";

function printTicker(data: TickerData): void {
  const sig = `${data.ask}|${data.bid}|${data.index}|${data.mark}|${data.last}`;
  if (sig === lastPrintedSig) return;
  lastPrintedSig = sig;

  const now = new Date().toLocaleString();
  const ask = data.ask.toFixed(2);
  const bid = data.bid.toFixed(2);
  const index = data.index.toFixed(2);
  const mark = data.mark.toFixed(2);
  const last = data.last.toFixed(2);

  process.stdout.write("\r\x1b[K");
  process.stdout.write(
    `${now}  ${data.symbol}  ask: $${ask}  bid: $${bid}  index: $${index}  mark: $${mark}  last: $${last}`
  );
  console.log();
}

function printJson(data: TickerData): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

/* ------------------------------------------------------------------ */
/*  USDT-M ticker extraction                                           */
/* ------------------------------------------------------------------ */

// Cache the fields array from the first perp_market24h_pack_p.update message.
// Subsequent messages only contain `data` without `fields`.
let cachedFields: string[] | null = null;

function handleUsdtmTicker(msg: Record<string, unknown>): TickerData | null {
  // market24h_p.update — per-symbol ticker
  if (msg.method === "market24h_p.update" && msg.data) {
    const d = msg.data as Record<string, unknown>;
    if (d.symbol !== SYMBOL) return null;
    return {
      symbol: SYMBOL,
      ask: Number(d.askRp ?? 0),
      bid: Number(d.bidRp ?? 0),
      index: Number(d.indexRp ?? 0),
      mark: Number(d.markRp ?? 0),
      last: Number(d.lastRp ?? 0),
      timestamp: Number(d.timestamp ?? Date.now() * 1_000_000),
    };
  }

  // perp_market24h_pack_p.update — columnar batch format
  if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
    // Cache fields from first message, reuse for subsequent messages
    if (Array.isArray(msg.fields)) {
      cachedFields = msg.fields as string[];
    }
    if (!cachedFields) return null;

    const ticker = findSymbolRow(msg.data as unknown[][], cachedFields, SYMBOL);
    if (!ticker) return null;
    return {
      symbol: SYMBOL,
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

/* ------------------------------------------------------------------ */
/*  Coin-M ticker extraction                                           */
/* ------------------------------------------------------------------ */

const PRICE_SCALE = 10_000;

function handleCoinmTicker(msg: Record<string, unknown>): TickerData | null {
  const ticker = msg.market24h as Record<string, unknown> | undefined;
  if (!ticker || ticker.symbol !== SYMBOL) return null;

  // Coin-M ticker fields: close, indexPrice, markPrice (already scaled by 10000)
  // ask/bid are not available in the market24h channel for Coin-M
  const last = Number(ticker.close ?? 0) / PRICE_SCALE;
  const index = Number(ticker.indexPrice ?? 0) / PRICE_SCALE;
  const mark = Number(ticker.markPrice ?? 0) / PRICE_SCALE;

  return {
    symbol: SYMBOL,
    ask: last,  // Coin-M market24h doesn't provide ask — approximate with last
    bid: last,  // Coin-M market24h doesn't provide bid — approximate with last
    index,
    mark,
    last,
    timestamp: Number(ticker.timestamp ?? Date.now() * 1_000_000),
  };
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    if (IS_USDT_M) {
      // Subscribe to all USDT-M 24h tickers (columnar format) — proven to work
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
    } else {
      ws.send({ method: "market24h.subscribe", params: [], id: 1 });
    }
  },
  onMessage: (msg) => {
    if (DEBUG) {
      console.log(JSON.stringify(msg).slice(0, 500));
    }

    const data = IS_USDT_M ? handleUsdtmTicker(msg) : handleCoinmTicker(msg);
    if (!data) return;

    if (JSON_MODE) {
      printJson(data);
    } else {
      printTicker(data);
    }

    if (CSV_FILE) {
      appendCsvRow(CSV_FILE, data);
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
    lastPrintedSig = "";
    cachedFields = null; // Re-cache fields from first message after reconnect
  },
});

console.log(`⟐  Connecting to ${WS_URL} (${IS_USDT_M ? "USDT-M" : "Coin-M"}) — tracking ${SYMBOL} …`);
ws.connect();
