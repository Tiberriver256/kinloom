import { asRevisionId } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import {
  buildCommittedRevisionRecord,
  chunkJsonArrayWithRanges,
  isSqliteConstraintError,
  resolveSlugForOp,
} from './sqlHelpers.js';

describe('d1 sqlHelpers seam', () => {
  it('chunks large JSON arrays under the D1 parameter byte cap with accurate index ranges', () => {
    const payload = 'x'.repeat(250_000);
    const items = [payload, payload, payload, payload, payload];
    const chunks = chunkJsonArrayWithRanges(items);

    expect(chunks.length).toBeGreaterThan(1);
    const reconstructed: unknown[] = [];
    let expectedStart = 0;
    for (const chunk of chunks) {
      expect(chunk.start).toBe(expectedStart);
      expect(new TextEncoder().encode(chunk.json).length).toBeLessThanOrEqual(900_000);
      const parsed = JSON.parse(chunk.json) as unknown[];
      expect(parsed.length).toBe(chunk.count);
      reconstructed.push(...parsed);
      expectedStart += chunk.count;
    }
    expect(reconstructed).toEqual(items);
  });

  it('detects SQLite constraint errors and resolves slugs for atomic mutations', () => {
    expect(isSqliteConstraintError(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'))).toBe(true);
    expect(isSqliteConstraintError(new Error('CHECK constraint failed: action'))).toBe(true);
    expect(isSqliteConstraintError(new Error('network timeout'))).toBe(false);

    expect(
      resolveSlugForOp({
        entity_type: 'person',
        entity_id: 'per_1',
        action: 'update',
        expected_parent_revision_id: asRevisionId(1),
        summary: 'Update slug',
        has_primary_source: true,
        before_json: null,
        after_json: { id: 'per_1', slug: 'clara-alder' },
      })
    ).toEqual({ updateSlug: true, value: 'clara-alder' });
  });

  it('builds a RevisionRecord from a committed atomic mutation op', () => {
    const rev = buildCommittedRevisionRecord({
      revisionId: 7,
      parentRevisionId: 6,
      op: {
        entity_type: 'place',
        entity_id: 'plc_1',
        action: 'update',
        expected_parent_revision_id: asRevisionId(6),
        summary: 'Correct coordinates',
        has_primary_source: true,
        before_json: { id: 'plc_1' },
        after_json: { id: 'plc_1', name: 'Harbor' },
      },
      batchId: null,
      author: { author_id: 'editor@example.test', author_name: 'Editor', author_type: 'human' },
      nowIso: '2026-01-02T00:00:00.000Z',
    });

    expect(rev.revision_id).toBe(7);
    expect(rev.parent_revision_id).toBe(6);
    expect(rev.entity_id).toBe('plc_1');
    expect(rev.summary).toBe('Correct coordinates');
  });
});
