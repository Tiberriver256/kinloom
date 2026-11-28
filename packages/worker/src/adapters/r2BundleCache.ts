import {
  type ArchiveBundle,
  ArchiveBundleSchema,
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
  RevisionRecordSchema,
  tryValidateArchiveBundle,
} from '@kinloom/core';
import { matchesIfNoneMatch } from '@kinloom/server';
import type { R2Bucket } from '../types.js';

export const DEFAULT_COMPILED_BUNDLE_KEY = 'compiled/archive.json';
const DELTA_FORMAT_V1 = 'kinloom-delta-v1';
const DEFAULT_DELTA_THRESHOLD_BYTES = 65_536;
const DEFAULT_MAX_DELTA_MUTATIONS = 2_000;
const DEFAULT_MAX_DELTA_BYTES = 2_097_152;
const MAX_R2_STORE_ATTEMPTS = 5;
const UTF8_ENCODER = new TextEncoder();

export interface R2IncrementalPatchBundleCacheOptions {
  bucket: R2Bucket;
  siteConfig: KinloomSiteConfig;
  clock: Clock;
  mode?: BuildMode;
  key?: string;
  deltaThresholdBytes?: number;
  maxDeltaMutations?: number;
  maxDeltaBytes?: number;
}

interface StoredDeltaState {
  readonly baseRevision: RevisionId;
  readonly baseR2Etag: string;
  readonly mutations: readonly RevisionRecord[];
}

interface StoredBundleMemo {
  readonly revision: RevisionId;
  readonly etag: string;
  readonly r2Etag: string;
  readonly generatedAt: string;
  readonly bundle: ArchiveBundle;
  serialized: string | null;
  encoded: Uint8Array | null;
  readonly deltaState: StoredDeltaState | null;
}

interface DeltaJournalEnvelope {
  readonly format: typeof DELTA_FORMAT_V1;
  readonly base_revision: number;
  readonly base_etag: string;
  readonly mutations: RevisionRecord[];
}

interface SerializedWithBytes {
  readonly json: string;
  readonly bytes: number;
}

const RevisionRecordArraySchema = RevisionRecordSchema.array();

// Last bundle this isolate wrote or replayed, per bucket and key.
// - On reads (`getCached`), trusted only when R2 `head()` confirms the same revision, etag, and generated_at.
// - On writes (`tryApplyMutationsFromMemo`), verified atomically by R2 conditional `put({ onlyIf: { etagMatches } })`.
const storedBundleMemos = new WeakMap<R2Bucket, Map<string, StoredBundleMemo>>();

// WeakMap caches for copy-on-write incremental JSON serialization + exact UTF-8 byte lengths.
const collectionJsonCache = new WeakMap<object, SerializedWithBytes>();
const itemJsonCache = new WeakMap<object, SerializedWithBytes>();

export function utf8ByteLengthFast(str: string): number {
  const len = str.length;
  let bytes = len;
  for (let i = 0; i < len; i += 1) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      continue;
    }
    if (code < 0x800) {
      bytes += 1;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < len &&
      (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 2;
      i += 1;
    } else {
      bytes += 2;
    }
  }
  return bytes;
}

function createBytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function serializeArrayWithItemCache(arr: readonly unknown[]): SerializedWithBytes {
  const cached = collectionJsonCache.get(arr);
  if (cached !== undefined) {
    return cached;
  }
  const len = arr.length;
  if (len === 0) {
    const empty: SerializedWithBytes = { json: '[]', bytes: 2 };
    collectionJsonCache.set(arr, empty);
    return empty;
  }
  const parts = new Array<string>(len);
  let totalBytes = 2 + (len - 1); // '[' + commas + ']'
  for (let i = 0; i < len; i += 1) {
    const item = arr[i];
    if (item !== null && typeof item === 'object') {
      let itemEntry = itemJsonCache.get(item);
      if (itemEntry === undefined) {
        const json = JSON.stringify(item);
        itemEntry = { json, bytes: utf8ByteLengthFast(json) };
        itemJsonCache.set(item, itemEntry);
      }
      parts[i] = itemEntry.json;
      totalBytes += itemEntry.bytes;
    } else {
      const json = item === undefined ? 'null' : JSON.stringify(item);
      parts[i] = json;
      totalBytes += utf8ByteLengthFast(json);
    }
  }
  const entry: SerializedWithBytes = { json: `[${parts.join(',')}]`, bytes: totalBytes };
  collectionJsonCache.set(arr, entry);
  return entry;
}

export function stringifyArchiveBundleWithBytes(bundle: ArchiveBundle): SerializedWithBytes {
  const entries = Object.entries(bundle);
  const topParts: string[] = [];
  let totalBytes = 2; // '{' + '}'

  for (const [k, val] of entries) {
    if (val === undefined) {
      continue;
    }
    let valEntry: SerializedWithBytes;
    if (k === 'meta') {
      const json = JSON.stringify(val);
      valEntry = { json, bytes: utf8ByteLengthFast(json) };
    } else if (Array.isArray(val)) {
      valEntry = serializeArrayWithItemCache(val);
    } else if (val !== null && typeof val === 'object') {
      const cachedObj = collectionJsonCache.get(val);
      if (cachedObj !== undefined) {
        valEntry = cachedObj;
      } else {
        const json = JSON.stringify(val);
        valEntry = { json, bytes: utf8ByteLengthFast(json) };
        collectionJsonCache.set(val, valEntry);
      }
    } else {
      const json = JSON.stringify(val);
      valEntry = { json, bytes: utf8ByteLengthFast(json) };
    }
    const keyPrefix = `${JSON.stringify(k)}:`;
    if (topParts.length > 0) {
      totalBytes += 1; // ','
    }
    totalBytes += utf8ByteLengthFast(keyPrefix) + valEntry.bytes;
    topParts.push(`${keyPrefix}${valEntry.json}`);
  }

  return { json: `{${topParts.join(',')}}`, bytes: totalBytes };
}

export function stringifyArchiveBundleFast(bundle: ArchiveBundle): string {
  return stringifyArchiveBundleWithBytes(bundle).json;
}

function ensureMemoEncoded(memo: StoredBundleMemo): Uint8Array {
  if (memo.encoded === null) {
    if (memo.serialized === null) {
      memo.serialized = stringifyArchiveBundleWithBytes(memo.bundle).json;
    }
    memo.encoded = UTF8_ENCODER.encode(memo.serialized);
  }
  return memo.encoded;
}

/**
 * Coalesces sequential delta journal entries by `(entity_type, entity_id)` so repeated updates
 * to the same entities stay bounded by active mutated entity count while preserving exact replay
 * semantics (`before_json` from the earliest delta against `.base`, `after_json` and `revision_id`
 * from the latest mutation).
 */
export function coalesceDeltaMutations(
  existing: readonly RevisionRecord[],
  incoming: readonly RevisionRecord[]
): RevisionRecord[] {
  if (existing.length === 0 && incoming.length <= 1) {
    return [...incoming];
  }
  const byEntityKey = new Map<string, RevisionRecord>();
  const appendOne = (mut: RevisionRecord): void => {
    const key = `${mut.entity_type}:${mut.entity_id}`;
    const prev = byEntityKey.get(key);
    if (!prev) {
      byEntityKey.set(key, mut);
      return;
    }
    byEntityKey.delete(key);
    if (prev.action === 'create' && mut.after_json === null) {
      return;
    }
    const mergedAction: RevisionRecord['action'] =
      prev.action === 'create' && mut.after_json !== null ? 'create' : mut.action;
    byEntityKey.set(key, {
      ...mut,
      action: mergedAction,
      parent_revision_id: prev.parent_revision_id,
      before_json: prev.before_json,
    });
  };

  let maxRevisionRecord: RevisionRecord | null = null;
  for (const m of existing) {
    if (!maxRevisionRecord || m.revision_id >= maxRevisionRecord.revision_id) {
      maxRevisionRecord = m;
    }
    appendOne(m);
  }
  for (const m of incoming) {
    if (!maxRevisionRecord || m.revision_id >= maxRevisionRecord.revision_id) {
      maxRevisionRecord = m;
    }
    appendOne(m);
  }

  const coalesced = [...byEntityKey.values()];
  const lastCoalesced = coalesced[coalesced.length - 1];
  if (
    maxRevisionRecord &&
    (!lastCoalesced || lastCoalesced.revision_id < maxRevisionRecord.revision_id)
  ) {
    coalesced.push({
      ...maxRevisionRecord,
      action: 'delete',
      before_json: null,
      after_json: null,
    });
  }
  return coalesced;
}

function parseDeltaJournal(rawText: string): DeltaJournalEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const rec = parsed as Record<string, unknown>;
    if (
      rec['format'] !== DELTA_FORMAT_V1 ||
      typeof rec['base_revision'] !== 'number' ||
      !Number.isSafeInteger(rec['base_revision']) ||
      rec['base_revision'] < 0 ||
      typeof rec['base_etag'] !== 'string' ||
      rec['base_etag'].length === 0 ||
      !Array.isArray(rec['mutations'])
    ) {
      return null;
    }
    const validatedMutations = RevisionRecordArraySchema.safeParse(rec['mutations']);
    if (!validatedMutations.success) {
      return null;
    }
    return {
      format: DELTA_FORMAT_V1,
      base_revision: rec['base_revision'],
      base_etag: rec['base_etag'],
      mutations: validatedMutations.data,
    };
  } catch {
    return null;
  }
}

function parseArchiveBundleText(rawText: string): ArchiveBundle | null {
  try {
    const raw: unknown = JSON.parse(rawText);
    const fast = tryValidateArchiveBundle(raw);
    if (fast !== null) {
      return fast;
    }
    const parsed = ArchiveBundleSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
 * Cloudflare R2 BundleCache that applies O(affected_people) incremental patches on writes,
 * persists compact CAS-guarded coalesced delta journals for large archives (avoiding multi-megabyte R2
 * snapshot rewrites on every mutation), and falls back to full compileArchive on cold misses.
 */
export class R2IncrementalPatchBundleCache implements BundleCache {
  readonly adapterKind = 'r2';
  private readonly bucket: R2Bucket;
  private readonly siteConfig: KinloomSiteConfig;
  private readonly clock: Clock;
  private readonly mode: BuildMode;
  private readonly key: string;
  private readonly baseKey: string;
  private readonly configHash: string;
  private readonly deltaThresholdBytes: number;
  private readonly maxDeltaMutations: number;
  private readonly maxDeltaBytes: number;
  public rebuildCount = 0;
  public incrementalPatchCount = 0;

  constructor(options: R2IncrementalPatchBundleCacheOptions) {
    this.bucket = options.bucket;
    this.siteConfig = options.siteConfig;
    this.clock = options.clock;
    this.mode = options.mode ?? 'private';
    this.key = options.key ?? DEFAULT_COMPILED_BUNDLE_KEY;
    this.baseKey = `${this.key}.base`;
    this.configHash = computeSiteConfigHash(options.siteConfig);
    this.deltaThresholdBytes = options.deltaThresholdBytes ?? DEFAULT_DELTA_THRESHOLD_BYTES;
    this.maxDeltaMutations = options.maxDeltaMutations ?? DEFAULT_MAX_DELTA_MUTATIONS;
    this.maxDeltaBytes = options.maxDeltaBytes ?? DEFAULT_MAX_DELTA_BYTES;
  }

  private get memoKey(): string {
    return `${this.mode}:${this.configHash}:${this.key}`;
  }

  private saveMemo(memo: StoredBundleMemo): void {
    let memos = storedBundleMemos.get(this.bucket);
    if (!memos) {
      memos = new Map();
      storedBundleMemos.set(this.bucket, memos);
    }
    memos.set(this.memoKey, memo);
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
      const headRev = parseRevisionMetadata(headObj.customMetadata?.['revision']);
      if (headRev === null || headObj.customMetadata?.['config_hash'] !== this.configHash) {
        return { status: 'miss' };
      }
      const headEtag = headObj.customMetadata?.['etag'] ?? `"r${headRev}-${this.configHash}"`;
      if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, headEtag)) {
        return { status: 'not_modified', etag: headEtag };
      }
      if (
        memo &&
        headRev === memo.revision &&
        headEtag === memo.etag &&
        headObj.customMetadata?.['generated_at'] === memo.generatedAt
      ) {
        const encoded = ensureMemoEncoded(memo);
        return {
          status: 'hit',
          object: {
            etag: memo.etag,
            revision_id: memo.revision,
            body: createBytesStream(encoded),
            byteLength: encoded.byteLength,
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

    const revId = parseRevisionMetadata(obj.customMetadata?.['revision']);
    if (revId === null || obj.customMetadata?.['config_hash'] !== this.configHash) {
      await obj.body.cancel().catch(() => undefined);
      return { status: 'miss' };
    }

    const etag = obj.customMetadata?.['etag'] ?? `"r${revId}-${this.configHash}"`;
    if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, etag)) {
      await obj.body.cancel().catch(() => undefined);
      return { status: 'not_modified', etag };
    }

    const generatedAt = obj.customMetadata?.['generated_at'] ?? obj.uploaded.toISOString();

    if (obj.customMetadata?.['format'] === DELTA_FORMAT_V1) {
      const [deltaText, baseObj] = await Promise.all([obj.text(), this.bucket.get(this.baseKey)]);
      if (!baseObj || baseObj.customMetadata?.['config_hash'] !== this.configHash) {
        if (baseObj) {
          await baseObj.body.cancel().catch(() => undefined);
        }
        return { status: 'miss' };
      }
      const delta = parseDeltaJournal(deltaText);
      if (!delta || delta.base_etag !== baseObj.etag) {
        await baseObj.body.cancel().catch(() => undefined);
        return { status: 'miss' };
      }
      const baseText = await baseObj.text();
      const baseBundle = parseArchiveBundleText(baseText);
      if (!baseBundle) {
        return { status: 'miss' };
      }

      const replayed =
        delta.mutations.length > 0
          ? patchCompiledBundle(baseBundle, delta.mutations, this.siteConfig, this.mode, {
              generatedAt,
            })
          : baseBundle;

      const coldMemo: StoredBundleMemo = {
        revision: revId,
        etag,
        r2Etag: obj.etag,
        generatedAt,
        bundle: replayed,
        serialized: delta.mutations.length === 0 ? baseText : null,
        encoded: null,
        deltaState: {
          baseRevision: asRevisionId(delta.base_revision),
          baseR2Etag: baseObj.etag,
          mutations: delta.mutations,
        },
      };
      this.saveMemo(coldMemo);
      const encoded = ensureMemoEncoded(coldMemo);

      return {
        status: 'hit',
        object: {
          etag,
          revision_id: revId,
          body: createBytesStream(encoded),
          byteLength: encoded.byteLength,
          generated_at: generatedAt,
          parsedBundle: replayed,
        },
      };
    }

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

  async tryApplyMutationsFromMemo(mutations: readonly RevisionRecord[]): Promise<CachedBundleObject | null> {
    const [firstMutation] = mutations;
    if (!firstMutation) {
      return null;
    }
    const priorMemo = storedBundleMemos.get(this.bucket)?.get(this.memoKey);
    if (!priorMemo?.r2Etag || priorMemo.revision !== firstMutation.revision_id - 1) {
      return null;
    }

    const generatedAt = this.clock.nowIso();
    const patched = patchCompiledBundle(priorMemo.bundle, mutations, this.siteConfig, this.mode, {
      generatedAt,
    });
    let maxRev = priorMemo.bundle.meta.max_revision_id ?? 0;
    for (const mut of mutations) {
      if (mut.revision_id > maxRev) {
        maxRev = mut.revision_id;
      }
    }
    const headRevisionId = asRevisionId(maxRev);
    const etag = `"r${headRevisionId}-${this.configHash}"`;

    if (priorMemo.deltaState !== null) {
      const nextMutations = coalesceDeltaMutations(priorMemo.deltaState.mutations, mutations);
      if (nextMutations.length <= this.maxDeltaMutations) {
        const deltaPayload: DeltaJournalEnvelope = {
          format: DELTA_FORMAT_V1,
          base_revision: priorMemo.deltaState.baseRevision,
          base_etag: priorMemo.deltaState.baseR2Etag,
          mutations: nextMutations,
        };
        const deltaBody = JSON.stringify(deltaPayload);
        if (deltaBody.length <= this.maxDeltaBytes) {
          const putResult = await this.bucket.put(this.key, deltaBody, {
            onlyIf: { etagMatches: priorMemo.r2Etag },
            httpMetadata: {
              contentType: 'application/json; charset=utf-8',
            },
            customMetadata: {
              revision: String(headRevisionId),
              config_hash: this.configHash,
              etag,
              generated_at: generatedAt,
              format: DELTA_FORMAT_V1,
              base_revision: String(priorMemo.deltaState.baseRevision),
            },
          });

          if (putResult === null) {
            storedBundleMemos.get(this.bucket)?.delete(this.memoKey);
            return null;
          }

          this.incrementalPatchCount += 1;
          this.saveMemo({
            revision: headRevisionId,
            etag,
            r2Etag: putResult.etag,
            generatedAt,
            bundle: patched,
            serialized: null,
            encoded: null,
            deltaState: {
              baseRevision: priorMemo.deltaState.baseRevision,
              baseR2Etag: priorMemo.deltaState.baseR2Etag,
              mutations: nextMutations,
            },
          });

          return {
            etag,
            revision_id: headRevisionId,
            body: '',
            byteLength: 0,
            generated_at: generatedAt,
            parsedBundle: patched,
          };
        }
      }

      // Delta journal reached compaction cap -> compact full snapshot into .base and reset journal.
      this.incrementalPatchCount += 1;
      return this.storeBundle(patched, headRevisionId, generatedAt);
    }

    const computed = stringifyArchiveBundleWithBytes(patched);
    if (computed.bytes >= this.deltaThresholdBytes) {
      this.incrementalPatchCount += 1;
      return this.storeBundle(patched, headRevisionId, generatedAt, computed.json, computed.bytes);
    }

    const putResult = await this.bucket.put(this.key, computed.json, {
      onlyIf: { etagMatches: priorMemo.r2Etag },
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

    if (putResult === null) {
      storedBundleMemos.get(this.bucket)?.delete(this.memoKey);
      return null;
    }

    this.incrementalPatchCount += 1;
    this.saveMemo({
      revision: headRevisionId,
      etag,
      r2Etag: putResult.etag,
      generatedAt,
      bundle: patched,
      serialized: computed.json,
      encoded: null,
      deltaState: null,
    });

    return {
      etag,
      revision_id: headRevisionId,
      body: computed.json,
      byteLength: putResult.size,
      generated_at: generatedAt,
      parsedBundle: patched,
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
    generatedAt: string,
    preSerialized?: string,
    preByteLength?: number
  ): Promise<CachedBundleObject> {
    let serialized: string;
    let byteLength: number;
    if (preSerialized !== undefined && preByteLength !== undefined) {
      serialized = preSerialized;
      byteLength = preByteLength;
    } else {
      const computed = stringifyArchiveBundleWithBytes(bundle);
      serialized = computed.json;
      byteLength = computed.bytes;
    }

    const etag = `"r${headRevisionId}-${this.configHash}"`;
    const priorMemo = storedBundleMemos.get(this.bucket)?.get(this.memoKey);

    let deltaBasePutEtag: string | null = null;
    let payloadToPut = serialized;
    let customMetadata: Record<string, string> = {
      revision: String(headRevisionId),
      config_hash: this.configHash,
      etag,
      generated_at: generatedAt,
    };

    if (byteLength >= this.deltaThresholdBytes) {
      const basePut = await this.bucket.put(this.baseKey, serialized, {
        httpMetadata: {
          contentType: 'application/json; charset=utf-8',
        },
        customMetadata: {
          revision: String(headRevisionId),
          config_hash: this.configHash,
        },
      });
      if (basePut !== null) {
        deltaBasePutEtag = basePut.etag;
        const initDelta: DeltaJournalEnvelope = {
          format: DELTA_FORMAT_V1,
          base_revision: headRevisionId,
          base_etag: basePut.etag,
          mutations: [],
        };
        payloadToPut = JSON.stringify(initDelta);
        customMetadata = {
          ...customMetadata,
          format: DELTA_FORMAT_V1,
          base_revision: String(headRevisionId),
        };
      }
    }

    for (let attempt = 0; attempt < MAX_R2_STORE_ATTEMPTS; attempt += 1) {
      let matchR2Etag: string | null = null;
      if (attempt === 0 && priorMemo && priorMemo.revision < headRevisionId && priorMemo.r2Etag) {
        matchR2Etag = priorMemo.r2Etag;
      } else {
        const existingHead = await this.bucket.head(this.key);
        if (existingHead) {
          const existingRev = parseRevisionMetadata(existingHead.customMetadata?.['revision']);
          const sameConfig = existingHead.customMetadata?.['config_hash'] === this.configHash;
          if (sameConfig && existingRev !== null && existingRev > headRevisionId) {
            const fresher = await this.getCached(null);
            if (fresher.status === 'hit') {
              return fresher.object;
            }
            continue;
          }
          matchR2Etag = existingHead.etag;
        }
      }

      const putResult = await this.bucket.put(this.key, payloadToPut, {
        onlyIf: matchR2Etag !== null ? { etagMatches: matchR2Etag } : { etagDoesNotMatch: '*' },
        httpMetadata: {
          contentType: 'application/json; charset=utf-8',
        },
        customMetadata,
      });

      if (putResult !== null) {
        this.saveMemo({
          revision: headRevisionId,
          etag,
          r2Etag: putResult.etag,
          generatedAt,
          bundle,
          serialized,
          encoded: null,
          deltaState:
            deltaBasePutEtag !== null
              ? {
                  baseRevision: headRevisionId,
                  baseR2Etag: deltaBasePutEtag,
                  mutations: [],
                }
              : null,
        });

        return {
          etag,
          revision_id: headRevisionId,
          body: serialized,
          byteLength,
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
      byteLength,
      generated_at: generatedAt,
      parsedBundle: bundle,
    };
  }
}
