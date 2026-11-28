import { type ArchiveRawSnapshot, asRevisionId, type BundleCache, type RevisionRecord } from '@kinloom/core';
import { describe, expect, it, vi } from 'vitest';
import {
  buildInitialSnapshotFromRevisions,
  WikiCommitPipeline,
  type WikiCommitPipelineDeps,
} from './commitPipeline.js';

function makeRevision(overrides: Partial<RevisionRecord> = {}): RevisionRecord {
  return {
    revision_id: asRevisionId(2),
    batch_id: null,
    entity_type: 'person',
    entity_id: 'per_a',
    parent_revision_id: asRevisionId(1),
    action: 'update',
    reverted_revision_id: null,
    author_id: 'admin@example.test',
    author_name: 'Admin',
    author_type: 'human',
    summary: 'Update person',
    has_primary_source: true,
    before_json: { id: 'per_a', slug: 'clara-alder', full_name: 'Clara Alder' },
    after_json: { id: 'per_a', slug: 'clara-alder', full_name: 'Clara M. Alder' },
    created_at: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('wikiWrite commitPipeline seam', () => {
  it('materializes an initial ArchiveRawSnapshot deterministically from r1 revisions', () => {
    const revisions: RevisionRecord[] = [
      {
        revision_id: asRevisionId(1),
        batch_id: null,
        entity_type: 'place',
        entity_id: 'plc_b',
        parent_revision_id: null,
        action: 'create',
        reverted_revision_id: null,
        author_id: 'admin@example.test',
        author_name: 'Admin',
        author_type: 'human',
        summary: 'Create place',
        has_primary_source: true,
        before_json: null,
        after_json: { id: 'plc_b', slug: 'harbor', name: 'Harbor' },
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        revision_id: asRevisionId(2),
        batch_id: null,
        entity_type: 'person',
        entity_id: 'per_a',
        parent_revision_id: null,
        action: 'create',
        reverted_revision_id: null,
        author_id: 'admin@example.test',
        author_name: 'Admin',
        author_type: 'human',
        summary: 'Create person',
        has_primary_source: false,
        before_json: null,
        after_json: { id: 'per_a', slug: 'clara-alder', full_name: 'Clara Alder' },
        created_at: '2026-01-01T00:00:01.000Z',
      },
      {
        revision_id: asRevisionId(3),
        batch_id: null,
        entity_type: 'kinship_edge',
        entity_id: 'per_a|parent|per_b',
        parent_revision_id: null,
        action: 'create',
        reverted_revision_id: null,
        author_id: 'admin@example.test',
        author_name: 'Admin',
        author_type: 'human',
        summary: 'Link kinship',
        has_primary_source: true,
        before_json: null,
        after_json: { from: 'per_a', to: 'per_b', relation: 'parent' },
        created_at: '2026-01-01T00:00:02.000Z',
      },
    ];

    const snapshot = buildInitialSnapshotFromRevisions(revisions, asRevisionId(3));

    expect(snapshot.head_revision_id).toBe(3);
    expect(snapshot.entities.map((e) => `${e.entity_type}:${e.entity_id}`)).toEqual([
      'person:per_a',
      'place:plc_b',
    ]);
    expect(snapshot.entities[0]!.slug).toBe('clara-alder');
    expect(snapshot.kinship.map((k) => k.edge_id)).toEqual(['per_a|parent|per_b']);
    expect(snapshot.kinship[0]!.edge.from).toBe('per_a');
  });

  it('falls back cleanly to loadActiveSnapshot + rebuildAndStore when cached R2 JSON is truncated or schema-invalid', async () => {
    const committedRev = makeRevision({ revision_id: asRevisionId(2) });
    const snapshot: ArchiveRawSnapshot = {
      head_revision_id: asRevisionId(2),
      entities: [],
      kinship: [],
    };

    for (const badBody of ['{"meta": truncated-json', JSON.stringify({ meta: 'not-a-valid-bundle' })]) {
      const loadActiveSnapshot = vi.fn(async () => snapshot);
      const applyMutationsAndStore = vi.fn(async () => ({
        body: '{}',
        byteLength: 2,
        etag: '"patched"',
        revision_id: asRevisionId(2),
        generated_at: '2026-01-01T00:00:01.000Z',
      }));
      const rebuildAndStore = vi.fn(async () => ({
        body: '{}',
        byteLength: 2,
        etag: '"r2-rebuilt"',
        revision_id: asRevisionId(2),
        generated_at: '2026-01-01T00:00:01.000Z',
      }));

      const repository = {
        commitAtomicMutations: vi.fn(async () => ({
          kind: 'committed' as const,
          head_revision_id: asRevisionId(2),
          revisions: [committedRev],
        })),
        loadActiveSnapshot,
      } as unknown as WikiCommitPipelineDeps['repository'];

      const bundleCache: BundleCache = {
        getCached: vi.fn(async () => ({
          status: 'hit' as const,
          object: {
            body: badBody,
            byteLength: badBody.length,
            etag: '"r1"',
            revision_id: asRevisionId(1),
            generated_at: '2026-01-01T00:00:00.000Z',
          },
        })),
        applyMutationsAndStore,
        rebuildAndStore,
      };

      const pipeline = new WikiCommitPipeline({
        repository,
        bundleCache,
        clock: {
          nowIso: () => '2026-01-01T00:00:01.000Z',
          now: () => new Date('2026-01-01T00:00:01.000Z'),
          currentYear: () => 2026,
        },
        plugins: [],
      });

      const result = await pipeline.commitAndPropagate({
        batchId: null,
        author: { author_id: 'admin@example.test', author_name: 'Admin', author_type: 'human' },
        operations: [],
      });

      expect(result.etag).toBe('"r2-rebuilt"');
      expect(applyMutationsAndStore).not.toHaveBeenCalled();
      expect(loadActiveSnapshot).toHaveBeenCalledTimes(1);
      expect(rebuildAndStore).toHaveBeenCalledWith(snapshot);
    }
  });
});
