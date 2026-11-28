import { CookieJar, httpRequest, SsrfBlockedError } from '../../runtime/http.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  ALLOWED_FREEREG_HOSTS,
  extractFreeregToken,
  FREEREG_BASE,
  FREEREG_SEARCH,
  type FreeregCachePayload,
  MAX_HTTP_ATTEMPTS,
  parseFreeregResults,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_MS,
  TRANSIENT_STATUS_CODES,
  UK_USER_AGENT,
  validateUkArchivesUrl,
} from './domain.js';

export async function requestWithRetry(
  ctx: RecordCommandContext,
  options: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly allowedHosts: readonly string[];
    readonly label: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly cookieJar?: CookieJar;
  }
): Promise<{ readonly status: number; readonly url: string; readonly bytes: Buffer }> {
  validateUkArchivesUrl(options.url, options.allowedHosts);
  try {
    const res = await httpRequest(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      userAgent: UK_USER_AGENT,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxAttempts: MAX_HTTP_ATTEMPTS,
      baseBackoffMs: RETRY_BASE_MS,
      retryStatuses: TRANSIENT_STATUS_CODES,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: options.allowedHosts },
      cookieJar: options.cookieJar,
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
      throwOnHttpError: false,
    });
    validateUkArchivesUrl(res.url, options.allowedHosts);
    if (res.status >= 400) {
      throw new RecordRuntimeError(`${options.label} returned HTTP ${res.status}`);
    }
    return { status: res.status, url: res.url, bytes: res.bytes };
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      let host = '';
      try {
        host = new URL(err.url).hostname.toLowerCase();
      } catch {
        host = err.url;
      }
      throw new RecordRuntimeError(
        `Refusing host '${host}'; allowed hosts: ${[...options.allowedHosts].toSorted().join(', ')}.`
      );
    }
    if (err instanceof RecordRuntimeError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`${options.label} request failed: ${message}`);
  }
}

export async function getJson(
  ctx: RecordCommandContext,
  baseUrl: string,
  params: Readonly<Record<string, string | number>> | undefined,
  allowedHosts: readonly string[],
  label: string
): Promise<Record<string, unknown>> {
  const target = new URL(baseUrl);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      target.searchParams.set(k, String(v));
    }
  }
  const res = await requestWithRetry(ctx, {
    method: 'GET',
    url: target.toString(),
    allowedHosts,
    label,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.bytes.toString('utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`${label} returned non-JSON: ${message}`);
  }
  if (!isPlainRecord(parsed)) {
    throw new RecordRuntimeError(`${label} returned unexpected JSON shape`);
  }
  return parsed;
}

export async function fetchFreeregSearch(
  ctx: RecordCommandContext,
  formData: Readonly<Record<string, string>>
): Promise<FreeregCachePayload> {
  const cookieJar = new CookieJar();
  const home = await requestWithRetry(ctx, {
    method: 'GET',
    url: `${FREEREG_BASE}/`,
    allowedHosts: ALLOWED_FREEREG_HOSTS,
    label: 'FreeREG home',
    cookieJar,
  });
  const token = extractFreeregToken(home.bytes.toString('utf8'));
  const postParams = new URLSearchParams({ ...formData, authenticity_token: token });
  const resp = await requestWithRetry(ctx, {
    method: 'POST',
    url: FREEREG_SEARCH,
    allowedHosts: ALLOWED_FREEREG_HOSTS,
    label: 'FreeREG search',
    body: postParams.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    cookieJar,
  });
  return { records: parseFreeregResults(resp.bytes.toString('utf8')) };
}
