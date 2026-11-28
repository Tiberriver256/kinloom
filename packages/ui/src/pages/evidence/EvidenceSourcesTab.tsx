import type { ArchiveEvent, Person, SourceRecord } from '@kinloom/core';
import { buildLibrarianCitation, formatSourceTypeLabel } from '@kinloom/core';
import type React from 'react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { EmptyStateNotice } from '../../components/Atoms.js';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import citationStyles from '../../styles/Citations.module.css';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import evidenceStyles from '../EvidencePage.module.css';
import { filterUnverifiedEvents } from './evidenceViewModel.js';

export interface EvidenceSourcesTabProps {
  readonly totalSourceCount: number;
  readonly canEdit?: boolean;
  readonly filteredSources: readonly SourceRecord[];
  readonly sourceLimit?: number;
  readonly sourceQuery: string;
  readonly sourceUsageCounts: ReadonlyMap<string, number>;
  readonly readableSourceIds: ReadonlySet<string>;
  readonly unverifiedEvents: readonly ArchiveEvent[];
  readonly showAllUnverified: boolean;
  readonly uncitedOnly?: boolean;
  readonly uncitedQuery?: string;
  readonly uncitedHeadingRef?: React.RefObject<HTMLHeadingElement | null>;
  readonly peopleById: ReadonlyMap<string, Person>;
  readonly onSourceQueryChange: (value: string) => void;
  readonly onLoadMoreSources?: () => void;
  readonly onUncitedQueryChange?: (value: string) => void;
  readonly onClearUncitedFilter?: () => void;
  readonly onToggleShowAllUnverified: () => void;
  readonly onOpenSourceInspector: (params: { sourceId: string }) => void;
  readonly onOpenSourceReader: (params: { sourceId: string }) => void;
}

export const EvidenceSourcesTab: React.FC<EvidenceSourcesTabProps> = ({
  totalSourceCount,
  canEdit = false,
  filteredSources,
  sourceLimit,
  sourceQuery,
  sourceUsageCounts,
  readableSourceIds,
  unverifiedEvents,
  showAllUnverified,
  uncitedOnly = false,
  uncitedQuery = '',
  uncitedHeadingRef,
  peopleById,
  onSourceQueryChange,
  onLoadMoreSources,
  onUncitedQueryChange,
  onClearUncitedFilter,
  onToggleShowAllUnverified,
  onOpenSourceInspector,
  onOpenSourceReader,
}) => {
  const effectiveSourceLimit = sourceLimit ?? filteredSources.length;
  const visibleSources = filteredSources.slice(0, effectiveSourceLimit);
  const remainingSources = Math.max(0, filteredSources.length - visibleSources.length);
  const matchedUnverified = useMemo(
    () =>
      uncitedOnly ? filterUnverifiedEvents(unverifiedEvents, uncitedQuery, peopleById) : unverifiedEvents,
    [uncitedOnly, unverifiedEvents, uncitedQuery, peopleById]
  );
  const visibleUnverified = showAllUnverified ? matchedUnverified : matchedUnverified.slice(0, 25);

  const unverifiedSection = (
    <section className={cx(layoutStyles, 'place-map-box')} style={{ marginBottom: 0 }}>
      {uncitedOnly && (
        <div className={cx(evidenceStyles, 'evidence-uncited-banner')} role="status">
          <span>
            Filtered to <strong>{unverifiedEvents.length}</strong>{' '}
            {unverifiedEvents.length === 1 ? 'entry' : 'entries'} needing primary citation
          </span>
          {onClearUncitedFilter && (
            <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onClearUncitedFilter}>
              Show full Source Registry
            </button>
          )}
        </div>
      )}
      {unverifiedEvents.length === 0 ? (
        <EmptyStateNotice
          title="All events have primary citations."
          body={
            totalSourceCount === 0
              ? 'Add dated milestones and catalog primary sources to track citation coverage here.'
              : 'Every documented event currently links to at least one primary archival source.'
          }
        />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
              marginBottom: 8,
            }}
          >
            <h2
              id="evidence-uncited-heading"
              ref={uncitedHeadingRef}
              tabIndex={-1}
              style={{
                fontFamily: 'var(--font-serif)',
                margin: 0,
                color: 'var(--surface-header)',
              }}
            >
              {KINLOOM_VOCABULARY.evidence.unverifiedHeading} ({matchedUnverified.length})
            </h2>
            {uncitedOnly && onUncitedQueryChange && (
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
          </div>
          <p style={{ margin: '0 0 12px', fontSize: '0.9375rem', color: 'var(--text-secondary)' }}>
            Because a GEDCOM export is a container rather than a primary source, events imported without an
            underlying census, vital, or archival citation are tracked here for primary verification.
          </p>
          {matchedUnverified.length === 0 ? (
            <EmptyStateNotice
              title="No uncited entries match that filter."
              action={
                uncitedQuery.trim() && onUncitedQueryChange ? (
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {visibleUnverified.map((ev) => {
                  const p = ev.participants
                    .map((pt) => peopleById.get(pt.person_id))
                    .find((x) => x && x.full_name !== 'Living');
                  return (
                    <div
                      key={ev.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 8,
                        padding: '7px 10px',
                        background: 'var(--surface-canvas)',
                        border: '1px solid var(--border-decorative)',
                        borderRadius: 2,
                      }}
                    >
                      <div>
                        <strong style={{ fontSize: '0.94rem' }}>{ev.title}</strong>{' '}
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.8125rem',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          ({ev.display_date || 'Date unrecorded'})
                        </span>
                      </div>
                      {p && (
                        <Link
                          to={`/person/${p.slug}?event=${ev.id}`}
                          className={cx(controlStyles, 'pill-btn')}
                          style={{ textDecoration: 'none', fontSize: '0.8125rem' }}
                        >
                          Verify on {p.full_name} →
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
              {matchedUnverified.length > 25 && (
                <div style={{ marginTop: 12 }}>
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {uncitedOnly ? (
        unverifiedSection
      ) : (
        <>
          <section className={cx(layoutStyles, 'place-map-box')} style={{ marginBottom: 0 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 10,
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontFamily: 'var(--font-serif)', margin: 0, color: 'var(--surface-header)' }}>
                {KINLOOM_VOCABULARY.evidence.sourceRegistryHeading} ({filteredSources.length})
              </h2>
              <input
                type="search"
                className={cx(controlStyles, 'search-input')}
                placeholder="Filter sources or repositories (e.g. Census, NARA, Vital, County)…"
                value={sourceQuery}
                onChange={(e) => {
                  onSourceQueryChange(e.target.value);
                }}
                aria-label="Filter archival sources"
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filteredSources.length === 0 ? (
                <EmptyStateNotice
                  eyebrow={totalSourceCount === 0 ? 'Source Registry' : undefined}
                  title={
                    totalSourceCount === 0
                      ? 'No sources have been cataloged yet.'
                      : 'No sources match that filter.'
                  }
                  body={
                    totalSourceCount === 0
                      ? 'Catalog primary census, vital, and archival sources so every milestone links back to verifiable evidence.'
                      : `No cataloged sources matched "${sourceQuery.trim()}".`
                  }
                  action={
                    sourceQuery.trim() ? (
                      <button
                        type="button"
                        className={cx(controlStyles, 'pill-btn')}
                        onClick={() => {
                          onSourceQueryChange('');
                        }}
                      >
                        Clear filter
                      </button>
                    ) : totalSourceCount === 0 && canEdit ? (
                      <Link to="/" className={cx(controlStyles, 'pill-btn active')}>
                        Add a source on a record
                      </Link>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  {visibleSources.map((s) => {
                    const count = sourceUsageCounts.get(s.id) || 0;
                    const readable = readableSourceIds.has(s.id);
                    const cit = buildLibrarianCitation(s);
                    return (
                      <div key={s.id} className={cx(evidenceStyles, 'evidence-source-row')}>
                        <div>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                              marginBottom: 4,
                            }}
                          >
                            <span className={cx(citationStyles, `evidence-tier-badge tier-${cit.tier}`)}>
                              {cit.tierLabel}
                            </span>
                            {cit.author && (
                              <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                                {cit.author}
                              </span>
                            )}
                          </div>
                          <div
                            style={{ fontWeight: 600, fontSize: '0.94rem', color: 'var(--surface-header)' }}
                          >
                            {cit.title}
                          </div>
                          <div
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.78rem',
                              color: 'var(--text-secondary)',
                              marginTop: 2,
                            }}
                          >
                            Repository: {cit.repository || 'Archival Collection'} ·{' '}
                            {formatSourceTypeLabel(s.source_type)}
                          </div>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            flexShrink: 0,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.78rem',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {count} citation{count === 1 ? '' : 's'}
                          </span>
                          <button
                            type="button"
                            className={cx(citationStyles, 'source-action-btn primary')}
                            onClick={() => {
                              onOpenSourceInspector({ sourceId: s.id });
                            }}
                          >
                            Inspect Source →
                          </button>
                          {readable && (
                            <button
                              type="button"
                              className={cx(controlStyles, 'source-read-btn')}
                              onClick={() => {
                                onOpenSourceReader({ sourceId: s.id });
                              }}
                            >
                              {KINLOOM_VOCABULARY.sources.openReaderCta}
                            </button>
                          )}
                          {s.url && (
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={cx(controlStyles, 'source-read-btn')}
                              style={{ textDecoration: 'none' }}
                            >
                              Open Archive ↗
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {remainingSources > 0 && onLoadMoreSources && (
                    <div className={cx(evidenceStyles, 'evidence-pagination-bar')}>
                      <span className={cx(evidenceStyles, 'evidence-pagination-count')}>
                        Showing {visibleSources.length} of {filteredSources.length}
                      </span>
                      <button
                        type="button"
                        className={cx(controlStyles, 'pill-btn')}
                        onClick={onLoadMoreSources}
                      >
                        Show more ({remainingSources} remaining)
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          {unverifiedSection}
        </>
      )}
    </div>
  );
};
