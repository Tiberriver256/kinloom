import { cachedJsonCall } from '../../runtime/cache.js';
import { parseRetryAfterMs } from '../../runtime/http.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  CACHE_SCHEMA,
  DEFAULT_TIMEOUT,
  HEADERS,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_S,
  RETRYABLE_STATUS_CODES,
  resolveChronamCacheDir,
  SEARCH_ATTEMPT_READ_CAP,
  validateLocUrl,
} from './domain.js';

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function isConnectTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (err.name === 'ConnectTimeoutError') {
    return true;
  }
  const code = 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
  return code === 'UND_ERR_CONNECT_TIMEOUT';
}

export function isTimeoutError(err: unknown, abortedByTimer: boolean): boolean {
  if (abortedByTimer) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  if (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    err.name === 'ReadTimeoutError' ||
    err.name === 'ConnectTimeoutError'
  ) {
    return true;
  }
  const code = 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
  return (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

export function retryDelaySeconds(attempt: number, resp: Response | null, nowMs: () => number): number {
  if (resp !== null && (resp.status === 429 || resp.status === 503)) {
    const retryAfterMs = parseRetryAfterMs(
      resp.headers.get('retry-after'),
      nowMs(),
      MAX_RETRY_AFTER_S * 1000
    );
    if (retryAfterMs !== undefined) {
      return retryAfterMs / 1000;
    }
  }
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.min(MAX_RETRY_AFTER_S, 0.5 * 2 ** attempt * jitter);
}

function buildRequestUrl(baseUrl: string, params?: readonly (readonly [string, string])[]): string {
  const validated = validateLocUrl(baseUrl);
  if (!params || params.length === 0) {
    return validated;
  }
  const parsed = new URL(validated);
  for (const [k, v] of params) {
    parsed.searchParams.append(k, v);
  }
  return parsed.toString();
}

export async function fetchFollowingLocRedirects(
  ctx: RecordCommandContext,
  initialUrl: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<{ readonly response: Response; readonly finalUrl: string }> {
  let currentUrl = validateLocUrl(initialUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    validateLocUrl(currentUrl);
    const response = await ctx.fetchImpl(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    });
    if (response.url) {
      validateLocUrl(response.url);
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        return { response, finalUrl: response.url || currentUrl };
      }
      if (hop === MAX_REDIRECTS) {
        throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${initialUrl}`);
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new RecordRuntimeError(`Invalid redirect location '${location}' from ${currentUrl}`);
      }
      validateLocUrl(nextUrl);
      currentUrl = nextUrl;
      continue;
    }
    return { response, finalUrl: response.url || currentUrl };
  }
  throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${initialUrl}`);
}

export async function getJson(
  ctx: RecordCommandContext,
  url: string,
  options: {
    readonly params?: readonly (readonly [string, string])[] | undefined;
    readonly timeout?: number | undefined;
  } = {}
): Promise<Record<string, unknown>> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const requestUrl = buildRequestUrl(url, options.params);
  const deadlineMs = ctx.nowMs() + Math.max(0.5, timeout) * 1000;
  const splitReadTimeout = timeout >= 90.0;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const remainingSec = (deadlineMs - ctx.nowMs()) / 1000;
    if (remainingSec <= 0.25) {
      break;
    }
    const readBudgetSec = splitReadTimeout ? Math.min(remainingSec, SEARCH_ATTEMPT_READ_CAP) : remainingSec;

    const controller = new AbortController();
    let abortedByTimer = false;
    const timer = setTimeout(
      () => {
        abortedByTimer = true;
        controller.abort(new DOMException('The read operation timed out', 'TimeoutError'));
      },
      Math.max(1, Math.round(readBudgetSec * 1000))
    );

    let resp: Response;
    let finalUrl: string;
    let bodyText: string;
    try {
      const fetched = await fetchFollowingLocRedirects(ctx, requestUrl, HEADERS, controller.signal);
      resp = fetched.response;
      finalUrl = fetched.finalUrl;

      if (RETRYABLE_STATUS_CODES.has(resp.status)) {
        lastError = new Error(`HTTP ${resp.status}`);
        const waitSec = retryDelaySeconds(attempt, resp, ctx.nowMs);
        const remAfter = (deadlineMs - ctx.nowMs()) / 1000;
        if (attempt + 1 < MAX_ATTEMPTS && remAfter >= waitSec + 2.0) {
          await ctx.sleepFn(Math.round(waitSec * 1000));
          continue;
        }
        const kind = resp.status === 429 ? 'rate limited' : 'transient service error';
        throw new RecordRuntimeError(
          `loc.gov returned HTTP ${resp.status} (${kind}). ` +
            'Wait and retry, narrow with --state/--dates/--lccn, or open `chronam url` in a browser.'
        );
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new RecordRuntimeError(`loc.gov returned HTTP ${resp.status} for ${finalUrl}`);
      }

      bodyText = await resp.text();
    } catch (err: unknown) {
      if (err instanceof RecordRuntimeError) {
        throw err;
      }
      lastError = err;
      const errMessage = err instanceof Error ? err.message : String(err);

      if (isConnectTimeoutError(err)) {
        const waitSec = retryDelaySeconds(attempt, null, ctx.nowMs);
        const remAfter = (deadlineMs - ctx.nowMs()) / 1000;
        if (attempt + 1 < MAX_ATTEMPTS && remAfter >= waitSec + 2.0) {
          await ctx.sleepFn(Math.round(waitSec * 1000));
          continue;
        }
        throw new RecordRuntimeError(
          `loc.gov request timed out after ${timeout.toFixed(1)}s (${errMessage}). ` +
            'loc.gov searches normally take 20-45 s; increase --timeout, ' +
            'narrow with --state, --dates, or --lccn, ' +
            'or open the browser URL from `chronam url`.'
        );
      }

      if (isTimeoutError(err, abortedByTimer)) {
        const waitSec = retryDelaySeconds(attempt, null, ctx.nowMs);
        const remAfter = (deadlineMs - ctx.nowMs()) / 1000;
        if (splitReadTimeout && attempt + 1 < MAX_ATTEMPTS && remAfter >= waitSec + 5.0) {
          await ctx.sleepFn(Math.round(waitSec * 1000));
          continue;
        }
        throw new RecordRuntimeError(
          `loc.gov request timed out after ${timeout.toFixed(1)}s (${errMessage}). ` +
            'loc.gov searches normally take 20-45 s; increase --timeout, ' +
            'narrow with --state, --dates, or --lccn, ' +
            'or open the browser URL from `chronam url`.'
        );
      }

      // Transport / protocol / connection error: retry within budget.
      const waitSec = retryDelaySeconds(attempt, null, ctx.nowMs);
      const remAfter = (deadlineMs - ctx.nowMs()) / 1000;
      if (attempt + 1 < MAX_ATTEMPTS && remAfter >= waitSec + 2.0) {
        await ctx.sleepFn(Math.round(waitSec * 1000));
        continue;
      }
      throw new RecordRuntimeError(
        `loc.gov connection error: ${errMessage}. Retry once or narrow with --state/--dates/--lccn.`
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      const contentType = resp.headers.get('content-type') ?? 'unknown';
      throw new RecordRuntimeError(
        `loc.gov returned non-JSON response (HTTP ${resp.status}, content-type=${contentType}).`
      );
    }
    if (!isPlainRecord(parsed)) {
      const contentType = resp.headers.get('content-type') ?? 'unknown';
      throw new RecordRuntimeError(
        `loc.gov returned non-JSON response (HTTP ${resp.status}, content-type=${contentType}).`
      );
    }
    return parsed;
  }

  const lastMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new RecordRuntimeError(`loc.gov request failed after ${timeout.toFixed(1)}s: ${lastMessage}`);
}

export async function cachedGetJson(
  ctx: RecordCommandContext,
  url: string,
  params: readonly (readonly [string, string])[] | undefined,
  options: {
    readonly timeout: number;
    readonly refresh: boolean;
    readonly ttlHours: number;
    readonly cacheable?: (data: Record<string, unknown>) => boolean;
  }
): Promise<{ readonly data: Record<string, unknown>; readonly cacheHit: boolean }> {
  const cacheDir = resolveChronamCacheDir(ctx.env);
  const sortedParams = [...(params ?? [])].toSorted((a, b) => {
    if (a[0] !== b[0]) {
      return a[0] < b[0] ? -1 : 1;
    }
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });

  const { value, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
    cacheDir,
    kind: 'chronam_json',
    payload: { url, params: sortedParams },
    ttlHours: options.ttlHours,
    refresh: options.refresh,
    schema: CACHE_SCHEMA,
    fetch: () => getJson(ctx, url, { params, timeout: options.timeout }),
    cacheable: options.cacheable,
    validateCached: isPlainRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  return { data: value, cacheHit };
}
