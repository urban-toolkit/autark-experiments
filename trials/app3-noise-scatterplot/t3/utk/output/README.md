# Manhattan Noisescape — Noise Complaints vs. Building Area (UTK)

A 3D web map of Manhattan, built with **UTK** (Urban Toolkit), where every
building is colored by the **number of 311 noise complaints within a 500 m
radius** of it, paired with an **interactive scatterplot** — one circle per
building — encoding the noise count on **x** and the building footprint **area
(m²)** on **y**. Clicking points in the scatterplot highlights the matching
buildings on the map. Elements on every base layer (surface, parks, water,
roads, buildings) can be click-selected (picked), turning blue.

## What it shows

- **Five OSM base layers** for *Manhattan Island* — surface, parks, water,
  roads, buildings — loaded via `utk.OSM.load(...)`.
- **Buildings colored by noise proximity.** For each building, the number of
  noise events from `data/noise.csv` (NYC 311) within **500 m** is counted and
  mapped to an Inferno color scale.
- **Picking on all five layers.** Click any surface/park/water/road/building
  element to select it; the picked element is drawn blue.
- **Linked scatterplot.** Noise complaints (x) vs. footprint area in m² (y),
  one circle per building. Clicking a point highlights the corresponding
  building on the map (and vice-versa), turning it red in the plot.

## Prerequisites

- Python 3.10+ with the UTK toolkit and the build dependencies:

  ```bash
  pip install utk numpy pandas pyproj scipy
  ```

  `utk` installs the UTK server and its prebuilt frontend bundle. The build
  script also uses `numpy`, `pandas`, `pyproj`, and `scipy`.

## How it was built (data pipeline)

All processed UTK layers are already present in `./data`, so you do **not** need
to rebuild to run the app. The pipeline is in **`build_data.py`** and can be
re-run at any time:

```bash
python3 build_data.py
```

What it does:

1. **Base layers** — `utk.OSM.load("Manhattan Island", layers=[surface, parks,
   water, roads, buildings])`. This triangulates ~10k building footprints in
   pure Python and takes **~2 hours** for the whole island, so the script
   **reuses** the layers already in `./data` when they exist (the common case).
   > The public Overpass API now rejects requests without a `User-Agent`, so the
   > script sets `overpass.API._headers` before importing `utk`.
2. **Noise counts** — noise events are projected to UTM 18N (EPSG:32618, true
   meters) and a `scipy` KDTree counts events within **500 m** of each building
   centroid → `noiseCount.json` (per building: min 0, max 68, mean ≈ 16.7).
3. **Building areas** — each footprint is reprojected 3395→32618 and its area
   computed by the shoelace formula → `buildingArea.json`.
4. **Joins** — the noise count is joined onto the buildings at the **OBJECTS**
   level (one value per building) in `buildings_joined.json`. The area is joined
   onto a separate lightweight `areaPoints` helper layer (one tiny triangle per
   building), **not** the buildings mesh — see *Known limitations* below.
5. **Grammar** — `grammar.json` wires the five pickable layers, the building
   noise coloring, and the linked scatterplot.

## Run the app

From this directory (the one containing `data/`):

```bash
utk start --data ./data
```

Then open **http://localhost:5001** in your browser.

> **Do not pass `--port`** — that flag is broken in this UTK build (it passes a
> list to Flask and crashes). The server always listens on **5001**. To change
> the port, edit `port=5001` in UTK's `utk_server.py`.
>
> If startup fails with *"Address already in use"*, a previous UTK server is
> still holding the port: `ss -ltnp | grep 5001`, then `kill <pid>`.

### Using the interface

- The map viewer is on the right; the grammar editor is on the left (toggle it
  with the **HIDE_GRAMMAR** widget).
- **Pan/orbit/zoom** with the mouse to explore the 3D buildings.
- **Pick an element:** click any building / road / park / water / ground cell —
  it turns blue.
- **Scatterplot:** click a circle to highlight that building on the map (it is
  drawn highlighted) and mark the point red. Click again to clear.

## Console logging

Open the browser **developer console** to trace progress: the UTK frontend logs
layer loading, the Overpass/data fetches (`/getLayer`, `/files/...`), the spatial
join expansion, and rendering milestones. The data build (`build_data.py`) logs
every step to the terminal (`[build_data] ...`), including the per-building noise
count and area statistics.

## Notes & known UTK limitations

- **"Count within a radius" is not expressible in UTK's grammar** (which only
  supports `NEAREST`, 1:1 joins), so the 500 m counts are precomputed in
  `build_data.py` and joined as a thematic layer.
- **Brushing → CLICK.** The grammar's plot `interaction: "BRUSH"` raises
  *"Plot BRUSH not implemented yet"* in this UTK build. Highlighting buildings
  from the scatterplot is therefore implemented with the supported **`CLICK`**
  interaction (per-point selection), which is the working way to link the plot
  to the map.
- **Scatter y axis lives on a helper layer (out-of-memory fix).** At the OBJECTS
  level UTK expands a knot's value across *every vertex* of its output layer and,
  when building a plot, materializes several per-vertex JS arrays per plot knot.
  The Manhattan buildings mesh has ~7.4M vertices, so putting **both** scatter
  axes (noise *and* area) on the buildings layer makes the browser tab run out of
  memory while loading. The fix keeps only the **noise** knot on the buildings
  mesh (it colors the map, is the scatter x axis, and drives CLICK-highlight) and
  puts the **area** axis on a lightweight `areaPoints` layer — one tiny triangle
  per building (~30k vertices total). Both layers emit one component per building
  in the same order, so the scatterplot still shows one circle per building with
  noise on x and area on y, with brushing/clicking highlighting the right
  buildings.
- **Per-knot colormap field is `color_map` (not `colorMap`).** The UTK frontend
  reads the colormap from the snake_case field `color_map`; the camelCase
  `colorMap` shown in some docs/examples is silently ignored, so the shader falls
  back to its default `interpolateReds` — making *every* layer render solid red.
  Each knot here sets `color_map`.
- **Only `rgb(...)`-returning d3 color maps work.** UTK parses the d3 interpolator
  output with `match(/\d+/g)`, which assumes an `"rgb(r,g,b)"` string. Maps that
  return hex (`interpolateInferno`, `interpolateViridis`, `interpolateMagma`,
  `interpolatePlasma`) build a malformed colormap texture. Buildings therefore
  use **`interpolateYlOrRd`** (a sequential ramp returning rgb) for a clear
  pale-yellow → deep-red low-to-high noise gradient; base layers use grey
  (surface), blue (water), green (parks), and purple (roads) — all distinct and
  non-red.

## File overview

| File | Purpose |
|------|---------|
| `build_data.py` | End-to-end data pipeline (rebuilds `./data`). |
| `data/grammar.json` | UTK grammar: 5 pickable layers + linked scatterplot. |
| `data/buildings.json` + `.data` | Building geometry (BUILDINGS_LAYER). |
| `data/surface\|parks\|water\|roads.*` | Base OSM layers (pickable). |
| `data/noiseCount.json` | Per-building noise complaints within 500 m. |
| `data/buildings_joined.json` | OBJECTS-level noise join onto buildings (map color + scatter x). |
| `data/areaPoints.json` + `.data` | Lightweight helper layer (1 triangle/building) for the scatter y axis. |
| `data/areaTheme.json`, `data/areaPoints_joined.json` | Per-building footprint area (m²) joined onto `areaPoints`. |
| `data/*Theme.json`, `data/*_joined.json` | Constant abstract data so base layers render + pick. |
