import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  cachedJsonCall,
  emitJsonStdout,
  emitStdout,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  parseCacheTtlHours,
  parseCommandArgs,
  parseRetryAfterMs,
  RecordRuntimeError,
  resolveCacheDir,
  sha256Hex,
  withAdvisoryLock,
  type CommandParseSpec,
  type OptionSpec,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
} from '../runtime/index.js';

export const COLLECTION_BASE = 'https://www.loc.gov/collections/chronicling-america/';
export const USER_AGENT =
  'kinloom/1.0 (genealogy research; +https://github.com/Tiberriver256/kinloom)';
export const HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': USER_AGENT,
  Accept: 'application/json',
});
// tile.loc.gov (storage-services PDFs) rejects hotlinking: it requires a
// loc.gov Referer. Send one for all file downloads; harmless elsewhere.
export const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': USER_AGENT,
  Referer: 'https://www.loc.gov/',
});

// Measured 2026-11-25: loc.gov search TTFB is 19-43 s. An 8 s budget made
// 80%+ of searches fail. One probe under 6 parallel requests took 70 s,
// so 120 s covers the observed tail with headroom.
export const DEFAULT_TIMEOUT = 120.0;
export const DOWNLOAD_TIMEOUT = 60.0;
export const CONNECT_TIMEOUT = 15.0;
export const SEARCH_ATTEMPT_READ_CAP = 65.0;
export const MAX_ATTEMPTS = 4;
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504, 520, 522, 524,
]);
export const MAX_RETRY_AFTER_S = 30.0;
export const COLLECTION_START_YEAR = '1736';
export const COLLECTION_END_YEAR = '1963';
export const DEFAULT_CACHE_TTL_HOURS = 168.0;
export const CACHE_SCHEMA = 1;

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const HTML_ERROR_PREFIXES = ['<!doctype html', '<html', '<head', '<body', '<title'] as const;
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JP2_MAGICS: readonly Buffer[] = [
  Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50]),
  Buffer.from([0xff, 0x4f, 0xff, 0x51]),
];

export const US_STATES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'alabama',
  AK: 'alaska',
  AZ: 'arizona',
  AR: 'arkansas',
  CA: 'california',
  CO: 'colorado',
  CT: 'connecticut',
  DE: 'delaware',
  DC: 'district of columbia',
  FL: 'florida',
  GA: 'georgia',
  HI: 'hawaii',
  ID: 'idaho',
  IL: 'illinois',
  IN: 'indiana',
  IA: 'iowa',
  KS: 'kansas',
  KY: 'kentucky',
  LA: 'louisiana',
  ME: 'maine',
  MD: 'maryland',
  MA: 'massachusetts',
  MI: 'michigan',
  MN: 'minnesota',
  MS: 'mississippi',
  MO: 'missouri',
  MT: 'montana',
  NE: 'nebraska',
  NV: 'nevada',
  NH: 'new hampshire',
  NJ: 'new jersey',
  NM: 'new mexico',
  NY: 'new york',
  NC: 'north carolina',
  ND: 'north dakota',
  OH: 'ohio',
  OK: 'oklahoma',
  OR: 'oregon',
  PA: 'pennsylvania',
  PR: 'puerto rico',
  RI: 'rhode island',
  SC: 'south carolina',
  SD: 'south dakota',
  TN: 'tennessee',
  TX: 'texas',
  UT: 'utah',
  VT: 'vermont',
  VA: 'virginia',
  VI: 'virgin islands',
  WA: 'washington',
  WV: 'west virginia',
  WI: 'wisconsin',
  WY: 'wyoming',
});

export type ChronamAssetKind = 'pdf' | 'image' | 'jp2' | 'text' | 'bin';

export interface PageAssets {
  readonly pdf: string | null;
  readonly image: string | null;
  readonly jp2: string | null;
  readonly text: string | null;
  readonly iiif_manifest_url: string | null;
}

export interface CachedFileResult {
  readonly cachePath: string;
  readonly nbytes: number;
  readonly contentType: string;
  readonly cacheHit: boolean;
}

export interface DownloadedFileRecord {
  readonly kind: string;
  readonly url: string;
  readonly path: string;
  readonly bytes: number;
  readonly content_type: string;
  readonly cache_hit: boolean;
}

class IncompleteDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteDownloadError';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : null;
  }
  return value ?? null;
}

function hasPrefix(buf: Uint8Array, magic: Buffer): boolean {
  if (buf.length < magic.length) {
    return false;
  }
  for (let i = 0; i < magic.length; i += 1) {
    if (buf[i] !== magic[i]) {
      return false;
    }
  }
  return true;
}

function stripLeadingBomAndWs(buf: Buffer): string {
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3;
  }
  while (start < buf.length) {
    const byte = buf[start];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) {
      start += 1;
    } else {
      break;
    }
  }
  return buf.subarray(start, Math.min(buf.length, 512)).toString('latin1').toLowerCase();
}

// --- disk cache & path safety ------------------------------------------------

export function resolveChronamCacheDir(env: NodeJS.ProcessEnv): string {
  return resolveCacheDir({
    env,
    envVars: ['KINLOOM_CHRONAM_CACHE_DIR'],
    defaultSubdir: 'kinloom-chronam',
  });
}

export function resolveTtlHours(cliTtl: number | undefined, env: NodeJS.ProcessEnv): number {
  if (cliTtl !== undefined) {
    return parseCacheTtlHours(cliTtl, DEFAULT_CACHE_TTL_HOURS, '--cache-ttl-hours');
  }
  return parseCacheTtlHours(
    env.KINLOOM_CHRONAM_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    'KINLOOM_CHRONAM_CACHE_TTL_HOURS'
  );
}

export function atomicCopyFileSync(src: string, dest: string): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(dest);
  const tmp = path.join(dir, `.${base}.${process.pid}.${process.hrtime.bigint()}.tmp`);
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort temp cleanup.
    }
    throw err;
  }
}

export function validateLocUrl(url: string): string {
  const text = (url ?? '').trim();
  if (!text) {
    throw new RecordRuntimeError(`Invalid URL: ${JSON.stringify(url)}`);
  }
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 32) {
      throw new RecordRuntimeError(`Invalid URL: ${JSON.stringify(url)}`);
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new RecordRuntimeError(`Refusing to access non-HTTPS or disallowed URL: ${text}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    !host ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new RecordRuntimeError(`Refusing to access non-HTTPS or disallowed URL: ${text}`);
  }
  if (host !== 'loc.gov' && !host.endsWith('.loc.gov')) {
    throw new RecordRuntimeError(`Refusing to access non-loc.gov host '${host}': ${text}`);
  }
  return text;
}

export function detectInvalidDownload(
  head: Buffer,
  contentType: string,
  kind: ChronamAssetKind
): string | null {
  const ctLower = (contentType || '').toLowerCase();
  if (ctLower.includes('text/html') || ctLower.includes('application/xhtml')) {
    return `HTML error page (${contentType})`;
  }
  const sample = stripLeadingBomAndWs(head);
  if (HTML_ERROR_PREFIXES.some((prefix) => sample.startsWith(prefix))) {
    return 'HTML error page';
  }
  if (kind === 'pdf' && !hasPrefix(head, PDF_MAGIC)) {
    return 'non-PDF payload';
  }
  if (kind === 'image' && !(hasPrefix(head, JPEG_MAGIC) || hasPrefix(head, PNG_MAGIC))) {
    return 'non-image payload';
  }
  if (kind === 'jp2' && !JP2_MAGICS.some((magic) => hasPrefix(head, magic))) {
    return 'non-JP2 payload';
  }
  return null;
}

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

export function resolveSafeChild(root: string, filename: string): string {
  if (
    !filename ||
    filename.includes('\0') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes(':') ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('..')
  ) {
    throw new RecordRuntimeError(`Unsafe filename: ${JSON.stringify(filename)}`);
  }
  const rootResolved = path.resolve(root);
  const dest = path.resolve(rootResolved, filename);
  const rel = path.relative(rootResolved, dest);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || dest === rootResolved) {
    throw new RecordRuntimeError(`Unsafe path escaping ${root}: ${JSON.stringify(filename)}`);
  }
  return dest;
}

export function safeOutputFilename(raw: string): string {
  const candidate = (raw || '').replace(/\\/g, '/');
  const tail = candidate.split('/').at(-1) ?? '';
  let base = tail.trim().replace(/\.\./g, '_');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  if (
    !base ||
    base === '.' ||
    base === '..' ||
    base.includes('..') ||
    base.includes('/') ||
    base.includes('\\')
  ) {
    base = 'page.bin';
  }
  return base;
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

function retryDelaySeconds(
  attempt: number,
  resp: Response | null,
  nowMs: () => number
): number {
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

function buildRequestUrl(
  baseUrl: string,
  params?: readonly (readonly [string, string])[]
): string {
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
    const readBudgetSec = splitReadTimeout
      ? Math.min(remainingSec, SEARCH_ATTEMPT_READ_CAP)
      : remainingSec;

    const controller = new AbortController();
    let abortedByTimer = false;
    const timer = setTimeout(() => {
      abortedByTimer = true;
      controller.abort(new DOMException('The read operation timed out', 'TimeoutError'));
    }, Math.max(1, Math.round(readBudgetSec * 1000)));

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
        `loc.gov connection error: ${errMessage}. ` +
          'Retry once or narrow with --state/--dates/--lccn.'
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
    const timer = setTimeout(() => {
      abortedByTimer = true;
      controller.abort(new DOMException('Download timed out', 'TimeoutError'));
    }, Math.max(1, Math.round(remainingSec * 1000)));

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
        throw new RecordRuntimeError(
          `Failed downloading ${validatedUrl}: HTTP ${resp.status} (${kindErr}).`
        );
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
        throw new IncompleteDownloadError(
          `Incomplete download (${written} of ${expectedLen} bytes)`
        );
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
      if (err instanceof RecordRuntimeError) {
        throw err;
      }
      lastError = err;
      const waitSec = retryDelaySeconds(attempt, null, ctx.nowMs);
      const remAfter = (deadlineMs - ctx.nowMs()) / 1000;
      const retryable =
        err instanceof IncompleteDownloadError ||
        isTimeoutError(err, abortedByTimer) ||
        err instanceof Error;
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

// --- query & asset helpers ---------------------------------------------------

export function resolveQuery(words: readonly string[], termsOpt: string | undefined): string {
  const joined = words.filter((w) => w.length > 0).join(' ').trim();
  const query = joined || (termsOpt ?? '').trim();
  if (!query) {
    throw new CliValidationError(
      'Provide QUERY words as positional arguments or via --terms/--query.'
    );
  }
  return query;
}

export function resolveDates(
  dates: string | undefined,
  dateFrom: string | undefined,
  dateTo: string | undefined
): string | undefined {
  if (dates) {
    const cleaned = dates.trim().replace(/-/g, '/');
    if (/^\d{4}$/.test(cleaned)) {
      return `${cleaned}/${cleaned}`;
    }
    if (!/^\d{4}\/\d{4}$/.test(cleaned)) {
      throw new CliValidationError(`--dates ${JSON.stringify(dates)}: expected YYYY/YYYY (or YYYY).`);
    }
    return cleaned;
  }
  if (dateFrom || dateTo) {
    const start = (dateFrom || COLLECTION_START_YEAR).trim().slice(0, 4);
    const end = (dateTo || COLLECTION_END_YEAR).trim().slice(0, 4);
    for (const [label, year] of [
      ['start', start],
      ['end', end],
    ] as const) {
      if (!/^\d{4}$/.test(year)) {
        throw new CliValidationError(`${label} year ${JSON.stringify(year)}: expected YYYY.`);
      }
    }
    return `${start}/${end}`;
  }
  return undefined;
}

export function normalizeState(state: string): string {
  const cleaned = state.trim();
  return (US_STATES[cleaned.toUpperCase()] ?? cleaned).toLowerCase();
}

export function buildSearchParams(
  query: string,
  options: {
    readonly dates?: string;
    readonly level: string;
    readonly limit: number;
    readonly page: number;
    readonly state?: string;
    readonly lccn?: string;
  }
): [string, string][] {
  const params: [string, string][] = [
    ['q', query],
    ['fo', 'json'],
    ['at', 'search,results'],
    ['c', String(options.limit)],
    ['sp', String(options.page)],
  ];
  if (options.level !== 'all') {
    params.push(['dl', options.level]);
  }
  if (options.dates) {
    params.push(['dates', options.dates]);
  }
  if (options.state) {
    params.push(['fa', `location_state:${normalizeState(options.state)}`]);
  }
  if (options.lccn) {
    params.push(['fa', `number_lccn:${options.lccn.trim()}`]);
  }
  return params;
}

function compactResult(item: Record<string, unknown>): Record<string, unknown> {
  const partofTitle = firstValue(item.partof_title);
  const title = partofTitle ? partofTitle : (item.title ?? null);
  return {
    title,
    date: item.date ?? null,
    state: firstValue(item.location_state),
    county: firstValue(item.location_county),
    city: firstValue(item.location_city),
    lccn: item.number_lccn ?? null,
    page: item.number_page ?? null,
    url: item.url ?? null,
    id: item.id ?? null,
  };
}

export function searchCacheable(data: Record<string, unknown>): boolean {
  // loc.gov sometimes answers a valid query with a transient 0-hit page.
  // Never cache an empty answer, so the next call asks loc.gov again.
  const searchObj = isPlainRecord(data.search) ? data.search : undefined;
  const hits = searchObj?.hits;
  const results = Array.isArray(data.results) ? data.results : [];
  return Boolean(hits) && results.length > 0;
}

export function resourceUrlJson(resourceUrl: string): string {
  const validated = validateLocUrl(resourceUrl);
  const parsed = new URL(validated);
  parsed.searchParams.delete('q');
  parsed.searchParams.set('fo', 'json');
  return parsed.toString();
}

export function extractSeqFromUrl(resourceUrl: string, fallback = '1'): string {
  try {
    const parsed = new URL(resourceUrl);
    const sp = parsed.searchParams.get('sp');
    if (sp && sp.trim().length > 0) {
      return sp.trim();
    }
  } catch {
    // Fall back to default sequence when URL cannot be parsed.
  }
  return fallback;
}

export function iiifJpegFromInfo(
  infoUrl: string,
  imageWidth: number | undefined
): string | null {
  if (!infoUrl || !infoUrl.endsWith('/info.json')) {
    return null;
  }
  const base = infoUrl.slice(0, -'/info.json'.length);
  const size = imageWidth !== undefined ? `${imageWidth},` : 'pct:50';
  return `${base}/full/${size}/0/default.jpg`;
}

export function resolvePageAssets(
  data: Record<string, unknown>,
  options: { readonly imageWidth?: number } = {}
): PageAssets {
  const rawResources = Array.isArray(data.resources) && data.resources.length > 0
    ? data.resources[0]
    : undefined;
  const resources = isPlainRecord(rawResources) ? rawResources : {};
  const pageEntries = Array.isArray(data.page) ? data.page : [];

  let pdfUrl: string | null = null;
  let jp2Url: string | null = null;
  let xmlUrl: string | null = null;
  let iiifImageUrl: string | null = null;
  let bestJpegUrl: string | null = null;

  for (const entry of pageEntries) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const mime = String(entry.mimetype ?? '').toLowerCase();
    const entryUrl = asNonEmptyString(entry.url);
    const infoUrl = asNonEmptyString(entry.info);

    if (mime === 'application/pdf' && entryUrl && !pdfUrl) {
      pdfUrl = entryUrl;
    } else if (mime === 'image/jp2' && entryUrl && !jp2Url) {
      jp2Url = entryUrl;
      if (infoUrl && !iiifImageUrl) {
        iiifImageUrl = iiifJpegFromInfo(infoUrl, options.imageWidth);
      }
    } else if (mime === 'text/xml' && entryUrl && !xmlUrl) {
      xmlUrl = entryUrl;
    } else if (mime === 'image/jpeg' && entryUrl) {
      bestJpegUrl = entryUrl;
    }

    if (infoUrl && !iiifImageUrl) {
      iiifImageUrl = iiifJpegFromInfo(infoUrl, options.imageWidth);
    }
  }

  return {
    pdf: pdfUrl ?? asNonEmptyString(resources.pdf) ?? null,
    image: iiifImageUrl ?? bestJpegUrl ?? asNonEmptyString(resources.image) ?? null,
    jp2: jp2Url,
    text: asNonEmptyString(resources.fulltext_file) ?? xmlUrl ?? null,
    iiif_manifest_url: asNonEmptyString(resources.iiif_manifest_url) ?? null,
  };
}

export function buildResourceUrl(
  lccn: string,
  date: string,
  edition: string,
  seq: string
): string {
  return `https://www.loc.gov/resource/${lccn}/${date}/ed-${edition}/?sp=${seq}`;
}

function formatTextField(value: unknown): string {
  return value === null || value === undefined ? 'None' : String(value);
}

// --- CLI option specs --------------------------------------------------------

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: `Cache TTL in hours (default ${DEFAULT_CACHE_TTL_HOURS}; env KINLOOM_CHRONAM_CACHE_TTL_HOURS).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and re-query loc.gov.',
  },
];

const QUERY_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'termsOpt',
    kind: 'string',
    flags: ['--terms', '--query', '-q'],
    metavar: 'TEXT',
    help: 'Alias for positional QUERY.',
  },
  {
    key: 'dates',
    kind: 'string',
    flags: ['--dates'],
    metavar: 'YYYY/YYYY',
    help: 'Date range YYYY/YYYY (or one year YYYY).',
  },
  {
    key: 'dateFrom',
    kind: 'string',
    flags: ['--date-from', '--from-year', '--date1', '--year1', '--start'],
    metavar: 'YYYY',
    help: 'Start year YYYY (alternative to --dates).',
  },
  {
    key: 'dateTo',
    kind: 'string',
    flags: ['--date-to', '--to-year', '--date2', '--year2', '--end'],
    metavar: 'YYYY',
    help: 'End year YYYY (alternative to --dates).',
  },
  {
    key: 'level',
    kind: 'string',
    flags: ['--level'],
    choices: ['page', 'issue', 'title', 'all'],
    default: 'page',
    metavar: 'LEVEL',
    help: 'Display level (dl=).',
  },
  {
    key: 'state',
    kind: 'string',
    flags: ['--state'],
    metavar: 'STATE',
    help: 'State name or postal code (CA, NJ); sent as fa=location_state:<state>.',
  },
  {
    key: 'lccn',
    kind: 'string',
    flags: ['--lccn'],
    metavar: 'LCCN',
    help: 'Filter by newspaper LCCN via fa=number_lccn:<lccn>.',
  },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  ...QUERY_OPTIONS,
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '--per-page', '--rows', '-n'],
    default: 10,
    min: 1,
    metavar: 'N',
    help: 'Results per page (c=).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page', '-p'],
    default: 1,
    min: 1,
    metavar: 'N',
    help: 'Results page (sp=).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT,
    min: 0,
    metavar: 'SECONDS',
    help: 'Request timeout budget in seconds (loc.gov search takes 20-45 s).',
  },
  ...CACHE_OPTIONS,
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of compact text.',
  },
];

const SEARCH_PARSE_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
};

const PAGE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'lccn',
    kind: 'string',
    flags: ['--lccn'],
    metavar: 'LCCN',
    help: 'Newspaper LCCN, e.g. sn83045462.',
  },
  {
    key: 'date',
    kind: 'string',
    flags: ['--date'],
    metavar: 'YYYY-MM-DD',
    help: 'Issue date YYYY-MM-DD.',
  },
  {
    key: 'edition',
    kind: 'string',
    flags: ['--edition'],
    default: '1',
    metavar: 'ED',
    help: 'Edition number.',
  },
  {
    key: 'seq',
    kind: 'string',
    flags: ['--seq'],
    default: '1',
    metavar: 'SEQ',
    help: 'Page sequence within the issue (?sp=).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT,
    min: 0,
    metavar: 'SECONDS',
    help: 'Request timeout budget in seconds.',
  },
  ...CACHE_OPTIONS,
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit the item JSON with boolean cache_hit.',
  },
];

const PAGE_PARSE_SPEC: CommandParseSpec = {
  options: PAGE_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'lccn',
    kind: 'string',
    flags: ['--lccn'],
    metavar: 'LCCN',
    help: 'Newspaper LCCN, e.g. sn83045462.',
  },
  {
    key: 'date',
    kind: 'string',
    flags: ['--date'],
    metavar: 'YYYY-MM-DD',
    help: 'Issue date YYYY-MM-DD.',
  },
  {
    key: 'edition',
    kind: 'string',
    flags: ['--edition'],
    default: '1',
    metavar: 'ED',
    help: 'Edition number.',
  },
  {
    key: 'seq',
    kind: 'string',
    flags: ['--seq'],
    metavar: 'SEQ',
    help: 'Page sequence within the issue (defaults to ?sp= or 1).',
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '--out-dir', '-o'],
    default: '.',
    metavar: 'DIR',
    help: 'Output directory.',
  },
  {
    key: 'pdf',
    kind: 'boolean',
    flags: ['--pdf'],
    negatable: true,
    default: true,
    help: 'Download the page PDF (falls back to IIIF JPEG if no PDF exists).',
  },
  {
    key: 'image',
    kind: 'boolean',
    flags: ['--image'],
    negatable: true,
    default: false,
    help: 'Download the page IIIF JPEG image.',
  },
  {
    key: 'imageWidth',
    kind: 'integer',
    flags: ['--image-width'],
    min: 100,
    max: 10000,
    metavar: 'PX',
    help: 'IIIF JPEG pixel width (100..10000); defaults to pct:50 when resolved from IIIF info.',
  },
  {
    key: 'jp2',
    kind: 'boolean',
    flags: ['--jp2'],
    negatable: true,
    default: false,
    help: 'Download the archival JP2 scan when listed on the page.',
  },
  {
    key: 'text',
    kind: 'boolean',
    flags: ['--text'],
    negatable: true,
    default: false,
    help: 'Download the ALTO XML word-coordinates file (OCR full text).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DOWNLOAD_TIMEOUT,
    min: 0,
    metavar: 'SECONDS',
    help: 'Download timeout in seconds.',
  },
  ...CACHE_OPTIONS,
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit structured JSON including boolean cache_hit.',
  },
];

const DOWNLOAD_PARSE_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

const URL_PARSE_SPEC: CommandParseSpec = {
  options: QUERY_OPTIONS,
  allowPositionals: true,
};

// --- usage renderers ---------------------------------------------------------

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom chronam <command> [options]',
    summary: 'Search Chronicling America historic newspapers (Library of Congress).',
    subcommands: [
      { name: 'search', summary: 'Search newspaper pages for QUERY (full-text, e.g. a surname).' },
      { name: 'get', summary: 'Show metadata and download links for one newspaper page.' },
      { name: 'page', summary: 'Alias for `get`: show metadata and download links for one page.' },
      { name: 'download', summary: 'Download a newspaper page (PDF, IIIF image, JP2, OCR) + metadata.' },
      { name: 'url', summary: 'Print the loc.gov website search URL for QUERY (open in a browser).' },
    ],
  });
}

function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom chronam search [QUERY...] [options]',
    summary: 'Search newspaper pages for QUERY (full-text, e.g. a surname).',
    options: SEARCH_OPTIONS,
    notes: [
      'Multi-word queries need no quotes: `kinloom chronam search Abraham Lincoln`.',
      'Results are cached on disk (~/.cache/kinloom-chronam, 168 h TTL).',
    ],
  });
}

function renderPageHelp(cmdName: 'get' | 'page'): string {
  return formatCommandUsage({
    usage: `kinloom chronam ${cmdName} [RESOURCE_URL] [options]`,
    summary: 'Show metadata and download links for one newspaper page.',
    options: PAGE_OPTIONS,
    notes: ['Give a loc.gov resource URL, or build one with --lccn --date [--edition --seq].'],
  });
}

function renderDownloadHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom chronam download [RESOURCE_URL] [options]',
    summary: 'Download a newspaper page (PDF, IIIF image, JP2, OCR) plus metadata.json.',
    options: DOWNLOAD_OPTIONS,
  });
}

function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom chronam url [QUERY...] [options]',
    summary: 'Print the loc.gov website search URL for QUERY (open in a browser).',
    options: QUERY_OPTIONS,
  });
}

// --- subcommands -------------------------------------------------------------

async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }

  const query = resolveQuery(parsed.positionals, getStringOption(parsed, 'termsOpt'));
  const dates = resolveDates(
    getStringOption(parsed, 'dates'),
    getStringOption(parsed, 'dateFrom'),
    getStringOption(parsed, 'dateTo')
  );
  const level = getStringOption(parsed, 'level') ?? 'page';
  const state = getStringOption(parsed, 'state');
  const lccn = getStringOption(parsed, 'lccn');
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const page = getNumberOption(parsed, 'page') ?? 1;
  const timeout = getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT;
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);

  const params = buildSearchParams(query, { dates, level, limit, page, state, lccn });
  const { data, cacheHit } = await cachedGetJson(ctx, COLLECTION_BASE, params, {
    timeout,
    refresh,
    ttlHours,
    cacheable: searchCacheable,
  });

  const rawResults = Array.isArray(data.results) ? data.results : [];
  const results = rawResults.filter(isPlainRecord);
  const searchObj = isPlainRecord(data.search) ? data.search : undefined;
  const hits = searchObj?.hits;

  if (hits && results.length === 0) {
    ctx.io.stderr(
      `Warning: loc.gov reported ${String(hits)} total hits but returned 0 rows on page ${page}. ` +
        'Check --page or retry once if loc.gov dropped facet results.'
    );
  } else if (!hits) {
    ctx.io.stderr(
      'Note: 0 hits. loc.gov sometimes returns a transient empty answer; empty results are ' +
        'never cached, so one rerun confirms a true zero.'
    );
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      hits: hits ?? null,
      cache_hit: cacheHit,
      results: results.map((item) => compactResult(item)),
    });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const lines: string[] = [
    `hits: ${formatTextField(hits)} (showing ${results.length} on this page)${cacheHit ? ' [cache]' : ''}`,
  ];
  for (const item of results) {
    const c = compactResult(item);
    lines.push(
      `- ${formatTextField(c.date)} | ${formatTextField(c.title)} | ${formatTextField(c.state)} | ${formatTextField(c.url)}`
    );
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runGetPage(
  cmdName: 'get' | 'page',
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PAGE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPageHelp(cmdName)) };
  }

  let resourceUrl = parsed.positionals[0];
  const lccn = getStringOption(parsed, 'lccn');
  const date = getStringOption(parsed, 'date');
  const edition = getStringOption(parsed, 'edition') ?? '1';
  const seq = getStringOption(parsed, 'seq') ?? '1';
  const timeout = getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT;
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);

  if (!resourceUrl) {
    if (!lccn || !date) {
      throw new CliValidationError('Give a resource URL or both --lccn and --date.');
    }
    resourceUrl = buildResourceUrl(lccn, date, edition, seq);
  }

  const jsonUrl = resourceUrlJson(resourceUrl);
  const { data, cacheHit } = await cachedGetJson(ctx, jsonUrl, undefined, {
    timeout,
    refresh,
    ttlHours,
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...data, cache_hit: cacheHit });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const item = isPlainRecord(data.item) ? data.item : {};
  const resource = isPlainRecord(data.resource) ? data.resource : {};
  const titleVal = resource.title || item.title;
  const lccnVal = firstValue(item.number_lccn) || item.lccn;
  const lines: string[] = [
    `title: ${formatTextField(titleVal)}${cacheHit ? ' [cache]' : ''}`,
    `date: ${formatTextField(item.date)}`,
    `lccn: ${formatTextField(lccnVal)}`,
    `place: ${formatTextField(firstValue(item.location_city))}, ${formatTextField(firstValue(item.location_state))}`,
    `url: ${resourceUrl}`,
  ];
  const assets = resolvePageAssets(data);
  const assetFields: readonly (readonly [string, keyof PageAssets])[] = [
    ['pdf', 'pdf'],
    ['image', 'image'],
    ['jp2', 'jp2'],
    ['fulltext_file', 'text'],
    ['iiif_manifest_url', 'iiif_manifest_url'],
  ];
  for (const [label, key] of assetFields) {
    const val = assets[key];
    if (val) {
      lines.push(`${label}: ${val}`);
    }
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDownloadHelp()) };
  }

  let resourceUrl = parsed.positionals[0];
  const lccn = getStringOption(parsed, 'lccn');
  const date = getStringOption(parsed, 'date');
  const edition = getStringOption(parsed, 'edition') ?? '1';
  const seqOpt = getStringOption(parsed, 'seq');
  const outOpt = getStringOption(parsed, 'out') ?? '.';
  const pdf = getBooleanOption(parsed, 'pdf');
  const image = getBooleanOption(parsed, 'image');
  const imageWidth = getNumberOption(parsed, 'imageWidth');
  const jp2 = getBooleanOption(parsed, 'jp2');
  const text = getBooleanOption(parsed, 'text');
  const timeout = getNumberOption(parsed, 'timeout') ?? DOWNLOAD_TIMEOUT;
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);

  let resolvedSeq: string;
  if (!resourceUrl) {
    if (!lccn || !date) {
      throw new CliValidationError('Give a resource URL or both --lccn and --date.');
    }
    resolvedSeq = seqOpt || '1';
    resourceUrl = buildResourceUrl(lccn, date, edition, resolvedSeq);
  } else {
    resolvedSeq = seqOpt || extractSeqFromUrl(resourceUrl, '1');
  }

  const resourceJsonUrl = resourceUrlJson(resourceUrl);
  const outParts = outOpt.split(/[\\/]+/);
  if (outParts.includes('..') && !path.isAbsolute(outOpt)) {
    throw new RecordRuntimeError(`Unsafe output directory containing '..': ${outOpt}`);
  }
  const outdir = path.isAbsolute(outOpt) ? outOpt : path.resolve(ctx.cwd, outOpt);
  fs.mkdirSync(outdir, { recursive: true });

  const { data, cacheHit: metaHit } = await cachedGetJson(ctx, resourceJsonUrl, undefined, {
    timeout,
    refresh,
    ttlHours,
  });

  const item = isPlainRecord(data.item) ? data.item : {};
  const itemLccn = firstValue(item.number_lccn);
  const itemDate = item.date;
  const stem = safeOutputFilename(
    `${itemLccn ? String(itemLccn) : 'loc'}_${itemDate ? String(itemDate) : 'nodate'}_sp${resolvedSeq}`
  );
  const assets = resolvePageAssets(data, { imageWidth });

  const jobs: [ChronamAssetKind, string, string][] = [];
  if (pdf && assets.pdf) {
    jobs.push(['pdf', assets.pdf, `${stem}.pdf`]);
  } else if (pdf && !image && assets.image) {
    jobs.push(['image', assets.image, `${stem}.jpg`]);
  }
  if (image && assets.image) {
    jobs.push(['image', assets.image, `${stem}.jpg`]);
  }
  if (jp2 && assets.jp2) {
    jobs.push(['jp2', assets.jp2, `${stem}.jp2`]);
  }
  if (text && assets.text) {
    jobs.push(['text', assets.text, `${stem}.alto.xml`]);
  }

  if (jobs.length === 0) {
    ctx.io.stderr('No downloadable resources found for this page.');
    return { exitCode: 1, bytesOut: 0, cacheHit: metaHit };
  }

  const downloadedFiles: DownloadedFileRecord[] = [];
  const textLines: string[] = [];
  let totalBytes = 0;

  for (const [kind, assetUrl, filename] of jobs) {
    const safeName = safeOutputFilename(filename);
    const dest = resolveSafeChild(outdir, safeName);
    const { cachePath, nbytes, contentType, cacheHit: fileHit } = await cachedDownloadFile(
      ctx,
      assetUrl,
      { timeout, refresh, ttlHours, kind }
    );
    atomicCopyFileSync(cachePath, dest);
    totalBytes += nbytes;
    downloadedFiles.push({
      kind,
      url: assetUrl,
      path: dest,
      bytes: nbytes,
      content_type: contentType,
      cache_hit: fileHit,
    });
    if (!asJson) {
      const marker = fileHit ? ' [cache]' : '';
      textLines.push(`${kind}: ${dest} (${nbytes} bytes)${marker}`);
    }
  }

  const metaName = safeOutputFilename(`${stem}.metadata.json`);
  const metaPath = resolveSafeChild(outdir, metaName);
  atomicWriteFileSync(
    metaPath,
    JSON.stringify(
      {
        resource_url: resourceUrl,
        item,
        resources: data.resources ?? null,
      },
      null,
      2
    )
  );

  const allHit = Boolean(
    metaHit && downloadedFiles.length > 0 && downloadedFiles.every((f) => f.cache_hit)
  );

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      resource_url: resourceUrl,
      out_dir: outdir,
      metadata_path: metaPath,
      metadata_cache_hit: metaHit,
      bytes: totalBytes,
      cache_hit: allHit,
      files: downloadedFiles,
    });
    return { exitCode: 0, bytesOut, cacheHit: allHit };
  }

  textLines.push(`metadata: ${metaPath}`);
  const bytesOut = emitStdout(ctx.io, textLines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: allHit };
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const query = resolveQuery(parsed.positionals, getStringOption(parsed, 'termsOpt'));
  const dates = resolveDates(
    getStringOption(parsed, 'dates'),
    getStringOption(parsed, 'dateFrom'),
    getStringOption(parsed, 'dateTo')
  );
  const level = getStringOption(parsed, 'level') ?? 'page';
  const state = getStringOption(parsed, 'state');
  const lccn = getStringOption(parsed, 'lccn');

  const params = buildSearchParams(query, { dates, level, limit: 10, page: 1, state, lccn });
  const browserParams = params.filter(
    ([k]) => k !== 'fo' && k !== 'at' && k !== 'c' && k !== 'sp'
  );
  const qs = new URLSearchParams(browserParams).toString();
  const bytesOut = emitStdout(ctx.io, `${COLLECTION_BASE}?${qs}`);
  return { exitCode: 0, bytesOut };
}

export const runChronamCommand: RecordHandler = async (
  args,
  ctx
): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'get':
        return await runGetPage('get', rest, ctx);
      case 'page':
        return await runGetPage('page', rest, ctx);
      case 'download':
        return await runDownload(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(
          `No such command '${subcmd}'. Run 'kinloom chronam --help'.`
        );
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof RecordRuntimeError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: err.exitCode, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
