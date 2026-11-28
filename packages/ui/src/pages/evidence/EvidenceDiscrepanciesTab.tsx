import type { ArchiveEvent, Person, SourceRecord } from '@kinloom/core';
import { formatPublicCitation } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { DateStamp, EmptyStateNotice } from '../../components/Atoms.js';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
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
  const singleCard = visibleEvents.length === 1;

  return (
    <section aria-label={KINLOOM_VOCABULARY.evidence.discrepanciesTab}>
      {conflictEvents.length === 0 ? (
        <EmptyStateNotice
          eyebrow="Conflict Preservation"
          title="No source discrepancies are recorded."
          body="When primary sources disagree on a date, place, or spelling, Kinloom preserves both claims side by side here."
        />
      ) : (
        <>
          <div
            className={cx(
              evidenceStyles,
              singleCard ? 'evidence-discrepancy-grid is-single' : 'evidence-discrepancy-grid'
            )}
          >
            {visibleEvents.map((ev) => {
              const primaryPerson = ev.participants
                .map((pt) => peopleById.get(pt.person_id))
                .find((p) => p && p.full_name !== 'Living');
              const readableRef = ev.sources.find((s) => readableSourceIds.has(s.source_id));
              const claims = collectEventDiscrepancyClaims(ev);
              const totalDiscrepancies = claims.length;

              return (
                <article
                  key={ev.id}
                  className={cx(
                    evidenceStyles,
                    singleCard ? 'evidence-discrepancy-card is-single' : 'evidence-discrepancy-card'
                  )}
                >
                  <div className={cx(evidenceStyles, 'evidence-discrepancy-lead')}>
                    <h2 className={cx(evidenceStyles, 'evidence-discrepancy-title')}>{ev.title}</h2>
                    <div className={cx(evidenceStyles, 'evidence-discrepancy-meta')}>
                      <DateStamp displayDate={ev.display_date} edtf={ev.edtf_date} />
                      <span className={cx(evidenceStyles, 'evidence-discrepancy-badge')}>
                        {totalDiscrepancies} Preserved Discrepanc{totalDiscrepancies === 1 ? 'y' : 'ies'}
                      </span>
                    </div>
                    <p className={cx(evidenceStyles, 'evidence-discrepancy-summary')}>{ev.summary}</p>
                  </div>

                  <div className={cx(evidenceStyles, 'evidence-discrepancy-claims')}>
                    <span className={cx(evidenceStyles, 'evidence-discrepancy-claims-heading')}>
                      Conflicting Claims Preserved Side-by-Side
                    </span>
                    <ul className={cx(evidenceStyles, 'evidence-discrepancy-claims-list')}>
                      {claims.map((claim) => {
                        const src = sourcesById.get(claim.sourceId);
                        const publicCitation = src ? formatPublicCitation(src.citation) : '';
                        return (
                          <li
                            key={claim.key}
                            className={cx(evidenceStyles, 'evidence-discrepancy-claim-item')}
                          >
                            <DiscrepancyClaimLead claim={claim} /> — {claim.note}
                            {publicCitation && (
                              <span className={cx(evidenceStyles, 'evidence-claim-citation')}>
                                {' '}
                                · {publicCitation}
                              </span>
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

                  {(readableRef || primaryPerson) && (
                    <div className={cx(evidenceStyles, 'evidence-discrepancy-actions')}>
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
                          className={cx(controlStyles, 'cta-btn-secondary')}
                        >
                          {KINLOOM_VOCABULARY.evidence.openProfileCta}
                        </Link>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>

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
