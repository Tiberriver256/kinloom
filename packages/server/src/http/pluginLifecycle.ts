import type {
  Clock,
  KinloomServerPlugin as CoreKinloomServerPlugin,
  KinloomServerPluginContext as CoreKinloomServerPluginContext,
  KinloomServerPorts as CoreKinloomServerPorts,
  KinloomSiteConfig,
} from '@kinloom/core';
import type { PageVisitStatsStore } from '../plugins/pageVisitStatsTypes.js';
import type { ServerDocumentContributions } from './documentContributions.js';
import type { ServerSecurityEvent, ServerSecurityEventPayload } from './securityEvents.js';

export {
  type CompiledDocumentContributions,
  compilePluginDocumentContributions,
  finalizeServerResponse,
  injectHtmlSnippets,
  isHtmlDocumentResponse,
  type ServerDocumentContributions,
  type ServerPrivacyDisclosure,
} from './documentContributions.js';
export {
  type AgentTokenRejectedReason,
  type CsrfRejectedReason,
  type InviteInvalidReason,
  type MagicLinkInvalidReason,
  type MediaUploadRejectedReason,
  type OAuthFailureReason,
  SERVER_SECURITY_EVENT_TYPES,
  type ServerSecurityEvent,
  type ServerSecurityEventBase,
  type ServerSecurityEventPayload,
  type ServerSecurityEventType,
  sanitizeMediaContentType,
  type WriteForbiddenReason,
} from './securityEvents.js';

export type ServerTimingSpanName = 'd1' | 'r2' | 'bundle' | 'total';
export type RecordableServerTimingSpanName = Exclude<ServerTimingSpanName, 'total'>;
export type ServerTelemetryCacheStatus = 'hit' | 'miss' | 'not_modified' | 'bypass';

export interface ServerRequestTelemetryContext {
  readonly request: Request;
  readonly method: string;
  readonly route: string;
  readonly isApiOrBundleRoute: boolean;
  readonly startedAtMs: number;
  readonly spans: Readonly<Partial<Record<ServerTimingSpanName, number>>>;
  readonly cacheStatus: ServerTelemetryCacheStatus | null;
  readonly bundleRevision: number | null;
  readonly responseHeaders: Headers;
  readonly metadata: Map<string, unknown>;
}

export interface ServerRequestStartEvent {
  readonly telemetry: ServerRequestTelemetryContext;
}

export interface ServerRequestResponseEvent {
  readonly telemetry: ServerRequestTelemetryContext;
  readonly response: Response;
  readonly status: number;
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly reportPluginError?: (pluginId: string, error: unknown) => void;
  readonly ports?: KinloomServerPorts;
  readonly siteConfig?: KinloomSiteConfig;
  readonly mode?: 'private' | 'public';
}

export interface ServerRequestErrorEvent {
  readonly telemetry: ServerRequestTelemetryContext;
  readonly error: unknown;
  readonly status: number;
  readonly errorCode: string;
  readonly durationMs: number;
}

export interface ServerPluginObservabilityFlags {
  readonly enabled: boolean;
  readonly serverTiming: boolean;
  readonly securityTelemetry: boolean;
  readonly webAnalytics: boolean;
}

export interface ServerPluginRouteContext extends CoreKinloomServerPluginContext {
  readonly emitSecurityEvent?: (payload: ServerSecurityEventPayload) => void;
}

export function hasSecurityEventEmitter(
  ctx: CoreKinloomServerPluginContext
): ctx is ServerPluginRouteContext & {
  readonly emitSecurityEvent: (payload: ServerSecurityEventPayload) => void;
} {
  return (
    'emitSecurityEvent' in ctx && typeof (ctx as ServerPluginRouteContext).emitSecurityEvent === 'function'
  );
}

export interface KinloomServerPlugin extends CoreKinloomServerPlugin {
  readonly documentContributions?: ServerDocumentContributions;
  readonly observabilityFlags?: ServerPluginObservabilityFlags;
  onRequestStart?(event: ServerRequestStartEvent): void | Promise<void>;
  onResponse?(event: ServerRequestResponseEvent): void | Promise<void>;
  onError?(event: ServerRequestErrorEvent): void | Promise<void>;
  onSecurityEvent?(event: ServerSecurityEvent): void | Promise<void>;
}

export interface KinloomServerPorts extends Omit<CoreKinloomServerPorts, 'plugins'> {
  plugins?: readonly KinloomServerPlugin[];
  pageVisitStatsStore?: PageVisitStatsStore;
}

export interface CompiledRoutePrefixMatcher {
  readonly method: string;
  readonly normalizedPrefix: string;
}

export interface ServerRequestTelemetryTracker {
  readonly startedAtMs: number;
  readonly hasSecuritySubscribers: boolean;
  now(): number;
  recordSpan(span: RecordableServerTimingSpanName, durationMs: number): void;
  setRoute(route: string): void;
  setCacheStatus(status: ServerTelemetryCacheStatus): void;
  setBundleRevision(revision: number | null): void;
  queueSecurityEvent(payload: ServerSecurityEventPayload): void;
  flushSecurityEvents(): Promise<void>;
  snapshot(): ServerRequestTelemetryContext;
  applyResponseHeaders(response: Response): Response;
}

const EXACT_STATIC_ROUTES = new Set<string>([
  '/',
  '/api/bundle',
  '/api/revisions',
  '/api/batches',
  '/api/export/yaml',
  '/api/export/snapshot',
  '/api/auth/me',
  '/api/auth/google/start',
  '/api/auth/google/callback',
  '/api/auth/magic-link/request',
  '/api/auth/magic-link/verify',
  '/api/auth/logout',
  '/api/media/upload',
  '/api/pronunciation/generate',
  '/api/pronunciations',
  '/api/admin/invites',
  '/api/admin/agent-tokens',
  '/api/admin/users',
  '/api/admin/system',
  '/api/admin/plugin-settings',
  '/api/admin/observability/stats',
  '/api/observability/page-visits',
  '/privacy',
  '/og/site.svg',
  '/data/bundle.json',
  '/favicon.ico',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/site.webmanifest',
  '/index.html',
  '/people',
  '/places',
  '/timeline',
  '/tree',
  '/map',
  '/kinship',
  '/evidence',
  '/changes',
  '/admin',
  '/login',
]);

function matchesPrefixBoundary(pathname: string, normalizedPrefix: string): boolean {
  if (normalizedPrefix === '/') {
    return pathname.startsWith('/');
  }
  return pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`);
}

function normalizePathWithoutTrailingSlash(pathname: string): string {
  if (pathname === '/' || pathname === '') {
    return '/';
  }
  const stripped = pathname.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : '/';
}

/**
 * Maps a raw HTTP pathname to a bounded-cardinality route template so dynamic entity IDs,
 * user emails, invite tokens, media keys, and living-person slugs never appear in telemetry.
 */
export function normalizeServerRouteTemplate(
  pathname: string,
  compiledPluginRoutes?: readonly CompiledRoutePrefixMatcher[],
  method?: string
): string {
  const cleanPath = normalizePathWithoutTrailingSlash(pathname);

  if (EXACT_STATIC_ROUTES.has(cleanPath)) {
    return cleanPath;
  }

  const segments = cleanPath.split('/').filter(Boolean);

  if (segments[0] === 'api') {
    const domain = segments[1];
    if (domain === 'entities') {
      if (segments.length === 3) {
        return '/api/entities/:type';
      }
      if (segments.length === 4) {
        return '/api/entities/:type/:id';
      }
      if (segments.length === 5 && segments[4] === 'restore') {
        return '/api/entities/:type/:id/restore';
      }
      return '/api/entities/*';
    }
    if (domain === 'revisions' && segments.length === 4 && segments[3] === 'revert') {
      return '/api/revisions/:id/revert';
    }
    if (domain === 'batches' && segments.length === 4 && segments[3] === 'revert') {
      return '/api/batches/:id/revert';
    }
    if (domain === 'auth' && segments[2] === 'invite' && segments.length === 4) {
      return '/api/auth/invite/:token';
    }
    if (domain === 'media') {
      if (segments.length === 3) {
        return '/api/media/:id';
      }
      return '/api/media/*';
    }
    if (domain === 'talk') {
      if (segments.length === 4) {
        return '/api/talk/:type/:id';
      }
      if (segments.length === 5) {
        return '/api/talk/:type/:id/:commentId';
      }
      return '/api/talk/*';
    }
    if (domain === 'admin') {
      if (segments[2] === 'invites' && segments.length === 4) {
        return '/api/admin/invites/:token';
      }
      if (segments[2] === 'agent-tokens' && segments.length === 4) {
        return '/api/admin/agent-tokens/:id';
      }
      if (segments[2] === 'users' && segments.length === 4) {
        return '/api/admin/users/:email';
      }
      if (segments[2] === 'plugin-settings' && segments.length === 4) {
        return '/api/admin/plugin-settings/:pluginId';
      }
      return '/api/admin/*';
    }
    if (domain === 'pronunciations' && segments.length === 3) {
      return '/api/pronunciations/:term';
    }
  }

  if (segments[0] === 'invite' && segments.length === 2) {
    return '/invite/:token';
  }
  if (segments[0] === 'media' && segments.length >= 2) {
    return '/media/:key';
  }
  if (segments[0] === 'sources' && segments.length >= 2) {
    return '/sources/:key';
  }
  if (segments[0] === 'og' && segments[1] === 'person' && segments.length === 3) {
    return '/og/person/:id.svg';
  }
  if (segments[0] === 'data' && segments.length >= 2) {
    return '/data/:file';
  }
  if (segments[0] === 'assets' && segments.length >= 2) {
    return '/assets/:asset';
  }
  if ((segments[0] === 'people' || segments[0] === 'person') && segments.length >= 2) {
    return `/${segments[0]}/:slug`;
  }
  if ((segments[0] === 'places' || segments[0] === 'place') && segments.length >= 2) {
    return `/${segments[0]}/:slug`;
  }

  if (compiledPluginRoutes && compiledPluginRoutes.length > 0) {
    const upperMethod = method ? method.toUpperCase() : '*';
    for (const compiled of compiledPluginRoutes) {
      if (compiled.method !== '*' && upperMethod !== '*' && compiled.method !== upperMethod) {
        continue;
      }
      if (matchesPrefixBoundary(cleanPath, compiled.normalizedPrefix)) {
        return cleanPath === compiled.normalizedPrefix
          ? compiled.normalizedPrefix
          : `${compiled.normalizedPrefix}/*`;
      }
    }
  }

  if (segments[0] === 'api') {
    return '/api/*';
  }
  return '/*';
}

export function isApiOrBundleRoute(route: string): boolean {
  return (
    route.startsWith('/api/') ||
    route.startsWith('/data/') ||
    route.startsWith('/media/') ||
    route.startsWith('/sources/')
  );
}

function readHighResNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function createRequestTelemetryTracker(params: {
  request: Request;
  method: string;
  route: string;
  clock?: Clock;
  securityPlugins?: readonly KinloomServerPlugin[];
  waitUntil?: (promise: Promise<unknown>) => void;
  onPluginError?: (pluginId: string, error: unknown) => void;
}): ServerRequestTelemetryTracker {
  const startedAtMs = readHighResNow();
  const spans: Partial<Record<ServerTimingSpanName, number>> = {};
  const responseHeaders = new Headers();
  const metadata = new Map<string, unknown>();
  const securityPlugins = params.securityPlugins ?? [];
  const hasSecuritySubscribers = securityPlugins.length > 0;
  const pendingSecurityEvents: Array<{ timestamp: string; payload: ServerSecurityEventPayload }> = [];
  let currentRoute = params.route;
  let cacheStatus: ServerTelemetryCacheStatus | null = null;
  let bundleRevision: number | null = null;

  function reportPluginError(pluginId: string, error: unknown): void {
    try {
      params.onPluginError?.(pluginId, error);
    } catch {
      // Isolate reporter failures so telemetry never fails user requests.
    }
  }

  return {
    startedAtMs,
    hasSecuritySubscribers,
    now: readHighResNow,
    recordSpan(span: RecordableServerTimingSpanName, durationMs: number): void {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        return;
      }
      spans[span] = (spans[span] ?? 0) + durationMs;
    },
    setRoute(route: string): void {
      currentRoute = route;
    },
    setCacheStatus(status: ServerTelemetryCacheStatus): void {
      cacheStatus = status;
    },
    setBundleRevision(revision: number | null): void {
      if (revision === null) {
        bundleRevision = null;
        return;
      }
      if (Number.isSafeInteger(revision) && revision >= 0) {
        bundleRevision = revision;
      }
    },
    queueSecurityEvent(payload: ServerSecurityEventPayload): void {
      if (!hasSecuritySubscribers) {
        return;
      }
      const timestamp = params.clock ? params.clock.nowIso() : new Date().toISOString();
      pendingSecurityEvents.push({ timestamp, payload });
    },
    async flushSecurityEvents(): Promise<void> {
      if (!hasSecuritySubscribers || pendingSecurityEvents.length === 0) {
        return;
      }
      const batch = pendingSecurityEvents.splice(0, pendingSecurityEvents.length);
      for (const item of batch) {
        for (const plugin of securityPlugins) {
          const hook = plugin.onSecurityEvent;
          if (!hook) {
            continue;
          }
          const event: ServerSecurityEvent = {
            ...item.payload,
            timestamp: item.timestamp,
            method: params.method,
            route: currentRoute,
            request: params.request,
            metadata,
            waitUntil: params.waitUntil,
            reportError: (error: unknown) => reportPluginError(plugin.id, error),
          };
          try {
            await hook(event);
          } catch (error) {
            reportPluginError(plugin.id, error);
          }
        }
      }
    },
    snapshot(): ServerRequestTelemetryContext {
      return {
        request: params.request,
        method: params.method,
        route: currentRoute,
        isApiOrBundleRoute: isApiOrBundleRoute(currentRoute),
        startedAtMs,
        spans: { ...spans },
        cacheStatus,
        bundleRevision,
        responseHeaders,
        metadata,
      };
    },
    applyResponseHeaders(response: Response): Response {
      let hasAny = false;
      responseHeaders.forEach(() => {
        hasAny = true;
      });
      if (!hasAny) {
        return response;
      }
      const merged = new Headers(response.headers);
      responseHeaders.forEach((value, key) => {
        if (key === 'server-timing' && merged.has(key)) {
          merged.append(key, value);
        } else {
          merged.set(key, value);
        }
      });
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: merged,
      });
    },
  };
}

export async function timeSpan<T>(
  telemetry: Pick<ServerRequestTelemetryTracker, 'now' | 'recordSpan'> | undefined,
  span: RecordableServerTimingSpanName,
  fn: () => Promise<T>
): Promise<T> {
  if (!telemetry) {
    return fn();
  }
  const start = telemetry.now();
  try {
    return await fn();
  } finally {
    const elapsed = telemetry.now() - start;
    telemetry.recordSpan(span, Math.max(0, elapsed));
  }
}

export function hasRequestLifecyclePlugins(plugins: readonly KinloomServerPlugin[]): boolean {
  return plugins.some(
    (plugin) =>
      typeof plugin.onRequestStart === 'function' ||
      typeof plugin.onResponse === 'function' ||
      typeof plugin.onError === 'function'
  );
}

export function hasSecurityEventPlugins(plugins: readonly KinloomServerPlugin[]): boolean {
  return plugins.some((plugin) => typeof plugin.onSecurityEvent === 'function');
}

export async function runPluginLifecycleHook<TEvent>(
  plugins: readonly KinloomServerPlugin[],
  getHook: (plugin: KinloomServerPlugin) => ((event: TEvent) => void | Promise<void>) | undefined,
  event: TEvent,
  onPluginError?: (pluginId: string, error: unknown) => void
): Promise<void> {
  for (const plugin of plugins) {
    const hook = getHook(plugin);
    if (!hook) {
      continue;
    }
    try {
      await hook(event);
    } catch (error) {
      try {
        onPluginError?.(plugin.id, error);
      } catch {
        // Isolate reporter failures so telemetry never fails user requests.
      }
    }
  }
}
