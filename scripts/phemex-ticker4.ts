#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ticker-24hr.ts — poll the Phemex v3 24h ticker every second and
 * print every variable of the response horizontally on one line.
 *
 * Public endpoint, no credentials needed.
 *
 * A line is printed only when one of the five price columns — ask, bid,
 * index, mark or last — actually changed (other fields like turnover or
 * the ticker's own timestamp are ignored). Each tick still writes the
 * current ask and bid prices to
 * ask.txt and bid.txt in the project root (value only, no newline), so other
 * scripts can find them regardless of the launch directory.
 *
 * With --xbar and --sigma, the end of every minute prints the average price
 * of each of the five columns over that minute (x̄ask … x̄last) and the
 * cumulative absolute movement — Σask, Σbid, Σindex, Σmark, Σlast — where Σ
 * (sigma) is the sum of |current − previous| between consecutive ticks
 * (oscillation counts as movement), plus the per-second rate of each
 * (Σ/Δt, per full 60-second minute).
 *
 * With --csv <FILE> every tick is also appended to FILE as a CSV row
 * (time,ask,bid,index,mark,last); the header line is written when the file
 * is new, so a fresh log is self-describing and appending to an existing
 * log only adds rows.
 *
 * Usage:
 *   npx tsx phemex-ticker-24hr.ts                  # default symbol XBRUSDT
 *   npx tsx phemex-ticker-24hr.ts --symbol BTCUSDT
 *   npx tsx phemex-ticker-24hr.ts --interval 2000  # poll every 2s
 *   npx tsx phemex-ticker-24hr.ts --delta          # add Δask/Δbid/... = field − last
 *   npx tsx phemex-ticker-24hr.ts --xbar           # per-minute average line (x̄ask … x̄last)
 *   npx tsx phemex-ticker-24hr.ts --sigma          # per-minute Σ and Σ/Δt movement lines
 *   npx tsx phemex-ticker-24hr.ts --ma             # Δindex moving averages (1s,3s,5s,10s,15s,30s,60s)
 *   npx tsx phemex-ticker-24hr.ts --csv ticker.csv # append CSV rows
 */

import fs from "node:fs";
import { resolve } from "node:path";
import { ReconnectingWs } from "../src/ws-client.js";
import { getArg, hasFlag, findSymbolRow } from "../src/cli-utils.js";

const USAGE = `Usage: npx tsx phemex-ticker-24hr.ts [options]

Subscribe to the Phemex 24h ticker via WebSocket and print every
variable of the response horizontally on one line. Public endpoint,
no credentials needed. A line is printed only when ask, bid, index,
mark or last changed; ask.txt and bid.txt are still updated in the
project root on every tick.
Δt (elapsed seconds) is part of --delta. With --xbar and --sigma, the
end of every minute prints the average price of the five columns
(x̄ask … x̄last) and the cumulative absolute movement (Σask … Σlast)
with each one's per-second rate (Σask/Δt … Σlast/Δt). With --ma,
seven time-weighted moving-average columns (ma1s … ma60s) are added,
each showing the recent Δindex averaged over its window using
ticker-time seconds.

Options:
  --symbol <SYMBOLS>  Comma-separated symbols to track (default: XBRUSDT)
                      e.g. --symbol BTCUSDT,ETHUSDT,SOLUSDT
  --store             Write price files to data/ subdirectory (one file per
                      symbol, e.g. data/BTCUSDT-ask.txt)
  --concise           Hide fundRate, high, low, openInt, open, predFund,
                      symbol, turnover, volume columns
  --delta             Add Δask, Δbid, Δindex, Δlast, Δmark columns showing
                      each field minus the last price, plus Δt (elapsed
                      seconds from ticker timestamp)
  --xbar              Print the per-minute average-price line (x̄ask … x̄last)
  --sigma             Print the per-minute cumulative movement lines
                      (Σask … Σlast and Σask/Δt … Σlast/Δt)
  --ma                Add Δindex moving-average columns (ma1s, ma3s, ma5s,
                      ma10s, ma15s, ma30s, ma60s) — time-weighted averages
                      over each window in ticker-time seconds (implies --delta)
  --csv <FILE>        Append a CSV row (time,ask,bid,index,mark,last) to
                      FILE on every tick; writes the header when FILE is new
  --help              Show this help and exit
`;

if (hasFlag("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const SYMBOLS = (getArg("--symbol") ?? "XBRUSDT").split(",").filter(Boolean);
const STORE = hasFlag("--store");
const INTERVAL_MS = Number(getArg("--interval") ?? 1000);
// --csv <FILE>: append a time,ask,bid,index,mark,last row to FILE every tick.
const CSV_FILE = getArg("--csv");
const WS_URL = "wss://ws.phemex.com";
const IS_USDT_M = SYMBOLS[0].endsWith("USDT");

// Columns hidden in --concise mode (keyed by raw response field name).
const CONCISE_HIDDEN = new Set([
  "fundingRateRr", "highRp", "lowRp", "openInterestRv", "openRp",
  "predFundingRateRr", "symbol", "turnoverRv", "volumeRq",
]);

// --ma: time-weighted moving average of Δindex over fixed windows.
const SHOW_MA = hasFlag("--ma");
const MA_WINDOWS = [1, 3, 5, 10, 15, 30, 60] as const;

// --delta: fields for which a Δ column (field value minus last price) is added.
// --ma computes delta internally but does not show the Δ columns unless --delta is also set.
const DELTA = hasFlag("--delta");
const DELTA_FIELDS = ["askRp", "bidRp", "indexRp", "lastRp", "markRp"] as const;

// --xbar / --sigma: per-minute summary lines — the average price line (x̄)
// and the cumulative movement lines (Σ, Σ/Δt); hidden by default.
const SHOW_XBAR = hasFlag("--xbar");
const SHOW_SIGMA = hasFlag("--sigma");

// Fields that trigger a printed line when they change — the five price
// columns. Other fields (turnover, volume, Δt, …) update
// without printing, so a line appears only when a price moved.
const SIG_FIELDS = ["askRp", "bidRp", "indexRp", "markRp", "lastRp"] as const;

// Display order of the columns: index, mark, last (and their Δ columns) are
// listed in that order; anything not listed keeps its API order.
const COLUMN_ORDER = [
  "askRp", "bidRp", "fundingRateRr", "highRp",
  "indexRp", "markRp", "lastRp",
  "lowRp", "openInterestRv", "openRp", "predFundingRateRr", "symbol",
  "timestamp", "turnoverRv", "volumeRq",
  "askRpDelta", "bidRpDelta", "indexRpDelta",
  "markRpDelta", "lastRpDelta",
  "dt",
  "ma1s", "ma3s", "ma5s", "ma10s", "ma15s", "ma30s", "ma60s",
];
const COLUMN_RANK = new Map(COLUMN_ORDER.map((k, i) => [k, i]));

// Value files live at the project root (like last.txt / mark.txt) so both
// the ticker and the monitor see the same files from any launch directory.
const ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(ROOT, "data");

// Per-symbol file paths — created lazily when --store is set.
const symbolFiles = new Map<string, {
  ask: string; bid: string; index: string; indexLast: string;
  last: string; mark: string; markLast: string;
}>();

function getSymbolFiles(sym: string) {
  let f = symbolFiles.get(sym);
  if (!f) {
    const prefix = (name: string) => `${sym}-${name}`;
    f = {
      ask:      resolve(DATA_DIR, prefix("ask.txt")),
      bid:      resolve(DATA_DIR, prefix("bid.txt")),
      index:    resolve(DATA_DIR, prefix("index.txt")),
      indexLast: resolve(DATA_DIR, prefix("indexLast.txt")),
      last:     resolve(DATA_DIR, prefix("last.txt")),
      mark:     resolve(DATA_DIR, prefix("mark.txt")),
      markLast: resolve(DATA_DIR, prefix("markLast.txt")),
    };
    symbolFiles.set(sym, f);
  }
  return f;
}

/* ------------------------------------------------------------------ */
/*  CSV logging (--csv <FILE>) — append one row per tick.              */
/* ------------------------------------------------------------------ */

// Columns appended to the CSV file, in order (time is prepended).
const CSV_COLUMNS = ["askRp", "bidRp", "indexRp", "markRp", "lastRp"] as const;

/**
 * Append one CSV row (time,ask,bid,index,mark,last) to FILE. When FILE does
 * not exist yet (or is empty) the header line is written first, so a fresh
 * log is self-describing; appending to an existing log only adds rows.
 */
function appendCsvRow(file: string, data: Record<string, unknown>): void {
  const header = "time,ask,bid,index,mark,last\n";
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fs.appendFileSync(file, header, "utf8");
  }
  const row = [tsToHMS(Date.now()), ...CSV_COLUMNS.map((k) => fmt(data[k]))].join(",");
  fs.appendFileSync(file, `${row}\n`, "utf8");
}

/* ------------------------------------------------------------------ */
/*  Column definitions — abbreviation (printed in the header) and the  */
/*  full variable name, defined once at the top of the program.        */
/* ------------------------------------------------------------------ */

const COLUMNS: Record<string, { label: string; full: string }> = {
  askRp:             { label: "ask",      full: "ask price" },
  bidRp:             { label: "bid",      full: "bid price" },
  fundingRateRr:     { label: "fundRate", full: "funding rate" },
  highRp:            { label: "high",     full: "24h high" },
  indexRp:           { label: "index",    full: "index price" },
  lastRp:            { label: "last",     full: "last price" },
  lowRp:             { label: "low",      full: "24h low" },
  markRp:            { label: "mark",     full: "mark price" },
  openInterestRv:    { label: "openInt",  full: "open interest" },
  openRp:            { label: "open",     full: "24h open" },
  predFundingRateRr: { label: "predFund", full: "predicted funding rate" },
  symbol:            { label: "symbol",   full: "symbol" },
  timestamp:         { label: "time",     full: "timestamp" },
  turnoverRv:        { label: "turnover", full: "turnover" },
  volumeRq:          { label: "volume",   full: "volume" },
  // Delta columns (--delta): Δ<label> = field value minus the last price.
  askRpDelta:        { label: "Δask",    full: "ask − last" },
  bidRpDelta:        { label: "Δbid",    full: "bid − last" },
  indexRpDelta:      { label: "Δindex",  full: "index − last" },
  // Δt (shown with --delta): elapsed seconds from ticker timestamp.
  dt:                 { label: "Δt",       full: "elapsed seconds (ticker ts)" },
  lastRpDelta:       { label: "Δlast",   full: "last − last" },
  markRpDelta:       { label: "Δmark",   full: "mark − last" },
  // Moving average columns (--ma): time-weighted avg of Δindex over N seconds.
  ma1s:              { label: "ma1s",    full: "Δindex MA 1s" },
  ma3s:              { label: "ma3s",    full: "Δindex MA 3s" },
  ma5s:              { label: "ma5s",    full: "Δindex MA 5s" },
  ma10s:             { label: "ma10s",   full: "Δindex MA 10s" },
  ma15s:             { label: "ma15s",   full: "Δindex MA 15s" },
  ma30s:             { label: "ma30s",   full: "Δindex MA 30s" },
  ma60s:             { label: "ma60s",   full: "Δindex MA 60s" },
};

/** Header label for a response field (falls back to the raw field name). */
function colLabel(key: string): string {
  return COLUMNS[key]?.label ?? key;
}

/** Full variable name for a response field (falls back to the raw name). */
function colFull(key: string): string {
  return COLUMNS[key]?.full ?? key;
}

/**
 * Fixed display width for a column: the wider of its header label and the
 * value format's width, so columns sit tight — one space between the
 * numbers — while still lining up on every line.
 */
function colWidth(key: string): number {
  const label = visWidth(colLabel(key));
  if (key === "timestamp") return Math.max(label, 12); // HH:MM:SS.mmm
  if (key === "markRp") return Math.max(label, 6);
  if (key === "markRpDelta") return Math.max(label, 6);
  if (key === "dt") return Math.max(label, 12);
  // Cumulative counters can grow; everything else is a small price/delta.
  if (key === "volumeRq" || key === "turnoverRv" || key === "openInterestRv")
    return Math.max(label, 8);
  // MA columns: signed 8-decimal values (e.g. +0.06000000 = 11 chars).
  if (key.startsWith("ma")) return Math.max(label, 11);
  return Math.max(label, 5); // 2-decimal numbers: 84.00, +0.02
}

/**
 * Width of a string in terminal columns. Combining characters (such as the
 * macron in x̄) overprint the previous glyph and take no column of their own,
 * while the Greek capitals Δ and Σ render at single width (they are
 * ambiguous-width in East Asian terms but narrow in Western terminals), so
 * every other character takes exactly one column. This must be reflected
 * when a column is sized or padded, or the columns drift by one cell per
 * character.
 */
function visWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (ch >= "\u0300" && ch <= "\u036f") continue; // combining marks
    w++;
  }
  return w;
}

/** Right-pad a string to a fixed width so columns stay aligned. */
function padRight(s: string, w: number): string {
  const need = w - visWidth(s);
  return need <= 0 ? s : s + " ".repeat(need);
}

/** Left-pad a string to a fixed width (right-aligns numeric columns). */
function padLeft(s: string, w: number): string {
  const need = w - visWidth(s);
  return need <= 0 ? s : " ".repeat(need) + s;
}

/** Format a number with exactly DECIMALS decimals; dash when absent/invalid. */
function fmt(v: unknown, decimals = 2): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toFixed(decimals);
}

/**
 * Format a delta value with a sign so columns align: "+0.05", "-0.02",
 * " 0.00" (a space holds the sign position for zero). DECIMALS controls
 * the digits after the point (default 2).
 */
function fmtDelta(v: unknown, decimals = 2): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const s = n.toFixed(decimals);
  return n > 0 ? `+${s}` : n < 0 ? s : ` ${s}`;
}

/** Exact value (up to 8 decimals, trailing zeros stripped) — for file writes. */
function fmtExact(v: unknown): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Math.round(n * 1e8) / 1e8);
}

function tsToHMS(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Format a Phemex ticker timestamp (nanoseconds since epoch) as local time,
 * with milliseconds. */
function fmtTsLocal(v: unknown): string {
  const ns = Number(v);
  if (!Number.isFinite(ns)) return fmt(v);
  const d = new Date(Math.floor(ns / 1e6));
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Time-weighted moving average of Δindex over a given window (seconds).
 * Each sample's weight is the duration it was "active" (time until the next
 * sample, or until now for the most recent). Returns null when fewer than
 * 2 samples fall inside the window.
 */
function weightedMa(
  samples: Array<{ t: number; v: number }>,
  nowSec: number,
  windowSec: number,
): number | null {
  const cutoff = nowSec - windowSec;
  // Collect samples inside the window, including one just before the cutoff
  // so the first interval spans back to the boundary.
  const inside: Array<{ t: number; v: number }> = [];
  let before: { t: number; v: number } | null = null;
  for (const s of samples) {
    if (s.t >= cutoff) inside.push(s);
    else before = s; // last sample before the window
  }
  if (inside.length === 0) return null;
  // Need at least the boundary sample to form a weighted interval.
  if (inside.length === 1 && !before) return null;
  // Build intervals: first interval starts at max(cutoff, before.t).
  let sumW = 0;
  let sumWV = 0;
  for (let i = 0; i < inside.length; i++) {
    const start = i === 0
      ? (before ? Math.max(cutoff, before.t) : cutoff)
      : inside[i - 1].t;
    const end = inside[i].t;
    const dt = end - start;
    if (dt > 0) {
      sumW += dt;
      sumWV += inside[i].v * dt;
    }
  }
  // Final interval: from last sample to now.
  const lastT = inside[inside.length - 1].t;
  const tailDt = nowSec - lastT;
  if (tailDt > 0) {
    sumW += tailDt;
    sumWV += inside[inside.length - 1].v * tailDt;
  }
  return sumW > 0 ? sumWV / sumW : null;
}

/**
 * Print the per-minute summary right after the minute rolls over — but only
 * the lines enabled by --xbar and --sigma: the average price of each of the
 * five fields over the ticks of that minute (x̄), the cumulative absolute
 * movement Σ (sigma) — the sum of |current − previous| between consecutive
 * ticks, so oscillation counts as movement — and the per-second rate Σ/60
 * (movement per full 60-second minute). The enabled lines share one column
 * grid, so their columns line up.
 */
function printMinuteSummary(
  total: Map<string, number>,
  count: number,
  sum: Map<string, number>,
): void {
  const stamp = tsToHMS(Date.now());
  // One shared column width — the widest label and the widest value across
  // the enabled lines — so the x̄, Σ and Σ/Δt columns line up: labels start
  // at the same position and values end at the same right edge.
  const cells = SIG_FIELDS.map((f) => {
    const t = total.get(f);
    const v = sum.get(f);
    return {
      labelAvg: `x̄${colLabel(f)}`,
      labelMov: `Σ${colLabel(f)}`,
      labelRate: `Σ${colLabel(f)}/Δt`,
      // All lines share the same decimal count (5), so with the
      // right-aligned values below every decimal point lands in the same
      // column and the numbers line up vertically.
      avg: count > 0 && t != null ? fmt(t / count, 5) : "—",
      mov: fmt(v, 5),
      // Σ/60: per-second rate over a full 60-second minute.
      rate: v != null ? fmt(v / 60, 5) : "—",
    };
  });
  // Collect only the enabled summary lines.
  const lines: Array<Array<{ label: string; value: string }>> = [];
  if (SHOW_XBAR) lines.push(cells.map((c) => ({ label: c.labelAvg, value: c.avg })));
  if (SHOW_SIGMA) {
    lines.push(cells.map((c) => ({ label: c.labelMov, value: c.mov })));
    lines.push(cells.map((c) => ({ label: c.labelRate, value: c.rate })));
  }
  if (lines.length === 0) return;
  const wLabel = Math.max(...lines.flat().map((c) => visWidth(c.label)));
  const wValue = Math.max(...lines.flat().map((c) => c.value.length));
  for (const row of lines) {
    console.log(
      `[${stamp}] ${row.map((c) => `${padRight(c.label, wLabel)} ${padLeft(c.value, wValue)}`).join(" ")}`,
    );
  }
}

/** Pick the formatter for a response field: timestamps as local time,
 *  delta and MA columns with a sign prefix, Δt with 8 decimals. */
function fmtField(k: string, v: unknown): string {
  if (k === "timestamp") return fmtTsLocal(v);
  if (k === "dt") return fmtDelta(v, 8);
  if (k === "markRp") return fmt(v, 2);
  if (k.endsWith("Delta")) return fmtDelta(v, 2);
  if (k.startsWith("ma")) return fmtDelta(v, 8);
  return fmt(v);
}

/* ------------------------------------------------------------------ */
/*  WebSocket ticker extraction                                        */
/* ------------------------------------------------------------------ */

let cachedFields: string[] | null = null;

function extractTickers(data: Record<string, unknown>): Record<string, unknown>[] {
  if (IS_USDT_M) {
    if (data.symbol !== undefined && !SYMBOLS.includes(data.symbol as string)) return [];
    return [data];
  }
  // Coin-M: msg.market24h is the ticker object.
  const ticker = data as Record<string, unknown>;
  const sym = String(ticker.symbol ?? "");
  if (!SYMBOLS.includes(sym)) return [];
  return [ticker];
}

function handleMessage(msg: Record<string, unknown>): Record<string, unknown>[] {
  // USDT-M: single-symbol push.
  if (msg.method === "market24h_p.update" && msg.data) {
    return extractTickers(msg.data as Record<string, unknown>);
  }
  // USDT-M: pack update (batch) — filter to our symbols.
  if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
    if (Array.isArray(msg.fields)) {
      cachedFields = msg.fields as string[];
    }
    if (!cachedFields) return [];
    const result: Record<string, unknown>[] = [];
    for (const row of msg.data as unknown[][]) {
      if (row.length < 1) continue;
      const sym = String(row[0]);
      if (!SYMBOLS.includes(sym)) continue;
      const ticker = findSymbolRow([row], cachedFields, sym);
      if (ticker) result.push(ticker);
    }
    return result;
  }
  // Coin-M: market24h push.
  if (msg.market24h) {
    return extractTickers(msg);
  }
  return [];
}

/* ------------------------------------------------------------------ */
/*  Main — WebSocket                                                    */
/* ------------------------------------------------------------------ */

let legendPrinted = false;
let lastHeaderMinute = -1;
const widths = new Map<string, number>();

// Per-symbol state for MA, sigma/xbar, and Δt tracking.
const symbolState = new Map<string, {
  lastSig: string;
  prevTs: number | null;
  maSamples: Array<{ t: number; v: number }>;
  cumTotal: Map<string, number>;
  cumCount: number;
  cumSum: Map<string, number>;
  cumPrev: Map<string, number>;
  cumMinute: number;
}>();

function getSymbolState(sym: string) {
  let s = symbolState.get(sym);
  if (!s) {
    s = {
      lastSig: "",
      prevTs: null,
      maSamples: [],
      cumTotal: new Map(),
      cumCount: 0,
      cumSum: new Map(),
      cumPrev: new Map(),
      cumMinute: -1,
    };
    symbolState.set(sym, s);
  }
  return s;
}

function processTicker(data: Record<string, unknown>): void {
  const sym = data.symbol as string;
  const state = getSymbolState(sym);
  // Compute Δindex and Δt internally always (needed by --ma).
  const last = Number(data.lastRp);
  const indexRp = Number(data.indexRp);
  const idxDelta = Number.isFinite(indexRp) && Number.isFinite(last)
    ? indexRp - last : NaN;

  const tickerTs = Number(data.timestamp);
  const tsValid = Number.isFinite(tickerTs) && tickerTs > 0;
  let dtSec: number | null = null;
  if (tsValid && state.prevTs != null) {
    const tNow = tickerTs / 1e9;
    const dt = tNow - state.prevTs;
    dtSec = dt > 0 ? dt : 0;
  }
  if (tsValid) {
    state.prevTs = tickerTs / 1e9;
  }

  // --delta: append Δ columns for display.
  if (DELTA) {
    for (const f of DELTA_FIELDS) {
      const v = Number(data[f]);
      data[`${f}Delta`] =
        Number.isFinite(v) && Number.isFinite(last) ? v - last : null;
    }
    data.dt = dtSec;
  }

  // --ma: time-weighted moving average of Δindex over each window.
  if (SHOW_MA) {
    if (tsValid && Number.isFinite(idxDelta)) {
      const tSec = tickerTs / 1e9;
      state.maSamples.push({ t: tSec, v: idxDelta });
      const maxWindow = MA_WINDOWS[MA_WINDOWS.length - 1];
      while (state.maSamples.length > 0 && state.maSamples[0].t < tSec - maxWindow - 1) {
        state.maSamples.shift();
      }
      for (const w of MA_WINDOWS) {
        data[`ma${w}s`] = weightedMa(state.maSamples, tSec, w);
      }
    }
  }

  // Σ (sigma) and x̄ (--xbar / --sigma).
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  if (SHOW_XBAR || SHOW_SIGMA) {
    if (minute !== state.cumMinute) {
      if (state.cumMinute >= 0) printMinuteSummary(state.cumTotal, state.cumCount, state.cumSum);
      state.cumMinute = minute;
      state.cumTotal.clear();
      state.cumCount = 0;
      state.cumSum.clear();
    }
    let sampled = false;
    for (const f of SIG_FIELDS) {
      const v = Number(data[f]);
      if (Number.isFinite(v)) {
        sampled = true;
        state.cumTotal.set(f, (state.cumTotal.get(f) ?? 0) + v);
      }
      if (state.cumPrev.has(f) && Number.isFinite(v)) {
        const pv = Number(state.cumPrev.get(f));
        if (Number.isFinite(pv)) {
          state.cumSum.set(f, (state.cumSum.get(f) ?? 0) + Math.abs(v - pv));
        }
      }
      state.cumPrev.set(f, v);
    }
    if (sampled) state.cumCount++;
  }

  const keys = Object.keys(data)
    .filter((k) => !hasFlag("--concise") || !CONCISE_HIDDEN.has(k))
    .sort(
      (a, b) =>
        (COLUMN_RANK.get(a) ?? COLUMN_ORDER.length) -
        (COLUMN_RANK.get(b) ?? COLUMN_ORDER.length),
    );

  if (widths.size === 0) {
    for (const k of keys) {
      widths.set(k, colWidth(k));
    }
  }

  if (!legendPrinted) {
    console.log(
      "Columns: " +
        keys
          .map((k) => `${colLabel(k)}=${colFull(k)}`)
          .join(", "),
    );
    legendPrinted = true;
  }

  if (STORE) {
    const files = getSymbolFiles(sym);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(files.ask, fmtExact(data.askRp), "utf8");
    fs.writeFileSync(files.bid, fmtExact(data.bidRp), "utf8");

    const idx = Number(data.indexRp);
    const ltp = Number(data.lastRp);
    const mkr = Number(data.markRp);
    fs.writeFileSync(files.index, fmtExact(idx), "utf8");
    fs.writeFileSync(files.indexLast, fmtExact(Number.isFinite(idx) && Number.isFinite(ltp) ? idx - ltp : null), "utf8");
    fs.writeFileSync(files.last, fmtExact(ltp), "utf8");
    fs.writeFileSync(files.mark, fmtExact(mkr), "utf8");
    fs.writeFileSync(files.markLast, fmtExact(Number.isFinite(mkr) && Number.isFinite(ltp) ? mkr - ltp : null), "utf8");
  }

  if (CSV_FILE) appendCsvRow(CSV_FILE, data);

  const sig = SIG_FIELDS.map((k) => `${k}=${data[k]}`).join("|");
  const changed = sig !== state.lastSig;
  state.lastSig = sig;

  if (changed) {
    for (const k of keys) {
      const valStr = fmtField(k, data[k]);
      const cur = widths.get(k) ?? colWidth(k);
      widths.set(k, Math.max(cur, visWidth(valStr), visWidth(colLabel(k))));
    }

    if (minute !== lastHeaderMinute) {
      lastHeaderMinute = minute;
      const head = keys
        .map((k) => {
          const rightAlign = k !== "timestamp" && k !== "symbol";
          return rightAlign
            ? padLeft(colLabel(k), widths.get(k)!)
            : padRight(colLabel(k), widths.get(k)!);
        })
        .join(" ");
      console.log(`[${tsToHMS(now)}] ${head}`);
    }

    const line = keys
      .map((k) => {
        const s = fmtField(k, data[k]);
        const rightAlign = k !== "timestamp" && k !== "symbol";
        return rightAlign
          ? padLeft(s, widths.get(k)!)
          : padRight(s, widths.get(k)!);
      })
      .join(" ");
    console.log(`[${tsToHMS(Date.now())}] ${line}`);
  }
}

const type = IS_USDT_M ? "USDT-M" : "Coin-M";
console.log(`⟐  Connecting to ${WS_URL} (${type}) — tracking ${SYMBOLS.join(", ")} …`);

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    if (IS_USDT_M) {
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
    } else {
      ws.send({ method: "market24h.subscribe", params: SYMBOLS, id: 1 });
    }
  },
  onMessage: (msg) => {
    const tickers = handleMessage(msg);
    for (const data of tickers) {
      processTicker(data);
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
    for (const s of symbolState.values()) {
      s.lastSig = "";
    }
    cachedFields = null;
  },
});

ws.connect();
