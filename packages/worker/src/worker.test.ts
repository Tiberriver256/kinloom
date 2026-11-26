import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it, vi } from 'vitest';
import {
  asBatchId,
  asRevisionId,
  type ArchiveBundle,
  type RawPerson,
  type RevisionRecord,
} from '@kinloom/core';
import {
  FakeAuthProvider,
  FixedClock,
  InMemoryEmailSender,
  readStreamToBytes,
} from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
  runBackendAdapterContractTests,
} from '@kinloom/server/testing';
import {
  buildMagicLinkEmailMessage,
  buildMagicLinkMimeMessage,
  CloudflareEmailSender,
  createCloudflareAssetHandler,
  createCloudflareWorker,
  D1ArchiveRepository,
  DEFAULT_COMPILED_BUNDLE_KEY,
  R2IncrementalPatchBundleCache,
  R2MediaStore,
  type D1Database,
  type Fetcher,
  type KinloomWorkerEnv,
  type R2Bucket,
  type SendEmailBinding,
  type SendEmailMessageBuilder,
} from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const INITIAL_MIGRATION_SQL = readFileSync(
  resolve(THIS_DIR, '../migrations/0001_initial.sql'),
  'utf8'
);

interface MiniflareFixture {
  mf: Miniflare;
  db: D1Database;
  bucket: R2Bucket;
  dispose: () => Promise<void>;
}

async function applySqlScript(db: D1Database, sqlScript: string): Promise<void> {
  // Strip single-line SQL comments before splitting statements so Miniflare D1 executes every DDL statement cleanly.
  const withoutComments = sqlScript
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');

  const statements = withoutComments
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);

  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}

async function createMiniflareFixture(): Promise<MiniflareFixture> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: 'kinloom-test-db' },
    r2Buckets: { MEDIA_BUCKET: 'kinloom-test-bucket' },
  });

  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;
  await applySqlScript(db, INITIAL_MIGRATION_SQL);

  return {
    mf,
    db,
    bucket,
    dispose: async () => {
      await mf.dispose();
    },
  };
}

function extractSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const combined = response.headers.get('set-cookie');
  return combined ? [combined] : [];
}

function cookiePairFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0]?.trim() ?? '';
}

// =============================================================================
// 1. Exact shared Backend Adapter Contract Suite against real Miniflare D1 + R2
// =============================================================================
runBackendAdapterContractTests('Cloudflare D1 + R2 (Miniflare)', async (siteConfig) => {
  const fixture = await createMiniflareFixture();
  const clock = new FixedClock('2026-06-15T12:00:00.000Z');
  const emailSender = new InMemoryEmailSender();
  const authProvider = new FakeAuthProvider();

  return {
    siteConfig,
    ports: {
      repository: new D1ArchiveRepository(fixture.db, { privacyConfig: siteConfig.privacy }),
      bundleCache: new R2IncrementalPatchBundleCache({
        bucket: fixture.bucket,
        siteConfig,
        clock,
        mode: 'private',
      }),
      mediaStore: new R2MediaStore(fixture.bucket),
      emailSender,
      authProvider,
      clock,
    },
    dispose: fixture.dispose,
  };
});

// =============================================================================
// 2. SQLite EXPLAIN QUERY PLAN verification (zero full-table scans on hot queries)
// =============================================================================
describe('D1 migration 0001_initial.sql EXPLAIN QUERY PLAN checks', () => {
  it('uses every required secondary index with zero full-table scans on hot queries', async () => {
    const fixture = await createMiniflareFixture();
    try {
      const explain = async (sql: string, bindings: unknown[] = []): Promise<string[]> => {
        const res = await fixture.db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...bindings)
          .all<{ detail: string }>();
        return res.results.map((row) => row.detail);
      };

      const queries: Array<{
        name: string;
        sql: string;
        bindings: unknown[];
        expectedIndex: string;
        forbiddenScans: string[];
        forbidTempSort?: boolean;
      }> = [
        {
          name: 'active entity lookup by slug',
          sql: `SELECT entity_id, data_json FROM entities WHERE entity_type = ? AND slug = ? AND deleted_at IS NULL`,
          bindings: ['person', 'arthur-alder'],
          expectedIndex: 'idx_entities_active_slug',
          forbiddenScans: ['SCAN entities'],
        },
        {
          name: 'active snapshot entity load',
          sql: `SELECT entity_type, entity_id, slug, data_json, current_revision_id, has_primary_source, deleted_at, updated_at FROM entities WHERE deleted_at IS NULL ORDER BY entity_type, entity_id`,
          bindings: [],
          expectedIndex: 'idx_entities_active_type',
          forbiddenScans: ['SCAN entities '],
          forbidTempSort: true,
        },
        {
          name: 'living person lookup',
          sql: `SELECT entity_id, data_json FROM entities WHERE entity_type = 'person' AND deleted_at IS NULL`,
          bindings: [],
          expectedIndex: 'idx_entities_active_type',
          forbiddenScans: ['SCAN entities'],
        },
        {
          name: 'per-record revision history newest-first',
          sql: `SELECT revision_id, summary FROM revisions WHERE entity_type = ? AND entity_id = ? ORDER BY revision_id DESC LIMIT 50`,
          bindings: ['person', 'per_arthur_alder'],
          expectedIndex: 'idx_revisions_entity_history',
          forbiddenScans: ['SCAN revisions'],
          forbidTempSort: true,
        },
        {
          name: 'batch revision lookup',
          sql: `SELECT revision_id, entity_id FROM revisions WHERE batch_id = ? AND batch_id IS NOT NULL ORDER BY revision_id ASC`,
          bindings: ['batch_001'],
          expectedIndex: 'idx_revisions_batch_lookup',
          forbiddenScans: ['SCAN revisions'],
          forbidTempSort: true,
        },
        {
          name: 'recent changes filtered by author_type',
          sql: `SELECT revision_id, author_name FROM revisions WHERE author_type = ? ORDER BY revision_id DESC LIMIT 50`,
          bindings: ['agent'],
          expectedIndex: 'idx_revisions_author_type_recent',
          forbiddenScans: ['SCAN revisions'],
          forbidTempSort: true,
        },
        {
          name: 'active kinship edge lookup',
          sql: `SELECT edge_id FROM kinship_edges WHERE from_person_id = ? AND to_person_id = ? AND relation = ? AND deleted_at IS NULL`,
          bindings: ['per_1', 'per_2', 'parent'],
          expectedIndex: 'idx_kinship_active_edge',
          forbiddenScans: ['SCAN kinship_edges'],
        },
        {
          name: 'kinship reverse lookup by to_person_id',
          sql: `SELECT edge_id FROM kinship_edges WHERE to_person_id = ? AND deleted_at IS NULL`,
          bindings: ['per_2'],
          expectedIndex: 'idx_kinship_to_person',
          forbiddenScans: ['SCAN kinship_edges'],
        },
        {
          name: 'active agent token hash lookup',
          sql: `SELECT token_id, scope FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
          bindings: ['0'.repeat(64)],
          expectedIndex: 'idx_agent_tokens_hash',
          forbiddenScans: ['SCAN agent_tokens'],
        },
        {
          name: 'entity talk thread chronological lookup',
          sql: `SELECT comment_id, body_md FROM talk_comments WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY comment_id ASC`,
          bindings: ['person', 'per_arthur_alder'],
          expectedIndex: 'idx_talk_comments_entity',
          forbiddenScans: ['SCAN talk_comments'],
          forbidTempSort: true,
        },
        {
          name: 'batch entity lookup by entity_type and entity_id via json_each join',
          sql: `SELECT e.entity_type, e.entity_id, e.slug, e.data_json, e.current_revision_id, e.has_primary_source, e.deleted_at, e.updated_at FROM json_each(?) AS k JOIN entities AS e ON e.entity_type = json_extract(k.value, '$[0]') AND e.entity_id = json_extract(k.value, '$[1]')`,
          bindings: ['[["person","per_1"],["event","evt_2"]]'],
          expectedIndex: 'sqlite_autoindex_entities_1',
          forbiddenScans: ['SCAN entities', 'SCAN e'],
        },
        {
          name: 'batch kinship lookup by edge_id IN',
          sql: `SELECT edge_id, from_person_id, to_person_id, relation, family_xref, current_revision_id, deleted_at, updated_at FROM kinship_edges WHERE edge_id IN (SELECT value FROM json_each(?))`,
          bindings: ['["edge_1","edge_2"]'],
          expectedIndex: 'sqlite_autoindex_kinship_edges_1',
          forbiddenScans: ['SCAN kinship_edges'],
        },
        {
          name: 'create-run current revision lookup by entity_type and entity_id',
          sql: `SELECT MAX(r.revision_id) FROM revisions r WHERE r.entity_type = ? AND r.entity_id = ?`,
          bindings: ['person', 'per_1'],
          expectedIndex: 'idx_revisions_entity_history',
          forbiddenScans: ['SCAN revisions', 'SCAN r'],
        },
        {
          name: 'magic-link lookup by email ordered by expires_at DESC',
          sql: `SELECT token_hash, expires_at FROM magic_links WHERE email = ? ORDER BY expires_at DESC`,
          bindings: ['editor@example.test'],
          expectedIndex: 'idx_magic_links_email_expires',
          forbiddenScans: ['SCAN magic_links'],
          forbidTempSort: true,
        },
      ];

      for (const check of queries) {
        const plan = await explain(check.sql, check.bindings);
        const joined = plan.join(' | ');
        expect(joined, `Expected index ${check.expectedIndex} for ${check.name}: ${joined}`).toContain(
          check.expectedIndex
        );
        for (const forbidden of check.forbiddenScans) {
          if (forbidden.endsWith(' ')) {
            // Ensure no full-table scan without USING INDEX
            const hasFullScan = plan.some(
              (line) => line.startsWith(forbidden.trim()) && !line.includes('USING INDEX') && !line.includes('USING COVERING INDEX')
            );
            expect(hasFullScan, `Unexpected full table scan for ${check.name}: ${joined}`).toBe(false);
          } else {
            expect(joined, `Unexpected full table scan for ${check.name}: ${joined}`).not.toContain(
              forbidden
            );
          }
        }
        if (check.forbidTempSort) {
          expect(joined, `Unexpected USE TEMP B-TREE for ${check.name}: ${joined}`).not.toContain(
            'USE TEMP B-TREE'
          );
        }
      }
    } finally {
      await fixture.dispose();
    }
  });
});

// =============================================================================
// 3. Full Cloudflare Worker HTTP lifecycle against real Miniflare D1 + R2
// =============================================================================
describe('createCloudflareWorker full HTTP lifecycle (Miniflare)', () => {
  it('runs bootstrap admin magic link, incremental R2 patching, 409 rollback, single & batch revert, 206 Range video streaming, invite enrollment, scoped tokens, living 422, and 304 caching', async () => {
    const fixture = await createMiniflareFixture();
    try {
      const siteConfig = createSyntheticSiteConfig();
      const clock = new FixedClock('2026-07-01T09:00:00.000Z');
      const sentEmails: SendEmailMessageBuilder[] = [];

      const sendEmailBinding: SendEmailBinding = {
        async send(message: SendEmailMessageBuilder): Promise<{ messageId: string }> {
          sentEmails.push(message);
          return { messageId: '<test-msg@familyloom.org>' };
        },
      };

      const fakeAssets: Fetcher = {
        async fetch(input: Request | string | URL): Promise<Response> {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
          if (url.pathname === '/index.html') {
            return new Response('<!doctype html><html><body>Kinloom SPA</body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          if (url.pathname === '/assets/app.js') {
            return new Response('console.log("kinloom");', {
              status: 200,
              headers: { 'content-type': 'application/javascript; charset=utf-8' },
            });
          }
          // Simulate Cloudflare Assets SPA fallback returning HTML for unknown paths
          return new Response('<!doctype html><html><body>SPA Fallback</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        },
      };

      const env: KinloomWorkerEnv = {
        DB: fixture.db,
        MEDIA_BUCKET: fixture.bucket,
        ASSETS: fakeAssets,
        SEND_EMAIL: sendEmailBinding,
        SESSION_SECRET: CONTRACT_SESSION_SECRET,
        BOOTSTRAP_ADMIN_EMAIL: 'founder@example.test',
        EMAIL_FROM: 'noreply@familyloom.org',
        ARCHIVE_MODE: 'private',
      };

      const worker = createCloudflareWorker({ siteConfig, clock });

      // 1. Bootstrap admin via magic-link over SEND_EMAIL EmailMessageBuilder binding
      const magicReqRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
          },
          body: JSON.stringify({ email: 'founder@example.test' }),
        }),
        env
      );
      expect(magicReqRes.status).toBe(202);
      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0].from).toEqual({
        email: 'noreply@familyloom.org',
        name: siteConfig.site.title,
      });
      expect(sentEmails[0].to).toBe('founder@example.test');
      expect(sentEmails[0].subject).toBe(`Sign in to ${siteConfig.site.title}`);
      expect(sentEmails[0].text).toBeTypeOf('string');
      expect(sentEmails[0].html).toBeTypeOf('string');

      const magicUrlMatch = /https:\/\/archive\.example\.test\/api\/auth\/magic-link\/verify\?[^\s]+/.exec(
        sentEmails[0].text ?? ''
      );
      expect(magicUrlMatch).not.toBeNull();
      expect(sentEmails[0].html).toContain(magicUrlMatch![0]);

      const verifyRes = await worker.fetch(new Request(magicUrlMatch![0]), env);
      expect(verifyRes.status).toBe(302);
      const adminCookie = cookiePairFromSetCookie(extractSetCookies(verifyRes)[0] ?? '');
      expect(adminCookie).toContain('__Host-kinloom_session=');

      const meRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me`, { headers: { cookie: adminCookie } }),
        env
      );
      const meBody = (await meRes.json()) as {
        session: { email: string; role: string };
        capabilities: { canManageSite: boolean };
        authProviders: { google: boolean; magicLink: boolean };
      };
      expect(meBody.session.email).toBe('founder@example.test');
      expect(meBody.session.role).toBe('admin');
      expect(meBody.capabilities.canManageSite).toBe(true);
      expect(meBody.authProviders).toEqual({ google: false, magicLink: true });

      // 2. Create and edit person -> verify R2 compiled/archive.json customMetadata + ETag 304
      const arthur = createSyntheticHistoricalPerson();
      const createRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({
            entity_id: arthur.id,
            data: arthur,
            summary: 'Create Arthur Alder record',
            has_primary_source: true,
          }),
        }),
        env
      );
      expect(createRes.status).toBe(201);

      const editRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/${arthur.id}`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({
            expected_parent_revision_id: 1,
            data: { ...arthur, full_name: 'Arthur W. Alder' },
            summary: 'Add middle initial W from census',
            has_primary_source: true,
          }),
        }),
        env
      );
      expect(editRes.status).toBe(200);

      const r2BundleHead = await fixture.bucket.head(DEFAULT_COMPILED_BUNDLE_KEY);
      expect(r2BundleHead?.customMetadata?.revision).toBe('2');
      expect(r2BundleHead?.customMetadata?.etag).toBe('"r2"');

      const bundleRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } }),
        env
      );
      expect(bundleRes.status).toBe(200);
      expect(bundleRes.headers.get('etag')).toBe('"r2"');
      const bundle = (await bundleRes.json()) as ArchiveBundle;
      expect(bundle.meta.max_revision_id).toBe(2);
      expect(bundle.people.find((p) => p.id === arthur.id)?.full_name).toBe('Arthur W. Alder');

      const notModRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
          headers: { cookie: adminCookie, 'if-none-match': '"r2"' },
        }),
        env
      );
      expect(notModRes.status).toBe(304);

      // 3. Stale expected_parent_revision_id returns HTTP 409 Conflict with diff and zero partial writes
      const conflictRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/${arthur.id}`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({
            expected_parent_revision_id: 1,
            data: { ...arthur, full_name: 'Arthur Stale Alder' },
            summary: 'Stale edit should conflict',
            has_primary_source: true,
          }),
        }),
        env
      );
      expect(conflictRes.status).toBe(409);
      const conflictBody = (await conflictRes.json()) as {
        error: {
          code: string;
          details: { server_revision_id: number; diff: { hasChanges: boolean } };
        };
      };
      expect(conflictBody.error.code).toBe('OPTIMISTIC_CONFLICT');
      expect(conflictBody.error.details.server_revision_id).toBe(2);
      expect(conflictBody.error.details.diff.hasChanges).toBe(true);

      // 4. Single revision revert (revert rev 2 -> restores 'Arthur Alder' as rev 3)
      const singleRevertRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/revisions/2/revert`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({ summary: 'Undo middle initial edit' }),
        }),
        env
      );
      expect(singleRevertRes.status).toBe(201);
      const revertedEntityRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/${arthur.id}`, {
          headers: { cookie: adminCookie },
        }),
        env
      );
      const revertedEntity = (await revertedEntityRes.json()) as {
        entity: RawPerson;
        current_revision_id: number;
      };
      expect(revertedEntity.entity.full_name).toBe('Arthur Alder');
      expect(revertedEntity.current_revision_id).toBe(3);

      // 5. Batch submit + batch revert
      const martha = createSyntheticHistoricalPerson({
        id: 'per_martha_alder',
        slug: 'martha-alder',
        full_name: 'Martha Alder',
        given_name: 'Martha',
      });
      const batchRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({
            batch_id: 'batch_worker_01',
            summary: 'Add Martha and refine name',
            has_primary_source: true,
            patches: [
              { action: 'create', entity_type: 'person', entity_id: martha.id, data: martha },
              {
                action: 'update',
                entity_type: 'person',
                entity_id: martha.id,
                data: { full_name: 'Martha Jane Alder' },
                merge: true,
              },
            ],
          }),
        }),
        env
      );
      expect(batchRes.status).toBe(201);

      const batchRevertRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches/batch_worker_01/revert`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({ summary: 'Revert Martha batch' }),
        }),
        env
      );
      expect(batchRevertRes.status).toBe(201);
      const batchRevertBody = (await batchRevertRes.json()) as {
        revisions: RevisionRecord[];
        head_revision_id: number;
      };
      expect(batchRevertBody.revisions.map((r) => r.reverted_revision_id)).toEqual([5, 4]);
      expect(batchRevertBody.head_revision_id).toBe(7);

      // 6. HTTP 206 Partial Content byte-range video streaming from R2
      const videoPayload = new TextEncoder().encode('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      const uploadForm = new FormData();
      uploadForm.append('file', new File([videoPayload], 'oral-history.mp4', { type: 'video/mp4' }));
      uploadForm.append(
        'metadata',
        JSON.stringify({
          id: 'med_video_r2',
          kind: 'video_story',
          person_ids: [arthur.id],
          caption: 'Arthur oral history recording',
          duration_seconds: 95,
        })
      );
      uploadForm.append('summary', 'Upload oral history clip to R2');

      const uploadRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/media/upload`, {
          method: 'POST',
          headers: { origin: CONTRACT_TEST_ORIGIN, cookie: adminCookie },
          body: uploadForm,
        }),
        env
      );
      expect(uploadRes.status).toBe(201);
      const uploaded = (await uploadRes.json()) as { url: string };

      const rangeRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}${uploaded.url}`, {
          headers: { cookie: adminCookie, range: 'bytes=10-19' },
        }),
        env
      );
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('accept-ranges')).toBe('bytes');
      expect(rangeRes.headers.get('content-range')).toBe(`bytes 10-19/${videoPayload.byteLength}`);
      expect(rangeRes.headers.get('content-length')).toBe('10');
      expect(await rangeRes.text()).toBe('ABCDEFGHIJ');

      // 7. Living-person portrait upload returns 422 LIVING_MEDIA_FORBIDDEN
      const living = createSyntheticLivingPerson();
      const createLivingRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({
            entity_id: living.id,
            data: living,
            summary: 'Add living Clara Alder',
            has_primary_source: false,
          }),
        }),
        env
      );
      expect(createLivingRes.status).toBe(201);

      const livingPortraitForm = new FormData();
      livingPortraitForm.append(
        'file',
        new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'clara.jpg', { type: 'image/jpeg' })
      );
      livingPortraitForm.append(
        'metadata',
        JSON.stringify({ kind: 'portrait', person_ids: [living.id], caption: 'Living portrait' })
      );
      livingPortraitForm.append('summary', 'Attempt living portrait');

      const livingUploadRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/media/upload`, {
          method: 'POST',
          headers: { origin: CONTRACT_TEST_ORIGIN, cookie: adminCookie },
          body: livingPortraitForm,
        }),
        env
      );
      expect(livingUploadRes.status).toBe(422);
      const livingErr = (await livingUploadRes.json()) as { error: { code: string } };
      expect(livingErr.error.code).toBe('LIVING_MEDIA_FORBIDDEN');

      // 8. Invite-to-editor auto-enrollment via magic link (strictly editor, never admin)
      const inviteRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/invites`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({ label: 'Family picnic link', expires_in_days: 14 }),
        }),
        env
      );
      expect(inviteRes.status).toBe(201);
      const { invite_url: inviteUrl } = (await inviteRes.json()) as { invite_url: string };

      const redeemRes = await worker.fetch(new Request(inviteUrl), env);
      expect(redeemRes.status).toBe(302);
      const viewerCookie = cookiePairFromSetCookie(extractSetCookies(redeemRes)[0] ?? '');

      const cousinMagicReq = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: viewerCookie,
          },
          body: JSON.stringify({ email: 'cousin.alex@example.test' }),
        }),
        env
      );
      expect(cousinMagicReq.status).toBe(202);
      const cousinEmail = sentEmails[sentEmails.length - 1];
      const cousinVerifyUrl = /https:\/\/archive\.example\.test\/api\/auth\/magic-link\/verify\?[^\s]+/.exec(
        cousinEmail.text ?? ''
      );
      const cousinVerifyRes = await worker.fetch(new Request(cousinVerifyUrl![0]), env);
      expect(cousinVerifyRes.status).toBe(302);
      const cousinCookie = cookiePairFromSetCookie(extractSetCookies(cousinVerifyRes)[0] ?? '');

      const cousinMeRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me`, { headers: { cookie: cousinCookie } }),
        env
      );
      const cousinMe = (await cousinMeRes.json()) as {
        session: { role: string };
        capabilities: { canEdit: boolean; canManageSite: boolean };
      };
      expect(cousinMe.session.role).toBe('editor');
      expect(cousinMe.capabilities.canEdit).toBe(true);
      expect(cousinMe.capabilities.canManageSite).toBe(false);

      // 9. read_backup agent token gets 200 on export and 403 on writes
      const backupTokRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/agent-tokens`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({ label: 'Nightly YAML backup', scope: 'read_backup' }),
        }),
        env
      );
      expect(backupTokRes.status).toBe(201);
      const { plaintext_secret: backupSecret } = (await backupTokRes.json()) as {
        plaintext_secret: string;
      };

      const exportRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/export/yaml`, {
          headers: { authorization: `Bearer ${backupSecret}` },
        }),
        env
      );
      expect(exportRes.status).toBe(200);

      const backupWriteRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${backupSecret}`,
          },
          body: JSON.stringify({
            data: arthur,
            summary: 'Should be rejected for read_backup scope',
            has_primary_source: true,
          }),
        }),
        env
      );
      expect(backupWriteRes.status).toBe(403);

      // 10. Static ASSETS fallback serves SPA on routes, SVG on /favicon.svg, and NEVER HTML on missing /favicon.ico or missing assets
      const spaRes = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/people`), env);
      expect(spaRes.status).toBe(200);
      expect(spaRes.headers.get('content-type')).toContain('text/html');

      const faviconSvgRes = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/favicon.svg`), env);
      expect(faviconSvgRes.status).toBe(200);
      expect(faviconSvgRes.headers.get('content-type')).toContain('image/svg+xml');

      const faviconIcoRes = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/favicon.ico`), env);
      expect(faviconIcoRes.status).toBe(404);
      expect(faviconIcoRes.headers.get('content-type')).not.toContain('text/html');

      const missingJsRes = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/assets/missing.js`), env);
      expect(missingJsRes.status).toBe(404);
      expect(missingJsRes.headers.get('content-type')).not.toContain('text/html');
    } finally {
      await fixture.dispose();
    }
  });

  it('uses incremental R2 bundle patching on warm writes and falls back to full rebuild on cache miss', async () => {
    const fixture = await createMiniflareFixture();
    try {
      const siteConfig = createSyntheticSiteConfig();
      const clock = new FixedClock('2026-08-01T10:00:00.000Z');
      const repo = new D1ArchiveRepository(fixture.db, { privacyConfig: siteConfig.privacy });
      const cache = new R2IncrementalPatchBundleCache({
        bucket: fixture.bucket,
        siteConfig,
        clock,
        mode: 'private',
      });

      const p1 = createSyntheticHistoricalPerson({ id: 'per_r2_1', slug: 'r2-one' });
      const p2 = createSyntheticHistoricalPerson({
        id: 'per_r2_2',
        slug: 'r2-two',
        full_name: 'Hannah Alder',
        given_name: 'Hannah',
      });

      const commit1 = await repo.commitAtomicMutations({
        batch_id: asBatchId('batch_r2_1'),
        author: { author_id: 'admin@example.test', author_name: 'Admin', author_type: 'human' },
        nowIso: clock.nowIso(),
        operations: [
          {
            entity_type: 'person',
            entity_id: p1.id,
            slug: p1.slug,
            action: 'create',
            expected_parent_revision_id: null,
            summary: 'Add first person',
            has_primary_source: true,
            before_json: null,
            after_json: p1 as unknown as Record<string, unknown>,
          },
        ],
      });
      expect(commit1.kind).toBe('committed');

      // Cold miss -> rebuildAndStore
      expect((await cache.getCached(null)).status).toBe('miss');
      const snapshot1 = await repo.loadActiveSnapshot();
      const coldBuilt = await cache.rebuildAndStore(snapshot1);
      expect(coldBuilt.etag).toBe('"r1"');
      expect(cache.rebuildCount).toBe(1);
      expect(cache.incrementalPatchCount).toBe(0);

      // Warm cache -> incremental applyMutationsAndStore
      const commit2 = await repo.commitAtomicMutations({
        batch_id: null,
        author: { author_id: 'admin@example.test', author_name: 'Admin', author_type: 'human' },
        nowIso: clock.nowIso(),
        operations: [
          {
            entity_type: 'person',
            entity_id: p2.id,
            slug: p2.slug,
            action: 'create',
            expected_parent_revision_id: null,
            summary: 'Add second person',
            has_primary_source: true,
            before_json: null,
            after_json: p2 as unknown as Record<string, unknown>,
          },
        ],
      });
      expect(commit2.kind).toBe('committed');
      if (commit2.kind === 'committed') {
        const prevBundle = JSON.parse(String(coldBuilt.body)) as ArchiveBundle;
        const patched = await cache.applyMutationsAndStore(prevBundle, commit2.revisions);
        expect(patched.etag).toBe('"r2"');
        expect(cache.rebuildCount).toBe(1);
        expect(cache.incrementalPatchCount).toBe(1);
      }

      // Verify R2 stored metadata & ETag short-circuit without downloading body
      const notMod = await cache.getCached('"r2"');
      expect(notMod).toEqual({ status: 'not_modified', etag: '"r2"' });

      const hit = await cache.getCached('"r1"');
      expect(hit.status).toBe('hit');
      if (hit.status === 'hit') {
        expect(hit.object.revision_id).toBe(asRevisionId(2));
        const rawBytes = await readStreamToBytes(hit.object.body as ReadableStream<Uint8Array>);
        const parsed = JSON.parse(new TextDecoder().decode(rawBytes)) as ArchiveBundle;
        expect(parsed.people.map((p) => p.id)).toEqual(['per_r2_1', 'per_r2_2']);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('handles missing SEND_EMAIL binding gracefully and guards asset handler against HTML leaks', async () => {
    const sender = new CloudflareEmailSender({ fromEmail: 'noreply@familyloom.org' });
    await expect(
      sender.sendMagicLink({
        toEmail: 'member@example.test',
        siteTitle: 'Alder Archive',
        magicLinkUrl: 'https://archive.example.test/api/auth/magic-link/verify?token=abc12345',
        expiresMinutes: 15,
      })
    ).rejects.toMatchObject({
      status: 503,
      code: 'EMAIL_SENDER_UNCONFIGURED',
    });

    const mime = buildMagicLinkMimeMessage({
      fromEmail: 'noreply@familyloom.org',
      toEmail: 'member@example.test',
      siteTitle: 'Alder\r\nBcc: evil@example.test',
      magicLinkUrl: 'https://archive.example.test/api/auth/magic-link/verify?token=abc12345',
      expiresMinutes: 15,
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(mime).not.toContain('\r\nBcc:');
    expect(mime).toContain('To: member@example.test\r\n');

    const assetHandler = createCloudflareAssetHandler();
    const api404 = await assetHandler.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/api/unknown`));
    expect(api404.status).toBe(404);
    expect(api404.headers.get('content-type')).toContain('text/plain');

    const media404 = await assetHandler.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/media/missing.jpg`));
    expect(media404.status).toBe(404);
    expect(media404.headers.get('content-type')).toContain('text/plain');

    const source404 = await assetHandler.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/sources/missing.pdf`));
    expect(source404.status).toBe(404);
    expect(source404.headers.get('content-type')).toContain('text/plain');

    // Regression check: conditional 304 Not Modified on static CSS/JS assets must pass through as 304, never 404.
    const conditionalAssetHandler = createCloudflareAssetHandler({
      async fetch() {
        return new Response(null, {
          status: 304,
          headers: { etag: '"css-hash-1"' },
        });
      },
    });
    const css304 = await conditionalAssetHandler.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/assets/index-abc.css`, {
        headers: { 'if-none-match': '"css-hash-1"' },
      })
    );
    expect(css304.status).toBe(304);
    expect(css304.headers.get('etag')).toBe('"css-hash-1"');
  });

  it('serves nested /media/* and /sources/* pre-seeded R2 objects without custom sha256 metadata and auth-gates /data/*', async () => {
    const fixture = await createMiniflareFixture();
    try {
      const clock = new FixedClock('2026-07-02T12:00:00.000Z');
      const emailSender = new InMemoryEmailSender();
      const siteConfig = createSyntheticSiteConfig();

      // Upload pre-seeded R2 objects directly (matching wrangler r2 object put without customMetadata.sha256)
      await fixture.bucket.put('media/photos/portrait-1900.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), {
        httpMetadata: { contentType: 'image/jpeg' },
      });
      await fixture.bucket.put('sources/memoir-1999.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), {
        httpMetadata: { contentType: 'application/pdf' },
      });

      const fakeAssets: Fetcher = {
        async fetch(input) {
          const reqUrl = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
          if (reqUrl.pathname === '/data/readings.json') {
            return new Response(JSON.stringify({ documents: { doc1: { pages: [] } } }), {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            });
          }
          if (reqUrl.pathname === '/index.html') {
            return new Response('<!doctype html><html><body>SPA</body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return new Response('Not Found', { status: 404 });
        },
      };

      const env: KinloomWorkerEnv = {
        DB: fixture.db,
        MEDIA_BUCKET: fixture.bucket,
        ASSETS: fakeAssets,
        SESSION_SECRET: CONTRACT_SESSION_SECRET,
        BOOTSTRAP_ADMIN_EMAIL: 'archivist@example.test',
        ARCHIVE_MODE: 'private',
      };

      const worker = createCloudflareWorker({ siteConfig, clock, emailSender });

      // Unauthenticated requests to /media/*, /sources/*, and /data/* must all fail with 401
      const unauthMedia = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/media/photos/portrait-1900.jpg`), env);
      expect(unauthMedia.status).toBe(401);
      const unauthSource = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/sources/memoir-1999.pdf`), env);
      expect(unauthSource.status).toBe(401);
      const unauthReadings = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/data/readings.json`), env);
      expect(unauthReadings.status).toBe(401);

      // Sign in as bootstrap admin
      const reqLink = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: { origin: CONTRACT_TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'archivist@example.test' }),
        }),
        env
      );
      expect(reqLink.status).toBe(202);
      const sentLink = emailSender.sentMessages[0]?.magicLinkUrl;
      expect(sentLink).toBeDefined();

      const verifyRes = await worker.fetch(new Request(sentLink!), env);
      expect(verifyRes.status).toBe(302);
      const cookie = cookiePairFromSetCookie(extractSetCookies(verifyRes)[0] ?? '');
      expect(cookie).toContain('kinloom_session=');

      // Nested /media/photos/... returns 200 with ETag and bytes
      const mediaRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/media/photos/portrait-1900.jpg`, { headers: { cookie } }),
        env
      );
      expect(mediaRes.status).toBe(200);
      expect(mediaRes.headers.get('content-type')).toBe('image/jpeg');
      expect(mediaRes.headers.get('etag')).toBeTruthy();
      expect((await mediaRes.arrayBuffer()).byteLength).toBe(8);

      // /sources/... supports HTTP 206 byte range streaming
      const sourceRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/sources/memoir-1999.pdf`, {
          headers: { cookie, range: 'bytes=0-3' },
        }),
        env
      );
      expect(sourceRes.status).toBe(206);
      expect(sourceRes.headers.get('content-range')).toBe('bytes 0-3/8');
      expect(new TextDecoder().decode(await sourceRes.arrayBuffer())).toBe('%PDF');

      // Traversal attempt must return 404
      const traversalRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/media/photos/%2e%2e/%2e%2e/compiled/archive.json`, { headers: { cookie } }),
        env
      );
      expect(traversalRes.status).toBe(404);

      // Auth-gated /data/readings.json returns 200 when signed in
      const readingsRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/data/readings.json`, { headers: { cookie } }),
        env
      );
      expect(readingsRes.status).toBe(200);
      expect(await readingsRes.json()).toEqual({ documents: { doc1: { pages: [] } } });
    } finally {
      await fixture.dispose();
    }
  });

  it('sends structured EmailMessageBuilder payloads with text and html, sanitizes input, and maps SEND_EMAIL failures to 502 EMAIL_DELIVERY_FAILED', async () => {
    const captured: SendEmailMessageBuilder[] = [];
    const magicLinkUrl =
      'https://archive.example.test/api/auth/magic-link/verify?token=secret_tok_123&next=%2Fpeople';

    const sender = new CloudflareEmailSender({
      fromEmail: 'noreply@familyloom.org',
      binding: {
        async send(message) {
          captured.push(message);
          return { messageId: '<ok@familyloom.org>' };
        },
      },
    });

    await sender.sendMagicLink({
      toEmail: 'member@example.test\r\nBcc: evil@example.test',
      siteTitle: 'Alder & <Oak>\r\nSubject: Injected',
      magicLinkUrl,
      expiresMinutes: 15,
    });

    expect(captured).toHaveLength(1);
    const msg = captured[0];
    expect(msg.from).toEqual({
      email: 'noreply@familyloom.org',
      name: 'Alder & <Oak> Subject: Injected',
    });
    expect(msg.to).toBe('member@example.test Bcc: evil@example.test');
    expect(msg.subject).toBe('Sign in to Alder & <Oak> Subject: Injected');
    expect(msg.subject).not.toContain('\r');
    expect(msg.subject).not.toContain('\n');
    expect(msg.text).toContain(magicLinkUrl);
    expect(msg.text).toContain('expires in 15 minutes');
    expect(msg.html).toContain('Alder &amp; &lt;Oak&gt; Subject: Injected');
    expect(msg.html).toContain(
      'https://archive.example.test/api/auth/magic-link/verify?token=secret_tok_123&amp;next=%2Fpeople'
    );
    expect(msg.html).not.toContain('<Oak>');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failingSender = new CloudflareEmailSender({
        fromEmail: 'noreply@familyloom.org',
        binding: {
          async send() {
            throw new Error(`Email service rejected request for ${magicLinkUrl}`);
          },
        },
      });

      await expect(
        failingSender.sendMagicLink({
          toEmail: 'member@example.test',
          siteTitle: 'Alder Archive',
          magicLinkUrl,
          expiresMinutes: 15,
        })
      ).rejects.toMatchObject({
        status: 502,
        code: 'EMAIL_DELIVERY_FAILED',
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
      expect(logged).toContain('SEND_EMAIL binding delivery failed');
      expect(logged).toContain('[redacted]');
      expect(logged).not.toContain('secret_tok_123');

      // End-to-end Worker HTTP response maps upstream SEND_EMAIL errors to 502 instead of 500
      const fixture = await createMiniflareFixture();
      try {
        const siteConfig = createSyntheticSiteConfig();
        const clock = new FixedClock('2026-07-03T10:00:00.000Z');
        const worker = createCloudflareWorker({ siteConfig, clock });
        const env: KinloomWorkerEnv = {
          DB: fixture.db,
          MEDIA_BUCKET: fixture.bucket,
          SEND_EMAIL: {
            async send() {
              throw new Error('Upstream Cloudflare Email Service error');
            },
          },
          SESSION_SECRET: CONTRACT_SESSION_SECRET,
          BOOTSTRAP_ADMIN_EMAIL: 'founder@example.test',
          EMAIL_FROM: 'noreply@familyloom.org',
          ARCHIVE_MODE: 'private',
        };

        const res = await worker.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: CONTRACT_TEST_ORIGIN,
            },
            body: JSON.stringify({ email: 'founder@example.test' }),
          }),
          env
        );
        expect(res.status).toBe(502);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('EMAIL_DELIVERY_FAILED');
        expect(body.error.message).toBe(
          'Unable to send sign-in email right now. Please try again later.'
        );
      } finally {
        await fixture.dispose();
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('maps Cloudflare recipient rejections (E_RECIPIENT_PLAN_RESTRICTED) to 502 EMAIL_RECIPIENT_NOT_ALLOWED and logs the code', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sender = new CloudflareEmailSender({
        fromEmail: 'noreply@familyloom.org',
        binding: {
          async send() {
            throw Object.assign(new Error('Recipient not allowed by plan'), {
              code: 'E_RECIPIENT_PLAN_RESTRICTED',
            });
          },
        },
      });

      await expect(
        sender.sendMagicLink({
          toEmail: 'alice.example@example.com',
          siteTitle: 'Alder Archive',
          magicLinkUrl: 'https://archive.example.test/api/auth/magic-link/verify?token=tok_abc',
          expiresMinutes: 15,
        })
      ).rejects.toMatchObject({
        status: 502,
        code: 'EMAIL_RECIPIENT_NOT_ALLOWED',
        message:
          'This archive cannot send sign-in email to that address yet. Ask the archive owner for help.',
      });

      expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toBe(
        '[kinloom/worker] SEND_EMAIL binding delivery failed (E_RECIPIENT_PLAN_RESTRICTED): Recipient not allowed by plan'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('delivers buildMagicLinkEmailMessage payloads through Miniflare native SEND_EMAIL binding', async () => {
    const payload = buildMagicLinkEmailMessage({
      fromEmail: 'noreply@familyloom.org',
      toEmail: 'founder@example.test',
      siteTitle: 'Alder Family Archive',
      magicLinkUrl: 'https://archive.example.test/api/auth/magic-link/verify?token=mf_token_001',
      expiresMinutes: 15,
    });

    const mf = new Miniflare({
      modules: true,
      compatibilityDate: '2026-08-06',
      script: `
        export default {
          async fetch(request, env) {
            const builder = await request.json();
            const result = await env.SEND_EMAIL.send(builder);
            return Response.json(result);
          }
        };
      `,
      email: {
        send_email: [{ name: 'SEND_EMAIL' }],
      },
    });

    try {
      const res = await mf.dispatchFetch('http://localhost/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { messageId?: string };
      expect(data.messageId).toMatch(/^<[^@]+@familyloom\.org>$/);
    } finally {
      await mf.dispose();
    }
  });

  it('serves GET /privacy as unauthenticated 200 text/html in private mode using siteConfig metadata', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const worker = createCloudflareWorker({ siteConfig });
    const env = {
      ARCHIVE_MODE: 'private',
      SESSION_SECRET: CONTRACT_SESSION_SECRET,
    } as KinloomWorkerEnv;

    const res = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/privacy`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain(`<title>Privacy Policy | ${siteConfig.site.title}</title>`);
    expect(html).toContain(siteConfig.site.familyName);
    expect(html).toContain('non-commercial, private family history archive');
    expect(html).toContain('zero advertisements');
    expect(html).toContain('zero tracking pixels');

    const headRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/privacy`, { method: 'HEAD' }),
      env
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await headRes.text()).toBe('');
  });
});
