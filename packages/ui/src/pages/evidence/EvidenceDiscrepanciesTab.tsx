import type { ArchiveEvent, Person, SourceRecord } from '@kinloom/core';
import { formatPublicCitation } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { DateStamp, EmptyStateNotice } from '../../components/Atoms.js';
import atomStyles from '../../components/Atoms.module.css';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import evidenceStyles from '../EvidencePage.module.css';
import { collectEventDiscrepancyClaims, type DiscrepancyClaim } from './evidenceViewModel.js';

export interface EvidenceDiscrepanciesTabProps {
  readonly conflictEvents: readonly ArchiveEvent[];
  readonly peopleById: ReadonlyMap<string, Person>;
  readonly sourcesById: ReadonlyMap<string, SourceRecord>;
  readonly readableSourceIds: ReadonlySet<string>;
  readonly discrepancyLimit?: number;
  readonly onLoadMoreDiscrepancies?: () => void;
  readonly onOpenSourceReader: (params: { sourceId: string; eventId?: string }) => void;
}

const DiscrepancyClaimLead: React.FC<{ readonly claim: DiscrepancyClaim }> = ({ claim }) => {
  if (claim.kind === 'date') {
    return <span className={cx(evidenceStyles, 'evidence-claim-date')}>{claim.value}</span>;
  }
  if (claim.kind === 'place') {
    return (
      <>
        <span className={cx(evidenceStyles, 'evidence-claim-label')}>Place:</span>{' '}
        <strong className={cx(evidenceStyles, 'evidence-claim-prose')}>{claim.value}</strong>
      </>
    );
  }
  return <strong className={cx(evidenceStyles, 'evidence-claim-prose')}>{claim.value}</strong>;
};

export const EvidenceDiscrepanciesTab: React.FC<EvidenceDiscrepanciesTabProps> = ({
  conflictEvents,
  peopleById,
  sourcesById,
  readableSourceIds,
  discrepancyLimit,
  onLoadMoreDiscrepancies,
  onOpenSourceReader,
}) => {
  const effectiveLimit = discrepancyLimit ?? conflictEvents.length;
  const visibleEvents = conflictEvents.slice(0, effectiveLimit);
  const remainingCount = Math.max(0, conflictEvents.length - visibleEvents.length);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {conflictEvents.length === 0 ? (
        <EmptyStateNotice
          eyebrow="Conflict Preservation"
          title="No source discrepancies are recorded."
          body="When primary sources disagree on a date, place, or spelling, Kinloom preserves both claims side by side here."
        />
      ) : (
        <>
          {visibleEvents.map((ev) => {
            const primaryPerson = ev.participants
              .map((pt) => peopleById.get(pt.person_id))
              .find((p) => p && p.full_name !== 'Living');
            const readableRef = ev.sources.find((s) => readableSourceIds.has(s.source_id));
            const claims = collectEventDiscrepancyClaims(ev);
            const totalDiscrepancies = claims.length;

            return (
              <article key={ev.id} className={cx(layoutStyles, 'place-map-box')} style={{ marginBottom: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 8,
                    alignItems: 'center',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <DateStamp displayDate={ev.display_date} edtf={ev.edtf_date} />
                    <span className={cx(atomStyles, 'conflict-pill')}>
                      ! {totalDiscrepancies} Preserved Discrepanc{totalDiscrepancies === 1 ? 'y' : 'ies'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {readableRef && (
                      <button
                        type="button"
                        className={cx(controlStyles, 'source-read-btn')}
                        onClick={() => {
                          onOpenSourceReader({ sourceId: readableRef.source_id, eventId: ev.id });
                        }}
                      >
                        {KINLOOM_VOCABULARY.sources.readSourceCta}
                      </button>
                    )}
                    {primaryPerson && (
                      <Link
                        to={`/person/${primaryPerson.slug}?event=${ev.id}`}
                        className={cx(controlStyles, 'pill-btn')}
                        style={{ textDecoration: 'none' }}
                      >
                        {KINLOOM_VOCABULARY.evidence.openProfileCta}
                      </Link>
                    )}
                  </div>
                </div>
                <h2
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: '1.22rem',
                    margin: '10px 0 6px',
                    color: 'var(--surface-header)',
                  }}
                >
                  {ev.title}
                </h2>
                <p style={{ margin: '0 0 10px', fontSize: '0.92rem' }}>{ev.summary}</p>
                <div className={cx(atomStyles, 'source-details')}>
                  <strong>Conflicting Claims Preserved Side-by-Side:</strong>
                  <ul>
                    {claims.map((claim) => {
                      const src = sourcesById.get(claim.sourceId);
                      const publicCitation = src ? formatPublicCitation(src.citation) : '';
                      return (
                        <li key={claim.key} style={{ marginBottom: 4 }}>
                          <DiscrepancyClaimLead claim={claim} /> — {claim.note}
                          {publicCitation && (
                            <span style={{ color: 'var(--text-secondary)' }}> · {publicCitation}</span>
                          )}
                          {readableSourceIds.has(claim.sourceId) && (
                            <button
                              type="button"
                              className={cx(controlStyles, 'source-read-inline')}
                              onClick={() => {
                                onOpenSourceReader({ sourceId: claim.sourceId, eventId: ev.id });
                              }}
                            >
                              Read Page ↗
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </article>
            );
          })}

          {remainingCount > 0 && onLoadMoreDiscrepancies && (
            <div className={cx(evidenceStyles, 'evidence-pagination-bar')}>
              <span className={cx(evidenceStyles, 'evidence-pagination-count')}>
                Showing {visibleEvents.length} of {conflictEvents.length}
              </span>
              <button
                type="button"
                className={cx(controlStyles, 'pill-btn')}
                onClick={onLoadMoreDiscrepancies}
              >
                Show more ({remainingCount} remaining)
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
