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
const NO_TRADE = hasFlag("--noTrade");
const DECIMALS = Number(getArg("--decimals") ?? 6);
const DELTA_LAST_THRESHOLD = Number(getArg("--deltaLastThreshold") ?? 0);
const NO_VECTOR = hasFlag("--noVector");
const NO_IL = hasFlag("--noIL");
const CD_LONG = Number(getArg("--cdLong") ?? 60);
const CD_SHORT = Number(getArg("--cdShort") ?? 60);

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
  --cdLong <N>           Long cooldown in seconds (default: 60)
  --cdShort <N>          Short cooldown in seconds (default: 60)
  --decimals <N>         Digits below decimal for printed numbers (default: 6)
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
let changeTimestampsHour: number[] = [];
let deltaLastWindowHour: { ts: number; val: number }[] = [];

/* ------------------------------------------------------------------ */
/*  State persistence                                                  */
/* ------------------------------------------------------------------ */

interface State {
  changeTimestamps: number[];
  deltaLastWindow: { ts: number; val: number }[];
  changeTimestampsHour: number[];
  deltaLastWindowHour: { ts: number; val: number }[];
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
    changeTimestampsHour = (saved.changeTimestampsHour ?? []).filter(ts => ts > cutoff);
    deltaLastWindowHour = (saved.deltaLastWindowHour ?? []).filter(x => x.ts > cutoff);
    console.log(`[${tsNow()}]  ✓  Loaded state: ${changeTimestamps.length} + ${changeTimestampsHour.length} changes`);
  } catch (e) {
    console.error(`[${tsNow()}]  ⚠  Failed to load state: ${(e as Error).message}`);
  }
}

function saveState(): void {
  const state: State = {
    changeTimestamps,
    deltaLastWindow,
    changeTimestampsHour,
    deltaLastWindowHour,
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
  return v.toFixed(decimals);
}

function fmtSign(v: number | null, decimals = DECIMALS): string {
  if (v == null || !Number.isFinite(v)) return "—".padEnd(3 + decimals);
  const s = v.toFixed(decimals);
  return v > 0 ? `+${s}` : v < 0 ? s : ` ${s}`;
}

function printHeaders(): void {
  const p = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  const h =
    `[YYYY-MM-DD HH:MM:SS] ` +
    p("ask", 2 + DECIMALS) + " " +
    p("bid", 2 + DECIMALS) + " " +
    p("last", 2 + DECIMALS) + " " +
    p("ab", 2 + DECIMALS) + " " +
    (NO_IL ? "" : p("I-L", 3 + DECIMALS) + " ") +
    p("ΔL", 3 + DECIMALS) + " " +
    p("Δask", 3 + DECIMALS) + " " +
    p("Δbid", 3 + DECIMALS) + " " +
    p("cdL", 3) + " " +
    p("cdS", 3) + " " +
    p("#ΔL/m", 5) + " " +
    p("ΣΔL/m", 6) + " " +
    p("#ΔL/h", 5) + " " +
    p("ΣΔL/h", 6);
  console.log(h);
  rowsPrinted = 0;
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`\n══ Vector (I-L) Strategy ══════════════════════════════════════`);
  console.log(`  Symbol:     ${SYMBOL}`);
  console.log(`  Size:       ${SIZE}`);
  console.log(`  Leverage:   ${LEVERAGE}x`);
  console.log(`  Threshold:  ±${THRESHOLD}`);
  console.log(`  Cd Long:    ${CD_LONG}s`);
  console.log(`  Cd Short:   ${CD_SHORT}s`);
  console.log(`  Mode:       ${DRY_RUN ? "DRY-RUN (no orders)" : "LIVE"}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  // Set leverage
  if (!DRY_RUN) {
    await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", creds.PHEMEX_API_KEY, secretRaw);
    await setLeverageUsdtM(SYMBOL, LEVERAGE, "Short", creds.PHEMEX_API_KEY, secretRaw);
    console.log(`[${tsNow()}]  ✓  Leverage set to ${LEVERAGE}x`);
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

      console.log(`[${tsNow()}] ${fmt(snapAsk)} ${fmt(snapBid)} ${fmt(snapLast)} ${fmt(ab)}${NO_IL ? "" : ` ${fmtSign(vector)}`} ${fmtSign(deltaLast)} ${fmtSign(deltaAsk)} ${fmtSign(deltaBid)} ${String(longCooldown).padStart(2)}s ${String(shortCooldown).padStart(2)}s ${rate} ${fmtSign(deltaLastSum)} ${rateHour} ${fmtSign(deltaLastSumHour)}`);
      rowsPrinted++;
      if (process.stdout.rows && rowsPrinted >= process.stdout.rows - 4) {
        printHeaders();
      }

      if (VERBOSE) {
        console.log(`[${tsNow()}]  📊  vector=${fmt(vector)}  bid=${fmt(ticker.bid)}  ask=${fmt(ticker.ask)}  deltaBid=${deltaBid !== null ? fmt(deltaBid) : "—"}  deltaAsk=${deltaAsk !== null ? fmt(deltaAsk) : "—"}`);
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
        if (longPos && deltaBid !== null && deltaBid < 0) {
          console.log(`[${tsNow()}]  EXIT LONG — deltaBid=${fmt(deltaBid)} < 0`);
          await closePos(longPos);
        }

        if (shortPos && deltaAsk !== null && deltaAsk > 0 && !NO_SHORT) {
          console.log(`[${tsNow()}]  EXIT SHORT — deltaAsk=${fmt(deltaAsk)} > 0`);
          await closePos(shortPos);
        }

        // Entry logic
        const longTrigger = (!NO_VECTOR && vector > THRESHOLD) || (DELTA_LAST_THRESHOLD > 0 && deltaLast !== null && deltaLast >= DELTA_LAST_THRESHOLD);
        const shortTrigger = (!NO_VECTOR && vector < -THRESHOLD) || (DELTA_LAST_THRESHOLD > 0 && deltaLast !== null && deltaLast <= -DELTA_LAST_THRESHOLD);

        if (longTrigger && longCooldown === 0 && !NO_LONG && !NO_TRADE) {
          if (FORCE || longSize === 0) {
            console.log(`[${tsNow()}]  ENTRY LONG — vector=${fmtSign(vector)}  ΔL=${deltaLast !== null ? fmtSign(deltaLast) : "—"}`);
            await openLong();
            longCooldown = CD_LONG;
          }
        } else if (shortTrigger && shortCooldown === 0 && !NO_SHORT && !NO_TRADE) {
          if (FORCE || shortSize === 0) {
            console.log(`[${tsNow()}]  ENTRY SHORT — vector=${fmtSign(vector)}  ΔL=${deltaLast !== null ? fmtSign(deltaLast) : "—"}`);
            await openShort();
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
