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
            revision: { revision_id: 10 },
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

    const tokenRes = await ds.createAgentToken({ label: 'Research CLI', scope: 'write_batch' });
    expect(tokenRes.plaintext_secret).toBe('klm_secret_once');
  });
});
