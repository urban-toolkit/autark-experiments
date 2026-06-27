# Manhattan Buildings — Subway Accessibility 3D Map (with Picking)

A **fully browser-side** web application that renders a **3D map of Manhattan
buildings**, where each building is colored by the **number of subway stations
within a 500-meter radius**. Every loaded layer (surface, parks, water, roads,
buildings) supports **click-to-select picking** — the clicked element changes
color.

Everything runs in the browser: OpenStreetMap data is fetched live from the
Overpass API, the subway CSV is loaded locally, and the spatial join is computed
in-browser with DuckDB-WASM. There is **no backend**.

Built entirely with the **Autark** toolkit:

| Package    | Version | Role                                                      |
| ---------- | ------- | --------------------------------------------------------- |
| `autk-db`  | 1.1.0   | Browser-native spatial database (DuckDB-WASM): OSM, CSV, spatial join |
| `autk-map` | 0.1.0   | WebGPU 3D map renderer: layers, thematic coloring, picking |

---

## Prerequisites

- **Node.js** 18+ and **npm**
- A browser with **WebGPU** enabled (recent Chrome / Edge, or Chromium with
  `--enable-unsafe-webgpu`). The renderer (`autk-map`) requires WebGPU.

---

## How it works

The whole pipeline lives in [`src/main.ts`](src/main.ts):

1. **Initialize the spatial database** — `new SpatialDb()` + `await db.init()`
   boots DuckDB-WASM with the spatial extension.
2. **Load OSM base layers** — a **single** `loadOsmFromOverpassApi` call fetches
   the five layer types (`surface`, `parks`, `water`, `roads`, `buildings`) for
   `areas: ['Manhattan Island']`. Combining them into one query minimizes
   Overpass requests and avoids HTTP 429 rate limiting.
3. **Load the subway CSV** — `loadCsv` reads
   `public/data/subway_manhattan_clean.csv`, building point geometry from the
   `GTFS Latitude` / `GTFS Longitude` columns.
4. **Spatial join** — `spatialJoin` with the `NEAR` predicate (500 m, building
   centroid) and a `count` aggregate writes a `subway_count` onto each building.
   A `LEFT` join means buildings with no nearby station correctly resolve to 0.
5. **Render** — `new AutkMap(canvas)` loads all five layers, then thematically
   colors buildings with the `SEQUENTIAL_REDS` color map keyed on
   `subway_count` (darker red = more nearby stations).
6. **Picking** — `isPick` is enabled on all five layers; a `MapEvent.PICK`
   listener logs the selection and updates the on-screen panel. Clicking an
   element highlights it (color change); clicking empty space deselects.

All major steps log to the **browser console** (data loading, Overpass
progress, spatial-join stats, render milestones, pick events).

---

## Running the app

From this directory (`output/`):

```bash
# 1. Install dependencies (Autark libs come from local tarballs)
npm install

# 2. Start the dev server (http://localhost:3005)
npm run dev
```

Then open **http://localhost:3005** in a WebGPU-capable browser.

> If port 3005 is already in use, Vite automatically picks the next free port
> (e.g. 3006) and prints the URL it chose — use that one.

The first load fetches Manhattan OSM data from the Overpass API, so allow a few
seconds for the loading overlay to clear. Open the browser **DevTools console**
to follow progress and see pick events.

### Production build

```bash
npm run build      # type-checks (tsc --noEmit) then builds to dist/
npm run preview    # serve the production build
```

---

## Using the map

- **Rotate / pan / zoom** with the mouse to explore the 3D scene.
- **Building color** encodes subway accessibility: the legend (bottom-left)
  runs from `0 stations` to the observed maximum within 500 m.
- **Click any element** — a surface, park, water body, road, or building — to
  select it. The selected element changes color and its layer + internal id
  appear in the top-left panel. Click empty space to deselect.
- The **stats panel** (top-right) reports building/station counts and the
  max/avg stations within 500 m.

---

## Project structure

```
output/
├── index.html              # Canvas + UI overlays (legend, stats, pick panel)
├── src/main.ts             # Full data → analysis → render → picking pipeline
├── public/data/
│   └── subway_manhattan_clean.csv   # Subway station dataset (served statically)
├── vite.config.ts          # Vite config (port 3005, autk-* kept un-bundled)
├── tsconfig.json
└── package.json            # Autark libs pinned to local .tgz tarballs
```

---

## Data sources

- **OpenStreetMap** via the [Overpass API](https://overpass-api.de/) — base
  layers for Manhattan Island.
- **NYC Open Data** — subway stations
  (`public/data/subway_manhattan_clean.csv`), with `GTFS Latitude` /
  `GTFS Longitude` coordinates.

---

## Troubleshooting

- **Blank canvas / WebGPU error** — your browser doesn't have WebGPU enabled.
  Use a recent Chrome/Edge or enable the WebGPU flag.
- **Overpass HTTP 429** — the public Overpass API is rate-limited. Wait a
  minute and reload; the app issues only one Overpass query per load to stay
  well within limits.
- **Slow first load** — the Manhattan OSM extract is sizeable; subsequent
  reloads are faster as the browser caches the response.
