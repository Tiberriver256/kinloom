import path from 'node:path';
import { canonicalJsonStringify, resolveCacheDir, sha256Hex, withAdvisoryLock } from '../../runtime/cache.js';
import { assertSafeUrl, SsrfBlockedError } from '../../runtime/http.js';
import {
  atomicWriteCompactJson,
  fetchWithTimeout,
  isPlainRecord,
  looksLikeHtmlBuffer,
  readJsonRecordIfValid,
  resolveEnvCacheTtlHours,
} from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  ArchiveNotFoundError,
  DEFAULT_QUERY_TTL_HOURS,
  DEFAULT_TIMEOUT_SECONDS,
  IA_URL_POLICY,
  MAX_HTTP_RETRIES,
  parseRetryAfterMsIa,
  RETRYABLE_HTTP_CODES,
  SEARCH_TIMEOUT_SECONDS,
  USER_AGENT,
} from './types.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

const inProcessLocks = new Map<string, Promise<void>>();

function isIncompleteReadError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
  if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET') {
    return true;
  }
  if (
    err.name === 'IncompleteRead' ||
    err.name === 'IncompleteReadError' ||
    err.name === 'RemoteDisconnected'
  ) {
    return true;
  }
  return /incomplete\s*read|remote\s*disconnected|premature\s*close|unexpected\s*eof/i.test(err.message);
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  ctx: RecordCommandContext
): Promise<T> {
  const key = path.resolve(lockPath);
  const prev = inProcessLocks.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => current);
  inProcessLocks.set(key, tail);
  await prev;
  try {
    return await withAdvisoryLock(key, fn, {
      nowMs: ctx.nowMs,
      sleepFn: ctx.sleepFn,
    });
  } finally {
    release();
    if (inProcessLocks.get(key) === tail) {
      inProcessLocks.delete(key);
    }
  }
}

export function getCacheRoot(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_IA_CACHE_DIR'],
    defaultSubdir: 'kinloom-ia',
  });
}

export function resolveQueryTtlHours(cliTtl: number | undefined, env: NodeJS.ProcessEnv): number {
  return resolveEnvCacheTtlHours(cliTtl, env, 'KINLOOM_IA_QUERY_TTL_HOURS', DEFAULT_QUERY_TTL_HOURS);
}

export async function httpGetBytesIa(
  url: string,
  ctx: RecordCommandContext,
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS
): Promise<Buffer> {
  const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000));

  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
    let currentUrl = assertSafeUrl(url, IA_URL_POLICY).toString();
    try {
      let response: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        assertSafeUrl(currentUrl, IA_URL_POLICY);
        try {
          response = await fetchWithTimeout(
            currentUrl,
            {
              method: 'GET',
              headers: { 'user-agent': USER_AGENT },
              redirect: 'manual',
            },
            timeoutMs,
            ctx.fetchImpl
          );
        } catch (err: unknown) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw new Error('The read operation timed out');
          }
          throw err;
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            break;
          }
          if (hop === MAX_REDIRECTS) {
            throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${url}`);
          }
          const nextUrl = new URL(location, currentUrl).toString();
          assertSafeUrl(nextUrl, IA_URL_POLICY);
          currentUrl = nextUrl;
          continue;
        }
        break;
      }

      if (!response) {
        throw new RecordRuntimeError(`Request failed for ${url}: no response received`);
      }

      if (response.url) {
        assertSafeUrl(response.url, IA_URL_POLICY);
      }

      const code = response.status;
      if (code === 403) {
        throw new RecordRuntimeError(
          `HTTP 403 from ${url}. This item may be access-restricted or borrow-only.`
        );
      }
      if (code === 404) {
        throw new ArchiveNotFoundError(`HTTP 404 from ${url}`);
      }
      if (RETRYABLE_HTTP_CODES.has(code)) {
        if (attempt < MAX_HTTP_RETRIES) {
          const delayMs = parseRetryAfterMsIa(response.headers.get('retry-after'), attempt, ctx.nowMs());
          await ctx.sleepFn(delayMs);
          continue;
        }
        throw new RecordRuntimeError(`HTTP ${code} from ${url}`);
      }
      if (code < 200 || code >= 300) {
        throw new RecordRuntimeError(`HTTP ${code} from ${url}`);
      }

      const arrayBuf = await response.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err: unknown) {
      if (
        err instanceof SsrfBlockedError ||
        err instanceof ArchiveNotFoundError ||
        err instanceof RecordRuntimeError
      ) {
        throw err;
      }
      if (isIncompleteReadError(err)) {
        if (attempt < MAX_HTTP_RETRIES) {
          const delayMs = parseRetryAfterMsIa(null, attempt, ctx.nowMs());
          await ctx.sleepFn(delayMs);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new RecordRuntimeError(`Incomplete response from ${url}: ${msg}`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(`Request failed for ${url}: ${msg}`);
    }
  }

  throw new RecordRuntimeError(`Request failed for ${url}`);
}

function isValidQueryPayload(kind: string, data: Record<string, unknown>): boolean {
  if (data.error) {
    return false;
  }
  if (kind === 'search') {
    const header = data.responseHeader;
    if (isPlainRecord(header)) {
      const status = header.status;
      if (status !== undefined && status !== null && status !== 0) {
        return false;
      }
    }
    return isPlainRecord(data.response);
  }
  if (kind === 'fulltext') {
    return isPlainRecord(data.response);
  }
  return true;
}

export interface HttpGetJsonOptions {
  readonly timeout?: number;
  readonly retryTransientJson?: boolean;
  readonly retryOnTimeout?: boolean;
}

export async function httpGetJsonIa(
  url: string,
  ctx: RecordCommandContext,
  options: HttpGetJsonOptions = {}
): Promise<Record<string, unknown>> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const retryTransientJson = options.retryTransientJson ?? false;
  const retryOnTimeout = options.retryOnTimeout ?? false;
  const attempts = retryTransientJson || retryOnTimeout ? MAX_HTTP_RETRIES + 1 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let raw: Buffer;
    try {
      raw = await httpGetBytesIa(url, ctx, timeout);
    } catch (err: unknown) {
      if (
        err instanceof RecordRuntimeError &&
        !(err instanceof ArchiveNotFoundError) &&
        !(err instanceof SsrfBlockedError)
      ) {
        const msg = err.message.toLowerCase();
        const isTimeout =
          msg.includes('timed out') || msg.includes('timeout') || msg.includes('reset by peer');
        if (retryOnTimeout && isTimeout && attempt + 1 < attempts) {
          await ctx.sleepFn(parseRetryAfterMsIa(null, attempt, ctx.nowMs()));
          continue;
        }
      }
      throw err;
    }

    if (looksLikeHtmlBuffer(raw)) {
      if (retryTransientJson && attempt + 1 < attempts) {
        await ctx.sleepFn(parseRetryAfterMsIa(null, attempt, ctx.nowMs()));
        continue;
      }
      throw new RecordRuntimeError(`HTML error or outage page returned from ${url}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (err: unknown) {
      if (retryTransientJson && attempt + 1 < attempts) {
        await ctx.sleepFn(parseRetryAfterMsIa(null, attempt, ctx.nowMs()));
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(`Invalid JSON response from ${url}: ${msg}`);
    }

    if (!isPlainRecord(parsed)) {
      if (retryTransientJson && attempt + 1 < attempts) {
        await ctx.sleepFn(parseRetryAfterMsIa(null, attempt, ctx.nowMs()));
        continue;
      }
      throw new RecordRuntimeError(`Expected JSON object from ${url}`);
    }

    return parsed;
  }

  throw new RecordRuntimeError(`Invalid JSON response from ${url}`);
}

function queryCachePath(
  kind: string,
  canonicalParams: Record<string, unknown>,
  cacheRoot: string
): readonly [string, string] {
  const canonical = canonicalJsonStringify(canonicalParams);
  const digest = sha256Hex(canonical);
  return [digest, path.join(cacheRoot, '_queries', kind, `${digest}.json`)];
}

export async function cachedQueryJson(
  kind: string,
  canonicalParams: Record<string, unknown>,
  url: string,
  ctx: RecordCommandContext,
  options: {
    readonly cacheRoot?: string;
    readonly ttlHours?: number;
    readonly refresh?: boolean;
    readonly timeout?: number;
  } = {}
): Promise<readonly [Record<string, unknown>, boolean]> {
  const root = options.cacheRoot ?? getCacheRoot(ctx);
  const ttlHours = options.ttlHours ?? DEFAULT_QUERY_TTL_HOURS;
  const refresh = options.refresh ?? false;
  const timeout = options.timeout ?? SEARCH_TIMEOUT_SECONDS;
  const [digest, cachePath] = queryCachePath(kind, canonicalParams, root);
  const ttlSeconds = ttlHours * 3600;

  const readFresh = (): Record<string, unknown> | undefined => {
    if (refresh || ttlSeconds <= 0) {
      return undefined;
    }
    const envelope = readJsonRecordIfValid(cachePath);
    if (!envelope) {
      return undefined;
    }
    const cachedAt = envelope.cached_at;
    const data = envelope.data;
    if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || !isPlainRecord(data)) {
      return undefined;
    }
    if (!isValidQueryPayload(kind, data)) {
      return undefined;
    }
    if (ctx.nowMs() / 1000 - cachedAt <= ttlSeconds) {
      return data;
    }
    return undefined;
  };

  const cached = readFresh();
  if (cached !== undefined) {
    return [cached, true];
  }

  const lockPath = path.join(root, '_queries', '_locks', `${kind}_${digest}.lock`);
  return withFileLock(
    lockPath,
    async () => {
      const rechecked = readFresh();
      if (rechecked !== undefined) {
        return [rechecked, true];
      }
      let lastError: RecordRuntimeError | undefined;
      let data: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
        const candidate = await httpGetJsonIa(url, ctx, {
          timeout,
          retryTransientJson: true,
          retryOnTimeout: true,
        });
        if (isValidQueryPayload(kind, candidate)) {
          data = candidate;
          break;
        }
        const responseHeader = isPlainRecord(candidate.responseHeader) ? candidate.responseHeader : undefined;
        const errMsg = candidate.error ?? responseHeader?.status;
        lastError = new RecordRuntimeError(
          `Internet Archive ${kind} API returned an error response (${String(errMsg)}) from ${url}`
        );
        if (attempt < MAX_HTTP_RETRIES) {
          await ctx.sleepFn(parseRetryAfterMsIa(null, attempt, ctx.nowMs()));
        }
      }
      if (!data) {
        throw lastError ?? new RecordRuntimeError(`Internet Archive ${kind} API error from ${url}`);
      }
      atomicWriteCompactJson(cachePath, {
        cached_at: ctx.nowMs() / 1000,
        params: canonicalParams,
        data,
      });
      return [data, false];
    },
    ctx
  );
}
