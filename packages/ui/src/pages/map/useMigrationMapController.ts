import type { ArchiveBundle, KinloomSiteConfig, MapJourneyState, MigrationStop, Place } from '@kinloom/core';
import { journeyNext, journeyPrev, journeyTick } from '@kinloom/core';
import { filterByDate } from '@openhistoricalmap/maplibre-gl-dates';
import type { FeatureCollection } from 'geojson';
import type { ErrorEvent, StyleSpecification } from 'maplibre-gl';
import { AttributionControl, Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadArchivalOhmStyle, OHM_STYLE_URL, OVERVIEW_REFERENCE_YEAR } from '../../browser/ohmStyle.js';
import { readResolvedDarkMode, subscribeResolvedDarkMode } from '../../hooks/useThemePreference.js';
import {
  applyMapThemeToLayers,
  buildPaperStyle,
  ensureMapLibreConfigured,
  getFitOptions,
  setPeriodBasemap,
  syncFamilyOverlay,
} from './mapLibreLayers.js';
import { computeAntimeridianSafeBounds, type HistoricalMapStatus } from './mapOverlayData.js';

export interface UseMigrationMapControllerParams {
  readonly loading: boolean;
  readonly bundle: ArchiveBundle | null;
  readonly siteConfig: KinloomSiteConfig;
  readonly placesBySlug: ReadonlyMap<string, Place>;
  readonly searchParams: URLSearchParams;
  readonly allStopsForPerson: readonly MigrationStop[];
  readonly stops: readonly MigrationStop[];
  readonly stopIds: readonly string[];
  readonly selectedPersonId: string;
  readonly selectedEraId: string;
  readonly selectedStop: MigrationStop | null;
  readonly selectedStopId: string | null;
  readonly stepIndex: number;
  readonly playing: boolean;
  readonly drawerExpanded: boolean;
  readonly overlay: FeatureCollection;
  readonly defaultBounds: [[number, number], [number, number]];
  readonly setSelectedPersonId: React.Dispatch<React.SetStateAction<string>>;
  readonly setSelectedStopId: React.Dispatch<React.SetStateAction<string | null>>;
  readonly setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setStepIndex: React.Dispatch<React.SetStateAction<number>>;
  readonly setDrawerExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  readonly applyJourney: (next: MapJourneyState) => void;
}

export interface MigrationMapController {
  readonly mapHostRef: React.RefObject<(HTMLDivElement & { kinloomMigrationMap?: MapLibreMap }) | null>;
  readonly toolbarRef: React.RefObject<HTMLDivElement | null>;
  readonly cardRef: React.RefObject<HTMLDivElement | null>;
  readonly dockRef: React.RefObject<HTMLDivElement | null>;
  readonly historicalMap: HistoricalMapStatus;
  readonly cardSide: 'left' | 'right';
  readonly handleZoomIn: () => void;
  readonly handleZoomOut: () => void;
  readonly handleFitClick: () => void;
}

export function useMigrationMapController(params: UseMigrationMapControllerParams): MigrationMapController {
  const {
    loading,
    bundle,
    siteConfig,
    placesBySlug,
    searchParams,
    allStopsForPerson,
    stops,
    stopIds,
    selectedPersonId,
    selectedEraId,
    selectedStop,
    selectedStopId,
    stepIndex,
    playing,
    drawerExpanded,
    overlay,
    defaultBounds,
    setSelectedPersonId,
    setSelectedStopId,
    setPlaying,
    setStepIndex,
    setDrawerExpanded,
    applyJourney,
  } = params;

  const mapHostRef = useRef<(HTMLDivElement & { kinloomMigrationMap?: MapLibreMap }) | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleLoadedRef = useRef(false);
  const historicalFailedRef = useRef(false);
  const pendingBoundsRef = useRef<[[number, number], [number, number]] | null>(null);
  const programmaticMoveRef = useRef(false);
  const lastAppliedDateRef = useRef<string | null>(null);
  const prevFilterKeyRef = useRef('all:all');
  const cardRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);

  const [historicalMap, setHistoricalMap] = useState<HistoricalMapStatus>({ kind: 'pending' });
  const [cardSide, setCardSide] = useState<'left' | 'right'>('right');

  const journey: MapJourneyState = { stepIndex, playing, selectedStopId };
  const journeyRef = useRef(journey);
  const stopIdsRef = useRef(stopIds);
  useEffect(() => {
    journeyRef.current = journey;
    stopIdsRef.current = stopIds;
  });

  const overlayRef = useRef(overlay);
  useLayoutEffect(() => {
    overlayRef.current = overlay;
  });

  const eraYear = selectedStop?.year ?? (stepIndex >= 0 ? stops[stepIndex]?.year : null);

  const measureFitOptions = useCallback((hasSelectedStop: boolean, drawerBottomPx?: number) => {
    const hostRect = mapHostRef.current?.getBoundingClientRect();
    const viewportWidth =
      hostRect && hostRect.width > 0
        ? hostRect.width
        : typeof window !== 'undefined'
          ? window.innerWidth
          : 1280;
    const viewportHeight =
      hostRect && hostRect.height > 0
        ? hostRect.height
        : typeof window !== 'undefined'
          ? window.innerHeight
          : undefined;
    const toolbarHeight = toolbarRef.current?.getBoundingClientRect().height ?? 0;

    let bottomDockHeight = 0;
    const dockEl = dockRef.current;
    if (dockEl) {
      const dockRect = dockEl.getBoundingClientRect();
      if (dockRect.height > 0) {
        bottomDockHeight = dockRect.height;
      } else {
        const playbackBar = dockEl.querySelector<HTMLElement>('[data-map-playback-bar="true"]');
        const barRect = playbackBar?.getBoundingClientRect();
        if (barRect && barRect.height > 0) {
          bottomDockHeight =
            hostRect && hostRect.bottom > barRect.top ? hostRect.bottom - barRect.top : barRect.height + 18;
        }
      }
    }

    return getFitOptions(hasSelectedStop, drawerBottomPx, {
      viewportWidth,
      viewportHeight,
      toolbarHeight: toolbarHeight > 0 ? toolbarHeight : undefined,
      bottomDockHeight: bottomDockHeight > 0 ? bottomDockHeight : undefined,
    });
  }, []);

  const fitCameraBounds = useCallback(
    (bounds: [[number, number], [number, number]], hasSelectedStop: boolean) => {
      const map = mapRef.current;
      if (!map) {
        pendingBoundsRef.current = bounds;
        return;
      }
      pendingBoundsRef.current = null;
      programmaticMoveRef.current = true;
      map.fitBounds(bounds, measureFitOptions(hasSelectedStop));
      window.setTimeout(() => {
        programmaticMoveRef.current = false;
      }, 60);
    },
    [measureFitOptions]
  );

  useEffect(() => {
    if (loading || !bundle) {
      return undefined;
    }
    const host = mapHostRef.current;
    const toolbar = toolbarRef.current;
    if (!host && !toolbar) {
      return undefined;
    }

    const syncOverlayOffsets = (): void => {
      const pageEl = host?.parentElement;
      if (!pageEl) {
        return;
      }
      const pageRect = pageEl.getBoundingClientRect();
      const tbEl = toolbarRef.current;
      if (tbEl) {
        const tbRect = tbEl.getBoundingClientRect();
        if (tbRect.height > 0) {
          const bottomOffset = Math.max(52, Math.ceil(tbRect.bottom - pageRect.top));
          pageEl.style.setProperty('--map-toolbar-bottom', `${bottomOffset}px`);
        }
      }
      const dockEl = dockRef.current;
      if (dockEl) {
        const dockRect = dockEl.getBoundingClientRect();
        if (dockRect.height > 0) {
          pageEl.style.setProperty('--map-dock-height', `${Math.ceil(dockRect.height)}px`);
        }
      }
    };

    syncOverlayOffsets();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      syncOverlayOffsets();
      const active = mapRef.current;
      if (active && typeof active.resize === 'function') {
        active.resize();
      }
    });
    if (host) {
      observer.observe(host);
    }
    if (toolbar) {
      observer.observe(toolbar);
    }
    const dock = dockRef.current;
    if (dock) {
      observer.observe(dock);
    }
    return (): void => {
      observer.disconnect();
    };
  }, [loading, bundle]);

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

    const buildAttributionControl = (offline: boolean): AttributionControl =>
      new AttributionControl({
        compact: true,
        customAttribution: offline
          ? [
              'Offline archival basemap',
              '<a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre</a>',
            ]
          : [
              '<a href="https://www.openhistoricalmap.org/" target="_blank" rel="noopener noreferrer">OpenHistoricalMap</a>',
              '<a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre</a>',
            ],
      });

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
          fitBoundsOptions: measureFitOptions(false),
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          maxPitch: 0,
          minZoom: 0.6,
          maxZoom: 12,
          maxTileCacheSize: 240,
          renderWorldCopies: true,
          fadeDuration: 0,
        });
      } catch {
        historicalFailedRef.current = true;
        setHistoricalMap({ kind: 'failed' });
        return;
      }
      activeMap = map;
      let activeAttribution = buildAttributionControl(isFallback);
      map.addControl(activeAttribution, 'bottom-left');
      mapRef.current = map;
      host.kinloomMigrationMap = map;
      map.getCanvas().setAttribute('aria-label', `${siteConfig.site.familyName} migration map`);

      const onStyle = (): void => {
        if (cancelled) {
          return;
        }
        styleLoadedRef.current = true;
        const darkNow = readResolvedDarkMode();
        if (typeof map.resize === 'function') {
          map.resize();
        }
        setPeriodBasemap(map, darkNow);
        if (!historicalFailedRef.current) {
          lastAppliedDateRef.current = OVERVIEW_REFERENCE_YEAR;
        }
        setHistoricalMap(historicalFailedRef.current ? { kind: 'failed' } : { kind: 'ready' });
        syncFamilyOverlay(
          map,
          overlayRef.current,
          (id) => {
            if (!cancelled) {
              setSelectedStopId(id);
            }
          },
          darkNow
        );
        applyMapThemeToLayers(map, darkNow);
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
        if (typeof map.removeControl === 'function') {
          map.removeControl(activeAttribution);
        }
        activeAttribution = buildAttributionControl(true);
        map.addControl(activeAttribution, 'bottom-left');
        window.setTimeout(() => {
          if (cancelled || mapRef.current !== map || styleLoadedRef.current) {
            return;
          }
          map.setStyle(buildPaperStyle(readResolvedDarkMode()));
        }, 0);
      };

      map.on('style.load', onStyle);
      map.on('error', onError);

      if (pendingBoundsRef.current) {
        const bounds = pendingBoundsRef.current;
        pendingBoundsRef.current = null;
        programmaticMoveRef.current = true;
        map.fitBounds(bounds, measureFitOptions(false));
        window.setTimeout(() => {
          programmaticMoveRef.current = false;
        }, 60);
      }
    };

    const initialIsDark = readResolvedDarkMode();
    const unsubscribeTheme = subscribeResolvedDarkMode((isDark) => {
      const map = mapRef.current;
      if (map && styleLoadedRef.current) {
        applyMapThemeToLayers(map, isDark);
      }
    });

    void loadArchivalOhmStyle(OVERVIEW_REFERENCE_YEAR, fetch, initialIsDark)
      .then((archivalStyle) => {
        mountMap(archivalStyle, false);
      })
      .catch(() => {
        mountMap(buildPaperStyle(readResolvedDarkMode()), true);
      });

    return (): void => {
      cancelled = true;
      unsubscribeTheme();
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
  }, [loading, bundle, defaultBounds, siteConfig.site.familyName, setSelectedStopId, measureFitOptions]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleLoadedRef.current) {
      return;
    }
    syncFamilyOverlay(
      map,
      overlay,
      (id) => {
        setSelectedStopId(id);
      },
      readResolvedDarkMode()
    );
  }, [overlay, setSelectedStopId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || historicalMap.kind !== 'ready') {
      return;
    }
    setPeriodBasemap(map, readResolvedDarkMode());
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
    const toolbarHeight = toolbarRef.current?.getBoundingClientRect().height ?? 0;
    const dockHeight = isMobile ? (dockRef.current?.getBoundingClientRect().height ?? 0) : 0;
    const marginTop =
      toolbarHeight > 0 ? Math.ceil(toolbarHeight) + (isMobile ? 24 : 32) : isMobile ? 124 : 76;
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
      padding: measureFitOptions(true, marginBottom).padding,
      duration: playing ? 360 : 220,
    });
    window.setTimeout(() => {
      programmaticMoveRef.current = false;
    }, 420);
  }, [selectedStop, playing, drawerExpanded, measureFitOptions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure map layout when cardSide or historicalMap toggles
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
    setSelectedPersonId,
    setSelectedStopId,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fit map camera only when filter selection changes
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
    const bounds = computeAntimeridianSafeBounds(stops, siteConfig.mapDefaults) ?? defaultBounds;
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
          const next = journeyTick(journeyRef.current, [...stopIdsRef.current]);
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
        applyJourney(journeyNext(journeyRef.current, [...stopIdsRef.current]));
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applyJourney(journeyPrev(journeyRef.current, [...stopIdsRef.current]));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [selectedStopId, applyJourney, setPlaying, setSelectedStopId, setDrawerExpanded]);

  const handleZoomIn = useCallback(() => {
    mapRef.current?.zoomIn({ duration: 180 });
  }, []);

  const handleZoomOut = useCallback(() => {
    mapRef.current?.zoomOut({ duration: 180 });
  }, []);

  const handleFitClick = useCallback(() => {
    const bounds = computeAntimeridianSafeBounds(stops, siteConfig.mapDefaults) ?? defaultBounds;
    fitCameraBounds(bounds, selectedStopId !== null);
  }, [stops, siteConfig.mapDefaults, defaultBounds, fitCameraBounds, selectedStopId]);

  return {
    mapHostRef,
    toolbarRef,
    cardRef,
    dockRef,
    historicalMap,
    cardSide,
    handleZoomIn,
    handleZoomOut,
    handleFitClick,
  };
}
