// Shared types for the Manhattan subway-accessibility application.

export interface SubwayStation {
  name: string;
  routes: string;
  lon: number;
  lat: number;
}

/** A GeoJSON-style polygon feature for buildings, parks and water bodies. */
export interface PolygonFeature {
  type: "Feature";
  geometry: {
    type: "Polygon";
    coordinates: number[][][]; // [ring][vertex][lon, lat]
  };
  properties: {
    id: number;
    kind: "building" | "park" | "water";
    name?: string;
    /** Extrusion height in metres (buildings only). */
    height?: number;
    /** Subway stations within 500 m of the footprint centroid (buildings only). */
    stationCount?: number;
  };
}

/** A GeoJSON-style line feature for roads. */
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

export interface OsmLayers {
  buildings: FeatureCollection<PolygonFeature>;
  parks: FeatureCollection<PolygonFeature>;
  water: FeatureCollection<PolygonFeature>;
  roads: FeatureCollection<LineFeature>;
}
