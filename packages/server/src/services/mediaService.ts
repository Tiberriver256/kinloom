import {
  assertMediaAllowedForPrivacy,
  buildEntityId,
  type EntityReadStore,
  isEditSummaryValid,
  type KinloomSiteConfig,
  type MediaByteRange,
  type MediaItem,
  MediaItemSchema,
  type MediaStore,
  maxBytesForMediaMime,
  parseEntityPayload,
  type RawEvent,
  type RevisionAuthor,
  type RevisionRecord,
  type StoredMediaObject,
  toEntityPayload,
  validateMediaSelection,
} from '@kinloom/core';
import { randomBytes, sha256Hex, toHex } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';
import type { WikiWriteService } from './wikiWriteService.js';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Verifies actual file magic bytes for allowed image and PDF MIME types
 * (JPEG, PNG, WebP, GIF, PDF) to prevent Content-Type spoofing.
 */
export function matchesMagicBytesForMime(mimeType: string, bytes: Uint8Array): boolean {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (normalized) {
    case 'image/jpeg':
      return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return startsWithBytes(bytes, PNG_MAGIC);
    case 'image/webp':
      return (
        bytes.byteLength >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case 'image/gif':
      return (
        bytes.byteLength >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
      );
    case 'application/pdf':
      return startsWithBytes(bytes, PDF_MAGIC);
    default:
      return true;
  }
}

const SAFE_MEDIA_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_MEDIA_PATH_SEGMENTS = 8;

function isSafeRelativeMediaKey(key: string): boolean {
  if (!key || key.startsWith('/') || key.endsWith('/') || key.includes('\\') || key.includes('\0')) {
    return false;
  }
  const segments = key.split('/');
  if (segments.length === 0 || segments.length > MAX_MEDIA_PATH_SEGMENTS) {
    return false;
  }
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || !SAFE_MEDIA_SEGMENT_PATTERN.test(segment)) {
      return false;
    }
  }
  return true;
}

export interface MediaServiceDeps {
  repository: EntityReadStore;
  mediaStore: MediaStore;
  wikiWriteService: WikiWriteService;
  siteConfig: KinloomSiteConfig;
}

export function parseHttpByteRange(
  rangeHeader: string,
  totalBytes: number
): { start: number; end: number; range: MediaByteRange } | null {
  const trimmed = rangeHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bytes=')) {
    return null;
  }
  const spec = trimmed.slice(6).trim();
  if (spec.includes(',') || totalBytes <= 0) {
    return null;
  }
  const dashIdx = spec.indexOf('-');
  if (dashIdx === -1) {
    return null;
  }
  const startStr = spec.slice(0, dashIdx).trim();
  const endStr = spec.slice(dashIdx + 1).trim();

  let start: number;
  let end: number;

  if (startStr === '') {
    // Suffix byte range: bytes=-N
    if (!/^\d+$/.test(endStr)) {
      return null;
    }
    const suffixLength = Number(endStr);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, totalBytes - suffixLength);
    end = totalBytes - 1;
  } else {
    if (!/^\d+$/.test(startStr)) {
      return null;
    }
    start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0 || start >= totalBytes) {
      return null;
    }
    if (endStr === '') {
      end = totalBytes - 1;
    } else {
      if (!/^\d+$/.test(endStr)) {
        return null;
      }
      end = Math.min(totalBytes - 1, Number(endStr));
      if (!Number.isSafeInteger(end) || end < start) {
        return null;
      }
    }
  }

  return {
    start,
    end,
    range: { offset: start, length: end - start + 1 },
  };
}

export interface MediaUploadRejectionInfo {
  readonly reason: 'magic_bytes_mismatch' | 'unsupported_media_type' | 'file_too_large' | 'empty_file';
  readonly status: number;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly maxBytes?: number;
}

export class MediaService {
  private readonly repository: EntityReadStore;
  private readonly mediaStore: MediaStore;
  private readonly wikiWriteService: WikiWriteService;
  private readonly siteConfig: KinloomSiteConfig;

  constructor(deps: MediaServiceDeps) {
    this.repository = deps.repository;
    this.mediaStore = deps.mediaStore;
    this.wikiWriteService = deps.wikiWriteService;
    this.siteConfig = deps.siteConfig;
  }

  async uploadMedia(params: {
    bytes: Uint8Array;
    contentType: string;
    metadata: Record<string, unknown>;
    summary: string;
    hasPrimarySource?: boolean;
    author: RevisionAuthor;
    onUploadRejected?: (info: MediaUploadRejectionInfo) => void;
  }): Promise<{
    media: MediaItem;
    url: string;
    revision: RevisionRecord;
    etag: string;
    deduplicated: boolean;
  }> {
    if (!isEditSummaryValid(params.summary)) {
      throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Edit summary must be at least 3 characters.');
    }

    const normalizedMime = params.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    const isAudioVideoKind =
      params.metadata.kind === 'video_story' || params.metadata.kind === 'audio_oral_history';

    const maxUploadOverride =
      normalizedMime === 'application/pdf' || isAudioVideoKind
        ? undefined
        : this.siteConfig.wiki?.maxUploadBytes;

    const selectionCheck = validateMediaSelection({
      mimeType: normalizedMime,
      sizeBytes: params.bytes.byteLength,
      targetHasLiving: false,
      maxUploadBytes: maxUploadOverride,
      allowAudioVideo: isAudioVideoKind,
    });

    if (!selectionCheck.ok) {
      if (selectionCheck.reason === 'unsupported_mime') {
        params.onUploadRejected?.({
          reason: 'unsupported_media_type',
          status: 415,
          contentType: normalizedMime,
          sizeBytes: params.bytes.byteLength,
        });
        throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', selectionCheck.message);
      }
      if (selectionCheck.reason === 'file_too_large') {
        params.onUploadRejected?.({
          reason: 'file_too_large',
          status: 413,
          contentType: normalizedMime,
          sizeBytes: params.bytes.byteLength,
          maxBytes: maxBytesForMediaMime(normalizedMime, maxUploadOverride),
        });
        throw new KinloomHttpError(413, 'PAYLOAD_TOO_LARGE', selectionCheck.message);
      }
      if (selectionCheck.reason === 'empty_file') {
        params.onUploadRejected?.({
          reason: 'empty_file',
          status: 400,
          contentType: normalizedMime,
          sizeBytes: params.bytes.byteLength,
        });
      }
      throw new KinloomHttpError(400, 'VALIDATION_ERROR', selectionCheck.message);
    }

    const ext = EXTENSION_BY_MIME[normalizedMime];
    if (!ext) {
      params.onUploadRejected?.({
        reason: 'unsupported_media_type',
        status: 415,
        contentType: normalizedMime,
        sizeBytes: params.bytes.byteLength,
      });
      throw new KinloomHttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        `Unsupported media MIME type '${normalizedMime}'.`
      );
    }

    if (!matchesMagicBytesForMime(normalizedMime, params.bytes)) {
      params.onUploadRejected?.({
        reason: 'magic_bytes_mismatch',
        status: 415,
        contentType: normalizedMime,
        sizeBytes: params.bytes.byteLength,
      });
      throw new KinloomHttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        `Uploaded file contents do not match declared media type '${normalizedMime}'.`
      );
    }

    const sha256 = await sha256Hex(params.bytes);
    const filename = `${sha256}.${ext}`;
    const storeKey = `media/${filename}`;
    const publicUrl = `/media/${filename}`;

    const mediaId =
      typeof params.metadata.id === 'string' && params.metadata.id.trim().length > 0
        ? params.metadata.id.trim()
        : buildEntityId('media', toHex(randomBytes(8)));

    const parsedMedia = MediaItemSchema.parse({
      ...params.metadata,
      id: mediaId,
      file: publicUrl,
      mime_type: normalizedMime,
    });

    // Pre-upload privacy check before touching blob storage
    await this.checkLivingPrivacy(parsedMedia);

    // Content-addressed deduplication
    const existingBlob = await this.mediaStore.head(storeKey);
    const deduplicated = existingBlob.exists;
    if (!deduplicated) {
      const arrayBuffer = new Uint8Array(params.bytes).buffer;
      await this.mediaStore.put({
        key: storeKey,
        body: arrayBuffer,
        contentType: normalizedMime,
        sha256,
      });
    }

    // Machine 3 attach-time re-check: verify no target person became living while blob upload was in flight.
    await this.checkLivingPrivacy(parsedMedia);

    const created = await this.wikiWriteService.createEntity({
      entityType: 'media',
      entityId: parsedMedia.id,
      data: toEntityPayload(parsedMedia),
      summary: params.summary.trim(),
      hasPrimarySource: params.hasPrimarySource ?? true,
      author: params.author,
    });

    return {
      media: parseEntityPayload('media', created.entity),
      url: publicUrl,
      revision: created.revision,
      etag: created.etag,
      deduplicated,
    };
  }

  async getMedia(params: {
    key: string;
    rangeHeader: string | null;
    prefix?: 'media' | 'sources';
  }): Promise<{ status: 200 | 206; object: StoredMediaObject }> {
    const trimmedKey = params.key.trim();
    if (!isSafeRelativeMediaKey(trimmedKey)) {
      throw new KinloomHttpError(404, 'NOT_FOUND', 'Media object was not found.');
    }

    const prefix = params.prefix ?? 'media';
    const storeKey = `${prefix}/${trimmedKey}`;

    if (params.rangeHeader) {
      const head = await this.mediaStore.head(storeKey);
      if (!head.exists || head.sizeBytes === undefined) {
        throw new KinloomHttpError(404, 'NOT_FOUND', 'Media object was not found.');
      }

      const parsedRange = parseHttpByteRange(params.rangeHeader, head.sizeBytes);
      if (!parsedRange) {
        throw new KinloomHttpError(416, 'RANGE_NOT_SATISFIABLE', 'Requested byte range is not satisfiable.', {
          total: head.sizeBytes,
        });
      }

      const object = await this.mediaStore.get(storeKey, { range: parsedRange.range });
      if (!object) {
        throw new KinloomHttpError(404, 'NOT_FOUND', 'Media object was not found.');
      }
      return {
        status: 206,
        object: {
          ...object,
          range: object.range ?? {
            start: parsedRange.start,
            end: parsedRange.end,
            total: head.sizeBytes,
          },
        },
      };
    }

    const object = await this.mediaStore.get(storeKey);
    if (!object) {
      throw new KinloomHttpError(404, 'NOT_FOUND', 'Media object was not found.');
    }
    return { status: 200, object };
  }

  private async checkLivingPrivacy(media: MediaItem): Promise<void> {
    const livingPersonIds = await this.repository.getLivingPersonIds();
    const eventsById = new Map<string, Pick<RawEvent, 'id' | 'participants'>>();
    if (media.event_id) {
      const evRow = await this.repository.getEntity('event', media.event_id);
      if (evRow && !('edge' in evRow) && evRow.deleted_at === null) {
        const parsedEv = parseEntityPayload('event', evRow.data);
        eventsById.set(parsedEv.id, parsedEv);
      }
    }
    assertMediaAllowedForPrivacy(media, livingPersonIds, eventsById);
  }
}
