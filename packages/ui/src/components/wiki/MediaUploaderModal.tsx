import type { ArchivalMediaKind } from '@kinloom/core';
import { useMachine } from '@xstate/react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import { useDialogFocusTrap } from '../../lib/useDialogFocusTrap.js';
import { KINLOOM_VOCABULARY, MEDIA_KIND_LABELS } from '../../lib/vocabulary.js';
import { mediaUploadMachine } from '../../machines/mediaUploadMachine.js';
import cssMod2 from '../../pages/IndexPage.module.css';
import cssMod0 from '../SourceReaderDrawer.module.css';
import cssMod1 from './WikiSurfaces.module.css';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod1, ...cssMod2 };

export interface MediaUploaderModalProps {
  open: boolean;
  defaultPersonId?: string;
  defaultEventId?: string;
  allowAudioVideo?: boolean;
  onClose: () => void;
  onUploaded?: (mediaId: string) => void;
}

export const MediaUploaderModal: React.FC<MediaUploaderModalProps> = ({
  open,
  defaultPersonId,
  defaultEventId,
  allowAudioVideo = true,
  onClose,
  onUploaded,
}) => {
  const { dataSource, bundle, peopleById, siteConfig, reloadArchive } = useArchiveData();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [personId, setPersonId] = useState(defaultPersonId ?? '');
  const [kind, setKind] = useState<ArchivalMediaKind>('family_photo');
  const [caption, setCaption] = useState('');
  const [dateEdtf, setDateEdtf] = useState('');
  const [summary, setSummary] = useState('Added family photo');

  const [snapshot, send] = useMachine(mediaUploadMachine, {
    input: {
      dataSource,
      allowAudioVideo,
      maxUploadBytes: siteConfig.wiki?.maxUploadBytes,
    },
  });

  useEffect(() => {
    if (snapshot.matches('complete') && snapshot.context.mediaId) {
      reloadArchive();
      onUploaded?.(snapshot.context.mediaId);
    }
  }, [snapshot, reloadArchive, onUploaded]);

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const isBusy = snapshot.hasTag('busy');

  const handleClose = useCallback((): void => {
    if (isBusy) {
      send({ type: 'CANCEL' });
    }
    onClose();
  }, [isBusy, send, onClose]);

  const dialogRef = useDialogFocusTrap({
    open,
    onClose: handleClose,
    initialFocusRef: closeBtnRef,
  });

  if (!open) {
    return null;
  }

  const targetPerson = personId ? peopleById.get(personId) : undefined;
  const targetIsLiving = Boolean(targetPerson?.is_living);
  const isComplete = snapshot.matches('complete');
  const isRejected = snapshot.matches('rejectedInvalid');
  const isRetryable = snapshot.matches('failedRetryable');

  const acceptAttr = allowAudioVideo
    ? 'image/jpeg,image/png,image/webp,application/pdf,video/mp4,video/webm,audio/mpeg,audio/mp4,audio/ogg,audio/wav'
    : 'image/jpeg,image/png,image/webp,application/pdf';

  const handleStartUpload = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!selectedFile) {
      return;
    }
    send({
      type: 'SELECT_FILE',
      file: selectedFile,
      targets: {
        personIds: personId ? [personId] : [],
        eventId: defaultEventId ?? null,
      },
      targetHasLiving: targetIsLiving,
      allowAudioVideo,
      metadata: {
        kind,
        caption: caption.trim() || selectedFile.name,
        summary: summary.trim() || `Upload ${selectedFile.name}`,
        dateEdtf: dateEdtf.trim() || undefined,
      },
    });
  };

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className={cx(uiStyles, 'lightbox-backdrop')}
      aria-label={KINLOOM_VOCABULARY.wiki.uploadDialogAria}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(uiStyles, 'lightbox-backdrop-close')}
        aria-label="Close media uploader"
        onClick={handleClose}
      />
      <div className={cx(uiStyles, 'wiki-modal-card')}>
        <div className={cx(uiStyles, 'wiki-modal-header')}>
          <h2>{KINLOOM_VOCABULARY.wiki.uploadDialogTitle}</h2>
          <button ref={closeBtnRef} type="button" className={cx(uiStyles, 'pill-btn')} onClick={handleClose}>
            Close
          </button>
        </div>

        {targetIsLiving && (
          <div className={cx(uiStyles, 'wiki-status-banner is-warning')} role="alert">
            <p>
              <strong>{KINLOOM_VOCABULARY.wiki.livingPrivacyRuleTitle}</strong> Portraits and photographs
              cannot be attached to living people. Choose a deceased ancestor or historical record instead.
            </p>
          </div>
        )}

        {isBusy && (
          <output className={cx(uiStyles, 'wiki-status-banner is-info')} aria-live="polite">
            <p>
              {snapshot.matches('hashingSha256') && 'Preparing file for upload…'}
              {snapshot.matches('uploading') && 'Uploading file to the family archive…'}
              {snapshot.matches('attaching') && 'Saving photo to the archive…'}
            </p>
            <button
              type="button"
              className={cx(uiStyles, 'pill-btn')}
              onClick={() => {
                send({ type: 'CANCEL' });
              }}
            >
              Cancel Upload
            </button>
          </output>
        )}

        {isRejected && (
          <div className={cx(uiStyles, 'wiki-status-banner is-error')} role="alert">
            <p>
              <strong>Upload blocked:</strong>{' '}
              {snapshot.context.rejectionMessage ?? 'File failed archival upload validation.'}
            </p>
            <div className={cx(uiStyles, 'wiki-inline-actions')} style={{ marginTop: 6 }}>
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn')}
                onClick={() => {
                  send({ type: 'RESET' });
                }}
              >
                Choose Another File
              </button>
            </div>
          </div>
        )}

        {isRetryable && (
          <div className={cx(uiStyles, 'wiki-status-banner is-error')} role="alert">
            <div>
              <strong>Upload interrupted:</strong> {snapshot.context.retryableError}
            </div>
            <div className={cx(uiStyles, 'wiki-inline-actions')} style={{ marginTop: 6 }}>
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn active')}
                onClick={() => {
                  send({ type: 'RETRY' });
                }}
              >
                Retry
              </button>
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn')}
                onClick={() => {
                  send({ type: 'CANCEL' });
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {isComplete && (
          <output className={cx(uiStyles, 'wiki-status-banner is-success')} aria-live="polite">
            <div>Uploaded and attached media to the archive.</div>
            <div className={cx(uiStyles, 'wiki-inline-actions')}>
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn')}
                onClick={() => {
                  setSelectedFile(null);
                  setCaption('');
                  send({ type: 'RESET' });
                }}
              >
                Upload Another
              </button>
              <button type="button" className={cx(uiStyles, 'pill-btn active')} onClick={onClose}>
                Done
              </button>
            </div>
          </output>
        )}

        <form className={cx(uiStyles, 'wiki-edit-form')} onSubmit={handleStartUpload}>
          <label className={cx(uiStyles, 'wiki-field')}>
            <span className={cx(uiStyles, 'wiki-field-label')}>
              Choose a photo, document{allowAudioVideo ? ', or video' : ''}
            </span>
            <input
              type="file"
              accept={acceptAttr}
              className={cx(uiStyles, 'wiki-input')}
              disabled={isBusy}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setSelectedFile(file);
                if (file && !caption) {
                  setCaption(file.name.replace(/\.[^.]+$/, '').replaceAll(/[-_]+/g, ' '));
                }
                if (file?.type.startsWith('video/')) {
                  setKind('video_story');
                } else if (file?.type.startsWith('audio/')) {
                  setKind('audio_oral_history');
                }
              }}
            />
          </label>

          <div className={cx(uiStyles, 'wiki-field-grid')}>
            <label className={cx(uiStyles, 'wiki-field')}>
              <span className={cx(uiStyles, 'wiki-field-label')}>Type of item</span>
              <select
                className={cx(uiStyles, 'wiki-input')}
                value={kind}
                disabled={isBusy}
                onChange={(e) => {
                  setKind(e.target.value as ArchivalMediaKind);
                }}
              >
                <option value="portrait">{MEDIA_KIND_LABELS.portrait}</option>
                <option value="family_photo">{MEDIA_KIND_LABELS.family_photo}</option>
                <option value="record_scan">{MEDIA_KIND_LABELS.record_scan}</option>
                <option value="headstone">{MEDIA_KIND_LABELS.headstone}</option>
                <option value="document_scan">{MEDIA_KIND_LABELS.document_scan}</option>
                <option value="milestone">{MEDIA_KIND_LABELS.milestone}</option>
                {allowAudioVideo && <option value="video_story">{MEDIA_KIND_LABELS.video_story}</option>}
                {allowAudioVideo && (
                  <option value="audio_oral_history">{MEDIA_KIND_LABELS.audio_oral_history}</option>
                )}
              </select>
            </label>

            <label className={cx(uiStyles, 'wiki-field')}>
              <span className={cx(uiStyles, 'wiki-field-label')}>Who is in this photo? (deceased only)</span>
              <select
                className={cx(uiStyles, 'wiki-input')}
                value={personId}
                disabled={isBusy}
                onChange={(e) => {
                  setPersonId(e.target.value);
                }}
              >
                <option value="">General archive media</option>
                {(bundle?.people ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name}
                    {p.is_living ? ' (Living — blocked)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
              <span className={cx(uiStyles, 'wiki-field-label')}>Caption</span>
              <input
                type="text"
                className={cx(uiStyles, 'wiki-input')}
                placeholder="Describe who or what appears in this photo"
                value={caption}
                disabled={isBusy}
                onChange={(e) => {
                  setCaption(e.target.value);
                }}
              />
            </label>

            <label className={cx(uiStyles, 'wiki-field')}>
              <span className={cx(uiStyles, 'wiki-field-label')}>Approximate date (optional)</span>
              <input
                type="text"
                className={cx(uiStyles, 'wiki-input')}
                placeholder="e.g. 1918 or 1945-06"
                value={dateEdtf}
                disabled={isBusy}
                onChange={(e) => {
                  setDateEdtf(e.target.value);
                }}
              />
            </label>

            <label className={cx(uiStyles, 'wiki-field')}>
              <span className={cx(uiStyles, 'wiki-field-label')}>Short note</span>
              <input
                type="text"
                className={cx(uiStyles, 'wiki-input')}
                value={summary}
                disabled={isBusy}
                onChange={(e) => {
                  setSummary(e.target.value);
                }}
              />
            </label>
          </div>

          <div className={cx(uiStyles, 'wiki-form-actions')}>
            <button
              type="submit"
              className={cx(uiStyles, 'wiki-btn-primary wiki-btn-sm')}
              disabled={!selectedFile || isBusy}
            >
              {isBusy ? 'Uploading…' : 'Upload Photo'}
            </button>
            <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};
