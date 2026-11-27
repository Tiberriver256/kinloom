import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKinloomConfig } from '@kinloom/core';
import {
  DEFAULT_CONTENT_SECURITY_POLICY,
  FixedClock,
  getSessionCookieName,
  signSessionToken,
} from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
} from '@kinloom/server/testing';
import { Miniflare } from 'miniflare';
import { describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_WEB_ANALYTICS_CONNECT_ORIGIN,
  CLOUDFLARE_WEB_ANALYTICS_PRIVACY_SUMMARY,
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN,
  createCloudflareWorker,
  createWorkersObservabilityPlugin,
  type D1Database,
  type ExecutionContext,
  type Fetcher,
  type KinloomWorkerEnv,
  type R2Bucket,
  renderPrivacyPolicyHtml,
  type SecurityTelemetryLogRecord,
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

  it('keeps security telemetry off by default on Worker and forwards ctx.waitUntil alerts when explicitly enabled', async () => {
    const { mf, env } = await createMiniflareEnv();
    try {
      const siteConfig = createSyntheticSiteConfig();
      const clock = new FixedClock('2026-07-01T09:00:00.000Z');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        // Observability plugin without securityTelemetry emits zero security_event logs.
        const obsDefaultWorker = createCloudflareWorker({
          siteConfig,
          clock,
          plugins: [createWorkersObservabilityPlugin({ clock, sink: () => undefined })],
        });
        const defaultDeniedRes = await obsDefaultWorker.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
            headers: { authorization: 'Bearer kin_worker_invalid_token_111111' },
          }),
          env
        );
        expect(defaultDeniedRes.status).toBe(401);
        expect(warnSpy.mock.calls).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }

      // Opt-in security telemetry with async alertSink wired through ExecutionContext.waitUntil.
      const securityRecords: SecurityTelemetryLogRecord[] = [];
      const alerts: SecurityTelemetryLogRecord[] = [];
      const reportedErrors: Array<{ pluginId: string; message: string }> = [];
      const waitUntilTasks: Promise<unknown>[] = [];
      const fakeCtx: ExecutionContext = {
        waitUntil(promise: Promise<unknown>) {
          waitUntilTasks.push(promise);
        },
        passThroughOnException() {},
      };

      const securityWorker = createCloudflareWorker({
        siteConfig,
        clock,
        onPluginError: (pluginId, error) => {
          reportedErrors.push({
            pluginId,
            message: error instanceof Error ? error.message : String(error),
          });
        },
        plugins: [
          createWorkersObservabilityPlugin({
            clock,
            sink: () => undefined,
            securityTelemetry: {
              enabled: true,
              sink: (record) => {
                securityRecords.push(record);
              },
              alertSink: async (record) => {
                alerts.push(record);
                if (record.event_type === 'csrf.rejected') {
                  throw new Error('worker alert webhook unreachable');
                }
              },
            },
          }),
        ],
      });

      const badBearerRes = await securityWorker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
          headers: {
            authorization: 'Bearer kin_worker_secret_token_987654',
            'cf-ray': 'wrk12345678901ab-ORD',
          },
        }),
        env,
        fakeCtx
      );
      expect(badBearerRes.status).toBe(401);

      const csrfRes = await securityWorker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/logout`, {
          method: 'POST',
          headers: {
            origin: 'https://evil.worker.example.test',
            'cf-ray': 'wrk22345678901ab-ORD',
          },
        }),
        env,
        fakeCtx
      );
      expect(csrfRes.status).toBe(403);
      expect(waitUntilTasks).toHaveLength(2);
      await Promise.all(waitUntilTasks);

      expect(securityRecords).toEqual([
        {
          event: 'security_event',
          event_type: 'auth.agent_token.rejected',
          timestamp: '2026-07-01T09:00:00.000Z',
          level: 'warn',
          request_id: 'wrk12345678901ab-ORD',
          method: 'GET',
          route: '/api/bundle',
          status: 401,
          reason: 'invalid_or_revoked',
        },
        {
          event: 'security_event',
          event_type: 'csrf.rejected',
          timestamp: '2026-07-01T09:00:00.000Z',
          level: 'warn',
          request_id: 'wrk22345678901ab-ORD',
          method: 'POST',
          route: '/api/auth/logout',
          status: 403,
          reason: 'origin_mismatch',
          auth_method: 'none',
        },
      ]);
      expect(alerts).toHaveLength(2);
      expect(reportedErrors).toEqual([
        {
          pluginId: 'kinloom-workers-observability',
          message: 'worker alert webhook unreachable',
        },
      ]);
      expect(JSON.stringify(securityRecords)).not.toContain('kin_worker_secret_token_987654');
      expect(JSON.stringify(securityRecords)).not.toContain('evil.worker.example.test');
    } finally {
      await mf.dispose();
    }
  });

  it('keeps Cloudflare Web Analytics off by default on Worker ASSETS and injects beacon, scoped CSP, and truthful /privacy when enabled', async () => {
    const { mf, env } = await createMiniflareEnv();
    const validToken = '0123456789abcdef0123456789abcdef';
    const expectedBeacon = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${validToken}"}'></script>`;
    const expectedScopedCsp = [
      "default-src 'self'",
      `script-src 'self' ${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://www.openhistoricalmap.org https://*.openhistoricalmap.org",
      `connect-src 'self' https://www.openhistoricalmap.org https://*.openhistoricalmap.org ${CLOUDFLARE_WEB_ANALYTICS_CONNECT_ORIGIN}`,
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self' https://accounts.google.com",
    ].join('; ');
    const spaIndexHtml =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Alder Archive</title></head><body><main id="app"></main></body></html>';

    const fakeAssets: Fetcher = {
      async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
        const req = input instanceof Request ? input : new Request(String(input), init);
        const pathname = new URL(req.url).pathname;
        const headOnly = req.method.toUpperCase() === 'HEAD';
        if (pathname === '/' || pathname === '/index.html') {
          return new Response(headOnly ? null : spaIndexHtml, {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'content-length': String(spaIndexHtml.length),
            },
          });
        }
        if (pathname === '/assets/main.js') {
          return new Response(headOnly ? null : 'export const ready = true;', {
            status: 200,
            headers: { 'content-type': 'text/javascript; charset=utf-8' },
          });
        }
        if (pathname === '/robots.txt') {
          return new Response(headOnly ? null : 'User-agent: *\nDisallow: /\n', {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        return new Response('Not Found', { status: 404 });
      },
    };
    const envWithAssets: KinloomWorkerEnv = {
      ...env,
      ASSETS: fakeAssets,
      CF_WEB_ANALYTICS_TOKEN: validToken,
    };

    try {
      const baseSiteConfig = createSyntheticSiteConfig();
      const siteConfig = parseKinloomConfig({
        ...baseSiteConfig,
        brand: { ...baseSiteConfig.brand, dynamicOg: true },
      });
      const clock = new FixedClock('2026-07-01T09:00:00.000Z');

      // Default OFF (no plugins) and observability plugin without webAnalytics emit zero beacon and default CSP.
      for (const worker of [
        createCloudflareWorker({ siteConfig, clock }),
        createCloudflareWorker({
          siteConfig,
          clock,
          plugins: [createWorkersObservabilityPlugin({ clock, sink: () => undefined })],
        }),
        createCloudflareWorker({
          siteConfig,
          clock,
          plugins: [
            createWorkersObservabilityPlugin({
              clock,
              sink: () => undefined,
              webAnalytics: { enabled: false, token: validToken },
            }),
          ],
        }),
      ]) {
        const defaultHome = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/`), envWithAssets);
        expect(defaultHome.status).toBe(200);
        expect(defaultHome.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
        expect(await defaultHome.text()).toBe(spaIndexHtml);

        const defaultPrivacy = await worker.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/privacy`),
          envWithAssets
        );
        expect(defaultPrivacy.status).toBe(200);
        expect(defaultPrivacy.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
        expect(await defaultPrivacy.text()).toBe(renderPrivacyPolicyHtml(siteConfig));
      }

      // Invalid token fails fast synchronously before any Worker request runs.
      expect(() =>
        createWorkersObservabilityPlugin({
          webAnalytics: { enabled: true, token: '"><script>alert(1)</script>' },
        })
      ).toThrow(RangeError);

      // Opt-in ON state via env.CF_WEB_ANALYTICS_TOKEN.
      const rumWorker = createCloudflareWorker({
        siteConfig,
        clock,
        plugins: [
          createWorkersObservabilityPlugin({
            clock,
            sink: () => undefined,
            webAnalytics: {
              enabled: true,
              token: envWithAssets.CF_WEB_ANALYTICS_TOKEN ?? '',
            },
          }),
        ],
      });

      const homeRes = await rumWorker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/`), envWithAssets);
      expect(homeRes.status).toBe(200);
      expect(homeRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(homeRes.headers.get('content-length')).toBeNull();
      expect(homeRes.headers.get('content-security-policy')).toBe(expectedScopedCsp);
      expect(await homeRes.text()).toContain(`${expectedBeacon}\n</body>`);

      // SPA fallback route served via Cloudflare ASSETS /index.html also injects beacon and scoped CSP.
      const spaFallbackRes = await rumWorker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/people/arthur-alder`),
        envWithAssets
      );
      expect(spaFallbackRes.status).toBe(200);
      expect(spaFallbackRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(spaFallbackRes.headers.get('content-length')).toBeNull();
      expect(spaFallbackRes.headers.get('content-security-policy')).toBe(expectedScopedCsp);
      expect(await spaFallbackRes.text()).toContain(`${expectedBeacon}\n</body>`);

      // /privacy renders truthful Cloudflare Web Analytics disclosure.
      const privacyRes = await rumWorker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/privacy`), envWithAssets);
      expect(privacyRes.status).toBe(200);
      expect(privacyRes.headers.get('content-security-policy')).toBe(expectedScopedCsp);
      const privacyHtml = await privacyRes.text();
      expect(privacyHtml).toContain(CLOUDFLARE_WEB_ANALYTICS_PRIVACY_SUMMARY);
      expect(privacyHtml).not.toContain(
        'This archive embeds zero tracking pixels or behavioral analytics trackers.'
      );
      expect(privacyHtml).toContain(`${expectedBeacon}\n</body>`);

      // Non-HTML endpoints (/api/health, /og/site.svg, /assets/main.js, /robots.txt) remain unmodified.
      const apiHealthRes = await rumWorker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/health`),
        envWithAssets
      );
      expect(apiHealthRes.status).toBe(404);
      expect(apiHealthRes.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
      expect(await apiHealthRes.text()).not.toContain('<script');

      const ogRes = await rumWorker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/og/site.svg`), envWithAssets);
      expect(ogRes.status).toBe(200);
      expect(ogRes.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
      expect(await ogRes.text()).not.toContain('<script');

      const jsRes = await rumWorker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/assets/main.js`),
        envWithAssets
      );
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
      expect(await jsRes.text()).toBe('export const ready = true;');

      const robotsRes = await rumWorker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/robots.txt`),
        envWithAssets
      );
      expect(robotsRes.status).toBe(200);
      expect(robotsRes.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
      expect(await robotsRes.text()).toBe('User-agent: *\nDisallow: /\n');
    } finally {
      await mf.dispose();
    }
  });
});
