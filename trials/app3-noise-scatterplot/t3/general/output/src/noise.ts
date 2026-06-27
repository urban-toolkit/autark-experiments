import type { NoiseEvent } from "./types";

/**
 * Loads and parses the NYC Open Data 311 noise CSV shipped in /public.
 * The file is the standard 311 export (comma separated, quoted fields); we keep
 * the complaint type, creation date and the WGS84 Latitude/Longitude columns.
 */
export async function loadNoiseEvents(
  url = "/noise.csv"
): Promise<NoiseEvent[]> {
  console.log(`[noise] Loading noise complaints from ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load noise CSV (HTTP ${res.status})`);
  }
  const text = await res.text();
  console.log(`[noise] CSV downloaded: ${(text.length / 1_048_576).toFixed(2)} MB`);

  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new Error("Noise CSV is empty");
  }

  const header = rows[0];
  const idx = {
    type: header.indexOf("Complaint Type"),
    created: header.indexOf("Created Date"),
    lat: header.indexOf("Latitude"),
    lon: header.indexOf("Longitude"),
  };
  if (idx.lat === -1 || idx.lon === -1) {
    throw new Error("Noise CSV is missing Latitude/Longitude columns");
  }

  const events: NoiseEvent[] = [];
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const lat = Number(r[idx.lat]);
    const lon = Number(r[idx.lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
      skipped++;
      continue;
    }
    events.push({
      type: idx.type >= 0 ? r[idx.type] : "Noise",
      created: idx.created >= 0 ? r[idx.created] : "",
      lat,
      lon,
    });
  }

  console.log(
    `[noise] Parsed ${events.length} geolocated noise events (${skipped} rows skipped for missing coordinates)`
  );
  return events;
}

/** Minimal RFC-4180-style CSV parser supporting quoted fields and CRLF. */
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
