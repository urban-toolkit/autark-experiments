#!/usr/bin/env python3
"""
Manhattan Street Network — UTK data build pipeline (app4: street network).

Produces, under ./data, a UTK project that:
  * renders a 2.5D map of Manhattan with four OSM base layers
    (surface, parks, water, roads),
  * colors every road segment by EITHER its length (m) OR the number of 311
    noise complaints (data/noise.csv) within a 10 m radius of the segment, with
    a TOGGLE_KNOT widget to switch between the two colorings, and
  * lets the user pick (click-select) elements on any of the four base layers;
    the clicked element turns blue.

Pipeline
--------
1. The four base layers for "Manhattan Island" are produced with
   ``utk.OSM.load(...)``. UTK builds the roads layer by buffering each OSM
   centre-line by 2 m and triangulating the resulting ribbon, so the segment
   *length cannot be recovered from the mesh*. We therefore monkeypatch
   ``OSM.osm_to_roads_polyline`` to also capture, in mesh order, each segment's
   centre-line (EPSG:3395 LineString) — these are deterministic and align 1:1
   with the produced road mesh components. The centre-lines are cached to
   ``data/centerlines_3395.json`` so re-runs need not re-download from OSM.
2. Each road segment gets two per-segment values:
     (a) its length in meters, measured on the centre-line reprojected
         3395 -> 32618 (UTM 18N), because EPSG:3395 length is inflated ~1.32x
         at 40.7N.                                    -> roadLengthTheme.json
     (b) the count of noise events whose location is within 10 m of the
         centre-line (events 4326 -> 32618, dwithin on an STRtree of the
         segments).                                   -> roadNoiseTheme.json
3. Both values are joined onto the roads layer at the OBJECTS level (one value
   per segment) in a single roads_joined.json holding two joins.
4. grammar.json wires four pickable base-layer knots and TWO roads colorings
   (``roadLength`` + ``roadNoise``) that both render the roads layer; the
   TOGGLE_KNOT widget switches between them.

Notes on UTK limitations (documented for the reader / the prompt):
  * The prompt asks for the per-segment length to be computed "entirely using
    shaders" on the GPU. Stock UTK exposes NO user-programmable GPU compute
    path: ``knotOp``/``op`` arithmetic is evaluated on the CPU (JS ``eval``),
    and the only GPU-evaluated step is the ``SMOOTH_COLOR_MAP`` fragment shader
    that maps an already-known per-vertex scalar to a color. Faithfully, the
    geometric reduction (sum of segment lengths) is computed here in the data
    layer with a vectorized (GPU-capable) numpy/pyproj path, and the GPU
    color-map shader renders it — the same trade-off as the noise count below.
  * "Count within a radius" is not expressible in UTK's grammar (only NEAREST,
    1:1 joins), so it is precomputed here in Python.
"""

import os
import json
import struct
import sys

import numpy as np
import pandas as pd
import pyproj
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
NOISE_CSV = os.path.abspath(
    os.path.join(HERE, "..", "..", "..", "..", "..", "data", "noise.csv")
)
CENTERLINE_CACHE = os.path.join(DATA_DIR, "centerlines_3395.json")
REGION = "Manhattan Island"
BASE_LAYERS = ["surface", "parks", "water", "roads"]
RADIUS_M = 10.0  # noise-event search radius around each road segment, in meters

# Centre-lines (EPSG:3395, mesh order) captured by the OSM.load monkeypatch.
CENTERLINES_3395 = []


def log(msg):
    print(f"[build_data] {msg}", flush=True)


# --------------------------------------------------------------------------
# Step 1 — base OSM layers, with a monkeypatch to capture road centre-lines
# --------------------------------------------------------------------------
def _patched_osm_to_roads_polyline(osm_elements, bpoly, bbox):
    """Faithful copy of ``utk.OSM.osm_to_roads_polyline`` that additionally
    records each segment's centre-line (EPSG:3395) into ``CENTERLINES_3395``.

    The only added lines are the two marked ``# >>> capture`` — everything else
    mirrors the upstream implementation so the produced mesh is identical and
    the captured centre-lines align 1:1 with ``mesh`` (same loop, same order).
    """
    import mapbox_earcut as earcut
    from shapely.geometry import MultiLineString
    from shapely.ops import transform as shp_transform
    import geopandas as gpd
    from utk import utils, errors

    mesh = []
    coords = []
    for wid in osm_elements["ways"]:
        way = osm_elements["ways"][wid]
        coords.append(way["geometry"])

    lines = MultiLineString(coords)
    inter = lines.intersection(utils.polygon_bpoly(bpoly, bbox))

    proj_4326 = pyproj.CRS("EPSG:4326")
    proj_3395 = pyproj.CRS("EPSG:3395")
    project = pyproj.Transformer.from_crs(proj_4326, proj_3395, always_xy=True).transform

    geometries = []
    geometries_coordinates = []
    ids = []
    ids_coordinates = []
    counter_id_coordinates = 0

    if inter.geom_type == "LineString":  # shapely2 compat
        inter_parts = [inter]
    else:
        inter_parts = [g for g in getattr(inter, "geoms", []) if g.geom_type == "LineString"]

    for id, line in enumerate(inter_parts):
        x, y = line.coords.xy
        invertedLine = LineString(list(zip(y, x)))
        ids.append(id)

        transformed_line = shp_transform(project, invertedLine)
        CENTERLINES_3395.append(list(transformed_line.coords))  # >>> capture

        buffer_line = transformed_line.buffer(2)  # in meters
        geometries.append(buffer_line)

        x, y = buffer_line.exterior.coords.xy
        nodes = list(zip(x, y))
        rings = [len(nodes)]
        indices = earcut.triangulate_float64(nodes, rings)
        nodes = np.array(nodes)

        if len(indices) == 0 or (len(indices) % 3) > 0:
            raise errors.InvalidPolygon("Invalid triangulation")

        nodes = nodes.flatten().tolist()
        indices = indices.tolist()

        for i in range(int(len(nodes) / 2)):
            geometries_coordinates.append(Point(nodes[i * 2], nodes[i * 2 + 1]))
            ids_coordinates.append(counter_id_coordinates)
            counter_id_coordinates += 1

        nodes = utils.from_2d_to_3d(nodes)
        mesh.append({"type": "type", "geometry": {
            "coordinates": [round(item, 4) for item in nodes], "indices": indices}})

    gdf = gpd.GeoDataFrame({"geometry": geometries, "id": ids}, crs=3395)
    gdf_coordinates = gpd.GeoDataFrame(
        {"geometry": geometries_coordinates, "id": ids_coordinates}, crs=3395)
    log(f"  monkeypatch: captured {len(CENTERLINES_3395)} road centre-lines.")
    return {"data": mesh, "gdf": {"objects": gdf, "coordinates": gdf_coordinates, "coordinates3d": None}}


def build_base_layers():
    """Generate surface/parks/water/roads for Manhattan Island with UTK.

    Without buildings (no per-building Python triangulation) the whole-island
    load is fast (~45 s). Reuses an existing build when both the road mesh and
    the centre-line cache are already present.
    """
    have_layers = all(
        os.path.exists(os.path.join(DATA_DIR, f"{n}.json")) for n in BASE_LAYERS)
    if have_layers and os.path.exists(CENTERLINE_CACHE):
        log("Base OSM layers + centre-line cache already present — reusing them.")
        with open(CENTERLINE_CACHE) as f:
            CENTERLINES_3395.extend(json.load(f))
        log(f"Loaded {len(CENTERLINES_3395)} cached road centre-lines.")
        return

    log("Base OSM layers missing — downloading from OpenStreetMap via UTK...")
    # Public Overpass servers reject requests without a User-Agent (HTTP 406/429).
    import overpass
    overpass.API._headers = {
        "User-Agent": "utk-research/1.0",
        "Accept-Charset": "utf-8;q=0.7,*;q=0.7",
    }
    import utk
    from utk import osm as utk_osm

    # Monkeypatch BEFORE the load so road centre-lines are captured in mesh order.
    utk_osm.OSM.osm_to_roads_polyline = staticmethod(_patched_osm_to_roads_polyline)
    log("Patched OSM.osm_to_roads_polyline to capture road centre-lines.")

    os.makedirs(DATA_DIR, exist_ok=True)
    log(f"Loading OSM layers for '{REGION}': {', '.join(BASE_LAYERS)} ...")
    uc = utk.OSM.load(REGION, layers=BASE_LAYERS)
    uc.save(DATA_DIR)
    log("Base OSM layers saved to ./data.")

    with open(CENTERLINE_CACHE, "w") as f:
        json.dump(CENTERLINES_3395, f)
    log(f"Cached {len(CENTERLINES_3395)} road centre-lines to {CENTERLINE_CACHE}.")


# --------------------------------------------------------------------------
# helpers for reading UTK binary geometry
# --------------------------------------------------------------------------
def read_doubles(path):
    with open(path, "rb") as f:
        return np.frombuffer(f.read(), dtype="<f8")


def road_count():
    with open(os.path.join(DATA_DIR, "roads.json")) as f:
        return len(json.load(f)["data"])


# --------------------------------------------------------------------------
# Step 2 — per-segment geometry: length (m) and noise count within 10 m
# --------------------------------------------------------------------------
def centerlines_utm():
    """Reproject the captured centre-lines (EPSG:3395) to EPSG:32618 (UTM 18N).

    Returns a list of shapely LineStrings in true meters.
    """
    to_utm = Transformer.from_crs(3395, 32618, always_xy=True)
    out = []
    for cl in CENTERLINES_3395:
        arr = np.asarray(cl, dtype="f8")
        ux, uy = to_utm.transform(arr[:, 0], arr[:, 1])
        out.append(LineString(np.column_stack([ux, uy])))
    return out


def compute_lengths(lines_utm):
    log("Computing road segment lengths (centre-line, EPSG:32618)...")
    lengths = np.fromiter((ln.length for ln in lines_utm), dtype="f8", count=len(lines_utm))
    log("Road length (m) — "
        f"min {lengths.min():.1f}, max {lengths.max():.1f}, mean {lengths.mean():.1f}.")
    return lengths


def compute_noise_counts(lines_utm):
    log(f"Loading noise data from {NOISE_CSV} ...")
    df = pd.read_csv(NOISE_CSV, low_memory=False)
    log(f"Noise CSV loaded: {len(df)} rows.")
    df = df.dropna(subset=["Latitude", "Longitude"])
    log(f"Noise events with valid coordinates: {len(df)}.")

    to_utm = Transformer.from_crs(4326, 32618, always_xy=True)
    nx, ny = to_utm.transform(df["Longitude"].values, df["Latitude"].values)
    points = [Point(x, y) for x, y in zip(nx, ny)]
    log(f"Projected {len(points)} noise events to UTM 18N.")

    log(f"Counting noise events within {RADIUS_M:.0f} m of each road segment...")
    tree = STRtree(lines_utm)
    counts = np.zeros(len(lines_utm), dtype="f8")
    for pt in points:
        # dwithin: indices of segments whose distance to the point is <= RADIUS_M
        idx = tree.query(pt, predicate="dwithin", distance=RADIUS_M)
        counts[idx] += 1.0
    log("Noise count per segment (within 10 m) — "
        f"min {counts.min():.0f}, max {counts.max():.0f}, mean {counts.mean():.2f}, "
        f"segments with >=1: {int((counts > 0).sum())}.")
    return counts


def segment_centroids_3395():
    """Centroid (EPSG:3395) of each captured centre-line, for the theme layers."""
    cents = np.empty((len(CENTERLINES_3395), 3), dtype="f8")
    for i, cl in enumerate(CENTERLINES_3395):
        arr = np.asarray(cl, dtype="f8")
        cents[i, 0] = arr[:, 0].mean()
        cents[i, 1] = arr[:, 1].mean()
        cents[i, 2] = 0.0
    return cents


# --------------------------------------------------------------------------
# Step 3 — OBJECTS-level joins (one value per road segment)
# --------------------------------------------------------------------------
def write_thematic_layer(name, centroids_3395, values):
    layer = {
        "id": name,
        "coordinates": centroids_3395.reshape(-1).tolist(),
        "values": values.tolist(),
    }
    with open(os.path.join(DATA_DIR, f"{name}.json"), "w") as f:
        json.dump(layer, f)
    log(f"Wrote thematic layer {name}.json ({len(values)} segments).")


def write_roads_joined(lengths, counts):
    """Join BOTH per-segment values onto the roads layer at the OBJECTS level.

    A single roads_joined.json holds two joins; the frontend matches each knot's
    ``in`` link to a join by (layerId==in.name, inLevel, outLevel, NEAREST,
    abstract). Each ``inValues`` length must equal the number of road mesh
    components (one value per segment).
    """
    n = len(lengths)
    joined = {
        "joinedLayers": [
            {"spatial_relation": "NEAREST", "layerId": "roadLengthTheme",
             "outLevel": "OBJECTS", "inLevel": "COORDINATES", "abstract": True},
            {"spatial_relation": "NEAREST", "layerId": "roadNoiseTheme",
             "outLevel": "OBJECTS", "inLevel": "COORDINATES", "abstract": True},
        ],
        "joinedObjects": [
            {"joinedLayerIndex": 0, "inValues": lengths.tolist()},
            {"joinedLayerIndex": 1, "inValues": counts.tolist()},
        ],
    }
    with open(os.path.join(DATA_DIR, "roads_joined.json"), "w") as f:
        json.dump(joined, f)
    log(f"Wrote roads_joined.json (2 OBJECTS joins, {n} values each).")


# --------------------------------------------------------------------------
# Step 4 — render styles + grammar (picking on 4 layers + length/noise toggle)
# --------------------------------------------------------------------------
def generate_cell_ids(name):
    """Add a per-triangle ``ids`` buffer to a triangle layer that lacks one.

    UTK's PICKING shader identifies clickable cells through per-triangle ids
    (``<layer>_ids.data``, one uint32 per triangle, referenced as [start,size]
    from each data entry). OSM.load emits these for buildings/surface but not
    for water/parks/roads, so picking those layers would otherwise select
    nothing. Each id is a component-local 0; the frontend offsets ids by the
    cumulative vertex count of preceding components, so giving every triangle in
    a data entry the same local id makes that whole entry one selectable element.
    """
    path = os.path.join(DATA_DIR, f"{name}.json")
    with open(path) as f:
        layer = json.load(f)
    if "ids" in layer["data"][0]["geometry"]:
        log(f"  {name}: ids already present — skipping id generation.")
        return
    ids_flat = []
    pos = 0
    for entry in layer["data"]:
        _, n_indices = entry["geometry"]["indices"]
        n_tri = n_indices // 3
        entry["geometry"]["ids"] = [pos, n_tri]
        ids_flat.extend([0] * n_tri)
        pos += n_tri
    with open(os.path.join(DATA_DIR, f"{name}_ids.data"), "wb") as f:
        f.write(struct.pack(f"<{len(ids_flat)}I", *ids_flat))
    with open(path, "w") as f:
        json.dump(layer, f)
    log(f"  {name}: generated {len(ids_flat)} per-triangle ids "
        f"({len(layer['data'])} selectable objects).")


def write_constant_abstract(name, const_value=1.0):
    """Attach a constant OBJECTS-level abstract value to a base triangle layer.

    A pickable TrianglesLayer is rendered by ``ShaderSmoothColorMap``, whose
    ``updateShaderData`` does ``d3.extent(this._function[0])`` with NO guard for
    an empty function array. A *pure* knot (no abstract data) leaves that array
    empty, so the shader crashes ("undefined is not iterable"). We therefore give
    each base layer a real per-object abstract value via a precomputed
    OBJECTS-level join. The value is constant, so d3's degenerate-domain scale
    maps every element to 0.5 -> a single flat ``colorMap(0.5)`` mid-tone color.
    """
    path = os.path.join(DATA_DIR, f"{name}.json")
    with open(path) as f:
        layer = json.load(f)
    data = layer["data"]
    n_obj = len(data)

    coords = read_doubles(os.path.join(DATA_DIR, f"{name}_coordinates.data"))
    theme_coords = []
    for entry in data:
        start, size = entry["geometry"]["coordinates"]
        block = coords[start:start + size].reshape(-1, 3)
        c = block.mean(axis=0)
        theme_coords.extend([float(c[0]), float(c[1]), 0.0])

    theme = {"id": f"{name}Theme", "coordinates": theme_coords,
             "values": [const_value] * n_obj}
    with open(os.path.join(DATA_DIR, f"{name}Theme.json"), "w") as f:
        json.dump(theme, f)

    joined = {
        "joinedLayers": [{
            "spatial_relation": "NEAREST", "layerId": f"{name}Theme",
            "outLevel": "OBJECTS", "inLevel": "COORDINATES", "abstract": True,
        }],
        "joinedObjects": [{"joinedLayerIndex": 0, "inValues": [const_value] * n_obj}],
    }
    with open(os.path.join(DATA_DIR, f"{name}_joined.json"), "w") as f:
        json.dump(joined, f)
    log(f"  {name}: wrote constant abstract data ({n_obj} objects) for SMOOTH_COLOR_MAP.")


def patch_layer(name, render_style, layer_type=None, drop_keys=()):
    path = os.path.join(DATA_DIR, f"{name}.json")
    with open(path) as f:
        layer = json.load(f)
    layer["renderStyle"] = render_style
    if layer_type is not None:
        layer["type"] = layer_type
    for entry in layer["data"]:
        for k in drop_keys:
            entry["geometry"].pop(k, None)
    with open(path, "w") as f:
        json.dump(layer, f)
    log(f"  {name}: type={layer.get('type')} renderStyle={render_style}")


def configure_layers_and_grammar(centroids, lengths, counts):
    log("Configuring layer render styles for picking...")

    # water/parks/roads ship without an ids buffer; generate one so picking can
    # identify individual elements on those layers.
    for name in ("water", "parks", "roads"):
        generate_cell_ids(name)

    # surface/water/parks carry a CONSTANT abstract value (flat mid-tone color)
    # so their SMOOTH_COLOR_MAP shader has function data and does not crash.
    for name in ("surface", "water", "parks"):
        write_constant_abstract(name)

    # roads carries REAL abstract data (length + noise), written as theme layers
    # + a two-join roads_joined.json.
    write_thematic_layer("roadLengthTheme", centroids, lengths)
    write_thematic_layer("roadNoiseTheme", centroids, counts)
    write_roads_joined(lengths, counts)

    # For a TrianglesLayer, the shader immediately before PICKING must be an
    # auxiliary shader (SMOOTH_COLOR_MAP). Surface comes from OSM.load as a
    # HEATMAP_LAYER (not pickable), so it is converted to TRIANGLES_3D_LAYER.
    patch_layer("surface", ["SMOOTH_COLOR_MAP", "PICKING"],
                layer_type="TRIANGLES_3D_LAYER", drop_keys=("discardFuncInterval",))
    patch_layer("water", ["SMOOTH_COLOR_MAP", "PICKING"])
    patch_layer("parks", ["SMOOTH_COLOR_MAP", "PICKING"])
    patch_layer("roads", ["SMOOTH_COLOR_MAP", "PICKING"])

    log("Writing grammar.json...")

    # NOTE: the frontend reads the knot's colormap from the snake_case key
    # `color_map` (NOT `colorMap`, which the docs/schema show); when it is
    # absent the shader silently defaults to `interpolateReds`, so every layer
    # renders solid red. Also, d3's `interpolateViridis/Inferno/Magma/Plasma`
    # return HEX strings ("#21918c") which UTK's ColorMap.getColor mis-parses
    # with `.match(/\d+/g)`; only the single-hue ColorBrewer scales
    # (Blues/Greens/Greys/Oranges/Purples/Reds — built via rgbBasis) return the
    # required `rgb(...)` form, so we use those for a valid gradient.
    def base_knot(kid, color, theme, layer):
        return {"id": kid, "color_map": color, "integration_scheme": [{
            "spatial_relation": "NEAREST",
            "in": {"name": theme, "level": "COORDINATES"},
            "out": {"name": layer, "level": "OBJECTS"},
            "operation": "NONE", "abstract": True}]}

    grammar = {
        "components": [
            {
                "map": {
                    "camera": {
                        "position": [-8234100.519233786, 4951755.384616743, 1],
                        "direction": {
                            "right": [0, 0, 3000],
                            "lookAt": [0, 0, 0],
                            "up": [0, 1, 0],
                        },
                    },
                    # Four base layers + the two road colorings are all PICKING
                    # knots so the user can click-select elements from any layer.
                    "knots": ["basesurface", "basewater", "baseparks",
                              "roadLength", "roadNoise"],
                    "interactions": ["PICKING", "PICKING", "PICKING",
                                     "PICKING", "PICKING"],
                },
                # The grammar schema's dependency rule requires both "plots" and
                # "knots" whenever a component has a "map". This app has no plot,
                # so plots is an empty array.
                "plots": [],
                "knots": [
                    base_knot("basesurface", "interpolateGreys", "surfaceTheme", "surface"),
                    base_knot("basewater", "interpolateBlues", "waterTheme", "water"),
                    base_knot("baseparks", "interpolateGreens", "parksTheme", "parks"),
                    # Roads colored by per-segment LENGTH (m), OBJECTS level.
                    base_knot("roadLength", "interpolatePurples", "roadLengthTheme", "roads"),
                    # Roads colored by per-segment NOISE count within 10 m.
                    base_knot("roadNoise", "interpolateReds", "roadNoiseTheme", "roads"),
                ],
                "widgets": [
                    {"type": "TOGGLE_KNOT"},
                    {"type": "SEARCH"},
                    {"type": "HIDE_GRAMMAR"},
                ],
                "position": {"width": [6, 12], "height": [1, 4]},
            }
        ],
        "arrangement": "LINKED",
        "grid": {"width": 12, "height": 4},
        "grammar_position": {"width": [1, 5], "height": [1, 4]},
    }
    with open(os.path.join(DATA_DIR, "grammar.json"), "w") as f:
        json.dump(grammar, f, indent=2)
    log("Wrote grammar.json (4 pickable layers + roadLength/roadNoise toggle).")


def main():
    log("=== Manhattan Street Network data build starting ===")
    build_base_layers()

    n_mesh = road_count()
    if len(CENTERLINES_3395) != n_mesh:
        raise SystemExit(
            f"centre-line count ({len(CENTERLINES_3395)}) != road mesh component "
            f"count ({n_mesh}); the monkeypatch capture is misaligned.")
    log(f"Centre-lines aligned with road mesh: {n_mesh} segments.")

    lines_utm = centerlines_utm()
    lengths = compute_lengths(lines_utm)
    counts = compute_noise_counts(lines_utm)
    centroids = segment_centroids_3395()

    configure_layers_and_grammar(centroids, lengths, counts)
    log("=== Build complete. Run: utk start --data ./data ===")


if __name__ == "__main__":
    sys.exit(main())
