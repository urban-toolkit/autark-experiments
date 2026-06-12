// Loads the 311 noise complaint CSV (served statically) and extracts the
// geolocated noise events used for the spatial join.

import Papa from "papaparse";

export interface NoisePoint {
  lon: number;
  lat: number;
  type: string;
  descriptor: string;
}

const CSV_URL = "data/noise.csv";

export async function loadNoisePoints(): Promise<NoisePoint[]> {
  console.log(`[noise] Loading noise data from ${CSV_URL}…`);
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch noise CSV: HTTP ${res.status}`);
  }
  const text = await res.text();
  console.log(
    `[noise] CSV downloaded: ${(text.length / 1024 / 1024).toFixed(2)} MB`,
  );

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  console.log(`[noise] Parsed ${parsed.data.length} raw rows`);

  const points: NoisePoint[] = [];
  let skippedNoCoord = 0;
  let skippedNotNoise = 0;
  for (const row of parsed.data) {
    const type = (row["Complaint Type"] ?? "").trim();
    // The dataset mixes all 311 complaints; keep only noise events.
    if (!/noise/i.test(type)) {
      skippedNotNoise++;
      continue;
    }
    const lat = parseFloat(row["Latitude"]);
    const lon = parseFloat(row["Longitude"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      skippedNoCoord++;
      continue;
    }
    points.push({
      lon,
      lat,
      type,
      descriptor: (row["Descriptor"] ?? "").trim(),
    });
  }

  console.log(
    `[noise] Noise events with coordinates: ${points.length} ` +
      `(skipped ${skippedNotNoise} non-noise, ${skippedNoCoord} missing coords)`,
  );
  return points;
}
