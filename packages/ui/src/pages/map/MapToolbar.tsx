import type { LineageRouteMode, MigrationEraConfig, Person } from '@kinloom/core';
import type React from 'react';
import canvasSurfaceStyles from '../../components/CanvasSurfacePrimitives.module.css';
import { cx, joinClasses } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import mapStyles from '../MapPage.module.css';

export interface MapToolbarProps {
  readonly selectablePeople: readonly Person[];
  readonly selectedPersonId: string;
  readonly selectedEraId: string;
  readonly routeMode: LineageRouteMode;
  readonly allStopsCount: number;
  readonly migrationEras: readonly MigrationEraConfig[];
  readonly eraStopCounts: ReadonlyMap<string, number>;
  readonly onSelectPersonId: (personId: string) => void;
  readonly onSelectEraId: (eraId: string) => void;
  readonly onSetRouteMode: (mode: LineageRouteMode) => void;
}

export const MapToolbar: React.FC<MapToolbarProps> = ({
  selectablePeople,
  selectedPersonId,
  selectedEraId,
  routeMode,
  allStopsCount,
  migrationEras,
  eraStopCounts,
  onSelectPersonId,
  onSelectEraId,
  onSetRouteMode,
}) => {
  const populatedEras = migrationEras.filter((era) => (eraStopCounts.get(era.id) ?? 0) > 0);

  return (
    <div className={cx(mapStyles, 'map-overlay map-toolbar')}>
      <label className={cx(mapStyles, 'map-trace-label')}>
        <span>Trace:</span>
        <select
          className={joinClasses(cx(controlStyles, 'pill-btn'), cx(mapStyles, 'map-trace-select'))}
          aria-label="Filter migration map by person"
          value={selectedPersonId}
          onChange={(event) => {
            onSelectPersonId(event.target.value);
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
        className={joinClasses(cx(controlStyles, 'pill-btn'), cx(mapStyles, 'map-era-select-mobile'))}
        aria-label={KINLOOM_VOCABULARY.map.filterByEraAria}
        value={selectedEraId}
        onChange={(event) => {
          onSelectEraId(event.target.value);
        }}
      >
        <option value="all">
          {KINLOOM_VOCABULARY.map.allEras} ({allStopsCount})
        </option>
        {populatedEras.map((era) => (
          <option key={era.id} value={era.id}>
            {era.label} ({eraStopCounts.get(era.id) ?? 0})
          </option>
        ))}
      </select>

      <fieldset className={cx(mapStyles, 'map-toolbar-presets')} aria-label="Filter migration map by era">
        <button
          type="button"
          className={joinClasses(
            cx(controlStyles, 'pill-btn'),
            cx(canvasSurfaceStyles, 'map-bordered-btn'),
            selectedEraId === 'all' ? 'active' : ''
          )}
          aria-pressed={selectedEraId === 'all'}
          onClick={() => {
            onSelectEraId('all');
          }}
        >
          All Eras ({allStopsCount})
        </button>
        {populatedEras.map((era) => (
          <button
            key={era.id}
            type="button"
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(canvasSurfaceStyles, 'map-bordered-btn'),
              selectedEraId === era.id ? 'active' : ''
            )}
            aria-pressed={selectedEraId === era.id}
            onClick={() => {
              onSelectEraId(era.id);
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
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(canvasSurfaceStyles, 'map-bordered-btn'),
              cx(mapStyles, 'map-route-mode-mobile')
            )}
            aria-label={`Route order: ${routeMode === 'per-person' ? KINLOOM_VOCABULARY.map.byPersonMode : KINLOOM_VOCABULARY.map.chronologicalMode}. Click to switch.`}
            onClick={() => {
              onSetRouteMode(routeMode === 'per-person' ? 'chronological' : 'per-person');
            }}
          >
            {routeMode === 'per-person'
              ? KINLOOM_VOCABULARY.map.byPersonMode
              : KINLOOM_VOCABULARY.map.chronologicalMode}
          </button>
          <fieldset className={cx(mapStyles, 'map-route-mode')} aria-label="Full lineage route mode">
            <button
              type="button"
              className={joinClasses(
                cx(controlStyles, 'pill-btn'),
                cx(canvasSurfaceStyles, 'map-bordered-btn'),
                routeMode === 'per-person' ? 'active' : ''
              )}
              aria-pressed={routeMode === 'per-person'}
              onClick={() => {
                onSetRouteMode('per-person');
              }}
            >
              By person
            </button>
            <button
              type="button"
              className={joinClasses(
                cx(controlStyles, 'pill-btn'),
                cx(canvasSurfaceStyles, 'map-bordered-btn'),
                routeMode === 'chronological' ? 'active' : ''
              )}
              aria-pressed={routeMode === 'chronological'}
              onClick={() => {
                onSetRouteMode('chronological');
              }}
            >
              Chronological
            </button>
          </fieldset>
        </>
      )}
    </div>
  );
};
