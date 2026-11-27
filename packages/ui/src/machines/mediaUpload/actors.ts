import { isArchiveApiError } from '@kinloom/core';
import { fromPromise } from 'xstate';
import type {
  AttachActorOutcome,
  AttachMediaActorInput,
  UploadActorOutcome,
  UploadMediaActorInput,
} from './types.js';

function isLivingMediaBlockedError(error: unknown): { blocked: true; message: string } | { blocked: false } {
  if (
    isArchiveApiError(error) &&
    error.status === 422 &&
    (error.code === 'LIVING_MEDIA_FORBIDDEN' ||
      error.code === 'LIVING_PRIVACY_BLOCKED' ||
      error.code === 'PRIVACY_VIOLATION')
  ) {
    return {
      blocked: true,
      message: error.message ?? 'Media cannot be attached to living relatives.',
    };
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

export const defaultUploadMediaActor = fromPromise<UploadActorOutcome, UploadMediaActorInput>(
  async ({ input, signal }) => {
    if (!input.dataSource?.uploadMedia) {
      throw new Error('Uploading media is not supported by this archive.');
    }

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
);

export const defaultAttachMediaActor = fromPromise<AttachActorOutcome, AttachMediaActorInput>(
  async ({ input }) => {
    if (input.uploadedMedia) {
      return {
        kind: 'attached',
        uploadGen: input.uploadGen,
        mediaId: input.uploadedMedia.id,
        targetBecameLiving: false,
      };
    }
    throw new Error('Media upload did not return an attached media record.');
  }
);

export function readUploadOutput(event: unknown): UploadActorOutcome | null {
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

export function readAttachOutput(event: unknown): AttachActorOutcome | null {
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
