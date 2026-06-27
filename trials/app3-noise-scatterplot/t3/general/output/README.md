# Manhattan Noisescape · Noise vs. Building Area Scatterplot

A **fully browser-side** (no backend) web application that renders a **3D map of
Manhattan buildings**, where each building is colored by the **number of NYC 311
noise complaints within a 500-meter radius** of its footprint. Alongside the map
is an **interactive scatterplot** — one point per building, plotting noise count
(x) against footprint area (y) — whose **brush highlights the matching buildings
on the map**.

Everything runs in the browser: OpenStreetMap geometry is fetched once from the
Overpass API (and cached in IndexedDB), the noise CSV is loaded from disk, and
the spatial join + rendering happen client-side with deck.gl + MapLibre GL.

---

## What it does

1. **Loads OSM base layers for Manhattan** via a single Overpass query
   (surface, parks, water, roads, buildings). The query is scoped to the
   Manhattan borough relation so results stay on-island, not in a loose bbox.
2. **Loads noise data** from `public/noise.csv` (NYC Open Data 311 export) and
   parses the `Latitude` / `Longitude` / `Complaint Type` / `Created Date`
   columns.
3. **Spatial join**: for every building it counts how many noise events fall
   within **500 m** of the footprint centroid (events are grid-bucketed so each
   building only tests its 9 neighbouring cells), and computes the footprint
   **area** in m².
4. **3D map**: buildings are extruded by their OSM height and colored on an
   Inferno ramp by their 500 m noise count (dark purple = quiet, bright
   yellow = loud).
5. **Picking on all 5 layers**: click any element (surface, water, park, road,
   building) to select it — it turns **cyan**. Click again to deselect.
6. **Interactive scatterplot** (bottom-right): each point is a building,
   x = noise events within 500 m, y = footprint area (log scale). **Drag a box**
   over the points and every building inside it is highlighted **magenta** on
   the map. Release on an empty drag to clear the brush.
7. All major operations are logged to the browser console (`[main]`,
   `[overpass]`, `[noise]`, `[spatial]`, `[render]`, `[scatter]` prefixes).

---

## Requirements

- **Node.js ≥ 18** and npm.
- A modern browser (WebGL2). Internet access on first run so the Overpass API
  can be queried; subsequent runs use the IndexedDB cache.

---

## Run it (development)

```bash
npm install
npm run dev
```

Open <http://localhost:3005>. The dev server uses a fixed port (`strictPort`),
so if 3005 is busy it fails loudly rather than moving.

On first load the app fetches Manhattan geometry from Overpass (this can take
30–60 s and is logged in the console). The result is cached in IndexedDB, so
later loads are near-instant. If every Overpass mirror is rate-limited
(HTTP 429/504) the loader retries across three mirrors with exponential backoff;
just wait or reload.

---

## Build & preview (production)

```bash
npm run build     # tsc --noEmit type-check, then vite build -> dist/
npm run preview   # serve the production build on http://localhost:3005
```

Other scripts:

```bash
npm run typecheck # tsc --noEmit only
```

---

## How to use the app

- **Rotate / pan / zoom** the 3D map with mouse drag + scroll (top-right
  navigation control shows the pitch).
- **Hover** any element for a tooltip (buildings show noise count, area, height).
- **Click** any element to select it (cyan); click again to deselect.
- **Brush** the scatterplot: press and drag a rectangle over the points. Every
  building inside the box turns magenta on the map and the count is shown under
  the chart. A plain click (no drag) clears the brush.

---

## Project layout

```
public/noise.csv      NYC 311 noise complaints (loaded at runtime from /noise.csv)
index.html            Map container, info panel, legend, scatterplot canvas
src/
  main.ts             App entry: wires loading → spatial join → render → scatter
  types.ts            Shared GeoJSON-style types and layer model
  noise.ts            CSV loader/parser for the 311 noise events
  overpass.ts         Combined Overpass query, mirror rotation + IndexedDB cache
  spatial.ts          500 m grid-bucketed noise count + footprint area per building
  render.ts           MapLibre base map + deck.gl layers, picking, brush highlight
  scatter.ts          Canvas scatterplot (noise × area) with drag-to-brush
vite.config.ts        Port 3005 (strictPort) for dev + preview
tsconfig.json         Strict TypeScript config
```

---

## Data sources

- **OpenStreetMap** via the [Overpass API](https://overpass-api.de/) — buildings,
  roads, parks, water for Manhattan island.
- **NYC Open Data 311 noise complaints** (`public/noise.csv`) —
  <https://opendata.cityofnewyork.us/>.

## Notes & caveats

- The "surface" layer has no single cheap OSM landmass polygon, so it is
  synthesized as one ground polygon spanning the (slightly padded) bounding box
  of all fetched features. It is drawn at the bottom and is fully selectable.
- Distances and areas use an equirectangular metric approximation, which is
  accurate to well under a metre at Manhattan's latitude and the 500 m scale.
- The production bundle is large (deck.gl + MapLibre); the chunk-size warning
  during `vite build` is expected and harmless.
