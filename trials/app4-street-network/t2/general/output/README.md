# Manhattan Street Network — Streets of New York

A **fully browser-side** (no backend) web app that renders a map of Manhattan and
colours every road segment either by its **length** or by the **number of noise
events within a 10-metre radius**. Road metrics are computed in a distributed
fashion on the **GPU (WebGPU)** when available, with an automatic CPU fallback.

Built with [Vite](https://vitejs.dev/) + TypeScript and
[MapLibre GL JS](https://maplibre.org/). OSM data comes live from the Overpass
API; noise data is loaded from a local CSV — everything runs in the browser.

---

## Features

| Requirement | How it is met |
|---|---|
| OSM base layers (surface, parks, water, roads) | One combined Overpass query over the `"Manhattan Island"` named area → `osmtogeojson` → four GeoJSON layers |
| Road length, distributed/GPU | WebGPU compute kernel (`one thread per road`) sums segment lengths in projected metres; CPU fallback if WebGPU is absent |
| Load noise CSV | `public/noise.csv` is fetched and parsed entirely in the browser |
| Count noise events ≤ 10 m of each segment | WebGPU compute kernel computes point-to-segment distance per road × event and counts hits ≤ 10 m (CPU fallback) |
| Colour by length **or** noise + toggle | "Length / Noise (10m)" buttons in the top-left panel switch the road colour ramp and legend live |
| Pick any layer element, colour changes on click | Click queries all four layers; the selected feature is highlighted yellow via MapLibre feature-state, and its attributes show in the info panel |
| Console logging | Every major step (fetch, parse, compute backend, spatial join, render, picks) logs to the browser console |

---

## Prerequisites

- **Node.js ≥ 18** and npm
- A modern browser. For GPU compute, use one with **WebGPU** (Chrome/Edge 113+).
  Without WebGPU the app still works using the CPU fallback.
- Internet access (Overpass API + OpenStreetMap raster tiles).

---

## The noise dataset

The app reads `public/noise.csv`, which is a copy of the task dataset at
`/home/lucas/projects/master-degree/autark-experiments/data/noise.csv`.
A copy already ships in this project. If you need to refresh it:

```bash
cp /home/lucas/projects/master-degree/autark-experiments/data/noise.csv public/noise.csv
```

Only the `Latitude` / `Longitude` columns are used; rows are filtered to a
Manhattan bounding box before the spatial join.

---

## Run it

```bash
# 1. install dependencies
npm install

# 2. start the dev server (http://localhost:3005)
npm run dev
```

Then open **http://localhost:3005** in your browser and open the DevTools
console to follow the progress logs.

### Production build / preview

```bash
npm run build      # tsc --noEmit + vite build  → dist/
npm run preview    # serve the built dist/ on http://localhost:3005
```

---

## How it works

1. **Map shell** — MapLibre GL initialises with a faint OSM raster basemap.
2. **Data load (parallel)** — a single Overpass query fetches roads + parks +
   water + landuse for *Manhattan Island* (with exponential backoff on HTTP
   429/504), while the noise CSV is loaded and parsed in the browser.
3. **Parse** — `osmtogeojson` converts the Overpass response; features are split
   into the `roads`, `parks`, `water` and `surface` layers.
4. **Projection** — road vertices and noise points are projected to a local
   equirectangular metre grid centred on Manhattan (so distances are in metres).
5. **Compute** — `src/compute/gpuCompute.ts` runs two WebGPU kernels:
   - **length**: per road, sum of its segment lengths.
   - **noise**: per road, count of noise events whose nearest distance to the
     road polyline is ≤ 10 m.
   If WebGPU is unavailable, `src/compute/cpuCompute.ts` produces identical
   results on the CPU. The chosen backend is logged to the console.
6. **Render** — roads are coloured by the active mode; surface/parks/water are
   filled. The legend and the "Length / Noise (10m)" toggle update together.
7. **Picking** — clicking anywhere queries all four layers; the top hit is
   highlighted yellow and its properties (including `road_length` and
   `noise_count`) are shown in the info panel.

---

## Project structure

```
index.html                  UI shell (map, controls, legend, info panel)
public/noise.csv            noise dataset (served browser-side)
src/
  main.ts                   orchestration + status/logging
  data/
    types.ts                shared types
    overpassClient.ts       single Overpass query + backoff
    osmParser.ts            Overpass JSON → 4 GeoJSON layers
    noiseLoader.ts          CSV fetch + parse + bbox filter
  compute/
    projection.ts           lon/lat → local metres
    gpuCompute.ts           WebGPU length + noise-count kernels
    cpuCompute.ts           CPU fallback (identical results)
    roadMetrics.ts          backend selection (GPU → CPU)
  map/
    mapManager.ts           MapLibre layers, toggle, picking, legend
    styles.ts               colour ramps + selection colour
```

---

## Notes & trade-offs

- **GPU "distributed" compute**: work is parallelised one thread per road
  segment via WebGPU compute shaders. The CPU fallback is provided so the app
  is usable in browsers without WebGPU; both paths yield the same numbers.
- **Projection**: a local equirectangular projection introduces < 0.3 % error
  over Manhattan — far below the 10 m radius precision required — and keeps the
  GPU kernels free of trigonometry.
- **Noise filtering**: the supplied CSV is a city-wide 311 sample; events are
  pre-filtered to a Manhattan bounding box so the spatial join stays bounded.
- **Overpass etiquette**: only **one** query is issued, over the
  `"Manhattan Island"` area, with exponential backoff on rate-limit responses.
