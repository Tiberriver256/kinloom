import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdminDiagnosticsReportSchema,
  AdminPluginSettingsListResponseSchema,
  AdminPluginSettingsUpdateResponseSchema,
} from '@kinloom/core';
import {
  BOOK_PUBLISHING_ARTIFACTS_ROUTE,
  BOOK_PUBLISHING_COMPILE_ROUTE,
  BOOK_PUBLISHING_JOBS_ROUTE,
  BOOK_PUBLISHING_PLUGIN_ID,
  BOOK_PUBLISHING_STATUS_ROUTE,
  BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE,
  createBookPublishingServerPlugin,
  createPronunciationPlugin,
  createRecipesServerPlugin,
  createWorkersObservabilityPlugin,
  FixedClock,
  getSessionCookieName,
  inspectPdfPrepress,
  PRONUNCIATION_PLUGIN_ID,
  RECIPES_PLUGIN_ID,
  signLuluWebhookHmacHex,
  signSessionToken,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
  type WorkersObservabilityLogRecord,
} from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
} from '@kinloom/server/testing';
import { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createCloudflareWorker,
  type D1Database,
  type KinloomWorkerEnv,
  type R2Bucket,
  runD1PluginMigrations,
} from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_MIGRATION_FILES = [
  '0001_initial.sql',
  '0002_pronunciations.sql',
  '0003_pronunciation_provenance.sql',
  '0004_plugin_settings.sql',
  '0005_page_visit_stats.sql',
  '0006_plugin_migrations.sql',
] as const;

const CORE_MIGRATIONS = CORE_MIGRATION_FILES.map((name) =>
  readFileSync(resolve(THIS_DIR, '../migrations', name), 'utf8')
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

function makeFakePcmBase64(): string {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

let sharedMf: Miniflare | null = null;

afterAll(async () => {
  if (sharedMf) {
    await sharedMf.dispose();
    sharedMf = null;
  }
});

describe('Cloudflare Worker multi-isolate D1 + R2 persistence (Book Publishing, Observability, Pronunciation, Recipes)', () => {
  it('persists Book Publishing PDFs/jobs, Workers Observability settings, Pronunciation D1 keys/toggles, and Recipes auth/migration status across fresh isolates', async () => {
    sharedMf = new Miniflare({
      modules: true,
      compatibilityDate: '2026-08-06',
      script: 'export default { fetch() { return new Response("ok"); } };',
      d1Databases: {
        DB_MAIN: 'multi-isolate-main-db',
        DB_UNMIGRATED: 'multi-isolate-unmigrated-db',
      },
      r2Buckets: {
        MEDIA_BUCKET: 'multi-isolate-bucket',
      },
    });

    const db = (await sharedMf.getD1Database('DB_MAIN')) as unknown as D1Database;
    const unmigratedDb = (await sharedMf.getD1Database('DB_UNMIGRATED')) as unknown as D1Database;
    const bucket = (await sharedMf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;

    for (const sql of CORE_MIGRATIONS) {
      await applySqlScript(db, sql);
      await applySqlScript(unmigratedDb, sql);
    }

    const clock = new FixedClock('2026-11-27T12:00:00.000Z');
    const siteConfig = createSyntheticSiteConfig();
    const adminEmail = 'steward@archive.example';

    for (const targetDb of [db, unmigratedDb]) {
      await targetDb
        .prepare(
          'INSERT INTO users (email, display_name, role, added_by, added_at, last_login_at) VALUES (?, ?, ?, ?, ?, NULL)'
        )
        .bind(adminEmail, 'Archive Steward', 'admin', 'bootstrap', clock.nowIso())
        .run();
    }

    // Apply book publishing + recipes plugin migrations ONLY on DB_MAIN (leave DB_UNMIGRATED without recipes tables).
    await runD1PluginMigrations(db, [createBookPublishingServerPlugin(), createRecipesServerPlugin()], clock);

    const adminToken = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: adminEmail,
        display_name: 'Archive Steward',
        role: 'admin',
      },
    });
    const adminCookie = `${getSessionCookieName(true)}=${adminToken}`;

    const envPrivate: KinloomWorkerEnv = {
      DB: db,
      MEDIA_BUCKET: bucket,
      SESSION_SECRET: CONTRACT_SESSION_SECRET,
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      ARCHIVE_MODE: 'private',
      // Deliberately NO GEMINI_API_KEY env var: must come from D1 plugin_setting_secrets!
    };

    const envPublic: KinloomWorkerEnv = {
      ...envPrivate,
      ARCHIVE_MODE: 'public',
    };

    const ttsCalls: Array<{
      url: string;
      apiKey: string | null;
      quotaProject: string | null;
      body: string;
    }> = [];
    let simulateGeminiRateLimit = false;
    const mockTtsFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      ttsCalls.push({
        url,
        apiKey: headers.get('x-goog-api-key'),
        quotaProject: headers.get('x-goog-user-project'),
        body,
      });
      if (url.includes('generativelanguage.googleapis.com') && simulateGeminiRateLimit) {
        return new Response('RESOURCE_EXHAUSTED', { status: 429 });
      }
      if (url.includes('texttospeech.googleapis.com/v1/text:synthesize')) {
        return new Response(JSON.stringify({ audioContent: makeFakePcmBase64() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/L16;codec=pcm;rate=24000',
                      data: makeFakePcmBase64(),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const makeIsolate = (logsOut: WorkersObservabilityLogRecord[]) =>
      createCloudflareWorker({
        siteConfig,
        clock,
        pronunciationFetch: mockTtsFetch,
        plugins: [
          createWorkersObservabilityPlugin({
            clock,
            sink: (rec) => {
              logsOut.push(rec);
            },
          }),
          createPronunciationPlugin(),
          createBookPublishingServerPlugin(),
          createRecipesServerPlugin(),
        ],
      });

    const isolateALogs: WorkersObservabilityLogRecord[] = [];
    const isolateBLogs: WorkersObservabilityLogRecord[] = [];
    const isolateA = makeIsolate(isolateALogs);

    // Seed a historical ancestor via Isolate A so Book Publishing + Pronunciation have real D1 data.
    const ancestor = createSyntheticHistoricalPerson({
      id: 'per_ada_alder',
      slug: 'ada-alder',
      full_name: 'Ada Alder',
      given_name: 'Ada',
      surname: 'Alder',
    });
    const seedRes = await isolateA.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          entity_id: ancestor.id,
          data: ancestor,
          summary: 'Seed historical ancestor Ada Alder',
          has_primary_source: true,
        }),
      }),
      envPrivate
    );
    expect(seedRes.status).toBe(201);

    // === 1. Book Publishing cross-isolate PDF artifacts (R2) + D1 print jobs + webhook cleanup ===
    const webhookSecret = 'lulu-cross-isolate-webhook-secret-999';
    const saveBookSettings = await isolateA.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/plugin-settings/${BOOK_PUBLISHING_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          values: {
            publisher_provider: 'mock',
            environment: 'sandbox',
            contact_email: adminEmail,
          },
          secrets: {
            lulu_webhook_secret: { action: 'set', value: webhookSecret },
          },
        }),
      }),
      envPrivate
    );
    expect(saveBookSettings.status).toBe(200);

    const compileRes = await isolateA.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}${BOOK_PUBLISHING_COMPILE_ROUTE}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({ title: 'Alder Hardcover Volume I', edition: 'public' }),
      }),
      envPrivate
    );
    expect(compileRes.status).toBe(200);
    const compileJson = (await compileRes.json()) as {
      artifacts: { interior_pdf_url: string; cover_pdf_url: string };
    };

    const submitJobRes = await isolateA.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}${BOOK_PUBLISHING_JOBS_ROUTE}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          title: 'Alder Hardcover Volume I',
          quantity: 1,
          shippingLevel: 'ground',
          shippingAddress: {
            name: 'Rowan Alder',
            street1: '100 Main St',
            city: 'Springfield',
            stateCode: 'IL',
            countryCode: 'US',
            postalCode: '62701',
            phoneNumber: '+15555550100',
          },
        }),
      }),
      envPrivate
    );
    expect(submitJobRes.status).toBe(201);
    const submittedJob = (await submitJobRes.json()) as { job: { jobId: string } };

    // Spin up brand-new Isolate B on the SAME D1 + R2!
    const isolateB = makeIsolate(isolateBLogs);

    // Download compiled Interior & Cover PDFs from fresh Isolate B (verifies R2 storage + deterministic HMAC key!)
    const [interiorRes, coverRes] = await Promise.all([
      isolateB.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}${compileJson.artifacts.interior_pdf_url}`),
        envPrivate
      ),
      isolateB.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}${compileJson.artifacts.cover_pdf_url}`),
        envPrivate
      ),
    ]);
    expect(interiorRes.status).toBe(200);
    expect(interiorRes.headers.get('content-type')).toBe('application/pdf');
    expect(inspectPdfPrepress(new Uint8Array(await interiorRes.arrayBuffer())).validHeader).toBe(true);
    expect(coverRes.status).toBe(200);
    expect(coverRes.headers.get('content-type')).toBe('application/pdf');
    expect(inspectPdfPrepress(new Uint8Array(await coverRes.arrayBuffer())).validHeader).toBe(true);

    // List jobs & status on fresh Isolate B -> persisted D1 job is visible!
    const jobsResB = await isolateB.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}${BOOK_PUBLISHING_JOBS_ROUTE}`, {
        headers: { cookie: adminCookie },
      }),
      envPrivate
    );
    expect(jobsResB.status).toBe(200);
    const jobsJsonB = (await jobsResB.json()) as { jobs: Array<{ jobId: string; status: string }> };
    expect(jobsJsonB.jobs.some((j) => j.jobId === submittedJob.job.jobId)).toBe(true);

    const statusResB = await isolateB.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}${BOOK_PUBLISHING_STATUS_ROUTE}`, {
        headers: { cookie: adminCookie },
      }),
      envPrivate
    );
    expect(statusResB.status).toBe(200);
    const statusJsonB = (await statusResB.json()) as { jobs: Array<{ jobId: string }> };
    expect(statusJsonB.jobs.some((j) => j.jobId === submittedJob.job.jobId)).toBe(true);

    // Deliver signed Lulu SHIPPED webhook on Isolate B -> persists status to D1 and deletes job PDFs from R2!
    const webhookPayload = new TextEncoder().encode(
      JSON.stringify({
        topic: 'PRINT_JOB_STATUS_CHANGED',
        data: {
          id: submittedJob.job.jobId,
          status: { name: 'SHIPPED', message: 'Dispatched' },
          line_items: [{ tracking_urls: ['https://track.example/job-1'] }],
        },
      })
    );
    const sig = await signLuluWebhookHmacHex(webhookSecret, webhookPayload);
    const webhookRes = await isolateB.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}${BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Lulu-HMAC-SHA256': sig },
        body: webhookPayload,
      }),
      envPrivate
    );
    expect(webhookRes.status).toBe(200);

    // Isolate A sees updated 'shipped' status from D1 immediately.
    const jobsAfterWebhook = await isolateA.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}${BOOK_PUBLISHING_JOBS_ROUTE}`, {
        headers: { cookie: adminCookie },
      }),
      envPrivate
    );
    const jobsAfterJson = (await jobsAfterWebhook.json()) as {
      jobs: Array<{ jobId: string; status: string }>;
    };
    expect(jobsAfterJson.jobs.find((j) => j.jobId === submittedJob.job.jobId)?.status).toBe('shipped');

    // === 2. Workers Observability cross-isolate D1 hydration ===
    const saveObsRes = await isolateA.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/plugin-settings/${WORKERS_OBSERVABILITY_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          values: {
            emit_server_timing: false,
            include_request_id_header: false,
            log_level_threshold: 'error',
          },
        }),
      }),
      envPrivate
    );
    expect(saveObsRes.status).toBe(200);

    // Fresh Isolate C hydrates disabled observability toggles from D1 on its very first request!
    const isolateCLogs: WorkersObservabilityLogRecord[] = [];
    const isolateC = makeIsolate(isolateCLogs);
    const bundleResC = await isolateC.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } }),
      envPrivate
    );
    expect(bundleResC.status).toBe(200);
    expect(bundleResC.headers.get('server-timing')).toBeNull();
    expect(bundleResC.headers.get('x-request-id')).toBeNull();
    expect(isolateCLogs).toHaveLength(0);

    const diagResC = await isolateC.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`, { headers: { cookie: adminCookie } }),
      envPrivate
    );
    const diagJsonC = AdminDiagnosticsReportSchema.parse(await diagResC.json());
    expect(diagJsonC.config.observability.server_timing).toBe(false);

    // === 3. Pronunciation & TTS cross-isolate D1 key, voice, phoneme_mode & disabled ===
    const savePronRes = await isolateA.fetch(
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
            fallback_backend: 'none',
            default_model: 'gemini-3.8-flash-tts',
            default_voice: 'Kore',
            phoneme_mode: 'plain',
            auto_generate_on_save: true,
          },
          secrets: {
            gemini_api_key: { action: 'set', value: 'AIzaSyCrossIsolateD1Key_777' },
          },
        }),
      }),
      envPrivate
    );
    expect(savePronRes.status).toBe(200);
    const savePronJson = AdminPluginSettingsUpdateResponseSchema.parse(await savePronRes.json());
    expect(savePronJson.plugin.readonly_values['active_generator']).toBe('gemini-tts');

    // Fresh Isolate D generates audio using D1 secret + voice + plain mode (no env.GEMINI_API_KEY!)
    const isolateD = makeIsolate([]);
    const pronDiagD = AdminDiagnosticsReportSchema.parse(
      await (
        await isolateD.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`, { headers: { cookie: adminCookie } }),
          envPrivate
        )
      ).json()
    );
    expect(pronDiagD.runtime.adapters.pronunciation_generator).toBe('gemini-tts');

    const genResD = await isolateD.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: ancestor.id,
          phonetic: 'AY-duh AWL-der',
          ipa: 'ˈeɪdə ˈɔːldər',
        }),
      }),
      envPrivate
    );
    expect(genResD.status).toBe(200);
    expect(ttsCalls).toHaveLength(1);
    expect(ttsCalls[0]?.apiKey).toBe('AIzaSyCrossIsolateD1Key_777');
    expect(ttsCalls[0]?.body).toContain('"voiceName":"Kore"');
    expect(ttsCalls[0]?.body).not.toContain('ˈeɪdə');

    // Configure Gemini primary + Chirp 3 HD fallback on Isolate A -> fresh Isolate F fails over on Gemini 429!
    const saveChirpFailoverRes = await isolateA.fetch(
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
            fallback_backend: 'chirp3-hd',
            chirp_voice: 'en-US-Chirp3-HD-Kore',
            gcp_project_id: 'kinloom-d1-quota',
            phoneme_mode: 'ipa',
          },
          secrets: {
            google_cloud_tts_api_key: { action: 'set', value: 'AIzaSyCrossIsolateChirpKey_999' },
          },
        }),
      }),
      envPrivate
    );
    expect(saveChirpFailoverRes.status).toBe(200);
    const saveChirpBody = await saveChirpFailoverRes.text();
    expect(saveChirpBody).not.toContain('AIzaSyCrossIsolateChirpKey_999');

    simulateGeminiRateLimit = true;
    const isolateF = makeIsolate([]);
    const genFailoverRes = await isolateF.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: ancestor.id,
          phonetic: 'AY-duh AWL-der',
          ipa: 'ˈeɪdə ˈɔːldər',
          force: true,
        }),
      }),
      envPrivate
    );
    expect(genFailoverRes.status).toBe(200);
    expect(ttsCalls).toHaveLength(3);
    expect(ttsCalls[1]?.url).toContain('generativelanguage.googleapis.com');
    expect(ttsCalls[2]?.url).toContain('texttospeech.googleapis.com/v1/text:synthesize');
    expect(ttsCalls[2]?.apiKey).toBe('AIzaSyCrossIsolateChirpKey_999');
    expect(ttsCalls[2]?.quotaProject).toBe('kinloom-d1-quota');
    expect(ttsCalls[2]?.body).toContain('en-US-Chirp3-HD-Kore');
    expect(ttsCalls[2]?.body).toContain('PHONETIC_ENCODING_IPA');
    simulateGeminiRateLimit = false;

    // Disable Pronunciation on Isolate A -> fresh Isolate E returns 503 PRONUNCIATION_DISABLED!
    await isolateA.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          values: { primary_backend: 'disabled', fallback_backend: 'none' },
        }),
      }),
      envPrivate
    );
    const isolateE = makeIsolate([]);
    const disabledPronRes = await isolateE.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({ entity_type: 'person', entity_id: ancestor.id }),
      }),
      envPrivate
    );
    expect(disabledPronRes.status).toBe(503);
    expect(((await disabledPronRes.json()) as { error: { code: string } }).error.code).toBe(
      'PRONUNCIATION_DISABLED'
    );

    // === 4. Family Recipes archive_read (public vs private) + missing migration 503 ===
    const privRecipesAnon = await isolateE.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes`),
      envPrivate
    );
    expect(privRecipesAnon.status).toBe(401);

    const pubRecipesAnon = await isolateE.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes`),
      envPublic
    );
    expect(pubRecipesAnon.status).toBe(200);

    // Unmigrated D1 returns 503 PLUGIN_MIGRATION_REQUIRED and reports degraded status cleanly!
    const envUnmigrated: KinloomWorkerEnv = {
      ...envPublic,
      DB: unmigratedDb,
    };
    const missingRecipesRes = await isolateE.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes`),
      envUnmigrated
    );
    expect(missingRecipesRes.status).toBe(503);
    expect(((await missingRecipesRes.json()) as { error: { code: string } }).error.code).toBe(
      'PLUGIN_MIGRATION_REQUIRED'
    );

    const unmigratedSettingsRes = await isolateE.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/plugin-settings`, {
        headers: { cookie: adminCookie },
      }),
      envUnmigrated
    );
    const unmigratedSettings = AdminPluginSettingsListResponseSchema.parse(
      await unmigratedSettingsRes.json()
    );
    const recipesPluginSnap = unmigratedSettings.plugins.find((p) => p.plugin_id === RECIPES_PLUGIN_ID);
    expect(recipesPluginSnap?.status).toBe('degraded');
    expect(String(recipesPluginSnap?.readonly_values['storage_adapter'])).toContain('migration required');

    // Confirm book artifacts route rejects forged tokens cleanly as well.
    const badTokenRes = await isolateE.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}${BOOK_PUBLISHING_ARTIFACTS_ROUTE}/bad.sig`),
      envPrivate
    );
    expect(badTokenRes.status).toBe(401);
  }, 30_000);
});
