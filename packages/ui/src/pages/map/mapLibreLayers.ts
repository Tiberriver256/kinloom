import type { FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap, Source, StyleSpecification } from 'maplibre-gl';
import { setMaxParallelImageRequests, setWorkerCount, setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { PAPER_LAND_LAYER_ID } from '../../lib/ohmStyle.js';
import { KINLOOM_COLOR_TOKENS } from '../../lib/tokens.js';
import { SOURCE_ID, STOP_LAYER_ID } from './mapOverlayData.js';

let maplibreConfigured = false;
const MODERN_BASEMAP_LAYERS = ['land', 'ohm_landcover_hillshade'];
const pointerBound = new WeakSet<MapLibreMap>();

export function ensureMapLibreConfigured(): void {
  if (maplibreConfigured || typeof window === 'undefined') {
    return;
  }
  maplibreConfigured = true;
  setWorkerUrl(maplibreWorkerUrl);
  const workerCount = Math.min(6, Math.max(2, navigator.hardwareConcurrency || 4));
  setWorkerCount(workerCount);
  setMaxParallelImageRequests(16);
}

export const PAPER_STYLE = {
  version: 8,
  name: 'paper',
  glyphs: 'https://www.openhistoricalmap.org/map-styles/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [
    {
      id: 'paper',
      type: 'background',
      paint: { 'background-color': KINLOOM_COLOR_TOKENS.warmLinen },
    },
  ],
} satisfies StyleSpecification;

export function setPeriodBasemap(map: MapLibreMap): void {
  for (const layerId of MODERN_BASEMAP_LAYERS) {
    if (!map.getLayer(layerId)) {
      continue;
    }
    map.setLayoutProperty(layerId, 'visibility', 'none');
  }
  if (map.getLayer(PAPER_LAND_LAYER_ID) || !map.getSource('osm_land')) {
    return;
  }
  const beforeId = map.getLayer('water_areas_ne') ? 'water_areas_ne' : undefined;
  map.addLayer(
    {
      id: PAPER_LAND_LAYER_ID,
      type: 'fill',
      source: 'osm_land',
      'source-layer': 'land',
      paint: { 'fill-color': KINLOOM_COLOR_TOKENS.warmLinen },
    },
    beforeId
  );
}

export function getFitOptions(
  hasSelectedStop: boolean,
  drawerBottomPx?: number
): {
  padding: { top: number; right: number; bottom: number; left: number };
  duration: number;
  maxZoom: number;
  absolutePadding: boolean;
} {
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 767;
  if (isMobile) {
    const defaultBottom = hasSelectedStop ? 210 : 116;
    return {
      padding: {
        top: 72,
        right: 76,
        bottom: drawerBottomPx !== undefined ? Math.max(defaultBottom, drawerBottomPx) : defaultBottom,
        left: 20,
      },
      duration: 0,
      maxZoom: 6.5,
      absolutePadding: true,
    };
  }
  return {
    padding: { top: 82, right: hasSelectedStop ? 344 : 110, bottom: 108, left: 28 },
    duration: 0,
    maxZoom: 6.5,
    absolutePadding: true,
  };
}

function bindStopClicks(map: MapLibreMap, onSelect: (id: string | null) => void): void {
  if (pointerBound.has(map)) {
    return;
  }
  pointerBound.add(map);
  const canvas = map.getCanvas();
  map.on('mouseenter', STOP_LAYER_ID, () => {
    canvas.style.cursor = 'pointer';
  });
  map.on('mouseleave', STOP_LAYER_ID, () => {
    canvas.style.cursor = '';
  });
  map.on('click', (event) => {
    if (!map.getLayer(STOP_LAYER_ID)) {
      onSelect(null);
      return;
    }
    const hits = map.queryRenderedFeatures(event.point, { layers: [STOP_LAYER_ID] });
    const raw: unknown = hits[0]?.properties?.id;
    onSelect(typeof raw === 'string' ? raw : null);
  });
}

function addFamilyLayers(map: MapLibreMap): void {
  map.addLayer({
    id: 'migration-guide',
    type: 'line',
    source: SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'guide'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': KINLOOM_COLOR_TOKENS.loomOchre,
      'line-width': 1.2,
      'line-opacity': 0.32,
      'line-dasharray': [1.4, 1.2],
    },
  });

  map.addLayer({
    id: 'migration-future',
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'future'],
    paint: {
      'circle-radius': 3.8,
      'circle-color': KINLOOM_COLOR_TOKENS.slateTaupe,
      'circle-opacity': 0.78,
      'circle-stroke-width': 1,
      'circle-stroke-color': KINLOOM_COLOR_TOKENS.warmSepia,
    },
  });

  map.addLayer({
    id: 'migration-route',
    type: 'line',
    source: SOURCE_ID,
    filter: [
      'all',
      ['==', ['get', 'kind'], 'route'],
      ['==', ['get', 'dashed'], false],
      ['==', ['get', 'latest'], false],
    ],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': KINLOOM_COLOR_TOKENS.loomOchre,
      'line-width': 1.8,
      'line-opacity': 0.78,
    },
  });

  map.addLayer({
    id: 'migration-route-latest',
    type: 'line',
    source: SOURCE_ID,
    filter: [
      'all',
      ['==', ['get', 'kind'], 'route'],
      ['==', ['get', 'dashed'], false],
      ['==', ['get', 'latest'], true],
    ],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': KINLOOM_COLOR_TOKENS.sealCrimson,
      'line-width': 2.6,
      'line-opacity': 0.95,
    },
  });

  map.addLayer({
    id: 'migration-route-dash',
    type: 'line',
    source: SOURCE_ID,
    filter: [
      'all',
      ['==', ['get', 'kind'], 'route'],
      ['==', ['get', 'dashed'], true],
      ['==', ['get', 'latest'], false],
    ],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': KINLOOM_COLOR_TOKENS.loomOchre,
      'line-width': 1.8,
      'line-opacity': 0.78,
      'line-dasharray': [2, 1.4],
    },
  });

  map.addLayer({
    id: 'migration-route-dash-latest',
    type: 'line',
    source: SOURCE_ID,
    filter: [
      'all',
      ['==', ['get', 'kind'], 'route'],
      ['==', ['get', 'dashed'], true],
      ['==', ['get', 'latest'], true],
    ],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': KINLOOM_COLOR_TOKENS.sealCrimson,
      'line-width': 2.6,
      'line-opacity': 0.95,
      'line-dasharray': [2, 1.4],
    },
  });

  map.addLayer({
    id: 'migration-stop-halo',
    type: 'circle',
    source: SOURCE_ID,
    filter: ['all', ['==', ['get', 'kind'], 'stop'], ['==', ['get', 'selected'], true]],
    paint: {
      'circle-radius': 18,
      'circle-color': KINLOOM_COLOR_TOKENS.loomOchre,
      'circle-opacity': 0.55,
      'circle-stroke-width': 2,
      'circle-stroke-color': KINLOOM_COLOR_TOKENS.amberWash,
    },
  });

  map.addLayer({
    id: STOP_LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'stop'],
    paint: {
      'circle-radius': ['case', ['==', ['get', 'selected'], true], 9, 5],
      'circle-color': ['coalesce', ['get', 'color'], KINLOOM_COLOR_TOKENS.archivalIndigo],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': KINLOOM_COLOR_TOKENS.ragCard,
    },
  });

  map.addLayer({
    id: 'migration-labels',
    type: 'symbol',
    source: SOURCE_ID,
    filter: [
      'all',
      ['==', ['get', 'kind'], 'stop'],
      ['==', ['get', 'showLabel'], true],
      ['==', ['get', 'selected'], false],
    ],
    layout: {
      'text-field': ['coalesce', ['get', 'label'], ''],
      'text-font': ['OpenHistorical'],
      'text-size': 12,
      'text-offset': [0.75, 0],
      'text-anchor': 'left',
      'text-allow-overlap': false,
      'text-padding': 4,
      'text-optional': true,
    },
    paint: {
      'text-color': KINLOOM_COLOR_TOKENS.archivalIndigo,
      'text-halo-color': KINLOOM_COLOR_TOKENS.ragCard,
      'text-halo-width': 1.4,
    },
  });

  map.addLayer({
    id: 'migration-label-selected',
    type: 'symbol',
    source: SOURCE_ID,
    filter: ['all', ['==', ['get', 'kind'], 'stop'], ['==', ['get', 'selected'], true]],
    layout: {
      'text-field': ['coalesce', ['get', 'label'], ''],
      'text-font': ['OpenHistorical Bold'],
      'text-size': 12.5,
      'text-offset': [0.8, 0],
      'text-anchor': 'left',
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-padding': 4,
    },
    paint: {
      'text-color': KINLOOM_COLOR_TOKENS.archivalIndigo,
      'text-halo-color': KINLOOM_COLOR_TOKENS.ragCard,
      'text-halo-width': 1.6,
    },
  });
}

function isGeoJsonSource(source: Source | undefined): source is GeoJSONSource {
  return source?.type === 'geojson';
}

export function syncFamilyOverlay(
  map: MapLibreMap,
  data: FeatureCollection,
  onSelect: (id: string | null) => void
): void {
  const source = map.getSource(SOURCE_ID);
  if (isGeoJsonSource(source)) {
    void source.setData(data);
    return;
  }
  map.addSource(SOURCE_ID, { type: 'geojson', data });
  addFamilyLayers(map);
  bindStopClicks(map, onSelect);
}
