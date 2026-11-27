import { asRevisionId, type RevisionRecord } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { buildInitialSnapshotFromRevisions } from './commitPipeline.js';

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
    expect(snapshot.entities[0].slug).toBe('clara-alder');
    expect(snapshot.kinship.map((k) => k.edge_id)).toEqual(['per_a|parent|per_b']);
    expect(snapshot.kinship[0].edge.from).toBe('per_a');
  });
});
