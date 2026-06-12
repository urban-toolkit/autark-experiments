// For every building, counts how many noise events fall within 500 m of the
// building centroid. Uses a uniform grid index over the noise points so the
// join stays fast even with tens of thousands of buildings.

import type { Feature, FeatureCollection, Position } from "geojson";
import type { NoisePoint } from "./noise";

export const RADIUS_M = 500;

// Metres per degree at Manhattan's latitude (~40.78°N).
const LAT = 40.78;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);

function ringCentroid(ring: Position[]): [number, number] {
  // Area-weighted polygon centroid (falls back to vertex average for
  // degenerate rings).
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-12) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / ring.length, sy / ring.length];
  }
  area *= 0.5;
  return [cx / (6 * area), cy / (6 * area)];
}

function featureCentroid(f: Feature): [number, number] | null {
  const g = f.geometry;
  if (g.type === "Polygon") {
    return ringCentroid(g.coordinates[0]);
  }
  if (g.type === "MultiPolygon") {
    // Use the largest ring's outer boundary (by vertex count) as a proxy.
    let best: Position[] | null = null;
    for (const poly of g.coordinates) {
      if (!best || poly[0].length > best.length) best = poly[0];
    }
    return best ? ringCentroid(best) : null;
  }
  return null;
}

function distanceM(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const dx = (lon1 - lon2) * M_PER_DEG_LON;
  const dy = (lat1 - lat2) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

interface Grid {
  cell: number; // degrees
  map: Map<string, NoisePoint[]>;
  key(lon: number, lat: number): string;
}

function buildGrid(points: NoisePoint[]): Grid {
  // Cell size ~ the search radius so each query touches a 3x3 neighbourhood.
  const cellLat = RADIUS_M / M_PER_DEG_LAT;
  const map = new Map<string, NoisePoint[]>();
  const key = (lon: number, lat: number) =>
    `${Math.floor(lon / cellLat)}:${Math.floor(lat / cellLat)}`;
  for (const p of points) {
    const k = key(p.lon, p.lat);
    const bucket = map.get(k);
    if (bucket) bucket.push(p);
    else map.set(k, [p]);
  }
  return { cell: cellLat, map, key };
}

export interface JoinResult {
  counts: number[]; // per building feature, same order as input
  centroids: ([number, number] | null)[];
  maxCount: number;
}

export function countNoiseWithinRadius(
  buildings: FeatureCollection,
  noise: NoisePoint[],
): JoinResult {
  console.log(
    `[join] Spatial join started: ${buildings.features.length} buildings × ${noise.length} noise events (r=${RADIUS_M}m)…`,
  );
  const t0 = performance.now();
  const grid = buildGrid(noise);
  const counts: number[] = new Array(buildings.features.length).fill(0);
  const centroids: ([number, number] | null)[] = new Array(
    buildings.features.length,
  ).fill(null);
  let maxCount = 0;

  buildings.features.forEach((f, i) => {
    const c = featureCentroid(f);
    centroids[i] = c;
    if (!c) return;
    const [lon, lat] = c;
    const ci = Math.floor(lon / grid.cell);
    const cj = Math.floor(lat / grid.cell);
    let count = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const bucket = grid.map.get(`${ci + di}:${cj + dj}`);
        if (!bucket) continue;
        for (const p of bucket) {
          if (distanceM(lon, lat, p.lon, p.lat) <= RADIUS_M) count++;
        }
      }
    }
    counts[i] = count;
    if (count > maxCount) maxCount = count;
  });

  console.log(
    `[join] Spatial join complete in ${(performance.now() - t0).toFixed(
      0,
    )}ms. Max complaints near a building: ${maxCount}. ` +
      `Buildings with ≥1 nearby complaint: ${counts.filter((c) => c > 0).length}`,
  );
  return { counts, centroids, maxCount };
}
