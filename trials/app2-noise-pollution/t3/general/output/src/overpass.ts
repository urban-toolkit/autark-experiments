// Fetches all OSM base layers for Manhattan Island in a SINGLE Overpass query
// (to stay well under the rate limit), converts it to GeoJSON, and splits the
// result into the five thematic layers the app renders. Responses are cached
// in IndexedDB so reloads never re-hit the API.

import osmtogeojson from "osmtogeojson";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  GeoJsonProperties,
} from "geojson";
import { cacheGet, cacheSet } from "./cache";

// Mirror endpoints, tried in order on failure. (Browser fetch automatically
// sends an Origin + real User-Agent, which these servers' anti-scraping rules
// require — so genuine in-browser requests are accepted.)
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// One union query: buildings, water, parks, major roads, and the island
// surface multipolygon. `area["name"="Manhattan Island"]` keeps us strictly on
// the island as required (no NJ / Brooklyn / Queens overspill).
const QUERY = `
[out:json][timeout:300];
area["name"="Manhattan Island"]->.a;
(
  way["building"](area.a);
  relation["building"](area.a);
  way["natural"="water"](area.a);
  relation["natural"="water"](area.a);
  way["leisure"="park"](area.a);
  relation["leisure"="park"](area.a);
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](area.a);
  relation["place"="island"]["name"="Manhattan Island"];
);
out geom;
`.trim();

const CACHE_KEY = "overpass:manhattan-island:v3";

export interface OsmLayers {
  surface: FeatureCollection;
  water: FeatureCollection;
  parks: FeatureCollection;
  roads: FeatureCollection;
  buildings: FeatureCollection;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchFromOverpass(): Promise<unknown> {
  let attempt = 0;
  for (const endpoint of ENDPOINTS) {
    for (let retry = 0; retry < 2; retry++) {
      attempt++;
      try {
        console.log(
          `[overpass] Fetching Overpass API (attempt ${attempt}) via ${endpoint} …`,
        );
        const t0 = performance.now();
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: QUERY,
        });
        if (res.status === 429 || res.status === 504) {
          const backoff = 4000 * (retry + 1);
          console.warn(
            `[overpass] HTTP ${res.status} (rate limited / overloaded). Backing off ${backoff}ms…`,
          );
          await sleep(backoff);
          continue;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const text = await res.text();
        const mb = (text.length / 1024 / 1024).toFixed(2);
        console.log(
          `[overpass] Overpass response received: ${mb} MB in ${(
            (performance.now() - t0) /
            1000
          ).toFixed(1)}s`,
        );
        return JSON.parse(text);
      } catch (err) {
        console.warn(`[overpass] attempt ${attempt} failed:`, err);
        await sleep(2000);
      }
    }
  }
  throw new Error("All Overpass endpoints failed after retries.");
}

function emptyFC(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function isPolygonal(g: Geometry | null): boolean {
  return !!g && (g.type === "Polygon" || g.type === "MultiPolygon");
}

function isLineal(g: Geometry | null): boolean {
  return !!g && (g.type === "LineString" || g.type === "MultiLineString");
}

function splitLayers(geojson: FeatureCollection): OsmLayers {
  const layers: OsmLayers = {
    surface: emptyFC(),
    water: emptyFC(),
    parks: emptyFC(),
    roads: emptyFC(),
    buildings: emptyFC(),
  };

  for (const f of geojson.features as Feature<Geometry, GeoJsonProperties>[]) {
    const p = f.properties ?? {};
    const g = f.geometry;
    if (p["place"] === "island" && isPolygonal(g)) {
      layers.surface.features.push(f);
    } else if (p["building"] && isPolygonal(g)) {
      layers.buildings.features.push(f);
    } else if (p["natural"] === "water" && isPolygonal(g)) {
      layers.water.features.push(f);
    } else if (p["leisure"] === "park" && isPolygonal(g)) {
      layers.parks.features.push(f);
    } else if (p["highway"] && isLineal(g)) {
      layers.roads.features.push(f);
    }
  }
  return layers;
}

export async function loadOsmLayers(): Promise<OsmLayers> {
  console.log("[overpass] Loading OSM layers for Manhattan Island…");

  let raw = await cacheGet<unknown>(CACHE_KEY);
  if (raw) {
    console.log("[overpass] Using cached Overpass response (IndexedDB).");
  } else {
    raw = await fetchFromOverpass();
    await cacheSet(CACHE_KEY, raw);
    console.log("[overpass] Cached Overpass response to IndexedDB.");
  }

  console.log("[overpass] Converting OSM → GeoJSON…");
  const geojson = osmtogeojson(raw) as FeatureCollection;
  console.log(`[overpass] GeoJSON features: ${geojson.features.length}`);

  const layers = splitLayers(geojson);
  console.log(
    `[overpass] OSM layers split → buildings: ${layers.buildings.features.length}, ` +
      `roads: ${layers.roads.features.length}, water: ${layers.water.features.length}, ` +
      `parks: ${layers.parks.features.length}, surface polygons: ${layers.surface.features.length}`,
  );
  return layers;
}
