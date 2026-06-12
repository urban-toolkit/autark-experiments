# Task: Manhattan Buildings — Subway Accessibility 3D Map

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

Build a web application that renders a **3D map of Manhattan buildings**, where each building is colored based on the **number of subway stations within a 500-meter radius**.

The application must:

1. Load OpenStreetMap base layers for Manhattan (surface, parks, water, roads, and buildings)
2. Load subway station data from a CSV file (the dataset is in /home/lucas/projects/master-degree/autark-experiments/data/subway_manhattan_clean.csv)
3. For each building, count how many subway stations are within 500 meters
4. Render a 3D map where building color encodes subway station proximity
5. Generate a `README.md` explaining how to run the application end-to-end, including how to start any backend components (e.g., UTK server) and how to access the app in the browser
