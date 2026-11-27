// Side-effect CSS import: the standard Vite pattern for loading library styles.
import { cx } from '../lib/cx.js';
import cssMod0 from './IndexPage.module.css';
import cssMod1 from './NotFoundPage.module.css';
import cssMod2 from './TreeAndMapPage.module.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import type {
  LineageRouteMode,
  MapJourneyState,
  MigrationEraConfig,
  MigrationSegment,
  MigrationStop,
  Place,
} from '@kinloom/core';
import {
  buildMigrationSegments,
  buildMigrationStops,
  buildPerPersonMigrationSegments,
  computeStopsBounds,
  DEFAULT_MIGRATION_ERAS,
  journeyNext,
  journeyPlayToggle,
  journeyPrev,
  journeyReset,
  journeyScrub,
  journeyTick,
} from '@kinloom/core';
import { filterByDate } from '@openhistoricalmap/maplibre-gl-dates';
import type { Feature, FeatureCollection } from 'geojson';
import type { ErrorEvent, GeoJSONSource, Source, StyleSpecification } from 'maplibre-gl';
import {
  AttributionControl,
  Map as MapLibreMap,
  setMaxParallelImageRequests,
  setWorkerCount,
  setWorkerUrl,
} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import {
  loadArchivalOhmStyle,
  OHM_STYLE_URL,
  OVERVIEW_REFERENCE_YEAR,
  PAPER_LAND_LAYER_ID,
} from '../lib/ohmStyle.js';
import { KINLOOM_COLOR_TOKENS } from '../lib/tokens.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod1, ...cssMod2 };

let maplibreConfigured = false;

function ensureMapLibreConfigured(): void {
  if (maplibreConfigured || typeof window === 'undefined') {
    return;
  }
  maplibreConfigured = true;
  setWorkerUrl(maplibreWorkerUrl);
  const workerCount = Math.min(6, Math.max(2, navigator.hardwareConcurrency || 4));
  setWorkerCount(workerCount);
  setMaxParallelImageRequests(16);
}

const MODERN_BASEMAP_LAYERS = ['land', 'ohm_landcover_hillshade'];

function setPeriodBasemap(map: MapLibreMap): void {
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

const SOURCE_ID = 'kinloom-migration';
const STOP_LAYER_ID = 'migration-stops';

const FALLBACK_ERA_COLORS = [
  KINLOOM_COLOR_TOKENS.archivalIndigo,
  KINLOOM_COLOR_TOKENS.pineMoss,
  KINLOOM_COLOR_TOKENS.loomOchre,
  KINLOOM_COLOR_TOKENS.sealCrimson,
  KINLOOM_COLOR_TOKENS.cobaltInk,
  KINLOOM_COLOR_TOKENS.warmSepia,
];

const PAPER_STYLE = {
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

type HistoricalMapStatus = { kind: 'pending' } | { kind: 'ready' } | { kind: 'failed' };

function getFitOptions(
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

const pointerBound = new WeakSet<MapLibreMap>();

function routeArc(from: Place, to: Place): [number, number][] {
  const startLng = from.lng;
  const startLat = from.lat;
  const endLng = to.lng;
  const endLat = to.lat;
  const span = Math.hypot(endLng - startLng, endLat - startLat);
  const bow = Math.min(7, Math.max(0.4, span * 0.14));
  const controlLng = (startLng + endLng) / 2;
  const controlLat = (startLat + endLat) / 2 + bow;
  const steps = 32;
  const coordinates: [number, number][] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    coordinates.push([
      u * u * startLng + 2 * u * t * controlLng + t * t * endLng,
      u * u * startLat + 2 * u * t * controlLat + t * t * endLat,
    ]);
  }
  return coordinates;
}

function wantsLabel(
  index: number,
  count: number,
  stopId: string,
  selectedStopId: string | null,
  personFilter: string
): boolean {
  if (stopId === selectedStopId) {
    return true;
  }
  if (personFilter !== 'all') {
    return true;
  }
  return index === 0 || index === count - 1;
}

function buildFamilyOverlay(input: {
  stops: MigrationStop[];
  visibleStops: MigrationStop[];
  segments: MigrationSegment[];
  allSegments: MigrationSegment[];
  stepIndex: number;
  selectedStopId: string | null;
  personFilter: string;
  stageColors: ReadonlyMap<string, string>;
}): FeatureCollection {
  const features: Feature[] = [];
  const stepping = input.stepIndex >= 0;

  if (stepping) {
    for (const segment of input.allSegments) {
      features.push({
        type: 'Feature',
        properties: { kind: 'guide' },
        geometry: {
          type: 'LineString',
          coordinates: routeArc(segment.from.place, segment.to.place),
        },
      });
    }
    for (const stop of input.stops.slice(input.visibleStops.length)) {
      features.push({
        type: 'Feature',
        properties: { kind: 'future', id: stop.id },
        geometry: { type: 'Point', coordinates: [stop.place.lng, stop.place.lat] },
      });
    }
  }

  for (const [index, segment] of input.segments.entries()) {
    features.push({
      type: 'Feature',
      properties: {
        kind: 'route',
        dashed: segment.distanceMiles > 2000,
        latest: stepping && index === input.segments.length - 1,
      },
      geometry: {
        type: 'LineString',
        coordinates: routeArc(segment.from.place, segment.to.place),
      },
    });
  }

  for (const [index, stop] of input.visibleStops.entries()) {
    features.push({
      type: 'Feature',
      properties: {
        kind: 'stop',
        id: stop.id,
        color: input.stageColors.get(stop.lineageStage) ?? KINLOOM_COLOR_TOKENS.archivalIndigo,
        label: `${stop.year} · ${stop.place.name}`,
        selected: stop.id === input.selectedStopId,
        showLabel: wantsLabel(
          index,
          input.visibleStops.length,
          stop.id,
          input.selectedStopId,
          input.personFilter
        ),
      },
      geometry: { type: 'Point', coordinates: [stop.place.lng, stop.place.lat] },
    });
  }

  return { type: 'FeatureCollection', features };
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

function syncFamilyOverlay(
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

export const MapPage: React.FC = () => {
  const { siteConfig, bundle, peopleById, placesById, placesBySlug, loading, error } = useArchiveData();
  const [searchParams] = useSearchParams();
  const mapHostRef = useRef<(HTMLDivElement & { kinloomMigrationMap?: MapLibreMap }) | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleLoadedRef = useRef(false);
  const historicalFailedRef = useRef(false);
  const pendingBoundsRef = useRef<[[number, number], [number, number]] | null>(null);
  const programmaticMoveRef = useRef(false);
  const lastAppliedDateRef = useRef<string | null>(null);

  const [selectedPersonId, setSelectedPersonId] = useState<string>('all');
  const [selectedEraId, setSelectedEraId] = useState<string>('all');
  const [routeMode, setRouteMode] = useState<LineageRouteMode>('per-person');
  const [drawerExpanded, setDrawerExpanded] = useState<boolean>(false);
  const prevFilterKeyRef = useRef('all:all');
  const [stepIndex, setStepIndex] = useState<number>(-1);
  const [playing, setPlaying] = useState<boolean>(false);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [historicalMap, setHistoricalMap] = useState<HistoricalMapStatus>({ kind: 'pending' });
  const [cardSide, setCardSide] = useState<'left' | 'right'>('right');
  const cardRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);

  const migrationEras = useMemo<readonly MigrationEraConfig[]>(
    () => (siteConfig.migrationEras.length > 0 ? siteConfig.migrationEras : DEFAULT_MIGRATION_ERAS),
    [siteConfig.migrationEras]
  );

  const stageColorMap = useMemo(() => {
    const map = new Map<string, string>();
    migrationEras.forEach((era, idx) => {
      map.set(era.id, era.color ?? FALLBACK_ERA_COLORS[idx % FALLBACK_ERA_COLORS.length]);
    });
    return map;
  }, [migrationEras]);

  const stageLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const era of migrationEras) {
      map.set(era.id, era.label);
    }
    return map;
  }, [migrationEras]);

  const selectablePeople = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return bundle.people
      .filter((person) => !person.is_living || person.full_name !== 'Living')
      .filter((person) => (person.event_count || 0) >= 2)
      .toSorted(
        (a, b) => (b.event_count || 0) - (a.event_count || 0) || a.full_name.localeCompare(b.full_name)
      );
  }, [bundle]);

  const allStopsForPerson = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return buildMigrationStops(bundle, placesById, peopleById, {
      personIdFilter: selectedPersonId === 'all' ? null : selectedPersonId,
      migrationEras,
    });
  }, [bundle, placesById, peopleById, selectedPersonId, migrationEras]);

  const stops = useMemo(() => {
    if (selectedEraId === 'all') {
      return allStopsForPerson;
    }
    return allStopsForPerson.filter((stop) => stop.lineageStage === selectedEraId);
  }, [allStopsForPerson, selectedEraId]);

  const eraStopCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const stop of allStopsForPerson) {
      counts.set(stop.lineageStage, (counts.get(stop.lineageStage) ?? 0) + 1);
    }
    return counts;
  }, [allStopsForPerson]);

  const visibleStops = useMemo(() => {
    if (stepIndex < 0 || stepIndex >= stops.length) {
      return stops;
    }
    return stops.slice(0, stepIndex + 1);
  }, [stops, stepIndex]);

  const usePerPersonSegments = selectedPersonId === 'all' && routeMode === 'per-person';

  const allSegments = useMemo(
    () =>
      usePerPersonSegments ? buildPerPersonMigrationSegments(stops, 18) : buildMigrationSegments(stops, 18),
    [stops, usePerPersonSegments]
  );
  const segments = useMemo(
    () =>
      usePerPersonSegments
        ? buildPerPersonMigrationSegments(visibleStops, 18)
        : buildMigrationSegments(visibleStops, 18),
    [visibleStops, usePerPersonSegments]
  );

  const selectedStop = selectedStopId ? (stops.find((stop) => stop.id === selectedStopId) ?? null) : null;

  const stopIds = useMemo(() => stops.map((stop) => stop.id), [stops]);
  const journey: MapJourneyState = { stepIndex, playing, selectedStopId };
  const journeyRef = useRef(journey);
  const stopIdsRef = useRef(stopIds);
  useEffect(() => {
    journeyRef.current = journey;
    stopIdsRef.current = stopIds;
  });
  const applyJourney = useCallback((next: MapJourneyState) => {
    setStepIndex(next.stepIndex);
    setPlaying(next.playing);
    setSelectedStopId(next.selectedStopId);
  }, []);
  const eraYear = selectedStop?.year ?? (stepIndex >= 0 ? stops[stepIndex]?.year : null);

  const overlay = useMemo(
    () =>
      buildFamilyOverlay({
        stops,
        visibleStops,
        segments,
        allSegments,
        stepIndex,
        selectedStopId: selectedStop?.id ?? null,
        personFilter: selectedPersonId,
        stageColors: stageColorMap,
      }),
    [stops, visibleStops, segments, allSegments, stepIndex, selectedStop?.id, selectedPersonId, stageColorMap]
  );
  const overlayRef = useRef(overlay);
  useLayoutEffect(() => {
    overlayRef.current = overlay;
  });

  const defaultBounds = useMemo<[[number, number], [number, number]]>(() => {
    const computed = computeStopsBounds(allStopsForPerson, siteConfig.mapDefaults);
    if (computed) {
      return computed;
    }
    const { centerLng, centerLat, minSpanDeg } = siteConfig.mapDefaults;
    const span = Math.max(4, minSpanDeg * 4);
    return [
      [centerLng - span, centerLat - span],
      [centerLng + span, centerLat + span],
    ];
  }, [allStopsForPerson, siteConfig.mapDefaults]);

  const fitCameraBounds = useCallback(
    (bounds: [[number, number], [number, number]], hasSelectedStop: boolean) => {
      const map = mapRef.current;
      if (!map) {
        pendingBoundsRef.current = bounds;
        return;
      }
      pendingBoundsRef.current = null;
      programmaticMoveRef.current = true;
      map.fitBounds(bounds, getFitOptions(hasSelectedStop));
      window.setTimeout(() => {
        programmaticMoveRef.current = false;
      }, 60);
    },
    []
  );

  useEffect(() => {
    if (loading || !bundle) {
      return undefined;
    }
    const host = mapHostRef.current;
    if (!host) {
      return undefined;
    }

    ensureMapLibreConfigured();
    let cancelled = false;
    styleLoadedRef.current = false;
    historicalFailedRef.current = false;
    lastAppliedDateRef.current = null;
    let activeMap: MapLibreMap | null = null;

    const mountMap = (initialStyle: StyleSpecification, isFallback: boolean): void => {
      if (cancelled) {
        return;
      }
      if (isFallback) {
        historicalFailedRef.current = true;
        setHistoricalMap({ kind: 'failed' });
      }
      let map: MapLibreMap;
      try {
        map = new MapLibreMap({
          container: host,
          style: initialStyle,
          bounds: defaultBounds,
          fitBoundsOptions: getFitOptions(false),
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          maxPitch: 0,
          minZoom: 1.4,
          maxZoom: 12,
          maxTileCacheSize: 240,
          renderWorldCopies: false,
          fadeDuration: 0,
        });
      } catch {
        historicalFailedRef.current = true;
        setHistoricalMap({ kind: 'failed' });
        return;
      }
      activeMap = map;
      map.addControl(
        new AttributionControl({
          compact: true,
          customAttribution: [
            '<a href="https://www.openhistoricalmap.org/" target="_blank" rel="noopener noreferrer">OpenHistoricalMap</a>',
            '<a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre</a>',
          ],
        }),
        'bottom-left'
      );
      mapRef.current = map;
      host.kinloomMigrationMap = map;
      map.getCanvas().setAttribute('aria-label', `${siteConfig.site.familyName} migration map`);

      const onStyle = (): void => {
        if (cancelled) {
          return;
        }
        styleLoadedRef.current = true;
        setPeriodBasemap(map);
        if (!historicalFailedRef.current) {
          lastAppliedDateRef.current = OVERVIEW_REFERENCE_YEAR;
        }
        setHistoricalMap(historicalFailedRef.current ? { kind: 'failed' } : { kind: 'ready' });
        syncFamilyOverlay(map, overlayRef.current, (id) => {
          if (!cancelled) {
            setSelectedStopId(id);
          }
        });
      };

      const onError = (event: ErrorEvent): void => {
        if (cancelled || styleLoadedRef.current || historicalFailedRef.current) {
          return;
        }
        if (!event.error?.message?.includes(OHM_STYLE_URL)) {
          return;
        }
        historicalFailedRef.current = true;
        setHistoricalMap({ kind: 'failed' });
        window.setTimeout(() => {
          if (cancelled || mapRef.current !== map || styleLoadedRef.current) {
            return;
          }
          map.setStyle(PAPER_STYLE);
        }, 0);
      };

      map.on('style.load', onStyle);
      map.on('error', onError);

      if (pendingBoundsRef.current) {
        const bounds = pendingBoundsRef.current;
        pendingBoundsRef.current = null;
        programmaticMoveRef.current = true;
        map.fitBounds(bounds, getFitOptions(false));
        window.setTimeout(() => {
          programmaticMoveRef.current = false;
        }, 60);
      }
    };

    void loadArchivalOhmStyle(OVERVIEW_REFERENCE_YEAR)
      .then((archivalStyle) => {
        mountMap(archivalStyle, false);
      })
      .catch(() => {
        mountMap(PAPER_STYLE, true);
      });

    return (): void => {
      cancelled = true;
      styleLoadedRef.current = false;
      historicalFailedRef.current = false;
      lastAppliedDateRef.current = null;
      delete host.kinloomMigrationMap;
      if (activeMap) {
        activeMap.remove();
        activeMap = null;
      }
      mapRef.current = null;
    };
  }, [loading, bundle, defaultBounds, siteConfig.site.familyName]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleLoadedRef.current) {
      return;
    }
    syncFamilyOverlay(map, overlay, (id) => {
      setSelectedStopId(id);
    });
  }, [overlay]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || historicalMap.kind !== 'ready') {
      return;
    }
    setPeriodBasemap(map);
    let targetDate = OVERVIEW_REFERENCE_YEAR;
    if (eraYear !== null) {
      targetDate = playing ? String(Math.floor(eraYear / 10) * 10) : String(eraYear);
    }
    if (lastAppliedDateRef.current === targetDate) {
      return;
    }
    lastAppliedDateRef.current = targetDate;
    filterByDate(map, targetDate);
  }, [eraYear, playing, historicalMap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedStop || !styleLoadedRef.current) {
      return;
    }
    const canvas = map.getCanvas().getBoundingClientRect();
    if (canvas.width === 0 || canvas.height === 0) {
      return;
    }
    const point = map.project([selectedStop.place.lng, selectedStop.place.lat]);
    const isMobile = window.innerWidth <= 767;
    const dockHeight = isMobile ? (dockRef.current?.getBoundingClientRect().height ?? 0) : 0;
    const marginTop = isMobile ? 72 : 76;
    const marginBottom = isMobile ? Math.max(drawerExpanded ? 320 : 196, Math.ceil(dockHeight) + 28) : 108;
    const marginLeft = 28;
    const marginRight = isMobile ? 68 : 56;
    const outOfView =
      point.x < marginLeft ||
      point.x > canvas.width - marginRight ||
      point.y < marginTop ||
      point.y > canvas.height - marginBottom;
    if (!outOfView) {
      return;
    }
    programmaticMoveRef.current = true;
    map.easeTo({
      center: [selectedStop.place.lng, selectedStop.place.lat],
      padding: getFitOptions(true, marginBottom).padding,
      duration: playing ? 360 : 220,
    });
    window.setTimeout(() => {
      programmaticMoveRef.current = false;
    }, 420);
  }, [selectedStop, playing, drawerExpanded]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    const card = cardRef.current;
    if (!selectedStop) {
      setCardSide('right');
      return;
    }
    if (window.innerWidth <= 767) {
      return;
    }
    if (!map || !card || !styleLoadedRef.current) {
      return;
    }
    const point = map.project([selectedStop.place.lng, selectedStop.place.lat]);
    const canvas = map.getCanvas().getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const x = canvas.left + point.x;
    const y = canvas.top + point.y;
    const covered = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    if (!covered) {
      return;
    }
    setCardSide((side) => (side === 'right' ? 'left' : 'right'));
  }, [selectedStop, cardSide, historicalMap]);

  useEffect(() => {
    if (!bundle) {
      return;
    }
    const personSlug = searchParams.get('person');
    const targetPerson = personSlug
      ? bundle.people.find(
          (person) => person.slug === personSlug && (!person.is_living || person.full_name !== 'Living')
        )
      : undefined;
    if (targetPerson) {
      setSelectedPersonId(targetPerson.id);
      return;
    }
    const placeSlug = searchParams.get('place');
    const targetPlace = placeSlug ? placesBySlug.get(placeSlug) : undefined;
    if (targetPlace) {
      const match = allStopsForPerson.find((stop) => stop.place.id === targetPlace.id);
      if (match) {
        setSelectedStopId(match.id);
      }
      const span = Math.max(1.5, siteConfig.mapDefaults.minSpanDeg);
      fitCameraBounds(
        [
          [targetPlace.lng - span, targetPlace.lat - span],
          [targetPlace.lng + span, targetPlace.lat + span],
        ],
        match !== undefined
      );
    } else {
      fitCameraBounds(defaultBounds, false);
    }
  }, [
    bundle,
    fitCameraBounds,
    allStopsForPerson,
    searchParams,
    placesBySlug,
    defaultBounds,
    siteConfig.mapDefaults.minSpanDeg,
  ]);

  useEffect(() => {
    const key = `${selectedPersonId}:${selectedEraId}`;
    if (prevFilterKeyRef.current === key) {
      return;
    }
    prevFilterKeyRef.current = key;
    const nextStopId = selectedPersonId === 'all' && selectedEraId === 'all' ? null : (stops[0]?.id ?? null);
    setPlaying(false);
    setStepIndex(-1);
    setDrawerExpanded(false);
    setSelectedStopId(nextStopId);
    const bounds = computeStopsBounds(stops, siteConfig.mapDefaults) ?? defaultBounds;
    fitCameraBounds(bounds, nextStopId !== null);
  }, [selectedPersonId, selectedEraId]);

  useEffect(() => {
    if (!playing || stops.length === 0) {
      return undefined;
    }
    let cancelled = false;
    let tickTimer: number | null = null;
    let renderFallbackTimer: number | null = null;
    let activeRenderListener: (() => void) | null = null;

    const waitForNextTick = (): void => {
      if (cancelled) {
        return;
      }
      const scheduleAdvance = (): void => {
        if (cancelled) {
          return;
        }
        tickTimer = window.setTimeout(() => {
          if (cancelled) {
            return;
          }
          const next = journeyTick(journeyRef.current, stopIdsRef.current);
          applyJourney(next);
          if (next.playing) {
            waitForNextTick();
          }
        }, 950);
      };

      const map = mapRef.current;
      if (!map) {
        scheduleAdvance();
        return;
      }
      let fired = false;
      const onReady = (): void => {
        if (fired || cancelled) {
          return;
        }
        fired = true;
        activeRenderListener = null;
        if (renderFallbackTimer !== null) {
          window.clearTimeout(renderFallbackTimer);
          renderFallbackTimer = null;
        }
        scheduleAdvance();
      };
      activeRenderListener = onReady;
      map.once('render', onReady);
      renderFallbackTimer = window.setTimeout(onReady, 350);
    };

    waitForNextTick();
    return (): void => {
      cancelled = true;
      const map = mapRef.current;
      if (map && activeRenderListener) {
        map.off('render', activeRenderListener);
      }
      if (tickTimer !== null) {
        window.clearTimeout(tickTimer);
      }
      if (renderFallbackTimer !== null) {
        window.clearTimeout(renderFallbackTimer);
      }
    };
  }, [playing, stops.length, applyJourney]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { target } = event;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (event.key === 'Escape' && selectedStopId) {
        setPlaying(false);
        setSelectedStopId(null);
        setDrawerExpanded(false);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        applyJourney(journeyNext(journeyRef.current, stopIdsRef.current));
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applyJourney(journeyPrev(journeyRef.current, stopIdsRef.current));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [selectedStopId, applyJourney]);

  const totalMiles = useMemo(
    () => segments.reduce((sum, segment) => sum + segment.distanceMiles, 0),
    [segments]
  );

  const handleFitClick = useCallback(() => {
    const bounds = computeStopsBounds(stops, siteConfig.mapDefaults) ?? defaultBounds;
    fitCameraBounds(bounds, selectedStopId !== null);
  }, [stops, siteConfig.mapDefaults, defaultBounds, fitCameraBounds, selectedStopId]);

  const sliderIndex = stepIndex < 0 ? Math.max(0, stops.length - 1) : stepIndex;
  const sliderStop = stops[sliderIndex];
  const sliderValueText = sliderStop
    ? `Stop ${sliderIndex + 1} of ${stops.length}: ${sliderStop.year}, ${sliderStop.place.name}`
    : 'No stops';

  const yearSpanLabel =
    visibleStops.length > 0 ? `${visibleStops[0].year}–${visibleStops.at(-1)?.year}` : '—';
  const metricLabel = usePerPersonSegments
    ? `${visibleStops.length} ${visibleStops.length === 1 ? 'stop' : 'stops'}`
    : `${totalMiles.toLocaleString()} mi`;

  if (error) {
    return (
      <div className={cx(uiStyles, 'map-shell')}>
        <ExplorerTopBar />
        <main id="main-content" className={cx(uiStyles, 'index-page')}>
          <div className={cx(uiStyles, 'archive-error-box')} role="alert">
            <h2>Unable to load migration map</h2>
            <p>{error}</p>
            <button
              type="button"
              className={cx(uiStyles, 'pill-btn active')}
              onClick={() => {
                window.location.reload();
              }}
            >
              Reload archive
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (loading || !bundle) {
    return (
      <div className={cx(uiStyles, 'map-shell')}>
        <ExplorerTopBar />
        <main id="main-content" className={cx(uiStyles, 'index-page')}>
          <output className={cx(uiStyles, 'archive-loading-shell')} aria-live="polite">
            <span className={cx(uiStyles, 'archive-loading-spinner')} aria-hidden="true" />
            <span>{KINLOOM_VOCABULARY.map.loading}</span>
          </output>
        </main>
      </div>
    );
  }

  return (
    <div className={cx(uiStyles, 'map-shell')}>
      <ExplorerTopBar />
      <main id="main-content" className={cx(uiStyles, 'tree-page map-page')}>
        <div
          ref={mapHostRef}
          className={cx(uiStyles, 'map-canvas')}
          style={{ position: 'absolute', inset: 0 }}
        />
        {historicalMap.kind === 'failed' && (
          <output className={cx(uiStyles, 'map-style-note')}>Showing offline paper basemap.</output>
        )}

        <div className={cx(uiStyles, 'map-overlay map-toolbar')}>
          <label className={cx(uiStyles, 'map-trace-label')}>
            <span>Trace:</span>
            <select
              className={cx(uiStyles, 'pill-btn map-trace-select')}
              aria-label="Filter migration map by person"
              value={selectedPersonId}
              onChange={(event) => {
                setSelectedPersonId(event.target.value);
              }}
            >
              <option value="all">All People ({selectablePeople.length})</option>
              {selectablePeople.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.full_name} ({person.birth_year || '?'}–{person.death_year || '?'})
                </option>
              ))}
            </select>
          </label>

          <select
            className={cx(uiStyles, 'pill-btn map-era-select-mobile')}
            aria-label={KINLOOM_VOCABULARY.map.filterByEraAria}
            value={selectedEraId}
            onChange={(event) => {
              setSelectedEraId(event.target.value);
            }}
          >
            <option value="all">
              {KINLOOM_VOCABULARY.map.allEras} ({allStopsForPerson.length})
            </option>
            {migrationEras
              .filter((era) => (eraStopCounts.get(era.id) ?? 0) > 0)
              .map((era) => (
                <option key={era.id} value={era.id}>
                  {era.label} ({eraStopCounts.get(era.id) ?? 0})
                </option>
              ))}
          </select>

          <fieldset className={cx(uiStyles, 'map-toolbar-presets')} aria-label="Filter migration map by era">
            <button
              type="button"
              className={cx(uiStyles, `pill-btn map-bordered-btn ${selectedEraId === 'all' ? 'active' : ''}`)}
              aria-pressed={selectedEraId === 'all'}
              onClick={() => {
                setSelectedEraId('all');
              }}
            >
              All Eras ({allStopsForPerson.length})
            </button>
            {migrationEras
              .filter((era) => (eraStopCounts.get(era.id) ?? 0) > 0)
              .map((era) => (
                <button
                  key={era.id}
                  type="button"
                  className={cx(
                    uiStyles,
                    `pill-btn map-bordered-btn ${selectedEraId === era.id ? 'active' : ''}`
                  )}
                  aria-pressed={selectedEraId === era.id}
                  onClick={() => {
                    setSelectedEraId(era.id);
                  }}
                >
                  {era.label} ({eraStopCounts.get(era.id) ?? 0})
                </button>
              ))}
          </fieldset>

          {selectedPersonId === 'all' && (
            <>
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn map-bordered-btn map-route-mode-mobile')}
                aria-label={`Route order: ${routeMode === 'per-person' ? KINLOOM_VOCABULARY.map.byPersonMode : KINLOOM_VOCABULARY.map.chronologicalMode}. Click to switch.`}
                onClick={() => {
                  setRouteMode((prev) => (prev === 'per-person' ? 'chronological' : 'per-person'));
                }}
              >
                {routeMode === 'per-person'
                  ? KINLOOM_VOCABULARY.map.byPersonMode
                  : KINLOOM_VOCABULARY.map.chronologicalMode}
              </button>
              <fieldset className={cx(uiStyles, 'map-route-mode')} aria-label="Full lineage route mode">
                <button
                  type="button"
                  className={cx(
                    uiStyles,
                    `pill-btn map-bordered-btn ${routeMode === 'per-person' ? 'active' : ''}`
                  )}
                  aria-pressed={routeMode === 'per-person'}
                  onClick={() => {
                    setRouteMode('per-person');
                  }}
                >
                  By person
                </button>
                <button
                  type="button"
                  className={cx(
                    uiStyles,
                    `pill-btn map-bordered-btn ${routeMode === 'chronological' ? 'active' : ''}`
                  )}
                  aria-pressed={routeMode === 'chronological'}
                  onClick={() => {
                    setRouteMode('chronological');
                  }}
                >
                  Chronological
                </button>
              </fieldset>
            </>
          )}
        </div>

        <aside
          className={cx(uiStyles, 'map-overlay map-stage-legend')}
          aria-label="Migration stage color legend"
        >
          {migrationEras.map((era) => (
            <span key={era.id} className={cx(uiStyles, 'map-legend-item')}>
              <span
                className={cx(uiStyles, 'map-legend-swatch')}
                style={{ backgroundColor: stageColorMap.get(era.id) ?? KINLOOM_COLOR_TOKENS.archivalIndigo }}
                aria-hidden="true"
              />
              {era.label}
            </span>
          ))}
        </aside>

        <div ref={dockRef} className={cx(uiStyles, `map-bottom-dock${selectedStop ? ' has-stop' : ''}`)}>
          {selectedStop && <div className={cx(uiStyles, 'map-drawer-handle')} aria-hidden="true" />}

          {selectedStop && (
            <section
              ref={cardRef}
              className={cx(
                uiStyles,
                `map-overlay tree-popover map-stop-popover${cardSide === 'left' ? ' is-left' : ''}${drawerExpanded ? ' is-expanded' : ''}`
              )}
              aria-label="Selected stop details"
              aria-live="polite"
            >
              <div className={cx(uiStyles, 'map-stop-header')}>
                <div className={cx(uiStyles, 'map-stop-meta')}>
                  <span
                    className={cx(uiStyles, 'map-stop-eyebrow')}
                    style={{
                      color:
                        stageColorMap.get(selectedStop.lineageStage) ?? KINLOOM_COLOR_TOKENS.archivalIndigo,
                    }}
                  >
                    <span>{selectedStop.displayDate}</span>
                    <span className={cx(uiStyles, 'map-stop-stage')}>
                      {(
                        stageLabelMap.get(selectedStop.lineageStage) ?? selectedStop.lineageStage
                      ).toUpperCase()}
                    </span>
                  </span>
                  <h2 className={cx(uiStyles, 'map-stop-title')}>{selectedStop.place.full_name}</h2>
                </div>
                <div className={cx(uiStyles, 'map-stop-header-actions')}>
                  <button
                    type="button"
                    className={cx(uiStyles, 'pill-btn map-bordered-btn map-drawer-toggle')}
                    aria-expanded={drawerExpanded}
                    onClick={() => {
                      setDrawerExpanded((open) => !open);
                    }}
                  >
                    {drawerExpanded ? 'Hide ▾' : 'Details ▴'}
                  </button>
                  <button
                    type="button"
                    className={cx(uiStyles, 'pill-btn map-bordered-btn map-close-btn')}
                    onClick={() => {
                      setPlaying(false);
                      setSelectedStopId(null);
                      setDrawerExpanded(false);
                    }}
                    aria-label="Close stop details"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className={cx(uiStyles, 'map-stop-details')}>
                <p className={cx(uiStyles, 'map-stop-summary')}>{selectedStop.title}</p>
                <div className={cx(uiStyles, 'map-stop-coords')}>
                  {selectedStop.place.lat.toFixed(2)}°{selectedStop.place.lat >= 0 ? 'N' : 'S'},{' '}
                  {Math.abs(selectedStop.place.lng).toFixed(2)}°{selectedStop.place.lng >= 0 ? 'E' : 'W'}
                </div>
                <div className={cx(uiStyles, 'map-stop-links')}>
                  <Link
                    to={`/place/${selectedStop.place.slug}`}
                    className={cx(uiStyles, 'pill-btn active')}
                    style={{ textDecoration: 'none' }}
                  >
                    {KINLOOM_VOCABULARY.map.placeProfileCta}
                  </Link>
                  {selectedStop.personSlugs.slice(0, 2).map((personSlug, index) => (
                    <Link
                      key={personSlug}
                      to={`/person/${personSlug}?event=${selectedStop.eventId}`}
                      className={cx(uiStyles, 'pill-btn map-bordered-btn')}
                      style={{ textDecoration: 'none' }}
                    >
                      {selectedStop.personNames[index]} →
                    </Link>
                  ))}
                </div>
              </div>
            </section>
          )}

          <div className={cx(uiStyles, 'map-overlay map-playback-bar')}>
            {stops.length === 0 ? (
              <div className={cx(uiStyles, 'map-empty-notice')} role="status">
                No geocoded stops match the active filter.
                {(selectedPersonId !== 'all' || selectedEraId !== 'all') && (
                  <button
                    type="button"
                    className={cx(uiStyles, 'pill-btn map-bordered-btn')}
                    onClick={() => {
                      setSelectedPersonId('all');
                      setSelectedEraId('all');
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : null}
            <div className={cx(uiStyles, 'map-playback-buttons')}>
              <button
                type="button"
                className={cx(uiStyles, `pill-btn map-bordered-btn ${playing ? 'active' : ''}`)}
                aria-pressed={playing}
                disabled={stops.length === 0}
                onClick={() => {
                  applyJourney(journeyPlayToggle(journey, stopIds));
                }}
              >
                {playing ? '❚❚ Pause' : '▶ Play Route'}
              </button>
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn map-bordered-btn')}
                disabled={stops.length === 0 || stepIndex === 0}
                onClick={() => {
                  applyJourney(journeyPrev(journey, stopIds));
                }}
              >
                ← Prev
              </button>
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn map-bordered-btn')}
                disabled={stops.length === 0 || stepIndex >= stops.length - 1}
                onClick={() => {
                  applyJourney(journeyNext(journey, stopIds));
                }}
              >
                Next →
              </button>
              <button
                type="button"
                className={cx(uiStyles, `pill-btn map-bordered-btn ${stepIndex < 0 ? 'active' : ''}`)}
                onClick={() => {
                  setDrawerExpanded(false);
                  applyJourney(journeyReset(journey));
                }}
              >
                All ({stops.length})
              </button>
            </div>

            <div className={cx(uiStyles, 'map-playback-slider')}>
              <input
                type="range"
                min={0}
                max={Math.max(0, stops.length - 1)}
                value={sliderIndex}
                onChange={(event) => {
                  applyJourney(journeyScrub(journey, Number(event.target.value), stopIds));
                }}
                aria-label="Scrub migration timeline stop"
                aria-valuetext={sliderValueText}
                className={cx(uiStyles, 'map-range-input')}
              />
              <span className={cx(uiStyles, 'map-playback-stat')}>
                {yearSpanLabel} · {metricLabel}
              </span>
            </div>
          </div>
        </div>

        <div className={cx(uiStyles, 'map-overlay tree-controls map-zoom-controls')}>
          <button
            type="button"
            className={cx(uiStyles, 'pill-btn')}
            aria-label="Zoom in map"
            onClick={() => {
              mapRef.current?.zoomIn({ duration: 180 });
            }}
          >
            +
          </button>
          <button
            type="button"
            className={cx(uiStyles, 'pill-btn')}
            aria-label="Zoom out map"
            onClick={() => {
              mapRef.current?.zoomOut({ duration: 180 });
            }}
          >
            −
          </button>
          <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={handleFitClick}>
            Fit
          </button>
        </div>
      </main>
    </div>
  );
};
