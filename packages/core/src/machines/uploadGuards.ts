import type { RawEvent } from '../schemas/entities.js';

export const ALLOWED_MEDIA_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

export const ALLOWED_AUDIO_VIDEO_MIMES = [
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
] as const;

export type AllowedMediaMime = (typeof ALLOWED_MEDIA_MIMES)[number];
export type AllowedAudioVideoMime = (typeof ALLOWED_AUDIO_VIDEO_MIMES)[number];
export type ExtendedMediaMime = AllowedMediaMime | AllowedAudioVideoMime;

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_VIDEO_BYTES = 100 * 1024 * 1024;

export interface MediaUploadGuardOptions {
  allowAudioVideo?: boolean;
  extraAllowedMimes?: readonly string[];
}

export interface MediaAttachTargets {
  personIds: readonly string[];
  eventId?: string | null;
  sourceId?: string | null;
}

export type MediaValidationFailure =
  | 'unsupported_mime'
  | 'empty_file'
  | 'file_too_large'
  | 'living_person_blocked'
  | 'hash_failed';

const ALLOWED_MIME_SET: ReadonlySet<string> = new Set(ALLOWED_MEDIA_MIMES);
const ALLOWED_AUDIO_VIDEO_MIME_SET: ReadonlySet<string> = new Set(ALLOWED_AUDIO_VIDEO_MIMES);

/**
 * Guard: accepts JPEG, PNG, WebP, and PDF uploads by default, and optional video/audio types when enabled.
 */
export function isAllowedMediaMime(mimeType: string): mimeType is AllowedMediaMime;
export function isAllowedMediaMime(mimeType: string, options?: MediaUploadGuardOptions): boolean;
export function isAllowedMediaMime(mimeType: string, options?: MediaUploadGuardOptions): boolean {
  const normalized = mimeType.trim().toLowerCase();
  if (ALLOWED_MIME_SET.has(normalized)) {
    return true;
  }
  if (options?.allowAudioVideo && ALLOWED_AUDIO_VIDEO_MIME_SET.has(normalized)) {
    return true;
  }
  if (options?.extraAllowedMimes) {
    return options.extraAllowedMimes.some((m) => m.trim().toLowerCase() === normalized);
  }
  return false;
}

/**
 * Resolve maximum allowed byte size for a media MIME type (15 MiB images, 25 MiB PDFs, 100 MiB video/audio, or configured cap).
 */
export function maxBytesForMediaMime(mimeType: string, overrideMaxBytes?: number): number {
  const normalized = mimeType.trim().toLowerCase();
  let defaultCap = MAX_IMAGE_BYTES;
  if (normalized === 'application/pdf') {
    defaultCap = MAX_PDF_BYTES;
  } else if (ALLOWED_AUDIO_VIDEO_MIME_SET.has(normalized)) {
    defaultCap = MAX_AUDIO_VIDEO_BYTES;
  }
  if (overrideMaxBytes !== undefined && overrideMaxBytes > 0) {
    return Math.min(defaultCap, overrideMaxBytes);
  }
  return defaultCap;
}

/**
 * Guard: file size must be strictly positive and within the MIME byte limit.
 */
export function isWithinMediaSizeLimit(
  mimeType: string,
  sizeBytes: number,
  overrideMaxBytes?: number
): boolean {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return false;
  }
  return sizeBytes <= maxBytesForMediaMime(mimeType, overrideMaxBytes);
}

/**
 * Guard: checks whether any target person or target event participant is living.
 */
export function hasLivingUploadTarget(
  targets: MediaAttachTargets,
  livingPersonIds: ReadonlySet<string>,
  eventsById?: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>>
): boolean {
  for (const pid of targets.personIds) {
    if (livingPersonIds.has(pid)) {
      return true;
    }
  }
  if (targets.eventId && eventsById) {
    const ev = eventsById.get(targets.eventId);
    if (ev && ev.participants.some((pt) => livingPersonIds.has(pt.person_id))) {
      return true;
    }
  }
  return false;
}

export type MediaSelectionValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: Exclude<MediaValidationFailure, 'hash_failed'>;
      message: string;
    };

/**
 * Pre-upload client and server validation of MIME allowlist, size limit, and living-person portrait restriction.
 */
export function validateMediaSelection(input: {
  mimeType: string;
  sizeBytes: number;
  targetHasLiving: boolean;
  maxUploadBytes?: number;
  allowAudioVideo?: boolean;
  extraAllowedMimes?: readonly string[];
}): MediaSelectionValidationResult {
  const normalizedMime = input.mimeType.trim().toLowerCase();
  if (
    !isAllowedMediaMime(normalizedMime, {
      allowAudioVideo: input.allowAudioVideo,
      extraAllowedMimes: input.extraAllowedMimes,
    })
  ) {
    const allowedSummary = input.allowAudioVideo
      ? 'JPEG, PNG, WebP, PDF, MP4, WebM, MP3, M4A, OGG, or WAV'
      : 'JPEG, PNG, WebP, or PDF';
    return {
      ok: false,
      reason: 'unsupported_mime',
      message: `Unsupported file type '${input.mimeType}'. Allowed types: ${allowedSummary}.`,
    };
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return {
      ok: false,
      reason: 'empty_file',
      message: 'Selected file is empty.',
    };
  }
  const limit = maxBytesForMediaMime(normalizedMime, input.maxUploadBytes);
  if (input.sizeBytes > limit) {
    return {
      ok: false,
      reason: 'file_too_large',
      message: `File exceeds the maximum allowed size of ${Math.round(limit / (1024 * 1024))} MiB.`,
    };
  }
  if (input.targetHasLiving) {
    return {
      ok: false,
      reason: 'living_person_blocked',
      message: 'Photos and portraits cannot be attached to living relatives.',
    };
  }
  return { ok: true };
}

/**
 * Guard: prevents stale or cancelled upload/attach responses from advancing a newer upload generation.
 */
export function isMatchingUploadGeneration(params: {
  activeUploadGen: number;
  eventUploadGen: number;
  cancelled: boolean;
}): boolean {
  return !params.cancelled && params.activeUploadGen > 0 && params.eventUploadGen === params.activeUploadGen;
}

/**
 * Guard: blocks attach completion if upload generation is stale, cancelled, or if a target person became living mid-upload.
 */
export function canCompleteMediaAttach(params: {
  activeUploadGen: number;
  eventUploadGen: number;
  cancelled: boolean;
  targetHasLiving: boolean;
  targetBecameLiving: boolean;
}): boolean {
  return isMatchingUploadGeneration(params) && !params.targetHasLiving && !params.targetBecameLiving;
}
