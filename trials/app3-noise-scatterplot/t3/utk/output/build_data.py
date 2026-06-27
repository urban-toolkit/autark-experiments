#!/usr/bin/env python3
"""
Manhattan Noisescape — UTK data build pipeline (app3: noise scatterplot).

Produces, under ./data, a UTK project that:
  * renders a 3D map of Manhattan where every building is colored by the number
    of 311 noise complaints (data/noise.csv) within a 500 m radius of it, and
  * shows a LINKED scatterplot — one circle per building — with the noise count
    on x and the building footprint area (m^2) on y. Clicking points in the
    scatterplot highlights the corresponding buildings on the map.
  * lets the user pick (click-select) elements on any of the five base layers
    (surface, parks, water, roads, buildings); the clicked element turns blue.

Pipeline
--------
1. Base OSM layers (surface, parks, water, roads, buildings) for
   "Manhattan Island" are produced once with ``utk.OSM.load(...)`` (see
   ``build_base_layers``). Triangulating ~10k building footprints in pure
   Python takes ~2 h, so this script reuses a previously generated island
   build when one is already present in ./data (the common case here — the
   physical layers were copied from the app2 build).
2. Each building's footprint centroid (EPSG:3395) is paired with
     (a) the count of noise events within 500 m  -> noiseCount.json
     (b) its footprint area in m^2               -> buildingArea.json
   Areas are computed by the shoelace formula on the footprint reprojected
   3395 -> 32618 (UTM 18N), because EPSG:3395 area is distorted ~1.74x at 40.7N.
3. The noise count is joined onto the buildings layer at the OBJECTS level
   (one value per building) in buildings_joined.json. The area is joined onto a
   separate lightweight helper layer (``areaPoints`` — one tiny triangle per
   building) instead of the buildings mesh: an OBJECTS knot on the ~7.4M-vertex
   buildings layer makes the frontend materialize several per-vertex JS arrays,
   and a second such knot exhausts browser memory on load (the original crash).
   Both layers emit one component per building in the same order, so the
   scatterplot reads one aligned row per building (noise x, area y).
4. grammar.json wires:
     * five pickable base-layer knots (color changes on click),
     * the OBJECTS-level ``noiseImpact`` knot which colors the buildings, feeds
       the scatter x axis, and drives CLICK-to-highlight (it must be the rendered
       map knot so the highlight is visible on the map),
     * the OBJECTS-level ``areaAxis`` knot on the lightweight ``areaPoints``
       layer which feeds the scatter y axis,
     * the LINKED scatterplot with a CLICK interaction.

Notes on UTK limitations (documented for the reader):
  * "Count within a radius" is not expressible in UTK's grammar (only NEAREST,
    1:1 joins), so it is precomputed here in Python.
  * The grammar's plot ``interaction`` of BRUSH raises "not implemented yet" in
    this UTK build, so brushing is realized with CLICK (per-point selection),
    which is the supported way to highlight buildings from the plot.
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


def building_footprints_3395():
    """Return (centroids (N,3), footprint rings) in EPSG:3395.

    Each ring is an (M,2) array of the building's outer footprint vertices,
    taken from buildings.json ``geometry.sectionFootprint[0]`` (a flat list
    [x0,y0,x1,y1,...] in EPSG:3395).
    """
    log("Reading building footprints from buildings.json...")
    with open(os.path.join(DATA_DIR, "buildings.json")) as f:
        buildings = json.load(f)
    data = buildings["data"]
    centroids = np.empty((len(data), 3), dtype="f8")
    rings = []
    for i, b in enumerate(data):
        ring = b["geometry"]["sectionFootprint"][0]
        pts = np.asarray(ring, dtype="f8").reshape(-1, 2)
        rings.append(pts)
        centroids[i, 0] = pts[:, 0].mean()
        centroids[i, 1] = pts[:, 1].mean()
        centroids[i, 2] = 0.0
    log(f"Read {len(centroids)} building footprints (EPSG:3395).")
    return centroids, rings


# --------------------------------------------------------------------------
# Step 2a — per-building noise counts within 500 m
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
    counts = np.fromiter(
        (len(n) for n in neighbor_lists), dtype="f8", count=len(neighbor_lists)
    )
    log(
        "Noise count per building — "
        f"min {counts.min():.0f}, max {counts.max():.0f}, mean {counts.mean():.2f}."
    )
    return counts


# --------------------------------------------------------------------------
# Step 2b — per-building footprint area (m^2)
# --------------------------------------------------------------------------
def compute_building_areas(rings_3395):
    """Shoelace footprint area in m^2, computed in EPSG:32618 (true meters)."""
    log("Computing building footprint areas (shoelace, EPSG:32618)...")
    to_utm_merc = Transformer.from_crs(3395, 32618, always_xy=True)
    areas = np.empty(len(rings_3395), dtype="f8")
    for i, ring in enumerate(rings_3395):
        ux, uy = to_utm_merc.transform(ring[:, 0], ring[:, 1])
        # shoelace; abs handles ring winding direction
        areas[i] = 0.5 * abs(
            np.dot(ux, np.roll(uy, -1)) - np.dot(uy, np.roll(ux, -1))
        )
    log(
        "Building area (m^2) — "
        f"min {areas.min():.1f}, max {areas.max():.1f}, mean {areas.mean():.1f}."
    )
    return areas


def write_thematic_layer(name, centroids_3395, values):
    """Write an abstract thematic layer (one centroid + value per building)."""
    layer = {
        "id": name,
        "coordinates": centroids_3395.reshape(-1).tolist(),
        "values": values.tolist(),
    }
    with open(os.path.join(DATA_DIR, f"{name}.json"), "w") as f:
        json.dump(layer, f)
    log(f"Wrote thematic layer {name}.json ({len(values)} buildings).")


# --------------------------------------------------------------------------
# Step 3 — OBJECTS-level joins (one value per building) for map + scatterplot
# --------------------------------------------------------------------------
def write_buildings_joined(counts):
    """Join the noise count onto buildings at the OBJECTS level (one per building).

    The length must equal the number of building mesh components. The frontend
    expands each object's single value across that object's vertices when
    rendering and when feeding the plot.

    Only the noise count is joined here. The footprint *area* is intentionally
    kept off the buildings layer (see ``build_area_axis_layer``): an OBJECTS knot
    on the ~7.4M-vertex buildings mesh forces the frontend to materialize several
    per-vertex JS arrays, and a second such knot exhausts browser memory on load.
    """
    n = len(counts)
    log(f"Writing OBJECTS-level noise join for {n} buildings...")
    joined = {
        "joinedLayers": [
            {
                "spatial_relation": "NEAREST",
                "layerId": "noiseCount",
                "outLevel": "OBJECTS",
                "inLevel": "COORDINATES",
                "abstract": True,
            },
        ],
        "joinedObjects": [
            {"joinedLayerIndex": 0, "inValues": counts.tolist()},
        ],
    }
    with open(os.path.join(DATA_DIR, "buildings_joined.json"), "w") as f:
        json.dump(joined, f)
    log(f"Wrote buildings_joined.json (1 OBJECTS join, {n} values).")


# --------------------------------------------------------------------------
# Step 3b — lightweight area-axis layer (scatterplot y), decoupled from mesh
# --------------------------------------------------------------------------
def build_area_axis_layer(centroids_3395, areas):
    """Build a LIGHTWEIGHT helper layer (one tiny triangle per building) that
    carries the footprint area, used *only* as the scatterplot's y axis.

    Why not keep the area on the buildings layer? At the OBJECTS level the
    frontend expands a knot's value across *every vertex* of its output layer and,
    when building the plot, materializes several per-vertex JS arrays
    (coordinates / function / highlights) for each plot knot. The buildings mesh
    has ~7.4M vertices, so a second buildings knot (area) roughly doubles those
    already-huge transient structures and crashes the browser tab with an
    out-of-memory error while loading.

    Putting the area axis on a ~30k-vertex helper layer (3 vertices per building)
    keeps the scatterplot one-circle-per-building while making that expansion
    negligible. The buildings' own ``noiseImpact`` knot remains the map color,
    the scatter x axis, and the CLICK-to-highlight driver (the plot's click
    handler highlights every plot knot's element by index, so the building
    highlight comes from ``noiseImpact``, not from this helper layer).

    The helper layer is referenced only by the (non-map) ``areaAxis`` knot, so it
    is loaded but never drawn. Its components are emitted in buildings.json order,
    so the scatter rows align 1:1 with the building (noise) rows — required
    because the plot merges the two knots by positional zip.
    """
    n = len(centroids_3395)
    log(f"Building lightweight area-axis layer ({n} triangles, one per building)...")

    # in/abstract theme: one centroid + area value per building
    write_thematic_layer("areaTheme", centroids_3395, areas)

    # physical helper geometry: a tiny (1 m) triangle at each building centroid
    coords = np.empty((n, 3, 3), dtype="<f8")
    coords[:, 0, :2] = centroids_3395[:, :2]
    coords[:, 1, :2] = centroids_3395[:, :2] + [1.0, 0.0]
    coords[:, 2, :2] = centroids_3395[:, :2] + [0.0, 1.0]
    coords[:, :, 2] = 0.0
    coords.tofile(os.path.join(DATA_DIR, "areaPoints_coordinates.data"))

    # component-local indices (0,1,2) and one id per triangle
    np.tile(np.array([0, 1, 2], dtype="<u4"), n).tofile(
        os.path.join(DATA_DIR, "areaPoints_indices.data"))
    np.zeros(n, dtype="<u4").tofile(os.path.join(DATA_DIR, "areaPoints_ids.data"))

    # [start, size]: coordinates/indices/ids are cumulative across components,
    # sizes are in doubles (9 = 3 verts * 3) / index count (3) / id count (1).
    data = [{"geometry": {"coordinates": [i * 9, 9],
                          "indices": [i * 3, 3],
                          "ids": [i, 1]}} for i in range(n)]
    layer = {"id": "areaPoints", "type": "TRIANGLES_3D_LAYER",
             "renderStyle": ["SMOOTH_COLOR_MAP"], "styleKey": "surface",
             "data": data}
    with open(os.path.join(DATA_DIR, "areaPoints.json"), "w") as f:
        json.dump(layer, f)

    joined = {
        "joinedLayers": [{
            "spatial_relation": "NEAREST", "layerId": "areaTheme",
            "outLevel": "OBJECTS", "inLevel": "COORDINATES", "abstract": True,
        }],
        "joinedObjects": [{"joinedLayerIndex": 0, "inValues": areas.tolist()}],
    }
    with open(os.path.join(DATA_DIR, "areaPoints_joined.json"), "w") as f:
        json.dump(joined, f)

    # Remove the stale buildings-area theme from the earlier (OOM) build, if any.
    stale = os.path.join(DATA_DIR, "buildingArea.json")
    if os.path.exists(stale):
        os.remove(stale)
        log("Removed stale buildingArea.json (area moved to areaPoints layer).")
    log(f"Wrote areaPoints layer (+areaTheme +join): {n} buildings -> {n * 3} vertices.")


# --------------------------------------------------------------------------
# Step 4 — render styles + grammar (picking on 5 layers + scatterplot)
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
    OBJECTS-level join (``<name>Theme.json`` + ``<name>_joined.json``). The value
    is constant, so d3's degenerate-domain scale maps every element to 0.5 -> a
    single flat ``colorMap(0.5)`` mid-tone color per layer.
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
    # auxiliary shader (SMOOTH_COLOR_MAP). Surface comes from OSM.load as a
    # HEATMAP_LAYER (not pickable), so it is converted to TRIANGLES_3D_LAYER.
    patch_layer("surface", ["SMOOTH_COLOR_MAP", "PICKING"], layer_type="TRIANGLES_3D_LAYER",
                drop_keys=("discardFuncInterval",))
    patch_layer("water", ["SMOOTH_COLOR_MAP", "PICKING"])
    patch_layer("parks", ["SMOOTH_COLOR_MAP", "PICKING"])
    patch_layer("roads", ["SMOOTH_COLOR_MAP", "PICKING"])
    # Buildings: colored by the OBJECTS-level noise count + pickable
    # (SMOOTH_COLOR_MAP_TEX is the BuildingsLayer auxiliary shader for PICKING).
    patch_layer("buildings", ["SMOOTH_COLOR_MAP_TEX", "PICKING"])

    log("Writing grammar.json...")
    scatter_plot = {
        "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
        "title": "Buildings: noise complaints (within 500 m) vs. footprint area",
        "width": 280,
        "height": 240,
        "background": "white",
        "mark": {"type": "circle", "size": 18, "opacity": 0.55},
        "encoding": {
            "x": {
                "field": "noiseImpact_abstract",
                "type": "quantitative",
                "title": "Noise complaints within 500 m",
            },
            "y": {
                "field": "areaAxis_abstract",
                "type": "quantitative",
                "title": "Building footprint area (m^2)",
            },
            "color": {
                # Selected (clicked) buildings turn red; the rest stay blue.
                "condition": {
                    "test": "datum.noiseImpact_highlight == true",
                    "value": "#d62728",
                },
                "value": "#1f77b4",
            },
            "order": {"field": "noiseImpact_highlight", "type": "nominal"},
        },
    }
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
                    # Every base layer + the building noise knot is a PICKING knot
                    # so the user can click-select elements from any layer.
                    "knots": ["basesurface", "basewater", "baseparks", "baseroads", "noiseImpact"],
                    "interactions": ["PICKING", "PICKING", "PICKING", "PICKING", "PICKING"],
                },
                "plots": [
                    {
                        "name": "Noise vs. area",
                        "plot": scatter_plot,
                        # noiseImpact (x) is the rendered map knot, so CLICK
                        # highlight from the plot is visible on the buildings;
                        # areaAxis (y) lives on the lightweight areaPoints layer.
                        "knots": ["noiseImpact", "areaAxis"],
                        "arrangement": "LINKED",
                        "interaction": "CLICK",
                    }
                ],
                # Base-layer knots carry a CONSTANT abstract value so the
                # SMOOTH_COLOR_MAP shader has function data (flat mid-tone color).
                "knots": [
                    {"id": "basesurface", "colorMap": "interpolateGreys",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "surfaceTheme", "level": "COORDINATES"},
                         "out": {"name": "surface", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
                    {"id": "basewater", "colorMap": "interpolateBlues",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "waterTheme", "level": "COORDINATES"},
                         "out": {"name": "water", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
                    {"id": "baseparks", "colorMap": "interpolateGreens",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "parksTheme", "level": "COORDINATES"},
                         "out": {"name": "parks", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
                    {"id": "baseroads", "colorMap": "interpolateGreys",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "roadsTheme", "level": "COORDINATES"},
                         "out": {"name": "roads", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
                    # Per-building noise count (OBJECTS): colors buildings AND
                    # is the scatter x axis.
                    {"id": "noiseImpact", "colorMap": "interpolateInferno",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "noiseCount", "level": "COORDINATES"},
                         "out": {"name": "buildings", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
                    # Per-building footprint area (OBJECTS): scatter y axis only,
                    # carried by the lightweight areaPoints layer (NOT buildings)
                    # so the plot does not expand the 7.4M-vertex mesh again.
                    {"id": "areaAxis", "colorMap": "interpolateViridis",
                     "integration_scheme": [{
                         "spatial_relation": "NEAREST",
                         "in": {"name": "areaTheme", "level": "COORDINATES"},
                         "out": {"name": "areaPoints", "level": "OBJECTS"},
                         "operation": "NONE", "abstract": True}]},
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
    log("Wrote grammar.json (5 pickable knots + LINKED noise/area scatterplot).")


def main():
    log("=== Manhattan Noisescape (scatterplot) data build starting ===")
    build_base_layers()
    centroids, rings = building_footprints_3395()
    counts = compute_noise_counts(centroids)
    areas = compute_building_areas(rings)
    write_thematic_layer("noiseCount", centroids, counts)
    write_buildings_joined(counts)
    build_area_axis_layer(centroids, areas)
    configure_layers_and_grammar()
    log("=== Build complete. Run: utk start --data ./data ===")


if __name__ == "__main__":
    sys.exit(main())
