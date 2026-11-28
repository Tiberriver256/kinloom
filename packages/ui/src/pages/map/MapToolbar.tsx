import type { LineageRouteMode, MigrationEraConfig, Person } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import canvasSurfaceStyles from '../../components/CanvasSurfacePrimitives.module.css';
import { cx, joinClasses } from '../../lib/cx.js';
import { KINLOOM_COLOR_TOKENS } from '../../lib/tokens.js';
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

  for (let i = 0; i < eras.length; i += 1) {
    const needed = gapPx + eras[i].width;
    if (usedWidth + needed <= availableForEras) {
      visibleIndices.push(i);
      usedWidth += needed;
    } else {
      break;
    }
  }

  if (selectedIndex >= 0 && !visibleIndices.includes(selectedIndex)) {
    const selectedNeeded = gapPx + eras[selectedIndex].width;
    while (visibleIndices.length > 0 && usedWidth + selectedNeeded > availableForEras) {
      const removed = visibleIndices.pop();
      if (removed !== undefined) {
        usedWidth -= gapPx + eras[removed].width;
      }
    }
    if (usedWidth + selectedNeeded <= availableForEras) {
      visibleIndices.push(selectedIndex);
    }
  }

  const visibleSet = new Set(visibleIndices);
  const visibleEraIds: string[] = [];
  const overflowEraIds: string[] = [];
  for (let i = 0; i < eras.length; i += 1) {
    if (visibleSet.has(i)) {
      visibleEraIds.push(eras[i].id);
    } else {
      overflowEraIds.push(eras[i].id);
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

const DEFAULT_PRESET_GAP_PX = 4;
const DEFAULT_TOOLBAR_INSET_PX = 12;
const FALLBACK_MORE_BUTTON_WIDTH = 104;

export const MapToolbar: React.FC<MapToolbarProps> = ({
  toolbarRef,
  selectablePeople,
  selectedPersonId,
  selectedEraId,
  routeMode,
  allStopsCount,
  migrationEras,
  eraStopCounts,
  stageColorMap,
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
  const presetsSlotRef = useRef<HTMLDivElement | null>(null);
  const measureRowRef = useRef<HTMLDivElement | null>(null);
  const overflowWrapRef = useRef<HTMLDivElement | null>(null);
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [overflowIds, setOverflowIds] = useState<readonly string[]>([]);

  const resolveEraSwatchColor = useCallback(
    (era: MigrationEraConfig): string =>
      stageColorMap?.get(era.id) ?? era.color ?? KINLOOM_COLOR_TOKENS.archivalIndigo,
    [stageColorMap]
  );

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

  const recalculateOverflow = useCallback(() => {
    const toolbar = internalToolbarRef.current;
    const slot = presetsSlotRef.current;
    const measureRow = measureRowRef.current;
    if (!toolbar || !slot || !measureRow) {
      return;
    }

    const parentWidth = toolbar.parentElement?.clientWidth ?? 0;
    if (parentWidth > 0 && parentWidth <= 768) {
      setOverflowIds((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    let availableWidth = slot.clientWidth;
    if (parentWidth > 768) {
      const style = window.getComputedStyle(toolbar);
      const padX =
        (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.paddingRight) || 0) +
        (Number.parseFloat(style.borderLeftWidth) || 0) +
        (Number.parseFloat(style.borderRightWidth) || 0);
      const gapX = Number.parseFloat(style.columnGap || style.gap) || 8;
      const traceEl = toolbar.querySelector<HTMLElement>('[data-map-trace-label="true"]');
      const routeEl = toolbar.querySelector<HTMLElement>('[data-map-route-mode="true"]');
      const traceWidth = traceEl ? Math.ceil(traceEl.getBoundingClientRect().width) : 0;
      const routeWidth = routeEl ? Math.ceil(routeEl.getBoundingClientRect().width) : 0;
      const insetX = Number.parseFloat(style.left) || DEFAULT_TOOLBAR_INSET_PX;
      const maxToolbarWidth = Math.max(0, parentWidth - insetX * 2);
      const siblingGaps = (traceWidth > 0 ? gapX : 0) + (routeWidth > 0 ? gapX : 0);
      availableWidth = Math.max(
        0,
        Math.floor(maxToolbarWidth - padX - traceWidth - routeWidth - siblingGaps)
      );
    }

    if (availableWidth <= 0) {
      setOverflowIds((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const measureStyle = window.getComputedStyle(measureRow);
    const presetGapPx =
      Number.parseFloat(measureStyle.columnGap || measureStyle.gap) || DEFAULT_PRESET_GAP_PX;

    const widthsByKey = new Map<string, number>();
    for (const el of measureRow.querySelectorAll<HTMLElement>('[data-measure-era]')) {
      const key = el.dataset.measureEra;
      if (key) {
        widthsByKey.set(key, Math.ceil(el.getBoundingClientRect().width));
      }
    }
    const allButtonWidth = widthsByKey.get('all') ?? 0;
    const moreButtonWidth = widthsByKey.get('more') ?? FALLBACK_MORE_BUTTON_WIDTH;

    const measuredEras = populatedEras.map((era) => ({
      id: era.id,
      width: widthsByKey.get(era.id) ?? 0,
    }));

    const layout = computeEraOverflowLayout({
      containerWidth: availableWidth,
      allButtonWidth,
      moreButtonWidth,
      gapPx: presetGapPx,
      eras: measuredEras,
      selectedEraId,
    });

    setOverflowIds((prev) => {
      if (
        prev.length === layout.overflowEraIds.length &&
        prev.every((id, idx) => id === layout.overflowEraIds[idx])
      ) {
        return prev;
      }
      return layout.overflowEraIds;
    });
  }, [populatedEras, selectedEraId]);

  useLayoutEffect(() => {
    recalculateOverflow();
  }, [recalculateOverflow]);

  useEffect(() => {
    const toolbar = internalToolbarRef.current;
    const observeTarget = toolbar?.parentElement ?? presetsSlotRef.current;
    if (!observeTarget) {
      return undefined;
    }
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        recalculateOverflow();
      });
      observer.observe(observeTarget);
    }
    const onResize = (): void => {
      recalculateOverflow();
    };
    window.addEventListener('resize', onResize);
    let cancelled = false;
    const fontSet = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fontSet?.ready) {
      void fontSet.ready.then(() => {
        if (!cancelled) {
          recalculateOverflow();
        }
      });
    }
    fontSet?.addEventListener?.('loadingdone', onResize);
    return (): void => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      fontSet?.removeEventListener?.('loadingdone', onResize);
    };
  }, [recalculateOverflow]);

  useEffect(() => {
    if (!overflowOpen) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && overflowWrapRef.current?.contains(target)) {
        return;
      }
      setOverflowOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [overflowOpen]);

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

  const overflowSet = useMemo(() => new Set(overflowIds), [overflowIds]);
  const visibleEras = useMemo(
    () => populatedEras.filter((era) => !overflowSet.has(era.id)),
    [populatedEras, overflowSet]
  );
  const overflowEras = useMemo(
    () => populatedEras.filter((era) => overflowSet.has(era.id)),
    [populatedEras, overflowSet]
  );

  useEffect(() => {
    if (overflowEras.length === 0 && overflowOpen) {
      setOverflowOpen(false);
    }
  }, [overflowEras.length, overflowOpen]);

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
          <span className={cx(mapStyles, 'map-filters-sheet-title')}>Filters &amp; Eras</span>
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

        <div ref={presetsSlotRef} className={cx(mapStyles, 'map-toolbar-presets-slot')}>
          <div ref={measureRowRef} className={cx(mapStyles, 'map-era-measure-row')} aria-hidden="true">
            <span
              data-measure-era="all"
              className={joinClasses(
                cx(controlStyles, 'pill-btn'),
                cx(canvasSurfaceStyles, 'map-bordered-btn'),
                cx(mapStyles, 'map-era-pill')
              )}
            >
              {KINLOOM_VOCABULARY.map.allEras} ({allStopsCount})
            </span>
            {populatedEras.map((era) => (
              <span
                key={era.id}
                data-measure-era={era.id}
                className={joinClasses(
                  cx(controlStyles, 'pill-btn'),
                  cx(canvasSurfaceStyles, 'map-bordered-btn'),
                  cx(mapStyles, 'map-era-pill')
                )}
              >
                <span
                  className={cx(mapStyles, 'map-era-swatch')}
                  style={{ backgroundColor: resolveEraSwatchColor(era) }}
                />
                {era.label} ({eraStopCounts.get(era.id) ?? 0})
              </span>
            ))}
            <span
              data-measure-era="more"
              className={joinClasses(
                cx(controlStyles, 'pill-btn'),
                cx(canvasSurfaceStyles, 'map-bordered-btn'),
                cx(mapStyles, 'map-era-more-btn')
              )}
            >
              More (+{Math.max(1, populatedEras.length)}) ▾
            </span>
          </div>

          <fieldset className={cx(mapStyles, 'map-toolbar-presets')} aria-label="Filter migration map by era">
            <button
              type="button"
              className={joinClasses(
                cx(controlStyles, 'pill-btn'),
                cx(canvasSurfaceStyles, 'map-bordered-btn'),
                cx(mapStyles, 'map-era-pill'),
                selectedEraId === 'all' ? 'active' : ''
              )}
              aria-pressed={selectedEraId === 'all'}
              onClick={() => {
                onSelectEraId('all');
              }}
            >
              {KINLOOM_VOCABULARY.map.allEras} ({allStopsCount})
            </button>
            {visibleEras.map((era) => (
              <button
                key={era.id}
                type="button"
                className={joinClasses(
                  cx(controlStyles, 'pill-btn'),
                  cx(canvasSurfaceStyles, 'map-bordered-btn'),
                  cx(mapStyles, 'map-era-pill'),
                  selectedEraId === era.id ? 'active' : ''
                )}
                aria-pressed={selectedEraId === era.id}
                onClick={() => {
                  onSelectEraId(era.id);
                }}
              >
                <span
                  className={cx(mapStyles, 'map-era-swatch')}
                  style={{ backgroundColor: resolveEraSwatchColor(era) }}
                  aria-hidden="true"
                />
                <span>
                  {era.label} ({eraStopCounts.get(era.id) ?? 0})
                </span>
              </button>
            ))}
          </fieldset>

          {overflowEras.length > 0 && (
            <div ref={overflowWrapRef} className={cx(mapStyles, 'map-era-more-wrap')}>
              <button
                type="button"
                className={joinClasses(
                  cx(controlStyles, 'pill-btn'),
                  cx(canvasSurfaceStyles, 'map-bordered-btn'),
                  cx(mapStyles, 'map-era-more-btn'),
                  overflowOpen ? 'active' : ''
                )}
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-label={`More migration eras (${overflowEras.length} hidden)`}
                onClick={() => {
                  setOverflowOpen((open) => !open);
                }}
              >
                More (+{overflowEras.length}) ▾
              </button>
              {overflowOpen && (
                <div
                  role="menu"
                  aria-label="Additional migration eras"
                  className={cx(mapStyles, 'map-era-more-menu')}
                >
                  {overflowEras.map((era) => (
                    <button
                      key={era.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selectedEraId === era.id}
                      className={joinClasses(
                        cx(mapStyles, 'map-era-more-item'),
                        selectedEraId === era.id ? 'active' : ''
                      )}
                      onClick={() => {
                        onSelectEraId(era.id);
                        setOverflowOpen(false);
                      }}
                    >
                      <span className={cx(mapStyles, 'map-era-more-label')}>
                        <span
                          className={cx(mapStyles, 'map-era-swatch')}
                          style={{ backgroundColor: resolveEraSwatchColor(era) }}
                          aria-hidden="true"
                        />
                        <span>{era.label}</span>
                      </span>
                      <span className={cx(mapStyles, 'map-era-more-count')}>
                        ({eraStopCounts.get(era.id) ?? 0})
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

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
