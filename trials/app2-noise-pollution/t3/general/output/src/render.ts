import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import type { Feature, Geometry } from "geojson";
import type { LineFeature, OsmLayers, PolygonFeature } from "./types";

// deck.gl's GeoJsonLayer always widens the feature geometry to the generic
// `Geometry`, so accessors are typed against that rather than our narrowed
// Polygon/LineString features (we only read `.properties`).
type PolyProps = PolygonFeature["properties"];
type LineProps = LineFeature["properties"];
type PolyFeature = Feature<Geometry, PolyProps>;
type LineFeatureG = Feature<Geometry, LineProps>;

// Inferno-style colour ramp (perceptually uniform): few nearby noise events are
// dark purple, many are bright orange/yellow.
const RAMP: [number, number, number][] = [
  [12, 7, 35],
  [84, 15, 109],
  [165, 44, 96],
  [231, 99, 49],
  [252, 200, 70],
];

// Colour applied to any element the user has clicked (picked).
const SELECT_COLOR: [number, number, number] = [0, 229, 255];

const BASE = {
  surface: [26, 30, 38] as [number, number, number],
  water: [38, 84, 124] as [number, number, number],
  parks: [40, 86, 53] as [number, number, number],
  roads: [90, 96, 108] as [number, number, number],
};

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
export function renderMap(layers: OsmLayers, maxCount: number): void {
  console.log("[render] Initializing renderer (MapLibre + deck.gl) ...");

  // Per-layer set of selected feature ids. A click toggles membership; the
  // colour accessors below paint any selected element with SELECT_COLOR.
  const selection = new Map<string, Set<number>>();
  let version = 0;
  let overlay: MapboxOverlay | null = null;

  const isSelected = (layerId: string, id: number): boolean =>
    selection.get(layerId)?.has(id) ?? false;

  function toggle(layerId: string, id: number): void {
    let set = selection.get(layerId);
    if (!set) {
      set = new Set<number>();
      selection.set(layerId, set);
    }
    if (set.has(id)) set.delete(id);
    else set.add(id);
    version++;
    console.log(
      `[render] Picked ${layerId} feature #${id} (${set.has(id) ? "selected" : "deselected"}); ${totalSelected()} element(s) selected`
    );
    overlay?.setProps({ layers: buildDeckLayers() });
  }

  function totalSelected(): number {
    let n = 0;
    for (const s of selection.values()) n += s.size;
    return n;
  }

  function buildDeckLayers() {
    const denom = maxCount > 0 ? maxCount : 1;

    const surface = new GeoJsonLayer<PolyProps>({
      id: "surface",
      data: layers.surface as unknown as PolygonFeature[],
      filled: true,
      stroked: false,
      extruded: false,
      getFillColor: (f: PolyFeature) =>
        isSelected("surface", f.properties.id)
          ? [...SELECT_COLOR, 255]
          : [...BASE.surface, 255],
      pickable: true,
      onClick: (info: PickingInfo) => onClick("surface", info),
      onHover: (info: PickingInfo) => onHover("surface", info),
      updateTriggers: { getFillColor: version },
    });

    const water = new GeoJsonLayer<PolyProps>({
      id: "water",
      data: layers.water as unknown as PolygonFeature[],
      filled: true,
      stroked: false,
      getFillColor: (f: PolyFeature) =>
        isSelected("water", f.properties.id)
          ? [...SELECT_COLOR, 230]
          : [...BASE.water, 220],
      pickable: true,
      onClick: (info: PickingInfo) => onClick("water", info),
      onHover: (info: PickingInfo) => onHover("water", info),
      updateTriggers: { getFillColor: version },
    });

    const parks = new GeoJsonLayer<PolyProps>({
      id: "parks",
      data: layers.parks as unknown as PolygonFeature[],
      filled: true,
      stroked: false,
      getFillColor: (f: PolyFeature) =>
        isSelected("parks", f.properties.id)
          ? [...SELECT_COLOR, 230]
          : [...BASE.parks, 200],
      pickable: true,
      onClick: (info: PickingInfo) => onClick("parks", info),
      onHover: (info: PickingInfo) => onHover("parks", info),
      updateTriggers: { getFillColor: version },
    });

    const roads = new GeoJsonLayer<LineProps>({
      id: "roads",
      data: layers.roads as unknown as LineFeature[],
      stroked: true,
      filled: false,
      getLineColor: (f: LineFeatureG) =>
        isSelected("roads", f.properties.id)
          ? [...SELECT_COLOR, 255]
          : [...BASE.roads, 180],
      getLineWidth: (f: LineFeatureG) => (isSelected("roads", f.properties.id) ? 6 : 2),
      lineWidthMinPixels: 1,
      lineWidthMaxPixels: 6,
      pickable: true,
      onClick: (info: PickingInfo) => onClick("roads", info),
      onHover: (info: PickingInfo) => onHover("roads", info),
      updateTriggers: { getLineColor: version, getLineWidth: version },
    });

    const buildings = new GeoJsonLayer<PolyProps>({
      id: "buildings",
      data: layers.buildings as unknown as PolygonFeature[],
      extruded: true,
      filled: true,
      wireframe: false,
      getElevation: (f: PolyFeature) => f.properties.height ?? 8,
      getFillColor: (f: PolyFeature) =>
        isSelected("buildings", f.properties.id)
          ? SELECT_COLOR
          : rampColor((f.properties.noiseCount ?? 0) / denom),
      material: {
        ambient: 0.5,
        diffuse: 0.6,
        shininess: 24,
        specularColor: [40, 40, 40],
      },
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 70],
      onClick: (info: PickingInfo) => onClick("buildings", info),
      onHover: (info: PickingInfo) => onHover("buildings", info),
      updateTriggers: { getFillColor: version },
    });

    // Order = draw order: surface (bottom) → water → parks → roads → buildings.
    return [surface, water, parks, roads, buildings];
  }

  function onClick(layerId: string, info: PickingInfo): void {
    const props = (info.object as Feature | undefined)?.properties as
      | { id?: number }
      | undefined;
    if (!props || typeof props.id !== "number") return;
    toggle(layerId, props.id);
  }

  function onHover(layerId: string, info: PickingInfo): void {
    const feature = info.object as Feature | undefined;
    if (!feature) {
      TOOLTIP.style.display = "none";
      return;
    }
    TOOLTIP.style.display = "block";
    TOOLTIP.style.left = `${info.x + 12}px`;
    TOOLTIP.style.top = `${info.y + 12}px`;
    TOOLTIP.innerHTML = tooltipHtml(layerId, feature.properties as Record<string, unknown>);
  }

  function tooltipHtml(layerId: string, p: Record<string, unknown>): string {
    const name = typeof p.name === "string" && p.name ? escapeHtml(p.name) : null;
    if (layerId === "buildings") {
      const count = (p.noiseCount as number) ?? 0;
      const height = (p.height as number) ?? 8;
      return (
        `<strong>${name ?? "Building"}</strong><br/>` +
        `Noise events within 500 m: <strong>${count}</strong><br/>` +
        `Height: ${height.toFixed(0)} m<br/>` +
        `<em>click to select</em>`
      );
    }
    if (layerId === "roads") {
      return (
        `<strong>${name ?? "Road"}</strong><br/>` +
        `Type: ${escapeHtml(String(p.highway ?? "road"))}<br/>` +
        `<em>click to select</em>`
      );
    }
    const label = layerId.charAt(0).toUpperCase() + layerId.slice(1);
    return `<strong>${name ?? label}</strong><br/><em>click to select</em>`;
  }

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0b0e14" } },
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
    overlay = new MapboxOverlay({
      interleaved: true,
      layers: buildDeckLayers(),
    });
    map.addControl(overlay as unknown as maplibregl.IControl);
    console.log(
      `[render] Scene rendered with 5 layers (surface, water, parks, roads, buildings); color domain 0–${maxCount} noise events`
    );
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}
