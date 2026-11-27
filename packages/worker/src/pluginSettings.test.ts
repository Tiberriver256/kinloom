import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdminPluginSettingsListResponseSchema,
  AdminPluginSettingsUpdateResponseSchema,
} from '@kinloom/core';
import {
  createPronunciationPlugin,
  createWorkersObservabilityPlugin,
  FixedClock,
  getSessionCookieName,
  PRONUNCIATION_PLUGIN_ID,
  signSessionToken,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
} from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticSiteConfig,
} from '@kinloom/server/testing';
import { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import { probeD1SchemaMigrationLevel } from './adapters/d1/schemaProbe.js';
import { D1PluginSettingsStore } from './adapters/d1PluginSettingsStore.js';
import { createCloudflareWorker, type D1Database, type KinloomWorkerEnv, type R2Bucket } from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATION_0001 = readFileSync(resolve(THIS_DIR, '../migrations/0001_initial.sql'), 'utf8');
const MIGRATION_0002 = readFileSync(resolve(THIS_DIR, '../migrations/0002_pronunciations.sql'), 'utf8');
const MIGRATION_0003 = readFileSync(
  resolve(THIS_DIR, '../migrations/0003_pronunciation_provenance.sql'),
  'utf8'
);
const MIGRATION_0004 = readFileSync(resolve(THIS_DIR, '../migrations/0004_plugin_settings.sql'), 'utf8');

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

describe('Cloudflare Worker D1PluginSettingsStore & /api/admin/plugin-settings (Miniflare D1)', () => {
  it('handles missing table gracefully, applies idempotent 0004 migration, isolates secrets in D1, and serves admin API cleanly', async () => {
    mf = new Miniflare({
      modules: true,
      compatibilityDate: '2026-08-06',
      script: 'export default { fetch() { return new Response("ok"); } };',
      d1Databases: {
        DB_SETTINGS: 'plugin-settings-db',
      },
      r2Buckets: {
        MEDIA_BUCKET: 'plugin-settings-bucket',
      },
    });

    const db = (await mf.getD1Database('DB_SETTINGS')) as unknown as D1Database;
    const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;

    await applySqlScript(db, MIGRATION_0001);
    await applySqlScript(db, MIGRATION_0002);
    await applySqlScript(db, MIGRATION_0003);

    // Before 0004 is applied, D1PluginSettingsStore degrades cleanly on reads.
    const store = new D1PluginSettingsStore(db);
    expect(await store.getSettings(PRONUNCIATION_PLUGIN_ID)).toBeNull();
    expect(await store.getSecretMetadata(PRONUNCIATION_PLUGIN_ID)).toEqual({});
    expect(await store.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'gemini_api_key')).toBeNull();

    // Apply 0004 twice to confirm strict SQL idempotency.
    await applySqlScript(db, MIGRATION_0004);
    await applySqlScript(db, MIGRATION_0004);
    expect(await probeD1SchemaMigrationLevel(db)).toBe('0004_plugin_settings.sql');

    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-27T12:00:00.000Z');
    const adminEmail = 'd1.steward@archive.example';
    await db
      .prepare(
        'INSERT INTO users (email, display_name, role, added_by, added_at, last_login_at) VALUES (?, ?, ?, ?, ?, NULL)'
      )
      .bind(adminEmail, 'D1 Steward', 'admin', 'bootstrap', clock.nowIso())
      .run();

    const worker = createCloudflareWorker({
      siteConfig,
      clock,
      plugins: [createWorkersObservabilityPlugin({ clock, sink: () => {} }), createPronunciationPlugin()],
    });

    const env: KinloomWorkerEnv = {
      DB: db,
      MEDIA_BUCKET: bucket,
      SESSION_SECRET: CONTRACT_SESSION_SECRET,
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      ARCHIVE_MODE: 'private',
    };

    const adminToken = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: adminEmail,
        display_name: 'D1 Steward',
        role: 'admin',
      },
    });
    const adminCookie = `${getSessionCookieName(true)}=${adminToken}`;

    // 1. GET lists both reference adopters with live D1/R2 readonly metadata.
    const initialGet = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/plugin-settings`, {
        headers: { cookie: adminCookie },
      }),
      env
    );
    expect(initialGet.status).toBe(200);
    const initialList = AdminPluginSettingsListResponseSchema.parse(await initialGet.json());
    const obsSnapshot = initialList.plugins.find((p) => p.plugin_id === WORKERS_OBSERVABILITY_PLUGIN_ID);
    expect(obsSnapshot?.readonly_values.runtime_platform).toBe('cloudflare-workers');
    expect(String(obsSnapshot?.readonly_values.storage_bindings)).toContain('repository=d1');
    expect(String(obsSnapshot?.readonly_values.storage_bindings)).toContain('media_store=r2');

    // 2. PUT writes non-secret settings and write-only API key into separate D1 tables.
    const d1GeminiKey = 'AIzaSyD1IsolatedSecret_1234567890';
    const putRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          values: {
            primary_backend: 'gemini',
            default_voice: 'Aoede',
            phoneme_mode: 'ipa',
          },
          secrets: {
            gemini_api_key: { action: 'set', value: d1GeminiKey },
          },
        }),
      }),
      env
    );
    expect(putRes.status).toBe(200);
    const putText = await putRes.text();
    expect(putText).not.toContain(d1GeminiKey);
    const putParsed = AdminPluginSettingsUpdateResponseSchema.parse(JSON.parse(putText));
    expect(putParsed.plugin.secrets.gemini_api_key).toEqual({
      configured: true,
      updated_at: '2026-11-27T12:00:00.000Z',
    });

    // Verify D1 table isolation directly: plugin_settings never contains the secret; plugin_setting_secrets holds it.
    const nonSecretRow = await db
      .prepare('SELECT values_json FROM plugin_settings WHERE plugin_id = ?')
      .bind(PRONUNCIATION_PLUGIN_ID)
      .first<{ values_json: string }>();
    expect(nonSecretRow?.values_json).toContain('Aoede');
    expect(nonSecretRow?.values_json).not.toContain(d1GeminiKey);
    expect(await store.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'gemini_api_key')).toBe(d1GeminiKey);

    // 3. Partial save of unrelated field preserves the D1 secret intact.
    const partialRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          values: { phoneme_mode: 'plain' },
        }),
      }),
      env
    );
    expect(partialRes.status).toBe(200);
    expect(await store.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'gemini_api_key')).toBe(d1GeminiKey);

    // 4. Explicit clear deletes the D1 secret row cleanly.
    const clearRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          secrets: { gemini_api_key: { action: 'clear' } },
        }),
      }),
      env
    );
    expect(clearRes.status).toBe(200);
    const cleared = AdminPluginSettingsUpdateResponseSchema.parse(await clearRes.json());
    expect(cleared.plugin.secrets.gemini_api_key).toEqual({ configured: false, updated_at: null });
    expect(await store.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'gemini_api_key')).toBeNull();
  });
});
