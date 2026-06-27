import type { RoadCollection, NoiseEvent } from '../data/types';
import { projectRoads, projectNoise } from './projection';
import { gpuCompute } from './gpuCompute';
import { cpuLengths, cpuNoiseCounts } from './cpuCompute';

export const NOISE_RADIUS_M = 10;

export interface RoadMetrics {
  lengths: Float32Array;
  counts: Uint32Array;
  usedGpu: boolean;
}

/**
 * Computes, for every road segment, its length (m) and the number of noise
 * events within NOISE_RADIUS_M metres. Runs the work on the GPU (distributed
 * one-thread-per-road compute kernels) when WebGPU is available, otherwise
 * falls back to an equivalent CPU implementation.
 */
export async function computeRoadMetrics(
  roads: RoadCollection,
  noiseEvents: NoiseEvent[]
): Promise<RoadMetrics> {
  console.log('Projecting roads and noise events to local metric coordinates...');
  const projRoads = projectRoads(roads);
  const projNoise = projectNoise(noiseEvents);

  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      console.log('WebGPU detected — computing lengths + noise counts on GPU');
      const { lengths, counts } = await gpuCompute(projRoads, projNoise, NOISE_RADIUS_M);
      return { lengths, counts, usedGpu: true };
    } catch (err) {
      console.warn('GPU compute failed, falling back to CPU:', err);
    }
  } else {
    console.log('WebGPU not available — using CPU compute fallback');
  }

  const lengths = cpuLengths(projRoads);
  const counts = cpuNoiseCounts(projRoads, projNoise, NOISE_RADIUS_M);
  return { lengths, counts, usedGpu: false };
}
