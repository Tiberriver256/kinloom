import type { FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap, Source, StyleSpecification } from 'maplibre-gl';
import { setMaxParallelImageRequests, setWorkerCount, setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { PAPER_LAND_LAYER_ID } from '../../browser/ohmStyle.js';
import {
  getOfflineBasemapPalette,
  OFFLINE_BASEMAP_LAYER_IDS,
  OFFLINE_BASEMAP_SOURCE_IDS,
  OFFLINE_GRATICULE_GEOJSON,
  OFFLINE_INLAND_WATER_GEOJSON,
  OFFLINE_LAND_GEOJSON,
} from '../../lib/mapOfflineBasemap.js';
import { getResolvedThemeColorTokens } from '../../lib/tokens.js';
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

export function buildPaperStyle(isDark = false): StyleSpecification {
  const colors = getOfflineBasemapPalette(isDark);
  return {
    version: 8,
    name: 'paper',
    glyphs: 'https://www.openhistoricalmap.org/map-styles/fonts/{fontstack}/{range}.pbf',
    sources: {
      [OFFLINE_BASEMAP_SOURCE_IDS.graticule]: {
        type: 'geojson',
        data: OFFLINE_GRATICULE_GEOJSON,
      },
      [OFFLINE_BASEMAP_SOURCE_IDS.land]: {
        type: 'geojson',
        data: OFFLINE_LAND_GEOJSON,
      },
      [OFFLINE_BASEMAP_SOURCE_IDS.inlandWater]: {
        type: 'geojson',
        data: OFFLINE_INLAND_WATER_GEOJSON,
      },
    },
    layers: [
      {
        id: OFFLINE_BASEMAP_LAYER_IDS.background,
        type: 'background',
        paint: { 'background-color': colors.water },
      },
      {
        id: OFFLINE_BASEMAP_LAYER_IDS.graticule,
        type: 'line',
        source: OFFLINE_BASEMAP_SOURCE_IDS.graticule,
        paint: {
          'line-color': colors.graticule,
          'line-width': 0.75,
          'line-opacity': colors.graticuleOpacity,
          'line-dasharray': [2, 3],
        },
      },
      {
        id: OFFLINE_BASEMAP_LAYER_IDS.landFill,
        type: 'fill',
        source: OFFLINE_BASEMAP_SOURCE_IDS.land,
        paint: {
          'fill-color': colors.land,
        },
      },
      {
        id: OFFLINE_BASEMAP_LAYER_IDS.coastline,
        type: 'line',
        source: OFFLINE_BASEMAP_SOURCE_IDS.land,
        paint: {
          'line-color': colors.coastline,
          'line-width': 1.15,
          'line-opacity': colors.coastlineOpacity,
        },
      },
      {
        id: OFFLINE_BASEMAP_LAYER_IDS.inlandWaterFill,
        type: 'fill',
        source: OFFLINE_BASEMAP_SOURCE_IDS.inlandWater,
        paint: {
          'fill-color': colors.water,
        },
      },
      {
        id: OFFLINE_BASEMAP_LAYER_IDS.inlandWaterShore,
        type: 'line',
        source: OFFLINE_BASEMAP_SOURCE_IDS.inlandWater,
        paint: {
          'line-color': colors.coastline,
          'line-width': 0.9,
          'line-opacity': colors.coastlineOpacity,
        },
      },
    ],
  };
}

export const PAPER_STYLE: StyleSpecification = buildPaperStyle(false);

export function setPeriodBasemap(map: MapLibreMap, isDark = false): void {
  const palette = getResolvedThemeColorTokens(isDark);
  for (const layerId of MODERN_BASEMAP_LAYERS) {
    if (!map.getLayer(layerId)) {
      continue;
    }
    map.setLayoutProperty(layerId, 'visibility', 'none');
  }
  if (map.getLayer(PAPER_LAND_LAYER_ID)) {
    if (typeof map.setPaintProperty === 'function') {
      map.setPaintProperty(PAPER_LAND_LAYER_ID, 'fill-color', palette.land);
    }
    return;
  }
  if (!map.getSource('osm_land')) {
    return;
  }
  const beforeId = map.getLayer('water_areas_ne') ? 'water_areas_ne' : undefined;
  map.addLayer(
    {
      id: PAPER_LAND_LAYER_ID,
      type: 'fill',
      source: 'osm_land',
      'source-layer': 'land',
      paint: { 'fill-color': palette.land },
    },
    beforeId
  );
}

export interface FitPaddingMeasurements {
  readonly viewportWidth: number;
  readonly viewportHeight?: number | undefined;
  readonly toolbarHeight?: number | undefined;
  readonly bottomDockHeight?: number | undefined;
  readonly hasSelectedStop: boolean;
  readonly drawerBottomPx?: number | undefined;
}

export interface FitPadding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export function computeSafeFitPadding(input: FitPaddingMeasurements): FitPadding {
  const isMobile = input.viewportWidth <= 767;
  const toolbarOffset = isMobile ? 8 : 12;
  const toolbarGap = isMobile ? 12 : 20;
  const measuredTop =
    input.toolbarHeight !== undefined && input.toolbarHeight > 0
      ? Math.ceil(input.toolbarHeight) + toolbarOffset + toolbarGap
      : isMobile
        ? 76
        : 82;

  const defaultBottom = isMobile ? (input.hasSelectedStop ? 210 : 124) : 112;
  const measuredBottom =
    input.bottomDockHeight !== undefined && input.bottomDockHeight > 0
      ? Math.ceil(input.bottomDockHeight) + (isMobile ? 18 : 24)
      : 0;

  let top = measuredTop;
  let bottom = Math.max(defaultBottom, measuredBottom, input.drawerBottomPx ?? 0);
  let left = isMobile ? 28 : 36;
  let right = isMobile ? 32 : input.hasSelectedStop ? 344 : 118;

  if (input.viewportHeight !== undefined && input.viewportHeight > 0) {
    const maxVertical = Math.max(0, input.viewportHeight - 120);
    if (top + bottom > maxVertical) {
      const scale = maxVertical / Math.max(1, top + bottom);
      top = Math.floor(top * scale);
      bottom = Math.floor(bottom * scale);
    }
  }

  if (input.viewportWidth > 0) {
    const maxHorizontal = Math.max(0, input.viewportWidth - 120);
    if (left + right > maxHorizontal) {
      const scale = maxHorizontal / Math.max(1, left + right);
      left = Math.floor(left * scale);
      right = Math.floor(right * scale);
    }
  }

  return { top, right, bottom, left };
}

export function getFitOptions(
  hasSelectedStop: boolean,
  drawerBottomPx?: number,
  measurements?: {
    readonly viewportWidth?: number | undefined;
    readonly viewportHeight?: number | undefined;
    readonly toolbarHeight?: number | undefined;
    readonly bottomDockHeight?: number | undefined;
  }
): {
  padding: { top: number; right: number; bottom: number; left: number };
  duration: number;
  maxZoom: number;
  absolutePadding: boolean;
} {
  const viewportWidth =
    measurements?.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1280);
  const viewportHeight =
    measurements?.viewportHeight ?? (typeof window !== 'undefined' ? window.innerHeight : undefined);
  const padding = computeSafeFitPadding({
    viewportWidth,
    viewportHeight,
    toolbarHeight: measurements?.toolbarHeight,
    bottomDockHeight: measurements?.bottomDockHeight,
    hasSelectedStop,
    drawerBottomPx,
  });
  return {
    padding: { top: padding.top, right: padding.right, bottom: padding.bottom, left: padding.left },
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
    const raw: unknown = hits[0]?.properties?.['id'];
    onSelect(typeof raw === 'string' ? raw : null);
  });
}

function addFamilyLayers(map: MapLibreMap, isDark = false): void {
  const palette = getResolvedThemeColorTokens(isDark);
  map.addLayer({
    id: 'migration-guide',
    type: 'line',
    source: SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'guide'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': palette.route,
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
      'circle-color': palette.futureStop,
      'circle-opacity': 0.78,
      'circle-stroke-width': 1,
      'circle-stroke-color': palette.futureStopStroke,
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
      'line-color': palette.route,
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
      'line-color': palette.routeLatest,
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
      'line-color': palette.route,
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
      'line-color': palette.routeLatest,
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
      'circle-color': palette.haloFill,
      'circle-opacity': 0.55,
      'circle-stroke-width': 2,
      'circle-stroke-color': palette.haloStroke,
    },
  });

  map.addLayer({
    id: STOP_LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'stop'],
    paint: {
      'circle-radius': ['case', ['==', ['get', 'selected'], true], 9, 5],
      'circle-color': ['coalesce', ['get', 'color'], palette.stopDefault],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': palette.stopStroke,
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
      'text-offset': [
        'case',
        ['==', ['get', 'labelAnchor'], 'right'],
        ['literal', [-0.75, 0]],
        ['literal', [0.75, 0]],
      ],
      'text-anchor': ['coalesce', ['get', 'labelAnchor'], 'left'],
      'text-max-width': 14,
      'text-allow-overlap': false,
      'text-padding': 4,
      'text-optional': true,
    },
    paint: {
      'text-color': palette.labelColor,
      'text-halo-color': palette.labelHalo,
      'text-halo-width': isDark ? 1.6 : 1.4,
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
      'text-offset': [
        'case',
        ['==', ['get', 'labelAnchor'], 'right'],
        ['literal', [-0.8, 0]],
        ['literal', [0.8, 0]],
      ],
      'text-anchor': ['coalesce', ['get', 'labelAnchor'], 'left'],
      'text-max-width': 14,
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-padding': 4,
    },
    paint: {
      'text-color': palette.labelColor,
      'text-halo-color': palette.labelHalo,
      'text-halo-width': 1.6,
    },
  });
}

export function applyMapThemeToLayers(map: MapLibreMap, isDark: boolean): void {
  if (typeof map.setPaintProperty !== 'function') {
    return;
  }
  const palette = getResolvedThemeColorTokens(isDark);
  const offlinePalette = getOfflineBasemapPalette(isDark);
  const paintIfPresent = (
    layerId: string,
    prop: Parameters<MapLibreMap['setPaintProperty']>[1],
    value: Parameters<MapLibreMap['setPaintProperty']>[2]
  ): void => {
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, prop, value);
    }
  };

  const hasOfflineBasemap = Boolean(map.getLayer(OFFLINE_BASEMAP_LAYER_IDS.landFill));
  if (hasOfflineBasemap) {
    paintIfPresent(OFFLINE_BASEMAP_LAYER_IDS.background, 'background-color', offlinePalette.water);
    paintIfPresent(OFFLINE_BASEMAP_LAYER_IDS.graticule, 'line-color', offlinePalette.graticule);
    paintIfPresent(OFFLINE_BASEMAP_LAYER_IDS.graticule, 'line-opacity', offlinePalette.graticuleOpacity);
    paintIfPresent(OFFLINE_BASEMAP_LAYER_IDS.landFill, 'fill-color', offlinePalette.land);
    paintIfPresent(OFFLINE_BASEMAP_LAYER_IDS.coastline, 'line-color', offlinePalette.coastline);
    paintIfPresent(OFFLINE_BASEMAP_LAYER_IDS.coastline, 'line-opacity', offlinePalette.coastlineOpacity);
    paintIfPresent(OFFLINE_BASEMAP_LAYER_IDS.inlandWaterFill, 'fill-color', offlinePalette.water);
    paintIfPresent(OFFLINE_BASEMAP_LAYER_IDS.inlandWaterShore, 'line-color', offlinePalette.coastline);
    paintIfPresent(
      OFFLINE_BASEMAP_LAYER_IDS.inlandWaterShore,
      'line-opacity',
      offlinePalette.coastlineOpacity
    );
  } else {
    paintIfPresent(OFFLINE_BASEMAP_LAYER_IDS.background, 'background-color', palette.land);
  }
  paintIfPresent(PAPER_LAND_LAYER_ID, 'fill-color', palette.land);

  const styleLayers = typeof map.getStyle === 'function' ? (map.getStyle()?.layers ?? []) : [];
  for (const layer of styleLayers) {
    if (layer.type === 'background') {
      if (hasOfflineBasemap && layer.id === OFFLINE_BASEMAP_LAYER_IDS.background) {
        continue;
      }
      paintIfPresent(layer.id, 'background-color', palette.land);
    } else if (layer.type === 'fill' && 'source-layer' in layer && layer['source-layer'] === 'water_areas') {
      paintIfPresent(layer.id, 'fill-color', palette.water);
    }
  }

  paintIfPresent('migration-guide', 'line-color', palette.route);
  paintIfPresent('migration-future', 'circle-color', palette.futureStop);
  paintIfPresent('migration-future', 'circle-stroke-color', palette.futureStopStroke);
  paintIfPresent('migration-route', 'line-color', palette.route);
  paintIfPresent('migration-route-latest', 'line-color', palette.routeLatest);
  paintIfPresent('migration-route-dash', 'line-color', palette.route);
  paintIfPresent('migration-route-dash-latest', 'line-color', palette.routeLatest);
  paintIfPresent('migration-stop-halo', 'circle-color', palette.haloFill);
  paintIfPresent('migration-stop-halo', 'circle-stroke-color', palette.haloStroke);
  paintIfPresent(STOP_LAYER_ID, 'circle-color', ['coalesce', ['get', 'color'], palette.stopDefault]);
  paintIfPresent(STOP_LAYER_ID, 'circle-stroke-color', palette.stopStroke);
  paintIfPresent('migration-labels', 'text-color', palette.labelColor);
  paintIfPresent('migration-labels', 'text-halo-color', palette.labelHalo);
  paintIfPresent('migration-labels', 'text-halo-width', isDark ? 1.6 : 1.4);
  paintIfPresent('migration-label-selected', 'text-color', palette.labelColor);
  paintIfPresent('migration-label-selected', 'text-halo-color', palette.labelHalo);
  paintIfPresent('migration-label-selected', 'text-halo-width', 1.6);
}

function isGeoJsonSource(source: Source | undefined): source is GeoJSONSource {
  return source?.type === 'geojson';
}

export function syncFamilyOverlay(
  map: MapLibreMap,
  data: FeatureCollection,
  onSelect: (id: string | null) => void,
  isDark = false
): void {
  const source = map.getSource(SOURCE_ID);
  if (isGeoJsonSource(source)) {
    void source.setData(data);
    return;
  }
  map.addSource(SOURCE_ID, { type: 'geojson', data });
  addFamilyLayers(map, isDark);
  bindStopClicks(map, onSelect);
}
