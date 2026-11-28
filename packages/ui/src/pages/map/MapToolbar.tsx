import type { LineageRouteMode, MigrationEraConfig, Person } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cx, joinClasses } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import mapStyles from '../MapPage.module.css';

export interface EraOverflowLayout {
  readonly visibleEraIds: readonly string[];
  readonly overflowEraIds: readonly string[];
}

export function computeEraOverflowLayout(params: {
  readonly containerWidth: number;
  readonly allButtonWidth: number;
  readonly moreButtonWidth: number;
  readonly gapPx: number;
  readonly eras: readonly { readonly id: string; readonly width: number }[];
  readonly selectedEraId: string;
}): EraOverflowLayout {
  const { containerWidth, allButtonWidth, moreButtonWidth, gapPx, eras, selectedEraId } = params;
  if (containerWidth <= 0 || eras.length === 0) {
    return {
      visibleEraIds: eras.map((era) => era.id),
      overflowEraIds: [],
    };
  }

  let totalWidth = allButtonWidth;
  for (const era of eras) {
    totalWidth += gapPx + era.width;
  }
  if (totalWidth <= containerWidth) {
    return {
      visibleEraIds: eras.map((era) => era.id),
      overflowEraIds: [],
    };
  }

  const availableForEras = Math.max(0, containerWidth - allButtonWidth - gapPx - moreButtonWidth);
  const selectedIndex = eras.findIndex((era) => era.id === selectedEraId);
  const visibleIndices: number[] = [];
  let usedWidth = 0;

  for (const [i, era] of eras.entries()) {
    const needed = gapPx + era.width;
    if (usedWidth + needed <= availableForEras) {
      visibleIndices.push(i);
      usedWidth += needed;
    } else {
      break;
    }
  }

  const selectedEra = selectedIndex >= 0 ? eras[selectedIndex] : undefined;
  if (selectedEra && !visibleIndices.includes(selectedIndex)) {
    const selectedNeeded = gapPx + selectedEra.width;
    while (visibleIndices.length > 0 && usedWidth + selectedNeeded > availableForEras) {
      const removed = visibleIndices.pop();
      if (removed !== undefined) {
        usedWidth -= gapPx + (eras[removed]?.width ?? 0);
      }
    }
    if (usedWidth + selectedNeeded <= availableForEras) {
      visibleIndices.push(selectedIndex);
    }
  }

  const visibleSet = new Set(visibleIndices);
  const visibleEraIds: string[] = [];
  const overflowEraIds: string[] = [];
  for (const [i, era] of eras.entries()) {
    if (visibleSet.has(i)) {
      visibleEraIds.push(era.id);
    } else {
      overflowEraIds.push(era.id);
    }
  }

  return { visibleEraIds, overflowEraIds };
}

export interface MapToolbarProps {
  readonly toolbarRef?: React.RefObject<HTMLDivElement | null>;
  readonly selectablePeople: readonly Person[];
  readonly selectedPersonId: string;
  readonly selectedEraId: string;
  readonly routeMode: LineageRouteMode;
  readonly allStopsCount: number;
  readonly migrationEras: readonly MigrationEraConfig[];
  readonly eraStopCounts: ReadonlyMap<string, number>;
  readonly stageColorMap?: ReadonlyMap<string, string>;
  readonly onSelectPersonId: (personId: string) => void;
  readonly onSelectEraId: (eraId: string) => void;
  readonly onSetRouteMode: (mode: LineageRouteMode) => void;
}

export const MapToolbar: React.FC<MapToolbarProps> = ({
  toolbarRef,
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
  const filtersPanelId = useId();
  const populatedEras = useMemo(
    () => migrationEras.filter((era) => (eraStopCounts.get(era.id) ?? 0) > 0),
    [migrationEras, eraStopCounts]
  );

  const internalToolbarRef = useRef<HTMLDivElement | null>(null);
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const selectedPerson = useMemo(
    () =>
      selectedPersonId === 'all'
        ? null
        : (selectablePeople.find((person) => person.id === selectedPersonId) ?? null),
    [selectablePeople, selectedPersonId]
  );

  const activeFilterCount = (selectedPersonId !== 'all' ? 1 : 0) + (selectedEraId !== 'all' ? 1 : 0);

  const setCombinedToolbarRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalToolbarRef.current = node;
      if (toolbarRef && 'current' in toolbarRef) {
        (toolbarRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [toolbarRef]
  );

  useEffect(() => {
    if (!mobileFiltersOpen) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && internalToolbarRef.current?.contains(target)) {
        return;
      }
      setMobileFiltersOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileFiltersOpen(false);
        filtersTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileFiltersOpen]);

  return (
    <div
      ref={setCombinedToolbarRef}
      className={cx(mapStyles, `map-overlay map-toolbar${mobileFiltersOpen ? ' is-filters-open' : ''}`)}
    >
      <div className={cx(mapStyles, 'map-toolbar-primary-row')}>
        {selectedPersonId === 'all' ? (
          <fieldset
            data-map-route-mode="true"
            className={cx(mapStyles, 'map-route-mode')}
            aria-label="Full lineage route mode"
          >
            <button
              type="button"
              className={joinClasses(
                cx(mapStyles, 'map-route-seg-btn'),
                routeMode === 'per-person' ? 'active' : ''
              )}
              aria-pressed={routeMode === 'per-person'}
              onClick={() => {
                setMobileFiltersOpen(false);
                onSetRouteMode('per-person');
              }}
            >
              {KINLOOM_VOCABULARY.map.byPersonMode}
            </button>
            <button
              type="button"
              className={joinClasses(
                cx(mapStyles, 'map-route-seg-btn'),
                routeMode === 'chronological' ? 'active' : ''
              )}
              aria-pressed={routeMode === 'chronological'}
              onClick={() => {
                setMobileFiltersOpen(false);
                onSetRouteMode('chronological');
              }}
            >
              {KINLOOM_VOCABULARY.map.chronologicalMode}
            </button>
          </fieldset>
        ) : (
          <div className={cx(mapStyles, 'map-mobile-active-person')}>
            <span className={cx(mapStyles, 'map-mobile-active-person-name')}>
              {selectedPerson ? selectedPerson.full_name : 'Filtered person'}
            </span>
            <button
              type="button"
              className={cx(mapStyles, 'map-mobile-active-person-clear')}
              aria-label="Show all people"
              onClick={() => {
                onSelectPersonId('all');
              }}
            >
              ×
            </button>
          </div>
        )}

        <button
          ref={filtersTriggerRef}
          type="button"
          className={joinClasses(
            cx(controlStyles, 'pill-btn'),
            cx(
              mapStyles,
              `map-filters-toggle-btn${mobileFiltersOpen ? ' active' : ''}${activeFilterCount > 0 ? ' has-active' : ''}`
            )
          )}
          aria-expanded={mobileFiltersOpen}
          aria-controls={filtersPanelId}
          aria-label={
            activeFilterCount > 0
              ? `Map filters and eras (${activeFilterCount} active)`
              : 'Map filters and eras'
          }
          onClick={() => {
            setMobileFiltersOpen((open) => !open);
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path
              d="M2.5 4h11M4.5 8h7M6.5 12h3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <span>Filters</span>
          {activeFilterCount > 0 && (
            <span
              className={cx(mapStyles, 'map-filters-badge')}
              data-active-count={activeFilterCount}
              aria-hidden="true"
            >
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      <div
        id={filtersPanelId}
        className={cx(mapStyles, `map-toolbar-filters-panel${mobileFiltersOpen ? ' is-open' : ''}`)}
        data-filters-open={mobileFiltersOpen ? 'true' : 'false'}
      >
        <div className={cx(mapStyles, 'map-filters-sheet-header')}>
          <span className={cx(mapStyles, 'map-filters-sheet-title')}>Filters &amp; Stages</span>
          <button
            type="button"
            className={cx(mapStyles, 'map-filters-sheet-close')}
            aria-label="Close map filters"
            onClick={() => {
              setMobileFiltersOpen(false);
              filtersTriggerRef.current?.focus();
            }}
          >
            Done
          </button>
        </div>

        <label data-map-trace-label="true" className={cx(mapStyles, 'map-trace-label')}>
          <span className={cx(mapStyles, 'map-trace-label-text')}>Trace:</span>
          <select
            className={joinClasses(cx(controlStyles, 'pill-btn'), cx(mapStyles, 'map-trace-select'))}
            aria-label={KINLOOM_VOCABULARY.map.filterByPersonAria}
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

        <label data-map-stage-label="true" className={cx(mapStyles, 'map-stage-label')}>
          <span className={cx(mapStyles, 'map-trace-label-text')}>Stage:</span>
          <select
            className={joinClasses(cx(controlStyles, 'pill-btn'), cx(mapStyles, 'map-stage-select'))}
            aria-label="Filter migration map by stage"
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
        </label>

        {activeFilterCount > 0 && (
          <button
            type="button"
            className={cx(mapStyles, 'map-filters-clear-btn')}
            onClick={() => {
              onSelectPersonId('all');
              onSelectEraId('all');
              setMobileFiltersOpen(false);
            }}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
};
