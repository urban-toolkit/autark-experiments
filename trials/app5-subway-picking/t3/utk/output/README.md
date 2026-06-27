# Manhattan Buildings — Subway Accessibility with Full-Layer Picking (UTK)

A 3D map of Manhattan, built entirely with **[UTK](https://urbantk.org/)** (Urban
Toolkit). Every building is coloured by the **number of subway stations within a
500 m radius**, and **every loaded layer is pickable** — clicking any element of
the surface, parks, water, roads, or buildings highlights it (turns it blue).

---

## What the app shows

| Layer | Source | Colour | Pickable |
|-------|--------|--------|----------|
| **buildings** | OSM (3D extruded footprints) | **Viridis** by subway-station count within 500 m | ✅ |
| **surface** | OSM ground plane | flat grey | ✅ |
| **parks** | OSM | flat green | ✅ |
| **water** | OSM | flat blue | ✅ |
| **roads** | OSM | flat grey | ✅ |

Click any element on the map and it turns **blue** to indicate selection.
The building colour ramp encodes accessibility: brighter (yellow) buildings have
more subway stations within walking distance; darker (purple) buildings have
fewer.

---

## Repository layout

```
.
├── build_data.py        # data-preparation pipeline (UTK Python API)
├── requirements.txt     # Python dependencies
├── README.md            # this file
└── data/                # UTK-ready layers + grammar (served by `utk start`)
    ├── grammar.json             # the visualisation specification
    ├── buildings.json (+ .data) # 3D buildings, picking enabled
    ├── surface/parks/water/roads.json (+ .data)
    ├── *_ids.data               # per-triangle picking id buffers
    ├── *Theme.json              # constant colour "in" layers (base layers)
    ├── *_joined.json            # precomputed spatial joins (colours)
    └── subwayCount.json         # thematic layer: per-building station count
```

---

## Prerequisites

- **Python 3.9–3.11**
- A modern WebGL2 browser (Chrome / Edge / Firefox)

Install the backend dependencies:

```bash
pip install -r requirements.txt
```

`pip install utk` brings the whole geospatial stack (GeoPandas, OSMnx, Shapely,
Flask, overpass, scipy, pyproj). UTK also ships the prebuilt React frontend, so
there is **no npm / Vite / TypeScript build step** — the web app is served
directly by the `utk` CLI.

---

## How to run (end-to-end)

### 1. Prepare the data (already done — `data/` is populated)

```bash
python build_data.py
```

`build_data.py` runs in two phases:

- **Phase A — physical layers** (only if `data/` is empty). Resolves the
  *Manhattan Island* polygon and downloads `surface, parks, water, roads,
  buildings` via `utk.OSM.load`, restricting every Overpass query to the island
  polygon (never a broader area). It then loads the subway-station CSV, counts
  stations within 500 m of each building (true metres in EPSG:32618 / UTM 18N),
  writes the `subwayCount` thematic layer, and precomputes the
  building↔count NEAREST join.

  > **Note:** the full-island OSM build (≈10 k buildings, ~7.5 M vertices) takes
  > **hours** because UTK triangulates every building footprint in pure Python.
  > The shipped `data/` already contains this build, so Phase A is skipped on a
  > normal run (`build_data.py` detects the existing layers).

- **Phase B — picking augmentation** (always runs, takes seconds). Makes the
  four base layers pickable and writes `grammar.json`. See
  [How picking works](#how-picking-works) below.

The Overpass calls are hardened against the public API's limits: a `User-Agent`
header is set (the public servers answer **HTTP 406** without one), requests
retry across **four endpoints** with **exponential backoff** on 429/504, and
responses are cached so re-runs perform no network traffic.

### 2. Start the UTK server

```bash
utk start --data ./data
```

This launches UTK's Flask server **on http://localhost:5001** and serves the
prebuilt frontend together with the `data/` layers.

> ⚠️ Do **not** pass `--port` — that CLI flag is broken in UTK 0.8.9 (it passes a
> list to Flask and crashes). To change the port, edit `port=5001` in
> `utk_server.py` inside the installed `utk` package.

### 3. Open the app

Open **http://localhost:5001** in your browser. You will see the 3D Manhattan
map. Use the mouse to orbit/zoom; **click any element to select it (it turns
blue)**. The `TOGGLE_KNOT` / `SEARCH` widgets are available in the side panel.

To stop the server, press `Ctrl-C`.

---

## How picking works

UTK's grammar exposes picking via `interactions: ["PICKING", …]` (one entry per
map knot). For an element to be selectable, three things must line up — and stock
`utk.OSM.load` only sets them up for buildings, so `build_data.py` adds them for
the four base layers:

1. **Render style.** Each pickable triangle layer needs
   `renderStyle: ["SMOOTH_COLOR_MAP", "PICKING"]` — `PICKING` must be preceded by
   a valid *auxiliary* shader (`SMOOTH_COLOR_MAP` for triangle layers,
   `SMOOTH_COLOR_MAP_TEX` for the buildings layer). The `surface` layer is also
   converted from `HEATMAP_LAYER` to `TRIANGLES_3D_LAYER` so it can be picked.

2. **A per-triangle `ids` buffer.** `utk.OSM.load` emits id buffers only for
   buildings and surface, so `build_data.py` generates `water_ids.data`,
   `parks_ids.data`, and `roads_ids.data` — one (component-local, all-zero)
   `uint32` per triangle. The frontend offsets each component's ids by the
   running vertex count, so all-zero local ids make **each OSM feature one
   uniquely-selectable cell**.

3. **A colour function.** A pickable triangle layer crashes at load if its
   colour function is empty. Each base layer therefore gets a **constant**
   OBJECTS-level abstract join (`<layer>Theme.json` + `<layer>_joined.json`): a
   single constant value per feature. A constant produces a degenerate colour
   domain, which the colour-map shader renders as one flat natural tone (grey
   ground, blue water, green parks, grey roads). Buildings instead carry the
   real per-vertex `subwayCount` join, giving the Viridis accessibility ramp.

A picked element is drawn solid **blue** by the picking shader, satisfying the
"colour changes on click" requirement.

---

## Design note: "count within 500 m" is computed in Python

UTK's grammar can express a `NEAREST` spatial join (1-to-1) but **not** a
"count features within a radius" reduction. The per-building station count is
therefore computed in the data layer (`scipy.spatial.cKDTree.query_ball_point`
at `r = 500 m`, in metric EPSG:32618), written as the `subwayCount` thematic
layer, and joined onto the building vertices with a `NEAREST` join so the GPU
`SMOOTH_COLOR_MAP_TEX` shader colours each building by its precomputed count.
This is the faithful UTK realisation of the requirement (UTK has no
user-programmable GPU-compute path; its only GPU step is the colour-map shader).

---

## Logging

`build_data.py` logs every major operation to **stdout** (data loading, Overpass
requests/responses, the spatial join, file writes, etc.), so the whole pipeline
can be traced from the console alone. The interactive frontend is UTK's
**prebuilt** React bundle, which is shipped inside the `utk` package; it cannot
be modified to add custom `console.log` calls without rebuilding UTK from source.
UTK's own runtime already logs layer-loading and rendering progress to the
browser console.

---

## Validation performed

Because UTK serves a prebuilt bundle (there is **no npm / Vite / TypeScript /
port-3005 project**), the generic Node build steps do not apply. Validation was
done as follows:

- **`python build_data.py`** completes without error and writes every layer.
- **Static checks:** `grammar.json` references resolve to files; every base
  layer is `TRIANGLES_3D_LAYER` with `renderStyle = [SMOOTH_COLOR_MAP, PICKING]`;
  each `*_ids.data` has exactly one `uint32` per triangle; each `*_joined.json`
  `inValues` length equals the layer's feature count; and the buildings join
  `inValues` length (7 462 756) equals the building vertex count.
- **Live server:** `utk start --data ./data` boots on
  **http://localhost:5001** and returns HTTP 200 for `/`, `/main.js`,
  `/getGrammar`, `/getLayer?layer=<buildings|surface|roads|waterTheme|…>`, and
  `/files/<*_joined.json | *_ids.data>`.
