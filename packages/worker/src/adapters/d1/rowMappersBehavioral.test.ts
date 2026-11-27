import { describe, expect, it } from 'vitest';
import {
  mapAgentTokenRow,
  mapEntityRow,
  mapInviteRow,
  mapKinshipRow,
  mapMagicLinkRow,
  mapRevisionRow,
  mapTalkRow,
  mapUserRow,
  parseDbEntityRow,
  parseDbHeadRevisionRow,
  parseDbKinshipRow,
  parseDbReturningRevisionIdRow,
  parseDbReturningRevisionPairRow,
} from './rowMappers.js';

describe('D1 rowMappers validation and domain mapping behaviors', () => {
  it('rejects malformed D1 row envelopes and non-object JSON payloads cleanly', () => {
    expect(() => parseDbEntityRow(null)).toThrow(/entity row object/);
    expect(() => parseDbEntityRow([])).toThrow(/entity row object/);
    expect(() => parseDbKinshipRow('bad')).toThrow(/kinship row object/);
    expect(() => parseDbHeadRevisionRow(null)).toThrow(/head revision row object/);
    expect(() => parseDbReturningRevisionIdRow(null)).toThrow(/returning revision_id row object/);
    expect(() => parseDbReturningRevisionPairRow(null)).toThrow(/returning revision row object/);

    expect(() =>
      parseDbEntityRow({
        entity_type: 123,
        entity_id: 'pl_1',
        slug: null,
        data_json: '{}',
        current_revision_id: 1,
        has_primary_source: 1,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00Z',
      })
    ).toThrow(/must be a string/);

    expect(() =>
      parseDbEntityRow({
        entity_type: 'place',
        entity_id: 'pl_1',
        slug: 42,
        data_json: '{}',
        current_revision_id: 1,
        has_primary_source: 1,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00Z',
      })
    ).toThrow(/must be a string or null/);

    expect(() =>
      parseDbHeadRevisionRow({
        head_revision_id: Number.NaN,
      })
    ).toThrow(/must be a finite number/);

    expect(() =>
      parseDbReturningRevisionPairRow({
        revision_id: 5,
        parent_revision_id: 'not-a-number',
      })
    ).toThrow(/must be a finite number or null/);

    const validPair = parseDbReturningRevisionPairRow({
      revision_id: 5,
      parent_revision_id: null,
    });
    expect(validPair).toEqual({ revision_id: 5, parent_revision_id: null });

    expect(() =>
      mapEntityRow({
        entity_type: 'kinship_edge',
        entity_id: 'edge_1',
        slug: null,
        data_json: '{}',
        current_revision_id: 1,
        has_primary_source: 1,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00Z',
      })
    ).toThrow(/Unexpected kinship_edge/);

    expect(() =>
      mapEntityRow({
        entity_type: 'place',
        entity_id: 'pl_1',
        slug: 'hudsonville',
        data_json: '[]',
        current_revision_id: 1,
        has_primary_source: 1,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00Z',
      })
    ).toThrow(/plain object/);
  });

  it('maps valid entity, kinship, revision, talk, user, invite, magic-link, and agent-token rows', () => {
    const entityRow = parseDbEntityRow({
      entity_type: 'source',
      entity_id: 'src_1',
      slug: undefined,
      data_json: JSON.stringify({ id: 'src_1', citation: '1880 Census', source_type: 'census' }),
      current_revision_id: 3,
      has_primary_source: 1,
      deleted_at: null,
      updated_at: '2026-01-01T00:00:00Z',
    });
    expect(mapEntityRow(entityRow).has_primary_source).toBe(true);

    const kinRow = parseDbKinshipRow({
      edge_id: 'k_1',
      from_person_id: 'per_1',
      to_person_id: 'per_2',
      relation: 'parent',
      family_xref: '@F1@',
      current_revision_id: 3,
      deleted_at: null,
      updated_at: '2026-01-01T00:00:00Z',
    });
    expect(mapKinshipRow(kinRow).edge.family_xref).toBe('@F1@');

    const rev = mapRevisionRow({
      revision_id: 4,
      batch_id: 'bat_1',
      entity_type: 'source',
      entity_id: 'src_1',
      parent_revision_id: 3,
      action: 'update',
      reverted_revision_id: null,
      author_id: 'editor@example.test',
      author_name: 'Clara Alder',
      author_type: 'human',
      summary: 'Updated citation',
      has_primary_source: 1,
      before_json: JSON.stringify({ id: 'src_1', citation: 'Old', source_type: 'census' }),
      after_json: JSON.stringify({ id: 'src_1', citation: 'New', source_type: 'census' }),
      created_at: '2026-01-02T00:00:00Z',
    });
    expect(rev.has_primary_source).toBe(true);

    expect(
      mapTalkRow({
        comment_id: 1,
        entity_type: 'person',
        entity_id: 'per_1',
        author_id: 'editor@example.test',
        author_name: 'Clara Alder',
        body_md: 'Verified birth record.',
        created_at: '2026-01-02T00:00:00Z',
        edited_at: null,
        deleted_at: null,
      }).comment_id
    ).toBe(1);

    expect(
      mapUserRow({
        email: 'editor@example.test',
        display_name: 'Clara Alder',
        role: 'editor',
        added_by: 'admin@example.test',
        added_at: '2026-01-01T00:00:00Z',
        last_login_at: null,
      }).role
    ).toBe('editor');

    expect(
      mapInviteRow({
        token: 'inv_1',
        label: 'Family Reunion',
        created_by: 'admin@example.test',
        created_at: '2026-01-01T00:00:00Z',
        expires_at: null,
        revoked_at: null,
        uses: 2,
        last_used_at: null,
      }).uses
    ).toBe(2);

    const hash64 = 'a'.repeat(64);
    expect(
      mapMagicLinkRow({
        token_hash: hash64,
        email: 'editor@example.test',
        invite_token: null,
        expires_at: '2026-01-02T00:00:00Z',
        used_at: null,
      }).email
    ).toBe('editor@example.test');

    expect(
      mapAgentTokenRow({
        token_id: 'tok_1',
        token_hash: hash64,
        label: 'CLI Bot',
        scope: 'write_batch',
        created_by: 'admin@example.test',
        created_at: '2026-01-01T00:00:00Z',
        revoked_at: null,
      }).scope
    ).toBe('write_batch');
  });
});
