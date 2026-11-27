import type { MapJourneyState, MigrationEraConfig, MigrationStop } from '@kinloom/core';
import { journeyNext, journeyPlayToggle, journeyPrev, journeyReset, journeyScrub } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../../lib/cx.js';
import { KINLOOM_COLOR_TOKENS } from '../../lib/tokens.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';

export interface MapStageLegendProps {
  readonly migrationEras: readonly MigrationEraConfig[];
  readonly stageColorMap: ReadonlyMap<string, string>;
  readonly uiStyles: Readonly<Record<string, string>>;
}

export const MapStageLegend: React.FC<MapStageLegendProps> = ({ migrationEras, stageColorMap, uiStyles }) => (
  <aside className={cx(uiStyles, 'map-overlay map-stage-legend')} aria-label="Migration stage color legend">
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
);

export interface MapZoomControlsProps {
  readonly uiStyles: Readonly<Record<string, string>>;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
}

export const MapZoomControls: React.FC<MapZoomControlsProps> = ({ uiStyles, onZoomIn, onZoomOut, onFit }) => (
  <div className={cx(uiStyles, 'map-overlay tree-controls map-zoom-controls')}>
    <button type="button" className={cx(uiStyles, 'pill-btn')} aria-label="Zoom in map" onClick={onZoomIn}>
      +
    </button>
    <button type="button" className={cx(uiStyles, 'pill-btn')} aria-label="Zoom out map" onClick={onZoomOut}>
      −
    </button>
    <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={onFit}>
      Fit
    </button>
  </div>
);

export interface MapStopDrawerAndDockProps {
  readonly dockRef: React.RefObject<HTMLDivElement | null>;
  readonly cardRef: React.RefObject<HTMLDivElement | null>;
  readonly selectedStop: MigrationStop | null;
  readonly cardSide: 'left' | 'right';
  readonly drawerExpanded: boolean;
  readonly stops: readonly MigrationStop[];
  readonly stopIds: readonly string[];
  readonly stepIndex: number;
  readonly playing: boolean;
  readonly journey: MapJourneyState;
  readonly selectedPersonId: string;
  readonly selectedEraId: string;
  readonly yearSpanLabel: string;
  readonly metricLabel: string;
  readonly stageColorMap: ReadonlyMap<string, string>;
  readonly stageLabelMap: ReadonlyMap<string, string>;
  readonly uiStyles: Readonly<Record<string, string>>;
  readonly onToggleDrawer: () => void;
  readonly onCloseStop: () => void;
  readonly onClearFilters: () => void;
  readonly onApplyJourney: (next: MapJourneyState) => void;
  readonly onResetAllStops: () => void;
}

export const MapStopDrawerAndDock: React.FC<MapStopDrawerAndDockProps> = ({
  dockRef,
  cardRef,
  selectedStop,
  cardSide,
  drawerExpanded,
  stops,
  stopIds,
  stepIndex,
  playing,
  journey,
  selectedPersonId,
  selectedEraId,
  yearSpanLabel,
  metricLabel,
  stageColorMap,
  stageLabelMap,
  uiStyles,
  onToggleDrawer,
  onCloseStop,
  onClearFilters,
  onApplyJourney,
  onResetAllStops,
}) => {
  const sliderIndex = stepIndex < 0 ? Math.max(0, stops.length - 1) : stepIndex;
  const sliderStop = stops[sliderIndex];
  const sliderValueText = sliderStop
    ? `Stop ${sliderIndex + 1} of ${stops.length}: ${sliderStop.year}, ${sliderStop.place.name}`
    : 'No stops';
  const mutableStopIds = [...stopIds];

  return (
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
                  color: stageColorMap.get(selectedStop.lineageStage) ?? KINLOOM_COLOR_TOKENS.archivalIndigo,
                }}
              >
                <span>{selectedStop.displayDate}</span>
                <span className={cx(uiStyles, 'map-stop-stage')}>
                  {(stageLabelMap.get(selectedStop.lineageStage) ?? selectedStop.lineageStage).toUpperCase()}
                </span>
              </span>
              <h2 className={cx(uiStyles, 'map-stop-title')}>{selectedStop.place.full_name}</h2>
            </div>
            <div className={cx(uiStyles, 'map-stop-header-actions')}>
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn map-bordered-btn map-drawer-toggle')}
                aria-expanded={drawerExpanded}
                onClick={onToggleDrawer}
              >
                {drawerExpanded ? 'Hide ▾' : 'Details ▴'}
              </button>
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn map-bordered-btn map-close-btn')}
                onClick={onCloseStop}
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
                onClick={onClearFilters}
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
              onApplyJourney(journeyPlayToggle(journey, mutableStopIds));
            }}
          >
            {playing ? '❚❚ Pause' : '▶ Play Route'}
          </button>
          <button
            type="button"
            className={cx(uiStyles, 'pill-btn map-bordered-btn')}
            disabled={stops.length === 0 || stepIndex === 0}
            onClick={() => {
              onApplyJourney(journeyPrev(journey, mutableStopIds));
            }}
          >
            ← Prev
          </button>
          <button
            type="button"
            className={cx(uiStyles, 'pill-btn map-bordered-btn')}
            disabled={stops.length === 0 || stepIndex >= stops.length - 1}
            onClick={() => {
              onApplyJourney(journeyNext(journey, mutableStopIds));
            }}
          >
            Next →
          </button>
          <button
            type="button"
            className={cx(uiStyles, `pill-btn map-bordered-btn ${stepIndex < 0 ? 'active' : ''}`)}
            onClick={() => {
              onResetAllStops();
              onApplyJourney(journeyReset(journey));
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
              onApplyJourney(journeyScrub(journey, Number(event.target.value), mutableStopIds));
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
  );
};
