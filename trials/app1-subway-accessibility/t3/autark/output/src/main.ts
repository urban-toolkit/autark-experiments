import { SpatialDb } from "autk-db";
import { AutkMap, LayerType, ColorMapInterpolator } from "autk-map";
import type { Feature } from "geojson";

// ── UI helpers ───────────────────────────────────────────────────────────────

function setPhase(text: string): void {
  const el = document.getElementById("phase");
  if (el) el.textContent = text;
  console.log(`[Phase] ${text}`);
}

function setStat(id: string, value: string | number): void {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function showError(message: string): void {
  const el = document.getElementById("error");
  if (el) {
    el.textContent = `Error: ${message}`;
    el.style.display = "block";
  }
}

/**
 * Reads the per-building subway-station count produced by the spatial join.
 * With `groupBy` aggregation the value lives under `properties.sjoin.count`,
 * but we also fall back to a flat property for robustness. Buildings with no
 * nearby station resolve to 0 (COUNT ignores the NULLs from the LEFT join).
 */
function subwayCount(feature: Feature): number {
  const props = (feature.properties ?? {}) as Record<string, any>;
  const val =
    props?.["sjoin"]?.["count"]?.["subway_count"] ??
    props["subway_count"] ??
    0;
  return typeof val === "number" ? val : Number(val) || 0;
}

// ── Main application ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const canvas = document.getElementById("map-canvas") as HTMLCanvasElement;

  // ── 1. Initialize the browser-side spatial database (DuckDB-WASM) ─────────
  setPhase("Initializing spatial database…");
  console.log("Initializing SpatialDb (DuckDB-WASM)…");
  const db = new SpatialDb();
  await db.init();
  console.log("SpatialDb initialized");

  // ── 2. Load OSM base layers for Manhattan Island ─────────────────────────
  setPhase("Fetching OpenStreetMap data for Manhattan Island…");
  console.log("Loading OSM layers (surface, parks, water, roads, buildings)…");
  console.log("Fetching Overpass API for area: Manhattan Island…");

  await db.loadOsmFromOverpassApi({
    queryArea: {
      geocodeArea: "New York",
      areas: ["Manhattan Island"],
    },
    outputTableName: "osm",
    autoLoadLayers: {
      coordinateFormat: "EPSG:3395",
      layers: ["surface", "parks", "water", "roads", "buildings"],
      dropOsmTable: true,
    },
    onProgress: (phase: string) => {
      const label = phase.replace(/-/g, " ");
      setPhase(`OSM: ${label}`);
      console.log(`Overpass progress: ${phase}`);
    },
  });

  const layerTables = db.getLayerTables();
  console.log(
    `OSM layers loaded: ${layerTables.length} layers — ${layerTables
      .map((l) => l.name)
      .join(", ")}`
  );

  // ── 3. Load subway station data from the CSV ─────────────────────────────
  // Served from /public; build an absolute URL so DuckDB-WASM's worker can
  // resolve it regardless of the port (dev / preview).
  const csvUrl = `${window.location.origin}/subway_manhattan_clean.csv`;
  setPhase("Loading subway station data…");
  console.log(`Loading subway CSV from ${csvUrl}`);

  await db.loadCsv({
    csvFileUrl: csvUrl,
    outputTableName: "subway_stations",
    delimiter: ",",
    geometryColumns: {
      latColumnName: "latitude",
      longColumnName: "longitude",
      coordinateFormat: "EPSG:3395",
    },
  });

  const stationRows = await db.getTableData({ tableName: "subway_stations" });
  console.log(`Subway stations loaded: ${stationRows.length} stations`);

  // ── 4. Spatial join: count subway stations within 500 m of each building ──
  setPhase("Counting subway stations within 500 m of each building…");
  console.log(
    "Spatial join started: buildings ⟕ subway_stations (NEAR, 500 m, centroid)…"
  );

  await db.spatialJoin({
    tableRootName: "osm_buildings",
    tableJoinName: "subway_stations",
    output: { type: "MODIFY_ROOT" },
    spatialPredicate: "NEAR",
    joinType: "LEFT",
    nearDistance: 500, // meters (EPSG:3395)
    nearUseCentroid: true, // building centroid → station distance
    groupBy: {
      selectColumns: [
        {
          tableName: "subway_stations",
          column: "key",
          aggregateFn: "count",
          aggregateFnResultColumnName: "subway_count",
        },
      ],
    },
  });

  console.log("Spatial join complete: buildings enriched with subway_count");

  // ── 5. Retrieve the enriched buildings layer and compute statistics ──────
  const buildingsGeojson = await db.getLayer("osm_buildings");
  console.log(`OSM buildings loaded: ${buildingsGeojson.features.length} features`);

  const counts = buildingsGeojson.features.map(subwayCount);
  const maxCount = counts.length ? Math.max(...counts) : 0;
  const avgCount = counts.length
    ? counts.reduce((a, b) => a + b, 0) / counts.length
    : 0;
  const withAccess = counts.filter((c) => c > 0).length;

  console.log(
    `Spatial join stats — buildings: ${buildingsGeojson.features.length}, ` +
      `with ≥1 station in 500 m: ${withAccess}, max: ${maxCount}, avg: ${avgCount.toFixed(2)}`
  );

  setStat("stat-buildings", buildingsGeojson.features.length.toLocaleString());
  setStat("stat-stations", stationRows.length);
  setStat("stat-max", maxCount);
  setStat("stat-avg", avgCount.toFixed(2));

  // ── 6. Initialize the WebGPU map renderer ────────────────────────────────
  setPhase("Initializing 3D renderer…");
  console.log("Initializing renderer (AutkMap / WebGPU)…");
  const map = new AutkMap(canvas);
  await map.init();
  console.log("AutkMap initialized");

  // ── 7. Load all OSM layers onto the map ──────────────────────────────────
  setPhase("Loading map layers…");
  const layerTypeMap: Record<string, LayerType> = {
    osm_surface: LayerType.AUTK_OSM_SURFACE,
    osm_parks: LayerType.AUTK_OSM_PARKS,
    osm_water: LayerType.AUTK_OSM_WATER,
    osm_roads: LayerType.AUTK_OSM_ROADS,
    osm_buildings: LayerType.AUTK_OSM_BUILDINGS,
  };

  for (const layer of layerTables) {
    // Reuse the already-fetched enriched buildings GeoJSON.
    const geojson =
      layer.name === "osm_buildings"
        ? buildingsGeojson
        : await db.getLayer(layer.name);
    const type = layerTypeMap[layer.name] ?? (layer.type as LayerType);
    map.loadGeoJsonLayer(layer.name, geojson, type);
    console.log(`Layer "${layer.name}" loaded: ${geojson.features.length} features`);
  }
  console.log(`Scene composed with ${layerTables.length} layers`);

  // ── 8. Thematic coloring of buildings by subway-station proximity ────────
  setPhase("Applying subway accessibility coloring…");
  console.log("Applying thematic coloring by subway station count…");

  map.updateRenderInfoProperty(
    "osm_buildings",
    "colorMapInterpolator",
    ColorMapInterpolator.SEQUENTIAL_REDS
  );
  map.updateRenderInfoProperty("osm_buildings", "isColorMap", true);
  map.updateRenderInfoProperty("osm_buildings", "colorMapLabels", [
    "0 stations",
    `${maxCount} stations`,
  ]);

  // groupById=true → each building colored by its single value (not per face).
  map.updateGeoJsonLayerThematic(
    "osm_buildings",
    buildingsGeojson,
    subwayCount,
    true
  );
  console.log("Thematic coloring applied to buildings");

  // ── 9. Start the render loop ─────────────────────────────────────────────
  map.draw();
  console.log("Render loop started (60 fps)");

  // ── 10. Reveal UI overlays, hide the loading screen ──────────────────────
  const loadingEl = document.getElementById("loading");
  if (loadingEl) loadingEl.style.display = "none";
  for (const id of ["legend", "stats"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "block";
  }
  const legendMax = document.getElementById("legend-max");
  if (legendMax) legendMax.textContent = String(maxCount);

  setPhase("Done");
  console.log("Application fully loaded and rendering");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Application error:", err);
  setPhase(`Error: ${msg}`);
  showError(msg);
});
