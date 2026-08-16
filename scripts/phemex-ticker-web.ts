#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ticker-web.ts — Web dashboard for Phemex 24h ticker data.
 *
 * Connects to Phemex via WebSocket, stores 60 seconds of tick data per symbol
 * in a ring buffer, computes indicators (std dev, velocity, EMA), and serves
 * an interactive HTML dashboard over HTTP.
 *
 * Usage:
 *   npx tsx scripts/phemex-ticker-web.ts
 *   npx tsx scripts/phemex-ticker-web.ts --port 3100
 *   npx tsx scripts/phemex-ticker-web.ts --symbols BTCUSDT,ETHUSDT
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReconnectingWs } from "../src/ws-client.js";
import { publicGet } from "../src/http-client.js";
import { getArg, hasFlag, findSymbolRow } from "../src/cli-utils.js";

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

const PORT = Number(getArg("--port") ?? 3200);
const ALL_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
  "BNBUSDT", "SUIUSDT", "LINKUSDT", "XAUUSDT", "XTIUSDT", "XBRUSDT",
];
const SYMBOLS = (getArg("--symbols") ?? ALL_SYMBOLS.join(","))
  .split(",").filter(Boolean);
const BUFFER_SECONDS = 300; // 5 minutes of ticks at ~2/sec = 600 slots
const WS_URL = "wss://ws.phemex.com";
const DISK_PATH = join(process.cwd(), ".phemex-ticker-cache.json");
const PREFS_PATH = join(process.cwd(), ".phemex-ticker-prefs.json");
const SAVE_INTERVAL = 30_000;

/* ------------------------------------------------------------------ */
/*  Klines cache                                                       */
/* ------------------------------------------------------------------ */

const RESOLUTION_MAP: Record<string, number> = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240, '6h': 360,
  '12h': 720, '1D': 1440, '1W': 10080, '1M': 7200,
};
const KLINE_CACHE = new Map<string, { data: unknown[]; ts: number }>();
const KLINE_TTL_SHORT = 60_000;   // 60s for intervals ≤ 1h
const KLINE_TTL_LONG = 300_000;   // 5m for intervals > 1h

function klineCacheKey(sym: string, res: number): string { return `${sym}:${res}`; }

async function fetchKlines(sym: string, resolution: number, limit = 500): Promise<unknown[]> {
  const key = klineCacheKey(sym, resolution);
  const cached = KLINE_CACHE.get(key);
  const ttl = resolution > 60 ? KLINE_TTL_LONG : KLINE_TTL_SHORT;
  if (cached && Date.now() - cached.ts < ttl) return cached.data;

  const query = `symbol=${sym}&resolution=${resolution}&limit=${limit}`;
  const resp = await publicGet("/exchange/public/md/v2/kline/last", query);
  const rows = (resp as any)?.data?.rows ?? [];
  KLINE_CACHE.set(key, { data: rows, ts: Date.now() });
  return rows;
}

function loadPrefs(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(PREFS_PATH, "utf-8")); } catch { return {}; }
}

function savePrefs(prefs: Record<string, unknown>): void {
  try { writeFileSync(PREFS_PATH, JSON.stringify(prefs)); } catch {}
}

function loadRotate(): boolean { return loadPrefs().rotate === true; }
function saveRotate(val: boolean): void { savePrefs({ ...loadPrefs(), rotate: val }); }
function loadSymbol(): string {
  const s = loadPrefs().symbol;
  return typeof s === "string" && SYMBOLS.includes(s) ? s : SYMBOLS[0];
}
function saveSymbol(sym: string): void { savePrefs({ ...loadPrefs(), symbol: sym }); }
function loadResolution(): string {
  const r = loadPrefs().resolution;
  return typeof r === "string" && r in RESOLUTION_MAP ? r : "5m";
}

/* ------------------------------------------------------------------ */
/*  Ring Buffer                                                        */
/* ------------------------------------------------------------------ */

interface Tick {
  t: number;       // ms since epoch
  ask: number;
  bid: number;
  index: number;
  mark: number;
  last: number;
}

class RingBuffer {
  private buf: (Tick | null)[];
  private head = 0;
  private count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Array(capacity).fill(null);
  }

  push(tick: Tick): void {
    this.buf[this.head] = tick;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): Tick[] {
    if (this.count === 0) return [];
    const result: Tick[] = [];
    const start = this.count < this.capacity
      ? 0
      : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const t = this.buf[idx];
      if (t) result.push(t);
    }
    return result;
  }

  last(): Tick | null {
    if (this.count === 0) return null;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buf[idx];
  }

  size(): number {
    return this.count;
  }
}

/* ------------------------------------------------------------------ */
/*  Indicators                                                         */
/* ------------------------------------------------------------------ */

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sqDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / (values.length - 1));
}

function ema(values: number[], period: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

interface Indicators {
  stdDev: Record<string, number>;
  velocity: Record<string, number>;   // price change per second
  ema9: Record<string, number | null>;
  ema21: Record<string, number | null>;
}

const PRICE_FIELDS = ["ask", "bid", "index", "mark", "last"] as const;

function computeIndicators(ring: RingBuffer): Indicators {
  const ticks = ring.toArray();
  const result: Indicators = {
    stdDev: {},
    velocity: {},
    ema9: {},
    ema21: {},
  };

  if (ticks.length < 2) {
    for (const f of PRICE_FIELDS) {
      result.stdDev[f] = 0;
      result.velocity[f] = 0;
      result.ema9[f] = ticks[0]?.[f] ?? null;
      result.ema21[f] = ticks[0]?.[f] ?? null;
    }
    return result;
  }

  for (const f of PRICE_FIELDS) {
    const vals = ticks.map((t) => t[f]).filter((v) => Number.isFinite(v));
    result.stdDev[f] = stdDev(vals);
    result.ema9[f] = ema(vals, 9);
    result.ema21[f] = ema(vals, 21);

    // Velocity: (last - first) / elapsed seconds
    const first = ticks[0];
    const last = ticks[ticks.length - 1];
    const dtSec = (last.t - first.t) / 1000;
    result.velocity[f] = dtSec > 0 ? (last[f] - first[f]) / dtSec : 0;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const buffers = new Map<string, RingBuffer>();
const latestTick = new Map<string, Tick>();
let rotateActive = loadRotate();
let rotateTimer: ReturnType<typeof setInterval> | null = null;
const ROTATE_INTERVAL = 15000; // 15 seconds per ticker

function getBuffer(sym: string): RingBuffer {
  let b = buffers.get(sym);
  if (!b) {
    b = new RingBuffer(BUFFER_SECONDS * 2);  // ~2 ticks/sec → 120 slots
    buffers.set(sym, b);
  }
  return b;
}

/* ------------------------------------------------------------------ */
/*  Disk Persistence                                                   */
/* ------------------------------------------------------------------ */

function saveToDisk(): void {
  try {
    const snap: Record<string, Tick[]> = {};
    for (const sym of SYMBOLS) {
      const ring = buffers.get(sym);
      snap[sym] = ring ? ring.toArray() : [];
    }
    writeFileSync(DISK_PATH, JSON.stringify(snap));
  } catch {}
}

function loadFromDisk(): void {
  try {
    const raw = readFileSync(DISK_PATH, "utf-8");
    const snap: Record<string, Tick[]> = JSON.parse(raw);
    for (const sym of SYMBOLS) {
      const ticks = snap[sym];
      if (!Array.isArray(ticks)) continue;
      const ring = getBuffer(sym);
      for (const tick of ticks) ring.push(tick);
      if (ticks.length) latestTick.set(sym, ticks[ticks.length - 1]);
    }
    console.log(`  Loaded cached data from disk`);
  } catch {}
}

/* ------------------------------------------------------------------ */
/*  WebSocket — USDT-M (pack subscription)                             */
/* ------------------------------------------------------------------ */

let usdtCachedFields: string[] | null = null;

function processTicker(sym: string, data: Record<string, unknown>): void {
  const ask = Number(data.askRp);
  const bid = Number(data.bidRp);
  const index = Number(data.indexRp);
  const mark = Number(data.markRp);
  const last = Number(data.lastRp);

  if (![ask, bid, index, mark, last].some(Number.isFinite)) return;

  const tick: Tick = {
    t: Date.now(),
    ask: Number.isFinite(ask) ? ask : 0,
    bid: Number.isFinite(bid) ? bid : 0,
    index: Number.isFinite(index) ? index : 0,
    mark: Number.isFinite(mark) ? mark : 0,
    last: Number.isFinite(last) ? last : 0,
  };

  getBuffer(sym).push(tick);
  latestTick.set(sym, tick);
}

function handleUsdtMsg(msg: Record<string, unknown>): void {
  if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
    if (Array.isArray(msg.fields)) {
      usdtCachedFields = msg.fields as string[];
    }
    if (!usdtCachedFields) return;
    for (const row of msg.data as unknown[][]) {
      if (!Array.isArray(row) || row.length < 1) continue;
      const sym = String(row[0]);
      if (!SYMBOLS.includes(sym)) continue;
      const ticker = findSymbolRow([row], usdtCachedFields!, sym);
      if (ticker) processTicker(sym, ticker as Record<string, unknown>);
    }
  }
}

function handleCoinMsg(msg: Record<string, unknown>): void {
  if (msg.market24h) {
    const ticker = msg.market24h as Record<string, unknown>;
    const sym = String(ticker.symbol ?? "");
    if (SYMBOLS.includes(sym)) {
      processTicker(sym, ticker);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  WebSocket connections                                               */
/* ------------------------------------------------------------------ */

const coinSymbols = SYMBOLS.filter((s) => !s.endsWith("USDT"));
const usdtSymbols = SYMBOLS.filter((s) => s.endsWith("USDT"));

const wsUsdt = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    console.log(`  [USDT-M] subscribed to ${usdtSymbols.join(", ") || "(none)"} (${usdtSymbols.length} symbols)`);
    wsUsdt.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
  },
  onMessage: (msg) => handleUsdtMsg(msg),
  onReconnect: (delay) => {
    console.log(`  [USDT-M] reconnecting in ${delay / 1000}s…`);
    usdtCachedFields = null;
  },
});

let wsCoin: ReconnectingWs | null = null;
if (coinSymbols.length > 0) {
  wsCoin = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      console.log(`  [Coin-M] subscribed to ${coinSymbols.join(", ")} (${coinSymbols.length} symbols)`);
      wsCoin!.send({ method: "market24h.subscribe", params: coinSymbols, id: 1 });
    },
    onMessage: (msg) => handleCoinMsg(msg),
    onReconnect: (delay) => {
      console.log(`  [Coin-M] reconnecting in ${delay / 1000}s…`);
    },
  });
}

/* ------------------------------------------------------------------ */
/*  HTTP Server                                                        */
/* ------------------------------------------------------------------ */

function buildDashboard(): string {
  const symList = JSON.stringify(SYMBOLS);
  const rotateStr = rotateActive ? 'true' : 'false';
  const rotateLabel = rotateActive ? '⏸ Stop' : '▶ Rotate';
  const rotateClass = rotateActive ? ' active' : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phemex Ticker Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
    --border: #30363d; --text: #e6edf3; --text2: #8b949e;
    --green: #3fb950; --red: #f85149; --blue: #58a6ff;
    --yellow: #d29922; --cyan: #39d353; --purple: #bc8cff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace; background: var(--bg); color: var(--text); font-size: 13px; }
  .header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 10px 16px; display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 14px; font-weight: 600; white-space: nowrap; }
  .status { font-size: 11px; color: var(--text2); }
  .status .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .dot.on { background: var(--green); } .dot.off { background: var(--red); }
  .tabs { display: flex; gap: 2px; padding: 6px 16px 0; background: var(--bg2); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .tab { padding: 6px 12px; cursor: pointer; border-radius: 4px 4px 0 0; color: var(--text2); font-size: 12px; border: 1px solid transparent; border-bottom: none; transition: all .15s; }
  .tab:hover { background: var(--bg3); color: var(--text); }
  .tab.active { background: var(--bg); color: var(--text); border-color: var(--border); font-weight: 600; }
  .main { display: flex; flex-direction: column; gap: 0; height: calc(100vh - 80px); overflow: hidden; }
  .price-row { display: flex; gap: 8px; padding: 10px 16px; flex-wrap: wrap; }
  .price-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; min-width: 130px; flex: 1; }
  .price-card .label { font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .price-card .value { font-size: 16px; font-weight: 600; }
  .price-card .delta { font-size: 11px; margin-top: 2px; }
  .up { color: var(--green); } .down { color: var(--red); } .flat { color: var(--text2); }
  .indicators { display: flex; gap: 8px; padding: 0 16px 8px; flex-wrap: wrap; }
  .ind-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; min-width: 150px; }
  .ind-card .label { font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .ind-card .row { display: flex; justify-content: space-between; font-size: 11px; padding: 1px 0; }
  .ind-card .row .k { color: var(--text2); }
  .chart-wrap { flex: 1; padding: 0 16px 8px; min-height: 200px; }
  .chart-box { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; height: 100%; position: relative; overflow: hidden; }
  canvas { width: 100%; height: 100%; display: block; }
  .legend { position: absolute; top: 6px; right: 10px; display: flex; gap: 10px; font-size: 10px; }
  .legend span { display: flex; align-items: center; gap: 3px; }
  .legend .swatch { width: 10px; height: 3px; border-radius: 1px; display: inline-block; }
  .field-selector { display: flex; gap: 4px; padding: 4px 16px; }
  .field-btn { padding: 3px 8px; font-size: 11px; border-radius: 3px; cursor: pointer; border: 1px solid var(--border); background: var(--bg2); color: var(--text2); font-family: inherit; }
  .field-btn.active { background: var(--bg3); color: var(--text); border-color: var(--blue); }
  .res-selector { display: flex; gap: 4px; padding: 4px 16px; flex-wrap: wrap; }
  .res-btn { padding: 3px 8px; font-size: 11px; border-radius: 3px; cursor: pointer; border: 1px solid var(--border); background: var(--bg2); color: var(--text2); font-family: inherit; }
  .res-btn.active { background: var(--blue); color: #fff; border-color: var(--blue); }
  .rotate-btn { padding: 5px 12px; font-size: 12px; border-radius: 4px; cursor: pointer; border: 1px solid var(--border); background: var(--bg2); color: var(--text2); font-family: inherit; transition: all .15s; margin-left: auto; white-space: nowrap; }
  .rotate-btn:hover { background: var(--bg3); color: var(--text); }
  .rotate-btn.active { background: var(--blue); color: #fff; border-color: var(--blue); }
</style>
</head>
<body>

<div class="header">
  <h1>Phemex Ticker</h1>
  <div class="status"><span class="dot off" id="statusDot"></span><span id="statusText">connecting…</span></div>
  <button class="rotate-btn${rotateClass}" id="rotateBtn" onclick="toggleRotate()">${rotateLabel}</button>
</div>

<div class="tabs" id="tabs"></div>

<div class="main">
  <div class="price-row" id="priceRow"></div>
  <div class="indicators" id="indicators"></div>
  <div class="field-selector" id="fieldSelector"></div>
  <div class="res-selector" id="resSelector"></div>
  <div class="chart-wrap">
    <div class="chart-box">
      <canvas id="chart"></canvas>
      <div class="legend" id="legend"></div>
    </div>
  </div>
</div>

<script>
const SYMBOLS = ${symList};
const FIELDS = ['ask','bid','index','mark','last'];
const DELTA_FIELDS = ['ask','bid','index','mark','last'];
const FIELD_COLORS = { ask: '#f85149', bid: '#3fb950', index: '#d29922', mark: '#58a6ff', last: '#bc8cff' };
const LS_KEY = 'phemex_ticker_data';
const LS_FIELDS_KEY = 'phemex_ticker_fields';
const LS_SYMBOL_KEY = 'phemex_ticker_symbol';
const LS_ROTATE_KEY = 'phemex_ticker_rotate';
const LS_RESOLUTION_KEY = 'phemex_ticker_resolution';
const MAX_TICKS = 180;

const RESOLUTIONS = ['1m','5m','15m','30m','1h','2h','4h','6h','12h','1D','1W','1M'];
const RESOLUTION_VALUES = { '1m':1, '5m':5, '15m':15, '30m':30, '1h':60, '2h':120, '4h':240, '6h':360, '12h':720, '1D':1440, '1W':10080, '1M':7200 };
const KLINE_FIELDS = ['open','high','low','close','volume'];

function loadData() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function loadFields() {
  try {
    const raw = localStorage.getItem(LS_FIELDS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter(f => FIELDS.includes(f)));
    }
  } catch {}
  return new Set(['last']);
}

function loadSymbol() {
  try {
    const raw = localStorage.getItem(LS_SYMBOL_KEY);
    if (raw && SYMBOLS.includes(raw)) return raw;
  } catch {}
  return SYMBOLS[0];
}

function saveSymbol(sym) {
  try { localStorage.setItem(LS_SYMBOL_KEY, sym); } catch {}
  fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: sym }) });
}

function loadRotate() {
  try { return localStorage.getItem(LS_ROTATE_KEY) === 'true'; } catch {}
  return false;
}

function saveRotate(val) {
  try { localStorage.setItem(LS_ROTATE_KEY, String(val)); } catch {}
  fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rotate: val }) });
}

function loadResolution() {
  try {
    const raw = localStorage.getItem(LS_RESOLUTION_KEY);
    if (raw && RESOLUTIONS.includes(raw)) return raw;
  } catch {}
  return '5m';
}

function saveResolution(val) {
  try { localStorage.setItem(LS_RESOLUTION_KEY, val); } catch {}
  fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution: val }) });
}

function saveData() {
  try {
    const snap = {};
    for (const s of SYMBOLS) {
      const d = data[s];
      snap[s] = { ticks: d.ticks.slice(-MAX_TICKS), latest: d.latest };
    }
    localStorage.setItem(LS_KEY, JSON.stringify(snap));
  } catch {}
}

function saveFields() {
  try {
    localStorage.setItem(LS_FIELDS_KEY, JSON.stringify([...activeFields]));
  } catch {}
}

let activeSymbol = loadSymbol();
let activeFields = loadFields();
let data = {};
let rotateActive = loadRotate();
let rotateTimer = null;
const ROTATE_INTERVAL = 15000;
let activeResolution = loadResolution();
let klineData = {};  // symbol -> rows from klines API
let klineRefreshTimer = null;

const saved = loadData();
SYMBOLS.forEach(s => {
  const prev = saved[s];
  data[s] = {
    ticks: prev?.ticks ?? [],
    latest: prev?.latest ?? null,
    indicators: null,
  };
});

// Rotate

function toggleRotate() {
  rotateActive = !rotateActive;
  saveRotate(rotateActive);
  const btn = document.getElementById('rotateBtn');
  if (rotateActive) {
    btn.classList.add('active');
    btn.textContent = '⏸ Stop';
    rotateTimer = setInterval(() => {
      const idx = SYMBOLS.indexOf(activeSymbol);
      activeSymbol = SYMBOLS[(idx + 1) % SYMBOLS.length];
      saveSymbol(activeSymbol);
      buildTabs();
      render();
    }, ROTATE_INTERVAL);
  } else {
    btn.classList.remove('active');
    btn.textContent = '▶ Rotate';
    if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  }
}

// SSE
const evtSource = new EventSource('/events');
evtSource.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'tick') {
    const d = data[msg.symbol];
    if (!d) return;
    d.latest = msg.tick;
    d.ticks.push(msg.tick);
    if (d.ticks.length > MAX_TICKS) d.ticks.shift();
    d.indicators = msg.indicators;
    saveData();
    if (msg.connected !== undefined) {
      document.getElementById('statusDot').className = 'dot ' + (msg.connected ? 'on' : 'off');
      document.getElementById('statusText').textContent = msg.connected ? 'connected' : 'reconnecting…';
    }
    if (msg.symbol === activeSymbol) render();
  } else if (msg.type === 'snapshot') {
    for (const [sym, snap] of Object.entries(msg.data)) {
      const d = data[sym];
      if (!d) continue;
      if (snap.ticks?.length) d.ticks = snap.ticks;
      if (snap.latest) d.latest = snap.latest;
      d.indicators = snap.indicators;
    }
    saveData();
    if (msg.connected !== undefined) {
      document.getElementById('statusDot').className = 'dot ' + (msg.connected ? 'on' : 'off');
      document.getElementById('statusText').textContent = msg.connected ? 'connected' : 'reconnecting…';
    }
    render();
  }
};
evtSource.onerror = () => {
  document.getElementById('statusDot').className = 'dot off';
  document.getElementById('statusText').textContent = 'disconnected';
};

// Tabs
function buildTabs() {
  const el = document.getElementById('tabs');
  el.innerHTML = SYMBOLS.map(s =>
    '<div class="tab' + (s === activeSymbol ? ' active' : '') + '" data-sym="' + s + '">' + s + '</div>'
  ).join('');
  el.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => {
      activeSymbol = t.dataset.sym;
      saveSymbol(activeSymbol);
      buildTabs();
      buildFieldSelector();
      if (!isLiveMode()) fetchKlinesForActive();
      render();
    };
  });
}

// Field selector
function buildFieldSelector() {
  const el = document.getElementById('fieldSelector');
  el.innerHTML = FIELDS.map(f =>
    '<button class="field-btn' + (activeFields.has(f) ? ' active' : '') + '" data-field="' + f + '">' + f + '</button>'
  ).join('');
  el.querySelectorAll('.field-btn').forEach(b => {
    b.onclick = () => {
      const f = b.dataset.field;
      if (activeFields.has(f)) activeFields.delete(f); else activeFields.add(f);
      saveFields();
      buildFieldSelector(); renderChart();
    };
  });
}

// Resolution selector
function buildResSelector() {
  const el = document.getElementById('resSelector');
  el.innerHTML = RESOLUTIONS.map(r =>
    '<button class="res-btn' + (r === activeResolution ? ' active' : '') + '" data-res="' + r + '">' + r + '</button>'
  ).join('');
  el.querySelectorAll('.res-btn').forEach(b => {
    b.onclick = () => {
      activeResolution = b.dataset.res;
      saveResolution(activeResolution);
      buildResSelector();
      startKlineRefresh();
      render();
    };
  });
}

function isLiveMode() {
  return RESOLUTION_VALUES[activeResolution] < 15;
}

async function fetchKlinesForActive() {
  if (isLiveMode()) return;
  try {
    const res = await fetch('/api/klines?symbol=' + activeSymbol + '&resolution=' + RESOLUTION_VALUES[activeResolution]);
    const json = await res.json();
    klineData[activeSymbol] = json.rows || [];
    render();
  } catch {}
}

function startKlineRefresh() {
  if (klineRefreshTimer) clearInterval(klineRefreshTimer);
  if (!isLiveMode()) {
    fetchKlinesForActive();
    klineRefreshTimer = setInterval(fetchKlinesForActive, 60000);
  } else {
    klineRefreshTimer = null;
  }
}

function fmtPrice(v) { return v == null ? '—' : v.toFixed(4); }
function fmtDelta(v) {
  if (v == null || isNaN(v)) return '—';
  const s = v >= 0 ? '+' + v.toFixed(4) : v.toFixed(4);
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  return '<span class="' + cls + '">' + s + '</span>';
}
function fmtSig(v) { return v == null ? '—' : v.toFixed(4); }

function render() {
  const d = data[activeSymbol];
  if (!d) return;
  const t = d.latest;

  // Price cards
  const row = document.getElementById('priceRow');
  if (t) {
    row.innerHTML = FIELDS.map(f => {
      const val = t[f];
      const ind = d.indicators;
      const vel = ind ? ind.velocity[f] : null;
      const velStr = vel != null ? (vel >= 0 ? '+' : '') + vel.toFixed(4) + '/s' : '';
      return '<div class="price-card"><div class="label">' + f + '</div>'
        + '<div class="value">' + fmtPrice(val) + '</div>'
        + '<div class="delta">' + (velStr ? '<span class="' + (vel > 0 ? 'up' : vel < 0 ? 'down' : 'flat') + '">' + velStr + '</span>' : '') + '</div></div>';
    }).join('');
  } else {
    row.innerHTML = '<div style="color:var(--text2);padding:8px">Waiting for data…</div>';
  }

  // Indicators
  const indEl = document.getElementById('indicators');
  if (d.indicators) {
    const ind = d.indicators;
    indEl.innerHTML = [
      { title: 'Std Dev', data: ind.stdDev },
      { title: 'Velocity /s', data: ind.velocity },
      { title: 'EMA-9', data: ind.ema9 },
      { title: 'EMA-21', data: ind.ema21 },
    ].map(card =>
      '<div class="ind-card"><div class="label">' + card.title + '</div>'
      + FIELDS.map(f =>
        '<div class="row"><span class="k">' + f + '</span><span>' + fmtSig(card.data[f]) + '</span></div>'
      ).join('') + '</div>'
    ).join('');
  }

  renderChart();
}

// Canvas chart
let chartCanvas, chartCtx;
function initChart() {
  chartCanvas = document.getElementById('chart');
  chartCtx = chartCanvas.getContext('2d');
  window.addEventListener('resize', renderChart);
}

function renderChart() {
  if (!chartCtx) return;
  const d = data[activeSymbol];
  const rect = chartCanvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  chartCanvas.width = rect.width * dpr;
  chartCanvas.height = rect.height * dpr;
  chartCtx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  chartCtx.clearRect(0, 0, W, H);

  const pad = { top: 24, right: 12, bottom: 20, left: 60 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const useKlines = !isLiveMode() && klineData[activeSymbol]?.length > 0;

  if (useKlines) {
    renderKlinesChart(pad, cw, ch, W, H);
  } else {
    renderLiveChart(d, pad, cw, ch, W, H);
  }
}

function renderKlinesChart(pad, cw, ch, W, H) {
  const rows = klineData[activeSymbol];
  if (!rows || rows.length < 2) {
    chartCtx.fillStyle = '#8b949e';
    chartCtx.font = '12px monospace';
    chartCtx.textAlign = 'center';
    chartCtx.fillText('Loading klines…', W / 2, H / 2);
    return;
  }

  // rows: [timestamp, interval, last_close, open, high, low, close, volume, turnover]
  const closes = rows.map(r => Number(r[6]));
  const times = rows.map(r => Number(r[0]));

  let minV = Math.min(...closes);
  let maxV = Math.max(...closes);
  const range = maxV - minV || 1;
  const margin = range * 0.08;
  minV -= margin;
  maxV += margin;
  const vRange = maxV - minV;

  const tMin = times[0];
  const tMax = times[times.length - 1];
  const tRange = Math.max(tMax - tMin, 1000);

  // Grid
  chartCtx.strokeStyle = '#21262d';
  chartCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch * i / 4);
    chartCtx.beginPath();
    chartCtx.moveTo(pad.left, y);
    chartCtx.lineTo(pad.left + cw, y);
    chartCtx.stroke();
    const val = maxV - (vRange * i / 4);
    chartCtx.fillStyle = '#8b949e';
    chartCtx.font = '10px monospace';
    chartCtx.textAlign = 'right';
    chartCtx.fillText(val.toFixed(4), pad.left - 4, y + 3);
  }

  // Time labels
  chartCtx.textAlign = 'center';
  const labelCount = Math.min(6, rows.length);
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.floor(i * (rows.length - 1) / (labelCount - 1));
    const x = pad.left + ((times[idx] - tMin) / tRange) * cw;
    const d2 = new Date(times[idx]);
    const label = d2.getMonth() + 1 + '/' + d2.getDate() + ' ' + d2.getHours() + ':' + String(d2.getMinutes()).padStart(2, '0');
    chartCtx.fillText(label, x, H - 4);
  }

  // Line
  chartCtx.strokeStyle = '#3fb950';
  chartCtx.lineWidth = 1.5;
  chartCtx.beginPath();
  for (let i = 0; i < rows.length; i++) {
    const x = pad.left + ((times[i] - tMin) / tRange) * cw;
    const y = pad.top + ((maxV - closes[i]) / vRange) * ch;
    if (i === 0) chartCtx.moveTo(x, y);
    else chartCtx.lineTo(x, y);
  }
  chartCtx.stroke();

  // Legend
  const leg = document.getElementById('legend');
  leg.innerHTML = '<span><span class="swatch" style="background:#3fb950"></span>close (' + activeResolution + ')</span>';
}

function renderLiveChart(d, pad, cw, ch, W, H) {
  if (!d || d.ticks.length < 2) {
    chartCtx.fillStyle = '#8b949e';
    chartCtx.font = '12px monospace';
    chartCtx.textAlign = 'center';
    chartCtx.fillText('Waiting for data…', W / 2, H / 2);
    return;
  }

  const ticks = activeResolution === '1m'
    ? d.ticks.filter(t => t.t > Date.now() - 60000)
    : activeResolution === '5m'
    ? d.ticks.filter(t => t.t > Date.now() - 300000)
    : d.ticks;
  const fields = [...activeFields];
  if (fields.length === 0) fields.push('last');

  let minV = Infinity, maxV = -Infinity;
  for (const f of fields) {
    for (const tick of ticks) {
      const v = tick[f];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  const range = maxV - minV || 1;
  const margin = range * 0.08;
  minV -= margin;
  maxV += margin;
  const vRange = maxV - minV;

  const tMin = ticks[0].t;
  const tMax = ticks[ticks.length - 1].t;
  const tRange = Math.max(tMax - tMin, 1000);

  chartCtx.strokeStyle = '#21262d';
  chartCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch * i / 4);
    chartCtx.beginPath();
    chartCtx.moveTo(pad.left, y);
    chartCtx.lineTo(pad.left + cw, y);
    chartCtx.stroke();
    const val = maxV - (vRange * i / 4);
    chartCtx.fillStyle = '#8b949e';
    chartCtx.font = '10px monospace';
    chartCtx.textAlign = 'right';
    chartCtx.fillText(val.toFixed(4), pad.left - 4, y + 3);
  }

  chartCtx.textAlign = 'center';
  const labelCount = Math.min(6, ticks.length);
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.floor(i * (ticks.length - 1) / (labelCount - 1));
    const x = pad.left + ((ticks[idx].t - tMin) / tRange) * cw;
    const d2 = new Date(ticks[idx].t);
    const label = d2.getMinutes() + ':' + String(d2.getSeconds()).padStart(2, '0');
    chartCtx.fillText(label, x, H - 4);
  }

  for (const f of fields) {
    chartCtx.strokeStyle = FIELD_COLORS[f];
    chartCtx.lineWidth = 1.5;
    chartCtx.beginPath();
    let started = false;
    for (const tick of ticks) {
      const x = pad.left + ((tick.t - tMin) / tRange) * cw;
      const y = pad.top + ((maxV - tick[f]) / vRange) * ch;
      if (!started) { chartCtx.moveTo(x, y); started = true; }
      else chartCtx.lineTo(x, y);
    }
    chartCtx.stroke();
  }

  const leg = document.getElementById('legend');
  leg.innerHTML = fields.map(f =>
    '<span><span class="swatch" style="background:' + FIELD_COLORS[f] + '"></span>' + f + '</span>'
  ).join('');
}

buildTabs();
buildFieldSelector();
buildResSelector();
initChart();
render();
startKlineRefresh();

// Start rotate if it was active
if (rotateActive) {
  rotateTimer = setInterval(() => {
    const idx = SYMBOLS.indexOf(activeSymbol);
    activeSymbol = SYMBOLS[(idx + 1) % SYMBOLS.length];
    saveSymbol(activeSymbol);
    buildTabs();
    if (!isLiveMode()) fetchKlinesForActive();
    render();
  }, ROTATE_INTERVAL);
}
</script>
</body>
</html>`;
}

function getSnapshot(): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const sym of SYMBOLS) {
    const ring = buffers.get(sym);
    snap[sym] = {
      ticks: ring ? ring.toArray().slice(-180) : [],
      latest: latestTick.get(sym) ?? null,
      indicators: ring ? computeIndicators(ring) : null,
    };
  }
  return snap;
}

/* ------------------------------------------------------------------ */
/*  SSE                                                                */
/* ------------------------------------------------------------------ */

const sseClients = new Set<ServerResponse>();

function broadcastTick(sym: string, tick: Tick, indicators: Indicators): void {
  const msg = `data: ${JSON.stringify({ type: "tick", symbol: sym, tick, indicators, connected: wsUsdt.isConnected })}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

function sendSnapshot(res: ServerResponse): void {
  const msg = `data: ${JSON.stringify({
    type: "snapshot",
    data: getSnapshot(),
    connected: wsUsdt.isConnected,
  })}\n\n`;
  res.write(msg);
}

/* ------------------------------------------------------------------ */
/*  HTTP handler                                                       */
/* ------------------------------------------------------------------ */

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "/";

  if (url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    sendSnapshot(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (url === "/api/snapshot") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(getSnapshot()));
    return;
  }

  if (url === "/api/indicators") {
    const snap: Record<string, unknown> = {};
    for (const sym of SYMBOLS) {
      const ring = buffers.get(sym);
      snap[sym] = ring ? computeIndicators(ring) : null;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(snap));
    return;
  }

  if (url.startsWith("/api/klines")) {
    const u = new URL(url, "http://localhost");
    const sym = u.searchParams.get("symbol") ?? SYMBOLS[0];
    const resLabel = u.searchParams.get("resolution") ?? "60";
    const resolution = Number(resLabel) || RESOLUTION_MAP[resLabel] || 60;
    fetchKlines(sym, resolution).then((rows) => {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ symbol: sym, resolution, rows }));
    }).catch((err) => {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url === "/api/prefs" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const prefs = JSON.parse(body);
        const current = loadPrefs();
        if (prefs.symbol !== undefined) current.symbol = prefs.symbol;
        if (prefs.rotate !== undefined) current.rotate = prefs.rotate;
        if (prefs.resolution !== undefined) current.resolution = prefs.resolution;
        savePrefs(current);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"bad json"}');
      }
    });
    return;
  }

  // Dashboard
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(buildDashboard());
});

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Phemex Ticker Dashboard`);
  console.log(`  http://0.0.0.0:${PORT}\n`);
  console.log(`  Tracking ${SYMBOLS.length} symbols: ${SYMBOLS.join(", ")}\n`);
  console.log(`  [USDT-M] connecting…`);
  if (wsCoin) console.log(`  [Coin-M] connecting…`);
});

// Broadcast latest ticks to SSE clients every 500ms
let lastBroadcast = new Map<string, number>();

wsUsdt.connect();
if (wsCoin) wsCoin.connect();

loadFromDisk();

// Broadcast latest ticks to SSE clients every 500ms
setInterval(() => {
  for (const sym of SYMBOLS) {
    const ring = buffers.get(sym);
    const tick = latestTick.get(sym);
    if (ring && tick) {
      const prev = lastBroadcast.get(sym) ?? 0;
      if (tick.t > prev) {
        lastBroadcast.set(sym, tick.t);
        broadcastTick(sym, tick, computeIndicators(ring));
      }
    }
  }
}, 500);

// Persist to disk every 30s
setInterval(saveToDisk, SAVE_INTERVAL);

// Save on CTRL-C
process.on("SIGINT", () => {
  console.log("\n  Saving data to disk…");
  saveToDisk();
  process.exit(0);
});

// Restart when this file changes
import { watchFile } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const MY_FILE = resolve(process.argv[1] ?? import.meta.url.replace(/^file:\/\//, ""));
const RESTART_CMD = process.env.__PHEMEX_CMD ?? `npx tsx ${MY_FILE}`;
watchFile(MY_FILE, { interval: 1000 }, () => {
  console.log("\n  File changed — restarting…");
  saveToDisk();
  server.close();
  wsUsdt.shutdown();
  if (wsCoin) wsCoin.shutdown();
  spawn(RESTART_CMD, { shell: true, stdio: "inherit", env: { ...process.env, __PHEMEX_CMD: RESTART_CMD } })
    .on("exit", () => process.exit());
});
