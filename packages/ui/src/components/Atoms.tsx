import type {
  AlternateDate,
  AlternatePlace,
  ConfidenceTier,
  EventSourceRef,
  FactConflict,
  Place,
  SourceRecord,
} from '@kinloom/core';
import {
  buildLibrarianCitation,
  formatPublicCitation,
  summarizeEventCitations,
} from '@kinloom/core';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { useDialogFocusTrap } from '../lib/useDialogFocusTrap.js';

export const EmptyStateNotice: React.FC<{
  title: string;
  body?: string;
  action?: React.ReactNode;
}> = ({ title, body, action }) => (
  <div className="empty-state-notice" role="status">
    <p className="empty-state-notice-title">{title}</p>
    {body && <p className="empty-state-notice-body">{body}</p>}
    {action && <div className="empty-state-notice-action">{action}</div>}
  </div>
);

const EMPTY_ALTERNATE_DATES: AlternateDate[] = [];
const EMPTY_ALTERNATE_PLACES: AlternatePlace[] = [];
const EMPTY_FACT_CONFLICTS: FactConflict[] = [];

export const DateStamp: React.FC<{ displayDate: string; edtf?: string }> = ({
  displayDate,
  edtf,
}) => (
  <span className="date-stamp" title={edtf ? `Recorded date: ${edtf}` : undefined}>
    {displayDate || 'Undated'}
  </span>
);

export const CoordinatePill: React.FC<{ place: Place | undefined }> = ({ place }) => {
  if (!place) {
    return null;
  }
  const latStr = `${Math.abs(place.lat).toFixed(2)}°${place.lat >= 0 ? 'N' : 'S'}`;
  const lngStr = `${Math.abs(place.lng).toFixed(2)}°${place.lng >= 0 ? 'E' : 'W'}`;
  return (
    <Link to={`/place/${place.slug}`} className="coordinate-pill" title={`Open ${place.full_name} profile`}>
      <span>
        {latStr}, {lngStr} · {place.name}
      </span>
    </Link>
  );
};

export const ScopeGlyph: React.FC<{ category?: string; size?: number }> = ({
  category = 'life_milestone',
  size = 15,
}) => {
  if (category === 'weather') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <path d="M8 1v14M1 8h14M3 3l10 10M13 3L3 13" />
      </svg>
    );
  }
  if (category === 'newspaper') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <rect x="2" y="2" width="12" height="12" />
        <path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4.5" />
      </svg>
    );
  }
  if (category === 'macro') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2a9 9 0 0 1 0 12M8 2a9 9 0 0 0 0 12" />
      </svg>
    );
  }
  if (category === 'homestead') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <path d="M2 8l6-5 6 5v6H2V8z" />
        <path d="M6.5 14v-4h3v4" />
      </svg>
    );
  }
  if (category === 'family_milestone') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <circle cx="6" cy="8" r="3.5" />
        <circle cx="10" cy="8" r="3.5" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <circle cx="8" cy="8" r="4" />
      <path d="M8 1v3M8 12v3" />
    </svg>
  );
};

const HONORIFIC_PREFIXES = new Set([
  'capt',
  'col',
  'dr',
  'gen',
  'hon',
  'lt',
  'maj',
  'mr',
  'mrs',
  'ms',
  'prof',
  'rev',
  'sen',
  'senator',
  'sgt',
  'sir',
]);

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'vi', 'esq', 'md', 'phd']);

export function initialsOf(name: string): string {
  const withoutParens = name.replaceAll(/\([^)]*\)/g, ' ');
  const rawTokens = withoutParens
    .trim()
    .split(/\s+/)
    .map((token) => token.replaceAll(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g, ''))
    .filter(Boolean);

  if (rawTokens.length === 0) {
    return '?';
  }

  const tokens = [...rawTokens];
  while (tokens.length > 1 && HONORIFIC_PREFIXES.has(tokens[0].toLowerCase())) {
    tokens.shift();
  }
  while (tokens.length > 1 && NAME_SUFFIXES.has((tokens.at(-1) ?? '').toLowerCase())) {
    tokens.pop();
  }

  if (tokens.length === 1) {
    return tokens[0].slice(0, 2).toUpperCase();
  }
  return (tokens[0][0] + (tokens.at(-1) ?? '')[0]).toUpperCase();
}

export const RelativeAvatarChip: React.FC<{
  name: string;
  relationship: string;
  tier: ConfidenceTier;
  distanceMiles: number | null;
  onClick: () => void;
}> = ({ name, relationship, tier, distanceMiles, onClick }) => {
  let tierClass = 'tier-possible';
  if (tier === 'Confirmed') {
    tierClass = 'tier-confirmed';
  } else if (tier === 'Inferred') {
    tierClass = 'tier-inferred';
  }
  let distLabel = '';
  if (distanceMiles === 0) {
    distLabel = ' · same place';
  } else if (distanceMiles !== null) {
    distLabel = ` · ${distanceMiles} mi`;
  }

  return (
    <button
      type="button"
      className={`avatar-chip ${tierClass}`}
      onClick={onClick}
      title={`${name} (${relationship}) — ${tier}${distLabel}. Open Person Profile.`}
    >
      <span className="avatar-circle">{initialsOf(name)}</span>
      <span>
        <strong>{name}</strong>{' '}
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
          {relationship} · {tier}
        </span>
      </span>
    </button>
  );
};

export function resolveAssetUrl(rel?: string | null, baseUrl?: string): string {
  if (!rel) {
    return '';
  }
  if (rel.startsWith('http://') || rel.startsWith('https://') || rel.startsWith('data:')) {
    return rel;
  }
  const base = baseUrl ?? ((typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/');
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${cleanBase}${rel.startsWith('/') ? rel : `/${rel}`}`;
}

export const ArchivalPhotoFrame: React.FC<{ caption: string; photoUrl?: string | null }> = ({
  caption,
  photoUrl,
}) => {
  const { baseUrl } = useArchiveData();
  const [open, setOpen] = useState(false);
  const closeBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const resolvedUrl = resolveAssetUrl(photoUrl, baseUrl);
  const dialogRef = useDialogFocusTrap({
    open,
    onClose: () => {
      setOpen(false);
    },
    initialFocusRef: closeBtnRef,
  });

  return (
    <>
      <button
        type="button"
        className={`wireframe-photo photo-placeholder-frame ${resolvedUrl ? 'has-real-photo' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {resolvedUrl ? (
          <>
            <img src={resolvedUrl} alt={caption} className="milestone-photo-img" loading="lazy" />
            <span className="wireframe-photo-caption">{caption}</span>
          </>
        ) : (
          <>
            <span className="wireframe-photo-label">Archival Photograph Needed · Click for Details</span>
            <span className="wireframe-photo-caption">{caption}</span>
          </>
        )}
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          open
          aria-modal="true"
          className="lightbox-backdrop photo-lightbox-overlay"
          aria-label="Archival photograph lightbox"
        >
          <button
            type="button"
            tabIndex={-1}
            className="lightbox-backdrop-close"
            aria-label="Close archival photograph lightbox"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className="lightbox-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <strong style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--surface-header)' }}>
                {resolvedUrl ? 'ARCHIVAL PHOTOGRAPH · ZOOM VIEW' : 'ARCHIVAL PHOTOGRAPH NEEDED'}
              </strong>
              <button
                ref={closeBtnRef}
                type="button"
                className="pill-btn"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Close [Esc]
              </button>
            </div>
            {resolvedUrl ? (
              <figure style={{ margin: 0 }}>
                <img
                  src={resolvedUrl}
                  alt={caption}
                  style={{ width: '100%', maxHeight: '72vh', objectFit: 'contain', borderRadius: 2, border: '1px solid var(--border-decorative)' }}
                />
                <figcaption style={{ marginTop: 8, fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  {caption}
                </figcaption>
              </figure>
            ) : (
              <div className="wireframe-photo" style={{ minHeight: 180, cursor: 'default' }}>
                <span className="wireframe-photo-label">No Photograph Archived Yet</span>
                <span className="wireframe-photo-caption">{caption}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 8 }}>
                  A family photograph for this moment has not been added yet.
                </span>
              </div>
            )}
          </div>
        </dialog>
      )}
    </>
  );
};

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
  const [activeScan, setActiveScan] = useState<{ url: string; title: string; citation?: string } | null>(null);
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
    <div className="source-tag">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className={`source-toggle ${summary.onlyUnverified ? 'is-uncited' : ''}`}
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
            <span className="conflict-pill">
              ! {alternateDates.length} Date Discrepanc{alternateDates.length > 1 ? 'ies' : 'y'}
            </span>
          )}
          {alternatePlaces.length > 0 && (
            <span className="conflict-pill">
              ! {alternatePlaces.length} Place Discrepanc{alternatePlaces.length > 1 ? 'ies' : 'y'}
            </span>
          )}
          {factConflicts.length > 0 && (
            <span className="conflict-pill">
              ! {factConflicts.length} Fact Discrepanc{factConflicts.length > 1 ? 'ies' : 'y'}
            </span>
          )}
        </button>

        {firstReadable && (
          <button
            type="button"
            className="source-read-btn"
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
            className="source-read-btn"
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
        <div className="source-details">
          {sources.length > 0 && (
            <div className="citation-card-list">
              {sources.map((ref) => {
                const rec = sourcesById.get(ref.source_id);
                const cit = buildLibrarianCitation(rec, ref);
                const isReadable = readableSourceIds.has(ref.source_id);
                const itemKey = `${ref.source_id}|${ref.claimed_date ?? ''}|${ref.citation_detail ?? ''}|${ref.scan_url ?? ''}`;
                return (
                  <div key={itemKey} className="citation-item-card">
                    <div className="citation-item-top">
                      <span className={`evidence-tier-badge tier-${cit.tier}`}>
                        {cit.tierLabel}
                      </span>
                      {cit.tier !== 'unverified' && (
                        <span className="evidence-basis-tag">{cit.evidenceBasis}</span>
                      )}
                    </div>
                    <div className="citation-item-title">{cit.title}</div>
                    {(cit.author || cit.repository) && (
                      <div className="citation-item-meta">
                        {[cit.author, cit.repository].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {cit.recordDetail ? (
                      <div className="citation-page-detail">{cit.recordDetail}</div>
                    ) : (
                      cit.tier !== 'unverified' && (
                        <div className="citation-missing-detail">
                          Collection-level reference (no page or roll number recorded)
                        </div>
                      )
                    )}
                    <div className="citation-item-actions">
                      <button
                        type="button"
                        className="source-action-btn primary"
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
                        className="source-action-btn"
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
                          className="source-action-btn"
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
                          className="source-action-btn"
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
                          className="source-action-btn"
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
            <div className="citation-conflicts-box">
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
                          className="source-read-inline"
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
            <div className="citation-conflicts-box">
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
                          className="source-read-inline"
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
            <div className="citation-conflicts-box">
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
                          className="source-read-inline"
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
          className="lightbox-backdrop photo-lightbox-overlay"
          aria-label="Record scan lightbox"
        >
          <button
            type="button"
            tabIndex={-1}
            className="lightbox-backdrop-close"
            aria-label="Close record scan lightbox"
            onClick={() => {
              setActiveScan(null);
            }}
          />
          <div className="scan-lightbox-card">
            <div className="scan-lightbox-header">
              <strong style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                RECORD SCAN · {activeScan.title}
              </strong>
              <button
                ref={scanCloseRef}
                type="button"
                className="pill-btn"
                onClick={() => {
                  setActiveScan(null);
                }}
              >
                Close [Esc]
              </button>
            </div>
            <div className="scan-lightbox-scroll">
              <img src={activeScan.url} alt={activeScan.title} className="scan-page-img-full" />
              {activeScan.citation && (
                <p style={{ marginTop: 10, fontSize: '0.82rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
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
