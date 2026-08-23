#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-vector-strategy2.ts — 1-hour candlestick slope strategy.
 *
 * Entry logic:
 *   Open Long when slope of last N candle closes > 0 (positive trend)
 *
 * Exit logic:
 *   Close Long when slope of last N candle closes < 0 (negative trend)
 *
 * Usage:
 *   npx tsx scripts/phemex-vector-strategy2.ts                  # live trade PUMPUSDT
 *   npx tsx scripts/phemex-vector-strategy2.ts --dry-run        # signals only, no orders
 *   npx tsx scripts/phemex-vector-strategy2.ts --symbol BTCUSDT
 *   npx tsx scripts/phemex-vector-strategy2.ts --size 1 --leverage 20
 *   npx tsx scripts/phemex-vector-strategy2.ts --lookback 10
 */

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { ReconnectingWs } from "../src/ws-client.js";
import { getArg, hasFlag, findSymbolRow } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM } from "../src/place-limit-order.js";
import { fetchPositions, closePosition, type Position } from "../src/positions.js";
import { publicGet } from "../src/http-client.js";

/* ------------------------------------------------------------------ */
/*  CLI options                                                        */
/* ------------------------------------------------------------------ */

const DRY_RUN = hasFlag("--dry-run");
const SYMBOL = (getArg("--symbol") ?? "PUMPUSDT").toUpperCase();
const SIZE = Number(getArg("--size") ?? 1);
const LEVERAGE = Number(getArg("--leverage") ?? 20);
const LOOKBACK = Number(getArg("--lookback") ?? 2);
const VERBOSE = hasFlag("--verbose");
const CREDENTIAL = getArg("--credential");
const FORCE = hasFlag("--force");
const NO_SHORT = hasFlag("--noShort");
const NO_LONG = hasFlag("--noLong");
const NO_TRADE = hasFlag("--noTrade");
const DECIMALS = Number(getArg("--decimals") ?? 6);
const SCIENTIFIC = hasFlag("--scientific");
const CANDLE_RES = 3600; // 1 hour in seconds

const USAGE = `Usage: npx tsx scripts/phemex-vector-strategy2.ts [options]

1-hour candlestick slope strategy — enter long when slope is positive, exit when negative.

Options:
  --dry-run              Print signals without placing orders
  --symbol <SYMBOL>      Symbol to trade (default: PUMPUSDT)
  --size <N>             Position size (default: 1)
  --leverage <N>         Leverage (default: 20)
  --lookback <N>         Number of candles for slope calculation (default: 2)
  --credential <name>    Credential profile from .credentials.json (e.g. A02, meta, gmail)
  --force                Open regardless of current position
  --noShort              Disable short entries (currently long-only)
  --noLong               Disable long entries
  --noTrade              Disable all entries
  --decimals <N>         Digits below decimal for printed numbers (default: 6)
  --scientific           Use scientific notation for numeric columns
  --verbose              Log extra debug info
  --help                 Show this help`;

if (hasFlag("--help")) {
  console.log(USAGE);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Credentials                                                        */
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

const creds = CREDENTIAL ? loadCredentialProfile(CREDENTIAL) : loadCredentials();
const secretRaw = Buffer.from(creds.PHEMEX_API_SECRET, "base64");

/* ------------------------------------------------------------------ */
/*  Candle & slope                                                     */
/* ------------------------------------------------------------------ */

interface Candle {
  ts: number;     // bucket start (epoch ms, aligned to hour)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

let candles: Candle[] = [];
let currentCandle: Candle | null = null;

function candleKey(ts: number): number {
  return Math.floor(ts / (CANDLE_RES * 1000)) * (CANDLE_RES * 1000);
}

function addTickToCandle(price: number, qty: number, ts: number): void {
  const key = candleKey(ts);
  if (!currentCandle || currentCandle.ts !== key) {
    if (currentCandle) candles.push(currentCandle);
    currentCandle = { ts: key, open: price, high: price, low: price, close: price, volume: qty };
  } else {
    currentCandle.high = Math.max(currentCandle.high, price);
    currentCandle.low = Math.min(currentCandle.low, price);
    currentCandle.close = price;
    currentCandle.volume += qty;
  }
}

/** Linear regression slope of close prices. Positive = bullish. */
function calcSlope(closes: number[]): number {
  const n = closes.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += closes[i];
    sumXY += i * closes[i];
    sumX2 += i * i;
  }
  return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
}

/** Fetch historical 1-hour candles from Phemex. */
async function fetchCandles(sym: string, limit: number): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - CANDLE_RES * limit;
  const query = `symbol=${sym}&resolution=${CANDLE_RES}&limit=${limit}&from=${from}&to=${now}`;
  const resp = await publicGet("/exchange/public/md/v2/kline/list", query);
  const rows = (resp as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const raw = (rows?.rows as unknown[]) ?? [];
  return raw.map((r: unknown) => {
    const row = r as Record<string, unknown>;
    return {
      ts: Number(row[0]) * 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Ticker state                                                       */
/* ------------------------------------------------------------------ */

interface TickerData {
  ask: number;
  bid: number;
  index: number;
  mark: number;
  last: number;
  timestamp: number;
}

let cachedFields: string[] | null = null;
let ticker: TickerData | null = null;
let rowsPrinted = 0;

/* ------------------------------------------------------------------ */
/*  State persistence                                                  */
/* ------------------------------------------------------------------ */

interface SavedPosition {
  symbol: string;
  side: "Buy" | "Sell";
  size: string;
}

interface State {
  savedLong: SavedPosition | null;
}

const STATE_FILE = path.resolve(process.cwd(), `.vector-state-${SYMBOL}.json`);

let savedLong: SavedPosition | null = null;

function loadState(): void {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const saved = JSON.parse(raw) as State;
    savedLong = saved.savedLong ?? null;
    console.log(`[${tsNow()}]  ✓  Loaded state:` +
      (savedLong ? ` saved long ${savedLong.size}` : " no position"));
  } catch (e) {
    console.error(`[${tsNow()}]  ⚠  Failed to load state: ${(e as Error).message}`);
  }
}

function saveState(): void {
  const state: State = { savedLong };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.error(`[${tsNow()}]  ⚠  Failed to save state: ${(e as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  WebSocket                                                           */
/* ------------------------------------------------------------------ */

const WS_URL = "wss://ws.phemex.com";
const isUsdtM = SYMBOL.endsWith("USDT");

function handleUsdtmTicker(msg: Record<string, unknown>): void {
  if (msg.method === "market24h_p.update" && msg.data) {
    const d = msg.data as Record<string, unknown>;
    if (d.symbol !== SYMBOL) return;
    ticker = {
      ask: Number(d.askRp ?? 0),
      bid: Number(d.bidRp ?? 0),
      index: Number(d.indexRp ?? 0),
      mark: Number(d.markRp ?? 0),
      last: Number(d.lastRp ?? 0),
      timestamp: Number(d.timestamp ?? Date.now() * 1_000_000),
    };
    return;
  }

  if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
    if (Array.isArray(msg.fields)) {
      cachedFields = msg.fields as string[];
    }
    if (!cachedFields) return;

    for (const row of msg.data as unknown[][]) {
      if (row.length < 1) continue;
      const sym = String(row[0]);
      if (sym !== SYMBOL) continue;
      const t = findSymbolRow([row], cachedFields, sym);
      if (!t) continue;
      ticker = {
        ask: Number(t.askRp ?? 0),
        bid: Number(t.bidRp ?? 0),
        index: Number(t.indexRp ?? 0),
        mark: Number(t.markRp ?? 0),
        last: Number(t.lastRp ?? 0),
        timestamp: Number(t.timestamp ?? Date.now() * 1_000_000),
      };
      return;
    }
  }
}

function handleCoinmTicker(msg: Record<string, unknown>): void {
  const t = msg.market24h as Record<string, unknown> | undefined;
  if (!t) return;
  if (t.symbol !== SYMBOL) return;
  const PRICE_SCALE = 10_000;
  const last = Number(t.close ?? 0) / PRICE_SCALE;
  ticker = {
    ask: last,
    bid: last,
    index: Number(t.indexPrice ?? 0) / PRICE_SCALE,
    mark: Number(t.markPrice ?? 0) / PRICE_SCALE,
    last,
    timestamp: Number(t.timestamp ?? Date.now() * 1_000_000),
  };
}

function startWebSocket(): ReconnectingWs {
  const ws = new ReconnectingWs(WS_URL, {
    registerSigint: false,
    onOpen: () => {
      if (isUsdtM) {
        ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
      } else {
        ws.send({ method: "market24h.subscribe", params: [SYMBOL], id: 1 });
      }
    },
    onMessage: (msg) => {
      if (isUsdtM) {
        handleUsdtmTicker(msg);
      } else {
        handleCoinmTicker(msg);
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
/*  Order helpers                                                       */
/* ------------------------------------------------------------------ */

async function openLong(): Promise<void> {
  if (DRY_RUN) {
    console.log(`[${tsNow()}]  📗  DRY-RUN — would open LONG ${SYMBOL} size=${SIZE}`);
    return;
  }
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Buy", price: 0, qty: SIZE, posSide: "Long" },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );
  console.log(`[${tsNow()}]  📗  LONG opened — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`);
}

async function closePos(pos: Position): Promise<void> {
  if (DRY_RUN) {
    console.log(`[${tsNow()}]  ✖  DRY-RUN — would close ${pos.side} ${SYMBOL}`);
    return;
  }
  await closePosition(pos, creds.PHEMEX_API_KEY, secretRaw);
  console.log(`[${tsNow()}]  ✖  ${pos.side} closed`);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function tsNow(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${date} ${time}`;
}

function fmt(v: number | null, decimals = DECIMALS): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return SCIENTIFIC ? v.toExponential(decimals) : v.toFixed(decimals);
}

function fmtSign(v: number | null, decimals = DECIMALS): string {
  if (v == null || !Number.isFinite(v)) {
    return SCIENTIFIC
      ? "—".padEnd(decimals + 6)
      : "—".padEnd(3 + decimals);
  }
  const s = SCIENTIFIC ? v.toExponential(decimals) : v.toFixed(decimals);
  return v > 0 ? `+${s}` : v < 0 ? s : ` ${s}`;
}

const r = (s: string, n: number) => " ".repeat(Math.max(0, n - s.length)) + s;

function printHeaders(): void {
  const priceW = SCIENTIFIC ? DECIMALS + 6 : DECIMALS + 2;
  const slopeW = SCIENTIFIC ? DECIMALS + 7 : DECIMALS + 3;
  const h =
    `[YYYY-MM-DD HH:MM:SS] ` +
    r("ask", priceW) + " " +
    r("bid", priceW) + " " +
    r("last", priceW) + " " +
    r("ab", priceW) + " " +
    r("slope", slopeW) + " " +
    r("candles", 7) + " " +
    r("position", 12);
  console.log(h);
  rowsPrinted = 0;
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`\n══ 1h Candlestick Slope Strategy ════════════════════════════════════`);
  console.log(`  Symbol:     ${SYMBOL}`);
  console.log(`  Size:       ${SIZE}`);
  console.log(`  Leverage:   ${LEVERAGE}x`);
  console.log(`  Lookback:   ${LOOKBACK} candles`);
  console.log(`  Mode:       ${DRY_RUN ? "DRY-RUN (no orders)" : "LIVE"}`);
  console.log(`═════════════════════════════════════════════════════════════════════\n`);

  // Set leverage
  if (!DRY_RUN) {
    await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", creds.PHEMEX_API_KEY, secretRaw);
    console.log(`[${tsNow()}]  ✓  Leverage set to ${LEVERAGE}x`);
  }

  // Load persisted state
  loadState();

  // Fetch historical candles
  console.log(`[${tsNow()}]  Fetching ${LOOKBACK + 10} historical 1h candles…`);
  candles = await fetchCandles(SYMBOL, LOOKBACK + 10);
  console.log(`[${tsNow()}]  ✓  Loaded ${candles.length} candles`);

  // console.log(candles)
    

  // Start WebSocket
  const ws = startWebSocket();

  // Wait for first tick
  process.stdout.write(`[${tsNow()}]  Waiting for first tick…`);
  while (!ticker) {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(" connected.\n");

  // Print column headers
  printHeaders();

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log(`\n[${tsNow()}] ⏹  Stopped.`);
    saveState();
    ws.shutdown();
    process.exit(0);
  });

  // Trading loop
  let loopCount = 0;
  for (;;) {
    const started = Date.now();

    if (ticker) {
      const snapBid = ticker.bid;
      const snapAsk = ticker.ask;
      const snapLast = ticker.last;
      const ab = snapAsk - snapBid;

      // Build current candle from ticks
      addTickToCandle(snapLast, 0, Date.now());

      // Get all completed candles + current
      const allCandles = currentCandle ? [...candles, currentCandle] : [...candles];
      const recentCloses = allCandles.slice(-LOOKBACK).map((c) => c.close);
      // console.log(recentCloses)
      const slope = calcSlope(recentCloses);

      // Fetch position status first
      let longSize = 0;
      let longPos: Position | null = null;
      let positionLabel = "— flat";

      try {
        const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);

        for (const pos of positions) {
          if (pos.symbol !== SYMBOL) continue;
          const size = parseFloat(pos.size || "0");
          if (pos.side === "Buy") {
            longSize += size;
            longPos = pos;
          }
        }

        if (longPos && longSize > 0) {
          positionLabel = `📗 LONG ${longSize}`;
        }
      } catch (e) {
        positionLabel = "? error";
      }

      const priceW = SCIENTIFIC ? DECIMALS + 6 : DECIMALS + 2;
      const slopeW = SCIENTIFIC ? DECIMALS + 7 : DECIMALS + 3;
      console.log(
        `[${tsNow()}] ` +
        r(fmt(snapAsk), priceW) + " " +
        r(fmt(snapBid), priceW) + " " +
        r(fmt(snapLast), priceW) + " " +
        r(fmt(ab), priceW) + " " +
        r(fmtSign(slope, 9), slopeW) + " " +
        r(String(allCandles.length), 7) + " " +
        r(positionLabel, 12)
      );
      rowsPrinted++;
      if (process.stdout.rows && rowsPrinted >= process.stdout.rows - 4) {
        printHeaders();
      }

      if (VERBOSE) {
        console.log(`[${tsNow()}]  📊  slope=${fmtSign(slope, 9)}  closes=${recentCloses.map((c) => fmt(c)).join(", ")}`);
      }

      // Exit logic: slope < 0 → close long
      if (longPos && slope < 0 && !NO_TRADE) {
        console.log(`[${tsNow()}]  EXIT LONG — slope=${fmtSign(slope, 9)} < 0`);
        await closePos(longPos);
        savedLong = null;
      }

      // Entry logic: slope > 0 → open long
      if (slope > 0 && !NO_LONG && !NO_TRADE) {
        if (FORCE || longSize === 0) {
          console.log(`[${tsNow()}]  ENTRY LONG — slope=${fmtSign(slope, 9)} > 0`);
          await openLong();
          savedLong = { symbol: SYMBOL, side: "Buy", size: String(SIZE) };
        }
      }
    }

    // Save state every 30 seconds
    loopCount++;
    if (loopCount % 30 === 0) {
      saveState();
    }

    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - elapsed)));
  }
}

main().catch((e) => {
  console.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
