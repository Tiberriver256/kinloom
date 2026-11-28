import {
  type ArchiveBundle,
  type ArchiveRawSnapshot,
  asRevisionId,
  type RevisionRecord,
  toEntityPayload,
} from '@kinloom/core';
import { FixedClock, readStreamToBytes } from '@kinloom/server';
import { createSyntheticHistoricalPerson, createSyntheticSiteConfig } from '@kinloom/server/testing';
import { describe, expect, it } from 'vitest';
import {
  coalesceDeltaMutations,
  R2IncrementalPatchBundleCache,
  utf8ByteLengthFast,
} from './adapters/r2BundleCache.js';
import type { R2Bucket, R2Object, R2ObjectBody, R2PutOptions } from './types.js';

interface MemoryR2Entry {
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

function createMemoryR2Bucket(): {
  bucket: R2Bucket;
  entries: Map<string, MemoryR2Entry>;
  cloneColdView(): R2Bucket;
} {
  const entries = new Map<string, MemoryR2Entry>();
  let etagCounter = 0;

  const makeView = (): R2Bucket => ({
    async head(key: string): Promise<R2Object | null> {
      const e = entries.get(key);
      if (!e) {
        return null;
      }
      return {
        key,
        size: e.bytes.byteLength,
        etag: e.etag,
        uploaded: e.uploaded,
        ...(e.customMetadata !== undefined ? { customMetadata: e.customMetadata } : {}),
      };
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      const e = entries.get(key);
      if (!e) {
        return null;
      }
      const bytes = e.bytes;
      return {
        key,
        size: bytes.byteLength,
        etag: e.etag,
        uploaded: e.uploaded,
        ...(e.customMetadata !== undefined ? { customMetadata: e.customMetadata } : {}),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        bodyUsed: false,
        async arrayBuffer() {
          return bytes.slice().buffer;
        },
        async text() {
          return new TextDecoder().decode(bytes);
        },
      };
    },
    async put(key: string, value, options?: R2PutOptions): Promise<R2Object | null> {
      const existing = entries.get(key);
      const cond = options?.onlyIf;
      if (cond && !(cond instanceof Headers)) {
        if (cond.etagMatches !== undefined && existing?.etag !== cond.etagMatches) {
          return null;
        }
        if (cond.etagDoesNotMatch === '*' && existing !== undefined) {
          return null;
        }
      }
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value
            : new Uint8Array(0);
      etagCounter += 1;
      const entry: MemoryR2Entry = {
        bytes,
        etag: `mem-etag-${etagCounter}`,
        uploaded: new Date('2026-11-27T12:00:00.000Z'),
        ...(options?.customMetadata !== undefined ? { customMetadata: options.customMetadata } : {}),
      };
      entries.set(key, entry);
      return {
        key,
        size: bytes.byteLength,
        etag: entry.etag,
        uploaded: entry.uploaded,
        ...(entry.customMetadata !== undefined ? { customMetadata: entry.customMetadata } : {}),
      };
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        entries.delete(k);
      }
    },
  });

  return {
    bucket: makeView(),
    entries,
    cloneColdView: () => makeView(),
  };
}

describe('R2IncrementalPatchBundleCache delta journal & coalescing behavioral suite', () => {
  it('computes exact UTF-8 byte lengths across ASCII, 2-byte, 3-byte, and surrogate-pair Astral code points', () => {
    for (const sample of ['', 'Alder 1850', 'é—ˈal.dər', '📜 Alder–Mercer Folio 𝌆']) {
      expect(utf8ByteLengthFast(sample)).toBe(new TextEncoder().encode(sample).byteLength);
    }
  });

  it('replays coalesced delta journals across cold isolates, compacts at cap, and self-heals on missing or corrupted base', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-27T12:00:00.000Z');
    const mem = createMemoryR2Bucket();

    const warmCache = new R2IncrementalPatchBundleCache({
      bucket: mem.bucket,
      siteConfig,
      clock,
      deltaThresholdBytes: 128, // Exercise delta journal on compact synthetic archive
      maxDeltaMutations: 3,
    });

    const p1 = createSyntheticHistoricalPerson({
      id: 'per_alder_1',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
    });
    const initialSnapshot: ArchiveRawSnapshot = {
      head_revision_id: asRevisionId(1),
      entities: [
        {
          entity_type: 'person',
          entity_id: p1.id,
          slug: p1.slug,
          data: toEntityPayload(p1),
          current_revision_id: asRevisionId(1),
          has_primary_source: true,
          deleted_at: null,
          updated_at: clock.nowIso(),
        },
      ],
      kinship: [],
    };

    const built = await warmCache.rebuildAndStore(initialSnapshot);
    expect(built.revision_id).toBe(asRevisionId(1));
    expect(mem.entries.has('compiled/archive.json.base')).toBe(true);

    // 1. Apply two sequential updates to per_alder_1 + create & delete ephemeral per_mercer_temp (coalescing!)
    const p1Updated = { ...p1, full_name: 'Arthur W. Alder' };
    const pTemp = createSyntheticHistoricalPerson({
      id: 'per_mercer_temp',
      slug: 'temp-mercer',
      full_name: 'Temp Mercer',
    });
    const rev2: RevisionRecord = {
      revision_id: asRevisionId(2),
      batch_id: null,
      entity_type: 'person',
      entity_id: p1.id,
      parent_revision_id: 1,
      action: 'update',
      reverted_revision_id: null,
      author_id: 'editor@example.test',
      author_name: 'Editor Alder',
      author_type: 'human',
      summary: 'Update Arthur middle initial',
      has_primary_source: true,
      before_json: toEntityPayload(p1),
      after_json: toEntityPayload(p1Updated),
      created_at: clock.nowIso(),
    };
    const rev3CreateTemp: RevisionRecord = {
      ...rev2,
      revision_id: asRevisionId(3),
      entity_id: pTemp.id,
      parent_revision_id: null,
      action: 'create',
      summary: 'Create ephemeral Mercer',
      before_json: null,
      after_json: toEntityPayload(pTemp),
    };
    const rev4DeleteTemp: RevisionRecord = {
      ...rev2,
      revision_id: asRevisionId(4),
      entity_id: pTemp.id,
      parent_revision_id: 3,
      action: 'delete',
      summary: 'Delete ephemeral Mercer',
      before_json: toEntityPayload(pTemp),
      after_json: null,
    };

    expect(coalesceDeltaMutations([rev3CreateTemp], [rev4DeleteTemp])).toHaveLength(1);

    const deltaApplied = await warmCache.tryApplyMutationsFromMemo([rev2, rev3CreateTemp, rev4DeleteTemp]);
    expect(deltaApplied?.revision_id).toBe(asRevisionId(4));

    // 2. Cold isolate (no in-memory memo) replays `.base` + delta journal accurately and supports 304 ETag
    const coldBucket = mem.cloneColdView();
    const coldCache = new R2IncrementalPatchBundleCache({
      bucket: coldBucket,
      siteConfig,
      clock,
      deltaThresholdBytes: 128,
      maxDeltaMutations: 3,
    });

    const coldNotMod = await coldCache.getCached(deltaApplied?.etag ?? null);
    expect(coldNotMod).toEqual({ status: 'not_modified', etag: deltaApplied?.etag });

    const coldHit = await coldCache.getCached(null);
    expect(coldHit.status).toBe('hit');
    if (coldHit.status === 'hit') {
      expect(coldHit.object.revision_id).toBe(asRevisionId(4));
      const decoded = JSON.parse(
        new TextDecoder().decode(await readStreamToBytes(coldHit.object.body as ReadableStream<Uint8Array>))
      ) as ArchiveBundle;
      expect(decoded.meta.max_revision_id).toBe(4);
      expect(decoded.people.map((p) => p.full_name)).toEqual(['Arthur W. Alder']);
    }

    // 3. Exceeding maxDeltaMutations=3 compacts full snapshot into `.base` and resets delta mutations
    const extraPeopleMutations: RevisionRecord[] = [1, 2, 3, 4].map((idx) => {
      const pExtra = createSyntheticHistoricalPerson({
        id: `per_alder_extra_${idx}`,
        slug: `extra-alder-${idx}`,
        full_name: `Extra Alder ${idx}`,
      });
      return {
        ...rev2,
        revision_id: asRevisionId(4 + idx),
        entity_id: pExtra.id,
        parent_revision_id: null,
        action: 'create' as const,
        before_json: null,
        after_json: toEntityPayload(pExtra),
      };
    });
    const compacted = await coldCache.tryApplyMutationsFromMemo(extraPeopleMutations);
    expect(compacted?.revision_id).toBe(asRevisionId(8));

    const verifyCompactedCold = new R2IncrementalPatchBundleCache({
      bucket: mem.cloneColdView(),
      siteConfig,
      clock,
      deltaThresholdBytes: 128,
    });
    const afterCompactionHit = await verifyCompactedCold.getCached(null);
    expect(afterCompactionHit.status).toBe('hit');
    if (afterCompactionHit.status === 'hit') {
      expect(afterCompactionHit.object.parsedBundle?.people).toHaveLength(1 + extraPeopleMutations.length);
    }

    // 4. Corrupted delta JSON or missing `.base` returns `{ status: 'miss' }` so read service self-heals
    const currentHead = mem.entries.get('compiled/archive.json');
    if (currentHead) {
      mem.entries.set('compiled/archive.json', {
        ...currentHead,
        bytes: new TextEncoder().encode('{invalid-json'),
      });
    }
    const corruptedCache = new R2IncrementalPatchBundleCache({
      bucket: mem.cloneColdView(),
      siteConfig,
      clock,
      deltaThresholdBytes: 128,
    });
    expect((await corruptedCache.getCached(null)).status).toBe('miss');

    await mem.bucket.delete('compiled/archive.json.base');
    const missingBaseCache = new R2IncrementalPatchBundleCache({
      bucket: mem.cloneColdView(),
      siteConfig,
      clock,
      deltaThresholdBytes: 128,
    });
    expect((await missingBaseCache.getCached(null)).status).toBe('miss');
  });

  it('handles inline-to-delta threshold crossing, maxDeltaBytes compaction, concurrent ETag conflicts, and fresher-revision wins', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-27T12:00:00.000Z');
    const mem = createMemoryR2Bucket();

    const p1 = createSyntheticHistoricalPerson({
      id: 'per_alder_inline',
      slug: 'arthur-alder-inline',
      full_name: 'Arthur Alder',
    });
    const baseSnap: ArchiveRawSnapshot = {
      head_revision_id: asRevisionId(1),
      entities: [
        {
          entity_type: 'person',
          entity_id: p1.id,
          slug: p1.slug,
          data: toEntityPayload(p1),
          current_revision_id: asRevisionId(1),
          has_primary_source: true,
          deleted_at: null,
          updated_at: clock.nowIso(),
        },
      ],
      kinship: [],
    };

    // Start just above initial serialized size so rev 1 stays inline, then rev 2 crosses deltaThresholdBytes
    const probeCache = new R2IncrementalPatchBundleCache({
      bucket: mem.bucket,
      siteConfig,
      clock,
      deltaThresholdBytes: 1_000_000,
    });
    const initialBuilt = await probeCache.rebuildAndStore(baseSnap);
    const threshold = initialBuilt.byteLength + 20;

    const mem2 = createMemoryR2Bucket();
    const crossingCache = new R2IncrementalPatchBundleCache({
      bucket: mem2.bucket,
      siteConfig,
      clock,
      deltaThresholdBytes: threshold,
      maxDeltaBytes: 120, // force maxDeltaBytes compaction on next delta write
    });
    await crossingCache.rebuildAndStore(baseSnap);
    expect(mem2.entries.has('compiled/archive.json.base')).toBe(false);

    const p2 = createSyntheticHistoricalPerson({
      id: 'per_mercer_cross',
      slug: 'clara-mercer-cross',
      full_name: 'Clara Mercer of Ottawa County',
    });
    const rev2: RevisionRecord = {
      revision_id: asRevisionId(2),
      batch_id: null,
      entity_type: 'person',
      entity_id: p2.id,
      parent_revision_id: null,
      action: 'create',
      reverted_revision_id: null,
      author_id: 'editor@example.test',
      author_name: 'Editor Alder',
      author_type: 'human',
      summary: 'Cross delta threshold from inline memo',
      has_primary_source: true,
      before_json: null,
      after_json: toEntityPayload(p2),
      created_at: clock.nowIso(),
    };

    const crossed = await crossingCache.tryApplyMutationsFromMemo([rev2]);
    expect(crossed?.revision_id).toBe(asRevisionId(2));
    expect(mem2.entries.has('compiled/archive.json.base')).toBe(true);

    // Next mutation exceeds maxDeltaBytes=120 -> compacts into .base
    const p2b = { ...p2, full_name: 'Clara E. Mercer of Ottawa County' };
    const rev3: RevisionRecord = {
      ...rev2,
      revision_id: asRevisionId(3),
      parent_revision_id: 2,
      action: 'update',
      before_json: toEntityPayload(p2),
      after_json: toEntityPayload(p2b),
    };
    const compactedByBytes = await crossingCache.tryApplyMutationsFromMemo([rev3]);
    expect(compactedByBytes?.revision_id).toBe(asRevisionId(3));

    // Concurrent ETag conflict during delta write returns null cleanly and evicts stale memo
    const conflictDeltaCache = new R2IncrementalPatchBundleCache({
      bucket: mem2.cloneColdView(),
      siteConfig,
      clock,
      deltaThresholdBytes: 128,
    });
    await conflictDeltaCache.getCached(null); // warm delta memo at rev 3
    // Mutate underlying R2 etag behind conflictDeltaCache's back
    const headEntry = mem2.entries.get('compiled/archive.json')!;
    mem2.entries.set('compiled/archive.json', { ...headEntry, etag: 'concurrent-writer-etag' });
    const rev4: RevisionRecord = {
      ...rev3,
      revision_id: asRevisionId(4),
      parent_revision_id: 3,
      before_json: toEntityPayload(p2b),
      after_json: toEntityPayload({ ...p2b, full_name: 'Clara Mercer IV' }),
    };
    expect(await conflictDeltaCache.tryApplyMutationsFromMemo([rev4])).toBeNull();

    // Concurrent ETag conflict during inline write returns null cleanly
    const memInline = createMemoryR2Bucket();
    const inlineCache = new R2IncrementalPatchBundleCache({
      bucket: memInline.bucket,
      siteConfig,
      clock,
      deltaThresholdBytes: 1_000_000,
    });
    const inlineRev1 = await inlineCache.rebuildAndStore(baseSnap);
    const inlineHead = memInline.entries.get('compiled/archive.json')!;
    memInline.entries.set('compiled/archive.json', { ...inlineHead, etag: 'concurrent-inline-etag' });
    expect(await inlineCache.tryApplyMutationsFromMemo([rev2])).toBeNull();

    // Direct applyMutationsAndStore + stale storeBundle yielding to fresher revision in R2
    const appliedRev2 = await inlineCache.applyMutationsAndStore(inlineRev1.parsedBundle!, [rev2]);
    expect(appliedRev2.revision_id).toBe(asRevisionId(2));

    const staleCache = new R2IncrementalPatchBundleCache({
      bucket: memInline.cloneColdView(),
      siteConfig,
      clock,
      deltaThresholdBytes: 1_000_000,
    });
    const yieldedToFresher = await staleCache.rebuildAndStore(baseSnap); // rev 1 < rev 2 in R2
    expect(yieldedToFresher.revision_id).toBe(asRevisionId(2));
  });
});
