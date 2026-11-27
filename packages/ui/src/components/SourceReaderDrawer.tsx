import type { ReadingDocument } from '@kinloom/core';
import {
  buildAllSourcesText,
  buildFullSourceText,
  buildSourceTextFilename,
  formatFileSize,
  formatPublicCitation,
} from '@kinloom/core';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { handleTablistKeyDown } from '../lib/keyboardNav.js';
import { readerNextPage, readerPrevPage, resolveReaderPageIndex } from '../lib/sourceReaderNav.js';
import { useDialogFocusTrap } from '../lib/useDialogFocusTrap.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import { resolveAssetUrl } from './Atoms.js';

function triggerTextDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

function slugifyFamilyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return slug || 'archive';
}

type ReaderViewMode = 'text' | 'split' | 'scan';

const renderHighlightedText = (text: string, query: string): React.ReactNode => {
  const q = query.trim();
  if (!q) {
    return text;
  }
  const escaped = q.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  let offset = 0;
  return parts.map((part) => {
    const start = offset;
    offset += part.length;
    return part.toLowerCase() === q.toLowerCase() ? (
      <mark key={start} className="transcript-mark">
        {part}
      </mark>
    ) : (
      part
    );
  });
};

export const SourceReaderDrawer: React.FC = () => {
  const { readings, readingsLoading, readingsError, siteConfig, featuredDocumentId, baseUrl } =
    useArchiveData();
  const { sourceReader, closeSourceReader } = useArchiveUi();

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const scanZoomCloseBtnRef = useRef<HTMLButtonElement | null>(null);
  const [activeDocId, setActiveDocId] = useState<string>('');
  const [pageIdx, setPageIdx] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [viewMode, setViewMode] = useState<ReaderViewMode>('text');
  const [scanZoomOpen, setScanZoomOpen] = useState<boolean>(false);
  const [copyFeedback, setCopyFeedback] = useState<string>('');

  const dialogRef = useDialogFocusTrap({
    open: Boolean(sourceReader),
    onClose: closeSourceReader,
    initialFocusRef: closeBtnRef,
  });

  const scanZoomDialogRef = useDialogFocusTrap({
    open: Boolean(sourceReader) && scanZoomOpen,
    onClose: () => {
      setScanZoomOpen(false);
    },
    initialFocusRef: scanZoomCloseBtnRef,
  });

  const orderedDocs = useMemo<ReadingDocument[]>(() => {
    if (!readings) {
      return [];
    }
    const entries = Object.values(readings.documents).filter((doc) => doc.pages.length > 0);
    return entries.toSorted((a, b) => {
      if (featuredDocumentId) {
        if (a.source_id === featuredDocumentId) {
          return -1;
        }
        if (b.source_id === featuredDocumentId) {
          return 1;
        }
      }
      return a.title.localeCompare(b.title);
    });
  }, [readings, featuredDocumentId]);

  useEffect(() => {
    if (!sourceReader) {
      return;
    }
    const requestedDocId = sourceReader.sourceId || featuredDocumentId || orderedDocs[0]?.source_id || '';
    setActiveDocId(requestedDocId);
    setSearchTerm(sourceReader.highlightQuery || '');
    setScanZoomOpen(false);

    if (!readings) {
      return;
    }
    const doc = readings.documents[requestedDocId] || orderedDocs[0];
    if (!doc) {
      return;
    }
    setActiveDocId(doc.source_id);

    const mappedPage =
      sourceReader.page ??
      (sourceReader.eventId ? readings.event_page_map[sourceReader.eventId]?.[doc.source_id] : undefined);

    setPageIdx(resolveReaderPageIndex(doc.pages, mappedPage));
  }, [sourceReader, readings, featuredDocumentId, orderedDocs]);

  useEffect(() => {
    if (!sourceReader || scanZoomOpen) {
      return undefined;
    }
    const onKey = (e: KeyboardEvent): void => {
      const targetEl = e.target instanceof HTMLElement ? e.target : null;
      const tag = targetEl?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }
      if (targetEl?.closest('[role="tablist"]')) {
        return;
      }
      if (e.key === 'ArrowRight') {
        setPageIdx((i) => readerNextPage(i, readings?.documents[activeDocId]?.pages.length || 0));
      } else if (e.key === 'ArrowLeft') {
        setPageIdx((i) => readerPrevPage(i));
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [sourceReader, scanZoomOpen, readings, activeDocId]);

  const currentDoc = useMemo(() => {
    if (!readings) {
      return null;
    }
    return readings.documents[activeDocId] || orderedDocs[0] || null;
  }, [readings, activeDocId, orderedDocs]);

  const matchingPageIndices = useMemo(() => {
    if (!currentDoc) {
      return [];
    }
    const q = searchTerm.trim().toLowerCase();
    if (!q) {
      return currentDoc.pages.map((_, idx) => idx);
    }
    return currentDoc.pages
      .map((p, idx) => (p.text.toLowerCase().includes(q) ? idx : -1))
      .filter((idx) => idx >= 0);
  }, [currentDoc, searchTerm]);

  if (!sourceReader) {
    return null;
  }

  const safeIdx = currentDoc ? Math.max(0, Math.min(pageIdx, Math.max(0, currentDoc.pages.length - 1))) : 0;
  const currentPage = currentDoc?.pages[safeIdx] || null;
  const hasScan = Boolean(currentPage?.image_url);
  const effectiveMode: ReaderViewMode = hasScan ? viewMode : 'text';
  const scanSrc = currentPage?.image_url ? resolveAssetUrl(currentPage.image_url, baseUrl) : '';
  const pdfSrc = currentDoc?.pdf_url ? resolveAssetUrl(currentDoc.pdf_url, baseUrl) : '';
  const pdfSizeLabel = formatFileSize(currentDoc?.pdf_size_bytes);

  const handleDownloadFullText = (): void => {
    if (!currentDoc) {
      return;
    }
    triggerTextDownload(buildSourceTextFilename(currentDoc), buildFullSourceText(currentDoc));
  };

  const handleCopyFullText = async (): Promise<void> => {
    if (!currentDoc) {
      return;
    }
    try {
      await navigator.clipboard.writeText(buildFullSourceText(currentDoc));
      setCopyFeedback('Copied all pages');
    } catch {
      setCopyFeedback('Copy blocked; use Download Text');
    }
    window.setTimeout(() => {
      setCopyFeedback('');
    }, 2500);
  };

  const handleDownloadAllSources = (): void => {
    if (orderedDocs.length === 0) {
      return;
    }
    const prefix = slugifyFamilyName(siteConfig.site.familyName);
    triggerTextDownload(`${prefix}-all-primary-sources.txt`, buildAllSourcesText(orderedDocs));
  };

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className="drawer-backdrop source-reader-backdrop"
      aria-label={KINLOOM_VOCABULARY.sources.readerAria}
    >
      <button
        type="button"
        tabIndex={-1}
        className="lightbox-backdrop-close"
        aria-label="Close source reader"
        onClick={closeSourceReader}
      />
      <aside
        className={`drawer-panel source-reader-panel ${effectiveMode === 'split' ? 'source-reader-wide' : ''}`}
      >
        <div className="drawer-top">
          <div>
            <h2 className="drawer-title" style={{ marginTop: 0 }}>
              {currentDoc?.title || KINLOOM_VOCABULARY.sources.readerFallbackTitle}
            </h2>
            {currentDoc && (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.78rem',
                  color: 'var(--text-secondary)',
                  marginTop: 2,
                }}
              >
                Source Reader · {currentDoc.author}
              </div>
            )}
          </div>
          <button ref={closeBtnRef} type="button" className="pill-btn" onClick={closeSourceReader}>
            Close [Esc]
          </button>
        </div>

        {orderedDocs.length > 0 && (
          <div
            className="filter-bar source-collection-tabs"
            style={{ marginBottom: 0 }}
            role="tablist"
            aria-label="Source collections"
            onKeyDown={(event) => {
              const ids = orderedDocs.map((d) => d.source_id);
              const active = currentDoc?.source_id ?? ids[0] ?? '';
              handleTablistKeyDown(event, ids, active, (nextId) => {
                setActiveDocId(nextId);
                setPageIdx(0);
                setSearchTerm('');
              });
            }}
          >
            {orderedDocs.map((doc) => {
              const isSelected = currentDoc?.source_id === doc.source_id;
              return (
                <button
                  key={doc.source_id}
                  type="button"
                  role="tab"
                  tabIndex={isSelected ? 0 : -1}
                  aria-selected={isSelected}
                  className={`pill-btn ${isSelected ? 'active' : ''}`}
                  onClick={() => {
                    setActiveDocId(doc.source_id);
                    setPageIdx(0);
                    setSearchTerm('');
                  }}
                >
                  {doc.title}
                </button>
              );
            })}
          </div>
        )}

        {readingsLoading && <p className="empty-ring-note">Loading primary transcriptions…</p>}
        {readingsError && <p className="empty-ring-note">Error loading transcriptions: {readingsError}</p>}
        {!readingsLoading && !readingsError && orderedDocs.length === 0 && (
          <p className="empty-ring-note">
            No primary source transcriptions have been added to this archive yet.
          </p>
        )}

        {currentDoc && currentPage && (
          <>
            <div className="source-reader-controls">
              <div className="source-reader-toolbar-row">
                <div className="source-pager-group">
                  <button
                    type="button"
                    className="pill-btn"
                    disabled={safeIdx <= 0}
                    onClick={() => {
                      setPageIdx((i) => readerPrevPage(i));
                    }}
                    aria-label="Previous page"
                  >
                    ← Prev
                  </button>
                  <select
                    className="pill-btn source-page-indicator"
                    aria-label="Select transcription page"
                    value={safeIdx}
                    onChange={(e) => {
                      setPageIdx(Number(e.target.value));
                    }}
                  >
                    {currentDoc.pages.map((p, idx) => (
                      <option key={p.page} value={idx}>
                        {p.label} ({idx + 1}/{currentDoc.pages.length})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="pill-btn"
                    disabled={safeIdx >= currentDoc.pages.length - 1}
                    onClick={() => {
                      setPageIdx((i) => readerNextPage(i, currentDoc.pages.length));
                    }}
                    aria-label="Next page"
                  >
                    Next →
                  </button>
                </div>

                {hasScan && (
                  <div className="source-view-mode-group" role="group" aria-label="Document view mode">
                    <button
                      type="button"
                      className={`pill-btn ${effectiveMode === 'text' ? 'active' : ''}`}
                      onClick={() => {
                        setViewMode('text');
                      }}
                    >
                      Text
                    </button>
                    <button
                      type="button"
                      className={`pill-btn ${effectiveMode === 'split' ? 'active' : ''}`}
                      onClick={() => {
                        setViewMode('split');
                      }}
                    >
                      Side-by-Side
                    </button>
                    <button
                      type="button"
                      className={`pill-btn ${effectiveMode === 'scan' ? 'active' : ''}`}
                      onClick={() => {
                        setViewMode('scan');
                      }}
                    >
                      Original Scan
                    </button>
                  </div>
                )}
              </div>

              <input
                type="search"
                className="search-input source-search-input"
                style={{ minWidth: 0, width: '100%' }}
                placeholder="Search within this document…"
                value={searchTerm}
                onChange={(e) => {
                  const val = e.target.value;
                  setSearchTerm(val);
                  if (val.trim()) {
                    const firstHit = currentDoc.pages.findIndex((p) =>
                      p.text.toLowerCase().includes(val.trim().toLowerCase())
                    );
                    if (firstHit !== -1) {
                      setPageIdx(firstHit);
                    }
                  }
                }}
                aria-label="Search within primary source transcription"
              />

              {searchTerm.trim() && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: '0.78rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>
                    {matchingPageIndices.length} matching page{matchingPageIndices.length === 1 ? '' : 's'}:
                  </span>
                  {matchingPageIndices.slice(0, 10).map((idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={`pill-btn ${safeIdx === idx ? 'active' : ''}`}
                      style={{ padding: '2px 7px', fontSize: '0.75rem' }}
                      onClick={() => {
                        setPageIdx(idx);
                      }}
                    >
                      p. {currentDoc.pages[idx].page}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className={`source-reader-stage mode-${effectiveMode}`}>
              {(effectiveMode === 'scan' || effectiveMode === 'split') && scanSrc && (
                <figure className="scan-viewer-sheet">
                  <div className="transcript-meta">
                    <span>Original Scan · {currentPage.label}</span>
                    <button
                      type="button"
                      className="source-read-inline"
                      onClick={() => {
                        setScanZoomOpen(true);
                      }}
                    >
                      Zoom Full Page ↗
                    </button>
                  </div>
                  <img
                    src={scanSrc}
                    alt={`Scanned original page for ${currentDoc.title}, ${currentPage.label}`}
                    className="scan-page-img"
                    loading="lazy"
                  />
                </figure>
              )}

              {(effectiveMode === 'text' || effectiveMode === 'split') && (
                <div className="transcript-sheet">
                  <div className="transcript-meta">
                    <span>{currentPage.label}</span>
                    <span>
                      Page {safeIdx + 1} of {currentDoc.pages.length}
                    </span>
                  </div>
                  <pre className="transcript-body">{renderHighlightedText(currentPage.text, searchTerm)}</pre>
                </div>
              )}
            </div>

            <div className="source-download-bar source-download-footer">
              <button
                type="button"
                className="pill-btn map-bordered-btn active"
                onClick={handleDownloadFullText}
              >
                Download Text ({currentDoc.pages.length} {currentDoc.pages.length === 1 ? 'p.' : 'pp.'})
              </button>
              <button
                type="button"
                className="pill-btn map-bordered-btn"
                onClick={() => {
                  void handleCopyFullText();
                }}
              >
                {copyFeedback || 'Copy All Text'}
              </button>
              {pdfSrc && (
                <a
                  href={pdfSrc}
                  download
                  className="pill-btn map-bordered-btn"
                  style={{ textDecoration: 'none' }}
                >
                  Download PDF{pdfSizeLabel ? ` (${pdfSizeLabel})` : ''}
                </a>
              )}
              {orderedDocs.length > 1 && (
                <button
                  type="button"
                  className="pill-btn map-bordered-btn"
                  onClick={handleDownloadAllSources}
                >
                  All Sources (.txt)
                </button>
              )}
            </div>

            <div
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-secondary)' }}
            >
              Provenance: {formatPublicCitation(currentDoc.provenance)}
            </div>
            <PluginSlot name="sourceReaderFooter" />
          </>
        )}

        {scanZoomOpen && scanSrc && currentPage && (
          <dialog
            ref={scanZoomDialogRef}
            open
            aria-modal="true"
            className="lightbox-backdrop"
            aria-label="Full page scan zoom view"
          >
            <button
              type="button"
              tabIndex={-1}
              className="lightbox-backdrop-close"
              aria-label="Close full page scan view"
              onClick={() => {
                setScanZoomOpen(false);
              }}
            />
            <div className="lightbox-card scan-lightbox-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 10,
                }}
              >
                <strong
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8rem',
                    color: 'var(--surface-header)',
                  }}
                >
                  {currentDoc?.title} · {currentPage.label}
                </strong>
                <button
                  ref={scanZoomCloseBtnRef}
                  type="button"
                  className="pill-btn"
                  onClick={() => {
                    setScanZoomOpen(false);
                  }}
                >
                  Close [Esc]
                </button>
              </div>
              <div className="scan-lightbox-scroll">
                <img
                  src={scanSrc}
                  alt={`High-resolution scan of ${currentPage.label}`}
                  className="scan-page-img-full"
                />
              </div>
            </div>
          </dialog>
        )}
      </aside>
    </dialog>
  );
};
