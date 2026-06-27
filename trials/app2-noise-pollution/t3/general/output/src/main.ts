import "maplibre-gl/dist/maplibre-gl.css";
import { loadNoiseEvents } from "./noise";
import { loadOsmLayers } from "./overpass";
import { countNoisePerBuilding } from "./spatial";
import { renderMap } from "./render";

const statusEl = document.getElementById("status") as HTMLDivElement;
const legendEl = document.getElementById("legend") as HTMLDivElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

async function main(): Promise<void> {
  console.log("[main] Manhattan Noisescape app starting");
  const t0 = performance.now();

  try {
    // 1. Noise complaints (NYC Open Data 311 CSV).
    setStatus("Loading noise complaints…");
    const events = await loadNoiseEvents();
    setStatus(`Loaded ${events.length} noise events`);

    // 2. OpenStreetMap base layers (Overpass), cached in IndexedDB.
    setStatus("Loading OSM layers for Manhattan…");
    const layers = await loadOsmLayers(setStatus);

    // 3. Spatial join: noise events within 500 m of each building.
    setStatus("Counting noise events within 500 m of each building…");
    const { max } = countNoisePerBuilding(layers, events);

    // 4. Render the 3D scene.
    setStatus("Rendering 3D map…");
    renderMap(layers, max);

    // 5. Legend.
    updateLegend(max);
    legendEl.style.display = "block";

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(
      `Ready · ${layers.buildings.features.length.toLocaleString()} buildings · ${events.length.toLocaleString()} noise events · ${secs}s`
    );
    console.log(`[main] App ready in ${secs}s`);
  } catch (err) {
    console.error("[main] Fatal error:", err);
    setStatus(`Error: ${(err as Error).message}. See console for details.`);
  }
}

function updateLegend(max: number): void {
  const midEl = document.getElementById("legend-mid");
  const maxEl = document.getElementById("legend-max");
  if (midEl) midEl.textContent = String(Math.round(max / 2));
  if (maxEl) maxEl.textContent = String(max);
}

main();
