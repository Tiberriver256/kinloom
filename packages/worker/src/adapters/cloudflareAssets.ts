import { type AssetHandler, getPublicPwaAssetSpec, type KinloomSiteConfig } from '@kinloom/core';
import {
  applySecurityHeaders,
  buildPublicPwaFallbackResponse,
  isValidPublicPwaAssetResponse,
  normalizePublicPwaAssetResponse,
} from '@kinloom/server';
import type { Fetcher } from '../types.js';

const STATIC_ASSET_EXTENSION_PATTERN = /\.[a-z0-9]{1,8}$/i;

function notFoundPlainResponse(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export interface CloudflareAssetHandlerOptions {
  readonly siteConfig?: KinloomSiteConfig | null;
}

/**
 * Cloudflare ASSETS binding adapter for serving SPA routes and static files.
 * Never falls back to SPA HTML for /api/*, /media/*, /sources/*, PWA assets, or missing static files.
 */
export function createCloudflareAssetHandler(
  assets?: Fetcher,
  options?: CloudflareAssetHandlerOptions
): AssetHandler {
  const siteConfig = options?.siteConfig ?? null;

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

    const headOnly = request.method.toUpperCase() === 'HEAD';
    const pwaSpec = getPublicPwaAssetSpec(pathname);
    if (pwaSpec) {
      if (assets) {
        const assetRes = await assets.fetch(request);
        if (isValidPublicPwaAssetResponse(assetRes)) {
          return normalizePublicPwaAssetResponse(assetRes, pwaSpec, headOnly);
        }
      }
      const fallback = buildPublicPwaFallbackResponse(pwaSpec, siteConfig, headOnly);
      return fallback ?? notFoundPlainResponse();
    }

    if (!assets) {
      return notFoundPlainResponse();
    }

    const directRes = await assets.fetch(request);

    if (STATIC_ASSET_EXTENSION_PATTERN.test(pathname)) {
      if (isValidPublicPwaAssetResponse(directRes)) {
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
