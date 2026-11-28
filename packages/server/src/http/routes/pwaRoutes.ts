import {
  type AssetHandler,
  buildWebManifest,
  getPublicPwaAssetSpec,
  type KinloomSiteConfig,
  type PublicPwaAssetSpec,
  renderDarkFaviconSvg,
  renderFaviconSvg,
  renderLightFaviconSvg,
  renderPrivacySafeServiceWorkerScript,
  renderThemeInitScriptSource,
} from '@kinloom/core';

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/html');
}

export function isValidPublicPwaAssetResponse(response: Response): boolean {
  return response.status === 304 || (response.ok && !isHtmlResponse(response));
}

export function normalizePublicPwaAssetResponse(
  response: Response,
  spec: PublicPwaAssetSpec,
  headOnly: boolean
): Response {
  const headers = new Headers(response.headers);
  if (spec.serviceWorkerAllowed) {
    headers.set('service-worker-allowed', spec.serviceWorkerAllowed);
    headers.set('cache-control', spec.cacheControl);
  }
  if (response.status === 304) {
    return new Response(null, {
      status: 304,
      statusText: response.statusText,
      headers,
    });
  }

  headers.set('content-type', spec.contentType);
  if (!headers.has('cache-control')) {
    headers.set('cache-control', spec.cacheControl);
  }

  return new Response(headOnly ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function buildPublicPwaFallbackResponse(
  spec: PublicPwaAssetSpec,
  siteConfig?: KinloomSiteConfig | null,
  headOnly = false
): Response | null {
  const accent = siteConfig?.brand?.accent ?? siteConfig?.theme?.accent;
  const accentDark = siteConfig?.theme?.accentDark;
  const label = siteConfig?.site.title ? `${siteConfig.site.title} icon` : undefined;

  let body: string | null = null;
  switch (spec.fallbackKind) {
    case 'manifest':
      body = `${JSON.stringify(buildWebManifest(siteConfig), null, 2)}\n`;
      break;
    case 'service_worker':
      body = renderPrivacySafeServiceWorkerScript({ siteTitle: siteConfig?.site.title });
      break;
    case 'theme_init':
      body = renderThemeInitScriptSource();
      break;
    case 'favicon_adaptive':
      body = renderFaviconSvg({ accent, accentDark, label });
      break;
    case 'favicon_light':
      body = renderLightFaviconSvg({ accent, accentDark, label });
      break;
    case 'favicon_dark':
      body = renderDarkFaviconSvg({ accent, accentDark, label });
      break;
    case 'none':
      return null;
  }

  const headers = new Headers({
    'content-type': spec.contentType,
    'cache-control': spec.cacheControl,
  });
  if (spec.serviceWorkerAllowed) {
    headers.set('service-worker-allowed', spec.serviceWorkerAllowed);
  }

  return new Response(headOnly ? null : body, {
    status: 200,
    headers,
  });
}

export interface PublicPwaRouteHandlerDeps {
  readonly siteConfig: KinloomSiteConfig;
  readonly assetHandler?: AssetHandler;
}

/**
 * Serves public PWA manifest, service worker, icons, and favicons unauthenticated
 * even when ARCHIVE_MODE=private, normalizing Content-Type and Service-Worker-Allowed
 * headers and falling back to generated manifest/SW/SVG assets when missing from ASSETS.
 */
export function createPublicPwaRouteHandler(
  deps: PublicPwaRouteHandlerDeps
): (params: { request: Request; pathname: string; method: string }) => Promise<Response | null> {
  const { siteConfig, assetHandler } = deps;

  return async ({ request, pathname, method }) => {
    if (method !== 'GET' && method !== 'HEAD') {
      return null;
    }

    const spec = getPublicPwaAssetSpec(pathname);
    if (!spec) {
      return null;
    }

    const headOnly = method === 'HEAD';
    if (assetHandler) {
      const assetResponse = await assetHandler.fetch(request);
      if (isValidPublicPwaAssetResponse(assetResponse)) {
        return normalizePublicPwaAssetResponse(assetResponse, spec, headOnly);
      }
    }

    const fallback = buildPublicPwaFallbackResponse(spec, siteConfig, headOnly);
    if (fallback !== null) {
      return fallback;
    }

    return new Response(headOnly ? null : 'Not Found', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  };
}
