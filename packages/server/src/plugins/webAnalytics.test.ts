import { parseKinloomConfig } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import { sha256Hex } from '../crypto.js';
import { createKinloomServer } from '../http/router.js';
import { renderPrivacyPolicyHtml } from '../http/routes/privacyAndOgRoutes.js';
import {
  buildContentSecurityPolicy,
  DEFAULT_CONTENT_SECURITY_POLICY,
  MEDIA_CONTENT_SECURITY_POLICY,
} from '../http/securityHeaders.js';
import { getSessionCookieName, signSessionToken } from '../http/session.js';
import { createSyntheticSiteConfig } from '../testing/adapterContractSuite.js';
import {
  CLOUDFLARE_WEB_ANALYTICS_CONNECT_ORIGIN,
  CLOUDFLARE_WEB_ANALYTICS_PRIVACY_SUMMARY,
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN,
  isCloudflareWebAnalyticsToken,
  isWebAnalyticsEnabled,
  renderCloudflareWebAnalyticsBeaconHtml,
  validateCloudflareWebAnalyticsToken,
} from './webAnalytics.js';
import { createWorkersObservabilityPlugin } from './workersObservability.js';

const ORIGIN = 'https://archive.example.test';
const SECRET = 'kinloom-web-analytics-test-secret-2026-abcdef';
const VALID_TOKEN = '0123456789abcdef0123456789abcdef';
const EXPECTED_BEACON_SCRIPT = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${VALID_TOKEN}"}'></script>`;

const EXPECTED_SCOPED_CSP = [
  "default-src 'self'",
  `script-src 'self' ${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com https://www.openhistoricalmap.org https://*.openhistoricalmap.org",
  `connect-src 'self' https://www.openhistoricalmap.org https://*.openhistoricalmap.org ${CLOUDFLARE_WEB_ANALYTICS_CONNECT_ORIGIN}`,
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self' https://accounts.google.com",
].join('; ');

const SAMPLE_SPA_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Archive</title></head><body><div id="root"></div></body></html>';

const SAMPLE_HEAD_ONLY_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Head Only</title></head></html>';

function createStubAssetHandler() {
  return {
    async fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      const headOnly = request.method.toUpperCase() === 'HEAD';
      if (pathname === '/assets/app.js') {
        return new Response(headOnly ? null : 'console.log("kinloom");', {
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        });
      }
      if (pathname === '/assets/app.css') {
        return new Response(headOnly ? null : 'body { margin: 0; }', {
          status: 200,
          headers: { 'content-type': 'text/css; charset=utf-8' },
        });
      }
      if (pathname === '/robots.txt') {
        return new Response(headOnly ? null : 'User-agent: *\nDisallow: /\n', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      if (pathname === '/head-only') {
        return new Response(headOnly ? null : SAMPLE_HEAD_ONLY_HTML, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(SAMPLE_HEAD_ONLY_HTML.length),
          },
        });
      }
      return new Response(headOnly ? null : SAMPLE_SPA_HTML, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(SAMPLE_SPA_HTML.length),
          'content-encoding': 'gzip',
        },
      });
    },
  };
}

describe('Cloudflare Web Analytics (RUM) optional plugin module', () => {
  it('stays completely off by default with zero beacon scripts, exact default CSP, and unchanged /privacy HTML', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const expectedDefaultPrivacyHtml = renderPrivacyPolicyHtml(siteConfig);

    const configurations = [
      { label: 'no plugins', plugins: [] },
      {
        label: 'observability without webAnalytics',
        plugins: [createWorkersObservabilityPlugin({ sink: () => undefined })],
      },
      {
        label: 'observability with webAnalytics disabled',
        plugins: [
          createWorkersObservabilityPlugin({
            sink: () => undefined,
            webAnalytics: { enabled: false, token: VALID_TOKEN },
          }),
        ],
      },
      {
        label: 'observability top-level disabled',
        plugins: [
          createWorkersObservabilityPlugin({
            enabled: false,
            webAnalytics: { enabled: true, token: 'invalid-not-validated-when-plugin-disabled' },
          }),
        ],
      },
    ];

    for (const cfg of configurations) {
      const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-07-01T00:00:00.000Z' });
      const server = createKinloomServer({
        siteConfig,
        ports: {
          ...ports,
          assetHandler: createStubAssetHandler(),
          plugins: cfg.plugins,
        },
        sessionSecret: SECRET,
      });

      const homeRes = await server.fetch(new Request(`${ORIGIN}/`));
      expect(homeRes.status, cfg.label).toBe(200);
      expect(homeRes.headers.get('content-security-policy'), cfg.label).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
      expect(homeRes.headers.get('content-security-policy'), cfg.label).not.toContain(
        'cloudflareinsights.com'
      );
      const homeHtml = await homeRes.text();
      expect(homeHtml, cfg.label).toBe(SAMPLE_SPA_HTML);
      expect(homeHtml, cfg.label).not.toContain('cloudflareinsights');

      const personRes = await server.fetch(new Request(`${ORIGIN}/people/arthur-alder`));
      expect(personRes.status, cfg.label).toBe(200);
      expect(await personRes.text(), cfg.label).toBe(SAMPLE_SPA_HTML);

      const privacyRes = await server.fetch(new Request(`${ORIGIN}/privacy`));
      expect(privacyRes.status, cfg.label).toBe(200);
      expect(privacyRes.headers.get('content-security-policy'), cfg.label).toBe(
        DEFAULT_CONTENT_SECURITY_POLICY
      );
      const privacyHtml = await privacyRes.text();
      expect(privacyHtml, cfg.label).toBe(expectedDefaultPrivacyHtml);
      expect(privacyHtml, cfg.label).toContain(
        'This archive embeds zero tracking pixels or behavioral analytics trackers.'
      );
      expect(privacyHtml, cfg.label).not.toContain('Cloudflare Web Analytics');
    }
  });

  it('injects the exact beacon, scopes CSP strictly on HTML, updates /privacy truthfully, and leaves non-HTML routes untouched', async () => {
    const baseSiteConfig = createSyntheticSiteConfig();
    const siteConfig = parseKinloomConfig({
      ...baseSiteConfig,
      brand: {
        ...baseSiteConfig.brand,
        dynamicOg: true,
      },
    });
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-07-01T00:00:00.000Z' });
    await ports.repository.upsertUser({
      email: 'archivist@example.test',
      display_name: 'Archive Admin',
      role: 'admin',
      added_at: ports.clock.nowIso(),
      added_by: 'bootstrap',
      last_login_at: null,
    });
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await ports.mediaStore.put({
      key: 'media/portrait.png',
      body: pngBytes.buffer,
      contentType: 'image/png',
      sha256: await sha256Hex(pngBytes),
    });

    const token = await signSessionToken({
      secret: SECRET,
      clock: ports.clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: 'archivist@example.test',
        display_name: 'Archive Admin',
        role: 'admin',
      },
    });
    const adminCookie = `${getSessionCookieName(true)}=${token}`;

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        assetHandler: createStubAssetHandler(),
        plugins: [
          createWorkersObservabilityPlugin({
            sink: () => undefined,
            webAnalytics: {
              enabled: true,
              token: VALID_TOKEN,
            },
          }),
        ],
      },
      sessionSecret: SECRET,
    });

    // Root HTML injects beacon before </body>, strips stale content-length/encoding, and scopes CSP.
    const rootRes = await server.fetch(new Request(`${ORIGIN}/`));
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(rootRes.headers.get('content-length')).toBeNull();
    expect(rootRes.headers.get('content-encoding')).toBeNull();
    expect(rootRes.headers.get('content-security-policy')).toBe(EXPECTED_SCOPED_CSP);
    const rootHtml = await rootRes.text();
    expect(rootHtml).toContain(`${EXPECTED_BEACON_SCRIPT}\n</body>`);

    // SPA route /people/:slug receives the exact same beacon and CSP.
    const personPageRes = await server.fetch(new Request(`${ORIGIN}/people/arthur-alder`));
    expect(personPageRes.status).toBe(200);
    expect(personPageRes.headers.get('content-security-policy')).toBe(EXPECTED_SCOPED_CSP);
    expect(await personPageRes.text()).toContain(`${EXPECTED_BEACON_SCRIPT}\n</body>`);

    // HTML lacking </body> injects before </head>.
    const headOnlyRes = await server.fetch(new Request(`${ORIGIN}/head-only`));
    expect(headOnlyRes.status).toBe(200);
    expect(headOnlyRes.headers.get('content-length')).toBeNull();
    expect(await headOnlyRes.text()).toContain(`${EXPECTED_BEACON_SCRIPT}\n</head>`);

    // HEAD / keeps an empty body while still serving scoped CSP.
    const headRootRes = await server.fetch(new Request(`${ORIGIN}/`, { method: 'HEAD' }));
    expect(headRootRes.status).toBe(200);
    expect(headRootRes.headers.get('content-security-policy')).toBe(EXPECTED_SCOPED_CSP);
    expect(await headRootRes.text()).toBe('');

    // /privacy truthfully discloses cookie-free Cloudflare Web Analytics without self-contradiction.
    const privacyRes = await server.fetch(new Request(`${ORIGIN}/privacy`));
    expect(privacyRes.status).toBe(200);
    expect(privacyRes.headers.get('content-security-policy')).toBe(EXPECTED_SCOPED_CSP);
    const privacyHtml = await privacyRes.text();
    expect(privacyHtml).toContain(CLOUDFLARE_WEB_ANALYTICS_PRIVACY_SUMMARY);
    expect(privacyHtml).toContain('cookie-free Cloudflare Web Analytics');
    expect(privacyHtml).toContain('zero cookies');
    expect(privacyHtml).toContain('zero cross-site tracking');
    expect(privacyHtml).toContain('This archive serves zero advertisements.');
    expect(privacyHtml).not.toContain(
      'This archive embeds zero tracking pixels or behavioral analytics trackers.'
    );
    expect(privacyHtml).toContain(`${EXPECTED_BEACON_SCRIPT}\n</body>`);

    // Non-HTML API responses are NEVER rewritten and stay on the strictest default CSP.
    const bundleRes = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } })
    );
    expect(bundleRes.status).toBe(200);
    expect(bundleRes.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
    expect(await bundleRes.text()).not.toContain('<script');

    const healthRes = await server.fetch(new Request(`${ORIGIN}/api/health`));
    expect(healthRes.status).toBe(404);
    expect(healthRes.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
    expect(await healthRes.text()).not.toContain('<script');

    // Dynamic OG SVG stays unmodified with default CSP.
    const ogRes = await server.fetch(new Request(`${ORIGIN}/og/site.svg`));
    expect(ogRes.status).toBe(200);
    expect(ogRes.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
    expect(await ogRes.text()).not.toContain('<script');

    // Static JS, CSS, and robots.txt are NEVER modified with a <script> tag.
    for (const staticPath of ['/assets/app.js', '/assets/app.css', '/robots.txt']) {
      const staticRes = await server.fetch(new Request(`${ORIGIN}${staticPath}`));
      expect(staticRes.status, staticPath).toBe(200);
      expect(staticRes.headers.get('content-security-policy'), staticPath).toBe(
        DEFAULT_CONTENT_SECURITY_POLICY
      );
      expect(await staticRes.text(), staticPath).not.toContain('<script');
    }

    // Media responses keep strict sandbox CSP and untouched binary bytes.
    const mediaRes = await server.fetch(
      new Request(`${ORIGIN}/media/portrait.png`, { headers: { cookie: adminCookie } })
    );
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers.get('content-security-policy')).toBe(MEDIA_CONTENT_SECURITY_POLICY);
    const mediaBytes = new Uint8Array(await mediaRes.arrayBuffer());
    expect([...mediaBytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('rejects malformed tokens fail-fast at plugin creation and validates CSP origin additions strictly', () => {
    expect(isWebAnalyticsEnabled(undefined)).toBe(false);
    expect(isWebAnalyticsEnabled({ enabled: false })).toBe(false);
    expect(isWebAnalyticsEnabled({ enabled: true, token: VALID_TOKEN })).toBe(true);
    expect(isCloudflareWebAnalyticsToken(VALID_TOKEN)).toBe(true);
    expect(validateCloudflareWebAnalyticsToken(VALID_TOKEN)).toBe(VALID_TOKEN);
    expect(renderCloudflareWebAnalyticsBeaconHtml(VALID_TOKEN)).toBe(EXPECTED_BEACON_SCRIPT);

    const invalidTokens: unknown[] = [
      '',
      '   ',
      '0123456789abcdef0123456789abcde',
      '0123456789abcdef0123456789abcdef0',
      '0123456789ABCDEF0123456789abcdef',
      '0123456789abcdef0123456789abcdeg',
      ` ${VALID_TOKEN}`,
      `${VALID_TOKEN} `,
      '0123456789abcdef\n0123456789abcdef',
      '"><script>alert(1)</script>',
      "' onload='alert(1)",
      '0123456789abcdef"><img src=x>',
      null,
      undefined,
      1234567890,
    ];

    for (const badToken of invalidTokens) {
      expect(isCloudflareWebAnalyticsToken(badToken)).toBe(false);
      expect(() => validateCloudflareWebAnalyticsToken(badToken)).toThrow(RangeError);
      expect(() =>
        createWorkersObservabilityPlugin({
          webAnalytics: {
            enabled: true,
            token: badToken as string,
          },
        })
      ).toThrow(RangeError);
    }

    // CSP builder rejects unsafe directives and non-https origins.
    for (const badOrigin of [
      "'unsafe-inline'",
      "'unsafe-eval'",
      '*',
      'http://static.cloudflareinsights.com',
      'https://*.cloudflareinsights.com',
      'https://static.cloudflareinsights.com/beacon.min.js',
      "https://static.cloudflareinsights.com; script-src 'unsafe-inline'",
    ]) {
      expect(() => buildContentSecurityPolicy({ scriptSrc: [badOrigin] })).toThrow(RangeError);
      expect(() => buildContentSecurityPolicy({ connectSrc: [badOrigin] })).toThrow(RangeError);
    }
  });
});
