import type { PlaceDirectoryEntry } from '@kinloom/core';
import { buildPlacesDirectory, DEFAULT_MIGRATION_ERAS } from '@kinloom/core';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyStateNotice } from '../components/Atoms.js';
import atomStyles from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx, joinClasses } from '../lib/cx.js';
import {
  buildPlacesDirectorySearchParams,
  buildPlacesDirectorySections,
  computeStageCounts,
  filterPlacesDirectory,
  PLACES_JUMP_STRIP_THRESHOLD,
  type PlacesDirectoryView,
  parsePlacesDirectorySearchParams,
  slicePlacesSection,
} from '../lib/placesDirectoryModel.js';
import { formatReaderLoadError, KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import controlStyles from '../styles/Controls.module.css';
import placesIndexStyles from './PlacesIndexPage.module.css';

const PlaceLedgerEntry: React.FC<{
  entry: PlaceDirectoryEntry;
  stageLabel: string;
}> = ({ entry, stageLabel }) => {
  let yearSpan = 'Undated';
  if (entry.minYear && entry.maxYear) {
    yearSpan = entry.minYear === entry.maxYear ? String(entry.minYear) : `${entry.minYear}–${entry.maxYear}`;
  }
  const previewPeople = entry.people.slice(0, 8);
  const extraCount = Math.max(0, entry.people.length - previewPeople.length);
  return (
    <article className={cx(placesIndexStyles, 'place-ledger-row')}>
      <div className={'place-ledger-main'}>
        <div className={cx(placesIndexStyles, 'place-ledger-top')}>
          <div className={cx(placesIndexStyles, 'place-ledger-identity')}>
            <h3 className={cx(placesIndexStyles, 'place-ledger-name')}>
              <Link to={`/place/${entry.place.slug}`}>{entry.place.name}</Link>
            </h3>
            <div className={cx(placesIndexStyles, 'place-ledger-full')}>
              {entry.place.full_name} · {stageLabel}
            </div>
          </div>
          <div className={cx(placesIndexStyles, 'place-ledger-stats')}>
            <span className={cx(placesIndexStyles, 'place-ledger-span')}>{yearSpan}</span>
            <span className={cx(placesIndexStyles, 'place-ledger-counts')}>
              {entry.people.length} {entry.people.length === 1 ? 'relative' : 'relatives'} ·{' '}
              {entry.eventCount} {entry.eventCount === 1 ? 'event' : 'events'}
            </span>
            <Link to={`/place/${entry.place.slug}`} className={cx(atomStyles, 'ink-link-btn')}>
              {KINLOOM_VOCABULARY.place.placeProfileCta}
            </Link>
          </div>
        </div>

        {previewPeople.length > 0 && (
          <div className={cx(placesIndexStyles, 'place-ledger-people')}>
            <span className={cx(placesIndexStyles, 'place-ledger-people-label')}>Passed through:</span>
            <div className={cx(placesIndexStyles, 'place-ledger-people-list')}>
              {previewPeople.map((p) => (
                <Link
                  key={p.person.id}
                  to={
                    p.firstEventId
                      ? `/person/${p.person.slug}?event=${p.firstEventId}`
                      : `/person/${p.person.slug}`
                  }
                  className={cx(placesIndexStyles, 'place-resident-link')}
                >
                  {p.person.full_name}
                  {p.startYear > 0 && (
                    <span> ({p.startYear === p.endYear ? p.startYear : `${p.startYear}–${p.endYear}`})</span>
                  )}
                </Link>
              ))}
              {extraCount > 0 && (
                <Link
                  to={`/place/${entry.place.slug}`}
                  className={cx(placesIndexStyles, 'place-resident-more')}
                >
                  +{extraCount} more →
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </article>
  );
};

export const PlacesIndexPage: React.FC = () => {
  const { siteConfig, bundle, placesById, peopleById, loading, error, reloadArchive } = useArchiveData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedSections, setExpandedSections] = useState<ReadonlySet<string>>(() => new Set());

  const migrationEras = useMemo(
    () => (siteConfig.migrationEras.length > 0 ? siteConfig.migrationEras : DEFAULT_MIGRATION_ERAS),
    [siteConfig.migrationEras]
  );

  const stageLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const era of migrationEras) {
      map.set(era.id, era.label);
    }
    return map;
  }, [migrationEras]);

  const directory = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return buildPlacesDirectory(bundle, placesById, peopleById, migrationEras);
  }, [bundle, placesById, peopleById, migrationEras]);

  const stageCounts = useMemo(() => computeStageCounts(directory, migrationEras), [directory, migrationEras]);

  const stageFilters = useMemo(
    () => [
      { id: 'all', label: KINLOOM_VOCABULARY.place.placesFilterAll },
      ...migrationEras
        .filter((era) => (stageCounts[era.id] ?? 0) > 0)
        .map((era) => ({ id: era.id, label: era.label })),
    ],
    [migrationEras, stageCounts]
  );

  const validStageIds = useMemo(() => new Set(stageFilters.map((f) => f.id)), [stageFilters]);

  const { view, stage, query } = useMemo(
    () => parsePlacesDirectorySearchParams(searchParams, validStageIds),
    [searchParams, validStageIds]
  );

  const updateQueryState = useCallback(
    (patch: Partial<{ view: PlacesDirectoryView; stage: string; query: string }>) => {
      const next = buildPlacesDirectorySearchParams({
        view: patch.view ?? view,
        stage: patch.stage ?? stage,
        query: patch.query ?? query,
      });
      setSearchParams(next, { replace: true });
    },
    [view, stage, query, setSearchParams]
  );

  const handleViewChange = useCallback(
    (nextView: PlacesDirectoryView) => {
      setExpandedSections(new Set());
      updateQueryState({ view: nextView });
    },
    [updateQueryState]
  );

  const handleStageChange = useCallback(
    (nextStage: string) => {
      setExpandedSections(new Set());
      updateQueryState({ stage: nextStage });
    },
    [updateQueryState]
  );

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      updateQueryState({ query: nextQuery });
    },
    [updateQueryState]
  );

  const handleClearFilters = useCallback(() => {
    setExpandedSections(new Set());
    updateQueryState({ stage: 'all', query: '' });
  }, [updateQueryState]);

  const filtered = useMemo(
    () => filterPlacesDirectory({ directory, stage, query }),
    [directory, stage, query]
  );

  const sections = useMemo(() => buildPlacesDirectorySections({ entries: filtered, view }), [filtered, view]);

  const showStageSelector = stageFilters.length > 2;
  const showJumpStrip = filtered.length > PLACES_JUMP_STRIP_THRESHOLD && sections.length > 1;
  const hasActiveFilters = stage !== 'all' || query.trim().length > 0;

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(placesIndexStyles, 'places-index-page')}>
        <header className={cx(atomStyles, 'folio-header axis-page-header')}>
          <div className={cx(atomStyles, 'folio-header-row')}>
            <div>
              <h1 className={cx(atomStyles, 'folio-title')}>
                Places in the {siteConfig.site.familyName} Archive
              </h1>
              <p className={cx(atomStyles, 'folio-lead')}>
                Towns, counties, and homesteads along the line: who passed through, when they overlapped, and
                what local weather or newspaper notices recorded.
              </p>
              <div className={cx(atomStyles, 'axis-page-header-actions')}>
                <Link to="/map" className={cx(atomStyles, 'ink-link-btn')}>
                  Open Migration Map →
                </Link>
              </div>
            </div>
          </div>
        </header>

        {loading && <p className={cx(controlStyles, 'empty-ring-note')}>Loading places directory…</p>}
        {error && (
          <div style={{ marginBottom: 18 }}>
            <p className={cx(controlStyles, 'empty-ring-note')}>
              {formatReaderLoadError(error, 'Unable to load archive records right now.')}
            </p>
            <button
              type="button"
              className={cx(controlStyles, 'pill-btn')}
              onClick={() => {
                reloadArchive();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {bundle && (
          <>
            <div className={cx(placesIndexStyles, 'places-toolbar')}>
              <div className={joinClasses(cx(placesIndexStyles, 'places-search-wrap'), 'places-search-bar')}>
                <input
                  type="search"
                  className={cx(controlStyles, 'search-input')}
                  placeholder={KINLOOM_VOCABULARY.place.filterPlaceholder}
                  value={query}
                  onChange={(e) => {
                    handleQueryChange(e.target.value);
                  }}
                  aria-label={KINLOOM_VOCABULARY.place.filterAria}
                />
              </div>

              <div className={cx(placesIndexStyles, 'places-toolbar-controls')}>
                <div
                  role="group"
                  aria-label="Places directory view"
                  className={cx(placesIndexStyles, 'places-view-segmented')}
                >
                  <button
                    type="button"
                    className={cx(
                      placesIndexStyles,
                      view === 'region' ? 'places-view-btn is-active' : 'places-view-btn'
                    )}
                    aria-pressed={view === 'region'}
                    onClick={() => {
                      handleViewChange('region');
                    }}
                  >
                    By Region
                  </button>
                  <button
                    type="button"
                    className={cx(
                      placesIndexStyles,
                      view === 'era' ? 'places-view-btn is-active' : 'places-view-btn'
                    )}
                    aria-pressed={view === 'era'}
                    onClick={() => {
                      handleViewChange('era');
                    }}
                  >
                    By Era
                  </button>
                  <button
                    type="button"
                    className={cx(
                      placesIndexStyles,
                      view === 'az' ? 'places-view-btn is-active' : 'places-view-btn'
                    )}
                    aria-pressed={view === 'az'}
                    onClick={() => {
                      handleViewChange('az');
                    }}
                  >
                    A–Z
                  </button>
                </div>

                {showStageSelector && (
                  <select
                    aria-label="Filter places by migration region"
                    className={joinClasses(
                      cx(controlStyles, 'pill-btn'),
                      cx(placesIndexStyles, 'places-stage-select')
                    )}
                    value={stage}
                    onChange={(e) => {
                      handleStageChange(e.target.value);
                    }}
                  >
                    {stageFilters.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label} ({stageCounts[f.id] ?? 0})
                      </option>
                    ))}
                  </select>
                )}

                {hasActiveFilters && (
                  <button
                    type="button"
                    className={cx(controlStyles, 'pill-btn places-clear-btn')}
                    onClick={handleClearFilters}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {showJumpStrip && (
              <div className={cx(placesIndexStyles, 'places-jump-strip-wrap')}>
                <nav
                  className={cx(
                    placesIndexStyles,
                    view === 'az' ? 'places-jump-strip is-az' : 'places-jump-strip'
                  )}
                  aria-label="Jump to places section"
                >
                  {sections.map((section) => (
                    <a
                      key={section.id}
                      href={`#${section.id}`}
                      className={cx(placesIndexStyles, 'places-jump-link')}
                      aria-label={
                        view === 'az'
                          ? `Jump to letter ${section.heading} (${section.entries.length})`
                          : undefined
                      }
                    >
                      <span>{section.shortLabel}</span>
                      {view !== 'az' && (
                        <span className={cx(placesIndexStyles, 'places-jump-count')}>
                          ({section.entries.length})
                        </span>
                      )}
                    </a>
                  ))}
                </nav>
              </div>
            )}

            {filtered.length === 0 ? (
              <EmptyStateNotice
                title={
                  directory.length === 0
                    ? 'No documented places have been added to this archive yet.'
                    : KINLOOM_VOCABULARY.place.emptyPlacesFilter
                }
                action={
                  hasActiveFilters ? (
                    <button
                      type="button"
                      className={cx(controlStyles, 'pill-btn')}
                      onClick={handleClearFilters}
                    >
                      Clear filters
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className={cx(placesIndexStyles, 'places-directory-shell')}>
                {sections.map((section, sectionIndex) => {
                  const isExpanded = expandedSections.has(section.id);
                  const slice = slicePlacesSection(section.entries, isExpanded);
                  return (
                    <section
                      key={section.id}
                      id={section.id}
                      className={cx(placesIndexStyles, 'places-directory-section')}
                      aria-labelledby={`${section.id}-heading`}
                    >
                      <header
                        className={cx(
                          placesIndexStyles,
                          sectionIndex === 0 ? 'places-section-header is-first' : 'places-section-header'
                        )}
                      >
                        <div className={cx(placesIndexStyles, 'places-section-heading-row')}>
                          <h2
                            id={`${section.id}-heading`}
                            className={cx(placesIndexStyles, 'places-section-heading')}
                          >
                            {section.heading}
                          </h2>
                          <span className={cx(placesIndexStyles, 'places-section-count')}>
                            ({section.entries.length})
                          </span>
                        </div>
                        {section.scentLink && (
                          <Link
                            to={section.scentLink.to}
                            className={cx(placesIndexStyles, 'places-section-scent')}
                          >
                            {section.scentLink.label}
                          </Link>
                        )}
                      </header>

                      <div className={cx(placesIndexStyles, 'places-ledger')}>
                        {slice.visible.map((entry) => (
                          <PlaceLedgerEntry
                            key={entry.place.id}
                            entry={entry}
                            stageLabel={stageLabelById.get(entry.stage) ?? entry.stage}
                          />
                        ))}
                      </div>

                      {slice.isCapped && (
                        <div className={cx(placesIndexStyles, 'places-section-expand-row')}>
                          <button
                            type="button"
                            className={cx(controlStyles, 'pill-btn')}
                            onClick={() => {
                              setExpandedSections((prev) => {
                                const next = new Set(prev);
                                next.add(section.id);
                                return next;
                              });
                            }}
                          >
                            Show all {section.entries.length}
                          </button>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>
      <KinloomFooter />
    </div>
  );
};
