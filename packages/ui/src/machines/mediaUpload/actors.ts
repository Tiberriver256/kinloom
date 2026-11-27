import type { MediaItem } from '@kinloom/core';
import { fromPromise } from 'xstate';
import { ApiClientError } from '../../adapters/httpWikiDataSource.js';
import type {
  AttachActorOutcome,
  AttachMediaActorInput,
  UploadActorOutcome,
  UploadMediaActorInput,
} from './types.js';

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
