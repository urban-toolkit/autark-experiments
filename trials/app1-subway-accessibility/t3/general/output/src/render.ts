import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import type { LineFeature, OsmLayers, PolygonFeature } from "./types";

// Diverging-ish sequential ramp (blue -> teal -> yellow -> orange -> red).
const RAMP: [number, number, number][] = [
  [44, 123, 182],
  [127, 205, 187],
  [255, 255, 191],
  [253, 174, 97],
  [215, 25, 28],
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

/** Builds the MapLibre map plus the deck.gl overlay with all OSM layers. */
export function renderMap(layers: OsmLayers, maxCount: number): void {
  console.log("[render] Initializing renderer (MapLibre + deck.gl) ...");

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      // Land surface base layer (no external tiles required).
      sources: {},
      layers: [{ id: "surface", type: "background", paint: { "background-color": "#12151c" } }],
    },
    center: [-73.97, 40.776],
    zoom: 12.4,
    pitch: 52,
    bearing: -17.5,
    antialias: true,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  map.on("load", () => {
    console.log("[render] MapLibre base map loaded; attaching deck.gl overlay");

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: buildDeckLayers(layers, maxCount),
    });
    map.addControl(overlay as unknown as maplibregl.IControl);

    console.log(
      `[render] Scene rendered with 4 OSM layers (water, parks, roads, buildings); color domain 0–${maxCount} stations`
    );
  });
}

function buildDeckLayers(layers: OsmLayers, maxCount: number) {
  const denom = maxCount > 0 ? maxCount : 1;

  const water = new GeoJsonLayer<PolygonFeature["properties"]>({
    id: "water",
    data: layers.water as unknown as PolygonFeature[],
    filled: true,
    stroked: false,
    getFillColor: [38, 84, 124, 220],
    parameters: { depthTest: false },
  });

  const parks = new GeoJsonLayer<PolygonFeature["properties"]>({
    id: "parks",
    data: layers.parks as unknown as PolygonFeature[],
    filled: true,
    stroked: false,
    getFillColor: [40, 78, 53, 200],
    parameters: { depthTest: false },
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
    parameters: { depthTest: false },
  });

  const buildings = new GeoJsonLayer<PolygonFeature["properties"]>({
    id: "buildings",
    data: layers.buildings as unknown as PolygonFeature[],
    extruded: true,
    filled: true,
    wireframe: false,
    getElevation: (f: PolygonFeature) => f.properties.height ?? 8,
    getFillColor: (f: PolygonFeature) =>
      rampColor((f.properties.stationCount ?? 0) / denom),
    material: { ambient: 0.5, diffuse: 0.6, shininess: 24, specularColor: [40, 40, 40] },
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 90],
    onHover: handleHover,
  });

  return [water, parks, roads, buildings];
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}
