import type { MediaChecklistItem, MediaItem } from '@kinloom/core';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { EmptyStateNotice } from '../../components/Atoms.js';
import { MediaPlayer } from '../../components/MediaPlayer.js';
import { cx } from '../../lib/cx.js';
import { useDialogFocusTrap } from '../../lib/useDialogFocusTrap.js';
import { KINLOOM_VOCABULARY, MEDIA_KIND_LABELS } from '../../lib/vocabulary.js';
import type { MediaKindFilter } from './evidenceViewModel.js';
import { MEDIA_KIND_FILTER_ORDER } from './evidenceViewModel.js';

export interface EvidenceMediaTabProps {
  readonly allMedia: readonly MediaItem[];
  readonly filteredMedia: readonly MediaItem[];
  readonly mediaLimit: number;
  readonly mediaKindFilter: MediaKindFilter;
  readonly mediaQuery: string;
  readonly mediaCountsByKind: Readonly<Record<string, number>>;
  readonly mediaChecklist: readonly MediaChecklistItem[];
  readonly missingChecklistItems: readonly MediaChecklistItem[];
  readonly baseUrl?: string;
  readonly uiStyles: Readonly<Record<string, string>>;
  readonly onMediaQueryChange: (value: string) => void;
  readonly onMediaKindFilterChange: (kind: MediaKindFilter) => void;
  readonly onClearMediaFilters: () => void;
  readonly onLoadMoreMedia: () => void;
  readonly onOpenMediaItem: (item: MediaItem) => void;
}

export const EvidenceMediaTab: React.FC<EvidenceMediaTabProps> = ({
  allMedia,
  filteredMedia,
  mediaLimit,
  mediaKindFilter,
  mediaQuery,
  mediaCountsByKind,
  mediaChecklist,
  missingChecklistItems,
  baseUrl,
  uiStyles,
  onMediaQueryChange,
  onMediaKindFilterChange,
  onClearMediaFilters,
  onLoadMoreMedia,
  onOpenMediaItem,
}) => {
  const displayedMedia = filteredMedia.slice(0, mediaLimit);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section className={cx(uiStyles, 'place-map-box')} style={{ marginBottom: 0 }}>
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
              Portraits, family photographs, headstones, record scans (strictly excluding living people), and
              document scans.
            </p>
          </div>
          <input
            type="search"
            className={cx(uiStyles, 'search-input')}
            placeholder={KINLOOM_VOCABULARY.evidence.mediaSearchPlaceholder}
            value={mediaQuery}
            onChange={(e) => {
              onMediaQueryChange(e.target.value);
            }}
            aria-label={KINLOOM_VOCABULARY.evidence.mediaSearchAria}
          />
        </div>

        <div
          className={cx(uiStyles, 'filter-bar')}
          role="group"
          aria-label="Filter photos and documents by category"
          style={{ marginBottom: 14 }}
        >
          <button
            type="button"
            className={cx(uiStyles, `pill-btn ${mediaKindFilter === 'all' ? 'active' : ''}`)}
            onClick={() => {
              onMediaKindFilterChange('all');
            }}
          >
            {KINLOOM_VOCABULARY.evidence.allMediaItems} ({allMedia.length})
          </button>
          {MEDIA_KIND_FILTER_ORDER.map((k) => {
            const cnt = mediaCountsByKind[k] || 0;
            if (cnt === 0) {
              return null;
            }
            return (
              <button
                key={k}
                type="button"
                className={cx(uiStyles, `pill-btn ${mediaKindFilter === k ? 'active' : ''}`)}
                onClick={() => {
                  onMediaKindFilterChange(k);
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
                <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={onClearMediaFilters}>
                  Clear filters
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className={cx(uiStyles, 'person-media-grid')}>
              {displayedMedia.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={cx(uiStyles, 'person-media-card')}
                  onClick={() => {
                    onOpenMediaItem(m);
                  }}
                >
                  <div className={cx(uiStyles, 'person-media-thumb-wrap')}>
                    <MediaPlayer media={m} baseUrl={baseUrl} variant="preview" />
                    <span className={cx(uiStyles, `media-kind-badge kind-${m.kind}`)}>
                      {MEDIA_KIND_LABELS[m.kind] || m.kind}
                    </span>
                  </div>
                  <div className={cx(uiStyles, 'person-media-caption')}>{m.caption}</div>
                </button>
              ))}
            </div>
            {filteredMedia.length > displayedMedia.length && (
              <div style={{ marginTop: 16, textAlign: 'center' }}>
                <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={onLoadMoreMedia}>
                  {KINLOOM_VOCABULARY.evidence.loadMoreMedia} ({filteredMedia.length - displayedMedia.length}{' '}
                  remaining)
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {mediaChecklist.length > 0 && (
        <section className={cx(uiStyles, 'place-map-box')} style={{ marginBottom: 0 }}>
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
            Cataloged media attachments for deceased ancestors whose image files have not yet been digitized.
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
                <div
                  key={`${item.person_id}-${item.obje_xref}`}
                  className={cx(uiStyles, 'evidence-source-row')}
                >
                  <div>
                    <strong style={{ fontSize: '0.94rem' }}>{item.title}</strong>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.78rem',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {item.person_name} ({item.lifespan}) · {item.media_type} · {item.form.toUpperCase()}
                    </div>
                  </div>
                  <Link
                    to={`/person/${item.person_slug}`}
                    className={cx(uiStyles, 'pill-btn')}
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
  );
};

export interface EvidenceMediaLightboxProps {
  readonly lightboxItem: MediaItem | null;
  readonly navMedia: readonly MediaItem[];
  readonly baseUrl?: string;
  readonly uiStyles: Readonly<Record<string, string>>;
  readonly onSetLightboxItem: React.Dispatch<React.SetStateAction<MediaItem | null>>;
}

export const EvidenceMediaLightbox: React.FC<EvidenceMediaLightboxProps> = ({
  lightboxItem,
  navMedia,
  baseUrl,
  uiStyles,
  onSetLightboxItem,
}) => {
  const lightboxCloseRef = useRef<HTMLButtonElement | null>(null);
  const lightboxDialogRef = useDialogFocusTrap({
    open: Boolean(lightboxItem),
    onClose: () => {
      onSetLightboxItem(null);
    },
    initialFocusRef: lightboxCloseRef,
  });

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
        onSetLightboxItem(navMedia[(idx + delta + navMedia.length) % navMedia.length]);
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [lightboxItem, navMedia, onSetLightboxItem]);

  if (!lightboxItem) {
    return null;
  }

  const curIdx = navMedia.findIndex((m) => m.id === lightboxItem.id);

  return (
    <dialog
      ref={lightboxDialogRef}
      open
      aria-modal="true"
      className={cx(uiStyles, 'lightbox-backdrop')}
      aria-label={lightboxItem.caption}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(uiStyles, 'lightbox-backdrop-close')}
        aria-label="Close lightbox"
        onClick={() => {
          onSetLightboxItem(null);
        }}
      />
      <div className={cx(uiStyles, 'scan-lightbox-card')}>
        <div className={cx(uiStyles, 'scan-lightbox-header')}>
          <div>
            <span
              className={cx(uiStyles, `media-kind-badge kind-${lightboxItem.kind}`)}
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
                  className={cx(uiStyles, 'pill-btn')}
                  onClick={() => {
                    onSetLightboxItem(navMedia[(curIdx - 1 + navMedia.length) % navMedia.length]);
                  }}
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  className={cx(uiStyles, 'pill-btn')}
                  onClick={() => {
                    onSetLightboxItem(navMedia[(curIdx + 1) % navMedia.length]);
                  }}
                >
                  Next →
                </button>
              </>
            )}
            {lightboxItem.person_slug && (
              <Link
                to={`/person/${lightboxItem.person_slug}`}
                className={cx(uiStyles, 'pill-btn')}
                style={{ textDecoration: 'none' }}
                onClick={() => {
                  onSetLightboxItem(null);
                }}
              >
                Open {lightboxItem.person_name || 'Person'} →
              </Link>
            )}
            <button
              ref={lightboxCloseRef}
              type="button"
              className={cx(uiStyles, 'pill-btn')}
              onClick={() => {
                onSetLightboxItem(null);
              }}
              aria-label="Close archival image lightbox"
            >
              Close [Esc]
            </button>
          </div>
        </div>
        <div className={cx(uiStyles, 'scan-lightbox-scroll')}>
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
};
