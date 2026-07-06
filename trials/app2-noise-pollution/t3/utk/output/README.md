# Manhattan Noisescape — Noise Pollution Impact on Buildings

A UTK urban visual-analytics application that renders a **3D map of Manhattan
buildings**, coloring each building by the **number of noise events (311
complaints) within a 500 m radius**. All five OpenStreetMap base layers —
surface, parks, water, roads, and buildings — are loaded and **pickable**
(click an element to select/highlight it).

Built entirely with [UTK](https://github.com/urban-toolkit/utk) (the Urban
Toolkit). The frontend is UTK's prebuilt web app, served by the UTK Flask
server; there is no separate npm/Vite project.

---

## What the app shows

- **3D buildings**, colored on an `interpolateInferno` scale by the number of
  noise events within 500 m of each building (dark = quiet, bright
  yellow = noisiest). Across Manhattan the per-building count ranges 0–68
  (mean ≈ 17).
- **Surface, parks, water, roads** rendered as base context layers.
- **Picking on every layer**: clicking any building, road, park, water body,
  or the ground surface selects it and changes its color. Toggle layers and
  search via the grammar widgets (top-left panel).

---

## Prerequisites

- **Python 3.10+**
- **UTK** and its scientific dependencies, installed in your environment:

  ```bash
  pip install utk
  # build_data.py additionally uses:
  pip install numpy pandas scipy pyproj
  ```

  (On the development machine UTK lives at
  `~/.local/lib/python3.10/site-packages/utk`.)

- A WebGL2-capable browser (Chrome/Firefox/Edge).

The prebuilt data lives in [`./data`](./data) and is ready to serve, so you can
**skip straight to "Run the application"**. Rebuild only if you want to
regenerate it (see below).

---

## Run the application

From this directory (`.../t4/utk/output`):

```bash
utk start --data ./data
```

Then open:

```
http://localhost:5001
```

> **Port note:** the server always listens on **5001**. Do **not** pass
> `utk start --port …` — that flag is broken in this UTK release (it passes a
> list to Flask and crashes). To change the port, edit `port = 5001` in
> `utk_server.py`.

Open the browser **developer console** to follow the app's progress logs
(layer loading, data fetches, rendering milestones) emitted by the UTK
frontend.

To stop the server press `Ctrl+C`.

---

## Rebuild the data (optional)

The data pipeline is [`build_data.py`](./build_data.py). It:

1. **Base OSM layers** — generates surface, parks, water, roads, and buildings
   for `Manhattan Island` via `utk.OSM.load(...)`. This triangulates ~10k
   building footprints in pure Python and takes **~2 hours**, so the script
   **reuses an existing island build** when `./data/buildings.json` is already
   present. (The public Overpass API now rejects requests without a
   `User-Agent`, so the script sets one before calling UTK.)
2. **Noise counts** — loads `../../../../../data/noise.csv`, keeps every event
   with valid coordinates, projects both the events (EPSG:4326) and the
   building centroids (EPSG:3395) to UTM zone 18N (meters), and counts the
   noise events within **500 m** of each building. The result is written as the
   abstract layer `noiseCount.json`.
3. **Spatial join** — joins `noiseCount` onto the buildings with a NEAREST,
   per-vertex (`COORDINATES3D`) relation — the same operation UTK's
   `FilesInterface.attachAbstractToPhysical` performs internally (a scipy
   `KDTree` nearest lookup) — producing `buildings_joined.json`. This direct
   computation is byte-for-byte identical to UTK's own join output but runs in
   seconds instead of UTK's minutes-long pandas loop.
4. **Grammar + render styles** — makes all five layers pickable and writes
   `grammar.json` with the buildings colored by the joined noise count.
   Concretely:
   - The four base layers (surface, water, parks, roads) are
     `TRIANGLES_3D_LAYER`s and use `renderStyle = ["SMOOTH_COLOR_MAP",
     "PICKING"]`. UTK's picking shader for a triangle layer requires the
     shader immediately before `PICKING` to be an *auxiliary* shader
     (`SMOOTH_COLOR_MAP`); `FLAT_COLOR` is **not** a valid auxiliary and makes
     the frontend throw at load. The surface additionally arrives from
     `OSM.load` as a non-pickable `HEATMAP_LAYER` and is converted to a
     `TRIANGLES_3D_LAYER`.
   - Because `SMOOTH_COLOR_MAP`'s shader reads per-element function values
     unconditionally (it crashes on a layer with no abstract data), each base
     layer is given a **constant** OBJECTS-level abstract value via a generated
     `<layer>Theme.json` + `<layer>_joined.json`. The constant maps through the
     colorMap to a flat mid-tone: grey ground, blue water, green parks, purple
     roads; buildings are the only data-driven (noise) coloring.
   - **Two colorMap gotchas** are encoded in `grammar.json`: (1) the knot field
     the frontend actually reads is snake_case **`color_map`** (camelCase
     `colorMap` is silently ignored → default `interpolateReds` → everything
     red); (2) the frontend parses the d3 interpolator's output with `/\d+/g`,
     which only works for maps that return `rgb(...)` strings — **hex-returning
     maps (`interpolateInferno`/`viridis`/`magma`/`plasma`/`turbo`) build a
     malformed, too-short colormap texture** (`texImage2D: ArrayBufferView not
     big enough`) and never color. So every `color_map` is an rgb()-returning
     map (Greys/Blues/Greens/Purples for the base layers, **`YlOrRd`** for the
     buildings — yellow = quiet → red = loud).
   - water/parks/roads ship without the per-triangle `ids` buffer that picking
     uses to identify elements, so the build generates one
     (`<layer>_ids.data`), making each OSM feature (water body / park / road
     segment) an individually selectable element.
   - Buildings use `["SMOOTH_COLOR_MAP_TEX", "PICKING"]`
     (`SMOOTH_COLOR_MAP_TEX` is the `BuildingsLayer` auxiliary shader) with the
     `YlOrRd` noise gradient.
   - A clicked/picked element is highlighted in blue by UTK's picking shader.

To rebuild:

```bash
python3 build_data.py
```

> **Why precompute the counts?** UTK's grammar can only express a NEAREST
> (1:1) join — it cannot express "count events within a radius". The radius
> aggregation is therefore done in `build_data.py`, and the per-building count
> is what UTK joins and renders.

---

## Project layout

```
output/
├── README.md            ← this file
├── build_data.py        ← data pipeline (noise counts, join, grammar)
└── data/                ← UTK project served by `utk start`
    ├── grammar.json         ← map, 5 pickable knots, noiseImpact color knot
    ├── surface.json         ← pickable ground (TRIANGLES_3D_LAYER)
    ├── parks.json  water.json  roads.json   ← pickable base layers
    ├── buildings.json       ← 3D buildings (SMOOTH_COLOR_MAP_TEX + PICKING)
    ├── noiseCount.json      ← abstract layer: per-building noise counts
    ├── buildings_joined.json← NEAREST join (per-vertex noise values)
    └── *_coordinates.data / *_indices.data / *_normals.data / *_ids.data
                              ← binary geometry buffers
```

---

## How the requirements map to the implementation

| Requirement | Where |
|---|---|
| Load OSM base layers (surface, parks, water, roads, buildings) | `build_data.build_base_layers` → `utk.OSM.load("Manhattan Island", …)` |
| Load noise data from CSV | `build_data.compute_noise_counts` reads `data/noise.csv` |
| Count noise events within 500 m of each building | `compute_noise_counts` (UTM 18N, scipy `KDTree.query_ball_point`, r=500 m) |
| Color buildings by proximity noise count | `noiseCount.json` + `buildings_joined.json` + `noiseImpact` knot (`interpolateInferno`) |
| Picking on every layer (color changes on click) | every layer's `renderStyle` ends in `PICKING` (preceded by a valid auxiliary shader); grammar `interactions` are all `PICKING`; picked elements turn blue |
| Console logging of major operations | UTK frontend logs to the browser console; `build_data.py` logs each pipeline step |

---

## Notes / troubleshooting

- **Overpass 406 / 429** — only relevant when rebuilding base layers.
  `build_data.py` sets a `User-Agent` to avoid 406; if you hit 429 (rate
  limit), wait and retry, or keep the existing `./data` build.
- **Server killed in a sandbox** — `utk start` binds a real socket; some
  sandboxed shells terminate long-lived listeners. Run it in a normal terminal.
- **Picking a layer does nothing / "picking needs an auxiliary shader"** — for
  a triangle layer, `PICKING` must be preceded by `SMOOTH_COLOR_MAP` (not
  `FLAT_COLOR`) in `renderStyle`, and the layer needs an `ids` buffer; both are
  set up by `build_data.py`. Also confirm the grammar `interactions` entry for
  the knot is `PICKING`.
