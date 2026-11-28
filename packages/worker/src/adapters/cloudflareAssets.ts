import {
  type AssetHandler,
  renderDarkFaviconSvg,
  renderFaviconSvg,
  renderLightFaviconSvg,
} from '@kinloom/core';
import { applySecurityHeaders } from '@kinloom/server';
import type { Fetcher } from '../types.js';

const KINLOOM_FAVICON_FALLBACKS: Readonly<Record<string, string>> = {
  '/favicon.svg': renderFaviconSvg(),
  '/favicon-light.svg': renderLightFaviconSvg(),
  '/favicon-dark.svg': renderDarkFaviconSvg(),
};

const STATIC_ASSET_EXTENSION_PATTERN = /\.[a-z0-9]{1,8}$/i;

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/html');
}

function isValidStaticAssetResponse(response: Response): boolean {
  return response.status === 304 || (response.ok && !isHtmlResponse(response));
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
  async function resolveAssetResponse(request: Request, url: URL): Promise<Response> {
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

    const fallbackFaviconSvg = KINLOOM_FAVICON_FALLBACKS[pathname];
    if (fallbackFaviconSvg !== undefined) {
      if (assets) {
        const assetRes = await assets.fetch(request);
        if (isValidStaticAssetResponse(assetRes)) {
          return assetRes;
        }
      }
      return new Response(fallbackFaviconSvg, {
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
        if (isValidStaticAssetResponse(assetRes)) {
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
      if (isValidStaticAssetResponse(directRes)) {
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
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const response = await resolveAssetResponse(request, url);
      return applySecurityHeaders(response, { isSecure: url.protocol === 'https:' });
    },
  };
}
