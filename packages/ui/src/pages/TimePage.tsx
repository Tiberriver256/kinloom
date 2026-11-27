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
import atomStyles from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap.js';
import { cx, joinClasses } from '../lib/cx.js';
import { formatReaderLoadError, KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import controlStyles from '../styles/Controls.module.css';
import timeStyles from './TimePage.module.css';
import { TimeChevronIcon as ChevronIcon, TimeLocalNote, TimePersonCard } from './time/TimeEntryCards.js';
import scrubberStyles from './time/TimeScrubber.module.css';

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
      <main id="main-content" className={cx(timeStyles, 'time-page')}>
        <header
          className={joinClasses(
            cx(atomStyles, 'folio-header axis-page-header'),
            cx(timeStyles, 'time-folio-header')
          )}
        >
          <div className={cx(timeStyles, 'time-header-top')}>
            <div className={'time-header-copy'}>
              <h1 className={cx(atomStyles, 'folio-title')}>
                {siteConfig.site.familyName} in{' '}
                <span className={cx(timeStyles, 'handwritten-year-hero')} aria-live="polite">
                  {activeYear}
                </span>
              </h1>
              <p className={cx(atomStyles, 'folio-lead')}>{KINLOOM_VOCABULARY.time.lead}</p>
            </div>
            {snapshot && (
              <div className={cx(timeStyles, 'time-header-summary')} aria-live="polite">
                {locatedCount} located · {townCount} {townCount === 1 ? 'town' : 'towns'}
              </div>
            )}
          </div>

          {yearSheetOpen && (
            <button
              type="button"
              tabIndex={-1}
              className={cx(scrubberStyles, 'time-dock-scrim')}
              aria-label="Close milestone year picker"
              onClick={() => {
                setYearSheetOpen(false);
              }}
            />
          )}

          <div
            className={cx(
              scrubberStyles,
              `time-scrubber-wrap print-hide ${yearSheetOpen ? 'sheet-open' : ''}`
            )}
          >
            {suggestedYears.length > 0 && (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: responsive mobile sheet becomes modal dialog on small viewports
              <div
                ref={yearSheetRef}
                id="time-anchor-sheet"
                role={yearSheetOpen ? 'dialog' : undefined}
                aria-modal={yearSheetOpen ? 'true' : undefined}
                aria-label={yearSheetOpen ? 'Milestone years' : undefined}
                className={cx(scrubberStyles, `time-anchor-sheet ${yearSheetOpen ? 'open' : ''}`)}
              >
                <div className={cx(scrubberStyles, 'time-sheet-header')}>
                  <span className={cx(scrubberStyles, 'time-sheet-title')}>Milestone years</span>
                  <button
                    ref={sheetCloseBtnRef}
                    type="button"
                    className={cx(scrubberStyles, 'time-sheet-close')}
                    onClick={() => {
                      setYearSheetOpen(false);
                    }}
                  >
                    Close
                  </button>
                </div>
                <div className={cx(scrubberStyles, 'time-anchor-caption')}>Year · people alive</div>
                <div
                  className={cx(scrubberStyles, 'time-anchor-strip')}
                  role="group"
                  aria-label="Jump to notable family years"
                >
                  {suggestedYears.map((m) => (
                    <button
                      key={m.year}
                      type="button"
                      className={cx(
                        scrubberStyles,
                        `time-anchor-btn ${activeYear === m.year ? 'active' : ''}`
                      )}
                      onClick={() => {
                        setYear(m.year);
                        setYearSheetOpen(false);
                      }}
                      aria-label={`${m.label}: ${m.locatedCount} located of ${m.aliveCount} alive in ${m.year}`}
                      title={`${m.year}: ${m.locatedCount} located of ${m.aliveCount} alive in ${m.year}`}
                    >
                      <span className={cx(scrubberStyles, 'time-anchor-year')}>{m.label}</span>
                      <span className={cx(scrubberStyles, 'time-anchor-count')} aria-hidden="true">
                        {m.locatedCount}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className={cx(scrubberStyles, 'time-mobile-dock-bar')}>
              <div className={cx(scrubberStyles, 'time-dock-stepper')}>
                <button
                  type="button"
                  className={cx(scrubberStyles, 'time-dock-step-btn')}
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
                <span className={cx(scrubberStyles, 'time-dock-year-readout')} aria-hidden="true">
                  {activeYear}
                </span>
                <button
                  type="button"
                  className={cx(scrubberStyles, 'time-dock-step-btn')}
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
                  className={cx(scrubberStyles, 'time-dock-jump-btn')}
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

            <div className={cx(scrubberStyles, 'time-slider-row')}>
              <span className={cx(scrubberStyles, 'time-slider-bound')}>{TIME_MIN_YEAR}</span>
              <input
                type="range"
                min={TIME_MIN_YEAR}
                max={TIME_MAX_YEAR}
                step={1}
                value={activeYear}
                onChange={(e) => {
                  setYear(Number(e.target.value));
                }}
                className={cx(scrubberStyles, 'ink-range-slider')}
                aria-label={`Select year to inspect ${siteConfig.site.familyName} locations`}
              />
              <span className={cx(scrubberStyles, 'time-slider-bound')}>{TIME_MAX_YEAR}</span>
            </div>
          </div>
        </header>

        {loading && <p className={cx(controlStyles, 'empty-ring-note')}>Loading archival snapshot…</p>}
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

        {snapshot && (
          <>
            {snapshot.macroEvents.length > 0 && primaryMacroEvent && (
              <section
                className={cx(timeStyles, `time-macro-ribbon ${worldExpanded ? 'is-expanded' : ''}`)}
                aria-label={`Wider world events in ${activeYear}`}
              >
                <div className={cx(timeStyles, 'time-ribbon-label')}>
                  <span>Wider world</span>
                </div>
                <button
                  type="button"
                  className={cx(scrubberStyles, 'time-macro-toggle')}
                  aria-expanded={worldExpanded}
                  onClick={() => {
                    setWorldExpanded((open) => !open);
                  }}
                >
                  <span className={cx(scrubberStyles, 'time-macro-toggle-main')}>
                    <span className={cx(scrubberStyles, 'time-macro-toggle-tag')}>World</span>
                    <strong className={cx(scrubberStyles, 'time-macro-toggle-title')}>
                      {primaryMacroEvent.title}
                    </strong>
                    {extraMacroCount > 0 && (
                      <span className={cx(scrubberStyles, 'time-macro-toggle-more')}>+{extraMacroCount}</span>
                    )}
                  </span>
                  <span className={cx(scrubberStyles, 'time-macro-toggle-action')}>
                    <span>{worldExpanded ? 'Hide' : 'Read'}</span>
                    <ChevronIcon direction={worldExpanded ? 'up' : 'down'} />
                  </span>
                </button>
                <div className={cx(timeStyles, 'time-macro-items')}>
                  {snapshot.macroEvents.map((ev) => (
                    <div key={ev.id} className={cx(timeStyles, 'time-macro-item')}>
                      <span className={cx(timeStyles, 'time-macro-year')}>{ev.display_date}</span>
                      <strong>{ev.title}</strong>
                      {ev.summary && (
                        <span className={cx(timeStyles, 'time-macro-summary')}> — {ev.summary}</span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {snapshot.lanes.length === 0 ? (
              <section className={cx(timeStyles, 'time-empty-state')}>
                <p>
                  {KINLOOM_VOCABULARY.time.emptyStatePrefix} <strong>{activeYear}</strong>.
                  {fallbackAnchorA !== undefined && (
                    <>
                      {' '}
                      Try a milestone year (such as{' '}
                      <button
                        type="button"
                        className={cx(atomStyles, 'ink-inline-btn')}
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
                            className={cx(atomStyles, 'ink-inline-btn')}
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
              <section
                className={cx(timeStyles, 'time-lanes')}
                aria-label={`Town and homestead lanes in ${activeYear}`}
              >
                {snapshot.lanes.map((lane) => (
                  <article key={lane.place.id} className={cx(timeStyles, 'time-lane')}>
                    <div className={cx(timeStyles, 'time-lane-header')}>
                      <div>
                        <h2 className={cx(timeStyles, 'time-lane-place')}>
                          <Link to={`/place/${lane.place.slug}`}>{lane.place.name}</Link>
                        </h2>
                        <div className={cx(timeStyles, 'time-lane-sub')}>{lane.place.full_name}</div>
                      </div>
                      <div className={cx(timeStyles, 'time-lane-meta')}>
                        <span>
                          {lane.people.length} {lane.people.length === 1 ? 'relative' : 'relatives'}
                        </span>
                      </div>
                    </div>

                    <div className={cx(timeStyles, 'time-lane-body')}>
                      <div className={cx(timeStyles, 'time-people-row')}>
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
                          className={cx(timeStyles, 'time-lane-local')}
                          aria-label={`Local dispatches near ${lane.place.name}`}
                        >
                          <div className={cx(timeStyles, 'time-local-heading')}>Local weather and news</div>
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
              <section
                className={cx(timeStyles, 'time-unlocated-section')}
                aria-label={KINLOOM_VOCABULARY.time.unlocatedAria}
              >
                <h2 className={cx(controlStyles, 'section-heading')}>
                  {KINLOOM_VOCABULARY.time.unlocatedHeadingPrefix} {activeYear} ·{' '}
                  {KINLOOM_VOCABULARY.time.unlocatedHeadingSuffix} ({snapshot.unlocatedPeople.length})
                </h2>
                <div className={cx(timeStyles, 'time-unlocated-list')}>
                  {snapshot.unlocatedPeople.map((entry) => (
                    <Link
                      key={entry.person.id}
                      to={
                        entry.nearestEventId
                          ? `/person/${entry.person.slug}?event=${entry.nearestEventId}`
                          : `/person/${entry.person.slug}`
                      }
                      className={cx(timeStyles, 'time-unlocated-row')}
                    >
                      <span className={cx(timeStyles, 'time-unlocated-name')}>{entry.person.full_name}</span>
                      <span className={cx(timeStyles, 'time-unlocated-years')}>
                        {entry.age === null ? '' : `age ${entry.age} · `}
                        {entry.person.birth_year || '?'}–{entry.person.death_year || '?'}
                      </span>
                      <span className={cx(timeStyles, 'time-unlocated-note')}>{entry.activityNote}</span>
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
