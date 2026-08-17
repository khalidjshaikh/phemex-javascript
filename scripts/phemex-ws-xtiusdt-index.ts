#!/usr/bin/env -S npx tsx

import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow } from "../src/cli-utils.js";

const WS_URL = "wss://ws.phemex.com";
const BUILD = "crude-1";

// USDT-M 24h pack column indices (no field names in the message)
const COL = {
  SYMBOL: 0,
  ASK: 1,
  BID: 2,
  HIGH: 3,
  LOW: 4,
  VOLUME: 5,
  TURNOVER: 6,
  FUNDING_RATE: 7,
  INDEX: 8,
  MARK: 9,
  OPEN_INTEREST: 10,
  OPEN_INTEREST_VALUE: 11,
  PREDICTED_FUNDING_RATE: 12,
  PRE_OPEN: 13,
  TIMESTAMP: 14,
} as const;

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const SYMBOL = parseArg("symbol") ?? "BTCUSDT";
const DECIMALS = Number(parseArg("decimals") ?? "2");

// Trade state
let prevPrice: number | null = null;
let prevTimeNs: number | null = null;
let prevVelocity: number | null = null;
let prevVelocityTimeNs: number | null = null;

let lastIndex: number | null = null;
let prevIndex: number | null = null;
let indexUpdated = false;

function fmtTs(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function fmtDelta(v: number): string {
  return v >= 0 ? `+${v.toFixed(DECIMALS)}` : v.toFixed(DECIMALS);
}

function computeMetrics(
  price: number,
  timeNs: number,
  prevP: number | null,
  prevT: number | null,
  prevV: number | null,
  prevVT: number | null,
): { dt: string; delta: string; velocity: string; acceleration: string; v: number | null; vt: number | null } {
  let dt = "—";
  let delta = "—";
  let velocity = "—";
  let acceleration = "—";
  let v: number | null = null;
  let vt: number | null = null;

  if (prevP !== null) {
    delta = fmtDelta(price - prevP);

    if (prevT !== null) {
      const dtSec = (timeNs - prevT) / 1e9;
      dt = dtSec > 0 ? `${dtSec.toFixed(8)}s` : "0s";
      if (dtSec > 0) {
        v = (price - prevP) / dtSec;
        velocity = v.toFixed(DECIMALS);

        if (prevV !== null && prevVT !== null) {
          const dtV = (timeNs - prevVT) / 1e9;
          if (dtV > 0) {
            const a = (v - prevV) / dtV;
            acceleration = a.toFixed(DECIMALS);
          }
        }

        vt = timeNs;
      }
    }
  }

  return { dt, delta, velocity, acceleration, v, vt };
}

function updateIndex(index: number, _timeNs: number): void {
  prevIndex = lastIndex;
  lastIndex = index;
  indexUpdated = true;
}

function indexSection(): string {
  if (lastIndex === null) {
    return "  idx: —";
  }
  const idx = `${"idx: "}$${lastIndex!.toFixed(DECIMALS)}`;
  const delta = indexUpdated && prevIndex !== null ? `  Δ: ${fmtDelta(lastIndex! - prevIndex)}` : "";
  indexUpdated = false;
  return `  ${idx}${delta}`;
}

function printTrade(price: number, timeNs: number, side: string): void {
  const m = computeMetrics(price, timeNs, prevPrice, prevTimeNs, prevVelocity, prevVelocityTimeNs);
  prevPrice = price;
  prevTimeNs = timeNs;
  if (m.v !== null) prevVelocity = m.v;
  if (m.vt !== null) prevVelocityTimeNs = m.vt;

  const idxStr = indexSection();
  const ts = `[${fmtTs(timeNs / 1e6)}]`;
  const dt = `${"Δt:"} ${m.dt.padStart(12)}`;
  const sym = `${SYMBOL.padEnd(8)}`;
  const sideStr = `${side.padStart(5)}`;
  const priceStr = `${"$"}${price.toFixed(2).padStart(9)}`;
  const delta = `${"Δ:"} ${m.delta.padStart(9)}`;
  const vel = `${"v:"} ${m.velocity.padStart(9)}`;
  const accel = `${"a:"} ${m.acceleration.padStart(9)}`;
  console.log(`${ts}  ${dt}  ${sym}  ${sideStr}  ${priceStr}  ${delta}  ${vel}  ${accel}${idxStr}`);
}

let cachedFields: string[] | null = null;

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    console.log(`⟐  [${BUILD}] Sending subscriptions…`);
    ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
    ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
  },
  onMessage: (msg) => {
    const m = msg as Record<string, unknown>;

    // 24h ticker pack
    if (m.method === "perp_market24h_pack_p.update" && Array.isArray(m.data)) {
      const fields = Array.isArray(m.fields) ? (m.fields as string[]) : null;
      if (fields) cachedFields = fields;

      if (cachedFields) {
        const ticker = findSymbolRow(m.data as unknown[][], cachedFields, SYMBOL);
        if (ticker) {
          const index = Number(ticker.indexRp);
          const tsNs = Date.now() * 1_000_000;
          if (Number.isFinite(index)) {
            updateIndex(index, tsNs);
          }
        }
      }
      return;
    }

    // Trade channel — real-time price updates
    if (m.trades_p && m.symbol === SYMBOL) {
      const raw = m.trades_p as unknown[][];
      const trades = raw
        .filter((t) => t.length >= 3)
        .map((t) => ({ ts: Number(t[0]), side: String(t[1]), price: Number(t[2]) }))
        .filter((t) => Number.isFinite(t.price) && Number.isFinite(t.ts) && t.ts > 0)
        .sort((a, b) => a.ts - b.ts);
      for (const t of trades) {
        printTrade(t.price, t.ts, t.side);
      }
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
    prevPrice = null;
    prevTimeNs = null;
    prevVelocity = null;
    prevVelocityTimeNs = null;
    lastIndex = null;
    prevIndex = null;
    indexUpdated = false;
    cachedFields = null;
  },
});

console.log(`⟐  Connecting to ${WS_URL} — tracking ${SYMBOL} [${BUILD}] …`);
ws.connect();
