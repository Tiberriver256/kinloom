import type { ArchiveBundle, RevisionRecord } from '@kinloom/core';
import { asBatchId, asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { ApiClientError, createHttpWikiDataSource } from './httpWikiDataSource.js';
import { StaticDemoDataSource } from './staticDemoDataSource.js';

const SITE_CONFIG = parseKinloomConfig({
  site: {
    title: 'Alder Adapter Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_ADAPTER_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  people: [],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

const SAMPLE_REV = {
  revision_id: asRevisionId(2),
  entity_type: 'person',
  entity_id: 'per_1',
  action: 'update',
  parent_revision_id: asRevisionId(1),
  batch_id: null,
  author_type: 'human',
  author_id: 'founder@example.test',
  author_name: 'Founder Alder',
  summary: 'Update name',
  before_snapshot: null,
  after_snapshot: { id: 'per_1' },
  has_primary_source: true,
  revert_of_revision_id: null,
  created_at: '2026-06-01T00:00:00Z',
} as unknown as RevisionRecord;

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('HttpWikiDataSource behavioral HTTP contract', () => {
  it('handles bundle 200/304 caching, readings 200/404/error, checklist fallbacks, and error envelopes', async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    let bundleMode: 'ok' | '304' | 'err' = 'ok';
    let readingsMode: 'ok' | '404' | 'err' = 'ok';
    let checklistMode: 'ok' | '404' | 'throw' = 'ok';

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method, headers: new Headers(init?.headers) });

      if (url.endsWith('/api/bundle')) {
        if (bundleMode === '304') return new Response(null, { status: 304, headers: { etag: '"r1"' } });
        if (bundleMode === 'err')
          return new Response('gateway down', { status: 502, statusText: 'Bad Gateway' });
        return jsonRes(SAMPLE_BUNDLE, 200, { etag: '"r1"' });
      }
      if (url.endsWith('data/readings.json')) {
        if (readingsMode === '404') return new Response('Not found', { status: 404 });
        if (readingsMode === 'err') {
          return jsonRes({ error: { code: 'READINGS_ERROR', message: 'Corrupt readings' } }, 500);
        }
        return jsonRes({ version: 1, documents: {}, event_page_map: {} });
      }
      if (url.endsWith('data/media-checklist.json')) {
        if (checklistMode === '404') return new Response('Not found', { status: 404 });
        if (checklistMode === 'throw') throw new Error('offline');
        return jsonRes({ items: [{ id: 'chk_1', title: '1880 Census', status: 'needed' }] });
      }
      return new Response('Not found', { status: 404 });
    };

    const ds = createHttpWikiDataSource({
      apiBaseUrl: 'https://wiki.example.test/',
      assetBaseUrl: '/assets',
      fetchImpl,
    });

    const first = await ds.loadArchive();
    expect(first.notModified).toBe(false);
    expect(first.etag).toBe('"r1"');

    bundleMode = '304';
    const second = await ds.loadArchive();
    expect(second.notModified).toBe(true);
    expect(second.etag).toBe('"r1"');

    bundleMode = 'err';
    await expect(ds.loadArchive()).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 502,
      code: 'HTTP_502',
    });

    const readingsOk = await ds.loadReadings();
    expect(readingsOk?.version).toBe(1);
    readingsMode = '404';
    expect(await ds.loadReadings()).toBeNull();
    readingsMode = 'err';
    await expect(ds.loadReadings()).rejects.toBeInstanceOf(ApiClientError);

    expect(await ds.loadMediaChecklist()).toHaveLength(1);
    checklistMode = '404';
    expect(await ds.loadMediaChecklist()).toEqual([]);
    checklistMode = 'throw';
    expect(await ds.loadMediaChecklist()).toEqual([]);
  });

  it('exercises entity CRUD, 409 conflicts, revisions/reverts, media upload, talk, auth, and admin endpoints', async () => {
    let updateMode: 'ok' | '409' | '500' = 'ok';
    let failDelete = false;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';

      if (url.endsWith('/api/auth/me')) {
        return jsonRes({
          session: { authenticated: true, principal_kind: 'user', email: 'a@example.test', role: 'admin' },
          capabilities: {
            canEdit: true,
            canUploadMedia: true,
            hasRevisionHistory: true,
            hasTalk: true,
            canManageSite: true,
          },
        });
      }
      if (url.endsWith('/api/auth/magic-link/request')) return jsonRes({ sent: true });
      if (url.endsWith('/api/auth/logout')) return new Response(null, { status: failDelete ? 500 : 204 });

      if (url.includes('/api/entities/person/per_1/restore')) {
        return jsonRes({ entity: { id: 'per_1' }, revision: SAMPLE_REV, etag: '"r3"' });
      }
      if (url.includes('/api/entities/person/per_1')) {
        if (method === 'GET') {
          return jsonRes({
            entity: { id: 'per_1' },
            current_revision_id: 2,
            has_primary_source: true,
            deleted_at: null,
            updated_at: '2026-06-01T00:00:00Z',
          });
        }
        if (method === 'PUT') {
          if (updateMode === '409') {
            return jsonRes(
              {
                error: {
                  code: 'REVISION_CONFLICT',
                  message: 'Stale parent revision',
                  details: {
                    entity_type: 'person',
                    entity_id: 'per_1',
                    expected_parent_revision_id: 1,
                    server_revision_id: 2,
                    server_entity: { id: 'per_1' },
                    server_deleted_at: null,
                    last_author_name: 'Clara',
                    last_updated_at: '2026-06-01T00:00:00Z',
                    diff: { hasChanges: true, addedCount: 0, removedCount: 0, changedCount: 1, fields: [] },
                  },
                },
              },
              409
            );
          }
          if (updateMode === '500') {
            return jsonRes({ error: { code: 'SERVER_ERROR', message: 'Boom' } }, 500);
          }
          return jsonRes({ entity: { id: 'per_1' }, revision: SAMPLE_REV, etag: '"r2"' });
        }
        if (method === 'DELETE') {
          return jsonRes({ revision: SAMPLE_REV, etag: '"r4"' });
        }
      }
      if (url.endsWith('/api/entities/person') && method === 'POST') {
        return jsonRes({ entity: { id: 'per_1' }, revision: SAMPLE_REV, etag: '"r1"' }, 201);
      }

      if (url.includes('/api/revisions/2/revert')) {
        return jsonRes({ revision: SAMPLE_REV, etag: '"r5"' });
      }
      if (url.includes('/api/revisions')) {
        return jsonRes({ items: [SAMPLE_REV], next_cursor: 1 });
      }
      if (url.includes('/api/batches/bat_1/revert')) {
        return jsonRes({ revisions: [SAMPLE_REV], etag: '"r6"' });
      }
      if (url.endsWith('/api/media/upload')) {
        if (failDelete) return jsonRes({ error: { code: 'PRIVACY_VIOLATION', message: 'Living' } }, 422);
        return jsonRes({
          media: { id: 'med_1', kind: 'portrait', file: '/media/a.jpg', caption: 'A' },
          url: '/media/a.jpg',
          revision: SAMPLE_REV,
          etag: '"r7"',
        });
      }

      if (url.includes('/api/talk/person/per_1/9') && method === 'DELETE') {
        return new Response(null, { status: failDelete ? 403 : 204 });
      }
      if (url.includes('/api/talk/person/per_1')) {
        if (method === 'POST') {
          return jsonRes({
            comment: {
              comment_id: 9,
              entity_type: 'person',
              entity_id: 'per_1',
              author_email: 'a@example.test',
              author_name: 'Admin',
              body_md: 'Note',
              created_at: '2026-06-01T00:00:00Z',
              deleted_at: null,
            },
          });
        }
        return jsonRes({ comments: [] });
      }

      if (url.includes('/api/admin/users/u%40example.test')) {
        if (method === 'PATCH') {
          return jsonRes({
            user: {
              email: 'u@example.test',
              display_name: 'U',
              role: 'admin',
              added_by: 'a@example.test',
              added_at: '2026-06-01T00:00:00Z',
              last_login_at: null,
            },
          });
        }
        if (method === 'DELETE') return new Response(null, { status: failDelete ? 409 : 204 });
      }
      if (url.endsWith('/api/admin/users')) {
        if (method === 'POST') {
          return jsonRes({
            user: {
              email: 'u@example.test',
              display_name: 'U',
              role: 'editor',
              added_by: 'a@example.test',
              added_at: '2026-06-01T00:00:00Z',
              last_login_at: null,
            },
          });
        }
        return jsonRes({ users: [] });
      }
      if (url.includes('/api/admin/invites/inv_1') && method === 'DELETE') {
        return new Response(null, { status: failDelete ? 404 : 204 });
      }
      if (url.endsWith('/api/admin/invites')) {
        if (method === 'POST') {
          return jsonRes({
            invite: {
              token: 'inv_1',
              label: 'Family',
              created_by: 'a@example.test',
              created_at: '2026-06-01T00:00:00Z',
              expires_at: '2026-07-01T00:00:00Z',
              revoked_at: null,
              uses: 0,
              last_used_at: null,
            },
            invite_url: 'https://wiki.example.test/invite/inv_1',
          });
        }
        return jsonRes({ invites: [] });
      }
      if (url.includes('/api/admin/agent-tokens/tok_1') && method === 'DELETE') {
        return new Response(null, { status: failDelete ? 404 : 204 });
      }
      if (url.endsWith('/api/admin/agent-tokens')) {
        if (method === 'POST') {
          return jsonRes({
            token_id: 'tok_1',
            label: 'Sync',
            scope: 'write_batch',
            plaintext_secret: 'secret_abc',
          });
        }
        return jsonRes({ tokens: [] });
      }

      return new Response('Unhandled', { status: 404 });
    };

    const ds = createHttpWikiDataSource({ apiBaseUrl: 'https://wiki.example.test', fetchImpl });

    expect((await ds.getSession()).session.authenticated).toBe(true);
    expect((await ds.requestMagicLink('a@example.test', { next: '/admin' })).sent).toBe(true);
    expect(ds.getGoogleSignInUrl('/tree', { selectAccount: true })).toBe(
      'https://wiki.example.test/api/auth/google/start?next=%2Ftree&select_account=1'
    );
    expect(ds.getGoogleSignInUrl()).toBe('https://wiki.example.test/api/auth/google/start');
    await ds.logout();

    expect((await ds.getEntity('person', 'per_1')).current_revision_id).toBe(2);
    expect(
      (await ds.createEntity('person', { data: { id: 'per_1' }, has_primary_source: true, summary: 'Add' }))
        .etag
    ).toBe('"r1"');

    const updOk = await ds.updateEntity('person', 'per_1', {
      expected_parent_revision_id: asRevisionId(1),
      data: { id: 'per_1' },
      has_primary_source: true,
      summary: 'Edit',
    });
    expect(updOk.ok).toBe(true);

    updateMode = '409';
    const updConflict = await ds.updateEntity('person', 'per_1', {
      expected_parent_revision_id: asRevisionId(1),
      data: { id: 'per_1' },
      has_primary_source: true,
      summary: 'Edit stale',
    });
    expect(updConflict.ok).toBe(false);
    if (!updConflict.ok) {
      expect(updConflict.conflict.server_revision_id).toBe(2);
    }

    updateMode = '500';
    await expect(
      ds.updateEntity('person', 'per_1', {
        expected_parent_revision_id: asRevisionId(1),
        data: { id: 'per_1' },
        has_primary_source: true,
        summary: 'Edit err',
      })
    ).rejects.toBeInstanceOf(ApiClientError);

    expect(
      (
        await ds.deleteEntity('person', 'per_1', {
          expected_parent_revision_id: asRevisionId(2),
          summary: 'Del',
        })
      ).etag
    ).toBe('"r4"');
    expect(
      (
        await ds.restoreEntity('person', 'per_1', {
          expected_parent_revision_id: asRevisionId(3),
          data: { id: 'per_1' },
          summary: 'Restore',
        })
      ).etag
    ).toBe('"r3"');

    const revs = await ds.listRevisions({
      entity_type: 'person',
      entity_id: 'per_1',
      batch_id: asBatchId('bat_1'),
      author_type: 'human',
      cursor: asRevisionId(5),
      limit: 10,
    });
    expect(revs.items).toHaveLength(1);
    expect(revs.next_cursor).toBe(1);
    expect((await ds.revertRevision(asRevisionId(2), 'Undo')).etag).toBe('"r5"');
    expect((await ds.revertBatch(asBatchId('bat_1'), 'Undo batch')).etag).toBe('"r6"');

    const fd = new FormData();
    expect((await ds.uploadMedia(fd)).url).toBe('/media/a.jpg');

    expect(await ds.listTalkComments('person', 'per_1')).toEqual([]);
    expect((await ds.postTalkComment('person', 'per_1', 'Note')).comment_id).toBe(9);
    await ds.deleteTalkComment('person', 'per_1', 9);

    expect(await ds.listUsers()).toEqual([]);
    expect((await ds.createUser({ email: 'u@example.test', display_name: 'U', role: 'editor' })).role).toBe(
      'editor'
    );
    expect((await ds.updateUserRole('u@example.test', { role: 'admin' })).role).toBe('admin');
    await ds.deleteUser('u@example.test');

    expect(await ds.listInvites()).toEqual([]);
    expect((await ds.createInvite({ label: 'Family', expires_in_days: 30 })).invite.token).toBe('inv_1');
    await ds.revokeInvite('inv_1');

    expect(await ds.listAgentTokens()).toEqual([]);
    expect((await ds.createAgentToken({ label: 'Sync', scope: 'write_batch' })).plaintext_secret).toBe(
      'secret_abc'
    );
    await ds.revokeAgentToken('tok_1');

    // Error paths on DELETE/POST endpoints
    failDelete = true;
    await expect(ds.logout()).rejects.toBeInstanceOf(ApiClientError);
    await expect(ds.uploadMedia(fd)).rejects.toBeInstanceOf(ApiClientError);
    await expect(ds.deleteTalkComment('person', 'per_1', 9)).rejects.toBeInstanceOf(ApiClientError);
    await expect(ds.deleteUser('u@example.test')).rejects.toBeInstanceOf(ApiClientError);
    await expect(ds.revokeInvite('inv_1')).rejects.toBeInstanceOf(ApiClientError);
    await expect(ds.revokeAgentToken('tok_1')).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe('StaticDemoDataSource behavioral contract', () => {
  it('loads static archive, readings (200/404/error), media checklist fallbacks, and anonymous session', async () => {
    let mode: 'ok' | '404' | 'err' = 'ok';
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('data/archive.json')) {
        if (mode === 'err') return new Response('fail', { status: 500 });
        return jsonRes(SAMPLE_BUNDLE, 200, { etag: '"static-1"' });
      }
      if (url.endsWith('data/readings.json')) {
        if (mode === '404') return new Response('no', { status: 404 });
        if (mode === 'err') return new Response('fail', { status: 500 });
        return jsonRes({ version: 1, documents: {}, event_page_map: {} });
      }
      if (url.endsWith('data/media-checklist.json')) {
        if (mode === '404') return new Response('no', { status: 404 });
        if (mode === 'err') throw new Error('network');
        return jsonRes({ items: [{ id: 'c1', title: 'Scan', status: 'needed' }] });
      }
      return new Response('404', { status: 404 });
    };

    const ds = new StaticDemoDataSource('/demo', fetchImpl);
    const loaded = await ds.loadArchive();
    expect(loaded.etag).toBe('"static-1"');
    expect(loaded.notModified).toBe(false);
    expect((await ds.loadReadings())?.version).toBe(1);
    expect(await ds.loadMediaChecklist()).toHaveLength(1);
    expect((await ds.getSession()).session.authenticated).toBe(false);

    mode = '404';
    expect(await ds.loadReadings()).toBeNull();
    expect(await ds.loadMediaChecklist()).toEqual([]);

    mode = 'err';
    await expect(ds.loadArchive()).rejects.toThrow(/HTTP 500/);
    await expect(ds.loadReadings()).rejects.toThrow(/HTTP 500/);
    expect(await ds.loadMediaChecklist()).toEqual([]);
  });
});
