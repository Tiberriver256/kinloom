import fs from 'node:fs';
import path from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { CliValidationError } from '../../../errors.js';
import {
  assertSafeUrl,
  atomicWriteFileSync,
  type CommandParseSpec,
  canonicalJsonStringify,
  emitJsonStdout,
  emitStdout,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  gunzipBytes,
  type OptionSpec,
  parseCacheTtlHours,
  parseCommandArgs,
  parseXml,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  resolveCacheDir,
  resolveSubcommandAlias,
  SsrfBlockedError,
  sha256Hex,
  type UrlSecurityPolicy,
  withAdvisoryLock,
} from '../runtime/index.js';

export const BASE = 'https://archive.org';
export const ADVANCED_SEARCH = `${BASE}/advancedsearch.php`;
export const FULLTEXT_SEARCH = `${BASE}/services/search/beta/page_production/`;
export const USER_AGENT = 'kinloom archive-org skill (research use)';
export const DEFAULT_FIELDS = ['identifier', 'title', 'creator', 'date', 'mediatype'] as const;
export const DEFAULT_TIMEOUT_SECONDS = 25;
export const SEARCH_TIMEOUT_SECONDS = 30;
export const DOWNLOAD_TIMEOUT_SECONDS = 60;
export const DEFAULT_QUERY_TTL_HOURS = 168;
export const MAX_WORKERS = 6;
export const PAGE_BATCH_LIMIT = 25;
export const PAGE_BATCH_WORKERS = 4;
export const RETRYABLE_HTTP_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 522, 524]);
export const MAX_HTTP_RETRIES = 2;
export const MAX_RETRY_AFTER_SECONDS = 5;

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const ARCHIVE_URL_RE =
  /^https?:\/\/(?:www\.)?archive\.org\/(?:details|metadata|download)\/([^/?#]+)(?:\/.*)?(?:[?#].*)?$/i;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

const IA_URL_POLICY: UrlSecurityPolicy = {
  allowedSchemes: ['https:'],
  allowedHosts: ['.archive.org'],
  blockPrivateIps: true,
};

const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  metadata: 'get',
  show: 'get',
  pages: 'page',
};

export class ArchiveNotFoundError extends RecordRuntimeError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'ArchiveNotFoundError';
  }
}

export interface PageIndex {
  leaf_count: number;
  access_leaf_count: number;
  scandata_to_bookreader: Record<string, number>;
  bookreader_to_scandata: Record<string, number>;
  scandata_to_printed: Record<string, string>;
  bookreader_to_printed: Record<string, string>;
  printed_to_bookreader: Record<string, number>;
  printed_to_bookreader_ci: Record<string, number>;
  printed_to_scandata: Record<string, number>;
  segment_mode: string;
  djvu_source?: string;
}

export interface ItemFileEntry {
  readonly name?: string;
  readonly format?: string;
  readonly size?: string | number;
  readonly [key: string]: unknown;
}

export interface ItemMetadataPayload {
  readonly metadata?: Record<string, unknown>;
  readonly files?: readonly ItemFileEntry[];
  readonly [key: string]: unknown;
}

export interface ItemCacheEntry {
  readonly identifier: string;
  readonly itemDir: string;
  readonly metadataPath: string;
  readonly scandataPath: string;
  readonly pageIndexPath: string;
  readonly djvuPath: string;
  readonly cached: boolean;
}

interface GrepHit {
  readonly identifier: string;
  readonly leaf: number | null;
  readonly scandata_leaf: number | null;
  readonly printed_page: string | null;
  readonly match: string;
  readonly snippet: string;
  readonly image_url: string | null;
  readonly details_url: string;
  cached?: boolean;
}

interface PageJob {
  readonly leaf: number;
  readonly scandata_leaf: number | null;
  readonly printed_page: string | null;
  suffix: string;
  url: string;
}

interface WrittenPageRow {
  readonly leaf: number;
  readonly scandata_leaf: number | null;
  readonly printed_page: string | null;
  readonly url: string;
  readonly path: string;
  readonly cache_path: string;
  readonly bytes: number;
  readonly page_cached: boolean;
}

const inProcessLocks = new Map<string, Promise<void>>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTruthyNonEmpty(value: unknown): boolean {
  if (!value) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isPlainRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function isBrokenPipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  if ('code' in err && (err as { code?: unknown }).code === 'EPIPE') {
    return true;
  }
  if (err instanceof Error && /broken pipe/i.test(err.message)) {
    return true;
  }
  return false;
}

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

async function withFileLock<T>(
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

async function runWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Map<number, R>();
  const limit = Math.max(1, Math.min(maxConcurrency, items.length));
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      const value = await worker(items[idx], idx);
      results.set(idx, value);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return items.map((_, idx) => results.get(idx) as R);
}

function getCacheRoot(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_IA_CACHE_DIR'],
    defaultSubdir: 'kinloom-ia',
  });
}

function resolveQueryTtlHours(cliTtl: number | undefined, env: NodeJS.ProcessEnv): number {
  if (cliTtl !== undefined) {
    return parseCacheTtlHours(cliTtl, DEFAULT_QUERY_TTL_HOURS, '--cache-ttl-hours');
  }
  const raw = env.KINLOOM_IA_QUERY_TTL_HOURS;
  if (raw !== undefined && raw.trim().length > 0) {
    return parseCacheTtlHours(raw, DEFAULT_QUERY_TTL_HOURS, 'KINLOOM_IA_QUERY_TTL_HOURS');
  }
  return DEFAULT_QUERY_TTL_HOURS;
}

function quotePathSegment(str: string): string {
  return encodeURIComponent(str)
    .replace(/%2F/gi, '/')
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeQueryPairs(pairs: readonly (readonly [string, string])[]): string {
  const enc = (value: string): string =>
    encodeURIComponent(value)
      .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%20/g, '+');
  return pairs.map(([key, value]) => `${enc(key)}=${enc(value)}`).join('&');
}

export function validateIdentifier(identifier: string): string {
  let cleaned = identifier.trim();
  const urlMatch = ARCHIVE_URL_RE.exec(cleaned);
  if (urlMatch) {
    cleaned = urlMatch[1].trim();
  }
  if (!cleaned || !SAFE_ID_RE.test(cleaned) || cleaned === '.' || cleaned === '..') {
    throw new RecordRuntimeError(`Invalid Internet Archive identifier: '${identifier}'`, 1);
  }
  return cleaned;
}

export function parseLeafInt(raw: string): number {
  const text = raw.trim();
  if (/^[nN]\d+$/.test(text)) {
    return Number.parseInt(text.slice(1), 10);
  }
  if (/^[+-]?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  throw new CliValidationError(`invalid leaf value: '${raw}' (expected integer like 12 or n12)`);
}

export function validateRelativeItemPath(name: string, filesRoot: string): readonly [string, string] {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')) {
    throw new CliValidationError(`Unsafe file path in item: '${name}'`);
  }
  const parts = name.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes(':')) {
      throw new CliValidationError(`Unsafe file path in item: '${name}'`);
    }
  }
  const rel = path.join(...parts);
  const rootResolved = path.resolve(filesRoot);
  const dest = path.resolve(rootResolved, rel);
  if (dest === rootResolved || !dest.startsWith(`${rootResolved}${path.sep}`)) {
    throw new CliValidationError(`Unsafe file path in item: '${name}'`);
  }
  return [rel, dest];
}

function readJsonIfValid(filePath: string): Record<string, unknown> | undefined {
  try {
    if (!fs.statSync(filePath).isFile()) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function atomicWriteCompactJson(dest: string, payload: unknown): void {
  atomicWriteFileSync(dest, JSON.stringify(payload));
}

export function parseRetryAfterMsIa(
  retryAfterHeader: string | null | undefined,
  attempt: number,
  nowMs: number
): number {
  const maxMs = MAX_RETRY_AFTER_SECONDS * 1000;
  const defaultDelayMs = Math.min(maxMs, Math.round(500 * 2 ** attempt));
  if (!retryAfterHeader) {
    return defaultDelayMs;
  }
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) {
    return defaultDelayMs;
  }
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) {
    if (asNum < 0) {
      return defaultDelayMs;
    }
    return Math.min(maxMs, Math.round(asNum * 1000));
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const deltaMs = Math.max(0, parsedDate - nowMs);
    return Math.min(maxMs, Math.round(deltaMs));
  }
  return defaultDelayMs;
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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await ctx.fetchImpl(currentUrl, {
            method: 'GET',
            headers: { 'user-agent': USER_AGENT },
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (err: unknown) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw new Error('The read operation timed out');
          }
          throw err;
        } finally {
          clearTimeout(timer);
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

function looksLikeHtmlBytes(raw: Buffer): boolean {
  let offset = 0;
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    offset = 3;
  }
  const sample = raw
    .subarray(offset, offset + 256)
    .toString('utf8')
    .trimStart()
    .toLowerCase();
  return (
    sample.startsWith('<!doctype') ||
    sample.startsWith('<html') ||
    sample.startsWith('<head') ||
    sample.startsWith('<body')
  );
}

interface HttpGetJsonOptions {
  readonly timeout?: number;
  readonly retryTransientJson?: boolean;
  readonly retryOnTimeout?: boolean;
}

async function httpGetJsonIa(
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

    if (looksLikeHtmlBytes(raw)) {
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

async function cachedQueryJson(
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
    const envelope = readJsonIfValid(cachePath);
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

function isValidMetadata(data: unknown): data is ItemMetadataPayload {
  if (!isPlainRecord(data)) {
    return false;
  }
  return isTruthyNonEmpty(data.metadata) || isTruthyNonEmpty(data.files);
}

async function loadOrFetchMetadataUnlocked(
  itemId: string,
  metaPath: string,
  ctx: RecordCommandContext,
  options: { readonly timeout?: number; readonly refresh?: boolean } = {}
): Promise<readonly [ItemMetadataPayload, boolean]> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const refresh = options.refresh ?? false;
  if (!refresh) {
    const cached = readJsonIfValid(metaPath);
    if (isValidMetadata(cached)) {
      return [cached, true];
    }
  }
  const url = `${BASE}/metadata/${quotePathSegment(itemId)}`;
  const data = await httpGetJsonIa(url, ctx, { timeout });
  if (!isValidMetadata(data)) {
    throw new ArchiveNotFoundError(`No item with identifier ${itemId}`);
  }
  atomicWriteCompactJson(metaPath, data);
  return [data, false];
}

export async function ensureItemMetadata(
  identifier: string,
  ctx: RecordCommandContext,
  options: { readonly cacheRoot?: string; readonly timeout?: number; readonly refresh?: boolean } = {}
): Promise<readonly [ItemMetadataPayload, boolean]> {
  const itemId = validateIdentifier(identifier);
  const root = options.cacheRoot ?? getCacheRoot(ctx);
  const itemDir = path.join(root, itemId);
  const metaPath = path.join(itemDir, 'metadata.json');
  const refresh = options.refresh ?? false;

  if (!refresh) {
    const cached = readJsonIfValid(metaPath);
    if (isValidMetadata(cached)) {
      return [cached, true];
    }
  }

  return withFileLock(
    path.join(itemDir, '.lock'),
    () => loadOrFetchMetadataUnlocked(itemId, metaPath, ctx, options),
    ctx
  );
}

export function itemUrl(identifier: string): string {
  return `${BASE}/details/${quotePathSegment(identifier)}`;
}

export function pageImageUrl(
  identifier: string,
  leafN: number,
  options: { readonly scale?: number; readonly width?: number } = {}
): string {
  if (options.width !== undefined) {
    return `${BASE}/download/${quotePathSegment(identifier)}/page/n${leafN}_w${options.width}.jpg`;
  }
  const effectiveScale = options.scale !== undefined ? options.scale : 2;
  return `${BASE}/download/${quotePathSegment(identifier)}/page/n${leafN}_s${effectiveScale}.jpg`;
}

export function pageDetailsUrl(identifier: string, leafN: number): string {
  return `${BASE}/details/${quotePathSegment(identifier)}/page/n${leafN}`;
}

function shortText(value: unknown, limit = 300): string {
  if (!value) {
    return '';
  }
  const cleaned = String(value).trim().replace(/\s+/g, ' ');
  if (cleaned.length <= limit) {
    return cleaned;
  }
  return `${cleaned.slice(0, limit).trimEnd()} ...`;
}

function getMetadataFiles(meta: ItemMetadataPayload): readonly ItemFileEntry[] {
  if (!Array.isArray(meta.files)) {
    return [];
  }
  return meta.files.filter((entry): entry is ItemFileEntry => isPlainRecord(entry));
}

function findItemFile(
  files: readonly ItemFileEntry[],
  options: { readonly suffixes: readonly string[]; readonly formats?: readonly string[] }
): string | undefined {
  const lowerSuffixes = options.suffixes.map((s) => s.toLowerCase());
  for (const entry of files) {
    const name = typeof entry.name === 'string' ? entry.name : '';
    const lowerName = name.toLowerCase();
    if (name && lowerSuffixes.some((suf) => lowerName.endsWith(suf))) {
      return name;
    }
  }
  if (options.formats && options.formats.length > 0) {
    const fmtSet = new Set(options.formats.map((f) => f.toLowerCase()));
    for (const entry of files) {
      const fmt = typeof entry.format === 'string' ? entry.format.toLowerCase() : '';
      const name = typeof entry.name === 'string' ? entry.name : '';
      if (name && fmtSet.has(fmt)) {
        return name;
      }
    }
  }
  return undefined;
}

function extractXmlText(node: unknown): string {
  if (node === null || node === undefined) {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (isPlainRecord(node) && '#text' in node) {
    return extractXmlText(node['#text']);
  }
  return '';
}

function findPageDataNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPageDataNode(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (Object.hasOwn(record, 'pageData')) {
    return record.pageData;
  }
  for (const value of Object.values(record)) {
    const found = findPageDataNode(value);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export function parseScandataXml(xmlBytes: Uint8Array): PageIndex {
  const xmlText = Buffer.from(xmlBytes).toString('utf8');
  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    throw new Error('Invalid scandata.xml XML payload.');
  }
  const parsed = parseXml<unknown>(xmlText);
  const pageDataNode = findPageDataNode(parsed);
  if (pageDataNode === undefined) {
    throw new Error('scandata.xml is missing <pageData>.');
  }

  let rawPages: unknown[] = [];
  if (isPlainRecord(pageDataNode) && Object.hasOwn(pageDataNode, 'page')) {
    const pageField = pageDataNode.page;
    rawPages = Array.isArray(pageField) ? pageField : pageField ? [pageField] : [];
  }

  const scandataToBookreader: Record<string, number> = {};
  const bookreaderToScandata: Record<string, number> = {};
  const scandataToPrinted: Record<string, string> = {};
  const bookreaderToPrinted: Record<string, string> = {};
  const printedToBookreader: Record<string, number> = {};
  const printedToBookreaderCi: Record<string, number> = {};
  const printedToScandata: Record<string, number> = {};

  let accessIdx = 0;
  for (let seqIdx = 0; seqIdx < rawPages.length; seqIdx += 1) {
    const rawPage = rawPages[seqIdx];
    const pageEl = isPlainRecord(rawPage) ? rawPage : {};
    const rawLeaf = pageEl['@_leafNum'];
    let leafNum = seqIdx;
    if (typeof rawLeaf === 'string' && /^[+-]?\d+$/.test(rawLeaf.trim())) {
      leafNum = Number.parseInt(rawLeaf.trim(), 10);
    }

    const pageType = extractXmlText(pageEl.pageType).trim();
    let inAccess: boolean;
    if (Object.hasOwn(pageEl, 'addToAccessFormats') && pageEl.addToAccessFormats !== undefined) {
      inAccess = extractXmlText(pageEl.addToAccessFormats).trim().toLowerCase() === 'true';
    } else {
      inAccess = pageType.toLowerCase() !== 'delete';
    }

    const printed = extractXmlText(pageEl.pageNumber).trim();
    const leafKey = String(leafNum);
    if (printed) {
      scandataToPrinted[leafKey] = printed;
      if (!Object.hasOwn(printedToScandata, printed)) {
        printedToScandata[printed] = leafNum;
      }
    }

    if (inAccess) {
      const brN = accessIdx;
      accessIdx += 1;
      scandataToBookreader[leafKey] = brN;
      bookreaderToScandata[String(brN)] = leafNum;
      if (printed) {
        bookreaderToPrinted[String(brN)] = printed;
        if (!Object.hasOwn(printedToBookreader, printed)) {
          printedToBookreader[printed] = brN;
        }
        const printedLower = printed.toLowerCase();
        if (!Object.hasOwn(printedToBookreaderCi, printedLower)) {
          printedToBookreaderCi[printedLower] = brN;
        }
      }
    }
  }

  return {
    leaf_count: rawPages.length,
    access_leaf_count: accessIdx,
    scandata_to_bookreader: scandataToBookreader,
    bookreader_to_scandata: bookreaderToScandata,
    scandata_to_printed: scandataToPrinted,
    bookreader_to_printed: bookreaderToPrinted,
    printed_to_bookreader: printedToBookreader,
    printed_to_bookreader_ci: printedToBookreaderCi,
    printed_to_scandata: printedToScandata,
    segment_mode: 'scandata',
  };
}

export function emptyPageIndex(): PageIndex {
  return {
    leaf_count: 0,
    access_leaf_count: 0,
    scandata_to_bookreader: {},
    bookreader_to_scandata: {},
    scandata_to_printed: {},
    bookreader_to_printed: {},
    printed_to_bookreader: {},
    printed_to_bookreader_ci: {},
    printed_to_scandata: {},
    segment_mode: 'bookreader',
  };
}

function maybeGunzip(raw: Uint8Array): Buffer {
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    return gunzipBytes(raw);
  }
  return Buffer.from(raw);
}

export function synthesizeDjvuFromHocr(searchtextGz: Uint8Array, pageindexGz: Uint8Array): string {
  const text = maybeGunzip(searchtextGz).toString('utf8');
  const offsets: unknown = JSON.parse(maybeGunzip(pageindexGz).toString('utf8'));
  if (!Array.isArray(offsets) || offsets.length === 0) {
    return text;
  }
  const segments: string[] = [];
  const textLen = text.length;
  for (const row of offsets) {
    if (Array.isArray(row) && row.length >= 2) {
      const rawStart = Number(row[0]);
      const rawEnd = Number(row[1]);
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
        throw new Error('Invalid hOCR page index offset.');
      }
      const start = Math.max(0, Math.min(Math.trunc(rawStart), textLen));
      const end = Math.max(start, Math.min(Math.trunc(rawEnd), textLen));
      segments.push(text.slice(start, end).replaceAll('\x0c', ' '));
    } else {
      segments.push('');
    }
  }
  return segments.join('\x0c');
}

async function fetchUrlsMap(
  tasks: Readonly<Record<string, string>>,
  ctx: RecordCommandContext,
  timeoutSeconds: number
): Promise<{ readonly fetched: Record<string, Buffer>; readonly errors: Record<string, Error> }> {
  const entries = Object.entries(tasks);
  const fetched: Record<string, Buffer> = {};
  const errors: Record<string, Error> = {};
  if (entries.length === 0) {
    return { fetched, errors };
  }
  await runWithConcurrency(entries, MAX_WORKERS, async ([key, url]) => {
    try {
      fetched[key] = await httpGetBytesIa(url, ctx, timeoutSeconds);
    } catch (err: unknown) {
      errors[key] = err instanceof Error ? err : new Error(String(err));
    }
  });
  return { fetched, errors };
}

function readPageIndex(filePath: string): PageIndex | undefined {
  const parsed = readJsonIfValid(filePath);
  if (!parsed) {
    return undefined;
  }
  return parsed as unknown as PageIndex;
}

export async function ensureItemCache(
  identifier: string,
  ctx: RecordCommandContext,
  options: {
    readonly needDjvu: boolean;
    readonly cacheRoot?: string;
    readonly timeout?: number;
    readonly refresh?: boolean;
  }
): Promise<ItemCacheEntry> {
  const itemId = validateIdentifier(identifier);
  const root = options.cacheRoot ?? getCacheRoot(ctx);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const refresh = options.refresh ?? false;
  const itemDir = path.join(root, itemId);
  const metaPath = path.join(itemDir, 'metadata.json');
  const scandataPath = path.join(itemDir, 'scandata.xml');
  const pageIndexPath = path.join(itemDir, 'page_index.json');
  const djvuPath = path.join(itemDir, 'djvu.txt');

  const isFile = (filePath: string): boolean => {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  };

  const cacheReady = (): boolean =>
    !refresh &&
    isValidMetadata(readJsonIfValid(metaPath)) &&
    readJsonIfValid(pageIndexPath) !== undefined &&
    (!options.needDjvu || isFile(djvuPath));

  if (cacheReady()) {
    return {
      identifier: itemId,
      itemDir,
      metadataPath: metaPath,
      scandataPath,
      pageIndexPath,
      djvuPath,
      cached: true,
    };
  }

  return withFileLock(
    path.join(itemDir, '.lock'),
    async () => {
      if (cacheReady()) {
        return {
          identifier: itemId,
          itemDir,
          metadataPath: metaPath,
          scandataPath,
          pageIndexPath,
          djvuPath,
          cached: true,
        };
      }

      const [metaData] = await loadOrFetchMetadataUnlocked(itemId, metaPath, ctx, {
        timeout,
        refresh,
      });
      const existingPageIndex = refresh ? undefined : readPageIndex(pageIndexPath);
      const hasPageIndex = existingPageIndex !== undefined;
      const hasDjvu = !refresh && isFile(djvuPath);

      const files = getMetadataFiles(metaData);
      const scandataName = findItemFile(files, {
        suffixes: ['_scandata.xml', 'scandata.xml'],
        formats: ['scandata'],
      });
      const djvuName = findItemFile(files, {
        suffixes: ['_djvu.txt'],
        formats: ['djvutxt'],
      });
      const hocrTextName = findItemFile(files, {
        suffixes: ['_hocr_searchtext.txt.gz'],
        formats: ['ocr search text'],
      });
      const hocrIdxName = findItemFile(files, {
        suffixes: ['_hocr_pageindex.json.gz'],
        formats: ['ocr page index'],
      });

      const stage1Tasks: Record<string, string> = {};
      if (!hasPageIndex && scandataName && (refresh || !isFile(scandataPath))) {
        stage1Tasks.scandata = `${BASE}/download/${quotePathSegment(itemId)}/${quotePathSegment(scandataName)}`;
      }
      if (options.needDjvu && !hasDjvu) {
        if (djvuName) {
          stage1Tasks.djvu = `${BASE}/download/${quotePathSegment(itemId)}/${quotePathSegment(djvuName)}`;
        } else if (hocrTextName && hocrIdxName) {
          stage1Tasks.hocr_text = `${BASE}/download/${quotePathSegment(itemId)}/${quotePathSegment(hocrTextName)}`;
          stage1Tasks.hocr_idx = `${BASE}/download/${quotePathSegment(itemId)}/${quotePathSegment(hocrIdxName)}`;
        }
      }

      const { fetched, errors: fetchErrors } = await fetchUrlsMap(stage1Tasks, ctx, timeout);

      let pageIndex: PageIndex;
      if (hasPageIndex && existingPageIndex) {
        pageIndex = existingPageIndex;
      } else {
        let scandataBytes: Buffer | undefined = fetched.scandata;
        if (scandataBytes === undefined && !refresh && isFile(scandataPath)) {
          scandataBytes = fs.readFileSync(scandataPath);
        }
        if (scandataBytes !== undefined) {
          try {
            pageIndex = parseScandataXml(scandataBytes);
            atomicWriteFileSync(scandataPath, scandataBytes);
          } catch {
            pageIndex = emptyPageIndex();
          }
        } else {
          pageIndex = emptyPageIndex();
        }
      }

      if (options.needDjvu && !hasDjvu) {
        const djvuRaw = fetched.djvu;
        const decodedDjvu = djvuRaw !== undefined ? djvuRaw.toString('utf8') : undefined;
        const hasFormFeeds = decodedDjvu !== undefined && decodedDjvu.includes('\x0c');

        if (!hasFormFeeds && hocrTextName && hocrIdxName) {
          const hocrTasks: Record<string, string> = {};
          if (!Object.hasOwn(fetched, 'hocr_text')) {
            hocrTasks.hocr_text = `${BASE}/download/${quotePathSegment(itemId)}/${quotePathSegment(hocrTextName)}`;
          }
          if (!Object.hasOwn(fetched, 'hocr_idx')) {
            hocrTasks.hocr_idx = `${BASE}/download/${quotePathSegment(itemId)}/${quotePathSegment(hocrIdxName)}`;
          }
          if (Object.keys(hocrTasks).length > 0) {
            const hocrRes = await fetchUrlsMap(hocrTasks, ctx, timeout);
            Object.assign(fetched, hocrRes.fetched);
            Object.assign(fetchErrors, hocrRes.errors);
          }
        }

        let djvuBytesOut: Buffer | undefined;
        let djvuSource: string | undefined;
        let segmentMode = pageIndex.segment_mode || 'scandata';

        if (hasFormFeeds && djvuRaw !== undefined && decodedDjvu !== undefined) {
          djvuBytesOut = djvuRaw;
          djvuSource = 'djvu_txt';
          const segCount = decodedDjvu.split('\x0c').length;
          const accessCount = Number(pageIndex.access_leaf_count || 0);
          const leafCount = Number(pageIndex.leaf_count || 0);
          if (accessCount > 0 && Math.abs(segCount - accessCount) < Math.abs(segCount - leafCount)) {
            segmentMode = 'bookreader';
          } else {
            segmentMode = 'scandata';
          }
        } else if (fetched.hocr_text !== undefined && fetched.hocr_idx !== undefined) {
          try {
            djvuBytesOut = Buffer.from(synthesizeDjvuFromHocr(fetched.hocr_text, fetched.hocr_idx), 'utf8');
            djvuSource = 'hocr';
            segmentMode = 'scandata';
          } catch (err: unknown) {
            fetchErrors.hocr = err instanceof Error ? err : new Error(String(err));
          }
        }

        if (djvuBytesOut === undefined && djvuRaw !== undefined) {
          djvuBytesOut = djvuRaw;
          djvuSource = 'djvu_txt';
          segmentMode = 'flat';
        }

        if (djvuBytesOut === undefined) {
          const errDetail = Object.entries(fetchErrors)
            .map(([k, v]) => `${k}: ${v.message}`)
            .join('; ');
          throw new RecordRuntimeError(
            `Item ${itemId} has no downloadable OCR text (_djvu.txt or _hocr_searchtext.txt.gz)${errDetail ? ` (${errDetail})` : ''}`
          );
        }

        pageIndex.segment_mode = segmentMode;
        if (djvuSource !== undefined) {
          pageIndex.djvu_source = djvuSource;
        }
        atomicWriteFileSync(djvuPath, djvuBytesOut);
        atomicWriteCompactJson(pageIndexPath, pageIndex);
      } else if (!hasPageIndex) {
        atomicWriteCompactJson(pageIndexPath, pageIndex);
      }

      return {
        identifier: itemId,
        itemDir,
        metadataPath: metaPath,
        scandataPath,
        pageIndexPath,
        djvuPath,
        cached: false,
      };
    },
    ctx
  );
}

function reuseExistingItemArtifact(
  itemDir: string,
  fileName: string,
  fileList: readonly ItemFileEntry[],
  fileEntry: ItemFileEntry
): Buffer | undefined {
  const isFile = (filePath: string): boolean => {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  };

  const scandataName = findItemFile(fileList, {
    suffixes: ['_scandata.xml', 'scandata.xml'],
    formats: ['scandata'],
  });
  const scandataPath = path.join(itemDir, 'scandata.xml');
  if (scandataName && fileName === scandataName && isFile(scandataPath)) {
    return fs.readFileSync(scandataPath);
  }

  const djvuName = findItemFile(fileList, { suffixes: ['_djvu.txt'], formats: ['djvutxt'] });
  const djvuPath = path.join(itemDir, 'djvu.txt');
  if (djvuName && fileName === djvuName && isFile(djvuPath)) {
    const pageIndex = readJsonIfValid(path.join(itemDir, 'page_index.json')) ?? {};
    const djvuSource = pageIndex.djvu_source;
    if (djvuSource === 'djvu_txt') {
      return fs.readFileSync(djvuPath);
    }
    if (djvuSource === undefined || djvuSource === null) {
      const rawSize = fileEntry.size;
      if (rawSize !== undefined && rawSize !== null) {
        const expectedSize = Number.parseInt(String(rawSize), 10);
        try {
          if (Number.isFinite(expectedSize) && fs.statSync(djvuPath).size === expectedSize) {
            return fs.readFileSync(djvuPath);
          }
        } catch {
          // Ignore stat error.
        }
      } else if (
        !findItemFile(fileList, {
          suffixes: ['_hocr_searchtext.txt.gz'],
          formats: ['ocr search text'],
        })
      ) {
        return fs.readFileSync(djvuPath);
      }
    }
  }
  return undefined;
}

async function ensureDownloadedFile(
  identifier: string,
  fileName: string,
  fileList: readonly ItemFileEntry[],
  fileEntry: ItemFileEntry,
  ctx: RecordCommandContext,
  options: { readonly cacheRoot?: string; readonly timeout?: number; readonly refresh?: boolean } = {}
): Promise<readonly [Buffer, string, boolean]> {
  const itemId = validateIdentifier(identifier);
  const root = options.cacheRoot ?? getCacheRoot(ctx);
  const timeout = options.timeout ?? DOWNLOAD_TIMEOUT_SECONDS;
  const refresh = options.refresh ?? false;
  const itemDir = path.join(root, itemId);
  const filesRoot = path.join(itemDir, 'files');
  const [, cachePath] = validateRelativeItemPath(fileName, filesRoot);

  const isFile = (filePath: string): boolean => {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  };

  if (!refresh) {
    if (isFile(cachePath)) {
      return [fs.readFileSync(cachePath), cachePath, true];
    }
    const reused = reuseExistingItemArtifact(itemDir, fileName, fileList, fileEntry);
    if (reused !== undefined) {
      return [reused, itemDir, true];
    }
  }

  return withFileLock(
    path.join(itemDir, '.lock'),
    async () => {
      if (!refresh) {
        if (isFile(cachePath)) {
          return [fs.readFileSync(cachePath), cachePath, true];
        }
        const reused = reuseExistingItemArtifact(itemDir, fileName, fileList, fileEntry);
        if (reused !== undefined) {
          return [reused, itemDir, true];
        }
      }
      const url = `${BASE}/download/${quotePathSegment(itemId)}/${quotePathSegment(fileName)}`;
      const content = await httpGetBytesIa(url, ctx, timeout);
      atomicWriteFileSync(cachePath, content);
      return [content, cachePath, false];
    },
    ctx
  );
}

export async function ensurePageImageCache(
  identifier: string,
  leafN: number,
  suffixTag: string,
  url: string,
  ctx: RecordCommandContext,
  options: { readonly cacheRoot?: string; readonly timeout?: number; readonly refresh?: boolean } = {}
): Promise<readonly [Buffer, string, boolean]> {
  const itemId = validateIdentifier(identifier);
  const root = options.cacheRoot ?? getCacheRoot(ctx);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const refresh = options.refresh ?? false;
  const itemDir = path.join(root, itemId);
  const pageCachePath = path.join(itemDir, 'pages', `n${leafN}_${suffixTag}.jpg`);

  const hasCachedPage = (): boolean => {
    try {
      const stat = fs.statSync(pageCachePath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  };

  if (!refresh && hasCachedPage()) {
    return [fs.readFileSync(pageCachePath), pageCachePath, true];
  }

  const pageLock = path.join(path.dirname(pageCachePath), `.${path.basename(pageCachePath)}.lock`);
  return withFileLock(
    pageLock,
    async () => {
      if (!refresh && hasCachedPage()) {
        return [fs.readFileSync(pageCachePath), pageCachePath, true];
      }
      const content = await httpGetBytesIa(url, ctx, timeout);
      atomicWriteFileSync(pageCachePath, content);
      return [content, pageCachePath, false];
    },
    ctx
  );
}

function resolveSegmentPage(
  segIdx: number,
  pageIndex: PageIndex
): readonly [number | null, number | null, string | null] {
  const mode = pageIndex.segment_mode || 'scandata';
  if (mode === 'flat') {
    return [null, null, null];
  }
  const key = String(segIdx);
  if (mode === 'bookreader') {
    const b2s = pageIndex.bookreader_to_scandata ?? {};
    const b2p = pageIndex.bookreader_to_printed ?? {};
    const scandataLeaf = Object.hasOwn(b2s, key) ? b2s[key] : null;
    const printed = Object.hasOwn(b2p, key) ? b2p[key] : null;
    return [segIdx, scandataLeaf, printed];
  }
  const s2b = pageIndex.scandata_to_bookreader ?? {};
  const s2p = pageIndex.scandata_to_printed ?? {};
  let brN: number | null = Object.hasOwn(s2b, key) ? s2b[key] : null;
  if (brN === null && Object.keys(s2b).length === 0) {
    brN = segIdx;
  }
  const printed = Object.hasOwn(s2p, key) ? s2p[key] : null;
  return [brN, segIdx, printed];
}

function extractSnippet(
  pageText: string,
  matchStart: number,
  matchEnd: number,
  contextChars: number
): string {
  const half = Math.max(20, Math.floor(contextChars / 2));
  const start = Math.max(0, matchStart - half);
  const end = Math.min(pageText.length, matchEnd + half);
  const raw = pageText.slice(start, end);
  let cleaned = raw.trim().replace(/\s+/g, ' ');
  if (start > 0) {
    cleaned = `...${cleaned}`;
  }
  if (end < pageText.length) {
    cleaned = `${cleaned}...`;
  }
  return cleaned;
}

function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\r') {
      if (i + 1 < text.length && text[i + 1] === '\n') {
        i += 1;
      }
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (ch === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

function grepCachedItem(
  identifier: string,
  djvuText: string,
  pageIndex: PageIndex,
  pattern: string,
  ignoreCase: boolean,
  options: { readonly contextChars: number; readonly limit: number }
): readonly [GrepHit[], number] {
  const testRegex = new RegExp(pattern, ignoreCase ? 'i' : '');
  const iterRegex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
  const hits: GrepHit[] = [];
  let totalMatches = 0;
  const pages = djvuText.split('\x0c');

  for (let segIdx = 0; segIdx < pages.length; segIdx += 1) {
    const pageText = pages[segIdx];
    if (!pageText || !testRegex.test(pageText)) {
      continue;
    }
    let offset = 0;
    for (const line of splitLinesKeepEnds(pageText)) {
      iterRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = iterRegex.exec(line)) !== null) {
        if (match[0].length === 0) {
          if (iterRegex.lastIndex >= line.length) {
            break;
          }
          iterRegex.lastIndex += 1;
          continue;
        }
        totalMatches += 1;
        if (hits.length < options.limit) {
          const [leafN, scandataLeaf, printedPage] = resolveSegmentPage(segIdx, pageIndex);
          const mStart = offset + match.index;
          const mEnd = mStart + match[0].length;
          hits.push({
            identifier,
            leaf: leafN,
            scandata_leaf: scandataLeaf,
            printed_page: printedPage,
            match: match[0],
            snippet: extractSnippet(pageText, mStart, mEnd, options.contextChars),
            image_url: leafN !== null ? pageImageUrl(identifier, leafN, { scale: 2 }) : null,
            details_url: leafN !== null ? pageDetailsUrl(identifier, leafN) : itemUrl(identifier),
          });
        }
      }
      offset += line.length;
    }
  }

  return [hits, totalMatches];
}

function resolvePrintedPageToLeaf(
  pageIndex: PageIndex,
  printedPage: string
): readonly [number, number | null] {
  const target = printedPage.trim();
  const p2b = pageIndex.printed_to_bookreader ?? {};
  const b2s = pageIndex.bookreader_to_scandata ?? {};
  if (Object.hasOwn(p2b, target)) {
    const brN = Number(p2b[target]);
    const scLeaf = Object.hasOwn(b2s, String(brN)) ? b2s[String(brN)] : null;
    return [brN, scLeaf];
  }
  const p2bCi = pageIndex.printed_to_bookreader_ci ?? {};
  const lower = target.toLowerCase();
  if (Object.hasOwn(p2bCi, lower)) {
    const brN = Number(p2bCi[lower]);
    const scLeaf = Object.hasOwn(b2s, String(brN)) ? b2s[String(brN)] : null;
    return [brN, scLeaf];
  }
  const p2s = pageIndex.printed_to_scandata ?? {};
  if (Object.hasOwn(p2s, target)) {
    const scLeaf = Number(p2s[target]);
    return [scLeaf, scLeaf];
  }
  const samplePages = Object.keys(p2b);
  const hint =
    samplePages.length > 0
      ? ` (known printed pages: ${samplePages[0]}..${samplePages[samplePages.length - 1]}, total ${samplePages.length})`
      : ' (no printed page numbers in scandata.xml)';
  throw new RecordRuntimeError(`Printed page '${printedPage}' not found in page_index.json${hint}`);
}

function describeLeaf(
  pageIndex: PageIndex,
  leafN: number
): {
  leaf: number;
  scandata_leaf: number | null;
  printed_page: string | null;
} {
  const key = String(leafN);
  const b2s = pageIndex.bookreader_to_scandata ?? {};
  const b2p = pageIndex.bookreader_to_printed ?? {};
  return {
    leaf: leafN,
    scandata_leaf: Object.hasOwn(b2s, key) ? b2s[key] : null,
    printed_page: Object.hasOwn(b2p, key) ? b2p[key] : null,
  };
}

function validateLeafInIndex(pageIndex: PageIndex, leafN: number): void {
  if (leafN < 0) {
    throw new RecordRuntimeError(`Leaf index must be >= 0, got ${leafN}.`);
  }
  const accessCount = Number(pageIndex.access_leaf_count || 0);
  if (accessCount > 0 && leafN >= accessCount) {
    throw new RecordRuntimeError(
      `Leaf n${leafN} is out of range (item has ${accessCount} BookReader leaves: n0..n${accessCount - 1}).`
    );
  }
}

function leafFromScandataLeaf(pageIndex: PageIndex, scandataLeaf: number): number {
  const s2b = pageIndex.scandata_to_bookreader ?? {};
  const key = String(scandataLeaf);
  if (Object.hasOwn(s2b, key)) {
    return Number(s2b[key]);
  }
  if (Object.keys(s2b).length === 0) {
    throw new RecordRuntimeError(
      `Scandata leaf ${scandataLeaf} cannot be resolved (no scandata.xml mapping cached).`
    );
  }
  throw new RecordRuntimeError(
    `Scandata leaf ${scandataLeaf} is not an access leaf (deleted or unknown) in page_index.json.`
  );
}

function segmentForLeaf(pageIndex: PageIndex, leafN: number, scandataLeaf: number | null): number | null {
  const mode = pageIndex.segment_mode || 'scandata';
  if (mode === 'flat') {
    return null;
  }
  if (mode === 'bookreader') {
    return leafN;
  }
  if (scandataLeaf !== null) {
    return scandataLeaf;
  }
  if (Object.keys(pageIndex.scandata_to_bookreader ?? {}).length === 0) {
    return leafN;
  }
  return null;
}

function parsePrintedRange(pageIndex: PageIndex, spec: string): number[] {
  const cleaned = spec.trim();
  if (!cleaned) {
    throw new RecordRuntimeError('Empty --pages range.');
  }
  const parts = cleaned.split(',').map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new RecordRuntimeError(
      `Invalid --pages range '${spec}'; expected labels or ranges like 12-14 or 12,14.`
    );
  }
  const leaves: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    let resolvedSingle: number | undefined;
    try {
      const [leaf] = resolvePrintedPageToLeaf(pageIndex, part);
      resolvedSingle = leaf;
    } catch {
      resolvedSingle = undefined;
    }

    let chunk: number[];
    if (resolvedSingle !== undefined) {
      chunk = [resolvedSingle];
    } else if (!part.includes('-')) {
      const [leaf] = resolvePrintedPageToLeaf(pageIndex, part);
      chunk = [leaf];
    } else {
      const dashIdx = part.indexOf('-');
      const startLabel = part.slice(0, dashIdx);
      const endLabel = part.slice(dashIdx + 1);
      if (!startLabel.trim() || !endLabel.trim()) {
        throw new RecordRuntimeError(`Invalid --pages range '${spec}'; expected <p1>-<p2>.`);
      }
      const [startLeaf] = resolvePrintedPageToLeaf(pageIndex, startLabel);
      const [endLeaf] = resolvePrintedPageToLeaf(pageIndex, endLabel);
      if (endLeaf < startLeaf) {
        throw new RecordRuntimeError(
          `Invalid --pages range '${spec}': printed page '${endLabel.trim()}' (n${endLeaf}) precedes '${startLabel.trim()}' (n${startLeaf}).`
        );
      }
      chunk = Array.from({ length: endLeaf - startLeaf + 1 }, (_, i) => startLeaf + i);
    }

    for (const leaf of chunk) {
      if (!seen.has(leaf)) {
        seen.add(leaf);
        leaves.push(leaf);
      }
    }
  }
  return leaves;
}

function parseLeafSpec(spec: string): number[] {
  const leaves: number[] = [];
  const seen = new Set<number>();
  const parts = spec.split(',').map((part) => part.trim());
  if (!spec.trim() || parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new CliValidationError(
      'Invalid --leaves value. Use integers or inclusive ranges like 120-123,130.'
    );
  }
  for (const part of parts) {
    const rangeMatch = /^[nN]?(\d+)\s*-\s*[nN]?(\d+)$/.exec(part);
    let chunk: number[];
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (end < start) {
        throw new CliValidationError(`Invalid --leaves range '${part}': ${end} precedes ${start}.`);
      }
      if (end - start + 1 > PAGE_BATCH_LIMIT) {
        throw new CliValidationError(
          `--leaves asks for more than ${PAGE_BATCH_LIMIT} pages. Split the request into batches of ${PAGE_BATCH_LIMIT} or fewer.`
        );
      }
      chunk = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    } else if (/^[nN]?\d+$/.test(part)) {
      const num = Number.parseInt(part[0] === 'n' || part[0] === 'N' ? part.slice(1) : part, 10);
      chunk = [num];
    } else {
      throw new CliValidationError(
        `Invalid --leaves token '${part}'. Use integers or inclusive ranges like 120-123,130.`
      );
    }
    for (const leaf of chunk) {
      if (!seen.has(leaf)) {
        seen.add(leaf);
        leaves.push(leaf);
        if (leaves.length > PAGE_BATCH_LIMIT) {
          throw new CliValidationError(
            `--leaves asks for more than ${PAGE_BATCH_LIMIT} pages. Split the request into batches of ${PAGE_BATCH_LIMIT} or fewer.`
          );
        }
      }
    }
  }
  return leaves;
}

function parsePrintedPageSpec(spec: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const parts = spec.split(',').map((part) => part.trim());
  if (!spec.trim() || parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new CliValidationError(
      'Invalid --printed-pages value. Use printed labels or inclusive integer ranges like 670-674,707.'
    );
  }
  for (const part of parts) {
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    let chunk: string[];
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (end < start) {
        throw new CliValidationError(`Invalid --printed-pages range '${part}': ${end} precedes ${start}.`);
      }
      if (end - start + 1 > PAGE_BATCH_LIMIT) {
        throw new CliValidationError(
          `--printed-pages asks for more than ${PAGE_BATCH_LIMIT} pages. Split the request into batches of ${PAGE_BATCH_LIMIT} or fewer.`
        );
      }
      chunk = Array.from({ length: end - start + 1 }, (_, i) => String(start + i));
    } else {
      chunk = [part];
    }
    for (const label of chunk) {
      if (!seen.has(label)) {
        seen.add(label);
        labels.push(label);
        if (labels.length > PAGE_BATCH_LIMIT) {
          throw new CliValidationError(
            `--printed-pages asks for more than ${PAGE_BATCH_LIMIT} pages. Split the request into batches of ${PAGE_BATCH_LIMIT} or fewer.`
          );
        }
      }
    }
  }
  return labels;
}

function pageSuffixAndUrl(
  identifier: string,
  leaf: number,
  scale: number | undefined,
  width: number | undefined
): readonly [string, string] {
  if (scale !== undefined) {
    return [`s${scale}`, pageImageUrl(identifier, leaf, { scale })];
  }
  const chosenWidth = width !== undefined ? width : 2400;
  return [`w${chosenWidth}`, pageImageUrl(identifier, leaf, { width: chosenWidth })];
}

function resolveSearchQuery(
  queryParts: readonly string[],
  queryFlag: string | undefined,
  options: { readonly mediatype?: string; readonly collections?: readonly string[] } = {}
): string {
  const posText = queryParts
    .filter((p) => p.length > 0)
    .join(' ')
    .trim();
  const flagText = (queryFlag ?? '').trim();
  if (posText && flagText) {
    throw new CliValidationError('Pass either a positional query or --query/-q, not both.');
  }
  const base = flagText || posText;
  const clauses: string[] = [];
  if (base) {
    clauses.push(base);
  }
  if (options.mediatype && options.mediatype.trim()) {
    clauses.push(`mediatype:(${options.mediatype.trim()})`);
  }
  const flatCollections: string[] = [];
  for (const item of options.collections ?? []) {
    for (const part of item.split(',')) {
      const cleaned = part.trim();
      if (cleaned) {
        flatCollections.push(cleaned);
      }
    }
  }
  if (flatCollections.length === 1) {
    clauses.push(`collection:(${flatCollections[0]})`);
  } else if (flatCollections.length > 1) {
    clauses.push(`collection:(${flatCollections.join(' OR ')})`);
  }
  if (clauses.length === 0) {
    throw new CliValidationError('Pass a search query (or --collection / --mediatype).');
  }
  return clauses.join(' AND ');
}

function flattenFields(rawFields: readonly string[]): string[] {
  const fields: string[] = [];
  for (const item of rawFields) {
    for (const part of item.split(',')) {
      const cleaned = part.trim();
      if (cleaned && !fields.includes(cleaned)) {
        fields.push(cleaned);
      }
    }
  }
  return fields.length > 0 ? fields : [...DEFAULT_FIELDS];
}

function looksLikeIdentifierToken(token: string): boolean {
  const cleaned = token.trim();
  if (!cleaned) {
    return false;
  }
  if (ARCHIVE_URL_RE.test(cleaned)) {
    return true;
  }
  return SAFE_ID_RE.test(cleaned) && cleaned !== '.' && cleaned !== '..';
}

function validatePositiveTimeout(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new CliValidationError(`--timeout must be > 0, got ${timeout}.`);
  }
  return timeout;
}

function jsonWithCacheHit(
  payload: Readonly<Record<string, unknown>>,
  cacheHit: boolean
): Record<string, unknown> {
  return { ...payload, cache_hit: Boolean(cacheHit) };
}

// ---------- Option Specs ----------

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'queryFlag',
    kind: 'string',
    flags: ['-q', '--query'],
    metavar: 'QUERY',
    help: 'Lucene query string (alternative to positional query).',
  },
  {
    key: 'mediatype',
    kind: 'string',
    flags: ['--mediatype', '--type'],
    metavar: 'TYPE',
    help: 'e.g. texts, movies, audio, software, collection.',
  },
  {
    key: 'collections',
    kind: 'string',
    flags: ['--collection'],
    multiple: true,
    metavar: 'COLLECTION',
    help: 'Filter by collection identifier (repeatable or comma-separated).',
  },
  {
    key: 'rows',
    kind: 'integer',
    flags: ['--rows', '--limit', '-n'],
    default: 10,
    metavar: 'N',
    help: 'Results per page (default: 10).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    default: 1,
    metavar: 'N',
    help: 'Results page (default: 1).',
  },
  {
    key: 'sorts',
    kind: 'string',
    flags: ['--sort'],
    multiple: true,
    metavar: 'SORT',
    help: "Repeatable, e.g. --sort 'downloads desc'.",
  },
  {
    key: 'fields',
    kind: 'string',
    flags: ['--field', '--fields'],
    multiple: true,
    metavar: 'FIELD',
    help: 'Repeatable or comma-separated metadata field(s).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: SEARCH_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${SEARCH_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Query cache TTL in hours (default: 168 or KINLOOM_IA_QUERY_TTL_HOURS).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and fetch fresh results.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Full JSON output.',
  },
];

const SEARCH_PARSE_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
};

const GET_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Full JSON output.' },
  { key: 'files', kind: 'boolean', flags: ['--files'], help: "List the item's files." },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local metadata cache and fetch fresh metadata.',
  },
];

const GET_PARSE_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'identifier',
};

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--out-dir', '--output'],
    default: '.',
    metavar: 'DIR',
    help: 'Directory to save files into (default: .).',
  },
  {
    key: 'listOnly',
    kind: 'boolean',
    flags: ['--list'],
    help: 'Only list files, do not download.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DOWNLOAD_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DOWNLOAD_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-download metadata and files.',
  },
];

const DOWNLOAD_PARSE_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'identifier',
};

const FULLTEXT_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'queryFlag',
    kind: 'string',
    flags: ['-q', '--query'],
    metavar: 'QUERY',
    help: 'Full-text search query (alternative to positional query).',
  },
  {
    key: 'rows',
    kind: 'integer',
    flags: ['--rows', '--limit', '-n'],
    default: 10,
    metavar: 'N',
    help: 'Hits per page (default: 10).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    default: 1,
    metavar: 'N',
    help: 'Results page, 1-based (default: 1).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: SEARCH_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${SEARCH_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Query cache TTL in hours (default: 168 or KINLOOM_IA_QUERY_TTL_HOURS).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and fetch fresh results.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Full JSON output.' },
];

const FULLTEXT_PARSE_SPEC: CommandParseSpec = {
  options: FULLTEXT_OPTIONS,
  allowPositionals: true,
};

const GREP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'itemFlags',
    kind: 'string',
    flags: ['--item', '--id'],
    multiple: true,
    metavar: 'ID',
    help: 'Internet Archive item identifier (repeatable alternative to positional identifier).',
  },
  {
    key: 'patterns',
    kind: 'string',
    flags: ['--pattern', '-e', '-q', '--query', '--regex'],
    multiple: true,
    metavar: 'REGEX',
    help: 'Regular expression pattern (searched line by line; repeatable).',
  },
  {
    key: 'context',
    kind: 'integer',
    flags: ['--context', '-C'],
    default: 240,
    metavar: 'CHARS',
    help: 'Context characters per hit snippet (default: 240).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '-m', '-n', '--max', '--max-count'],
    default: 25,
    metavar: 'N',
    help: 'Maximum hits returned (default: 25).',
  },
  {
    key: 'ignoreCase',
    kind: 'boolean',
    flags: ['-i', '--ignore-case'],
    help: 'Case-insensitive regex matching.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-fetch metadata, scandata, and OCR text.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Structured JSON output.' },
];

const GREP_PARSE_SPEC: CommandParseSpec = {
  options: GREP_OPTIONS,
  allowPositionals: true,
};

const PAGE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'printedPage',
    kind: 'string',
    flags: ['--printed-page', '--page', '-p'],
    metavar: 'PAGE',
    help: 'Printed page label resolved via cached page_index.json.',
  },
  {
    key: 'printedPages',
    kind: 'string',
    flags: ['--printed-pages', '--pages'],
    metavar: 'SPEC',
    help: 'Comma-separated printed labels and inclusive integer ranges, e.g. 674,707 or 670-674 (max 25).',
  },
  {
    key: 'leaf',
    kind: 'string',
    flags: ['--leaf'],
    metavar: 'LEAF',
    help: 'BookReader leaf index (e.g. 12 or n12).',
  },
  {
    key: 'leaves',
    kind: 'string',
    flags: ['--leaves'],
    metavar: 'SPEC',
    help: 'Comma-separated BookReader leaves and inclusive ranges, e.g. 120-123,130 (max 25).',
  },
  {
    key: 'scale',
    kind: 'integer',
    flags: ['--scale'],
    metavar: 'N',
    help: 'BookReader scale factor (e.g. 1=full, 2=half, 4=quarter).',
  },
  {
    key: 'width',
    kind: 'integer',
    flags: ['--width'],
    metavar: 'PX',
    help: 'Rendered JPEG width in pixels (default 2400 when --scale is omitted).',
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--out-dir', '--output'],
    default: '.',
    metavar: 'PATH',
    help: 'Output file path (.jpg) or directory (default: .).',
  },
  {
    key: 'concurrency',
    kind: 'integer',
    flags: ['--concurrency', '-j'],
    default: PAGE_BATCH_WORKERS,
    metavar: 'N',
    help: `Max concurrent page downloads for batch ranges (1-8, default: ${PAGE_BATCH_WORKERS}).`,
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-fetch index and page JPEG.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Structured JSON output.' },
];

const PAGE_PARSE_SPEC: CommandParseSpec = {
  options: PAGE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'identifier',
};

const TEXT_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'itemFlag',
    kind: 'string',
    flags: ['--item', '--id'],
    metavar: 'ID',
    help: 'Item identifier (alternative to positional identifier).',
  },
  {
    key: 'printedPage',
    kind: 'string',
    flags: ['--printed-page', '--page', '-p'],
    metavar: 'PAGE',
    help: 'Printed page label resolved via cached page_index.json.',
  },
  {
    key: 'leaf',
    kind: 'string',
    flags: ['--leaf'],
    metavar: 'LEAF',
    help: 'BookReader leaf index (e.g. 12 or n12).',
  },
  {
    key: 'leaves',
    kind: 'string',
    flags: ['--leaves'],
    metavar: 'SPEC',
    help: 'Comma-separated BookReader leaves and inclusive ranges, e.g. 12-14 or n12-n14.',
  },
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages', '--printed-pages'],
    metavar: 'SPEC',
    help: 'Printed page range or comma-separated labels, e.g. 12-14 or 12,14.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-fetch metadata, scandata, and OCR text.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Structured JSON output.' },
];

const TEXT_PARSE_SPEC: CommandParseSpec = {
  options: TEXT_OPTIONS,
  allowPositionals: true,
  maxPositionals: 2,
};

const LOOKUP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'printedPage',
    kind: 'string',
    flags: ['--printed-page', '--page', '-p'],
    metavar: 'PAGE',
    help: 'Printed page label.',
  },
  {
    key: 'leaf',
    kind: 'string',
    flags: ['--leaf'],
    metavar: 'LEAF',
    help: 'BookReader leaf index (e.g. 12 or n12).',
  },
  {
    key: 'scandataLeaf',
    kind: 'integer',
    flags: ['--scandata-leaf'],
    metavar: 'N',
    help: 'Raw scandata.xml leafNum.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-fetch metadata and scandata.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Structured JSON output.' },
];

const LOOKUP_PARSE_SPEC: CommandParseSpec = {
  options: LOOKUP_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'identifier',
};

const URL_OPTIONS: readonly OptionSpec[] = [
  { key: 'queryFlag', kind: 'string', flags: ['-q', '--query'], metavar: 'QUERY' },
  { key: 'mediatype', kind: 'string', flags: ['--mediatype', '--type'], metavar: 'TYPE' },
  {
    key: 'collections',
    kind: 'string',
    flags: ['--collection'],
    multiple: true,
    metavar: 'COLLECTION',
  },
];

const URL_PARSE_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: true,
};

// ---------- Help Formatters ----------

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ia <command> [options]',
    summary: 'Search, inspect, grep cached OCR, and download pages from Internet Archive.',
    subcommands: [
      { name: 'search', summary: 'Search items with a Lucene query.' },
      { name: 'get', summary: "Read an item's metadata and file list (aliases: metadata, show)." },
      { name: 'download', summary: 'Download files of an item, or list them with no FILE given.' },
      { name: 'fulltext', summary: 'Search OCR full text across digitized books and periodicals.' },
      {
        name: 'grep',
        summary: 'Search cached full-text OCR inside one or more items with exact page mapping.',
      },
      {
        name: 'page',
        summary: 'Download one or more rendered page JPEGs by printed page or BookReader leaf.',
      },
      { name: 'text', summary: 'Print cached OCR text for a printed page, leaf, or printed-page range.' },
      { name: 'lookup', summary: 'Resolve printed page <-> BookReader leaf <-> scandata leaf.' },
      { name: 'url', summary: 'Print the website advanced-search URL for a query.' },
    ],
  });
}

// ---------- Subcommands ----------

async function runSearch(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia search [QUERY...] [options]',
          summary: 'Search items with a Lucene query.',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }

  const rows = getNumberOption(parsed, 'rows') ?? 10;
  const page = getNumberOption(parsed, 'page') ?? 1;
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? SEARCH_TIMEOUT_SECONDS);
  if (rows < 1) {
    throw new CliValidationError(`--rows/--limit must be >= 1, got ${rows}.`);
  }
  if (page < 1) {
    throw new CliValidationError(`--page must be >= 1, got ${page}.`);
  }

  const query = resolveSearchQuery(parsed.positionals, getStringOption(parsed, 'queryFlag'), {
    mediatype: getStringOption(parsed, 'mediatype'),
    collections: getStringListOption(parsed, 'collections'),
  });
  const chosen = flattenFields(getStringListOption(parsed, 'fields'));
  const sorts = [...getStringListOption(parsed, 'sorts')];
  const ttlHours = resolveQueryTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const params: (readonly [string, string])[] = [
    ['q', query],
    ['output', 'json'],
    ['rows', String(rows)],
  ];
  if (page > 1) {
    params.push(['page', String(page)]);
  }
  for (const field of chosen) {
    params.push(['fl[]', field]);
  }
  for (const sort of sorts) {
    params.push(['sort[]', sort]);
  }
  const qs = encodeQueryPairs(params);
  const canonicalParams: Record<string, unknown> = {
    kind: 'search',
    query,
    fields: chosen,
    rows,
    page,
    sorts,
  };

  const [data, cached] = await cachedQueryJson('search', canonicalParams, `${ADVANCED_SEARCH}?${qs}`, ctx, {
    ttlHours,
    refresh,
    timeout,
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cached));
    return { exitCode: 0, bytesOut, cacheHit: cached };
  }

  const response = isPlainRecord(data.response) ? data.response : {};
  const status = cached ? 'cache-hit' : 'fetched';
  const lines: string[] = [`${String(response.numFound ?? '')} items (${status})`];
  const docs = Array.isArray(response.docs) ? response.docs : [];
  for (const rawDoc of docs) {
    const doc = isPlainRecord(rawDoc) ? rawDoc : {};
    const identifier = String(doc.identifier ?? '');
    const title = String(doc.title ?? '');
    const creator = String(doc.creator ?? '');
    const date = String(doc.date ?? '');
    const mediatypeOut = String(doc.mediatype ?? '');
    lines.push(`${identifier} | ${title} | ${creator} | ${date} | ${mediatypeOut} | ${itemUrl(identifier)}`);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cached };
}

async function runGet(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia get <IDENTIFIER> [options]',
          summary: "Read an item's metadata and file list by identifier (aliases: metadata, show).",
          options: GET_OPTIONS,
        })
      ),
    };
  }

  const identifier = validateIdentifier(parsed.positionals[0]);
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const showFiles = getBooleanOption(parsed, 'files');

  let data: ItemMetadataPayload;
  let cached: boolean;
  try {
    [data, cached] = await ensureItemMetadata(identifier, ctx, { timeout, refresh });
  } catch (err: unknown) {
    if (err instanceof ArchiveNotFoundError) {
      throw new RecordRuntimeError(`No item with identifier ${identifier}`);
    }
    throw err;
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cached));
    return { exitCode: 0, bytesOut, cacheHit: cached };
  }

  const meta = isPlainRecord(data.metadata) ? data.metadata : {};
  const status = cached ? 'cache-hit' : 'fetched';
  const lines: string[] = [
    String(meta.title || identifier),
    `  Identifier: ${String(meta.identifier ?? '')}`,
  ];
  if (meta.creator) {
    lines.push(`  Creator: ${String(meta.creator)}`);
  }
  if (meta.date) {
    lines.push(`  Date: ${String(meta.date)}`);
  }
  if (meta.mediatype) {
    lines.push(`  Mediatype: ${String(meta.mediatype)}`);
  }
  if (meta.collection) {
    const col = Array.isArray(meta.collection)
      ? meta.collection.map(String).join(', ')
      : String(meta.collection);
    lines.push(`  Collection: ${col}`);
  }
  if (meta.description) {
    lines.push(`  Description: ${shortText(meta.description)}`);
  }
  const fileList = getMetadataFiles(data);
  lines.push(`  Files: ${fileList.length} | ${itemUrl(identifier)} (${status})`);
  if (showFiles) {
    for (const entry of fileList) {
      const size = entry.size ?? '';
      lines.push(`    ${String(entry.name ?? '')} | ${String(entry.format ?? '')} | ${String(size)} bytes`);
    }
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cached };
}

async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia download <IDENTIFIER> [FILES...] [options]',
          summary: 'Download files of an item, or list them with no FILE given.',
          options: DOWNLOAD_OPTIONS,
        })
      ),
    };
  }

  const identifier = validateIdentifier(parsed.positionals[0]);
  const requestedFiles = parsed.positionals.slice(1);
  const outArg = getStringOption(parsed, 'out') ?? '.';
  const listOnly = getBooleanOption(parsed, 'listOnly');
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DOWNLOAD_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const cacheRoot = getCacheRoot(ctx);
  const filesRoot = path.join(cacheRoot, identifier, 'files');

  const validatedNames: (readonly [string, string])[] = [];
  if (!listOnly && requestedFiles.length > 0) {
    for (const name of requestedFiles) {
      const [rel] = validateRelativeItemPath(name, filesRoot);
      validatedNames.push([name, rel]);
    }
  }

  let data: ItemMetadataPayload;
  let metaCached: boolean;
  try {
    [data, metaCached] = await ensureItemMetadata(identifier, ctx, {
      cacheRoot,
      timeout,
      refresh,
    });
  } catch (err: unknown) {
    if (err instanceof ArchiveNotFoundError) {
      throw new RecordRuntimeError(`No item with identifier ${identifier}`);
    }
    throw err;
  }

  const fileList = getMetadataFiles(data);
  if (listOnly || requestedFiles.length === 0) {
    const lines = fileList.map(
      (entry) =>
        `${String(entry.name ?? '')} | ${String(entry.format ?? '')} | ${String(entry.size ?? '')} bytes`
    );
    const bytesOut = emitStdout(ctx.io, lines.join('\n'));
    return { exitCode: 0, bytesOut, cacheHit: metaCached };
  }

  const byName = new Map<string, ItemFileEntry>();
  for (const entry of fileList) {
    if (typeof entry.name === 'string' && entry.name.length > 0) {
      byName.set(entry.name, entry);
    }
  }

  const outDir = path.resolve(ctx.cwd, outArg);
  fs.mkdirSync(outDir, { recursive: true });
  const lines: string[] = [];
  let allCached = metaCached;

  for (const [name, rel] of validatedNames) {
    const fileEntry = byName.get(name);
    if (!fileEntry) {
      throw new RecordRuntimeError(`File not in item ${identifier}: ${name}`);
    }
    const [content, , cached] = await ensureDownloadedFile(identifier, name, fileList, fileEntry, ctx, {
      cacheRoot,
      timeout,
      refresh,
    });
    allCached = allCached && cached;
    const dest = path.join(outDir, path.basename(rel));
    atomicWriteFileSync(dest, content);
    const displayDest = path.isAbsolute(outArg) ? dest : path.join(outArg, path.basename(rel));
    const status = cached ? 'cache-hit' : 'fetched';
    lines.push(`${displayDest} (${content.length} bytes, ${status})`);
  }

  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: allCached };
}

async function runFulltext(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, FULLTEXT_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia fulltext [QUERY...] [options]',
          summary: 'Search OCR full text across digitized books and periodicals.',
          options: FULLTEXT_OPTIONS,
        })
      ),
    };
  }

  const rows = getNumberOption(parsed, 'rows') ?? 10;
  const page = getNumberOption(parsed, 'page') ?? 1;
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? SEARCH_TIMEOUT_SECONDS);
  if (rows < 1) {
    throw new CliValidationError(`--rows/--limit must be >= 1, got ${rows}.`);
  }
  if (page < 1) {
    throw new CliValidationError(`--page must be >= 1, got ${page}.`);
  }

  const query = resolveSearchQuery(parsed.positionals, getStringOption(parsed, 'queryFlag'));
  const ttlHours = resolveQueryTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const qs = encodeQueryPairs([
    ['user_query', query],
    ['service_backend', 'fts'],
    ['hits_per_page', String(rows)],
    ['page', String(page)],
  ]);
  const canonicalParams: Record<string, unknown> = {
    kind: 'fulltext',
    query,
    rows,
    page,
  };

  const [data, cached] = await cachedQueryJson('fulltext', canonicalParams, `${FULLTEXT_SEARCH}?${qs}`, ctx, {
    ttlHours,
    refresh,
    timeout,
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cached));
    return { exitCode: 0, bytesOut, cacheHit: cached };
  }

  const resp = isPlainRecord(data.response) ? data.response : {};
  const body = isPlainRecord(resp.body) ? resp.body : {};
  const hitsBlock = isPlainRecord(body.hits) ? body.hits : {};
  const total = hitsBlock.total ?? 0;
  const hits = Array.isArray(hitsBlock.hits) ? hitsBlock.hits : [];
  const status = cached ? 'cache-hit' : 'fetched';
  const lines: string[] = [`${String(total)} full-text matches (showing ${hits.length}, ${status})`];

  for (const rawHit of hits) {
    const hit = isPlainRecord(rawHit) ? rawHit : {};
    const fields = isPlainRecord(hit.fields) ? hit.fields : {};
    const identifier = String(fields.identifier ?? '');
    const title = String(fields.title ?? '');
    const year = String(fields.year ?? fields.date ?? '');
    const highlight = isPlainRecord(hit.highlight) ? hit.highlight : {};
    const snippets = Array.isArray(highlight.text) ? highlight.text : [];
    const firstSnippet =
      snippets.length > 0 && typeof snippets[0] === 'string'
        ? shortText(snippets[0].replaceAll('{{{', '').replaceAll('}}}', ''), 200)
        : '';
    lines.push(`- ${identifier} | ${title} | ${year} | ${itemUrl(identifier)}`);
    if (firstSnippet) {
      lines.push(`  OCR: ${firstSnippet}`);
    }
  }

  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cached };
}

async function runGrep(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const t0 = ctx.nowMs();
  const parsed = parseCommandArgs(argv, GREP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia grep [IDENTIFIERS...] [options]',
          summary: 'Search cached full-text OCR inside one or more items with exact page mapping.',
          options: GREP_OPTIONS,
        })
      ),
    };
  }

  const contextChars = getNumberOption(parsed, 'context') ?? 240;
  const limit = getNumberOption(parsed, 'limit') ?? 25;
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  if (contextChars < 0) {
    throw new CliValidationError(`--context must be >= 0, got ${contextChars}.`);
  }
  if (limit < 0) {
    throw new CliValidationError(`--limit must be >= 0, got ${limit}.`);
  }

  let rawPatterns = [...getStringListOption(parsed, 'patterns')];
  let rawItems = [...getStringListOption(parsed, 'itemFlags')].filter((item) => item.length > 0);
  let posArgs = parsed.positionals.filter((tok) => tok.length > 0);

  if (rawPatterns.length === 0) {
    if (rawItems.length > 0 && posArgs.length === 1) {
      rawPatterns = [posArgs[0]];
      posArgs = [];
    } else if (rawItems.length === 0 && posArgs.length === 2) {
      const firstIsId = looksLikeIdentifierToken(posArgs[0]);
      const secondIsId = looksLikeIdentifierToken(posArgs[1]);
      if (firstIsId && !secondIsId) {
        rawItems = [posArgs[0]];
        rawPatterns = [posArgs[1]];
        posArgs = [];
      } else if (secondIsId && !firstIsId) {
        rawPatterns = [posArgs[0]];
        rawItems = [posArgs[1]];
        posArgs = [];
      }
    }
    if (rawPatterns.length === 0) {
      throw new CliValidationError(
        "Pass --pattern <regex> (or -e / -q <regex>) and at least one item identifier. Example: archive-org grep <item_id> -e '<regex>'."
      );
    }
  }

  rawItems.push(...posArgs);
  if (rawItems.length === 0) {
    throw new CliValidationError(
      'Pass at least one Internet Archive item identifier (positional or --item/--id).'
    );
  }

  const pattern = rawPatterns.length === 1 ? rawPatterns[0] : rawPatterns.map((p) => `(?:${p})`).join('|');
  const ignoreCase = getBooleanOption(parsed, 'ignoreCase');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  try {
    // Validate regex syntax up front before any network calls.
    void new RegExp(pattern, ignoreCase ? 'gi' : 'g');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid regex pattern '${pattern}': ${msg}`);
  }

  const seenIds = new Set<string>();
  const identifiers: string[] = [];
  for (const rawItem of rawItems) {
    const itemId = validateIdentifier(rawItem);
    if (!seenIds.has(itemId)) {
      seenIds.add(itemId);
      identifiers.push(itemId);
    }
  }

  const cacheRoot = getCacheRoot(ctx);
  const cacheEntries: ItemCacheEntry[] = [];
  const itemErrors: { readonly identifier: string; readonly error: string }[] = [];

  if (identifiers.length === 1) {
    const entry = await ensureItemCache(identifiers[0], ctx, {
      needDjvu: true,
      cacheRoot,
      timeout,
      refresh,
    });
    cacheEntries.push(entry);
  } else {
    const results = await runWithConcurrency(identifiers, MAX_WORKERS, async (itemId) => {
      try {
        const entry = await ensureItemCache(itemId, ctx, {
          needDjvu: true,
          cacheRoot,
          timeout,
          refresh,
        });
        return { ok: true as const, itemId, entry };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, itemId, error: msg };
      }
    });
    for (const res of results) {
      if (res.ok) {
        cacheEntries.push(res.entry);
      } else {
        itemErrors.push({ identifier: res.itemId, error: res.error });
      }
    }
    if (cacheEntries.length === 0) {
      const detail = itemErrors.map((e) => `${e.identifier}: ${e.error}`).join('; ');
      throw new RecordRuntimeError(detail);
    }
  }

  const allHits: GrepHit[] = [];
  const itemSummaries: Record<string, unknown>[] = [];
  let remaining = Math.max(0, limit);
  let totalMatches = 0;
  let allCached = itemErrors.length === 0;

  for (const entry of cacheEntries) {
    const wasCached = entry.cached;
    allCached = allCached && wasCached;
    const pageIndex = readPageIndex(entry.pageIndexPath) ?? emptyPageIndex();
    const djvuText = fs.readFileSync(entry.djvuPath).toString('utf8');
    const [hits, itemTotal] = grepCachedItem(entry.identifier, djvuText, pageIndex, pattern, ignoreCase, {
      contextChars,
      limit: remaining,
    });
    for (const h of hits) {
      h.cached = wasCached;
    }
    allHits.push(...hits);
    remaining = Math.max(0, limit - allHits.length);
    totalMatches += itemTotal;
    itemSummaries.push({
      identifier: entry.identifier,
      cached: wasCached,
      matches: itemTotal,
      returned: hits.length,
      cache_dir: entry.itemDir,
    });
  }

  const elapsedMs = Math.round((ctx.nowMs() - t0) * 100) / 100;
  const payload: Record<string, unknown> = {
    pattern,
    ignore_case: ignoreCase,
    cached: allCached,
    elapsed_ms: elapsedMs,
    total_matches: totalMatches,
    returned: allHits.length,
    items: itemSummaries,
    hits: allHits,
  };
  if (itemErrors.length > 0) {
    payload.errors = itemErrors;
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, allCached));
    return { exitCode: 0, bytesOut, cacheHit: allCached };
  }

  const status = allCached ? 'cache-hit' : 'fetched';
  const lines: string[] = [
    `${totalMatches} matches across ${cacheEntries.length} item(s) (showing ${allHits.length}, ${status}, ${elapsedMs} ms)`,
  ];
  for (const hit of allHits) {
    const pp = hit.printed_page ? `p.${hit.printed_page}` : 'p.?';
    const lf = hit.leaf !== null ? `n${hit.leaf}` : 'n?';
    lines.push(`- ${hit.identifier} | ${lf} (${pp}) | ${hit.image_url ?? hit.details_url}`);
    lines.push(`  ${hit.snippet}`);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  for (const err of itemErrors) {
    ctx.io.stderr(`warning: ${err.identifier}: ${err.error}`);
  }
  return { exitCode: 0, bytesOut, cacheHit: allCached };
}

async function runPage(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const t0 = ctx.nowMs();
  const parsed = parseCommandArgs(argv, PAGE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia page <IDENTIFIER> [LEAF] [options]',
          summary: 'Download one or more rendered page JPEGs by printed page number or BookReader leaf.',
          options: PAGE_OPTIONS,
        })
      ),
    };
  }

  const identifier = validateIdentifier(parsed.positionals[0]);
  const leafPosRaw = parsed.positionals.length > 1 ? parsed.positionals[1] : undefined;
  const leafFromPos = leafPosRaw !== undefined ? parseLeafInt(leafPosRaw) : undefined;
  const leafFlagRaw = getStringOption(parsed, 'leaf');
  const leafFromFlag = leafFlagRaw !== undefined ? parseLeafInt(leafFlagRaw) : undefined;
  const printedPage = getStringOption(parsed, 'printedPage');
  const leavesSpec = getStringOption(parsed, 'leaves');
  const printedPagesSpec = getStringOption(parsed, 'printedPages');
  const scale = getNumberOption(parsed, 'scale');
  const width = getNumberOption(parsed, 'width');
  const concurrency = getNumberOption(parsed, 'concurrency') ?? PAGE_BATCH_WORKERS;
  const outArg = getStringOption(parsed, 'out') ?? '.';
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  if (scale !== undefined && scale < 1) {
    throw new CliValidationError(`--scale must be >= 1, got ${scale}.`);
  }
  if (width !== undefined && width < 1) {
    throw new CliValidationError(`--width must be >= 1, got ${width}.`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new CliValidationError(`--concurrency must be an integer between 1 and 8, got ${concurrency}.`);
  }

  if (printedPage !== undefined && (leafFromPos !== undefined || leafFromFlag !== undefined)) {
    throw new CliValidationError('Pass either --printed-page or --leaf (not both).');
  }
  if (leafFromPos !== undefined && leafFromFlag !== undefined) {
    throw new CliValidationError('Pass either positional <leaf> or --leaf (not both).');
  }
  if (leavesSpec !== undefined && printedPagesSpec !== undefined) {
    throw new CliValidationError('Pass either --leaves or --printed-pages, not both.');
  }
  const singleNames: string[] = [];
  if (leafFromPos !== undefined) {
    singleNames.push('positional <leaf>');
  }
  if (leafFromFlag !== undefined) {
    singleNames.push('--leaf');
  }
  if (printedPage !== undefined) {
    singleNames.push('--printed-page');
  }
  if (leavesSpec !== undefined && singleNames.length > 0) {
    throw new CliValidationError(`Pass either --leaves or ${singleNames.join(' or ')}, not both.`);
  }
  if (printedPagesSpec !== undefined && singleNames.length > 0) {
    throw new CliValidationError(`Pass either --printed-pages or ${singleNames.join(' or ')}, not both.`);
  }

  const cacheRoot = getCacheRoot(ctx);
  const jobs: PageJob[] = [];
  let indexCached: boolean | null = null;

  if (printedPagesSpec !== undefined) {
    const labels = parsePrintedPageSpec(printedPagesSpec);
    const cacheEntry = await ensureItemCache(identifier, ctx, {
      needDjvu: false,
      cacheRoot,
      timeout,
      refresh,
    });
    indexCached = cacheEntry.cached;
    const pageIndex = readPageIndex(cacheEntry.pageIndexPath) ?? emptyPageIndex();
    for (const label of labels) {
      const [leaf] = resolvePrintedPageToLeaf(pageIndex, label);
      validateLeafInIndex(pageIndex, leaf);
      const info = describeLeaf(pageIndex, leaf);
      const [suffix, url] = pageSuffixAndUrl(identifier, leaf, scale, width);
      jobs.push({
        leaf,
        scandata_leaf: info.scandata_leaf,
        printed_page: info.printed_page,
        suffix,
        url,
      });
    }
  } else if (leavesSpec !== undefined) {
    for (const leaf of parseLeafSpec(leavesSpec)) {
      const [suffix, url] = pageSuffixAndUrl(identifier, leaf, scale, width);
      jobs.push({ leaf, scandata_leaf: null, printed_page: null, suffix, url });
    }
  } else if (printedPage !== undefined) {
    const cacheEntry = await ensureItemCache(identifier, ctx, {
      needDjvu: false,
      cacheRoot,
      timeout,
      refresh,
    });
    indexCached = cacheEntry.cached;
    const pageIndex = readPageIndex(cacheEntry.pageIndexPath) ?? emptyPageIndex();
    const [targetLeaf, scandataLeaf] = resolvePrintedPageToLeaf(pageIndex, printedPage);
    const [suffix, url] = pageSuffixAndUrl(identifier, targetLeaf, scale, width);
    jobs.push({
      leaf: targetLeaf,
      scandata_leaf: scandataLeaf,
      printed_page: printedPage,
      suffix,
      url,
    });
  } else {
    const targetLeaf = leafFromFlag !== undefined ? leafFromFlag : leafFromPos;
    if (targetLeaf === undefined) {
      throw new CliValidationError(
        'Specify a target page with --printed-page <str>, --leaf <int>, positional <leaf>, --leaves, or --printed-pages.'
      );
    }
    if (targetLeaf < 0) {
      throw new CliValidationError(`Leaf index must be >= 0, got ${targetLeaf}.`);
    }
    const [suffix, url] = pageSuffixAndUrl(identifier, targetLeaf, scale, width);
    jobs.push({ leaf: targetLeaf, scandata_leaf: null, printed_page: null, suffix, url });
  }

  const outResolved = path.resolve(ctx.cwd, outArg);
  const outExt = path.extname(outResolved).toLowerCase();
  const outIsExistingDir = (() => {
    try {
      return fs.statSync(outResolved).isDirectory();
    } catch {
      return false;
    }
  })();

  if (jobs.length > 1 && IMAGE_EXTS.has(outExt) && !outIsExistingDir) {
    throw new CliValidationError(
      `--out ${outArg} is a single image file. Pass a directory when fetching ${jobs.length} pages.`
    );
  }

  const fetched = await runWithConcurrency(jobs, concurrency, (job) =>
    ensurePageImageCache(identifier, job.leaf, job.suffix, job.url, ctx, {
      cacheRoot,
      timeout,
      refresh,
    })
  );

  const written: WrittenPageRow[] = [];
  if (jobs.length === 1) {
    const job = jobs[0];
    const [content, pageCachePath, pageCached] = fetched[0];
    let dest: string;
    if (IMAGE_EXTS.has(outExt) && !outIsExistingDir) {
      dest = outResolved;
    } else {
      fs.mkdirSync(outResolved, { recursive: true });
      dest = path.join(outResolved, `${identifier}_n${job.leaf}_${job.suffix}.jpg`);
    }
    if (path.resolve(dest) !== path.resolve(pageCachePath)) {
      atomicWriteFileSync(dest, content);
    }
    written.push({
      leaf: job.leaf,
      scandata_leaf: job.scandata_leaf,
      printed_page: job.printed_page,
      url: job.url,
      path: dest,
      cache_path: pageCachePath,
      bytes: content.length,
      page_cached: pageCached,
    });
  } else {
    fs.mkdirSync(outResolved, { recursive: true });
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      const [content, pageCachePath, pageCached] = fetched[i];
      const dest = path.join(outResolved, `${identifier}_n${job.leaf}_${job.suffix}.jpg`);
      if (path.resolve(dest) !== path.resolve(pageCachePath)) {
        atomicWriteFileSync(dest, content);
      }
      written.push({
        leaf: job.leaf,
        scandata_leaf: job.scandata_leaf,
        printed_page: job.printed_page,
        url: job.url,
        path: dest,
        cache_path: pageCachePath,
        bytes: content.length,
        page_cached: pageCached,
      });
    }
  }

  if (written.length === 1) {
    const row = written[0];
    const elapsedMs = Math.round((ctx.nowMs() - t0) * 100) / 100;
    const pageHit = indexCached === null ? row.page_cached : Boolean(row.page_cached && indexCached);
    const payload: Record<string, unknown> = {
      identifier,
      leaf: row.leaf,
      scandata_leaf: row.scandata_leaf,
      printed_page: row.printed_page,
      url: row.url,
      path: row.path,
      cache_path: row.cache_path,
      bytes: row.bytes,
      index_cached: indexCached,
      page_cached: row.page_cached,
      elapsed_ms: elapsedMs,
    };
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, pageHit));
      return { exitCode: 0, bytesOut, cacheHit: pageHit };
    }
    const extra = row.printed_page !== null ? ` [p.${row.printed_page} -> n${row.leaf}]` : ` [n${row.leaf}]`;
    const status = row.page_cached ? 'cache-hit' : 'fetched';
    const bytesOut = emitStdout(ctx.io, `${row.path} (${row.bytes} bytes)${extra} (${status})`);
    return { exitCode: 0, bytesOut, cacheHit: pageHit };
  }

  const cacheHit = written.every((row) => row.page_cached) && indexCached !== false;
  const pagesPayload = written.map((row) => ({
    leaf: row.leaf,
    scandata_leaf: row.scandata_leaf,
    printed_page: row.printed_page,
    url: row.url,
    path: row.path,
    bytes: row.bytes,
    page_cached: row.page_cached,
  }));
  const payload: Record<string, unknown> = {
    identifier,
    count: pagesPayload.length,
    pages: pagesPayload,
  };
  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, cacheHit));
    return { exitCode: 0, bytesOut, cacheHit };
  }
  const lines = written.map((row) => {
    const extra = row.printed_page !== null ? ` [p.${row.printed_page} -> n${row.leaf}]` : ` [n${row.leaf}]`;
    const status = row.page_cached ? 'cache-hit' : 'fetched';
    return `${row.path} (${row.bytes} bytes)${extra} (${status})`;
  });
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runText(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TEXT_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia text [IDENTIFIER] [PAGE] [options]',
          summary:
            'Print cached OCR text for a printed page, leaf, or printed-page range (no JPEG download).',
          options: TEXT_OPTIONS,
        })
      ),
    };
  }

  const itemFlag = getStringOption(parsed, 'itemFlag');
  const posId = parsed.positionals[0];
  let pagePos = parsed.positionals[1];
  let rawId = itemFlag ?? posId;
  if (itemFlag && posId && pagePos === undefined) {
    pagePos = posId;
    rawId = itemFlag;
  }
  if (!rawId) {
    throw new CliValidationError('Pass an Internet Archive item identifier (positional or --item/--id).');
  }
  const identifier = validateIdentifier(rawId);

  let printedPage = getStringOption(parsed, 'printedPage');
  const leafFlagRaw = getStringOption(parsed, 'leaf');
  let leafArg = leafFlagRaw !== undefined ? parseLeafInt(leafFlagRaw) : undefined;
  let pagesArg = getStringOption(parsed, 'pages');
  const leavesArg = getStringOption(parsed, 'leaves');
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  if (pagePos !== undefined) {
    const explicit = [printedPage, leafArg, pagesArg, leavesArg].filter((v) => v !== undefined);
    if (explicit.length > 0) {
      throw new CliValidationError(
        'Pass either a positional page/leaf or one of --printed-page/--page, --leaf, --pages, or --leaves, not both.'
      );
    }
    const token = pagePos.trim();
    if (/^[nN]\d+$/.test(token)) {
      leafArg = Number.parseInt(token.slice(1), 10);
    } else if (token.includes('-') || token.includes(',')) {
      pagesArg = token;
    } else {
      printedPage = token;
    }
  }

  const selectors = [printedPage, leafArg, pagesArg, leavesArg].filter((v) => v !== undefined);
  if (selectors.length !== 1) {
    throw new CliValidationError(
      'Pass exactly one of --printed-page/--page <p>, --leaf <n>, --pages <p1-p2>, or --leaves <n1-n2>.'
    );
  }

  const cacheEntry = await ensureItemCache(identifier, ctx, {
    needDjvu: true,
    cacheRoot: getCacheRoot(ctx),
    timeout,
    refresh,
  });
  const pageIndex = readPageIndex(cacheEntry.pageIndexPath) ?? emptyPageIndex();
  const djvuText = fs.readFileSync(cacheEntry.djvuPath).toString('utf8');

  let leaves: number[];
  if (printedPage !== undefined) {
    const [leaf] = resolvePrintedPageToLeaf(pageIndex, printedPage);
    leaves = [leaf];
  } else if (leafArg !== undefined) {
    leaves = [leafArg];
  } else if (leavesArg !== undefined) {
    leaves = parseLeafSpec(leavesArg);
  } else {
    leaves = parsePrintedRange(pageIndex, pagesArg ?? '');
  }

  for (const leaf of leaves) {
    validateLeafInIndex(pageIndex, leaf);
  }

  if (pageIndex.segment_mode === 'flat') {
    throw new RecordRuntimeError(
      `Item ${identifier} OCR text has no page breaks; per-page text is unavailable. Use \`grep\` or \`download\` for the full text.`
    );
  }

  const segments = djvuText.split('\x0c');
  const pagesOut: {
    readonly leaf: number;
    readonly scandata_leaf: number | null;
    readonly printed_page: string | null;
    readonly text: string;
    readonly image_url: string;
    readonly details_url: string;
  }[] = [];

  for (const leaf of leaves) {
    const info = describeLeaf(pageIndex, leaf);
    const segIdx = segmentForLeaf(pageIndex, leaf, info.scandata_leaf);
    if (segIdx === null || segIdx < 0 || segIdx >= segments.length) {
      throw new RecordRuntimeError(
        `No OCR text segment found for leaf n${leaf} in ${identifier} (djvu.txt has ${segments.length} pages).`
      );
    }
    pagesOut.push({
      ...info,
      text: segments[segIdx].replace(/^\n+|\n+$/g, ''),
      image_url: pageImageUrl(identifier, leaf, { scale: 2 }),
      details_url: pageDetailsUrl(identifier, leaf),
    });
  }

  const payload: Record<string, unknown> = {
    identifier,
    cached: cacheEntry.cached,
    pages: pagesOut,
  };
  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, cacheEntry.cached));
    return { exitCode: 0, bytesOut, cacheHit: cacheEntry.cached };
  }

  const lines: string[] = [];
  for (let idx = 0; idx < pagesOut.length; idx += 1) {
    const page = pagesOut[idx];
    if (idx > 0) {
      lines.push('');
    }
    const pp = page.printed_page ? `p.${page.printed_page}` : 'p.?';
    const sc = page.scandata_leaf !== null ? `, scandata leaf ${page.scandata_leaf}` : '';
    lines.push(`== ${identifier} | n${page.leaf} (${pp}${sc})`);
    lines.push(`   image: ${page.image_url}`);
    lines.push(`   details: ${page.details_url}`);
    lines.push(page.text);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cacheEntry.cached };
}

async function runLookup(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, LOOKUP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia lookup <IDENTIFIER> [options]',
          summary: 'Resolve printed page <-> BookReader leaf <-> scandata leaf from cached page_index.json.',
          options: LOOKUP_OPTIONS,
        })
      ),
    };
  }

  const identifier = validateIdentifier(parsed.positionals[0]);
  const printedPage = getStringOption(parsed, 'printedPage');
  const leafFlagRaw = getStringOption(parsed, 'leaf');
  const leafArg = leafFlagRaw !== undefined ? parseLeafInt(leafFlagRaw) : undefined;
  const scandataLeaf = getNumberOption(parsed, 'scandataLeaf');
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const selectors = [printedPage, leafArg, scandataLeaf].filter((v) => v !== undefined);
  if (selectors.length !== 1) {
    throw new CliValidationError(
      'Pass exactly one of --printed-page <p>, --leaf <n>, or --scandata-leaf <n>.'
    );
  }

  const cacheEntry = await ensureItemCache(identifier, ctx, {
    needDjvu: false,
    cacheRoot: getCacheRoot(ctx),
    timeout,
    refresh,
  });
  const pageIndex = readPageIndex(cacheEntry.pageIndexPath) ?? emptyPageIndex();

  let leaf: number;
  if (printedPage !== undefined) {
    [leaf] = resolvePrintedPageToLeaf(pageIndex, printedPage);
  } else if (leafArg !== undefined) {
    leaf = leafArg;
  } else {
    leaf = leafFromScandataLeaf(pageIndex, scandataLeaf as number);
  }
  validateLeafInIndex(pageIndex, leaf);

  const info = describeLeaf(pageIndex, leaf);
  const payload: Record<string, unknown> = {
    identifier,
    cached: cacheEntry.cached,
    ...info,
    image_url: pageImageUrl(identifier, leaf, { scale: 2 }),
    details_url: pageDetailsUrl(identifier, leaf),
  };

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, cacheEntry.cached));
    return { exitCode: 0, bytesOut, cacheHit: cacheEntry.cached };
  }

  const pp = info.printed_page ? info.printed_page : '?';
  const sc = info.scandata_leaf !== null ? String(info.scandata_leaf) : '?';
  const lines = [
    `${identifier}: printed page ${pp} | BookReader leaf n${leaf} | scandata leaf ${sc}`,
    `  image: ${String(payload.image_url)}`,
    `  details: ${String(payload.details_url)}`,
  ];
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cacheEntry.cached };
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia url [QUERY...] [options]',
          summary: 'Print the website advanced-search URL for a query.',
          options: URL_OPTIONS,
        })
      ),
    };
  }
  const full = resolveSearchQuery(parsed.positionals, getStringOption(parsed, 'queryFlag'), {
    mediatype: getStringOption(parsed, 'mediatype'),
    collections: getStringListOption(parsed, 'collections'),
  });
  const bytesOut = emitStdout(ctx.io, `${ADVANCED_SEARCH}?q=${quotePathSegment(full)}`);
  return { exitCode: 0, bytesOut };
}

export const runArchiveOrgCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [rawSubcmd, ...rest] = args;
    const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);
    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'get':
        return await runGet(rest, ctx);
      case 'download':
        return await runDownload(rest, ctx);
      case 'fulltext':
        return await runFulltext(rest, ctx);
      case 'grep':
        return await runGrep(rest, ctx);
      case 'page':
        return await runPage(rest, ctx);
      case 'text':
        return await runText(rest, ctx);
      case 'lookup':
        return await runLookup(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${rawSubcmd}'. Run 'kinloom ia --help'.`);
    }
  } catch (err: unknown) {
    if (isBrokenPipeError(err)) {
      return { exitCode: 0, bytesOut: 0 };
    }
    if (err instanceof CliValidationError) {
      ctx.io.stderr(err.message);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof RecordRuntimeError) {
      ctx.io.stderr(err.message);
      return { exitCode: err.exitCode, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(message);
    return { exitCode: 1, bytesOut: 0 };
  }
};
