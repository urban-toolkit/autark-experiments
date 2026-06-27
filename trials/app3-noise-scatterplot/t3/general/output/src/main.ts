import "maplibre-gl/dist/maplibre-gl.css";
import { loadNoiseEvents } from "./noise";
import { loadOsmLayers } from "./overpass";
import { countNoisePerBuilding } from "./spatial";
import { renderMap } from "./render";
import { createScatterplot } from "./scatter";

const statusEl = document.getElementById("status") as HTMLDivElement;
const legendEl = document.getElementById("legend") as HTMLDivElement;
const scatterEl = document.getElementById("scatter") as HTMLDivElement;
const scatterCanvas = document.getElementById("scatter-canvas") as HTMLCanvasElement;
const scatterInfo = document.getElementById("scatter-info") as HTMLDivElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

async function main(): Promise<void> {
  console.log("[main] Manhattan Noisescape (scatterplot) app starting");
  const t0 = performance.now();

  try {
    // 1. Noise complaints (NYC Open Data 311 CSV).
    setStatus("Loading noise complaints…");
    const events = await loadNoiseEvents();
    setStatus(`Loaded ${events.length} noise events`);

    // 2. OpenStreetMap base layers (Overpass), cached in IndexedDB.
    setStatus("Loading OSM layers for Manhattan…");
    const layers = await loadOsmLayers(setStatus);

    // 3. Spatial join: noise events within 500 m of each building (+ footprint area).
    setStatus("Counting noise events within 500 m of each building…");
    const { max, maxArea } = countNoisePerBuilding(layers, events);

    // 4. Render the 3D scene; keep the controller so the scatterplot brush can
    //    highlight buildings on the map.
    setStatus("Rendering 3D map…");
    const controller = renderMap(layers, max);

    // 5. Interactive scatterplot: x = noise count, y = footprint area. Brushing
    //    points highlights the matching buildings on the map.
    createScatterplot(
      scatterCanvas,
      layers.buildings.features,
      max,
      maxArea,
      (ids) => controller.setBrushedBuildings(ids),
      (html) => {
        scatterInfo.innerHTML = html;
      }
    );
    scatterEl.style.display = "block";

    // 6. Legend.
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
