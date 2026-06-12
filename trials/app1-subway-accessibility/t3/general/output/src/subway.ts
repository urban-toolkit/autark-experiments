import type { SubwayStation } from "./types";

/**
 * Loads and parses the NYC Open Data subway-station CSV that ships in /public.
 * The file is comma separated with quoted fields; we only need the station
 * name, daytime routes and the GTFS latitude/longitude columns.
 */
export async function loadSubwayStations(
  url = "/subway_manhattan_clean.csv"
): Promise<SubwayStation[]> {
  console.log(`[subway] Loading subway stations from ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load subway CSV (HTTP ${res.status})`);
  }
  const text = await res.text();
  console.log(`[subway] CSV downloaded: ${(text.length / 1024).toFixed(1)} KB`);

  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new Error("Subway CSV is empty");
  }

  const header = rows[0];
  const idx = {
    name: header.indexOf("Stop Name"),
    routes: header.indexOf("Daytime Routes"),
    lat: header.indexOf("GTFS Latitude"),
    lon: header.indexOf("GTFS Longitude"),
  };
  if (idx.lat === -1 || idx.lon === -1) {
    throw new Error("Subway CSV is missing GTFS Latitude/Longitude columns");
  }

  const stations: SubwayStation[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const lat = Number(r[idx.lat]);
    const lon = Number(r[idx.lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stations.push({
      name: idx.name >= 0 ? r[idx.name] : "Station",
      routes: idx.routes >= 0 ? r[idx.routes] : "",
      lat,
      lon,
    });
  }

  console.log(`[subway] Parsed ${stations.length} subway stations`);
  return stations;
}

/** Minimal RFC-4180-ish CSV parser supporting quoted fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}
