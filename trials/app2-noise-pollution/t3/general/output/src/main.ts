// Orchestrates the whole pipeline: load OSM layers + noise CSV, run the
// spatial join, then render the 3D map.

import { loadOsmLayers } from "./overpass";
import { loadNoisePoints } from "./noise";
import { countNoiseWithinRadius, RADIUS_M } from "./spatialJoin";
import { renderMap } from "./render";

const statusEl = document.getElementById("status") as HTMLDivElement;
const legendMax = document.getElementById("legend-max") as HTMLSpanElement;

function status(msg: string) {
  statusEl.textContent = msg;
  console.log(`[app] ${msg}`);
}

async function main() {
  console.log("%cManhattan Noisescape — booting", "font-weight:bold");
  const t0 = performance.now();
  try {
    status("Loading OSM layers and noise data…");
    // Fetch OSM (cached) and the noise CSV concurrently.
    const [osm, noise] = await Promise.all([
      loadOsmLayers(),
      loadNoisePoints(),
    ]);

    status(
      `Joining ${osm.buildings.features.length} buildings with ${noise.length} noise events (≤${RADIUS_M}m)…`,
    );
    const { counts, maxCount } = countNoiseWithinRadius(osm.buildings, noise);
    legendMax.textContent = String(maxCount);

    status("Rendering 3D map…");
    renderMap(osm, counts, maxCount);

    status(
      `Ready · ${osm.buildings.features.length} buildings · max ${maxCount} complaints near a building.`,
    );
    console.log(
      `[app] Pipeline complete in ${((performance.now() - t0) / 1000).toFixed(
        1,
      )}s.`,
    );
  } catch (err) {
    console.error("[app] Fatal error during startup:", err);
    status(`Error: ${(err as Error).message}. See console for details.`);
  }
}

main();
