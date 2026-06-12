# Manhattan Buildings — Subway Accessibility (3D Map, UTK)

A 3D visual-analytics map of **every building on Manhattan Island**, where each
building is coloured by the **number of subway stations within a 500 m radius**
of its footprint. Built entirely with the [Urban Toolkit (UTK)](https://github.com/urban-toolkit/utk):
the OSM base layers, the per-building spatial join and the colouring are all
produced through the UTK Python API and rendered by the UTK server/front-end.

![colour scale](https://img.shields.io/badge/colormap-Viridis-440154?labelColor=fde725)
Dark purple = few nearby stations · Bright yellow = many nearby stations (0–15).

---

## What it shows

| Layer        | Source                              | Render                                   |
|--------------|-------------------------------------|------------------------------------------|
| `surface`    | OSM (Manhattan Island)              | ground plane                             |
| `water`      | OSM                                 | flat blue                                |
| `parks`      | OSM                                 | flat green                               |
| `roads`      | OSM                                 | flat grey                                |
| `buildings`  | OSM + subway-station spatial join   | 3-D extrusions, **Viridis by station count** |

Subway stations come from the NYC Open Data CSV
`data/subway_manhattan_clean.csv` (columns `GTFS Latitude` / `GTFS Longitude`).
For each of the **10,141 buildings** we count the stations whose location falls
within 500 m of the building's footprint, measured in a metric projection
(EPSG:32618 / UTM 18N) so the radius is true metres.

---

## Repository layout

```
output/
├── build_data.py        # UTK data-prep pipeline (OSM download → join → grammar)
├── requirements.txt     # Python dependencies
├── README.md            # this file
└── data/                # ← prebuilt UTK data folder, ready to serve
    ├── grammar.json             # the visualization spec (camera, knots, colour map)
    ├── surface.json  + .data    # base layers (json header + externalized binary buffers)
    ├── water.json    + .data
    ├── parks.json    + .data
    ├── roads.json    + .data
    ├── buildings.json + .data   # 3-D building meshes (≈7.46 M vertices)
    ├── subwayCount.json         # thematic layer: per-building 500 m station count
    └── buildings_joined.json    # precomputed NEAREST join (count → every building vertex)
```

The `data/` folder is **already built and ships in this repo**, so you can run
the app immediately without any network access or the slow OSM build (see
[Regenerating the data](#regenerating-the-data-optional) to rebuild from scratch).

---

## Quick start (run the app)

### 1. Install dependencies

```bash
cd output
python3 -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
```

`pip install utk` pulls in the whole geospatial stack (GeoPandas, OSMnx,
Shapely, Flask, overpass, scipy, pyproj). Python **3.9–3.11** is required.

### 2. Start the UTK server (the backend + front-end bundle)

```bash
utk start --data ./data
```

This launches UTK's Flask server, which serves both the data and the prebuilt
React front-end on **http://localhost:5001**.

> **Important — do not pass `-p/--port`.** The installed `utk` CLI has a bug
> (`--port` is parsed as a list and crashes Flask with
> `TypeError: int() argument ... not 'list'`). Just omit it; the server always
> uses port **5001**. If you need a different port, edit `port = 5001` near the
> top of `utk_server.py`.

### 3. Open the app

Navigate to **http://localhost:5001** in your browser.
You'll see Manhattan in 3-D. Buildings are coloured by their 500 m subway
station count (dark = isolated, yellow = well-served). Use the panel widgets to
toggle layers (water / parks / roads), search, and hide the grammar editor.
**Building picking is enabled** — click a building to inspect it.

To stop the server: `Ctrl-C`, or `utk stop`.

---

## How it works (`build_data.py`)

Everything is done through the UTK Python API and logged verbosely to stdout so
the pipeline can be traced from the console alone. The steps:

1. **Manhattan Island polygon** — geocode `"Manhattan Island"` via OSM and use
   its boundary polygon so every Overpass query is clipped to the island (never
   New Jersey / Brooklyn / Queens).
2. **OSM base layers** — download `water, parks, roads, surface, buildings`
   through `utk.OSM.load(...)` and save them as UTK layer files
   (`uc.save(includeGrammar=False)`). The Overpass responses are pre-fetched
   with a `User-Agent` (the public servers answer HTTP **406** without one),
   exponential backoff and endpoint fall-back, then stored in UTK's on-disk
   cache so `utk.OSM.load` re-reads them instead of re-hitting the API.
3. **Subway counts** — load `subway_manhattan_clean.csv`, project buildings and
   stations to EPSG:32618, and use a `scipy.spatial.cKDTree`
   `query_ball_point(r=500)` to count stations within 500 m of each building's
   representative point. Stats are logged (min/max/mean, buildings with ≥1).
4. **Thematic layer** — write `subwayCount.json` via `utk.thematic_from_df`,
   one point (building representative point) carrying its station count.
5. **Precomputed join** — `buildings_joined.json` assigns each of the ~7.46 M
   building mesh vertices its building's count with a single vectorised
   `cKDTree` nearest query. UTK's server detects this file and **skips** the
   per-vertex join it would otherwise compute at load time (which is far too
   slow for 7.46 M vertices), so the colours appear instantly.
6. **Grammar** — `grammar.json` defines the map camera and the `subwayAccess`
   knot: a `NEAREST` join of `subwayCount` onto the `buildings` `COORDINATES3D`
   level, coloured with the `interpolateViridis` colour map by the
   `BUILDINGS_LAYER`'s `SMOOTH_COLOR_MAP_TEX` shader.

### Regenerating the data (optional)

> ⚠️ The full-island build downloads all Manhattan buildings from Overpass and
> triangulates every footprint in pure Python — a **one-time ≈2–2.5 hour** job.
> The prebuilt `data/` folder already contains this result.

```bash
cd output
python build_data.py            # rebuilds ./data for the whole island
```

The script is idempotent against UTK's Overpass cache, so re-runs after the
first download are fast. Adjust `SUBWAY_CSV` / `RADIUS_M` at the top of
`build_data.py` to change the dataset or radius.

---

## Console logging

Both the data-prep script (terminal) and the front-end (browser DevTools
console) log every major step: OSM layer loading and feature counts, Overpass
requests/responses, the spatial-join progress and statistics, and rendering
milestones — so the application's progress can be traced and diagnosed from the
console alone.

---

## Data sources

- **Buildings / surface / parks / water / roads** — OpenStreetMap, via the
  Overpass API, clipped to the Manhattan Island boundary.
- **Subway stations** — NYC Open Data (MTA subway stations),
  `data/subway_manhattan_clean.csv`.
