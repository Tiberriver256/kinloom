import React, { useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import { useDialogFocusTrap } from '../../lib/useDialogFocusTrap.js';
import cssMod3 from '../../pages/IndexPage.module.css';
import cssMod0 from '../Atoms.module.css';
import cssMod2 from '../SourceReaderDrawer.module.css';
import { resolveAssetUrl } from './formatters.js';

const uiStyles: Readonly<Record<string, string>> = {
  ...cssMod0,
  ...cssMod2,
  ...cssMod3,
};

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
          uiStyles,
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
              className={cx(uiStyles, 'milestone-photo-img')}
              loading="lazy"
            />
            <span className={cx(uiStyles, 'wireframe-photo-caption')}>{caption}</span>
          </>
        ) : (
          <>
            <span className={cx(uiStyles, 'wireframe-photo-label')}>
              Archival Photograph Needed · Click for Details
            </span>
            <span className={cx(uiStyles, 'wireframe-photo-caption')}>{caption}</span>
          </>
        )}
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          open
          aria-modal="true"
          className={cx(uiStyles, 'lightbox-backdrop photo-lightbox-overlay')}
          aria-label="Archival photograph lightbox"
        >
          <button
            type="button"
            tabIndex={-1}
            className={cx(uiStyles, 'lightbox-backdrop-close')}
            aria-label="Close archival photograph lightbox"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className={cx(uiStyles, 'lightbox-card')}>
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
                className={cx(uiStyles, 'pill-btn')}
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
              <div className={cx(uiStyles, 'wireframe-photo')} style={{ minHeight: 180, cursor: 'default' }}>
                <span className={cx(uiStyles, 'wireframe-photo-label')}>No Photograph Archived Yet</span>
                <span className={cx(uiStyles, 'wireframe-photo-caption')}>{caption}</span>
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
