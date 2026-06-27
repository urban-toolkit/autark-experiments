# Manhattan Buildings — Subway Accessibility (3D)

A **fully browser-side** (no backend) web application that renders a **3D map of
Manhattan buildings**, where each building is colored by the **number of subway
stations within a 500-meter radius** of its footprint.

Everything — fetching OpenStreetMap data, parsing the subway CSV, the spatial
join, and the 3D rendering — happens in the browser. There is no server-side
code: the only "server" is Vite's static dev/preview server.

![pipeline](https://img.shields.io/badge/pipeline-browser--side-blue)

---

## What it does

1. **Loads the subway stations** from `public/subway_manhattan_clean.csv`
   (NYC Open Data), parsing the `GTFS Latitude` / `GTFS Longitude` columns.
2. **Loads OpenStreetMap base layers** for Manhattan via the **Overpass API** —
   buildings, roads, parks and water — in a *single* combined query (to respect
   Overpass rate limits) scoped to the **Manhattan Island** administrative area.
   The result is cached in **IndexedDB**, so subsequent loads are instant and do
   not re-hit Overpass.
3. **Counts stations within 500 m** of every building footprint centroid using a
   uniform spatial grid (each building only checks its 9 neighbouring cells) and
   an equirectangular distance approximation.
4. **Renders a 3D map** with [MapLibre GL](https://maplibre.org/) +
   [deck.gl](https://deck.gl/): extruded buildings colored on a perceptually
   uniform **Viridis** ramp (dark purple = few nearby stations, bright yellow =
   many), plus water, parks, roads and subway-station markers.
5. Hovering a building shows its name, height, and station count; hovering a
   station shows its name and routes.

All major steps log progress to the **browser console** (`[main]`, `[subway]`,
`[overpass]`, `[spatial]`, `[render]` prefixes) so the full pipeline can be
traced and diagnosed from the console alone.

---

## Requirements

- **Node.js 18+** and **npm**
- A modern browser with WebGL2 (Chrome, Firefox, Edge, Safari)
- Internet access on first run (to reach the Overpass API). After the first
  successful load the OSM data is cached locally in IndexedDB.

---

## Run it

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server (http://localhost:3005)
npm run dev
```

Then open **http://localhost:3005** in your browser. The status line in the
top-left panel reports progress; open the developer console to watch the full
log. The very first load fetches Manhattan from Overpass (this can take 10–60 s
depending on mirror load); later loads read from the IndexedDB cache.

### Production build & preview

```bash
# Type-check + bundle into dist/
npm run build

# Serve the production build on http://localhost:3005
npm run preview
```

### Type-check only

```bash
npm run typecheck
```

---

## How it works (architecture)

```
public/subway_manhattan_clean.csv   NYC Open Data subway stations (input)

src/
  main.ts        Orchestrates the pipeline + status/legend UI
  subway.ts      Fetches & parses the subway CSV (quoted-field CSV parser)
  overpass.ts    Single combined Overpass query + IndexedDB cache + backoff
  spatial.ts     Grid-accelerated "stations within 500 m" count per building
  render.ts      MapLibre base map + deck.gl layers (3D extruded buildings)
  types.ts       Shared GeoJSON / domain types
```

### Notes & design decisions

- **One Overpass query, with backoff.** Buildings, roads, parks and water are
  fetched in a single request to minimise the chance of an HTTP 429. The fetch
  rotates across three public Overpass mirrors with exponential backoff and
  retries on 429/504.
- **Manhattan Island scope.** The query uses the Manhattan borough
  administrative area (`area(3608398124)`) so results stay on the island rather
  than spilling into a loose bounding box.
- **IndexedDB cache.** The converted layers are stored under the key
  `manhattan-osm-layers-v1`. To force a fresh fetch, clear the site's IndexedDB
  (DevTools → Application → IndexedDB → `manhattan-subway`) and reload.
- **500 m counting.** Distances are measured from each building's footprint
  centroid using an equirectangular approximation (sub-metre accurate at this
  scale and latitude). A ~500 m grid keeps the join near-linear.
- **Color encoding.** Building fill color maps `stationCount / max` through a
  Viridis ramp; the legend shows the `0 … mid … max` domain.

---

## Tech stack

- [Vite](https://vitejs.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [MapLibre GL JS](https://maplibre.org/) (base map / camera)
- [deck.gl](https://deck.gl/) `@deck.gl/mapbox`, `@deck.gl/layers`,
  `@deck.gl/core` (3D layers via `MapboxOverlay`)
- Data: [NYC Open Data](https://opendata.cityofnewyork.us/) (subway stations) +
  [OpenStreetMap](https://www.openstreetmap.org/) via the
  [Overpass API](https://overpass-api.de/)
