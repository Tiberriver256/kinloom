import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  getPublicPwaAssetSpec,
  joinPwaBasePath,
  normalizePwaBaseUrl,
  PUBLIC_PWA_STATIC_ASSET_PATHS,
  PWA_NEVER_CACHE_PATH_PREFIXES,
  renderPrivacySafeServiceWorkerScript,
} from './pwa.js';

interface MockFetchEvent {
  request: {
    url: string;
    method: string;
    mode: string;
  };
  respondWith: ReturnType<typeof vi.fn>;
}

function createSwSandbox(script: string, fetchImpl: (req: unknown) => Promise<Response>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const skipWaiting = vi.fn();
  const claim = vi.fn(() => Promise.resolve());
  const forbiddenCaches = {
    open: vi.fn(() => {
      throw new Error('Privacy violation: Service Worker must never open Cache Storage');
    }),
  };

  const selfObj = {
    location: { origin: 'https://archive.example.test' },
    skipWaiting,
    clients: { claim },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler);
    },
  };

  vm.runInNewContext(script, {
    self: selfObj,
    fetch: fetchImpl,
    caches: forbiddenCaches,
    URL,
    Response,
  });

  return { listeners, skipWaiting, claim, forbiddenCaches };
}

describe('standalone PWA primitives and privacy-safe service worker', () => {
  it('normalizes root and subpath baseUrls and joins asset paths cleanly', () => {
    expect(normalizePwaBaseUrl()).toBe('/');
    expect(normalizePwaBaseUrl('')).toBe('/');
    expect(normalizePwaBaseUrl('   ')).toBe('/');
    expect(normalizePwaBaseUrl('///')).toBe('/');
    expect(normalizePwaBaseUrl('/kinloom')).toBe('/kinloom/');
    expect(normalizePwaBaseUrl('/kinloom/')).toBe('/kinloom/');
    expect(normalizePwaBaseUrl('org/kinloom')).toBe('/org/kinloom/');

    expect(joinPwaBasePath('/', '/icon-192.png')).toBe('/icon-192.png');
    expect(joinPwaBasePath('/kinloom', '/icon-192.png')).toBe('/kinloom/icon-192.png');
    expect(joinPwaBasePath('/kinloom/', 'site.webmanifest')).toBe('/kinloom/site.webmanifest');
  });

  it('defines canonical MIME types and headers for all 10 public PWA assets and rejects non-PWA paths', () => {
    expect(PUBLIC_PWA_STATIC_ASSET_PATHS).toEqual([
      '/site.webmanifest',
      '/sw.js',
      '/icon-192.png',
      '/icon-512.png',
      '/icon-maskable-512.png',
      '/apple-touch-icon.png',
      '/favicon.ico',
      '/favicon.svg',
      '/favicon-light.svg',
      '/favicon-dark.svg',
    ]);

    expect(getPublicPwaAssetSpec('/site.webmanifest')).toMatchObject({
      contentType: 'application/manifest+json',
      fallbackKind: 'manifest',
    });
    expect(getPublicPwaAssetSpec('/sw.js')).toMatchObject({
      contentType: 'application/javascript; charset=utf-8',
      cacheControl: 'no-cache',
      serviceWorkerAllowed: '/',
      fallbackKind: 'service_worker',
    });
    expect(getPublicPwaAssetSpec('/icon-192.png')?.contentType).toBe('image/png');
    expect(getPublicPwaAssetSpec('/favicon.ico')?.contentType).toBe('image/x-icon');
    expect(getPublicPwaAssetSpec('/favicon.svg')?.contentType).toBe('image/svg+xml; charset=utf-8');

    expect(getPublicPwaAssetSpec('/api/bundle')).toBeNull();
    expect(getPublicPwaAssetSpec('/data/archive.json')).toBeNull();
    expect(getPublicPwaAssetSpec('toString')).toBeNull();
  });

  it('generates a strictly privacy-safe sw.js that never writes to Cache Storage and passes through /api, /media, /data, and /sources', async () => {
    expect(PWA_NEVER_CACHE_PATH_PREFIXES).toEqual(['/api', '/media', '/data', '/sources']);

    const script = renderPrivacySafeServiceWorkerScript({
      baseUrl: '/kinloom/',
      siteTitle: 'Alder & <Oak> Archive',
    });

    // Static guarantee: zero Cache Storage mutation calls anywhere in the SW script.
    expect(script).not.toMatch(/\bcaches\.open\b/);
    expect(script).not.toMatch(/\.put\s*\(/);
    expect(script).not.toMatch(/\.addAll\s*\(/);
    expect(script).toContain('"/api"');
    expect(script).toContain('"/media"');
    expect(script).toContain('"/data"');
    expect(script).toContain('"/sources"');

    const onlineFetch = vi.fn(async () => new Response('<html>live</html>', { status: 200 }));
    const sandbox = createSwSandbox(script, onlineFetch);

    // Lifecycle: install calls skipWaiting(), activate calls clients.claim().
    sandbox.listeners.get('install')?.({});
    expect(sandbox.skipWaiting).toHaveBeenCalledTimes(1);

    const waitUntil = vi.fn();
    sandbox.listeners.get('activate')?.({ waitUntil });
    expect(sandbox.claim).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);

    const fetchHandler = sandbox.listeners.get('fetch');
    expect(fetchHandler).toBeTypeOf('function');

    // Protected paths, subpaths, mutations, cross-origin, and non-navigate subresources must bypass respondWith completely.
    const bypassedRequests = [
      { url: 'https://archive.example.test/api/bundle', method: 'GET', mode: 'cors' },
      { url: 'https://archive.example.test/api', method: 'GET', mode: 'navigate' },
      { url: 'https://archive.example.test/media/portrait.jpg', method: 'GET', mode: 'no-cors' },
      { url: 'https://archive.example.test/data/archive.json', method: 'GET', mode: 'cors' },
      { url: 'https://archive.example.test/sources/deed.pdf', method: 'GET', mode: 'navigate' },
      { url: 'https://archive.example.test/kinloom/api/auth/me', method: 'GET', mode: 'cors' },
      { url: 'https://archive.example.test/kinloom/data/archive.json', method: 'GET', mode: 'cors' },
      { url: 'https://archive.example.test/kinloom/media/scan.png', method: 'GET', mode: 'navigate' },
      { url: 'https://archive.example.test/person/arthur', method: 'POST', mode: 'cors' },
      { url: 'https://other.example.test/person/arthur', method: 'GET', mode: 'navigate' },
      { url: 'https://archive.example.test/assets/app.js', method: 'GET', mode: 'cors' },
    ];

    for (const req of bypassedRequests) {
      const event: MockFetchEvent = { request: req, respondWith: vi.fn() };
      fetchHandler?.(event);
      expect(event.respondWith, `Expected pass-through for ${req.method} ${req.url}`).not.toHaveBeenCalled();
    }

    // Online navigation forwards straight to fetch(request) without touching Cache Storage.
    const navOnlineEvent: MockFetchEvent = {
      request: { url: 'https://archive.example.test/kinloom/person/arthur', method: 'GET', mode: 'navigate' },
      respondWith: vi.fn(),
    };
    fetchHandler?.(navOnlineEvent);
    expect(navOnlineEvent.respondWith).toHaveBeenCalledTimes(1);
    const liveRes = (await navOnlineEvent.respondWith.mock.calls[0]?.[0]) as Response;
    expect(liveRes.status).toBe(200);
    expect(await liveRes.text()).toBe('<html>live</html>');
    expect(sandbox.forbiddenCaches.open).not.toHaveBeenCalled();

    // Offline navigation returns a 503 no-store HTML notice with escaped site title and zero Cache Storage access.
    const offlineSandbox = createSwSandbox(script, async () => {
      throw new TypeError('Failed to fetch');
    });
    const navOfflineEvent: MockFetchEvent = {
      request: { url: 'https://archive.example.test/kinloom/', method: 'GET', mode: 'navigate' },
      respondWith: vi.fn(),
    };
    offlineSandbox.listeners.get('fetch')?.(navOfflineEvent);
    expect(navOfflineEvent.respondWith).toHaveBeenCalledTimes(1);
    const offlineRes = (await navOfflineEvent.respondWith.mock.calls[0]?.[0]) as Response;
    expect(offlineRes.status).toBe(503);
    expect(offlineRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(offlineRes.headers.get('cache-control')).toBe('no-store');
    const offlineHtml = await offlineRes.text();
    expect(offlineHtml).toContain('Alder &amp; &lt;Oak&gt; Archive');
    expect(offlineHtml).toContain('viewport-fit=cover');
    expect(offlineSandbox.forbiddenCaches.open).not.toHaveBeenCalled();
  });

  it('defaults site title to Kinloom when omitted or blank', () => {
    const script = renderPrivacySafeServiceWorkerScript({ siteTitle: '   ' });
    expect(script).toContain('<title>Offline | Kinloom</title>');
  });
});
