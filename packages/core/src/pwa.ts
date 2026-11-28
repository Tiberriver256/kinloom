import {
  deriveDarkModeFaviconAccent,
  escapeXml,
  KINLOOM_BRAND_PALETTE,
  normalizeHex,
} from './brandkitSvg.js';

export type PublicPwaAssetPath =
  | '/site.webmanifest'
  | '/sw.js'
  | '/theme-init.js'
  | '/icon-192.png'
  | '/icon-512.png'
  | '/icon-maskable-512.png'
  | '/apple-touch-icon.png'
  | '/favicon.ico'
  | '/favicon.svg'
  | '/favicon-light.svg'
  | '/favicon-dark.svg';

export type PublicPwaAssetFallbackKind =
  | 'manifest'
  | 'service_worker'
  | 'theme_init'
  | 'favicon_adaptive'
  | 'favicon_light'
  | 'favicon_dark'
  | 'none';

export interface PublicPwaAssetSpec {
  readonly path: PublicPwaAssetPath;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly serviceWorkerAllowed?: string;
  readonly fallbackKind: PublicPwaAssetFallbackKind;
}

export const PUBLIC_PWA_STATIC_ASSET_SPECS: Readonly<Record<PublicPwaAssetPath, PublicPwaAssetSpec>> = {
  '/site.webmanifest': {
    path: '/site.webmanifest',
    contentType: 'application/manifest+json',
    cacheControl: 'public, max-age=3600',
    fallbackKind: 'manifest',
  },
  '/sw.js': {
    path: '/sw.js',
    contentType: 'application/javascript; charset=utf-8',
    cacheControl: 'no-cache',
    serviceWorkerAllowed: '/',
    fallbackKind: 'service_worker',
  },
  '/theme-init.js': {
    path: '/theme-init.js',
    contentType: 'application/javascript; charset=utf-8',
    cacheControl: 'public, max-age=86400',
    fallbackKind: 'theme_init',
  },
  '/icon-192.png': {
    path: '/icon-192.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=86400',
    fallbackKind: 'none',
  },
  '/icon-512.png': {
    path: '/icon-512.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=86400',
    fallbackKind: 'none',
  },
  '/icon-maskable-512.png': {
    path: '/icon-maskable-512.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=86400',
    fallbackKind: 'none',
  },
  '/apple-touch-icon.png': {
    path: '/apple-touch-icon.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=86400',
    fallbackKind: 'none',
  },
  '/favicon.ico': {
    path: '/favicon.ico',
    contentType: 'image/x-icon',
    cacheControl: 'public, max-age=86400',
    fallbackKind: 'none',
  },
  '/favicon.svg': {
    path: '/favicon.svg',
    contentType: 'image/svg+xml; charset=utf-8',
    cacheControl: 'public, max-age=86400',
    fallbackKind: 'favicon_adaptive',
  },
  '/favicon-light.svg': {
    path: '/favicon-light.svg',
    contentType: 'image/svg+xml; charset=utf-8',
    cacheControl: 'public, max-age=86400',
    fallbackKind: 'favicon_light',
  },
  '/favicon-dark.svg': {
    path: '/favicon-dark.svg',
    contentType: 'image/svg+xml; charset=utf-8',
    cacheControl: 'public, max-age=86400',
    fallbackKind: 'favicon_dark',
  },
};

export const PUBLIC_PWA_STATIC_ASSET_PATHS: readonly PublicPwaAssetPath[] = Object.keys(
  PUBLIC_PWA_STATIC_ASSET_SPECS
) as PublicPwaAssetPath[];

export function getPublicPwaAssetSpec(pathname: string): PublicPwaAssetSpec | null {
  if (!Object.hasOwn(PUBLIC_PWA_STATIC_ASSET_SPECS, pathname)) {
    return null;
  }
  return PUBLIC_PWA_STATIC_ASSET_SPECS[pathname as PublicPwaAssetPath];
}

export const PWA_NEVER_CACHE_PATH_PREFIXES = ['/api', '/media', '/data', '/sources'] as const;

/**
 * Normalizes a PWA base path (root `/` or subpath `/kinloom/`) with both leading and trailing slashes.
 */
export function normalizePwaBaseUrl(raw?: string): string {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    return '/';
  }
  const withoutEdgeSlashes = trimmed.replace(/^\/+|\/+$/g, '');
  if (!withoutEdgeSlashes) {
    return '/';
  }
  return `/${withoutEdgeSlashes}/`;
}

export function joinPwaBasePath(baseUrl: string | undefined, assetPath: string): string {
  const base = normalizePwaBaseUrl(baseUrl);
  const relative = assetPath.replace(/^\/+/, '');
  return `${base}${relative}`;
}

const DEFAULT_OFFLINE_ACCENT_LIGHT = KINLOOM_BRAND_PALETTE.ochre;
const DEFAULT_OFFLINE_ACCENT_DARK = '#D89C56';
const OFFLINE_DARK_CARD_BG = '#1F1D1A';

export interface RenderPrivacySafeServiceWorkerOptions {
  readonly baseUrl?: string;
  readonly siteTitle?: string;
  readonly accent?: string;
  readonly accentDark?: string;
}

function buildOfflineNoticeHtml(options: {
  readonly siteTitle: string;
  readonly accent?: string | undefined;
  readonly accentDark?: string | undefined;
}): string {
  const escapedTitle = escapeXml(options.siteTitle.trim() || 'Kinloom');
  const accentLight = normalizeHex(options.accent, DEFAULT_OFFLINE_ACCENT_LIGHT);
  const fallbackDark =
    accentLight === DEFAULT_OFFLINE_ACCENT_LIGHT
      ? DEFAULT_OFFLINE_ACCENT_DARK
      : deriveDarkModeFaviconAccent(accentLight, OFFLINE_DARK_CARD_BG);
  const accentDark = normalizeHex(options.accentDark, fallbackDark);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<title>Offline | ${escapedTitle}</title>`,
    '<style>',
    `:root{color-scheme:light dark;--bg:#F5EFE2;--card:#FCF9F2;--ink:#1B2A41;--muted:#554E45;--rule:#D6CEBE;--accent:${accentLight}}`,
    `@media(prefers-color-scheme:dark){:root{--bg:#171614;--card:#1F1D1A;--ink:#EDE6D9;--muted:#BDB3A3;--rule:#3D3832;--accent:${accentDark}}}`,
    '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:var(--bg);color:var(--ink);font-family:Georgia,serif;line-height:1.6}',
    'main{max-width:30rem;width:100%;padding:2rem 1.75rem;background:var(--card);border:1px solid var(--rule);border-radius:6px}',
    'h1{margin:0 0 .75rem;font-size:1.5rem;line-height:1.25}p{margin:0 0 1rem;color:var(--muted)}',
    'a{display:inline-block;padding:.5rem 1rem;border:1px solid var(--accent);border-radius:4px;color:var(--accent);text-decoration:none;font-family:system-ui,sans-serif;font-size:.9rem;font-weight:600}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapedTitle}</h1>`,
    '<p>This archive requires an active network connection. Records are never stored in browser cache so private family data stays off shared devices.</p>',
    '<a href="">Try again</a>',
    '</main>',
    '</body>',
    '</html>',
  ].join('');
}

/**
 * Generates Kinloom's canonical privacy-safe Service Worker (`sw.js`).
 *
 * Security invariant: this worker NEVER writes to Cache Storage for any request
 * (`/api/*`, `/media/*`, `/data/*`, `/sources/*`, or HTML navigations), ensuring private
 * family archives never leave sensitive records behind on shared devices while remaining
 * cleanly installable on iOS and Android.
 */
export function renderPrivacySafeServiceWorkerScript(
  options?: RenderPrivacySafeServiceWorkerOptions
): string {
  const basePath = normalizePwaBaseUrl(options?.baseUrl);
  const offlineHtml = buildOfflineNoticeHtml({
    siteTitle: options?.siteTitle ?? 'Kinloom',
    accent: options?.accent,
    accentDark: options?.accentDark,
  });
  const excludedPrefixes = JSON.stringify(PWA_NEVER_CACHE_PATH_PREFIXES);

  return `// Kinloom Privacy-Safe Service Worker (network-only; never caches private records)
'use strict';

const BASE_PATH = ${JSON.stringify(basePath)};
const NEVER_CACHE_PREFIXES = ${excludedPrefixes};
const OFFLINE_HTML = ${JSON.stringify(offlineHtml)};

function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

function isExcludedPath(pathname) {
  for (let i = 0; i < NEVER_CACHE_PREFIXES.length; i += 1) {
    const prefix = NEVER_CACHE_PREFIXES[i];
    if (matchesPrefix(pathname, prefix)) {
      return true;
    }
    if (BASE_PATH !== '/') {
      const scopedPrefix = BASE_PATH.slice(0, -1) + prefix;
      if (matchesPrefix(pathname, scopedPrefix)) {
        return true;
      }
    }
  }
  return false;
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isExcludedPath(url.pathname)) {
    return;
  }

  if (request.mode !== 'navigate') {
    return;
  }

  event.respondWith(
    fetch(request).catch(function () {
      return new Response(OFFLINE_HTML, {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    })
  );
});
`;
}
