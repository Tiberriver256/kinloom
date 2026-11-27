import { describe, expect, it } from 'vitest';
import {
  mapAgentTokenRow,
  mapInviteRow,
  mapMagicLinkRow,
  mapRevisionRow,
  mapTalkRow,
  mapUserRow,
  parseDbAgentTokenRow,
  parseDbAuthorNameRow,
  parseDbCountRow,
  parseDbInviteRow,
  parseDbLivingPersonProjectionRow,
  parseDbMagicLinkRow,
  parseDbPronunciationLexiconRow,
  parseDbRevisionRow,
  parseDbTalkRow,
  parseDbUserRow,
} from './rowMappers.js';

const VALID_SHA256 = 'a'.repeat(64);

describe('d1 rowMappers runtime boundary parsers', () => {
  it('parses valid D1 rows for revisions, talk comments, users, invites, magic links, agent tokens, counts, authors, living projections, and pronunciations', () => {
    const rev = mapRevisionRow(
      parseDbRevisionRow({
        revision_id: 7,
        batch_id: null,
        entity_type: 'person',
        entity_id: 'per_arthur',
        parent_revision_id: 6,
        action: 'update',
        reverted_revision_id: null,
        author_id: 'editor@example.test',
        author_name: 'Editor',
        author_type: 'human',
        summary: 'Update note',
        has_primary_source: 1,
        before_json: '{"id":"per_arthur"}',
        after_json: '{"id":"per_arthur","full_name":"Arthur Alder"}',
        created_at: '2026-06-01T12:00:00.000Z',
      })
    );
    expect(rev.revision_id).toBe(7);
    expect(rev.has_primary_source).toBe(true);

    const talk = mapTalkRow(
      parseDbTalkRow({
        comment_id: 3,
        entity_type: 'person',
        entity_id: 'per_arthur',
        author_id: 'editor@example.test',
        author_name: 'Editor',
        body_md: 'Verify census page.',
        created_at: '2026-06-01T12:00:00.000Z',
        edited_at: null,
        deleted_at: null,
      })
    );
    expect(talk.comment_id).toBe(3);

    const user = mapUserRow(
      parseDbUserRow({
        email: 'admin@example.test',
        display_name: 'Archive Admin',
        role: 'admin',
        added_by: 'bootstrap',
        added_at: '2026-06-01T12:00:00.000Z',
        last_login_at: null,
      })
    );
    expect(user.role).toBe('admin');

    const invite = mapInviteRow(
      parseDbInviteRow({
        token: 'inv_abc',
        label: 'Family invite',
        created_by: 'admin@example.test',
        created_at: '2026-06-01T12:00:00.000Z',
        expires_at: null,
        revoked_at: null,
        uses: 2,
        last_used_at: '2026-06-02T00:00:00.000Z',
      })
    );
    expect(invite.uses).toBe(2);

    const magicLink = mapMagicLinkRow(
      parseDbMagicLinkRow({
        token_hash: VALID_SHA256,
        email: 'editor@example.test',
        invite_token: null,
        expires_at: '2026-06-01T12:15:00.000Z',
        used_at: null,
      })
    );
    expect(magicLink.token_hash).toBe(VALID_SHA256);

    const token = mapAgentTokenRow(
      parseDbAgentTokenRow({
        token_id: 'tok_1',
        token_hash: VALID_SHA256,
        label: 'Export Job',
        scope: 'read_backup',
        created_by: 'admin@example.test',
        created_at: '2026-06-01T12:00:00.000Z',
        revoked_at: null,
      })
    );
    expect(token.scope).toBe('read_backup');

    expect(parseDbCountRow({ count: 4 })).toEqual({ count: 4 });
    expect(parseDbAuthorNameRow({ author_name: 'Editor' })).toEqual({ author_name: 'Editor' });
    expect(
      parseDbLivingPersonProjectionRow({
        entity_id: 'per_elena',
        is_living: 1,
        birth_edtf: 1984,
        death_edtf: null,
      })
    ).toEqual({
      entity_id: 'per_elena',
      is_living: 1,
      birth_edtf: 1984,
      death_edtf: null,
    });

    // Legacy 6-column pronunciation row omits provenance columns
    expect(
      parseDbPronunciationLexiconRow({
        term: 'Mercer',
        phonetic: 'MER-ser',
        ipa: null,
        language: 'en-US',
        audio_url: null,
        note: null,
      })
    ).toEqual({
      term: 'Mercer',
      phonetic: 'MER-ser',
      ipa: null,
      language: 'en-US',
      audio_url: null,
      note: null,
      source_url: null,
      source_label: null,
      region: null,
      variants_json: null,
    });
  });

  it('throws clear errors on malformed or schema-drifted D1 rows', () => {
    expect(() => parseDbRevisionRow({ revision_id: 'not-a-number' })).toThrow(/revision_id/);
    expect(() => parseDbTalkRow(null)).toThrow(/talk comment/);
    expect(() => parseDbUserRow({ email: 'a@example.test', display_name: 42 })).toThrow(/display_name/);
    expect(() =>
      parseDbInviteRow({ token: 't', label: 'l', created_by: 'a', created_at: 'x', uses: 'two' })
    ).toThrow(/uses/);
    expect(() => parseDbMagicLinkRow({ token_hash: 123 })).toThrow(/token_hash/);
    expect(() => parseDbAgentTokenRow({ token_id: 't', token_hash: 'h', label: 'l', scope: 5 })).toThrow(
      /scope/
    );
    expect(() => parseDbCountRow({ count: '3' })).toThrow(/count/);
    expect(() => parseDbAuthorNameRow({ author_name: null })).toThrow(/author_name/);
    expect(() => parseDbLivingPersonProjectionRow({ entity_id: 'p', is_living: {} })).toThrow(/is_living/);
    expect(() => parseDbPronunciationLexiconRow({ term: null })).toThrow(/term/);
  });
});
