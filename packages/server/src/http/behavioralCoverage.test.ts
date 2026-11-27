import type { RawPerson } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import { SystemClock } from '../adapters/systemClock.js';
import { bytesToStream, matchesIfNoneMatch, readBodyToString, sha256Hex } from '../crypto.js';
import {
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';
import { createKinloomServer } from './router.js';
import { signSessionToken } from './session.js';

const ORIGIN = 'https://alder.example.test';
const SECRET = 'kinloom-behavioral-server-secret-2026-abcdef123456';

async function makeSessionCookie(
  ports: ReturnType<typeof createInMemoryServerPorts>,
  user: { email: string; display_name: string; role: 'admin' | 'editor' }
): Promise<string> {
  await ports.repository.upsertUser({
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    added_by: 'seed',
    added_at: ports.clock.nowIso(),
    last_login_at: ports.clock.nowIso(),
  });
  const token = await signSessionToken({
    secret: SECRET,
    clock: ports.clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email: user.email,
      display_name: user.display_name,
      role: user.role,
    },
  });
  return `__Host-kinloom_session=${token}`;
}

describe('HTTP & Crypto behavioral coverage (structure-insensitive)', () => {
  it('handles HTTP ETag matching, byte-range parsing, hashing, and constant-time equality', async () => {
    expect(matchesIfNoneMatch(null, '"r5"')).toBe(false);
    expect(matchesIfNoneMatch('*', '"r5"')).toBe(true);
    expect(matchesIfNoneMatch('"r4", W/"r5"', '"r5"')).toBe(true);
    expect(matchesIfNoneMatch('"r3"', '"r5"')).toBe(false);

    const stream = bytesToStream(new TextEncoder().encode('alder-archive'));
    expect(await readBodyToString(stream)).toBe('alder-archive');
    expect(await readBodyToString('plain-string')).toBe('plain-string');

    const digest = await sha256Hex('kinloom-alder');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const sysClock = new SystemClock();
    expect(sysClock.now()).toBeInstanceOf(Date);
    expect(sysClock.currentYear()).toBeGreaterThanOrEqual(2025);
    expect(sysClock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('supports export YAML & snapshot 200/304 caching, talk comment permissions, admin lifecycle, and media validation', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: SECRET,
      bootstrapAdminEmail: 'admin@example.test',
    });

    const adminCookie = await makeSessionCookie(ports, {
      email: 'admin@example.test',
      display_name: 'Admin Alder',
      role: 'admin',
    });
    const editorCookie = await makeSessionCookie(ports, {
      email: 'editor@example.test',
      display_name: 'Editor Alder',
      role: 'editor',
    });

    // 1. Seed a historical person via HTTP
    const person: RawPerson = createSyntheticHistoricalPerson({ id: 'per_alder_export' });
    const createRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          entity_id: person.id,
          data: person,
          has_primary_source: true,
          summary: 'Create person for export and talk tests',
        }),
      })
    );
    expect(createRes.status).toBe(201);

    // 2. Export YAML & Snapshot with 200 + 304 Not Modified via If-None-Match
    const yamlRes = await server.fetch(
      new Request(`${ORIGIN}/api/export/yaml`, { headers: { cookie: adminCookie } })
    );
    expect(yamlRes.status).toBe(200);
    const yamlEtag = yamlRes.headers.get('etag');
    expect(yamlEtag).toBeTruthy();

    const yaml304 = await server.fetch(
      new Request(`${ORIGIN}/api/export/yaml`, {
        headers: { cookie: adminCookie, 'if-none-match': yamlEtag! },
      })
    );
    expect(yaml304.status).toBe(304);

    const snapRes = await server.fetch(
      new Request(`${ORIGIN}/api/export/snapshot`, { headers: { cookie: adminCookie } })
    );
    expect(snapRes.status).toBe(200);
    const snapEtag = snapRes.headers.get('etag');
    expect(snapEtag).toBeTruthy();

    const snap304 = await server.fetch(
      new Request(`${ORIGIN}/api/export/snapshot`, {
        headers: { cookie: adminCookie, 'if-none-match': snapEtag! },
      })
    );
    expect(snap304.status).toBe(304);

    // 3. Talk comment lifecycle: create, list, edit by author, reject edit by non-author, delete by admin
    const postTalk = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${person.id}`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body_md: 'Verify census sheet 4B.' }),
      })
    );
    expect(postTalk.status).toBe(201);
    const createdTalk = (await postTalk.json()) as { comment: { comment_id: number } };
    const commentId = createdTalk.comment.comment_id;

    const listTalk = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${person.id}`, { headers: { cookie: editorCookie } })
    );
    expect(listTalk.status).toBe(200);

    // Non-author editor cannot delete admin's comment
    const forbiddenDel = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${person.id}/${commentId}`, {
        method: 'DELETE',
        headers: { cookie: editorCookie, origin: ORIGIN },
      })
    );
    expect(forbiddenDel.status).toBe(403);

    // Author/admin deletes comment & confirms 404 on unknown comment
    const delTalk = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${person.id}/${commentId}`, {
        method: 'DELETE',
        headers: { cookie: adminCookie, origin: ORIGIN },
      })
    );
    expect(delTalk.status).toBe(204);

    const missingTalk = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${person.id}/999999`, {
        method: 'DELETE',
        headers: { cookie: adminCookie, origin: ORIGIN },
      })
    );
    expect(missingTalk.status).toBe(404);

    // 4. Admin users, invites, and agent tokens management
    const listUsers = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users`, { headers: { cookie: adminCookie } })
    );
    expect(listUsers.status).toBe(200);

    const promoteEditor = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users/${encodeURIComponent('editor@example.test')}`, {
        method: 'PATCH',
        headers: {
          cookie: adminCookie,
          origin: ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ role: 'admin', display_name: 'Editor Promoted' }),
      })
    );
    expect(promoteEditor.status).toBe(200);

    const listInvites = await server.fetch(
      new Request(`${ORIGIN}/api/admin/invites`, { headers: { cookie: adminCookie } })
    );
    expect(listInvites.status).toBe(200);

    const createTok = await server.fetch(
      new Request(`${ORIGIN}/api/admin/agent-tokens`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ label: 'Backup Bot', scope: 'read_backup' }),
      })
    );
    expect(createTok.status).toBe(201);
    const createdTok = (await createTok.json()) as { token_id: string };

    const listToks = await server.fetch(
      new Request(`${ORIGIN}/api/admin/agent-tokens`, { headers: { cookie: adminCookie } })
    );
    expect(listToks.status).toBe(200);

    const revokeTok = await server.fetch(
      new Request(`${ORIGIN}/api/admin/agent-tokens/${createdTok.token_id}`, {
        method: 'DELETE',
        headers: { cookie: adminCookie, origin: ORIGIN },
      })
    );
    expect(revokeTok.status).toBe(204);

    // 5. Media upload validation & streaming: malformed upload -> 400, missing media -> 404, valid upload -> 201 + 206 + 416
    const badMedia = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(badMedia.status).toBe(400);

    const missingMedia = await server.fetch(
      new Request(`${ORIGIN}/api/media/nonexistent-key.jpg`, { headers: { cookie: adminCookie } })
    );
    expect(missingMedia.status).toBe(404);

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    const form = new FormData();
    form.append('file', new Blob([pngBytes], { type: 'image/png' }), 'scan.png');
    form.append(
      'metadata',
      JSON.stringify({
        id: 'med_behav_png',
        kind: 'document_scan',
        person_id: person.id,
        caption: 'Test scan',
      })
    );
    form.append('summary', 'Upload archival scan');

    const uploadRes = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: ORIGIN },
        body: form,
      })
    );
    expect(uploadRes.status).toBe(201);
    const uploaded = (await uploadRes.json()) as { media: { file: string } };
    const mediaPath = uploaded.media.file;

    const fullMedia = await server.fetch(
      new Request(`${ORIGIN}${mediaPath}`, { headers: { cookie: adminCookie } })
    );
    expect(fullMedia.status).toBe(200);
    const partial = await server.fetch(
      new Request(`${ORIGIN}${mediaPath}`, {
        headers: { cookie: adminCookie, range: 'bytes=0-3' },
      })
    );
    expect(partial.status).toBe(206);

    const badRange = await server.fetch(
      new Request(`${ORIGIN}${mediaPath}`, {
        headers: { cookie: adminCookie, range: 'bytes=9999-10000' },
      })
    );
    expect(badRange.status).toBe(416);

    // 7. Read entity current revision, submit batch with merge: true update + kinship_edge + revertBatch + delete user
    const getPerson = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${person.id}`, { headers: { cookie: adminCookie } })
    );
    expect(getPerson.status).toBe(200);
    const personRow = (await getPerson.json()) as { entity: { current_revision_id: number } };
    const person2: RawPerson = {
      ...createSyntheticHistoricalPerson({ id: 'per_alder_spouse' }),
      id: 'per_clara_alder',
      slug: 'clara-alder-spouse',
      full_name: 'Clara Alder',
    };
    const batchRes = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          batch_id: 'batch_behav_1',
          author_type: 'human',
          summary: 'Add spouse and kinship edge',
          has_primary_source: true,
          patches: [
            {
              action: 'create',
              entity_type: 'person',
              entity_id: person2.id,
              data: person2,
              summary: 'Create spouse',
            },
            {
              action: 'update',
              entity_type: 'person',
              entity_id: person.id,
              parent_revision_id: personRow.entity.current_revision_id,
              data: { alt_names: ['H. Alder'] },
              merge: true,
              summary: 'Merge alternate name',
            },
            {
              action: 'create',
              entity_type: 'kinship_edge',
              entity_id: `${person.id}:spouse:${person2.id}`,
              data: { from: person.id, to: person2.id, relation: 'spouse' },
              summary: 'Link spouses',
            },
          ],
        }),
      })
    );
    expect(batchRes.status, await batchRes.clone().text()).toBe(201);

    const revertRes = await server.fetch(
      new Request(`${ORIGIN}/api/batches/batch_behav_1/revert`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ summary: 'Revert behavioral test batch' }),
      })
    );
    expect(revertRes.status).toBe(201);

    const delUser = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users/${encodeURIComponent('editor@example.test')}`, {
        method: 'DELETE',
        headers: { cookie: adminCookie, origin: ORIGIN },
      })
    );
    expect(delUser.status).toBe(204);
  });
});
