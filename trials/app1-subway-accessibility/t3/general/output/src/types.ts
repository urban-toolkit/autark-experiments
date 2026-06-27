// Shared types for the Manhattan subway-accessibility application.

/** A single subway station parsed from the NYC Open Data CSV. */
export interface SubwayStation {
  name: string;
  routes: string;
  lon: number;
  lat: number;
}

/** GeoJSON-style polygon feature used for buildings, parks and water. */
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

/** The four OSM base layers we fetch and render. */
export interface OsmLayers {
  buildings: FeatureCollection<PolygonFeature>;
  parks: FeatureCollection<PolygonFeature>;
  water: FeatureCollection<PolygonFeature>;
  roads: FeatureCollection<LineFeature>;
}
