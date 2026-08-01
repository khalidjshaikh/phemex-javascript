/**
 * npu-app.ts
 *
 * Calls src/npu.ts, which adds two numbers (2 and 3) on the Apple Neural
 * Engine (NPU) via the ONNX Runtime CoreML execution provider, using the
 * model.onnx graph C = A + B.
 */
import { add } from './src/npu.js';

async function main(): Promise<void> {
  const sum = await add(2, 3);
  console.log(`2 + 3 = ${sum} (on NPU)`);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
