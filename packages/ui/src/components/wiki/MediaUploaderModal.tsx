import type { ArchivalMediaKind } from '@kinloom/core';
import React, { useEffect, useState } from 'react';
import { mediaUploadMachine } from '../../machines/mediaUploadMachine.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useMachine } from '@xstate/react';

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
  const [summary, setSummary] = useState('Upload archival media');

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

  if (!open) {
    return null;
  }

  const targetPerson = personId ? peopleById.get(personId) : undefined;
  const targetIsLiving = Boolean(targetPerson?.is_living);
  const isBusy = snapshot.hasTag('busy');
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
    <dialog open className="lightbox-backdrop" aria-label="Upload archival media">
      <button
        type="button"
        className="lightbox-backdrop-close"
        aria-label="Close media uploader"
        onClick={() => {
          if (isBusy) {
            send({ type: 'CANCEL' });
          }
          onClose();
        }}
      />
      <div className="wiki-modal-card">
        <div className="wiki-modal-header">
          <h2>Upload Archival Media</h2>
          <button
            type="button"
            className="pill-btn"
            onClick={() => {
              if (isBusy) {
                send({ type: 'CANCEL' });
              }
              onClose();
            }}
          >
            Close
          </button>
        </div>

        {targetIsLiving && (
          <div className="wiki-status-banner is-warning" role="alert">
            <strong>Living-person privacy rule:</strong> Portraits and photographs cannot be
            attached to living relatives. Choose a deceased ancestor or historical record instead.
          </div>
        )}

        {isBusy && (
          <output className="wiki-status-banner is-info" aria-live="polite">
            <div>
              {snapshot.matches('hashingSha256') && 'Computing SHA-256 archival digest…'}
              {snapshot.matches('uploading') && 'Uploading content-addressed file to archive…'}
              {snapshot.matches('attaching') && 'Attaching media record to archive ledger…'}
            </div>
            <button
              type="button"
              className="pill-btn"
              onClick={() => {
                send({ type: 'CANCEL' });
              }}
            >
              Cancel Upload
            </button>
          </output>
        )}

        {isRejected && (
          <div className="wiki-status-banner is-error" role="alert">
            <strong>Upload blocked:</strong>{' '}
            {snapshot.context.rejectionMessage ?? 'File failed archival upload validation.'}
            <div className="wiki-inline-actions" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="pill-btn"
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
          <div className="wiki-status-banner is-error" role="alert">
            <div>
              <strong>Upload interrupted:</strong> {snapshot.context.retryableError}
            </div>
            <div className="wiki-inline-actions" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="pill-btn active"
                onClick={() => {
                  send({ type: 'RETRY' });
                }}
              >
                Retry
              </button>
              <button
                type="button"
                className="pill-btn"
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
          <output className="wiki-status-banner is-success" aria-live="polite">
            <div>
              Uploaded and attached media <code>{snapshot.context.mediaId}</code>
              {snapshot.context.sha256 ? ` (SHA-256 ${snapshot.context.sha256.slice(0, 12)}…)` : ''}.
            </div>
            <div className="wiki-inline-actions">
              <button
                type="button"
                className="pill-btn"
                onClick={() => {
                  setSelectedFile(null);
                  setCaption('');
                  send({ type: 'RESET' });
                }}
              >
                Upload Another
              </button>
              <button type="button" className="pill-btn active" onClick={onClose}>
                Done
              </button>
            </div>
          </output>
        )}

        <form className="wiki-edit-form" onSubmit={handleStartUpload}>
          <label className="wiki-field">
            <span className="wiki-field-label">
              File (JPEG, PNG, WebP, PDF{allowAudioVideo ? ', MP4, WebM, MP3, M4A, OGG, WAV' : ''})
            </span>
            <input
              type="file"
              accept={acceptAttr}
              className="wiki-input"
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

          <div className="wiki-field-grid">
            <label className="wiki-field">
              <span className="wiki-field-label">Media category</span>
              <select
                className="wiki-input"
                value={kind}
                disabled={isBusy}
                onChange={(e) => {
                  setKind(e.target.value as ArchivalMediaKind);
                }}
              >
                <option value="portrait">Portrait</option>
                <option value="family_photo">Family Photo</option>
                <option value="record_scan">Primary Record Scan</option>
                <option value="headstone">Headstone</option>
                <option value="document_scan">Document Scan</option>
                <option value="milestone">Milestone Photo</option>
                {allowAudioVideo && <option value="video_story">Video Story</option>}
                {allowAudioVideo && <option value="audio_oral_history">Audio Oral History</option>}
              </select>
            </label>

            <label className="wiki-field">
              <span className="wiki-field-label">Attach to relative (deceased only)</span>
              <select
                className="wiki-input"
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

            <label className="wiki-field wiki-field-full">
              <span className="wiki-field-label">Caption</span>
              <input
                type="text"
                className="wiki-input"
                placeholder="Describe who or what appears in this media"
                value={caption}
                disabled={isBusy}
                onChange={(e) => {
                  setCaption(e.target.value);
                }}
              />
            </label>

            <label className="wiki-field">
              <span className="wiki-field-label">Date (EDTF, optional)</span>
              <input
                type="text"
                className="wiki-input"
                placeholder="e.g. 1918~"
                value={dateEdtf}
                disabled={isBusy}
                onChange={(e) => {
                  setDateEdtf(e.target.value);
                }}
              />
            </label>

            <label className="wiki-field">
              <span className="wiki-field-label">Edit summary</span>
              <input
                type="text"
                className="wiki-input"
                value={summary}
                disabled={isBusy}
                onChange={(e) => {
                  setSummary(e.target.value);
                }}
              />
            </label>
          </div>

          <div className="wiki-form-actions">
            <button
              type="submit"
              className="pill-btn active"
              disabled={!selectedFile || isBusy}
            >
              {isBusy ? 'Uploading…' : 'Hash & Upload'}
            </button>
            <button type="button" className="pill-btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};
