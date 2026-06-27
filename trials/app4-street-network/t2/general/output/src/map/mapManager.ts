import maplibregl from 'maplibre-gl';
import type { ExpressionSpecification } from 'maplibre-gl';
import type { ManhattanLayers, LayerName, ColorMode } from '../data/types';
import {
  roadLengthColorExpression,
  roadNoiseColorExpression,
  SELECTION_COLOR,
  LAYER_COLORS,
} from './styles';

const LAYER_IDS: LayerName[] = ['surface', 'parks', 'water', 'roads'];

interface SelectionState {
  source: string;
  id: number;
}

export class MapManager {
  private map: maplibregl.Map;
  private selection: SelectionState | null = null;
  private mode: ColorMode = 'length';
  private maxLength = 2000;
  private maxNoise = 1;

  constructor() {
    console.log('Initializing MapLibre GL map...');
    this.map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap contributors',
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#f0ece3' } },
          { id: 'osm-base', type: 'raster', source: 'osm-tiles', paint: { 'raster-opacity': 0.3 } },
        ],
      },
      center: [-73.97, 40.78],
      zoom: 12,
    });
    this.map.addControl(new maplibregl.NavigationControl(), 'top-right');
    console.log('Map initialized');
  }

  onReady(): Promise<void> {
    return new Promise((resolve) => {
      if (this.map.loaded()) resolve();
      else this.map.on('load', () => resolve());
    });
  }

  /** Builds the road-color expression for the current mode, preserving the
   *  yellow selection highlight via a feature-state guard. */
  private roadColorExpression(): ExpressionSpecification {
    const ramp =
      this.mode === 'length'
        ? roadLengthColorExpression(this.maxLength)
        : roadNoiseColorExpression(this.maxNoise);
    return [
      'case',
      ['boolean', ['feature-state', 'selected'], false],
      SELECTION_COLOR,
      ramp,
    ] as ExpressionSpecification;
  }

  addLayers(layers: ManhattanLayers, maxLength: number, maxNoise: number): void {
    console.log('Adding GeoJSON layers to map...');
    this.maxLength = maxLength;
    this.maxNoise = maxNoise;

    const addFill = (name: LayerName, color: string, opacity: number) => {
      this.map.addSource(name, { type: 'geojson', data: layers[name], generateId: true });
      this.map.addLayer({
        id: name,
        type: 'fill',
        source: name,
        paint: {
          'fill-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            SELECTION_COLOR,
            color,
          ] as ExpressionSpecification,
          'fill-opacity': opacity,
        },
      });
    };

    addFill('surface', LAYER_COLORS.surface, 0.7);
    addFill('parks', LAYER_COLORS.parks, 0.8);
    addFill('water', LAYER_COLORS.water, 0.8);

    // Roads
    this.map.addSource('roads', { type: 'geojson', data: layers.roads, generateId: true });
    this.map.addLayer({
      id: 'roads-outline',
      type: 'line',
      source: 'roads',
      paint: {
        'line-color': 'rgba(0,0,0,0.15)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 3, 18, 7] as ExpressionSpecification,
      },
    });
    this.map.addLayer({
      id: 'roads',
      type: 'line',
      source: 'roads',
      paint: {
        'line-color': this.roadColorExpression(),
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 2, 18, 5] as ExpressionSpecification,
      },
    });

    console.log('All layers added to map');
    this.setupClickHandlers();
    this.setupLayerToggles();
    this.setupModeSwitch();
  }

  /** Switches road coloring between length and noise. */
  setMode(mode: ColorMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.map.setPaintProperty('roads', 'line-color', this.roadColorExpression());
    this.updateLegend();
    console.log(`Road color mode switched to: ${mode}`);
  }

  private setupModeSwitch(): void {
    const btnLength = document.getElementById('mode-length');
    const btnNoise = document.getElementById('mode-noise');
    btnLength?.addEventListener('click', () => {
      this.setMode('length');
      btnLength.classList.add('active');
      btnNoise?.classList.remove('active');
    });
    btnNoise?.addEventListener('click', () => {
      this.setMode('noise');
      btnNoise.classList.add('active');
      btnLength?.classList.remove('active');
    });
    this.updateLegend();
    console.log('Road color mode switch wired up');
  }

  private setupClickHandlers(): void {
    const infoPanel = document.getElementById('info-panel')!;
    const infoTable = document.querySelector('#info-table tbody')!;

    for (const layerId of LAYER_IDS) {
      this.map.on('mouseenter', layerId, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', layerId, () => { this.map.getCanvas().style.cursor = ''; });
    }

    this.map.on('click', (e) => {
      const features = this.map.queryRenderedFeatures(e.point, { layers: LAYER_IDS });

      if (this.selection) {
        this.map.setFeatureState({ source: this.selection.source, id: this.selection.id }, { selected: false });
        this.selection = null;
      }

      if (features.length === 0) {
        infoPanel.style.display = 'none';
        console.log('Click: no feature selected');
        return;
      }

      const feature = features[0];
      const source = feature.source;
      const featureId = feature.id as number;
      console.log(`Click: selected feature id=${featureId} from layer=${source}`);

      this.map.setFeatureState({ source, id: featureId }, { selected: true });
      this.selection = { source, id: featureId };

      const props = feature.properties ?? {};
      let html = `<tr><td>Layer</td><td>${source}</td></tr>`;
      for (const [key, value] of Object.entries(props)) {
        if (key === 'id') continue;
        let displayValue: string;
        if (key === 'road_length') displayValue = `${Number(value).toFixed(1)} m`;
        else if (key === 'noise_count') displayValue = `${value} events (≤10 m)`;
        else displayValue = String(value);
        html += `<tr><td>${key}</td><td>${displayValue}</td></tr>`;
      }
      infoTable.innerHTML = html;
      infoPanel.style.display = 'block';
    });

    console.log('Click handlers set up for all layers (picking enabled)');
  }

  private setupLayerToggles(): void {
    for (const layerId of LAYER_IDS) {
      const checkbox = document.getElementById(`toggle-${layerId}`) as HTMLInputElement | null;
      if (!checkbox) continue;
      checkbox.addEventListener('change', () => {
        const visibility = checkbox.checked ? 'visible' : 'none';
        this.map.setLayoutProperty(layerId, 'visibility', visibility);
        if (layerId === 'roads') this.map.setLayoutProperty('roads-outline', 'visibility', visibility);
        console.log(`Layer ${layerId} visibility: ${visibility}`);
      });
    }
    console.log('Layer toggle controls set up');
  }

  private updateLegend(): void {
    const title = document.getElementById('legend-title');
    const bar = document.getElementById('legend-bar');
    const maxEl = document.getElementById('legend-max');
    if (this.mode === 'length') {
      if (title) title.textContent = 'Road Length (m)';
      if (bar) bar.className = 'legend-bar length';
      if (maxEl) maxEl.textContent = Math.round(this.maxLength).toString();
    } else {
      if (title) title.textContent = 'Noise events within 10 m';
      if (bar) bar.className = 'legend-bar noise';
      if (maxEl) maxEl.textContent = Math.round(this.maxNoise).toString();
    }
  }
}
