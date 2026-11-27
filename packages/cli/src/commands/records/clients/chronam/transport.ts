import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, cachedJsonCall, sha256Hex, withAdvisoryLock } from '../../runtime/cache.js';
import { parseRetryAfterMs } from '../../runtime/http.js';
import { IncompleteDownloadError, isPlainRecord } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  CACHE_SCHEMA,
  type CachedFileResult,
  type ChronamAssetKind,
  DEFAULT_TIMEOUT,
  DOWNLOAD_HEADERS,
  detectInvalidDownload,
  HEADERS,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_S,
  RETRYABLE_STATUS_CODES,
  resolveChronamCacheDir,
  resolveSafeChild,
  SEARCH_ATTEMPT_READ_CAP,
  validateLocUrl,
} from './domain.js';

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

// --- file validation & disk cache helpers ------------------------------------

function validateDownloadFile(
  filePath: string,
  options: { readonly url: string; readonly contentType: string; readonly kind: ChronamAssetKind }
): number {
  let nbytes: number;
  try {
    nbytes = fs.statSync(filePath).size;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Failed reading downloaded file for ${options.url}: ${message}`);
  }
  if (nbytes <= 0) {
    throw new RecordRuntimeError(`Download was empty: ${options.url}`);
  }
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(Math.min(512, nbytes));
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const reason = detectInvalidDownload(head, options.contentType, options.kind);
  if (reason !== null) {
    throw new RecordRuntimeError(`Refusing ${reason} when downloading ${options.url}`);
  }
  return nbytes;
}

function fileCachePaths(
  cacheDir: string,
  url: string
): readonly [binPath: string, metaPath: string, lockPath: string] {
  const key = sha256Hex(url);
  const root = path.join(cacheDir, 'files');
  return [
    resolveSafeChild(root, `${key}.bin`),
    resolveSafeChild(root, `${key}.json`),
    resolveSafeChild(root, `${key}.lock`),
  ];
}

function readCachedFileMeta(
  binPath: string,
  metaPath: string,
  ttlHours: number,
  options: { readonly kind: ChronamAssetKind; readonly url: string; readonly nowMs: () => number }
): { readonly nbytes: number; readonly contentType: string } | null {
  if (ttlHours <= 0) {
    return null;
  }
  try {
    if (!fs.statSync(binPath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainRecord(raw) || raw.schema !== CACHE_SCHEMA) {
    return null;
  }
  const fetchedAt = raw.fetched_at;
  const nbytes = raw.nbytes;
  if (
    typeof fetchedAt !== 'number' ||
    !Number.isFinite(fetchedAt) ||
    typeof nbytes !== 'number' ||
    !Number.isInteger(nbytes) ||
    nbytes <= 0
  ) {
    return null;
  }
  const nowSec = options.nowMs() / 1000;
  if (nowSec - fetchedAt > ttlHours * 3600) {
    return null;
  }
  const contentType = typeof raw.content_type === 'string' ? raw.content_type : '';
  const fallbackUrl = typeof raw.url === 'string' ? raw.url : '';
  try {
    const actual = validateDownloadFile(binPath, {
      url: options.url || fallbackUrl,
      contentType,
      kind: options.kind,
    });
    if (actual !== nbytes) {
      return null;
    }
    return { nbytes: actual, contentType };
  } catch {
    return null;
  }
}

// --- HTTP & retry helpers ----------------------------------------------------

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

function isTimeoutError(err: unknown, abortedByTimer: boolean): boolean {
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

function retryDelaySeconds(attempt: number, resp: Response | null, nowMs: () => number): number {
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

async function fetchFollowingLocRedirects(
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
    readonly params?: readonly (readonly [string, string])[];
    readonly timeout?: number;
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

function unlinkQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

async function writeResponseToFile(resp: Response, tmpPath: string): Promise<number> {
  const fd = fs.openSync(tmpPath, 'w');
  let written = 0;
  try {
    if (resp.body) {
      const reader = resp.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value && value.byteLength > 0) {
            fs.writeSync(fd, value);
            written += value.byteLength;
          }
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const arr = Buffer.from(await resp.arrayBuffer());
      if (arr.byteLength > 0) {
        fs.writeSync(fd, arr);
        written += arr.byteLength;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return written;
}

export async function streamDownloadToPath(
  ctx: RecordCommandContext,
  url: string,
  destPath: string,
  options: {
    readonly timeout: number;
    readonly kind?: ChronamAssetKind;
  }
): Promise<{ readonly nbytes: number; readonly contentType: string }> {
  const validatedUrl = validateLocUrl(url);
  const kind: ChronamAssetKind = options.kind ?? 'bin';
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const deadlineMs = ctx.nowMs() + Math.max(1.0, options.timeout) * 1000;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const remainingSec = (deadlineMs - ctx.nowMs()) / 1000;
    if (remainingSec <= 0.25) {
      break;
    }
    const base = path.basename(destPath);
    const tmpPath = path.join(
      path.dirname(destPath),
      `.${base}.${process.pid}.${process.hrtime.bigint()}.tmp`
    );

    const controller = new AbortController();
    let abortedByTimer = false;
    const timer = setTimeout(
      () => {
        abortedByTimer = true;
        controller.abort(new DOMException('Download timed out', 'TimeoutError'));
      },
      Math.max(1, Math.round(remainingSec * 1000))
    );

    try {
      const { response: resp } = await fetchFollowingLocRedirects(
        ctx,
        validatedUrl,
        DOWNLOAD_HEADERS,
        controller.signal
      );

      if (RETRYABLE_STATUS_CODES.has(resp.status)) {
        lastError = new Error(`HTTP ${resp.status}`);
        const waitSec = retryDelaySeconds(attempt, resp, ctx.nowMs);
        unlinkQuietly(tmpPath);
        const remAfter = (deadlineMs - ctx.nowMs()) / 1000;
        if (attempt + 1 < MAX_ATTEMPTS && remAfter >= waitSec + 1.0) {
          await ctx.sleepFn(Math.round(waitSec * 1000));
          continue;
        }
        const kindErr = resp.status === 429 ? 'rate limited' : 'transient service error';
        throw new RecordRuntimeError(`Failed downloading ${validatedUrl}: HTTP ${resp.status} (${kindErr}).`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        unlinkQuietly(tmpPath);
        throw new RecordRuntimeError(`Failed downloading ${validatedUrl}: HTTP ${resp.status}`);
      }

      const rawContentType = resp.headers.get('content-type') ?? '';
      const contentType = rawContentType.split(';', 1)[0]?.trim() ?? '';
      const contentEncoding = (resp.headers.get('content-encoding') ?? '').trim().toLowerCase();
      const rawLen = (resp.headers.get('content-length') ?? '').trim();
      let expectedLen: number | undefined;
      if (rawLen && (!contentEncoding || contentEncoding === 'identity') && /^\d+$/.test(rawLen)) {
        const parsedLen = Number.parseInt(rawLen, 10);
        if (Number.isSafeInteger(parsedLen) && parsedLen > 0) {
          expectedLen = parsedLen;
        }
      }

      const written = await writeResponseToFile(resp, tmpPath);

      if (expectedLen !== undefined && written < expectedLen) {
        throw new IncompleteDownloadError(`Incomplete download (${written} of ${expectedLen} bytes)`);
      }

      const nbytes = validateDownloadFile(tmpPath, {
        url: validatedUrl,
        contentType,
        kind,
      });
      fs.renameSync(tmpPath, destPath);
      return { nbytes, contentType };
    } catch (err: unknown) {
      unlinkQuietly(tmpPath);
      if (err instanceof RecordRuntimeError && !(err instanceof IncompleteDownloadError)) {
        throw err;
      }
      lastError = err;
      const waitSec = retryDelaySeconds(attempt, null, ctx.nowMs);
      const remAfter = (deadlineMs - ctx.nowMs()) / 1000;
      const retryable =
        err instanceof IncompleteDownloadError || isTimeoutError(err, abortedByTimer) || err instanceof Error;
      if (retryable && attempt + 1 < MAX_ATTEMPTS && remAfter >= waitSec + 1.0) {
        await ctx.sleepFn(Math.round(waitSec * 1000));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(`Failed downloading ${validatedUrl}: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const lastMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new RecordRuntimeError(
    `Failed downloading ${validatedUrl} after ${options.timeout.toFixed(1)}s: ${lastMessage}`
  );
}

export async function cachedDownloadFile(
  ctx: RecordCommandContext,
  url: string,
  options: {
    readonly timeout: number;
    readonly refresh: boolean;
    readonly ttlHours: number;
    readonly kind?: ChronamAssetKind;
  }
): Promise<CachedFileResult> {
  const validatedUrl = validateLocUrl(url);
  const kind: ChronamAssetKind = options.kind ?? 'bin';
  const cacheDir = resolveChronamCacheDir(ctx.env);
  const [binPath, metaPath, lockPath] = fileCachePaths(cacheDir, validatedUrl);

  if (!options.refresh) {
    const hit = readCachedFileMeta(binPath, metaPath, options.ttlHours, {
      kind,
      url: validatedUrl,
      nowMs: ctx.nowMs,
    });
    if (hit !== null) {
      return {
        cachePath: binPath,
        nbytes: hit.nbytes,
        contentType: hit.contentType,
        cacheHit: true,
      };
    }
  }

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const hit = readCachedFileMeta(binPath, metaPath, options.ttlHours, {
          kind,
          url: validatedUrl,
          nowMs: ctx.nowMs,
        });
        if (hit !== null) {
          return {
            cachePath: binPath,
            nbytes: hit.nbytes,
            contentType: hit.contentType,
            cacheHit: true,
          };
        }
      }

      const info = await streamDownloadToPath(ctx, validatedUrl, binPath, {
        timeout: options.timeout,
        kind,
      });

      atomicWriteFileSync(
        metaPath,
        JSON.stringify({
          schema: CACHE_SCHEMA,
          fetched_at: ctx.nowMs() / 1000,
          url: validatedUrl,
          nbytes: info.nbytes,
          content_type: info.contentType,
        })
      );

      return {
        cachePath: binPath,
        nbytes: info.nbytes,
        contentType: info.contentType,
        cacheHit: false,
      };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function cachedDownloadBytes(
  ctx: RecordCommandContext,
  url: string,
  options: {
    readonly timeout: number;
    readonly refresh: boolean;
    readonly ttlHours: number;
    readonly kind?: ChronamAssetKind;
  }
): Promise<{ readonly data: Buffer; readonly cacheHit: boolean }> {
  const { cachePath, cacheHit } = await cachedDownloadFile(ctx, url, options);
  return { data: fs.readFileSync(cachePath), cacheHit };
}
