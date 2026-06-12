#!/usr/bin/env python3
"""
prepare_data.py
===============

Backend data-preparation step for the *Manhattan Buildings - Subway Accessibility*
UTK visual-analytics application.

Everything below is built **with the UTK Python API** (``utk.OSM.load``,
``utk.thematic_from_df``, ``UrbanComponent.save``).  The script:

  1. Resolves the *Manhattan Island* polygon from OpenStreetMap and uses it to
     restrict every Overpass query to the island (never a broader area).
  2. Downloads the OSM base layers (surface, parks, water, roads, buildings)
     through ``utk.OSM.load`` and saves them as UTK-ready layer files in
     ``./data``.
  3. Loads the subway-station CSV.
  4. Counts, for every building, how many subway stations lie within a
     500-metre radius (accurate metric distance in EPSG:32618 / UTM 18N).
  5. Writes those counts as a UTK *thematic* layer (``subwayCount.json``).
  6. Emits a ``grammar.json`` whose ``subwayAccess`` knot joins the counts onto
     the building footprints and colours each building by the count.

Robustness notes
----------------
* The public Overpass endpoints reject requests without a ``User-Agent`` (HTTP
  406) and frequently answer HTTP 504 when a query slot is busy.  We therefore
  (a) install a ``User-Agent`` on UTK's overpass client and (b) *pre-fetch* each
  layer's exact Overpass query ourselves with retries / exponential backoff /
  endpoint fall-back, then store the result in UTK's on-disk cache so that
  ``utk.OSM.load`` simply re-reads it (no extra API traffic).

All major operations are logged to stdout so the pipeline can be traced from the
console alone.
"""

import os
import sys
import time
import json
import logging

# --------------------------------------------------------------------------- #
# Logging                                                                       #
# --------------------------------------------------------------------------- #
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("prepare_data")

# Run from the directory that contains this script so that UTK's relative
# ``./urbantk_cache/`` and ``./data`` folders are always in the same place.
HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

DATA_DIR = os.path.join(HERE, "data")
SUBWAY_CSV = "/home/lucas/projects/master-degree/autark-experiments/data/subway_manhattan_clean.csv"
RADIUS_M = 500.0
COLOR_MAP = "interpolateViridis"
USER_AGENT = "utk-subway-accessibility/1.0 (academic research; OSM Overpass)"

# Endpoints tried, in order, by the resilient pre-fetcher.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# --------------------------------------------------------------------------- #
# Make UTK's Overpass client send a User-Agent (fixes HTTP 406).                #
# --------------------------------------------------------------------------- #
import overpass  # noqa: E402

overpass.API._headers = {
    "Accept-Charset": "utf-8;q=0.7,*;q=0.7",
    "User-Agent": USER_AGENT,
}

import requests  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import geopandas as gpd  # noqa: E402
from pyproj import Transformer  # noqa: E402
from scipy.spatial import cKDTree  # noqa: E402
from shapely.geometry import MultiPolygon  # noqa: E402

import utk  # noqa: E402
from utk.osm import OSM  # noqa: E402
from utk import cache as utk_cache  # noqa: E402

# Layers to load.  Buildings must be last (UTK requirement for correct
# rendering); surface is the ground plane that the other layers sit on.
LAYERS = ["water", "parks", "roads", "surface", "buildings"]
# 'surface' is generated locally by UTK (no Overpass query), so it is excluded
# from the pre-fetch list.
PREFETCH_LAYERS = ["water", "parks", "roads", "buildings"]


# --------------------------------------------------------------------------- #
# Step 1 - Manhattan Island polygon                                             #
# --------------------------------------------------------------------------- #
def get_manhattan_polygon():
    """Return the Manhattan-Island boundary as a list of (lat, lon) tuples.

    Querying restricted to this polygon guarantees we never pull data from
    outside the island (e.g. New Jersey, Brooklyn, Queens).
    """
    import osmnx as ox

    log.info("Geocoding 'Manhattan Island' boundary from OSM ...")
    gdf = ox.geocode_to_gdf("Manhattan Island")
    geom = gdf.geometry.iloc[0]
    if isinstance(geom, MultiPolygon):
        geom = max(geom.geoms, key=lambda p: p.area)  # main island body

    # Simplify to keep the Overpass `poly:` filter small but still island-shaped.
    simplified = geom.simplify(0.0008)
    # osmnx polygons are (lon, lat); UTK / Overpass want (lat, lon).
    latlon = [(lat, lon) for lon, lat in simplified.exterior.coords]
    log.info(
        "Manhattan Island polygon: %d vertices (simplified from %d), bounds=%s",
        len(latlon),
        len(geom.exterior.coords),
        [round(x, 4) for x in geom.bounds],
    )
    return latlon


# --------------------------------------------------------------------------- #
# Resilient Overpass pre-fetch -> UTK cache                                     #
# --------------------------------------------------------------------------- #
def _fetch_overpass(query, max_attempts=6):
    """POST ``query`` to Overpass, cycling endpoints with exponential backoff.

    Returns the parsed JSON dict (the same object ``overpass.API.get(build=False)``
    would return), or raises after exhausting all attempts.
    """
    headers = {"User-Agent": USER_AGENT}
    last_err = None
    for attempt in range(max_attempts):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        try:
            log.info("    Overpass POST (attempt %d/%d) -> %s",
                     attempt + 1, max_attempts, endpoint)
            t0 = time.time()
            r = requests.post(endpoint, data={"data": query},
                              headers=headers, timeout=300)
            dt = time.time() - t0
            if r.status_code == 200:
                payload = json.loads(r.text)
                if "elements" not in payload:
                    raise ValueError("response missing 'elements'")
                size_mb = len(r.content) / 1e6
                log.info("    Overpass OK: %.2f MB, %d elements, %.1fs",
                         size_mb, len(payload["elements"]), dt)
                return payload
            log.warning("    Overpass HTTP %d (%.1fs) from %s",
                        r.status_code, dt, endpoint)
            last_err = RuntimeError("HTTP %d" % r.status_code)
        except Exception as e:  # noqa: BLE001 - we want to retry on anything
            log.warning("    Overpass error from %s: %r", endpoint, e)
            last_err = e
        backoff = min(60, 5 * (2 ** attempt))
        log.info("    backing off %ds before retry ...", backoff)
        time.sleep(backoff)
    raise RuntimeError("Overpass pre-fetch failed after %d attempts: %r"
                       % (max_attempts, last_err))


def prefetch_layers_into_cache(polygon_latlon):
    """Pre-populate UTK's Overpass cache for each network-backed layer.

    UTK keys its cache on ``md5(query)`` where ``query`` is exactly what
    ``OSM.build_osm_query`` produces, so we replicate that query string and
    store the response under the same key.  ``utk.OSM.load`` then finds a cache
    hit and performs no network request.
    """
    # UTK flattens the polygon to [lat, lon, lat, lon, ...] for poly queries.
    flat = [c for pt in polygon_latlon for c in pt]
    for layer in PREFETCH_LAYERS:
        query = OSM.build_osm_query(flat, "geom", False, [layer])
        cached = utk_cache._load_osm_from_cache(query)
        if cached is not None:
            log.info("Layer '%s': Overpass response already cached (%d elements).",
                     layer, len(cached.get("elements", [])))
            continue
        log.info("Layer '%s': fetching from Overpass (restricted to island poly) ...",
                 layer)
        payload = _fetch_overpass(query)
        utk_cache._save_osm_to_cache(query, payload)
        log.info("Layer '%s': cached.", layer)
        time.sleep(2)  # be polite between heavy queries


# --------------------------------------------------------------------------- #
# Step 2 - load + save OSM layers via UTK                                       #
# --------------------------------------------------------------------------- #
def load_and_save_layers(polygon_latlon):
    log.info("Loading OSM layers via utk.OSM.load: %s", LAYERS)
    t0 = time.time()
    uc = utk.OSM.load(polygon_latlon, layers=LAYERS)
    log.info("OSM layers loaded in %.1fs", time.time() - t0)

    for j, gdf in zip(uc.layers["json"], uc.layers["gdf"]["objects"]):
        n = len(gdf) if gdf is not None and hasattr(gdf, "__len__") else "?"
        log.info("  layer '%s' type=%s render=%s objects=%s",
                 j["id"], j["type"], j["renderStyle"], n)

    log.info("Saving layers to %s (includeGrammar=False) ...", DATA_DIR)
    uc.save(DATA_DIR, includeGrammar=False)
    log.info("Layers saved.")
    return uc


# --------------------------------------------------------------------------- #
# Steps 3-5 - count subway stations within 500 m and write thematic layer       #
# --------------------------------------------------------------------------- #
def compute_counts_and_thematic(uc):
    # Locate the building gdf (footprint polygons, EPSG:3395).
    b_idx = next(i for i, j in enumerate(uc.layers["json"])
                 if j["id"] == "buildings")
    buildings = uc.layers["gdf"]["objects"][b_idx]
    if buildings.crs is None:
        buildings = buildings.set_crs(3395)
    log.info("Buildings layer: %d footprints (crs=%s)",
             len(buildings), buildings.crs)

    # Subway stations from CSV.
    log.info("Loading subway stations from %s", SUBWAY_CSV)
    stations = pd.read_csv(SUBWAY_CSV)
    log.info("Subway stations loaded: %d rows", len(stations))
    lat_col, lon_col = "GTFS Latitude", "GTFS Longitude"

    # Project everything to EPSG:32618 (UTM 18N) so distances are true metres.
    metric_crs = 32618
    log.info("Projecting buildings and stations to EPSG:%d for metric distance.",
             metric_crs)
    b_metric = buildings.to_crs(metric_crs)
    b_points = b_metric.geometry.representative_point()  # guaranteed inside

    to_utm = Transformer.from_crs(4326, metric_crs, always_xy=True)
    sx, sy = to_utm.transform(stations[lon_col].values, stations[lat_col].values)
    station_xy = np.column_stack([sx, sy])

    # Spatial join via KD-tree: count stations within RADIUS_M of each building.
    log.info("Spatial join started: counting stations within %.0f m of each building.",
             RADIUS_M)
    tree = cKDTree(station_xy)
    bx = np.array([p.x for p in b_points])
    by = np.array([p.y for p in b_points])
    neighbours = tree.query_ball_point(np.column_stack([bx, by]), r=RADIUS_M)
    counts = np.array([len(n) for n in neighbours], dtype=int)
    log.info("Spatial join complete: %d buildings matched.", len(counts))
    log.info("Subway-count stats -> min=%d max=%d mean=%.2f (buildings with >=1: %d)",
             counts.min(), counts.max(), counts.mean(), int((counts > 0).sum()))

    # Building representative points back in lat/lon for the thematic layer.
    b_pts_4326 = buildings.to_crs(4326).geometry.representative_point()
    thematic_df = pd.DataFrame({
        "lat": [p.y for p in b_pts_4326],
        "lon": [p.x for p in b_pts_4326],
        "count": counts,
    })

    out_json = os.path.join(DATA_DIR, "subwayCount.json")
    log.info("Writing thematic layer 'subwayCount' -> %s", out_json)
    utk.thematic_from_df(
        thematic_df,
        out_json,
        latitude_column="lat",
        longitude_column="lon",
        coordinates_projection="4326",
        value_column="count",
    )
    log.info("Thematic layer written.")
    return counts


# --------------------------------------------------------------------------- #
# Pre-compute the building<->subwayCount join (fast, vectorised).               #
#                                                                               #
# UTK's server computes the COORDINATES3D NEAREST join with a per-vertex pandas #
# loop, which is far too slow for ~7.5 M building vertices. Because the UTK      #
# server skips recomputation when a matching ``*_joined.json`` already exists    #
# (``FilesInterface.existsJoin``), we generate it here with a single cKDTree     #
# query so the frontend loads the colours instantly.                            #
#                                                                               #
# ``inValues[k]`` must be parallel to the k-th (x, y, z) triple in              #
# ``buildings_coordinates.data`` (that is exactly the COORDINATES3D order UTK    #
# reconstructs and the order the renderer textures vertices in).                #
# --------------------------------------------------------------------------- #
def precompute_join():
    import struct  # noqa: PLC0415

    coords_path = os.path.join(DATA_DIR, "buildings_coordinates.data")
    log.info("Pre-computing building/subway join (vectorised NEAREST) ...")
    raw = np.frombuffer(open(coords_path, "rb").read(), dtype="<f8")
    b_xyz = raw.reshape(-1, 3)
    log.info("  building vertices (COORDINATES3D): %d", len(b_xyz))

    sub = json.load(open(os.path.join(DATA_DIR, "subwayCount.json")))
    s_xyz = np.asarray(sub["coordinates"], dtype="<f8").reshape(-1, 3)
    s_val = np.asarray(sub["values"], dtype=float)
    log.info("  subwayCount points: %d", len(s_xyz))

    # 3-D nearest neighbour (subway points sit at z=0, so the nearest is the
    # horizontally-closest building centroid -> each building gets its own count).
    tree = cKDTree(s_xyz)
    _, idx = tree.query(b_xyz, k=1, workers=-1)
    in_values = s_val[idx]
    log.info("  join complete: min=%g max=%g mean=%.2f",
             in_values.min(), in_values.max(), in_values.mean())

    joined = {
        "joinedLayers": [{
            "spatial_relation": "NEAREST",
            "layerId": "subwayCount",
            "outLevel": "COORDINATES3D",
            "inLevel": "COORDINATES3D",
            "abstract": True,
        }],
        "joinedObjects": [{
            "joinedLayerIndex": 0,
            "inValues": [round(float(v), 1) for v in in_values],
        }],
    }
    out = os.path.join(DATA_DIR, "buildings_joined.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(joined, f)
    log.info("  wrote %s (%.1f MB)", out, os.path.getsize(out) / 1e6)


# --------------------------------------------------------------------------- #
# Step 6 - grammar.json                                                         #
# --------------------------------------------------------------------------- #
def write_grammar(uc):
    camera = uc.camera
    grammar = {
        "components": [
            {
                "map": {
                    "camera": camera,
                    # NOTE: 'surface' is loaded (data/surface.*) and used as the
                    # analysis/ground plane, but it is a HEATMAP_LAYER and is not
                    # rendered as a standalone knot (it carries no scalar field).
                    "knots": [
                        "purewater",
                        "pureparks",
                        "pureroads",
                        "subwayAccess",
                    ],
                    "interactions": [
                        "NONE",
                        "NONE",
                        "NONE",
                        "PICKING",
                    ],
                },
                "plots": [],
                "knots": [
                    {"id": "purewater",
                     "integration_scheme": [{"out": {"name": "water", "level": "OBJECTS"}}]},
                    {"id": "pureparks",
                     "integration_scheme": [{"out": {"name": "parks", "level": "OBJECTS"}}]},
                    {"id": "pureroads",
                     "integration_scheme": [{"out": {"name": "roads", "level": "OBJECTS"}}]},
                    {
                        # Colour each building by its subway-station count.
                        # We mirror UTK's proven building-colouring pattern (the
                        # shadow example): a NEAREST join at the COORDINATES3D
                        # level so the BUILDINGS_LAYER's SMOOTH_COLOR_MAP_TEX
                        # shader receives a per-vertex scalar. Each building's
                        # vertices resolve to that building's own count point
                        # (the thematic points sit at z=0, so the nearest point
                        # is the horizontally-closest building centroid).
                        "id": "subwayAccess",
                        "colorMap": COLOR_MAP,
                        "integration_scheme": [
                            {
                                "spatial_relation": "NEAREST",
                                "in": {"name": "subwayCount", "level": "COORDINATES3D"},
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

    out = os.path.join(DATA_DIR, "grammar.json")
    log.info("Writing grammar -> %s", out)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(grammar, f, indent=2)
    log.info("Grammar written.")


# --------------------------------------------------------------------------- #
# Main                                                                          #
# --------------------------------------------------------------------------- #
def main():
    log.info("=== Manhattan Subway-Accessibility data preparation (UTK) ===")
    os.makedirs(DATA_DIR, exist_ok=True)

    polygon = get_manhattan_polygon()

    log.info("Pre-fetching Overpass layers into UTK cache ...")
    prefetch_layers_into_cache(polygon)

    uc = load_and_save_layers(polygon)
    compute_counts_and_thematic(uc)
    precompute_join()
    write_grammar(uc)

    log.info("=== Data preparation complete. Start the app with: ===")
    log.info("    utk start --data %s", DATA_DIR)
    log.info("    then open http://localhost:5001 in your browser")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log.exception("Data preparation FAILED")
        sys.exit(1)
