import { fetchManhattanOsmData } from './data/overpassClient';
import { parseOsmData } from './data/osmParser';
import { loadNoiseEvents } from './data/noiseLoader';
import { computeRoadMetrics, NOISE_RADIUS_M } from './compute/roadMetrics';
import { MapManager } from './map/mapManager';

function setStatus(msg: string): void {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = msg;
  console.log(`[Status] ${msg}`);
}

function hideLoading(): void {
  document.getElementById('loading-overlay')?.classList.add('hidden');
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function main(): Promise<void> {
  console.log('=== Manhattan Street Network — starting ===');

  try {
    // Step 1: map shell
    setStatus('Initializing map...');
    const mapManager = new MapManager();
    await mapManager.onReady();
    console.log('Map ready');

    // Step 2 + 3: fetch OSM + noise in parallel (one Overpass call only)
    setStatus('Loading Manhattan OSM layers and noise data...');
    const [osmData, noiseEvents] = await Promise.all([
      fetchManhattanOsmData(),
      loadNoiseEvents(),
    ]);

    // Step 4: parse OSM into layers
    setStatus('Parsing OSM data...');
    const layers = parseOsmData(osmData);

    // Step 5: compute road lengths + noise-within-10m counts (GPU if available)
    setStatus('Computing road lengths and noise counts (GPU if available)...');
    const metrics = await computeRoadMetrics(layers.roads, noiseEvents);
    console.log(`Compute backend used: ${metrics.usedGpu ? 'GPU (WebGPU)' : 'CPU fallback'}`);

    // Step 6: inject computed values into road features
    let maxNoise = 0;
    let totalMatched = 0;
    for (let i = 0; i < layers.roads.features.length; i++) {
      const len = metrics.lengths[i];
      const cnt = metrics.counts[i];
      layers.roads.features[i].properties.road_length = len;
      layers.roads.features[i].properties.noise_count = cnt;
      if (cnt > maxNoise) maxNoise = cnt;
      totalMatched += cnt;
    }

    // Color ramp maxima: clamp length at the 95th percentile to avoid outliers
    const sortedLengths = Array.from(metrics.lengths).sort((a, b) => a - b);
    const lengthMax = percentile(sortedLengths, 0.95) || 2000;

    console.log(
      `Road lengths — min ${sortedLengths[0]?.toFixed(1)}m, max ${sortedLengths[sortedLengths.length - 1]?.toFixed(1)}m, p95 ${lengthMax.toFixed(1)}m`
    );
    console.log(
      `Noise spatial join (r=${NOISE_RADIUS_M}m) — max per-road count ${maxNoise}, total road-event matches ${totalMatched}`
    );

    // Step 7: render
    setStatus('Rendering layers...');
    mapManager.addLayers(layers, lengthMax, maxNoise || 1);

    hideLoading();
    console.log('=== Application fully loaded and rendered ===');
  } catch (err) {
    console.error('Application error:', err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main();
