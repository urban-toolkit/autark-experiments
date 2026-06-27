import type { ExpressionSpecification } from 'maplibre-gl';

/** Diverging blue→red ramp for road length (short → long). */
export function roadLengthColorExpression(maxLength: number): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['get', 'road_length'],
    0, '#2166ac',
    maxLength * 0.1, '#67a9cf',
    maxLength * 0.25, '#d1e5f0',
    maxLength * 0.5, '#fddbc7',
    maxLength * 0.75, '#ef8a62',
    maxLength, '#b2182b',
  ] as ExpressionSpecification;
}

/** Sequential yellow→dark-red ramp for noise-event counts (low → high). */
export function roadNoiseColorExpression(maxCount: number): ExpressionSpecification {
  const m = Math.max(maxCount, 1);
  return [
    'interpolate',
    ['linear'],
    ['get', 'noise_count'],
    0, '#ffffcc',
    m * 0.25, '#fed976',
    m * 0.5, '#fd8d3c',
    m * 0.75, '#e31a1c',
    m, '#800026',
  ] as ExpressionSpecification;
}

export const SELECTION_COLOR = '#ffff00';

export const LAYER_COLORS = {
  surface: '#e8e0d0',
  parks: '#b5d99c',
  water: '#a3cce9',
} as const;
