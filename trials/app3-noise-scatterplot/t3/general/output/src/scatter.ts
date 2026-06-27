import type { PolygonFeature } from "./types";

/**
 * A lightweight HTML5-canvas scatterplot: one point per building, x = number of
 * noise events within 500 m, y = footprint area (log scale, since building
 * areas span several orders of magnitude). The user drags a rectangle over the
 * points; every building inside the box is reported via `onBrush` so the map
 * can highlight the matching footprints. Releasing on a zero-size box (a plain
 * click) clears the brush.
 */

// Colour of brushed points — matches the map's brush highlight (magenta).
const BRUSH_COLOR = "#ff5bd1";
const POINT_COLOR = "rgba(143, 211, 255, 0.45)";

interface PlotPoint {
  id: number;
  px: number;
  py: number;
  count: number;
  area: number;
}

interface Margins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Scatterplot {
  /** Currently brushed building ids (empty when nothing is brushed). */
  readonly brushed: Set<number>;
}

export function createScatterplot(
  canvas: HTMLCanvasElement,
  buildings: PolygonFeature[],
  maxCount: number,
  maxArea: number,
  onBrush: (ids: Set<number>) => void,
  onInfo: (msg: string) => void
): Scatterplot {
  console.log(
    `[scatter] Building scatterplot for ${buildings.length} buildings (x: 0–${maxCount} noise events, y: area up to ${Math.round(maxArea)} m²)`
  );

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const W = canvas.width;
  const H = canvas.height;
  const margin: Margins = { left: 40, right: 10, top: 10, bottom: 24 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  const xMax = Math.max(1, maxCount);
  const logMax = Math.log10(Math.max(10, maxArea));

  const xToPx = (count: number): number =>
    margin.left + (count / xMax) * plotW;
  const yToPx = (area: number): number => {
    const logA = Math.log10(Math.max(1, area));
    return margin.top + plotH - (logA / logMax) * plotH;
  };

  // Precompute every point's pixel position once.
  const points: PlotPoint[] = [];
  for (const b of buildings) {
    const count = b.properties.noiseCount ?? 0;
    const area = b.properties.area ?? 0;
    points.push({
      id: b.properties.id,
      px: xToPx(count),
      py: yToPx(area),
      count,
      area,
    });
  }

  const brushed = new Set<number>();
  let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;

  function draw(): void {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    // Plot background.
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(margin.left, margin.top, plotW, plotH);

    // Axes.
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    // y gridlines / labels at decade boundaries (10, 100, 1k, 10k … m²).
    ctx.fillStyle = "#9aa3b2";
    ctx.font = "9px -apple-system, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let p = 1; Math.pow(10, p) <= Math.pow(10, logMax) * 1.0001; p++) {
      const area = Math.pow(10, p);
      const y = yToPx(area);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.fillText(decadeLabel(area), margin.left - 4, y);
    }

    // x labels.
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let k = 0; k <= 4; k++) {
      const v = Math.round((xMax / 4) * k);
      ctx.fillText(String(v), xToPx(v), margin.top + plotH + 5);
    }

    // Axis titles.
    ctx.fillStyle = "#b9c0cc";
    ctx.textAlign = "center";
    ctx.fillText("noise events within 500 m", margin.left + plotW / 2, H - 11);
    ctx.save();
    ctx.translate(9, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("area (m², log)", 0, 0);
    ctx.restore();

    // Unbrushed points first, then brushed on top.
    ctx.fillStyle = POINT_COLOR;
    for (const pt of points) {
      if (brushed.has(pt.id)) continue;
      ctx.fillRect(pt.px - 1, pt.py - 1, 2, 2);
    }
    ctx.fillStyle = BRUSH_COLOR;
    for (const pt of points) {
      if (!brushed.has(pt.id)) continue;
      ctx.fillRect(pt.px - 1.5, pt.py - 1.5, 3, 3);
    }

    // Live brush rectangle.
    if (drag) {
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      const w = Math.abs(drag.x1 - drag.x0);
      const h = Math.abs(drag.y1 - drag.y0);
      ctx.strokeStyle = BRUSH_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "rgba(255,91,209,0.12)";
      ctx.fillRect(x, y, w, h);
    }
  }

  function applyBrush(): void {
    if (!drag) return;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    brushed.clear();
    if (w >= 2 && h >= 2) {
      for (const pt of points) {
        if (pt.px >= x && pt.px <= x + w && pt.py >= y && pt.py <= y + h) {
          brushed.add(pt.id);
        }
      }
    }
  }

  function localPos(ev: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * W,
      y: ((ev.clientY - rect.top) / rect.height) * H,
    };
  }

  canvas.addEventListener("mousedown", (ev) => {
    const p = localPos(ev);
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    draw();
  });

  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    const p = localPos(ev);
    drag.x1 = p.x;
    drag.y1 = p.y;
    applyBrush();
    draw();
  });

  window.addEventListener("mouseup", () => {
    if (!drag) return;
    applyBrush();
    drag = null;
    draw();
    if (brushed.size > 0) {
      const counts = [...brushed].length;
      console.log(`[scatter] Brush selected ${counts} building(s); highlighting on map`);
      onInfo(`<b>${brushed.size}</b> building(s) highlighted on the map.`);
    } else {
      console.log("[scatter] Brush cleared");
      onInfo("Drag a box over the points to highlight buildings.");
    }
    onBrush(new Set(brushed));
  });

  draw();
  console.log("[scatter] Scatterplot rendered");
  return { brushed };
}

function decadeLabel(area: number): string {
  if (area >= 1000) return `${area / 1000}k`;
  return String(area);
}
