# Task: Manhattan Street Network — Understanding the Streets Of New York

## Role

You are an urban planner with expertise in geospatial data, interested in understanding Manhattan's city dynamics using datasets available in NYC Open Data (https://opendata.cityofnewyork.us/).

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

Build a web application that renders a **map of Manhattan**, where each road segment can be either **colored by the number of noise events within a 10-meter radius** or the **length of the road segment**.

The application must:

1. Load OpenStreetMap base layers for Manhattan (surface, parks, water, roads).
2. Calculate the length of each road segment. This computation must be done in a distributed fashion (using a GPU, if available). This computation must be done entirely using shaders. The geometry of each road segment must be sent to the GPU and used in this computation.
3. Load noise data from a CSV file (the dataset is in /home/lucas/projects/master-degree/autark-experiments/data/noise.csv)
4. For each road segment, count how many noise events happened within a 10-meter radius of the segment.
5. Color each road segment according to its length **or** the number of noise events within a 10-meter radius. Provide a control (e.g., a toggle) that lets the user switch between the two coloring modes.
6. Allow the user to select (pick) elements from any of the loaded layers (surface, parks, water, roads). The selected element's color should change on click.
7. Generate a `README.md` explaining how to run the application end-to-end, including how to start any backend components (e.g., UTK server) and how to access the app in the browser
