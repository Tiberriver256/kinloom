import type { ArchiveEvent, Person } from '@kinloom/core';
import type React from 'react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { EmptyStateNotice } from '../../components/Atoms.js';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import evidenceStyles from '../EvidencePage.module.css';
import { filterUnverifiedEvents } from './evidenceViewModel.js';

export interface EvidenceNeedsCitationTabProps {
  readonly totalSourceCount: number;
  readonly unverifiedEvents: readonly ArchiveEvent[];
  readonly showAllUnverified: boolean;
  readonly uncitedQuery: string;
  readonly uncitedHeadingRef?: React.RefObject<HTMLHeadingElement | null>;
  readonly peopleById: ReadonlyMap<string, Person>;
  readonly onUncitedQueryChange: (value: string) => void;
  readonly onToggleShowAllUnverified: () => void;
  readonly onOpenSourceRegistry?: () => void;
}

export const EvidenceNeedsCitationTab: React.FC<EvidenceNeedsCitationTabProps> = ({
  totalSourceCount,
  unverifiedEvents,
  showAllUnverified,
  uncitedQuery,
  uncitedHeadingRef,
  peopleById,
  onUncitedQueryChange,
  onToggleShowAllUnverified,
  onOpenSourceRegistry,
}) => {
  const matchedUnverified = useMemo(
    () => filterUnverifiedEvents(unverifiedEvents, uncitedQuery, peopleById),
    [unverifiedEvents, uncitedQuery, peopleById]
  );
  const visibleUnverified = showAllUnverified ? matchedUnverified : matchedUnverified.slice(0, 25);

  return (
    <section className={cx(layoutStyles, 'place-map-box')} style={{ marginBottom: 0 }}>
      <div className={cx(evidenceStyles, 'evidence-section-header')}>
        <h2
          id="evidence-uncited-heading"
          ref={uncitedHeadingRef}
          tabIndex={-1}
          className={cx(evidenceStyles, 'evidence-section-title')}
        >
          {KINLOOM_VOCABULARY.evidence.unverifiedHeading} ({matchedUnverified.length})
        </h2>
        <div className={cx(evidenceStyles, 'evidence-section-controls')}>
          {unverifiedEvents.length > 0 && (
            <input
              type="search"
              className={cx(controlStyles, 'search-input')}
              placeholder="Filter uncited entries by person or event…"
              value={uncitedQuery}
              onChange={(e) => {
                onUncitedQueryChange(e.target.value);
              }}
              aria-label="Filter uncited entries by person or event"
            />
          )}
          {onOpenSourceRegistry && (
            <button
              type="button"
              className={cx(controlStyles, 'cta-btn-secondary')}
              onClick={onOpenSourceRegistry}
            >
              Show full Source Registry
            </button>
          )}
        </div>
      </div>

      {unverifiedEvents.length === 0 ? (
        <EmptyStateNotice
          eyebrow="Citation Audit"
          title="All events have primary citations."
          body={
            totalSourceCount === 0
              ? 'Add dated milestones and catalog primary sources to track citation coverage here.'
              : 'Every documented event currently links to at least one primary archival source.'
          }
          action={
            onOpenSourceRegistry && totalSourceCount > 0 ? (
              <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onOpenSourceRegistry}>
                Browse Source Registry ({totalSourceCount})
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <p className={cx(evidenceStyles, 'evidence-audit-lead')}>
            Because a GEDCOM export is a container rather than a primary source, events imported without an
            underlying census, vital, or archival citation are tracked here for primary verification.
          </p>
          {matchedUnverified.length === 0 ? (
            <EmptyStateNotice
              title="No uncited entries match that filter."
              action={
                uncitedQuery.trim() ? (
                  <button
                    type="button"
                    className={cx(controlStyles, 'pill-btn')}
                    onClick={() => {
                      onUncitedQueryChange('');
                    }}
                  >
                    Clear filter
                  </button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className={cx(evidenceStyles, 'evidence-uncited-list')}>
                {visibleUnverified.map((ev) => {
                  const p = ev.participants
                    .map((pt) => peopleById.get(pt.person_id))
                    .find((x) => x && x.full_name !== 'Living');
                  return (
                    <div key={ev.id} className={cx(evidenceStyles, 'evidence-uncited-row')}>
                      <div className={cx(evidenceStyles, 'evidence-uncited-info')}>
                        <strong className={cx(evidenceStyles, 'evidence-uncited-title')}>{ev.title}</strong>
                        <span className={cx(evidenceStyles, 'evidence-uncited-date')}>
                          ({ev.display_date || 'Date unrecorded'})
                        </span>
                      </div>
                      {p && (
                        <Link
                          to={`/person/${p.slug}?event=${ev.id}`}
                          className={cx(controlStyles, 'cta-btn-secondary')}
                        >
                          Verify on {p.full_name} →
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
              {matchedUnverified.length > 25 && (
                <div className={cx(evidenceStyles, 'evidence-pagination-bar')}>
                  <span className={cx(evidenceStyles, 'evidence-pagination-count')}>
                    Showing {visibleUnverified.length} of {matchedUnverified.length}
                  </span>
                  <button
                    type="button"
                    className={cx(controlStyles, 'pill-btn')}
                    onClick={onToggleShowAllUnverified}
                  >
                    {showAllUnverified
                      ? 'Show Fewer Entries Needing Citation'
                      : `Show All ${matchedUnverified.length} Entries Needing Citation`}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
};
