# Task: Manhattan Buildings — Subway Accessibility 3D Map

## Role

You are an urban planner with expertise in geospatial data interested in understanding city dynamics from Manhattan represented in datasets available in NYC Open Data (https://opendata.cityofnewyork.us/).

---

## Goal

Build a **fully browser-side** (no backend) web application that renders a **3D map of Manhattan buildings**, where each building is colored based on the **number of subway stations within a 500-meter radius**.

The application must:

1. Load OpenStreetMap base layers for Manhattan (surface, parks, water, roads, and buildings)
2. Load subway station data from a CSV file (the dataset is in /home/lucas/projects/master-degree/autark-experiments/data/subway_manhattan_clean.csv)
3. For each building, count how many subway stations are within 500 meters
4. Render a 3D map where building color encodes subway station proximity
5. The user should be able to select (picking) elements from any of the loaded layers (surface, parks, water, roads, and buildings). The color of the element should change on click.
6. Generate a `README.md` explaining how to run the application end-to-end.
