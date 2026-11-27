import type { ArchivalMediaKind, MediaChecklistItem, MediaItem } from '@kinloom/core';
import {
  buildLibrarianCitation,
  formatPublicCitation,
  formatSourceTypeLabel,
  UNVERIFIED_TREE_SOURCE_ID,
} from '@kinloom/core';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DateStamp, EmptyStateNotice } from '../components/Atoms.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { MediaPlayer } from '../components/MediaPlayer.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { handleTablistKeyDown } from '../lib/keyboardNav.js';
import { useDialogFocusTrap } from '../lib/useDialogFocusTrap.js';
import { KINLOOM_VOCABULARY, MEDIA_KIND_LABELS } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';

type EvidenceTab = 'conflicts' | 'citations' | 'media';
type MediaKindFilter = 'all' | ArchivalMediaKind;

export const EvidencePage: React.FC = () => {
  const { bundle, baseUrl, peopleById, sourcesById, readableSourceIds, loadMediaChecklist, loading } =
    useArchiveData();
  const { openSourceReader, openSourceInspector } = useArchiveUi();
  const [searchParams] = useSearchParams();
  const initialTabParam = searchParams.get('tab');
  const initialSourceParam = searchParams.get('source') || '';
  const initialTab: EvidenceTab =
    initialTabParam === 'citations' || initialTabParam === 'media' || initialTabParam === 'conflicts'
      ? initialTabParam
      : 'conflicts';
  const [tab, setTab] = useState<EvidenceTab>(initialTab);
  const [sourceQuery, setSourceQuery] = useState(initialSourceParam);
  const [showAllUnverified, setShowAllUnverified] = useState(false);
  const [mediaKindFilter, setMediaKindFilter] = useState<MediaKindFilter>('all');
  const [mediaQuery, setMediaQuery] = useState('');
  const [mediaLimit, setMediaLimit] = useState(36);
  const [lightboxItem, setLightboxItem] = useState<MediaItem | null>(null);
  const [mediaChecklist, setMediaChecklist] = useState<MediaChecklistItem[]>([]);
  const lightboxCloseRef = useRef<HTMLButtonElement | null>(null);
  const lightboxDialogRef = useDialogFocusTrap({
    open: Boolean(lightboxItem),
    onClose: () => {
      setLightboxItem(null);
    },
    initialFocusRef: lightboxCloseRef,
  });

  useEffect(() => {
    let cancelled = false;
    void loadMediaChecklist()
      .then((items) => {
        if (!cancelled) {
          setMediaChecklist(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMediaChecklist([]);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [loadMediaChecklist]);

  const conflictEvents = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return bundle.events.filter(
      (e) =>
        (e.alternate_dates?.length || 0) +
          (e.alternate_places?.length || 0) +
          (e.fact_conflicts?.length || 0) >
        0
    );
  }, [bundle]);

  const unverifiedEvents = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return bundle.events.filter(
      (e) =>
        (e.scope === 'personal' || e.scope === 'family') &&
        e.sources.length > 0 &&
        e.sources.every((s) => s.source_id === UNVERIFIED_TREE_SOURCE_ID)
    );
  }, [bundle]);

  const detailedCitationCount = useMemo(() => {
    if (!bundle) {
      return 0;
    }
    let total = 0;
    for (const ev of bundle.events) {
      for (const sr of ev.sources) {
        if (sr.citation_detail) {
          total += 1;
        }
      }
    }
    return total;
  }, [bundle]);

  const linkedRecordScanCount = useMemo(() => {
    if (!bundle) {
      return 0;
    }
    let total = 0;
    for (const ev of bundle.events) {
      for (const sr of ev.sources) {
        if (sr.scan_url) {
          total += 1;
        }
      }
    }
    return total;
  }, [bundle]);

  const sourceUsageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!bundle) {
      return counts;
    }
    for (const ev of bundle.events) {
      for (const sr of ev.sources) {
        counts.set(sr.source_id, (counts.get(sr.source_id) || 0) + 1);
      }
    }
    return counts;
  }, [bundle]);

  const filteredSources = useMemo(() => {
    if (!bundle) {
      return [];
    }
    const q = sourceQuery.trim().toLowerCase();
    return bundle.sources
      .filter((s) => {
        if (!q) {
          return true;
        }
        return (
          s.id.toLowerCase().includes(q) ||
          s.citation.toLowerCase().includes(q) ||
          (s.author || '').toLowerCase().includes(q) ||
          (s.repository || '').toLowerCase().includes(q) ||
          s.source_type.toLowerCase().includes(q)
        );
      })
      .toSorted((a, b) => (sourceUsageCounts.get(b.id) || 0) - (sourceUsageCounts.get(a.id) || 0));
  }, [bundle, sourceQuery, sourceUsageCounts]);

  const allMedia = useMemo(() => bundle?.media || [], [bundle]);

  const mediaCountsByKind = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of allMedia) {
      counts[m.kind] = (counts[m.kind] || 0) + 1;
    }
    return counts;
  }, [allMedia]);

  const filteredMedia = useMemo(() => {
    const q = mediaQuery.trim().toLowerCase();
    return allMedia.filter((m) => {
      if (mediaKindFilter !== 'all' && m.kind !== mediaKindFilter) {
        return false;
      }
      if (q) {
        const hay = `${m.caption} ${m.person_name || ''} ${m.provenance || ''} ${m.kind}`.toLowerCase();
        if (!hay.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [allMedia, mediaKindFilter, mediaQuery]);

  const displayedMedia = filteredMedia.slice(0, mediaLimit);

  const missingChecklistItems = useMemo(
    () => mediaChecklist.filter((i) => i.status !== 'digitized'),
    [mediaChecklist]
  );

  const navMedia = useMemo(() => filteredMedia.filter((m) => m.kind !== 'document_scan'), [filteredMedia]);

  useEffect(() => {
    if (!lightboxItem) {
      return undefined;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const idx = navMedia.findIndex((m) => m.id === lightboxItem.id);
        if (idx === -1 || navMedia.length <= 1) {
          return;
        }
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        setLightboxItem(navMedia[(idx + delta + navMedia.length) % navMedia.length]);
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [lightboxItem, navMedia]);

  if (loading || !bundle) {
    return (
      <div>
        <ExplorerTopBar />
        <main id="main-content" className="index-page">
          {KINLOOM_VOCABULARY.evidence.loading}
        </main>
      </div>
    );
  }

  const visibleUnverified = showAllUnverified ? unverifiedEvents : unverifiedEvents.slice(0, 25);

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className="place-page">
        <section className="wire-banner" style={{ marginBottom: 18 }}>
          <div>
            <h1>{KINLOOM_VOCABULARY.evidence.heading}</h1>
            <p>
              Provenance audit separating primary sources from uncited tree entries, preserving source
              discrepancies, and cataloging portraits, family photos, headstones, record scans, and document
              scans.
            </p>
          </div>
          <div className="folio-metrics">
            <div>
              <strong>{bundle.sources.length}</strong> cataloged sources
            </div>
            <div>
              <strong>{detailedCitationCount}</strong> page/roll citations ·{' '}
              <strong>{linkedRecordScanCount}</strong> linked record scans
            </div>
            <div style={{ color: 'var(--radar-copresence)' }}>
              <strong>{allMedia.length}</strong> photos &amp; documents ·{' '}
              <strong>{unverifiedEvents.length}</strong> {unverifiedEvents.length === 1 ? 'entry' : 'entries'}{' '}
              needing citation
            </div>
          </div>
        </section>

        <PluginSlot name="evidenceExtra" />

        <div
          className="filter-bar evidence-tabs"
          role="tablist"
          aria-label={KINLOOM_VOCABULARY.evidence.tablistAria}
          onKeyDown={(event) => {
            handleTablistKeyDown(event, ['conflicts', 'citations', 'media'] as const, tab, (next) => {
              setTab(next);
            });
          }}
        >
          <button
            type="button"
            role="tab"
            tabIndex={tab === 'conflicts' ? 0 : -1}
            aria-selected={tab === 'conflicts'}
            className={`pill-btn ${tab === 'conflicts' ? 'active' : ''}`}
            onClick={() => {
              setTab('conflicts');
            }}
          >
            {KINLOOM_VOCABULARY.evidence.discrepanciesTab} ({conflictEvents.length})
          </button>
          <button
            type="button"
            role="tab"
            tabIndex={tab === 'citations' ? 0 : -1}
            aria-selected={tab === 'citations'}
            className={`pill-btn ${tab === 'citations' ? 'active' : ''}`}
            onClick={() => {
              setTab('citations');
            }}
          >
            {KINLOOM_VOCABULARY.evidence.sourcesTab} ({bundle.sources.length})
          </button>
          <button
            type="button"
            role="tab"
            tabIndex={tab === 'media' ? 0 : -1}
            aria-selected={tab === 'media'}
            className={`pill-btn ${tab === 'media' ? 'active' : ''}`}
            onClick={() => {
              setTab('media');
            }}
          >
            {KINLOOM_VOCABULARY.evidence.mediaTab} ({allMedia.length})
          </button>
        </div>

        {tab === 'conflicts' && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {conflictEvents.length === 0 ? (
              <EmptyStateNotice title="No source discrepancies are recorded." />
            ) : (
              conflictEvents.map((ev) => {
                const primaryPerson = ev.participants
                  .map((pt) => peopleById.get(pt.person_id))
                  .find((p) => p && p.full_name !== 'Living');
                const readableRef = ev.sources.find((s) => readableSourceIds.has(s.source_id));
                const totalDiscrepancies =
                  (ev.alternate_dates?.length || 0) +
                  (ev.alternate_places?.length || 0) +
                  (ev.fact_conflicts?.length || 0);
                return (
                  <article key={ev.id} className="place-map-box" style={{ marginBottom: 0 }}>
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
                        <span className="conflict-pill">
                          ! {totalDiscrepancies} Preserved Discrepanc{totalDiscrepancies === 1 ? 'y' : 'ies'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {readableRef && (
                          <button
                            type="button"
                            className="source-read-btn"
                            onClick={() => {
                              openSourceReader({ sourceId: readableRef.source_id, eventId: ev.id });
                            }}
                          >
                            {KINLOOM_VOCABULARY.sources.readSourceCta}
                          </button>
                        )}
                        {primaryPerson && (
                          <Link
                            to={`/person/${primaryPerson.slug}?event=${ev.id}`}
                            className="pill-btn"
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
                    <div className="source-details">
                      <strong>Conflicting Claims Preserved Side-by-Side:</strong>
                      <ul>
                        {[
                          ...(ev.alternate_dates || []).map((alt) => ({
                            key: `date|${alt.edtf_date}|${alt.source_id}|${alt.note}`,
                            badge: alt.edtf_date,
                            note: alt.note,
                            sourceId: alt.source_id,
                          })),
                          ...(ev.alternate_places || []).map((alt) => ({
                            key: `place|${alt.place_name}|${alt.source_id}|${alt.note}`,
                            badge: `Place: ${alt.place_name}`,
                            note: alt.note,
                            sourceId: alt.source_id,
                          })),
                          ...(ev.fact_conflicts || []).map((alt) => ({
                            key: `fact|${alt.claim}|${alt.source_id}|${alt.note}`,
                            badge: alt.claim,
                            note: alt.note,
                            sourceId: alt.source_id,
                          })),
                        ].map((claim) => {
                          const src = sourcesById.get(claim.sourceId);
                          const publicCitation = src ? formatPublicCitation(src.citation) : '';
                          return (
                            <li key={claim.key} style={{ marginBottom: 4 }}>
                              <code>{claim.badge}</code> — {claim.note}
                              {publicCitation && (
                                <span style={{ color: 'var(--text-secondary)' }}> · {publicCitation}</span>
                              )}
                              {readableSourceIds.has(claim.sourceId) && (
                                <button
                                  type="button"
                                  className="source-read-inline"
                                  onClick={() => {
                                    openSourceReader({ sourceId: claim.sourceId, eventId: ev.id });
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
              })
            )}
          </section>
        )}

        {tab === 'citations' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <section className="place-map-box" style={{ marginBottom: 0 }}>
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
                  className="search-input"
                  placeholder="Filter sources or repositories (e.g. Census, NARA, Vital, County)…"
                  value={sourceQuery}
                  onChange={(e) => {
                    setSourceQuery(e.target.value);
                  }}
                  aria-label="Filter archival sources"
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filteredSources.length === 0 ? (
                  <EmptyStateNotice
                    title={
                      bundle.sources.length === 0
                        ? 'No sources have been cataloged yet.'
                        : 'No sources match that filter.'
                    }
                    action={
                      sourceQuery.trim() ? (
                        <button
                          type="button"
                          className="pill-btn"
                          onClick={() => {
                            setSourceQuery('');
                          }}
                        >
                          Clear filter
                        </button>
                      ) : undefined
                    }
                  />
                ) : (
                  filteredSources.map((s) => {
                    const count = sourceUsageCounts.get(s.id) || 0;
                    const readable = readableSourceIds.has(s.id);
                    const cit = buildLibrarianCitation(s);
                    return (
                      <div key={s.id} className="evidence-source-row">
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
                            <span className={`evidence-tier-badge tier-${cit.tier}`}>{cit.tierLabel}</span>
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
                            className="source-action-btn primary"
                            onClick={() => {
                              openSourceInspector({ sourceId: s.id });
                            }}
                          >
                            Inspect Source →
                          </button>
                          {readable && (
                            <button
                              type="button"
                              className="source-read-btn"
                              onClick={() => {
                                openSourceReader({ sourceId: s.id });
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
                              className="source-read-btn"
                              style={{ textDecoration: 'none' }}
                            >
                              Open Archive ↗
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <section className="place-map-box" style={{ marginBottom: 0 }}>
              {unverifiedEvents.length === 0 ? (
                <EmptyStateNotice title="All events have primary citations." />
              ) : (
                <>
                  <h2
                    style={{
                      fontFamily: 'var(--font-serif)',
                      margin: '0 0 6px',
                      color: 'var(--surface-header)',
                    }}
                  >
                    {KINLOOM_VOCABULARY.evidence.unverifiedHeading} ({unverifiedEvents.length})
                  </h2>
                  <p style={{ margin: '0 0 12px', fontSize: '0.9375rem', color: 'var(--text-secondary)' }}>
                    Because a GEDCOM export is a container rather than a primary source, events imported
                    without an underlying census, vital, or archival citation are tracked here for primary
                    verification.
                  </p>
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
                              className="pill-btn"
                              style={{ textDecoration: 'none', fontSize: '0.8125rem' }}
                            >
                              Verify on {p.full_name} →
                            </Link>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {unverifiedEvents.length > 25 && (
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="pill-btn"
                        onClick={() => {
                          setShowAllUnverified((v) => !v);
                        }}
                      >
                        {showAllUnverified
                          ? 'Show Fewer Entries Needing Citation'
                          : `Show All ${unverifiedEvents.length} Entries Needing Citation`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        )}

        {tab === 'media' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <section className="place-map-box" style={{ marginBottom: 0 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                <div>
                  <h2
                    style={{
                      fontFamily: 'var(--font-serif)',
                      margin: '0 0 4px',
                      color: 'var(--surface-header)',
                    }}
                  >
                    {KINLOOM_VOCABULARY.evidence.mediaGalleryHeading} ({filteredMedia.length})
                  </h2>
                  <p style={{ margin: 0, fontSize: '0.92rem', color: 'var(--text-secondary)' }}>
                    Portraits, family photographs, headstones, record scans (strictly excluding living
                    people), and document scans.
                  </p>
                </div>
                <input
                  type="search"
                  className="search-input"
                  placeholder={KINLOOM_VOCABULARY.evidence.mediaSearchPlaceholder}
                  value={mediaQuery}
                  onChange={(e) => {
                    setMediaQuery(e.target.value);
                    setMediaLimit(36);
                  }}
                  aria-label={KINLOOM_VOCABULARY.evidence.mediaSearchAria}
                />
              </div>

              {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="group" is the correct grouping pattern for a button toolbar */}
              <div
                className="filter-bar"
                role="group"
                aria-label="Filter photos and documents by category"
                style={{ marginBottom: 14 }}
              >
                <button
                  type="button"
                  className={`pill-btn ${mediaKindFilter === 'all' ? 'active' : ''}`}
                  onClick={() => {
                    setMediaKindFilter('all');
                    setMediaLimit(36);
                  }}
                >
                  {KINLOOM_VOCABULARY.evidence.allMediaItems} ({allMedia.length})
                </button>
                {(
                  [
                    'record_scan',
                    'portrait',
                    'family_photo',
                    'headstone',
                    'document_scan',
                    'milestone',
                    'video_story',
                    'audio_oral_history',
                  ] as ArchivalMediaKind[]
                ).map((k) => {
                  const cnt = mediaCountsByKind[k] || 0;
                  if (cnt === 0) {
                    return null;
                  }
                  return (
                    <button
                      key={k}
                      type="button"
                      className={`pill-btn ${mediaKindFilter === k ? 'active' : ''}`}
                      onClick={() => {
                        setMediaKindFilter(k);
                        setMediaLimit(36);
                      }}
                    >
                      {MEDIA_KIND_LABELS[k]} ({cnt})
                    </button>
                  );
                })}
              </div>

              {displayedMedia.length === 0 ? (
                <EmptyStateNotice
                  title={
                    allMedia.length === 0
                      ? 'No photos or documents have been added yet.'
                      : KINLOOM_VOCABULARY.evidence.mediaEmpty
                  }
                  action={
                    mediaKindFilter !== 'all' || mediaQuery.trim() ? (
                      <button
                        type="button"
                        className="pill-btn"
                        onClick={() => {
                          setMediaKindFilter('all');
                          setMediaQuery('');
                        }}
                      >
                        Clear filters
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <div className="person-media-grid">
                    {displayedMedia.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="person-media-card"
                        onClick={() => {
                          if (m.kind === 'document_scan' && m.source_id && m.page) {
                            openSourceReader({ sourceId: m.source_id, page: m.page });
                          } else {
                            setLightboxItem(m);
                          }
                        }}
                      >
                        <div className="person-media-thumb-wrap">
                          <MediaPlayer media={m} baseUrl={baseUrl} variant="preview" />
                          <span className={`media-kind-badge kind-${m.kind}`}>
                            {MEDIA_KIND_LABELS[m.kind] || m.kind}
                          </span>
                        </div>
                        <div className="person-media-caption">{m.caption}</div>
                      </button>
                    ))}
                  </div>
                  {filteredMedia.length > displayedMedia.length && (
                    <div style={{ marginTop: 16, textAlign: 'center' }}>
                      <button
                        type="button"
                        className="pill-btn"
                        onClick={() => {
                          setMediaLimit((n) => n + 36);
                        }}
                      >
                        {KINLOOM_VOCABULARY.evidence.loadMoreMedia} (
                        {filteredMedia.length - displayedMedia.length} remaining)
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>

            {mediaChecklist.length > 0 && (
              <section className="place-map-box" style={{ marginBottom: 0 }}>
                <h2
                  style={{
                    fontFamily: 'var(--font-serif)',
                    margin: '0 0 6px',
                    color: 'var(--surface-header)',
                  }}
                >
                  Un-digitized Photos &amp; Documents ({missingChecklistItems.length} missing of{' '}
                  {mediaChecklist.length} cataloged)
                </h2>
                <p style={{ margin: '0 0 12px', fontSize: '0.92rem', color: 'var(--text-secondary)' }}>
                  Cataloged media attachments for deceased ancestors whose image files have not yet been
                  digitized.
                </p>
                {missingChecklistItems.length === 0 ? (
                  <p
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.82rem',
                      color: 'var(--radar-local)',
                    }}
                  >
                    All cataloged deceased-ancestor archival photos have been digitized.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {missingChecklistItems.map((item) => (
                      <div key={`${item.person_id}-${item.obje_xref}`} className="evidence-source-row">
                        <div>
                          <strong style={{ fontSize: '0.94rem' }}>{item.title}</strong>
                          <div
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.78rem',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {item.person_name} ({item.lifespan}) · {item.media_type} ·{' '}
                            {item.form.toUpperCase()}
                          </div>
                        </div>
                        <Link
                          to={`/person/${item.person_slug}`}
                          className="pill-btn"
                          style={{ textDecoration: 'none', fontSize: '0.8125rem' }}
                        >
                          {KINLOOM_VOCABULARY.evidence.openProfileCta}
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        {lightboxItem &&
          (() => {
            const curIdx = navMedia.findIndex((m) => m.id === lightboxItem.id);
            return (
              <dialog
                ref={lightboxDialogRef}
                open
                aria-modal="true"
                className="lightbox-backdrop"
                aria-label={lightboxItem.caption}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  className="lightbox-backdrop-close"
                  aria-label="Close lightbox"
                  onClick={() => {
                    setLightboxItem(null);
                  }}
                />
                <div className="scan-lightbox-card">
                  <div className="scan-lightbox-header">
                    <div>
                      <span
                        className={`media-kind-badge kind-${lightboxItem.kind}`}
                        style={{ position: 'static', marginRight: 8 }}
                      >
                        {MEDIA_KIND_LABELS[lightboxItem.kind] || lightboxItem.kind}
                      </span>
                      <strong
                        style={{
                          fontFamily: 'var(--font-serif)',
                          fontSize: '1.05rem',
                          color: 'var(--text-inverse)',
                        }}
                      >
                        {lightboxItem.caption}
                      </strong>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {navMedia.length > 1 && curIdx !== -1 && (
                        <>
                          <button
                            type="button"
                            className="pill-btn"
                            onClick={() => {
                              setLightboxItem(navMedia[(curIdx - 1 + navMedia.length) % navMedia.length]);
                            }}
                          >
                            ← Prev
                          </button>
                          <button
                            type="button"
                            className="pill-btn"
                            onClick={() => {
                              setLightboxItem(navMedia[(curIdx + 1) % navMedia.length]);
                            }}
                          >
                            Next →
                          </button>
                        </>
                      )}
                      {lightboxItem.person_slug && (
                        <Link
                          to={`/person/${lightboxItem.person_slug}`}
                          className="pill-btn"
                          style={{ textDecoration: 'none' }}
                          onClick={() => {
                            setLightboxItem(null);
                          }}
                        >
                          Open {lightboxItem.person_name || 'Person'} →
                        </Link>
                      )}
                      <button
                        ref={lightboxCloseRef}
                        type="button"
                        className="pill-btn"
                        onClick={() => {
                          setLightboxItem(null);
                        }}
                        aria-label="Close archival image lightbox"
                      >
                        Close [Esc]
                      </button>
                    </div>
                  </div>
                  <div className="scan-lightbox-scroll">
                    <MediaPlayer media={lightboxItem} baseUrl={baseUrl} variant="full" />
                  </div>
                  {lightboxItem.provenance && (
                    <div
                      style={{
                        padding: '8px 14px',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.75rem',
                        color: 'var(--text-secondary)',
                        borderTop: '1px solid var(--border-decorative)',
                      }}
                    >
                      Source file: {lightboxItem.provenance}
                    </div>
                  )}
                </div>
              </dialog>
            );
          })()}
      </main>
      <KinloomFooter />
    </div>
  );
};
