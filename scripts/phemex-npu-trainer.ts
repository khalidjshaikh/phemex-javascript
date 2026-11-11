#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
// Suppress ONNX Runtime warnings
import { env as ortEnv } from 'onnxruntime-node';
ortEnv.logLevel = 'error';
/**
 * phemex-npu-trainer.ts — Simplified NPU trader using deltaLast only.
 *
 * Neural network with ONNX Runtime + CoreMLExecutionProvider on Apple Neural Engine.
 * Input:  deltaLast (current_last - previous_last)
 * Output: direction probability (price will go UP or DOWN)
 *
 * Training:  Backpropagation in pure JS
 * Inference: ONNX Runtime on Apple Neural Engine (ANE)
 *
 * Usage:
 *   npx tsx scripts/phemex-npu-trainer.ts --symbol PUMPUSDT
 *   npx tsx scripts/phemex-npu-trainer.ts --dry-run
 *   npx tsx scripts/phemex-npu-trainer.ts --collect-only
 *   npx tsx scripts/phemex-npu-trainer.ts --train-only
 *   npx tsx scripts/phemex-npu-trainer.ts --export-onnx
 */
import fs from 'node:fs';
import path from 'node:path';
import { ReconnectingWs } from '../src/ws-client.js';
import { getArg, hasFlag, findSymbolRow } from '../src/cli-utils.js';
import { loadCredentials } from '../src/credentials.js';
import { placeMarketOrder, setLeverageUsdtM } from '../src/place-limit-order.js';
import { fetchPositions, closePosition, type Position } from '../src/positions.js';
import { NeuralNetONNX, type ONNXPrediction } from '../src/neural-net-onnx.js';

/* ── CLI Options ──────────────────────────────────────────────────────── */

const DRY_RUN = hasFlag('--dry-run');
const SYMBOL = (getArg('--symbol') ?? 'PUMPUSDT').toUpperCase();
const SIZE = Number(getArg('--size') ?? 1);
const LEVERAGE = Number(getArg('--leverage') ?? 20);
const CREDENTIAL = getArg('--credential');
const COLLECT_ONLY = hasFlag('--collect-only');
const TRAIN_ONLY = hasFlag('--train-only');
const EXPORT_ONLY = hasFlag('--export-onnx');
const VERBOSE = hasFlag('--verbose');
const LOOKFORWARD = Number(getArg('--lookforward') ?? 10);
const RETRAIN_EVERY = Number(getArg('--retrain-every') ?? 500);  // ticks
const CONFIDENCE_THRESHOLD = Number(getArg('--confidence') ?? 0.6);

const USAGE = `Usage: npx tsx scripts/phemex-npu-trainer.ts [options]

Simplified NPU trader using deltaLast only.

Options:
  --symbol <SYMBOL>      Symbol to trade (default: PUMPUSDT)
  --size <N>             Position size (default: 1)
  --leverage <N>         Leverage (default: 20)
  --credential <name>    Credential profile
  --dry-run              Simulate trades without placing orders
  --collect-only         Only collect data, don't trade
  --train-only           Only train model, don't trade
  --export-onnx          Export ONNX model and exit
  --lookforward <N>      Ticks ahead for labels (default: 10)
  --retrain-every <N>    Retrain every N ticks (default: 500)
  --confidence <N>       Min confidence to trade (default: 0.6)
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

/* ── Data Buffer ──────────────────────────────────────────────────────── */

class DataBuffer {
  private deltas: number[] = [];
  private prices: number[] = [];
  private maxBufferSize = 10;

  add(deltaLast: number, price: number): void {
    this.deltas.push(deltaLast);
    this.prices.push(price);
    if (this.deltas.length > this.maxBufferSize) {
      this.deltas.shift();
      this.prices.shift();
    }
  }

  /** Generate labeled training data: did price go up in next N ticks? */
  generateLabels(lookforward: number): { delta: number; label: number }[] {
    const fw = Math.max(lookforward, 1); // minimum 1 tick ahead
    const data: { delta: number; label: number }[] = [];
    for (let i = 0; i < this.deltas.length - fw; i++) {
      const currentPrice = this.prices[i];
      const futurePrice = this.prices[i + fw];
      const direction = futurePrice > currentPrice ? 1 : 0;
      data.push({ delta: this.deltas[i], label: direction });
    }
    return data;
  }

  get length(): number {
    return this.deltas.length;
  }
}

/* ── NPU Trainer ──────────────────────────────────────────────────────── */

class NPUTrainer {
  private model: NeuralNetONNX;
  private dataBuffer: DataBuffer;
  private prevLast: number | null = null;

  private longCooldown = 0;
  private shortCooldown = 0;
  private readonly CD_LONG = 60;
  private readonly CD_SHORT = 60;

  private lastPrediction: ONNXPrediction | null = null;
  private tickCount = 0;
  private trainCount = 0;

  constructor() {
    this.model = new NeuralNetONNX(SYMBOL);
    this.dataBuffer = new DataBuffer();
  }

  async initialize(): Promise<void> {
    console.log(`[NPUTrainer] Initializing for ${SYMBOL}...`);
    await this.model.initialize();
    console.log(`[NPUTrainer] Model: 1 → 1 (last → direction, single neuron)`);
    console.log(`[NPUTrainer] Initialized successfully`);
  }

  async tick(ticker: TickerData): Promise<void> {
    this.tickCount++;

    // Use last price directly
    const last = ticker.last;
    this.prevLast = ticker.last;

    // Update normalization stats
    this.model.updateStats(last);

    // Add to training buffer
    this.dataBuffer.add(last, ticker.last);

    // Run inference on ANE
    this.lastPrediction = await this.model.predict(last);

    // Retrain every tick
    if (this.dataBuffer.length >= Math.max(LOOKFORWARD, 1) + 1) {
      await this.train();
    }

    // Log AFTER training so we see updated ow
    const pred = this.lastPrediction;
    const ow = this.model['outputW'];
    const ob = this.model['outputB'];
    console.log(
      `[${this.tsNow()}] ` +
      `last=${last.toFixed(6)} | ` +
      `dir=${pred.direction} (${(pred.confidence * 100).toFixed(1)}%) | ` +
      `prob=${pred.probability.toFixed(4)} | ` +
      `ow=${ow[0].toFixed(6)} ob=${ob[0].toFixed(6)} | ` +
      `tick=${this.tickCount}`
    );
  }

  async train(): Promise<void> {
    const data = this.dataBuffer.generateLabels(LOOKFORWARD);
    if (data.length === 0) return;

    console.log(`[${this.tsNow()}] Training on ${data.length} samples...`);

    let totalLoss = 0;
    let correct = 0;

    for (const { delta, label } of data) {
      const loss = this.model.train(delta, label);
      totalLoss += loss;

      const pred = this.model.predictRaw(delta);
      if ((pred.direction === 'UP' && label === 1) || (pred.direction === 'DOWN' && label === 0)) {
        correct++;
      }
    }

    this.trainCount++;
    const avgLoss = totalLoss / data.length;
    const accuracy = correct / data.length;

    console.log(
      `[${this.tsNow()}] Training #${this.trainCount}: ` +
      `loss=${avgLoss.toFixed(6)} accuracy=${(accuracy * 100).toFixed(1)}%`
    );

    // Save weights and invalidate ONNX session
    this.model.saveWeights();
    this.model.saveStats();
    this.model.resetSession();
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

    // Entry: BUY if UP with high confidence, SELL if DOWN with high confidence
    if (prediction.direction === 'UP' && prediction.confidence >= CONFIDENCE_THRESHOLD && this.longCooldown === 0) {
      if (longSize === 0) {
        console.log(`[${this.tsNow()}] ENTRY LONG — confidence: ${(prediction.confidence * 100).toFixed(1)}%`);
        await this.openLong();
        this.longCooldown = this.CD_LONG;
      }
    } else if (prediction.direction === 'DOWN' && prediction.confidence >= CONFIDENCE_THRESHOLD && this.shortCooldown === 0) {
      if (shortSize === 0) {
        console.log(`[${this.tsNow()}] ENTRY SHORT — confidence: ${(prediction.confidence * 100).toFixed(1)}%`);
        await this.openShort();
        this.shortCooldown = this.CD_SHORT;
      }
    }

    // Exit: close long if DOWN, close short if UP
    if (longPos && prediction.direction === 'DOWN') {
      console.log(`[${this.tsNow()}] EXIT LONG — signal reversed`);
      await this.closePos(longPos);
    }
    if (shortPos && prediction.direction === 'UP') {
      console.log(`[${this.tsNow()}] EXIT SHORT — signal reversed`);
      await this.closePos(shortPos);
    }

    // Cooldown management
    if (this.longCooldown > 0) this.longCooldown--;
    if (this.shortCooldown > 0) this.shortCooldown--;
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
  console.log(`\n══ NPU Trainer (deltaLast) ══════════════════════════════════`);
  console.log(`  Symbol:     ${SYMBOL}`);
  console.log(`  Size:       ${SIZE}`);
  console.log(`  Leverage:   ${LEVERAGE}x`);
  console.log(`  Mode:       ${DRY_RUN ? 'DRY-RUN' : COLLECT_ONLY ? 'COLLECT' : TRAIN_ONLY ? 'TRAIN' : 'LIVE'}`);
  console.log(`  Lookahead:  ${LOOKFORWARD} ticks`);
  console.log(`  Retrain:    every ${RETRAIN_EVERY} ticks`);
  console.log(`  Confidence: ${(CONFIDENCE_THRESHOLD * 100).toFixed(0)}%`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  // Initialize trainer
  const trainer = new NPUTrainer();
  await trainer.initialize();

  // Export ONNX only and exit
  if (EXPORT_ONLY) {
    console.log(`[NPUTrainer] Exporting ONNX model...`);
    await trainer['model'].exportToOnnx();
    console.log(`[NPUTrainer] Done.`);
    process.exit(0);
  }

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
    trainer['model'].saveWeights();
    trainer['model'].saveStats();
    ws.shutdown();
    process.exit(0);
  });

  // Main loop
  let loopCount = 0;
  for (;;) {
    const started = Date.now();

    if (ticker) {
      await trainer.tick(ticker);

      // Trade [DISABLED]
      // if (!COLLECT_ONLY && !TRAIN_ONLY) {
      //   await trainer.trade(ticker);
      // }

      // Status every 100 ticks
      if (loopCount % 100 === 0) {
        const info = trainer['model'].getInfo();
        console.log(
          `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ` +
          `Status: tick=${loopCount} samples=${info.sampleCount} trains=${trainer['trainCount']} ` +
          `mean=${info.runningMean.toFixed(6)}`
        );
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
