// Sequential YlOrRd-style color ramp mapping a noise count to an RGB color.

export type RGB = [number, number, number];

// YlOrRd control stops.
const STOPS: RGB[] = [
  [255, 255, 204],
  [255, 237, 160],
  [254, 217, 118],
  [254, 178, 76],
  [253, 141, 60],
  [252, 78, 42],
  [227, 26, 28],
  [177, 0, 38],
];

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

// t in [0,1] → color along the ramp.
export function ramp(t: number): RGB {
  const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  if (i >= STOPS.length - 1) return STOPS[STOPS.length - 1];
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

// Map a noise count to a color. Uses a sqrt transform so the long tail of
// low-count buildings still shows visible variation.
export function colorForCount(count: number, maxCount: number): RGB {
  if (maxCount <= 0 || count <= 0) return [60, 66, 78]; // muted grey for zero
  const t = Math.sqrt(count) / Math.sqrt(maxCount);
  return ramp(t);
}
