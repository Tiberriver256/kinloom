import {
  type ServerSecurityEvent,
  type ServerSecurityEventType,
  sanitizeMediaContentType,
} from '../http/securityEvents.js';

export type SecurityTelemetryLogLevel = 'warn' | 'error';

export interface SecurityTelemetryLogRecord {
  readonly event: 'security_event';
  readonly event_type: ServerSecurityEventType;
  readonly timestamp: string;
  readonly level: SecurityTelemetryLogLevel;
  readonly request_id: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly reason: string;
  readonly provider?: 'google';
  readonly required_role?: 'editor' | 'admin';
  readonly actor_kind?: 'anonymous' | 'invite_viewer' | 'user' | 'agent';
  readonly auth_method?: 'cookie' | 'none';
  readonly content_type?: string;
  readonly size_bytes?: number;
  readonly max_bytes?: number;
}

export type SecurityTelemetrySink = (record: SecurityTelemetryLogRecord) => void | Promise<void>;

export type SecurityTelemetryAlertSink = (record: SecurityTelemetryLogRecord) => void | Promise<void>;

export interface SecurityTelemetryOptions {
  /** Must be explicitly true to enable security & abuse telemetry. Off by default. */
  readonly enabled: boolean;
  /** Optional dedicated sink for security_event JSON records. Defaults to console.warn / console.error JSON lines. */
  readonly sink?: SecurityTelemetrySink;
  /**
   * Optional user-supplied alert callback / webhook sink.
   * Strictly fault-isolated: sync throws and async rejections never break or delay HTTP responses.
   */
  readonly alertSink?: SecurityTelemetryAlertSink;
  /** Optional alias for alertSink. */
  readonly onAlert?: SecurityTelemetryAlertSink;
  /**
   * Optional allowlist of event types that invoke alertSink / onAlert.
   * When omitted, all 8 security event types trigger the alert callback if configured.
   */
  readonly alertOn?: readonly ServerSecurityEventType[];
}

export type WorkersSecurityTelemetryOption = boolean | SecurityTelemetryOptions;

const CANONICAL_METHOD_PATTERN = /^[A-Z]{2,16}$/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_PAIR_PATTERN = /\b(?:__Host-)?kinloom_(?:session|oauth)=[^;\s]+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|code|state|secret|email|invite|api_key|key)=)[^&\s#]+/gi;
const AGENT_TOKEN_PATTERN = /\b(?:kin|tok|sess)_[A-Za-z0-9._-]{8,}\b/gi;

function scrubSensitivePatterns(raw: string): string {
  return raw
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(COOKIE_PAIR_PATTERN, '[REDACTED_COOKIE]')
    .replace(QUERY_SECRET_PATTERN, '$1[REDACTED]')
    .replace(AGENT_TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}

function sanitizeSecurityMethod(method: string): string {
  const upper = method.trim().toUpperCase();
  return CANONICAL_METHOD_PATTERN.test(upper) ? upper : 'UNKNOWN';
}

function sanitizeSecurityRoute(route: string): string {
  const withoutQuery = route.split(/[?#]/)[0] ?? '/';
  const redacted = scrubSensitivePatterns(withoutQuery);
  return redacted.startsWith('/') ? redacted : `/${redacted}`;
}

function resolveSecurityLogLevel(status: number): SecurityTelemetryLogLevel {
  return status >= 500 ? 'error' : 'warn';
}

export function defaultSecurityTelemetrySink(record: SecurityTelemetryLogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === 'error') {
    console.error(line);
  } else {
    console.warn(line);
  }
}

export function isSecurityTelemetryEnabled(option: WorkersSecurityTelemetryOption | undefined): boolean {
  if (option === true) {
    return true;
  }
  return typeof option === 'object' && option !== null && option.enabled === true;
}

export function buildSecurityTelemetryLogRecord(params: {
  readonly event: ServerSecurityEvent;
  readonly requestId: string;
  readonly timestamp?: string;
}): SecurityTelemetryLogRecord {
  const { event } = params;
  const base = {
    event: 'security_event' as const,
    event_type: event.type,
    timestamp: params.timestamp ?? event.timestamp,
    level: resolveSecurityLogLevel(event.status),
    request_id: params.requestId,
    method: sanitizeSecurityMethod(event.method),
    route: sanitizeSecurityRoute(event.route),
    status: event.status,
    reason: event.reason,
  };

  switch (event.type) {
    case 'auth.magic_link.rate_limited':
    case 'auth.magic_link.invalid_or_expired':
    case 'auth.invite.invalid':
    case 'auth.agent_token.rejected':
      return base;
    case 'auth.oauth.failed':
      return {
        ...base,
        provider: event.provider,
      };
    case 'auth.write.forbidden':
      return {
        ...base,
        ...(event.requiredRole !== undefined ? { required_role: event.requiredRole } : {}),
        ...(event.actorKind !== undefined ? { actor_kind: event.actorKind } : {}),
      };
    case 'media.upload.rejected':
      return {
        ...base,
        content_type: sanitizeMediaContentType(event.contentType),
        size_bytes: Math.max(0, Math.trunc(event.sizeBytes)),
        ...(event.maxBytes !== undefined ? { max_bytes: Math.max(0, Math.trunc(event.maxBytes)) } : {}),
      };
    case 'csrf.rejected':
      return {
        ...base,
        auth_method: event.authMethod,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function safeReportError(reportError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    reportError?.(error);
  } catch {
    // Isolate error reporter failures so alerts never break HTTP responses.
  }
}

function dispatchAlertCallback(
  callback: SecurityTelemetryAlertSink,
  record: SecurityTelemetryLogRecord,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  reportError: ((error: unknown) => void) | undefined
): void {
  let result: void | Promise<void>;
  try {
    result = callback(record);
  } catch (error) {
    safeReportError(reportError, error);
    return;
  }

  if (result && typeof (result as PromiseLike<void>).then === 'function') {
    const isolatedPromise = Promise.resolve(result).catch((error: unknown) => {
      safeReportError(reportError, error);
    });
    if (waitUntil) {
      try {
        waitUntil(isolatedPromise);
      } catch (error) {
        safeReportError(reportError, error);
      }
    }
  }
}

export function createSecurityTelemetryHandler(params: {
  readonly option: WorkersSecurityTelemetryOption;
  readonly resolveRequestId: (event: ServerSecurityEvent) => string;
  readonly readTimestampIso?: () => string;
}): ((event: ServerSecurityEvent) => Promise<void>) | undefined {
  if (params.option === false) {
    return undefined;
  }

  const normalizedOptions: SecurityTelemetryOptions =
    params.option === true ? { enabled: true } : params.option;
  if (!normalizedOptions.enabled) {
    return undefined;
  }
  const sink: SecurityTelemetrySink = normalizedOptions.sink ?? defaultSecurityTelemetrySink;
  const alertCallback: SecurityTelemetryAlertSink | undefined =
    normalizedOptions.alertSink ?? normalizedOptions.onAlert;
  const alertAllowlist: ReadonlySet<ServerSecurityEventType> | null = normalizedOptions.alertOn
    ? new Set(normalizedOptions.alertOn)
    : null;

  return async (event: ServerSecurityEvent): Promise<void> => {
    const record = buildSecurityTelemetryLogRecord({
      event,
      requestId: params.resolveRequestId(event),
      timestamp: params.readTimestampIso ? params.readTimestampIso() : event.timestamp,
    });

    try {
      await sink(record);
    } catch (error) {
      safeReportError(event.reportError, error);
    }

    if (alertCallback && (!alertAllowlist || alertAllowlist.has(record.event_type))) {
      dispatchAlertCallback(alertCallback, record, event.waitUntil, event.reportError);
    }
  };
}
