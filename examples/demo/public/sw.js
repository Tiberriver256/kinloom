// Kinloom Privacy-Safe Service Worker (network-only; never caches private records)
'use strict';

const BASE_PATH = "/";
const NEVER_CACHE_PREFIXES = ["/api","/media","/data","/sources"];
const OFFLINE_HTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"><title>Offline | Lincoln &amp; Todd Historical Archive</title><style>:root{color-scheme:light dark;--bg:#F5EFE2;--card:#FCF9F2;--ink:#1B2A41;--muted:#554E45;--rule:#D6CEBE;--accent:#7A4612}@media(prefers-color-scheme:dark){:root{--bg:#171614;--card:#1F1D1A;--ink:#EDE6D9;--muted:#BDB3A3;--rule:#3D3832;--accent:#D89C56}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:var(--bg);color:var(--ink);font-family:Georgia,serif;line-height:1.6}main{max-width:30rem;width:100%;padding:2rem 1.75rem;background:var(--card);border:1px solid var(--rule);border-radius:6px}h1{margin:0 0 .75rem;font-size:1.5rem;line-height:1.25}p{margin:0 0 1rem;color:var(--muted)}a{display:inline-block;padding:.5rem 1rem;border:1px solid var(--accent);border-radius:4px;color:var(--accent);text-decoration:none;font-family:system-ui,sans-serif;font-size:.9rem;font-weight:600}</style></head><body><main><h1>Lincoln &amp; Todd Historical Archive</h1><p>This archive requires an active network connection. Records are never stored in browser cache so private family data stays off shared devices.</p><a href=\"\">Try again</a></main></body></html>";

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
