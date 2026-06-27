import type { Feature, FeatureCollection, LineString, Polygon, MultiPolygon } from 'geojson';
import type {
  ManhattanLayers,
  RoadProperties,
  AreaProperties,
  RoadCollection,
  AreaCollection,
} from './types';

// osmtogeojson handles the messy Overpass JSON -> GeoJSON conversion,
// including stitching multipolygon relations (parks/water) together.
import osmtogeojson from 'osmtogeojson';

/**
 * Splits the raw Overpass response into the four map layers required by the
 * task: roads (LineString), parks, water and surface (landuse) polygons.
 */
export function parseOsmData(osmData: unknown): ManhattanLayers {
  console.log('Parsing OSM data to GeoJSON layers...');

  const geojson = osmtogeojson(osmData) as FeatureCollection;
  console.log(`osmtogeojson produced ${geojson.features.length} features`);

  const roads: Feature<LineString, RoadProperties>[] = [];
  const parks: Feature<Polygon | MultiPolygon, AreaProperties>[] = [];
  const water: Feature<Polygon | MultiPolygon, AreaProperties>[] = [];
  const surface: Feature<Polygon | MultiPolygon, AreaProperties>[] = [];

  let idCounter = 1;

  for (const feature of geojson.features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const geomType = feature.geometry?.type;

    if (props['highway'] && geomType === 'LineString') {
      const id = idCounter++;
      roads.push({
        type: 'Feature',
        id,
        geometry: feature.geometry as LineString,
        properties: {
          id,
          name: props['name'] as string | undefined,
          highway: props['highway'] as string | undefined,
        },
      });
    } else if (props['leisure'] === 'park' && (geomType === 'Polygon' || geomType === 'MultiPolygon')) {
      const id = idCounter++;
      parks.push({
        type: 'Feature',
        id,
        geometry: feature.geometry as Polygon | MultiPolygon,
        properties: { id, name: props['name'] as string | undefined },
      });
    } else if (props['natural'] === 'water' && (geomType === 'Polygon' || geomType === 'MultiPolygon')) {
      const id = idCounter++;
      water.push({
        type: 'Feature',
        id,
        geometry: feature.geometry as Polygon | MultiPolygon,
        properties: { id, name: props['name'] as string | undefined },
      });
    } else if (props['landuse'] && (geomType === 'Polygon' || geomType === 'MultiPolygon')) {
      const id = idCounter++;
      surface.push({
        type: 'Feature',
        id,
        geometry: feature.geometry as Polygon | MultiPolygon,
        properties: {
          id,
          name: props['name'] as string | undefined,
          landuse: props['landuse'] as string | undefined,
        },
      });
    }
  }

  console.log(
    `Parsed layers — Roads: ${roads.length}, Parks: ${parks.length}, Water: ${water.length}, Surface: ${surface.length}`
  );

  return {
    roads: { type: 'FeatureCollection', features: roads } as RoadCollection,
    parks: { type: 'FeatureCollection', features: parks } as AreaCollection,
    water: { type: 'FeatureCollection', features: water } as AreaCollection,
    surface: { type: 'FeatureCollection', features: surface } as AreaCollection,
  };
}
