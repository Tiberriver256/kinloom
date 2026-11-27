import { describe, expect, it, vi } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import type { FixedClock } from '../adapters/systemClock.js';
import {
  hasRequestLifecyclePlugins,
  type KinloomServerPlugin,
  normalizeServerRouteTemplate,
} from '../http/pluginLifecycle.js';
import { createKinloomServer } from '../http/router.js';
import { getSessionCookieName, signSessionToken } from '../http/session.js';
import {
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';
import {
  createWorkersObservabilityPlugin,
  formatServerTimingHeader,
  redactObservabilityText,
  sanitizeObservabilityErrorCode,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
  type WorkersObservabilityLogRecord,
} from './workersObservability.js';

const ORIGIN = 'https://alder.example.test';
const SECRET = 'kinloom-observability-test-secret-2026-abcdef';

async function createAdminCookie(clock: FixedClock, email = 'archivist@example.test'): Promise<string> {
  const token = await signSessionToken({
    secret: SECRET,
    clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email,
      display_name: 'Archive Admin',
      role: 'admin',
    },
  });
  return `${getSessionCookieName(true)}=${token}`;
}

describe('Workers Observability plugin and lifecycle seam', () => {
  it('stays completely off by default with zero X-Request-Id, Server-Timing, or console telemetry logs', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const clock = ports.clock;
    await ports.repository.upsertUser({
      email: 'archivist@example.test',
      display_name: 'Archive Admin',
      role: 'admin',
      added_at: clock.nowIso(),
      added_by: 'bootstrap',
      last_login_at: null,
    });
    const adminCookie = await createAdminCookie(clock);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const server = createKinloomServer({
        siteConfig,
        ports,
        sessionSecret: SECRET,
      });

      const meRes = await server.fetch(
        new Request(`${ORIGIN}/api/auth/me`, {
          headers: { 'cf-ray': '8f1a2b3c4d5e6f7a-ORD', cookie: adminCookie },
        })
      );
      expect(meRes.status).toBe(200);
      expect(meRes.headers.get('x-request-id')).toBeNull();
      expect(meRes.headers.get('server-timing')).toBeNull();

      const bundleRes = await server.fetch(
        new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } })
      );
      expect(bundleRes.status).toBe(200);
      expect(bundleRes.headers.get('x-request-id')).toBeNull();
      expect(bundleRes.headers.get('server-timing')).toBeNull();

      const notFoundRes = await server.fetch(new Request(`${ORIGIN}/api/does-not-exist`));
      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.headers.get('x-request-id')).toBeNull();
      expect(notFoundRes.headers.get('server-timing')).toBeNull();

      expect(logSpy.mock.calls).toHaveLength(0);
      expect(errorSpy.mock.calls).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('acts as a complete no-op when created with { enabled: false }', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const records: WorkersObservabilityLogRecord[] = [];

    const disabledPlugin = createWorkersObservabilityPlugin({
      enabled: false,
      sink: (record) => {
        records.push(record);
      },
    });
    expect(disabledPlugin.id).toBe(WORKERS_OBSERVABILITY_PLUGIN_ID);
    expect(hasRequestLifecyclePlugins([disabledPlugin])).toBe(false);

    const server = createKinloomServer({
      siteConfig,
      ports: { ...ports, plugins: [disabledPlugin] },
      sessionSecret: SECRET,
    });

    const res = await server.fetch(
      new Request(`${ORIGIN}/api/auth/me`, {
        headers: { 'cf-ray': '8f1a2b3c4d5e6f7a-ORD' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeNull();
    expect(res.headers.get('server-timing')).toBeNull();
    expect(records).toEqual([]);
  });

  it('propagates safe X-Request-Id or cf-ray, falls back to generated UUID, and respects header flags', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const clock = ports.clock;
    const records: WorkersObservabilityLogRecord[] = [];
    let tick = 1000;
    let uuidSeq = 0;

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [
          createWorkersObservabilityPlugin({
            clock,
            now: () => {
              tick += 12.5;
              return tick;
            },
            generateRequestId: () => {
              uuidSeq += 1;
              return `00000000-0000-4000-8000-00000000000${uuidSeq}`;
            },
            sink: (record) => {
              records.push(record);
            },
          }),
        ],
      },
      sessionSecret: SECRET,
    });

    const withCfRay = await server.fetch(
      new Request(`${ORIGIN}/api/auth/me`, {
        headers: { 'cf-ray': '8f1a2b3c4d5e6f7a-ORD' },
      })
    );
    expect(withCfRay.status).toBe(200);
    expect(withCfRay.headers.get('x-request-id')).toBe('8f1a2b3c4d5e6f7a-ORD');
    expect(withCfRay.headers.get('server-timing')).toBe('total;dur=12.5');

    const withIncomingId = await server.fetch(
      new Request(`${ORIGIN}/api/auth/me`, {
        headers: {
          'x-request-id': 'trace-abc_123:45',
          'cf-ray': '8f1a2b3c4d5e6f7a-ORD',
        },
      })
    );
    expect(withIncomingId.headers.get('x-request-id')).toBe('trace-abc_123:45');

    // Unsafe x-request-id containing an email or token prefix is rejected in favor of cf-ray or UUID.
    const withEmailRequestId = await server.fetch(
      new Request(`${ORIGIN}/api/auth/me`, {
        headers: {
          'x-request-id': 'private.person@example.test',
          'cf-ray': '9a2b3c4d5e6f7081-IAD',
        },
      })
    );
    expect(withEmailRequestId.headers.get('x-request-id')).toBe('9a2b3c4d5e6f7081-IAD');

    const withTokenPrefixRequestId = await server.fetch(
      new Request(`${ORIGIN}/api/auth/me`, {
        headers: { 'x-request-id': 'kin_secret_agent_token_123456' },
      })
    );
    expect(withTokenPrefixRequestId.headers.get('x-request-id')).toBe('00000000-0000-4000-8000-000000000001');

    expect(records.map((r) => r.request_id)).toEqual([
      '8f1a2b3c4d5e6f7a-ORD',
      'trace-abc_123:45',
      '9a2b3c4d5e6f7081-IAD',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(records[0]).toMatchObject({
      event: 'http_request',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'info',
      method: 'GET',
      route: '/api/auth/me',
      status: 200,
      duration_ms: 12.5,
      cache_status: null,
      bundle_revision: null,
      error_code: null,
    });

    // Disabled response headers still log records cleanly.
    const silentHeaderRecords: WorkersObservabilityLogRecord[] = [];
    const noHeaderServer = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [
          createWorkersObservabilityPlugin({
            emitServerTiming: false,
            includeRequestIdHeader: false,
            generateRequestId: () => 'req-silent-1',
            sink: (record) => {
              silentHeaderRecords.push(record);
            },
          }),
        ],
      },
      sessionSecret: SECRET,
    });
    const silentRes = await noHeaderServer.fetch(new Request(`${ORIGIN}/api/auth/me`));
    expect(silentRes.headers.get('x-request-id')).toBeNull();
    expect(silentRes.headers.get('server-timing')).toBeNull();
    expect(silentHeaderRecords).toHaveLength(1);
    expect(silentHeaderRecords[0]?.request_id).toBe('req-silent-1');
  });

  it('emits valid RFC Server-Timing and cache/revision metadata on bundle, data, media, and non-API routes', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const clock = ports.clock;
    await ports.repository.upsertUser({
      email: 'archivist@example.test',
      display_name: 'Archive Admin',
      role: 'admin',
      added_at: clock.nowIso(),
      added_by: 'bootstrap',
      last_login_at: null,
    });
    const adminCookie = await createAdminCookie(clock);
    const records: WorkersObservabilityLogRecord[] = [];

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        assetHandler: {
          async fetch(req: Request): Promise<Response> {
            const pathname = new URL(req.url).pathname;
            if (pathname === '/data/bundle.json') {
              return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
            return new Response('not found', { status: 404 });
          },
        },
        plugins: [
          createWorkersObservabilityPlugin({
            clock,
            sink: (record) => {
              records.push(record);
            },
          }),
        ],
      },
      sessionSecret: SECRET,
    });

    // Create an entity so head revision advances to 1.
    const arthur = createSyntheticHistoricalPerson();
    const createRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          entity_id: arthur.id,
          data: arthur,
          summary: 'Create Arthur Alder record',
          has_primary_source: true,
        }),
      })
    );
    expect(createRes.status).toBe(201);
    expect(createRes.headers.get('server-timing')).toMatch(/^d1;dur=\d+(?:\.\d+)?, total;dur=\d+(?:\.\d+)?$/);
    expect(records[0]).toMatchObject({
      route: '/api/entities/:type',
      status: 201,
      bundle_revision: 1,
    });

    // GET /api/bundle -> hit at revision 1 with d1, r2, bundle, total Server-Timing spans.
    const bundleHitRes = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } })
    );
    expect(bundleHitRes.status).toBe(200);
    const etag = bundleHitRes.headers.get('etag') ?? '';
    expect(bundleHitRes.headers.get('server-timing')).toMatch(
      /^d1;dur=\d+(?:\.\d+)?, r2;dur=\d+(?:\.\d+)?, bundle;dur=\d+(?:\.\d+)?, total;dur=\d+(?:\.\d+)?$/
    );
    expect(records[1]).toMatchObject({
      route: '/api/bundle',
      status: 200,
      cache_status: 'hit',
      bundle_revision: 1,
    });

    // Conditional GET /api/bundle -> 304 not_modified.
    const bundle304Res = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, {
        headers: { cookie: adminCookie, 'if-none-match': etag },
      })
    );
    expect(bundle304Res.status).toBe(304);
    expect(records[2]).toMatchObject({
      route: '/api/bundle',
      status: 304,
      cache_status: 'not_modified',
      bundle_revision: 1,
    });

    // Static /data/bundle.json -> emits Server-Timing with bundle & total.
    const dataBundleRes = await server.fetch(
      new Request(`${ORIGIN}/data/bundle.json`, { headers: { cookie: adminCookie } })
    );
    expect(dataBundleRes.status).toBe(200);
    expect(dataBundleRes.headers.get('server-timing')).toMatch(
      /bundle;dur=\d+(?:\.\d+)?, total;dur=\d+(?:\.\d+)?$/
    );
    expect(records[3]).toMatchObject({
      route: '/data/bundle.json',
      status: 200,
      cache_status: 'hit',
    });

    // Public HTML /privacy -> emits X-Request-Id, omits Server-Timing.
    const privacyRes = await server.fetch(new Request(`${ORIGIN}/privacy`));
    expect(privacyRes.status).toBe(200);
    expect(privacyRes.headers.get('x-request-id')).toMatch(/.+/);
    expect(privacyRes.headers.get('server-timing')).toBeNull();
    expect(records[4]).toMatchObject({
      route: '/privacy',
      status: 200,
    });
  });

  it('logs 2xx/4xx/5xx via default console sink and strictly redacts emails, tokens, cookies, query secrets, and living-person slugs', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const clock = ports.clock;
    const living = createSyntheticLivingPerson({
      id: 'per_living_clara_99',
      slug: 'clara-living-alder',
      full_name: 'Clara Living Alder',
    });

    const crashingPlugin: KinloomServerPlugin = {
      id: 'crashing-route-plugin',
      name: 'Crashing Route Plugin',
      routes: [
        {
          method: 'GET',
          pathPrefix: '/api/custom-boom',
          minRole: 'public',
          async handle() {
            throw new Error(
              'Sensitive failure for clara.alder@example.test Bearer kin_super_secret_987654321'
            );
          },
        },
      ],
    };

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const server = createKinloomServer({
        siteConfig,
        ports: {
          ...ports,
          plugins: [crashingPlugin, createWorkersObservabilityPlugin({ clock })],
        },
        sessionSecret: SECRET,
      });

      // 401 on admin user email route with bearer token + cookie + query secret.
      const adminEmailRes = await server.fetch(
        new Request(
          `${ORIGIN}/api/admin/users/clara.alder@example.test?token=ml_secret_token_42&email=clara.alder@example.test`,
          {
            method: 'DELETE',
            headers: {
              origin: ORIGIN,
              authorization: 'Bearer kin_agent_secret_token_999999',
              cookie: '__Host-kinloom_session=sess_cookie_secret_999999',
            },
          }
        )
      );
      expect(adminEmailRes.status).toBe(401);

      // 401 on living entity path.
      const livingEntityRes = await server.fetch(new Request(`${ORIGIN}/api/entities/person/${living.id}`));
      expect(livingEntityRes.status).toBe(401);

      // 400 on magic-link verify with query token.
      const magicVerifyRes = await server.fetch(
        new Request(
          `${ORIGIN}/api/auth/magic-link/verify?token=ml_one_time_secret_777&next=/people/${living.slug}`
        )
      );
      expect(magicVerifyRes.status).toBe(400);

      // 404 on invite redemption with secret token in path.
      const inviteRes = await server.fetch(new Request(`${ORIGIN}/invite/inv_secret_token_555`));
      expect(inviteRes.status).toBe(404);

      // 404 on living-person slug path.
      const livingSlugRes = await server.fetch(new Request(`${ORIGIN}/people/${living.slug}`));
      expect(livingSlugRes.status).toBe(404);

      // 500 internal error from crashing plugin route.
      const boomRes = await server.fetch(
        new Request(`${ORIGIN}/api/custom-boom/${living.slug}?secret=top_secret_value`)
      );
      expect(boomRes.status).toBe(500);

      const infoWarnLines = logSpy.mock.calls.map((args) => String(args[0]));
      const errorLines = errorSpy.mock.calls.map((args) => String(args[0]));
      expect(infoWarnLines).toHaveLength(5);
      expect(errorLines).toHaveLength(1);

      const parsedWarn = infoWarnLines.map((line) => JSON.parse(line) as WorkersObservabilityLogRecord);
      const parsedError = JSON.parse(errorLines[0] ?? '{}') as WorkersObservabilityLogRecord;

      expect(parsedWarn.map((r) => r.route)).toEqual([
        '/api/admin/users/:email',
        '/api/entities/:type/:id',
        '/api/auth/magic-link/verify',
        '/invite/:token',
        '/people/:slug',
      ]);
      expect(parsedWarn.map((r) => r.level)).toEqual(['warn', 'warn', 'warn', 'warn', 'warn']);
      expect(parsedError).toMatchObject({
        event: 'http_request',
        level: 'error',
        route: '/api/custom-boom/*',
        status: 500,
        error_code: 'INTERNAL_ERROR',
      });

      const allEmittedText = [...infoWarnLines, ...errorLines].join('\n');
      for (const secret of [
        'clara.alder@example.test',
        'kin_agent_secret_token_999999',
        'kin_super_secret_987654321',
        'sess_cookie_secret_999999',
        'ml_secret_token_42',
        'ml_one_time_secret_777',
        'inv_secret_token_555',
        'per_living_clara_99',
        'clara-living-alder',
        'top_secret_value',
      ]) {
        expect(allEmittedText).not.toContain(secret);
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('fault-isolates synchronous and asynchronous errors thrown by sinks, lifecycle hooks, and error reporters', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const reportedErrors: Array<{ pluginId: string; message: string }> = [];

    const syncThrowingSinkPlugin = createWorkersObservabilityPlugin({
      sink: () => {
        throw new Error('sync sink explosion');
      },
    });
    const asyncThrowingHookPlugin: KinloomServerPlugin = {
      id: 'async-faulty-lifecycle',
      name: 'Async Faulty Lifecycle',
      async onRequestStart() {
        throw new Error('async start explosion');
      },
      async onResponse() {
        throw new Error('async response explosion');
      },
      async onError() {
        throw new Error('async error hook explosion');
      },
    };

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [asyncThrowingHookPlugin, syncThrowingSinkPlugin],
      },
      sessionSecret: SECRET,
      onPluginError: (pluginId, err) => {
        reportedErrors.push({
          pluginId,
          message: err instanceof Error ? err.message : String(err),
        });
      },
    });

    const okRes = await server.fetch(new Request(`${ORIGIN}/api/auth/me`));
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as {
      session: { authenticated: boolean; principal_kind: string };
    };
    expect(okBody.session).toEqual({ authenticated: false, principal_kind: 'anonymous' });
    expect(okRes.headers.get('x-request-id')).toMatch(/.+/);
    expect(reportedErrors).toEqual([
      { pluginId: 'async-faulty-lifecycle', message: 'async start explosion' },
      { pluginId: 'async-faulty-lifecycle', message: 'async response explosion' },
      { pluginId: WORKERS_OBSERVABILITY_PLUGIN_ID, message: 'sync sink explosion' },
    ]);

    // Even when onPluginError itself throws, 404 responses still return intact.
    const serverWithThrowingReporter = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [
          asyncThrowingHookPlugin,
          createWorkersObservabilityPlugin({
            sink: async () => {
              throw new Error('async sink explosion');
            },
          }),
        ],
      },
      sessionSecret: SECRET,
      onPluginError: () => {
        throw new Error('reporter failure');
      },
    });

    const errRes = await serverWithThrowingReporter.fetch(new Request(`${ORIGIN}/api/unknown-route`));
    expect(errRes.status).toBe(404);
    const errBody = (await errRes.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe('NOT_FOUND');
  });

  it('normalizes routes, formats Server-Timing headers, and redacts sensitive strings cleanly', () => {
    expect(normalizeServerRouteTemplate('/api/entities/person/per_living_1')).toBe('/api/entities/:type/:id');
    expect(normalizeServerRouteTemplate('/api/entities/person/per_1/restore')).toBe(
      '/api/entities/:type/:id/restore'
    );
    expect(normalizeServerRouteTemplate('/api/media/med_123')).toBe('/api/media/:id');
    expect(normalizeServerRouteTemplate('/api/talk/person/per_1/99')).toBe('/api/talk/:type/:id/:commentId');
    expect(normalizeServerRouteTemplate('/og/person/clara-alder.svg')).toBe('/og/person/:id.svg');
    expect(normalizeServerRouteTemplate('/data/bundle.json')).toBe('/data/bundle.json');
    expect(normalizeServerRouteTemplate('/data/custom.json')).toBe('/data/:file');
    expect(normalizeServerRouteTemplate('/media/abc123.mp4')).toBe('/media/:key');

    expect(
      formatServerTimingHeader({
        total: 25.456,
        bundle: 12.1,
        r2: 8,
        d1: 4.004,
      })
    ).toBe('d1;dur=4, r2;dur=8, bundle;dur=12.1, total;dur=25.46');

    expect(
      redactObservabilityText(
        'GET /api/auth/magic-link/verify?token=abc123&email=user@example.test Bearer tok_999999999 __Host-kinloom_session=xyz'
      )
    ).toBe(
      'GET /api/auth/magic-link/verify?token=[REDACTED]&email=[REDACTED] Bearer [REDACTED] [REDACTED_COOKIE]'
    );

    expect(sanitizeObservabilityErrorCode('OPTIMISTIC_CONFLICT')).toBe('OPTIMISTIC_CONFLICT');
    expect(sanitizeObservabilityErrorCode('Failed for alice@example.test')).toBe('INTERNAL_ERROR');
    expect(sanitizeObservabilityErrorCode(null)).toBeNull();
  });
});
