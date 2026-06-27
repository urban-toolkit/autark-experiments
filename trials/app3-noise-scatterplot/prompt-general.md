# Task: Manhattan Noisescape — Noise Pollution Impact on Buildings

## Role

You are an urban planner with expertise in geospatial data interested in understanding city dynamics from Manhattan represented in datasets available in NYC Open Data (https://opendata.cityofnewyork.us/).

---

## Goal

Build a **fully browser-side** (no backend) web application that renders a **3D map of Manhattan buildings**, where each building is colored based on the **number of subway stations within a 500-meter radius**.

The application must:

1. Load OpenStreetMap base layers for Manhattan (surface, parks, water, roads, and buildings)
2. Load noise data from a CSV file (the dataset is in /home/lucas/projects/master-degree/autark-experiments/data/noise.csv)
3. For each building, count how many noise events happened within 500 meters of the building
4. Render a 3D map where building color encodes noise complaints that happened in the building proximity
5. The user should be able to select (picking) elements from any of the loaded layers (surface, parks, water, roads, and buildings). The color of the element should change on click.
6. An interactive scatterplot, where each circle is a building, must encode the number of noise complaints in the x axis and the building area in the y axis. Brushing points in this scatterplot must highlight the correspondent buildings in the map.
7. Generate a `README.md` explaining how to run the application end-to-end.
