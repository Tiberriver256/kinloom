import {
  type ArchiveBundle,
  type ArchiveRawSnapshot,
  asRevisionId,
  type BuildMode,
  type BundleCache,
  type CachedBundleObject,
  type Clock,
  compileArchive,
  extractCollectionsFromSnapshot,
  type KinloomSiteConfig,
  patchCompiledBundle,
  type RevisionId,
  type RevisionRecord,
} from '@kinloom/core';
import { bytesToStream, matchesIfNoneMatch } from '@kinloom/server';
import type { R2Bucket } from '../types.js';

export const DEFAULT_COMPILED_BUNDLE_KEY = 'compiled/archive.json';
const MAX_R2_STORE_ATTEMPTS = 5;

export interface R2IncrementalPatchBundleCacheOptions {
  bucket: R2Bucket;
  siteConfig: KinloomSiteConfig;
  clock: Clock;
  mode?: BuildMode;
  key?: string;
}

interface StoredBundleMemo {
  readonly revision: RevisionId;
  readonly etag: string;
  readonly generatedAt: string;
  readonly serialized: string;
  readonly byteLength: number;
  readonly bundle: ArchiveBundle;
  readonly bytes: Uint8Array;
}

// Last bundle this isolate wrote, per bucket and key. getCached() trusts it only
// when R2 head() still reports the same revision, etag, and generated_at, so a
// write from any other isolate falls back to a full R2 read.
const storedBundleMemos = new WeakMap<R2Bucket, Map<string, StoredBundleMemo>>();

function parseRevisionMetadata(raw: string | undefined): RevisionId | null {
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 0) {
    return null;
  }
  return asRevisionId(num);
}

const BUNDLE_COMPILER_EPOCH = 'v2';

/**
 * Deterministic 8-char hex fingerprint of siteConfig + compiler epoch so any deploy
 * that changes kinloom.config.yaml or bundle pronunciation resolution automatically
 * invalidates both the R2 bundle cache and browser HTTP 304 ETag caches.
 */
export function computeSiteConfigHash(siteConfig: KinloomSiteConfig): string {
  const input = `${BUNDLE_COMPILER_EPOCH}:${JSON.stringify(siteConfig)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Cloudflare R2 BundleCache that applies O(affected_people) incremental patches on writes
 * and falls back to full compileArchive on cold misses.
 */
export class R2IncrementalPatchBundleCache implements BundleCache {
  private readonly bucket: R2Bucket;
  private readonly siteConfig: KinloomSiteConfig;
  private readonly clock: Clock;
  private readonly mode: BuildMode;
  private readonly key: string;
  private readonly configHash: string;
  public rebuildCount = 0;
  public incrementalPatchCount = 0;

  constructor(options: R2IncrementalPatchBundleCacheOptions) {
    this.bucket = options.bucket;
    this.siteConfig = options.siteConfig;
    this.clock = options.clock;
    this.mode = options.mode ?? 'private';
    this.key = options.key ?? DEFAULT_COMPILED_BUNDLE_KEY;
    this.configHash = computeSiteConfigHash(options.siteConfig);
  }

  private get memoKey(): string {
    return `${this.mode}:${this.configHash}:${this.key}`;
  }

  async getCached(
    ifNoneMatch: string | null
  ): Promise<
    | { status: 'not_modified'; etag: string }
    | { status: 'hit'; object: CachedBundleObject }
    | { status: 'miss' }
  > {
    const memo = storedBundleMemos.get(this.bucket)?.get(this.memoKey);
    if (ifNoneMatch || memo) {
      const headObj = await this.bucket.head(this.key);
      if (!headObj) {
        return { status: 'miss' };
      }
      const headRev = parseRevisionMetadata(headObj.customMetadata?.revision);
      if (headRev === null || headObj.customMetadata?.config_hash !== this.configHash) {
        return { status: 'miss' };
      }
      const headEtag = headObj.customMetadata?.etag ?? `"r${headRev}-${this.configHash}"`;
      if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, headEtag)) {
        return { status: 'not_modified', etag: headEtag };
      }
      if (
        memo &&
        headRev === memo.revision &&
        headEtag === memo.etag &&
        headObj.customMetadata?.generated_at === memo.generatedAt
      ) {
        return {
          status: 'hit',
          object: {
            etag: memo.etag,
            revision_id: memo.revision,
            body: bytesToStream(memo.bytes),
            byteLength: memo.byteLength,
            generated_at: memo.generatedAt,
            parsedBundle: memo.bundle,
          },
        };
      }
    }

    const obj = await this.bucket.get(this.key);
    if (!obj) {
      return { status: 'miss' };
    }

    const revId = parseRevisionMetadata(obj.customMetadata?.revision);
    if (revId === null || obj.customMetadata?.config_hash !== this.configHash) {
      await obj.body.cancel().catch(() => undefined);
      return { status: 'miss' };
    }

    const etag = obj.customMetadata?.etag ?? `"r${revId}-${this.configHash}"`;
    if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, etag)) {
      await obj.body.cancel().catch(() => undefined);
      return { status: 'not_modified', etag };
    }

    const generatedAt = obj.customMetadata?.generated_at ?? obj.uploaded.toISOString();
    return {
      status: 'hit',
      object: {
        etag,
        revision_id: revId,
        body: obj.body,
        byteLength: obj.size,
        generated_at: generatedAt,
      },
    };
  }

  async applyMutationsAndStore(
    previous: ArchiveBundle,
    mutations: readonly RevisionRecord[]
  ): Promise<CachedBundleObject> {
    const generatedAt = this.clock.nowIso();
    const patched = patchCompiledBundle(previous, mutations, this.siteConfig, this.mode, {
      generatedAt,
    });
    let maxRev = previous.meta.max_revision_id ?? 0;
    for (const mutation of mutations) {
      if (mutation.revision_id > maxRev) {
        maxRev = mutation.revision_id;
      }
    }
    this.incrementalPatchCount += 1;
    return this.storeBundle(patched, asRevisionId(maxRev), generatedAt);
  }

  async rebuildAndStore(snapshot: ArchiveRawSnapshot): Promise<CachedBundleObject> {
    const collections = extractCollectionsFromSnapshot(snapshot);
    const generatedAt = this.clock.nowIso();
    const { bundle } = compileArchive({
      ...collections,
      siteConfig: this.siteConfig,
      mode: this.mode,
      generatedAt,
      maxRevisionId: snapshot.head_revision_id,
    });
    this.rebuildCount += 1;
    return this.storeBundle(bundle, snapshot.head_revision_id, generatedAt);
  }

  private async storeBundle(
    bundle: ArchiveBundle,
    headRevisionId: RevisionId,
    generatedAt: string
  ): Promise<CachedBundleObject> {
    const serialized = JSON.stringify(bundle);
    const encoded = new TextEncoder().encode(serialized);
    const etag = `"r${headRevisionId}-${this.configHash}"`;

    for (let attempt = 0; attempt < MAX_R2_STORE_ATTEMPTS; attempt += 1) {
      const existingHead = await this.bucket.head(this.key);
      if (existingHead) {
        const existingRev = parseRevisionMetadata(existingHead.customMetadata?.revision);
        const sameConfig = existingHead.customMetadata?.config_hash === this.configHash;
        if (sameConfig && existingRev !== null && existingRev > headRevisionId) {
          const fresher = await this.getCached(null);
          if (fresher.status === 'hit') {
            return fresher.object;
          }
          continue;
        }
      }

      const putResult = await this.bucket.put(this.key, encoded, {
        onlyIf: existingHead ? { etagMatches: existingHead.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: {
          contentType: 'application/json; charset=utf-8',
        },
        customMetadata: {
          revision: String(headRevisionId),
          config_hash: this.configHash,
          etag,
          generated_at: generatedAt,
        },
      });

      if (putResult !== null) {
        let memos = storedBundleMemos.get(this.bucket);
        if (!memos) {
          memos = new Map();
          storedBundleMemos.set(this.bucket, memos);
        }
        memos.set(this.memoKey, {
          revision: headRevisionId,
          etag,
          generatedAt,
          serialized,
          byteLength: encoded.byteLength,
          bundle,
          bytes: encoded,
        });

        return {
          etag,
          revision_id: headRevisionId,
          body: serialized,
          byteLength: encoded.byteLength,
          generated_at: generatedAt,
          parsedBundle: bundle,
        };
      }
    }

    const latest = await this.getCached(null);
    if (latest.status === 'hit' && latest.object.revision_id >= headRevisionId) {
      return latest.object;
    }

    return {
      etag,
      revision_id: headRevisionId,
      body: serialized,
      byteLength: encoded.byteLength,
      generated_at: generatedAt,
      parsedBundle: bundle,
    };
  }
}
