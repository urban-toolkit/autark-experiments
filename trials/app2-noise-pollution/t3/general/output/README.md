# Manhattan Noisescape — Noise Pollution Impact on Buildings

A **fully browser-side** (no backend) 3D web map of Manhattan. Every building is
extruded and colored by the **number of NYC 311 noise complaints that occurred
within a 500 m radius** of its footprint. All five base layers
(**surface, water, parks, roads, buildings**) are interactive: click any element
to select it and its color changes.

Built with [Vite](https://vitejs.dev/) + TypeScript, rendered with
[deck.gl](https://deck.gl/) over a [MapLibre GL](https://maplibre.org/) base
map. There is no server component — all data is fetched and processed in the
browser.

---

## What it does

1. **Loads the noise dataset** — parses `public/noise.csv` (the NYC Open Data 311
   export) in the browser, keeping each complaint's `Complaint Type`,
   `Created Date` and WGS84 `Latitude`/`Longitude`.
2. **Loads OpenStreetMap base layers** for Manhattan via a single combined
   Overpass query (buildings, roads, parks, water). The query targets the
   Manhattan borough **area** (relation `8398124`) to stay on the island. A
   ground **surface** polygon is synthesised from the data bounding box so the
   surface is itself a selectable layer. Responses are cached in **IndexedDB**,
   so the heavy Overpass fetch only happens once per browser.
3. **Spatial join** — for every building, counts the noise events within 500 m of
   its footprint centroid. Events are bucketed into a ~500 m grid so each
   building only tests its 9 neighbouring cells; distances use an
   equirectangular metric (sub-metre accurate at this scale and latitude).
4. **Renders the 3D scene** — buildings are extruded by their OSM height and
   colored on an Inferno ramp from few nearby complaints (dark purple) to many
   (bright orange/yellow). A legend shows the color domain.
5. **Picking on all 5 layers** — clicking any surface / water / park / road /
   building element toggles its selection; selected elements are painted cyan
   (selected roads also thicken). Click again to deselect. Hovering shows a
   tooltip.

Every major step logs progress to the browser console
(`Loading OSM layers…`, `Overpass response received: X MB`,
`Spatial join complete…`, `Scene rendered with 5 layers`, etc.).

---

## Prerequisites

- **Node.js ≥ 18** and npm.
- A modern browser with WebGL2.
- Internet access on first run (to reach the public Overpass API). Subsequent
  runs use the IndexedDB cache.

---

## Run it

```bash
# from this directory
npm install      # install dependencies
npm run dev      # start the dev server on http://localhost:3005
```

Then open **http://localhost:3005** in your browser. The first load fetches the
OSM layers from Overpass (this can take a little while and is cached afterwards),
then renders the map. Watch the in-app status line and the browser console for
progress.

### Production build

```bash
npm run build    # type-check (tsc --noEmit) + bundle into dist/
npm run preview  # serve the production build on http://localhost:3005
```

---

## Project layout

```
public/noise.csv     NYC 311 noise dataset (served as a static asset)
index.html           App shell: map container, info panel, legend, tooltip
src/main.ts          Orchestrates load → join → render
src/noise.ts         Fetches & parses the noise CSV
src/overpass.ts      Combined Overpass query + IndexedDB cache + surface polygon
src/spatial.ts       Grid-accelerated "noise events within 500 m" count
src/render.ts        MapLibre + deck.gl scene, 5 layers, click-to-select picking
src/types.ts         Shared data types
vite.config.ts       Dev/preview server on port 3005 (strict)
```

---

## How the requirements are met

| Requirement | Where |
| --- | --- |
| Fully browser-side, no backend | Vite static app; Overpass + CSV fetched client-side |
| OSM base layers (surface, parks, water, roads, buildings) | `src/overpass.ts` |
| Load noise CSV | `src/noise.ts` (`public/noise.csv`) |
| Count noise events within 500 m per building | `src/spatial.ts` |
| 3D map, building color encodes nearby noise | `src/render.ts` (extruded `GeoJsonLayer`, Inferno ramp) |
| Picking on any layer, color changes on click | `src/render.ts` (`onClick` per layer → selection set → cyan) |
| Console logging of all major operations | every module (`console.log`) |

---

## Notes & trade-offs

- **Overpass rate limits**: a *single* combined query is issued, rotated across
  three public mirrors with exponential backoff on 429/504, and the result is
  cached in IndexedDB. If every mirror is busy the app reports the error in the
  status line — re-run once the API frees up.
- **The "surface" layer** is a single ground polygon spanning the data bounding
  box (OSM has no single "Manhattan landmass" way that loads cheaply). It sits
  beneath the other layers and is fully selectable, satisfying the picking
  requirement for the surface.
- **`noise.csv`** is a generic 5,000-row 311 sample covering all of NYC; only the
  events that fall within 500 m of a Manhattan building contribute to that
  building's count. Every geolocated row is treated as a noise event per the
  task statement.
- **Distance metric**: equirectangular (flat-earth) approximation. At Manhattan's
  latitude and a 500 m radius the error is well under a metre — negligible for
  this visualization.
```
