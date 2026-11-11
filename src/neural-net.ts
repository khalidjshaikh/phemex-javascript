/**
 * neural-net.ts
 *
 * Neural network with backpropagation for online learning.
 * Multi-task model:
 *   - Direction: price will go up/down (binary classification)
 *   - Magnitude: expected price change % (regression)
 *   - Signal: buy/sell/hold (3-class classification)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/* ── Feature definitions ──────────────────────────────────────────────── */

export interface TickerFeatures {
  last: number;
  bid: number;
  ask: number;
  index: number;
  mark: number;
  spread: number;
  vector: number;
  deltaLast: number;
  deltaBid: number;
  deltaAsk: number;
  deltaLastSum: number;
  deltaLastPosSum: number;
  deltaLastNegSum: number;
  deltaAskSum: number;
  deltaBidSum: number;
  changeRate: number;
  deltaLastSumHour: number;
  deltaAskPosSumHour: number;
  deltaBidNegSumHour: number;
  changeRateHour: number;
  cumulativeDeltaBidNeg: number;
  cumulativeDeltaAskPos: number;
  slope: number;
  slopeAngle: number;
  lastNorm: number;
  bidNorm: number;
  askNorm: number;
}

export const FEATURE_KEYS: (keyof TickerFeatures)[] = [
  'last', 'bid', 'ask', 'index', 'mark', 'spread', 'vector',
  'deltaLast', 'deltaBid', 'deltaAsk',
  'deltaLastSum', 'deltaLastPosSum', 'deltaLastNegSum', 'deltaAskSum', 'deltaBidSum', 'changeRate',
  'deltaLastSumHour', 'deltaAskPosSumHour', 'deltaBidNegSumHour', 'changeRateHour',
  'cumulativeDeltaBidNeg', 'cumulativeDeltaAskPos',
  'slope', 'slopeAngle',
  'lastNorm', 'bidNorm', 'askNorm',
];

export const FEATURE_COUNT = FEATURE_KEYS.length;

/* ── Model outputs ────────────────────────────────────────────────────── */

export interface ModelPrediction {
  direction: number;
  directionConfidence: number;
  magnitude: number;
  signal: number;
  signalConfidence: number;
}

/* ── Model configuration ──────────────────────────────────────────────── */

export interface ModelConfig {
  inputSize: number;
  hiddenSize: number;
  numLayers: number;
}

const DEFAULT_CONFIG: ModelConfig = {
  inputSize: FEATURE_COUNT,
  hiddenSize: 64,
  numLayers: 3,
};

/* ── Matrix operations ────────────────────────────────────────────────── */

function matMulAdd(a: Float32Array, w: Float32Array, b: Float32Array, rows: number, cols: number, k: number): Float32Array {
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = b[c];
      for (let i = 0; i < k; i++) {
        sum += a[r * k + i] * w[i * cols + c];
      }
      out[r * cols + c] = sum;
    }
  }
  return out;
}

function relu(arr: Float32Array): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = arr[i] > 0 ? arr[i] : 0;
  }
  return out;
}

function sigmoid(arr: Float32Array): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = 1 / (1 + Math.exp(-arr[i]));
  }
  return out;
}

function softmax(arr: Float32Array): Float32Array {
  const out = new Float32Array(arr.length);
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    out[i] = Math.exp(arr[i] - max);
    sum += out[i];
  }
  for (let i = 0; i < arr.length; i++) {
    out[i] /= sum;
  }
  return out;
}

/* ── Layer weights ────────────────────────────────────────────────────── */

interface LayerWeights {
  w: Float32Array;
  b: Float32Array;
  rows: number;
  cols: number;
}

interface ForwardCache {
  inputs: Float32Array[];
  preActivations: Float32Array[];
  postActivations: Float32Array[];
}

/* ── Neural Network Class ─────────────────────────────────────────────── */

export class NeuralNet {
  private config: ModelConfig;
  private runningMean: Float32Array;
  private runningStd: Float32Array;
  private sampleCount: number = 0;
  private weightsPath: string;
  private statsPath: string;

  // Layer weights
  private layers: LayerWeights[] = [];
  private directionW: Float32Array = new Float32Array(0);
  private directionB: Float32Array = new Float32Array(0);
  private magnitudeW: Float32Array = new Float32Array(0);
  private magnitudeB: Float32Array = new Float32Array(0);
  private signalW: Float32Array = new Float32Array(0);
  private signalB: Float32Array = new Float32Array(0);

  // Gradient accumulators
  private layerGrads: { dw: Float32Array; db: Float32Array }[] = [];
  private dirGradW: Float32Array = new Float32Array(0);
  private dirGradB: Float32Array = new Float32Array(0);
  private magGradW: Float32Array = new Float32Array(0);
  private magGradB: Float32Array = new Float32Array(0);
  private sigGradW: Float32Array = new Float32Array(0);
  private sigGradB: Float32Array = new Float32Array(0);

  constructor(
    private symbol: string,
    config: Partial<ModelConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.weightsPath = path.join(
      process.cwd(),
      'models',
      `${symbol.toLowerCase()}`,
      'weights.json',
    );
    this.statsPath = path.join(
      process.cwd(),
      'models',
      `${symbol.toLowerCase()}`,
      'stats.json',
    );
    this.runningMean = new Float32Array(this.config.inputSize);
    this.runningStd = new Float32Array(this.config.inputSize).fill(1);
    this.initWeights();
  }

  /**
   * Initialize weights with He initialization.
   */
  private initWeights(): void {
    const { inputSize, hiddenSize, numLayers } = this.config;
    this.layers = [];
    this.layerGrads = [];

    let prevSize = inputSize;
    for (let i = 0; i < numLayers; i++) {
      const rows = prevSize;
      const cols = hiddenSize;
      const w = new Float32Array(rows * cols);
      const scale = Math.sqrt(2.0 / rows);
      for (let j = 0; j < w.length; j++) {
        w[j] = (Math.random() * 2 - 1) * scale;
      }
      const b = new Float32Array(cols).fill(0);
      this.layers.push({ w, b, rows, cols });
      this.layerGrads.push({
        dw: new Float32Array(rows * cols),
        db: new Float32Array(cols),
      });
      prevSize = cols;
    }

    // Output heads
    const h = hiddenSize;
    this.directionW = new Float32Array(h);
    this.directionB = new Float32Array(1);
    this.magnitudeW = new Float32Array(h);
    this.magnitudeB = new Float32Array(1);
    this.signalW = new Float32Array(h * 3);
    this.signalB = new Float32Array(3);

    for (let i = 0; i < h; i++) {
      this.directionW[i] = (Math.random() * 2 - 1) * 0.1;
      this.magnitudeW[i] = (Math.random() * 2 - 1) * 0.1;
      for (let j = 0; j < 3; j++) {
        this.signalW[i * 3 + j] = (Math.random() * 2 - 1) * 0.1;
      }
    }

    this.dirGradW = new Float32Array(h);
    this.dirGradB = new Float32Array(1);
    this.magGradW = new Float32Array(h);
    this.magGradB = new Float32Array(1);
    this.sigGradW = new Float32Array(h * 3);
    this.sigGradB = new Float32Array(3);
  }

  /**
   * Initialize neural network.
   */
  async initialize(): Promise<void> {
    const modelDir = path.dirname(this.weightsPath);
    if (!fs.existsSync(modelDir)) {
      fs.mkdirSync(modelDir, { recursive: true });
    }
    this.loadWeights();
    this.loadStats();
    console.log(`[NeuralNet] Initialized for ${this.symbol}`);
  }

  /**
   * Load weights from disk.
   */
  private loadWeights(): void {
    if (!fs.existsSync(this.weightsPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.weightsPath, 'utf8'));
      const { inputSize, hiddenSize, numLayers } = this.config;

      let prevSize = inputSize;
      for (let i = 0; i < numLayers; i++) {
        const rows = prevSize;
        const cols = hiddenSize;
        this.layers[i].w = Float32Array.from(data.layers[i].w);
        this.layers[i].b = Float32Array.from(data.layers[i].b);
        prevSize = cols;
      }

      this.directionW = Float32Array.from(data.directionW);
      this.directionB = Float32Array.from(data.directionB);
      this.magnitudeW = Float32Array.from(data.magnitudeW);
      this.magnitudeB = Float32Array.from(data.magnitudeB);
      this.signalW = Float32Array.from(data.signalW);
      this.signalB = Float32Array.from(data.signalB);

      console.log(`[NeuralNet] Loaded weights from ${this.weightsPath}`);
    } catch (e) {
      console.error(`[NeuralNet] Failed to load weights: ${(e as Error).message}`);
    }
  }

  /**
   * Save weights to disk.
   */
  private saveWeights(): void {
    const data = {
      layers: this.layers.map(l => ({
        w: Array.from(l.w),
        b: Array.from(l.b),
      })),
      directionW: Array.from(this.directionW),
      directionB: Array.from(this.directionB),
      magnitudeW: Array.from(this.magnitudeW),
      magnitudeB: Array.from(this.magnitudeB),
      signalW: Array.from(this.signalW),
      signalB: Array.from(this.signalB),
    };
    fs.writeFileSync(this.weightsPath, JSON.stringify(data));
  }

  /**
   * Load normalization statistics from disk.
   */
  private loadStats(): void {
    if (!fs.existsSync(this.statsPath)) return;
    try {
      const stats = JSON.parse(fs.readFileSync(this.statsPath, 'utf8'));
      this.runningMean = Float32Array.from(stats.mean);
      this.runningStd = Float32Array.from(stats.std);
      this.sampleCount = stats.sampleCount || 0;
    } catch (e) {
      // ignore
    }
  }

  /**
   * Save normalization statistics to disk.
   */
  private saveStats(): void {
    const stats = {
      mean: Array.from(this.runningMean),
      std: Array.from(this.runningStd),
      sampleCount: this.sampleCount,
    };
    fs.writeFileSync(this.statsPath, JSON.stringify(stats, null, 2));
  }

  /**
   * Update running statistics (Welford's online algorithm).
   */
  updateStats(features: TickerFeatures): void {
    this.sampleCount++;
    for (let i = 0; i < FEATURE_KEYS.length && i < this.config.inputSize; i++) {
      const x = features[FEATURE_KEYS[i]] as number;
      const delta = x - this.runningMean[i];
      this.runningMean[i] += delta / this.sampleCount;
      const delta2 = x - this.runningMean[i];
      this.runningStd[i] = Math.sqrt(
        (this.runningStd[i] ** 2 * (this.sampleCount - 1) + delta * delta2) / this.sampleCount
      );
    }
    for (let i = 0; i < this.runningStd.length; i++) {
      if (this.runningStd[i] < 1e-8) this.runningStd[i] = 1;
    }
    if (this.sampleCount % 100 === 0) this.saveStats();
  }

  /**
   * Normalize features using running statistics.
   */
  normalize(features: TickerFeatures): Float32Array {
    const normalized = new Float32Array(this.config.inputSize);
    for (let i = 0; i < FEATURE_KEYS.length && i < this.config.inputSize; i++) {
      const val = features[FEATURE_KEYS[i]] as number;
      normalized[i] = (val - this.runningMean[i]) / this.runningStd[i];
      normalized[i] = Math.max(-5, Math.min(5, normalized[i]));
    }
    return normalized;
  }

  /**
   * Forward pass through hidden layers.
   */
  private forwardHidden(input: Float32Array): { cache: ForwardCache; output: Float32Array } {
    const inputs: Float32Array[] = [];
    const preActivations: Float32Array[] = [];
    const postActivations: Float32Array[] = [];

    let x = input;
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      inputs.push(x);

      // z = x @ W + b
      const z = matMulAdd(x, layer.w, layer.b, 1, layer.cols, layer.rows);
      preActivations.push(z);

      // a = relu(z) (except last layer)
      if (i < this.layers.length - 1) {
        x = relu(z);
      } else {
        x = z;
      }
      postActivations.push(x);
    }

    return { cache: { inputs, preActivations, postActivations }, output: x };
  }

  /**
   * Forward pass through output heads.
   */
  private forwardOutput(hidden: Float32Array): {
    directionLogit: number;
    direction: number;
    magnitude: number;
    signalLogits: Float32Array;
    signal: Float32Array;
  } {
    // Direction: sigmoid(hidden @ w + b)
    let dirLogit = this.directionB[0];
    for (let i = 0; i < this.directionW.length; i++) {
      dirLogit += hidden[i] * this.directionW[i];
    }
    const direction = 1 / (1 + Math.exp(-dirLogit));

    // Magnitude: hidden @ w + b
    let mag = this.magnitudeB[0];
    for (let i = 0; i < this.magnitudeW.length; i++) {
      mag += hidden[i] * this.magnitudeW[i];
    }

    // Signal: softmax(hidden @ w + b)
    const signalLogits = new Float32Array(3);
    for (let j = 0; j < 3; j++) {
      let sum = this.signalB[j];
      for (let i = 0; i < this.signalW.length / 3; i++) {
        sum += hidden[i] * this.signalW[i * 3 + j];
      }
      signalLogits[j] = sum;
    }
    const signal = softmax(signalLogits);

    return { directionLogit: dirLogit, direction, magnitude: mag, signalLogits, signal };
  }

  /**
   * Forward pass (full).
   */
  private forward(normalized: Float32Array): {
    cache: ForwardCache;
    output: { directionLogit: number; direction: number; magnitude: number; signalLogits: Float32Array; signal: Float32Array };
  } {
    const { cache, output: hidden } = this.forwardHidden(normalized);
    const output = this.forwardOutput(hidden);
    return { cache, output };
  }

  /**
   * Run inference on the given features.
   */
  async predict(features: TickerFeatures): Promise<ModelPrediction> {
    this.updateStats(features);
    const normalized = this.normalize(features);
    const { output } = this.forward(normalized);

    let signal = 0;
    let signalConfidence = output.signal[1];
    if (output.signal[0] > output.signal[1] && output.signal[0] > output.signal[2]) {
      signal = -1;
      signalConfidence = output.signal[0];
    } else if (output.signal[2] > output.signal[1] && output.signal[2] > output.signal[0]) {
      signal = 1;
      signalConfidence = output.signal[2];
    }

    return {
      direction: output.direction > 0.5 ? 1 : 0,
      directionConfidence: output.direction > 0.5 ? output.direction : 1 - output.direction,
      magnitude: output.magnitude,
      signal,
      signalConfidence,
    };
  }

  /**
   * Backward pass + weight update.
   */
  async updateWeights(
    features: TickerFeatures,
    targetDirection: number,
    targetMagnitude: number,
    targetSignal: number,
    learningRate: number = 0.001,
  ): Promise<void> {
    const normalized = this.normalize(features);
    const { cache, output } = this.forward(normalized);
    const { inputs, postActivations, preActivations } = cache;
    const hidden = postActivations[postActivations.length - 1];
    const { numLayers, hiddenSize } = this.config;

    // ── Output head gradients ──

    // Direction: dL/dlogit = sigmoid(z) - target
    const dirGrad = output.direction - targetDirection;

    // Magnitude: dL/dz = 2 * (pred - target) / N
    const magGrad = 2 * (output.magnitude - targetMagnitude);

    // Signal: softmax - one_hot
    const sigGrad = new Float32Array(3);
    const targetClass = targetSignal === -1 ? 0 : targetSignal === 1 ? 2 : 1;
    for (let j = 0; j < 3; j++) {
      sigGrad[j] = output.signal[j] - (j === targetClass ? 1 : 0);
    }

    // ── Update output head weights ──

    for (let i = 0; i < hiddenSize; i++) {
      this.directionW[i] -= learningRate * dirGrad * hidden[i];
      this.magnitudeW[i] -= learningRate * magGrad * hidden[i];
      for (let j = 0; j < 3; j++) {
        this.signalW[i * 3 + j] -= learningRate * sigGrad[j] * hidden[i];
      }
    }
    this.directionB[0] -= learningRate * dirGrad;
    this.magnitudeB[0] -= learningRate * magGrad;
    for (let j = 0; j < 3; j++) {
      this.signalB[j] -= learningRate * sigGrad[j];
    }

    // ── Backprop through hidden layers ──

    // Gradient flowing into last hidden layer
    let dHidden = new Float32Array(hiddenSize);
    for (let i = 0; i < hiddenSize; i++) {
      dHidden[i] = dirGrad * this.directionW[i] + magGrad * this.magnitudeW[i];
      for (let j = 0; j < 3; j++) {
        dHidden[i] += sigGrad[j] * this.signalW[i * 3 + j];
      }
    }

    // Backprop through layers in reverse
    for (let l = numLayers - 1; l >= 0; l--) {
      const layer = this.layers[l];
      const x = inputs[l];

      // dReLU: if preActivation <= 0, gradient is 0
      if (l < numLayers - 1) {
        for (let i = 0; i < hiddenSize; i++) {
          if (preActivations[l][i] <= 0) {
            dHidden[i] = 0;
          }
        }
      }

      // dW = x^T @ dHidden
      for (let r = 0; r < layer.rows; r++) {
        for (let c = 0; c < layer.cols; c++) {
          this.layerGrads[l].dw[r * layer.cols + c] = x[r] * dHidden[c];
        }
      }

      // db = dHidden
      for (let c = 0; c < layer.cols; c++) {
        this.layerGrads[l].db[c] = dHidden[c];
      }

      // dX = dHidden @ W
      const dX = new Float32Array(layer.rows);
      for (let r = 0; r < layer.rows; r++) {
        let sum = 0;
        for (let c = 0; c < layer.cols; c++) {
          sum += dHidden[c] * layer.w[r * layer.cols + c];
        }
        dX[r] = sum;
      }

      // Update weights
      for (let i = 0; i < layer.w.length; i++) {
        layer.w[i] -= learningRate * this.layerGrads[l].dw[i];
      }
      for (let i = 0; i < layer.b.length; i++) {
        layer.b[i] -= learningRate * this.layerGrads[l].db[i];
      }

      dHidden = dX;
    }

    // Save weights periodically
    this.saveWeights();
  }

  /**
   * Export model for deployment.
   */
  exportModel(outputPath: string): void {
    if (fs.existsSync(this.weightsPath)) {
      fs.copyFileSync(this.weightsPath, outputPath);
      console.log(`[NeuralNet] Model exported to ${outputPath}`);
    }
  }

  /**
   * Get model info.
   */
  getInfo(): { symbol: string; config: ModelConfig; sampleCount: number } {
    return {
      symbol: this.symbol,
      config: this.config,
      sampleCount: this.sampleCount,
    };
  }
}
