import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticSiteConfig,
} from '@kinloom/server/testing';
import { describe, expect, it } from 'vitest';
import {
  createCloudflareAssetHandler,
  createCloudflareWorker,
  type Fetcher,
  type KinloomWorkerEnv,
} from './index.js';

describe('Cloudflare Worker standalone PWA assets in private mode', () => {
  it('serves all 10 PWA/brandkit endpoints unauthenticated as HTTP 200 in private mode and generates /site.webmanifest + /sw.js fallbacks when omitted from ASSETS', async () => {
    const siteConfig = createSyntheticSiteConfig();

    // ASSETS contains raster icons and favicon.ico, but omits /site.webmanifest, /sw.js, and SVG favicons
    // (returning Cloudflare SPA HTML fallback for unknown routes).
    const assets: Fetcher = {
      async fetch(input) {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        );
        if (
          url.pathname === '/icon-192.png' ||
          url.pathname === '/icon-512.png' ||
          url.pathname === '/icon-maskable-512.png' ||
          url.pathname === '/apple-touch-icon.png'
        ) {
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        }
        if (url.pathname === '/favicon.ico') {
          return new Response(new Uint8Array([0, 0, 1, 0]), {
            status: 200,
            headers: { 'content-type': 'image/x-icon' },
          });
        }
        return new Response('<!doctype html><html><body>SPA</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    };

    const worker = createCloudflareWorker({ siteConfig });
    const env = {
      ARCHIVE_MODE: 'private',
      SESSION_SECRET: CONTRACT_SESSION_SECRET,
      ASSETS: assets,
    } as KinloomWorkerEnv;

    const checks: Array<[string, string]> = [
      ['/site.webmanifest', 'application/manifest+json'],
      ['/sw.js', 'application/javascript; charset=utf-8'],
      ['/icon-192.png', 'image/png'],
      ['/icon-512.png', 'image/png'],
      ['/icon-maskable-512.png', 'image/png'],
      ['/apple-touch-icon.png', 'image/png'],
      ['/favicon.ico', 'image/x-icon'],
      ['/favicon.svg', 'image/svg+xml; charset=utf-8'],
      ['/favicon-light.svg', 'image/svg+xml; charset=utf-8'],
      ['/favicon-dark.svg', 'image/svg+xml; charset=utf-8'],
    ];

    for (const [pathname, expectedMime] of checks) {
      const res = await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}${pathname}`), env);
      expect(res.status, `Expected 200 for ${pathname}`).toBe(200);
      expect(res.headers.get('content-type')).toBe(expectedMime);
      if (pathname === '/sw.js') {
        expect(res.headers.get('service-worker-allowed')).toBe('/');
        expect(res.headers.get('cache-control')).toBe('no-cache');
        const script = await res.text();
        expect(script).toContain('"/api"');
        expect(script).not.toMatch(/\bcaches\.open\b/);
      }
      if (pathname === '/site.webmanifest') {
        const manifest = (await res.json()) as {
          id: string;
          name: string;
          start_url: string;
          scope: string;
          display: string;
          orientation: string;
        };
        expect(manifest.id).toBe('/');
        expect(manifest.name).toBe(siteConfig.site.title);
        expect(manifest.start_url).toBe('/');
        expect(manifest.scope).toBe('/');
        expect(manifest.display).toBe('standalone');
        expect(manifest.orientation).toBe('any');
      }
    }
  });

  it('serves fallback manifest and sw.js directly from createCloudflareAssetHandler when ASSETS binding is absent', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const handler = createCloudflareAssetHandler(undefined, { siteConfig });

    const manifestRes = await handler.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/site.webmanifest`));
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get('content-type')).toBe('application/manifest+json');
    expect(((await manifestRes.json()) as { name: string }).name).toBe(siteConfig.site.title);

    const swHead = await handler.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/sw.js`, { method: 'HEAD' }));
    expect(swHead.status).toBe(200);
    expect(swHead.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(swHead.headers.get('service-worker-allowed')).toBe('/');
    expect(swHead.headers.get('cache-control')).toBe('no-cache');
    expect(await swHead.text()).toBe('');

    const missingPng = await handler.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/icon-192.png`));
    expect(missingPng.status).toBe(404);
  });
});
