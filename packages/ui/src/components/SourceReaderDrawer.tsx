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
import { Link, useInRouterContext } from 'react-router-dom';
import { triggerTextDownload } from '../browser/download.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { handleTablistKeyDown } from '../hooks/keyboardNav.js';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap.js';
import { cx, joinClasses } from '../lib/cx.js';
import { readerNextPage, readerPrevPage, resolveReaderPageIndex } from '../lib/sourceReaderNav.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import controlStyles from '../styles/Controls.module.css';
import overlayStyles from '../styles/Overlays.module.css';
import { resolveAssetUrl } from './Atoms.js';
import canvasSurfaceStyles from './CanvasSurfacePrimitives.module.css';
import readerStyles from './SourceReaderDrawer.module.css';
import {
  type ReaderViewMode,
  SourceReaderScanZoomDialog,
  SourceReaderStage,
  slugifyFamilyName,
} from './sourceReader/SourceReaderStage.js';

export const SourceReaderDrawer: React.FC = () => {
  const {
    bundle,
    peopleById,
    readings,
    readingsLoading,
    readingsError,
    siteConfig,
    featuredDocumentId,
    baseUrl,
  } = useArchiveData();
  const { sourceReader, closeSourceReader } = useArchiveUi();
  const inRouter = useInRouterContext();

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const scanZoomCloseBtnRef = useRef<HTMLButtonElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const mountedRef = useRef<boolean>(true);
  const [activeDocId, setActiveDocId] = useState<string>('');
  const [pageIdx, setPageIdx] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [viewMode, setViewMode] = useState<ReaderViewMode>('text');
  const [scanZoomOpen, setScanZoomOpen] = useState<boolean>(false);
  const [copyFeedback, setCopyFeedback] = useState<string>('');

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

  const safeIdx = currentDoc ? Math.max(0, Math.min(pageIdx, Math.max(0, currentDoc.pages.length - 1))) : 0;
  const currentPage = currentDoc?.pages[safeIdx] || null;

  const citedByLinks = useMemo(() => {
    if (!readings || !bundle || !currentDoc || !currentPage) {
      return [];
    }
    const items: Array<{ readonly key: string; readonly label: string; readonly to: string }> = [];
    const seen = new Set<string>();
    for (const ev of bundle.events) {
      const mappedPage = readings.event_page_map[ev.id]?.[currentDoc.source_id];
      if (mappedPage !== currentPage.page) {
        continue;
      }
      for (const participant of ev.participants) {
        const person = peopleById.get(participant.person_id);
        if (!person || (person.is_living && person.full_name.trim() === 'Living')) {
          continue;
        }
        const to = `/person/${person.slug}?event=${encodeURIComponent(ev.id)}`;
        const key = `${person.id}:${ev.id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const dateSuffix = ev.display_date || ev.edtf_date ? ` (${ev.display_date || ev.edtf_date})` : '';
        items.push({
          key,
          label: `${person.full_name} — ${ev.title}${dateSuffix}`,
          to,
        });
      }
    }
    return items.slice(0, 8);
  }, [readings, bundle, peopleById, currentDoc, currentPage]);

  if (!sourceReader) {
    return null;
  }
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
      if (!mountedRef.current) {
        return;
      }
      setCopyFeedback('Copied all pages');
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setCopyFeedback('Copy blocked; use Download Text');
    }
    if (typeof window === 'undefined') {
      return;
    }
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      if (mountedRef.current) {
        setCopyFeedback('');
      }
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
      className={joinClasses(
        cx(overlayStyles, 'drawer-backdrop'),
        cx(readerStyles, 'source-reader-backdrop')
      )}
      aria-label={KINLOOM_VOCABULARY.sources.readerAria}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(overlayStyles, 'lightbox-backdrop-close')}
        aria-label="Close source reader"
        onClick={closeSourceReader}
      />
      <aside
        className={joinClasses(
          cx(overlayStyles, 'drawer-panel'),
          cx(readerStyles, 'source-reader-panel'),
          effectiveMode === 'split' ? 'source-reader-wide' : ''
        )}
      >
        <div className={cx(overlayStyles, 'drawer-top')}>
          <div>
            <h2 className={'drawer-title'} style={{ marginTop: 0 }}>
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
          <button
            ref={closeBtnRef}
            type="button"
            className={cx(controlStyles, 'pill-btn')}
            onClick={closeSourceReader}
          >
            <span>Close</span> <kbd className="kl-kbd">Esc</kbd>
          </button>
        </div>

        {orderedDocs.length > 0 && (
          <div
            className={joinClasses(
              cx(controlStyles, 'filter-bar'),
              cx(readerStyles, 'source-collection-tabs')
            )}
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
                  className={cx(controlStyles, `pill-btn ${isSelected ? 'active' : ''}`)}
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

        {readingsLoading && (
          <p className={cx(controlStyles, 'empty-ring-note')}>Loading primary transcriptions…</p>
        )}
        {readingsError && (
          <p className={cx(controlStyles, 'empty-ring-note')}>
            Error loading transcriptions: {readingsError}
          </p>
        )}
        {!readingsLoading && !readingsError && orderedDocs.length === 0 && (
          <p className={cx(controlStyles, 'empty-ring-note')}>
            No primary source transcriptions have been added to this archive yet.
          </p>
        )}

        {currentDoc && currentPage && (
          <>
            <div className={cx(readerStyles, 'source-reader-controls')}>
              <div className={cx(readerStyles, 'source-reader-toolbar-row')}>
                <div className={cx(readerStyles, 'source-pager-group')}>
                  <button
                    type="button"
                    className={cx(controlStyles, 'pill-btn')}
                    disabled={safeIdx <= 0}
                    onClick={() => {
                      setPageIdx((i) => readerPrevPage(i));
                    }}
                    aria-label="Previous page"
                  >
                    ← Prev
                  </button>
                  <select
                    className={joinClasses(
                      cx(controlStyles, 'pill-btn'),
                      cx(readerStyles, 'source-page-indicator')
                    )}
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
                    className={cx(controlStyles, 'pill-btn')}
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
                  <div
                    className={cx(readerStyles, 'source-view-mode-group')}
                    role="group"
                    aria-label="Document view mode"
                  >
                    {(
                      [
                        ['text', 'Text'],
                        ['split', 'Side-by-Side'],
                        ['scan', 'Original Scan'],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        className={cx(controlStyles, `pill-btn ${effectiveMode === mode ? 'active' : ''}`)}
                        onClick={() => {
                          setViewMode(mode);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <input
                type="search"
                className={cx(controlStyles, 'search-input source-search-input')}
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
                      className={cx(controlStyles, `pill-btn ${safeIdx === idx ? 'active' : ''}`)}
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

            <SourceReaderStage
              effectiveMode={effectiveMode}
              currentDoc={currentDoc}
              currentPage={currentPage}
              safeIdx={safeIdx}
              scanSrc={scanSrc}
              searchTerm={searchTerm}
              onOpenScanZoom={() => {
                setScanZoomOpen(true);
              }}
            />

            {citedByLinks.length > 0 && (
              <nav className={cx(readerStyles, 'source-cited-by-strip')} aria-label="Cited by">
                <span className={cx(readerStyles, 'source-cited-by-label')}>Cited by</span>
                <div className="kl-cluster">
                  {citedByLinks.map((item) =>
                    inRouter ? (
                      <Link
                        key={item.key}
                        to={item.to}
                        className={cx(readerStyles, 'source-cited-by-link')}
                        onClick={closeSourceReader}
                      >
                        {item.label}
                      </Link>
                    ) : (
                      <a
                        key={item.key}
                        href={item.to}
                        className={cx(readerStyles, 'source-cited-by-link')}
                        onClick={closeSourceReader}
                      >
                        {item.label}
                      </a>
                    )
                  )}
                </div>
              </nav>
            )}

            <div className={cx(readerStyles, 'source-download-bar source-download-footer')}>
              <button
                type="button"
                className={joinClasses(
                  cx(controlStyles, 'pill-btn active'),
                  cx(canvasSurfaceStyles, 'map-bordered-btn')
                )}
                onClick={handleDownloadFullText}
              >
                Download Text ({currentDoc.pages.length} {currentDoc.pages.length === 1 ? 'p.' : 'pp.'})
              </button>
              <button
                type="button"
                className={joinClasses(
                  cx(controlStyles, 'pill-btn'),
                  cx(canvasSurfaceStyles, 'map-bordered-btn')
                )}
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
                  className={joinClasses(
                    cx(controlStyles, 'pill-btn'),
                    cx(canvasSurfaceStyles, 'map-bordered-btn')
                  )}
                  style={{ textDecoration: 'none' }}
                >
                  Download PDF{pdfSizeLabel ? ` (${pdfSizeLabel})` : ''}
                </a>
              )}
              {orderedDocs.length > 1 && (
                <button
                  type="button"
                  className={joinClasses(
                    cx(controlStyles, 'pill-btn'),
                    cx(canvasSurfaceStyles, 'map-bordered-btn')
                  )}
                  onClick={handleDownloadAllSources}
                >
                  All Sources (.txt)
                </button>
              )}
            </div>

            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              }}
            >
              Provenance: {formatPublicCitation(currentDoc.provenance)}
            </div>
            <PluginSlot name="sourceReaderFooter" />
          </>
        )}

        {scanZoomOpen && scanSrc && currentPage && (
          <SourceReaderScanZoomDialog
            dialogRef={scanZoomDialogRef}
            closeBtnRef={scanZoomCloseBtnRef}
            docTitle={currentDoc?.title}
            pageLabel={currentPage.label}
            scanSrc={scanSrc}
            buttonClassName={cx(controlStyles, 'pill-btn')}
            onClose={() => {
              setScanZoomOpen(false);
            }}
          />
        )}
      </aside>
    </dialog>
  );
};
