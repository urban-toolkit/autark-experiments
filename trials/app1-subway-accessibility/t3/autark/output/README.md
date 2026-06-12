# Manhattan Buildings — Subway Accessibility 3D Map

A fully **browser-side** (no backend) web application that renders a **3D map of
Manhattan buildings**, where each building is colored by the **number of subway
stations within a 500‑meter radius**. Data loading, the spatial analysis, and
the WebGPU rendering all run in the browser, built entirely with the
[**Autark**](https://github.com/urban-toolkit/autark/) toolkit.

![pipeline](https://img.shields.io/badge/autk--db-1.1.0-blue) ![pipeline](https://img.shields.io/badge/autk--map-0.1.0-blue)

---

## What it does

1. **Loads OpenStreetMap base layers** for *Manhattan Island* (surface, parks,
   water, roads, and 3D buildings) from the public Overpass API, via
   `autk-db`'s `loadOsmFromOverpassApi` — a single combined query.
2. **Loads subway station data** from a CSV into DuckDB-WASM, projecting the
   `latitude`/`longitude` columns to `EPSG:3395` as a geometry column.
3. **Counts, for each building, how many subway stations fall within 500 m**
   using a single in-browser spatial join (`spatialJoin` with the `NEAR`
   predicate, `nearDistance: 500`, centroid distance, `count` aggregate).
4. **Renders a 3D map** with `autk-map` (WebGPU). Buildings are thematically
   colored by their subway-station count using a sequential Reds color scale;
   an on-screen legend and summary stats panel are shown.
5. **Logs every major step** to the browser console for traceability.

---

## Requirements

- **Node.js 18+** and **npm** (to install dependencies and run the dev server).
- A browser with **WebGPU** support to view the map: **Chrome 113+**,
  **Edge 113+**, or **Safari 18+**. (`autk-map` and the GPU renderer require
  WebGPU; the rest of the pipeline runs in any modern browser.)
- Network access to the public **Overpass API** (`overpass-api.de`) the first
  time the page loads, to download the OSM data for Manhattan.

> **Note on the Overpass API:** the public servers are rate-limited and can
> return **HTTP 429 (Too Many Requests)**. The app issues a *single* combined
> OSM query to minimize requests. If you hit a 429, simply wait a minute and
> reload.

---

## Project layout

```
output/
├── index.html                       # App shell: canvas + loading / legend / stats overlays
├── src/
│   └── main.ts                      # The whole pipeline: load → join → render
├── public/
│   └── subway_manhattan_clean.csv   # Subway stations (key, latitude, longitude)
├── package.json
├── vite.config.ts                   # Vite config (keeps autk-* un-optimized)
├── tsconfig.json
└── README.md
```

### About the subway CSV

The app reads `public/subway_manhattan_clean.csv`, a 3‑column file
(`key,latitude,longitude`) derived from the NYC Open Data subway-stations
dataset (`data/subway_manhattan_clean.csv`). The original file's coordinate
columns are named `GTFS Latitude` / `GTFS Longitude`; they were renamed to the
simple `latitude` / `longitude` (and a numeric `key` added for the count
aggregate) because `autk-db`'s CSV geometry loader interpolates column names
directly into SQL and does not quote spaces.

To regenerate it from the source dataset:

```bash
python3 - <<'PY'
import csv
src = "../../../../data/subway_manhattan_clean.csv"   # adjust path as needed
with open(src, newline="") as f:
    rows = [
        (i + 1, r["GTFS Latitude"].strip(), r["GTFS Longitude"].strip())
        for i, r in enumerate(csv.DictReader(f))
        if r["GTFS Latitude"].strip() and r["GTFS Longitude"].strip()
    ]
with open("public/subway_manhattan_clean.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["key", "latitude", "longitude"])
    w.writerows(rows)
print(f"wrote {len(rows)} stations")
PY
```

---

## Install

Dependencies are the local Autark tarballs (this app only needs `autk-db` and
`autk-map`). They are already referenced in `package.json` as `file:` paths, so
a plain install works:

```bash
npm install
```

If you need to (re)install them explicitly from the tarballs:

```bash
npm install \
  ../../../../libs/autk-db-1.1.0.tgz \
  ../../../../libs/autk-map-0.1.0.tgz
```

---

## Run (development)

```bash
npm run dev
```

Then open **http://localhost:3005** in a WebGPU-capable browser. Open the
DevTools console to watch the pipeline progress:

```
Initializing SpatialDb (DuckDB-WASM)…
Loading OSM layers (surface, parks, water, roads, buildings)…
Overpass progress: querying-osm-server
Overpass progress: downloading-osm-data
OSM layers loaded: 5 layers — osm_surface, osm_parks, osm_water, osm_roads, osm_buildings
Subway stations loaded: 153 stations
Spatial join started: buildings ⟕ subway_stations (NEAR, 500 m, centroid)…
Spatial join complete: buildings enriched with subway_count
OSM buildings loaded: <N> features
Spatial join stats — buildings: <N>, with ≥1 station in 500 m: <M>, max: <K>, avg: <A>
Render loop started (60 fps)
Application fully loaded and rendering
```

The first load downloads OSM data for all of Manhattan, so allow some time for
the `Fetching OpenStreetMap data…` phase to finish.

## Build (production)

```bash
npm run build      # tsc type-check + vite production build → dist/
npm run preview    # serve the production build on http://localhost:3005
```

---

## How it works (pipeline)

```
autk-db  ── loadOsmFromOverpassApi ──▶  osm_surface / osm_parks / osm_water / osm_roads / osm_buildings
autk-db  ── loadCsv ───────────────▶  subway_stations  (geometry from lat/lon, EPSG:3395)
autk-db  ── spatialJoin (NEAR 500m, count) ──▶  osm_buildings.properties.sjoin.count.subway_count
autk-map ── loadGeoJsonLayer ×5 + updateGeoJsonLayerThematic ──▶  3D WebGPU map, buildings colored by count
```

Key implementation points (`src/main.ts`):

- **One Overpass query.** `autoLoadLayers` extracts all five base layers from a
  single `loadOsmFromOverpassApi` call scoped to `areas: ['Manhattan Island']`,
  keeping Overpass usage minimal.
- **Count within radius.** `spatialJoin` with `spatialPredicate: 'NEAR'`,
  `nearDistance: 500` (meters, because geometries are in `EPSG:3395`),
  `nearUseCentroid: true`, and a `count` aggregate writes a per-building
  `subway_count` under `properties.sjoin.count`. The `LEFT` join means
  buildings with no nearby station get a count of `0`.
- **Thematic coloring.** `updateGeoJsonLayerThematic(..., groupById = true)`
  colors each *building* (not each face) by its `subway_count` through the
  `SEQUENTIAL_REDS` interpolator; the legend min/max labels reflect the data
  range.

---

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Blank canvas, console error about WebGPU | Browser lacks WebGPU. Use Chrome/Edge 113+ or Safari 18+. |
| Stuck on `Fetching OpenStreetMap data…` then an error | Overpass returned **429** (rate limit) or timed out. Wait ~1 min and reload. |
| `Failed to fetch` for the CSV | Make sure the dev server is running and `public/subway_manhattan_clean.csv` exists. |
| All buildings the same color | Means every building has the same count — verify the CSV loaded (`Subway stations loaded: 153 stations` in the console). |
