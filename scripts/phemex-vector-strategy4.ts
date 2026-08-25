#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-vector-strategy.ts — Vector (I-L) trading strategy.
 *
 * Entry logic:
 *   Open Long  when vector (Index − Last) > +threshold (default +0.003)
 *   Open Short when vector (Index − Last) < −threshold (default −0.003)
 *
 * Exit logic:
 *   Close Long  when delta bid  < 0  (current bid − previous bid)
 *   Close Short when delta ask  > 0  (current ask − previous ask)
 *
 * Usage:
 *   npx tsx scripts/phemex-vector-strategy.ts                  # live trade XRPUSDT
 *   npx tsx scripts/phemex-vector-strategy.ts --dry-run        # signals only, no orders
 *   npx tsx scripts/phemex-vector-strategy.ts --symbol BTCUSDT
 *   npx tsx scripts/phemex-vector-strategy.ts --size 0.01 --leverage 50
 *   npx tsx scripts/phemex-vector-strategy.ts --noLong
 *   npx tsx scripts/phemex-vector-strategy.ts --deltaLastThreshold 0.000010
 *
 * Hedge mode: both long and short can be held simultaneously.
 */

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { ReconnectingWs } from "../src/ws-client.js";
import { getArg, hasFlag, findSymbolRow } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM } from "../src/place-limit-order.js";
import { fetchPositions, closePosition, type Position } from "../src/positions.js";
import { createCanvas, clear, set, line, frame, getTerminalSize } from "termdot";

/* ------------------------------------------------------------------ */
/*  CLI options                                                        */
/* ------------------------------------------------------------------ */

const DRY_RUN = hasFlag("--dry-run");
const SYMBOL = (getArg("--symbol") ?? "XRPUSDT").toUpperCase();
const SIZE = Number(getArg("--size") ?? 0.01);
const LEVERAGE = Number(getArg("--leverage") ?? 50);
const THRESHOLD = Number(getArg("--threshold") ?? 0.003);
const VERBOSE = hasFlag("--verbose");
const CREDENTIAL = getArg("--credential");
const FORCE = hasFlag("--force");
const NO_SHORT = hasFlag("--noShort");
const NO_LONG = hasFlag("--noLong");
const EXIT_BID_THRESHOLD = Number(getArg("--exitBidThreshold") ?? 0);
const EXIT_ASK_THRESHOLD = Number(getArg("--exitAskThreshold") ?? 0);
const EXIT_SIGMA_BID_THRESHOLD = Number(getArg("--exitSigmaBidThreshold") ?? 0);
const EXIT_SIGMA_ASK_THRESHOLD = Number(getArg("--exitSigmaAskThreshold") ?? 0);
const NO_EXIT_BID = hasFlag("--noExitBid");
const NO_EXIT_ASK = hasFlag("--noExitAsk");
const NO_TRADE = hasFlag("--noTrade");
const DECIMALS = Number(getArg("--decimals") ?? 6);
const DELTA_LAST_THRESHOLD = Number(getArg("--deltaLastThreshold") ?? 0);
const NO_VECTOR = hasFlag("--noVector");
const NO_IL = hasFlag("--noIL");
const CD_LONG = Number(getArg("--cdLong") ?? 60);
const CD_SHORT = Number(getArg("--cdShort") ?? 60);
const PROFIT_EXIT = hasFlag("--profitExit");
const PROFIT = Number(getArg("--profit") ?? 0);
const SCIENTIFIC = hasFlag("--scientific");
const HIDE_COLS = new Set((getArg("--hideCols") ?? "").split(",").filter(Boolean).map(s => s.trim().toLowerCase()));
const CLOSE_LONG = hasFlag("--closeLong");
const CLOSE_SHORT = hasFlag("--closeShort");

// Chart options
const CHART = hasFlag("--chart");
const SUPPRESS_TICKER = hasFlag("--suppressTickerOutput");

// Slope-based strategy options
const SLOPE_MODE = hasFlag("--slope");
const SLOPE_N = Number(getArg("--slopeN") ?? 10);
const SLOPE_THRESHOLD = Number(getArg("--slopeThreshold") ?? 0);
const OPPOSING_THRESHOLD = Number(getArg("--opposingThreshold") ?? 1e-6);
const NO_OPPOSING_EXIT = hasFlag("--noOpposingExit");
const NO_ZERO_SLOPE_EXIT = hasFlag("--noZeroSlopeExit");
const SLOPE_HOLD_THRESHOLD = Number(getArg("--slopeHoldThreshold") ?? 0);

const USAGE = `Usage: npx tsx scripts/phemex-vector-strategy.ts [options]

Vector (I-L) strategy — enter when Index−Last exceeds threshold, exit on bid/ask reversal.

Options:
  --dry-run              Print signals without placing orders
  --symbol <SYMBOL>      Symbol to trade (default: XRPUSDT)
  --size <N>             Position size in base asset (default: 0.01)
  --leverage <N>         Leverage (default: 50)
  --threshold <N>        Vector threshold for entry (default: 0.003)
  --deltaLastThreshold <N>  Delta last threshold for entry (default: 0)
  --noVector             Ignore vector threshold, use only deltaLastThreshold
  --credential <name>    Credential profile from .credentials.json (e.g. A02, meta, gmail)
  --force                Open regardless of current position
  --noShort              Disable short entries
  --noLong               Disable long entries
  --noTrade              Disable all entries (long and short)
  --closeLong            Close existing long position and exit
  --closeShort           Close existing short position and exit
  --exitBidThreshold <N> Exit long when ΣΔbid- <= N (default: 0)
  --exitAskThreshold <N> Exit short when ΣΔask+ >= N (default: 0)
  --noExitBid            Disable cumulative bid exit (use only exitSigmaBidThreshold)
  --noExitAsk            Disable cumulative ask exit (use only exitSigmaAskThreshold)
  --exitSigmaBidThreshold <N> Exit long when ΣΔbid-/h <= N (default: 0)
  --exitSigmaAskThreshold <N> Exit short when ΣΔask+/h >= N (default: 0)
  --cdLong <N>           Long cooldown in seconds (default: 60)
  --cdShort <N>          Short cooldown in seconds (default: 60)
  --profitExit           Exit long when bid >= entry + profit
  --profit <N>           Profit threshold for profitExit (default: 0)
  --decimals <N>         Digits below decimal for printed numbers (default: 6)
  --scientific           Use scientific notation for numeric columns
  --hideCols <list>      Comma-separated columns to hide: ask, bid, ab, deltaAsk, deltaBid
  --slope                Enable slope-based strategy
  --slopeN <N>           Number of points for slope calculation (default: 10)
  --slopeThreshold <N>   Minimum slope magnitude for entry (default: 0)
  --opposingThreshold <N> Opposing direction threshold for exit (default: 1e-6)
  --noOpposingExit       Disable opposing threshold exits
  --noZeroSlopeExit     Disable slope inflection exits
  --slopeHoldThreshold <N> Hold position when |slope| >= threshold (disables take-profit exits)
  --chart                 Enable braille price chart on right side
  --suppressTickerOutput  Suppress ticker row output (chart only)
  --verbose              Log every tick's vector and deltas
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
let prevBid: number | null = null;
let prevAsk: number | null = null;
let prevLast: number | null = null;
let longCooldown = 0;
let shortCooldown = 0;
let rowsPrinted = 0;
let changeTimestamps: number[] = [];
let deltaLastWindow: { ts: number; val: number }[] = [];
let deltaAskWindow: { ts: number; val: number }[] = [];
let deltaBidWindow: { ts: number; val: number }[] = [];
let changeTimestampsHour: number[] = [];
let deltaLastWindowHour: { ts: number; val: number }[] = [];
let deltaAskWindowHour: { ts: number; val: number }[] = [];
let deltaBidWindowHour: { ts: number; val: number }[] = [];
let savedLong: SavedPosition | null = null;
let savedShort: SavedPosition | null = null;
let longOpensHour: number[] = [];
let shortOpensHour: number[] = [];
let deltaLastPosCountHour = 0;
let deltaLastNegCountHour = 0;
let cumulativeDeltaBidNeg = 0;
let cumulativeDeltaAskPos = 0;

// Slope-based strategy state
let priceBuffer: { ts: number; last: number }[] = [];
let entryAskForLong: number | null = null;
let entryBidForShort: number | null = null;
let previousSlope = 0;

// Chart state
let chartCanvas: ReturnType<typeof createCanvas> | null = null;
let priceHistory: number[] = [];
let chartPixelHeight = 0;
let chartPixelWidth = 0;
let lastChartOutput = "";
type TradeEventType = "OPEN_LONG" | "OPEN_SHORT" | "EXIT_LONG" | "EXIT_SHORT";
let tradeEvents: { type: TradeEventType; price: number; tick: number }[] = [];
let tickCounter = 0;

/* ------------------------------------------------------------------ */
/*  State persistence                                                  */
/* ------------------------------------------------------------------ */

interface SavedPosition {
  symbol: string;
  side: "Buy" | "Sell";
  size: string;
}

interface State {
  changeTimestamps: number[];
  deltaLastWindow: { ts: number; val: number }[];
  deltaAskWindow: { ts: number; val: number }[];
  deltaBidWindow: { ts: number; val: number }[];
  changeTimestampsHour: number[];
  deltaLastWindowHour: { ts: number; val: number }[];
  deltaAskWindowHour: { ts: number; val: number }[];
  deltaBidWindowHour: { ts: number; val: number }[];
  savedLong: SavedPosition | null;
  savedShort: SavedPosition | null;
  longOpensHour: number[];
  shortOpensHour: number[];
  cumulativeDeltaBidNeg: number;
  cumulativeDeltaAskPos: number;
  priceBuffer: { ts: number; last: number }[];
  entryAskForLong: number | null;
  entryBidForShort: number | null;
  previousSlope: number;
}

const STATE_FILE = path.resolve(process.cwd(), `.vector-state-${SYMBOL}.json`);

function loadState(): void {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const saved = JSON.parse(raw) as State;
    const cutoff = Date.now() - 3600000;
    changeTimestamps = (saved.changeTimestamps ?? []).filter(ts => ts > cutoff);
    deltaLastWindow = (saved.deltaLastWindow ?? []).filter(x => x.ts > cutoff);
    deltaAskWindow = (saved.deltaAskWindow ?? []).filter(x => x.ts > cutoff);
    deltaBidWindow = (saved.deltaBidWindow ?? []).filter(x => x.ts > cutoff);
    changeTimestampsHour = (saved.changeTimestampsHour ?? []).filter(ts => ts > cutoff);
    deltaLastWindowHour = (saved.deltaLastWindowHour ?? []).filter(x => x.ts > cutoff);
    deltaAskWindowHour = (saved.deltaAskWindowHour ?? []).filter(x => x.ts > cutoff);
    deltaBidWindowHour = (saved.deltaBidWindowHour ?? []).filter(x => x.ts > cutoff);
    longOpensHour = (saved.longOpensHour ?? []).filter(ts => ts > cutoff);
    shortOpensHour = (saved.shortOpensHour ?? []).filter(ts => ts > cutoff);
    savedLong = saved.savedLong ?? null;
    savedShort = saved.savedShort ?? null;
    cumulativeDeltaBidNeg = saved.cumulativeDeltaBidNeg ?? 0;
    cumulativeDeltaAskPos = saved.cumulativeDeltaAskPos ?? 0;
    priceBuffer = (saved.priceBuffer ?? []).slice(-SLOPE_N);
    entryAskForLong = saved.entryAskForLong ?? null;
    entryBidForShort = saved.entryBidForShort ?? null;
    previousSlope = saved.previousSlope ?? 0;
    console.log(`[${tsNow()}]  ✓  Loaded state: ${changeTimestamps.length} + ${changeTimestampsHour.length} changes` +
      (savedLong ? ` | saved long ${savedLong.size}` : "") +
      (savedShort ? ` | saved short ${savedShort.size}` : "") +
      ` | Δask/m: ${deltaAskWindow.length} | Δbid/m: ${deltaBidWindow.length}` +
      (SLOPE_MODE ? ` | slope buffer: ${priceBuffer.length}` : ""));
  } catch (e) {
    console.error(`[${tsNow()}]  ⚠  Failed to load state: ${(e as Error).message}`);
  }
}

function saveState(): void {
  const state: State = {
    changeTimestamps,
    deltaLastWindow,
    deltaAskWindow,
    deltaBidWindow,
    changeTimestampsHour,
    deltaLastWindowHour,
    deltaAskWindowHour,
    deltaBidWindowHour,
    savedLong,
    savedShort,
    longOpensHour,
    shortOpensHour,
    cumulativeDeltaBidNeg,
    cumulativeDeltaAskPos,
    priceBuffer,
    entryAskForLong,
    entryBidForShort,
    previousSlope,
  };
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
  longOpensHour.push(Date.now());
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

async function openShort(): Promise<void> {
  shortOpensHour.push(Date.now());
  if (DRY_RUN) {
    console.log(`[${tsNow()}]  📕  DRY-RUN — would open SHORT ${SYMBOL} size=${SIZE}`);
    return;
  }
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Sell", price: 0, qty: SIZE, posSide: "Short" },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );
  console.log(`[${tsNow()}]  📕  SHORT opened — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`);
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
  const deltaW = SCIENTIFIC ? DECIMALS + 7 : DECIMALS + 3;
  const deltaSumW = SCIENTIFIC ? DECIMALS + 7 : 6;
  const h =
    `[YYYY-MM-DD HH:MM:SS] ` +
    (HIDE_COLS.has("ask") ? "" : r("ask", priceW) + " ") +
    (HIDE_COLS.has("bid") ? "" : r("bid", priceW) + " ") +
    r("last", priceW) + " " +
    (HIDE_COLS.has("ab") ? "" : r("ab", priceW) + " ") +
    (SLOPE_MODE ? r("slope", deltaW) + " " : (NO_IL ? "" : r("I-L", deltaW) + " ")) +
    r("ΔL", deltaW) + " " +
    (HIDE_COLS.has("deltaask") ? "" : r("Δask", deltaW) + " ") +
    (HIDE_COLS.has("deltabid") ? "" : r("Δbid", deltaW) + " ") +
    r("cdL", 3) + " " +
    r("cdS", 3) + " " +
    r("#ΔL/m", 5) + " " +
    r("ΣΔL/m", deltaSumW) + " " +
    r("ΣΔL+/m", deltaSumW) + " " +
    r("ΣΔL-/m", deltaSumW) + " " +
    (HIDE_COLS.has("σδask/m") || HIDE_COLS.has("sigmadeltaask/m") ? "" : r("ΣΔask/m", deltaSumW) + " ") +
    (HIDE_COLS.has("σδask+/m") || HIDE_COLS.has("sigmadeltaask+/m") ? "" : r("ΣΔask+/m", deltaSumW) + " ") +
    (HIDE_COLS.has("σδask-/m") || HIDE_COLS.has("sigmadeltaask-/m") ? "" : r("ΣΔask-/m", deltaSumW) + " ") +
    r("#Δask/m", 5) + " " +
    (HIDE_COLS.has("σδbid/m") || HIDE_COLS.has("sigmadeltabid/m") ? "" : r("ΣΔbid/m", deltaSumW) + " ") +
    (HIDE_COLS.has("σδbid+/m") || HIDE_COLS.has("sigmadeltabid+/m") ? "" : r("ΣΔbid+/m", deltaSumW) + " ") +
    (HIDE_COLS.has("σδbid-/m") || HIDE_COLS.has("sigmadeltabid-/m") ? "" : r("ΣΔbid-/m", deltaSumW) + " ") +
    r("#Δbid/m", 5) + " " +
    r("ΣΔask+/h", deltaSumW) + " " +
    r("ΣΔbid-/h", deltaSumW) + " " +
    r("ΣΔask+", deltaSumW) + " " +
    r("ΣΔbid-", deltaSumW) + " " +
    r("#ΔL/h", 5) + " " +
    r("#ΔL+/h", 6) + " " +
    r("#ΔL-/h", 6) + " " +
    r("ΣΔL/h", deltaSumW) + " " +
    r("ΣΔL+/h", deltaSumW) + " " +
    r("ΣΔL-/h", deltaSumW) + " " +
    r("#L/h", 5) + " " +
    r("#S/h", 5);
  console.log(h);
  rowsPrinted = 0;
}

/* ------------------------------------------------------------------ */
/*  Slope calculation                                                   */
/* ------------------------------------------------------------------ */

function calculateSlope(buffer: { ts: number; last: number }[]): number {
  if (buffer.length < 2) return 0;

  const n = buffer.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y = buffer[i].last;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  return slope;
}

function recordExit(type: "EXIT_LONG" | "EXIT_SHORT", price: number): void {
  tradeEvents.push({ type, price, tick: tickCounter });
}

/* ------------------------------------------------------------------ */
/*  Chart rendering                                                     */
/* ------------------------------------------------------------------ */

function renderChart(price: number): string {
  if (!CHART) return "";

  if (!chartCanvas) {
    chartCanvas = createCanvas();
  }

  // Use 80% of terminal dimensions: width for chart, height - 5 for ticker lines below
  const { width: termWidth, height: termHeight } = getTerminalSize();
  const chartCols = Math.max(20, Math.floor(termWidth * 0.8));
  const chartRows = Math.max(5, Math.floor(termHeight * 0.8) - 5);  // 5 rows for ticker below

  chartPixelWidth = chartCols * 2;   // 2 pixels per braille column
  chartPixelHeight = chartRows * 4;  // 4 pixels per braille row

  // Append price and trim to chart width
  priceHistory.push(price);
  if (priceHistory.length > chartCols) {
    priceHistory.shift();
  }

  // Find min/max for normalization
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const p of priceHistory) {
    if (p < minPrice) minPrice = p;
    if (p > maxPrice) maxPrice = p;
  }

  // Add small padding to avoid flat line when all same
  if (minPrice === maxPrice) {
    minPrice -= 1;
    maxPrice += 1;
  }

  const priceRange = maxPrice - minPrice;

  // Clear canvas
  clear(chartCanvas);

  // Build set of event indices for this chart window
  const eventIndices = new Map<number, string>();
  const eventMarkers: { char: string; label: string }[] = [
    { char: "▲", label: "Open Long" },
    { char: "▼", label: "Open Short" },
    { char: "○", label: "Exit Long" },
    { char: "●", label: "Exit Short" },
  ];
  const activeMarkers: string[] = [];

  for (const evt of tradeEvents) {
    const chartIdx = evt.tick - (tickCounter - chartCols);
    if (chartIdx < 0 || chartIdx >= chartCols) continue;
    const marker = eventMarkers.find(m => m.char === (evt.type === "OPEN_LONG" ? "▲" : evt.type === "OPEN_SHORT" ? "▼" : evt.type === "EXIT_LONG" ? "○" : "●"));
    if (marker) {
      eventIndices.set(chartIdx, marker.char);
      if (!activeMarkers.includes(marker.label)) {
        activeMarkers.push(marker.label);
      }
    }
  }

  // Draw price line and event markers together
  let prevPx = -1;
  let prevPy = -1;

  for (let i = 0; i < priceHistory.length; i++) {
    const p = priceHistory[i];
    const px = Math.round((i / Math.max(1, chartCols - 1)) * (chartPixelWidth - 1));
    const py = Math.round(((maxPrice - p) / priceRange) * (chartPixelHeight - 1));

    if (prevPx >= 0) {
      for (const pt of line(prevPx, prevPy, px, py)) {
        set(chartCanvas, pt.x, pt.y);
      }
    } else {
      set(chartCanvas, px, py);
    }

    // Draw event marker at this index (vertical bar through the price point)
    if (eventIndices.has(i)) {
      for (let dy = -2; dy <= 2; dy++) {
        const y = py + dy;
        if (y >= 0 && y < chartPixelHeight) {
          set(chartCanvas, px, y);
        }
      }
    }

    prevPx = px;
    prevPy = py;
  }

  // Render braille frame
  const chartStr = frame(chartCanvas);
  const chartLines = chartStr.split("\n").filter(l => l.length > 0);

  // Build the right-side panel with price labels
  const resultLines: string[] = [];

  // Header
  resultLines.push(`  LAST: ${fmt(price)}`);

  // Add chart lines with price scale on right (right-aligned labels)
  const labelWidth = fmt(maxPrice).length;
  for (let i = 0; i < chartLines.length; i++) {
    const fraction = i / Math.max(1, chartLines.length - 1);
    const labelPrice = maxPrice - fraction * priceRange;
    const label = fmt(labelPrice).padStart(labelWidth);
    // Pad each line to exact chartCols width using spaces
    const line = chartLines[i];
    const padLen = Math.max(0, chartCols - [...line].length);
    resultLines.push(`${line}${" ".repeat(padLen)}  ${label}`);
  }

  // Add legend at bottom
  resultLines.push("");
  const legendParts: string[] = [];
  for (const m of eventMarkers) {
    if (activeMarkers.includes(m.label)) {
      legendParts.push(`${m.char}=${m.label}`);
    }
  }
  if (legendParts.length > 0) {
    resultLines.push(`  Legend: ${legendParts.join("  ")}`);
  }

  return resultLines.join("\n");
}

function printChartToTerminal(price: number, tickerData: TickerData | null): void {
  if (!CHART) return;

  const chartOutput = renderChart(price);
  if (!chartOutput) return;

  const lines = chartOutput.split("\n");

  // Clear screen and move cursor to top-left
  process.stdout.write("\x1b[2J\x1b[H");

  // Print chart at top
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write(lines[i] + "\n");
  }

  // Print ticker summary on one line below chart
  if (tickerData) {
    process.stdout.write("\n");
    process.stdout.write(`  ${SYMBOL}  Last:${fmt(tickerData.last)}  Bid:${fmt(tickerData.bid)}  Ask:${fmt(tickerData.ask)}  Idx:${fmt(tickerData.index)}  Mk:${fmt(tickerData.mark)}  Spr:${fmt(tickerData.ask - tickerData.bid)}  Vec:${fmtSign(tickerData.index - tickerData.last)}\n`);
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`\n══ Vector (I-L) Strategy ══════════════════════════════════════`);
  console.log(`  Symbol:     ${SYMBOL}`);
  console.log(`  Size:       ${SIZE}`);
  console.log(`  Leverage:   ${LEVERAGE}x`);
  if (SLOPE_MODE) {
    console.log(`  Strategy:   SLOPE`);
    console.log(`  SlopeN:     ${SLOPE_N}`);
    console.log(`  SlopeThr:   ${fmt(SLOPE_THRESHOLD)}`);
    console.log(`  OpposingThr: ${fmt(OPPOSING_THRESHOLD)}`);
  } else {
    console.log(`  Threshold:  ±${THRESHOLD}`);
  }
  console.log(`  Cd Long:    ${CD_LONG}s`);
  console.log(`  Cd Short:   ${CD_SHORT}s`);
  console.log(`  ExitBid:    <= ${fmt(EXIT_BID_THRESHOLD)}`);
  console.log(`  ExitAsk:    >= ${fmt(EXIT_ASK_THRESHOLD)}`);
  console.log(`  ExitSigmaBid: <= ${fmt(EXIT_SIGMA_BID_THRESHOLD)}`);
  console.log(`  ExitSigmaAsk: >= ${fmt(EXIT_SIGMA_ASK_THRESHOLD)}`);
  console.log(`  ProfitExit: ${PROFIT_EXIT ? `ON (profit=${PROFIT})` : "OFF"}`);
  if (CHART) console.log(`  Chart:      ON (auto-size to terminal)`);
  if (SUPPRESS_TICKER) console.log(`  SuppressTicker: ON`);
  if (HIDE_COLS.size > 0) console.log(`  HideCols:   ${[...HIDE_COLS].join(", ")}`);
  console.log(`  Mode:       ${DRY_RUN ? "DRY-RUN (no orders)" : "LIVE"}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  // Set leverage
  if (!DRY_RUN) {
    await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", creds.PHEMEX_API_KEY, secretRaw);
    await setLeverageUsdtM(SYMBOL, LEVERAGE, "Short", creds.PHEMEX_API_KEY, secretRaw);
    console.log(`[${tsNow()}]  ✓  Leverage set to ${LEVERAGE}x`);
  }

  // Close positions if requested
  if (CLOSE_LONG || CLOSE_SHORT) {
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      for (const pos of positions) {
        if (pos.symbol !== SYMBOL) continue;
        const size = parseFloat(pos.size || "0");
        if (size === 0) continue;
        
        if (CLOSE_LONG && pos.side === "Buy") {
          console.log(`[${tsNow()}]  Closing LONG position: ${pos.size}`);
          await closePos(pos);
        }
        if (CLOSE_SHORT && pos.side === "Sell") {
          console.log(`[${tsNow()}]  Closing SHORT position: ${pos.size}`);
          await closePos(pos);
        }
      }
      console.log(`[${tsNow()}]  ✓  Position(s) closed`);
    } catch (e) {
      console.error(`[${tsNow()}]  ⚠  Error closing positions: ${(e as Error).message}`);
    }
    if (!CLOSE_LONG && !CLOSE_SHORT) {
      // If only closing, exit after
      process.exit(0);
    }
  }

  // Load persisted state
  loadState();

  // Start WebSocket
  const ws = startWebSocket();

  // Wait for first tick
  process.stdout.write(`[${tsNow()}]  Waiting for first tick…`);
  while (!ticker) {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(" connected.\n");

  // Print column headers
  if (!SUPPRESS_TICKER) {
    printHeaders();
  }

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
    tickCounter++;
    if (longCooldown > 0) longCooldown--;
    if (shortCooldown > 0) shortCooldown--;

    if (ticker) {
      const snapBid = ticker.bid;
      const snapAsk = ticker.ask;
      const snapLast = ticker.last;
      const snapIndex = ticker.index;
      const vector = snapIndex - snapLast;
      const deltaBid = prevBid !== null ? snapBid - prevBid : null;
      const deltaAsk = prevAsk !== null ? snapAsk - prevAsk : null;
      const deltaLast = prevLast !== null ? snapLast - prevLast : null;

      const ab = snapAsk - snapBid;

      // Accumulate cumulative deltas (reset on exit)
      if (deltaBid !== null && deltaBid < 0) cumulativeDeltaBidNeg += deltaBid;
      if (deltaAsk !== null && deltaAsk > 0) cumulativeDeltaAskPos += deltaAsk;

      // Update price buffer for slope calculation (SLOPE_MODE)
      if (SLOPE_MODE) {
        priceBuffer.push({ ts: Date.now(), last: snapLast });
        while (priceBuffer.length > SLOPE_N) {
          priceBuffer.shift();
        }
      }

      // Count last changes (rolling window of 60 seconds)
      if (deltaLast !== null && deltaLast !== 0) {
        changeTimestamps.push(Date.now());
      }
      // Remove entries older than 60 seconds
      const cutoff = Date.now() - 60000;
      while (changeTimestamps.length > 0 && changeTimestamps[0] < cutoff) {
        changeTimestamps.shift();
      }
      const rate = String(changeTimestamps.length);

      // Aggregate deltaLast over rolling 60 second window
      if (deltaLast !== null) {
        deltaLastWindow.push({ ts: Date.now(), val: deltaLast });
      }
      while (deltaLastWindow.length > 0 && deltaLastWindow[0].ts < cutoff) {
        deltaLastWindow.shift();
      }
      const deltaLastSum = deltaLastWindow.reduce((acc, x) => acc + x.val, 0);
      const deltaLastPosSum = deltaLastWindow.filter(x => x.val > 0).reduce((acc, x) => acc + x.val, 0);
      const deltaLastNegSum = deltaLastWindow.filter(x => x.val < 0).reduce((acc, x) => acc + x.val, 0);

      // Aggregate deltaAsk over rolling 60 second window
      if (deltaAsk !== null) {
        deltaAskWindow.push({ ts: Date.now(), val: deltaAsk });
      }
      while (deltaAskWindow.length > 0 && deltaAskWindow[0].ts < cutoff) {
        deltaAskWindow.shift();
      }
      const deltaAskSum = deltaAskWindow.reduce((acc, x) => acc + x.val, 0);
      const deltaAskPosSum = deltaAskWindow.filter(x => x.val > 0).reduce((acc, x) => acc + x.val, 0);
      const deltaAskNegSum = deltaAskWindow.filter(x => x.val < 0).reduce((acc, x) => acc + x.val, 0);
      const deltaAskCount = deltaAskWindow.filter(x => x.val !== 0).length;

      // Aggregate deltaBid over rolling 60 second window
      if (deltaBid !== null) {
        deltaBidWindow.push({ ts: Date.now(), val: deltaBid });
      }
      while (deltaBidWindow.length > 0 && deltaBidWindow[0].ts < cutoff) {
        deltaBidWindow.shift();
      }
      const deltaBidSum = deltaBidWindow.reduce((acc, x) => acc + x.val, 0);
      const deltaBidPosSum = deltaBidWindow.filter(x => x.val > 0).reduce((acc, x) => acc + x.val, 0);
      const deltaBidNegSum = deltaBidWindow.filter(x => x.val < 0).reduce((acc, x) => acc + x.val, 0);
      const deltaBidCount = deltaBidWindow.filter(x => x.val !== 0).length;

      // Count last changes (rolling window of 1 hour)
      const cutoffHour = Date.now() - 3600000;
      if (deltaLast !== null && deltaLast !== 0) {
        changeTimestampsHour.push(Date.now());
      }
      while (changeTimestampsHour.length > 0 && changeTimestampsHour[0] < cutoffHour) {
        changeTimestampsHour.shift();
      }
      const rateHour = String(changeTimestampsHour.length);

      // Aggregate deltaLast over rolling 1 hour window
      if (deltaLast !== null) {
        deltaLastWindowHour.push({ ts: Date.now(), val: deltaLast });
      }
      while (deltaLastWindowHour.length > 0 && deltaLastWindowHour[0].ts < cutoffHour) {
        deltaLastWindowHour.shift();
      }
      const deltaLastSumHour = deltaLastWindowHour.reduce((acc, x) => acc + x.val, 0);
      const deltaLastPosSumHour = deltaLastWindowHour.filter(x => x.val > 0).reduce((acc, x) => acc + x.val, 0);
      const deltaLastNegSumHour = deltaLastWindowHour.filter(x => x.val < 0).reduce((acc, x) => acc + x.val, 0);
      deltaLastPosCountHour = deltaLastWindowHour.filter(x => x.val > 0).length;
      deltaLastNegCountHour = deltaLastWindowHour.filter(x => x.val < 0).length;

      // Aggregate deltaAsk over rolling 1 hour window
      if (deltaAsk !== null) {
        deltaAskWindowHour.push({ ts: Date.now(), val: deltaAsk });
      }
      while (deltaAskWindowHour.length > 0 && deltaAskWindowHour[0].ts < cutoffHour) {
        deltaAskWindowHour.shift();
      }
      const deltaAskPosSumHour = deltaAskWindowHour.filter(x => x.val > 0).reduce((acc, x) => acc + x.val, 0);

      // Aggregate deltaBid over rolling 1 hour window
      if (deltaBid !== null) {
        deltaBidWindowHour.push({ ts: Date.now(), val: deltaBid });
      }
      while (deltaBidWindowHour.length > 0 && deltaBidWindowHour[0].ts < cutoffHour) {
        deltaBidWindowHour.shift();
      }
      const deltaBidNegSumHour = deltaBidWindowHour.filter(x => x.val < 0).reduce((acc, x) => acc + x.val, 0);

      while (longOpensHour.length > 0 && longOpensHour[0] < cutoffHour) {
        longOpensHour.shift();
      }
      while (shortOpensHour.length > 0 && shortOpensHour[0] < cutoffHour) {
        shortOpensHour.shift();
      }
      const longOpensCount = longOpensHour.length;
      const shortOpensCount = shortOpensHour.length;

      const priceW = SCIENTIFIC ? DECIMALS + 6 : DECIMALS + 2;
      const deltaW = SCIENTIFIC ? DECIMALS + 7 : DECIMALS + 3;
      const deltaSumW = SCIENTIFIC ? DECIMALS + 7 : 6;
      const slope = SLOPE_MODE ? calculateSlope(priceBuffer) : 0;
      if (!SUPPRESS_TICKER) {
        console.log(
          `[${tsNow()}] ` +
          (HIDE_COLS.has("ask") ? "" : r(fmt(snapAsk), priceW) + " ") +
          (HIDE_COLS.has("bid") ? "" : r(fmt(snapBid), priceW) + " ") +
          r(fmt(snapLast), priceW) + " " +
          (HIDE_COLS.has("ab") ? "" : r(fmt(ab), priceW) + " ") +
          (SLOPE_MODE ? r(fmt(slope), deltaW) + " " : (NO_IL ? "" : r(fmtSign(vector), deltaW) + " ")) +
          r(fmtSign(deltaLast), deltaW) + " " +
          (HIDE_COLS.has("deltaask") ? "" : r(fmtSign(deltaAsk), deltaW) + " ") +
          (HIDE_COLS.has("deltabid") ? "" : r(fmtSign(deltaBid), deltaW) + " ") +
          r(String(longCooldown) + "s", 3) + " " +
          r(String(shortCooldown) + "s", 3) + " " +
          r(rate, 5) + " " +
          r(fmtSign(deltaLastSum), deltaSumW) + " " +
          r(fmtSign(deltaLastPosSum), deltaSumW) + " " +
          r(fmtSign(deltaLastNegSum), deltaSumW) + " " +
          (HIDE_COLS.has("σδask/m") || HIDE_COLS.has("sigmadeltaask/m") ? "" : r(fmtSign(deltaAskSum), deltaSumW) + " ") +
          (HIDE_COLS.has("σδask+/m") || HIDE_COLS.has("sigmadeltaask+/m") ? "" : r(fmtSign(deltaAskPosSum), deltaSumW) + " ") +
          (HIDE_COLS.has("σδask-/m") || HIDE_COLS.has("sigmadeltaask-/m") ? "" : r(fmtSign(deltaAskNegSum), deltaSumW) + " ") +
          r(String(deltaAskCount), 5) + " " +
          (HIDE_COLS.has("σδbid/m") || HIDE_COLS.has("sigmadeltabid/m") ? "" : r(fmtSign(deltaBidSum), deltaSumW) + " ") +
          (HIDE_COLS.has("σδbid+/m") || HIDE_COLS.has("sigmadeltabid+/m") ? "" : r(fmtSign(deltaBidPosSum), deltaSumW) + " ") +
          (HIDE_COLS.has("σδbid-/m") || HIDE_COLS.has("sigmadeltabid-/m") ? "" : r(fmtSign(deltaBidNegSum), deltaSumW) + " ") +
          r(String(deltaBidCount), 5) + " " +
          r(fmtSign(deltaAskPosSumHour), deltaSumW) + " " +
          r(fmtSign(deltaBidNegSumHour), deltaSumW) + " " +
          r(fmtSign(cumulativeDeltaAskPos), deltaSumW) + " " +
          r(fmtSign(cumulativeDeltaBidNeg), deltaSumW) + " " +
          r(rateHour, 5) + " " +
          r(String(deltaLastPosCountHour), 6) + " " +
          r(String(deltaLastNegCountHour), 6) + " " +
          r(fmtSign(deltaLastSumHour), deltaSumW) + " " +
          r(fmtSign(deltaLastPosSumHour), deltaSumW) + " " +
          r(fmtSign(deltaLastNegSumHour), deltaSumW) + " " +
          r(String(longOpensCount), 5) + " " +
          r(String(shortOpensCount), 5)
        );
      }
      // if (SLOPE_MODE && priceBuffer.length > 0) {
      //   const bufStr = priceBuffer.map((p) => fmt(p.last)).join(", ");
      //   console.log(`  buffer[${priceBuffer.length}/${SLOPE_N}]: [${bufStr}]`);
      // }

      // Render chart on right side if enabled
      if (CHART) {
        printChartToTerminal(snapLast, ticker);
      }

      if (!SUPPRESS_TICKER) {
        rowsPrinted++;
        if (process.stdout.rows && rowsPrinted >= process.stdout.rows - 4) {
          printHeaders();
        }
      }

      if (VERBOSE) {
        const slope = SLOPE_MODE ? calculateSlope(priceBuffer) : 0;
        console.log(`[${tsNow()}]  📊  ${SLOPE_MODE ? `slope=${fmt(slope)}  buffer=${priceBuffer.length}/${SLOPE_N}` : `vector=${fmt(vector)}`}  bid=${fmt(ticker.bid)}  ask=${fmt(ticker.ask)}  deltaBid=${deltaBid !== null ? fmt(deltaBid) : "—"}  deltaAsk=${deltaAsk !== null ? fmt(deltaAsk) : "—"}`);
      }

      try {
        const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);

        let longSize = 0;
        let shortSize = 0;
        let longPos: Position | null = null;
        let shortPos: Position | null = null;

        for (const pos of positions) {
          if (pos.symbol !== SYMBOL) continue;
          const size = parseFloat(pos.size || "0");
          if (pos.side === "Buy") {
            longSize += size;
            longPos = pos;
          } else if (pos.side === "Sell") {
            shortSize += size;
            shortPos = pos;
          }
        }

        // Exit logic (check first — close before potentially opening)
        if (longPos && !NO_EXIT_BID && cumulativeDeltaBidNeg <= EXIT_BID_THRESHOLD) {
          console.log(`[${tsNow()}]  EXIT LONG — ΣΔbid-=${fmt(cumulativeDeltaBidNeg)} <= ${fmt(EXIT_BID_THRESHOLD)}`);
          recordExit("EXIT_LONG", snapLast);
          await closePos(longPos);
          cumulativeDeltaBidNeg = 0;
          entryAskForLong = null;
        }

        if (longPos && EXIT_SIGMA_BID_THRESHOLD !== 0 && deltaBidNegSumHour <= EXIT_SIGMA_BID_THRESHOLD) {
          console.log(`[${tsNow()}]  EXIT LONG — ΣΔbid-/h=${fmt(deltaBidNegSumHour)} <= ${fmt(EXIT_SIGMA_BID_THRESHOLD)}`);
          recordExit("EXIT_LONG", snapLast);
          await closePos(longPos);
          cumulativeDeltaBidNeg = 0;
          entryAskForLong = null;
        }

        if (PROFIT_EXIT && longPos) {
          const entry = parseFloat(longPos.avgEntryPriceRp || "0");
          if (ticker && ticker.bid >= entry + PROFIT) {
            console.log(`[${tsNow()}]  EXIT LONG — bid ${fmt(ticker.bid)} >= entry ${fmt(entry)} + ${fmt(PROFIT)}`);
            recordExit("EXIT_LONG", snapLast);
            await closePos(longPos);
            cumulativeDeltaBidNeg = 0;
            entryAskForLong = null;
          }
        }

        // Slope-based exit for long: bid > entryAsk
        if (SLOPE_MODE && longPos && entryAskForLong !== null && snapBid > entryAskForLong) {
          const holdSlope = priceBuffer.length >= SLOPE_N ? Math.abs(calculateSlope(priceBuffer)) : 0;
          if (SLOPE_HOLD_THRESHOLD <= 0 || holdSlope < SLOPE_HOLD_THRESHOLD) {
            console.log(`[${tsNow()}]  EXIT LONG — bid ${fmt(snapBid)} > entryAsk ${fmt(entryAskForLong)}`);
            recordExit("EXIT_LONG", snapLast);
            await closePos(longPos);
            entryAskForLong = null;
          }
        }

        // Slope-based exits for long
        if (SLOPE_MODE && longPos && priceBuffer.length >= SLOPE_N) {
          const currentSlope = calculateSlope(priceBuffer);
          if (!NO_ZERO_SLOPE_EXIT) {
            if (SLOPE_THRESHOLD > 0 && currentSlope < -SLOPE_THRESHOLD) {
              console.log(`[${tsNow()}]  EXIT LONG — slope ${fmt(currentSlope)} < -${fmt(SLOPE_THRESHOLD)}`);
              recordExit("EXIT_LONG", snapLast);
              await closePos(longPos);
              entryAskForLong = null;
            } else if (previousSlope > 0 && currentSlope < 0) {
              console.log(`[${tsNow()}]  EXIT LONG — slope inflection: ${fmt(previousSlope)} -> ${fmt(currentSlope)}`);
              recordExit("EXIT_LONG", snapLast);
              await closePos(longPos);
              entryAskForLong = null;
            }
          }
          previousSlope = currentSlope;
        }

        // Slope-based exit for long: opposing direction 1e-6
        if (SLOPE_MODE && longPos && entryAskForLong !== null && !NO_OPPOSING_EXIT && snapBid < entryAskForLong - OPPOSING_THRESHOLD) {
          console.log(`[${tsNow()}]  EXIT LONG — opposing threshold: bid ${fmt(snapBid)} < entryAsk ${fmt(entryAskForLong)} - ${fmt(OPPOSING_THRESHOLD)}`);
          recordExit("EXIT_LONG", snapLast);
          await closePos(longPos);
          entryAskForLong = null;
        }

        if (shortPos && !NO_EXIT_ASK && cumulativeDeltaAskPos >= EXIT_ASK_THRESHOLD && !NO_SHORT) {
          console.log(`[${tsNow()}]  EXIT SHORT — ΣΔask+=${fmt(cumulativeDeltaAskPos)} >= ${fmt(EXIT_ASK_THRESHOLD)}`);
          recordExit("EXIT_SHORT", snapLast);
          await closePos(shortPos);
          cumulativeDeltaAskPos = 0;
          entryBidForShort = null;
        }

        if (shortPos && EXIT_SIGMA_ASK_THRESHOLD !== 0 && deltaAskPosSumHour >= EXIT_SIGMA_ASK_THRESHOLD) {
          console.log(`[${tsNow()}]  EXIT SHORT — ΣΔask+/h=${fmt(deltaAskPosSumHour)} >= ${fmt(EXIT_SIGMA_ASK_THRESHOLD)}`);
          recordExit("EXIT_SHORT", snapLast);
          await closePos(shortPos);
          cumulativeDeltaAskPos = 0;
          entryBidForShort = null;
        }

        // Slope-based exit for short: ask < entryBid
        if (SLOPE_MODE && shortPos && entryBidForShort !== null && snapAsk < entryBidForShort) {
          const holdSlope = priceBuffer.length >= SLOPE_N ? Math.abs(calculateSlope(priceBuffer)) : 0;
          if (SLOPE_HOLD_THRESHOLD <= 0 || holdSlope < SLOPE_HOLD_THRESHOLD) {
            console.log(`[${tsNow()}]  EXIT SHORT — ask ${fmt(snapAsk)} < entryBid ${fmt(entryBidForShort)}`);
            recordExit("EXIT_SHORT", snapLast);
            await closePos(shortPos);
            entryBidForShort = null;
          }
        }

        // Slope-based exit for short: slope > threshold
        // Slope-based exits for short
        if (SLOPE_MODE && shortPos && priceBuffer.length >= SLOPE_N) {
          const currentSlope = calculateSlope(priceBuffer);
          if (!NO_ZERO_SLOPE_EXIT) {
            if (SLOPE_THRESHOLD > 0 && currentSlope > SLOPE_THRESHOLD) {
              console.log(`[${tsNow()}]  EXIT SHORT — slope ${fmt(currentSlope)} > ${fmt(SLOPE_THRESHOLD)}`);
              recordExit("EXIT_SHORT", snapLast);
              await closePos(shortPos);
              entryBidForShort = null;
            } else if (previousSlope < 0 && currentSlope > 0) {
              console.log(`[${tsNow()}]  EXIT SHORT — slope inflection: ${fmt(previousSlope)} -> ${fmt(currentSlope)}`);
              recordExit("EXIT_SHORT", snapLast);
              await closePos(shortPos);
              entryBidForShort = null;
            }
          }
          previousSlope = currentSlope;
        }

        // Slope-based exit for short: opposing direction 1e-6
        if (SLOPE_MODE && shortPos && entryBidForShort !== null && !NO_OPPOSING_EXIT && snapAsk > entryBidForShort + OPPOSING_THRESHOLD) {
          console.log(`[${tsNow()}]  EXIT SHORT — opposing threshold: ask ${fmt(snapAsk)} > entryBid ${fmt(entryBidForShort)} + ${fmt(OPPOSING_THRESHOLD)}`);
          recordExit("EXIT_SHORT", snapLast);
          await closePos(shortPos);
          entryBidForShort = null;
        }

        // Entry logic
        let longTrigger = false;
        let shortTrigger = false;

        if (SLOPE_MODE && priceBuffer.length >= SLOPE_N) {
          // Slope-based entry
          const slope = calculateSlope(priceBuffer);
          if (Math.abs(slope) > SLOPE_THRESHOLD) {
            longTrigger = slope > 0;
            shortTrigger = slope < 0;
          }
        } else {
          // Original vector/deltaLast entry
          longTrigger = (!NO_VECTOR && vector > THRESHOLD) || (DELTA_LAST_THRESHOLD > 0 && deltaLast !== null && deltaLast >= DELTA_LAST_THRESHOLD);
          shortTrigger = (!NO_VECTOR && vector < -THRESHOLD) || (DELTA_LAST_THRESHOLD > 0 && deltaLast !== null && deltaLast <= -DELTA_LAST_THRESHOLD);
        }

        if (longTrigger && longCooldown === 0 && !NO_LONG && !NO_TRADE) {
          if (FORCE || longSize === 0) {
            if (shortPos) {
              console.log(`[${tsNow()}]  CLOSE SHORT — opening long`);
              await closePos(shortPos);
              entryBidForShort = null;
            }
            const slope = SLOPE_MODE ? calculateSlope(priceBuffer) : 0;
            console.log(`[${tsNow()}]  ENTRY LONG — ${SLOPE_MODE ? `slope=${fmt(slope)}` : `vector=${fmtSign(vector)}  ΔL=${deltaLast !== null ? fmtSign(deltaLast) : "—"}`}`);
            tradeEvents.push({ type: "OPEN_LONG", price: snapLast, tick: tickCounter });
            await openLong();
            entryAskForLong = snapAsk;
            longCooldown = CD_LONG;
          }
        } else if (shortTrigger && shortCooldown === 0 && !NO_SHORT && !NO_TRADE) {
          if (FORCE || shortSize === 0) {
            if (longPos) {
              console.log(`[${tsNow()}]  CLOSE LONG — opening short`);
              await closePos(longPos);
              entryAskForLong = null;
            }
            const slope = SLOPE_MODE ? calculateSlope(priceBuffer) : 0;
            console.log(`[${tsNow()}]  ENTRY SHORT — ${SLOPE_MODE ? `slope=${fmt(slope)}` : `vector=${fmtSign(vector)}  ΔL=${deltaLast !== null ? fmtSign(deltaLast) : "—"}`}`);
            tradeEvents.push({ type: "OPEN_SHORT", price: snapLast, tick: tickCounter });
            await openShort();
            entryBidForShort = snapBid;
            shortCooldown = CD_SHORT;
          }
        }
      } catch (e) {
        console.error(`[${tsNow()}]  ⚠  Error: ${(e as Error).message}`);
      }

      // Update previous values AFTER processing
      prevBid = snapBid;
      prevAsk = snapAsk;
      prevLast = snapLast;
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
