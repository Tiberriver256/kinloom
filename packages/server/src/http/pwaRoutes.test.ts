import { type AssetHandler, PUBLIC_PWA_STATIC_ASSET_PATHS, parseKinloomConfig } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import { createKinloomServer } from './router.js';
import { DEFAULT_CONTENT_SECURITY_POLICY } from './securityHeaders.js';

function makePrivateSiteConfig() {
  return parseKinloomConfig({
    schemaVersion: 1,
    site: {
      title: 'Alder Family Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_ARCHIVE',
      description: 'Five generations of the Alder family.',
      footerCredit: 'Built with Kinloom',
    },
    theme: { accent: '#2F5245' },
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
    },
  });
}

describe('unauthenticated private-mode PWA asset serving on createKinloomServer', () => {
  const origin = 'https://archive.example.test';
  const sessionSecret = '0123456789abcdef0123456789abcdef';

  it('serves all 10 PWA/brandkit assets as unauthenticated HTTP 200 with canonical Content-Type and SW headers in private mode', async () => {
    const siteConfig = makePrivateSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);

    // Deliberately return missing or generic Content-Type headers from the backing asset handler
    // to prove the server enforces canonical PWA Content-Type, Service-Worker-Allowed, and Cache-Control.
    const assetHandler: AssetHandler = {
      async fetch(request: Request): Promise<Response> {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/sw.js' && request.headers.get('if-none-match') === '"sw-v1"') {
          return new Response(null, { status: 304, headers: { etag: '"sw-v1"' } });
        }
        if (
          PUBLIC_PWA_STATIC_ASSET_PATHS.includes(pathname as (typeof PUBLIC_PWA_STATIC_ASSET_PATHS)[number])
        ) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        }
        return new Response('Not Found', { status: 404 });
      },
    };
    ports.assetHandler = assetHandler;

    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret,
      mode: 'private',
    });

    const expectedTypes: Record<string, string> = {
      '/site.webmanifest': 'application/manifest+json',
      '/sw.js': 'application/javascript; charset=utf-8',
      '/theme-init.js': 'application/javascript; charset=utf-8',
      '/icon-192.png': 'image/png',
      '/icon-512.png': 'image/png',
      '/icon-maskable-512.png': 'image/png',
      '/apple-touch-icon.png': 'image/png',
      '/favicon.ico': 'image/x-icon',
      '/favicon.svg': 'image/svg+xml; charset=utf-8',
      '/favicon-light.svg': 'image/svg+xml; charset=utf-8',
      '/favicon-dark.svg': 'image/svg+xml; charset=utf-8',
    };

    for (const [assetPath, expectedContentType] of Object.entries(expectedTypes)) {
      const res = await server.fetch(new Request(`${origin}${assetPath}`));
      expect(res.status, `Expected HTTP 200 for unauthenticated ${assetPath}`).toBe(200);
      expect(res.headers.get('content-type')).toBe(expectedContentType);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');

      if (assetPath === '/sw.js') {
        expect(res.headers.get('service-worker-allowed')).toBe('/');
        expect(res.headers.get('cache-control')).toBe('no-cache');
      }

      const headRes = await server.fetch(new Request(`${origin}${assetPath}`, { method: 'HEAD' }));
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get('content-type')).toBe(expectedContentType);
      expect(await headRes.text()).toBe('');
    }

    // Conditional 304 on /sw.js preserves Service-Worker-Allowed and Cache-Control: no-cache.
    const sw304 = await server.fetch(
      new Request(`${origin}/sw.js`, { headers: { 'if-none-match': '"sw-v1"' } })
    );
    expect(sw304.status).toBe(304);
    expect(sw304.headers.get('service-worker-allowed')).toBe('/');
    expect(sw304.headers.get('cache-control')).toBe('no-cache');

    // Private API and /data/* remain strictly 401 UNAUTHORIZED without a session cookie.
    const apiRes = await server.fetch(new Request(`${origin}/api/bundle`));
    expect(apiRes.status).toBe(401);
    const dataRes = await server.fetch(new Request(`${origin}/data/archive.json`));
    expect(dataRes.status).toBe(401);
  });

  it('serves generated manifest, privacy-safe sw.js, and SVG favicons when ASSETS is absent or returns SPA HTML', async () => {
    const siteConfig = makePrivateSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    ports.assetHandler = {
      async fetch(): Promise<Response> {
        return new Response('<!doctype html><html><body>SPA Fallback</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    };

    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret,
      mode: 'private',
    });

    const manifestRes = await server.fetch(new Request(`${origin}/site.webmanifest`));
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get('content-type')).toBe('application/manifest+json');
    const manifest = (await manifestRes.json()) as {
      id: string;
      name: string;
      start_url: string;
      scope: string;
      display: string;
      orientation: string;
      icons: Array<{ src: string; sizes: string; purpose: string }>;
    };
    expect(manifest.id).toBe('/');
    expect(manifest.name).toBe('Alder Family Archive');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('any');
    expect(manifest.icons).toHaveLength(3);

    const swRes = await server.fetch(new Request(`${origin}/sw.js`));
    expect(swRes.status).toBe(200);
    expect(swRes.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(swRes.headers.get('service-worker-allowed')).toBe('/');
    expect(swRes.headers.get('cache-control')).toBe('no-cache');
    const swText = await swRes.text();
    expect(swText).toContain('"/api"');
    expect(swText).toContain('"/media"');
    expect(swText).toContain('"/data"');
    expect(swText).not.toMatch(/\bcaches\.open\b/);

    const themeInitRes = await server.fetch(new Request(`${origin}/theme-init.js`));
    expect(themeInitRes.status).toBe(200);
    expect(themeInitRes.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(themeInitRes.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
    expect(DEFAULT_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(DEFAULT_CONTENT_SECURITY_POLICY).toContain('https://fonts.googleapis.com');
    expect(DEFAULT_CONTENT_SECURITY_POLICY).toContain('https://fonts.gstatic.com');
    const themeInitText = await themeInitRes.text();
    expect(themeInitText).toContain("localStorage.getItem('kinloom-theme')");

    // Verify /api/auth/me exposes private-archive and optional-asset capability flags
    const meRes = await server.fetch(new Request(`${origin}/api/auth/me`));
    expect(meRes.status).toBe(200);
    const meJson = (await meRes.json()) as {
      capabilities: { canReadArchive?: boolean; hasReadings?: boolean; hasMediaChecklist?: boolean };
    };
    expect(meJson.capabilities.canReadArchive).toBe(false);
    expect(meJson.capabilities.hasReadings).toBe(false);
    expect(meJson.capabilities.hasMediaChecklist).toBe(false);

    for (const svgPath of ['/favicon.svg', '/favicon-light.svg', '/favicon-dark.svg']) {
      const svgRes = await server.fetch(new Request(`${origin}${svgPath}`));
      expect(svgRes.status).toBe(200);
      expect(svgRes.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
      expect(await svgRes.text()).toContain('Alder Family Archive icon');
    }

    // Missing raster icons return 404 plain text, never SPA HTML or 401.
    const missingIcon = await server.fetch(new Request(`${origin}/icon-192.png`));
    expect(missingIcon.status).toBe(404);
    expect(missingIcon.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    const missingIconHead = await server.fetch(new Request(`${origin}/icon-192.png`, { method: 'HEAD' }));
    expect(missingIconHead.status).toBe(404);
    expect(await missingIconHead.text()).toBe('');

    // Non-GET/HEAD method on /sw.js falls through to 404.
    const postSw = await server.fetch(new Request(`${origin}/sw.js`, { method: 'POST' }));
    expect(postSw.status).toBe(404);
  });
});
