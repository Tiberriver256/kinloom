import type { ReadingDocument, ReadingPage } from '@kinloom/core';
import type React from 'react';
import { cx } from '../../lib/cx.js';
import controlStyles from '../../styles/Controls.module.css';
import overlayStyles from '../../styles/Overlays.module.css';
import { ArchivalImage } from '../Atoms.js';
import readerStyles from '../SourceReaderDrawer.module.css';

export type ReaderViewMode = 'text' | 'split' | 'scan';

export function slugifyFamilyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return slug || 'archive';
}

export function renderHighlightedText(text: string, query: string, markClassName: string): React.ReactNode {
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
      <mark key={start} className={markClassName}>
        {part}
      </mark>
    ) : (
      part
    );
  });
}

export const SourceReaderStage: React.FC<{
  readonly effectiveMode: ReaderViewMode;
  readonly currentDoc: ReadingDocument;
  readonly currentPage: ReadingPage;
  readonly safeIdx: number;
  readonly scanSrc: string;
  readonly searchTerm: string;
  readonly onOpenScanZoom: () => void;
}> = ({ effectiveMode, currentDoc, currentPage, safeIdx, scanSrc, searchTerm, onOpenScanZoom }) => (
  <div className={cx(readerStyles, `source-reader-stage mode-${effectiveMode}`)}>
    {(effectiveMode === 'scan' || effectiveMode === 'split') && scanSrc && (
      <figure className={cx(readerStyles, 'scan-viewer-sheet')}>
        <div className={cx(readerStyles, 'transcript-meta')}>
          <span>Original Scan · {currentPage.label}</span>
          <button type="button" className={cx(controlStyles, 'source-read-inline')} onClick={onOpenScanZoom}>
            Zoom Full Page ↗
          </button>
        </div>
        <ArchivalImage
          src={scanSrc}
          alt={`Scanned original page for ${currentDoc.title}, ${currentPage.label}`}
          frameStyle={{ width: '100%' }}
          className={cx(readerStyles, 'scan-page-img')}
          loading="lazy"
          fallbackCaption={`Original scan unavailable (${currentPage.label})`}
        />
      </figure>
    )}

    {(effectiveMode === 'text' || effectiveMode === 'split') && (
      <div className={cx(readerStyles, 'transcript-sheet')}>
        <div className={cx(readerStyles, 'transcript-meta')}>
          <span>{currentPage.label}</span>
          <span>
            Page {safeIdx + 1} of {currentDoc.pages.length}
          </span>
        </div>
        <pre className={cx(readerStyles, 'transcript-body')}>
          {renderHighlightedText(currentPage.text, searchTerm, cx(readerStyles, 'transcript-mark'))}
        </pre>
      </div>
    )}
  </div>
);

export const SourceReaderScanZoomDialog: React.FC<{
  readonly dialogRef: React.RefObject<HTMLDialogElement | null>;
  readonly closeBtnRef: React.RefObject<HTMLButtonElement | null>;
  readonly docTitle: string | undefined;
  readonly pageLabel: string;
  readonly scanSrc: string;
  readonly buttonClassName: string;
  readonly onClose: () => void;
}> = ({ dialogRef, closeBtnRef, docTitle, pageLabel, scanSrc, buttonClassName, onClose }) => (
  <dialog
    ref={dialogRef}
    open
    aria-modal="true"
    className={cx(overlayStyles, 'lightbox-backdrop')}
    aria-label="Full page scan zoom view"
  >
    <button
      type="button"
      tabIndex={-1}
      className={cx(overlayStyles, 'lightbox-backdrop-close')}
      aria-label="Close full page scan view"
      onClick={onClose}
    />
    <div className={cx(overlayStyles, 'lightbox-card scan-lightbox-card')}>
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
          {docTitle} · {pageLabel}
        </strong>
        <button ref={closeBtnRef} type="button" className={buttonClassName} onClick={onClose}>
          Close [Esc]
        </button>
      </div>
      <div className={cx(overlayStyles, 'scan-lightbox-scroll')}>
        <ArchivalImage
          src={scanSrc}
          alt={`High-resolution scan of ${pageLabel}`}
          loading="eager"
          frameStyle={{ width: '100%' }}
          className={cx(overlayStyles, 'scan-page-img-full')}
          fallbackCaption={`High-resolution scan unavailable (${pageLabel})`}
        />
      </div>
    </div>
  </dialog>
);
