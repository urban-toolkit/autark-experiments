import type { RoadCollection, NoiseEvent } from '../data/types';

// Local equirectangular projection centred on Manhattan. Over a ~20 km span
// the distortion is < 0.3 %, far below the 10 m radius precision we need, and
// it lets every length / distance computation run in flat metres on the GPU.
const REF_LAT = 40.78;
const REF_LON = -73.97;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((REF_LAT * Math.PI) / 180);

export function projectLon(lon: number): number {
  return (lon - REF_LON) * M_PER_DEG_LON;
}
export function projectLat(lat: number): number {
  return (lat - REF_LAT) * M_PER_DEG_LAT;
}

export interface ProjectedRoads {
  /** Flat [x0,y0, x1,y1, ...] metre coordinates of every road vertex. */
  coords: Float32Array;
  /** Per road: [startVertex, vertexCount] into `coords`. */
  index: Uint32Array;
  numRoads: number;
}

/** Flattens & projects all road polylines into GPU-friendly typed arrays. */
export function projectRoads(roads: RoadCollection): ProjectedRoads {
  const numRoads = roads.features.length;
  let totalPoints = 0;
  for (const f of roads.features) totalPoints += f.geometry.coordinates.length;

  const coords = new Float32Array(totalPoints * 2);
  const index = new Uint32Array(numRoads * 2);
  let pointOffset = 0;
  let w = 0;

  for (let i = 0; i < numRoads; i++) {
    const c = roads.features[i].geometry.coordinates;
    index[i * 2] = pointOffset;
    index[i * 2 + 1] = c.length;
    for (const p of c) {
      coords[w++] = projectLon(p[0]);
      coords[w++] = projectLat(p[1]);
    }
    pointOffset += c.length;
  }
  return { coords, index, numRoads };
}

/** Projects noise events into a flat [x0,y0, x1,y1, ...] metre array. */
export function projectNoise(events: NoiseEvent[]): Float32Array {
  const out = new Float32Array(events.length * 2);
  for (let i = 0; i < events.length; i++) {
    out[i * 2] = projectLon(events[i].lon);
    out[i * 2 + 1] = projectLat(events[i].lat);
  }
  return out;
}
