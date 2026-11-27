import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminDiagnosticsReportSchema, KINLOOM_CORE_VERSION } from '@kinloom/core';
import {
  createWorkersObservabilityPlugin,
  FixedClock,
  getSessionCookieName,
  KINLOOM_SERVER_VERSION,
  signSessionToken,
} from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticSiteConfig,
} from '@kinloom/server/testing';
import { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import { probeD1SchemaMigrationLevel } from './adapters/d1/schemaProbe.js';
import {
  createCloudflareWorker,
  type D1Database,
  KINLOOM_WORKER_VERSION,
  type KinloomWorkerEnv,
  type R2Bucket,
} from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATION_0001 = readFileSync(resolve(THIS_DIR, '../migrations/0001_initial.sql'), 'utf8');
const MIGRATION_0002 = readFileSync(resolve(THIS_DIR, '../migrations/0002_pronunciations.sql'), 'utf8');
const MIGRATION_0003 = readFileSync(
  resolve(THIS_DIR, '../migrations/0003_pronunciation_provenance.sql'),
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
  if (statements.length > 0) {
    await db.batch(statements.map((stmt) => db.prepare(stmt)));
  }
}

let mf: Miniflare | null = null;

afterAll(async () => {
  if (mf) {
    await mf.dispose();
    mf = null;
  }
});

describe('Cloudflare Worker GET /api/admin/system diagnostics (Miniflare D1/R2)', () => {
  it('detects D1 migration levels across empty, 0001, 0002, 0003, and d1_migrations ledger states', async () => {
    mf = new Miniflare({
      modules: true,
      compatibilityDate: '2026-08-06',
      script: 'export default { fetch() { return new Response("ok"); } };',
      d1Databases: {
        DB_EMPTY: 'diag-empty-db',
        DB_FULL: 'diag-full-db',
      },
      r2Buckets: {
        MEDIA_BUCKET: 'diag-media-bucket',
      },
    });

    const emptyDb = (await mf.getD1Database('DB_EMPTY')) as unknown as D1Database;
    expect(await probeD1SchemaMigrationLevel(emptyDb)).toBeNull();

    await applySqlScript(emptyDb, MIGRATION_0001);
    expect(await probeD1SchemaMigrationLevel(emptyDb)).toBe('0001_initial.sql');

    await applySqlScript(emptyDb, MIGRATION_0002);
    expect(await probeD1SchemaMigrationLevel(emptyDb)).toBe('0002_pronunciations.sql');

    await applySqlScript(emptyDb, MIGRATION_0003);
    expect(await probeD1SchemaMigrationLevel(emptyDb)).toBe('0003_pronunciation_provenance.sql');

    await emptyDb
      .prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)')
      .run();
    await emptyDb
      .prepare("INSERT INTO d1_migrations (name) VALUES ('0003_pronunciation_provenance.sql')")
      .run();
    expect(await probeD1SchemaMigrationLevel(emptyDb)).toBe('0003_pronunciation_provenance.sql');

    const brokenDb = {
      prepare() {
        throw new Error('D1 binding fault');
      },
    } as unknown as D1Database;
    expect(await probeD1SchemaMigrationLevel(brokenDb)).toBeNull();
  });

  it('serves redacted D1/R2 worker diagnostics, tracks isolate errors, and never leaks env secrets', async () => {
    if (!mf) {
      throw new Error('Expected Miniflare instance');
    }
    const db = (await mf.getD1Database('DB_FULL')) as unknown as D1Database;
    const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;
    await applySqlScript(db, MIGRATION_0001);
    await applySqlScript(db, MIGRATION_0002);
    await applySqlScript(db, MIGRATION_0003);

    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-27T12:00:00.000Z');
    const adminEmail = 'worker.steward@archive.example';
    const googleSecret = 'worker_google_oauth_secret_888';
    const geminiSecret = 'worker_gemini_api_key_777';

    await db
      .prepare(
        'INSERT INTO users (email, display_name, role, added_by, added_at, last_login_at) VALUES (?, ?, ?, ?, ?, NULL)'
      )
      .bind(adminEmail, 'Worker Steward', 'admin', 'bootstrap', clock.nowIso())
      .run();

    const worker = createCloudflareWorker({
      siteConfig,
      clock,
      plugins: [createWorkersObservabilityPlugin({ clock, sink: () => {} })],
    });

    const env: KinloomWorkerEnv = {
      DB: db,
      MEDIA_BUCKET: bucket,
      SESSION_SECRET: CONTRACT_SESSION_SECRET,
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      GOOGLE_CLIENT_ID: 'worker-google-client-id',
      GOOGLE_CLIENT_SECRET: googleSecret,
      GEMINI_API_KEY: geminiSecret,
      ARCHIVE_MODE: 'private',
      KINLOOM_BUILD_SHA: 'deadbeef1234',
      KINLOOM_BUILD_TIMESTAMP: '2026-11-27T09:00:00Z',
      KINLOOM_COMPATIBILITY_DATE: '2026-08-06',
    };

    const adminToken = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: adminEmail,
        display_name: 'Worker Steward',
        role: 'admin',
      },
    });
    const adminCookie = `${getSessionCookieName(true)}=${adminToken}`;

    // Trigger one 404 to confirm isolate-level recent error tracking across requests.
    const notFoundRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/per_missing_record`, {
        headers: { cookie: adminCookie },
      }),
      env
    );
    expect(notFoundRes.status).toBe(404);

    // Cold bundle cache should report 'warn' before /api/bundle warms it.
    const coldRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`, {
        headers: { cookie: adminCookie },
      }),
      env
    );
    expect(coldRes.status).toBe(200);
    const coldText = await coldRes.text();
    for (const secret of [
      CONTRACT_SESSION_SECRET,
      googleSecret,
      geminiSecret,
      adminEmail,
      'per_missing_record',
    ]) {
      expect(coldText).not.toContain(secret);
    }

    const coldReport = AdminDiagnosticsReportSchema.parse(JSON.parse(coldText));
    expect(coldReport.versions).toEqual({
      core_version: KINLOOM_CORE_VERSION,
      server_version: KINLOOM_SERVER_VERSION,
      worker_version: KINLOOM_WORKER_VERSION,
      build_commit_sha: 'deadbeef1234',
      build_timestamp: '2026-11-27T09:00:00Z',
      schema_migration_level: '0003_pronunciation_provenance.sql',
    });
    expect(coldReport.runtime).toEqual({
      platform: 'cloudflare-workers',
      node_version: null,
      workers_compatibility_date: '2026-08-06',
      adapters: {
        repository: 'd1',
        bundle_cache: 'r2',
        media_store: 'r2',
        email_sender: 'cloudflare-email',
        auth_provider_configured: true,
        auth_provider_id: 'google',
        pronunciation_generator: 'gemini-tts',
        pronunciation_lexicon_store: 'd1',
      },
    });
    expect(coldReport.archive.bundle_cache_status).toBe('miss');
    expect(coldReport.health_checks).toEqual([
      expect.objectContaining({ name: 'repository', status: 'pass' }),
      expect.objectContaining({ name: 'bundle_cache', status: 'warn' }),
      expect.objectContaining({ name: 'media_store', status: 'pass' }),
    ]);
    expect(coldReport.recent_errors).toEqual([
      {
        timestamp: clock.nowIso(),
        route: '/api/entities/:type/:id',
        status: 404,
        error_code: 'NOT_FOUND',
      },
    ]);

    // Warm the R2 bundle cache via /api/bundle and confirm bundle_cache check transitions to 'pass'.
    const bundleRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } }),
      env
    );
    expect(bundleRes.status).toBe(200);

    const warmRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`, { headers: { cookie: adminCookie } }),
      env
    );
    const warmReport = AdminDiagnosticsReportSchema.parse(await warmRes.json());
    expect(warmReport.archive.bundle_cache_status).toBe('hit');
    expect(warmReport.health_checks.find((c) => c.name === 'bundle_cache')?.status).toBe('pass');
  });
});
