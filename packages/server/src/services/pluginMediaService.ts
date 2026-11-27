import type { MediaStore, Sha256Hex } from '@kinloom/core';
import { matchesIfNoneMatch, sha256Hex } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';
import { MEDIA_CONTENT_SECURITY_POLICY } from '../http/securityHeaders.js';
import { type StrippableImageMime, stripImageMetadata } from './imageMetadataStripper.js';
import { type MediaUploadRejectionInfo, matchesMagicBytesForMime } from './mediaService.js';

export const DEFAULT_PLUGIN_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PLUGIN_IMAGE_MIMES: readonly StrippableImageMime[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

const EXTENSION_BY_IMAGE_MIME: Readonly<Record<StrippableImageMime, 'jpg' | 'png' | 'webp'>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const SAFE_KEY_SEGMENT_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_FILENAME_RE = /^[a-zA-Z0-9._-]{1,120}$/;

function assertValidSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_KEY_SEGMENT_RE.test(trimmed)) {
    throw new KinloomHttpError(
      400,
      'VALIDATION_ERROR',
      `Invalid ${label} '${value}'. Must contain only letters, digits, hyphens, or underscores.`
    );
  }
  return trimmed;
}

function isStrippableImageMime(mime: string): mime is StrippableImageMime {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp';
}

export interface PluginMediaServiceOptions {
  readonly mediaStore: MediaStore;
  readonly namespace: string;
  readonly allowedMimes?: readonly StrippableImageMime[];
  readonly maxBytes?: number;
  readonly onUploadRejected?: (info: MediaUploadRejectionInfo) => void;
}

export interface StorePluginImageParams {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly resourceId: string;
  readonly assetId: string;
  readonly maxBytesOverride?: number;
  readonly onUploadRejected?: (info: MediaUploadRejectionInfo) => void;
}

export interface StoredPluginImageResult {
  readonly key: string;
  readonly assetId: string;
  readonly mimeType: StrippableImageMime;
  readonly ext: 'jpg' | 'png' | 'webp';
  readonly sizeBytes: number;
  readonly sha256: Sha256Hex;
  readonly width: number | null;
  readonly height: number | null;
  readonly orientation: number;
  readonly strippedMetadataBytes: number;
}

export interface ServePluginImageParams {
  readonly key: string;
  readonly expectedMimeType: StrippableImageMime;
  readonly sha256: string;
  readonly downloadFilename: string;
  readonly ifNoneMatch?: string | null;
}

/**
 * Reusable domain-agnostic media upload, pure-TS EXIF stripping, safe serving, and cleanup
 * service for Kinloom server plugins.
 */
export class PluginMediaService {
  private readonly mediaStore: MediaStore;
  private readonly namespace: string;
  private readonly allowedMimes: ReadonlySet<StrippableImageMime>;
  private readonly defaultMaxBytes: number;
  private readonly defaultOnUploadRejected?: (info: MediaUploadRejectionInfo) => void;

  constructor(options: PluginMediaServiceOptions) {
    this.mediaStore = options.mediaStore;
    this.namespace = assertValidSegment(options.namespace, 'media namespace');
    this.allowedMimes = new Set(options.allowedMimes ?? DEFAULT_PLUGIN_IMAGE_MIMES);
    this.defaultMaxBytes = options.maxBytes ?? DEFAULT_PLUGIN_MEDIA_MAX_BYTES;
    this.defaultOnUploadRejected = options.onUploadRejected;
  }

  buildObjectKey(resourceId: string, assetId: string, ext: 'jpg' | 'png' | 'webp'): string {
    const safeResource = assertValidSegment(resourceId, 'resource ID');
    const safeAsset = assertValidSegment(assetId, 'asset ID');
    return `plugins/${this.namespace}/${safeResource}/${safeAsset}.${ext}`;
  }

  isScopedKey(key: string): boolean {
    const prefix = `plugins/${this.namespace}/`;
    if (!key.startsWith(prefix) || key.includes('..') || key.includes('\\') || key.includes('\0')) {
      return false;
    }
    const rest = key.slice(prefix.length);
    const parts = rest.split('/');
    if (parts.length !== 2) {
      return false;
    }
    const [resourceSeg, fileSeg] = parts;
    if (!SAFE_KEY_SEGMENT_RE.test(resourceSeg)) {
      return false;
    }
    return /^[a-zA-Z0-9_-]{1,64}\.(?:jpg|png|webp)$/.test(fileSeg);
  }

  async storeImage(params: StorePluginImageParams): Promise<StoredPluginImageResult> {
    const notifyRejected = params.onUploadRejected ?? this.defaultOnUploadRejected;
    const normalizedMime = params.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    const maxBytes = params.maxBytesOverride ?? this.defaultMaxBytes;

    // 1. Reject empty payloads
    if (params.bytes.byteLength === 0) {
      notifyRejected?.({
        reason: 'empty_file',
        status: 400,
        contentType: normalizedMime,
        sizeBytes: 0,
      });
      throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Uploaded image file is empty.');
    }

    // 2. Reject oversized payloads before parsing binary containers
    if (params.bytes.byteLength > maxBytes) {
      notifyRejected?.({
        reason: 'file_too_large',
        status: 413,
        contentType: normalizedMime,
        sizeBytes: params.bytes.byteLength,
        maxBytes,
      });
      throw new KinloomHttpError(
        413,
        'PAYLOAD_TOO_LARGE',
        `Uploaded image exceeds maximum allowed size of ${Math.round(maxBytes / (1024 * 1024))} MB.`
      );
    }

    // 3. Enforce strict image MIME allowlist
    if (!isStrippableImageMime(normalizedMime) || !this.allowedMimes.has(normalizedMime)) {
      notifyRejected?.({
        reason: 'unsupported_media_type',
        status: 415,
        contentType: normalizedMime,
        sizeBytes: params.bytes.byteLength,
      });
      throw new KinloomHttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        `Unsupported image media type '${normalizedMime || 'unknown'}'. Allowed types: JPEG, PNG, WebP.`
      );
    }

    // 4. Verify real magic-byte header matches declared MIME
    if (!matchesMagicBytesForMime(normalizedMime, params.bytes)) {
      notifyRejected?.({
        reason: 'magic_bytes_mismatch',
        status: 415,
        contentType: normalizedMime,
        sizeBytes: params.bytes.byteLength,
      });
      throw new KinloomHttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        `Uploaded file bytes do not match declared image type '${normalizedMime}'.`
      );
    }

    // 5. Strip EXIF/XMP/IPTC metadata and parse dimensions in pure TypeScript
    let stripped: ReturnType<typeof stripImageMetadata>;
    try {
      stripped = stripImageMetadata(params.bytes, normalizedMime);
    } catch (err) {
      notifyRejected?.({
        reason: 'magic_bytes_mismatch',
        status: 415,
        contentType: normalizedMime,
        sizeBytes: params.bytes.byteLength,
      });
      if (err instanceof KinloomHttpError) {
        throw err;
      }
      throw new KinloomHttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        `Uploaded image container failed structural verification for '${normalizedMime}'.`
      );
    }

    // 6. Hash stripped bytes so stored bytes and digest match
    const sha256 = await sha256Hex(stripped.bytes);
    const ext = EXTENSION_BY_IMAGE_MIME[normalizedMime];
    const key = this.buildObjectKey(params.resourceId, params.assetId, ext);
    const bufferCopy = new Uint8Array(stripped.bytes).buffer;

    await this.mediaStore.put({
      key,
      body: bufferCopy,
      contentType: normalizedMime,
      sha256,
    });

    return {
      key,
      assetId: params.assetId,
      mimeType: normalizedMime,
      ext,
      sizeBytes: stripped.bytes.byteLength,
      sha256,
      width: stripped.width,
      height: stripped.height,
      orientation: stripped.orientation,
      strippedMetadataBytes: stripped.strippedMetadataBytes,
    };
  }

  async serveImageResponse(params: ServePluginImageParams): Promise<Response> {
    if (!this.isScopedKey(params.key)) {
      throw new KinloomHttpError(404, 'NOT_FOUND', 'Image object was not found.');
    }

    const safeFilename = SAFE_FILENAME_RE.test(params.downloadFilename)
      ? params.downloadFilename
      : `image.${EXTENSION_BY_IMAGE_MIME[params.expectedMimeType]}`;
    const etag = `"${params.sha256}"`;

    const baseHeaders = new Headers({
      'content-security-policy': MEDIA_CONTENT_SECURITY_POLICY,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
      etag,
    });

    if (matchesIfNoneMatch(params.ifNoneMatch ?? null, etag)) {
      return new Response(null, { status: 304, headers: baseHeaders });
    }

    const stored = await this.mediaStore.get(params.key);
    if (!stored) {
      throw new KinloomHttpError(404, 'NOT_FOUND', 'Image object was not found.');
    }

    baseHeaders.set('content-type', params.expectedMimeType);
    baseHeaders.set('content-length', String(stored.sizeBytes));
    baseHeaders.set('content-disposition', `inline; filename="${safeFilename}"`);

    return new Response(stored.body, {
      status: 200,
      headers: baseHeaders,
    });
  }

  async deleteObject(key: string): Promise<void> {
    if (!this.isScopedKey(key) || typeof this.mediaStore.delete !== 'function') {
      return;
    }
    try {
      await this.mediaStore.delete(key);
    } catch {
      // Best-effort storage cleanup so soft-delete succeeds even if blob was already removed.
    }
  }
}

export function extensionForImageMime(mime: StrippableImageMime): 'jpg' | 'png' | 'webp' {
  return EXTENSION_BY_IMAGE_MIME[mime];
}
