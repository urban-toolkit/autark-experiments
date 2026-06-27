import type { ProjectedRoads } from './projection';

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
function dist2PointSeg(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = 0;
  if (ab2 > 0) t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

/** CPU fallback: per-road polyline length in metres. */
export function cpuLengths(roads: ProjectedRoads): Float32Array {
  console.log(`CPU length calculation for ${roads.numRoads} road segments...`);
  const t0 = performance.now();
  const { coords, index, numRoads } = roads;
  const lengths = new Float32Array(numRoads);

  for (let r = 0; r < numRoads; r++) {
    const start = index[r * 2];
    const count = index[r * 2 + 1];
    let total = 0;
    for (let i = 0; i < count - 1; i++) {
      const a = (start + i) * 2;
      const b = (start + i + 1) * 2;
      const dx = coords[b] - coords[a];
      const dy = coords[b + 1] - coords[a + 1];
      total += Math.sqrt(dx * dx + dy * dy);
    }
    lengths[r] = total;
  }
  console.log(`CPU length calculation complete in ${(performance.now() - t0).toFixed(1)}ms`);
  return lengths;
}

/** CPU fallback: per-road count of noise events within `radius` metres. */
export function cpuNoiseCounts(
  roads: ProjectedRoads,
  noise: Float32Array,
  radius: number
): Uint32Array {
  const numNoise = noise.length / 2;
  console.log(`CPU noise spatial join: ${roads.numRoads} roads x ${numNoise} events (r=${radius}m)...`);
  const t0 = performance.now();
  const { coords, index, numRoads } = roads;
  const counts = new Uint32Array(numRoads);
  const r2 = radius * radius;

  for (let r = 0; r < numRoads; r++) {
    const start = index[r * 2];
    const count = index[r * 2 + 1];
    let c = 0;
    for (let n = 0; n < numNoise; n++) {
      const px = noise[n * 2];
      const py = noise[n * 2 + 1];
      let minD2 = Infinity;
      for (let i = 0; i < count - 1; i++) {
        const a = (start + i) * 2;
        const b = (start + i + 1) * 2;
        const d2 = dist2PointSeg(px, py, coords[a], coords[a + 1], coords[b], coords[b + 1]);
        if (d2 < minD2) minD2 = d2;
        if (minD2 <= r2) break;
      }
      if (minD2 <= r2) c++;
    }
    counts[r] = c;
  }
  console.log(`CPU noise spatial join complete in ${(performance.now() - t0).toFixed(1)}ms`);
  return counts;
}
