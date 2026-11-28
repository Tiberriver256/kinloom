import type { MapJourneyState, MigrationStop } from '@kinloom/core';
import { journeyNext, journeyPlayToggle, journeyPrev, journeyReset, journeyScrub } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import canvasSurfaceStyles from '../../components/CanvasSurfacePrimitives.module.css';
import { cx, joinClasses } from '../../lib/cx.js';
import { KINLOOM_COLOR_TOKENS } from '../../lib/tokens.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import mapStyles from '../MapPage.module.css';

export interface MapZoomControlsProps {
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
}

export const MapZoomControls: React.FC<MapZoomControlsProps> = ({ onZoomIn, onZoomOut, onFit }) => (
  <div
    role="group"
    aria-label="Map zoom controls"
    className={cx(canvasSurfaceStyles, 'map-overlay tree-controls map-zoom-controls')}
  >
    <button
      type="button"
      className={cx(controlStyles, 'pill-btn')}
      aria-label="Zoom in map"
      onClick={onZoomIn}
    >
      +
    </button>
    <button
      type="button"
      className={cx(controlStyles, 'pill-btn')}
      aria-label="Zoom out map"
      onClick={onZoomOut}
    >
      −
    </button>
    <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onFit}>
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
    <div ref={dockRef} className={cx(mapStyles, `map-bottom-dock${selectedStop ? ' has-stop' : ''}`)}>
      {selectedStop && <div className={cx(mapStyles, 'map-drawer-handle')} aria-hidden="true" />}

      {selectedStop && (
        <section
          ref={cardRef}
          className={joinClasses(
            cx(canvasSurfaceStyles, 'tree-popover'),
            cx(mapStyles, 'map-stop-popover'),
            'map-overlay',
            cardSide === 'left' ? ' is-left' : '',
            drawerExpanded ? ' is-expanded' : ''
          )}
          aria-label="Selected stop details"
          aria-live="polite"
        >
          <div className={cx(mapStyles, 'map-stop-header')}>
            <div className={cx(mapStyles, 'map-stop-meta')}>
              <span
                className={cx(mapStyles, 'map-stop-eyebrow')}
                style={{
                  color: stageColorMap.get(selectedStop.lineageStage) ?? KINLOOM_COLOR_TOKENS.archivalIndigo,
                }}
              >
                <span>{selectedStop.displayDate}</span>
                <span className={cx(mapStyles, 'map-stop-stage')}>
                  {(stageLabelMap.get(selectedStop.lineageStage) ?? selectedStop.lineageStage).toUpperCase()}
                </span>
              </span>
              <h2 className={cx(mapStyles, 'map-stop-title')}>{selectedStop.place.full_name}</h2>
            </div>
            <div className={cx(mapStyles, 'map-stop-header-actions')}>
              <button
                type="button"
                className={joinClasses(
                  cx(controlStyles, 'pill-btn'),
                  cx(canvasSurfaceStyles, 'map-bordered-btn'),
                  cx(mapStyles, 'map-drawer-toggle')
                )}
                aria-expanded={drawerExpanded}
                onClick={onToggleDrawer}
              >
                {drawerExpanded ? 'Hide ▾' : 'Details ▴'}
              </button>
              <button
                type="button"
                className={joinClasses(
                  cx(controlStyles, 'pill-btn'),
                  cx(canvasSurfaceStyles, 'map-bordered-btn'),
                  cx(mapStyles, 'map-close-btn')
                )}
                onClick={onCloseStop}
                aria-label="Close stop details"
              >
                ✕
              </button>
            </div>
          </div>

          <div className={'map-stop-details'}>
            <p className={cx(mapStyles, 'map-stop-summary')}>{selectedStop.title}</p>
            <div className={cx(mapStyles, 'map-stop-coords')}>
              {selectedStop.place.lat.toFixed(2)}°{selectedStop.place.lat >= 0 ? 'N' : 'S'},{' '}
              {Math.abs(selectedStop.place.lng).toFixed(2)}°{selectedStop.place.lng >= 0 ? 'E' : 'W'}
            </div>
            <div className={cx(mapStyles, 'map-stop-links')}>
              <Link
                to={`/place/${selectedStop.place.slug}`}
                className={cx(controlStyles, 'pill-btn active')}
                style={{ textDecoration: 'none' }}
              >
                {KINLOOM_VOCABULARY.map.placeProfileCta}
              </Link>
              {selectedStop.personSlugs.slice(0, 2).map((personSlug, index) => (
                <Link
                  key={personSlug}
                  to={`/person/${personSlug}?event=${selectedStop.eventId}`}
                  className={joinClasses(
                    cx(controlStyles, 'pill-btn'),
                    cx(canvasSurfaceStyles, 'map-bordered-btn')
                  )}
                  style={{ textDecoration: 'none' }}
                >
                  {selectedStop.personNames[index]} →
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <div data-map-playback-bar="true" className={cx(mapStyles, 'map-overlay map-playback-bar')}>
        {stops.length === 0 ? (
          <div className={cx(mapStyles, 'map-empty-notice')} role="status">
            No geocoded stops match the active filter.
            {(selectedPersonId !== 'all' || selectedEraId !== 'all') && (
              <button
                type="button"
                className={joinClasses(
                  cx(controlStyles, 'pill-btn'),
                  cx(canvasSurfaceStyles, 'map-bordered-btn')
                )}
                onClick={onClearFilters}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : null}
        <div className={cx(mapStyles, 'map-playback-buttons')}>
          <button
            type="button"
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(canvasSurfaceStyles, 'map-bordered-btn'),
              playing ? 'active' : ''
            )}
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
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(canvasSurfaceStyles, 'map-bordered-btn')
            )}
            disabled={stops.length === 0 || stepIndex === 0}
            onClick={() => {
              onApplyJourney(journeyPrev(journey, mutableStopIds));
            }}
          >
            ← Prev
          </button>
          <button
            type="button"
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(canvasSurfaceStyles, 'map-bordered-btn')
            )}
            disabled={stops.length === 0 || stepIndex >= stops.length - 1}
            onClick={() => {
              onApplyJourney(journeyNext(journey, mutableStopIds));
            }}
          >
            Next →
          </button>
          <button
            type="button"
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(canvasSurfaceStyles, 'map-bordered-btn'),
              stepIndex < 0 ? 'active' : ''
            )}
            onClick={() => {
              onResetAllStops();
              onApplyJourney(journeyReset(journey));
            }}
          >
            All ({stops.length})
          </button>
        </div>

        <div className={cx(mapStyles, 'map-playback-slider')}>
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
            className={cx(mapStyles, 'map-range-input')}
          />
          <span className={cx(mapStyles, 'map-playback-stat')}>
            {yearSpanLabel} · {metricLabel}
          </span>
        </div>
      </div>
    </div>
  );
};
