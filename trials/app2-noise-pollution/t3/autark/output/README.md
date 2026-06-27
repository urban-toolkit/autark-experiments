# Manhattan Noisescape

A **fully browser-side** (no backend) urban visual-analytics application built with the
[Autark](https://github.com/urban-toolkit/autark/) toolkit. It renders a **3D map of
Manhattan** where each building is colored by the **number of NYC 311 noise complaints
within 500 m** of it. Every layer (surface, parks, water, roads, buildings) is
**pickable** — clicking a feature changes its color.

Everything runs in the browser:

- **autk-db** (DuckDB-WASM) loads the OSM base layers and the noise CSV, and runs the
  500 m proximity spatial join.
- **autk-map** (WebGPU) renders the 3D city and handles picking.

## What it does

1. **Loads OSM base layers for Manhattan Island** — surface, parks, water, roads and
   buildings — straight from the Overpass API via `autk-db.loadOsmFromOverpassApi`
   (`areas: ['Manhattan Island']`, projected to `EPSG:3395` so distances are in meters).
2. **Loads the noise data** from `public/data/noise.csv` (NYC 311 complaints) as a
   spatial point table, building a geometry column from the `Latitude`/`Longitude`
   columns.
3. **Counts noise events within 500 m of each building** with a `spatialJoin`
   (`spatialPredicate: 'NEAR'`, `nearDistance: 500`, centroid-based, `count` aggregate,
   normalized to `0–1`).
4. **Renders a 3D map** where building color encodes the nearby-noise count using a
   sequential reds color map (`updateGeoJsonLayerThematic` with `groupById`).
5. **Picking on all 5 layers** — `isPick` is enabled per layer and a `MapEvent.PICK`
   listener logs the selection; the renderer highlights (recolors) the clicked feature.
6. Every major step is logged to the **browser console** (data loading, Overpass
   progress, spatial-join progress, render milestones, picks, and errors).

## Requirements

- **Node.js 18+** and npm.
- A browser with **WebGPU** support for `autk-map` (Chrome 113+, Edge 113+, Safari 18+).
- The Autark tarballs in `../../../../../libs/` (relative to this folder) — the
  dependencies are pinned to those local files in `package.json`, **not** the npm
  registry.

## Install

The Autark packages are installed exclusively from the local tarballs (already wired up
in `package.json`):

```bash
npm install
```

This installs `autk-db` (1.1.0) and `autk-map` (0.1.0) from
`../../../../../libs/autk-db-1.1.0.tgz` and `../../../../../libs/autk-map-0.1.0.tgz`,
plus the dev toolchain (Vite, TypeScript).

## Run (development)

```bash
npm run dev
```

Then open **http://localhost:3005**. The first load fetches Manhattan OSM data from the
Overpass API, so it can take a minute (watch progress in the loading overlay and the
browser console).

## Build (production)

```bash
npm run build      # tsc type-check + vite build → dist/
npm run preview    # serve the production build at http://localhost:3005
```

## Project structure

```
.
├── index.html            # canvas + loading overlay + legend HUD
├── src/main.ts           # the entire app: db → spatial join → map → picking
├── public/data/noise.csv # NYC 311 noise-complaint dataset (served statically)
├── vite.config.ts        # port 3005; excludes autk-* from dep pre-bundling
├── tsconfig.json
└── package.json          # autk-db / autk-map pinned to local tarballs
```

## Notes

- **Coordinate system:** OSM layers and the CSV points are both projected to
  `EPSG:3395` (World Mercator, meters) so that the `nearDistance: 500` in the spatial
  join is a true 500 m radius.
- **Why `'Manhattan Island'`:** querying with `areas: ['Manhattan Island']` keeps the
  OSM data clipped to the island; broader areas (`'Manhattan'`, `'New York'`) would leak
  features outside the island boundary.
- **Color encoding:** buildings use the normalized noise count
  (`sjoin.count.noise_count_norm`, 0–1) mapped through a sequential reds scale — darker
  red means more nearby noise complaints.
- **No backend:** all queries run in DuckDB-WASM and all rendering uses WebGPU; the only
  external request is the one-time Overpass API download.
```
