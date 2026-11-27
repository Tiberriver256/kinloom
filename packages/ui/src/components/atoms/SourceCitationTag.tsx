import type {
  AlternateDate,
  AlternatePlace,
  EventSourceRef,
  FactConflict,
  SourceRecord,
} from '@kinloom/core';
import { buildLibrarianCitation, formatPublicCitation, summarizeEventCitations } from '@kinloom/core';
import React, { useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useArchiveUi } from '../../context/ArchiveUiContext.js';
import { cx } from '../../lib/cx.js';
import { useDialogFocusTrap } from '../../lib/useDialogFocusTrap.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import cssMod3 from '../../pages/IndexPage.module.css';
import cssMod0 from '../Atoms.module.css';
import cssMod1 from '../SourceInspectorDrawer.module.css';
import cssMod2 from '../SourceReaderDrawer.module.css';
import { resolveAssetUrl } from './formatters.js';

const uiStyles: Readonly<Record<string, string>> = {
  ...cssMod0,
  ...cssMod1,
  ...cssMod2,
  ...cssMod3,
};

const EMPTY_ALTERNATE_DATES: AlternateDate[] = [];
const EMPTY_ALTERNATE_PLACES: AlternatePlace[] = [];
const EMPTY_FACT_CONFLICTS: FactConflict[] = [];

export const SourceCitationTag: React.FC<{
  sources: EventSourceRef[];
  alternateDates?: AlternateDate[];
  alternatePlaces?: AlternatePlace[];
  factConflicts?: FactConflict[];
  sourcesById: Map<string, SourceRecord>;
  eventId?: string;
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
  const [activeScan, setActiveScan] = useState<{ url: string; title: string; citation?: string } | null>(
    null
  );
  const scanCloseRef = React.useRef<HTMLButtonElement | null>(null);
  const { openSourceReader, openSourceInspector } = useArchiveUi();
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
        setCopiedKey(key);
        window.setTimeout(() => {
          setCopiedKey((prev) => (prev === key ? null : prev));
        }, 1800);
      })
      .catch(() => {
        setCopiedKey(null);
      });
  };

  return (
    <div className={cx(uiStyles, 'source-tag')}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className={cx(uiStyles, `source-toggle ${summary.onlyUnverified ? 'is-uncited' : ''}`)}
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
            <span className={cx(uiStyles, 'conflict-pill')}>
              ! {alternateDates.length} Date Discrepanc{alternateDates.length > 1 ? 'ies' : 'y'}
            </span>
          )}
          {alternatePlaces.length > 0 && (
            <span className={cx(uiStyles, 'conflict-pill')}>
              ! {alternatePlaces.length} Place Discrepanc{alternatePlaces.length > 1 ? 'ies' : 'y'}
            </span>
          )}
          {factConflicts.length > 0 && (
            <span className={cx(uiStyles, 'conflict-pill')}>
              ! {factConflicts.length} Fact Discrepanc{factConflicts.length > 1 ? 'ies' : 'y'}
            </span>
          )}
        </button>

        {firstReadable && (
          <button
            type="button"
            className={cx(uiStyles, 'source-read-btn')}
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
            className={cx(uiStyles, 'source-read-btn')}
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
        <div className={cx(uiStyles, 'source-details')}>
          {sources.length > 0 && (
            <div className={cx(uiStyles, 'citation-card-list')}>
              {sources.map((ref) => {
                const rec = sourcesById.get(ref.source_id);
                const cit = buildLibrarianCitation(rec, ref);
                const isReadable = readableSourceIds.has(ref.source_id);
                const itemKey = `${ref.source_id}|${ref.claimed_date ?? ''}|${ref.citation_detail ?? ''}|${ref.scan_url ?? ''}`;
                return (
                  <div key={itemKey} className={cx(uiStyles, 'citation-item-card')}>
                    <div className={cx(uiStyles, 'citation-item-top')}>
                      <span className={cx(uiStyles, `evidence-tier-badge tier-${cit.tier}`)}>
                        {cit.tierLabel}
                      </span>
                      {cit.tier !== 'unverified' && (
                        <span className={cx(uiStyles, 'evidence-basis-tag')}>{cit.evidenceBasis}</span>
                      )}
                    </div>
                    <div className={cx(uiStyles, 'citation-item-title')}>{cit.title}</div>
                    {(cit.author || cit.repository) && (
                      <div className={cx(uiStyles, 'citation-item-meta')}>
                        {[cit.author, cit.repository].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {cit.recordDetail ? (
                      <div className={cx(uiStyles, 'citation-page-detail')}>{cit.recordDetail}</div>
                    ) : (
                      cit.tier !== 'unverified' && (
                        <div className={cx(uiStyles, 'citation-missing-detail')}>
                          Collection-level reference (no page or roll number recorded)
                        </div>
                      )
                    )}
                    <div className={cx(uiStyles, 'citation-item-actions')}>
                      <button
                        type="button"
                        className={cx(uiStyles, 'source-action-btn primary')}
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
                        className={cx(uiStyles, 'source-action-btn')}
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
                          className={cx(uiStyles, 'source-action-btn')}
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
                          className={cx(uiStyles, 'source-action-btn')}
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
                          className={cx(uiStyles, 'source-action-btn')}
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
            <div className={cx(uiStyles, 'citation-conflicts-box')}>
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
                          className={cx(uiStyles, 'source-read-inline')}
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
            <div className={cx(uiStyles, 'citation-conflicts-box')}>
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
                          className={cx(uiStyles, 'source-read-inline')}
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
            <div className={cx(uiStyles, 'citation-conflicts-box')}>
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
                          className={cx(uiStyles, 'source-read-inline')}
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
          className={cx(uiStyles, 'lightbox-backdrop photo-lightbox-overlay')}
          aria-label="Record scan lightbox"
        >
          <button
            type="button"
            tabIndex={-1}
            className={cx(uiStyles, 'lightbox-backdrop-close')}
            aria-label="Close record scan lightbox"
            onClick={() => {
              setActiveScan(null);
            }}
          />
          <div className={cx(uiStyles, 'scan-lightbox-card')}>
            <div className={cx(uiStyles, 'scan-lightbox-header')}>
              <strong style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                RECORD SCAN · {activeScan.title}
              </strong>
              <button
                ref={scanCloseRef}
                type="button"
                className={cx(uiStyles, 'pill-btn')}
                onClick={() => {
                  setActiveScan(null);
                }}
              >
                Close [Esc]
              </button>
            </div>
            <div className={cx(uiStyles, 'scan-lightbox-scroll')}>
              <img
                src={activeScan.url}
                alt={activeScan.title}
                className={cx(uiStyles, 'scan-page-img-full')}
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
