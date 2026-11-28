import type {
  Clock,
  KinloomServerPluginReadonlySettingsContext,
  PluginSettingScalarValue,
  PluginSettingsSchema,
} from '@kinloom/core';
import type {
  KinloomServerPlugin,
  ServerRequestErrorEvent,
  ServerRequestResponseEvent,
  ServerRequestStartEvent,
  ServerSecurityEvent,
  ServerTelemetryCacheStatus,
  ServerTimingSpanName,
} from '../http/pluginLifecycle.js';
import { redactObservabilityText, sanitizeObservabilityErrorCode } from '../http/redaction.js';
import { KINLOOM_SERVER_VERSION } from '../version.js';
import { createSecurityTelemetryHandler, type WorkersSecurityTelemetryOption } from './securityTelemetry.js';
import { createWebAnalyticsDocumentContributions, type WebAnalyticsOptions } from './webAnalytics.js';

export {
  buildSecurityTelemetryLogRecord,
  createSecurityTelemetryHandler,
  defaultSecurityTelemetrySink,
  isSecurityTelemetryEnabled,
  type SecurityTelemetryAlertSink,
  type SecurityTelemetryLogLevel,
  type SecurityTelemetryLogRecord,
  type SecurityTelemetryOptions,
  type SecurityTelemetrySink,
  type WorkersSecurityTelemetryOption,
} from './securityTelemetry.js';
export {
  CLOUDFLARE_WEB_ANALYTICS_BEACON_URL,
  CLOUDFLARE_WEB_ANALYTICS_CONNECT_ORIGIN,
  CLOUDFLARE_WEB_ANALYTICS_PRIVACY_DISCLOSURE_ID,
  CLOUDFLARE_WEB_ANALYTICS_PRIVACY_SUMMARY,
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN,
  type CloudflareWebAnalyticsToken,
  createWebAnalyticsDocumentContributions,
  isCloudflareWebAnalyticsToken,
  isWebAnalyticsEnabled,
  renderCloudflareWebAnalyticsBeaconHtml,
  validateCloudflareWebAnalyticsToken,
  type WebAnalyticsOptions,
} from './webAnalytics.js';
export { redactObservabilityText, sanitizeObservabilityErrorCode };

export const WORKERS_OBSERVABILITY_PLUGIN_ID = 'kinloom-workers-observability';

export type WorkersObservabilityLogLevel = 'info' | 'warn' | 'error';

export interface WorkersObservabilityLogRecord {
  readonly event: 'http_request';
  readonly timestamp: string;
  readonly level: WorkersObservabilityLogLevel;
  readonly request_id: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly duration_ms: number;
  readonly cache_status: ServerTelemetryCacheStatus | null;
  readonly bundle_revision: number | null;
  readonly error_code: string | null;
  readonly spans_ms?: Readonly<Partial<Record<ServerTimingSpanName, number>>>;
}

export type WorkersObservabilitySink = (record: WorkersObservabilityLogRecord) => void | Promise<void>;

export interface WorkersObservabilityPluginOptions {
  /**
   * When false, returns a no-op plugin with zero lifecycle hooks, zero headers, and zero logs.
   * Defaults to true when the factory is explicitly invoked.
   */
  readonly enabled?: boolean;
  /** Emit RFC Server-Timing headers on API and bundle responses. Defaults to true. */
  readonly emitServerTiming?: boolean;
  /** Emit X-Request-Id response headers. Defaults to true. */
  readonly includeRequestIdHeader?: boolean;
  /** Structured JSON log sink. Defaults to console.log / console.error JSON lines. */
  readonly sink?: WorkersObservabilitySink;
  /** Optional Clock for deterministic ISO timestamps and elapsed timing fallback. */
  readonly clock?: Clock;
  /** Optional monotonic/millisecond timestamp function for deterministic duration measurement. */
  readonly now?: () => number;
  /** Optional request ID generator fallback when no safe incoming request ID or cf-ray exists. */
  readonly generateRequestId?: () => string;
  /**
   * Opt-in security and abuse telemetry (structured security_event logs and fault-isolated alert sink).
   * Strictly OFF by default even when createWorkersObservabilityPlugin() is registered.
   */
  readonly securityTelemetry?: WorkersSecurityTelemetryOption;
  /**
   * Opt-in privacy-first Cloudflare Web Analytics (RUM and Core Web Vitals).
   * Strictly OFF by default even when createWorkersObservabilityPlugin() is registered.
   */
  readonly webAnalytics?: WebAnalyticsOptions;
}

interface PerRequestObservabilityState {
  readonly requestId: string;
  readonly startedAtMs: number | null;
  errorCode: string | null;
}

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_CF_RAY_PATTERN = /^[A-Za-z0-9-]{4,64}$/;
const SUSPICIOUS_TOKEN_PREFIX_PATTERN = /^(?:kin_|tok_|sess_|bearer|jwt_|eyJ)/i;
const CANONICAL_METHOD_PATTERN = /^[A-Z]{2,16}$/;

const SERVER_TIMING_ORDER: readonly ServerTimingSpanName[] = ['d1', 'r2', 'bundle', 'total'];

function roundDurationMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatDurationNumber(value: number): string {
  const rounded = roundDurationMs(value);
  return String(Number(rounded.toFixed(2)));
}

function sanitizeMethod(method: string): string {
  const upper = method.trim().toUpperCase();
  return CANONICAL_METHOD_PATTERN.test(upper) ? upper : 'UNKNOWN';
}

function sanitizeRouteForLog(route: string): string {
  const withoutQuery = route.split(/[?#]/)[0] ?? '/';
  const redacted = redactObservabilityText(withoutQuery);
  return redacted.startsWith('/') ? redacted : `/${redacted}`;
}

function isSafeIncomingRequestId(raw: string | null): raw is string {
  if (!raw) {
    return false;
  }
  const trimmed = raw.trim();
  if (!SAFE_REQUEST_ID_PATTERN.test(trimmed)) {
    return false;
  }
  if (SUSPICIOUS_TOKEN_PREFIX_PATTERN.test(trimmed)) {
    return false;
  }
  return true;
}

function isSafeCfRay(raw: string | null): raw is string {
  if (!raw) {
    return false;
  }
  return SAFE_CF_RAY_PATTERN.test(raw.trim());
}

function defaultGenerateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Propagates a validated incoming X-Request-Id or Cloudflare cf-ray header,
 * falling back to a generated UUID when absent or unsafe.
 */
export function resolveObservabilityRequestId(
  request: Request,
  generateRequestId: () => string = defaultGenerateRequestId
): string {
  const incomingRequestId = request.headers.get('x-request-id');
  if (isSafeIncomingRequestId(incomingRequestId)) {
    return incomingRequestId.trim();
  }
  const cfRay = request.headers.get('cf-ray');
  if (isSafeCfRay(cfRay)) {
    return cfRay.trim();
  }
  const generated = generateRequestId();
  return isSafeIncomingRequestId(generated) ? generated.trim() : defaultGenerateRequestId();
}

/**
 * Formats a W3C/RFC Server-Timing header value from recorded span durations in canonical order.
 */
export function formatServerTimingHeader(
  spans: Readonly<Partial<Record<ServerTimingSpanName, number>>>
): string {
  const parts: string[] = [];
  for (const name of SERVER_TIMING_ORDER) {
    const duration = spans[name];
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      parts.push(`${name};dur=${formatDurationNumber(duration)}`);
    }
  }
  return parts.join(', ');
}

function defaultWorkersObservabilitySink(record: WorkersObservabilityLogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function resolveLogLevel(status: number): WorkersObservabilityLogLevel {
  if (status >= 500) {
    return 'error';
  }
  if (status >= 400) {
    return 'warn';
  }
  return 'info';
}

function readTimestampIso(options: WorkersObservabilityPluginOptions): string {
  if (options.clock) {
    return options.clock.nowIso();
  }
  return new Date().toISOString();
}

function readCustomNowMs(options: WorkersObservabilityPluginOptions): number | null {
  if (options.now) {
    return options.now();
  }
  return null;
}

function readState(metadata: Map<string, unknown>): PerRequestObservabilityState | null {
  const raw = metadata.get(WORKERS_OBSERVABILITY_PLUGIN_ID);
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'requestId' in raw &&
    typeof (raw as { requestId: unknown }).requestId === 'string'
  ) {
    return raw as PerRequestObservabilityState;
  }
  return null;
}

const LOG_LEVEL_SEVERITY: Readonly<Record<WorkersObservabilityLogLevel, number>> = {
  info: 0,
  warn: 1,
  error: 2,
};

function isLogLevel(value: unknown): value is WorkersObservabilityLogLevel {
  return value === 'info' || value === 'warn' || value === 'error';
}

function buildWorkersObservabilitySettingsSchema(defaults: {
  readonly emitServerTiming: boolean;
  readonly includeRequestIdHeader: boolean;
  readonly minLogLevel: WorkersObservabilityLogLevel;
}): PluginSettingsSchema {
  return {
    title: 'Cloudflare Backend & Observability',
    description:
      'Inspect active Cloudflare runtime bindings and observability capabilities, and adjust safe request telemetry toggles.',
    sections: [
      {
        id: 'runtime_status',
        title: 'Runtime & Backend Status',
        description:
          'Read-only status derived from the active server ports and Worker deployment configuration.',
        fields: [
          {
            key: 'runtime_platform',
            label: 'Runtime Platform',
            type: 'readonly',
            defaultValue: 'portable-server',
          },
          {
            key: 'storage_bindings',
            label: 'Active Storage & Email Bindings',
            type: 'readonly',
            defaultValue: 'in-memory',
          },
          {
            key: 'observability_status',
            label: 'Observability Status',
            type: 'readonly',
            defaultValue: 'active',
          },
          {
            key: 'server_timing_status',
            label: 'Server-Timing Header',
            type: 'readonly',
            defaultValue: defaults.emitServerTiming ? 'enabled' : 'disabled',
          },
          {
            key: 'security_telemetry_status',
            label: 'Security Telemetry',
            type: 'readonly',
            defaultValue: 'disabled',
          },
          {
            key: 'web_analytics_status',
            label: 'Cloudflare Web Analytics',
            type: 'readonly',
            defaultValue: 'disabled',
          },
        ],
      },
      {
        id: 'telemetry_controls',
        title: 'Safe Telemetry Controls',
        description: 'Runtime toggles for privacy-safe HTTP telemetry headers and structured log verbosity.',
        fields: [
          {
            key: 'emit_server_timing',
            label: 'Emit Server-Timing headers',
            type: 'boolean',
            defaultValue: defaults.emitServerTiming,
            helpText:
              'Include W3C Server-Timing span durations (d1, r2, bundle, total) on API and bundle responses.',
          },
          {
            key: 'include_request_id_header',
            label: 'Include X-Request-Id header',
            type: 'boolean',
            defaultValue: defaults.includeRequestIdHeader,
            helpText: 'Propagate or generate a privacy-safe X-Request-Id correlation header on responses.',
          },
          {
            key: 'log_level_threshold',
            label: 'Minimum Structured Log Level',
            type: 'select',
            required: true,
            defaultValue: defaults.minLogLevel,
            helpText: 'Filter structured http_request telemetry logs by minimum severity level.',
            options: [
              { value: 'info', label: 'Info (all requests)' },
              { value: 'warn', label: 'Warn (4xx and 5xx only)' },
              { value: 'error', label: 'Error (5xx only)' },
            ],
          },
        ],
      },
    ],
  };
}

function buildWorkersReadonlySettings(
  ctx: KinloomServerPluginReadonlySettingsContext,
  state: {
    readonly enabled: boolean;
    readonly emitServerTiming: boolean;
    readonly securityTelemetry: boolean;
    readonly webAnalytics: boolean;
  }
): Readonly<Record<string, PluginSettingScalarValue>> {
  const isWorkers = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
  const hasCloudflareAdapter =
    ctx.ports.repository.adapterKind === 'd1' ||
    ctx.ports.bundleCache.adapterKind === 'r2' ||
    ctx.ports.mediaStore.adapterKind === 'r2';
  const platformLabel = isWorkers || hasCloudflareAdapter ? 'cloudflare-workers' : 'portable-server';
  const bindingsSummary = [
    `repository=${ctx.ports.repository.adapterKind ?? 'custom'}`,
    `bundle_cache=${ctx.ports.bundleCache.adapterKind ?? 'custom'}`,
    `media_store=${ctx.ports.mediaStore.adapterKind ?? 'custom'}`,
    `email=${ctx.ports.emailSender.adapterKind ?? 'custom'}`,
  ].join(', ');

  return {
    runtime_platform: platformLabel,
    storage_bindings: bindingsSummary,
    observability_status: state.enabled ? 'active' : 'disabled',
    server_timing_status: state.enabled && state.emitServerTiming ? 'enabled' : 'disabled',
    security_telemetry_status: state.enabled && state.securityTelemetry ? 'enabled' : 'disabled',
    web_analytics_status: state.enabled && state.webAnalytics ? 'enabled' : 'disabled',
  };
}

/**
 * Opt-in Kinloom server plugin for Cloudflare Workers Observability.
 * Emits privacy-safe structured JSON logs, X-Request-Id propagation, and RFC Server-Timing headers.
 * Passing `{ enabled: false }` returns an inert no-op plugin with zero lifecycle hooks.
 */
export function createWorkersObservabilityPlugin(
  options: WorkersObservabilityPluginOptions = {}
): KinloomServerPlugin {
  if (options.enabled === false) {
    const disabledSchema = buildWorkersObservabilitySettingsSchema({
      emitServerTiming: false,
      includeRequestIdHeader: false,
      minLogLevel: 'info',
    });
    return {
      id: WORKERS_OBSERVABILITY_PLUGIN_ID,
      name: 'Cloudflare Workers Observability (disabled)',
      version: KINLOOM_SERVER_VERSION,
      changelog: [
        {
          version: '0.61.0',
          date: '2026-11-28',
          summary: 'X-Request-Id, Server-Timing headers, and structured request telemetry.',
          changes: [
            {
              category: 'added',
              text: 'X-Request-Id, Server-Timing headers, and structured request telemetry.',
            },
          ],
        },
      ],
      status: 'disabled',
      settingsSchema: disabledSchema,
      observabilityFlags: {
        enabled: false,
        serverTiming: false,
        securityTelemetry: false,
        webAnalytics: false,
      },
      getStatus: () => ({ status: 'disabled', detail: 'Disabled via plugin options' }),
      getReadonlySettings: (ctx) =>
        buildWorkersReadonlySettings(ctx, {
          enabled: false,
          emitServerTiming: false,
          securityTelemetry: false,
          webAnalytics: false,
        }),
    };
  }

  let emitServerTiming = options.emitServerTiming ?? true;
  let includeRequestIdHeader = options.includeRequestIdHeader ?? true;
  let minLogLevel: WorkersObservabilityLogLevel = 'info';
  const sink: WorkersObservabilitySink = options.sink ?? defaultWorkersObservabilitySink;
  const generateRequestId = options.generateRequestId ?? defaultGenerateRequestId;
  const settingsSchema = buildWorkersObservabilitySettingsSchema({
    emitServerTiming,
    includeRequestIdHeader,
    minLogLevel,
  });

  function ensureState(request: Request, metadata: Map<string, unknown>): PerRequestObservabilityState {
    const existing = readState(metadata);
    if (existing) {
      return existing;
    }
    const created: PerRequestObservabilityState = {
      requestId: resolveObservabilityRequestId(request, generateRequestId),
      startedAtMs: readCustomNowMs(options),
      errorCode: null,
    };
    metadata.set(WORKERS_OBSERVABILITY_PLUGIN_ID, created);
    return created;
  }

  const securityEventHandler = options.securityTelemetry
    ? createSecurityTelemetryHandler({
        option: options.securityTelemetry,
        resolveRequestId: (event: ServerSecurityEvent) =>
          ensureState(event.request, event.metadata).requestId,
        readTimestampIso: () => readTimestampIso(options),
      })
    : undefined;

  const documentContributions = createWebAnalyticsDocumentContributions(options.webAnalytics);

  function describeActiveFeatures(): string {
    const activeFeatures: string[] = [];
    if (emitServerTiming) {
      activeFeatures.push('server-timing');
    }
    if (includeRequestIdHeader) {
      activeFeatures.push('request-id');
    }
    if (securityEventHandler) {
      activeFeatures.push('security-telemetry');
    }
    if (documentContributions) {
      activeFeatures.push('web-analytics');
    }
    return activeFeatures.length > 0 ? activeFeatures.join(', ') : 'structured-logs';
  }

  return {
    id: WORKERS_OBSERVABILITY_PLUGIN_ID,
    name: 'Cloudflare Workers Observability',
    version: KINLOOM_SERVER_VERSION,
    status: 'active',
    settingsSchema,
    get observabilityFlags() {
      return {
        enabled: true,
        serverTiming: emitServerTiming,
        securityTelemetry: Boolean(securityEventHandler),
        webAnalytics: Boolean(documentContributions),
      };
    },
    getStatus: () => ({
      status: 'active',
      detail: describeActiveFeatures(),
    }),
    getReadonlySettings: (ctx) =>
      buildWorkersReadonlySettings(ctx, {
        enabled: true,
        emitServerTiming,
        securityTelemetry: Boolean(securityEventHandler),
        webAnalytics: Boolean(documentContributions),
      }),
    onSettingsUpdated: (event) => {
      if (typeof event.values.emit_server_timing === 'boolean') {
        emitServerTiming = event.values.emit_server_timing;
      }
      if (typeof event.values.include_request_id_header === 'boolean') {
        includeRequestIdHeader = event.values.include_request_id_header;
      }
      if (isLogLevel(event.values.log_level_threshold)) {
        minLogLevel = event.values.log_level_threshold;
      }
    },
    ...(documentContributions ? { documentContributions } : {}),

    onRequestStart(event: ServerRequestStartEvent): void {
      ensureState(event.telemetry.request, event.telemetry.metadata);
    },

    onError(event: ServerRequestErrorEvent): void {
      const state = ensureState(event.telemetry.request, event.telemetry.metadata);
      state.errorCode = sanitizeObservabilityErrorCode(event.errorCode);
    },

    async onResponse(event: ServerRequestResponseEvent): Promise<void> {
      const { telemetry } = event;
      const state = ensureState(telemetry.request, telemetry.metadata);

      const endCustomMs = readCustomNowMs(options);
      const rawDurationMs =
        state.startedAtMs !== null && endCustomMs !== null
          ? Math.max(0, endCustomMs - state.startedAtMs)
          : Math.max(0, event.durationMs);
      const durationMs = roundDurationMs(rawDurationMs);

      const spansWithTotal: Partial<Record<ServerTimingSpanName, number>> = {};
      for (const spanName of ['d1', 'r2', 'bundle'] as const) {
        const value = telemetry.spans[spanName];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          spansWithTotal[spanName] = roundDurationMs(value);
        }
      }
      spansWithTotal.total = durationMs;

      if (includeRequestIdHeader) {
        telemetry.responseHeaders.set('x-request-id', state.requestId);
      }

      if (emitServerTiming && telemetry.isApiOrBundleRoute) {
        const headerValue = formatServerTimingHeader(spansWithTotal);
        if (headerValue) {
          telemetry.responseHeaders.set('server-timing', headerValue);
        }
      }

      const level = resolveLogLevel(event.status);
      if (LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[minLogLevel]) {
        return;
      }

      const errorCode = sanitizeObservabilityErrorCode(event.errorCode ?? state.errorCode);
      const record: WorkersObservabilityLogRecord = {
        event: 'http_request',
        timestamp: readTimestampIso(options),
        level,
        request_id: state.requestId,
        method: sanitizeMethod(telemetry.method),
        route: sanitizeRouteForLog(telemetry.route),
        status: event.status,
        duration_ms: durationMs,
        cache_status: telemetry.cacheStatus,
        bundle_revision: telemetry.bundleRevision,
        error_code: errorCode,
        spans_ms: spansWithTotal,
      };

      await sink(record);
    },

    ...(securityEventHandler ? { onSecurityEvent: securityEventHandler } : {}),
  };
}
