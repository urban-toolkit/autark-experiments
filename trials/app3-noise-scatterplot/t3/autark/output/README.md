# Manhattan Noisescape — Noise Pollution Impact on Buildings

A fully **browser-side** (no backend) urban visual-analytics application built with
the [**Autark**](https://github.com/urban-toolkit/autark/) toolkit. It renders a
**3D map of Manhattan buildings** colored by the number of **311 noise complaints
within 500 m** of each building, and links the map to an **interactive scatterplot**
(noise complaints vs. building footprint area) with brushing.

Everything runs in the browser: [DuckDB-WASM](https://duckdb.org/) (via `autk-db`)
loads and joins the data, WebGPU (via `autk-map`) renders the 3D city, and D3
(via `autk-plot`) draws the linked scatterplot.

---

## What it does

1. **Loads OpenStreetMap base layers for Manhattan Island** — surface, parks, water,
   roads, and buildings — directly from the Overpass API (`autk-db.loadOsmFromOverpassApi`,
   restricted to `areas: ['Manhattan Island']` so nothing off-island leaks in).
2. **Loads NYC 311 noise data** from `public/data/noise.csv` as a spatial point table,
   projecting the `Latitude`/`Longitude` columns to EPSG:3395 (`autk-db.loadCsv`).
3. **Counts noise events within 500 m of every building** with a single proximity
   spatial join (`autk-db.spatialJoin`, `NEAR`, `nearDistance: 500` meters,
   centroid-to-point).
4. **Renders a 3D map** where each building's color encodes its nearby noise-complaint
   count (`autk-map`, `SEQUENTIAL_REDS` color ramp).
5. **Picking on all five layers** — clicking any feature (surface, parks, water, roads,
   buildings) selects it and changes its color (`updateRenderInfoProperty('…','isPick',true)`).
6. **Linked scatterplot** (`autk-plot.Scatterplot`): one point per building,
   **x = noise complaints within 500 m**, **y = footprint area (m²)**. Dragging a
   rectangular **brush** over the scatterplot highlights the corresponding buildings
   on the 3D map.
7. Every major step is logged to the **browser console** for traceability.

---

## Requirements

- **Node.js 18+** and npm.
- A browser with **WebGPU** support for `autk-map` (Chrome 113+, Edge 113+, or
  Safari 18+). `autk-db` and `autk-plot` work in any modern browser.
- The Autark libraries are installed **from the local tarballs** in
  `../../../../../libs/` (pinned to `autk-db 1.1.0`, `autk-map 0.1.0`,
  `autk-plot 1.1.0`) — see `package.json`. No `autk-*` package is fetched from npm.

---

## Run it

```bash
# 1. Install dependencies (pulls the Autark libs from the local tarballs)
npm install

# 2. Start the dev server (http://localhost:3005)
npm run dev
```

Then open <http://localhost:3005> in a WebGPU-capable browser.

> The first load fetches Manhattan's OSM data from the public Overpass API and
> runs the spatial join in DuckDB-WASM — this can take a minute. Progress is shown
> in the loading overlay and logged to the console.

### Production build & preview

```bash
npm run build     # tsc type-check + vite production build → dist/
npm run preview   # serve the built app on http://localhost:3005
```

---

## How to use the app

- **Rotate / pan / zoom** the 3D map with the mouse.
- **Building color** = number of 311 noise complaints within 500 m (light = fewer,
  dark red = more).
- **Click** any layer element (surface, parks, water, roads, a building) to select
  it — the picked element changes color.
- **Brush the scatterplot** (drag a box over the points in the bottom-right panel):
  the selected buildings are highlighted on the map. Release the brush (or brush an
  empty area) to restore the noise coloring.

---

## Project structure

```
.
├── index.html          # Canvas, loading overlay, HUD legend, scatterplot panel
├── src/
│   └── main.ts         # Full pipeline: load → join → render → link
├── public/
│   └── data/
│       └── noise.csv   # NYC 311 noise-complaint dataset (served at /data/noise.csv)
├── package.json        # Autark deps pinned to local tarballs
├── vite.config.ts      # Port 3005; excludes autk-* from dep pre-bundling
└── tsconfig.json
```

---

## Data & methodology notes

- **Dataset:** NYC 311 service requests (noise-complaint sample) from
  [NYC Open Data](https://opendata.cityofnewyork.us/). Each row's
  `Latitude`/`Longitude` becomes a point; `Unique Key` is counted per building.
- **Proximity count:** `spatialJoin` with `NEAR` measures distance in the native
  units of the EPSG:3395 projection — which is meters — so `nearDistance: 500`
  is a true 500 m radius. `nearUseCentroid: true` measures from each building's
  centroid.
- **Building area (scatterplot Y):** computed with the shoelace formula on the
  EPSG:3395 footprint. Because World Mercator inflates area by `1/cos²(lat)`, the
  raw value is multiplied by `cos²(latitude)` (latitude taken from the OSM bounding
  box) to approximate **ground** square meters. This is an approximation suitable
  for the relative comparison the scatterplot shows.
- **Linking:** the map's building thematic layer and the scatterplot are driven by
  the **same** de-duplicated `FeatureCollection`, so scatter point *i* corresponds
  exactly to building component *i*. Brushing recolors the brushed buildings to the
  top of the ramp; clearing the brush re-applies the noise coloring.

---

## Troubleshooting

- **Blank map / WebGPU error:** use a WebGPU-capable browser (Chrome/Edge 113+).
- **Overpass timeout / HTTP 429:** the public Overpass API is rate-limited; wait a
  moment and reload. The query is restricted to Manhattan Island and issued once.
- **Port already in use:** stop whatever is on port 3005, or change `server.port`
  in `vite.config.ts` (it uses `strictPort`).
