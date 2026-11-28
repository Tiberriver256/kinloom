import type { SourceRecord } from '@kinloom/core';
import { buildLibrarianCitation, formatSourceTypeLabel } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { EmptyStateNotice } from '../../components/Atoms.js';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import citationStyles from '../../styles/Citations.module.css';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import evidenceStyles from '../EvidencePage.module.css';

export interface EvidenceSourcesTabProps {
  readonly totalSourceCount: number;
  readonly canEdit?: boolean;
  readonly filteredSources: readonly SourceRecord[];
  readonly sourceLimit?: number;
  readonly sourceQuery: string;
  readonly sourceUsageCounts: ReadonlyMap<string, number>;
  readonly readableSourceIds: ReadonlySet<string>;
  readonly onSourceQueryChange: (value: string) => void;
  readonly onLoadMoreSources?: () => void;
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
  onSourceQueryChange,
  onLoadMoreSources,
  onOpenSourceInspector,
  onOpenSourceReader,
}) => {
  const effectiveSourceLimit = sourceLimit ?? filteredSources.length;
  const visibleSources = filteredSources.slice(0, effectiveSourceLimit);
  const remainingSources = Math.max(0, filteredSources.length - visibleSources.length);

  return (
    <section className={cx(layoutStyles, 'place-map-box')} style={{ marginBottom: 0 }}>
      <div className={cx(evidenceStyles, 'evidence-section-header')}>
        <h2 className={cx(evidenceStyles, 'evidence-section-title')}>
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
      <div className={cx(evidenceStyles, 'evidence-source-list')}>
        {filteredSources.length === 0 ? (
          <EmptyStateNotice
            eyebrow={totalSourceCount === 0 ? 'Source Registry' : undefined}
            title={
              totalSourceCount === 0 ? 'No sources have been cataloged yet.' : 'No sources match that filter.'
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
                    <div className={cx(evidenceStyles, 'evidence-source-meta')}>
                      <span className={cx(citationStyles, `evidence-tier-badge tier-${cit.tier}`)}>
                        {cit.tierLabel}
                      </span>
                      {cit.author && (
                        <span className={cx(evidenceStyles, 'evidence-source-author')}>{cit.author}</span>
                      )}
                    </div>
                    <div className={cx(evidenceStyles, 'evidence-source-title')}>{cit.title}</div>
                    <div className={cx(evidenceStyles, 'evidence-source-repo')}>
                      Repository: {cit.repository || 'Archival Collection'} ·{' '}
                      {formatSourceTypeLabel(s.source_type)}
                    </div>
                  </div>
                  <div className={cx(evidenceStyles, 'evidence-source-actions')}>
                    <span className={cx(evidenceStyles, 'evidence-source-count')}>
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
                <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onLoadMoreSources}>
                  Show more ({remainingSources} remaining)
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
