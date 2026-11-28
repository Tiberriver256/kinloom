import { constrainLayerToDateRange, dateRangeFromDate } from '@openhistoricalmap/maplibre-gl-dates';
import type { FilterSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { getResolvedThemeColorTokens } from '../lib/tokens.js';

export const OHM_STYLE_URL = 'https://www.openhistoricalmap.org/map-styles/main/main.json';
export const PAPER_LAND_LAYER_ID = 'kinloom-paper-land';
export const OVERVIEW_REFERENCE_YEAR = '1900';

const MAP_MAX_ZOOM = 12;
const DEFAULT_OHM_STYLE_TIMEOUT_MS = 4000;

const ARCHIVAL_SOURCE_LAYERS = new Set([
  'land',
  'water_areas',
  'water_lines',
  'water_areas_centroids',
  'land_ohm_lines',
  'land_ohm_centroids',
  'place_points_centroids',
  'populated_places',
]);

const DROPPED_LAYER_IDS = new Set(['ohm_landcover_hillshade', 'water_lines_labels_dam']);

const UNUSED_SOURCE_IDS = new Set(['ohm_landcover_hillshade']);

const ENGLISH_FIRST_NAME_EXPR: unknown[] = ['coalesce', ['get', 'name_en'], ['get', 'name']];

function isPlainNameGetter(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && value[0] === 'get' && value[1] === 'name';
}

function isItalicFontStack(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === 'OpenHistorical Italic';
}

function buildInitialDateState(initialYear: string): Record<string, { default: number | string | null }> {
  const range = dateRangeFromDate(initialYear);
  if (!range) {
    return {};
  }
  return {
    maplibre_gl_dates__startDecimalYear: {
      default: typeof range.startDecimalYear === 'number' ? range.startDecimalYear : null,
    },
    maplibre_gl_dates__startISODate: {
      default: typeof range.startISODate === 'string' ? range.startISODate : null,
    },
    maplibre_gl_dates__endDecimalYear: {
      default: typeof range.endDecimalYear === 'number' ? range.endDecimalYear : null,
    },
    maplibre_gl_dates__endISODate: {
      default: typeof range.endISODate === 'string' ? range.endISODate : null,
    },
  };
}

function hasSourceLayer(layer: LayerSpecification): layer is LayerSpecification & {
  source: string;
  'source-layer'?: string;
  filter?: FilterSpecification;
} {
  return 'source' in layer && typeof layer.source === 'string';
}

function transformLayer(layer: LayerSpecification, isDark: boolean): LayerSpecification | null {
  const palette = getResolvedThemeColorTokens(isDark);
  if (DROPPED_LAYER_IDS.has(layer.id)) {
    return null;
  }
  if (layer.type === 'background') {
    if (!isDark) {
      return layer;
    }
    return {
      ...layer,
      paint: { ...layer.paint, 'background-color': palette.land },
    };
  }
  if (typeof layer.minzoom === 'number' && layer.minzoom > MAP_MAX_ZOOM) {
    return null;
  }
  if (!hasSourceLayer(layer)) {
    return null;
  }
  const sourceLayer = layer['source-layer'];
  if (!sourceLayer || !ARCHIVAL_SOURCE_LAYERS.has(sourceLayer)) {
    return null;
  }

  if (layer.id === 'land' && layer.type === 'fill') {
    return {
      ...layer,
      id: PAPER_LAND_LAYER_ID,
      paint: { 'fill-color': palette.land },
    };
  }

  let next: LayerSpecification = layer;

  if (isDark && next.type === 'fill' && sourceLayer === 'water_areas') {
    next = {
      ...next,
      paint: { ...next.paint, 'fill-color': palette.water },
    };
  } else if (isDark && next.type === 'line' && sourceLayer === 'water_lines') {
    next = {
      ...next,
      paint: { ...next.paint, 'line-color': palette.water },
    };
  } else if (isDark && next.type === 'line' && sourceLayer === 'land_ohm_lines') {
    next = {
      ...next,
      paint: { ...next.paint, 'line-color': palette.futureStopStroke },
    };
  }

  if (next.type === 'symbol') {
    if (next.layout) {
      const nextLayout: Record<string, unknown> = { ...next.layout };
      let layoutChanged = false;
      if (isPlainNameGetter(nextLayout['text-field'])) {
        nextLayout['text-field'] = ENGLISH_FIRST_NAME_EXPR;
        layoutChanged = true;
      }
      if (isItalicFontStack(nextLayout['text-font'])) {
        nextLayout['text-font'] = ['OpenHistorical'];
        layoutChanged = true;
      }
      if (layoutChanged) {
        next = { ...next, layout: nextLayout as typeof next.layout };
      }
    }
    if (isDark) {
      next = {
        ...next,
        paint: {
          ...next.paint,
          'text-color': palette.labelColor,
          'text-halo-color': palette.labelHalo,
        },
      };
    }
  }

  if (hasSourceLayer(next) && next.source === 'ohm') {
    const constrainedFilter = constrainLayerToDateRange(next.filter);
    next = { ...next, filter: constrainedFilter };
  }

  return next;
}

/**
 * Prunes OpenHistoricalMap's style down to the archival cartographic layers
 * needed at zooms 1-12, switches labels to English-first, consolidates font
 * stacks, and pre-applies the initial date range.
 */
export function buildArchivalOhmStyle(
  rawStyle: StyleSpecification,
  initialYear = OVERVIEW_REFERENCE_YEAR,
  isDark = false
): StyleSpecification {
  const nextSources = Object.fromEntries(
    Object.entries(rawStyle.sources).filter(([sourceId]) => !UNUSED_SOURCE_IDS.has(sourceId))
  );

  const nextLayers: LayerSpecification[] = [];
  for (const layer of rawStyle.layers) {
    const transformed = transformLayer(layer, isDark);
    if (transformed) {
      nextLayers.push(transformed);
    }
  }

  const dateState = buildInitialDateState(initialYear);
  const existingState =
    'state' in rawStyle && typeof rawStyle.state === 'object' && rawStyle.state !== null
      ? rawStyle.state
      : {};

  return {
    ...rawStyle,
    sources: nextSources,
    layers: nextLayers,
    state: {
      ...existingState,
      ...dateState,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLayerSpecLike(value: unknown): boolean {
  return isPlainObject(value) && typeof value['id'] === 'string' && typeof value['type'] === 'string';
}

function isMapLibreStyleDocument(value: unknown): value is StyleSpecification {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    value['version'] === 8 &&
    isPlainObject(value['sources']) &&
    Array.isArray(value['layers']) &&
    value['layers'].every(isLayerSpecLike)
  );
}

let cachedRawStylePromise: Promise<StyleSpecification> | null = null;
let cachedDefaultLightStyle: StyleSpecification | null = null;
let cachedDefaultDarkStyle: StyleSpecification | null = null;

export function resetCachedOhmStyle(): void {
  cachedRawStylePromise = null;
  cachedDefaultLightStyle = null;
  cachedDefaultDarkStyle = null;
}

async function fetchOhmStyleWithTimeout(fetchFn: typeof fetch, timeoutMs: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms loading ${OHM_STYLE_URL}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchFn(OHM_STYLE_URL), timeoutPromise]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export async function loadArchivalOhmStyle(
  initialYear = OVERVIEW_REFERENCE_YEAR,
  fetchFn: typeof fetch = fetch,
  isDark = false,
  timeoutMs = DEFAULT_OHM_STYLE_TIMEOUT_MS
): Promise<StyleSpecification> {
  if (!cachedRawStylePromise) {
    cachedRawStylePromise = fetchOhmStyleWithTimeout(fetchFn, timeoutMs)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} loading ${OHM_STYLE_URL}`);
        }
        const raw: unknown = await res.json();
        if (!isMapLibreStyleDocument(raw)) {
          throw new Error(`Invalid MapLibre style JSON loaded from ${OHM_STYLE_URL}`);
        }
        return raw;
      })
      .catch((error: unknown) => {
        cachedRawStylePromise = null;
        throw error;
      });
  }
  const rawStyle = await cachedRawStylePromise;
  if (initialYear === OVERVIEW_REFERENCE_YEAR) {
    if (isDark) {
      if (!cachedDefaultDarkStyle) {
        cachedDefaultDarkStyle = buildArchivalOhmStyle(rawStyle, initialYear, true);
      }
      return cachedDefaultDarkStyle;
    }
    if (!cachedDefaultLightStyle) {
      cachedDefaultLightStyle = buildArchivalOhmStyle(rawStyle, initialYear, false);
    }
    return cachedDefaultLightStyle;
  }
  return buildArchivalOhmStyle(rawStyle, initialYear, isDark);
}
