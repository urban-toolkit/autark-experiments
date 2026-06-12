// deck.gl rendering: five pickable layers (surface, water, parks, roads,
// buildings). Buildings are 3D-extruded and colored by nearby noise count.
// Clicking any element highlights it (its color changes) and shows details.

import { Deck, type PickingInfo, type Color } from "@deck.gl/core";
import { GeoJsonLayer } from "@deck.gl/layers";
import type { Feature, FeatureCollection } from "geojson";
import type { OsmLayers } from "./overpass";
import { colorForCount } from "./colors";

const HIGHLIGHT: Color = [80, 220, 255, 255]; // cyan for the selected element

interface RenderState {
  layers: OsmLayers;
  counts: number[];
  maxCount: number;
}

// Stable per-feature id, used to track the current selection.
function featureId(f: Feature, fallback: string): string {
  if (f.id != null) return String(f.id);
  if (f.properties && f.properties["@id"] != null) {
    return String(f.properties["@id"]);
  }
  return fallback;
}

function buildingElevation(f: Feature): number {
  const p = f.properties ?? {};
  const h = parseFloat(p["height"]);
  if (Number.isFinite(h)) return h;
  const levels = parseFloat(p["building:levels"]);
  if (Number.isFinite(levels)) return levels * 3.2;
  return 12; // default storey-ish height
}

export class MapView {
  private deck: Deck;
  private selectedId: string | null = null;
  private state: RenderState;
  private tooltip = document.getElementById("tooltip") as HTMLDivElement;
  private selrow = document.getElementById("selrow") as HTMLDivElement;

  constructor(state: RenderState) {
    this.state = state;

    // Annotate building features with their noise count + stable id so the
    // color accessor stays simple and survives layer recreation.
    state.layers.buildings.features.forEach((f, i) => {
      f.properties = f.properties ?? {};
      f.properties["_noise"] = state.counts[i] ?? 0;
      f.properties["_id"] = featureId(f, `building-${i}`);
    });

    console.log("[render] Initializing renderer (deck.gl)…");
    this.deck = new Deck({
      parent: document.getElementById("map") as HTMLDivElement,
      initialViewState: {
        longitude: -73.9712,
        latitude: 40.7831,
        zoom: 11.4,
        pitch: 50,
        bearing: 15,
      },
      controller: true,
      layers: this.buildLayers(),
      onClick: (info) => this.handleClick(info),
      onHover: (info) => this.handleHover(info),
      getCursor: ({ isHovering }) => (isHovering ? "pointer" : "grab"),
    });
    console.log("[render] Scene rendered with 5 layers.");
  }

  private isSelected(f: Feature, fallback: string): boolean {
    return this.selectedId != null && featureId(f, fallback) === this.selectedId;
  }

  private buildLayers() {
    const { layers, maxCount } = this.state;

    const surface = new GeoJsonLayer({
      id: "surface",
      data: layers.surface as FeatureCollection,
      pickable: true,
      stroked: false,
      filled: true,
      extruded: false,
      getFillColor: (f: Feature) =>
        this.isSelected(f, "surface")
          ? HIGHLIGHT
          : ([26, 30, 40, 255] as Color),
      updateTriggers: { getFillColor: this.selectedId },
    });

    const water = new GeoJsonLayer({
      id: "water",
      data: layers.water as FeatureCollection,
      pickable: true,
      stroked: false,
      filled: true,
      getFillColor: (f: Feature) =>
        this.isSelected(f, "water") ? HIGHLIGHT : ([33, 80, 120, 220] as Color),
      updateTriggers: { getFillColor: this.selectedId },
    });

    const parks = new GeoJsonLayer({
      id: "parks",
      data: layers.parks as FeatureCollection,
      pickable: true,
      stroked: false,
      filled: true,
      getFillColor: (f: Feature) =>
        this.isSelected(f, "parks") ? HIGHLIGHT : ([34, 78, 48, 235] as Color),
      updateTriggers: { getFillColor: this.selectedId },
    });

    const roads = new GeoJsonLayer({
      id: "roads",
      data: layers.roads as FeatureCollection,
      pickable: true,
      stroked: true,
      filled: false,
      lineWidthUnits: "pixels",
      getLineWidth: 1.4,
      lineWidthMinPixels: 1,
      getLineColor: (f: Feature) =>
        this.isSelected(f, "roads") ? HIGHLIGHT : ([90, 96, 110, 255] as Color),
      updateTriggers: { getLineColor: this.selectedId },
    });

    const buildings = new GeoJsonLayer({
      id: "buildings",
      data: layers.buildings as FeatureCollection,
      pickable: true,
      stroked: false,
      filled: true,
      extruded: true,
      wireframe: false,
      getElevation: (f: Feature) => buildingElevation(f),
      getFillColor: (f: Feature) => {
        const id = String(f.properties?.["_id"]);
        if (this.selectedId != null && id === this.selectedId) return HIGHLIGHT;
        const count = (f.properties?.["_noise"] as number) ?? 0;
        const [r, g, b] = colorForCount(count, maxCount);
        return [r, g, b, 255] as Color;
      },
      material: {
        ambient: 0.55,
        diffuse: 0.7,
        shininess: 32,
        specularColor: [40, 40, 40],
      },
      updateTriggers: { getFillColor: this.selectedId },
    });

    return [surface, water, parks, roads, buildings];
  }

  private refresh() {
    this.deck.setProps({ layers: this.buildLayers() });
  }

  private describe(layerId: string, f: Feature): string {
    const p = f.properties ?? {};
    switch (layerId) {
      case "buildings":
        return `Building${p["name"] ? ` · ${p["name"]}` : ""} — ${
          p["_noise"] ?? 0
        } noise complaints ≤500m`;
      case "roads":
        return `Road · ${p["name"] ?? p["highway"] ?? "street"}`;
      case "parks":
        return `Park · ${p["name"] ?? "green space"}`;
      case "water":
        return `Water · ${p["name"] ?? "waterbody"}`;
      case "surface":
        return `Surface · Manhattan Island`;
      default:
        return layerId;
    }
  }

  private handleClick(info: PickingInfo) {
    if (!info.object || !info.layer) {
      this.selectedId = null;
      this.selrow.textContent = "";
      console.log("[render] Selection cleared.");
      this.refresh();
      return;
    }
    const f = info.object as Feature;
    const layerId = info.layer.id;
    const id =
      layerId === "buildings"
        ? String(f.properties?.["_id"])
        : featureId(f, `${layerId}-${info.index}`);
    this.selectedId = id;
    const desc = this.describe(layerId, f);
    this.selrow.textContent = `Selected: ${desc}`;
    console.log(`[render] Picked ${layerId} (id=${id}): ${desc}`);
    this.refresh();
  }

  private handleHover(info: PickingInfo) {
    if (!info.object || !info.layer) {
      this.tooltip.style.display = "none";
      return;
    }
    const f = info.object as Feature;
    this.tooltip.style.display = "block";
    this.tooltip.style.left = `${info.x + 12}px`;
    this.tooltip.style.top = `${info.y + 12}px`;
    this.tooltip.textContent = this.describe(info.layer.id, f);
  }
}

export function renderMap(
  layers: OsmLayers,
  counts: number[],
  maxCount: number,
): MapView {
  return new MapView({ layers, counts, maxCount });
}
