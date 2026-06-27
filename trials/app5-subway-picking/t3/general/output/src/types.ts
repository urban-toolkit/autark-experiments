// Shared types for the Manhattan subway-accessibility (pickable) application.

/** A single subway station parsed from the NYC Open Data CSV. */
export interface SubwayStation {
  name: string;
  routes: string;
  lon: number;
  lat: number;
}

/** Layers that participate in picking. */
export type LayerKind = "surface" | "building" | "park" | "water" | "road";

/** GeoJSON-style polygon feature used for surface, buildings, parks and water. */
export interface PolygonFeature {
  type: "Feature";
  geometry: {
    type: "Polygon";
    coordinates: number[][][]; // [ring][vertex][lon, lat]
  };
  properties: {
    id: number;
    kind: Exclude<LayerKind, "road">;
    name?: string;
    /** Extrusion height in metres (buildings only). */
    height?: number;
    /** Subway stations within 500 m of the footprint centroid (buildings only). */
    stationCount?: number;
  };
}

/** GeoJSON-style line feature used for roads. */
export interface LineFeature {
  type: "Feature";
  geometry: {
    type: "LineString";
    coordinates: number[][]; // [vertex][lon, lat]
  };
  properties: {
    id: number;
    kind: "road";
    highway?: string;
  };
}

export interface FeatureCollection<F> {
  type: "FeatureCollection";
  features: F[];
}

/** The five OSM-derived base layers we render. */
export interface OsmLayers {
  /** Single ground polygon (the Manhattan land surface, derived from the data bbox). */
  surface: FeatureCollection<PolygonFeature>;
  buildings: FeatureCollection<PolygonFeature>;
  parks: FeatureCollection<PolygonFeature>;
  water: FeatureCollection<PolygonFeature>;
  roads: FeatureCollection<LineFeature>;
}
