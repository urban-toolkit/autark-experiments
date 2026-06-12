import { SpatialDb } from "autk-db";
import { AutkMap, LayerType, MapEvent, ColorMapInterpolator } from "autk-map";
import type { Feature } from "geojson";

// ─────────────────────────────────────────────────────────────────────────────
// Manhattan Noisescape
//
// Fully browser-side urban visual-analytics app built with the Autark toolkit.
//   1. autk-db loads OSM base layers for Manhattan Island (surface, parks,
//      water, roads, buildings) straight from the Overpass API.
//   2. autk-db loads the NYC 311 noise-complaint CSV as a spatial point table.
//   3. A spatial join counts how many noise events fall within 500 m of every
//      building (centroid-to-point NEAR predicate).
//   4. autk-map renders a 3D city where building color encodes that count.
//   5. Every layer is pickable — clicking a feature highlights it.
//
// All major steps are logged to the browser console.
// ─────────────────────────────────────────────────────────────────────────────

const statusEl = document.getElementById("status")!;
const loadingEl = document.getElementById("loading")!;
const hudEl = document.getElementById("hud")!;

const NOISE_RADIUS_METERS = 500;
// EPSG:3395 (World Mercator, meters) is used for both OSM and CSV so that the
// 500 m NEAR distance in the spatial join is expressed in real meters.
const COORDINATE_FORMAT = "EPSG:3395";
const NOISE_CSV_URL = `${window.location.origin}/data/noise.csv`;

function setStatus(msg: string) {
  statusEl.textContent = msg;
  console.log(`[status] ${msg}`);
}

async function main() {
  const t0 = performance.now();
  try {
    // ── 1. Initialize the in-browser spatial database ─────────────────────────
    setStatus("Initializing DuckDB-WASM spatial database…");
    const db = new SpatialDb();
    await db.init();
    console.log("Database initialized");

    // ── 2. Load OSM base layers for Manhattan Island ──────────────────────────
    setStatus("Loading OSM layers for Manhattan Island… (this can take a minute)");
    console.log("Loading OSM layers from Overpass API…");
    await db.loadOsmFromOverpassApi({
      // IMPORTANT: only 'Manhattan Island' keeps the data inside the island.
      queryArea: {
        geocodeArea: "New York",
        areas: ["Manhattan Island"],
      },
      outputTableName: "osm",
      autoLoadLayers: {
        coordinateFormat: COORDINATE_FORMAT,
        layers: ["surface", "parks", "water", "roads", "buildings"],
        dropOsmTable: true,
      },
      onProgress: (phase) => {
        console.log(`[OSM progress] ${phase}`);
        setStatus(`OSM: ${phase}`);
      },
    });
    console.log("OSM layers loaded successfully");

    for (const lt of db.getLayerTables()) {
      console.log(`Layer table ready: ${lt.name} (type: ${lt.type})`);
    }

    // ── 3. Load the NYC 311 noise-complaint CSV ───────────────────────────────
    setStatus("Loading noise-complaint CSV…");
    console.log(`Fetching noise CSV from ${NOISE_CSV_URL}`);
    const noiseTable = await db.loadCsv({
      csvFileUrl: NOISE_CSV_URL,
      outputTableName: "noise",
      geometryColumns: {
        latColumnName: "Latitude",
        longColumnName: "Longitude",
        coordinateFormat: COORDINATE_FORMAT,
      },
    });
    console.log(
      `Noise CSV loaded into table "${noiseTable.name}" ` +
        `(${noiseTable.columns?.length ?? "?"} columns)`
    );

    // ── 4. Spatial join: count noise events within 500 m of each building ─────
    setStatus(`Counting noise events within ${NOISE_RADIUS_METERS} m of each building…`);
    console.log("Spatial join started (buildings ⟵ noise, NEAR 500 m)…");
    await db.spatialJoin({
      tableRootName: "osm_buildings",
      tableJoinName: "noise",
      output: { type: "MODIFY_ROOT" },
      spatialPredicate: "NEAR",
      joinType: "LEFT",
      nearDistance: NOISE_RADIUS_METERS,
      nearUseCentroid: true,
      groupBy: {
        selectColumns: [
          {
            tableName: "noise",
            column: "Unique Key",
            aggregateFn: "count",
            aggregateFnResultColumnName: "noise_count",
            normalize: true,
          },
        ],
      },
    });
    console.log("Spatial join complete");

    // ── 5. Initialize the 3D map renderer ─────────────────────────────────────
    setStatus("Initializing 3D map renderer…");
    const canvas = document.getElementById("map-canvas") as HTMLCanvasElement;
    const map = new AutkMap(canvas, true);
    await map.init();
    console.log("Map renderer initialized (WebGPU)");

    // ── 6. Load every layer onto the map (draw order matters: bottom → top) ───
    setStatus("Loading layers onto the map…");
    const layerOrder: [string, LayerType][] = [
      ["surface", LayerType.AUTK_OSM_SURFACE],
      ["parks", LayerType.AUTK_OSM_PARKS],
      ["water", LayerType.AUTK_OSM_WATER],
      ["roads", LayerType.AUTK_OSM_ROADS],
      ["buildings", LayerType.AUTK_OSM_BUILDINGS],
    ];

    for (const [name, type] of layerOrder) {
      const geojson = await db.getLayer(`osm_${name}`);
      console.log(`Loading layer "${name}": ${geojson.features.length} features`);
      map.loadGeoJsonLayer(name, geojson, type);
    }
    console.log("All 5 layers loaded onto the map");

    // ── 7. Thematic coloring: building color ⟶ nearby noise count ─────────────
    setStatus("Applying noise thematic coloring to buildings…");
    const buildingsGeojson = await db.getLayer("osm_buildings");

    // Quick diagnostics: how many buildings actually have noise nearby?
    let matched = 0;
    let maxCount = 0;
    for (const f of buildingsGeojson.features) {
      const c =
        (f.properties as Record<string, unknown> | null)?.["sjoin"] != null
          ? ((f.properties!["sjoin"] as Record<string, Record<string, number>>)
              ?.count?.noise_count ?? 0)
          : 0;
      if (c > 0) matched++;
      if (c > maxCount) maxCount = c;
    }
    console.log(
      `Spatial join matched ${matched} / ${buildingsGeojson.features.length} ` +
        `buildings with ≥1 nearby noise event (max ${maxCount} within ${NOISE_RADIUS_METERS} m)`
    );

    map.updateRenderInfoProperty(
      "buildings",
      "colorMapInterpolator",
      ColorMapInterpolator.SEQUENTIAL_REDS
    );
    map.updateRenderInfoProperty("buildings", "isColorMap", true);
    map.updateRenderInfoProperty("buildings", "colorMapLabels", [
      "Fewer noise complaints",
      "More noise complaints",
    ]);

    // groupById=true so each building takes a single value (not face-by-face).
    map.updateGeoJsonLayerThematic(
      "buildings",
      buildingsGeojson,
      (feature: Feature) => {
        const sjoin = (feature.properties as Record<string, unknown> | null)?.[
          "sjoin"
        ] as Record<string, Record<string, number>> | undefined;
        return sjoin?.count?.noise_count_norm ?? 0;
      },
      true
    );
    console.log("Thematic coloring applied to buildings");

    // ── 8. Enable picking on every layer (highlights the clicked feature) ─────
    const pickableLayers = ["surface", "parks", "water", "roads", "buildings"];
    for (const layerName of pickableLayers) {
      map.updateRenderInfoProperty(layerName, "isPick", true);
      console.log(`Picking enabled for layer: ${layerName}`);
    }

    map.mapEvents.addEventListener(
      MapEvent.PICK,
      (selectedIds: number[], layerId: string) => {
        if (selectedIds.length > 0) {
          console.log(
            `[Pick] Layer "${layerId}" — highlighted component(s):`,
            selectedIds
          );
        } else {
          console.log(`[Pick] Cleared selection on layer "${layerId}"`);
        }
      }
    );
    console.log("Pick event listener registered for all layers");

    // ── 9. Start the render loop ──────────────────────────────────────────────
    map.draw(60);
    console.log("Scene rendered with 5 layers");

    // Reveal the map.
    loadingEl.classList.add("hidden");
    hudEl.classList.remove("hidden");
    setStatus("Ready");
    console.log(
      `Application ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`
    );
  } catch (err) {
    console.error("Application error:", err);
    setStatus(
      `Error: ${err instanceof Error ? err.message : String(err)} — see console.`
    );
  }
}

main();
