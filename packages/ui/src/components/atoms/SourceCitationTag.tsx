import type {
  AlternateDate,
  AlternatePlace,
  EventSourceRef,
  FactConflict,
  SourceRecord,
} from '@kinloom/core';
import { buildLibrarianCitation, formatPublicCitation, summarizeEventCitations } from '@kinloom/core';
import React, { useEffect, useRef, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useArchiveUi } from '../../context/ArchiveUiContext.js';
import { useDialogFocusTrap } from '../../hooks/useDialogFocusTrap.js';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import citationStyles from '../../styles/Citations.module.css';
import controlStyles from '../../styles/Controls.module.css';
import overlayStyles from '../../styles/Overlays.module.css';
import atomStyles from '../Atoms.module.css';
import { ArchivalImage } from './ArchivalImage.js';
import { resolveAssetUrl } from './formatters.js';

const EMPTY_ALTERNATE_DATES: AlternateDate[] = [];
const EMPTY_ALTERNATE_PLACES: AlternatePlace[] = [];
const EMPTY_FACT_CONFLICTS: FactConflict[] = [];

export const SourceCitationTag: React.FC<{
  sources: EventSourceRef[];
  alternateDates?: AlternateDate[] | undefined;
  alternatePlaces?: AlternatePlace[] | undefined;
  factConflicts?: FactConflict[] | undefined;
  sourcesById: Map<string, SourceRecord>;
  eventId?: string | undefined;
}> = ({
  sources,
  alternateDates = EMPTY_ALTERNATE_DATES,
  alternatePlaces = EMPTY_ALTERNATE_PLACES,
  factConflicts = EMPTY_FACT_CONFLICTS,
  sourcesById,
  eventId,
}) => {
  const { readableSourceIds, baseUrl } = useArchiveData();
  const [expanded, setExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeScan, setActiveScan] = useState<{
    url: string;
    title: string;
    citation?: string | undefined;
  } | null>(null);
  const scanCloseRef = React.useRef<HTMLButtonElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const mountedRef = useRef<boolean>(true);
  const { openSourceReader, openSourceInspector } = useArchiveUi();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);
  const scanDialogRef = useDialogFocusTrap({
    open: Boolean(activeScan),
    onClose: () => {
      setActiveScan(null);
    },
    initialFocusRef: scanCloseRef,
  });

  if (
    sources.length === 0 &&
    alternateDates.length === 0 &&
    alternatePlaces.length === 0 &&
    factConflicts.length === 0
  ) {
    return null;
  }

  const firstReadable = sources.find((ref) => readableSourceIds.has(ref.source_id));
  const firstScan = sources.find((ref) => Boolean(ref.scan_url));
  const summary = summarizeEventCitations(sources, sourcesById);

  const handleCopyCitation = (key: string, formatted: string): void => {
    if (!navigator.clipboard) {
      return;
    }
    navigator.clipboard
      .writeText(formatted)
      .then(() => {
        if (!mountedRef.current) {
          return;
        }
        setCopiedKey(key);
        if (typeof window === 'undefined') {
          return;
        }
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = window.setTimeout(() => {
          copyTimerRef.current = null;
          if (mountedRef.current) {
            setCopiedKey((prev) => (prev === key ? null : prev));
          }
        }, 1800);
      })
      .catch(() => {
        if (mountedRef.current) {
          setCopiedKey(null);
        }
      });
  };

  return (
    <div className={cx(atomStyles, 'source-tag')}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className={cx(atomStyles, `source-toggle ${summary.onlyUnverified ? 'is-uncited' : ''}`)}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          <span>
            {expanded ? '▾' : '▸'} {summary.label}
          </span>
          {alternateDates.length > 0 && (
            <span className={cx(atomStyles, 'conflict-pill')}>
              ! {alternateDates.length} Date Discrepanc{alternateDates.length > 1 ? 'ies' : 'y'}
            </span>
          )}
          {alternatePlaces.length > 0 && (
            <span className={cx(atomStyles, 'conflict-pill')}>
              ! {alternatePlaces.length} Place Discrepanc{alternatePlaces.length > 1 ? 'ies' : 'y'}
            </span>
          )}
          {factConflicts.length > 0 && (
            <span className={cx(atomStyles, 'conflict-pill')}>
              ! {factConflicts.length} Fact Discrepanc{factConflicts.length > 1 ? 'ies' : 'y'}
            </span>
          )}
        </button>

        {firstReadable && (
          <button
            type="button"
            className={cx(controlStyles, 'source-read-btn')}
            onClick={(e) => {
              e.stopPropagation();
              openSourceReader({ sourceId: firstReadable.source_id, eventId });
            }}
          >
            {KINLOOM_VOCABULARY.sources.readSourceCta}
          </button>
        )}

        {firstScan?.scan_url && (
          <button
            type="button"
            className={cx(controlStyles, 'source-read-btn')}
            onClick={(e) => {
              e.stopPropagation();
              const rec = sourcesById.get(firstScan.source_id);
              setActiveScan({
                url: resolveAssetUrl(firstScan.scan_url, baseUrl),
                title: firstScan.scan_title || (rec ? formatPublicCitation(rec.citation) : 'Record Scan'),
                citation: firstScan.citation_detail || (rec ? formatPublicCitation(rec.citation) : undefined),
              });
            }}
          >
            {KINLOOM_VOCABULARY.sources.viewRecordScanCta}
          </button>
        )}
      </div>

      {expanded && (
        <div className={cx(atomStyles, 'source-details')}>
          {sources.length > 0 && (
            <div className={cx(citationStyles, 'citation-card-list')}>
              {sources.map((ref) => {
                const rec = sourcesById.get(ref.source_id);
                const cit = buildLibrarianCitation(rec, ref);
                const isReadable = readableSourceIds.has(ref.source_id);
                const itemKey = `${ref.source_id}|${ref.claimed_date ?? ''}|${ref.citation_detail ?? ''}|${ref.scan_url ?? ''}`;
                return (
                  <div key={itemKey} className={cx(citationStyles, 'citation-item-card')}>
                    <div className={cx(citationStyles, 'citation-item-top')}>
                      <span className={cx(citationStyles, `evidence-tier-badge tier-${cit.tier}`)}>
                        {cit.tierLabel}
                      </span>
                      {cit.tier !== 'unverified' && (
                        <span className={cx(citationStyles, 'evidence-basis-tag')}>{cit.evidenceBasis}</span>
                      )}
                    </div>
                    <div className={cx(citationStyles, 'citation-item-title')}>{cit.title}</div>
                    {(cit.author || cit.repository) && (
                      <div className={cx(citationStyles, 'citation-item-meta')}>
                        {[cit.author, cit.repository].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {cit.recordDetail ? (
                      <div className={cx(citationStyles, 'citation-page-detail')}>{cit.recordDetail}</div>
                    ) : (
                      cit.tier !== 'unverified' && (
                        <div className={cx(citationStyles, 'citation-missing-detail')}>
                          Collection-level reference (no page or roll number recorded)
                        </div>
                      )
                    )}
                    <div className={cx(citationStyles, 'citation-item-actions')}>
                      <button
                        type="button"
                        className={cx(citationStyles, 'source-action-btn primary')}
                        onClick={(e) => {
                          e.stopPropagation();
                          openSourceInspector({
                            sourceId: ref.source_id,
                            eventId,
                            citationDetail: ref.citation_detail ?? undefined,
                            claimedDate: ref.claimed_date ?? undefined,
                            scanUrl: ref.scan_url ?? undefined,
                            scanTitle: ref.scan_title ?? undefined,
                            confidence: ref.confidence,
                          });
                        }}
                      >
                        Inspect Source →
                      </button>
                      <button
                        type="button"
                        className={cx(citationStyles, 'source-action-btn')}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopyCitation(itemKey, cit.bibliographicString);
                        }}
                      >
                        {copiedKey === itemKey ? 'Copied' : 'Copy'}
                      </button>
                      {isReadable && (
                        <button
                          type="button"
                          className={cx(citationStyles, 'source-action-btn')}
                          onClick={(e) => {
                            e.stopPropagation();
                            openSourceReader({ sourceId: ref.source_id, eventId });
                          }}
                        >
                          Read Text ↗
                        </button>
                      )}
                      {ref.scan_url && (
                        <button
                          type="button"
                          className={cx(citationStyles, 'source-action-btn')}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveScan({
                              url: resolveAssetUrl(ref.scan_url, baseUrl),
                              title: ref.scan_title || cit.title || 'Record Scan',
                              citation: ref.citation_detail || cit.bibliographicString,
                            });
                          }}
                        >
                          Scan ↗
                        </button>
                      )}
                      {cit.url && (
                        <a
                          href={cit.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cx(citationStyles, 'source-action-btn')}
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          {cit.urlHost || 'Archive'} ↗
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {alternateDates.length > 0 && (
            <div className={cx(citationStyles, 'citation-conflicts-box')}>
              <strong>Preserved Date Discrepancies</strong>
              <ul>
                {alternateDates.map((alt) => {
                  const rec = sourcesById.get(alt.source_id);
                  return (
                    <li key={`${alt.edtf_date}|${alt.source_id}|${alt.note}`}>
                      <code>{alt.edtf_date || 'alt'}</code> — {alt.note}{' '}
                      {rec && (
                        <button
                          type="button"
                          className={cx(controlStyles, 'source-read-inline')}
                          onClick={(e) => {
                            e.stopPropagation();
                            openSourceInspector({
                              sourceId: alt.source_id,
                              eventId,
                              citationDetail: alt.note,
                              claimedDate: alt.edtf_date,
                            });
                          }}
                        >
                          {formatPublicCitation(rec.citation)}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {alternatePlaces.length > 0 && (
            <div className={cx(citationStyles, 'citation-conflicts-box')}>
              <strong>Preserved Place Discrepancies</strong>
              <ul>
                {alternatePlaces.map((alt) => {
                  const rec = sourcesById.get(alt.source_id);
                  return (
                    <li key={`${alt.place_name}|${alt.source_id}|${alt.note}`}>
                      <code>{alt.place_name}</code> — {alt.note}{' '}
                      {rec && (
                        <button
                          type="button"
                          className={cx(controlStyles, 'source-read-inline')}
                          onClick={(e) => {
                            e.stopPropagation();
                            openSourceInspector({
                              sourceId: alt.source_id,
                              eventId,
                              citationDetail: alt.note,
                            });
                          }}
                        >
                          {formatPublicCitation(rec.citation)}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {factConflicts.length > 0 && (
            <div className={cx(citationStyles, 'citation-conflicts-box')}>
              <strong>Preserved Fact Discrepancies</strong>
              <ul>
                {factConflicts.map((alt) => {
                  const rec = sourcesById.get(alt.source_id);
                  return (
                    <li key={`${alt.claim}|${alt.source_id}|${alt.note}`}>
                      <code>{alt.claim}</code> — {alt.note}{' '}
                      {rec && (
                        <button
                          type="button"
                          className={cx(controlStyles, 'source-read-inline')}
                          onClick={(e) => {
                            e.stopPropagation();
                            openSourceInspector({
                              sourceId: alt.source_id,
                              eventId,
                              citationDetail: alt.note,
                            });
                          }}
                        >
                          {formatPublicCitation(rec.citation)}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {activeScan && (
        <dialog
          ref={scanDialogRef}
          open
          aria-modal="true"
          className={cx(overlayStyles, 'lightbox-backdrop photo-lightbox-overlay')}
          aria-label="Record scan lightbox"
        >
          <button
            type="button"
            tabIndex={-1}
            className={cx(overlayStyles, 'lightbox-backdrop-close')}
            aria-label="Close record scan lightbox"
            onClick={() => {
              setActiveScan(null);
            }}
          />
          <div className={cx(overlayStyles, 'scan-lightbox-card')}>
            <div className={cx(overlayStyles, 'scan-lightbox-header')}>
              <strong style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                RECORD SCAN · {activeScan.title}
              </strong>
              <button
                ref={scanCloseRef}
                type="button"
                className={cx(controlStyles, 'pill-btn')}
                onClick={() => {
                  setActiveScan(null);
                }}
              >
                Close [Esc]
              </button>
            </div>
            <div className={cx(overlayStyles, 'scan-lightbox-scroll')}>
              <ArchivalImage
                src={activeScan.url}
                alt={activeScan.title}
                loading="eager"
                frameStyle={{ width: '100%' }}
                className={cx(overlayStyles, 'scan-page-img-full')}
                fallbackCaption={activeScan.title}
              />
              {activeScan.citation && (
                <p
                  style={{
                    marginTop: 10,
                    fontSize: '0.82rem',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {activeScan.citation}
                </p>
              )}
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
};
