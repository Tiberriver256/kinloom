import type {
  KinloomServerPlugin,
  KinloomServerPluginRoute,
  KinloomServerPorts,
  KinloomSiteConfig,
} from '@kinloom/core';
import { KinloomHttpError, toErrorResponseData } from '../errors.js';
import { AdminService } from '../services/adminService.js';
import { AuthService } from '../services/authService.js';
import { BundleReadService } from '../services/bundleReadService.js';
import { MediaService } from '../services/mediaService.js';
import { PronunciationService } from '../services/pronunciationService.js';
import { TalkService } from '../services/talkService.js';
import { WikiWriteService } from '../services/wikiWriteService.js';
import { enforceCsrfOrigin, requireMinRole, resolveCallerPrincipal } from './authMiddleware.js';
import { type HttpRequestContext, type HttpRouteHandler, jsonResponse } from './httpPrimitives.js';
import { createAdminRouteHandler } from './routes/adminRoutes.js';
import { createAuthRouteHandler } from './routes/authRoutes.js';
import { createMediaAndTalkRouteHandler } from './routes/mediaAndTalkRoutes.js';
import { createPrivacyAndOgRouteHandler } from './routes/privacyAndOgRoutes.js';
import { createPronunciationRouteHandler } from './routes/pronunciationRoutes.js';
import { createWikiRouteHandler } from './routes/wikiRoutes.js';
import { applySecurityHeaders } from './securityHeaders.js';
import { isSecureRequestUrl } from './session.js';

export {
  type AuthBrowserProvider,
  buildAuthErrorRedirectUrl,
  isBrowserNavigation,
  mapAuthErrorToBrowserCode,
} from './httpPrimitives.js';

export interface KinloomServerConfig {
  siteConfig: KinloomSiteConfig;
  ports: KinloomServerPorts;
  sessionSecret: string;
  mode?: 'private' | 'public';
  bootstrapAdminEmail?: string;
  sessionTtlSeconds?: number;
  oauthCookieTtlSeconds?: number;
  magicLinkTtlMinutes?: number;
  onPluginError?: (pluginId: string, error: unknown) => void;
  compiledPluginRoutes?: readonly CompiledPluginRoute[];
}

export interface KinloomServer {
  fetch(request: Request): Promise<Response>;
}

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_OAUTH_COOKIE_TTL_SECONDS = 10 * 60;

export interface CompiledPluginRoute {
  readonly pluginId: string;
  readonly method: string;
  readonly normalizedPrefix: string;
  readonly route: KinloomServerPluginRoute;
}

function normalizePluginPathPrefix(raw: string, pluginId: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) {
    throw new RangeError(`Server plugin '${pluginId}' route pathPrefix '${raw}' must start with '/'.`);
  }
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : '/';
}

function matchesPathPrefix(pathname: string, normalizedPrefix: string): boolean {
  if (normalizedPrefix === '/') {
    return pathname.startsWith('/');
  }
  return pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`);
}

function pluginMethodsOverlap(methodA: string, methodB: string): boolean {
  return methodA === '*' || methodB === '*' || methodA === methodB;
}

export const RESERVED_SERVER_ROUTE_PREFIXES: readonly string[] = [
  '/api/bundle',
  '/api/entities',
  '/api/revisions',
  '/api/batches',
  '/api/export',
  '/api/auth',
  '/api/media',
  '/api/talk',
  '/api/admin',
  '/api/pronunciations',
  '/api/pronunciation',
  '/privacy',
  '/og',
  '/invite',
  '/media',
  '/sources',
  '/data',
];

export function validateAndCompilePluginRoutes(
  plugins: readonly KinloomServerPlugin[]
): readonly CompiledPluginRoute[] {
  const seenPluginIds = new Set<string>();
  const compiledRoutes: CompiledPluginRoute[] = [];

  for (const plugin of plugins) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      throw new RangeError('Server plugin id must be a non-empty string.');
    }
    if (seenPluginIds.has(pluginId)) {
      throw new RangeError(`Duplicate server plugin id '${pluginId}'.`);
    }
    seenPluginIds.add(pluginId);

    for (const route of plugin.routes ?? []) {
      const method = route.method.trim().toUpperCase();
      if (!method) {
        throw new RangeError(`Server plugin '${pluginId}' route method must be non-empty.`);
      }
      const normalizedPrefix = normalizePluginPathPrefix(route.pathPrefix, pluginId);

      for (const reservedPrefix of RESERVED_SERVER_ROUTE_PREFIXES) {
        if (
          matchesPathPrefix(normalizedPrefix, reservedPrefix) ||
          matchesPathPrefix(reservedPrefix, normalizedPrefix)
        ) {
          throw new RangeError(
            `Server plugin '${pluginId}' route '${method} ${normalizedPrefix}' collides with reserved built-in route prefix '${reservedPrefix}'.`
          );
        }
      }

      for (const existing of compiledRoutes) {
        if (
          pluginMethodsOverlap(existing.method, method) &&
          (matchesPathPrefix(normalizedPrefix, existing.normalizedPrefix) ||
            matchesPathPrefix(existing.normalizedPrefix, normalizedPrefix))
        ) {
          throw new RangeError(
            `Conflicting server plugin route '${method} ${normalizedPrefix}' in plugin '${pluginId}' overlaps with '${existing.method} ${existing.normalizedPrefix}' in plugin '${existing.pluginId}'.`
          );
        }
      }

      compiledRoutes.push({
        pluginId,
        method,
        normalizedPrefix,
        route,
      });
    }
  }

  return compiledRoutes;
}

function matchPluginRoute(
  routes: readonly CompiledPluginRoute[],
  method: string,
  pathname: string
): KinloomServerPluginRoute | null {
  const upperMethod = method.toUpperCase();
  for (const compiled of routes) {
    if (compiled.method !== '*' && compiled.method !== upperMethod) {
      continue;
    }
    if (matchesPathPrefix(pathname, compiled.normalizedPrefix)) {
      return compiled.route;
    }
  }
  return null;
}

/**
 * Portable Web-Standard Fetch server implementing all Kinloom HTTP API endpoints,
 * session/CSRF/RBAC middleware, plugin routes, and optional static SPA asset fallback.
 */
export function createKinloomServer(config: KinloomServerConfig): KinloomServer {
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    throw new RangeError('sessionSecret must be at least 16 characters.');
  }

  const mode = config.mode ?? 'private';
  const sessionTtlSeconds = config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const oauthCookieTtlSeconds = config.oauthCookieTtlSeconds ?? DEFAULT_OAUTH_COOKIE_TTL_SECONDS;
  const plugins = config.ports.plugins ?? [];
  const pluginRoutes = config.compiledPluginRoutes ?? validateAndCompilePluginRoutes(plugins);

  const authService = new AuthService({
    repository: config.ports.repository,
    emailSender: config.ports.emailSender,
    authProvider: config.ports.authProvider,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
    bootstrapAdminEmail: config.bootstrapAdminEmail,
    magicLinkTtlMinutes: config.magicLinkTtlMinutes,
  });

  const wikiWriteService = new WikiWriteService({
    repository: config.ports.repository,
    bundleCache: config.ports.bundleCache,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
    mediaStore: config.ports.mediaStore,
    pronunciationGenerator: config.ports.pronunciationGenerator,
    plugins,
    onPluginError: config.onPluginError,
  });

  const bundleReadService = new BundleReadService({
    repository: config.ports.repository,
    bundleCache: config.ports.bundleCache,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
  });

  const mediaService = new MediaService({
    repository: config.ports.repository,
    mediaStore: config.ports.mediaStore,
    wikiWriteService,
    siteConfig: config.siteConfig,
  });

  const talkService = new TalkService({
    repository: config.ports.repository,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
  });

  const adminService = new AdminService({
    repository: config.ports.repository,
    clock: config.ports.clock,
  });

  const pronunciationService = new PronunciationService({
    repository: config.ports.repository,
    mediaStore: config.ports.mediaStore,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
    pronunciationGenerator: config.ports.pronunciationGenerator,
    pronunciationLexiconStore: config.ports.pronunciationLexiconStore,
  });

  const handlePublicPrivacyOrOg = createPrivacyAndOgRouteHandler({
    siteConfig: config.siteConfig,
    entityStore: config.ports.repository,
    clock: config.ports.clock,
  });

  const routeHandlers: readonly HttpRouteHandler[] = [
    createAuthRouteHandler({
      authService,
      clock: config.ports.clock,
      sessionSecret: config.sessionSecret,
      sessionTtlSeconds,
      oauthCookieTtlSeconds,
    }),
    createWikiRouteHandler({ bundleReadService, wikiWriteService }),
    createPronunciationRouteHandler({ pronunciationService, mode }),
    createMediaAndTalkRouteHandler({ mediaService, talkService }),
    createAdminRouteHandler(adminService),
  ];

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();
    const isSecure = isSecureRequestUrl(url);

    const publicDocResponse = await handlePublicPrivacyOrOg({ pathname, method, isSecure });
    if (publicDocResponse !== null) {
      return publicDocResponse;
    }

    const segments = pathname.split('/').filter(Boolean);

    const auth = await resolveCallerPrincipal({
      request,
      url,
      sessionSecret: config.sessionSecret,
      repository: config.ports.repository,
      clock: config.ports.clock,
    });

    const ctx: HttpRequestContext = {
      request,
      url,
      pathname,
      method,
      isSecure,
      segments,
      auth,
    };

    for (const handle of routeHandlers) {
      const response = await handle(ctx);
      if (response !== null) {
        return response;
      }
    }

    const matchedPluginRoute = matchPluginRoute(pluginRoutes, method, pathname);
    if (matchedPluginRoute) {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, matchedPluginRoute.minRole, {
        allowAgentScopes:
          matchedPluginRoute.minRole === 'viewer'
            ? ['write_batch', 'read_backup']
            : matchedPluginRoute.minRole === 'editor'
              ? ['write_batch']
              : [],
        adminForbiddenCode: matchedPluginRoute.minRole === 'admin' ? 'ADMIN_REQUIRED' : 'FORBIDDEN',
      });
      return matchedPluginRoute.handle({
        request,
        url,
        principal: auth.principal,
        siteConfig: config.siteConfig,
        ports: config.ports,
      });
    }

    if (
      config.ports.assetHandler &&
      (method === 'GET' || method === 'HEAD') &&
      !pathname.startsWith('/api/') &&
      !pathname.startsWith('/media/') &&
      !pathname.startsWith('/sources/')
    ) {
      if (pathname.startsWith('/data/')) {
        requireMinRole(auth.principal, 'viewer', {
          allowAgentScopes: ['write_batch', 'read_backup'],
        });
      }
      return config.ports.assetHandler.fetch(request);
    }

    throw new KinloomHttpError(404, 'NOT_FOUND', `Route ${method} ${pathname} was not found.`);
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const isSecure = isSecureRequestUrl(url);
      const isMediaPath = url.pathname.startsWith('/media/') || url.pathname.startsWith('/sources/');
      try {
        const response = await handleRequest(request);
        const isMediaResponse = isMediaPath && (response.status === 200 || response.status === 206);
        return applySecurityHeaders(response, { isSecure, isMedia: isMediaResponse });
      } catch (error) {
        const mapped = toErrorResponseData(error);
        return applySecurityHeaders(jsonResponse(mapped.body, mapped.status, mapped.headers), {
          isSecure,
          isMedia: false,
        });
      }
    },
  };
}
