import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEntityPatch,
  buildBatchRevertPayloads,
  buildRevertPayload,
  computeEntityDiff,
} from './revisions.js';
import { BatchSubmissionSchema, RevisionRecordSchema } from './schemas/revisions.js';

describe('revision diff and revert engine', () => {
  it('computes nested field diffs across added, removed, and changed keys', () => {
    const before = {
      id: 'per_1',
      full_name: 'Arthur Alder',
      birth_edtf: '1850',
      meta: { verified: false, note: 'draft' },
    };
    const after = {
      id: 'per_1',
      full_name: 'Arthur W. Alder',
      death_edtf: '1922',
      meta: { verified: true, note: 'draft' },
    };

    const diff = computeEntityDiff(before, after);
    expect(diff.hasChanges).toBe(true);
    expect(diff.addedCount).toBe(1);
    expect(diff.removedCount).toBe(1);
    expect(diff.changedCount).toBe(2);
    expect(diff.fields.map((f) => `${f.kind}:${f.path}`)).toEqual([
      'removed:birth_edtf',
      'added:death_edtf',
      'changed:full_name',
      'changed:meta.verified',
    ]);
  });

  it('enforces valid state transitions in applyEntityPatch and rejects illegal transitions', () => {
    const created = applyEntityPatch(null, {
      action: 'create',
      entity_type: 'person',
      entity_id: 'per_1',
      data: { id: 'per_1', full_name: 'Arthur Alder' },
    });
    expect(created.before).toBeNull();
    expect(created.after).toEqual({ id: 'per_1', full_name: 'Arthur Alder' });

    expect(() =>
      applyEntityPatch(
        { data: created.after!, deletedAt: null },
        { action: 'create', entity_type: 'person', entity_id: 'per_1', data: {} }
      )
    ).toThrow(/already exists/);

    const updated = applyEntityPatch(
      { data: created.after!, deletedAt: null },
      {
        action: 'update',
        entity_type: 'person',
        entity_id: 'per_1',
        data: { birth_edtf: '1850' },
        merge: true,
      }
    );
    expect(updated.after).toEqual({ id: 'per_1', full_name: 'Arthur Alder', birth_edtf: '1850' });

    const deleted = applyEntityPatch(
      { data: updated.after!, deletedAt: null },
      { action: 'delete', entity_type: 'person', entity_id: 'per_1' }
    );
    expect(deleted.after).toBeNull();

    const restored = applyEntityPatch(
      { data: updated.after!, deletedAt: '2026-11-24T00:00:00Z' },
      { action: 'restore', entity_type: 'person', entity_id: 'per_1' }
    );
    expect(restored.after).toEqual(updated.after);
  });

  it('builds Wikipedia-style non-destructive revert payloads and unwinds agent batches in reverse order', () => {
    const rev1 = RevisionRecordSchema.parse({
      revision_id: 10,
      batch_id: 'batch_001',
      entity_type: 'person',
      entity_id: 'per_1',
      parent_revision_id: 9,
      action: 'update',
      reverted_revision_id: null,
      author_id: 'agent_token_1',
      author_name: 'Research Agent',
      author_type: 'agent',
      summary: 'Update birth date from 1880 census',
      has_primary_source: 1,
      before_json: { id: 'per_1', birth_edtf: '1850' },
      after_json: { id: 'per_1', birth_edtf: '1851' },
      created_at: '2026-11-24T12:00:00Z',
    });

    const rev2 = RevisionRecordSchema.parse({
      revision_id: 11,
      batch_id: 'batch_001',
      entity_type: 'person',
      entity_id: 'per_1',
      parent_revision_id: 10,
      action: 'update',
      reverted_revision_id: null,
      author_id: 'agent_token_1',
      author_name: 'Research Agent',
      author_type: 'agent',
      summary: 'Add death year from burial record',
      has_primary_source: true,
      before_json: { id: 'per_1', birth_edtf: '1851' },
      after_json: { id: 'per_1', birth_edtf: '1851', death_edtf: '1922' },
      created_at: '2026-11-24T12:01:00Z',
    });

    const singleRevert = buildRevertPayload(rev2.after_json, rev2);
    expect(singleRevert.action).toBe('revert');
    expect(singleRevert.reverted_revision_id).toBe(11);
    expect(singleRevert.after_json).toEqual({ id: 'per_1', birth_edtf: '1851' });

    const batchReverts = buildBatchRevertPayloads(
      new Map([['person:per_1', rev2.after_json]]),
      [rev1, rev2]
    );
    expect(batchReverts.map((r) => r.reverted_revision_id)).toEqual([11, 10]);
    expect(batchReverts[1].after_json).toEqual({ id: 'per_1', birth_edtf: '1850' });

    const validBatch = BatchSubmissionSchema.parse({
      batch_id: 'batch_002',
      summary: 'Attach census records',
      patches: [
        {
          action: 'update',
          entity_type: 'person',
          entity_id: 'per_1',
          data: { birth_edtf: '1850-03-14' },
        },
      ],
    });
    expect(validBatch.author_type).toBe('agent');
    expect(validBatch.patches).toHaveLength(1);
  });

  it('property: applying an update patch then reverting restores exact original snapshot', () => {
    const payloadArb = fc.dictionary(
      fc.stringMatching(/^[a-z][a-z_]{1,9}$/),
      fc.oneof(fc.string({ maxLength: 20 }), fc.integer({ min: 0, max: 3000 }), fc.boolean()),
      { minKeys: 1, maxKeys: 6 }
    );

    fc.assert(
      fc.property(payloadArb, payloadArb, (initial, patchData) => {
        const applied = applyEntityPatch(
          { data: initial, deletedAt: null },
          {
            action: 'update',
            entity_type: 'person',
            entity_id: 'per_prop',
            data: patchData,
            merge: true,
          }
        );
        const rev = RevisionRecordSchema.parse({
          revision_id: 42,
          entity_type: 'person',
          entity_id: 'per_prop',
          action: 'update',
          author_id: 'editor@example.com',
          author_name: 'Editor',
          author_type: 'human',
          summary: 'Property edit',
          has_primary_source: true,
          before_json: applied.before,
          after_json: applied.after,
          created_at: '2026-11-24T00:00:00Z',
        });
        const reverted = buildRevertPayload(applied.after, rev);
        expect(reverted.after_json).toEqual(initial);
      }),
      { numRuns: 60 }
    );
  });
});
