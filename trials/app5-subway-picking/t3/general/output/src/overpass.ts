import type {
  FeatureCollection,
  LineFeature,
  OsmLayers,
  PolygonFeature,
} from "./types";

// Manhattan borough administrative relation 8398124 -> Overpass area id
// (3600000000 + relation id). Querying by this area keeps results inside the
// island boundary rather than a loose bounding box.
const MANHATTAN_AREA_ID = 3608398124;

// Public Overpass mirrors, tried in rotation with exponential backoff so a
// single overloaded server (429/504) does not sink the whole load.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const CACHE_KEY = "manhattan-subway-osm-layers-v1";

/**
 * One combined Overpass query for every base layer. A single request is the
 * most reliable way to stay under the Overpass rate limit. `out geom;` inlines
 * each way's node coordinates so we never resolve node references ourselves.
 */
function buildQuery(): string {
  return `[out:json][timeout:240];
area(${MANHATTAN_AREA_ID})->.man;
(
  way["building"](area.man);
  way["highway"]["highway"!~"^(footway|path|steps|cycleway|corridor|elevator|construction|proposed)$"](area.man);
  way["leisure"="park"](area.man);
  way["landuse"~"^(grass|recreation_ground|cemetery|forest|meadow)$"](area.man);
  way["natural"~"^(water|wood|scrub)$"](area.man);
  way["waterway"="riverbank"](area.man);
);
out geom;`;
}

interface OverpassNode {
  lat: number;
  lon: number;
}
interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: OverpassNode[];
}

/**
 * Returns the Manhattan OSM base layers — served from the IndexedDB cache when
 * present, otherwise fetched from Overpass once and cached for next time.
 */
export async function loadOsmLayers(
  onStatus: (msg: string) => void
): Promise<OsmLayers> {
  console.log("[overpass] Loading OSM layers for Manhattan...");

  const cached = await readCache();
  if (cached) {
    console.log("[overpass] OSM layers restored from IndexedDB cache");
    onStatus("Loaded OSM layers from local cache");
    logLayerCounts(cached);
    return cached;
  }

  console.log("[overpass] No cache present — fetching from Overpass API...");
  const raw = await fetchOverpass(onStatus);
  const layers = convertElements(raw.elements ?? []);
  logLayerCounts(layers);

  try {
    await writeCache(layers);
    console.log("[overpass] OSM layers cached in IndexedDB for next load");
  } catch (err) {
    console.warn("[overpass] Could not cache OSM layers:", err);
  }
  return layers;
}

async function fetchOverpass(
  onStatus: (msg: string) => void
): Promise<{ elements: OverpassElement[] }> {
  const body = "data=" + encodeURIComponent(buildQuery());
  let lastErr: unknown;

  // Two full passes over the mirror list, backing off between attempts.
  const maxAttempts = OVERPASS_ENDPOINTS.length * 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      console.log(
        `[overpass] Fetching Overpass API (attempt ${attempt + 1}/${maxAttempts}) via ${endpoint}`
      );
      onStatus("Querying OpenStreetMap (Overpass)…");
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (res.status === 429 || res.status === 504) {
        throw new Error(`Overpass busy (HTTP ${res.status})`);
      }
      if (!res.ok) {
        throw new Error(`Overpass error (HTTP ${res.status})`);
      }
      const text = await res.text();
      console.log(
        `[overpass] Overpass response received: ${(text.length / 1_048_576).toFixed(2)} MB`
      );
      const json = JSON.parse(text) as { elements: OverpassElement[] };
      console.log(`[overpass] Parsed ${json.elements.length} OSM elements`);
      return json;
    } catch (err) {
      lastErr = err;
      const waitMs = Math.min(2000 * 2 ** attempt, 20000);
      console.warn(
        `[overpass] Attempt ${attempt + 1} failed: ${(err as Error).message}. Retrying in ${waitMs} ms`
      );
      onStatus(`Overpass busy — retrying in ${Math.round(waitMs / 1000)}s…`);
      await sleep(waitMs);
    }
  }
  throw new Error(
    `All Overpass mirrors failed: ${(lastErr as Error)?.message ?? "unknown error"}`
  );
}

/** Splits raw Overpass elements into typed GeoJSON FeatureCollections. */
function convertElements(elements: OverpassElement[]): OsmLayers {
  const buildings: PolygonFeature[] = [];
  const parks: PolygonFeature[] = [];
  const water: PolygonFeature[] = [];
  const roads: LineFeature[] = [];

  // Track the bounding box of everything so we can synthesise a ground surface.
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const grow = (coords: number[][]): void => {
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  };

  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const coords = el.geometry.map((n) => [n.lon, n.lat]);
    grow(coords);

    // Roads stay as open polylines.
    if (tags.highway) {
      roads.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: { id: el.id, kind: "road", highway: tags.highway },
      });
      continue;
    }

    // Everything else is an area; close its ring if Overpass left it open.
    const ring = closeRing(coords);
    if (ring.length < 4) continue;

    if (tags.building) {
      buildings.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {
          id: el.id,
          kind: "building",
          name: tags.name,
          height: parseHeight(tags),
          stationCount: 0,
        },
      });
    } else if (tags.natural === "water" || tags.waterway === "riverbank") {
      water.push(polygon(el.id, ring, "water", tags.name));
    } else {
      parks.push(polygon(el.id, ring, "park", tags.name));
    }
  }

  const surface = buildSurface(minLon, minLat, maxLon, maxLat);

  return {
    surface: collection(surface ? [surface] : []),
    buildings: collection(buildings),
    parks: collection(parks),
    water: collection(water),
    roads: collection(roads),
  };
}

/**
 * Synthesises the "surface" base layer: a single ground polygon spanning the
 * (slightly padded) bounding box of all OSM features. It sits beneath every
 * other layer and, like the rest, is selectable.
 */
function buildSurface(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number
): PolygonFeature | null {
  if (!Number.isFinite(minLon) || !Number.isFinite(maxLat)) return null;
  const padLon = (maxLon - minLon) * 0.02;
  const padLat = (maxLat - minLat) * 0.02;
  const x0 = minLon - padLon;
  const y0 = minLat - padLat;
  const x1 = maxLon + padLon;
  const y1 = maxLat + padLat;
  const ring = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { id: 0, kind: "surface", name: "Manhattan surface" },
  };
}

function polygon(
  id: number,
  ring: number[][],
  kind: "park" | "water",
  name?: string
): PolygonFeature {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { id, kind, name },
  };
}

function collection<F>(features: F[]): FeatureCollection<F> {
  return { type: "FeatureCollection", features };
}

function closeRing(coords: number[][]): number[][] {
  if (coords.length === 0) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...coords, first];
  }
  return coords;
}

/** Derives a building extrusion height (metres) from OSM tags. */
function parseHeight(tags: Record<string, string>): number {
  if (tags.height) {
    const h = parseFloat(tags.height);
    if (Number.isFinite(h) && h > 0) return h;
  }
  if (tags["building:levels"]) {
    const levels = parseFloat(tags["building:levels"]);
    if (Number.isFinite(levels) && levels > 0) return levels * 3.2;
  }
  return 8; // sensible default for a low-rise structure
}

function logLayerCounts(layers: OsmLayers): void {
  console.log(`[overpass] OSM surface: ${layers.surface.features.length} feature`);
  console.log(`[overpass] OSM buildings loaded: ${layers.buildings.features.length} features`);
  console.log(`[overpass] OSM roads loaded: ${layers.roads.features.length} features`);
  console.log(`[overpass] OSM parks loaded: ${layers.parks.features.length} features`);
  console.log(`[overpass] OSM water loaded: ${layers.water.features.length} features`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Minimal IndexedDB key/value cache (avoids re-hammering Overpass) -------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("manhattan-subway", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readCache(): Promise<OsmLayers | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get(CACHE_KEY);
      req.onsuccess = () => resolve((req.result as OsmLayers) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeCache(layers: OsmLayers): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(layers, CACHE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
