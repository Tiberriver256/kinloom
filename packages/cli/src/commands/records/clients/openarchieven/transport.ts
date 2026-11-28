import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  atomicWriteFileSync,
  cachedJsonCall,
  resolveCacheDir,
  sha256Hex,
  withAdvisoryLock,
} from '../../runtime/cache.js';
import {
  DEFAULT_RETRY_STATUSES,
  DEFAULT_USER_AGENT,
  type HttpResponseResult,
  httpRequest,
  SsrfBlockedError,
  type UrlSecurityPolicy,
} from '../../runtime/http.js';
import {
  atomicWriteCompactJson,
  hasMagicPrefix,
  isPlainRecord,
  JPEG_MAGIC,
  looksLikeHtmlBuffer,
  readJsonRecordIfValid,
  resolveEnvCacheTtlHours,
  stripLeadingBomAndWs,
} from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import { validateApiUrl, validateScanUrl } from './domain.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const CACHE_SCHEMA = 1;
export const API_BASE = 'https://api.openarch.nl/1.0/records';

const MAX_HTTP_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const MIN_INTERVAL_MS = 250;
const TIMEOUT_MS = 30_000;

const CONTENT_TYPE_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'image/tif': 'tif',
  'image/jp2': 'jp2',
  'image/jpeg2000': 'jp2',
  'application/pdf': 'pdf',
};

const HTML_CONTENT_TYPES: ReadonlySet<string> = new Set(['text/html', 'application/xhtml+xml']);
const FALLBACK_HTTP_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

const PNG_PREFIX = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GIF87_PREFIX = Buffer.from('GIF87a');
const GIF89_PREFIX = Buffer.from('GIF89a');
const PDF_PREFIX = Buffer.from('%PDF');
const RIFF_PREFIX = Buffer.from('RIFF');
const WEBP_MARKER = Buffer.from('WEBP');
const TIFF_LE_PREFIX = new Uint8Array([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BE_PREFIX = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]);
const JP2_BOX_PREFIX = new Uint8Array([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50]);
const JP2_CODESTREAM_PREFIX = new Uint8Array([0xff, 0x4f, 0xff, 0x51]);

export interface CachePolicyOptions {
  readonly refresh: boolean;
  readonly ttlHours: number;
}

interface ShowEnvelope {
  readonly data: unknown;
}

class ScanPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanPayloadError';
  }
}

class ScanHttpError extends Error {
  readonly statusCode: number;
  readonly url: string;

  constructor(statusCode: number, url: string) {
    super(`Scan download failed with HTTP ${statusCode} for ${url}. The response was not cached.`);
    this.name = 'ScanHttpError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

export function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_OPENARCHIEVEN_CACHE_DIR'],
    defaultSubdir: 'kinloom-openarchieven',
  });
}

export function resolveTtlHours(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_OPENARCHIEVEN_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export async function requestWithRetry(
  ctx: RecordCommandContext,
  url: string,
  options: {
    readonly validator: (candidate: string) => string;
    readonly urlPolicy: UrlSecurityPolicy;
    readonly accept: string;
    readonly label: string;
  }
): Promise<HttpResponseResult> {
  options.validator(url);
  if (MIN_INTERVAL_MS > 0) {
    await ctx.sleepFn(MIN_INTERVAL_MS);
  }

  const guardedFetch: typeof fetch = (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    options.validator(target);
    return ctx.fetchImpl(input, init);
  };

  try {
    const response = await httpRequest(url, {
      method: 'GET',
      headers: { Accept: options.accept },
      userAgent: DEFAULT_USER_AGENT,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: MAX_HTTP_ATTEMPTS,
      baseBackoffMs: RETRY_BASE_MS,
      maxRetryAfterMs: 30_000,
      retryStatuses: DEFAULT_RETRY_STATUSES,
      urlPolicy: options.urlPolicy,
      fetchImpl: guardedFetch,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
      throwOnHttpError: false,
    });
    options.validator(response.url);
    return response;
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      options.validator(err.url);
      throw err;
    }
    if (err instanceof RecordRuntimeError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`${options.label} failed: ${message}`);
  }
}

export async function getJson(
  ctx: RecordCommandContext,
  endpoint: string,
  params: Readonly<Record<string, string | number>>
): Promise<unknown> {
  const baseUrl = `${API_BASE}/${endpoint}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  const fullUrl = `${baseUrl}?${query.toString()}`;
  const resp = await requestWithRetry(ctx, fullUrl, {
    validator: validateApiUrl,
    urlPolicy: {
      allowedSchemes: ['https:'],
      allowedHosts: ['api.openarch.nl'],
      blockPrivateIps: true,
    },
    accept: 'application/json',
    label: 'OpenArchieven request',
  });

  if (resp.status !== 200) {
    throw new RecordRuntimeError(`HTTP ${resp.status} from ${baseUrl}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(resp.bytes.toString('utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Invalid JSON from ${baseUrl}: ${message}`);
  }

  if (isPlainRecord(data) && data.error_code !== undefined && data.error_code !== null) {
    const desc =
      (typeof data.error_description === 'string' && data.error_description) ||
      (typeof data.error === 'string' && data.error) ||
      'Unknown API error';
    throw new RecordRuntimeError(`OpenArchieven API error ${String(data.error_code)}: ${desc}`);
  }
  return data;
}

export function searchWindow(
  limit: number,
  start: number,
  page: number | undefined,
  startFromUser: boolean
): readonly [number, number] {
  const numberShow = Math.max(1, Math.min(Math.trunc(limit), 100));
  let effectiveStart = start;
  if (page !== undefined) {
    if (startFromUser) {
      throw new CliValidationError('Do not combine --page with --start.');
    }
    if (page < 1) {
      throw new CliValidationError("Option '--page' must be an integer >= 1.");
    }
    effectiveStart = (page - 1) * numberShow;
  }
  return [numberShow, Math.max(0, Math.min(Math.trunc(effectiveStart), 10_000))];
}

function isSearchCacheable(result: Record<string, unknown>): boolean {
  const resp = result.response;
  if (!isPlainRecord(resp)) {
    return false;
  }
  const docs = resp.docs;
  const found = resp.number_found;
  return (
    Array.isArray(docs) &&
    typeof found === 'number' &&
    Number.isInteger(found) &&
    found >= 0 &&
    (docs.length > 0 || found === 0)
  );
}

function isShowCacheable(result: ShowEnvelope): boolean {
  const data = result.data;
  if (isPlainRecord(data)) {
    return Object.keys(data).length > 0;
  }
  if (Array.isArray(data)) {
    return data.length > 0;
  }
  return false;
}

function isShowEnvelope(value: unknown): value is ShowEnvelope {
  return isPlainRecord(value) && 'data' in value;
}

export async function loadSearch(
  ctx: RecordCommandContext,
  cacheDir: string,
  params: Readonly<Record<string, string | number>>,
  options: CachePolicyOptions
): Promise<{ readonly data: Record<string, unknown>; readonly cacheHit: boolean }> {
  const { value, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
    cacheDir,
    kind: 'search',
    payload: params,
    ttlHours: options.ttlHours,
    refresh: options.refresh,
    schema: CACHE_SCHEMA,
    fetch: async () => {
      const fetched = await getJson(ctx, 'search.json', params);
      if (!isPlainRecord(fetched)) {
        throw new RecordRuntimeError(`Unexpected non-object search response from ${API_BASE}/search.json`);
      }
      return fetched;
    },
    cacheable: isSearchCacheable,
    validateCached: isPlainRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return { data: value, cacheHit };
}

export async function loadShow(
  ctx: RecordCommandContext,
  cacheDir: string,
  code: string,
  ident: string,
  lang: string,
  options: CachePolicyOptions
): Promise<{ readonly data: unknown; readonly cacheHit: boolean }> {
  const params: Record<string, string> = {
    archive: code,
    identifier: ident,
    lang,
  };
  const { value: wrapped, cacheHit } = await cachedJsonCall<ShowEnvelope>({
    cacheDir,
    kind: 'show',
    payload: params,
    ttlHours: options.ttlHours,
    refresh: options.refresh,
    schema: CACHE_SCHEMA,
    fetch: async () => ({ data: await getJson(ctx, 'show.json', params) }),
    cacheable: isShowCacheable,
    validateCached: isShowEnvelope,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return { data: wrapped.data, cacheHit };
}

function magicExtension(content: Buffer): string | undefined {
  if (hasMagicPrefix(content, JPEG_MAGIC)) {
    return 'jpg';
  }
  if (hasMagicPrefix(content, PNG_PREFIX)) {
    return 'png';
  }
  if (hasMagicPrefix(content, GIF87_PREFIX) || hasMagicPrefix(content, GIF89_PREFIX)) {
    return 'gif';
  }
  if (hasMagicPrefix(content, PDF_PREFIX)) {
    return 'pdf';
  }
  if (
    content.length >= 12 &&
    hasMagicPrefix(content, RIFF_PREFIX) &&
    content.subarray(8, 12).equals(WEBP_MARKER)
  ) {
    return 'webp';
  }
  if (hasMagicPrefix(content, TIFF_LE_PREFIX) || hasMagicPrefix(content, TIFF_BE_PREFIX)) {
    return 'tif';
  }
  if (hasMagicPrefix(content, JP2_BOX_PREFIX) || hasMagicPrefix(content, JP2_CODESTREAM_PREFIX)) {
    return 'jp2';
  }
  return undefined;
}

function looksLikeMarkup(content: Buffer): boolean {
  if (looksLikeHtmlBuffer(content, 512)) {
    return true;
  }
  const head = stripLeadingBomAndWs(content, 512);
  return head.startsWith('<?xml') || head.startsWith('<');
}

function classifyScanPayload(content: Buffer, contentType: string): string {
  const media = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  if (content.length === 0) {
    throw new ScanPayloadError('The download was empty.');
  }
  if (HTML_CONTENT_TYPES.has(media)) {
    const shown = media || 'unknown type';
    throw new ScanPayloadError(
      `The server returned HTML (${shown}), not an image or PDF. Open the scan URL in a browser.`
    );
  }
  const magic = magicExtension(content);
  if (magic) {
    return magic;
  }
  if (looksLikeMarkup(content)) {
    throw new ScanPayloadError(
      'The server returned HTML, not an image or PDF. Open the scan URL in a browser.'
    );
  }
  const mapped = CONTENT_TYPE_EXT[media];
  if (mapped) {
    return mapped;
  }
  const shown = media || 'missing content-type';
  throw new ScanPayloadError(
    `The server did not return an image or PDF (${shown}). Open the scan URL in a browser.`
  );
}

function scanCachePaths(
  cacheDir: string,
  url: string
): { readonly binPath: string; readonly metaPath: string; readonly lockPath: string } {
  const key = sha256Hex(url);
  const root = path.join(cacheDir, 'scans');
  return {
    binPath: path.join(root, `${key}.bin`),
    metaPath: path.join(root, `${key}.json`),
    lockPath: path.join(root, `${key}.lock`),
  };
}

export function readCachedScan(
  binPath: string,
  metaPath: string,
  ttlHours: number,
  nowMs: () => number
): { readonly body: Buffer; readonly ext: string } | undefined {
  if (ttlHours <= 0) {
    return undefined;
  }
  try {
    const fd = fs.openSync(binPath, 'r');
    try {
      if (!fs.fstatSync(fd).isFile()) {
        return undefined;
      }
      const raw = readJsonRecordIfValid(metaPath);
      if (!raw || raw.schema !== CACHE_SCHEMA) {
        return undefined;
      }
      const fetched = raw.fetched_at;
      const nbytes = raw.nbytes;
      if (
        typeof fetched !== 'number' ||
        !Number.isFinite(fetched) ||
        typeof nbytes !== 'number' ||
        !Number.isInteger(nbytes) ||
        nbytes <= 0
      ) {
        return undefined;
      }
      if (nowMs() / 1000 - fetched > ttlHours * 3600) {
        return undefined;
      }
      const data = fs.readFileSync(fd);
      if (data.length !== nbytes) {
        return undefined;
      }
      const ext = classifyScanPayload(data, 'application/octet-stream');
      return { body: data, ext };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

async function fetchScanBytes(
  ctx: RecordCommandContext,
  url: string
): Promise<{ readonly body: Buffer; readonly contentType: string }> {
  const resp = await requestWithRetry(ctx, url, {
    validator: validateScanUrl,
    urlPolicy: {
      allowedSchemes: ['http:', 'https:'],
      blockPrivateIps: true,
    },
    accept: 'image/*,application/pdf;q=0.9,*/*;q=0.1',
    label: `Scan download for ${url}`,
  });
  if (resp.status !== 200) {
    throw new ScanHttpError(resp.status, url);
  }
  return {
    body: resp.bytes,
    contentType: resp.headers.get('content-type') ?? '',
  };
}

export async function cachedScanBytesChecked(
  ctx: RecordCommandContext,
  cacheDir: string,
  url: string,
  options: CachePolicyOptions
): Promise<{ readonly body: Buffer; readonly ext: string; readonly cacheHit: boolean }> {
  const { binPath, metaPath, lockPath } = scanCachePaths(cacheDir, url);
  if (!options.refresh) {
    const hit = readCachedScan(binPath, metaPath, options.ttlHours, ctx.nowMs);
    if (hit) {
      return { body: hit.body, ext: hit.ext, cacheHit: true };
    }
  }
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const hit = readCachedScan(binPath, metaPath, options.ttlHours, ctx.nowMs);
        if (hit) {
          return { body: hit.body, ext: hit.ext, cacheHit: true };
        }
      }
      const { body, contentType } = await fetchScanBytes(ctx, url);
      const ext = classifyScanPayload(body, contentType);
      atomicWriteFileSync(binPath, body);
      atomicWriteCompactJson(metaPath, {
        schema: CACHE_SCHEMA,
        fetched_at: ctx.nowMs() / 1000,
        nbytes: body.length,
        ext,
      });
      return { body, ext, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function downloadScanCandidates(
  ctx: RecordCommandContext,
  cacheDir: string,
  candidates: readonly (readonly [string, boolean])[],
  options: CachePolicyOptions
): Promise<{
  readonly body: Buffer;
  readonly ext: string;
  readonly resolvedUrl: string;
  readonly cacheHit: boolean;
}> {
  let lastError: string | undefined;
  for (let idx = 0; idx < candidates.length; idx += 1) {
    const [candidateUrl, fallbackOn5xx] = candidates[idx];
    const hasNext = idx + 1 < candidates.length;
    try {
      const { body, ext, cacheHit } = await cachedScanBytesChecked(ctx, cacheDir, candidateUrl, options);
      return { body, ext, resolvedUrl: candidateUrl, cacheHit };
    } catch (err: unknown) {
      if (err instanceof ScanPayloadError) {
        lastError = `${err.message} URL: ${candidateUrl}. Nothing was saved or cached.`;
        if (hasNext) {
          continue;
        }
        throw new RecordRuntimeError(lastError);
      }
      if (err instanceof ScanHttpError) {
        lastError = err.message;
        if (hasNext && (fallbackOn5xx || FALLBACK_HTTP_STATUSES.has(err.statusCode))) {
          continue;
        }
        throw new RecordRuntimeError(lastError);
      }
      throw err;
    }
  }
  throw new RecordRuntimeError(lastError ?? 'No downloadable scan URL was found.');
}
