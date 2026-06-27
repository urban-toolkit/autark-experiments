# Manhattan Street Network — Understanding the Streets of New York

A fully **browser-side** (no backend) urban analytics app built with the
[Autark](https://github.com/urban-toolkit/autark/) toolkit. It renders a map of
**Manhattan Island** and lets you color every road segment by either:

- **Segment length** — computed on the **GPU** with a WGSL compute shader, or
- **Nearby noise events** — the number of NYC 311 noise complaints within a
  **10-meter radius** of the segment.

A toggle in the top-left panel switches between the two coloring modes. You can
also **click any feature** (road, park, water body, or surface) to highlight it.

---

## What it does

1. **Loads OpenStreetMap base layers** for Manhattan Island via the Overpass API
   (`surface`, `parks`, `water`, `roads`) into an in-browser DuckDB-WASM
   database (`autk-db`). A single Overpass query is used to stay within rate
   limits.
2. **Computes the length of each road segment on the GPU** (`autk-compute`).
   Each segment's geometry (its vertex coordinates, in EPSG:3395 meters) is
   uploaded to the GPU as a per-feature matrix and the length is computed
   **entirely in a WGSL shader** by summing the Euclidean distance between
   consecutive vertices.
3. **Loads the NYC 311 noise dataset** from a local CSV (`autk-db`), creating a
   spatial point table (lat/lon → EPSG:3395).
4. **Counts noise events within 10 m of each road segment** using a spatial
   join (`NEAR`, 10 m, geometry-to-geometry).
5. **Colors road segments** by length *or* noise count (`autk-map` thematic
   mapping), switchable via the toggle control.
6. **Enables click-to-select picking** on every layer; the selected element's
   color changes on click.

All major steps are logged to the **browser console** (`console.log`) so the
full data-loading and processing pipeline can be traced from the dev tools.

---

## Requirements

- **Node.js 18+** and npm.
- A browser with **WebGPU** support — **Chrome 113+** or **Edge 113+**
  (required by `autk-map` and `autk-compute`).

---

## Install

The Autark libraries are installed **exclusively from the local tarballs** in
`../../../../../libs/` (relative to this folder). They are already pinned in
`package.json`:

| Package        | Version |
| -------------- | ------- |
| `autk-db`      | 1.1.0   |
| `autk-map`     | 0.1.0   |
| `autk-compute` | 1.1.0   |

Install everything:

```bash
npm install
```

If you need to re-pin the tarballs manually:

```bash
npm install \
  /home/lucas/projects/master-degree/autark-experiments/libs/autk-db-1.1.0.tgz \
  /home/lucas/projects/master-degree/autark-experiments/libs/autk-map-0.1.0.tgz \
  /home/lucas/projects/master-degree/autark-experiments/libs/autk-compute-1.1.0.tgz
```

---

## Run (development)

```bash
npm run dev
```

Then open **http://localhost:3005** in a WebGPU-capable browser.

> The first load fetches Manhattan OSM data from the public Overpass API, which
> can take a little while. Watch the loading overlay and the browser console for
> progress.

---

## Build (production)

```bash
npm run build      # type-checks (tsc) then bundles with Vite → dist/
npm run preview    # serves the production build on http://localhost:3005
```

---

## How to use

- **Color by Length / Noise (10 m)** — toggle buttons in the top-left panel.
  The legend updates to show the active metric and its value range.
- **Click** any road, park, water body, or surface to highlight it. Click empty
  space to clear the selection. Selection events are logged to the console.

---

## Data

- **Noise CSV:** `public/data/noise.csv` (NYC 311 service requests; served as a
  static asset). Each row is treated as a noise event. Geocoded via the
  `Latitude` / `Longitude` columns.
- **OpenStreetMap:** fetched live from the Overpass API for
  `areas: ['Manhattan Island']`.

---

## Project structure

```
.
├── index.html          # Canvas, loading overlay, control panel + legend
├── src/main.ts         # Full pipeline: load → GPU length → spatial join → render
├── public/data/noise.csv
├── vite.config.ts      # Vite config (port 3005; excludes autk-* from pre-bundling)
├── tsconfig.json
└── package.json
```

---

## Tech notes

- **GPU length computation** (`src/main.ts`): each road's coordinates are packed
  into `properties.coords` as a `number[][]` matrix and passed to
  `geojsonCompute.computeFunctionIntoProperties` via `attributeMatrices`
  (`{ rows: 'auto', cols: 2 }`). The WGSL shader receives `coords`,
  `coords_rows`, and `coords_cols` and returns the summed segment length per
  feature into `properties.compute.segment_length`.
- **Noise count** is read from `properties.sjoin.count.noise_count`, produced by
  the `autk-db` spatial join.
- **Picking**: `isPick` is enabled on every layer; `autk-map` automatically
  highlights the picked component and emits a `MapEvent.PICK` event.
