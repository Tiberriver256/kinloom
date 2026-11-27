import React, { useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useDialogFocusTrap } from '../../hooks/useDialogFocusTrap.js';
import { cx } from '../../lib/cx.js';
import controlStyles from '../../styles/Controls.module.css';
import overlayStyles from '../../styles/Overlays.module.css';
import atomStyles from '../Atoms.module.css';
import { resolveAssetUrl } from './formatters.js';

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
        className={cx(
          atomStyles,
          `wireframe-photo photo-placeholder-frame ${resolvedUrl ? 'has-real-photo' : ''}`
        )}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {resolvedUrl ? (
          <>
            <img
              src={resolvedUrl}
              alt={caption}
              className={cx(atomStyles, 'milestone-photo-img')}
              loading="lazy"
            />
            <span className={cx(atomStyles, 'wireframe-photo-caption')}>{caption}</span>
          </>
        ) : (
          <>
            <span className={cx(atomStyles, 'wireframe-photo-label')}>
              Archival Photograph Needed · Click for Details
            </span>
            <span className={cx(atomStyles, 'wireframe-photo-caption')}>{caption}</span>
          </>
        )}
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          open
          aria-modal="true"
          className={cx(overlayStyles, 'lightbox-backdrop photo-lightbox-overlay')}
          aria-label="Archival photograph lightbox"
        >
          <button
            type="button"
            tabIndex={-1}
            className={cx(overlayStyles, 'lightbox-backdrop-close')}
            aria-label="Close archival photograph lightbox"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className={cx(overlayStyles, 'lightbox-card')}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <strong
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.82rem',
                  color: 'var(--surface-header)',
                }}
              >
                {resolvedUrl ? 'ARCHIVAL PHOTOGRAPH · ZOOM VIEW' : 'ARCHIVAL PHOTOGRAPH NEEDED'}
              </strong>
              <button
                ref={closeBtnRef}
                type="button"
                className={cx(controlStyles, 'pill-btn')}
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
                  style={{
                    width: '100%',
                    maxHeight: '72vh',
                    objectFit: 'contain',
                    borderRadius: 2,
                    border: '1px solid var(--border-decorative)',
                  }}
                />
                <figcaption
                  style={{
                    marginTop: 8,
                    fontSize: '0.85rem',
                    color: 'var(--text-secondary)',
                    fontStyle: 'italic',
                  }}
                >
                  {caption}
                </figcaption>
              </figure>
            ) : (
              <div
                className={cx(atomStyles, 'wireframe-photo')}
                style={{ minHeight: 180, cursor: 'default' }}
              >
                <span className={cx(atomStyles, 'wireframe-photo-label')}>No Photograph Archived Yet</span>
                <span className={cx(atomStyles, 'wireframe-photo-caption')}>{caption}</span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.78rem',
                    color: 'var(--text-secondary)',
                    marginTop: 8,
                  }}
                >
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
