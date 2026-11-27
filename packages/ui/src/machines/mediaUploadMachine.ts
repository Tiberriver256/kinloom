import type {
  ArchivalMediaKind,
  ArchiveDataSource,
  MediaAttachTargets,
  MediaItem,
  MediaValidationFailure,
} from '@kinloom/core';
import { canCompleteMediaAttach, isMatchingUploadGeneration, validateMediaSelection } from '@kinloom/core';
import { assign, fromPromise, setup } from 'xstate';
import { ApiClientError } from '../adapters/httpWikiDataSource.js';

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

const DEFAULT_METADATA: MediaUploadMetadata = {
  kind: 'family_photo',
  caption: '',
  summary: 'Upload archival media',
};

function isLivingMediaBlockedError(error: unknown): { blocked: true; message: string } | { blocked: false } {
  if (error instanceof ApiClientError) {
    if (
      error.status === 422 &&
      (error.code === 'LIVING_MEDIA_FORBIDDEN' ||
        error.code === 'LIVING_PRIVACY_BLOCKED' ||
        error.code === 'PRIVACY_VIOLATION')
    ) {
      return { blocked: true, message: error.message };
    }
  }
  return { blocked: false };
}

export const defaultHashFileSha256 = fromPromise<string, { file: File }>(async ({ input }) => {
  const buffer = await input.file.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('WebCrypto SHA-256 unavailable in this environment.');
});

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

export const defaultUploadMediaActor = fromPromise<UploadActorOutcome, UploadMediaActorInput>(
  async ({ input, signal }) => {
    const form = new FormData();
    form.append('file', input.file);
    form.append('sha256', input.sha256);
    form.append(
      'metadata',
      JSON.stringify({
        kind: input.metadata.kind,
        caption: input.metadata.caption || input.file.name,
        person_ids: [...input.targets.personIds],
        person_id: input.targets.personIds[0] ?? null,
        event_id: input.targets.eventId ?? null,
        source_id: input.targets.sourceId ?? null,
        date_edtf: input.metadata.dateEdtf || undefined,
        provenance: input.metadata.provenance || undefined,
        mime_type: input.file.type || undefined,
      })
    );
    form.append('summary', input.metadata.summary.trim() || `Upload ${input.file.name}`);

    if (input.dataSource?.uploadMedia) {
      try {
        const uploaded = await input.dataSource.uploadMedia(form, { signal });
        return {
          kind: 'uploaded',
          uploadGen: input.uploadGen,
          r2Key: uploaded.url,
          url: uploaded.url,
          media: uploaded.media,
        };
      } catch (error) {
        const livingCheck = isLivingMediaBlockedError(error);
        if (livingCheck.blocked) {
          return {
            kind: 'living_blocked',
            uploadGen: input.uploadGen,
            message: livingCheck.message,
          };
        }
        throw error;
      }
    }

    const res = await fetch('/api/media/upload', {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
      signal,
    });

    if (res.status === 422) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: string };
        message?: string;
      };
      return {
        kind: 'living_blocked',
        uploadGen: input.uploadGen,
        message: body.error?.message ?? body.message ?? 'Media cannot be attached to living relatives.',
      };
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} uploading media`);
    }

    const data = (await res.json()) as { media?: MediaItem; url?: string; r2Key?: string };
    return {
      kind: 'uploaded',
      uploadGen: input.uploadGen,
      r2Key: data.r2Key ?? data.url ?? `media/${input.sha256}`,
      url: data.url,
      media: data.media,
    };
  }
);

export const defaultAttachMediaActor = fromPromise<AttachActorOutcome, AttachMediaActorInput>(
  async ({ input, signal }) => {
    // Single-request Worker `/api/media/upload` creates and attaches the media entity atomically.
    if (input.uploadedMedia) {
      return {
        kind: 'attached',
        uploadGen: input.uploadGen,
        mediaId: input.uploadedMedia.id,
        targetBecameLiving: false,
      };
    }

    const res = await fetch('/api/media/attach', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        r2Key: input.r2Key,
        sha256: input.sha256,
        targets: input.targets,
      }),
      signal,
    });

    if (res.status === 422) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
        message?: string;
      };
      return {
        kind: 'living_blocked',
        uploadGen: input.uploadGen,
        message: body.error?.message ?? body.message ?? 'Media cannot be attached to living relatives.',
      };
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} attaching media`);
    }

    const ok = (await res.json()) as { media_id: string; target_became_living?: boolean };
    return {
      kind: 'attached',
      uploadGen: input.uploadGen,
      mediaId: ok.media_id,
      targetBecameLiving: Boolean(ok.target_became_living),
    };
  }
);

function readUploadOutput(event: unknown): UploadActorOutcome | null {
  if (typeof event !== 'object' || event === null || !('output' in event)) {
    return null;
  }
  const output = (event as { output: unknown }).output;
  if (typeof output !== 'object' || output === null || !('kind' in output)) {
    return null;
  }
  const kind = (output as { kind: unknown }).kind;
  if (kind === 'uploaded' || kind === 'living_blocked') {
    return output as UploadActorOutcome;
  }
  return null;
}

function readAttachOutput(event: unknown): AttachActorOutcome | null {
  if (typeof event !== 'object' || event === null || !('output' in event)) {
    return null;
  }
  const output = (event as { output: unknown }).output;
  if (typeof output !== 'object' || output === null || !('kind' in output)) {
    return null;
  }
  const kind = (output as { kind: unknown }).kind;
  if (kind === 'attached' || kind === 'living_blocked') {
    return output as AttachActorOutcome;
  }
  return null;
}

export const mediaUploadMachine = setup({
  types: {
    context: {} as MediaUploadContext,
    events: {} as MediaUploadEvent,
    input: {} as MediaUploadInput | undefined,
  },
  actors: {
    hashFileSha256: defaultHashFileSha256,
    uploadMedia: defaultUploadMediaActor,
    attachMedia: defaultAttachMediaActor,
  },
  guards: {
    isClientInvalid: ({ context }) => context.rejectionReason !== null,
    alreadyUploaded: ({ context }) => context.r2Key !== null,
    isUploadLivingBlocked: ({ event }) => {
      const output = readUploadOutput(event);
      return output !== null && output.kind === 'living_blocked';
    },
    isUploadSuccessMatchingGen: ({ context, event }) => {
      const output = readUploadOutput(event);
      return (
        output !== null &&
        output.kind === 'uploaded' &&
        isMatchingUploadGeneration({
          activeUploadGen: context.uploadGen,
          eventUploadGen: output.uploadGen,
          cancelled: context.cancelled,
        })
      );
    },
    isAttachLivingBlocked: ({ event }) => {
      const output = readAttachOutput(event);
      return (
        output !== null &&
        (output.kind === 'living_blocked' || (output.kind === 'attached' && output.targetBecameLiving))
      );
    },
    canCompleteAttach: ({ context, event }) => {
      const output = readAttachOutput(event);
      return (
        output !== null &&
        output.kind === 'attached' &&
        canCompleteMediaAttach({
          activeUploadGen: context.uploadGen,
          eventUploadGen: output.uploadGen,
          cancelled: context.cancelled,
          targetHasLiving: context.targetHasLiving,
          targetBecameLiving: output.targetBecameLiving,
        })
      );
    },
  },
  actions: {
    captureFileSelection: assign(({ context, event }) => {
      if (event.type !== 'SELECT_FILE') {
        return {};
      }
      const allowAudioVideo = event.allowAudioVideo ?? context.allowAudioVideo;
      const maxUploadBytes = event.maxUploadBytes ?? context.maxUploadBytes;
      const check = validateMediaSelection({
        mimeType: event.file.type,
        sizeBytes: event.file.size,
        targetHasLiving: event.targetHasLiving,
        allowAudioVideo,
        maxUploadBytes,
      });
      return {
        uploadGen: context.uploadGen + 1,
        cancelled: false,
        file: event.file,
        targets: event.targets,
        targetHasLiving: event.targetHasLiving,
        allowAudioVideo,
        maxUploadBytes,
        metadata: {
          ...DEFAULT_METADATA,
          ...event.metadata,
          caption: event.metadata?.caption || event.file.name,
        },
        sha256: null,
        r2Key: null,
        uploadedUrl: null,
        uploadedMedia: null,
        mediaId: null,
        rejectionReason: check.ok ? null : check.reason,
        rejectionMessage: check.ok ? null : check.message,
        retryableError: null,
      };
    }),
    cancelAndReset: assign(({ context }) => ({
      uploadGen: context.uploadGen + 1,
      cancelled: true,
      file: null,
      targets: { personIds: [] },
      targetHasLiving: false,
      sha256: null,
      r2Key: null,
      uploadedUrl: null,
      uploadedMedia: null,
      mediaId: null,
      rejectionReason: null,
      rejectionMessage: null,
      retryableError: null,
    })),
    resetUpload: assign(() => ({
      cancelled: false,
      file: null,
      targets: { personIds: [] },
      targetHasLiving: false,
      sha256: null,
      r2Key: null,
      uploadedUrl: null,
      uploadedMedia: null,
      mediaId: null,
      rejectionReason: null,
      rejectionMessage: null,
      retryableError: null,
    })),
  },
}).createMachine({
  id: 'mediaUpload',
  initial: 'idle',
  context: ({ input }) => ({
    uploadGen: 0,
    cancelled: false,
    file: null,
    targets: { personIds: [] },
    targetHasLiving: false,
    allowAudioVideo: input?.allowAudioVideo ?? true,
    maxUploadBytes: input?.maxUploadBytes,
    metadata: DEFAULT_METADATA,
    sha256: null,
    r2Key: null,
    uploadedUrl: null,
    uploadedMedia: null,
    mediaId: null,
    rejectionReason: null,
    rejectionMessage: null,
    retryableError: null,
    dataSource: input?.dataSource,
  }),
  states: {
    idle: {
      tags: ['idle'],
      on: {
        SELECT_FILE: {
          target: 'clientValidating',
          actions: [{ type: 'captureFileSelection' }],
        },
      },
    },
    clientValidating: {
      always: [{ guard: 'isClientInvalid', target: 'rejectedInvalid' }, { target: 'hashingSha256' }],
    },
    hashingSha256: {
      tags: ['busy', 'hashing'],
      invoke: {
        id: 'hashFileSha256',
        src: 'hashFileSha256',
        input: ({ context }) => ({ file: context.file as File }),
        onDone: {
          target: 'uploading',
          actions: assign(({ event }) => ({ sha256: event.output })),
        },
        onError: {
          target: 'rejectedInvalid',
          actions: assign(({ event }) => ({
            rejectionReason: 'hash_failed' as const,
            rejectionMessage:
              event.error instanceof Error ? event.error.message : 'Failed to hash file with SHA-256.',
          })),
        },
      },
      on: {
        CANCEL: { target: 'idle', actions: [{ type: 'cancelAndReset' }] },
      },
    },
    uploading: {
      tags: ['busy', 'uploading'],
      invoke: {
        id: 'uploadMedia',
        src: 'uploadMedia',
        input: ({ context }) => ({
          file: context.file as File,
          sha256: context.sha256 ?? '',
          targets: context.targets,
          metadata: context.metadata,
          uploadGen: context.uploadGen,
          dataSource: context.dataSource,
        }),
        onDone: [
          {
            guard: 'isUploadLivingBlocked',
            target: 'rejectedInvalid',
            actions: assign(({ event }) => ({
              rejectionReason: 'living_person_blocked' as const,
              rejectionMessage:
                event.output.kind === 'living_blocked'
                  ? event.output.message
                  : 'Photos and portraits cannot be attached to living relatives.',
            })),
          },
          {
            guard: 'isUploadSuccessMatchingGen',
            target: 'attaching',
            actions: assign(({ event }) =>
              event.output.kind === 'uploaded'
                ? {
                    r2Key: event.output.r2Key,
                    uploadedUrl: event.output.url ?? event.output.r2Key,
                    uploadedMedia: event.output.media ?? null,
                    retryableError: null,
                  }
                : {}
            ),
          },
          // Stale upload generation response: safely reset to idle.
          {
            target: 'idle',
            actions: [{ type: 'resetUpload' }],
          },
        ],
        onError: {
          target: 'failedRetryable',
          actions: assign(({ event }) => ({
            retryableError: event.error instanceof Error ? event.error.message : String(event.error),
          })),
        },
      },
      on: {
        CANCEL: { target: 'idle', actions: [{ type: 'cancelAndReset' }] },
      },
    },
    attaching: {
      tags: ['busy', 'attaching'],
      invoke: {
        id: 'attachMedia',
        src: 'attachMedia',
        input: ({ context }) => ({
          r2Key: context.r2Key ?? '',
          sha256: context.sha256 ?? '',
          targets: context.targets,
          uploadedMedia: context.uploadedMedia,
          uploadGen: context.uploadGen,
        }),
        onDone: [
          {
            guard: 'canCompleteAttach',
            target: 'complete',
            actions: assign(({ event }) =>
              event.output.kind === 'attached' ? { mediaId: event.output.mediaId, retryableError: null } : {}
            ),
          },
          {
            guard: 'isAttachLivingBlocked',
            target: 'rejectedInvalid',
            actions: assign(({ event }) => ({
              rejectionReason: 'living_person_blocked' as const,
              rejectionMessage:
                event.output.kind === 'living_blocked'
                  ? event.output.message
                  : 'Target person is marked living; media attachment blocked.',
            })),
          },
          // Stale generation or cancelled attach response never completes.
          {
            target: 'idle',
            actions: [{ type: 'resetUpload' }],
          },
        ],
        onError: {
          target: 'failedRetryable',
          actions: assign(({ event }) => ({
            retryableError: event.error instanceof Error ? event.error.message : String(event.error),
          })),
        },
      },
      on: {
        CANCEL: { target: 'idle', actions: [{ type: 'cancelAndReset' }] },
      },
    },
    complete: {
      tags: ['complete'],
      on: {
        RESET: { target: 'idle', actions: [{ type: 'resetUpload' }] },
        SELECT_FILE: {
          target: 'clientValidating',
          actions: [{ type: 'captureFileSelection' }],
        },
      },
    },
    failedRetryable: {
      tags: ['error', 'retryable'],
      on: {
        RETRY: [{ guard: 'alreadyUploaded', target: 'attaching' }, { target: 'uploading' }],
        CANCEL: { target: 'idle', actions: [{ type: 'cancelAndReset' }] },
      },
    },
    rejectedInvalid: {
      tags: ['error', 'rejected'],
      on: {
        RESET: { target: 'idle', actions: [{ type: 'resetUpload' }] },
        SELECT_FILE: {
          target: 'clientValidating',
          actions: [{ type: 'captureFileSelection' }],
        },
      },
    },
  },
});
