// Side-effect CSS import: the standard Vite pattern for loading library styles.
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LineageRouteMode, MapJourneyState, MigrationEraConfig } from '@kinloom/core';
import {
  buildMigrationSegments,
  buildMigrationStops,
  buildPerPersonMigrationSegments,
  DEFAULT_MIGRATION_ERAS,
} from '@kinloom/core';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import statusShellStyles from '../components/ArchiveStatusShell.module.css';
import canvasSurfaceStyles from '../components/CanvasSurfacePrimitives.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx, joinClasses } from '../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import mapStyles from './MapPage.module.css';
import { MapStageLegend, MapStopDrawerAndDock, MapZoomControls } from './map/MapStopDrawerAndDock.js';
import { MapToolbar } from './map/MapToolbar.js';
import { buildFamilyOverlay, computeDefaultMapBounds, FALLBACK_ERA_COLORS } from './map/mapOverlayData.js';
import { useMigrationMapController } from './map/useMigrationMapController.js';

export const MapPage: React.FC = () => {
  const { siteConfig, bundle, peopleById, placesById, placesBySlug, loading, error } = useArchiveData();
  const [searchParams] = useSearchParams();

  const [selectedPersonId, setSelectedPersonId] = useState<string>('all');
  const [selectedEraId, setSelectedEraId] = useState<string>('all');
  const [routeMode, setRouteMode] = useState<LineageRouteMode>('per-person');
  const [drawerExpanded, setDrawerExpanded] = useState<boolean>(false);
  const [stepIndex, setStepIndex] = useState<number>(-1);
  const [playing, setPlaying] = useState<boolean>(false);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);

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

  const applyJourney = useCallback((next: MapJourneyState) => {
    setStepIndex(next.stepIndex);
    setPlaying(next.playing);
    setSelectedStopId(next.selectedStopId);
  }, []);

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

  const defaultBounds = useMemo(
    () => computeDefaultMapBounds(allStopsForPerson, siteConfig.mapDefaults),
    [allStopsForPerson, siteConfig.mapDefaults]
  );

  const controller = useMigrationMapController({
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
  });

  const totalMiles = useMemo(
    () => segments.reduce((sum, segment) => sum + segment.distanceMiles, 0),
    [segments]
  );

  const yearSpanLabel =
    visibleStops.length > 0 ? `${visibleStops[0].year}–${visibleStops.at(-1)?.year}` : '—';
  const metricLabel = usePerPersonSegments
    ? `${visibleStops.length} ${visibleStops.length === 1 ? 'stop' : 'stops'}`
    : `${totalMiles.toLocaleString()} mi`;

  if (error) {
    return (
      <div className={cx(mapStyles, 'map-shell')}>
        <ExplorerTopBar />
        <main id="main-content" className={cx(layoutStyles, 'index-page')}>
          <div className={cx(statusShellStyles, 'archive-error-box')} role="alert">
            <h2>Unable to load migration map</h2>
            <p>{error}</p>
            <button
              type="button"
              className={cx(controlStyles, 'pill-btn active')}
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
      <div className={cx(mapStyles, 'map-shell')}>
        <ExplorerTopBar />
        <main id="main-content" className={cx(layoutStyles, 'index-page')}>
          <output className={cx(statusShellStyles, 'archive-loading-shell')} aria-live="polite">
            <span className={cx(statusShellStyles, 'archive-loading-spinner')} aria-hidden="true" />
            <span>{KINLOOM_VOCABULARY.map.loading}</span>
          </output>
        </main>
      </div>
    );
  }

  return (
    <div className={cx(mapStyles, 'map-shell')}>
      <ExplorerTopBar />
      <main
        id="main-content"
        className={joinClasses(cx(canvasSurfaceStyles, 'tree-page'), cx(mapStyles, 'map-page'))}
      >
        <div
          ref={controller.mapHostRef}
          className={'map-canvas'}
          style={{ position: 'absolute', inset: 0 }}
        />
        {controller.historicalMap.kind === 'failed' && (
          <output className={cx(mapStyles, 'map-style-note')}>Showing offline paper basemap.</output>
        )}

        <MapToolbar
          toolbarRef={controller.toolbarRef}
          selectablePeople={selectablePeople}
          selectedPersonId={selectedPersonId}
          selectedEraId={selectedEraId}
          routeMode={routeMode}
          allStopsCount={allStopsForPerson.length}
          migrationEras={migrationEras}
          eraStopCounts={eraStopCounts}
          onSelectPersonId={setSelectedPersonId}
          onSelectEraId={setSelectedEraId}
          onSetRouteMode={setRouteMode}
        />

        <MapStageLegend migrationEras={migrationEras} stageColorMap={stageColorMap} />

        <MapStopDrawerAndDock
          dockRef={controller.dockRef}
          cardRef={controller.cardRef}
          selectedStop={selectedStop}
          cardSide={controller.cardSide}
          drawerExpanded={drawerExpanded}
          stops={stops}
          stopIds={stopIds}
          stepIndex={stepIndex}
          playing={playing}
          journey={journey}
          selectedPersonId={selectedPersonId}
          selectedEraId={selectedEraId}
          yearSpanLabel={yearSpanLabel}
          metricLabel={metricLabel}
          stageColorMap={stageColorMap}
          stageLabelMap={stageLabelMap}
          onToggleDrawer={() => {
            setDrawerExpanded((open) => !open);
          }}
          onCloseStop={() => {
            setPlaying(false);
            setSelectedStopId(null);
            setDrawerExpanded(false);
          }}
          onClearFilters={() => {
            setSelectedPersonId('all');
            setSelectedEraId('all');
          }}
          onApplyJourney={applyJourney}
          onResetAllStops={() => {
            setDrawerExpanded(false);
          }}
        />

        <MapZoomControls
          onZoomIn={controller.handleZoomIn}
          onZoomOut={controller.handleZoomOut}
          onFit={controller.handleFitClick}
        />
      </main>
    </div>
  );
};
