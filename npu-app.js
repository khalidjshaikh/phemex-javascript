/**
 * app.js
 *
 * Calls a function that adds two numbers (2 and 3) on the Apple Neural
 * Engine (NPU) via the ONNX Runtime CoreML execution provider, using the
 * model.onnx graph C = A + B.
 */
const fs = require('node:fs');
const path = require('node:path');
const ort = require('onnxruntime-node');
const { onnx } = require('onnx-proto');

const MODEL_PATH = path.join(__dirname, 'model.onnx');

/** Create an ONNX TypeProto for a float32 tensor of the given static dims. */
function floatTensorType(dims) {
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
function buildModel() {
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
let sessionPromise = null;

function createSession() {
  if (!sessionPromise) {
    // CoreML EP: ML Program format compiled for CPU + Apple Neural Engine
    // (NPU). No CPU fallback: if CoreML cannot claim the Add node, session
    // creation fails loudly.
    sessionPromise = ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: [
        {
          name: 'coreml',
          ModelFormat: 'MLProgram',
          MLComputeUnits: 'CPUAndNeuralEngine',
          RequireStaticInputShapes: '1',
        },
      ],
    });
  }
  return sessionPromise;
}

/** Add two numbers on the NPU. Resolves with the sum. */
async function add(a, b) {
  const session = await createSession();
  const feeds = {
    A: new ort.Tensor('float32', new Float32Array([a]), [1]),
    B: new ort.Tensor('float32', new Float32Array([b]), [1]),
  };
  const results = await session.run(feeds);
  const c = results.C;
  return c.data[0];
}

async function main() {
  const sum = await add(2, 3);
  console.log(`2 + 3 = ${sum} (on NPU)`);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
