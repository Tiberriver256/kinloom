import {
  type CallerPrincipal,
  type KinloomServerPluginRoute,
  type KinloomSiteConfig,
  validatePluginDocumentation,
} from '@kinloom/core';
import { hmacSignBase64Url } from '../crypto.js';
import { KinloomHttpError, toErrorResponseData } from '../errors.js';
import { AdminDocsService } from '../services/adminDocsService.js';
import { AdminService } from '../services/adminService.js';
import { AuthService } from '../services/authService.js';
import { BundleReadService } from '../services/bundleReadService.js';
import { ChangelogService } from '../services/changelogService.js';
import { MediaService } from '../services/mediaService.js';
import { PluginSettingsService } from '../services/pluginSettingsService.js';
import { PronunciationService } from '../services/pronunciationService.js';
import {
  type KinloomServerDiagnosticsConfig,
  SystemDiagnosticsService,
} from '../services/systemDiagnosticsService.js';
import { TalkService } from '../services/talkService.js';
import { WikiWriteService } from '../services/wikiWriteService.js';
import { enforceCsrfOrigin, requireMinRole, resolveCallerPrincipal } from './authMiddleware.js';
import { compilePluginDocumentContributions, finalizeServerResponse } from './documentContributions.js';
import { type HttpRequestContext, type HttpRouteHandler, jsonResponse } from './httpPrimitives.js';
import {
  createRequestTelemetryTracker,
  hasRequestLifecyclePlugins,
  hasSecurityEventPlugins,
  type KinloomServerPlugin,
  type KinloomServerPorts,
  normalizeServerRouteTemplate,
  runPluginLifecycleHook,
  type ServerPluginRouteContext,
  type ServerRequestTelemetryTracker,
  timeSpan,
} from './pluginLifecycle.js';
import { assertValidPluginNamespace, validateRegisteredPluginDatabases } from './pluginMigrations.js';
import { RecentErrorRingBuffer } from './recentErrorBuffer.js';
import { createAdminRouteHandler } from './routes/adminRoutes.js';
import { createAuthRouteHandler } from './routes/authRoutes.js';
import { createMediaAndTalkRouteHandler } from './routes/mediaAndTalkRoutes.js';
import { createPrivacyAndOgRouteHandler } from './routes/privacyAndOgRoutes.js';
import { createPronunciationRouteHandler } from './routes/pronunciationRoutes.js';
import { createPublicPwaRouteHandler } from './routes/pwaRoutes.js';
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
  hasReadings?: boolean;
  hasMediaChecklist?: boolean;
  bootstrapAdminEmail?: string;
  sessionTtlSeconds?: number;
  oauthCookieTtlSeconds?: number;
  magicLinkTtlMinutes?: number;
  onPluginError?: (pluginId: string, error: unknown) => void;
  compiledPluginRoutes?: readonly CompiledPluginRoute[];
  diagnostics?: KinloomServerDiagnosticsConfig;
}

export interface KinloomServerFetchOptions {
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export interface KinloomServer {
  fetch(request: Request, options?: KinloomServerFetchOptions): Promise<Response>;
}

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_OAUTH_COOKIE_TTL_SECONDS = 10 * 60;

export interface CompiledPluginRoute {
  readonly pluginId: string;
  readonly databaseNamespace?: string;
  readonly method: string;
  readonly normalizedPrefix: string;
  readonly route: KinloomServerPluginRoute;
}

function normalizePluginPathPrefix(raw: string, pluginId: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) {
    throw new RangeError(`Server plugin '${pluginId}' route pathPrefix '${raw}' must start with '/'.`);
  }
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end > 0 ? trimmed.slice(0, end) : '/';
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
  '/api/admin/invites',
  '/api/admin/agent-tokens',
  '/api/admin/users',
  '/api/admin/system',
  '/api/admin/changelogs',
  '/api/admin/docs',
  '/api/admin/plugin-settings',
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

  validateRegisteredPluginDatabases(plugins);

  for (const plugin of plugins) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      throw new RangeError('Server plugin id must be a non-empty string.');
    }
    if (seenPluginIds.has(pluginId)) {
      throw new RangeError(`Duplicate server plugin id '${pluginId}'.`);
    }
    seenPluginIds.add(pluginId);

    if (plugin.documentation !== undefined) {
      validatePluginDocumentation(plugin.documentation, `Server plugin '${pluginId}'`);
    }

    const databaseNamespace =
      plugin.databaseNamespace !== undefined
        ? assertValidPluginNamespace(plugin.databaseNamespace)
        : undefined;

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
        ...(databaseNamespace ? { databaseNamespace } : {}),
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
): CompiledPluginRoute | null {
  const upperMethod = method.toUpperCase();
  for (const compiled of routes) {
    if (compiled.method !== '*' && compiled.method !== upperMethod) {
      continue;
    }
    if (matchesPathPrefix(pathname, compiled.normalizedPrefix)) {
      return compiled;
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
  const documentContributions = compilePluginDocumentContributions(plugins);
  const hasLifecyclePlugins = hasRequestLifecyclePlugins(plugins);
  const hasSecurityPlugins = hasSecurityEventPlugins(plugins);
  const securityPlugins = hasSecurityPlugins
    ? plugins.filter((plugin) => typeof plugin.onSecurityEvent === 'function')
    : [];

  const authService = new AuthService({
    repository: config.ports.repository,
    emailSender: config.ports.emailSender,
    authProvider: config.ports.authProvider,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
    mode,
    hasReadings: config.hasReadings,
    hasMediaChecklist: config.hasMediaChecklist,
    bootstrapAdminEmail: config.bootstrapAdminEmail,
    magicLinkTtlMinutes: config.magicLinkTtlMinutes,
    userOnboardingStore: config.ports.userOnboardingStore,
  });

  const wikiWriteService = new WikiWriteService({
    repository: config.ports.repository,
    bundleCache: config.ports.bundleCache,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
    mediaStore: config.ports.mediaStore,
    pronunciationGenerator: config.ports.pronunciationGenerator,
    pronunciationEnv: config.ports.pronunciationEnv,
    pluginSettingsStore: config.ports.pluginSettingsStore,
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

  const recentErrors =
    config.diagnostics?.recentErrorBuffer ??
    new RecentErrorRingBuffer(config.diagnostics?.recentErrorsCapacity);

  const systemDiagnosticsService = new SystemDiagnosticsService({
    siteConfig: config.siteConfig,
    mode,
    ports: config.ports,
    plugins,
    recentErrors,
    diagnosticsConfig: config.diagnostics,
    onPluginError: config.onPluginError,
  });

  const pluginSettingsService = new PluginSettingsService({
    siteConfig: config.siteConfig,
    mode,
    ports: config.ports,
    plugins,
    store: config.ports.pluginSettingsStore,
    onPluginError: config.onPluginError,
  });

  const pronunciationService = new PronunciationService({
    repository: config.ports.repository,
    mediaStore: config.ports.mediaStore,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
    pronunciationGenerator: config.ports.pronunciationGenerator,
    pronunciationEnv: config.ports.pronunciationEnv,
    pronunciationLexiconStore: config.ports.pronunciationLexiconStore,
    pluginSettingsStore: config.ports.pluginSettingsStore,
  });

  const handlePublicPrivacyOrOg = createPrivacyAndOgRouteHandler({
    siteConfig: config.siteConfig,
    entityStore: config.ports.repository,
    clock: config.ports.clock,
    privacyDisclosures: documentContributions?.privacyDisclosures,
  });

  const handlePublicPwaAsset = createPublicPwaRouteHandler({
    siteConfig: config.siteConfig,
    assetHandler: config.ports.assetHandler,
  });

  const routeHandlers: readonly HttpRouteHandler[] = [
    createAuthRouteHandler({
      authService,
      clock: config.ports.clock,
      sessionSecret: config.sessionSecret,
      sessionTtlSeconds,
      oauthCookieTtlSeconds,
    }),
    createWikiRouteHandler({ bundleReadService, wikiWriteService, mode }),
    createPronunciationRouteHandler({ pronunciationService, mode }),
    createMediaAndTalkRouteHandler({ mediaService, talkService, mode }),
    createAdminRouteHandler(
      adminService,
      systemDiagnosticsService,
      pluginSettingsService,
      new ChangelogService({ plugins, workerVersion: config.diagnostics?.workerVersion }),
      new AdminDocsService({ plugins })
    ),
  ];

  async function handleRequest(
    request: Request,
    telemetry?: ServerRequestTelemetryTracker,
    onPrincipalResolved?: (principal: CallerPrincipal) => void
  ): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();
    const isSecure = isSecureRequestUrl(url);

    const publicDocResponse = await handlePublicPrivacyOrOg({ pathname, method, isSecure });
    if (publicDocResponse !== null) {
      return publicDocResponse;
    }

    const publicPwaResponse = await handlePublicPwaAsset({ request, pathname, method });
    if (publicPwaResponse !== null) {
      return publicPwaResponse;
    }

    const segments = pathname.split('/').filter(Boolean);

    const auth = await resolveCallerPrincipal({
      request,
      url,
      sessionSecret: config.sessionSecret,
      repository: config.ports.repository,
      clock: config.ports.clock,
      telemetry,
    });
    onPrincipalResolved?.(auth.principal);

    const ctx: HttpRequestContext = {
      request,
      url,
      pathname,
      method,
      isSecure,
      segments,
      auth,
      telemetry,
    };

    for (const handle of routeHandlers) {
      const response = await handle(ctx);
      if (response !== null) {
        return response;
      }
    }

    const matchedPluginRoute = matchPluginRoute(pluginRoutes, method, pathname);
    if (matchedPluginRoute) {
      const { route: pluginRoute, pluginId, databaseNamespace } = matchedPluginRoute;
      enforceCsrfOrigin(request, url, auth.authMethod, telemetry);
      const effectiveMinRole =
        pluginRoute.minRole === 'archive_read'
          ? mode === 'public'
            ? 'public'
            : 'viewer'
          : pluginRoute.minRole;
      requireMinRole(auth.principal, effectiveMinRole, {
        mode,
        allowAgentScopes:
          effectiveMinRole === 'viewer'
            ? ['write_batch', 'read_backup']
            : effectiveMinRole === 'editor'
              ? ['write_batch']
              : [],
        adminForbiddenCode: effectiveMinRole === 'admin' ? 'ADMIN_REQUIRED' : 'FORBIDDEN',
        telemetry,
        bearerRejected: auth.bearerRejected,
      });
      const pluginDb =
        databaseNamespace && config.ports.pluginDatabaseFactory
          ? config.ports.pluginDatabaseFactory.forPlugin(pluginId, databaseNamespace)
          : undefined;
      const pluginCtx: ServerPluginRouteContext = {
        request,
        url,
        principal: auth.principal,
        siteConfig: config.siteConfig,
        ports: config.ports,
        mode,
        derivePluginSigningKey: (purpose = 'default') =>
          hmacSignBase64Url(config.sessionSecret, `kinloom-plugin-signing-key:v1:${pluginId}:${purpose}`),
        ...(pluginDb ? { pluginDb } : {}),
        ...(telemetry ? { emitSecurityEvent: (payload) => telemetry.queueSecurityEvent(payload) } : {}),
      };
      return pluginRoute.handle(pluginCtx);
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
          telemetry,
          bearerRejected: auth.bearerRejected,
        });
        const assetHandler = config.ports.assetHandler;
        const dataResponse = await timeSpan(telemetry, 'bundle', () => assetHandler.fetch(request));
        if (telemetry) {
          if (dataResponse.status === 304) {
            telemetry.setCacheStatus('not_modified');
          } else if (dataResponse.status === 200) {
            telemetry.setCacheStatus('hit');
          }
        }
        return dataResponse;
      }
      return config.ports.assetHandler.fetch(request);
    }

    throw new KinloomHttpError(404, 'NOT_FOUND', `Route ${method} ${pathname} was not found.`);
  }

  return {
    async fetch(request: Request, fetchOptions?: KinloomServerFetchOptions): Promise<Response> {
      const url = new URL(request.url);
      const isSecure = isSecureRequestUrl(url);
      const isMediaPath = url.pathname.startsWith('/media/') || url.pathname.startsWith('/sources/');

      if (!hasLifecyclePlugins && !hasSecurityPlugins) {
        try {
          const response = await handleRequest(request);
          return finalizeServerResponse({
            request,
            pathname: url.pathname,
            response,
            isSecure,
            isMediaPath,
            documentContributions,
          });
        } catch (error) {
          const mapped = toErrorResponseData(error);
          recentErrors.record({
            timestamp: config.ports.clock.nowIso(),
            route: normalizeServerRouteTemplate(url.pathname, pluginRoutes, request.method.toUpperCase()),
            status: mapped.status,
            errorCode: mapped.body.error.code,
          });
          return applySecurityHeaders(jsonResponse(mapped.body, mapped.status, mapped.headers), {
            isSecure,
            isMedia: false,
          });
        }
      }

      const method = request.method.toUpperCase();
      const route = normalizeServerRouteTemplate(url.pathname, pluginRoutes, method);
      const tracker = createRequestTelemetryTracker({
        request,
        method,
        route,
        clock: config.ports.clock,
        securityPlugins: hasSecurityPlugins ? securityPlugins : undefined,
        waitUntil: fetchOptions?.waitUntil,
        onPluginError: config.onPluginError,
      });

      if (hasLifecyclePlugins) {
        await runPluginLifecycleHook(
          plugins,
          (plugin) => plugin.onRequestStart,
          { telemetry: tracker.snapshot() },
          config.onPluginError
        );
      }

      let resolvedPrincipal: CallerPrincipal = { kind: 'anonymous' };

      try {
        const response = await handleRequest(request, tracker, (principal) => {
          resolvedPrincipal = principal;
        });
        const secured = await finalizeServerResponse({
          request,
          pathname: url.pathname,
          response,
          isSecure,
          isMediaPath,
          documentContributions,
        });
        await tracker.flushSecurityEvents();
        if (!hasLifecyclePlugins) {
          return secured;
        }
        const durationMs = Math.max(0, tracker.now() - tracker.startedAtMs);
        await runPluginLifecycleHook(
          plugins,
          (plugin) => plugin.onResponse,
          {
            telemetry: tracker.snapshot(),
            response: secured,
            status: secured.status,
            durationMs,
            errorCode: null,
            waitUntil: fetchOptions?.waitUntil,
            reportPluginError: config.onPluginError,
            ports: config.ports,
            siteConfig: config.siteConfig,
            mode,
            principal: resolvedPrincipal,
          },
          config.onPluginError
        );
        return tracker.applyResponseHeaders(secured);
      } catch (error) {
        const mapped = toErrorResponseData(error);
        recentErrors.record({
          timestamp: config.ports.clock.nowIso(),
          route: tracker.snapshot().route,
          status: mapped.status,
          errorCode: mapped.body.error.code,
        });
        const errorResponse = applySecurityHeaders(jsonResponse(mapped.body, mapped.status, mapped.headers), {
          isSecure,
          isMedia: false,
        });
        await tracker.flushSecurityEvents();
        if (!hasLifecyclePlugins) {
          return errorResponse;
        }
        const durationMs = Math.max(0, tracker.now() - tracker.startedAtMs);
        const errorCode = mapped.body.error.code;
        await runPluginLifecycleHook(
          plugins,
          (plugin) => plugin.onError,
          {
            telemetry: tracker.snapshot(),
            error,
            status: mapped.status,
            errorCode,
            durationMs,
          },
          config.onPluginError
        );
        await runPluginLifecycleHook(
          plugins,
          (plugin) => plugin.onResponse,
          {
            telemetry: tracker.snapshot(),
            response: errorResponse,
            status: mapped.status,
            durationMs,
            errorCode,
            waitUntil: fetchOptions?.waitUntil,
            reportPluginError: config.onPluginError,
            ports: config.ports,
            siteConfig: config.siteConfig,
            mode,
            principal: resolvedPrincipal,
          },
          config.onPluginError
        );
        return tracker.applyResponseHeaders(errorResponse);
      }
    },
  };
}
