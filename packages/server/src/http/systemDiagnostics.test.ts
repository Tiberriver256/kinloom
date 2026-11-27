import {
  AdminDiagnosticsReportSchema,
  type ArchiveRepository,
  type BundleCache,
  KINLOOM_CORE_VERSION,
  type MediaStore,
} from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { GoogleOAuthProvider } from '../adapters/googleOAuthProvider.js';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import { createWorkersObservabilityPlugin } from '../plugins/workersObservability.js';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';
import { KINLOOM_SERVER_VERSION } from '../version.js';
import { type KinloomServerPlugin, normalizeServerRouteTemplate } from './pluginLifecycle.js';
import { RecentErrorRingBuffer } from './recentErrorBuffer.js';
import { sanitizeDiagnosticDetail } from './redaction.js';
import { createKinloomServer } from './router.js';
import { getSessionCookieName, signSessionToken } from './session.js';

const WEB_ANALYTICS_TOKEN = '0123456789abcdef0123456789abcdef';
const OAUTH_CLIENT_SECRET = 'google_super_secret_oauth_value_999';
const BOOTSTRAP_ADMIN_EMAIL = 'steward.admin@archive.example';

async function makeAdminCookie(
  clock: ReturnType<typeof createInMemoryServerPorts>['clock'],
  role: 'admin' | 'editor' = 'admin',
  email = BOOTSTRAP_ADMIN_EMAIL
): Promise<string> {
  const token = await signSessionToken({
    secret: CONTRACT_SESSION_SECRET,
    clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email,
      display_name: role === 'admin' ? 'Archive Steward' : 'Archive Editor',
      role,
    },
  });
  return `${getSessionCookieName(true)}=${token}`;
}

describe('GET /api/admin/system diagnostics endpoint', () => {
  it('enforces admin-only RBAC and CSRF origin checks and never leaks diagnostics into /api/bundle', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);

    await ports.repository.upsertUser({
      email: BOOTSTRAP_ADMIN_EMAIL,
      display_name: 'Archive Steward',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: ports.clock.nowIso(),
      last_login_at: null,
    });
    await ports.repository.upsertUser({
      email: 'editor.user@archive.example',
      display_name: 'Archive Editor',
      role: 'editor',
      added_by: BOOTSTRAP_ADMIN_EMAIL,
      added_at: ports.clock.nowIso(),
      last_login_at: null,
    });
    await ports.repository.createInvite({
      token: 'inv_readonly_secret_12345',
      label: 'Cousins Link',
      created_by: BOOTSTRAP_ADMIN_EMAIL,
      created_at: ports.clock.nowIso(),
      expires_at: null,
      revoked_at: null,
      uses: 0,
      last_used_at: null,
    });

    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: CONTRACT_SESSION_SECRET,
      bootstrapAdminEmail: BOOTSTRAP_ADMIN_EMAIL,
    });

    const unauthRes = await server.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`));
    expect(unauthRes.status).toBe(401);

    const inviteCookie = `${getSessionCookieName(true)}=${await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock: ports.clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'invite_viewer',
        invite_token: 'inv_readonly_secret_12345',
        label: 'Cousins Link',
      },
    })}`;
    const viewerRes = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`, {
        headers: { cookie: inviteCookie },
      })
    );
    expect(viewerRes.status).toBe(403);

    const editorCookie = await makeAdminCookie(ports.clock, 'editor', 'editor.user@archive.example');
    const editorRes = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`, {
        headers: { cookie: editorCookie },
      })
    );
    expect(editorRes.status).toBe(403);

    const adminCookie = await makeAdminCookie(ports.clock, 'admin', BOOTSTRAP_ADMIN_EMAIL);
    const adminRes = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers.get('cache-control')).toBe('no-store');
    const report = AdminDiagnosticsReportSchema.parse(await adminRes.json());
    expect(report.versions.server_version).toBe(KINLOOM_SERVER_VERSION);
    expect(report.versions.core_version).toBe(KINLOOM_CORE_VERSION);

    const bundleRes = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(bundleRes.status).toBe(200);
    const bundleJson = (await bundleRes.json()) as Record<string, unknown>;
    expect('health_checks' in bundleJson).toBe(false);
    expect('recent_errors' in bundleJson).toBe(false);
    expect('versions' in bundleJson).toBe(false);
  });

  it('strictly redacts secrets, tokens, emails, and living-person names while reporting accurate counts and flags', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);

    const historical = createSyntheticHistoricalPerson({ id: 'per_elias_vance', slug: 'elias-vance' });
    const living = createSyntheticLivingPerson({
      id: 'per_jordan_mercer_living',
      slug: 'jordan-mercer-living',
      full_name: 'Jordan Mercer',
    });

    await ports.repository.commitAtomicMutations({
      batch_id: null,
      author: { author_id: 'system:seed', author_name: 'Seed', author_type: 'system_seed' },
      nowIso: ports.clock.nowIso(),
      operations: [
        {
          entity_type: 'person',
          entity_id: historical.id,
          slug: historical.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed historical person',
          has_primary_source: true,
          before_json: null,
          after_json: { ...historical },
        },
        {
          entity_type: 'person',
          entity_id: living.id,
          slug: living.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed living person',
          has_primary_source: true,
          before_json: null,
          after_json: { ...living },
        },
      ],
    });
    const snap = await ports.repository.loadActiveSnapshot();
    await ports.bundleCache.rebuildAndStore(snap);

    const googleAuthProvider = new GoogleOAuthProvider({
      clientId: 'google-client-id-123',
      clientSecret: OAUTH_CLIENT_SECRET,
    });
    await ports.repository.upsertUser({
      email: BOOTSTRAP_ADMIN_EMAIL,
      display_name: 'Archive Steward',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: ports.clock.nowIso(),
      last_login_at: null,
    });
    const inviteToken = 'inv_secret_family_link_999';
    await ports.repository.createInvite({
      token: inviteToken,
      label: 'Family Invite',
      created_by: BOOTSTRAP_ADMIN_EMAIL,
      created_at: ports.clock.nowIso(),
      expires_at: null,
      revoked_at: null,
      uses: 0,
      last_used_at: null,
    });

    const obsPlugin = createWorkersObservabilityPlugin({
      sink: () => {},
      clock: ports.clock,
      emitServerTiming: true,
      securityTelemetry: { enabled: true, sink: () => {} },
      webAnalytics: { enabled: true, token: WEB_ANALYTICS_TOKEN },
    });
    const noisyDetailPlugin: KinloomServerPlugin = {
      id: 'noisy-detail-plugin',
      name: 'Noisy Detail Plugin',
      version: '1.2.3',
      getStatus: () => ({
        status: 'active',
        detail: `Synced by ${BOOTSTRAP_ADMIN_EMAIL} with Bearer tok_secret_abcdefgh12345 and ?token=mysecret`,
      }),
    };

    const server = createKinloomServer({
      siteConfig,
      ports: { ...ports, authProvider: googleAuthProvider, plugins: [obsPlugin, noisyDetailPlugin] },
      sessionSecret: CONTRACT_SESSION_SECRET,
      bootstrapAdminEmail: BOOTSTRAP_ADMIN_EMAIL,
      diagnostics: {
        buildCommitSha: 'abcdef123456',
        buildTimestamp: '2026-11-27T10:00:00Z',
        schemaMigrationLevel: '0003_pronunciation_provenance.sql',
        readOnlyDemo: false,
      },
    });

    const adminCookie = await makeAdminCookie(ports.clock, 'admin', BOOTSTRAP_ADMIN_EMAIL);

    // Trigger errors containing sensitive path segments and query parameters to verify ring-buffer redaction.
    const errRes1 = await server.fetch(
      new Request(
        `${CONTRACT_TEST_ORIGIN}/api/entities/person/per_jordan_mercer_living?token=supersecret&email=${BOOTSTRAP_ADMIN_EMAIL}`,
        { headers: { cookie: adminCookie } }
      )
    );
    expect(errRes1.status).toBe(200);
    const errRes2 = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/per_missing_living_slug?secret=topsecret123`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(errRes2.status).toBe(404);

    const sysRes = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(sysRes.status).toBe(200);
    const rawText = await sysRes.text();

    // Zero secrets, tokens, emails, or living-person names/slugs anywhere in the payload.
    for (const forbidden of [
      CONTRACT_SESSION_SECRET,
      OAUTH_CLIENT_SECRET,
      WEB_ANALYTICS_TOKEN,
      BOOTSTRAP_ADMIN_EMAIL,
      inviteToken,
      'Jordan Mercer',
      'jordan-mercer-living',
      'per_jordan_mercer_living',
      'per_missing_living_slug',
      'topsecret123',
      'tok_secret_abcdefgh12345',
      'mysecret',
    ]) {
      expect(rawText).not.toContain(forbidden);
    }

    const report = AdminDiagnosticsReportSchema.parse(JSON.parse(rawText));
    expect(report.versions).toEqual({
      core_version: KINLOOM_CORE_VERSION,
      server_version: KINLOOM_SERVER_VERSION,
      worker_version: null,
      build_commit_sha: 'abcdef123456',
      build_timestamp: '2026-11-27T10:00:00Z',
      schema_migration_level: '0003_pronunciation_provenance.sql',
    });
    expect(report.runtime.platform).toBe('node');
    expect(report.runtime.adapters).toMatchObject({
      repository: 'in-memory',
      bundle_cache: 'in-memory',
      media_store: 'in-memory',
      email_sender: 'in-memory',
      auth_provider_configured: true,
      auth_provider_id: 'google',
      pronunciation_generator: 'none',
      pronunciation_lexicon_store: 'in-memory',
    });
    expect(report.config.observability).toEqual({
      enabled: true,
      server_timing: true,
      security_telemetry: true,
      web_analytics: true,
    });
    expect(report.archive.counts).toMatchObject({
      people_deceased: 1,
      people_living: 1,
    });
    expect(report.archive.bundle_cache_status).toBe('hit');
    expect(report.health_checks.map((c) => [c.name, c.status])).toEqual([
      ['repository', 'pass'],
      ['bundle_cache', 'pass'],
      ['media_store', 'pass'],
    ]);
    expect(report.plugins).toEqual([
      expect.objectContaining({
        id: 'kinloom-workers-observability',
        version: KINLOOM_SERVER_VERSION,
        status: 'active',
        surface: 'server',
      }),
      expect.objectContaining({
        id: 'noisy-detail-plugin',
        version: '1.2.3',
        status: 'active',
        detail: 'Synced by [REDACTED_EMAIL] with Bearer [REDACTED] and ?token=[REDACTED]',
      }),
    ]);
    expect(report.recent_errors).toEqual([
      {
        timestamp: ports.clock.nowIso(),
        route: '/api/entities/:type/:id',
        status: 404,
        error_code: 'NOT_FOUND',
      },
    ]);
  });

  it('fault-isolates throwing plugin getStatus() probes, disabled plugins, and failing storage health checks', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    await ports.repository.upsertUser({
      email: BOOTSTRAP_ADMIN_EMAIL,
      display_name: 'Archive Steward',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: ports.clock.nowIso(),
      last_login_at: null,
    });

    const pluginErrors: string[] = [];
    const disabledObs = createWorkersObservabilityPlugin({ enabled: false });
    const throwingPlugin: KinloomServerPlugin = {
      id: 'flaky-probe-plugin',
      name: 'Flaky Probe Plugin',
      version: '2.0.0',
      getStatus: async () => {
        throw new Error('database password leaked: secret123');
      },
    };
    const minimalPlugin: KinloomServerPlugin = {
      id: 'minimal-unversioned',
      name: 'Minimal Plugin',
    };

    const failingRepository: ArchiveRepository = {
      ...ports.repository,
      loadActiveSnapshot: async () => {
        throw new Error('D1 unavailable');
      },
    };
    const failingBundleCache: BundleCache = {
      adapterKind: 'in-memory',
      getCached: async () => {
        throw new Error('R2 timeout');
      },
      rebuildAndStore: (snapshot) => ports.bundleCache.rebuildAndStore(snapshot),
    };
    const failingMediaStore: MediaStore = {
      adapterKind: 'in-memory',
      head: async () => {
        throw new Error('R2 head failure');
      },
      put: (params) => ports.mediaStore.put(params),
      get: (key, options) => ports.mediaStore.get(key, options),
    };

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        repository: failingRepository,
        bundleCache: failingBundleCache,
        mediaStore: failingMediaStore,
        plugins: [disabledObs, throwingPlugin, minimalPlugin],
      },
      sessionSecret: CONTRACT_SESSION_SECRET,
      bootstrapAdminEmail: BOOTSTRAP_ADMIN_EMAIL,
      onPluginError: (pluginId) => {
        pluginErrors.push(pluginId);
      },
      diagnostics: {
        getSchemaMigrationLevel: async () => {
          throw new Error('migration query failed');
        },
        schemaMigrationLevel: 'fallback-v1',
      },
    });

    const adminCookie = await makeAdminCookie(ports.clock, 'admin', BOOTSTRAP_ADMIN_EMAIL);
    const res = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/system`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(res.status).toBe(200);
    const report = AdminDiagnosticsReportSchema.parse(await res.json());

    expect(pluginErrors).toEqual(['flaky-probe-plugin']);
    expect(report.versions.schema_migration_level).toBe('fallback-v1');
    expect(report.config.observability.enabled).toBe(false);
    expect(report.archive.bundle_cache_status).toBe('error');
    expect(report.health_checks).toEqual([
      expect.objectContaining({ name: 'repository', status: 'fail', detail: 'Repository probe failed' }),
      expect.objectContaining({ name: 'bundle_cache', status: 'fail', detail: 'Bundle cache probe failed' }),
      expect.objectContaining({ name: 'media_store', status: 'fail', detail: 'Media store probe failed' }),
    ]);
    expect(report.plugins).toEqual([
      expect.objectContaining({
        id: 'kinloom-workers-observability',
        version: KINLOOM_SERVER_VERSION,
        status: 'disabled',
      }),
      expect.objectContaining({
        id: 'flaky-probe-plugin',
        version: '2.0.0',
        status: 'degraded',
        detail: 'Status probe threw an error',
      }),
      expect.objectContaining({
        id: 'minimal-unversioned',
        version: 'unversioned',
        status: 'active',
        detail: null,
      }),
    ]);
  });

  it('bounds RecentErrorRingBuffer capacity, redacts route/code fields, and normalizes /api/admin/system', () => {
    expect(normalizeServerRouteTemplate('/api/admin/system')).toBe('/api/admin/system');
    expect(sanitizeDiagnosticDetail('   ')).toBeNull();
    expect(sanitizeDiagnosticDetail('a'.repeat(20), 10)).toBe('aaaaaaaaa…');

    const zeroBuf = new RecentErrorRingBuffer(0);
    zeroBuf.record({
      timestamp: '2026-11-27T00:00:00Z',
      route: '/api/bundle',
      status: 500,
      errorCode: 'ERR',
    });
    expect(zeroBuf.snapshot()).toEqual([]);

    const buf = new RecentErrorRingBuffer(2);
    buf.record({ timestamp: '2026-11-27T00:00:00Z', route: '/api/bundle', status: 200, errorCode: 'OK' });
    buf.record({
      timestamp: '2026-11-27T00:00:01Z',
      route: 'api/users/jane@example.com?token=abc',
      status: 404,
      errorCode: 'bad code!',
    });
    buf.record({
      timestamp: '2026-11-27T00:00:02Z',
      route: '/api/entities/:type/:id',
      status: 409,
      errorCode: 'CONFLICT',
    });
    buf.record({
      timestamp: '2026-11-27T00:00:03Z',
      route: '/api/admin/system',
      status: 503,
      errorCode: 'SERVICE_UNAVAILABLE',
    });

    expect(buf.snapshot()).toEqual([
      {
        timestamp: '2026-11-27T00:00:03Z',
        route: '/api/admin/system',
        status: 503,
        error_code: 'SERVICE_UNAVAILABLE',
      },
      {
        timestamp: '2026-11-27T00:00:02Z',
        route: '/api/entities/:type/:id',
        status: 409,
        error_code: 'CONFLICT',
      },
    ]);

    buf.clear();
    expect(buf.snapshot()).toEqual([]);
  });
});
