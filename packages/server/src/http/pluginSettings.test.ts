import {
  AdminDiagnosticsReportSchema,
  AdminPluginSettingsListResponseSchema,
  AdminPluginSettingsUpdateResponseSchema,
} from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import type { FixedClock } from '../adapters/systemClock.js';
import {
  createKinloomServer,
  createPronunciationPlugin,
  createWorkersObservabilityPlugin,
  getSessionCookieName,
  type KinloomServerPlugin,
  normalizeServerRouteTemplate,
  PRONUNCIATION_PLUGIN_ID,
  signSessionToken,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
  type WorkersObservabilityLogRecord,
} from '../index.js';
import { createSyntheticSiteConfig } from '../testing/adapterContractSuite.js';

const ORIGIN = 'https://alder.example.test';
const SESSION_SECRET = 'kinloom-plugin-settings-test-secret-0123456789';

async function createUserCookie(clock: FixedClock, role: 'admin' | 'editor', email: string): Promise<string> {
  const token = await signSessionToken({
    secret: SESSION_SECRET,
    clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email,
      display_name: role === 'admin' ? 'Archive Admin' : 'Archive Editor',
      role,
    },
  });
  return `${getSessionCookieName(true)}=${token}`;
}

describe('Declarative Plugin Settings API, RBAC/CSRF, write-only secrets, and reference adopters', () => {
  it('enforces admin RBAC (401/403) and CSRF origin validation on GET and PUT /api/admin/plugin-settings', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const clock = ports.clock;

    await ports.repository.upsertUser({
      email: 'admin@archive.example',
      display_name: 'Archive Admin',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: clock.nowIso(),
      last_login_at: null,
    });
    await ports.repository.upsertUser({
      email: 'editor@archive.example',
      display_name: 'Archive Editor',
      role: 'editor',
      added_by: 'admin@archive.example',
      added_at: clock.nowIso(),
      last_login_at: null,
    });

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [createPronunciationPlugin()],
      },
      sessionSecret: SESSION_SECRET,
    });

    // 1. Unauthenticated -> 401
    const unauthGet = await server.fetch(new Request(`${ORIGIN}/api/admin/plugin-settings`));
    expect(unauthGet.status).toBe(401);

    const unauthPut = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ values: { default_voice: 'Kore' } }),
      })
    );
    expect(unauthPut.status).toBe(401);

    // 2. Editor -> 403 ADMIN_REQUIRED
    const editorCookie = await createUserCookie(clock, 'editor', 'editor@archive.example');
    const editorGet = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings`, {
        headers: { cookie: editorCookie },
      })
    );
    expect(editorGet.status).toBe(403);
    expect(((await editorGet.json()) as { error: { code: string } }).error.code).toBe('ADMIN_REQUIRED');

    const editorPut = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({ values: { default_voice: 'Kore' } }),
      })
    );
    expect(editorPut.status).toBe(403);

    // 3. Admin with cross-origin CSRF header -> 403 CSRF_ORIGIN_MISMATCH
    const adminCookie = await createUserCookie(clock, 'admin', 'admin@archive.example');
    const csrfPut = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example.test',
          cookie: adminCookie,
        },
        body: JSON.stringify({ values: { default_voice: 'Kore' } }),
      })
    );
    expect(csrfPut.status).toBe(403);
    expect(((await csrfPut.json()) as { error: { code: string } }).error.code).toBe('CSRF_ORIGIN_MISMATCH');
  });

  it('persists write-only secrets ({ type: string, secret: true } and { type: secret }), preserves them on partial saves, clears them explicitly, and never leaks plaintext anywhere', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const clock = ports.clock;
    const telemetryLogs: WorkersObservabilityLogRecord[] = [];

    await ports.repository.upsertUser({
      email: 'admin@archive.example',
      display_name: 'Archive Admin',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: clock.nowIso(),
      last_login_at: null,
    });
    const adminCookie = await createUserCookie(clock, 'admin', 'admin@archive.example');

    const observabilityPlugin = createWorkersObservabilityPlugin({
      clock,
      sink: (rec) => {
        telemetryLogs.push(rec);
      },
    });
    const pronunciationPlugin = createPronunciationPlugin();

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [observabilityPlugin, pronunciationPlugin],
      },
      sessionSecret: SESSION_SECRET,
    });

    // Initial GET lists both reference adopters with defaults and unconfigured secrets.
    const initialRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(initialRes.status).toBe(200);
    const initialList = AdminPluginSettingsListResponseSchema.parse(await initialRes.json());
    expect(initialList.plugins.map((p) => p.plugin_id)).toEqual([
      WORKERS_OBSERVABILITY_PLUGIN_ID,
      PRONUNCIATION_PLUGIN_ID,
    ]);

    const pronInitial = initialList.plugins.find((p) => p.plugin_id === PRONUNCIATION_PLUGIN_ID);
    expect(pronInitial?.values).toMatchObject({
      primary_backend: 'gemini',
      fallback_backend: 'none',
      default_model: 'gemini-3.8-flash-tts',
      default_voice: 'Charon',
      phoneme_mode: 'ipa',
      auto_generate_on_save: true,
    });
    expect(pronInitial?.secrets).toEqual({
      gemini_api_key: { configured: false, updated_at: null },
      openai_api_key: { configured: false, updated_at: null },
      chirp3_api_key: { configured: false, updated_at: null },
    });

    // Save non-secret fields + write-only API keys (string+secret:true and secret).
    const geminiSecret = 'AIzaSySyntheticGeminiKey_99887766';
    const openaiSecret = 'sk-synthetic-openai-speech-key-554433';
    const chirpSecret = 'chirp3-synthetic-secret-221100';

    const saveSecretsRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          values: {
            primary_backend: 'openai-speech',
            fallback_backend: 'gemini',
            openai_base_url: 'https://tts.archive.example/v1',
            default_voice: 'Kore',
            phoneme_mode: 'arpabet',
          },
          secrets: {
            gemini_api_key: { action: 'set', value: geminiSecret },
            openai_api_key: { action: 'set', value: openaiSecret },
            chirp3_api_key: { action: 'set', value: chirpSecret },
          },
        }),
      })
    );
    expect(saveSecretsRes.status).toBe(200);
    const saveSecretsText = await saveSecretsRes.text();
    for (const secret of [geminiSecret, openaiSecret, chirpSecret]) {
      expect(saveSecretsText).not.toContain(secret);
    }

    const updatedAfterSecrets = AdminPluginSettingsUpdateResponseSchema.parse(JSON.parse(saveSecretsText));
    expect(updatedAfterSecrets.plugin.secrets).toEqual({
      gemini_api_key: { configured: true, updated_at: '2026-11-27T12:00:00.000Z' },
      openai_api_key: { configured: true, updated_at: '2026-11-27T12:00:00.000Z' },
      chirp3_api_key: { configured: true, updated_at: '2026-11-27T12:00:00.000Z' },
    });
    expect(updatedAfterSecrets.plugin.readonly_values.configured_credentials).toBe(
      'gemini, openai-speech, chirp3-hd'
    );
    expect(pronunciationPlugin.getRuntimeConfig()).toMatchObject({
      primaryBackend: 'openai-speech',
      fallbackBackend: 'gemini',
      openAiBaseUrl: 'https://tts.archive.example/v1',
      defaultVoice: 'Kore',
      phonemeMode: 'arpabet',
    });

    // Verify internal store holds the secrets cleanly separated from non-secret settings.
    expect(await ports.pluginSettingsStore.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'gemini_api_key')).toBe(
      geminiSecret
    );
    const storedNonSecrets = await ports.pluginSettingsStore.getSettings(PRONUNCIATION_PLUGIN_ID);
    expect(JSON.stringify(storedNonSecrets)).not.toContain(geminiSecret);
    expect(JSON.stringify(storedNonSecrets)).not.toContain(openaiSecret);

    // Partial update of unrelated field preserves all existing secrets untouched.
    clock.advanceMs(120_000);
    const partialRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          values: {
            default_voice: 'Puck',
            auto_generate_on_save: false,
          },
        }),
      })
    );
    expect(partialRes.status).toBe(200);
    const partialParsed = AdminPluginSettingsUpdateResponseSchema.parse(await partialRes.json());
    expect(partialParsed.plugin.values.default_voice).toBe('Puck');
    expect(partialParsed.plugin.values.auto_generate_on_save).toBe(false);
    expect(partialParsed.plugin.secrets.gemini_api_key).toEqual({
      configured: true,
      updated_at: '2026-11-27T12:00:00.000Z',
    });
    expect(await ports.pluginSettingsStore.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'gemini_api_key')).toBe(
      geminiSecret
    );
    expect(await ports.pluginSettingsStore.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'openai_api_key')).toBe(
      openaiSecret
    );

    // Explicit clear removes only the targeted secret.
    const clearRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          secrets: {
            openai_api_key: { action: 'clear' },
          },
        }),
      })
    );
    expect(clearRes.status).toBe(200);
    const clearedParsed = AdminPluginSettingsUpdateResponseSchema.parse(await clearRes.json());
    expect(clearedParsed.plugin.secrets.openai_api_key).toEqual({ configured: false, updated_at: null });
    expect(clearedParsed.plugin.secrets.gemini_api_key.configured).toBe(true);
    expect(
      await ports.pluginSettingsStore.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'openai_api_key')
    ).toBeNull();
    expect(await ports.pluginSettingsStore.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'gemini_api_key')).toBe(
      geminiSecret
    );

    // Verify ZERO plaintext secrets leak across GET plugin-settings, GET system diagnostics, GET bundle, GET privacy, and telemetry logs.
    const [listRes, diagRes, bundleRes, privacyRes] = await Promise.all([
      server.fetch(new Request(`${ORIGIN}/api/admin/plugin-settings`, { headers: { cookie: adminCookie } })),
      server.fetch(new Request(`${ORIGIN}/api/admin/system`, { headers: { cookie: adminCookie } })),
      server.fetch(new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } })),
      server.fetch(new Request(`${ORIGIN}/privacy`)),
    ]);
    const [listText, diagText, bundleText, privacyText] = await Promise.all([
      listRes.text(),
      diagRes.text(),
      bundleRes.text(),
      privacyRes.text(),
    ]);
    const diagReport = AdminDiagnosticsReportSchema.parse(JSON.parse(diagText));
    expect(diagReport.plugins.find((p) => p.id === PRONUNCIATION_PLUGIN_ID)?.hooks).toContain(
      'settingsSchema'
    );

    const combinedSurface = [listText, diagText, bundleText, privacyText, JSON.stringify(telemetryLogs)].join(
      '\n'
    );
    for (const secret of [geminiSecret, openaiSecret, chirpSecret]) {
      expect(combinedSurface).not.toContain(secret);
    }

    // Verify route normalization masks pluginId cleanly in observability telemetry.
    expect(normalizeServerRouteTemplate('/api/admin/plugin-settings')).toBe('/api/admin/plugin-settings');
    expect(normalizeServerRouteTemplate('/api/admin/plugin-settings/kinloom-pronunciation')).toBe(
      '/api/admin/plugin-settings/:pluginId'
    );
    expect(telemetryLogs.some((r) => r.route === '/api/admin/plugin-settings/:pluginId')).toBe(true);
  });

  it('applies live runtime telemetry toggles via Cloudflare Workers Observability plugin settings', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const clock = ports.clock;
    const records: WorkersObservabilityLogRecord[] = [];

    await ports.repository.upsertUser({
      email: 'admin@archive.example',
      display_name: 'Archive Admin',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: clock.nowIso(),
      last_login_at: null,
    });
    const adminCookie = await createUserCookie(clock, 'admin', 'admin@archive.example');

    const disabledObs = createWorkersObservabilityPlugin({ enabled: false });
    expect(disabledObs.settingsSchema).toBeDefined();

    const activeObs = createWorkersObservabilityPlugin({
      clock,
      sink: (rec) => {
        records.push(rec);
      },
    });
    const server = createKinloomServer({
      siteConfig,
      ports: { ...ports, plugins: [activeObs] },
      sessionSecret: SESSION_SECRET,
    });

    // Before toggle: Server-Timing and X-Request-Id are emitted, info logs recorded.
    const beforeRes = await server.fetch(new Request(`${ORIGIN}/api/auth/me`));
    expect(beforeRes.headers.get('server-timing')).toMatch(/total;dur=/);
    expect(beforeRes.headers.get('x-request-id')).toMatch(/.+/);
    const countBefore = records.length;

    // Toggle off headers and raise log level threshold to error.
    const toggleRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${WORKERS_OBSERVABILITY_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          values: {
            emit_server_timing: false,
            include_request_id_header: false,
            log_level_threshold: 'error',
          },
        }),
      })
    );
    expect(toggleRes.status).toBe(200);
    const toggled = AdminPluginSettingsUpdateResponseSchema.parse(await toggleRes.json());
    expect(toggled.plugin.readonly_values.server_timing_status).toBe('disabled');
    expect(toggled.plugin.readonly_values.storage_bindings).toContain('repository=in-memory');

    // Subsequent 200 request emits no headers and no info log.
    const afterRes = await server.fetch(new Request(`${ORIGIN}/api/auth/me`));
    expect(afterRes.status).toBe(200);
    expect(afterRes.headers.get('server-timing')).toBeNull();
    expect(afterRes.headers.get('x-request-id')).toBeNull();
    expect(records.length).toBe(countBefore);
  });

  it('rejects unknown plugins (400), malformed payloads (400), validation errors (422), missing store (503), and fault-isolates plugin hooks', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const clock = ports.clock;
    const reportedErrors: string[] = [];

    await ports.repository.upsertUser({
      email: 'admin@archive.example',
      display_name: 'Archive Admin',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: clock.nowIso(),
      last_login_at: null,
    });
    const adminCookie = await createUserCookie(clock, 'admin', 'admin@archive.example');

    const faultyPlugin: KinloomServerPlugin = {
      id: 'faulty-settings-plugin',
      name: 'Faulty Plugin',
      settingsSchema: {
        sections: [
          {
            id: 'main',
            title: 'Main',
            fields: [
              { key: 'ro_state', label: 'RO', type: 'readonly', defaultValue: 'fallback' },
              { key: 'note', label: 'Note', type: 'string', defaultValue: 'ok' },
            ],
          },
        ],
      },
      getReadonlySettings: () => {
        throw new Error('readonly hook failure');
      },
      onSettingsUpdated: () => {
        throw new Error('updated hook failure');
      },
    };

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [createPronunciationPlugin(), faultyPlugin],
      },
      sessionSecret: SESSION_SECRET,
      onPluginError: (pluginId) => {
        reportedErrors.push(pluginId);
      },
    });

    // Unknown plugin -> 400 UNKNOWN_PLUGIN
    const unknownRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/does-not-exist`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ values: {} }),
      })
    );
    expect(unknownRes.status).toBe(400);
    expect(((await unknownRes.json()) as { error: { code: string } }).error.code).toBe('UNKNOWN_PLUGIN');

    // Malformed payload (extra unknown top-level key rejected by strict schema) -> 400
    const badBodyRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ unexpected_root: true }),
      })
    );
    expect(badBodyRes.status).toBe(400);

    // Invalid schema values (fallback === primary, openai without url, secret in values) -> 422
    const invalidFieldsRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          values: {
            primary_backend: 'openai-speech',
            fallback_backend: 'openai-speech',
            openai_base_url: '',
            gemini_api_key: 'never-put-secrets-here',
          },
        }),
      })
    );
    expect(invalidFieldsRes.status).toBe(422);
    const invalidJson = (await invalidFieldsRes.json()) as {
      error: { code: string; details: { field_errors: Record<string, string> } };
    };
    expect(invalidJson.error.code).toBe('VALIDATION_ERROR');
    expect(invalidJson.error.details.field_errors.fallback_backend).toMatch(/must differ/);
    expect(invalidJson.error.details.field_errors.openai_base_url).toMatch(/required/);
    expect(invalidJson.error.details.field_errors.gemini_api_key).toMatch(/write-only/);

    // Faulty plugin hooks are isolated while save succeeds.
    const faultyPut = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/faulty-settings-plugin`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ values: { note: 'saved-cleanly' } }),
      })
    );
    expect(faultyPut.status).toBe(200);
    expect(reportedErrors).toContain('faulty-settings-plugin');

    // Server without pluginSettingsStore still lists defaults on GET, returns 503 on PUT.
    const { pluginSettingsStore: _omitted, ...portsWithoutStore } = ports;
    const storelessServer = createKinloomServer({
      siteConfig,
      ports: {
        ...portsWithoutStore,
        plugins: [createPronunciationPlugin()],
      },
      sessionSecret: SESSION_SECRET,
    });
    const storelessGet = await storelessServer.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings`, { headers: { cookie: adminCookie } })
    );
    expect(storelessGet.status).toBe(200);
    const storelessPut = await storelessServer.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ values: { default_voice: 'Kore' } }),
      })
    );
    expect(storelessPut.status).toBe(503);
  });
});
