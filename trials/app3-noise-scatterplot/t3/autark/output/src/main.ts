import { SpatialDb } from "autk-db";
import { AutkMap, LayerType, MapEvent, ColorMapInterpolator } from "autk-map";
import { Scatterplot, PlotEvent } from "autk-plot";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

// ─────────────────────────────────────────────────────────────────────────────
// Manhattan Noisescape — Noise Pollution Impact on Buildings (+ linked scatter)
//
// A fully browser-side urban visual-analytics application built with Autark:
//
//   1. autk-db loads the OSM base layers for Manhattan Island (surface, parks,
//      water, roads, buildings) directly from the Overpass API.
//   2. autk-db loads the NYC 311 noise-complaint CSV as a spatial point table.
//   3. A spatial join (NEAR, 500 m) counts how many noise events fall within
//      500 m of every building.
//   4. autk-map renders a 3D city where building color encodes that count.
//   5. Every layer is pickable — clicking a feature changes its color.
//   6. autk-plot draws a linked scatterplot (x = noise complaints, y = building
//      footprint area). Brushing the scatterplot highlights the matching
//      buildings on the map.
//
// There is no backend: DuckDB-WASM runs the queries and WebGPU renders the map.
// All major operations are logged to the browser console.
// ─────────────────────────────────────────────────────────────────────────────

const statusEl = document.getElementById("status")!;
const loadingEl = document.getElementById("loading")!;
const hudEl = document.getElementById("hud")!;
const scatterPanelEl = document.getElementById("scatter-panel")!;
const scatterEl = document.getElementById("scatter")!;

// Distance threshold for the proximity join, in meters.
const NOISE_RADIUS_METERS = 500;

// EPSG:3395 (World Mercator, meters) is used for BOTH the OSM layers and the CSV
// points, so the 500 m NEAR distance in the spatial join is expressed in real
// meters (ST_Distance operates in the native units of the projection).
const COORDINATE_FORMAT = "EPSG:3395";

// The CSV is served as a static asset from /public/data/noise.csv.
const NOISE_CSV_URL = `${window.location.origin}/data/noise.csv`;

function setStatus(msg: string) {
  statusEl.textContent = msg;
  console.log(`[status] ${msg}`);
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

// Shoelace area of a single ring (EPSG:3395 planar meters²), always positive.
function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

// Polygon area = outer ring minus holes; MultiPolygon = sum of polygons.
// Returned in EPSG:3395 planar meters² (corrected to ground meters² by caller).
function footprintArea(geom: Geometry | null): number {
  if (!geom) return 0;
  if (geom.type === "Polygon") {
    const rings = geom.coordinates;
    if (!rings.length) return 0;
    let a = ringArea(rings[0] as Position[]);
    for (let i = 1; i < rings.length; i++) a -= ringArea(rings[i] as Position[]);
    return Math.max(a, 0);
  }
  if (geom.type === "MultiPolygon") {
    let total = 0;
    for (const poly of geom.coordinates) {
      if (!poly.length) continue;
      let a = ringArea(poly[0] as Position[]);
      for (let i = 1; i < poly.length; i++) a -= ringArea(poly[i] as Position[]);
      total += Math.max(a, 0);
    }
    return total;
  }
  return 0;
}

// Read the aggregated noise count produced by the spatial join.
function noiseCountOf(feature: Feature): number {
  const sjoin = (feature.properties as Record<string, unknown> | null)?.[
    "sjoin"
  ] as Record<string, Record<string, number>> | undefined;
  return sjoin?.count?.noise_count ?? 0;
}

async function main() {
  const t0 = performance.now();
  try {
    // ── 1. Initialize the in-browser spatial database ─────────────────────────
    setStatus("Initializing DuckDB-WASM spatial database…");
    console.log("Initializing autk-db (DuckDB-WASM)…");
    const db = new SpatialDb();
    await db.init();
    console.log("Database initialized");

    // ── 2. Load OSM base layers for Manhattan Island ──────────────────────────
    setStatus("Loading OSM layers for Manhattan Island… (this can take a minute)");
    console.log("Loading OSM layers from the Overpass API…");
    await db.loadOsmFromOverpassApi({
      // IMPORTANT: only 'Manhattan Island' keeps the data clipped to the island
      // (broader areas like 'Manhattan' or 'New York' would leak off-island).
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

    // Geographic extent (lon/lat) — used to correct the World-Mercator areas.
    const osmBbox = db.getOsmBoundingBox();
    const centerLatDeg = osmBbox ? (osmBbox[1] + osmBbox[3]) / 2 : 40.78;
    // World Mercator inflates area by 1/cos²(lat). Multiply back to ground m².
    const areaCorrection = Math.cos((centerLatDeg * Math.PI) / 180) ** 2;
    console.log(
      `OSM bounding box (lon/lat): ${
        osmBbox ? osmBbox.map((v) => v.toFixed(4)).join(", ") : "n/a"
      } — area correction factor ${areaCorrection.toFixed(4)}`
    );

    // ── 3. Load the NYC 311 noise-complaint CSV as a spatial point table ───────
    setStatus("Loading noise-complaint CSV…");
    console.log(`Fetching noise CSV from ${NOISE_CSV_URL}`);
    const noiseTable = await db.loadCsv({
      csvFileUrl: NOISE_CSV_URL,
      outputTableName: "noise",
      // Build a geoPoint geometry column from the lat/long columns so the table
      // can take part in the spatial join. Project to the same CRS as the OSM
      // layers so distances are comparable.
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
    setStatus(
      `Counting noise events within ${NOISE_RADIUS_METERS} m of each building…`
    );
    console.log(
      `Spatial join started (osm_buildings ⟵ noise, NEAR ${NOISE_RADIUS_METERS} m)…`
    );
    await db.spatialJoin({
      tableRootName: "osm_buildings",
      tableJoinName: "noise",
      output: { type: "MODIFY_ROOT" },
      spatialPredicate: "NEAR",
      joinType: "LEFT",
      nearDistance: NOISE_RADIUS_METERS,
      // Measure from each building centroid to each noise point.
      nearUseCentroid: true,
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
    console.log("Spatial join complete");

    // ── 5. Initialize the 3D map renderer (WebGPU) ────────────────────────────
    setStatus("Initializing 3D map renderer…");
    console.log("Initializing autk-map (WebGPU)…");
    const canvas = document.getElementById("map-canvas") as HTMLCanvasElement;
    const map = new AutkMap(canvas, true);
    await map.init();
    console.log("Map renderer initialized");

    // ── 6. Load every layer onto the map (draw order: bottom → top) ───────────
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

    // ── 7. Build the per-building analytics table ─────────────────────────────
    // One row per building: noise count (within 500 m) + footprint area (m²).
    // We dedupe by building_id and stamp flat numeric properties so the SAME
    // FeatureCollection drives both the map thematic coloring and the scatter
    // plot, guaranteeing that scatter point i ↔ map building component i.
    setStatus("Preparing per-building noise / area analytics…");
    const rawBuildings = await db.getLayer("osm_buildings");

    const seen = new Set<string>();
    const buildingFeatures: Feature[] = [];
    for (const f of rawBuildings.features) {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const bid = String(props["building_id"] ?? buildingFeatures.length);
      if (seen.has(bid)) continue; // keep first occurrence (matches groupById)
      seen.add(bid);

      const noiseCount = noiseCountOf(f);
      const areaM2 = footprintArea(f.geometry) * areaCorrection;

      f.properties = {
        ...props,
        building_id: bid,
        _idx: buildingFeatures.length,
        noise_count: noiseCount,
        area_m2: Math.round(areaM2),
      };
      buildingFeatures.push(f);
    }

    const buildingsFC: FeatureCollection = {
      type: "FeatureCollection",
      bbox: rawBuildings.bbox,
      features: buildingFeatures,
    };

    let matched = 0;
    let maxCount = 0;
    for (const f of buildingFeatures) {
      const c = f.properties!["noise_count"] as number;
      if (c > 0) matched++;
      if (c > maxCount) maxCount = c;
    }
    console.log(
      `Per-building analytics ready: ${buildingFeatures.length} buildings, ` +
        `${matched} with ≥1 nearby noise event (max ${maxCount} within ` +
        `${NOISE_RADIUS_METERS} m)`
    );

    // ── 8. Thematic coloring: building color ⟶ nearby noise count ─────────────
    setStatus("Applying noise thematic coloring to buildings…");
    map.updateRenderInfoProperty(
      "buildings",
      "colorMapInterpolator",
      ColorMapInterpolator.SEQUENTIAL_REDS
    );
    map.updateRenderInfoProperty("buildings", "isColorMap", true);

    // Re-applies the persistent noise coloring (also used to clear a brush).
    function applyNoiseColoring() {
      map.updateGeoJsonLayerThematic(
        "buildings",
        buildingsFC,
        (feature: Feature) => (feature.properties!["noise_count"] as number) ?? 0,
        true // groupById — one value per building
      );
      map.updateRenderInfoProperty("buildings", "colorMapLabels", [
        "Fewer noise complaints",
        "More noise complaints",
      ]);
    }
    applyNoiseColoring();
    console.log("Thematic coloring applied to buildings");

    // ── 9. Enable picking on every layer (color changes on click) ─────────────
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
    console.log("Pick event listener registered for all 5 layers");

    // ── 10. Linked scatterplot (autk-plot): noise vs. building area ───────────
    setStatus("Building linked scatterplot…");
    const scatter = new Scatterplot({
      div: scatterEl,
      data: buildingsFC, // properties carry noise_count (x) and area_m2 (y)
      events: [PlotEvent.BRUSH], // enable the 2D rectangular brush
      labels: {
        axis: ["noise_count", "area_m2"],
        title: "Noise complaints (500 m) vs. building footprint area",
      },
      width: 420,
      height: 300,
      margins: { left: 64, right: 14, top: 16, bottom: 44 },
    });
    console.log(
      `Scatterplot rendered with ${buildingFeatures.length} building points`
    );

    // Chart → Map: brushing highlights the matching buildings on the map.
    // Brushed buildings are pushed to the top of the color ramp; releasing the
    // brush (empty selection) restores the persistent noise coloring.
    scatter.plotEvents.addEventListener(
      PlotEvent.BRUSH,
      (selectedIds: number[]) => {
        if (selectedIds.length === 0) {
          console.log("[Brush] Cleared — restoring noise coloring");
          applyNoiseColoring();
          return;
        }
        const selected = new Set(selectedIds);
        console.log(
          `[Brush] ${selectedIds.length} building(s) selected — highlighting on map`
        );
        map.updateGeoJsonLayerThematic(
          "buildings",
          buildingsFC,
          (feature: Feature) =>
            selected.has(feature.properties!["_idx"] as number) ? 1 : 0,
          true
        );
        map.updateRenderInfoProperty("buildings", "colorMapLabels", [
          "Not selected",
          "Brushed",
        ]);
      }
    );
    console.log("Brush → map highlight link registered");

    // ── 11. Start the render loop ─────────────────────────────────────────────
    map.draw(60);
    console.log("Scene rendered with 5 layers");

    // Reveal the map + linked views.
    loadingEl.classList.add("hidden");
    hudEl.classList.remove("hidden");
    scatterPanelEl.classList.remove("hidden");
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
