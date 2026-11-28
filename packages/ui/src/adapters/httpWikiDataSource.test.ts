import { asBatchId, asRevisionId } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { HttpWikiDataSource } from './httpWikiDataSource.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('HttpWikiDataSource', () => {
  it('sends If-None-Match on repeat loadArchive and returns cached bundle on 304', async () => {
    const requests: RequestInit[] = [];
    const bundlePayload = {
      meta: {
        build_mode: 'private',
        generated_at: '2026-11-24T00:00:00Z',
        max_revision_id: 7,
        counts: {
          people: 0,
          living_redacted: 0,
          events: 0,
          residence_spans: 0,
          places: 0,
          sources: 0,
        },
      },
      people: [],
      events: [],
      residence_spans: [],
      places: [],
      place_ancestors: {},
      kinship: [],
      sources: [],
    };

    const ds = new HttpWikiDataSource({
      fetchImpl: async (_url, init) => {
        requests.push(init ?? {});
        if (requests.length === 1) {
          return jsonResponse(bundlePayload, 200, { etag: '"r7"' });
        }
        return new Response(null, { status: 304, headers: { etag: '"r7"' } });
      },
    });

    const first = await ds.loadArchive();
    expect(first.notModified).toBe(false);
    expect(first.etag).toBe('"r7"');

    const second = await ds.loadArchive();
    expect(second.notModified).toBe(true);
    expect(second.bundle.meta.max_revision_id).toBe(7);
    const headers = requests[1]?.headers as Record<string, string>;
    expect(headers['if-none-match']).toBe('"r7"');
  });

  it('maps HTTP 409 Conflict envelope into structured { ok: false, conflict }', async () => {
    const ds = new HttpWikiDataSource({
      fetchImpl: async () =>
        jsonResponse(
          {
            error: {
              code: 'OPTIMISTIC_CONFLICT',
              message: 'Entity person/p_1 was modified by another editor.',
              details: {
                kind: 'conflict',
                entity_type: 'person',
                entity_id: 'p_1',
                expected_parent_revision_id: 3,
                server_revision_id: 4,
                server_entity: { id: 'p_1', full_name: 'Clara Barton' },
                server_deleted_at: null,
                last_author_name: 'Jane Editor',
                last_updated_at: '2026-11-24T12:00:00Z',
                diff: {
                  fields: [
                    {
                      path: 'full_name',
                      kind: 'changed',
                      before: 'Clara Barton',
                      after: 'Clarissa Barton',
                    },
                  ],
                  addedCount: 0,
                  removedCount: 0,
                  changedCount: 1,
                  hasChanges: true,
                },
              },
            },
          },
          409
        ),
    });

    const res = await ds.updateEntity('person', 'p_1', {
      data: { id: 'p_1', full_name: 'Clarissa Barton' },
      expected_parent_revision_id: asRevisionId(3),
      summary: 'Update full name',
      has_primary_source: true,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.conflict.server_revision_id).toBe(4);
      expect(res.conflict.last_author_name).toBe('Jane Editor');
    }
  });

  it('supports revisions, batch revert, talk, uploadMedia AbortSignal, and admin endpoints', async () => {
    const calls: { url: string; method: string; hasSignal: boolean }[] = [];
    const ds = new HttpWikiDataSource({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method, hasSignal: Boolean(init?.signal) });
        if (url === '/api/auth/me') {
          return jsonResponse({
            session: { authenticated: true, principal_kind: 'user', role: 'admin', email: 'a@example.com' },
            capabilities: {
              canEdit: true,
              canUploadMedia: true,
              hasRevisionHistory: true,
              hasTalk: true,
              canManageSite: true,
            },
          });
        }
        if (url.startsWith('/api/batches/batch_1/revert')) {
          return jsonResponse({ revisions: [], etag: '"r9"' }, 201);
        }
        if (url === '/api/media/upload') {
          return jsonResponse({
            media: { id: 'm1', kind: 'portrait', file: '/media/abc.jpg', caption: 'Portrait' },
            url: '/media/abc.jpg',
            revision: {
              revision_id: 10,
              batch_id: null,
              entity_type: 'media',
              entity_id: 'm1',
              parent_revision_id: null,
              action: 'create',
              reverted_revision_id: null,
              author_id: 'a@example.com',
              author_name: 'Admin',
              author_type: 'human',
              summary: 'Upload portrait',
              has_primary_source: true,
              before_json: null,
              after_json: { id: 'm1' },
              created_at: '2026-11-24T00:00:00Z',
            },
            etag: '"r10"',
          });
        }
        if (url === '/api/admin/agent-tokens' && method === 'POST') {
          return jsonResponse(
            {
              token_id: 'tok_1',
              label: 'Research CLI',
              scope: 'write_batch',
              plaintext_secret: 'klm_secret_once',
            },
            201
          );
        }
        return jsonResponse({ ok: true });
      },
    });

    const sessionRes = await ds.getSession();
    expect(sessionRes.session.role).toBe('admin');

    const batchRes = await ds.revertBatch(asBatchId('batch_1'), 'Undo research wave');
    expect(batchRes.etag).toBe('"r9"');

    const controller = new AbortController();
    const form = new FormData();
    const uploadRes = await ds.uploadMedia(form, { signal: controller.signal });
    expect(uploadRes.url).toBe('/media/abc.jpg');
    expect(calls.find((c) => c.url === '/api/media/upload')?.hasSignal).toBe(true);

    const tokenRes = await ds.admin.createAgentToken({ label: 'Research CLI', scope: 'write_batch' });
    expect(tokenRes.plaintext_secret).toBe('klm_secret_once');
  });

  it('supports loadPronunciations, upsertPronunciationTerm, generatePronunciationAudio, and rejects malformed JSON envelopes', async () => {
    const requests: Array<{ url: string; method: string; credentials?: RequestCredentials }> = [];
    let notFoundPronunciations = false;
    let corruptSession = false;

    const ds = new HttpWikiDataSource({
      apiBaseUrl: 'https://archive.example.test',
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        requests.push({
          url,
          method,
          ...(init?.credentials !== undefined ? { credentials: init.credentials } : {}),
        });

        if (url.endsWith('/api/pronunciations') && method === 'GET') {
          if (notFoundPronunciations) {
            return new Response('Not found', { status: 404 });
          }
          return jsonResponse({
            pronunciations: {
              Alder: { phonetic: 'AWL-der', ipa: '/ˈɔːl.dər/', language: 'en-US' },
            },
          });
        }
        if (url.endsWith('/api/pronunciations/Alder') && method === 'PUT') {
          return jsonResponse({
            term: 'Alder',
            pronunciation: { phonetic: 'AHL-der', ipa: '/ˈɑːl.dər/' },
            pronunciations: {
              Alder: { phonetic: 'AHL-der', ipa: '/ˈɑːl.dər/' },
            },
          });
        }
        if (url.endsWith('/api/pronunciation/generate') && method === 'POST') {
          return jsonResponse({
            audio_url: '/media/audio/alder.mp3',
            content_type: 'audio/mpeg',
            size_bytes: 1234,
          });
        }
        if (url.endsWith('/api/auth/me') && corruptSession) {
          return jsonResponse({ session: 'not-an-object' });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    const loaded = await ds.loadPronunciations();
    expect(loaded?.['Alder']?.phonetic).toBe('AWL-der');
    expect(requests[0]).toEqual({
      url: 'https://archive.example.test/api/pronunciations',
      method: 'GET',
      credentials: 'same-origin',
    });

    notFoundPronunciations = true;
    expect(await ds.loadPronunciations()).toBeUndefined();

    const upserted = await ds.upsertPronunciationTerm('Alder', {
      phonetic: 'AHL-der',
      ipa: '/ˈɑːl.dər/',
    });
    expect(upserted.pronunciations['Alder']?.phonetic).toBe('AHL-der');

    const generated = await ds.generatePronunciationAudio({
      entity_type: 'person',
      entity_id: 'per_1',
      text: 'Alder',
      phonetic: 'AHL-der',
    });
    expect(generated.audio_url).toBe('/media/audio/alder.mp3');

    corruptSession = true;
    await expect(ds.getSession()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'INVALID_API_RESPONSE',
    });
  });

  it('rejects malformed archive bundles, malformed revisions, and invalid media checklist items with INVALID_API_RESPONSE', async () => {
    let mode: 'bad-bundle' | 'bad-rev-type' | 'bad-rev-action' | 'bad-rev-author' | 'bad-checklist' =
      'bad-bundle';

    const ds = new HttpWikiDataSource({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === '/api/bundle') {
          return jsonResponse({
            meta: {
              build_mode: 'public',
              generated_at: '2026-11-24T00:00:00Z',
              counts: {
                people: 0,
                living_redacted: 0,
                events: 0,
                residence_spans: 0,
                places: 0,
                sources: 0,
              },
            },
            // Missing required top-level bundle arrays
          });
        }
        if (url.startsWith('/api/revisions')) {
          const baseRev = {
            revision_id: 11,
            batch_id: null,
            entity_type: 'person',
            entity_id: 'per_1',
            parent_revision_id: null,
            action: 'update',
            reverted_revision_id: null,
            author_id: 'editor@example.test',
            author_name: 'Editor',
            author_type: 'human',
            summary: 'Edit',
            has_primary_source: true,
            before_json: null,
            after_json: { id: 'per_1' },
            created_at: '2026-11-24T00:00:00Z',
          };
          const badRev =
            mode === 'bad-rev-type'
              ? { ...baseRev, entity_type: 'unknown_entity' }
              : mode === 'bad-rev-action'
                ? { ...baseRev, action: 'obliterate' }
                : { ...baseRev, author_type: 'mystery_bot' };
          return jsonResponse({ items: [badRev], next_cursor: null });
        }
        if (url.endsWith('data/media-checklist.json')) {
          return jsonResponse({ items: [{ id: 'bad_item', title: 'Missing required fields' }] });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    await expect(ds.loadArchive()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'INVALID_API_RESPONSE',
    });

    mode = 'bad-rev-type';
    await expect(ds.listRevisions()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'INVALID_API_RESPONSE',
    });

    mode = 'bad-rev-action';
    await expect(ds.listRevisions()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'INVALID_API_RESPONSE',
    });

    mode = 'bad-rev-author';
    await expect(ds.listRevisions()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'INVALID_API_RESPONSE',
    });

    mode = 'bad-checklist';
    await expect(ds.loadMediaChecklist()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'INVALID_API_RESPONSE',
    });
  });
});
