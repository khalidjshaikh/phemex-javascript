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

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
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
  --help          Show this help and exit

Output columns:
  I       = index price
  ΔI      = index tick delta
  L       = last (mark) price
  ΔL      = last tick delta
  I-L     = index − last
  Δ       = change in I-L from previous tick
  Σ(I−L)  = cumulative I-L within the minute

Per-minute / per-hour summaries include:
  Σ(I−L)>0  Σ(I−L)<0   positive/negative I-L sums
  ΣΔL>0     ΣΔL<0      positive/negative ΔL sums
`;

if (hasFlag("--help")) { console.log(USAGE); process.exit(0); }
const QUIET = hasFlag("--quiet") || hasFlag("--no-ticker");
const NO_MINUTE = hasFlag("--no-minute");

const DECIMALS = Number(hasFlag("--decimals") ? process.argv[process.argv.indexOf("--decimals") + 1] : 4);
const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "XAUUSDT";

/* ── Persistence ── */

const DATA_DIR = join(process.cwd(), "data");
const HOURS_FILE = join(DATA_DIR, "xau-il-sigma-hours.jsonl");

interface HourRecord {
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
  signChanges: number;
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

const W_IL = DECIMALS + 5;   // sign + digits + dot + decimals
const W_DL = DECIMALS + 4;   // sign + digits + dot + decimals
const W_SG = DECIMALS + 7;   // sign + digits + dot + decimals

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
let minuteSignChanges = 0;
let prevSign: "pos" | "neg" | "zero" | null = null;
let hourSignChanges = 0;
let hourTicks = 0;
let hourSigma = 0;
let hourSigmaPos = 0;
let hourSigmaNeg = 0;
let hourDeltaSum = 0;
let hourDeltaL = 0;
let hourDeltaLPos = 0;
let hourDeltaLNeg = 0;
let hourDeltaCount = 0;
let currentHour = -1;

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

function fmtHourLine(label: string, h: { clockHour: number; ticks: number; avgIl: number; sigma: number; sigmaPos?: number; sigmaNeg?: number; deltaL: number; deltaLPos?: number; deltaLNeg?: number; signChanges: number }): string {
  const hr = `hour ${fmtHour(h.clockHour)}`;
  const ticks = String(h.ticks);
  const avg = h.ticks > 0 ? fmtSigma(h.avgIl) : "—";
  const sig = fmtSigma(h.sigma);
  const sigP = fmtSigma(h.sigmaPos ?? 0);
  const sigN = fmtSigma(h.sigmaNeg ?? 0);
  const dl = fmtDelta(h.deltaL);
  const dlP = fmtDelta(h.deltaLPos ?? 0);
  const dlN = fmtDelta(h.deltaLNeg ?? 0);
  const sc = String(h.signChanges);
  return `${label} ${padR(hr, 8)} ${padR(ticks, 5)} ${padR(avg, 10)} ${padR(sig, 12)} ${padR(sigP, 12)} ${padR(sigN, 12)} ${padR(dl, 10)} ${padR(dlP, 10)} ${padR(dlN, 10)} ${padR(sc, 4)}`;
}

const HOUR_HEADER = `  ${padR("hour", 8)} ${padR("ticks", 5)} ${padR("avg(I−L)", 10)} ${padR("Σ(I−L)", 12)} ${padR("Σ(I−L)>0", 12)} ${padR("Σ(I−L)<0", 12)} ${padR("ΣΔL", 10)} ${padR("ΣΔL>0", 10)} ${padR("ΣΔL<0", 10)} ${padR("sign", 4)}`;
const HOUR_SEP = `  ${padR("", 8)} ${padR("", 5)} ${padR("", 10)} ${padR("", 12)} ${padR("", 12)} ${padR("", 12)} ${padR("", 10)} ${padR("", 10)} ${padR("", 10)} ${padR("chgs", 4)}`;

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
const pastHours = loadHours();
if (pastHours.length > 0) {
  console.log(`  ── past hours (${pastHours.length}) ──`);
  console.log(HOUR_HEADER);
  for (const h of pastHours) {
    console.log(fmtHourLine("  ", h));
  }
  console.log();
}

// Restore last hour state if we're still in the same hour
const lastHour = loadLastHour();
const nowHour = localHour();
if (lastHour && lastHour.clockHour === nowHour) {
  hourTicks = lastHour.ticks;
  hourSigma = lastHour.sigma;
  hourSigmaPos = lastHour.sigmaPos ?? 0;
  hourSigmaNeg = lastHour.sigmaNeg ?? 0;
  hourDeltaCount = lastHour.deltas;
  hourDeltaSum = lastHour.deltaSum;
  hourDeltaL = lastHour.deltaL;
  hourDeltaLPos = lastHour.deltaLPos ?? 0;
  hourDeltaLNeg = lastHour.deltaLNeg ?? 0;
  hourSignChanges = lastHour.signChanges;
  currentHour = lastHour.clockHour;
  console.log(`  ⟳  Restored hour ${fmtHour(lastHour.clockHour)} state: ${hourTicks} ticks, Σ(I−L): ${fmtSigma(hourSigma)}`);
  console.log();
}

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
        console.log(`  ticks: ${tickCount}  avg(I−L): ${tickCount > 0 ? fmtSigma(cumSigma / tickCount) : "—"}  Σ(I−L): ${fmtSigma(cumSigma)}  Σ(I−L)>0: ${fmtSigma(cumSigmaPos)}  Σ(I−L)<0: ${fmtSigma(cumSigmaNeg)}  ΣΔL: ${fmtDelta(cumDeltaL)}  ΣΔL>0: ${fmtDelta(cumDeltaLPos)}  ΣΔL<0: ${fmtDelta(cumDeltaLNeg)}  sign changes: ${minuteSignChanges}`);
        console.log();
      }

      // Hour rollover
      const hour = localHour();
      if (currentHour >= 0 && hour !== currentHour) {
        console.log(`  ═══ hour ${fmtHour(currentHour % 24)} end ═══`);
        console.log(`  ticks: ${hourTicks}  avg(I−L): ${hourTicks > 0 ? fmtSigma(hourSigma / hourTicks) : "—"}  Σ(I−L): ${fmtSigma(hourSigma)}  Σ(I−L)>0: ${fmtSigma(hourSigmaPos)}  Σ(I−L)<0: ${fmtSigma(hourSigmaNeg)}  ΣΔL: ${fmtDelta(hourDeltaL)}  ΣΔL>0: ${fmtDelta(hourDeltaLPos)}  ΣΔL<0: ${fmtDelta(hourDeltaLNeg)}  sign changes: ${hourSignChanges}`);
        console.log();

        saveHour({
          hour: currentHour,
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
          signChanges: hourSignChanges,
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
        hourDeltaCount = 0;
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
      if (deltaLast > 0) cumDeltaLPos += deltaLast;
      else if (deltaLast < 0) cumDeltaLNeg += deltaLast;
      hourDeltaL += deltaLast;
      if (deltaLast > 0) hourDeltaLPos += deltaLast;
      else if (deltaLast < 0) hourDeltaLNeg += deltaLast;
    }

    if (!QUIET) {
      console.log(
        `[${tsToHMS(now)}]  I=${padL(fmtPrice(index), W_IL)}  ΔI=${padL(fmtDelta(deltaIndex), W_DL)}  L=${padL(fmtPrice(last), W_IL)}  ΔL=${padL(fmtDelta(deltaLast), W_DL)}  I-L=${padL(fmtDelta(iMinusL), W_IL)}  Δ=${padL(fmtDelta(deltaIl), W_DL)}  Σ(I−L)=${padL(fmtSigma(cumSigma), W_SG)}  Σ+=${padL(fmtSigma(cumSigmaPos), W_SG)}  Σ-=${padL(fmtSigma(cumSigmaNeg), W_SG)}`,
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
