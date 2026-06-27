const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/**
 * Fetches all Manhattan Island OSM data in a SINGLE Overpass query
 * (roads, parks, water, and landuse "surface" polygons) to respect the
 * Overpass rate limits. Uses the named area "Manhattan Island" so the
 * result is clipped to the island rather than the whole NYC bounding box.
 */
export async function fetchManhattanOsmData(): Promise<unknown> {
  console.log('Fetching Overpass API data for Manhattan Island...');

  const query = `
[out:json][timeout:120][maxsize:134217728];
area["name"="Manhattan Island"]->.manhattan;
(
  way["highway"](area.manhattan);
  way["leisure"="park"](area.manhattan);
  relation["leisure"="park"](area.manhattan);
  way["natural"="water"](area.manhattan);
  relation["natural"="water"](area.manhattan);
  way["landuse"](area.manhattan);
  relation["landuse"](area.manhattan);
);
out body;
>;
out skel qt;
`;

  const maxRetries = 4;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Overpass API request attempt ${attempt}/${maxRetries}...`);
      const t0 = performance.now();
      const response = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });

      // 429 (rate limit) / 504 (gateway timeout) → exponential backoff
      if (response.status === 429 || response.status === 504) {
        const wait = Math.pow(2, attempt) * 2000;
        console.warn(`Overpass API responded ${response.status}. Backing off ${wait}ms before retry...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        throw new Error(`Overpass API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      const sizeMB = (JSON.stringify(data).length / 1024 / 1024).toFixed(2);
      console.log(
        `Overpass response received: ~${sizeMB} MB, ${data.elements?.length ?? 0} elements in ${elapsed}s`
      );
      return data;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const wait = Math.pow(2, attempt) * 2000;
      console.warn(`Overpass request failed: ${err}. Retrying in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw new Error('Overpass API: all retries exhausted');
}
