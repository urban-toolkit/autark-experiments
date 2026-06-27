#!/usr/bin/env python3
"""
build_data.py
=============

Backend data-preparation step for the *Manhattan Buildings - Subway Accessibility
with full-layer picking* UTK visual-analytics application (app5).

This app extends the plain subway-accessibility map with **picking on every
loaded layer** (surface, parks, water, roads, buildings): clicking any element
highlights it (turns it blue). Buildings are additionally coloured by the number
of subway stations within 500 m.

Everything geometric is produced with the UTK Python API (``utk.OSM.load``,
``utk.thematic_from_df``).  The script has two phases:

  PHASE A - physical layers (only if not already present in ./data)
  ----------------------------------------------------------------
    1. Resolve the *Manhattan Island* polygon (restricts every Overpass query to
       the island, never a broader area).
    2. Download surface, parks, water, roads, buildings via ``utk.OSM.load``.
    3. Load the subway-station CSV, count stations within 500 m of every building
       (true metres in EPSG:32618), and write the ``subwayCount`` thematic layer.
    4. Pre-compute the building<->subwayCount NEAREST join (vectorised KD-tree)
       into ``buildings_joined.json``.

  PHASE B - picking augmentation (always runs)
  --------------------------------------------
    5. Make surface/parks/water/roads pickable:
         * renderStyle -> ["SMOOTH_COLOR_MAP", "PICKING"]
           (PICKING needs a valid auxiliary triangle shader in front of it)
         * surface: HEATMAP_LAYER -> TRIANGLES_3D_LAYER (drop discardFuncInterval)
         * generate a per-triangle, all-zero, component-local ``ids`` buffer for
           water/parks/roads (OSM.load only emits ids for buildings + surface),
           so each OSM feature becomes one globally-unique selectable cell.
         * give each base layer a CONSTANT OBJECTS-level abstract join
           (``<layer>Theme.json`` + ``<layer>_joined.json``).  A pickable triangle
           layer crashes at load if its colour function is empty, so a constant
           join is mandatory; a degenerate colour domain renders every element a
           flat natural tone (grey ground, blue water, green parks).
    6. Emit grammar.json: 5 knots (one per layer), every map interaction = PICKING.

If ./data already contains the physical layers (e.g. copied from app1's full
island build), PHASE A is skipped and only the fast PHASE B runs.

All major operations are logged so the pipeline can be traced from the console.
"""

import os
import sys
import json
import time
import struct
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("build_data")

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
DATA_DIR = os.path.join(HERE, "data")

SUBWAY_CSV = "/home/lucas/projects/master-degree/autark-experiments/data/subway_manhattan_clean.csv"
RADIUS_M = 500.0
USER_AGENT = "utk-subway-picking/1.0 (academic research; OSM Overpass)"

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# All five layers the app renders + makes pickable. Buildings must be last.
LAYERS = ["water", "parks", "roads", "surface", "buildings"]
PREFETCH_LAYERS = ["water", "parks", "roads", "buildings"]  # surface is local

# Base (non-building) layers: pickable triangle layers that get a constant
# colour + a per-triangle ids buffer. (id, colorMap)
BASE_LAYERS = {
    "surface": "interpolateGreys",   # grey ground
    "water":   "interpolateBlues",   # blue
    "parks":   "interpolateGreens",  # green
    "roads":   "interpolateGreys",   # grey street network
}

BUILDINGS_COLORMAP = "interpolateViridis"


# =========================================================================== #
# PHASE A helpers (only used for a from-scratch OSM build)                      #
# =========================================================================== #
def _phase_a_build():
    """Full OSM build: physical layers + subwayCount + buildings_joined."""
    import overpass
    overpass.API._headers = {
        "Accept-Charset": "utf-8;q=0.7,*;q=0.7",
        "User-Agent": USER_AGENT,
    }
    import requests
    import numpy as np
    import pandas as pd
    from pyproj import Transformer
    from scipy.spatial import cKDTree
    from shapely.geometry import MultiPolygon
    import utk
    from utk.osm import OSM
    from utk import cache as utk_cache

    # ---- Manhattan Island polygon ---------------------------------------- #
    import osmnx as ox
    log.info("Geocoding 'Manhattan Island' boundary from OSM ...")
    gdf = ox.geocode_to_gdf("Manhattan Island")
    geom = gdf.geometry.iloc[0]
    if isinstance(geom, MultiPolygon):
        geom = max(geom.geoms, key=lambda p: p.area)
    simplified = geom.simplify(0.0008)
    polygon = [(lat, lon) for lon, lat in simplified.exterior.coords]
    log.info("Manhattan Island polygon: %d vertices", len(polygon))

    # ---- resilient Overpass prefetch into UTK cache ---------------------- #
    def _fetch(query, max_attempts=6):
        headers = {"User-Agent": USER_AGENT}
        last = None
        for attempt in range(max_attempts):
            ep = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
            try:
                log.info("    Overpass POST (%d/%d) -> %s", attempt + 1, max_attempts, ep)
                r = requests.post(ep, data={"data": query}, headers=headers, timeout=300)
                if r.status_code == 200:
                    payload = json.loads(r.text)
                    if "elements" not in payload:
                        raise ValueError("response missing 'elements'")
                    log.info("    Overpass OK: %.2f MB, %d elements",
                             len(r.content) / 1e6, len(payload["elements"]))
                    return payload
                log.warning("    Overpass HTTP %d from %s", r.status_code, ep)
                last = RuntimeError("HTTP %d" % r.status_code)
            except Exception as e:  # noqa: BLE001
                log.warning("    Overpass error from %s: %r", ep, e)
                last = e
            backoff = min(60, 5 * (2 ** attempt))
            log.info("    backing off %ds ...", backoff)
            time.sleep(backoff)
        raise RuntimeError("Overpass prefetch failed: %r" % last)

    flat = [c for pt in polygon for c in pt]
    for layer in PREFETCH_LAYERS:
        query = OSM.build_osm_query(flat, "geom", False, [layer])
        if utk_cache._load_osm_from_cache(query) is not None:
            log.info("Layer '%s': already cached.", layer)
            continue
        log.info("Layer '%s': fetching from Overpass (island poly) ...", layer)
        utk_cache._save_osm_to_cache(query, _fetch(query))
        time.sleep(2)

    # ---- load + save layers ---------------------------------------------- #
    log.info("Loading OSM layers via utk.OSM.load: %s", LAYERS)
    t0 = time.time()
    uc = utk.OSM.load(polygon, layers=LAYERS)
    log.info("OSM layers loaded in %.1fs", time.time() - t0)
    uc.save(DATA_DIR, includeGrammar=False)
    log.info("Physical layers saved to %s", DATA_DIR)

    # ---- subway counts within 500 m -------------------------------------- #
    b_idx = next(i for i, j in enumerate(uc.layers["json"]) if j["id"] == "buildings")
    buildings = uc.layers["gdf"]["objects"][b_idx]
    if buildings.crs is None:
        buildings = buildings.set_crs(3395)
    log.info("Buildings: %d footprints", len(buildings))

    log.info("Loading subway stations from %s", SUBWAY_CSV)
    stations = pd.read_csv(SUBWAY_CSV)
    log.info("Subway stations loaded: %d rows", len(stations))

    b_metric = buildings.to_crs(32618)
    b_points = b_metric.geometry.representative_point()
    to_utm = Transformer.from_crs(4326, 32618, always_xy=True)
    sx, sy = to_utm.transform(stations["GTFS Longitude"].values,
                              stations["GTFS Latitude"].values)
    log.info("Spatial join started: stations within %.0f m of each building.", RADIUS_M)
    tree = cKDTree(np.column_stack([sx, sy]))
    bx = np.array([p.x for p in b_points])
    by = np.array([p.y for p in b_points])
    neigh = tree.query_ball_point(np.column_stack([bx, by]), r=RADIUS_M)
    counts = np.array([len(n) for n in neigh], dtype=int)
    log.info("Spatial join complete: %d buildings; counts min=%d max=%d mean=%.2f",
             len(counts), counts.min(), counts.max(), counts.mean())

    b_pts_4326 = buildings.to_crs(4326).geometry.representative_point()
    thematic_df = pd.DataFrame({
        "lat": [p.y for p in b_pts_4326],
        "lon": [p.x for p in b_pts_4326],
        "count": counts,
    })
    utk.thematic_from_df(thematic_df, os.path.join(DATA_DIR, "subwayCount.json"),
                         latitude_column="lat", longitude_column="lon",
                         coordinates_projection="4326", value_column="count")
    log.info("Thematic layer 'subwayCount' written.")

    # ---- precompute building<->subwayCount NEAREST join ------------------ #
    raw = np.frombuffer(open(os.path.join(DATA_DIR, "buildings_coordinates.data"), "rb").read(),
                        dtype="<f8")
    b_xyz = raw.reshape(-1, 3)
    sub = json.load(open(os.path.join(DATA_DIR, "subwayCount.json")))
    s_xyz = np.asarray(sub["coordinates"], dtype="<f8").reshape(-1, 3)
    s_val = np.asarray(sub["values"], dtype=float)
    _, idx = cKDTree(s_xyz).query(b_xyz, k=1, workers=-1)
    in_values = s_val[idx]
    joined = {
        "joinedLayers": [{"spatial_relation": "NEAREST", "layerId": "subwayCount",
                          "outLevel": "COORDINATES3D", "inLevel": "COORDINATES3D",
                          "abstract": True}],
        "joinedObjects": [{"joinedLayerIndex": 0,
                           "inValues": [round(float(v), 1) for v in in_values]}],
    }
    with open(os.path.join(DATA_DIR, "buildings_joined.json"), "w") as f:
        json.dump(joined, f)
    log.info("buildings_joined.json written (%d vertices).", len(in_values))


def _have_physical_layers():
    required = [
        "buildings.json", "buildings_coordinates.data", "buildings_joined.json",
        "subwayCount.json",
        "surface.json", "water.json", "parks.json", "roads.json",
        "water_coordinates.data", "parks_coordinates.data", "roads_coordinates.data",
    ]
    return all(os.path.exists(os.path.join(DATA_DIR, f)) for f in required)


# =========================================================================== #
# PHASE B - picking augmentation                                               #
# =========================================================================== #
def _augment_layer_for_picking(layer):
    """Flip render style, generate ids, and write the constant colour join."""
    path = os.path.join(DATA_DIR, "%s.json" % layer)
    j = json.load(open(path))

    # 1) make it a pickable triangle layer ---------------------------------- #
    if j["type"] == "HEATMAP_LAYER":
        log.info("  [%s] HEATMAP_LAYER -> TRIANGLES_3D_LAYER", layer)
        j["type"] = "TRIANGLES_3D_LAYER"
        # discardFuncInterval is a heatmap-only field; drop it on every feature.
        for d in j["data"]:
            d["geometry"].pop("discardFuncInterval", None)
    j["renderStyle"] = ["SMOOTH_COLOR_MAP", "PICKING"]

    # 2) per-triangle, component-local, all-zero ids buffer ----------------- #
    #    (each OSM feature -> one globally-unique selectable cell)
    ids_path = os.path.join(DATA_DIR, "%s_ids.data" % layer)
    if not os.path.exists(ids_path):
        cum = 0
        total_tri = 0
        for d in j["data"]:
            n_idx = d["geometry"]["indices"][1]
            n_tri = n_idx // 3
            d["geometry"]["ids"] = [cum, n_tri]
            cum += n_tri
            total_tri += n_tri
        with open(ids_path, "wb") as f:
            f.write(struct.pack("<%dI" % total_tri, *([0] * total_tri)))
        log.info("  [%s] generated %s (%d triangles, all-zero local ids)",
                 layer, os.path.basename(ids_path), total_tri)
    else:
        log.info("  [%s] ids buffer already present, keeping it", layer)

    n_objects = len(j["data"])
    with open(path, "w") as f:
        json.dump(j, f)

    # 3) constant OBJECTS-level abstract colour join ------------------------ #
    theme = {
        "id": "%sTheme" % layer,
        "coordinates": [0.0, 0.0, 0.0] * n_objects,  # referenced only by the join match
        "values": [1.0] * n_objects,
    }
    with open(os.path.join(DATA_DIR, "%sTheme.json" % layer), "w") as f:
        json.dump(theme, f)

    joined = {
        "joinedLayers": [{
            "spatial_relation": "NEAREST",
            "layerId": "%sTheme" % layer,
            "outLevel": "OBJECTS",
            "inLevel": "COORDINATES",
            "abstract": True,
        }],
        "joinedObjects": [{
            "joinedLayerIndex": 0,
            "inValues": [1.0] * n_objects,  # constant -> degenerate domain -> flat tone
        }],
    }
    with open(os.path.join(DATA_DIR, "%s_joined.json" % layer), "w") as f:
        json.dump(joined, f)
    log.info("  [%s] wrote %sTheme.json + %s_joined.json (%d objects)",
             layer, layer, layer, n_objects)


def _augment_all_for_picking():
    log.info("PHASE B: making all base layers pickable ...")
    for layer in BASE_LAYERS:
        _augment_layer_for_picking(layer)
    # sanity: buildings is already pickable from the OSM build
    b = json.load(open(os.path.join(DATA_DIR, "buildings.json")))
    if "PICKING" not in b["renderStyle"]:
        b["renderStyle"] = ["SMOOTH_COLOR_MAP_TEX", "PICKING"]
        with open(os.path.join(DATA_DIR, "buildings.json"), "w") as f:
            json.dump(b, f)
        log.info("  [buildings] added PICKING to renderStyle")
    else:
        log.info("  [buildings] already pickable (%s)", b["renderStyle"])


# =========================================================================== #
# grammar.json                                                                 #
# =========================================================================== #
def write_grammar():
    # Camera centred on Manhattan (same framing as app1's full-island build).
    camera = {
        "position": [-8234100.519233786, 4951755.384616743, 1],
        "direction": {
            "right": [0, 0, 3000],
            "lookAt": [0, 0, 0],
            "up": [0, 1, 0],
        },
    }

    knots = []
    # base layers (constant colour, OBJECTS abstract join)
    for layer, cmap in BASE_LAYERS.items():
        knots.append({
            "id": "%sColor" % layer,
            "colorMap": cmap,
            "integration_scheme": [{
                "spatial_relation": "NEAREST",
                "in": {"name": "%sTheme" % layer, "level": "COORDINATES"},
                "out": {"name": layer, "level": "OBJECTS"},
                "operation": "NONE",
                "abstract": True,
            }],
        })
    # buildings coloured by subway-station count within 500 m
    knots.append({
        "id": "subwayAccess",
        "colorMap": BUILDINGS_COLORMAP,
        "integration_scheme": [{
            "spatial_relation": "NEAREST",
            "in": {"name": "subwayCount", "level": "COORDINATES3D"},
            "out": {"name": "buildings", "level": "COORDINATES3D"},
            "operation": "NONE",
            "abstract": True,
        }],
    })

    map_knots = [k["id"] for k in knots]
    interactions = ["PICKING"] * len(map_knots)  # picking on every layer

    grammar = {
        "components": [{
            "map": {"camera": camera, "knots": map_knots, "interactions": interactions},
            "plots": [],
            "knots": knots,
            "widgets": [
                {"type": "TOGGLE_KNOT"},
                {"type": "SEARCH"},
                {"type": "HIDE_GRAMMAR"},
            ],
            "position": {"width": [6, 12], "height": [1, 4]},
        }],
        "arrangement": "LINKED",
        "grid": {"width": 12, "height": 4},
        "grammar_position": {"width": [1, 5], "height": [1, 4]},
    }
    with open(os.path.join(DATA_DIR, "grammar.json"), "w") as f:
        json.dump(grammar, f, indent=2)
    log.info("grammar.json written: knots=%s, interactions all PICKING", map_knots)


# =========================================================================== #
# Main                                                                         #
# =========================================================================== #
def main():
    log.info("=== Manhattan Subway-Picking data preparation (UTK) ===")
    os.makedirs(DATA_DIR, exist_ok=True)

    if _have_physical_layers():
        log.info("PHASE A skipped: physical layers already present in %s", DATA_DIR)
    else:
        log.info("PHASE A: building physical layers from OSM (this can take hours) ...")
        _phase_a_build()

    _augment_all_for_picking()
    write_grammar()

    log.info("=== Data preparation complete. Start the app with: ===")
    log.info("    utk start --data %s", DATA_DIR)
    log.info("    then open http://localhost:5001 in your browser")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log.exception("Data preparation FAILED")
        sys.exit(1)
