import type { ProjectedRoads } from './projection';

// Two WGSL compute kernels run on the same device:
//  1. lengths  — one thread per road sums its segment lengths (metres).
//  2. noise    — one thread per road counts noise events whose distance to
//                the road polyline is <= radius (point-to-segment distance).
// Coordinates arrive already projected to flat metres, so no trig is needed.

const LENGTH_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> coords: array<f32>;
@group(0) @binding(1) var<storage, read> roadIndex: array<u32>;
@group(0) @binding(2) var<storage, read_write> lengths: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= arrayLength(&lengths)) { return; }
  let start = roadIndex[r * 2u];
  let count = roadIndex[r * 2u + 1u];
  var total: f32 = 0.0;
  if (count >= 2u) {
    for (var i: u32 = 0u; i < count - 1u; i = i + 1u) {
      let a = (start + i) * 2u;
      let b = (start + i + 1u) * 2u;
      let dx = coords[b] - coords[a];
      let dy = coords[b + 1u] - coords[a + 1u];
      total = total + sqrt(dx * dx + dy * dy);
    }
  }
  lengths[r] = total;
}
`;

const NOISE_SHADER = /* wgsl */ `
struct Params { numNoise: u32, r2: f32 };

@group(0) @binding(0) var<storage, read> coords: array<f32>;
@group(0) @binding(1) var<storage, read> roadIndex: array<u32>;
@group(0) @binding(2) var<storage, read> noise: array<f32>;
@group(0) @binding(3) var<storage, read_write> counts: array<u32>;
@group(0) @binding(4) var<uniform> params: Params;

fn dist2_point_seg(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
  let abx = bx - ax;
  let aby = by - ay;
  let apx = px - ax;
  let apy = py - ay;
  let ab2 = abx * abx + aby * aby;
  var t: f32 = 0.0;
  if (ab2 > 0.0) { t = clamp((apx * abx + apy * aby) / ab2, 0.0, 1.0); }
  let cx = ax + t * abx;
  let cy = ay + t * aby;
  let dx = px - cx;
  let dy = py - cy;
  return dx * dx + dy * dy;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= arrayLength(&counts)) { return; }
  let start = roadIndex[r * 2u];
  let count = roadIndex[r * 2u + 1u];
  if (count < 2u) { counts[r] = 0u; return; }

  var c: u32 = 0u;
  for (var n: u32 = 0u; n < params.numNoise; n = n + 1u) {
    let px = noise[n * 2u];
    let py = noise[n * 2u + 1u];
    var minD2: f32 = 3.4e38;
    for (var i: u32 = 0u; i < count - 1u; i = i + 1u) {
      let a = (start + i) * 2u;
      let b = (start + i + 1u) * 2u;
      let d2 = dist2_point_seg(px, py, coords[a], coords[a + 1u], coords[b], coords[b + 1u]);
      minD2 = min(minD2, d2);
      if (minD2 <= params.r2) { break; }
    }
    if (minD2 <= params.r2) { c = c + 1u; }
  }
  counts[r] = c;
}
`;

export interface GpuResult {
  lengths: Float32Array;
  counts: Uint32Array;
}

function makeStorage(device: GPUDevice, data: ArrayBufferView): GPUBuffer {
  const buf = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, data as BufferSource);
  return buf;
}

/** Runs both kernels on the GPU. Throws if WebGPU is unavailable. */
export async function gpuCompute(
  roads: ProjectedRoads,
  noise: Float32Array,
  radius: number
): Promise<GpuResult> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU not available');
  }
  console.log('Requesting WebGPU adapter/device...');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter found');
  const device = await adapter.requestDevice();
  console.log('WebGPU device acquired — running distributed compute kernels');
  const t0 = performance.now();

  const numRoads = roads.numRoads;
  const coordsBuf = makeStorage(device, roads.coords);
  const indexBuf = makeStorage(device, roads.index);

  // --- Kernel 1: lengths ---
  const lengthsBuf = device.createBuffer({
    size: numRoads * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const lengthPipe = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: LENGTH_SHADER }), entryPoint: 'main' },
  });
  const lengthBind = device.createBindGroup({
    layout: lengthPipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: coordsBuf } },
      { binding: 1, resource: { buffer: indexBuf } },
      { binding: 2, resource: { buffer: lengthsBuf } },
    ],
  });

  // --- Kernel 2: noise counts ---
  const numNoise = noise.length / 2;
  const noiseBuf = makeStorage(device, noise.length > 0 ? noise : new Float32Array(2));
  const countsBuf = device.createBuffer({
    size: numRoads * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const paramsBuf = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([numNoise]));
  device.queue.writeBuffer(paramsBuf, 4, new Float32Array([radius * radius]));
  const noisePipe = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: NOISE_SHADER }), entryPoint: 'main' },
  });
  const noiseBind = device.createBindGroup({
    layout: noisePipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: coordsBuf } },
      { binding: 1, resource: { buffer: indexBuf } },
      { binding: 2, resource: { buffer: noiseBuf } },
      { binding: 3, resource: { buffer: countsBuf } },
      { binding: 4, resource: { buffer: paramsBuf } },
    ],
  });

  const workgroups = Math.ceil(numRoads / 64);
  const encoder = device.createCommandEncoder();

  const p1 = encoder.beginComputePass();
  p1.setPipeline(lengthPipe);
  p1.setBindGroup(0, lengthBind);
  p1.dispatchWorkgroups(workgroups);
  p1.end();

  const p2 = encoder.beginComputePass();
  p2.setPipeline(noisePipe);
  p2.setBindGroup(0, noiseBind);
  p2.dispatchWorkgroups(workgroups);
  p2.end();

  // Readback buffers
  const lenRead = device.createBuffer({ size: numRoads * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const cntRead = device.createBuffer({ size: numRoads * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  encoder.copyBufferToBuffer(lengthsBuf, 0, lenRead, 0, numRoads * 4);
  encoder.copyBufferToBuffer(countsBuf, 0, cntRead, 0, numRoads * 4);
  device.queue.submit([encoder.finish()]);

  await Promise.all([lenRead.mapAsync(GPUMapMode.READ), cntRead.mapAsync(GPUMapMode.READ)]);
  const lengths = new Float32Array(lenRead.getMappedRange().slice(0));
  const counts = new Uint32Array(cntRead.getMappedRange().slice(0));
  lenRead.unmap();
  cntRead.unmap();

  for (const b of [coordsBuf, indexBuf, lengthsBuf, noiseBuf, countsBuf, paramsBuf, lenRead, cntRead]) b.destroy();
  device.destroy();

  console.log(
    `GPU compute complete in ${(performance.now() - t0).toFixed(1)}ms (${numRoads} roads, ${numNoise} noise events)`
  );
  return { lengths, counts };
}
