import type { MediaItem } from '@kinloom/core';
import { formatPublicProvenance } from '@kinloom/core';
import type React from 'react';
import { useEffect, useRef } from 'react';
import mediaGalleryStyles from '../../components/MediaGallery.module.css';
import { MediaPlayer } from '../../components/MediaPlayer.js';
import { useDialogFocusTrap } from '../../hooks/useDialogFocusTrap.js';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY, MEDIA_KIND_LABELS } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import overlayStyles from '../../styles/Overlays.module.css';
import type { PersonLightboxState } from './personViewModel.js';

export interface PersonMediaSectionProps {
  readonly personMedia: readonly MediaItem[];
  readonly baseUrl?: string;
  readonly showAllMedia: boolean;
  readonly onToggleShowAll: () => void;
  readonly onOpenGalleryIndex: (index: number) => void;
}

export const PersonMediaSection: React.FC<PersonMediaSectionProps> = ({
  personMedia,
  baseUrl,
  showAllMedia,
  onToggleShowAll,
  onOpenGalleryIndex,
}) => {
  if (personMedia.length === 0) {
    return null;
  }

  return (
    <section
      id="person-media"
      className={cx(mediaGalleryStyles, 'person-media-section')}
      aria-label={KINLOOM_VOCABULARY.person.photosAndDocumentsAria}
    >
      <div className={cx(mediaGalleryStyles, 'person-media-header')}>
        <h2>{KINLOOM_VOCABULARY.person.photosAndDocumentsHeading}</h2>
        {personMedia.length > 8 && (
          <button
            type="button"
            className={cx(controlStyles, 'pill-btn print-hide')}
            onClick={onToggleShowAll}
          >
            {showAllMedia ? 'Show Fewer' : `Show All ${personMedia.length}`}
          </button>
        )}
      </div>
      <div className={cx(mediaGalleryStyles, 'person-media-grid')}>
        {(showAllMedia ? personMedia : personMedia.slice(0, 8)).map((item, idx) => (
          <button
            key={item.id}
            type="button"
            className={cx(mediaGalleryStyles, 'person-media-card')}
            onClick={() => {
              onOpenGalleryIndex(idx);
            }}
          >
            <div className={cx(mediaGalleryStyles, 'person-media-thumb-wrap')}>
              <MediaPlayer media={item} baseUrl={baseUrl} variant="preview" />
            </div>
            <span className={cx(mediaGalleryStyles, 'person-media-caption')}>{item.caption}</span>
          </button>
        ))}
      </div>
    </section>
  );
};

export interface PersonMediaLightboxProps {
  readonly lightbox: PersonLightboxState;
  readonly personMedia: readonly MediaItem[];
  readonly baseUrl?: string;
  readonly onSetLightbox: React.Dispatch<React.SetStateAction<PersonLightboxState>>;
}

export const PersonMediaLightbox: React.FC<PersonMediaLightboxProps> = ({
  lightbox,
  personMedia,
  baseUrl,
  onSetLightbox,
}) => {
  const lightboxCloseBtnRef = useRef<HTMLButtonElement | null>(null);
  const lightboxDialogRef = useDialogFocusTrap({
    open: lightbox.kind !== 'closed',
    onClose: () => {
      onSetLightbox({ kind: 'closed' });
    },
    initialFocusRef: lightboxCloseBtnRef,
  });

  useEffect(() => {
    if (lightbox.kind === 'closed') {
      return undefined;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' && personMedia.length > 0) {
        onSetLightbox((prev) =>
          prev.kind === 'gallery' ? { kind: 'gallery', index: (prev.index + 1) % personMedia.length } : prev
        );
      } else if (e.key === 'ArrowLeft' && personMedia.length > 0) {
        onSetLightbox((prev) =>
          prev.kind === 'gallery'
            ? {
                kind: 'gallery',
                index: (prev.index - 1 + personMedia.length) % personMedia.length,
              }
            : prev
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [lightbox.kind, personMedia.length, onSetLightbox]);

  const activeLightboxMedia =
    lightbox.kind === 'gallery'
      ? (personMedia[lightbox.index] ?? null)
      : lightbox.kind === 'single'
        ? lightbox.media
        : null;

  if (!activeLightboxMedia) {
    return null;
  }

  return (
    <dialog
      ref={lightboxDialogRef}
      open
      aria-modal="true"
      className={cx(overlayStyles, 'lightbox-backdrop photo-lightbox-overlay print-hide')}
      aria-label={KINLOOM_VOCABULARY.person.mediaLightboxAria}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(overlayStyles, 'lightbox-backdrop-close')}
        aria-label="Close lightbox"
        onClick={() => {
          onSetLightbox({ kind: 'closed' });
        }}
      />
      <div className={cx(overlayStyles, 'scan-lightbox-card')}>
        <div className={cx(overlayStyles, 'scan-lightbox-header')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              className={cx(mediaGalleryStyles, `media-kind-badge kind-${activeLightboxMedia.kind}`)}
              style={{ position: 'static' }}
            >
              {MEDIA_KIND_LABELS[activeLightboxMedia.kind] || activeLightboxMedia.kind}
            </span>
            {lightbox.kind === 'gallery' && (
              <strong
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.78rem',
                  color: 'var(--text-inverse)',
                }}
              >
                {lightbox.index + 1} / {personMedia.length}
              </strong>
            )}
          </div>
          <div className={cx(mediaGalleryStyles, 'media-lightbox-nav')}>
            {lightbox.kind === 'gallery' && personMedia.length > 1 && (
              <>
                <button
                  type="button"
                  className={cx(controlStyles, 'pill-btn')}
                  onClick={() => {
                    onSetLightbox({
                      kind: 'gallery',
                      index: (lightbox.index - 1 + personMedia.length) % personMedia.length,
                    });
                  }}
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  className={cx(controlStyles, 'pill-btn')}
                  onClick={() => {
                    onSetLightbox({
                      kind: 'gallery',
                      index: (lightbox.index + 1) % personMedia.length,
                    });
                  }}
                >
                  Next →
                </button>
              </>
            )}
            <button
              ref={lightboxCloseBtnRef}
              type="button"
              className={cx(controlStyles, 'pill-btn')}
              onClick={() => {
                onSetLightbox({ kind: 'closed' });
              }}
            >
              Close [Esc]
            </button>
          </div>
        </div>
        <div className={cx(overlayStyles, 'scan-lightbox-scroll')}>
          <MediaPlayer media={activeLightboxMedia} baseUrl={baseUrl} variant="full" />
          <div style={{ marginTop: 12, padding: '8px 4px' }}>
            <div
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: '1.05rem',
                color: 'var(--surface-header)',
                fontWeight: 600,
              }}
            >
              {activeLightboxMedia.caption}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.74rem',
                color: 'var(--text-secondary)',
                marginTop: 4,
              }}
            >
              {activeLightboxMedia.date_edtf ? `Date: ${activeLightboxMedia.date_edtf} · ` : ''}
              {formatPublicProvenance(activeLightboxMedia.provenance)}
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
};
