import type { AssetHandler } from '@kinloom/core';
import type { Fetcher } from '../types.js';

const KINLOOM_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none" role="img" aria-label="Kinloom">
  <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="6" fill="#F5EFE2" stroke="#D6CEBE" stroke-width="1.5"/>
  <g transform="translate(4 4)">
    <path d="M8 2.5V13.5M8 18.5V21.5" stroke="#1B2A41" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M16 2.5V5.5M16 10.5V21.5" stroke="#1B2A41" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M2.5 8H5.5M10.5 8H21.5" stroke="#7A4612" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M2.5 16H13.5M18.5 16H21.5" stroke="#1B2A41" stroke-width="2.5" stroke-linecap="round"/>
  </g>
</svg>
`;

const STATIC_ASSET_EXTENSION_PATTERN = /\.[a-z0-9]{1,8}$/i;

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/html');
}

function notFoundPlainResponse(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Cloudflare ASSETS binding adapter for serving SPA routes and static files.
 * Never falls back to SPA HTML for /api/*, /media/*, /favicon.ico, /favicon.svg, or missing static assets.
 */
export function createCloudflareAssetHandler(assets?: Fetcher): AssetHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (
        pathname === '/api' ||
        pathname.startsWith('/api/') ||
        pathname === '/media' ||
        pathname.startsWith('/media/') ||
        pathname === '/sources' ||
        pathname.startsWith('/sources/')
      ) {
        return notFoundPlainResponse();
      }

      if (pathname === '/favicon.svg') {
        if (assets) {
          const assetRes = await assets.fetch(request);
          if (assetRes.ok && !isHtmlResponse(assetRes)) {
            return assetRes;
          }
        }
        return new Response(KINLOOM_FAVICON_SVG, {
          status: 200,
          headers: {
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'public, max-age=86400',
          },
        });
      }

      if (pathname === '/favicon.ico') {
        if (assets) {
          const assetRes = await assets.fetch(request);
          if (assetRes.ok && !isHtmlResponse(assetRes)) {
            return assetRes;
          }
        }
        return notFoundPlainResponse();
      }

      if (!assets) {
        return notFoundPlainResponse();
      }

      const directRes = await assets.fetch(request);

      if (STATIC_ASSET_EXTENSION_PATTERN.test(pathname)) {
        if (directRes.ok && !isHtmlResponse(directRes)) {
          return directRes;
        }
        return notFoundPlainResponse();
      }

      if (directRes.status !== 404) {
        return directRes;
      }

      const indexUrl = new URL('/index.html', url.origin);
      const indexRes = await assets.fetch(new Request(indexUrl.toString(), { method: request.method }));
      if (!indexRes.ok) {
        return notFoundPlainResponse();
      }

      const headers = new Headers(indexRes.headers);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'text/html; charset=utf-8');
      }
      return new Response(indexRes.body, {
        status: 200,
        headers,
      });
    },
  };
}
