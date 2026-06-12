import type { OsmLayers, SubwayStation } from "./types";

const RADIUS_M = 500;
const M_PER_DEG_LAT = 111_320;

/**
 * For every building, counts the number of subway stations whose distance to
 * the building footprint centroid is within RADIUS_M metres.
 *
 * Stations are bucketed into a ~500 m grid so each building only tests stations
 * in the 9 neighbouring cells instead of all 472. Distances use an
 * equirectangular approximation, which is accurate to well under a metre at the
 * 500 m scale and the latitude of Manhattan.
 */
export function countStationsPerBuilding(
  layers: OsmLayers,
  stations: SubwayStation[]
): { max: number; total: number } {
  console.log(
    `[spatial] Spatial join started: ${layers.buildings.features.length} buildings × ${stations.length} stations (r=${RADIUS_M} m)`
  );

  // Grid cell size in degrees, sized to the search radius.
  const refLat = stations.length
    ? stations.reduce((s, st) => s + st.lat, 0) / stations.length
    : 40.78;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  const cellLat = RADIUS_M / M_PER_DEG_LAT;
  const cellLon = RADIUS_M / mPerDegLon;

  const grid = new Map<string, SubwayStation[]>();
  const key = (cx: number, cy: number) => `${cx}:${cy}`;
  for (const st of stations) {
    const cx = Math.floor(st.lon / cellLon);
    const cy = Math.floor(st.lat / cellLat);
    const k = key(cx, cy);
    const bucket = grid.get(k);
    if (bucket) bucket.push(st);
    else grid.set(k, [st]);
  }

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
        for (const st of bucket) {
          const dx = (st.lon - clon) * mPerDegLon;
          const dy = (st.lat - clat) * M_PER_DEG_LAT;
          if (dx * dx + dy * dy <= RADIUS_M * RADIUS_M) count++;
        }
      }
    }

    b.properties.stationCount = count;
    if (count > 0) {
      matchedBuildings++;
      totalMatches += count;
    }
    if (count > max) max = count;
  }

  console.log(
    `[spatial] Spatial join complete: ${matchedBuildings} buildings within 500 m of ≥1 station; max stations for a single building = ${max}`
  );
  return { max, total: totalMatches };
}

/** Average-vertex centroid of a closed ring (the closing vertex is ignored). */
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
