# Task: Manhattan Noisescape — Noise Pollution Impact on Buildings

## Role

You are an urban planner with expertise in geospatial data interested in understanding city dynamics from Manhattan represented in datasets available in NYC Open Data (https://opendata.cityofnewyork.us/).

---

## Constraints

A new tool, UTK, is available for researchers to facilitate the construction of urban visual analytics systems. You must only use UTK to implement the functionalities described below. UTK documentation is available locally at /home/lucas/projects/master-degree/autark-experiments/trials/docs-utk

> Note: the public Overpass API now rejects requests without a `User-Agent`. Before calling `utk.OSM.load`, set one so the download works:
> ```python
> import overpass
> overpass.API._headers = {"User-Agent": "utk-research/1.0", "Accept-Charset": "utf-8;q=0.7,*;q=0.7"}
> ```

---

## Goal

Build a web application that renders a **3D map of Manhattan buildings**, where each building is colored based on the **number of noise events within a 500-meter radius**.

The application must:

1. Load OpenStreetMap base layers for Manhattan (surface, parks, water, roads, and buildings)
2. Load noise data from a CSV file (the dataset is in /home/lucas/projects/master-degree/autark-experiments/data/noise.csv)
3. For each building, count how many noise events happened within 500 meters of the building
4. Render a 3D map where building color encodes noise complaints that happened in the building proximity
5. The user should be able to select (picking) elements from any of the loaded layers (surface, parks, water, roads, and buildings). The color of the element should change on click.
6. Generate a `README.md` explaining how to run the application end-to-end, including how to start any backend components (e.g., UTK server) and how to access the app in the browser
