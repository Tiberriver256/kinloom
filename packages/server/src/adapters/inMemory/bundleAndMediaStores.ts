import {
  type ArchiveBundle,
  type ArchiveRawSnapshot,
  asRevisionId,
  type BundleCache,
  type CachedBundleObject,
  type Clock,
  compileArchive,
  extractCollectionsFromSnapshot,
  type KinloomSiteConfig,
  type MediaByteRange,
  type MediaStore,
  type PluginSettingScalarValue,
  type PluginSettingsSecretWriteOp,
  type PluginSettingsStore,
  type Pronunciation,
  type PronunciationLexiconStore,
  patchCompiledBundle,
  type RevisionId,
  type RevisionRecord,
  type Sha256Hex,
  type StoredMediaObject,
  type StoredPluginSecretMetadata,
  type StoredPluginSettingsRecord,
} from '@kinloom/core';
import { bytesToStream, matchesIfNoneMatch, readStreamToBytes } from '../../crypto.js';

/**
 * In-memory incremental BundleCache using @kinloom/core patchCompiledBundle + compileArchive.
 */
export class InMemoryIncrementalBundleCache implements BundleCache {
  readonly adapterKind = 'in-memory';
  private readonly siteConfig: KinloomSiteConfig;
  private readonly clock: Clock;
  private cached: CachedBundleObject | null = null;
  public rebuildCount = 0;
  public incrementalPatchCount = 0;

  constructor(siteConfig: KinloomSiteConfig, clock: Clock) {
    this.siteConfig = siteConfig;
    this.clock = clock;
  }

  invalidate(): void {
    this.cached = null;
  }

  async getCached(
    ifNoneMatch: string | null
  ): Promise<
    | { status: 'not_modified'; etag: string }
    | { status: 'hit'; object: CachedBundleObject }
    | { status: 'miss' }
  > {
    if (!this.cached) {
      return { status: 'miss' };
    }
    if (matchesIfNoneMatch(ifNoneMatch, this.cached.etag)) {
      return { status: 'not_modified', etag: this.cached.etag };
    }
    return {
      status: 'hit',
      object: {
        ...this.cached,
      },
    };
  }

  async rebuildAndStore(snapshot: ArchiveRawSnapshot): Promise<CachedBundleObject> {
    const collections = extractCollectionsFromSnapshot(snapshot);
    const generatedAt = this.clock.nowIso();
    const { bundle } = compileArchive({
      ...collections,
      siteConfig: this.siteConfig,
      mode: 'private',
      generatedAt,
      maxRevisionId: snapshot.head_revision_id,
    });
    this.rebuildCount += 1;
    return this.storeBundle(bundle, snapshot.head_revision_id, generatedAt);
  }

  async applyMutationsAndStore(
    previous: ArchiveBundle,
    mutations: readonly RevisionRecord[]
  ): Promise<CachedBundleObject> {
    const generatedAt = this.clock.nowIso();
    const patched = patchCompiledBundle(previous, mutations, this.siteConfig, 'private', {
      generatedAt,
    });
    let maxRev = previous.meta.max_revision_id ?? 0;
    for (const m of mutations) {
      if (m.revision_id > maxRev) {
        maxRev = m.revision_id;
      }
    }
    this.incrementalPatchCount += 1;
    return this.storeBundle(patched, asRevisionId(maxRev), generatedAt);
  }

  private storeBundle(
    bundle: ArchiveBundle,
    revisionId: RevisionId,
    generatedAt: string
  ): CachedBundleObject {
    if (this.cached && this.cached.revision_id > revisionId) {
      return { ...this.cached };
    }
    const serialized = JSON.stringify(bundle);
    const byteLength = new TextEncoder().encode(serialized).byteLength;
    const object: CachedBundleObject = {
      etag: `"r${revisionId}"`,
      revision_id: revisionId,
      body: serialized,
      byteLength,
      generated_at: generatedAt,
    };
    this.cached = object;
    return object;
  }
}

interface StoredBlobEntry {
  bytes: Uint8Array;
  contentType: string;
  sha256: Sha256Hex;
}

/**
 * In-memory content-addressed MediaStore with HTTP 206 byte-range slice support.
 */
export class InMemoryMediaStore implements MediaStore {
  readonly adapterKind = 'in-memory';
  private readonly blobs = new Map<string, StoredBlobEntry>();
  public putCount = 0;

  async head(key: string): Promise<{ exists: boolean; sizeBytes?: number; contentType?: string }> {
    const entry = this.blobs.get(key);
    if (!entry) {
      return { exists: false };
    }
    return {
      exists: true,
      sizeBytes: entry.bytes.byteLength,
      contentType: entry.contentType,
    };
  }

  async put(params: {
    key: string;
    body: ArrayBuffer | ReadableStream<Uint8Array>;
    contentType: string;
    sha256: Sha256Hex;
  }): Promise<void> {
    const bytes =
      params.body instanceof ArrayBuffer
        ? new Uint8Array(params.body.slice(0))
        : await readStreamToBytes(params.body);
    this.blobs.set(params.key, {
      bytes,
      contentType: params.contentType,
      sha256: params.sha256,
    });
    this.putCount += 1;
  }

  async get(key: string, options?: { range?: MediaByteRange }): Promise<StoredMediaObject | null> {
    const entry = this.blobs.get(key);
    if (!entry) {
      return null;
    }
    const total = entry.bytes.byteLength;
    if (options?.range) {
      const start = Math.max(0, options.range.offset);
      const endExclusive =
        options.range.length !== undefined ? Math.min(total, start + options.range.length) : total;
      const slice = entry.bytes.slice(start, endExclusive);
      return {
        key,
        contentType: entry.contentType,
        sizeBytes: slice.byteLength,
        sha256: entry.sha256,
        body: bytesToStream(slice),
        range: {
          start,
          end: start + slice.byteLength - 1,
          total,
        },
      };
    }

    return {
      key,
      contentType: entry.contentType,
      sizeBytes: total,
      sha256: entry.sha256,
      body: bytesToStream(entry.bytes),
    };
  }
}

export class InMemoryPronunciationLexiconStore implements PronunciationLexiconStore {
  readonly adapterKind = 'in-memory';
  private readonly entries = new Map<string, Pronunciation>();

  async list(): Promise<Record<string, Pronunciation>> {
    const out: Record<string, Pronunciation> = {};
    for (const [term, entry] of [...this.entries.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
      out[term] = structuredClone(entry);
    }
    return out;
  }

  async upsert(
    term: string,
    entry: Pronunciation,
    _updatedBy: string,
    _updatedAt: string
  ): Promise<Pronunciation> {
    const clone = structuredClone(entry);
    this.entries.set(term, clone);
    return structuredClone(clone);
  }

  async delete(term: string): Promise<void> {
    this.entries.delete(term);
  }
}

interface InMemoryStoredSecret {
  readonly value: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/**
 * In-memory PluginSettingsStore keeping non-secret settings and write-only secrets
 * in separate maps so metadata queries never touch secret plaintext.
 */
export class InMemoryPluginSettingsStore implements PluginSettingsStore {
  readonly adapterKind = 'in-memory';
  private readonly settingsByPlugin = new Map<string, StoredPluginSettingsRecord>();
  private readonly secretsByPlugin = new Map<string, Map<string, InMemoryStoredSecret>>();

  async getSettings(pluginId: string): Promise<StoredPluginSettingsRecord | null> {
    const existing = this.settingsByPlugin.get(pluginId);
    if (!existing) {
      return null;
    }
    return {
      plugin_id: existing.plugin_id,
      values: { ...existing.values },
      updated_at: existing.updated_at,
      updated_by: existing.updated_by,
    };
  }

  async getSecretMetadata(pluginId: string): Promise<Readonly<Record<string, StoredPluginSecretMetadata>>> {
    const secrets = this.secretsByPlugin.get(pluginId);
    if (!secrets) {
      return {};
    }
    const out: Record<string, StoredPluginSecretMetadata> = {};
    for (const [key, entry] of secrets.entries()) {
      out[key] = {
        configured: true,
        updated_at: entry.updatedAt,
      };
    }
    return out;
  }

  async getSecretValue(pluginId: string, fieldKey: string): Promise<string | null> {
    return this.secretsByPlugin.get(pluginId)?.get(fieldKey)?.value ?? null;
  }

  async savePluginSettings(params: {
    readonly pluginId: string;
    readonly values: Readonly<Record<string, PluginSettingScalarValue>>;
    readonly secretMutations: readonly PluginSettingsSecretWriteOp[];
    readonly updatedBy: string;
    readonly updatedAt: string;
  }): Promise<{
    readonly settings: StoredPluginSettingsRecord;
    readonly secretMetadata: Readonly<Record<string, StoredPluginSecretMetadata>>;
  }> {
    const record: StoredPluginSettingsRecord = {
      plugin_id: params.pluginId,
      values: { ...params.values },
      updated_at: params.updatedAt,
      updated_by: params.updatedBy,
    };
    this.settingsByPlugin.set(params.pluginId, record);

    if (params.secretMutations.length > 0) {
      let secretMap = this.secretsByPlugin.get(params.pluginId);
      if (!secretMap) {
        secretMap = new Map<string, InMemoryStoredSecret>();
        this.secretsByPlugin.set(params.pluginId, secretMap);
      }
      for (const mutation of params.secretMutations) {
        if (mutation.action === 'clear') {
          secretMap.delete(mutation.key);
        } else if (mutation.action === 'set' && mutation.value !== undefined) {
          secretMap.set(mutation.key, {
            value: mutation.value,
            updatedAt: params.updatedAt,
            updatedBy: params.updatedBy,
          });
        }
      }
    }

    return {
      settings: {
        plugin_id: record.plugin_id,
        values: { ...record.values },
        updated_at: record.updated_at,
        updated_by: record.updated_by,
      },
      secretMetadata: await this.getSecretMetadata(params.pluginId),
    };
  }
}
