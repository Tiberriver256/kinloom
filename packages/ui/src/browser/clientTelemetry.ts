export type ClientErrorKind =
  | 'react_boundary'
  | 'window_error'
  | 'unhandled_rejection'
  | 'chunk_preload'
  | 'blank_screen';

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string | undefined;
  componentStack?: string | undefined;
  route: string;
  buildId: string;
  assetUrl?: string | undefined;
  timestamp: string;
}

export type ClientTelemetryTransport = (payload: string) => void;

export interface ClientTelemetryOptions {
  /** Optional HTTP endpoint URL to receive JSON error reports via sendBeacon/fetch. */
  endpoint?: string;
  /** Optional custom transport callback receiving the serialized JSON error report. */
  transport?: ClientTelemetryTransport;
}

export const CHUNK_RELOAD_STORAGE_KEY = 'kinloom_chunk_reload_at';
const CHUNK_RELOAD_COOLDOWN_MS = 60_000;
const MAX_REPORTS_PER_SESSION = 8;
const DEDUP_CAP = 32;

const CHUNK_ERROR_PATTERNS = [
  'failed to fetch dynamically imported module',
  'failed to load module script',
  'importing a module script failed',
  'error loading dynamically imported module',
  'unable to preload',
  'loading chunk',
  'chunkloaderror',
  'text/html',
];

const SAFE_ROUTE_QUERY_KEYS = new Set([
  'event',
  'from',
  'person',
  'place',
  'source',
  'tab',
  'to',
  'view',
  'year',
]);

let globalHandlersInstalled = false;
let configuredTelemetryOptions: ClientTelemetryOptions | null = null;
const seenReportKeys: string[] = [];
let sessionReportCount = 0;

export function getAppBuildId(): string {
  return typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : 'dev';
}

export function safeSessionStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isChunkLoadError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  if (CHUNK_ERROR_PATTERNS.some((pattern) => message.includes(pattern))) {
    return true;
  }
  if (error instanceof Error && error.name.toLowerCase() === 'chunkloaderror') {
    return true;
  }
  return false;
}

export function shouldAttemptChunkReload(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  nowMs = Date.now()
): boolean {
  if (!storage) {
    return false;
  }
  try {
    const raw = storage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    const last = raw ? Math.trunc(Number(raw)) : Number.NaN;
    if (Number.isFinite(last) && nowMs - last < CHUNK_RELOAD_COOLDOWN_MS) {
      return false;
    }
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(nowMs));
    return true;
  } catch {
    return false;
  }
}

function stripSensitiveUrl(raw: string | undefined, maxLen: number): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim().slice(0, maxLen);
  try {
    const parsed = new URL(trimmed, 'https://archive.local');
    return parsed.pathname.replace(/^\/invite\/[^/]+/i, '/invite/[redacted]').slice(0, maxLen);
  } catch {
    const noQuery = trimmed.split('?')[0]?.split('#')[0];
    return (noQuery ?? trimmed).replace(/^\/invite\/[^/]+/i, '/invite/[redacted]').slice(0, maxLen);
  }
}

export function sanitizeRoute(raw: string | undefined): string {
  const trimmed = (raw ?? '/').trim();
  if (!trimmed) {
    return '/';
  }
  try {
    const parsed = new URL(trimmed, 'https://archive.local');
    const cleanPath = parsed.pathname.replace(/^\/invite\/[^/]+/i, '/invite/[redacted]');
    const safeParams = new URLSearchParams();
    for (const [key, value] of parsed.searchParams.entries()) {
      if (SAFE_ROUTE_QUERY_KEYS.has(key.toLowerCase())) {
        safeParams.append(key, value);
      }
    }
    const qs = safeParams.toString();
    return (qs ? `${cleanPath}?${qs}` : cleanPath).slice(0, 300);
  } catch {
    return (
      trimmed
        .split('?')[0]
        ?.replace(/^\/invite\/[^/]+/i, '/invite/[redacted]')
        .slice(0, 300) || '/'
    );
  }
}

export function sanitizeReport(input: Partial<ClientErrorReport>): ClientErrorReport {
  const kind = input.kind ?? 'window_error';
  return {
    kind,
    message: (input.message ?? 'Unknown client error').trim().slice(0, 500),
    stack: input.stack?.trim().slice(0, 2000),
    componentStack: input.componentStack?.trim().slice(0, 1500),
    route: sanitizeRoute(input.route),
    buildId: (input.buildId ?? getAppBuildId()).trim().slice(0, 80),
    assetUrl: stripSensitiveUrl(input.assetUrl, 300),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

function reportDedupKey(report: ClientErrorReport): string {
  return `${report.kind}\0${report.message}\0${report.route}`;
}

function rememberReportKey(key: string): void {
  if (seenReportKeys.includes(key)) {
    return;
  }
  seenReportKeys.push(key);
  if (seenReportKeys.length > DEDUP_CAP) {
    seenReportKeys.shift();
  }
}

function dispatchToEndpoint(endpoint: string, body: string): void {
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon(endpoint, blob)) {
      return;
    }
  }
  if (typeof fetch === 'function') {
    void fetch(endpoint, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {
      /* Ignore transport failure */
    });
  }
}

function sendPayload(body: string, options?: ClientTelemetryOptions): void {
  const effective = options ?? configuredTelemetryOptions;
  if (!effective) {
    return;
  }
  if (effective.transport) {
    effective.transport(body);
    return;
  }
  const endpoint = effective.endpoint?.trim();
  if (endpoint) {
    dispatchToEndpoint(endpoint, body);
  }
}

export function reportClientError(input: Partial<ClientErrorReport>, options?: ClientTelemetryOptions): void {
  try {
    const effective = options ?? configuredTelemetryOptions;
    if (!effective || (!effective.transport && !effective.endpoint?.trim())) {
      return;
    }
    if (sessionReportCount >= MAX_REPORTS_PER_SESSION) {
      return;
    }
    const report = sanitizeReport(input);
    const key = reportDedupKey(report);
    if (seenReportKeys.includes(key)) {
      return;
    }
    rememberReportKey(key);
    sessionReportCount += 1;
    sendPayload(JSON.stringify(report), effective);
  } catch {
    // Transport must never throw into app code.
  }
}

function currentRoute(): string {
  if (typeof window === 'undefined') {
    return '/';
  }
  return `${window.location.pathname}${window.location.search}`;
}

function handleChunkFailure(message: string, stack?: string, assetUrl?: string): void {
  const route = currentRoute();
  reportClientError({
    kind: 'chunk_preload',
    message,
    stack,
    route,
    buildId: getAppBuildId(),
    assetUrl,
  });
  if (typeof window !== 'undefined' && shouldAttemptChunkReload(safeSessionStorage())) {
    window.location.reload();
  }
}

function onWindowError(event: Event): void {
  if (!(event instanceof ErrorEvent)) {
    return;
  }
  const message = event.message || 'Window script error';
  const stack = event.error instanceof Error ? event.error.stack : undefined;
  if (isChunkLoadError(event.error ?? message)) {
    handleChunkFailure(message, stack, event.filename);
    return;
  }
  reportClientError({
    kind: 'window_error',
    message,
    stack,
    route: currentRoute(),
    buildId: getAppBuildId(),
    assetUrl: event.filename,
  });
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  const reason: unknown = event.reason;
  const message = errorMessage(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  if (isChunkLoadError(reason)) {
    handleChunkFailure(message, stack);
    return;
  }
  reportClientError({
    kind: 'unhandled_rejection',
    message,
    stack,
    route: currentRoute(),
    buildId: getAppBuildId(),
  });
}

function onVitePreloadError(event: Event): void {
  if (!('preventDefault' in event) || typeof event.preventDefault !== 'function') {
    return;
  }
  event.preventDefault();
  const payload = 'payload' in event ? (event as { payload?: unknown }).payload : undefined;
  const message = errorMessage(payload ?? 'Vite preload error');
  const stack = payload instanceof Error ? payload.stack : undefined;
  handleChunkFailure(message, stack);
}

export function installGlobalErrorHandlers(options?: ClientTelemetryOptions): () => void {
  if (globalHandlersInstalled || typeof window === 'undefined') {
    return () => {
      /* Not installed */
    };
  }
  globalHandlersInstalled = true;
  configuredTelemetryOptions = options ?? null;
  window.addEventListener('vite:preloadError', onVitePreloadError);
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    window.removeEventListener('vite:preloadError', onVitePreloadError);
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    configuredTelemetryOptions = null;
    globalHandlersInstalled = false;
  };
}
