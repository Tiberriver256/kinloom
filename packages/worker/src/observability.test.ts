import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixedClock, getSessionCookieName, signSessionToken } from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
} from '@kinloom/server/testing';
import { Miniflare } from 'miniflare';
import { describe, expect, it, vi } from 'vitest';
import {
  createCloudflareWorker,
  createWorkersObservabilityPlugin,
  type D1Database,
  type KinloomWorkerEnv,
  type R2Bucket,
  type WorkersObservabilityLogRecord,
} from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const INITIAL_MIGRATION_SQL = readFileSync(resolve(THIS_DIR, '../migrations/0001_initial.sql'), 'utf8');
const PRONUNCIATIONS_MIGRATION_SQL = readFileSync(
  resolve(THIS_DIR, '../migrations/0002_pronunciations.sql'),
  'utf8'
);

async function applySqlScript(db: D1Database, sqlScript: string): Promise<void> {
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

async function createMiniflareEnv() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: 'kinloom-obs-test-db' },
    r2Buckets: { MEDIA_BUCKET: 'kinloom-obs-test-bucket' },
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;
  await applySqlScript(db, INITIAL_MIGRATION_SQL);
  await applySqlScript(db, PRONUNCIATIONS_MIGRATION_SQL);
  const env: KinloomWorkerEnv = {
    DB: db,
    MEDIA_BUCKET: bucket,
    SESSION_SECRET: CONTRACT_SESSION_SECRET,
    BOOTSTRAP_ADMIN_EMAIL: 'founder@example.test',
    ARCHIVE_MODE: 'private',
  };
  return { mf, env };
}

describe('createCloudflareWorker optional Workers Observability plugin', () => {
  it('keeps observability off by default with zero extra headers and zero telemetry logs', async () => {
    const { mf, env } = await createMiniflareEnv();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const siteConfig = createSyntheticSiteConfig();
      const clock = new FixedClock('2026-07-01T09:00:00.000Z');
      const worker = createCloudflareWorker({ siteConfig, clock });

      const meRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me`, {
          headers: { 'cf-ray': '8f1a2b3c4d5e6f7a-ORD' },
        }),
        env
      );
      expect(meRes.status).toBe(200);
      expect(meRes.headers.get('x-request-id')).toBeNull();
      expect(meRes.headers.get('server-timing')).toBeNull();

      const notFoundRes = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/api/missing`), env);
      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.headers.get('x-request-id')).toBeNull();
      expect(notFoundRes.headers.get('server-timing')).toBeNull();

      expect(logSpy.mock.calls).toHaveLength(0);
      expect(errorSpy.mock.calls).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await mf.dispose();
    }
  });

  it('propagates cf-ray, emits Server-Timing and structured logs on real D1/R2 bundle flows, and isolates sink errors', async () => {
    const { mf, env } = await createMiniflareEnv();
    try {
      const siteConfig = createSyntheticSiteConfig();
      const clock = new FixedClock('2026-07-01T09:00:00.000Z');
      const records: WorkersObservabilityLogRecord[] = [];
      const worker = createCloudflareWorker({
        siteConfig,
        clock,
        plugins: [
          createWorkersObservabilityPlugin({
            clock,
            sink: (record) => {
              records.push(record);
            },
          }),
        ],
      });

      await env.DB.prepare(
        `INSERT INTO users (email, display_name, role, added_at, added_by, last_login_at) VALUES (?, ?, ?, ?, ?, NULL)`
      )
        .bind('founder@example.test', 'Archive Founder', 'admin', clock.nowIso(), 'bootstrap')
        .run();

      const sessionToken = await signSessionToken({
        secret: CONTRACT_SESSION_SECRET,
        clock,
        ttlSeconds: 3600,
        payload: {
          kind: 'user',
          email: 'founder@example.test',
          display_name: 'Archive Founder',
          role: 'admin',
        },
      });
      const adminCookie = `${getSessionCookieName(true)}=${sessionToken}`;

      // Cold bundle miss against real D1 + R2.
      const missRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
          headers: { cookie: adminCookie, 'cf-ray': '8f1a2b3c4d5e6f7a-ORD' },
        }),
        env
      );
      expect(missRes.status).toBe(200);
      expect(missRes.headers.get('x-request-id')).toBe('8f1a2b3c4d5e6f7a-ORD');
      expect(missRes.headers.get('server-timing')).toMatch(
        /^d1;dur=\d+(?:\.\d+)?, r2;dur=\d+(?:\.\d+)?, bundle;dur=\d+(?:\.\d+)?, total;dur=\d+(?:\.\d+)?$/
      );
      expect(records[0]).toMatchObject({
        event: 'http_request',
        request_id: '8f1a2b3c4d5e6f7a-ORD',
        route: '/api/bundle',
        status: 200,
        cache_status: 'miss',
        bundle_revision: 0,
        error_code: null,
      });

      // Create historical person -> advances D1 & R2 bundle to revision 1.
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
            summary: 'Add Arthur Alder',
            has_primary_source: true,
          }),
        }),
        env
      );
      expect(createRes.status).toBe(201);
      expect(records[1]).toMatchObject({
        route: '/api/entities/:type',
        status: 201,
        bundle_revision: 1,
      });

      // Warm bundle hit -> cache_status 'hit' at revision 1.
      const hitRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
          headers: { cookie: adminCookie },
        }),
        env
      );
      expect(hitRes.status).toBe(200);
      expect(records[2]).toMatchObject({
        route: '/api/bundle',
        status: 200,
        cache_status: 'hit',
        bundle_revision: 1,
      });

      // Throwing sink never breaks Worker responses.
      const faultyWorker = createCloudflareWorker({
        siteConfig,
        clock,
        plugins: [
          createWorkersObservabilityPlugin({
            sink: () => {
              throw new Error('sink unavailable');
            },
          }),
        ],
      });
      const safeRes = await faultyWorker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me`, {
          headers: { cookie: adminCookie },
        }),
        env
      );
      expect(safeRes.status).toBe(200);
    } finally {
      await mf.dispose();
    }
  });
});
