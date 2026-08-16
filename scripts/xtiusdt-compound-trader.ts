#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * xtiusdt-compound-trader.ts — Multi-algorithm compound interest trader for XTIUSDT.
 *
 * Combines 6 algorithms with ensemble voting to trade WTI Crude Oil perpetual
 * contracts. Reinvests profits to grow the account over months/years.
 *
 * Algorithms:
 *   1. EMA Crossover (EMA20/50 with EMA200 trend filter)
 *   2. Index-Price Divergence (mean reversion)
 *   3. Bollinger Band Squeeze Breakout
 *   4. RSI Divergence (reversal detection)
 *   5. Momentum + Tick Volume
 *   6. Index Trade (trader2 mandatory gate — bias/threshold entry)
 *
 * Ensemble: trader2 must agree + at least 2 of the other 5 algorithms.
 *
 * Usage:
 *   npx tsx scripts/xtiusdt-compound-trader.ts
 *   npx tsx scripts/xtiusdt-compound-trader.ts --dry-run
 *   npx tsx scripts/xtiusdt-compound-trader.ts --size 0.02
 *   npx tsx scripts/xtiusdt-compound-trader.ts --restore
 */

import fs from "node:fs";
import path from "node:path";
import { ReconnectingWs } from "../src/ws-client.js";
import { loadCredentials } from "../src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM } from "../src/place-limit-order.js";
import { fetchPositions, fetchAccountBalance, calcPnlPct, type Position } from "../src/positions.js";
import { saveJson, loadJson } from "../src/persistence.js";
import { getArg, hasFlag } from "../src/cli-utils.js";

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

interface SymbolConfig {
  threshold: number;
  longThreshold: number;
  shortThreshold: number;
  size: number;
  leverage: number;
  hedge: boolean;
  profit: number;
}

interface TickerData {
  symbol: string;
  ask: number;
  bid: number;
  index: number;
  mark: number;
  last: number;
  timestamp: number;
}

interface Indicators {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  ema1200: number | null;
  ema3000: number | null;
  ema12000: number | null;
  rsi: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  atr: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  tickVolume: number;
}

interface AlgorithmSignal {
  name: string;
  signal: number; // +1 long, -1 short, 0 neutral
  confidence: number; // 0-1
  reason: string;
}

interface CompoundState {
  peakBalance: number;
  tradeCount: number;
  baseQty: number;
  currentQty: number;
  totalPnl: number;
  consecutiveLosses: number;
  lastTradeTime: number;
  position: "NONE" | "LONG" | "SHORT";
  entryPrice: number;
  entryQty: number;
  bestPnlPct: number; // best unrealized PnL% for trailing stop
}

interface TradeRecord {
  time: string;
  side: "Long" | "Short";
  entry: number;
  exit: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  balance: number;
}

interface Metrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  currentBalance: number;
  peakBalance: number;
}

/* ================================================================== */
/*  Config & Constants                                                 */
/* ================================================================== */

const SYMBOL = "XTIUSDT";
const WS_URL = "wss://ws.phemex.com";
const LEVERAGE = 100;
const BASE_QTY = 0.01;
const MAX_QTY = 1.0;
const TAKE_PROFIT_PCT = 0.0020; // 0.20%
const STOP_LOSS_PCT = 0.0008; // 0.08%
const MAX_DRAWDOWN_PCT = 0.30; // 30%
const LOSS_COOLDOWN_MS = 90_000; // 90 seconds
const MAX_DAILY_TRADES = 500;
const RECALC_INTERVAL = 20; // recalc size every 20 trades
const ENSEMBLE_MIN_AGREE = 2; // 2 of 5 other algorithms must agree (trader2 mandatory)
const PAUSE_MS = 1_000; // 1 second between cycles
const PRICE_SCALE = 10_000;
const MIN_RSI_MOVE_PCT = 0.0003; // ignore RSI price changes below 0.03% of price
const WARMUP_TICKS = 100; // don't trade until we have enough indicator history
const SIGNAL_DEBOUNCE = 3; // require same signal direction for N consecutive cycles
const ATR_SL_MULT = 2.0; // stop loss = 2.0x ATR
const MIN_SL_PCT = 0.0008; // floor: 0.08%
const MAX_SL_PCT = 0.005;  // cap: 0.50%
const TRAILING_ACTIVATE_PCT = 0.0010; // activate trailing stop at 0.10% profit
const TRAILING_STEP_PCT = 0.0005; // trail by 0.05% behind best profit

const DATA_DIR = path.resolve(__dirname, "..", "data", "xtiusdt-compound");

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

function fmtTime(): string {
  return new Date().toLocaleTimeString();
}

function fmtNum(n: number | null, decimals = 2): string {
  return n !== null ? n.toFixed(decimals) : "—";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/* ================================================================== */
/*  Technical Indicators                                               */
/* ================================================================== */

class IndicatorEngine {
  private prices: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private closes: number[] = [];
  private tickVolumes: number[] = [];
  private ema20: number | null = null;
  private ema50: number | null = null;
  private ema200: number | null = null;
  private ema1200: number | null = null;
  private ema3000: number | null = null;
  private ema12000: number | null = null;
  private atr14: number | null = null;
  private atrSum = 0;
  private rsiGains: number[] = [];
  private rsiLosses: number[] = [];
  private rsiAvgGain: number | null = null;
  private rsiAvgLoss: number | null = null;
  private ema12: number | null = null;
  private ema26: number | null = null;
  private macdLine: number | null = null;
  private macdSignal: number | null = null;
  private bbSma20: number | null = null;
  private bbVariance: number | null = null;
  private prevClose: number | null = null;
  private maxLen = 12000;

  addTick(price: number, high: number, low: number, tickVolume: number): void {
    this.prices.push(price);
    this.highs.push(high);
    this.lows.push(low);
    this.closes.push(price);
    this.tickVolumes.push(tickVolume);

    if (this.prices.length > this.maxLen) {
      this.prices.shift();
      this.highs.shift();
      this.lows.shift();
      this.closes.shift();
      this.tickVolumes.shift();
    }

    this.ema20 = this.computeEMA(20, this.ema20, price);
    this.ema50 = this.computeEMA(50, this.ema50, price);
    this.ema200 = this.computeEMA(200, this.ema200, price);
    this.ema1200 = this.computeEMA(1200, this.ema1200, price);
    this.ema3000 = this.computeEMA(3000, this.ema3000, price);
    this.ema12000 = this.computeEMA(12000, this.ema12000, price);
    this.computeATR(high, low);
    this.computeRSI(price);
    this.computeMACD(price);
    this.computeBollinger(price);
    this.prevClose = price;
  }

  private computeEMA(period: number, prev: number | null, price: number): number {
    if (this.prices.length <= period) {
      const slice = this.prices.slice(0, this.prices.length);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    }
    const k = 2 / (period + 1);
    return price * k + (prev ?? price) * (1 - k);
  }

  private computeATR(high: number, low: number): void {
    const tr = this.prevClose !== null
      ? Math.max(high - low, Math.abs(high - this.prevClose), Math.abs(low - this.prevClose))
      : high - low;
    this.atrSum += tr;
    if (this.atrSum > this.maxLen * 10) this.atrSum /= 2; // prevent overflow
    if (this.prices.length >= 14) {
      if (this.atr14 === null) {
        const atrs: number[] = [];
        for (let i = 1; i <= Math.min(14, this.prices.length - 1); i++) {
          const h = this.highs[this.highs.length - 1 - i];
          const l = this.lows[this.lows.length - 1 - i];
          const c = this.closes[this.closes.length - 2 - i];
          atrs.push(Math.max(h - l, Math.abs(h - c), Math.abs(l - c)));
        }
        this.atr14 = atrs.reduce((a, b) => a + b, 0) / atrs.length;
      } else {
        this.atr14 = (this.atr14 * 13 + tr) / 14;
      }
    }
  }

  private computeRSI(price: number): void {
    if (this.prevClose === null) return;
    const change = price - this.prevClose;
    // Ignore micro-movements below threshold to prevent RSI lock at 0/100
    const minMove = price * MIN_RSI_MOVE_PCT;
    const gain = change > minMove ? change : 0;
    const loss = change < -minMove ? -change : 0;

    this.rsiGains.push(gain);
    this.rsiLosses.push(loss);
    if (this.rsiGains.length > this.maxLen) {
      this.rsiGains.shift();
      this.rsiLosses.shift();
    }

    if (this.rsiGains.length < 14) return;

    if (this.rsiAvgGain === null) {
      this.rsiAvgGain = this.rsiGains.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
      this.rsiAvgLoss = this.rsiLosses.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    } else {
      this.rsiAvgGain = (this.rsiAvgGain * 13 + gain) / 14;
      this.rsiAvgLoss = (this.rsiAvgLoss * 13 + loss) / 14;
    }
  }

  private computeMACD(price: number): void {
    this.ema12 = this.computeEMA(12, this.ema12, price);
    this.ema26 = this.computeEMA(26, this.ema26, price);
    this.macdLine = this.ema12 - this.ema26;
    if (this.macdLine !== null) {
      this.macdSignal = this.computeEMA(9, this.macdSignal, this.macdLine);
    }
  }

  private computeBollinger(price: number): void {
    if (this.prices.length < 20) return;
    const slice = this.prices.slice(-20);
    const sma = slice.reduce((a, b) => a + b, 0) / 20;
    const variance = slice.reduce((a, b) => a + (b - sma) ** 2, 0) / 20;
    this.bbSma20 = sma;
    this.bbVariance = variance;
  }

  getRSI(): number | null {
    if (this.rsiAvgGain === null || this.rsiAvgLoss === null) return null;
    if (this.rsiAvgGain === 0 && this.rsiAvgLoss === 0) return 50;
    if (this.rsiAvgLoss === 0) return 100;
    if (this.rsiAvgGain === 0) return 0;
    const rs = this.rsiAvgGain / this.rsiAvgLoss;
    return 100 - 100 / (1 + rs);
  }

  getTickVolume(): number {
    return this.tickVolumes.length > 0 ? this.tickVolumes[this.tickVolumes.length - 1] : 0;
  }

  getAvgTickVolume(period: number = 20): number {
    if (this.tickVolumes.length < period) return 0;
    const slice = this.tickVolumes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  getATRPercent(): number | null {
    if (this.atr14 === null || this.prices.length === 0) return null;
    const last = this.prices[this.prices.length - 1];
    return last > 0 ? (this.atr14 / last) * 100 : null;
  }

  getATRPercentile(): number | null {
    const current = this.getATRPercent();
    if (current === null) return null;
    // Approximate percentile based on typical range
    // ATR% for commodities is usually 0.5-3%
    return clamp((current - 0.3) / (2.5 - 0.3) * 100, 0, 100);
  }

  getIndicators(): Indicators {
    const rsi = this.getRSI();
    const bbStd = this.bbVariance !== null ? Math.sqrt(this.bbVariance) : null;
    return {
      ema20: this.ema20,
      ema50: this.ema50,
      ema200: this.ema200,
      ema1200: this.ema1200,
      ema3000: this.ema3000,
      ema12000: this.ema12000,
      rsi,
      bbUpper: this.bbSma20 !== null && bbStd !== null ? this.bbSma20 + 2 * bbStd : null,
      bbMiddle: this.bbSma20,
      bbLower: this.bbSma20 !== null && bbStd !== null ? this.bbSma20 - 2 * bbStd : null,
      atr: this.atr14,
      macd: this.macdLine,
      macdSignal: this.macdSignal,
      macdHistogram: this.macdLine !== null && this.macdSignal !== null ? this.macdLine - this.macdSignal : null,
      tickVolume: this.getTickVolume(),
    };
  }

  loadState(data: { prices: number[]; highs: number[]; lows: number[]; closes: number[]; tickVolumes: number[] }): void {
    this.prices = data.prices || [];
    this.highs = data.highs || [];
    this.lows = data.lows || [];
    this.closes = data.closes || [];
    this.tickVolumes = data.tickVolumes || [];
    // Recompute indicators from history
    this.ema20 = null;
    this.ema50 = null;
    this.ema200 = null;
    this.ema1200 = null;
    this.ema3000 = null;
    this.ema12000 = null;
    this.ema12 = null;
    this.ema26 = null;
    this.atr14 = null;
    this.atrSum = 0;
    this.rsiAvgGain = null;
    this.rsiAvgLoss = null;
    this.macdSignal = null;
    this.bbSma20 = null;
    this.bbVariance = null;
    this.prevClose = null;
    for (let i = 0; i < this.prices.length; i++) {
      this.ema20 = this.computeEMA(20, this.ema20, this.prices[i]);
      this.ema50 = this.computeEMA(50, this.ema50, this.prices[i]);
      this.ema200 = this.computeEMA(200, this.ema200, this.prices[i]);
      this.ema1200 = this.computeEMA(1200, this.ema1200, this.prices[i]);
      this.ema3000 = this.computeEMA(3000, this.ema3000, this.prices[i]);
      this.ema12000 = this.computeEMA(12000, this.ema12000, this.prices[i]);
      this.computeATR(this.highs[i], this.lows[i]);
      this.computeRSI(this.prices[i]);
      this.computeMACD(this.prices[i]);
      this.computeBollinger(this.prices[i]);
      this.prevClose = this.prices[i];
    }
  }

  getState(): { prices: number[]; highs: number[]; lows: number[]; closes: number[]; tickVolumes: number[] } {
    return {
      prices: [...this.prices],
      highs: [...this.highs],
      lows: [...this.lows],
      closes: [...this.closes],
      tickVolumes: [...this.tickVolumes],
    };
  }
}

/* ================================================================== */
/*  5 Trading Algorithms                                               */
/* ================================================================== */

function algoEmaCrossover(price: number, ind: Indicators): AlgorithmSignal {
  if (ind.ema20 === null || ind.ema50 === null || ind.ema200 === null || ind.ema1200 === null) {
    return { name: "EMA Crossover", signal: 0, confidence: 0, reason: "indicators not ready" };
  }

  const emaAbove = ind.ema20 > ind.ema50;
  const priceAboveEma200 = price > ind.ema200;
  const priceAboveEma1200 = price > ind.ema1200;

  if (emaAbove && priceAboveEma200 && priceAboveEma1200) {
    return { name: "EMA Crossover", signal: 1, confidence: 0.7, reason: "EMA20>EMA50, price>EMA200, price>EMA1200" };
  }
  if (!emaAbove && !priceAboveEma200 && !priceAboveEma1200) {
    return { name: "EMA Crossover", signal: -1, confidence: 0.7, reason: "EMA20<EMA50, price<EMA200, price<EMA1200" };
  }
  return { name: "EMA Crossover", signal: 0, confidence: 0.3, reason: "mixed signals" };
}

function algoIndexDivergence(index: number, last: number): AlgorithmSignal {
  const indexLast = index - last;
  if (!Number.isFinite(indexLast)) {
    return { name: "Index Divergence", signal: 0, confidence: 0, reason: "no data" };
  }

  if (indexLast > 0.3) {
    return { name: "Index Divergence", signal: 1, confidence: 0.6, reason: `indexLast ${fmtNum(indexLast)} > +0.3` };
  }
  if (indexLast < -0.3) {
    return { name: "Index Divergence", signal: -1, confidence: 0.6, reason: `indexLast ${fmtNum(indexLast)} < -0.3` };
  }
  return { name: "Index Divergence", signal: 0, confidence: 0.2, reason: "dead band" };
}

function algoBollingerSqueeze(price: number, ind: Indicators): AlgorithmSignal {
  if (ind.bbUpper === null || ind.bbLower === null || ind.bbMiddle === null || ind.atr === null) {
    return { name: "Bollinger Squeeze", signal: 0, confidence: 0, reason: "indicators not ready" };
  }

  const bbWidth = ind.bbUpper - ind.bbLower;
  const bbWidthPct = (bbWidth / ind.bbMiddle) * 100;
  const atrPct = ind.atr !== null ? (ind.atr / price) * 100 : null;

  // Detect squeeze: narrow bands
  const isSqueeze = bbWidthPct < 1.5; // less than 1.5% band width

  if (price > ind.bbUpper) {
    return { name: "Bollinger Squeeze", signal: 1, confidence: 0.65, reason: `breakout above upper band (${fmtNum(bbWidthPct)}%)` };
  }
  if (price < ind.bbLower) {
    return { name: "Bollinger Squeeze", signal: -1, confidence: 0.65, reason: `breakout below lower band (${fmtNum(bbWidthPct)}%)` };
  }
  if (isSqueeze && price > ind.bbMiddle) {
    return { name: "Bollinger Squeeze", signal: 0.5, confidence: 0.4, reason: `squeeze, price above middle (${fmtNum(bbWidthPct)}%)` };
  }
  if (isSqueeze && price < ind.bbMiddle) {
    return { name: "Bollinger Squeeze", signal: -0.5, confidence: 0.4, reason: `squeeze, price below middle (${fmtNum(bbWidthPct)}%)` };
  }
  return { name: "Bollinger Squeeze", signal: 0, confidence: 0.2, reason: "no signal" };
}

function algoRsiDivergence(price: number, ind: Indicators): AlgorithmSignal {
  if (ind.rsi === null) {
    return { name: "RSI Divergence", signal: 0, confidence: 0, reason: "RSI not ready" };
  }

  if (ind.rsi < 40) {
    return { name: "RSI Divergence", signal: 1, confidence: 0.6, reason: `RSI oversold (${fmtNum(ind.rsi)})` };
  }
  if (ind.rsi > 60) {
    return { name: "RSI Divergence", signal: -1, confidence: 0.6, reason: `RSI overbought (${fmtNum(ind.rsi)})` };
  }
  if (ind.rsi < 45 && ind.macdHistogram !== null && ind.macdHistogram > 0) {
    return { name: "RSI Divergence", signal: 0.5, confidence: 0.4, reason: `RSI low + MACD bullish` };
  }
  if (ind.rsi > 55 && ind.macdHistogram !== null && ind.macdHistogram < 0) {
    return { name: "RSI Divergence", signal: -0.5, confidence: 0.4, reason: `RSI high + MACD bearish` };
  }
  return { name: "RSI Divergence", signal: 0, confidence: 0.2, reason: "neutral RSI" };
}

function algoMomentumVolume(price: number, ind: Indicators): AlgorithmSignal {
  const avgVol = 20;
  const tickVol = ind.tickVolume;
  const avgTickVol = 0; // will be computed externally

  if (ind.ema20 === null || ind.atr === null) {
    return { name: "Momentum+Volume", signal: 0, confidence: 0, reason: "indicators not ready" };
  }

  const momentum = (price - ind.ema20) / ind.atr;

  if (momentum > 0.5) {
    return { name: "Momentum+Volume", signal: 1, confidence: 0.55, reason: `momentum ${fmtNum(momentum)} > +0.5` };
  }
  if (momentum < -0.5) {
    return { name: "Momentum+Volume", signal: -1, confidence: 0.55, reason: `momentum ${fmtNum(momentum)} < -0.5` };
  }
  return { name: "Momentum+Volume", signal: 0, confidence: 0.2, reason: "weak momentum" };
}

function algoIndexTrade(index: number, last: number): AlgorithmSignal {
  const bias = -0.13;
  const threshold = 0.24;
  const indexLast = index - last;

  if (!Number.isFinite(indexLast)) {
    return { name: "Index Trade (trader2)", signal: 0, confidence: 0, reason: "no data" };
  }

  const adjusted = indexLast + bias;
  if (adjusted >= threshold) {
    return { name: "Index Trade (trader2)", signal: 1, confidence: 0.7, reason: `adjusted ${fmtNum(adjusted)} >= ${threshold} (indexLast ${fmtNum(indexLast)})` };
  }
  if (adjusted <= -threshold) {
    return { name: "Index Trade (trader2)", signal: -1, confidence: 0.7, reason: `adjusted ${fmtNum(adjusted)} <= -${threshold} (indexLast ${fmtNum(indexLast)})` };
  }
  return { name: "Index Trade (trader2)", signal: 0, confidence: 0.2, reason: `adjusted ${fmtNum(adjusted)} in dead band` };
}

/* ================================================================== */
/*  Ensemble Engine                                                    */
/* ================================================================== */

function ensembleVote(signals: AlgorithmSignal[]): { signal: number; confidence: number; reasons: string[] } {
  const trader2Signal = signals.find((s) => s.name === "Index Trade (trader2)");
  const otherSignals = signals.filter((s) => s.name !== "Index Trade (trader2)");

  const reasons: string[] = [];

  if (!trader2Signal || trader2Signal.signal === 0) {
    reasons.push(`NO TRADE: trader2 veto (signal: ${trader2Signal?.signal ?? "missing"})`);
    return { signal: 0, confidence: 0, reasons };
  }

  const dir = trader2Signal.signal > 0 ? 1 : -1;
  const agreeOthers = otherSignals.filter((s) => (dir > 0 ? s.signal > 0 : s.signal < 0));

  if (agreeOthers.length < ENSEMBLE_MIN_AGREE) {
    reasons.push(`NO TRADE: trader2 ${dir > 0 ? "LONG" : "SHORT"} but only ${agreeOthers.length}/${ENSEMBLE_MIN_AGREE} others agree`);
    return { signal: 0, confidence: 0, reasons };
  }

  const allAgree = [trader2Signal, ...agreeOthers];
  const confidence = allAgree.reduce((a, s) => a + s.confidence, 0) / allAgree.length;
  reasons.push(`${dir > 0 ? "LONG" : "SHORT"}: ${allAgree.map((s) => s.name).join(", ")}`);

  return { signal: dir, confidence, reasons };
}

/* ================================================================== */
/*  Risk Manager                                                       */
/* ================================================================== */

class RiskManager {
  private dailyTrades = 0;
  private dailyResetAt = Date.now();
  private lastLossTime = 0;

  canTrade(state: CompoundState, currentBalance: number): { ok: boolean; reason: string } {
    // Check drawdown
    if (state.peakBalance > 0) {
      const drawdown = (state.peakBalance - currentBalance) / state.peakBalance;
      if (drawdown >= MAX_DRAWDOWN_PCT) {
        return { ok: false, reason: `max drawdown ${fmtNum(drawdown * 100)}% >= ${MAX_DRAWDOWN_PCT * 100}%` };
      }
    }

    // Check loss cooldown
    if (Date.now() - this.lastLossTime < LOSS_COOLDOWN_MS) {
      const remaining = Math.ceil((LOSS_COOLDOWN_MS - (Date.now() - this.lastLossTime)) / 1000);
      return { ok: false, reason: `loss cooldown ${remaining}s remaining` };
    }

    // Check daily trade limit
    this.checkDailyReset();
    if (this.dailyTrades >= MAX_DAILY_TRADES) {
      return { ok: false, reason: `daily limit ${MAX_DAILY_TRADES} reached` };
    }

    return { ok: true, reason: "ok" };
  }

  recordTrade(): void {
    this.checkDailyReset();
    this.dailyTrades++;
  }

  recordLoss(): void {
    this.lastLossTime = Date.now();
  }

  private checkDailyReset(): void {
    const now = Date.now();
    if (now - this.dailyResetAt > 86_400_000) {
      this.dailyTrades = 0;
      this.dailyResetAt = now;
    }
  }
}

/* ================================================================== */
/*  Compound Engine                                                    */
/* ================================================================== */

function calcDynamicQty(state: CompoundState, currentBalance: number): number {
  if (state.tradeCount > 0 && state.tradeCount % RECALC_INTERVAL === 0) {
    const growthFactor = 1 + (state.totalPnl / (state.baseQty * 100));
    state.currentQty = clamp(state.baseQty * growthFactor, state.baseQty, MAX_QTY);
  }
  return Math.round(state.currentQty * 10000) / 10000;
}

/* ================================================================== */
/*  Performance Logger                                                 */
/* ================================================================== */

class PerformanceLogger {
  private trades: TradeRecord[] = [];
  private metricsPath = path.resolve(DATA_DIR, "metrics.json");
  private tradesPath = path.resolve(DATA_DIR, "trades.json");

  constructor() {
    const saved = loadJson<TradeRecord[]>(this.tradesPath);
    if (saved && Array.isArray(saved)) this.trades = saved;
  }

  recordTrade(trade: TradeRecord): void {
    this.trades.push(trade);
    saveJson(this.tradesPath, this.trades);
  }

  getMetrics(currentBalance: number, peakBalance: number): Metrics {
    const wins = this.trades.filter((t) => t.pnl > 0);
    const losses = this.trades.filter((t) => t.pnl <= 0);
    const totalPnl = this.trades.reduce((a, t) => a + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
    const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

    // Max drawdown from trade history
    let maxDd = 0;
    let peak = peakBalance;
    for (const t of this.trades) {
      if (t.balance > peak) peak = t.balance;
      const dd = (peak - t.balance) / peak;
      if (dd > maxDd) maxDd = dd;
    }

    return {
      totalTrades: this.trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: this.trades.length > 0 ? (wins.length / this.trades.length) * 100 : 0,
      totalPnl,
      avgWin,
      avgLoss,
      profitFactor,
      maxDrawdown: maxDd * 100,
      currentBalance,
      peakBalance,
    };
  }

  saveMetrics(metrics: Metrics): void {
    saveJson(this.metricsPath, metrics);
  }

  getTradeCount(): number {
    return this.trades.length;
  }
}

/* ================================================================== */
/*  State Persistence                                                  */
/* ================================================================== */

const STATE_PATH = path.resolve(DATA_DIR, "state.json");
const INDICATORS_PATH = path.resolve(DATA_DIR, "indicators.json");

function saveState(state: CompoundState): void {
  saveJson(STATE_PATH, state);
}

function loadState(): CompoundState | null {
  return loadJson<CompoundState>(STATE_PATH);
}

/* ================================================================== */
/*  WebSocket                                                          */
/* ================================================================== */

let cachedFields: string[] | null = null;
const indicatorEngine = new IndicatorEngine();

function handleTicker(msg: Record<string, unknown>): TickerData | null {
  // USDT-M pack format
  if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.data)) {
    if (Array.isArray(msg.fields)) cachedFields = msg.fields as string[];
    if (!cachedFields) return null;
    for (const row of msg.data as unknown[][]) {
      if (row.length < 1) continue;
      const sym = String(row[0]);
      if (sym !== SYMBOL) continue;
      const d: Record<string, unknown> = {};
      for (let i = 0; i < cachedFields.length && i < row.length; i++) {
        d[cachedFields[i]] = row[i];
      }
      return {
        symbol: sym,
        ask: Number(d.askRp ?? 0),
        bid: Number(d.bidRp ?? 0),
        index: Number(d.indexRp ?? 0),
        mark: Number(d.markRp ?? 0),
        last: Number(d.lastRp ?? 0),
        timestamp: Number(d.timestamp ?? Date.now() * 1_000_000),
      };
    }
  }

  // Single symbol format
  if (msg.method === "market24h_p.update" && msg.data) {
    const d = msg.data as Record<string, unknown>;
    if (String(d.symbol ?? "") !== SYMBOL) return null;
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

  return null;
}

/* ================================================================== */
/*  Order Executor                                                     */
/* ================================================================== */

async function openPosition(
  side: "Buy" | "Sell",
  posSide: "Long" | "Short",
  qty: number,
  apiKey: string,
  secretRaw: Buffer,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) {
    console.log(`[${fmtTime()}]   [DRY-RUN] market-${side} ${qty} ${SYMBOL} (posSide ${posSide})`);
    return true;
  }

  try {
    await setLeverageUsdtM(SYMBOL, LEVERAGE, posSide, apiKey, secretRaw);
    const result = await placeMarketOrder(
      { account: "usdt-m", symbol: SYMBOL, side, price: 0, qty, posSide },
      apiKey,
      secretRaw,
    );
    console.log(`[${fmtTime()}]   ✓  ${posSide} opened — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`);
    return true;
  } catch (e) {
    console.error(`[${fmtTime()}]   ✗  ${posSide} open failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function closePosition(
  posSide: "Long" | "Short",
  qty: number,
  apiKey: string,
  secretRaw: Buffer,
  dryRun: boolean,
): Promise<boolean> {
  const side = posSide === "Long" ? "Sell" : "Buy";
  if (dryRun) {
    console.log(`[${fmtTime()}]   [DRY-RUN] market-${side} ${qty} ${SYMBOL} to CLOSE ${posSide}`);
    return true;
  }

  try {
    const result = await placeMarketOrder(
      { account: "usdt-m", symbol: SYMBOL, side, price: 0, qty: Math.round(qty * 10000) / 10000, posSide },
      apiKey,
      secretRaw,
    );
    console.log(`[${fmtTime()}]   ✓  ${posSide} closed — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`);
    return true;
  } catch (e) {
    console.error(`[${fmtTime()}]   ✗  ${posSide} close failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function fetchPositionsForSymbol(apiKey: string, secretRaw: Buffer): Promise<{ longSize: number; shortSize: number; longEntry: number; shortEntry: number }> {
  const positions = await fetchPositions(apiKey, secretRaw);
  let longSize = 0;
  let shortSize = 0;
  let longEntry = 0;
  let shortEntry = 0;
  for (const p of positions) {
    if (p.symbol !== SYMBOL) continue;
    const size = parseFloat(p.size || "0");
    const entry = parseFloat(p.avgEntryPriceRp || "0");
    if (p.side === "Buy") {
      longSize += size;
      longEntry = entry;
    } else if (p.side === "Sell") {
      shortSize += size;
      shortEntry = entry;
    }
  }
  return { longSize, shortSize, longEntry, shortEntry };
}

/* ================================================================== */
/*  Main                                                               */
/* ================================================================== */

async function main(): Promise<void> {
  const dryRun = hasFlag("--dry-run");
  const restore = hasFlag("--restore");
  const sizeArg = getArg("--size");
  const startQty = sizeArg !== undefined ? Number(sizeArg) : BASE_QTY;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const creds = loadCredentials();
  const secretRaw = Buffer.from(creds.PHEMEX_API_SECRET, "base64");

  // Load or initialize state
  let state: CompoundState = restore && loadState()
    ? loadState()!
    : {
        peakBalance: 1.0,
        tradeCount: 0,
        baseQty: startQty,
        currentQty: startQty,
        totalPnl: 0,
        consecutiveLosses: 0,
        lastTradeTime: 0,
        position: "NONE",
        entryPrice: 0,
        entryQty: 0,
        bestPnlPct: 0,
      };

  // Runtime signal tracking
  let tickCount = 0;
  let lastSignalDir = 0; // +1 long, -1 short, 0 neutral
  let signalStreak = 0; // consecutive same-direction signals

  // Restore indicator state
  if (restore) {
    const indState = loadJson<ReturnType<IndicatorEngine["getState"]>>(INDICATORS_PATH);
    if (indState) {
      indicatorEngine.loadState(indState);
      console.log(`[${fmtTime()}] ⟐  Restored ${indState.prices.length} price history`);
      if (indState.prices.length >= WARMUP_TICKS) {
        tickCount = WARMUP_TICKS; // skip warmup — enough history restored
      }
    }
  }

  // Validate state against actual exchange positions
  try {
    const actualPos = await fetchPositionsForSymbol(creds.PHEMEX_API_KEY, secretRaw);
    const hasActual = actualPos.longSize > 0 || actualPos.shortSize > 0;
    const hasState = state.position !== "NONE";
    if (hasActual && !hasState) {
      console.log(`[${fmtTime()}] ⚠  Exchange has position but state is NONE — syncing`);
      if (actualPos.longSize > 0) {
        state.position = "LONG";
        state.entryPrice = actualPos.longEntry;
        state.entryQty = actualPos.longSize;
      } else {
        state.position = "SHORT";
        state.entryPrice = actualPos.shortEntry;
        state.entryQty = actualPos.shortSize;
      }
    } else if (!hasActual && hasState) {
      console.log(`[${fmtTime()}] ⚠  State says ${state.position} but no exchange position — resetting`);
      state.position = "NONE";
      state.entryPrice = 0;
      state.entryQty = 0;
    }
  } catch (e) {
    console.error(`[${fmtTime()}] ✗  Position sync check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const riskManager = new RiskManager();
  const perfLogger = new PerformanceLogger();

  let lastTicker: TickerData | null = null;

  console.log(`[${fmtTime()}] ═ ${SYMBOL} Compound Trader ${dryRun ? "(DRY RUN)" : ""} ══════════════════════`);
  console.log(`[${fmtTime()}]   Qty: ${state.currentQty}   Leverage: ${LEVERAGE}x   TP: ${TAKE_PROFIT_PCT * 100}%   SL: ${STOP_LOSS_PCT * 100}%`);
  console.log(`[${fmtTime()}]   Max Drawdown: ${MAX_DRAWDOWN_PCT * 100}%   Loss Cooldown: ${LOSS_COOLDOWN_MS / 1000}s   Ensemble: trader2 mandatory + ${ENSEMBLE_MIN_AGREE}/5 algorithms`);
  console.log(`[${fmtTime()}]   State: ${state.position} | Balance: $${fmtNum(state.peakBalance, 4)} | Trades: ${perfLogger.getTradeCount()}`);
  console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════════════════════════`);

  // Set initial leverage
  try {
    await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", creds.PHEMEX_API_KEY, secretRaw);
    console.log(`[${fmtTime()}]   ✓  ${SYMBOL} leverage set to ${LEVERAGE}x`);
  } catch (e) {
    console.error(`[${fmtTime()}]   ✗  Leverage setup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Start WebSocket
  const ws = new ReconnectingWs(WS_URL, {
    registerSigint: false,
    onOpen: () => {
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
      console.log(`[${fmtTime()}]   ✓  WebSocket connected`);
    },
    onMessage: (msg) => {
      const ticker = handleTicker(msg as Record<string, unknown>);
      if (ticker) lastTicker = ticker;
    },
    onReconnect: () => {
      cachedFields = null;
    },
  });

  ws.connect();

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Saving state...`);
    saveState(state);
    saveJson(INDICATORS_PATH, indicatorEngine.getState());
    const metrics = perfLogger.getMetrics(state.peakBalance, state.peakBalance);
    perfLogger.saveMetrics(metrics);
    ws.shutdown();
    console.log(`[${fmtTime()}] ⏹  Stopped. State saved.`);
    process.exit(0);
  });

  // Main trading loop
  let prevEma20: number | null = null;
  let prevEma50: number | null = null;
  let lineCount = 0;

  for (;;) {
    const started = Date.now();

    try {
      const ticker = lastTicker;
      if (!ticker || ticker.last <= 0) {
        await sleep(PAUSE_MS);
        continue;
      }

      const price = ticker.last;
      const ask = ticker.ask;
      const bid = ticker.bid;
      const high = ticker.ask;
      const low = ticker.bid;
      const tickVol = 1; // simplified tick volume

      // Update indicators
      indicatorEngine.addTick(price, high, low, tickVol);
      const ind = indicatorEngine.getIndicators();
      tickCount++;

      // Run all 6 algorithms
      const signals: AlgorithmSignal[] = [
        algoEmaCrossover(price, ind),
        algoIndexDivergence(ticker.index, ticker.last),
        algoBollingerSqueeze(price, ind),
        algoRsiDivergence(price, ind),
        algoMomentumVolume(price, ind),
        algoIndexTrade(ticker.index, ticker.last),
      ];

      // Ensemble vote
      const vote = ensembleVote(signals);

      // Signal debounce: only track when flat (looking to enter)
      const currentDir = vote.signal > 0 ? 1 : vote.signal < 0 ? -1 : 0;
      if (state.position !== "NONE") {
        signalStreak = 0;
        lastSignalDir = 0;
      } else if (currentDir === lastSignalDir && currentDir !== 0) {
        signalStreak++;
      } else {
        signalStreak = currentDir !== 0 ? 1 : 0;
        lastSignalDir = currentDir;
      }

      // Check positions
      const pos = await fetchPositionsForSymbol(creds.PHEMEX_API_KEY, secretRaw);

      // Sync state with actual positions
      if (pos.longSize > 0 && state.position !== "LONG") {
        state.position = "LONG";
        state.entryPrice = pos.longEntry;
        state.entryQty = pos.longSize;
      } else if (pos.shortSize > 0 && state.position !== "SHORT") {
        state.position = "SHORT";
        state.entryPrice = pos.shortEntry;
        state.entryQty = pos.shortSize;
      } else if (pos.longSize === 0 && pos.shortSize === 0 && state.position !== "NONE") {
        state.position = "NONE";
      }

      // Check take profit / stop loss for existing position
      if (state.position === "LONG" && pos.longSize > 0) {
        const exitPrice = bid; // close long at bid
        const pnlPct = (exitPrice - state.entryPrice) / state.entryPrice;
        // Track best PnL for trailing stop
        if (pnlPct > state.bestPnlPct) state.bestPnlPct = pnlPct;
        if (pnlPct >= TAKE_PROFIT_PCT) {
          console.log(`[${fmtTime()}]  ✦  TP hit: ${fmtNum(pnlPct * 100)}% >= ${TAKE_PROFIT_PCT * 100}% — closing LONG`);
          if (await closePosition("Long", pos.longSize, creds.PHEMEX_API_KEY, secretRaw, dryRun)) {
            const pnl = (exitPrice - state.entryPrice) * pos.longSize;
            state.totalPnl += pnl;
            state.tradeCount++;
            state.position = "NONE";
            state.bestPnlPct = 0;
            riskManager.recordTrade();
            perfLogger.recordTrade({
              time: new Date().toISOString(),
              side: "Long",
              entry: state.entryPrice,
              exit: exitPrice,
              qty: pos.longSize,
              pnl,
              pnlPct: pnlPct * 100,
              reason: "TP",
              balance: state.peakBalance + state.totalPnl,
            });
          }
        } else {
          const atrPct = ind.atr !== null ? (ind.atr / price) : null;
          const dynSlPct = atrPct !== null
            ? clamp(atrPct * ATR_SL_MULT, MIN_SL_PCT, MAX_SL_PCT)
            : STOP_LOSS_PCT;
          // Trailing stop: if in profit beyond activation threshold, trail behind best PnL
          const trailingActive = state.bestPnlPct >= TRAILING_ACTIVATE_PCT;
          const effectiveSlPct = trailingActive
            ? Math.max(dynSlPct, state.bestPnlPct - TRAILING_STEP_PCT)
            : dynSlPct;
          if (pnlPct <= -effectiveSlPct) {
            const reason = trailingActive ? "TRAIL-SL" : "SL";
            console.log(`[${fmtTime()}]  ✦  ${reason} hit: ${fmtNum(pnlPct * 100)}% <= -${effectiveSlPct * 100}% — closing LONG`);
            if (await closePosition("Long", pos.longSize, creds.PHEMEX_API_KEY, secretRaw, dryRun)) {
              const pnl = (exitPrice - state.entryPrice) * pos.longSize;
              state.totalPnl += pnl;
              state.tradeCount++;
              state.position = "NONE";
              state.bestPnlPct = 0;
              riskManager.recordTrade();
              if (!trailingActive) riskManager.recordLoss();
              perfLogger.recordTrade({
                time: new Date().toISOString(),
                side: "Long",
                entry: state.entryPrice,
                exit: exitPrice,
                qty: pos.longSize,
                pnl,
                pnlPct: pnlPct * 100,
                reason,
                balance: state.peakBalance + state.totalPnl,
              });
            }
          }
        }
      } else if (state.position === "SHORT" && pos.shortSize > 0) {
        const exitPrice = ask; // close short at ask
        const pnlPct = (state.entryPrice - exitPrice) / state.entryPrice;
        // Track best PnL for trailing stop
        if (pnlPct > state.bestPnlPct) state.bestPnlPct = pnlPct;
        if (pnlPct >= TAKE_PROFIT_PCT) {
          console.log(`[${fmtTime()}]  ✦  TP hit: ${fmtNum(pnlPct * 100)}% >= ${TAKE_PROFIT_PCT * 100}% — closing SHORT`);
          if (await closePosition("Short", pos.shortSize, creds.PHEMEX_API_KEY, secretRaw, dryRun)) {
            const pnl = (state.entryPrice - exitPrice) * pos.shortSize;
            state.totalPnl += pnl;
            state.tradeCount++;
            state.position = "NONE";
            state.bestPnlPct = 0;
            riskManager.recordTrade();
            perfLogger.recordTrade({
              time: new Date().toISOString(),
              side: "Short",
              entry: state.entryPrice,
              exit: exitPrice,
              qty: pos.shortSize,
              pnl,
              pnlPct: pnlPct * 100,
              reason: "TP",
              balance: state.peakBalance + state.totalPnl,
            });
          }
        } else {
          const atrPct = ind.atr !== null ? (ind.atr / price) : null;
          const dynSlPct = atrPct !== null
            ? clamp(atrPct * ATR_SL_MULT, MIN_SL_PCT, MAX_SL_PCT)
            : STOP_LOSS_PCT;
          // Trailing stop: if in profit beyond activation threshold, trail behind best PnL
          const trailingActive = state.bestPnlPct >= TRAILING_ACTIVATE_PCT;
          const effectiveSlPct = trailingActive
            ? Math.max(dynSlPct, state.bestPnlPct - TRAILING_STEP_PCT)
            : dynSlPct;
          if (pnlPct <= -effectiveSlPct) {
            const reason = trailingActive ? "TRAIL-SL" : "SL";
            console.log(`[${fmtTime()}]  ✦  ${reason} hit: ${fmtNum(pnlPct * 100)}% <= -${effectiveSlPct * 100}% — closing SHORT`);
            if (await closePosition("Short", pos.shortSize, creds.PHEMEX_API_KEY, secretRaw, dryRun)) {
              const pnl = (state.entryPrice - exitPrice) * pos.shortSize;
              state.totalPnl += pnl;
              state.tradeCount++;
              state.position = "NONE";
              state.bestPnlPct = 0;
              riskManager.recordTrade();
              if (!trailingActive) riskManager.recordLoss();
              perfLogger.recordTrade({
                time: new Date().toISOString(),
                side: "Short",
                entry: state.entryPrice,
                exit: exitPrice,
                qty: pos.shortSize,
                pnl,
                pnlPct: pnlPct * 100,
                reason,
                balance: state.peakBalance + state.totalPnl,
              });
            }
          }
        }
      }

      // Fetch real account balance from Phemex
      let currentBalance = state.peakBalance + state.totalPnl;
      try {
        const acct = await fetchAccountBalance(creds.PHEMEX_API_KEY, secretRaw);
        if (acct.total > 0) {
          currentBalance = acct.total;
          if (currentBalance > state.peakBalance) state.peakBalance = currentBalance;
        }
      } catch {
        // fall back to computed balance
      }

      const riskCheck = riskManager.canTrade(state, currentBalance);
      if (!riskCheck.ok) {
        // Suppress repeated log for same reason
      } else if (tickCount < WARMUP_TICKS) {
        // Wait for indicator warmup
      } else if (signalStreak < SIGNAL_DEBOUNCE) {
        // Signal not confirmed yet
      } else if (vote.signal !== 0 && state.position === "NONE") {
        const qty = calcDynamicQty(state, currentBalance);
        const side = vote.signal > 0 ? "Buy" : "Sell";
        const posSide = vote.signal > 0 ? "Long" : "Short";

        console.log(
          `[${fmtTime()}]  ⟐  ${posSide} signal (${fmtNum(vote.confidence, 2)}) ` +
          `[${vote.reasons.join(" | ")}] ` +
          `qty: ${qty} @ ${LEVERAGE}x`
        );

        if (await openPosition(side, posSide, qty, creds.PHEMEX_API_KEY, secretRaw, dryRun)) {
          state.position = posSide.toUpperCase() as "LONG" | "SHORT";
          state.entryPrice = posSide === "Long" ? ask : bid;
          state.entryQty = qty;
          state.bestPnlPct = 0;
          state.lastTradeTime = Date.now();
          riskManager.recordTrade();
        }
      }

      // Update peak balance and save state periodically
      if (state.tradeCount > 0 && state.tradeCount % 5 === 0) {
        saveState(state);
        saveJson(INDICATORS_PATH, indicatorEngine.getState());
        const metrics = perfLogger.getMetrics(currentBalance, state.peakBalance);
        perfLogger.saveMetrics(metrics);
      }

      // Display status
      const posLabel = state.position === "NONE" ? "FLAT" : `${state.position} @ ${fmtNum(state.entryPrice)}`;
      const warmup = tickCount < WARMUP_TICKS ? ` WARMUP(${tickCount}/${WARMUP_TICKS})` : "";
      const debounce = signalStreak > 0 ? ` streak:${signalStreak}` : "";
      let pnlInfo = "";
      if (state.position !== "NONE" && state.entryPrice > 0) {
        const isLong = state.position === "LONG";
        const exitRef = isLong ? bid : ask; // bid for LONG, ask for SHORT
        const pnlPct = isLong
          ? (exitRef - state.entryPrice) / state.entryPrice
          : (state.entryPrice - exitRef) / state.entryPrice;
        const tpPrice = isLong
          ? state.entryPrice * (1 + TAKE_PROFIT_PCT)
          : state.entryPrice * (1 - TAKE_PROFIT_PCT);
        const atrPct = ind.atr !== null ? (ind.atr / price) : null;
        const dynSlPct = atrPct !== null
          ? clamp(atrPct * ATR_SL_MULT, MIN_SL_PCT, MAX_SL_PCT)
          : STOP_LOSS_PCT;
        const trailingActive = state.bestPnlPct >= TRAILING_ACTIVATE_PCT;
        const effectiveSlPct = trailingActive
          ? Math.max(dynSlPct, state.bestPnlPct - TRAILING_STEP_PCT)
          : dynSlPct;
        const slPrice = isLong
          ? state.entryPrice * (1 - effectiveSlPct)
          : state.entryPrice * (1 + effectiveSlPct);
        const trailLabel = trailingActive ? `${fmtNum(slPrice)}` : `OFF(${fmtNum(state.bestPnlPct * 100)}%)`;
        pnlInfo = ` ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct * 100)}% ${fmtNum(tpPrice)} ${fmtNum(slPrice)} ${trailLabel}`;
      }
      const sigChar = vote.signal > 0 ? "↑" : vote.signal < 0 ? "↓" : "—";
      // Algorithm status: Uppercase=long, lowercase=short, .=neutral
      const algoStatus = signals.map((s) => {
        if (s.signal > 0) return s.name[0].toUpperCase();
        if (s.signal < 0) return s.name[0].toLowerCase();
        return ".";
      }).join("");
      if (lineCount % (process.stdout.rows || 24) === 0) {
        console.log(`Bal    Price   Ask    Bid   Index  Last   I-L    EMA20  EMA50  EMA200 EMA1200 EMA3000 EMA12000  RSI  ATR  Algo  Sig  Pos           PnL    TP     SL    Trail     Trades`);
      }
      lineCount++;
      const rpad = (s: string, n: number) => s.padStart(n);
      const lpad = (s: string, n: number) => s.padEnd(n);
      let pnlStr = "";
      let tpStr = "";
      let slStr = "";
      let trailStr = "";
      if (state.position !== "NONE" && state.entryPrice > 0) {
        const isLong = state.position === "LONG";
        const exitRef = isLong ? bid : ask;
        const pnlPct = isLong
          ? (exitRef - state.entryPrice) / state.entryPrice
          : (state.entryPrice - exitRef) / state.entryPrice;
        const tpPrice = isLong
          ? state.entryPrice * (1 + TAKE_PROFIT_PCT)
          : state.entryPrice * (1 - TAKE_PROFIT_PCT);
        const atrPct = ind.atr !== null ? (ind.atr / price) : null;
        const dynSlPct = atrPct !== null
          ? clamp(atrPct * ATR_SL_MULT, MIN_SL_PCT, MAX_SL_PCT)
          : STOP_LOSS_PCT;
        const trailingActive = state.bestPnlPct >= TRAILING_ACTIVATE_PCT;
        const effectiveSlPct = trailingActive
          ? Math.max(dynSlPct, state.bestPnlPct - TRAILING_STEP_PCT)
          : dynSlPct;
        const slPrice = isLong
          ? state.entryPrice * (1 - effectiveSlPct)
          : state.entryPrice * (1 + effectiveSlPct);
        pnlStr = `${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct * 100)}%`;
        tpStr = fmtNum(tpPrice);
        slStr = fmtNum(slPrice);
        trailStr = trailingActive ? fmtNum(slPrice) : `OFF(${fmtNum(state.bestPnlPct * 100)}%)`;
      }
      const indexLast = ticker.index - ticker.last;
      console.log(
        `${rpad(fmtNum(currentBalance, 3), 3)}  ` +
        `${rpad(fmtNum(price), 5)}  ` +
        `${rpad(fmtNum(ask), 5)}  ` +
        `${rpad(fmtNum(bid), 5)}  ` +
        `${rpad(fmtNum(ticker.index), 5)}  ` +
        `${rpad(fmtNum(ticker.last), 5)}  ` +
        `${rpad(fmtNum(indexLast), 5)}  ` +
        `${rpad(fmtNum(ind.ema20), 5)}  ` +
        `${rpad(fmtNum(ind.ema50), 5)}  ` +
        `${rpad(fmtNum(ind.ema200), 5)}  ` +
        `${rpad(fmtNum(ind.ema1200), 6)}  ` +
        `${rpad(fmtNum(ind.ema3000), 6)}  ` +
        `${rpad(fmtNum(ind.ema12000), 7)}  ` +
        `${rpad(fmtNum(ind.rsi, 0), 3)}  ` +
        `${rpad(fmtNum(ind.atr), 5)}  ` +
        `${lpad(algoStatus, 6)}  ` +
        `${lpad(sigChar, 3)}  ` +
        `${lpad(posLabel, 9)} ` +
        `${rpad(pnlStr, 5)} ` +
        `${rpad(tpStr, 5)} ` +
        `${rpad(slStr, 4)} ` +
        `${lpad(trailStr, 7)}  ` +
        `${state.tradeCount}${warmup}${debounce}`
      );

    } catch (e) {
      console.error(`[${fmtTime()}] ✗  Cycle error: ${e instanceof Error ? e.message : String(e)}`);
    }

    const elapsed = Date.now() - started;
    await sleep(Math.max(0, PAUSE_MS - elapsed));
  }
}

main().catch((e) => {
  console.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
