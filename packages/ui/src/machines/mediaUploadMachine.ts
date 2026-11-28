import { canCompleteMediaAttach, isMatchingUploadGeneration, validateMediaSelection } from '@kinloom/core';
import { assign, setup } from 'xstate';
import {
  defaultAttachMediaActor,
  defaultHashFileSha256,
  defaultUploadMediaActor,
  readAttachOutput,
  readUploadOutput,
} from './mediaUpload/actors.js';
import type {
  AttachActorOutcome,
  AttachMediaActorInput,
  MediaUploadContext,
  MediaUploadEvent,
  MediaUploadInput,
  MediaUploadMetadata,
  UploadActorOutcome,
  UploadMediaActorInput,
} from './mediaUpload/types.js';

export type {
  AttachActorOutcome,
  AttachMediaActorInput,
  MediaUploadContext,
  MediaUploadEvent,
  MediaUploadInput,
  MediaUploadMetadata,
  UploadActorOutcome,
  UploadMediaActorInput,
};
export { defaultAttachMediaActor, defaultHashFileSha256, defaultUploadMediaActor };

const DEFAULT_METADATA: MediaUploadMetadata = {
  kind: 'family_photo',
  caption: '',
  summary: 'Upload archival media',
};

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
        ...(maxUploadBytes !== undefined ? { maxUploadBytes } : {}),
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
        SELECT_FILE: { target: 'clientValidating', actions: [{ type: 'captureFileSelection' }] },
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
          { target: 'idle', actions: [{ type: 'resetUpload' }] },
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
          { target: 'idle', actions: [{ type: 'resetUpload' }] },
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
        SELECT_FILE: { target: 'clientValidating', actions: [{ type: 'captureFileSelection' }] },
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
        SELECT_FILE: { target: 'clientValidating', actions: [{ type: 'captureFileSelection' }] },
      },
    },
  },
});
