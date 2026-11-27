import type { ArchiveEvent, TimePersonEntry } from '@kinloom/core';
import {
  buildPersonThumbMap,
  computeTimeSnapshot,
  getSuggestedSnapshotYears,
  parseTimeYearParam,
  pickDefaultSnapshotYear,
  TIME_MAX_YEAR,
  TIME_MIN_YEAR,
} from '@kinloom/core';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { initialsOf, resolveAssetUrl } from '../components/Atoms.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useDialogFocusTrap } from '../lib/useDialogFocusTrap.js';
import { formatReaderLoadError, KINLOOM_VOCABULARY } from '../lib/vocabulary.js';

const TimePersonCard: React.FC<{
  entry: TimePersonEntry;
  activeYear: number;
  personThumbMap: Map<string, string>;
  baseUrl: string;
}> = ({ entry, activeYear, personThumbMap, baseUrl }) => {
  const targetUrl = entry.nearestEventId
    ? `/person/${entry.person.slug}?event=${entry.nearestEventId}`
    : `/person/${entry.person.slug}`;
  let tierClass = 'tier-possible';
  if (entry.tier === 'Confirmed') {
    tierClass = 'tier-confirmed';
  } else if (entry.tier === 'Inferred') {
    tierClass = 'tier-inferred';
  }
  const thumb = personThumbMap.get(entry.person.id) || entry.person.portrait_url;
  return (
    <Link to={targetUrl} className={`time-person-item ${tierClass}`}>
      <div className="photo-print time-person-thumb" aria-hidden="true">
        {thumb ? (
          <img src={resolveAssetUrl(thumb, baseUrl)} alt="" loading="lazy" />
        ) : (
          <span className="photo-print-monogram">{initialsOf(entry.person.full_name)}</span>
        )}
      </div>
      <div className="time-person-info">
        <div className="time-person-name-row">
          <span className="time-person-name">{entry.person.full_name}</span>
          {entry.age !== null && <span className="time-person-age">age {entry.age}</span>}
        </div>
        <div className="time-person-status">
          {entry.exactYearMatch ? `In ${activeYear}: ` : ''}
          {entry.activityTitle}
        </div>
        <p className="time-person-note">{entry.activityNote}</p>
        <div className="time-person-tier">{entry.tier}</div>
      </div>
    </Link>
  );
};

const TimeLocalNote: React.FC<{ ev: ArchiveEvent }> = ({ ev }) => (
  <div className="time-local-note">
    <div className="time-local-title">
      <span>
        {ev.display_date} — {ev.title}
      </span>
    </div>
    {ev.summary && <p>{ev.summary}</p>}
  </div>
);

const ChevronIcon: React.FC<{ direction: 'left' | 'right' | 'up' | 'down' }> = ({ direction }) => {
  let points = '9 18 15 12 9 6';
  if (direction === 'left') {
    points = '15 18 9 12 15 6';
  } else if (direction === 'up') {
    points = '18 15 12 9 6 15';
  } else if (direction === 'down') {
    points = '6 9 12 15 18 9';
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={points} />
    </svg>
  );
};

export const TimePage: React.FC = () => {
  const { siteConfig, baseUrl, bundle, placesById, loading, error, reloadArchive } = useArchiveData();
  const [searchParams] = useSearchParams();
  const [year, setYear] = useState<number | null>(null);
  const [yearSheetOpen, setYearSheetOpen] = useState(false);
  const [worldExpanded, setWorldExpanded] = useState(false);
  const sheetCloseBtnRef = useRef<HTMLButtonElement | null>(null);
  const yearSheetRef = useDialogFocusTrap<HTMLDivElement>({
    open: yearSheetOpen,
    onClose: () => {
      setYearSheetOpen(false);
    },
    initialFocusRef: sheetCloseBtnRef,
  });

  if (bundle && year === null) {
    setYear(
      parseTimeYearParam(searchParams.get('year')) ??
        pickDefaultSnapshotYear(bundle, placesById, siteConfig.anchorYears)
    );
  }

  const suggestedYears = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return getSuggestedSnapshotYears(bundle, placesById, siteConfig.anchorYears);
  }, [bundle, placesById, siteConfig.anchorYears]);

  const activeYear = year ?? suggestedYears[0]?.year ?? 1860;

  useEffect(() => {
    if (year === null || !window.location.pathname.endsWith('/time')) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('year', String(year));
    window.history.replaceState(window.history.state, '', url.toString());
  }, [year]);

  const snapshot = useMemo(() => {
    if (!bundle) {
      return null;
    }
    return computeTimeSnapshot(bundle, activeYear, placesById);
  }, [bundle, activeYear, placesById]);

  const personThumbMap = useMemo(() => {
    if (!bundle) {
      return new Map<string, string>();
    }
    return buildPersonThumbMap(bundle);
  }, [bundle]);

  const prevAnchorYear = useMemo(() => {
    let candidate: number | null = null;
    for (const item of suggestedYears) {
      if (item.year < activeYear) {
        candidate = item.year;
      }
    }
    return candidate;
  }, [suggestedYears, activeYear]);

  const nextAnchorYear = useMemo(() => {
    for (const item of suggestedYears) {
      if (item.year > activeYear) {
        return item.year;
      }
    }
    return null;
  }, [suggestedYears, activeYear]);

  const locatedCount = useMemo(() => {
    if (!snapshot) {
      return 0;
    }
    return snapshot.lanes.reduce((sum, lane) => sum + lane.people.length, 0);
  }, [snapshot]);

  const townCount = snapshot ? snapshot.lanes.length : 0;
  const primaryMacroEvent = snapshot?.macroEvents[0] ?? null;
  const extraMacroCount = snapshot ? Math.max(0, snapshot.macroEvents.length - 1) : 0;
  const fallbackAnchorA = suggestedYears[0]?.year;
  const fallbackAnchorB = suggestedYears[1]?.year;

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className="time-page">
        <header className="folio-header axis-page-header time-folio-header">
          <div className="time-header-top">
            <div className="time-header-copy">
              <h1 className="folio-title">
                {siteConfig.site.familyName} in{' '}
                <span className="handwritten-year-hero" aria-live="polite">
                  {activeYear}
                </span>
              </h1>
              <p className="folio-lead">{KINLOOM_VOCABULARY.time.lead}</p>
            </div>
            {snapshot && (
              <div className="time-header-summary" aria-live="polite">
                {locatedCount} located · {townCount} {townCount === 1 ? 'town' : 'towns'}
              </div>
            )}
          </div>

          {yearSheetOpen && (
            <button
              type="button"
              tabIndex={-1}
              className="time-dock-scrim"
              aria-label="Close milestone year picker"
              onClick={() => {
                setYearSheetOpen(false);
              }}
            />
          )}

          <div className={`time-scrubber-wrap print-hide ${yearSheetOpen ? 'sheet-open' : ''}`}>
            {suggestedYears.length > 0 && (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: responsive mobile sheet becomes modal dialog on small viewports
              <div
                ref={yearSheetRef}
                id="time-anchor-sheet"
                role={yearSheetOpen ? 'dialog' : undefined}
                aria-modal={yearSheetOpen ? 'true' : undefined}
                aria-label={yearSheetOpen ? 'Milestone years' : undefined}
                className={`time-anchor-sheet ${yearSheetOpen ? 'open' : ''}`}
              >
                <div className="time-sheet-header">
                  <span className="time-sheet-title">Milestone years</span>
                  <button
                    ref={sheetCloseBtnRef}
                    type="button"
                    className="time-sheet-close"
                    onClick={() => {
                      setYearSheetOpen(false);
                    }}
                  >
                    Close
                  </button>
                </div>
                <div className="time-anchor-caption">Year · people alive</div>
                {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="group" is the correct grouping pattern for a button toolbar
                <div className="time-anchor-strip" role="group" aria-label="Jump to notable family years">
                  {suggestedYears.map((m) => (
                    <button
                      key={m.year}
                      type="button"
                      className={`time-anchor-btn ${activeYear === m.year ? 'active' : ''}`}
                      onClick={() => {
                        setYear(m.year);
                        setYearSheetOpen(false);
                      }}
                      aria-label={`${m.label}: ${m.locatedCount} located of ${m.aliveCount} alive in ${m.year}`}
                      title={`${m.year}: ${m.locatedCount} located of ${m.aliveCount} alive in ${m.year}`}
                    >
                      <span className="time-anchor-year">{m.label}</span>
                      <span className="time-anchor-count" aria-hidden="true">
                        {m.locatedCount}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="time-mobile-dock-bar">
              <div className="time-dock-stepper">
                <button
                  type="button"
                  className="time-dock-step-btn"
                  aria-label={
                    prevAnchorYear === null
                      ? 'No earlier milestone year'
                      : `Previous milestone year (${prevAnchorYear})`
                  }
                  disabled={prevAnchorYear === null}
                  onClick={() => {
                    if (prevAnchorYear !== null) {
                      setYear(prevAnchorYear);
                      setYearSheetOpen(false);
                    }
                  }}
                >
                  <ChevronIcon direction="left" />
                </button>
                <span className="time-dock-year-readout" aria-hidden="true">
                  {activeYear}
                </span>
                <button
                  type="button"
                  className="time-dock-step-btn"
                  aria-label={
                    nextAnchorYear === null
                      ? 'No later milestone year'
                      : `Next milestone year (${nextAnchorYear})`
                  }
                  disabled={nextAnchorYear === null}
                  onClick={() => {
                    if (nextAnchorYear !== null) {
                      setYear(nextAnchorYear);
                      setYearSheetOpen(false);
                    }
                  }}
                >
                  <ChevronIcon direction="right" />
                </button>
              </div>
              {suggestedYears.length > 0 && (
                <button
                  type="button"
                  className="time-dock-jump-btn"
                  aria-expanded={yearSheetOpen}
                  aria-controls="time-anchor-sheet"
                  onClick={() => {
                    setYearSheetOpen((open) => !open);
                  }}
                >
                  <span>Jump to year ({suggestedYears.length})</span>
                  <ChevronIcon direction={yearSheetOpen ? 'down' : 'up'} />
                </button>
              )}
            </div>

            <div className="time-slider-row">
              <span className="time-slider-bound">{TIME_MIN_YEAR}</span>
              <input
                type="range"
                min={TIME_MIN_YEAR}
                max={TIME_MAX_YEAR}
                step={1}
                value={activeYear}
                onChange={(e) => {
                  setYear(Number(e.target.value));
                }}
                className="ink-range-slider"
                aria-label={`Select year to inspect ${siteConfig.site.familyName} locations`}
              />
              <span className="time-slider-bound">{TIME_MAX_YEAR}</span>
            </div>
          </div>
        </header>

        {loading && <p className="empty-ring-note">Loading archival snapshot…</p>}
        {error && (
          <div style={{ marginBottom: 18 }}>
            <p className="empty-ring-note">
              {formatReaderLoadError(error, 'Unable to load archive records right now.')}
            </p>
            <button
              type="button"
              className="pill-btn"
              onClick={() => {
                reloadArchive();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {snapshot && (
          <>
            {snapshot.macroEvents.length > 0 && primaryMacroEvent && (
              <section
                className={`time-macro-ribbon ${worldExpanded ? 'is-expanded' : ''}`}
                aria-label={`Wider world events in ${activeYear}`}
              >
                <div className="time-ribbon-label">
                  <span>Wider world</span>
                </div>
                <button
                  type="button"
                  className="time-macro-toggle"
                  aria-expanded={worldExpanded}
                  onClick={() => {
                    setWorldExpanded((open) => !open);
                  }}
                >
                  <span className="time-macro-toggle-main">
                    <span className="time-macro-toggle-tag">World</span>
                    <strong className="time-macro-toggle-title">{primaryMacroEvent.title}</strong>
                    {extraMacroCount > 0 && (
                      <span className="time-macro-toggle-more">+{extraMacroCount}</span>
                    )}
                  </span>
                  <span className="time-macro-toggle-action">
                    <span>{worldExpanded ? 'Hide' : 'Read'}</span>
                    <ChevronIcon direction={worldExpanded ? 'up' : 'down'} />
                  </span>
                </button>
                <div className="time-macro-items">
                  {snapshot.macroEvents.map((ev) => (
                    <div key={ev.id} className="time-macro-item">
                      <span className="time-macro-year">{ev.display_date}</span>
                      <strong>{ev.title}</strong>
                      {ev.summary && <span className="time-macro-summary"> — {ev.summary}</span>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {snapshot.lanes.length === 0 ? (
              <section className="time-empty-state">
                <p>
                  {KINLOOM_VOCABULARY.time.emptyStatePrefix} <strong>{activeYear}</strong>.
                  {fallbackAnchorA !== undefined && (
                    <>
                      {' '}
                      Try a milestone year (such as{' '}
                      <button
                        type="button"
                        className="ink-inline-btn"
                        onClick={() => {
                          setYear(fallbackAnchorA);
                        }}
                      >
                        {fallbackAnchorA}
                      </button>
                      {fallbackAnchorB !== undefined && (
                        <>
                          {' '}
                          or{' '}
                          <button
                            type="button"
                            className="ink-inline-btn"
                            onClick={() => {
                              setYear(fallbackAnchorB);
                            }}
                          >
                            {fallbackAnchorB}
                          </button>
                        </>
                      )}
                      ).
                    </>
                  )}
                </p>
              </section>
            ) : (
              <section className="time-lanes" aria-label={`Town and homestead lanes in ${activeYear}`}>
                {snapshot.lanes.map((lane) => (
                  <article key={lane.place.id} className="time-lane">
                    <div className="time-lane-header">
                      <div>
                        <h2 className="time-lane-place">
                          <Link to={`/place/${lane.place.slug}`}>{lane.place.name}</Link>
                        </h2>
                        <div className="time-lane-sub">{lane.place.full_name}</div>
                      </div>
                      <div className="time-lane-meta">
                        <span>
                          {lane.people.length} {lane.people.length === 1 ? 'relative' : 'relatives'}
                        </span>
                      </div>
                    </div>

                    <div className="time-lane-body">
                      <div className="time-people-row">
                        {lane.people.map((entry) => (
                          <TimePersonCard
                            key={entry.person.id}
                            entry={entry}
                            activeYear={activeYear}
                            personThumbMap={personThumbMap}
                            baseUrl={baseUrl}
                          />
                        ))}
                      </div>

                      {lane.localEvents.length > 0 && (
                        <aside
                          className="time-lane-local"
                          aria-label={`Local dispatches near ${lane.place.name}`}
                        >
                          <div className="time-local-heading">Local weather and news</div>
                          {lane.localEvents.map((ev) => (
                            <TimeLocalNote key={ev.id} ev={ev} />
                          ))}
                        </aside>
                      )}
                    </div>
                  </article>
                ))}
              </section>
            )}

            {snapshot.unlocatedPeople.length > 0 && (
              <section className="time-unlocated-section" aria-label={KINLOOM_VOCABULARY.time.unlocatedAria}>
                <h2 className="section-heading">
                  {KINLOOM_VOCABULARY.time.unlocatedHeadingPrefix} {activeYear} ·{' '}
                  {KINLOOM_VOCABULARY.time.unlocatedHeadingSuffix} ({snapshot.unlocatedPeople.length})
                </h2>
                <div className="time-unlocated-list">
                  {snapshot.unlocatedPeople.map((entry) => (
                    <Link
                      key={entry.person.id}
                      to={
                        entry.nearestEventId
                          ? `/person/${entry.person.slug}?event=${entry.nearestEventId}`
                          : `/person/${entry.person.slug}`
                      }
                      className="time-unlocated-row"
                    >
                      <span className="time-unlocated-name">{entry.person.full_name}</span>
                      <span className="time-unlocated-years">
                        {entry.age === null ? '' : `age ${entry.age} · `}
                        {entry.person.birth_year || '?'}–{entry.person.death_year || '?'}
                      </span>
                      <span className="time-unlocated-note">{entry.activityNote}</span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
      <KinloomFooter />
    </div>
  );
};
