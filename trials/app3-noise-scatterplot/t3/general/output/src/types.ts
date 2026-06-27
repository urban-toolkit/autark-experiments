// Shared types for the Manhattan Noisescape application.

/** A single 311 noise complaint parsed from the NYC Open Data CSV. */
export interface NoiseEvent {
  /** Complaint type, e.g. "Noise - Residential". */
  type: string;
  /** Creation timestamp as recorded in the CSV (kept as raw text). */
  created: string;
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
    /** Noise events within 500 m of the footprint centroid (buildings only). */
    noiseCount?: number;
    /** Footprint area in square metres (buildings only). */
    area?: number;
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
