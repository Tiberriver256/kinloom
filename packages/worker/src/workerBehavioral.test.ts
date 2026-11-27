import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawPerson } from '@kinloom/core';
import { FixedClock, signSessionToken } from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
} from '@kinloom/server/testing';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  createCloudflareWorker,
  D1ArchiveRepository,
  type D1Database,
  type Fetcher,
  type KinloomWorkerEnv,
  type R2Bucket,
} from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const INITIAL_MIGRATION_SQL = readFileSync(resolve(THIS_DIR, '../migrations/0001_initial.sql'), 'utf8');

async function applySqlScript(db: D1Database, sqlScript: string): Promise<void> {
  const withoutComments = sqlScript
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');
  const statements = withoutComments
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
  if (statements.length > 0) {
    await db.batch(statements.map((stmt) => db.prepare(stmt)));
  }
}

describe('Cloudflare Worker behavioral lifecycle (talk, admin D1 store, and static asset routing)', () => {
  it('persists D1 talk comments, admin user/invite/token management, and enforces asset routing rules', async () => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      d1Databases: { DB: 'kinloom-behav-db' },
      r2Buckets: { MEDIA_BUCKET: 'kinloom-behav-bucket' },
    });

    try {
      const db = (await mf.getD1Database('DB')) as unknown as D1Database;
      const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;
      await applySqlScript(db, INITIAL_MIGRATION_SQL);

      const siteConfig = createSyntheticSiteConfig();
      const clock = new FixedClock(new Date('2026-11-26T12:00:00.000Z'));
      const repo = new D1ArchiveRepository(db);

      await repo.upsertUser({
        email: 'admin@example.test',
        display_name: 'Admin Alder',
        role: 'admin',
        added_by: 'bootstrap',
        added_at: clock.nowIso(),
        last_login_at: clock.nowIso(),
      });
      await repo.upsertUser({
        email: 'editor@example.test',
        display_name: 'Editor Alder',
        role: 'editor',
        added_by: 'admin@example.test',
        added_at: clock.nowIso(),
        last_login_at: clock.nowIso(),
      });

      const adminToken = await signSessionToken({
        secret: CONTRACT_SESSION_SECRET,
        clock,
        ttlSeconds: 3600,
        payload: {
          kind: 'user',
          email: 'admin@example.test',
          display_name: 'Admin Alder',
          role: 'admin',
        },
      });
      const adminCookie = `__Host-kinloom_session=${adminToken}`;

      const fakeAssets: Fetcher = {
        fetch: async (input) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          );
          if (url.pathname === '/assets/app-abc123.js') {
            return new Response('console.log("ok");', {
              status: 200,
              headers: { 'content-type': 'application/javascript' },
            });
          }
          if (url.pathname === '/index.html' || url.pathname === '/') {
            return new Response('<!doctype html><html><body>Kinloom</body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          return new Response('Not found', { status: 404 });
        },
      };

      const env: KinloomWorkerEnv = {
        DB: db,
        MEDIA_BUCKET: bucket,
        ASSETS: fakeAssets,
        SESSION_SECRET: CONTRACT_SESSION_SECRET,
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.test',
      };

      const worker = createCloudflareWorker({ siteConfig, clock });

      // 1. Seed a person and exercise full D1 talk comment CRUD over HTTP
      const person: RawPerson = createSyntheticHistoricalPerson({ id: 'per_d1_talk' });
      const createPerson = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({
            entity_id: person.id,
            data: person,
            has_primary_source: true,
            summary: 'Seed person for D1 talk',
          }),
        }),
        env
      );
      expect(createPerson.status).toBe(201);

      const postTalk = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/talk/person/${person.id}`, {
          method: 'POST',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ body_md: 'Check 1890 tax roll.' }),
        }),
        env
      );
      expect(postTalk.status).toBe(201);
      const { comment } = (await postTalk.json()) as { comment: { comment_id: number } };

      const listTalk = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/talk/person/${person.id}`, {
          headers: { cookie: adminCookie },
        }),
        env
      );
      expect(listTalk.status).toBe(200);
      const talkList = (await listTalk.json()) as { comments: Array<{ comment_id: number }> };
      expect(talkList.comments.some((c) => c.comment_id === comment.comment_id)).toBe(true);

      const delTalk = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/talk/person/${person.id}/${comment.comment_id}`, {
          method: 'DELETE',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN },
        }),
        env
      );
      expect(delTalk.status).toBe(204);

      // 2. Admin D1 user, invite, and token list/update/revoke endpoints
      const listUsers = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/users`, { headers: { cookie: adminCookie } }),
        env
      );
      expect(listUsers.status).toBe(200);

      const updateRole = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/users/${encodeURIComponent('editor@example.test')}`, {
          method: 'PATCH',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'admin', display_name: 'Editor Admin' }),
        }),
        env
      );
      expect(updateRole.status).toBe(200);

      const deleteUser = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/users/${encodeURIComponent('editor@example.test')}`, {
          method: 'DELETE',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN },
        }),
        env
      );
      expect(deleteUser.status).toBe(204);

      const createInvite = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/invites`, {
          method: 'POST',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'Cousin Invite', expires_in_days: 7 }),
        }),
        env
      );
      expect(createInvite.status).toBe(201);
      const createdInv = (await createInvite.json()) as { invite: { token: string } };

      const listInvites = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/invites`, { headers: { cookie: adminCookie } }),
        env
      );
      expect(listInvites.status).toBe(200);

      const revokeInvite = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/invites/${createdInv.invite.token}`, {
          method: 'DELETE',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN },
        }),
        env
      );
      expect(revokeInvite.status).toBe(204);

      const createTok = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/agent-tokens`, {
          method: 'POST',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'CI Sync', scope: 'read_backup' }),
        }),
        env
      );
      expect(createTok.status).toBe(201);
      const createdTok = (await createTok.json()) as { token_id: string };

      const listToks = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/agent-tokens`, { headers: { cookie: adminCookie } }),
        env
      );
      expect(listToks.status).toBe(200);

      const delTok = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/agent-tokens/${createdTok.token_id}`, {
          method: 'DELETE',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN },
        }),
        env
      );
      expect(delTok.status).toBe(204);

      // 3. Cloudflare static asset routing behavior through worker.fetch()
      const staticJs = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/assets/app-abc123.js`), env);
      expect(staticJs.status).toBe(200);
      expect(staticJs.headers.get('x-content-type-options')).toBe('nosniff');

      const faviconSvg = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/favicon.svg`), env);
      expect(faviconSvg.status).toBe(200);
      expect(faviconSvg.headers.get('content-type')).toContain('image/svg+xml');

      const faviconIco = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/favicon.ico`), env);
      expect(faviconIco.status).toBe(404);

      const spaRoute = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/person/henry-alder`), env);
      expect(spaRoute.status).toBe(200);
      expect(await spaRoute.text()).toContain('Kinloom');

      const deletePerson = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/${person.id}`, {
          method: 'DELETE',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ expected_parent_revision_id: 1, summary: 'Soft delete in worker' }),
        }),
        env
      );
      expect(deletePerson.status, await deletePerson.clone().text()).toBe(200);
      const delJson = (await deletePerson.json()) as { revision: { revision_id: number } };

      const restorePerson = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/${person.id}/restore`, {
          method: 'POST',
          headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({
            expected_parent_revision_id: delJson.revision.revision_id,
            summary: 'Restore in worker',
          }),
        }),
        env
      );
      expect(restorePerson.status).toBe(200);

      const missingFile = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/missing-file.txt`), env);
      expect(missingFile.status).toBe(404);

      const noAssetsEnv: KinloomWorkerEnv = { ...env, ASSETS: undefined };
      const exportYaml = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/export/yaml`, { headers: { cookie: adminCookie } }),
        env
      );
      expect(exportYaml.status).toBe(200);

      const exportSnapshot = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/export/snapshot`, { headers: { cookie: adminCookie } }),
        env
      );
      expect(exportSnapshot.status).toBe(200);

      const missingR2Media = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/media/does-not-exist.jpg`, { headers: { cookie: adminCookie } }),
        env
      );
      expect(missingR2Media.status).toBe(404);

      const assetsWithFavicon: Fetcher = {
        fetch: async (input) => {
          const u = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          );
          if (u.pathname === '/favicon.svg') {
            return new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
          }
          if (u.pathname === '/favicon.ico') {
            return new Response(new Uint8Array([0, 0, 1, 0]), {
              status: 200,
              headers: { 'content-type': 'image/x-icon' },
            });
          }
          return new Response('Not Found', { status: 404 });
        },
      };
      const favSvgHit = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/favicon.svg`), {
        ...env,
        ASSETS: assetsWithFavicon,
      });
      expect(favSvgHit.status).toBe(200);
      const favIcoHit = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/favicon.ico`), {
        ...env,
        ASSETS: assetsWithFavicon,
      });
      expect(favIcoHit.status).toBe(200);
      const missingSpaIndex = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/person/missing-spa`), {
        ...env,
        ASSETS: assetsWithFavicon,
      });
      expect(missingSpaIndex.status).toBe(404);

      const noAssetsRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/person/henry-alder`),
        noAssetsEnv
      );
      expect(noAssetsRes.status).toBe(404);
    } finally {
      await mf.dispose();
    }
  }, 20_000);

  it('validates server plugins synchronously at createCloudflareWorker creation time', () => {
    const siteConfig = createSyntheticSiteConfig();
    const okHandler = async () => new Response('ok');

    expect(() =>
      createCloudflareWorker({
        siteConfig,
        plugins: [
          { id: 'dup-worker-plugin', name: 'One' },
          { id: ' dup-worker-plugin ', name: 'Two' },
        ],
      })
    ).toThrow(RangeError);

    for (const badPrefix of ['/api/bundle', '/data', '/data/readings.json']) {
      expect(() =>
        createCloudflareWorker({
          siteConfig,
          plugins: [
            {
              id: `reserved-${badPrefix.replaceAll('/', '_')}`,
              name: 'Reserved Prefix',
              routes: [{ method: 'GET', pathPrefix: badPrefix, minRole: 'public', handle: okHandler }],
            },
          ],
        })
      ).toThrow(RangeError);
    }

    expect(() =>
      createCloudflareWorker({
        siteConfig,
        plugins: [
          {
            id: 'custom-worker-plugin',
            name: 'Valid Plugin',
            routes: [
              {
                method: 'GET',
                pathPrefix: '/api/custom-worker',
                minRole: 'public',
                handle: okHandler,
              },
            ],
          },
        ],
      })
    ).not.toThrow();
  });
});
