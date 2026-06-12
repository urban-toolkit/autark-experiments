# Task: Manhattan Buildings — Subway Accessibility 3D Map

## Role

You are an urban planner with expertise in geospatial data interested in understanding city dynamics from Manhattan represented in datasets available in NYC Open Data (https://opendata.cityofnewyork.us/).

---

## Constraints

A new tool, Autark, is available for researchers to facilitate the construction of urban visual analytics systems. You must only use Autark to implement the functionalities described below. Autark documentation is available locally at /home/lucas/projects/master-degree/autark-experiments/trials/docs

You must install the Autark libraries **exclusively from the local tarballs** in `/home/lucas/projects/master-degree/autark-experiments/libs/` — do **not** fetch any `autk-*` package from the npm registry. Install only the packages you need from their local `.tgz` file, for example:

```bash
npm install \
  /home/lucas/projects/master-degree/autark-experiments/libs/autk-db-1.1.0.tgz \
  /home/lucas/projects/master-degree/autark-experiments/libs/autk-map-0.1.0.tgz \
  /home/lucas/projects/master-degree/autark-experiments/libs/autk-compute-1.1.0.tgz \
  /home/lucas/projects/master-degree/autark-experiments/libs/autk-plot-1.1.0.tgz
```

This pins the versions to autk-db 1.1.0, autk-map 0.1.0, autk-compute 1.1.0, and autk-plot 1.1.0.

---

## Goal

Build a **fully browser-side** (no backend) web application that renders a **3D map of Manhattan buildings**, where each building is colored based on the **number of subway stations within a 500-meter radius**.

The application must:

1. Load OpenStreetMap base layers for Manhattan (surface, parks, water, roads, and buildings)
2. Load subway station data from a CSV file (the dataset is in /home/lucas/projects/master-degree/autark-experiments/data/subway_manhattan_clean.csv)
3. For each building, count how many subway stations are within 500 meters
4. Render a 3D map where building color encodes subway station proximity
5. Generate a `README.md` explaining how to run the application end-to-end
