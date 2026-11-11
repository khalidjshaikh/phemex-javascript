#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-npu-trader.ts — Neural network trading using Apple Neural Engine.
 *
 * Uses ONNX Runtime with CoreMLExecutionProvider for ANE acceleration.
 * Features:
 *   - Multi-task model: direction, magnitude, signal
 *   - Online learning: continuous model updates
 *   - Real-time inference on ticker data
 *
 * Usage:
 *   npx tsx scripts/phemex-npu-trader.ts --symbol PUMPUSDT
 *   npx tsx scripts/phemex-npu-trader.ts --symbol XRPUSDT --dry-run
 *   npx tsx scripts/phemex-npu-trader.ts --collect-only
 *   npx tsx scripts/phemex-npu-trader.ts --train-only
 */
import fs from 'node:fs';
import path from 'node:path';
import { ReconnectingWs } from '../src/ws-client.js';
import { getArg, hasFlag, findSymbolRow } from '../src/cli-utils.js';
import { loadCredentials } from '../src/credentials.js';
import { placeMarketOrder, setLeverageUsdtM } from '../src/place-limit-order.js';
import { fetchPositions, closePosition, type Position } from '../src/positions.js';
import { NeuralNet, TickerFeatures, ModelPrediction } from '../src/neural-net.js';
import { TrainingPipeline, DataBuffer } from '../src/training.js';

/* ── CLI Options ──────────────────────────────────────────────────────── */

const DRY_RUN = hasFlag('--dry-run');
const SYMBOL = (getArg('--symbol') ?? 'PUMPUSDT').toUpperCase();
const SIZE = Number(getArg('--size') ?? 1);
const LEVERAGE = Number(getArg('--leverage') ?? 20);
const CREDENTIAL = getArg('--credential');
const COLLECT_ONLY = hasFlag('--collect-only');
const TRAIN_ONLY = hasFlag('--train-only');
const VERBOSE = hasFlag('--verbose');

const USAGE = `Usage: npx tsx scripts/phemex-npu-trader.ts [options]

Neural network trading using Apple Neural Engine (ANE).

Options:
  --symbol <SYMBOL>      Symbol to trade (default: PUMPUSDT)
  --size <N>             Position size (default: 1)
  --leverage <N>         Leverage (default: 20)
  --credential <name>    Credential profile
  --dry-run              Simulate trades without placing orders
  --collect-only         Only collect data, don't trade
  --train-only           Only train model, don't trade
  --verbose              Log detailed predictions
  --help                 Show this help`;

if (hasFlag('--help')) {
  console.log(USAGE);
  process.exit(0);
}

/* ── Credentials ──────────────────────────────────────────────────────── */

function loadCredentialProfile(name: string) {
  const credsPath = path.resolve(process.cwd(), '.credentials.json');
  if (!fs.existsSync(credsPath)) {
    console.error(`Missing ${credsPath}`);
    process.exit(1);
  }
  const all = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  if (!all[name]) {
    console.error(`Credential "${name}" not found`);
    process.exit(1);
  }
  return all[name];
}

const creds = CREDENTIAL ? loadCredentialProfile(CREDENTIAL) : loadCredentials();
const secretRaw = Buffer.from(creds.PHEMEX_API_SECRET, 'base64');

/* ── WebSocket ────────────────────────────────────────────────────────── */

const WS_URL = 'wss://ws.phemex.com';
const isUsdtM = SYMBOL.endsWith('USDT');

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

function handleTicker(msg: Record<string, unknown>): void {
  if (msg.method === 'market24h_p.update' && msg.data) {
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

  if (msg.method === 'perp_market24h_pack_p.update' && Array.isArray(msg.data)) {
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

function startWebSocket(): ReconnectingWs {
  const ws = new ReconnectingWs(WS_URL, {
    registerSigint: false,
    onOpen: () => {
      if (isUsdtM) {
        ws.send({ method: 'perp_market24h_pack_p.subscribe', params: [], id: 1 });
      } else {
        ws.send({ method: 'market24h.subscribe', params: [SYMBOL], id: 1 });
      }
    },
    onMessage: handleTicker,
    onReconnect: () => { cachedFields = null; },
  });
  ws.connect();
  return ws;
}

/* ── Feature Extraction ───────────────────────────────────────────────── */

class FeatureExtractor {
  private prevBid: number | null = null;
  private prevAsk: number | null = null;
  private prevLast: number | null = null;

  private deltaLastWindow: { ts: number; val: number }[] = [];
  private deltaAskWindow: { ts: number; val: number }[] = [];
  private deltaBidWindow: { ts: number; val: number }[] = [];
  private changeTimestamps: number[] = [];

  private deltaLastWindowHour: { ts: number; val: number }[] = [];
  private deltaAskWindowHour: { ts: number; val: number }[] = [];
  private deltaBidWindowHour: { ts: number; val: number }[] = [];
  private changeTimestampsHour: number[] = [];

  private cumulativeDeltaBidNeg = 0;
  private cumulativeDeltaAskPos = 0;

  private priceBuffer: { ts: number; last: number }[] = [];
  private readonly SLOPE_N = 10;

  extract(ticker: TickerData): TickerFeatures {
    const now = Date.now();
    const cutoff = now - 60000;
    const cutoffHour = now - 3600000;

    // Current deltas
    const deltaBid = this.prevBid !== null ? ticker.bid - this.prevBid : 0;
    const deltaAsk = this.prevAsk !== null ? ticker.ask - this.prevAsk : 0;
    const deltaLast = this.prevLast !== null ? ticker.last - this.prevLast : 0;

    // Update cumulative deltas
    if (deltaBid < 0) this.cumulativeDeltaBidNeg += deltaBid;
    if (deltaAsk > 0) this.cumulativeDeltaAskPos += deltaAsk;

    // Update price buffer for slope
    this.priceBuffer.push({ ts: now, last: ticker.last });
    while (this.priceBuffer.length > this.SLOPE_N) {
      this.priceBuffer.shift();
    }

    // Update windows
    if (deltaLast !== 0) {
      this.changeTimestamps.push(now);
      this.changeTimestampsHour.push(now);
    }
    if (deltaLast !== null) {
      this.deltaLastWindow.push({ ts: now, val: deltaLast });
      this.deltaLastWindowHour.push({ ts: now, val: deltaLast });
    }
    if (deltaAsk !== null) {
      this.deltaAskWindow.push({ ts: now, val: deltaAsk });
      this.deltaAskWindowHour.push({ ts: now, val: deltaAsk });
    }
    if (deltaBid !== null) {
      this.deltaBidWindow.push({ ts: now, val: deltaBid });
      this.deltaBidWindowHour.push({ ts: now, val: deltaBid });
    }

    // Trim old data
    this.changeTimestamps = this.changeTimestamps.filter(ts => ts > cutoff);
    this.deltaLastWindow = this.deltaLastWindow.filter(x => x.ts > cutoff);
    this.deltaAskWindow = this.deltaAskWindow.filter(x => x.ts > cutoff);
    this.deltaBidWindow = this.deltaBidWindow.filter(x => x.ts > cutoff);

    this.changeTimestampsHour = this.changeTimestampsHour.filter(ts => ts > cutoffHour);
    this.deltaLastWindowHour = this.deltaLastWindowHour.filter(x => x.ts > cutoffHour);
    this.deltaAskWindowHour = this.deltaAskWindowHour.filter(x => x.ts > cutoffHour);
    this.deltaBidWindowHour = this.deltaBidWindowHour.filter(x => x.ts > cutoffHour);

    // Calculate slope
    const slope = this.calculateSlope();
    const slopeAngle = Math.atan(slope) * (180 / Math.PI);

    // Store previous values
    this.prevBid = ticker.bid;
    this.prevAsk = ticker.ask;
    this.prevLast = ticker.last;

    return {
      // Price features
      last: ticker.last,
      bid: ticker.bid,
      ask: ticker.ask,
      index: ticker.index,
      mark: ticker.mark,
      spread: ticker.ask - ticker.bid,
      vector: ticker.index - ticker.last,

      // Delta features
      deltaLast,
      deltaBid,
      deltaAsk,

      // Rolling window (1 min)
      deltaLastSum: this.deltaLastWindow.reduce((acc, x) => acc + x.val, 0),
      deltaLastPosSum: this.deltaLastWindow.filter(x => x.val > 0).reduce((acc, x) => acc + x.val, 0),
      deltaLastNegSum: this.deltaLastWindow.filter(x => x.val < 0).reduce((acc, x) => acc + x.val, 0),
      deltaAskSum: this.deltaAskWindow.reduce((acc, x) => acc + x.val, 0),
      deltaBidSum: this.deltaBidWindow.reduce((acc, x) => acc + x.val, 0),
      changeRate: this.changeTimestamps.length,

      // Hourly features
      deltaLastSumHour: this.deltaLastWindowHour.reduce((acc, x) => acc + x.val, 0),
      deltaAskPosSumHour: this.deltaAskWindowHour.filter(x => x.val > 0).reduce((acc, x) => acc + x.val, 0),
      deltaBidNegSumHour: this.deltaBidWindowHour.filter(x => x.val < 0).reduce((acc, x) => acc + x.val, 0),
      changeRateHour: this.changeTimestampsHour.length,

      // Cumulative features
      cumulativeDeltaBidNeg: this.cumulativeDeltaBidNeg,
      cumulativeDeltaAskPos: this.cumulativeDeltaAskPos,

      // Slope features
      slope,
      slopeAngle,

      // Normalized features (will be normalized by neural net)
      lastNorm: ticker.last,
      bidNorm: ticker.bid,
      askNorm: ticker.ask,
    };
  }

  private calculateSlope(): number {
    if (this.priceBuffer.length < 2) return 0;

    const n = this.priceBuffer.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
      const x = i;
      const y = this.priceBuffer[i].last;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
  }

  reset(): void {
    this.prevBid = null;
    this.prevAsk = null;
    this.prevLast = null;
    this.deltaLastWindow = [];
    this.deltaAskWindow = [];
    this.deltaBidWindow = [];
    this.changeTimestamps = [];
    this.deltaLastWindowHour = [];
    this.deltaAskWindowHour = [];
    this.deltaBidWindowHour = [];
    this.changeTimestampsHour = [];
    this.cumulativeDeltaBidNeg = 0;
    this.cumulativeDeltaAskPos = 0;
    this.priceBuffer = [];
  }
}

/* ── Trading Logic ────────────────────────────────────────────────────── */

class NPUTrader {
  private neuralNet: NeuralNet;
  private trainingPipeline: TrainingPipeline;
  private featureExtractor: FeatureExtractor;

  private longCooldown = 0;
  private shortCooldown = 0;
  private readonly CD_LONG = 60;
  private readonly CD_SHORT = 60;

  private lastPrediction: ModelPrediction | null = null;
  private tickCount = 0;

  constructor() {
    this.neuralNet = new NeuralNet(SYMBOL);
    this.trainingPipeline = new TrainingPipeline({
      symbol: SYMBOL,
      collectDuration: 10 * 60 * 1000,
      minSamples: 500,
      retrainInterval: 4 * 60 * 60 * 1000,
      lookforward: 10,
      threshold: 0.001,
    });
    this.featureExtractor = new FeatureExtractor();
  }

  async initialize(): Promise<void> {
    console.log(`[NPUTrader] Initializing for ${SYMBOL}...`);
    await this.neuralNet.initialize();
    await this.trainingPipeline.initialize();
    console.log(`[NPUTrader] Initialized successfully`);
  }

  async tick(ticker: TickerData): Promise<void> {
    this.tickCount++;

    // Extract features
    const features = this.featureExtractor.extract(ticker);

    // Add to training buffer
    this.trainingPipeline.addData(features, ticker.last);

    // Run inference
    const prediction = await this.neuralNet.predict(features);
    this.lastPrediction = prediction;

    // Log prediction
    if (VERBOSE || this.tickCount % 10 === 0) {
      console.log(`[${this.tsNow()}] Predict: dir=${prediction.direction === 1 ? 'UP' : 'DOWN'} (${(prediction.directionConfidence * 100).toFixed(1)}%) | mag=${(prediction.magnitude * 100).toFixed(4)}% | signal=${prediction.signal === 1 ? 'BUY' : prediction.signal === -1 ? 'SELL' : 'HOLD'} (${(prediction.signalConfidence * 100).toFixed(1)}%)`);
    }

    // Check if should retrain
    if (this.trainingPipeline.shouldRetrain()) {
      console.log(`[${this.tsNow()}] Retraining model...`);
      const result = await this.trainingPipeline.train();
      console.log(`[${this.tsNow()}] Training complete: accuracy=${(result.accuracy * 100).toFixed(1)}%`);
    }

    // Cooldown management
    if (this.longCooldown > 0) this.longCooldown--;
    if (this.shortCooldown > 0) this.shortCooldown--;
  }

  async trade(ticker: TickerData): Promise<void> {
    if (COLLECT_ONLY || TRAIN_ONLY) return;
    if (!this.lastPrediction) return;

    const prediction = this.lastPrediction;

    // Fetch current positions
    let longSize = 0;
    let shortSize = 0;
    let longPos: Position | null = null;
    let shortPos: Position | null = null;

    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      for (const pos of positions) {
        if (pos.symbol !== SYMBOL) continue;
        const size = parseFloat(pos.size || '0');
        if (pos.side === 'Buy') {
          longSize += size;
          longPos = pos;
        } else if (pos.side === 'Sell') {
          shortSize += size;
          shortPos = pos;
        }
      }
    } catch (e) {
      console.error(`[${this.tsNow()}] Error fetching positions: ${(e as Error).message}`);
      return;
    }

    // Entry logic based on prediction
    const minConfidence = 0.6;

    if (prediction.signal === 1 && prediction.signalConfidence >= minConfidence && this.longCooldown === 0) {
      // Buy signal
      if (longSize === 0) {
        console.log(`[${this.tsNow()}] ENTRY LONG — confidence: ${(prediction.signalConfidence * 100).toFixed(1)}%`);
        await this.openLong();
        this.longCooldown = this.CD_LONG;
      }
    } else if (prediction.signal === -1 && prediction.signalConfidence >= minConfidence && this.shortCooldown === 0) {
      // Sell signal
      if (shortSize === 0) {
        console.log(`[${this.tsNow()}] ENTRY SHORT — confidence: ${(prediction.signalConfidence * 100).toFixed(1)}%`);
        await this.openShort();
        this.shortCooldown = this.CD_SHORT;
      }
    }

    // Exit logic
    if (longPos && prediction.signal === -1) {
      console.log(`[${this.tsNow()}] EXIT LONG — signal reversed`);
      await this.closePos(longPos);
    }
    if (shortPos && prediction.signal === 1) {
      console.log(`[${this.tsNow()}] EXIT SHORT — signal reversed`);
      await this.closePos(shortPos);
    }
  }

  private async openLong(): Promise<void> {
    if (DRY_RUN) {
      console.log(`[${this.tsNow()}] DRY-RUN: Would open LONG ${SYMBOL} size=${SIZE}`);
      return;
    }
    try {
      const result = await placeMarketOrder(
        { account: 'usdt-m', symbol: SYMBOL, side: 'Buy', price: 0, qty: SIZE, posSide: 'Long' },
        creds.PHEMEX_API_KEY,
        secretRaw,
      );
      console.log(`[${this.tsNow()}] LONG opened — orderID: ${result.orderID ?? '—'}`);
    } catch (e) {
      console.error(`[${this.tsNow()}] Error opening long: ${(e as Error).message}`);
    }
  }

  private async openShort(): Promise<void> {
    if (DRY_RUN) {
      console.log(`[${this.tsNow()}] DRY-RUN: Would open SHORT ${SYMBOL} size=${SIZE}`);
      return;
    }
    try {
      const result = await placeMarketOrder(
        { account: 'usdt-m', symbol: SYMBOL, side: 'Sell', price: 0, qty: SIZE, posSide: 'Short' },
        creds.PHEMEX_API_KEY,
        secretRaw,
      );
      console.log(`[${this.tsNow()}] SHORT opened — orderID: ${result.orderID ?? '—'}`);
    } catch (e) {
      console.error(`[${this.tsNow()}] Error opening short: ${(e as Error).message}`);
    }
  }

  private async closePos(pos: Position): Promise<void> {
    if (DRY_RUN) {
      console.log(`[${this.tsNow()}] DRY-RUN: Would close ${pos.side} ${SYMBOL}`);
      return;
    }
    try {
      await closePosition(pos, creds.PHEMEX_API_KEY, secretRaw);
      console.log(`[${this.tsNow()}] ${pos.side} closed`);
    } catch (e) {
      console.error(`[${this.tsNow()}] Error closing: ${(e as Error).message}`);
    }
  }

  private tsNow(): string {
    const d = new Date();
    const p = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}

/* ── Main ─────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log(`\n══ NPU Trading ══════════════════════════════════════════════`);
  console.log(`  Symbol:     ${SYMBOL}`);
  console.log(`  Size:       ${SIZE}`);
  console.log(`  Leverage:   ${LEVERAGE}x`);
  console.log(`  Mode:       ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`  Collect:    ${COLLECT_ONLY ? 'YES' : 'NO'}`);
  console.log(`  Train:      ${TRAIN_ONLY ? 'YES' : 'NO'}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  // Initialize trader
  const trader = new NPUTrader();
  await trader.initialize();

  // Set leverage
  if (!DRY_RUN && !COLLECT_ONLY && !TRAIN_ONLY) {
    try {
      await setLeverageUsdtM(SYMBOL, LEVERAGE, 'Long', creds.PHEMEX_API_KEY, secretRaw);
      await setLeverageUsdtM(SYMBOL, LEVERAGE, 'Short', creds.PHEMEX_API_KEY, secretRaw);
      console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] Leverage set to ${LEVERAGE}x`);
    } catch (e) {
      console.error(`Error setting leverage: ${(e as Error).message}`);
    }
  }

  // Start WebSocket
  const ws = startWebSocket();

  // Wait for first tick
  process.stdout.write(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] Waiting for first tick…`);
  while (!ticker) {
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(' connected.\n');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log(`\n[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] Stopped.`);
    ws.shutdown();
    process.exit(0);
  });

  // Main loop
  let loopCount = 0;
  for (;;) {
    const started = Date.now();

    if (ticker) {
      // Process tick
      await trader.tick(ticker);

      // Trade (if not in collect/train only mode)
      if (!COLLECT_ONLY && !TRAIN_ONLY) {
        await trader.trade(ticker);
      }

      // Print status every 10 ticks
      if (loopCount % 10 === 0) {
        const info = trader['neuralNet'].getInfo();
        const trainInfo = trader['trainingPipeline'].getInfo();
        console.log(`[${trader['tsNow']()}] Status: tick=${loopCount} | buffer=${trainInfo.bufferSize} | samples=${info.sampleCount} | trains=${trainInfo.trainCount}`);
      }
    }

    loopCount++;
    const elapsed = Date.now() - started;
    await new Promise(r => setTimeout(r, Math.max(0, 1000 - elapsed)));
  }
}

main().catch((e) => {
  console.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
