import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  atomicWriteFileSync,
  cachedJsonCall,
  resolveCacheDir,
  withAdvisoryLock,
} from '../../runtime/cache.js';
import { fetchWithCurl, SsrfBlockedError } from '../../runtime/http.js';
import {
  readJsonRecordIfValid,
  resolveEnvCacheTtlHours,
  resolveSafeChildPath,
  resolveUserPathFromContext,
} from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  ALLOWED_HOSTS_LIST,
  BASE,
  BASE_BACKOFF_MS,
  CACHE_SCHEMA,
  CONNECT_TIMEOUT_SEC,
  DEFAULT_CACHE_TTL_HOURS,
  DOWNLOAD_FILE_EXTS,
  type DownloadedFileData,
  encodeQueryPlus,
  filenameFromContentDisposition,
  isHtmlPayload,
  isItemData,
  isSearchResult,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  type MichiganologyItemData,
  type MichiganologySearchResult,
  parseItemHtml,
  parseSearchHtml,
  RETRYABLE_STATUS_CODES,
  SAFE_ITEM_ID_RE,
  sanitizeServerFilename,
  USER_AGENT,
  validateMichiganologyUrl,
  validateUserFilename,
} from './domain.js';

export function getMichiganologyCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_MICHIGANOLOGY_CACHE_DIR'],
    defaultSubdir: 'kinloom-michiganology',
  });
}

export function resolveMichiganologyTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_MICHIGANOLOGY_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export async function curlFetchValidated(
  ctx: RecordCommandContext,
  rawUrl: string,
  timeoutSec: number
): Promise<{ readonly bytes: Buffer; readonly headers: Headers; readonly url: string }> {
  const validatedUrl = validateMichiganologyUrl(rawUrl);
  try {
    const res = await fetchWithCurl(validatedUrl, {
      userAgent: USER_AGENT,
      timeoutMs: Math.max(1000, Math.round(timeoutSec * 1000)),
      connectTimeoutSec: CONNECT_TIMEOUT_SEC,
      maxAttempts: MAX_ATTEMPTS,
      baseBackoffMs: BASE_BACKOFF_MS,
      maxRetryAfterMs: MAX_RETRY_AFTER_MS,
      retryStatuses: RETRYABLE_STATUS_CODES,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS_LIST },
      execFileImpl: ctx.execFileImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
      throwOnHttpError: true,
    });
    validateMichiganologyUrl(res.url);
    return { bytes: res.bytes, headers: res.headers, url: res.url };
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      if (err.message.includes('not in the allowlist')) {
        throw new RecordRuntimeError(`Refusing to access disallowed host: ${err.url}`);
      }
      throw err;
    }
    throw err;
  }
}

export async function cachedSearch(
  ctx: RecordCommandContext,
  query: string,
  budget: number,
  ttlHours: number,
  refresh: boolean
): Promise<{ readonly value: MichiganologySearchResult; readonly cacheHit: boolean }> {
  return cachedJsonCall<MichiganologySearchResult>({
    cacheDir: getMichiganologyCacheDir(ctx),
    kind: 'search',
    payload: { query },
    ttlHours,
    refresh,
    fetch: async () => {
      const url = `${BASE}/?s=${encodeQueryPlus(query)}`;
      const res = await curlFetchValidated(ctx, url, budget);
      return parseSearchHtml(res.bytes.toString('utf8'), query);
    },
    cacheable: (r) => r.results.length > 0 || r.total !== null,
    validateCached: isSearchResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}

export async function cachedItem(
  ctx: RecordCommandContext,
  itemId: string,
  itemUrl: string,
  budget: number,
  ttlHours: number,
  refresh: boolean
): Promise<{ readonly value: MichiganologyItemData; readonly cacheHit: boolean }> {
  return cachedJsonCall<MichiganologyItemData>({
    cacheDir: getMichiganologyCacheDir(ctx),
    kind: 'get',
    payload: { id: itemId, url: itemUrl },
    ttlHours,
    refresh,
    fetch: async () => {
      const res = await curlFetchValidated(ctx, itemUrl, budget);
      return parseItemHtml(res.bytes.toString('utf8'), itemId, itemUrl);
    },
    cacheable: (r) => Boolean(r.parsed),
    validateCached: isItemData,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}

function fileCachePaths(ctx: RecordCommandContext, itemId: string): readonly [string, string, string] {
  if (!SAFE_ITEM_ID_RE.test(itemId)) {
    throw new RecordRuntimeError(`Invalid Michiganology item identifier: '${itemId}'`);
  }
  const root = path.join(getMichiganologyCacheDir(ctx), 'files', itemId);
  return [path.join(root, 'body'), path.join(root, 'meta.json'), path.join(root, '.lock')];
}

function readFileCache(
  ctx: RecordCommandContext,
  itemId: string,
  ttlHours: number
): DownloadedFileData | null {
  if (ttlHours <= 0) {
    return null;
  }
  const [bodyPath, metaPath] = fileCachePaths(ctx, itemId);
  try {
    const fd = fs.openSync(bodyPath, 'r');
    let body: Buffer;
    let size: number;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size <= 0) {
        return null;
      }
      size = stat.size;
      const rawMeta = readJsonRecordIfValid(metaPath);
      if (!rawMeta || rawMeta.schema !== CACHE_SCHEMA) {
        return null;
      }
      const fetched = rawMeta.fetched_at;
      const filename = rawMeta.filename;
      const contentType = rawMeta.content_type;
      if (
        typeof fetched !== 'number' ||
        !Number.isFinite(fetched) ||
        typeof filename !== 'string' ||
        !filename ||
        typeof contentType !== 'string' ||
        !contentType ||
        rawMeta.bytes !== size
      ) {
        return null;
      }
      if (ctx.nowMs() / 1000 - fetched > ttlHours * 3600) {
        return null;
      }
      body = fs.readFileSync(fd);
      if (body.length === 0 || isHtmlPayload(contentType, body)) {
        return null;
      }
      return { body, filename, content_type: contentType };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

async function fetchDownloadBytes(
  ctx: RecordCommandContext,
  itemId: string,
  timeoutSec: number
): Promise<DownloadedFileData> {
  if (!SAFE_ITEM_ID_RE.test(itemId)) {
    throw new RecordRuntimeError(`Invalid Michiganology item identifier: '${itemId}'`);
  }
  const downloadUrl = validateMichiganologyUrl(`${BASE}/download/file/${itemId}`);
  const res = await curlFetchValidated(ctx, downloadUrl, timeoutSec);
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const filename = filenameFromContentDisposition(res.headers.get('content-disposition'), `${itemId}.bin`);
  if (res.bytes.length === 0) {
    throw new RecordRuntimeError(
      `Michiganology download returned an empty file for ${itemId}. The response was not cached.`
    );
  }
  if (isHtmlPayload(contentType, res.bytes)) {
    throw new RecordRuntimeError(
      `Michiganology download returned an HTML page for ${itemId}, not a file. The response was not cached.`
    );
  }
  return { body: res.bytes, filename, content_type: contentType };
}

export async function cachedDownload(
  ctx: RecordCommandContext,
  itemId: string,
  refresh: boolean,
  ttlHours: number,
  timeoutSec: number
): Promise<{ readonly data: DownloadedFileData; readonly cacheHit: boolean }> {
  const [bodyPath, metaPath, lockPath] = fileCachePaths(ctx, itemId);
  if (!refresh) {
    const hit = readFileCache(ctx, itemId, ttlHours);
    if (hit) {
      return { data: hit, cacheHit: true };
    }
  }
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!refresh) {
        const hit = readFileCache(ctx, itemId, ttlHours);
        if (hit) {
          return { data: hit, cacheHit: true };
        }
      }
      const fetched = await fetchDownloadBytes(ctx, itemId, timeoutSec);
      atomicWriteFileSync(bodyPath, fetched.body);
      atomicWriteFileSync(
        metaPath,
        JSON.stringify({
          schema: CACHE_SCHEMA,
          fetched_at: ctx.nowMs() / 1000,
          filename: fetched.filename,
          content_type: fetched.content_type,
          bytes: fetched.body.length,
        })
      );
      return { data: fetched, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export function resolveDownloadDest(
  out: string,
  filename: string | undefined,
  resolvedName: string,
  ctx: RecordCommandContext
): string {
  if (out.includes('\0')) {
    throw new CliValidationError(`Invalid --out path: '${out}'`);
  }
  const resolvedOut = path.resolve(resolveUserPathFromContext(out, ctx));

  if (filename !== undefined) {
    const safeName = validateUserFilename(filename);
    fs.mkdirSync(resolvedOut, { recursive: true });
    return resolveSafeChildPath(resolvedOut, safeName, {
      rejectDoubleDotSubstring: true,
      escapeRootLabel: resolvedOut,
    });
  }

  const ext = path.extname(out).toLowerCase();
  if (DOWNLOAD_FILE_EXTS.has(ext)) {
    const rawParts = out.split(/[\\/]+/);
    if (rawParts.includes('..')) {
      throw new CliValidationError(`Unsafe --out path containing '..': '${out}'`);
    }
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    return resolvedOut;
  }

  fs.mkdirSync(resolvedOut, { recursive: true });
  const safeServer = sanitizeServerFilename(resolvedName, 'download.bin');
  return resolveSafeChildPath(resolvedOut, safeServer, {
    rejectDoubleDotSubstring: true,
    escapeRootLabel: resolvedOut,
  });
}
