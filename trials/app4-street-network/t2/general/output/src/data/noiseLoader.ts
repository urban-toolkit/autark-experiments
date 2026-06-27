import type { NoiseEvent } from './types';

// Generous Manhattan-island bounding box. Filtering up front keeps the
// spatial-join work bounded (the CSV is a city-wide 311 sample).
const MANHATTAN_BBOX = { minLon: -74.03, maxLon: -73.90, minLat: 40.68, maxLat: 40.89 };

/**
 * Loads the noise CSV (served from /public/noise.csv) fully in the browser
 * and returns the events that carry valid coordinates inside Manhattan.
 */
export async function loadNoiseEvents(url = '/noise.csv'): Promise<NoiseEvent[]> {
  console.log(`Loading noise data from ${url} ...`);
  const t0 = performance.now();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load noise CSV: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  console.log(`Noise CSV downloaded: ~${(text.length / 1024).toFixed(0)} KB`);

  const rows = parseCsv(text);
  if (rows.length === 0) {
    console.warn('Noise CSV contained no rows');
    return [];
  }

  const header = rows[0];
  const latIdx = header.findIndex((h) => h.trim().toLowerCase() === 'latitude');
  const lonIdx = header.findIndex((h) => h.trim().toLowerCase() === 'longitude');
  if (latIdx === -1 || lonIdx === -1) {
    throw new Error('Noise CSV is missing Latitude/Longitude columns');
  }

  const events: NoiseEvent[] = [];
  let withinBbox = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const lat = parseFloat(row[latIdx]);
    const lon = parseFloat(row[lonIdx]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (
      lon >= MANHATTAN_BBOX.minLon && lon <= MANHATTAN_BBOX.maxLon &&
      lat >= MANHATTAN_BBOX.minLat && lat <= MANHATTAN_BBOX.maxLat
    ) {
      events.push({ lon, lat });
      withinBbox++;
    }
  }

  const elapsed = (performance.now() - t0).toFixed(1);
  console.log(
    `Noise data loaded: ${rows.length - 1} total rows, ${withinBbox} events within Manhattan bbox (${elapsed}ms)`
  );
  return events;
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields containing commas,
 * newlines and escaped quotes. Returns an array of rows of string cells.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      // Skip blank trailing lines
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}
