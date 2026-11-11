/**
 * training.ts
 *
 * Online learning pipeline for trading neural networks.
 * Collects data, trains models, and manages model lifecycle.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NeuralNet, TickerFeatures, ModelPrediction } from './neural-net';

/* ── Data Collection ──────────────────────────────────────────────────── */

export interface DataPoint {
  features: TickerFeatures;
  label: {
    direction: number;    // 0 or 1
    magnitude: number;    // actual return %
    signal: number;       // -1, 0, or 1
  };
  timestamp: number;
}

export interface TrainingConfig {
  symbol: string;
  collectDuration: number;    // ms to collect data
  minSamples: number;         // minimum samples before training
  retrainInterval: number;    // ms between retraining
  lookforward: number;        // ticks to look ahead for labels
  threshold: number;          // threshold for direction/signal
  batchSize: number;          // samples per training batch
  learningRate: number;       // gradient descent learning rate
}

const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  symbol: 'XRPUSDT',
  collectDuration: 10 * 60 * 1000,  // 10 minutes
  minSamples: 1000,
  retrainInterval: 4 * 60 * 60 * 1000,  // 4 hours
  lookforward: 10,
  threshold: 0.001,
  batchSize: 32,
  learningRate: 0.001,
};

/* ── Data Buffer ──────────────────────────────────────────────────────── */

export class DataBuffer {
  private buffer: TickerFeatures[] = [];
  private priceHistory: number[] = [];
  private maxBufferSize: number;

  constructor(maxSize: number = 10000) {
    this.maxBufferSize = maxSize;
  }

  add(features: TickerFeatures, lastPrice: number): void {
    this.buffer.push(features);
    this.priceHistory.push(lastPrice);

    // Trim old data
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
      this.priceHistory.shift();
    }
  }

  /**
   * Generate labeled training data.
   * Looks ahead `lookforward` ticks to determine labels.
   */
  generateLabels(lookforward: number, threshold: number): DataPoint[] {
    const dataPoints: DataPoint[] = [];

    for (let i = 0; i < this.buffer.length - lookforward; i++) {
      const currentPrice = this.priceHistory[i];
      const futurePrice = this.priceHistory[i + lookforward];
      const returnPct = (futurePrice - currentPrice) / currentPrice;

      // Direction: 1 if price went up, 0 if down
      const direction = returnPct > 0 ? 1 : 0;

      // Magnitude: actual return percentage
      const magnitude = returnPct;

      // Signal: -1 (sell), 0 (hold), 1 (buy)
      let signal = 0;
      if (returnPct > threshold) {
        signal = 1;  // buy
      } else if (returnPct < -threshold) {
        signal = -1; // sell
      }

      dataPoints.push({
        features: this.buffer[i],
        label: { direction, magnitude, signal },
        timestamp: Date.now(),
      });
    }

    return dataPoints;
  }

  get length(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
    this.priceHistory = [];
  }
}

/* ── Training Pipeline ────────────────────────────────────────────────── */

export class TrainingPipeline {
  private neuralNet: NeuralNet;
  private dataBuffer: DataBuffer;
  private config: TrainingConfig;
  private lastTrainTime: number = 0;
  private trainCount: number = 0;
  private dataDir: string;

  constructor(config: Partial<TrainingConfig> = {}) {
    this.config = { ...DEFAULT_TRAINING_CONFIG, ...config };
    this.neuralNet = new NeuralNet(this.config.symbol);
    this.dataBuffer = new DataBuffer();
    this.dataDir = path.join(
      process.cwd(),
      'models',
      this.config.symbol.toLowerCase(),
    );
  }

  /**
   * Initialize the training pipeline.
   */
  async initialize(): Promise<void> {
    await this.neuralNet.initialize();
    this.loadData();
    console.log(`[Training] Pipeline initialized for ${this.config.symbol}`);
  }

  /**
   * Add new data point to the buffer.
   */
  addData(features: TickerFeatures, lastPrice: number): void {
    this.dataBuffer.add(features, lastPrice);
  }

  /**
   * Check if it's time to retrain.
   */
  shouldRetrain(): boolean {
    const now = Date.now();
    const timeSinceLastTrain = now - this.lastTrainTime;
    return (
      this.dataBuffer.length >= this.config.minSamples &&
      timeSinceLastTrain >= this.config.retrainInterval
    );
  }

  /**
   * Run training on accumulated data.
   */
  async train(): Promise<{
    loss: number;
    accuracy: number;
    samples: number;
  }> {
    console.log(`[Training] Starting training with ${this.dataBuffer.length} samples...`);

    // Generate labeled data
    const dataPoints = this.dataBuffer.generateLabels(
      this.config.lookforward,
      this.config.threshold,
    );

    if (dataPoints.length === 0) {
      console.log(`[Training] No labeled data available`);
      return { loss: 0, accuracy: 0, samples: 0 };
    }

    // Shuffle data
    const shuffled = [...dataPoints].sort(() => Math.random() - 0.5);

    // Train in batches
    let totalLoss = 0;
    let correctPredictions = 0;
    let processedSamples = 0;

    for (let i = 0; i < shuffled.length; i += this.config.batchSize) {
      const batch = shuffled.slice(i, i + this.config.batchSize);

      for (const sample of batch) {
        // Run prediction to get current output
        const prediction = await this.neuralNet.predict(sample.features);

        // Calculate loss (simplified cross-entropy + MSE)
        const directionLoss = -(
          sample.label.direction * Math.log(prediction.directionConfidence + 1e-8) +
          (1 - sample.label.direction) * Math.log(1 - prediction.directionConfidence + 1e-8)
        );
        const magnitudeLoss = (prediction.magnitude - sample.label.magnitude) ** 2;
        const loss = directionLoss + magnitudeLoss;
        totalLoss += loss;

        // Check accuracy
        if (prediction.direction === sample.label.direction) {
          correctPredictions++;
        }

        // Update weights (simplified gradient descent)
        await this.neuralNet.updateWeights(
          sample.features,
          sample.label.direction,
          sample.label.magnitude,
          sample.label.signal,
          this.config.learningRate,
        );

        processedSamples++;
      }
    }

    const avgLoss = totalLoss / processedSamples;
    const accuracy = correctPredictions / processedSamples;

    this.lastTrainTime = Date.now();
    this.trainCount++;
    this.saveData();

    console.log(`[Training] Training complete: loss=${avgLoss.toFixed(6)}, accuracy=${(accuracy * 100).toFixed(1)}%, samples=${processedSamples}`);

    return { loss: avgLoss, accuracy, samples: processedSamples };
  }

  /**
   * Get prediction for current features.
   */
  async predict(features: TickerFeatures): Promise<ModelPrediction> {
    return this.neuralNet.predict(features);
  }

  /**
   * Save collected data to disk.
   */
  private saveData(): void {
    const dataPath = path.join(this.dataDir, 'training_data.json');
    const data = this.dataBuffer.generateLabels(
      this.config.lookforward,
      this.config.threshold,
    );
    fs.writeFileSync(dataPath, JSON.stringify(data.slice(-1000), null, 2));
  }

  /**
   * Load previously collected data.
   */
  private loadData(): void {
    const dataPath = path.join(this.dataDir, 'training_data.json');
    if (fs.existsSync(dataPath)) {
      console.log(`[Training] Loading previous training data...`);
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as DataPoint[];
      // Restore to buffer (simplified - in practice you'd restore features)
      console.log(`[Training] Loaded ${data.length} samples`);
    }
  }

  /**
   * Get pipeline info.
   */
  getInfo(): {
    symbol: string;
    bufferSize: number;
    trainCount: number;
    lastTrainTime: number;
  } {
    return {
      symbol: this.config.symbol,
      bufferSize: this.dataBuffer.length,
      trainCount: this.trainCount,
      lastTrainTime: this.lastTrainTime,
    };
  }
}
