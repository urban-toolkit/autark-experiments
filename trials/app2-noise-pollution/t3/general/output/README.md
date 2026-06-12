# Manhattan Noisescape

A **fully browser-side** (no backend) web app that renders a **3D map of Manhattan
buildings**, coloring each building by the **number of 311 noise complaints within
500 m** of the building. All OSM base layers (surface, parks, water, roads,
buildings) are loaded live from the Overpass API, and every layer is clickable
(picking) — the selected element changes color.

Built with **Vite + TypeScript + [deck.gl](https://deck.gl/)**. There is no
server component: data is fetched, processed, and rendered entirely in the
browser.

---

## What it does

1. **Loads OSM base layers for Manhattan Island** in a single Overpass query
   (buildings, water, parks, major roads, and the island surface polygon),
   strictly scoped to `area["name"="Manhattan Island"]` so nothing off-island
   (NJ, Brooklyn, Queens) is pulled in. The raw response is cached in
   **IndexedDB**, so reloads never re-hit the rate-limited API.
2. **Loads the noise dataset** from `public/data/noise.csv` (NYC 311 data) and
   keeps only geolocated **noise** complaints.
3. **Spatial join** — for every building it counts how many noise events fall
   within **500 m** of the building centroid, using a uniform grid index over the
   noise points for speed.
4. **Renders a 3D map** — buildings are extruded and colored on a YlOrRd ramp by
   their nearby-noise count (grey = none, yellow → deep red = more complaints).
5. **Picking** — clicking any element of any layer (building, road, park, water,
   surface) highlights it in cyan and shows its details in the side panel.
   Clicking empty space clears the selection.
6. **Console logging** — every major step (OSM load, Overpass request/response
   size, CSV parse, spatial join, rendering milestones, errors) is logged to the
   browser console so progress can be traced from the console alone.

---

## Prerequisites

- **Node.js ≥ 18** and **npm**
- A modern browser (Chrome, Firefox, Edge, Safari)
- Internet access (the app fetches OSM data live from the Overpass API on first
  load)

---

## Run it (development)

```bash
npm install
npm run dev
```

Then open **http://localhost:3005** in your browser.

> **First load** fetches the full Manhattan Island dataset from Overpass
> (~45k buildings). This can take **30–90 seconds** and the response is several
> MB — watch the side panel status line and the browser console for progress.
> The result is cached in IndexedDB, so subsequent reloads are near-instant.

---

## Production build & preview

```bash
npm run build      # type-checks (tsc --noEmit) then builds with Vite
npm run preview    # serves the built app on http://localhost:3005
```

---

## How to use the map

- **Drag** to pan, **scroll** to zoom, **right-drag / ctrl-drag** to rotate &
  tilt (the view starts pitched for a 3D perspective).
- **Hover** any element for a tooltip.
- **Click** any building, road, park, water body, or the island surface to
  select it — it turns cyan and its details appear in the panel. Click empty
  space to deselect.
- Building color encodes the **number of noise complaints within 500 m**; see the
  legend in the panel (the max value is filled in once the join completes).

---

## Project structure

```
index.html              App shell, side panel, legend, tooltip
vite.config.ts          Dev/preview server on port 3005
src/
  main.ts               Orchestrates load → join → render
  overpass.ts           Single Overpass query for Manhattan Island, split into 5 layers
  cache.ts              IndexedDB key/value cache for the Overpass response
  noise.ts              Loads & parses the noise CSV, keeps geolocated noise events
  spatialJoin.ts        Counts noise events within 500 m of each building (grid index)
  colors.ts             YlOrRd color ramp for the noise counts
  render.ts             deck.gl Deck + 5 GeoJsonLayers, picking & highlighting
public/data/noise.csv   NYC 311 noise dataset (served statically)
```

---

## Notes & design decisions

- **Single Overpass request.** All five layer types are fetched in one union
  query to minimize API calls (the public Overpass servers rate-limit
  aggressively and return HTTP 429/406 otherwise). The fetcher retries with
  exponential backoff and falls back across mirror endpoints
  (`overpass-api.de` → `overpass.osm.ch` → `maps.mail.ru`).
- **IndexedDB caching.** The (multi-MB) Overpass response is cached client-side
  so you only pay the download once. To force a fresh fetch, clear the site's
  IndexedDB (DevTools → Application → IndexedDB → `noisescape-cache`).
- **The CSV is mixed 311 data.** `noise.csv` actually contains many complaint
  types; the app keeps only rows whose *Complaint Type* matches `noise`. Counts
  are modest because the file is a 5,000-row sample of the full dataset.
- **Roads** are limited to drivable/through classes (motorway…residential) to
  keep the download and render light; footways/service alleys are excluded.
- **Building heights** come from OSM `height` or `building:levels × 3.2 m` when
  present, otherwise a default storey height — OSM coverage of heights in
  Manhattan is partial.

---

## Troubleshooting

- **Map is empty / "Error" in the panel** — open the browser console. If you see
  Overpass `429`/`406` errors, the public API is rate-limiting your IP; wait a
  minute and reload (the app also tries mirror endpoints automatically).
- **Want to re-fetch fresh OSM data** — clear the `noisescape-cache` IndexedDB
  database (see above) and reload.
