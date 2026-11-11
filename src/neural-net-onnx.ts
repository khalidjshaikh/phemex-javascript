/**
 * neural-net-onnx.ts
 *
 * Simplified neural network with backpropagation.
 * Input:  deltaLast (1 feature)
 * Output: direction probability (1 sigmoid neuron)
 * Architecture: 1 → 8 → 8 → 8 → 1 (3 hidden layers, ReLU)
 *
 * Training runs in pure JS (backpropagation).
 * Inference runs on Apple Neural Engine via ONNX Runtime + CoreML EP.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ort from 'onnxruntime-node';
import { onnx } from 'onnx-proto';

/* ── Configuration ─────────────────────────────────────────────────────── */

export interface ONNXModelConfig {
  hiddenSize: number;
  numLayers: number;
  learningRate: number;
}

const DEFAULT_CONFIG: ONNXModelConfig = {
  hiddenSize: 1,
  numLayers: 0,
  learningRate: 0.01,
};

/* ── Prediction result ─────────────────────────────────────────────────── */

export interface ONNXPrediction {
  probability: number;   // sigmoid output [0,1]
  direction: 'UP' | 'DOWN';
  confidence: number;    // max(prob, 1-prob)
}

/* ── Layer weights ─────────────────────────────────────────────────────── */

interface LayerWeights {
  w: Float32Array;  // [rows × cols]
  b: Float32Array;  // [cols]
  rows: number;
  cols: number;
}

interface ForwardCache {
  preActivations: Float32Array[];  // z values before ReLU
  postActivations: Float32Array[]; // a values after activation
}

/* ── Neural Network Class ──────────────────────────────────────────────── */

export class NeuralNetONNX {
  private config: ONNXModelConfig;
  private layers: LayerWeights[] = [];
  private outputW: Float32Array = new Float32Array(0);
  private outputB: Float32Array = new Float32Array(0);

  // Normalization (Welford's online algorithm)
  private runningMean = 0;
  private runningM2 = 0;
  private sampleCount = 0;

  // Paths
  private weightsPath: string;
  private statsPath: string;
  private onnxModelPath: string;

  // ONNX Runtime session (lazy)
  private sessionPromise: Promise<ort.InferenceSession> | null = null;

  constructor(
    private symbol: string,
    config: Partial<ONNXModelConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const dir = path.join(process.cwd(), 'models', symbol.toLowerCase());
    this.weightsPath = path.join(dir, 'weights-npu.json');
    this.statsPath = path.join(dir, 'stats-npu.json');
    this.onnxModelPath = path.join(dir, 'model-npu.onnx');
    this.initWeights();
  }

  /* ── Weight initialization (He) ──────────────────────────────────────── */

  private initWeights(): void {
    const { hiddenSize, numLayers } = this.config;
    this.layers = [];

    let prevSize = 1; // input is 1 (deltaLast)
    for (let i = 0; i < numLayers; i++) {
      const rows = prevSize;
      const cols = hiddenSize;
      const w = new Float32Array(rows * cols);
      for (let j = 0; j < w.length; j++) {
        w[j] = (Math.random() * 2 - 1) * 0.1;
      }
      const b = new Float32Array(cols).fill(0);
      this.layers.push({ w, b, rows, cols });
      prevSize = cols;
    }

    // Output layer: hidden → 1
    const outW = new Float32Array(hiddenSize);
    for (let i = 0; i < hiddenSize; i++) {
      outW[i] = (Math.random() * 2 - 1) * 0.1;
    }
    this.outputW = outW;
    this.outputB = new Float32Array(1).fill(0);
  }

  /* ── Initialization ──────────────────────────────────────────────────── */

  async initialize(): Promise<void> {
    const dir = path.dirname(this.weightsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.loadWeights();
    this.loadStats();
    console.log(`[NeuralNetONNX] Initialized for ${this.symbol}`);
  }

  /* ── Forward pass (training) ─────────────────────────────────────────── */

  private forward(deltaLast: number): { output: number; cache: ForwardCache } {
    const { numLayers } = this.config;
    const preActivations: Float32Array[] = [];
    const postActivations: Float32Array[] = [];

    // Input layer
    let x = new Float32Array([deltaLast]);

    for (let i = 0; i < numLayers; i++) {
      const layer = this.layers[i];
      // z = x @ W + b
      const z = new Float32Array(layer.cols);
      for (let c = 0; c < layer.cols; c++) {
        let sum = layer.b[c];
        for (let r = 0; r < layer.rows; r++) {
          sum += x[r] * layer.w[r * layer.cols + c];
        }
        z[c] = sum;
      }
      preActivations.push(z);

      // Activation: ReLU (all layers for this small model)
      const a = new Float32Array(layer.cols);
      for (let j = 0; j < layer.cols; j++) {
        a[j] = z[j] > 0 ? z[j] : 0;
      }
      postActivations.push(a);
      x = a;
    }

    // Output: sigmoid(x @ W + b)
    let logit = this.outputB[0];
    for (let i = 0; i < this.outputW.length; i++) {
      logit += x[i] * this.outputW[i];
    }
    const output = 1 / (1 + Math.exp(-logit));

    return { output, cache: { preActivations, postActivations } };
  }

  /* ── Predict (for training, pure JS) ─────────────────────────────────── */

  predictRaw(deltaLast: number): ONNXPrediction {
    const { output } = this.forward(deltaLast);
    return {
      probability: output,
      direction: output > 0.5 ? 'UP' : 'DOWN',
      confidence: output > 0.5 ? output : 1 - output,
    };
  }

  /* ── Predict (for inference, ONNX Runtime on ANE) ────────────────────── */

  async predict(deltaLast: number): Promise<ONNXPrediction> {
    try {
      const session = await this.getOrCreateSession();
      const input = new ort.Tensor('float32', [deltaLast], [1]);
      const results = await session.run({ deltaLast: input });
      const outputTensor = results['direction'];
      const prob = (outputTensor.data as Float32Array)[0];
      return {
        probability: prob,
        direction: prob > 0.5 ? 'UP' : 'DOWN',
        confidence: prob > 0.5 ? prob : 1 - prob,
      };
    } catch {
      // Fallback to JS forward pass
      return this.predictRaw(deltaLast);
    }
  }

  /* ── Backpropagation + weight update ─────────────────────────────────── */

  train(deltaLast: number, target: number, lr?: number): number {
    const learningRate = lr ?? this.config.learningRate;
    const { output, cache } = this.forward(deltaLast);
    const { numLayers } = this.config;

    // Binary cross-entropy loss
    const loss = -(
      target * Math.log(output + 1e-8) +
      (1 - target) * Math.log(1 - output + 1e-8)
    );

    // Output gradient: dL/dlogit = sigmoid - target
    const dOut = output - target;

    if (numLayers === 0) {
      // Single neuron: sigmoid(last * ow + ob)
      this.outputW[0] -= learningRate * dOut * deltaLast;
      this.outputB[0] -= learningRate * dOut;
    } else {
      // Has hidden layers — standard backprop
      const { preActivations, postActivations } = cache;
      const lastHidden = postActivations[numLayers - 1];

      for (let i = 0; i < this.config.hiddenSize; i++) {
        this.outputW[i] -= learningRate * dOut * lastHidden[i];
      }
      this.outputB[0] -= learningRate * dOut;

      let dHidden = new Float32Array(this.config.hiddenSize);
      for (let i = 0; i < this.config.hiddenSize; i++) {
        dHidden[i] = dOut * this.outputW[i];
      }

      for (let l = numLayers - 1; l >= 0; l--) {
        const layer = this.layers[l];
        const x = l === 0 ? new Float32Array([deltaLast]) : postActivations[l - 1];

        for (let i = 0; i < this.config.hiddenSize; i++) {
          if (preActivations[l][i] <= 0) dHidden[i] = 0;
        }

        const dw = new Float32Array(layer.rows * layer.cols);
        for (let r = 0; r < layer.rows; r++) {
          for (let c = 0; c < layer.cols; c++) {
            dw[r * layer.cols + c] = x[r] * dHidden[c];
          }
        }

        const db = new Float32Array(layer.cols);
        for (let c = 0; c < layer.cols; c++) db[c] = dHidden[c];

        const dX = new Float32Array(layer.rows);
        for (let r = 0; r < layer.rows; r++) {
          let sum = 0;
          for (let c = 0; c < layer.cols; c++) {
            sum += dHidden[c] * layer.w[r * layer.cols + c];
          }
          dX[r] = sum;
        }

        for (let i = 0; i < layer.w.length; i++) layer.w[i] -= learningRate * dw[i];
        for (let i = 0; i < layer.b.length; i++) layer.b[i] -= learningRate * db[i];

        dHidden = dX;
      }
    }

    return loss;
  }

  /* ── Normalization (Welford's online algorithm) ──────────────────────── */

  updateStats(deltaLast: number): void {
    this.sampleCount++;
    const delta = deltaLast - this.runningMean;
    this.runningMean += delta / this.sampleCount;
    const delta2 = deltaLast - this.runningMean;
    this.runningM2 += delta * delta2;
    if (this.sampleCount % 100 === 0) this.saveStats();
  }

  normalize(deltaLast: number): number {
    if (this.sampleCount < 2) return deltaLast;
    const std = Math.sqrt(this.runningM2 / this.sampleCount);
    if (std < 1e-8) return 0;
    const normalized = (deltaLast - this.runningMean) / std;
    return Math.max(-5, Math.min(5, normalized));
  }

  /* ── ONNX Model Export ───────────────────────────────────────────────── */

  async exportToOnnx(): Promise<void> {
    const { numLayers, hiddenSize } = this.config;
    const nodes: onnx.NodeProto[] = [];
    const inputs: onnx.ValueInfoProto[] = [];
    const outputs: onnx.ValueInfoProto[] = [];
    const initializers: onnx.TensorProto[] = [];

    // Input
    inputs.push(onnx.ValueInfoProto.create({
      name: 'deltaLast',
      type: this.floatTensorType([1]),
    }));

    // Build layers
    let prevName = 'deltaLast';
    let prevSize = 1;

    for (let i = 0; i < numLayers; i++) {
      const layer = this.layers[i];
      const wName = `W${i}`;
      const bName = `b${i}`;
      const zName = `Z${i}`;
      const aName = `A${i}`;

      // Weight initializer [prevSize, hiddenSize]
      initializers.push(onnx.TensorProto.create({
        name: wName,
        dataType: onnx.TensorProto.DataType.FLOAT,
        dims: [prevSize, hiddenSize],
        floatData: Array.from(layer.w),
      }));

      // Bias initializer [hiddenSize]
      initializers.push(onnx.TensorProto.create({
        name: bName,
        dataType: onnx.TensorProto.DataType.FLOAT,
        dims: [hiddenSize],
        floatData: Array.from(layer.b),
      }));

      // MatMul + Add + ReLU
      nodes.push(onnx.NodeProto.create({
        name: `MatMul${i}`,
        opType: 'MatMul',
        input: [prevName, wName],
        output: [zName],
      }));
      nodes.push(onnx.NodeProto.create({
        name: `Add${i}`,
        opType: 'Add',
        input: [zName, bName],
        output: [aName],
      }));

      // ReLU on all hidden layers
      nodes.push(onnx.NodeProto.create({
        name: `Relu${i}`,
        opType: 'Relu',
        input: [aName],
        output: [`${aName}_relu`],
      }));

      prevName = `${aName}_relu`;
      prevSize = hiddenSize;
    }

    // Output layer: MatMul + Add + Sigmoid
    const outWName = 'W_out';
    const outBName = 'b_out';
    const outZName = 'Z_out';

    initializers.push(onnx.TensorProto.create({
      name: outWName,
      dataType: onnx.TensorProto.DataType.FLOAT,
      dims: [hiddenSize, 1],
      floatData: Array.from(this.outputW),
    }));

    initializers.push(onnx.TensorProto.create({
      name: outBName,
      dataType: onnx.TensorProto.DataType.FLOAT,
      dims: [1],
      floatData: Array.from(this.outputB),
    }));

    nodes.push(onnx.NodeProto.create({
      name: 'MatMul_out',
      opType: 'MatMul',
      input: [prevName, outWName],
      output: [outZName],
    }));
    nodes.push(onnx.NodeProto.create({
      name: 'Add_out',
      opType: 'Add',
      input: [outZName, outBName],
      output: ['logit'],
    }));
    nodes.push(onnx.NodeProto.create({
      name: 'Sigmoid',
      opType: 'Sigmoid',
      input: ['logit'],
      output: ['direction'],
    }));

    outputs.push(onnx.ValueInfoProto.create({
      name: 'direction',
      type: this.floatTensorType([1]),
    }));

    // Build model
    const model = onnx.ModelProto.create({
      irVersion: 8,
      opsetImport: [onnx.OperatorSetIdProto.create({ domain: '', version: 13 })],
      graph: onnx.GraphProto.create({
        name: `NPU_${this.symbol}`,
        node: nodes,
        input: inputs,
        output: outputs,
        initializer: initializers,
      }),
    });

    const bytes = onnx.ModelProto.encode(model).finish();
    fs.writeFileSync(this.onnxModelPath, Buffer.from(bytes));
    console.log(`[NeuralNetONNX] Exported ONNX model to ${this.onnxModelPath} (${bytes.length} bytes)`);
  }

  /* ── ONNX Runtime Session ────────────────────────────────────────────── */

  private async getOrCreateSession(): Promise<ort.InferenceSession> {
    if (!this.sessionPromise) {
      // Ensure model exists
      if (!fs.existsSync(this.onnxModelPath)) {
        await this.exportToOnnx();
      }

      const coremlEP = {
        name: 'coreml',
        ModelFormat: 'MLProgram',
        MLComputeUnits: 'CPUAndNeuralEngine',
        RequireStaticInputShapes: '1',
      } as unknown as ort.InferenceSession.ExecutionProviderConfig;

      this.sessionPromise = ort.InferenceSession.create(this.onnxModelPath, {
        executionProviders: [coremlEP],
      });
    }
    return this.sessionPromise;
  }

  /* ── Weight persistence ──────────────────────────────────────────────── */

  private loadWeights(): void {
    if (!fs.existsSync(this.weightsPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.weightsPath, 'utf8'));
      const { numLayers } = this.config;

      for (let i = 0; i < numLayers; i++) {
        this.layers[i].w = Float32Array.from(data.layers[i].w);
        this.layers[i].b = Float32Array.from(data.layers[i].b);
      }

      this.outputW = Float32Array.from(data.outputW);
      this.outputB = Float32Array.from(data.outputB);

      console.log(`[NeuralNetONNX] Loaded weights from ${this.weightsPath}`);
    } catch (e) {
      console.error(`[NeuralNetONNX] Failed to load weights: ${(e as Error).message}`);
    }
  }

  saveWeights(): void {
    const data = {
      layers: this.layers.map(l => ({
        w: Array.from(l.w),
        b: Array.from(l.b),
      })),
      outputW: Array.from(this.outputW),
      outputB: Array.from(this.outputB),
    };
    fs.writeFileSync(this.weightsPath, JSON.stringify(data));
  }

  /* ── Stats persistence ───────────────────────────────────────────────── */

  private loadStats(): void {
    if (!fs.existsSync(this.statsPath)) return;
    try {
      const stats = JSON.parse(fs.readFileSync(this.statsPath, 'utf8'));
      this.runningMean = stats.mean ?? 0;
      this.runningM2 = stats.m2 ?? 0;
      this.sampleCount = stats.sampleCount ?? 0;
    } catch {
      // ignore
    }
  }

  saveStats(): void {
    const stats = {
      mean: this.runningMean,
      m2: this.runningM2,
      sampleCount: this.sampleCount,
    };
    fs.writeFileSync(this.statsPath, JSON.stringify(stats, null, 2));
  }

  /* ── Utility ─────────────────────────────────────────────────────────── */

  private floatTensorType(dims: number[]): onnx.TypeProto {
    return onnx.TypeProto.create({
      tensorType: onnx.TypeProto.Tensor.create({
        elemType: onnx.TensorProto.DataType.FLOAT,
        shape: onnx.TensorShapeProto.create({
          dim: dims.map(d => onnx.TensorShapeProto.Dimension.create({ dimValue: d })),
        }),
      }),
    });
  }

  getInfo(): { symbol: string; config: ONNXModelConfig; sampleCount: number; runningMean: number } {
    return {
      symbol: this.symbol,
      config: this.config,
      sampleCount: this.sampleCount,
      runningMean: this.runningMean,
    };
  }

  /** Invalidate ONNX session (call after weight updates). */
  resetSession(): void {
    this.sessionPromise = null;
  }
}
