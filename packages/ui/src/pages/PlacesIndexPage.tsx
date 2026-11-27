import type { PlaceDirectoryEntry } from '@kinloom/core';
import { buildPlacesDirectory, DEFAULT_MIGRATION_ERAS } from '@kinloom/core';
import type React from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyStateNotice } from '../components/Atoms.js';
import cssMod0 from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import { formatReaderLoadError, KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import cssMod1 from './IndexPage.module.css';
import cssMod2 from './PersonPage.module.css';
import cssMod3 from './PlacesIndexPage.module.css';
import cssMod4 from './TimePage.module.css';

const uiStyles: Readonly<Record<string, string>> = {
  ...cssMod0,
  ...cssMod1,
  ...cssMod2,
  ...cssMod3,
  ...cssMod4,
};

const PlaceLedgerEntry: React.FC<{
  entry: PlaceDirectoryEntry;
  stageLabel: string;
}> = ({ entry, stageLabel }) => {
  let yearSpan = 'Undated';
  if (entry.minYear && entry.maxYear) {
    yearSpan =
      entry.minYear === entry.maxYear ? String(entry.minYear) : `${entry.minYear} – ${entry.maxYear}`;
  }
  const previewPeople = entry.people.slice(0, 8);
  const extraCount = Math.max(0, entry.people.length - previewPeople.length);
  return (
    <article className={cx(uiStyles, 'place-ledger-row')}>
      <div className={cx(uiStyles, 'place-ledger-main')}>
        <div className={cx(uiStyles, 'place-ledger-top')}>
          <div>
            <h2 className={cx(uiStyles, 'place-ledger-name')}>
              <Link to={`/place/${entry.place.slug}`}>{entry.place.name}</Link>
            </h2>
            <div className={cx(uiStyles, 'place-ledger-full')}>
              {entry.place.full_name} · {stageLabel}
            </div>
          </div>
          <div className={cx(uiStyles, 'place-ledger-stats')}>
            <span className={cx(uiStyles, 'place-ledger-span')}>{yearSpan}</span>
            <span className={cx(uiStyles, 'place-ledger-counts')}>
              {entry.people.length} {entry.people.length === 1 ? 'relative' : 'relatives'} ·{' '}
              {entry.eventCount} {entry.eventCount === 1 ? 'event' : 'events'}
            </span>
            <Link to={`/place/${entry.place.slug}`} className={cx(uiStyles, 'ink-link-btn')}>
              {KINLOOM_VOCABULARY.place.placeProfileCta}
            </Link>
          </div>
        </div>

        {previewPeople.length > 0 && (
          <div className={cx(uiStyles, 'place-ledger-people')}>
            <span className={cx(uiStyles, 'place-ledger-people-label')}>Passed through:</span>
            <div className={cx(uiStyles, 'place-ledger-people-list')}>
              {previewPeople.map((p) => (
                <Link
                  key={p.person.id}
                  to={
                    p.firstEventId
                      ? `/person/${p.person.slug}?event=${p.firstEventId}`
                      : `/person/${p.person.slug}`
                  }
                  className={cx(uiStyles, 'place-resident-link')}
                >
                  {p.person.full_name}
                  {p.startYear > 0 && (
                    <span> ({p.startYear === p.endYear ? p.startYear : `${p.startYear}–${p.endYear}`})</span>
                  )}
                </Link>
              ))}
              {extraCount > 0 && (
                <Link to={`/place/${entry.place.slug}`} className={cx(uiStyles, 'place-resident-more')}>
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
  const [stage, setStage] = useState<string>('all');
  const [query, setQuery] = useState<string>('');

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

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { all: directory.length };
    for (const era of migrationEras) {
      counts[era.id] = 0;
    }
    for (const entry of directory) {
      counts[entry.stage] = (counts[entry.stage] ?? 0) + 1;
    }
    return counts;
  }, [directory, migrationEras]);

  const stageFilters = useMemo(
    () => [
      { id: 'all', label: KINLOOM_VOCABULARY.place.placesFilterAll },
      ...migrationEras
        .filter((era) => (stageCounts[era.id] ?? 0) > 0)
        .map((era) => ({ id: era.id, label: era.label })),
    ],
    [migrationEras, stageCounts]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return directory.filter((entry) => {
      if (stage !== 'all' && entry.stage !== stage) {
        return false;
      }
      if (q) {
        const matchPlace = entry.place.full_name.toLowerCase().includes(q);
        const matchPerson = entry.people.some((p) => p.person.full_name.toLowerCase().includes(q));
        if (!matchPlace && !matchPerson) {
          return false;
        }
      }
      return true;
    });
  }, [directory, stage, query]);

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(uiStyles, 'places-index-page')}>
        <header className={cx(uiStyles, 'folio-header axis-page-header')}>
          <div className={cx(uiStyles, 'folio-header-row')}>
            <div>
              <h1 className={cx(uiStyles, 'folio-title')}>
                Places in the {siteConfig.site.familyName} Archive
              </h1>
              <p className={cx(uiStyles, 'folio-lead')}>
                Towns, counties, and homesteads along the line: who passed through, when they overlapped, and
                what local weather or newspaper notices recorded.
              </p>
              <div className={cx(uiStyles, 'axis-page-header-actions')}>
                <Link to="/map" className={cx(uiStyles, 'ink-link-btn')}>
                  Open Migration Map →
                </Link>
              </div>
            </div>
          </div>
        </header>

        {loading && <p className={cx(uiStyles, 'empty-ring-note')}>Loading places directory…</p>}
        {error && (
          <div style={{ marginBottom: 18 }}>
            <p className={cx(uiStyles, 'empty-ring-note')}>
              {formatReaderLoadError(error, 'Unable to load archive records right now.')}
            </p>
            <button
              type="button"
              className={cx(uiStyles, 'pill-btn')}
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
            <div className={cx(uiStyles, 'places-filter-stack')}>
              <div
                className={cx(uiStyles, 'filter-bar ink-filter-bar')}
                role="group"
                aria-label="Filter places by migration region"
              >
                {stageFilters.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={cx(uiStyles, `pill-btn ${stage === f.id ? 'active' : ''}`)}
                    onClick={() => {
                      setStage(f.id);
                    }}
                  >
                    {f.label} ({stageCounts[f.id] ?? 0})
                  </button>
                ))}
              </div>

              <div className={cx(uiStyles, 'filter-bar places-search-bar')}>
                <input
                  type="search"
                  className={cx(uiStyles, 'search-input')}
                  placeholder={KINLOOM_VOCABULARY.place.filterPlaceholder}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                  }}
                  aria-label={KINLOOM_VOCABULARY.place.filterAria}
                />
              </div>
            </div>

            {filtered.length === 0 ? (
              <EmptyStateNotice
                title={
                  directory.length === 0
                    ? 'No documented places have been added to this archive yet.'
                    : KINLOOM_VOCABULARY.place.emptyPlacesFilter
                }
                action={
                  stage !== 'all' || query.trim() ? (
                    <button
                      type="button"
                      className={cx(uiStyles, 'pill-btn')}
                      onClick={() => {
                        setStage('all');
                        setQuery('');
                      }}
                    >
                      Clear filters
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <section className={cx(uiStyles, 'places-ledger')} aria-label="Archived places and residents">
                {filtered.map((entry) => (
                  <PlaceLedgerEntry
                    key={entry.place.id}
                    entry={entry}
                    stageLabel={stageLabelById.get(entry.stage) ?? entry.stage}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </main>
      <KinloomFooter />
    </div>
  );
};
