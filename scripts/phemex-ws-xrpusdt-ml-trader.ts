#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ws-xrpusdt-ml-trader.ts — XRPUSDT WebSocket ML auto-trader on USDT-M.
 *
 * Three phases:
 *   Phase 1: Collect XRPUSDT ticks via WebSocket (~10 min)
 *   Phase 2: Train RF + XGBoost models via Python subprocess
 *   Phase 3: Live trading with ML predictions
 *
 * Trading strategy:
 *   - Entry: Both RF and XGBoost agree on direction, |predicted return| > 2.5%
 *   - Exit:  direction flip, trailing stop, hard stop, profit target
 *
 * Usage:
 *   ./phemex-ws-xrpusdt-ml-trader.ts                     # live (default)
 *   ./phemex-ws-xrpusdt-ml-trader.ts --dry-run           # simulate only
 *   ./phemex-ws-xrpusdt-ml-trader.ts --retrain           # force retrain
 *   ./phemex-ws-xrpusdt-ml-trader.ts --size 0.01         # position size
 *   ./phemex-ws-xrpusdt-ml-trader.ts --leverage 100      # leverage
 *   ./phemex-ws-xrpusdt-ml-trader.ts --threshold 0.025   # ML signal threshold
 */

import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow } from "../src/cli-utils.js";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import {
  placeMarketOrder,
  setLeverageUsdtM,
} from "../src/place-limit-order.js";
import {
  fetchPositions,
  calcPnlPct,
  closePosition,
  Position,
} from "../src/positions.js";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/* ── Constants ──────────────────────────────────────────────────────── */

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "XRPUSDT";
const PYTHON_SCRIPT = path.resolve(import.meta.dirname, "xrpusdt_ml_model.py");
const MODEL_DIR = path.resolve(import.meta.dirname, "..", "models", "xrpusdt");
const POLL_INTERVAL_MS = 2_000;
const COLLECT_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const MIN_TICKS_FOR_TRAINING = 2000;

/* ── Defaults (overridable via CLI) ─────────────────────────────────── */

const DEFAULT_LEVERAGE = 100;
const DEFAULT_SIZE = 0.01;
const DEFAULT_THRESHOLD = 0.025;     // min predicted return to enter
const DEFAULT_TRAILING_STOP = 5;    // PnL% trailing stop from peak
const DEFAULT_HARD_STOP = -10;      // PnL% hard stop
const DEFAULT_FEE_BPS = 10;         // estimated taker fee, per side

/* ── CLI flags ──────────────────────────────────────────────────────── */

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const RETRAIN = hasFlag("retrain");
const LEVERAGE = Number(parseArg("leverage")) || DEFAULT_LEVERAGE;
const QTY = Number(parseArg("size")) || DEFAULT_SIZE;
const SIGNAL_THRESHOLD = Number(parseArg("threshold")) || DEFAULT_THRESHOLD;
const TRAILING_STOP_PCT = Number(parseArg("trailing")) || DEFAULT_TRAILING_STOP;
const HARD_STOP_PCT = -Math.abs(Number(parseArg("hard-stop") ?? Math.abs(DEFAULT_HARD_STOP)));
const FEE_BPS = Number(parseArg("fee-bps")) ?? DEFAULT_FEE_BPS;

if (hasFlag("help") || hasFlag("h")) {
  console.log(`Usage: scripts/phemex-ws-xrpusdt-ml-trader.ts [options]

Collects XRPUSDT data, trains ML models, then auto-trades.

  --dry-run             Simulate trades without placing real orders (default: live)
  --retrain             Force retrain even if models exist
  --size <qty>          Position quantity (default: ${DEFAULT_SIZE})
  --leverage <n>        Leverage (default: ${DEFAULT_LEVERAGE})
  --threshold <pct>     ML signal threshold (default: ${DEFAULT_THRESHOLD})
  --trailing <pct>      PnL trailing distance (default: ${DEFAULT_TRAILING_STOP})
  --hard-stop <pct>     Maximum PnL loss (default: ${DEFAULT_HARD_STOP})
  --fee-bps <bps>       Estimated taker fee per side (default: ${DEFAULT_FEE_BPS})
  --help, -h            Show this help
`);
  process.exit(0);
}

/* ── Credentials ────────────────────────────────────────────────────── */

const credentials = loadCredentialsLocal();
const apiKey = credentials.PHEMEX_API_KEY;
const secretRaw = base64UrlDecode(credentials.PHEMEX_API_SECRET);

/* ── State ──────────────────────────────────────────────────────────── */

let allPositions: Position[] = [];
let botLong: { entryPrice: number; maxPnlPct: number } | null = null;
let botShort: { entryPrice: number; maxPnlPct: number } | null = null;

let lastPrice = 0;
let bidPrice = 0;
let askPrice = 0;
let indexPrice = 0;
let highPrice = 0;
let lowPrice = 0;
let tickerReady = false;
let actionInFlight = false;

/** Data collection */
const collectedPrices: number[] = [];
const collectedVolumes: number[] = [];
let collectStartTime = 0;
let collectPhase = true;

/** ML models */
let mlModels: Record<string, unknown> | null = null;
let mlReady = false;
let lastPrediction: { rf: number; xgb: number; ensemble: number } | null = null;

/* ── Helpers ────────────────────────────────────────────────────────── */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtPrice(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function log(...args: unknown[]): void {
  console.log(`[${fmtTime()}]`, ...args);
}

function estimatedNetPerUnit(side: "Long" | "Short", entry: number): number {
  const exit = side === "Long" ? bidPrice : askPrice;
  if (entry <= 0 || exit <= 0) return Number.NEGATIVE_INFINITY;
  const gross = side === "Long" ? exit - entry : entry - exit;
  const fees = (entry + exit) * FEE_BPS / 10_000;
  return gross - fees;
}

function runAction(label: string, action: () => Promise<void>): void {
  if (actionInFlight) return;
  actionInFlight = true;
  action().catch((err) => log(`✗  ${label}:`, err instanceof Error ? err.message : err))
    .finally(() => { actionInFlight = false; });
}

/* ── Python subprocess ──────────────────────────────────────────────── */

let pythonProc: ChildProcess | null = null;
let pythonCallbacks: Map<number, (msg: Record<string, unknown>) => void> = new Map();
let pythonMsgId = 0;

function startPython(): void {
  log(`⟐  Starting Python ML model: ${PYTHON_SCRIPT}`);
  pythonProc = spawn("python3", [PYTHON_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  pythonProc.stdout!.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        log(`  ← Python: ${msg.status}`);
        // Emit to any pending callback
        for (const [id, cb] of pythonCallbacks) {
          cb(msg);
          pythonCallbacks.delete(id);
          break;
        }
      } catch { /* ignore parse errors */ }
    }
  });

  pythonProc.stderr!.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log(`  ✗ Python: ${msg}`);
  });

  pythonProc.on("exit", (code) => {
    log(`⟐  Python exited with code ${code}`);
    pythonProc = null;
  });
}

function sendToPython(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!pythonProc?.stdin) {
      reject(new Error("Python not running"));
      return;
    }
    const id = ++pythonMsgId;
    pythonCallbacks.set(id, resolve);
    pythonProc.stdin.write(JSON.stringify(msg) + "\n");

    // Timeout after 30s
    setTimeout(() => {
      if (pythonCallbacks.has(id)) {
        pythonCallbacks.delete(id);
        reject(new Error("Python response timeout"));
      }
    }, 30_000);
  });
}

/* ── Feature computation (mirrors Python compute_features) ──────────── */

function computeFeatures(prices: number[], volumes: number[]): Record<string, number> {
  const n = prices.length;
  const d: Record<string, number> = {};

  for (const lag of [1, 2, 3, 5, 10, 20]) {
    d[`ret_${lag}d`] = lag < n ? prices[n - 1] / prices[n - 1 - lag] - 1.0 : 0.0;
  }

  for (const w of [5, 10, 20, 50, 200]) {
    if (w <= n) {
      const ma = prices.slice(-w).reduce((a, b) => a + b, 0) / w;
      d[`ratio_ma_${w}`] = ma !== 0 ? prices[n - 1] / ma : 1.0;
    } else {
      d[`ratio_ma_${w}`] = 1.0;
    }
  }

  for (const [fast, slow] of [[5, 20], [10, 50], [20, 200]] as const) {
    if (slow <= n) {
      const maF = prices.slice(-fast).reduce((a, b) => a + b, 0) / fast;
      const maS = prices.slice(-slow).reduce((a, b) => a + b, 0) / slow;
      d[`ma_cross_${fast}_${slow}`] = maS !== 0 ? maF / maS : 1.0;
    } else {
      d[`ma_cross_${fast}_${slow}`] = 1.0;
    }
  }

  // RSI
  if (n >= 15) {
    const diffs = [];
    for (let i = n - 15; i < n; i++) diffs.push(prices[i] - prices[i - 1]);
    const g = diffs.filter((x) => x > 0);
    const l = diffs.filter((x) => x < 0).map((x) => -x);
    const ag = g.length ? g.reduce((a, b) => a + b, 0) / g.length : 0;
    const al = l.length ? l.reduce((a, b) => a + b, 0) / l.length : 1e-12;
    d.rsi_14 = 100 - 100 / (1 + ag / al);
  } else {
    d.rsi_14 = 50.0;
  }
  d.rsi_zone = d.rsi_14 > 70 ? 1 : d.rsi_14 < 30 ? -1 : 0;

  // MACD
  if (n >= 27) {
    const e12 = ema(prices, 12);
    const e26 = ema(prices, 26);
    const macdV = e12 - e26;
    const sig = ema(Array(n).fill(macdV), 9);
    d.macd = macdV;
    d.macd_sig = sig;
    d.macd_hist = macdV - sig;
    d.macd_cross = macdV > sig ? 1 : macdV < sig ? -1 : 0;
  } else {
    d.macd = 0; d.macd_sig = 0; d.macd_hist = 0; d.macd_cross = 0;
  }

  // Bollinger
  if (n >= 20) {
    const slice = prices.slice(-20);
    const bbMa = slice.reduce((a, b) => a + b, 0) / 20;
    const bbStd = Math.sqrt(slice.reduce((a, b) => a + (b - bbMa) ** 2, 0) / 20);
    const upper = bbMa + 2 * bbStd;
    const lower = bbMa - 2 * bbStd;
    d.bb_pos = (prices[n - 1] - lower) / Math.max(upper - lower, 1e-12);
  } else {
    d.bb_pos = 0.5;
  }

  // Volatility
  for (const w of [5, 10, 20]) {
    if (w <= n) {
      const slice = prices.slice(-w);
      const mean = slice.reduce((a, b) => a + b, 0) / w;
      const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / w);
      d[`vol_${w}d`] = std / (mean + 1e-12);
    } else {
      d[`vol_${w}d`] = 0.0;
    }
  }

  // Volume
  if (volumes.some((v) => v > 0)) {
    d.vol_ret = volumes.length >= 2 ? volumes[volumes.length - 1] / Math.max(volumes[volumes.length - 2], 1) - 1.0 : 0.0;
    for (const w of [5, 20]) {
      if (w <= volumes.length) {
        const vma = volumes.slice(-w).reduce((a, b) => a + b, 0) / w;
        d[`vol_ratio_${w}`] = volumes[volumes.length - 1] / Math.max(vma, 1);
      } else {
        d[`vol_ratio_${w}`] = 1.0;
      }
    }
  } else {
    d.vol_ret = 0.0;
    d.vol_ratio_5 = 1.0;
    d.vol_ratio_20 = 1.0;
  }

  return d;
}

function ema(arr: number[], period: number): number {
  const a = 2 / (period + 1);
  let out = arr[0];
  for (let i = 1; i < arr.length; i++) {
    out = a * arr[i] + (1 - a) * out;
  }
  return out;
}

/* ── Ticker display ─────────────────────────────────────────────────── */

function printTicker(ticker: Record<string, unknown>): void {
  const open = Number(ticker.openRp ?? 0);
  const high = Number(ticker.highRp ?? 0);
  const low = Number(ticker.lowRp ?? 0);
  const last = Number(ticker.lastRp ?? 0);
  const bid = Number(ticker.bidRp ?? ticker.bidEp ?? 0);
  const ask = Number(ticker.askRp ?? ticker.askEp ?? 0);
  const index = Number(ticker.indexRp ?? ticker.indexEp ?? 0);
  const volume = Number(ticker.volumeRq ?? 0);

  if (last > 0) lastPrice = last;
  if (bid > 0) bidPrice = bid;
  if (ask > 0) askPrice = ask;
  if (index > 0) indexPrice = index;
  if (high > 0) highPrice = high;
  if (low > 0) lowPrice = low;
  if (open > 0) tickerReady = true;

  // Collect data for training
  if (collectPhase && last > 0) {
    collectedPrices.push(last);
    collectedVolumes.push(volume);
  }

  const changePct = open > 0 ? ((last - open) / open) * 100 : 0;
  const sign = changePct >= 0 ? "+" : "";

  const mlSignal = lastPrediction
    ? `  ML: ${fmtPct(lastPrediction.ensemble * 100)}`
    : "";

  const phase = collectPhase
    ? `  ⏳ Collecting: ${collectedPrices.length} ticks`
    : mlReady
      ? `  🤖 Trading`
      : `  ⚙️  Training...`;

  process.stdout.write(
    `\r\x1B[K  ${SYMBOL}  ${fmtPrice(last)}  ` +
    `Bid: ${fmtPrice(bid)}  Ask: ${fmtPrice(ask)}  ` +
    `Idx: ${fmtPrice(index)}  ` +
    `Chg: ${sign}${changePct.toFixed(2)}%  ` +
    `${phase}${mlSignal}`
  );
}

/* ── Trading actions ────────────────────────────────────────────────── */

async function openLong(price: number): Promise<void> {
  log(`🟢  Opening Long ${QTY} ${SYMBOL} @ ${fmtPrice(price)}  ${LEVERAGE}x …`);
  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", apiKey, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Buy", price: 0, qty: QTY, posSide: "Long" },
    apiKey, secretRaw,
  );
  botLong = { entryPrice: price, maxPnlPct: 0 };
  log(`✓  Long opened  orderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

async function openShort(price: number): Promise<void> {
  log(`🔴  Opening Short ${QTY} ${SYMBOL} @ ${fmtPrice(price)}  ${LEVERAGE}x …`);
  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Short", apiKey, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Sell", price: 0, qty: QTY, posSide: "Short" },
    apiKey, secretRaw,
  );
  botShort = { entryPrice: price, maxPnlPct: 0 };
  log(`✓  Short opened  orderID: ${result.orderID ?? result.clOrdID ?? "—"}`);
}

async function closeLong(pos: Position, reason: string): Promise<void> {
  const price = bidPrice;
  log(`✖  Closing Long ${SYMBOL} @ ${fmtPrice(price)} — ${reason} …`);
  await closePosition(pos, apiKey, secretRaw);
  botLong = null;
  log(`✓  Long closed`);
}

async function closeShort(pos: Position, reason: string): Promise<void> {
  const price = askPrice;
  log(`✖  Closing Short ${SYMBOL} @ ${fmtPrice(price)} — ${reason} …`);
  await closePosition(pos, apiKey, secretRaw);
  botShort = null;
  log(`✓  Short closed`);
}

/* ── ML-based trading logic ─────────────────────────────────────────── */

function checkEntrySignals(): void {
  if (actionInFlight || !mlReady || !lastPrediction) return;
  if (!tickerReady || lastPrice <= 0 || bidPrice <= 0 || askPrice <= bidPrice) return;

  const { ensemble } = lastPrediction;

  // Open Long: ensemble predicts positive return above threshold
  if (ensemble > SIGNAL_THRESHOLD) {
    const liveLong = allPositions.some((p) => p.symbol === SYMBOL && p.side === "Buy");
    const liveAny = allPositions.some((p) => p.symbol === SYMBOL);
    const botActive = botLong !== null || botShort !== null || liveAny;
    if (!botActive && !liveLong) {
      runAction("openLong error", () => openLong(askPrice));
    }
  }

  // Open Short: ensemble predicts negative return below -threshold
  if (ensemble < -SIGNAL_THRESHOLD) {
    const liveShort = allPositions.some((p) => p.symbol === SYMBOL && p.side === "Sell");
    const liveAny = allPositions.some((p) => p.symbol === SYMBOL);
    const botActive = botLong !== null || botShort !== null || liveAny;
    if (!botActive && !liveShort) {
      runAction("openShort error", () => openShort(bidPrice));
    }
  }
}

function checkExitSignals(): void {
  if (actionInFlight || !lastPrediction) return;

  const { ensemble } = lastPrediction;

  // Close Long: ML predicts negative return
  if (botLong && ensemble < -SIGNAL_THRESHOLD) {
    const pos = allPositions.find((p) => p.symbol === SYMBOL && p.side === "Buy");
    if (pos) {
      const reason = `ML signal flip (ensemble ${fmtPct(ensemble * 100)})`;
      runAction("closeLong error", () => closeLong(pos, reason));
    }
  }

  // Close Short: ML predicts positive return
  if (botShort && ensemble > SIGNAL_THRESHOLD) {
    const pos = allPositions.find((p) => p.symbol === SYMBOL && p.side === "Sell");
    if (pos) {
      const reason = `ML signal flip (ensemble ${fmtPct(ensemble * 100)})`;
      runAction("closeShort error", () => closeShort(pos, reason));
    }
  }
}

/* ── Position polling (REST) — trailing stop + hard stop ─────────────── */

async function pollPositions(): Promise<void> {
  try {
    const positions = await fetchPositions(apiKey, secretRaw);
    allPositions = positions;
    const pos = positions.find((p) => p.symbol === SYMBOL);

    if (!pos) {
      if (botLong) {
        log(`  ℹ  Long position gone (closed externally) — resetting`);
        botLong = null;
      }
      if (botShort) {
        log(`  ℹ  Short position gone (closed externally) — resetting`);
        botShort = null;
      }
      return;
    }

    const pnlPct = calcPnlPct(pos);
    const entry = parseFloat(pos.avgEntryPriceRp || "0");
    const mark = parseFloat(pos.markPriceRp || "0");
    const size = parseFloat(pos.size || "0");
    const margin = parseFloat(pos.posCostRv || "0");

    const isLong = pos.side === "Buy";
    const bot = isLong ? botLong : botShort;

    if (bot) {
      if (pnlPct > bot.maxPnlPct) bot.maxPnlPct = pnlPct;
      const floor = Math.max(bot.maxPnlPct - TRAILING_STOP_PCT, HARD_STOP_PCT);

      log(
        `  ${pos.side === "Buy" ? "🟢" : "🔴"}  ${SYMBOL} ${pos.side}  ` +
        `size: ${size.toFixed(4)}  entry: ${fmtPrice(entry)}  mark: ${fmtPrice(mark)}  ` +
        `PnL: ${fmtPct(pnlPct)}  peak: ${fmtPct(bot.maxPnlPct)}  floor: ${fmtPct(floor)}`
      );

      const netPerUnit = estimatedNetPerUnit(isLong ? "Long" : "Short", entry);
      if (netPerUnit >= 0.02 && !actionInFlight) {
        const reason = `net target (estimated ${fmtPrice(netPerUnit)}/unit)`;
        runAction(isLong ? "closeLong error" : "closeShort error", () =>
          isLong ? closeLong(pos, reason) : closeShort(pos, reason));
        return;
      }

      if (pnlPct < floor && !actionInFlight) {
        const reason = pnlPct <= HARD_STOP_PCT
          ? `hard stop (PnL ${fmtPct(pnlPct)} < ${fmtPct(HARD_STOP_PCT)})`
          : `trailing stop (PnL ${fmtPct(pnlPct)} < floor ${fmtPct(floor)})`;
        runAction(isLong ? "closeLong error" : "closeShort error", () =>
          isLong ? closeLong(pos, reason) : closeShort(pos, reason));
      }
    } else {
      log(
        `  📊  ${SYMBOL} ${pos.side}  ` +
        `size: ${size.toFixed(4)}  entry: ${fmtPrice(entry)}  mark: ${fmtPrice(mark)}  ` +
        `PnL: ${fmtPct(pnlPct)}  (external)`
      );
    }
  } catch (err: unknown) {
    log("✗  Position poll error:", err instanceof Error ? err.message : err);
  }
}

/* ── Phase transitions ──────────────────────────────────────────────── */

async function transitionToTraining(): Promise<void> {
  collectPhase = false;
  log(`\n══  Data collection complete: ${collectedPrices.length} ticks  ══`);

  // Try loading existing models first
  if (!RETRAIN && fs.existsSync(path.join(MODEL_DIR, "rf_model.pkl"))) {
    log(`⟐  Loading saved models from ${MODEL_DIR} …`);
    try {
      const resp = await sendToPython({ action: "load", path: MODEL_DIR });
      if (resp.status === "loaded") {
        mlReady = true;
        log(`✓  Models loaded — entering live trading`);
        return;
      }
    } catch (err) {
      log(`✗  Failed to load models: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Train new models
  log(`⟐  Training RF + XGBoost on ${collectedPrices.length} ticks …`);
  try {
    const resp = await sendToPython({
      action: "train",
      prices: collectedPrices,
      volumes: collectedVolumes,
    });
    if (resp.status === "trained") {
      mlReady = true;
      log(`✓  Models trained — saving to ${MODEL_DIR}`);
      await sendToPython({ action: "save", path: MODEL_DIR });
      log(`✓  Models saved — entering live trading`);
    } else {
      log(`✗  Training failed: ${resp.message}`);
    }
  } catch (err) {
    log(`✗  Training error: ${err instanceof Error ? err.message : err}`);
  }
}

async function getPrediction(): Promise<void> {
  if (!mlReady || !tickerReady || lastPrice <= 0) return;

  const features = computeFeatures(collectedPrices, collectedVolumes);

  try {
    const resp = await sendToPython({ action: "predict", features });
    if (resp.status === "predicted") {
      lastPrediction = {
        rf: resp.rf as number,
        xgb: resp.xgb as number,
        ensemble: resp.ensemble as number,
      };
    }
  } catch {
    // Prediction errors are non-fatal
  }
}

/* ── Main ───────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  log(`══ ${SYMBOL} ML Trader ══════════════════════════════════`);
  log(`  Symbol:       ${SYMBOL}`);
  log(`  Leverage:     ${LEVERAGE}x`);
  log(`  Size:         ${QTY}`);
  log(`  Threshold:    ${fmtPct(SIGNAL_THRESHOLD * 100)}`);
  log(`  Stops:        trailing ${TRAILING_STOP_PCT}%  hard ${HARD_STOP_PCT}%`);
  log(`═══════════════════════════════════════════════════════════════════════════════`);

  // Start Python subprocess
  startPython();

  // Discover existing exposure (non-blocking)
  pollPositions().catch(() => {});

  // Start WebSocket
  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      log(`⟐  WebSocket connected — subscribing to ${SYMBOL} …`);
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
      ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
    },
    onMessage: async (msg) => {
      const m = msg as Record<string, unknown>;

      // 24h ticker
      if (
        m.method === "perp_market24h_pack_p.update" &&
        Array.isArray(m.fields) &&
        Array.isArray(m.data)
      ) {
        const ticker = findSymbolRow(m.data as unknown[][], m.fields as string[], SYMBOL);
        if (ticker) {
          printTicker(ticker);

          // Collect tick from ticker update
          if (collectPhase && lastPrice > 0) {
            collectedPrices.push(lastPrice);
            collectedVolumes.push(Number(ticker.volumeRq ?? 0));
          }

          // Transition from collection to training
          if (collectPhase && collectedPrices.length >= MIN_TICKS_FOR_TRAINING) {
            const elapsed = Date.now() - collectStartTime;
            if (elapsed >= COLLECT_DURATION_MS) {
              ws.close();
              await transitionToTraining();
              // Reconnect for live trading
              ws.connect();
            }
          }

          // Get prediction on each ticker update (throttled)
          if (mlReady && !collectPhase) {
            await getPrediction();
            checkEntrySignals();
            checkExitSignals();
          }
        }
        return;
      }

      // Real-time trades — collect price
      if (m.trades_p && m.symbol === SYMBOL && Array.isArray(m.trades_p) && m.trades_p.length > 0) {
        const trades = m.trades_p as unknown[][];
        for (const trade of trades) {
          const p = Number(trade[2]);
          if (p > 0 && collectPhase) {
            collectedPrices.push(p);
          }
        }
      }
    },
    onReconnect: (delayMs) => {
      log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
    },
  });

  collectStartTime = Date.now();
  ws.connect();

  // Warn if no data after 30s
  setTimeout(() => {
    if (collectPhase && collectedPrices.length === 0) {
      log(`⚠  No data received after 30s — check WebSocket connection`);
    }
  }, 30_000);

  // Position polling loop
  let running = true;
  process.on("SIGINT", () => {
    log("\n⏹  Shutting down …");
    running = false;
    ws.shutdown();
    if (pythonProc) pythonProc.kill();
    process.exit(0);
  });

  while (running) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (!running) break;
    await pollPositions();
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
