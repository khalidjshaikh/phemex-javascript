import { create, globals } from 'webgpu';

Object.assign(globalThis, globals);

// WGSL compute shader: result[0] = a[0] + b[0]
const shaderCode = /* wgsl */ `
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> result: array<f32>;

@compute @workgroup_size(1)
fn main() {
  result[0] = a[0] + b[0];
}
`;

// The native dawn.node implementation lives only as long as this reference
// (see the webgpu README "Lifetime" note). Dropping it lets GC tear down the
// GPU while requestAdapter's async callback is still in flight -> SIGSEGV.
const gpu = create([]);

// Adds two numbers on the GPU and returns the result.
export async function add(a, b) {
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('No GPU adapter available');
  const device = await adapter.requestDevice();
  const byteSize = Float32Array.BYTES_PER_ELEMENT;

  const bufA = device.createBuffer({ size: byteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bufB = device.createBuffer({ size: byteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bufResult = device.createBuffer({ size: byteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const bufStaging = device.createBuffer({ size: byteSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  device.queue.writeBuffer(bufA, 0, new Float32Array([a]));
  device.queue.writeBuffer(bufB, 0, new Float32Array([b]));

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: shaderCode }), entryPoint: 'main' },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bufA } },
      { binding: 1, resource: { buffer: bufB } },
      { binding: 2, resource: { buffer: bufResult } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();
  encoder.copyBufferToBuffer(bufResult, 0, bufStaging, 0, byteSize);
  device.queue.submit([encoder.finish()]);

  await bufStaging.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(bufStaging.getMappedRange().slice(0, byteSize))[0];
  bufStaging.unmap();
  device.destroy();

  return out;
}
