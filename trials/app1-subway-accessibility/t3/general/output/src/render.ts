import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import type { Feature, Geometry } from "geojson";
import type {
  LineFeature,
  OsmLayers,
  PolygonFeature,
  SubwayStation,
} from "./types";

// deck.gl's GeoJsonLayer always widens the feature geometry to the generic
// `Geometry`, so accessors are typed against that rather than our narrowed
// Polygon/LineString features (we only read `.properties`).
type BuildingProps = PolygonFeature["properties"];
type BuildingFeature = Feature<Geometry, BuildingProps>;

// Viridis colour ramp (perceptually uniform): low station counts are dark
// purple/blue, high counts are bright green/yellow.
const RAMP: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

function rampColor(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (RAMP.length - 1);
  const i = Math.floor(scaled);
  if (i >= RAMP.length - 1) return RAMP[RAMP.length - 1];
  const f = scaled - i;
  const a = RAMP[i];
  const b = RAMP[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

const TOOLTIP = document.getElementById("tooltip") as HTMLDivElement;

/** Builds the MapLibre base map plus the deck.gl overlay with every OSM layer. */
export function renderMap(
  layers: OsmLayers,
  stations: SubwayStation[],
  maxCount: number
): void {
  console.log("[render] Initializing renderer (MapLibre + deck.gl) ...");

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      // Flat surface base layer — no external tile dependency.
      sources: {},
      layers: [
        { id: "surface", type: "background", paint: { "background-color": "#12151c" } },
      ],
    },
    center: [-73.97, 40.776],
    zoom: 12.4,
    pitch: 52,
    bearing: -17.5,
    antialias: true,
  });

  map.addControl(
    new maplibregl.NavigationControl({ visualizePitch: true }),
    "top-right"
  );

  map.on("load", () => {
    console.log("[render] MapLibre base map loaded; attaching deck.gl overlay");

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: buildDeckLayers(layers, stations, maxCount),
    });
    map.addControl(overlay as unknown as maplibregl.IControl);

    console.log(
      `[render] Scene rendered with 5 layers (water, parks, roads, buildings, stations); color domain 0–${maxCount} stations`
    );
  });
}

function buildDeckLayers(
  layers: OsmLayers,
  stations: SubwayStation[],
  maxCount: number
) {
  const denom = maxCount > 0 ? maxCount : 1;

  const water = new GeoJsonLayer<BuildingProps>({
    id: "water",
    data: layers.water as unknown as PolygonFeature[],
    filled: true,
    stroked: false,
    getFillColor: [38, 84, 124, 220],
  });

  const parks = new GeoJsonLayer<BuildingProps>({
    id: "parks",
    data: layers.parks as unknown as PolygonFeature[],
    filled: true,
    stroked: false,
    getFillColor: [40, 78, 53, 200],
  });

  const roads = new GeoJsonLayer<LineFeature["properties"]>({
    id: "roads",
    data: layers.roads as unknown as LineFeature[],
    stroked: true,
    filled: false,
    getLineColor: [70, 76, 88, 180],
    getLineWidth: 2,
    lineWidthMinPixels: 1,
    lineWidthMaxPixels: 4,
  });

  const buildings = new GeoJsonLayer<BuildingProps>({
    id: "buildings",
    data: layers.buildings as unknown as PolygonFeature[],
    extruded: true,
    filled: true,
    wireframe: false,
    getElevation: (f: BuildingFeature) => f.properties.height ?? 8,
    getFillColor: (f: BuildingFeature) =>
      rampColor((f.properties.stationCount ?? 0) / denom),
    material: {
      ambient: 0.5,
      diffuse: 0.6,
      shininess: 24,
      specularColor: [40, 40, 40],
    },
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 90],
    onHover: handleHover,
  });

  // Subway stations as small reference markers above the buildings.
  const stationLayer = new ScatterplotLayer<SubwayStation>({
    id: "stations",
    data: stations,
    getPosition: (s: SubwayStation) => [s.lon, s.lat],
    getFillColor: [255, 255, 255, 230],
    getLineColor: [10, 10, 10, 255],
    stroked: true,
    lineWidthMinPixels: 1,
    getRadius: 30,
    radiusMinPixels: 2,
    radiusMaxPixels: 6,
    pickable: true,
    onHover: handleStationHover,
  });

  return [water, parks, roads, buildings, stationLayer];
}

function handleHover(info: PickingInfo): void {
  const feature = info.object as PolygonFeature | undefined;
  if (!feature || feature.properties.kind !== "building") {
    TOOLTIP.style.display = "none";
    return;
  }
  const p = feature.properties;
  TOOLTIP.style.display = "block";
  TOOLTIP.style.left = `${info.x + 12}px`;
  TOOLTIP.style.top = `${info.y + 12}px`;
  TOOLTIP.innerHTML =
    `<strong>${p.name ? escapeHtml(p.name) : "Building"}</strong><br/>` +
    `Subway stations within 500 m: <strong>${p.stationCount ?? 0}</strong><br/>` +
    `Height: ${(p.height ?? 8).toFixed(0)} m`;
}

function handleStationHover(info: PickingInfo): void {
  const s = info.object as SubwayStation | undefined;
  if (!s) {
    TOOLTIP.style.display = "none";
    return;
  }
  TOOLTIP.style.display = "block";
  TOOLTIP.style.left = `${info.x + 12}px`;
  TOOLTIP.style.top = `${info.y + 12}px`;
  TOOLTIP.innerHTML =
    `<strong>${escapeHtml(s.name)}</strong><br/>` +
    `Routes: ${s.routes ? escapeHtml(s.routes) : "—"}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}
