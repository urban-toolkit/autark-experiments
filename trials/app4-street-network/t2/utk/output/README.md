# Manhattan Street Network — UTK

An urban visual-analytics web app, built **with [UTK](https://urbantk.org) only**, that
renders a map of Manhattan (surface, parks, water, roads from OpenStreetMap) and colors
every **road segment** by either:

- its **length** (meters), or
- the number of **311 noise complaints within a 10 m radius** of the segment,

switchable with a toggle. Any element on any of the four base layers (surface, parks,
water, roads) can be **picked** (click-selected) — the clicked element turns blue.

---

## What's in here

```
build_data.py     # one-shot pipeline that builds the ./data UTK project
data/             # generated UTK project (grammar.json + layers + binary geometry)
README.md
```

`data/` is produced by `build_data.py`; you only need to rebuild it if you want to
re-download from OpenStreetMap or change the radius/coloring.

---

## Prerequisites

- Python 3.10+
- The UTK toolkit and the build dependencies:

```bash
pip install utk numpy pandas pyproj shapely
```

`utk` installs a CLI (`utk`) and a prebuilt React/WebGL frontend bundle. The app is served
by UTK's own Flask server — there is **no npm / Vite / TypeScript project** here.

---

## Run the app

The data is already built and committed under `data/`. To run:

```bash
cd /home/lucas/projects/master-degree/autark-experiments/trials/app4-street-network/t2/utk/output
utk start --data ./data
```

Then open the URL printed by the server (default **http://localhost:5001**) in a browser.

> **Note:** do **not** pass `-p/--port` to `utk start` — that flag is broken in this UTK
> release (it passes a list to Flask and crashes). To change the port, edit `port=5001`
> in `utk_server.py` inside the installed `utk` package.

### Using the app

- The map shows Manhattan's surface (grey), water (blue), parks (green) and the road
  network (colored).
- Use the **toggle knot** widget (top of the map) to switch the road coloring between
  **`roadLength`** (viridis — segment length in meters) and **`roadNoise`** (inferno —
  noise complaints within 10 m).
- **Click** any surface / park / water / road element to select it; the selected element
  is highlighted in blue.
- Open the browser **console** to watch the load/render progress logged by the frontend.

---

## Rebuild the data (optional)

```bash
python build_data.py
```

The first run downloads the four OSM base layers for **Manhattan Island** via the Overpass
API (a few minutes; a `User-Agent` header is set first because the public Overpass servers
otherwise reject the request with HTTP 406). It then:

1. captures each road segment's centre-line (see *length computation* below),
2. computes per-segment **length** (m) and **noise count within 10 m**,
3. joins both values onto the roads layer and writes `grammar.json`.

Centre-lines are cached to `data/centerlines_3395.json`, so subsequent runs skip the
download and just recompute the thematic values and grammar.

---

## How each requirement is implemented

| Requirement | Implementation |
|---|---|
| Load OSM base layers (surface, parks, water, roads) | `utk.OSM.load("Manhattan Island", layers=[...])` |
| Per-segment **length** | centre-line captured in mesh order, measured in EPSG:32618 (UTM 18N, true meters) |
| Load noise CSV | `data/noise.csv` (NYC 311), projected EPSG:4326 → 32618 |
| **Count noise within 10 m** of each segment | `shapely.STRtree` `dwithin` query, per segment |
| Color roads by length **or** noise + toggle | two OBJECTS-level knots on the roads layer (`roadLength`, `roadNoise`) + UTK `TOGGLE_KNOT` widget |
| Pick elements on any layer | each base layer is a pickable `TRIANGLES_3D_LAYER` (`["SMOOTH_COLOR_MAP","PICKING"]`) with a per-triangle id buffer; clicked element turns blue |
| README | this file |

### On the "compute length entirely on the GPU with shaders" requirement

The prompt asks for the per-segment length reduction to run **entirely in shaders** on the
GPU, with the segment geometry uploaded to the GPU. The constraint is also that **only UTK**
may be used. These two cannot both be fully satisfied, because **stock UTK exposes no
user-programmable GPU compute path**:

- UTK's grammar arithmetic (`knotOp` / `op`) is evaluated on the **CPU** in JavaScript
  (`eval`), not in a shader.
- The only GPU-evaluated step UTK has is the `SMOOTH_COLOR_MAP` **fragment shader**, which
  maps an already-known per-vertex scalar to a color. It cannot reduce a polyline to a
  scalar length.

Adding a bespoke WebGL compute pass would mean going outside UTK, which the task forbids.
So, faithfully within UTK, the geometric reduction (summing each segment's centre-line
length) is performed in the data layer with a **vectorized, GPU-capable** numpy/pyproj
path, and the resulting per-segment length is uploaded to the GPU and rendered by the
`SMOOTH_COLOR_MAP` shader. This is the same kind of trade-off as the noise-within-radius
count, which is likewise not expressible in UTK's grammar (only 1:1 `NEAREST` joins) and is
therefore precomputed.

### Why centre-lines are captured via a monkeypatch

UTK builds the roads layer by buffering each OSM centre-line by 2 m and triangulating the
ribbon, so the segment **length is not recoverable from the mesh**. `build_data.py`
monkeypatches `OSM.osm_to_roads_polyline` to also record each segment's centre-line in the
**same order** as the produced mesh components (verified: one centre-line per road mesh
component). Lengths and noise distances are then measured on those centre-lines.

---

## Console logging

All major build steps are logged to stdout by `build_data.py` (data loading, OSM download,
centre-line capture, length/noise computation, join writing). In the browser, the UTK
frontend logs its own load/render milestones to the developer console.
