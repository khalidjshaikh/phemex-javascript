#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * xau-il-sigma.ts — Track XAUUSDT I-L (index − last) with per-minute Σ|I−L|.
 *
 * Every tick prints:
 *   [HH:MM:SS.mmm] I-L=<value>  Σ|I−L|=<cumulative>
 *
 * At minute boundaries the Σ|I−L| is finalized and a summary line is printed,
 * then the counter resets for the next minute.
 *
 * Usage:
 *   npx tsx xau-il-sigma.ts
 *   npx tsx xau-il-sigma.ts --decimals 4
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { ReconnectingWs } from "../src/ws-client.js";
import { hasFlag } from "../src/cli-utils.js";

const USAGE = `Usage: npx tsx xau-il-sigma.ts [options]

Track XAUUSDT I-L (index − last) with per-minute and per-hour Σ(I−L) summaries.

Options:
  --decimals <N>  Decimal places for display (default: 4)
  --quiet         Suppress per-tick output, show only minute/hour summaries
  --no-ticker     Suppress per-tick output (same as --quiet)
  --no-minute     Suppress per-minute summary reports
  --noIL          Hide I-L cumulative columns (avg(I−L), Σ(I−L), Σ(I−L)>0, Σ(I−L)<0, sign changes)
  --help          Show this help and exit

Output columns:
  I       = index price
  ΔI      = index tick delta
  L       = last (mark) price
  ΔL      = last tick delta
  I-L     = index − last
  Δ(I-L)  = change in I-L from previous tick
  Σ(I−L)  = cumulative I-L within the minute

Per-minute / per-hour summaries include:
  Σ(I−L)>0  Σ(I−L)<0   positive/negative I-L sums
  ΣΔL>0     ΣΔL<0      positive/negative ΔL sums
`;

if (hasFlag("--help")) { console.log(USAGE); process.exit(0); }
const QUIET = hasFlag("--quiet") || hasFlag("--no-ticker");
const NO_MINUTE = hasFlag("--no-minute");
const NO_IL = hasFlag("--noIL");

const DECIMALS = Number(hasFlag("--decimals") ? process.argv[process.argv.indexOf("--decimals") + 1] : 4);
const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "XAUUSDT";

/* ── Persistence ── */

const DATA_DIR = join(process.cwd(), "data");
const HOURS_FILE = join(DATA_DIR, "xau-il-sigma-hours.jsonl");

interface HourRecord {
  date: string;
  hour: number;
  clockHour: number;
  ticks: number;
  sigma: number;
  sigmaPos: number;
  sigmaNeg: number;
  avgIl: number;
  deltas: number;
  deltaSum: number;
  avgDelta: number;
  deltaL: number;
  deltaLPos: number;
  deltaLNeg: number;
  deltaLCount: number;
  deltaLPosCount: number;
  deltaLNegCount: number;
  signChanges: number;
  priceChange: number;
}

function loadHours(): HourRecord[] {
  if (!existsSync(HOURS_FILE)) return [];
  try {
    return readFileSync(HOURS_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function saveHour(rec: HourRecord): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(HOURS_FILE, JSON.stringify(rec) + "\n");
}

function upsertHour(rec: HourRecord): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(HOURS_FILE)) {
    const lines = readFileSync(HOURS_FILE, "utf8").split("\n").filter(Boolean);
    if (lines.length > 0) {
      const last: HourRecord = JSON.parse(lines[lines.length - 1]);
      if (last.clockHour === rec.clockHour && last.date === rec.date) {
        lines[lines.length - 1] = JSON.stringify(rec);
        writeFileSync(HOURS_FILE, lines.join("\n") + "\n");
        return;
      }
    }
  }
  appendFileSync(HOURS_FILE, JSON.stringify(rec) + "\n");
}

function loadLastHour(): HourRecord | null {
  const hours = loadHours();
  return hours.length > 0 ? hours[hours.length - 1] : null;
}

/* ── Helpers ── */

function tsToHMS(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function fmtPrice(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(DECIMALS);
}

function fmtDelta(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const s = n.toFixed(DECIMALS);
  return n > 0 ? `+${s}` : n < 0 ? s : ` ${s}`;
}

function fmtSigma(v: number): string {
  return v.toFixed(DECIMALS);
}

function padL(s: string, w: number): string {
  const need = w - s.length;
  return need <= 0 ? s : " ".repeat(need) + s;
}

const W_IL = 9;   // price column width
const W_DL = 9;   // delta column width
const W_SG = 11;  // sigma column width

function localHour(): number { const d = new Date(); return d.getHours(); }
function localMinute(): number { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

/* ── Per-minute state ── */

let cumSigma = 0;
let cumSigmaPos = 0;
let cumSigmaNeg = 0;
let currentMinute = -1;
let tickCount = 0;
let prevIl: number | null = null;
let prevLast: number | null = null;
let prevIndex: number | null = null;
let cumDelta = 0;
let deltaCount = 0;
let cumDeltaL = 0;
let cumDeltaLPos = 0;
let cumDeltaLNeg = 0;
let cumDeltaLCount = 0;
let cumDeltaLPosCount = 0;
let cumDeltaLNegCount = 0;
let minuteSignChanges = 0;
let prevSign: "pos" | "neg" | "zero" | null = null;
let tickHeaderPrinted = false;
let hourSignChanges = 0;
let hourTicks = 0;
let hourSigma = 0;
let hourSigmaPos = 0;
let hourSigmaNeg = 0;
let hourDeltaSum = 0;
let hourDeltaL = 0;
let hourDeltaLPos = 0;
let hourDeltaLNeg = 0;
let hourDeltaLCount = 0;
let hourDeltaLPosCount = 0;
let hourDeltaLNegCount = 0;
let hourDeltaCount = 0;
let currentHour = -1;
let hourFirstLast: number | null = null;
let hourLastLast: number | null = null;

function resetMinute(minute: number): void {
  currentMinute = minute;
  cumSigma = 0;
  cumSigmaPos = 0;
  cumSigmaNeg = 0;
  tickCount = 0;
  prevIl = null;
  prevLast = null;
  prevIndex = null;
  cumDelta = 0;
  cumDeltaL = 0;
  cumDeltaLPos = 0;
  cumDeltaLNeg = 0;
  cumDeltaLCount = 0;
  cumDeltaLPosCount = 0;
  cumDeltaLNegCount = 0;
  deltaCount = 0;
  minuteSignChanges = 0;
  prevSign = null;
}

function fmtHour(v: number): string {
  return String(v).padStart(2, "0");
}

function padR(s: string, w: number): string {
  const need = w - s.length;
  return need <= 0 ? s : s + " ".repeat(need);
}

function fmtDate(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function fmtHourLine(label: string, h: { date?: string; clockHour: number; ticks: number; avgIl: number; sigma: number; sigmaPos?: number; sigmaNeg?: number; deltaL: number; deltaLPos?: number; deltaLNeg?: number; deltaLCount?: number; deltaLPosCount?: number; deltaLNegCount?: number; signChanges: number; priceChange?: number }): string {
  const dt = h.date ?? "";
  const hr = fmtHour(h.clockHour);
  const ticks = String(h.ticks);
  const dl = fmtDelta(h.deltaL);
  const dlP = fmtDelta(h.deltaLPos ?? 0);
  const dlN = fmtDelta(h.deltaLNeg ?? 0);
  const dlCnt = String(h.deltaLCount ?? 0);
  const dlPCnt = String(h.deltaLPosCount ?? 0);
  const dlNCnt = String(h.deltaLNegCount ?? 0);
  const pc = h.priceChange != null ? fmtDelta(h.priceChange) : "—";
  if (NO_IL) {
    return `${label} ${padR(dt, 10)} ${padR(hr, 8)} ${padR(ticks, 5)} ${padR(dl, 10)} ${padR(dlP, 10)} ${padR(dlN, 10)} ${padR(dlCnt, 8)} ${padR(dlPCnt, 8)} ${padR(dlNCnt, 8)} ${padR(pc, 10)}`;
  }
  const avg = h.ticks > 0 ? fmtSigma(h.avgIl) : "—";
  const sig = fmtSigma(h.sigma);
  const sigP = fmtSigma(h.sigmaPos ?? 0);
  const sigN = fmtSigma(h.sigmaNeg ?? 0);
  const sc = String(h.signChanges);
  return `${label} ${padR(dt, 10)} ${padR(hr, 8)} ${padR(ticks, 5)} ${padR(avg, 10)} ${padR(sig, 12)} ${padR(sigP, 12)} ${padR(sigN, 12)} ${padR(dl, 10)} ${padR(dlP, 10)} ${padR(dlN, 10)} ${padR(dlCnt, 8)} ${padR(dlPCnt, 8)} ${padR(dlNCnt, 8)} ${padR(sc, 4)} ${padR(pc, 10)}`;
}

const HOUR_HEADER = NO_IL
  ? `  ${padR("date", 10)} ${padR("hour", 8)} ${padR("ticks", 5)} ${padR("ΣΔL", 10)} ${padR("ΣΔL>0", 10)} ${padR("ΣΔL<0", 10)} ${padR("#ΔL/h", 8)} ${padR("#ΔL+", 8)} ${padR("#ΔL-", 8)} ${padR("ΔL(h)", 10)}`
  : `  ${padR("date", 10)} ${padR("hour", 8)} ${padR("ticks", 5)} ${padR("avg(I−L)", 10)} ${padR("Σ(I−L)", 12)} ${padR("Σ(I−L)>0", 12)} ${padR("Σ(I−L)<0", 12)} ${padR("ΣΔL", 10)} ${padR("ΣΔL>0", 10)} ${padR("ΣΔL<0", 10)} ${padR("#ΔL/h", 8)} ${padR("#ΔL+", 8)} ${padR("#ΔL-", 8)} ${padR("sign", 4)} ${padR("ΔL(h)", 10)}`;
const HOUR_SEP = `  ${padR("", 10)} ${padR("", 8)} ${padR("", 5)} ${padR("", 10)} ${padR("", 12)} ${padR("", 12)} ${padR("", 12)} ${padR("", 10)} ${padR("", 10)} ${padR("", 10)} ${padR("", 8)} ${padR("", 8)} ${padR("", 8)}`;

/* ── WebSocket message handling ── */

let cachedFields: string[] | null = null;

function extractTicker(data: Record<string, unknown>): Record<string, unknown> | null {
  if (data.symbol === SYMBOL) return data;
  return null;
}

function handleMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  // USDT-M single-symbol push
  if (msg.method === "market24h_p.update" && msg.data) {
    return extractTicker(msg.data as Record<string, unknown>);
  }
  // USDT-M pack update (batch)
  if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
    if (Array.isArray(msg.fields)) cachedFields = msg.fields as string[];
    if (!cachedFields) return null;
    for (const row of msg.data as unknown[][]) {
      if (row.length < 1) continue;
      if (String(row[0]) !== SYMBOL) continue;
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cachedFields.length && i < row.length; i++) {
        obj[cachedFields[i]] = row[i];
      }
      return obj;
    }
    return null;
  }
  // Coin-M
  if (msg.market24h) {
    const ticker = msg as Record<string, unknown>;
    if (String(ticker.symbol) === SYMBOL) return ticker;
  }
  return null;
}

/* ── Main ── */

const nodeVersion = process.version;
console.log(`Node: ${nodeVersion}`);
console.log(`⟐  Connecting to ${WS_URL} — tracking ${SYMBOL} …`);
console.log(`   Decimals: ${DECIMALS}`);
console.log();

// Print past hours from persistence
const nowHour = localHour();
const pastHours = loadHours();
const lastHour = loadLastHour();
const pastCompleted = pastHours.filter((h) => h.clockHour !== nowHour);
const inProgress = lastHour && lastHour.clockHour === nowHour ? lastHour : null;

if (pastCompleted.length > 0 || inProgress) {
  console.log(`  ── past hours (${pastCompleted.length})${inProgress ? " + hour in progress" : ""} ──`);
  console.log(HOUR_HEADER);
  for (const h of pastCompleted) {
    console.log(fmtHourLine("  ", h));
  }
  if (inProgress) {
    console.log(fmtHourLine("⟳ ", inProgress));
  }
  console.log();
}

// Restore last hour state if we're still in the same hour
if (inProgress) {
  hourTicks = inProgress.ticks;
  hourSigma = inProgress.sigma;
  hourSigmaPos = inProgress.sigmaPos ?? 0;
  hourSigmaNeg = inProgress.sigmaNeg ?? 0;
  hourDeltaCount = inProgress.deltas;
  hourDeltaSum = inProgress.deltaSum;
  hourDeltaL = inProgress.deltaL;
  hourDeltaLPos = inProgress.deltaLPos ?? 0;
  hourDeltaLNeg = inProgress.deltaLNeg ?? 0;
  hourDeltaLCount = inProgress.deltaLCount ?? 0;
  hourDeltaLPosCount = inProgress.deltaLPosCount ?? 0;
  hourDeltaLNegCount = inProgress.deltaLNegCount ?? 0;
  hourSignChanges = inProgress.signChanges;
  currentHour = inProgress.clockHour;
  currentMinute = localMinute();
  hourFirstLast = null;  // Will be set on next tick
  hourLastLast = null;
}

const TICK_HEADER = NO_IL
  ? `[             ]  ${padL("L", W_IL)}  ${padL("ΔL", W_DL)}  ${padL("ΣΔL", W_SG)}  ${padL("ΣΔL+", W_SG)}  ${padL("ΣΔL-", W_SG)}  ${padL("#ΔL/h", 8)}  ${padL("#ΔL+", 8)}  ${padL("#ΔL-", 8)}  ${padL("ΔL(h)", W_SG)}`
  : `[             ]  ${padL("I", W_IL)}  ${padL("ΔI", W_DL)}  ${padL("L", W_IL)}  ${padL("ΔL", W_DL)}  ${padL("I-L", W_IL)}  ${padL("Δ(I-L)", W_DL)}  ${padL("Σ(I−L)", W_SG)}  ${padL("Σ+", W_SG)}  ${padL("Σ-", W_SG)}  ${padL("ΣΔL", W_SG)}  ${padL("ΣΔL+", W_SG)}  ${padL("ΣΔL-", W_SG)}  ${padL("#ΔL/h", 8)}  ${padL("#ΔL+", 8)}  ${padL("#ΔL-", 8)}  ${padL("chgs", 4)}  ${padL("ΔL(h)", W_SG)}`;

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
  },
  onMessage: (msg) => {
    const ticker = handleMessage(msg);
    if (!ticker) return;

    const index = Number(ticker.indexRp);
    const last = Number(ticker.lastRp);
    if (!Number.isFinite(index) || !Number.isFinite(last)) return;

    const iMinusL = index - last;
    const now = Date.now();
    const minute = localMinute();

    // Minute rollover: print summary, then reset
    if (currentMinute >= 0 && minute !== currentMinute) {
      if (!NO_MINUTE) {
        console.log(`\n  ── minute ${String(currentMinute % 60).padStart(2, "0")} end ──`);
        if (NO_IL) {
          console.log(`  ticks: ${tickCount}  ΣΔL: ${fmtDelta(cumDeltaL)}  ΣΔL>0: ${fmtDelta(cumDeltaLPos)}  ΣΔL<0: ${fmtDelta(cumDeltaLNeg)}  #ΔL: ${cumDeltaLCount}  #ΔL+: ${cumDeltaLPosCount}  #ΔL-: ${cumDeltaLNegCount}`);
        } else {
          console.log(`  ticks: ${tickCount}  avg(I−L): ${tickCount > 0 ? fmtSigma(cumSigma / tickCount) : "—"}  Σ(I−L): ${fmtSigma(cumSigma)}  Σ(I−L)>0: ${fmtSigma(cumSigmaPos)}  Σ(I−L)<0: ${fmtSigma(cumSigmaNeg)}  ΣΔL: ${fmtDelta(cumDeltaL)}  ΣΔL>0: ${fmtDelta(cumDeltaLPos)}  ΣΔL<0: ${fmtDelta(cumDeltaLNeg)}  #ΔL: ${cumDeltaLCount}  #ΔL+: ${cumDeltaLPosCount}  #ΔL-: ${cumDeltaLNegCount}  sign changes: ${minuteSignChanges}`);
        }
        console.log();
      }
      tickHeaderPrinted = false;

      // Hour rollover
      const hour = localHour();
      if (currentHour >= 0 && hour !== currentHour) {
        console.log(`  ═══ hour ${fmtHour(currentHour % 24)} end ═══`);
        console.log(HOUR_HEADER);
        console.log(fmtHourLine("  ", {
          date: fmtDate(new Date()),
          clockHour: currentHour % 24,
          ticks: hourTicks,
          avgIl: hourTicks > 0 ? hourSigma / hourTicks : 0,
          sigma: hourSigma,
          sigmaPos: hourSigmaPos,
          sigmaNeg: hourSigmaNeg,
          deltaL: hourDeltaL,
          deltaLPos: hourDeltaLPos,
          deltaLNeg: hourDeltaLNeg,
          signChanges: hourSignChanges,
        }));
        console.log();

        upsertHour({
          date: fmtDate(new Date()),
          hour: currentHour,
          clockHour: currentHour,
          ticks: hourTicks,
          sigma: hourSigma,
          sigmaPos: hourSigmaPos,
          sigmaNeg: hourSigmaNeg,
          avgIl: hourTicks > 0 ? hourSigma / hourTicks : 0,
          deltas: hourDeltaCount,
          deltaSum: hourDeltaSum,
          avgDelta: hourDeltaCount > 0 ? hourDeltaSum / hourDeltaCount : 0,
          deltaL: hourDeltaL,
          deltaLPos: hourDeltaLPos,
          deltaLNeg: hourDeltaLNeg,
          deltaLCount: hourDeltaLCount,
          deltaLPosCount: hourDeltaLPosCount,
          deltaLNegCount: hourDeltaLNegCount,
          signChanges: hourSignChanges,
          priceChange: hourLastLast != null && hourFirstLast != null ? hourLastLast - hourFirstLast : 0,
        });

        hourSignChanges = 0;
        hourTicks = 0;
        hourSigma = 0;
        hourSigmaPos = 0;
        hourSigmaNeg = 0;
        hourDeltaSum = 0;
        hourDeltaL = 0;
        hourDeltaLPos = 0;
        hourDeltaLNeg = 0;
        hourDeltaLCount = 0;
        hourDeltaLPosCount = 0;
        hourDeltaLNegCount = 0;
        hourDeltaCount = 0;
        hourFirstLast = null;
        hourLastLast = null;
      }
      currentHour = hour;
    }

    // Start new minute
    if (minute !== currentMinute) resetMinute(minute);

    // Detect sign change
    const curSign: "pos" | "neg" | "zero" = iMinusL > 0 ? "pos" : iMinusL < 0 ? "neg" : "zero";
    if (prevSign !== null && curSign !== "zero" && prevSign !== "zero" && curSign !== prevSign) {
      minuteSignChanges++;
      hourSignChanges++;
    }
    if (curSign !== "zero") prevSign = curSign;

    cumSigma += iMinusL;
    if (iMinusL > 0) cumSigmaPos += iMinusL;
    else if (iMinusL < 0) cumSigmaNeg += iMinusL;
    tickCount++;
    hourTicks++;
    hourSigma += iMinusL;
    if (iMinusL > 0) hourSigmaPos += iMinusL;
    else if (iMinusL < 0) hourSigmaNeg += iMinusL;
    if (hourFirstLast === null) hourFirstLast = last;
    hourLastLast = last;

    const deltaIl = prevIl !== null ? iMinusL - prevIl : null;
    prevIl = iMinusL;
    const deltaLast = prevLast !== null ? last - prevLast : null;
    prevLast = last;
    const deltaIndex = prevIndex !== null ? index - prevIndex : null;
    prevIndex = index;
    if (deltaIl !== null) {
      cumDelta += deltaIl;
      deltaCount++;
      hourDeltaSum += deltaIl;
      hourDeltaCount++;
    }
    if (deltaLast !== null) {
      cumDeltaL += deltaLast;
      if (deltaLast > 0) {
        cumDeltaLPos += deltaLast;
        cumDeltaLPosCount++;
      } else if (deltaLast < 0) {
        cumDeltaLNeg += deltaLast;
        cumDeltaLNegCount++;
      }
      if (deltaLast !== 0) cumDeltaLCount++;
      hourDeltaL += deltaLast;
      if (deltaLast > 0) {
        hourDeltaLPos += deltaLast;
        hourDeltaLPosCount++;
      } else if (deltaLast < 0) {
        hourDeltaLNeg += deltaLast;
        hourDeltaLNegCount++;
      }
      if (deltaLast !== 0) hourDeltaLCount++;
    }

    if (!QUIET) {
      if (!tickHeaderPrinted) {
        console.log(TICK_HEADER);
        tickHeaderPrinted = true;
      }
      console.log(
        NO_IL
          ? `[${tsToHMS(now)}]  ${padL(fmtPrice(last), W_IL)}  ${padL(fmtDelta(deltaLast), W_DL)}  ${padL(fmtDelta(cumDeltaL), W_SG)}  ${padL(fmtDelta(cumDeltaLPos), W_SG)}  ${padL(fmtDelta(cumDeltaLNeg), W_SG)}  ${padL(String(hourDeltaLCount), 8)}  ${padL(String(hourDeltaLPosCount), 8)}  ${padL(String(hourDeltaLNegCount), 8)}  ${padL(hourLastLast != null && hourFirstLast != null ? fmtDelta(hourLastLast - hourFirstLast) : "—", W_SG)}`
          : `[${tsToHMS(now)}]  ${padL(fmtPrice(index), W_IL)}  ${padL(fmtDelta(deltaIndex), W_DL)}  ${padL(fmtPrice(last), W_IL)}  ${padL(fmtDelta(deltaLast), W_DL)}  ${padL(fmtDelta(iMinusL), W_IL)}  ${padL(fmtDelta(deltaIl), W_DL)}  ${padL(fmtSigma(cumSigma), W_SG)}  ${padL(fmtSigma(cumSigmaPos), W_SG)}  ${padL(fmtSigma(cumSigmaNeg), W_SG)}  ${padL(fmtDelta(cumDeltaL), W_SG)}  ${padL(fmtDelta(cumDeltaLPos), W_SG)}  ${padL(fmtDelta(cumDeltaLNeg), W_SG)}  ${padL(String(hourDeltaLCount), 8)}  ${padL(String(hourDeltaLPosCount), 8)}  ${padL(String(hourDeltaLNegCount), 8)}  ${padL(String(minuteSignChanges), 4)}  ${padL(hourLastLast != null && hourFirstLast != null ? fmtDelta(hourLastLast - hourFirstLast) : "—", W_SG)}`,
      );
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
    prevIl = null;
    prevLast = null;
    prevIndex = null;
    prevSign = null;
    resetMinute(currentMinute);
  },
});

ws.connect();

/* ── Periodic save every 60s ── */

setInterval(() => {
  if (hourTicks === 0) return;
  upsertHour({
    date: fmtDate(new Date()),
    hour: localHour(),
    clockHour: localHour(),
    ticks: hourTicks,
    sigma: hourSigma,
    sigmaPos: hourSigmaPos,
    sigmaNeg: hourSigmaNeg,
    avgIl: hourTicks > 0 ? hourSigma / hourTicks : 0,
    deltas: hourDeltaCount,
    deltaSum: hourDeltaSum,
    avgDelta: hourDeltaCount > 0 ? hourDeltaSum / hourDeltaCount : 0,
    deltaL: hourDeltaL,
    deltaLPos: hourDeltaLPos,
    deltaLNeg: hourDeltaLNeg,
    deltaLCount: hourDeltaLCount,
    deltaLPosCount: hourDeltaLPosCount,
    deltaLNegCount: hourDeltaLNegCount,
    signChanges: hourSignChanges,
    priceChange: hourLastLast != null && hourFirstLast != null ? hourLastLast - hourFirstLast : 0,
  });
}, 60_000);

/* ── Save on exit ── */

function saveCurrentHour(): void {
  if (hourTicks === 0) return;
  console.log(`\n  ⟐  Saving partial hour ${fmtHour(localHour())} (${hourTicks} ticks) …`);
  upsertHour({
    date: fmtDate(new Date()),
    hour: localHour(),
    clockHour: localHour(),
    ticks: hourTicks,
    sigma: hourSigma,
    sigmaPos: hourSigmaPos,
    sigmaNeg: hourSigmaNeg,
    avgIl: hourTicks > 0 ? hourSigma / hourTicks : 0,
    deltas: hourDeltaCount,
    deltaSum: hourDeltaSum,
    avgDelta: hourDeltaCount > 0 ? hourDeltaSum / hourDeltaCount : 0,
    deltaL: hourDeltaL,
    deltaLPos: hourDeltaLPos,
    deltaLNeg: hourDeltaLNeg,
    deltaLCount: hourDeltaLCount,
    deltaLPosCount: hourDeltaLPosCount,
    deltaLNegCount: hourDeltaLNegCount,
    signChanges: hourSignChanges,
    priceChange: hourLastLast != null && hourFirstLast != null ? hourLastLast - hourFirstLast : 0,
  });
}

process.on("SIGINT", () => { saveCurrentHour(); process.exit(0); });
process.on("SIGTERM", () => { saveCurrentHour(); process.exit(0); });
