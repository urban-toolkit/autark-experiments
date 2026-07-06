#!/usr/bin/env python3
"""
Manhattan Noisescape — UTK data build pipeline.

Produces, under ./data, a UTK project that renders a 3D map of Manhattan
buildings colored by the number of noise events (311 complaints from
data/noise.csv) within a 500 m radius of each building.

Pipeline
--------
1. Base OSM layers (surface, parks, water, roads, buildings) for
   "Manhattan Island" are produced with ``utk.OSM.load(...)`` (see
   ``build_base_layers`` below). Because that triangulates ~10k building
   footprints in pure Python it takes ~2 h, so this script reuses a
   previously generated island build when one is already present in ./data.
2. Each building's centroid (EPSG:3395) is paired with the count of noise
   events within 500 m, written as the abstract layer ``noiseCount.json``.
3. ``noiseCount`` is joined onto the buildings layer with a NEAREST,
   per-vertex (COORDINATES3D) spatial relation — the same operation UTK's
   ``FilesInterface.attachAbstractToPhysical`` performs internally
   (scipy ``KDTree``) — producing ``buildings_joined.json``.
4. Layer render styles and ``grammar.json`` are written so every layer
   (surface, parks, water, roads, buildings) is pickable and buildings are
   colored by the joined noise count.

"Count within a radius" is intentionally precomputed here: UTK's grammar
can only express NEAREST (1:1) joins, not radius aggregation.
"""

import os
import json
import struct
import sys

import numpy as np
import pandas as pd
from pyproj import Transformer
from scipy.spatial import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
NOISE_CSV = os.path.abspath(
    os.path.join(HERE, "..", "..", "..", "..", "..", "data", "noise.csv")
)
RADIUS_M = 500.0  # noise-event search radius around each building, in meters


def log(msg):
    print(f"[build_data] {msg}", flush=True)


# --------------------------------------------------------------------------
# Step 1 — base OSM layers (documented; reused when already built)
# --------------------------------------------------------------------------
def build_base_layers():
    """Generate the five base layers for Manhattan Island with UTK.

    Only runs when ./data does not already contain a buildings layer, because
    the per-building triangulation is slow (~2 h for the whole island).
    """
    if os.path.exists(os.path.join(DATA_DIR, "buildings.json")):
        log("Base OSM layers already present in ./data — reusing them.")
        return

    log("Base OSM layers missing — downloading from OpenStreetMap via UTK...")
    # Public Overpass servers reject requests without a User-Agent (HTTP 406).
    import overpass
    overpass.API._headers = {
        "User-Agent": "utk-research/1.0",
        "Accept-Charset": "utf-8;q=0.7,*;q=0.7",
    }
    import utk

    os.makedirs(DATA_DIR, exist_ok=True)
    log("Loading OSM layers for 'Manhattan Island' (surface, parks, water, roads, buildings)...")
    uc = utk.OSM.load(
        "Manhattan Island",
        layers=["surface", "parks", "water", "roads", "buildings"],
    )
    uc.save(DATA_DIR)
    log("Base OSM layers saved to ./data.")


# --------------------------------------------------------------------------
# helpers for reading UTK binary geometry
# --------------------------------------------------------------------------
def read_doubles(path):
    with open(path, "rb") as f:
        return np.frombuffer(f.read(), dtype="<f8")


def building_centroids_3395():
    """Return (N,3) building centroids in EPSG:3395 from sectionFootprint."""
    log("Reading building footprints from buildings.json...")
    with open(os.path.join(DATA_DIR, "buildings.json")) as f:
        buildings = json.load(f)
    data = buildings["data"]
    centroids = np.empty((len(data), 3), dtype="f8")
    for i, b in enumerate(data):
        ring = b["geometry"]["sectionFootprint"][0]  # flat [x0,y0,x1,y1,...] in 3395
        pts = np.asarray(ring, dtype="f8").reshape(-1, 2)
        centroids[i, 0] = pts[:, 0].mean()
        centroids[i, 1] = pts[:, 1].mean()
        centroids[i, 2] = 0.0
    log(f"Computed {len(centroids)} building centroids (EPSG:3395).")
    return centroids


# --------------------------------------------------------------------------
# Step 2 — per-building noise counts within 500 m
# --------------------------------------------------------------------------
def compute_noise_counts(centroids_3395):
    log(f"Loading noise data from {NOISE_CSV} ...")
    df = pd.read_csv(NOISE_CSV, low_memory=False)
    log(f"Noise CSV loaded: {len(df)} rows.")
    df = df.dropna(subset=["Latitude", "Longitude"])
    log(f"Noise events with valid coordinates: {len(df)} (used as noise events).")

    # Project noise events (EPSG:4326) and building centroids (EPSG:3395) to a
    # metric CRS (UTM zone 18N) so the 500 m radius is true meters.
    to_utm_wgs = Transformer.from_crs(4326, 32618, always_xy=True)
    to_utm_merc = Transformer.from_crs(3395, 32618, always_xy=True)

    nx, ny = to_utm_wgs.transform(df["Longitude"].values, df["Latitude"].values)
    noise_utm = np.column_stack([nx, ny])
    log(f"Projected {len(noise_utm)} noise events to UTM 18N.")

    cx, cy = to_utm_merc.transform(centroids_3395[:, 0], centroids_3395[:, 1])
    cent_utm = np.column_stack([cx, cy])

    log(f"Counting noise events within {RADIUS_M:.0f} m of each building...")
    noise_tree = KDTree(noise_utm)
    neighbor_lists = noise_tree.query_ball_point(cent_utm, r=RADIUS_M)
    counts = np.fromiter((len(n) for n in neighbor_lists), dtype="f8", count=len(neighbor_lists))
    log(
        "Noise count per building — "
        f"min {counts.min():.0f}, max {counts.max():.0f}, mean {counts.mean():.2f}."
    )
    return counts


def write_noise_count_layer(centroids_3395, counts):
    coords = centroids_3395.reshape(-1).tolist()
    layer = {
        "id": "noiseCount",
        "coordinates": coords,
        "values": counts.tolist(),
    }
    path = os.path.join(DATA_DIR, "noiseCount.json")
    with open(path, "w") as f:
        json.dump(layer, f)
    log(f"Wrote thematic layer noiseCount.json ({len(counts)} centroids).")


# --------------------------------------------------------------------------
# Step 3 — NEAREST per-vertex join (UTK-faithful, scipy KDTree)
# --------------------------------------------------------------------------
def write_buildings_joined(centroids_3395, counts):
    log("Reading building vertices (buildings_coordinates.data)...")
    verts = read_doubles(os.path.join(DATA_DIR, "buildings_coordinates.data")).reshape(-1, 3)
    log(f"Building vertices: {len(verts)}.")

    log("Joining noiseCount onto buildings (NEAREST, COORDINATES3D)...")
    tree = KDTree(centroids_3395)
    _, idx = tree.query(verts, 1)  # nearest centroid per vertex
    in_values = counts[idx].tolist()

    joined = {
        "joinedLayers": [
            {
                "spatial_relation": "NEAREST",
                "layerId": "noiseCount",
                "outLevel": "COORDINATES3D",
                "inLevel": "COORDINATES3D",
                "abstract": True,
            }
        ],
        "joinedObjects": [{"joinedLayerIndex": 0, "inValues": in_values}],
    }
    path = os.path.join(DATA_DIR, "buildings_joined.json")
    with open(path, "w") as f:
        json.dump(joined, f)
    log(f"Wrote buildings_joined.json ({len(in_values)} per-vertex values).")


# --------------------------------------------------------------------------
# Step 4 — layer render styles + grammar (picking on all five layers)
# --------------------------------------------------------------------------
def generate_cell_ids(name):
    """Add a per-triangle ``ids`` buffer to a triangle layer that lacks one.

    UTK's PICKING shader identifies clickable cells through per-triangle ids
    (``<layer>_ids.data``, one uint32 per triangle, referenced as [start,size]
    from each data entry). OSM.load emits these for buildings/surface but not
    for water/parks/roads, so picking those layers would select nothing.

    Each id is stored as a component-local 0; the frontend offsets ids by the
    cumulative vertex count of preceding components, so giving every triangle
    in a data entry the same local id makes that whole entry (one water body /
    park / road segment) a single selectable element with a globally unique id.
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
        _, n_indices = entry["geometry"]["indices"]  # [start, size]
        n_tri = n_indices // 3
        entry["geometry"]["ids"] = [pos, n_tri]
        ids_flat.extend([0] * n_tri)  # local id 0 -> unique per entry after offset
        pos += n_tri
    with open(os.path.join(DATA_DIR, f"{name}_ids.data"), "wb") as f:
        f.write(struct.pack(f"<{len(ids_flat)}I", *ids_flat))
    with open(path, "w") as f:
        json.dump(layer, f)
    log(f"  {name}: generated {len(ids_flat)} per-triangle ids "
        f"({len(layer['data'])} selectable objects).")


def write_constant_abstract(name, const_value=1.0):
    """Attach a constant OBJECTS-level abstract value to a base triangle layer.

    A pickable TrianglesLayer is rendered by `ShaderSmoothColorMap`, whose
    `updateShaderData` does `d3.extent(this._function[0])` with NO guard for an
    empty function array. A *pure* knot (no abstract data) leaves that array
    empty, so the shader crashes ("undefined is not iterable"). We therefore
    give each base layer a real per-object abstract value via a precomputed
    OBJECTS-level join:
      - `<name>Theme.json`  : an abstract layer (one centroid + value per object)
      - `<name>_joined.json`: joinedLayers/joinedObjects with one inValue per
        object; the frontend expands it to per-coordinate and feeds the shader.
    The value is constant, so d3's degenerate-domain scale maps every element to
    0.5 -> a single flat `colorMap(0.5)` mid-tone color per layer.
    """
    path = os.path.join(DATA_DIR, f"{name}.json")
    with open(path) as f:
        layer = json.load(f)
    data = layer["data"]
    n_obj = len(data)

    # per-object centroids (EPSG:3395) from each entry's [start,size] coords
    coords = read_doubles(os.path.join(DATA_DIR, f"{name}_coordinates.data"))
    theme_coords = []
    for entry in data:
        start, size = entry["geometry"]["coordinates"]  # size = number of doubles (3 per vertex)
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


def configure_layers_and_grammar():
    log("Configuring layer render styles for picking...")

    # water/parks/roads ship without an ids buffer; generate one so picking can
    # identify individual elements on those layers.
    for name in ("water", "parks", "roads"):
        generate_cell_ids(name)

    # Every base triangle layer needs abstract function data so its
    # SMOOTH_COLOR_MAP shader does not crash (see write_constant_abstract).
    for name in ("surface", "water", "parks", "roads"):
        write_constant_abstract(name)

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

    # For a TrianglesLayer, the shader immediately before PICKING must be an
    # auxiliary shader (SMOOTH_COLOR_MAP); FLAT_COLOR is NOT a valid auxiliary
    # and makes the frontend throw at load. So the four base layers use
    # SMOOTH_COLOR_MAP (which also renders them as a flat colorMap color) + PICKING.
    # Surface additionally comes from OSM.load as a HEATMAP_LAYER, which is not
    # pickable, so it is converted to a TRIANGLES_3D_LAYER.
    patch_layer("surface", ["SMOOTH_COLOR_MAP", "PICKING"], layer_type="TRIANGLES_3D_LAYER",
                drop_keys=("discardFuncInterval",))
    patch_layer("water", ["SMOOTH_COLOR_MAP", "PICKING"])
    patch_layer("parks", ["SMOOTH_COLOR_MAP", "PICKING"])
    patch_layer("roads", ["SMOOTH_COLOR_MAP", "PICKING"])
    # Buildings are colored by the joined noise count + pickable (SMOOTH_COLOR_MAP_TEX
    # is the BuildingsLayer auxiliary shader for PICKING).
    patch_layer("buildings", ["SMOOTH_COLOR_MAP_TEX", "PICKING"])

    log("Writing grammar.json...")
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
                    # Every layer is a knot with a PICKING interaction so the
                    # user can click-select elements from any layer.
                    "knots": ["basesurface", "basewater", "baseparks", "baseroads", "noiseImpact"],
                    "interactions": ["PICKING", "PICKING", "PICKING", "PICKING", "PICKING"],
                },
                "plots": [],
                # Base-layer knots carry a CONSTANT abstract value (an OBJECTS-level
                # join to <layer>Theme) so the SMOOTH_COLOR_MAP shader has function
                # data and does not crash. Constant values render each layer as a flat
                # color_map(0.5) mid-tone (grey ground, blue water, green parks, purple
                # roads). TWO frontend gotchas encoded here:
                #  1. The knot colorMap field the frontend reads is snake_case
                #     `color_map`; `colorMap` is silently ignored -> default
                #     `interpolateReds` -> everything renders red.
                #  2. The frontend's getColor parses the d3 interpolator output with
                #     /\d+/g, which only works for maps that return `rgb(...)` strings.
                #     HEX-returning maps (inferno/viridis/magma/plasma/turbo) yield a
                #     malformed (short) colormap texture -> "texImage2D: ArrayBufferView
                #     not big enough" -> that layer never colors. So every color_map
                #     here is an rgb()-returning map (Greys/Blues/Greens/Purples/YlOrRd).
                "knots": [
                    {"id": "basesurface", "color_map": "interpolateGreys",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "surfaceTheme", "level": "COORDINATES"},
                         "out": {"name": "surface", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
                    {"id": "basewater", "color_map": "interpolateBlues",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "waterTheme", "level": "COORDINATES"},
                         "out": {"name": "water", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
                    {"id": "baseparks", "color_map": "interpolateGreens",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "parksTheme", "level": "COORDINATES"},
                         "out": {"name": "parks", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
                    {"id": "baseroads", "color_map": "interpolatePurples",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "roadsTheme", "level": "COORDINATES"},
                         "out": {"name": "roads", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
                    {
                        # buildings: YlOrRd (yellow=quiet -> red=loud) is an rgb()-returning
                        # perceptual heat gradient (see gotcha #2 above); inferno was broken.
                        "id": "noiseImpact",
                        "color_map": "interpolateYlOrRd",
                        "integration_scheme": [
                            {
                                "spatial_relation": "NEAREST",
                                "in": {"name": "noiseCount", "level": "COORDINATES3D"},
                                "out": {"name": "buildings", "level": "COORDINATES3D"},
                                "operation": "NONE",
                                "abstract": True,
                            }
                        ],
                    },
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
    log("Wrote grammar.json with 5 pickable knots (noiseImpact colors buildings).")


def main():
    log("=== Manhattan Noisescape data build starting ===")
    build_base_layers()
    centroids = building_centroids_3395()
    counts = compute_noise_counts(centroids)
    write_noise_count_layer(centroids, counts)
    write_buildings_joined(centroids, counts)
    configure_layers_and_grammar()
    log("=== Build complete. Run: utk start --data ./data ===")


if __name__ == "__main__":
    sys.exit(main())
