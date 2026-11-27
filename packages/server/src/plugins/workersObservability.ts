import type { Clock } from '@kinloom/core';
import type {
  KinloomServerPlugin,
  ServerRequestErrorEvent,
  ServerRequestResponseEvent,
  ServerRequestStartEvent,
  ServerTelemetryCacheStatus,
  ServerTimingSpanName,
} from '../http/pluginLifecycle.js';

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
}

interface PerRequestObservabilityState {
  readonly requestId: string;
  readonly startedAtMs: number | null;
  errorCode: string | null;
}

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_CF_RAY_PATTERN = /^[A-Za-z0-9-]{4,64}$/;
const SUSPICIOUS_TOKEN_PREFIX_PATTERN = /^(?:kin_|tok_|sess_|bearer|jwt_|eyJ)/i;
const CANONICAL_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const CANONICAL_METHOD_PATTERN = /^[A-Z]{2,16}$/;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_PAIR_PATTERN = /\b(?:__Host-)?kinloom_(?:session|oauth)=[^;\s]+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|code|state|secret|email|invite|api_key|key)=)[^&\s#]+/gi;
const AGENT_TOKEN_PATTERN = /\b(?:kin|tok|sess)_[A-Za-z0-9._-]{8,}\b/gi;

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

/**
 * Redacts emails, bearer tokens, Kinloom session/OAuth cookies, agent tokens, and sensitive query parameters.
 */
export function redactObservabilityText(raw: string): string {
  return raw
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(COOKIE_PAIR_PATTERN, '[REDACTED_COOKIE]')
    .replace(QUERY_SECRET_PATTERN, '$1[REDACTED]')
    .replace(AGENT_TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}

export function sanitizeObservabilityErrorCode(code: string | null | undefined): string | null {
  if (!code) {
    return null;
  }
  const trimmed = code.trim();
  if (CANONICAL_ERROR_CODE_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return 'INTERNAL_ERROR';
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

/**
 * Opt-in Kinloom server plugin for Cloudflare Workers Observability.
 * Emits privacy-safe structured JSON logs, X-Request-Id propagation, and RFC Server-Timing headers.
 * Passing `{ enabled: false }` returns an inert no-op plugin with zero lifecycle hooks.
 */
export function createWorkersObservabilityPlugin(
  options: WorkersObservabilityPluginOptions = {}
): KinloomServerPlugin {
  if (options.enabled === false) {
    return {
      id: WORKERS_OBSERVABILITY_PLUGIN_ID,
      name: 'Cloudflare Workers Observability (disabled)',
    };
  }

  const emitServerTiming = options.emitServerTiming ?? true;
  const includeRequestIdHeader = options.includeRequestIdHeader ?? true;
  const sink: WorkersObservabilitySink = options.sink ?? defaultWorkersObservabilitySink;
  const generateRequestId = options.generateRequestId ?? defaultGenerateRequestId;

  function ensureState(telemetry: ServerRequestStartEvent['telemetry']): PerRequestObservabilityState {
    const existing = readState(telemetry.metadata);
    if (existing) {
      return existing;
    }
    const created: PerRequestObservabilityState = {
      requestId: resolveObservabilityRequestId(telemetry.request, generateRequestId),
      startedAtMs: readCustomNowMs(options),
      errorCode: null,
    };
    telemetry.metadata.set(WORKERS_OBSERVABILITY_PLUGIN_ID, created);
    return created;
  }

  return {
    id: WORKERS_OBSERVABILITY_PLUGIN_ID,
    name: 'Cloudflare Workers Observability',

    onRequestStart(event: ServerRequestStartEvent): void {
      ensureState(event.telemetry);
    },

    onError(event: ServerRequestErrorEvent): void {
      const state = ensureState(event.telemetry);
      state.errorCode = sanitizeObservabilityErrorCode(event.errorCode);
    },

    async onResponse(event: ServerRequestResponseEvent): Promise<void> {
      const { telemetry } = event;
      const state = ensureState(telemetry);

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

      const errorCode = sanitizeObservabilityErrorCode(event.errorCode ?? state.errorCode);
      const record: WorkersObservabilityLogRecord = {
        event: 'http_request',
        timestamp: readTimestampIso(options),
        level: resolveLogLevel(event.status),
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
  };
}
