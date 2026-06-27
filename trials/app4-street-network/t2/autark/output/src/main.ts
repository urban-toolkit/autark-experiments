import { SpatialDb } from "autk-db";
import { AutkMap, LayerType, ColorMapInterpolator, MapEvent } from "autk-map";
import { GeojsonCompute } from "autk-compute";
import type { Feature, Position } from "geojson";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Radius (meters, EPSG:3395) used to count noise events around each road. */
const NOISE_RADIUS_METERS = 10;

/** Static noise CSV served from /public/data/noise.csv. */
const NOISE_CSV_URL = `${window.location.origin}/data/noise.csv`;

/** OSM layers loaded for Manhattan Island and their map render types. */
const OSM_LAYERS: ReadonlyArray<{ table: string; type: LayerType }> = [
  { table: "osm_surface", type: LayerType.AUTK_OSM_SURFACE },
  { table: "osm_parks", type: LayerType.AUTK_OSM_PARKS },
  { table: "osm_water", type: LayerType.AUTK_OSM_WATER },
  { table: "osm_roads", type: LayerType.AUTK_OSM_ROADS },
];

type ColorMode = "length" | "noise";

// ─────────────────────────────────────────────────────────────────────────────
// Small UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function setPhase(text: string): void {
  const el = document.getElementById("phase");
  if (el) el.textContent = text;
  console.log(`[phase] ${text}`);
}

function hideLoading(): void {
  const loading = document.getElementById("loading");
  if (loading) loading.style.display = "none";
  const panel = document.getElementById("panel");
  if (panel) panel.style.display = "block";
}

/** Read a road's noise-event count produced by the spatial join. */
function noiseCount(feature: Feature): number {
  const sjoin = feature.properties?.sjoin as
    | { count?: { noise_count?: number } }
    | undefined;
  return sjoin?.count?.noise_count ?? 0;
}

/** Read a road's segment length produced by the GPU compute pass. */
function segmentLength(feature: Feature): number {
  const compute = feature.properties?.compute as
    | { segment_length?: number }
    | undefined;
  return compute?.segment_length ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Manhattan Street Network — booting ===");
  const canvas = document.getElementById("map-canvas") as HTMLCanvasElement;

  // ── 1. Spatial database ────────────────────────────────────────────────────
  setPhase("Initializing spatial database…");
  const db = new SpatialDb();
  await db.init();
  console.log("SpatialDb initialized");

  // ── 2. GPU compute engine ──────────────────────────────────────────────────
  const gpuCompute = new GeojsonCompute();
  console.log("GeojsonCompute initialized");

  // ── 3. Load OSM base layers for Manhattan Island ───────────────────────────
  setPhase("Loading OSM layers for Manhattan Island…");
  console.log("Fetching Overpass API for Manhattan Island (surface, parks, water, roads)…");
  await db.loadOsmFromOverpassApi({
    queryArea: {
      geocodeArea: "New York",
      areas: ["Manhattan Island"],
    },
    outputTableName: "osm",
    autoLoadLayers: {
      coordinateFormat: "EPSG:3395",
      layers: ["surface", "parks", "water", "roads"],
      dropOsmTable: true,
    },
    onProgress: (phase: string) => {
      setPhase(`OSM: ${phase}`);
      console.log(`Overpass progress: ${phase}`);
    },
  });
  console.log("OSM data loaded; tables:", db.getLayerTables().map((l) => l.name));

  // ── 4. Load noise CSV as a spatial point table ─────────────────────────────
  setPhase("Loading noise events (CSV)…");
  console.log(`Fetching noise CSV from ${NOISE_CSV_URL}`);
  const noiseTable = await db.loadCsv({
    csvFileUrl: NOISE_CSV_URL,
    outputTableName: "noise",
    geometryColumns: {
      latColumnName: "Latitude",
      longColumnName: "Longitude",
      coordinateFormat: "EPSG:3395",
    },
  });
  console.log(
    `Noise CSV loaded into table "${noiseTable.name}" ` +
      `(${noiseTable.columns?.length ?? "?"} columns)`
  );

  // ── 5. Spatial join: count noise events within 10 m of each road segment ───
  setPhase(`Counting noise events within ${NOISE_RADIUS_METERS} m of each road…`);
  console.log(
    `Spatial join started (osm_roads ⟵ noise, NEAR ${NOISE_RADIUS_METERS} m)…`
  );
  await db.spatialJoin({
    tableRootName: "osm_roads",
    tableJoinName: "noise",
    output: { type: "MODIFY_ROOT" },
    spatialPredicate: "NEAR",
    nearDistance: NOISE_RADIUS_METERS,
    joinType: "LEFT",
    groupBy: {
      selectColumns: [
        {
          tableName: "noise",
          column: "Unique Key",
          aggregateFn: "count",
          aggregateFnResultColumnName: "noise_count",
        },
      ],
    },
  });
  console.log("Spatial join complete — noise counts written to osm_roads");

  // ── 6. Retrieve roads (now carrying noise counts) ──────────────────────────
  setPhase("Preparing road geometry for the GPU…");
  const roads = await db.getLayer("osm_roads");
  console.log(`Roads retrieved: ${roads.features.length} segments`);

  // ── 7. Pack each segment's geometry into a per-feature coordinate matrix ────
  //     The geometry itself is uploaded to the GPU (cols = [x, y], rows = vertex
  //     count) and the length is computed there — see the WGSL shader below.
  let maxVertices = 0;
  for (const feature of roads.features) {
    const ring = flattenLineCoords(feature);
    if (!feature.properties) feature.properties = {};
    feature.properties.coords = ring; // number[][] → matrix rows × 2
    maxVertices = Math.max(maxVertices, ring.length);
  }
  console.log(
    `Geometry packed for GPU: ${roads.features.length} segments, ` +
      `max ${maxVertices} vertices/segment`
  );

  // ── 8. Compute segment lengths on the GPU using a WGSL shader ──────────────
  setPhase("Computing road lengths on the GPU…");
  console.log("Dispatching length shader to the GPU (one workgroup per segment)…");
  const roadsComputed = await gpuCompute.computeFunctionIntoProperties({
    geojson: roads,
    // The master variable list maps WGSL name → feature property path.
    attributes: { coords: "properties.coords" },
    attributeMatrices: {
      // rows: 'auto' → vertex count is inferred per feature at runtime.
      coords: { rows: "auto", cols: 2 },
    },
    outputColumnName: "segment_length",
    wglsFunction: `
      // Sum the Euclidean distance between consecutive vertices of the polyline.
      // coords is a flat row-major array (rows × cols); coords_rows is the
      // number of vertices, coords_cols is 2 (x, y). Units are meters (EPSG:3395).
      var total: f32 = 0.0;
      for (var i: u32 = 1u; i < coords_rows; i = i + 1u) {
        let x0 = coords[(i - 1u) * coords_cols + 0u];
        let y0 = coords[(i - 1u) * coords_cols + 1u];
        let x1 = coords[i * coords_cols + 0u];
        let y1 = coords[i * coords_cols + 1u];
        let dx = x1 - x0;
        let dy = y1 - y0;
        total = total + sqrt(dx * dx + dy * dy);
      }
      return total;
    `,
  });
  console.log("GPU length computation complete");

  // Drop the bulky coords arrays now that lengths are computed.
  for (const feature of roadsComputed.features) {
    if (feature.properties) delete feature.properties.coords;
  }

  // ── 9. Compute data ranges for legends and diagnostics ─────────────────────
  const maxLength = roadsComputed.features.reduce(
    (m, f) => Math.max(m, segmentLength(f)),
    0
  );
  const maxNoise = roadsComputed.features.reduce(
    (m, f) => Math.max(m, noiseCount(f)),
    0
  );
  const roadsWithNoise = roadsComputed.features.filter((f) => noiseCount(f) > 0).length;
  console.log(
    `Length range: 0–${maxLength.toFixed(1)} m | ` +
      `Noise range: 0–${maxNoise} events | ` +
      `${roadsWithNoise}/${roadsComputed.features.length} segments have ≥1 nearby noise event`
  );

  // ── 10. Initialize the renderer ────────────────────────────────────────────
  setPhase("Initializing renderer…");
  const map = new AutkMap(canvas);
  await map.init();
  console.log("AutkMap initialized");

  // ── 11. Load all OSM layers onto the map ───────────────────────────────────
  setPhase("Loading layers onto the map…");
  for (const { table, type } of OSM_LAYERS) {
    const geojson = table === "osm_roads" ? roadsComputed : await db.getLayer(table);
    map.loadGeoJsonLayer(table, geojson, type);
    console.log(`Layer "${table}" loaded (${geojson.features.length} features)`);
  }
  console.log(`Scene assembled with ${OSM_LAYERS.length} layers`);

  // ── 12. Thematic coloring + length/noise toggle ────────────────────────────
  const legendTitle = document.getElementById("legend-title")!;
  const legendBar = document.getElementById("legend-bar")!;
  const legendMin = document.getElementById("legend-min")!;
  const legendMax = document.getElementById("legend-max")!;
  const btnLength = document.getElementById("btn-length") as HTMLButtonElement;
  const btnNoise = document.getElementById("btn-noise") as HTMLButtonElement;

  function applyColoring(mode: ColorMode): void {
    if (mode === "length") {
      map.updateRenderInfoProperty(
        "osm_roads",
        "colorMapInterpolator",
        ColorMapInterpolator.SEQUENTIAL_BLUES
      );
      map.updateRenderInfoProperty("osm_roads", "isColorMap", true);
      map.updateRenderInfoProperty("osm_roads", "colorMapLabels", [
        "0 m",
        `${maxLength.toFixed(0)} m`,
      ]);
      map.updateGeoJsonLayerThematic("osm_roads", roadsComputed, segmentLength);

      legendTitle.textContent = "Segment length";
      legendBar.style.background =
        "linear-gradient(90deg, #deebf7, #3182bd, #08306b)";
      legendMin.textContent = "0 m";
      legendMax.textContent = `${maxLength.toFixed(0)} m`;
    } else {
      map.updateRenderInfoProperty(
        "osm_roads",
        "colorMapInterpolator",
        ColorMapInterpolator.SEQUENTIAL_REDS
      );
      map.updateRenderInfoProperty("osm_roads", "isColorMap", true);
      map.updateRenderInfoProperty("osm_roads", "colorMapLabels", [
        "0",
        `${maxNoise}`,
      ]);
      map.updateGeoJsonLayerThematic("osm_roads", roadsComputed, noiseCount);

      legendTitle.textContent = `Noise events (≤ ${NOISE_RADIUS_METERS} m)`;
      legendBar.style.background =
        "linear-gradient(90deg, #fee0d2, #de2d26, #67000d)";
      legendMin.textContent = "0";
      legendMax.textContent = `${maxNoise}`;
    }
    btnLength.classList.toggle("active", mode === "length");
    btnNoise.classList.toggle("active", mode === "noise");
    console.log(`Coloring roads by ${mode}`);
  }

  btnLength.addEventListener("click", () => applyColoring("length"));
  btnNoise.addEventListener("click", () => applyColoring("noise"));
  applyColoring("length"); // default

  // ── 13. Enable click-to-select picking on every layer ──────────────────────
  for (const { table } of OSM_LAYERS) {
    map.updateRenderInfoProperty(table, "isPick", true);
  }
  map.mapEvents.addEventListener(
    MapEvent.PICK,
    (selectedIds: number[], layerId: string) => {
      if (selectedIds.length === 0) {
        console.log(`[pick] cleared selection on "${layerId}"`);
      } else {
        console.log(`[pick] selected ${selectedIds.length} feature(s) on "${layerId}":`, selectedIds);
      }
    }
  );
  console.log("Picking enabled on all layers");

  // ── 14. Start rendering ────────────────────────────────────────────────────
  map.draw();
  hideLoading();
  setPhase("Done");
  console.log("=== Application ready ===");
}

/**
 * Flatten a (Multi)LineString feature into a list of [x, y] vertices in
 * EPSG:3395 meters, ready to be uploaded to the GPU as a matrix.
 */
function flattenLineCoords(feature: Feature): number[][] {
  const geom = feature.geometry;
  const out: number[][] = [];
  if (geom.type === "LineString") {
    for (const c of geom.coordinates) out.push([c[0], c[1]]);
  } else if (geom.type === "MultiLineString") {
    for (const line of geom.coordinates) {
      for (const c of line as Position[]) out.push([c[0], c[1]]);
    }
  }
  return out;
}

main().catch((err) => {
  console.error("Fatal application error:", err);
  setPhase(`Error: ${err instanceof Error ? err.message : String(err)}`);
});
