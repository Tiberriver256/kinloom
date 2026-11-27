import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { cx, joinClasses } from '../lib/cx.js';
import {
  DEFAULT_IMAGE_UPLOAD_MAX_BYTES,
  DEFAULT_IMAGE_UPLOAD_MIMES,
  validateImageUploadCandidates,
} from '../lib/lightboxModel.js';
import primitiveStyles from './ArchivalPrimitives.module.css';

export interface ArchivalFileDropzoneProps {
  readonly accept?: string;
  readonly allowedMimes?: readonly string[];
  readonly maxBytes?: number;
  readonly multiple?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly progressLabel?: string | null;
  readonly label?: string;
  readonly hint?: string;
  readonly onFilesAccepted: (files: readonly File[]) => void;
  readonly onFilesRejected?: (errors: readonly string[]) => void;
  readonly className?: string;
}

/**
 * Accessible drag-and-drop + file-picker input for archival image uploads.
 * Performs client-side MIME and size pre-validation before handing files to the caller.
 */
export const ArchivalFileDropzone: React.FC<ArchivalFileDropzoneProps> = ({
  accept = 'image/jpeg,image/png,image/webp',
  allowedMimes = DEFAULT_IMAGE_UPLOAD_MIMES,
  maxBytes = DEFAULT_IMAGE_UPLOAD_MAX_BYTES,
  multiple = true,
  disabled = false,
  busy = false,
  progressLabel = null,
  label = 'Upload recipe card photos',
  hint = 'Drop JPEG, PNG, or WebP images here, or select files from your device.',
  onFilesAccepted,
  onFilesRejected,
  className,
}) => {
  const inputId = useId();
  const hintId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const isDisabled = disabled || busy;

  const processFileListRef = useRef<(fileList: FileList | readonly File[] | null) => void>(() => {});
  processFileListRef.current = (fileList: FileList | readonly File[] | null): void => {
    if (!fileList || fileList.length === 0) {
      return;
    }
    const candidates = Array.from(fileList);
    const { accepted, errors } = validateImageUploadCandidates(candidates, {
      allowedMimes,
      maxBytes,
    });
    if (errors.length > 0) {
      onFilesRejected?.(errors);
    }
    if (accepted.length > 0) {
      onFilesAccepted(accepted);
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return undefined;
    }

    const handleDragOver = (event: DragEvent): void => {
      event.preventDefault();
      if (!isDisabled) {
        setDragActive(true);
      }
    };
    const handleDragLeave = (event: DragEvent): void => {
      event.preventDefault();
      setDragActive(false);
    };
    const handleDrop = (event: DragEvent): void => {
      event.preventDefault();
      setDragActive(false);
      if (isDisabled) {
        return;
      }
      processFileListRef.current(event.dataTransfer?.files ?? null);
    };

    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('dragleave', handleDragLeave);
    el.addEventListener('drop', handleDrop);

    return (): void => {
      el.removeEventListener('dragover', handleDragOver);
      el.removeEventListener('dragleave', handleDragLeave);
      el.removeEventListener('drop', handleDrop);
    };
  }, [isDisabled]);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    processFileListRef.current(event.target.files);
    event.target.value = '';
  };

  return (
    <div
      ref={containerRef}
      className={joinClasses(
        cx(primitiveStyles, dragActive ? 'archival-dropzone archival-dropzone-active' : 'archival-dropzone'),
        className
      )}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={isDisabled}
        aria-describedby={hintId}
        className={cx(primitiveStyles, 'archival-dropzone-input')}
        onChange={handleInputChange}
      />
      <div className={cx(primitiveStyles, 'archival-dropzone-copy')}>
        <label htmlFor={inputId} className={cx(primitiveStyles, 'archival-dropzone-title')}>
          {label}
        </label>
        <p id={hintId} className={cx(primitiveStyles, 'archival-dropzone-hint')}>
          {hint}
        </p>
      </div>
      <div className={cx(primitiveStyles, 'archival-dropzone-actions')}>
        <button
          type="button"
          className={cx(primitiveStyles, 'archival-dropzone-btn')}
          disabled={isDisabled}
          onClick={() => {
            inputRef.current?.click();
          }}
        >
          {busy ? 'Uploading…' : 'Choose Image Files'}
        </button>
      </div>
      {progressLabel && (
        <output aria-live="polite" className={cx(primitiveStyles, 'archival-dropzone-status')}>
          {progressLabel}
        </output>
      )}
    </div>
  );
};
