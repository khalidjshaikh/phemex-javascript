/**
 * npu-app.ts
 *
 * Calls a function that adds two numbers (2 and 3) on the Apple Neural
 * Engine (NPU) via the ONNX Runtime CoreML execution provider, using the
 * model.onnx graph C = A + B.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ort from 'onnxruntime-node';
import { onnx } from 'onnx-proto';

const MODEL_PATH = path.join(__dirname, 'model.onnx');

/** Create an ONNX TypeProto for a float32 tensor of the given static dims. */
function floatTensorType(dims: number[]): onnx.TypeProto {
  return onnx.TypeProto.create({
    tensorType: onnx.TypeProto.Tensor.create({
      elemType: onnx.TensorProto.DataType.FLOAT,
      shape: onnx.TensorShapeProto.create({
        dim: dims.map((d) => onnx.TensorShapeProto.Dimension.create({ dimValue: d })),
      }),
    }),
  });
}

/** Build and write model.onnx (graph: C = A + B) using onnx-proto. */
function buildModel(): void {
  const model = onnx.ModelProto.create({
    irVersion: 8,
    opsetImport: [onnx.OperatorSetIdProto.create({ domain: '', version: 13 })],
    graph: onnx.GraphProto.create({
      name: 'AddGraph',
      node: [
        onnx.NodeProto.create({
          name: 'Add0',
          opType: 'Add',
          input: ['A', 'B'],
          output: ['C'],
        }),
      ],
      input: [
        onnx.ValueInfoProto.create({ name: 'A', type: floatTensorType([1]) }),
        onnx.ValueInfoProto.create({ name: 'B', type: floatTensorType([1]) }),
      ],
      output: [onnx.ValueInfoProto.create({ name: 'C', type: floatTensorType([1]) })],
    }),
  });
  const bytes = onnx.ModelProto.encode(model).finish();
  fs.writeFileSync(MODEL_PATH, Buffer.from(bytes));
  console.log(`Built ${MODEL_PATH} (${bytes.length} bytes)`);
}

// Build the model on demand if it doesn't exist yet.
if (!fs.existsSync(MODEL_PATH)) {
  buildModel();
}

// Cache the session so repeated calls reuse the NPU-compiled model.
let sessionPromise: Promise<ort.InferenceSession> | null = null;

function createSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    // CoreML EP: ML Program format compiled for CPU + Apple Neural Engine
    // (NPU). No CPU fallback: if CoreML cannot claim the Add node, session
    // creation fails loudly.
    const coremlEP = {
      name: 'coreml',
      ModelFormat: 'MLProgram',
      MLComputeUnits: 'CPUAndNeuralEngine',
      RequireStaticInputShapes: '1',
    } as unknown as ort.InferenceSession.ExecutionProviderConfig;
    sessionPromise = ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: [coremlEP],
    });
  }
  return sessionPromise;
}

/** Add two numbers on the NPU. Resolves with the sum. */
async function add(a: number, b: number): Promise<number> {
  const session = await createSession();
  const feeds: ort.InferenceSession.FeedsType = {
    A: new ort.Tensor('float32', new Float32Array([a]), [1]),
    B: new ort.Tensor('float32', new Float32Array([b]), [1]),
  };
  const results = await session.run(feeds);
  const c = results.C as ort.Tensor;
  return (c.data as Float32Array)[0];
}

async function main(): Promise<void> {
  const sum = await add(2, 3);
  console.log(`2 + 3 = ${sum} (on NPU)`);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
