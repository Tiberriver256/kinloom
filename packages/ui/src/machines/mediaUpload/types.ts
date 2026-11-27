import type {
  ArchivalMediaKind,
  ArchiveDataSource,
  MediaAttachTargets,
  MediaItem,
  MediaValidationFailure,
} from '@kinloom/core';

export interface MediaUploadMetadata {
  kind: ArchivalMediaKind;
  caption: string;
  summary: string;
  dateEdtf?: string;
  provenance?: string;
}

export interface MediaUploadContext {
  uploadGen: number;
  cancelled: boolean;
  file: File | null;
  targets: MediaAttachTargets;
  targetHasLiving: boolean;
  allowAudioVideo: boolean;
  maxUploadBytes?: number;
  metadata: MediaUploadMetadata;
  sha256: string | null;
  r2Key: string | null;
  uploadedUrl: string | null;
  uploadedMedia: MediaItem | null;
  mediaId: string | null;
  rejectionReason: MediaValidationFailure | null;
  rejectionMessage: string | null;
  retryableError: string | null;
  dataSource?: ArchiveDataSource;
}

export type MediaUploadEvent =
  | {
      type: 'SELECT_FILE';
      file: File;
      targets: MediaAttachTargets;
      targetHasLiving: boolean;
      metadata?: Partial<MediaUploadMetadata>;
      allowAudioVideo?: boolean;
      maxUploadBytes?: number;
    }
  | { type: 'CANCEL' }
  | { type: 'RETRY' }
  | { type: 'RESET' };

export type UploadActorOutcome =
  | {
      kind: 'uploaded';
      uploadGen: number;
      r2Key: string;
      url?: string;
      media?: MediaItem;
    }
  | {
      kind: 'living_blocked';
      uploadGen: number;
      message: string;
    };

export type AttachActorOutcome =
  | {
      kind: 'attached';
      uploadGen: number;
      mediaId: string;
      targetBecameLiving: boolean;
    }
  | {
      kind: 'living_blocked';
      uploadGen: number;
      message: string;
    };

export interface MediaUploadInput {
  dataSource?: ArchiveDataSource;
  allowAudioVideo?: boolean;
  maxUploadBytes?: number;
}

export interface UploadMediaActorInput {
  file: File;
  sha256: string;
  targets: MediaAttachTargets;
  metadata: MediaUploadMetadata;
  uploadGen: number;
  dataSource?: ArchiveDataSource;
}

export interface AttachMediaActorInput {
  r2Key: string;
  sha256: string;
  targets: MediaAttachTargets;
  uploadedMedia: MediaItem | null;
  uploadGen: number;
}
