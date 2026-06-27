import type { NoiseEvent, OsmLayers } from "./types";

const RADIUS_M = 500;
const M_PER_DEG_LAT = 111_320;

/**
 * For every building, counts the noise events whose distance to the building
 * footprint centroid is within RADIUS_M metres, and writes the result onto
 * `properties.noiseCount`.
 *
 * Events are bucketed into a ~500 m grid so each building only tests the events
 * in its 9 neighbouring cells instead of all of them. Distances use an
 * equirectangular approximation, accurate to well under a metre at the 500 m
 * scale and Manhattan's latitude.
 */
export function countNoisePerBuilding(
  layers: OsmLayers,
  events: NoiseEvent[]
): { max: number; total: number } {
  console.log(
    `[spatial] Spatial join started: ${layers.buildings.features.length} buildings × ${events.length} noise events (r=${RADIUS_M} m)`
  );

  // Metres-per-degree-longitude at the mean event latitude, plus grid cells
  // sized to the search radius.
  const refLat = events.length
    ? events.reduce((s, e) => s + e.lat, 0) / events.length
    : 40.78;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  const cellLat = RADIUS_M / M_PER_DEG_LAT;
  const cellLon = RADIUS_M / mPerDegLon;

  const grid = new Map<string, NoiseEvent[]>();
  const key = (cx: number, cy: number) => `${cx}:${cy}`;
  for (const e of events) {
    const cx = Math.floor(e.lon / cellLon);
    const cy = Math.floor(e.lat / cellLat);
    const k = key(cx, cy);
    const bucket = grid.get(k);
    if (bucket) bucket.push(e);
    else grid.set(k, [e]);
  }

  const r2 = RADIUS_M * RADIUS_M;
  let max = 0;
  let totalMatches = 0;
  let matchedBuildings = 0;

  for (const b of layers.buildings.features) {
    const [clon, clat] = centroid(b.geometry.coordinates[0]);
    const cx = Math.floor(clon / cellLon);
    const cy = Math.floor(clat / cellLat);

    let count = 0;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(key(gx, gy));
        if (!bucket) continue;
        for (const e of bucket) {
          const dx = (e.lon - clon) * mPerDegLon;
          const dy = (e.lat - clat) * M_PER_DEG_LAT;
          if (dx * dx + dy * dy <= r2) count++;
        }
      }
    }

    b.properties.noiseCount = count;
    if (count > 0) {
      matchedBuildings++;
      totalMatches += count;
    }
    if (count > max) max = count;
  }

  console.log(
    `[spatial] Spatial join complete: ${matchedBuildings} buildings within 500 m of ≥1 noise event; max for a single building = ${max}`
  );
  return { max, total: totalMatches };
}

/** Average-vertex centroid of a closed ring (the duplicated closing vertex is ignored). */
function centroid(ring: number[][]): [number, number] {
  const n = ring.length > 1 ? ring.length - 1 : ring.length;
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < n; i++) {
    lon += ring[i][0];
    lat += ring[i][1];
  }
  return [lon / n, lat / n];
}
