import {
  asSha256Hex,
  type MediaByteRange,
  type MediaStore,
  type Sha256Hex,
  type StoredMediaObject,
} from '@kinloom/core';
import type { R2Bucket, R2ObjectBody } from '../types.js';

const KEY_SHA256_PATTERN = /(?:^|\/)([0-9a-f]{64})\.[a-z0-9]+$/i;

function resolveSha256(key: string, obj: R2ObjectBody): Sha256Hex | undefined {
  const metaSha = obj.customMetadata?.['sha256'];
  if (metaSha && /^[0-9a-f]{64}$/i.test(metaSha)) {
    return asSha256Hex(metaSha);
  }
  const match = KEY_SHA256_PATTERN.exec(key);
  if (match?.[1]) {
    return asSha256Hex(match[1]);
  }
  return undefined;
}

/**
 * Cloudflare R2 implementation of content-addressed MediaStore with native HTTP 206 byte ranges.
 */
export class R2MediaStore implements MediaStore {
  readonly adapterKind = 'r2';
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async head(key: string): Promise<{ exists: boolean; sizeBytes?: number; contentType?: string }> {
    const obj = await this.bucket.head(key);
    if (!obj) {
      return { exists: false };
    }
    return {
      exists: true,
      sizeBytes: obj.size,
      ...(obj.httpMetadata?.contentType !== undefined
        ? { contentType: obj.httpMetadata.contentType }
        : {}),
    };
  }

  async put(params: {
    key: string;
    body: ArrayBuffer | ReadableStream<Uint8Array>;
    contentType: string;
    sha256: Sha256Hex;
  }): Promise<void> {
    await this.bucket.put(params.key, params.body, {
      httpMetadata: {
        contentType: params.contentType,
      },
      customMetadata: {
        sha256: params.sha256,
      },
    });
  }

  async get(key: string, options?: { range?: MediaByteRange }): Promise<StoredMediaObject | null> {
    if (options?.range) {
      const r2Range =
        options.range.length !== undefined
          ? { offset: options.range.offset, length: options.range.length }
          : { offset: options.range.offset };

      const obj = await this.bucket.get(key, { range: r2Range });
      if (!obj) {
        return null;
      }

      const total = obj.size;
      const start = Math.max(0, options.range.offset);
      const endExclusive =
        options.range.length !== undefined ? Math.min(total, start + options.range.length) : total;
      const rangeLength = Math.max(0, endExclusive - start);

      const sha256 = resolveSha256(key, obj);
      return {
        key,
        contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
        sizeBytes: rangeLength,
        ...(sha256 ? { sha256 } : {}),
        etag: obj.etag,
        body: obj.body,
        range: {
          start,
          end: start + rangeLength - 1,
          total,
        },
      };
    }

    const obj = await this.bucket.get(key);
    if (!obj) {
      return null;
    }

    const sha256 = resolveSha256(key, obj);
    return {
      key,
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
      sizeBytes: obj.size,
      ...(sha256 ? { sha256 } : {}),
      etag: obj.etag,
      body: obj.body,
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
