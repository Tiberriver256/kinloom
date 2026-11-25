import type { FilterSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { constrainLayerToDateRange, dateRangeFromDate } from '@openhistoricalmap/maplibre-gl-dates';

export const OHM_STYLE_URL = 'https://www.openhistoricalmap.org/map-styles/main/main.json';
export const PAPER_LAND_LAYER_ID = 'kinloom-paper-land';
export const OVERVIEW_REFERENCE_YEAR = '1900';

const MAP_MAX_ZOOM = 12;

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

const DROPPED_LAYER_IDS = new Set([
  'ohm_landcover_hillshade',
  'water_lines_labels_dam',
]);

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

function transformLayer(layer: LayerSpecification): LayerSpecification | null {
  if (DROPPED_LAYER_IDS.has(layer.id)) {
    return null;
  }
  if (layer.type === 'background') {
    return layer;
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
      paint: { 'fill-color': '#EFE4C8' },
    };
  }

  let next: LayerSpecification = layer;

  if (next.type === 'symbol' && next.layout) {
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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- preserving SymbolLayerSpecification after updating text-field/text-font layout properties
      next = { ...next, layout: nextLayout as typeof next.layout };
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
): StyleSpecification {
  const nextSources = Object.fromEntries(
    Object.entries(rawStyle.sources).filter(([sourceId]) => !UNUSED_SOURCE_IDS.has(sourceId)),
  );

  const nextLayers: LayerSpecification[] = [];
  for (const layer of rawStyle.layers) {
    const transformed = transformLayer(layer);
    if (transformed) {
      nextLayers.push(transformed);
    }
  }

  const dateState = buildInitialDateState(initialYear);
  const existingState = 'state' in rawStyle && typeof rawStyle.state === 'object' && rawStyle.state !== null
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

let cachedStylePromise: Promise<StyleSpecification> | null = null;

export function resetCachedOhmStyle(): void {
  cachedStylePromise = null;
}

export async function loadArchivalOhmStyle(
  initialYear = OVERVIEW_REFERENCE_YEAR,
  fetchFn: typeof fetch = fetch,
): Promise<StyleSpecification> {
  if (!cachedStylePromise) {
    cachedStylePromise = fetchFn(OHM_STYLE_URL)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} loading ${OHM_STYLE_URL}`);
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- OHM main.json conforms to MapLibre StyleSpecification
        const raw = (await res.json()) as StyleSpecification;
        return buildArchivalOhmStyle(raw, initialYear);
      })
      .catch((error: unknown) => {
        cachedStylePromise = null;
        throw error;
      });
  }
  const baseStyle = await cachedStylePromise;
  if (initialYear === OVERVIEW_REFERENCE_YEAR) {
    return baseStyle;
  }
  return {
    ...baseStyle,
    state: {
      ...baseStyle.state,
      ...buildInitialDateState(initialYear),
    },
  };
}
