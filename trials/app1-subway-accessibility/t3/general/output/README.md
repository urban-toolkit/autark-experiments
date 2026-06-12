# Manhattan — Subway Accessibility (3D Map)

A **fully browser-side** web application (no backend) that renders a **3D map of
Manhattan buildings**, where each building is colored by the **number of subway
stations within a 500-meter radius** of its footprint.

![Stations within 500 m: blue (few) → red (many)](https://img.shields.io/badge/legend-0%E2%86%92max%20stations-blue?style=flat-square)

---

## What it does

1. **Loads OpenStreetMap base layers for Manhattan** (surface, parks, water,
   roads, buildings) from the **Overpass API** in a single combined query,
   scoped to the Manhattan borough boundary (`area 3608398124`). The response is
   cached in **IndexedDB** so subsequent loads are instant and don't re-hit
   Overpass.
2. **Loads subway-station data** from `public/subway_manhattan_clean.csv`
   (NYC Open Data, MTA subway stations), parsed entirely in the browser.
3. **Counts, for every building, how many subway stations fall within 500 m** of
   the building-footprint centroid. Stations are bucketed into a ~500 m spatial
   grid so each building only tests nearby stations (equirectangular distance).
4. **Renders a 3D map** with [MapLibre GL JS](https://maplibre.org/) +
   [deck.gl](https://deck.gl/): buildings are extruded by their OSM height and
   colored by station proximity (blue = few, red = many). Hover a building for
   its name, station count and height.
5. Every major step is logged to the **browser console** (data loading, Overpass
   request/response sizes, the spatial join, and rendering milestones).

---

## Requirements

- **Node.js ≥ 18** and **npm**
- A modern browser with WebGL2 (Chrome, Edge, Firefox, Safari)
- Internet access on first run (to query the Overpass API; cached afterwards)

---

## Run it

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server (http://localhost:3005)
npm run dev
```

Then open **http://localhost:3005** in your browser and open the developer
console (F12) to follow the progress logs. The first load fetches Manhattan from
Overpass (this can take 30–90 s depending on Overpass load and is cached
afterward — watch the status box in the top-left and the console).

### Production build

```bash
npm run build      # type-checks (tsc --noEmit) then builds with Vite
npm run preview    # serves the production build on http://localhost:3005
```

---

## How it works (architecture)

```
public/subway_manhattan_clean.csv ──► src/subway.ts   (CSV → stations[])
Overpass API  ───────────────────────► src/overpass.ts (OSM → GeoJSON layers, IndexedDB cache)
                                              │
                       stations[] + layers ──► src/spatial.ts (500 m count per building)
                                              │
                                   layers ───► src/render.ts (MapLibre + deck.gl 3D scene)
                                              │
                                        src/main.ts (orchestration + status/legend)
```

| File | Responsibility |
| --- | --- |
| `src/main.ts` | Orchestrates the pipeline and updates the status/legend UI. |
| `src/subway.ts` | Fetches and parses the subway-station CSV. |
| `src/overpass.ts` | Builds the combined Overpass query, fetches with multi-mirror retry + exponential backoff, converts elements to GeoJSON, caches in IndexedDB. |
| `src/spatial.ts` | Grid-accelerated "stations within 500 m" count per building. |
| `src/render.ts` | MapLibre base map + deck.gl `GeoJsonLayer`s (water, parks, roads, extruded/colored buildings) + hover tooltip. |
| `src/types.ts` | Shared TypeScript types. |

### Overpass / rate-limit handling

- A **single** combined query fetches buildings, roads, parks and water to
  minimize the number of requests.
- Results are **cached in IndexedDB** (`manhattan-osm-layers-v1`); clearing site
  data forces a re-fetch.
- On HTTP **429/504** or network failure, the app rotates through several
  Overpass mirrors with **exponential backoff** (2s → 20s).

### Color encoding

Buildings use a sequential ramp over `[0 … max]` stations within 500 m:

```
0 ──────────────────────────────► max
blue → teal → yellow → orange → red
```

The legend in the top-left shows the live `0 / mid / max` domain.

---

## Data sources

- **Buildings / roads / parks / water:** © OpenStreetMap contributors (ODbL),
  via the [Overpass API](https://overpass-api.de/).
- **Subway stations:** [NYC Open Data](https://opendata.cityofnewyork.us/) — MTA
  subway stations (`subway_manhattan_clean.csv`, included in `public/`).

---

## Troubleshooting

- **"Overpass busy — retrying…" for a long time:** the public Overpass servers
  are occasionally overloaded. The app retries across mirrors automatically;
  just wait, or reload to retry. Once a successful response is cached, reloads
  are instant.
- **Blank map but no errors:** make sure WebGL2 is enabled in your browser.
- **Force a fresh OSM fetch:** clear the site's IndexedDB (DevTools → Application
  → IndexedDB → `manhattan-subway`).
