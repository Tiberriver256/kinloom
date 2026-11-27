import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
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
  HttpStatusError,
  launchOptionalChromium,
  type OptionalBrowserPage,
  type OptionSpec,
  parseCommandArgs,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  resolveCacheDir,
  resolveSubcommandAlias,
  withAdvisoryLock,
} from '../runtime/index.js';

export const CATALOG_WEB_BASE = 'https://catalog.archives.gov';
export const CATALOG_API_BASE = 'https://catalog.archives.gov/api/v2';
export const API_MAX_WORKERS = 6;
export const API_ATTEMPTS = 3;
export const API_READ_TIMEOUT_MS = 30_000;
export const DOWNLOAD_MAX_WORKERS = 4;
export const DOWNLOAD_ATTEMPTS = 4;
export const DEFAULT_DOWNLOAD_TIMEOUT = 60.0;
export const RETRY_AFTER_CAP_S = 30.0;
export const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 522, 524]);
const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm', '.xhtml']);
export const DEFAULT_QUERY_TTL_HOURS = 168.0;
export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const VALID_LEVELS = ['recordGroup', 'collection', 'series', 'fileUnit', 'item'] as const;

export const S3_PATH_HOST_RE = /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
export const NARA_BUCKET_HOST_RE =
  /^(?:naraprodstorage|nara-[a-z0-9-]*|opaexport[a-z0-9-]*)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
export const NARA_PATH_PREFIXES = ['/naraprodstorage/', '/opaexport', '/nara-'] as const;
const CATALOG_RECORD_URL_RE = /^https:\/\/catalog\.archives\.gov\/id\/(\d+)\/?(?:[?#].*)?$/i;
const HTML_ERROR_PREFIXES = ['<!doctype html', '<html', '<head', '<body', '<title'] as const;

export const CENSUS1950_API_BASE = 'https://1950census.archives.gov/api';
export const CENSUS1950_DEFAULT_LIMIT = 25;
export const CENSUS1950_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AS: 'American Samoa',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CN: 'Canton Island',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  GU: 'Guam',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  JN: 'Johnston Island',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MW: 'Midway Island',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  OI: 'Overseas Island Possessions',
  PC: 'Panama Canal Zone',
  PA: 'Pennsylvania',
  PR: 'Puerto Rico',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VI: 'Virgin Islands',
  VA: 'Virginia',
  WK: 'Wake Island',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

const CENSUS1950_STATE_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(CENSUS1950_STATES).map(([abbr, name]) => [name.toLowerCase(), abbr])
);

export const CENSUS1950_IIIF_ORIGIN = 'https://1950census.archives.gov';
export const CENSUS1950_IMAGE_MAX_WIDTH = 10_000;
export const CENSUS1950_IMAGE_MAX_PER_CALL = 25;
export const CENSUS1950_IMAGE_FETCH_WORKERS = 4;
export const CENSUS1950_IMAGE_ATTEMPTS = 3;
export const CENSUS1950_IMAGE_TIMEOUT = 45.0;
export const CENSUS1950_RETRY_AFTER_CAP_S = 5.0;
export const CENSUS1950_TRANSIENT_STATUS: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504, 520, 522, 524,
]);
export const CENSUS1950_IMAGE_PATH_RE = /^1950census\/[A-Za-z0-9._/-]+\.jpg$/i;
const CENSUS1950_JPEG_SUFFIXES: ReadonlySet<string> = new Set(['.jpg', '.jpeg']);
export const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

// ---------------------------------------------------------------------------
// Types & Errors
// ---------------------------------------------------------------------------

export interface NaraDigitalObjectSummary {
  readonly page: number;
  readonly filename: string;
  readonly url: string;
}

export interface NaraExtractedTextItem {
  readonly page: number;
  readonly filename: string;
  readonly text: string;
}

export interface NaraRecordSummary {
  naId: string;
  title?: string;
  url: string;
  level?: string;
  rg?: string | number;
  rgTitle?: string;
  series?: string;
  seriesNaId?: string;
  dates?: string[];
  microform?: string[];
  access?: string;
  use?: string;
  scope?: string;
  location?: string | string[];
  objectCount?: number;
  objects?: NaraDigitalObjectSummary[];
  extractedText?: NaraExtractedTextItem[];
  transcriptions?: string[];
  error?: string;
}

export interface NaraSearchPayload {
  query?: string;
  searchUrl: string;
  total: number;
  results: NaraRecordSummary[];
}

export interface SearchFilterOptions {
  readonly levels: readonly string[];
  readonly recordGroups: readonly string[];
  readonly online: boolean;
  readonly materialType?: string;
  readonly person?: string;
  readonly title?: string;
  readonly geo?: string;
  readonly control?: string;
  readonly series?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly page: number;
  readonly limit: number;
}

export interface CanonicalSearchParams {
  readonly query: string | null;
  readonly levels: readonly string[];
  readonly record_groups: readonly string[];
  readonly online: boolean;
  readonly material_type: string | null;
  readonly person: string | null;
  readonly title: string | null;
  readonly geo: string | null;
  readonly control: string | null;
  readonly start_date: string | null;
  readonly end_date: string | null;
  readonly page: number;
  readonly limit: number;
}

export interface CanonicalCensus1950Query {
  readonly state: string;
  readonly county: string;
  readonly name: string;
  readonly ed: string;
  readonly limit: number;
  readonly page: number;
}

export interface Census1950ApiPayload {
  readonly total?: number;
  readonly page?: number;
  readonly size?: number;
  readonly results: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export interface Census1950ImageRecord {
  readonly image: string;
  readonly url: string;
  readonly path: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly cache_hit: boolean;
}

export interface NaraBrowserOverrides {
  readonly browserSearchMany?: (
    items: readonly (readonly [string | null, string])[],
    ctx: RecordCommandContext,
    timeoutMs?: number
  ) => Promise<NaraSearchPayload[]>;
  readonly browserGetRecords?: (
    naids: readonly string[],
    options: {
      readonly includeObjects: boolean;
      readonly includeText: boolean;
      readonly pageSpec: string | null;
      readonly timeoutMs?: number;
    },
    ctx: RecordCommandContext
  ) => Promise<NaraRecordSummary[]>;
}

export class NaraWafOrNonJsonError extends RecordRuntimeError {
  readonly url: string;
  readonly contentType: string;

  constructor(url: string, contentType: string, detail = '') {
    const base = `NARA v2 API returned non-JSON response (${contentType || 'unknown content-type'})`;
    super(detail ? `${base}: ${detail}` : base, 1);
    this.name = 'NaraWafOrNonJsonError';
    this.url = url;
    this.contentType = contentType;
  }
}

export class IncompleteDownloadError extends RecordRuntimeError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'IncompleteDownloadError';
  }
}

class TransientNonJpegError extends RecordRuntimeError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'TransientNonJpegError';
  }
}

// ---------------------------------------------------------------------------
// Generic Utilities
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isEpipeError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  return (err as { code?: unknown }).code === 'EPIPE';
}

function getCacheRoot(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_NARA_CACHE_DIR'],
    defaultSubdir: 'kinloom-nara',
  });
}

export function resolveQueryTtlHours(cliTtl: number | undefined, env: NodeJS.ProcessEnv): number {
  if (cliTtl !== undefined) {
    if (!Number.isFinite(cliTtl) || cliTtl < 0) {
      throw new CliValidationError(`Invalid --cache-ttl-hours value: ${String(cliTtl)} (must be >= 0).`);
    }
    return cliTtl;
  }
  const raw = env.KINLOOM_NARA_QUERY_TTL_HOURS;
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed)) {
      throw new CliValidationError(`Invalid KINLOOM_NARA_QUERY_TTL_HOURS value: '${raw}'.`);
    }
    if (parsed < 0) {
      throw new CliValidationError(`Invalid KINLOOM_NARA_QUERY_TTL_HOURS value: '${raw}' (must be >= 0).`);
    }
    return parsed;
  }
  return DEFAULT_QUERY_TTL_HOURS;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: (R | undefined)[] = Array.from({ length: items.length }, () => undefined);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results as R[];
}

function readJsonIfValid(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.statSync(filePath).isFile()) {
      return null;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function atomicWriteCompactJson(dest: string, payload: unknown): void {
  atomicWriteFileSync(dest, JSON.stringify(payload));
}

function atomicCopyFileSync(src: string, dest: string): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(dest);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${process.hrtime.bigint()}.tmp`);
  try {
    fs.copyFileSync(src, tmpPath);
    fs.renameSync(tmpPath, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup.
    }
    throw err;
  }
}

function quotePythonStyle(value: string, safeSlash = true): string {
  let encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  if (safeSlash) {
    encoded = encoded.replace(/%2F/g, '/');
  }
  return encoded;
}

function formatWithCommas(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Validation & Path Safety
// ---------------------------------------------------------------------------

export function validateNaid(naid: string): string {
  const raw = String(naid).trim();
  if (!raw || raw.includes('\0') || raw.includes('..')) {
    throw new CliValidationError(`Invalid NAID: '${naid}'`);
  }
  const urlMatch = CATALOG_RECORD_URL_RE.exec(raw);
  if (urlMatch) {
    return urlMatch[1];
  }
  if (raw.includes('/') || raw.includes('\\')) {
    throw new CliValidationError(`Invalid NAID: '${naid}'`);
  }
  const match = /^(?:NAID[\s:-]*)?(\d+)$/i.exec(raw);
  if (!match) {
    throw new CliValidationError(`Invalid NAID (expected digits): '${naid}'`);
  }
  return match[1];
}

export function isDirectDownloadUrl(raw: string): boolean {
  const text = String(raw).trim();
  if (CATALOG_RECORD_URL_RE.test(text)) {
    return false;
  }
  const lower = text.toLowerCase();
  return lower.startsWith('https://') || lower.startsWith('http://');
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 32) {
      return true;
    }
  }
  return false;
}

export function validateNaraDownloadUrl(rawUrl: string): string {
  const text = String(rawUrl).trim();
  if (!text || text.includes('\0') || hasControlChar(text)) {
    throw new RecordRuntimeError(`Invalid download URL: '${rawUrl}'`);
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new RecordRuntimeError(`Invalid download URL: '${rawUrl}'`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    !host ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new RecordRuntimeError(`Refusing non-HTTPS or disallowed download URL: ${text}`);
  }
  const pathLower = parsed.pathname.toLowerCase();
  const allowed =
    host === 'archives.gov' ||
    host.endsWith('.archives.gov') ||
    NARA_BUCKET_HOST_RE.test(host) ||
    (S3_PATH_HOST_RE.test(host) && NARA_PATH_PREFIXES.some((prefix) => pathLower.startsWith(prefix)));
  if (!allowed) {
    throw new RecordRuntimeError(`Refusing download from disallowed host '${host}': ${text}`);
  }
  return text;
}

export function safeObjectFilename(pageNum: number, rawName: string | null | undefined): string {
  if (!Number.isInteger(pageNum) || pageNum < 1) {
    throw new RangeError(`Invalid page number: ${String(pageNum)}`);
  }
  const candidate = (rawName ?? '').replace(/\\/g, '/');
  const slashIdx = candidate.lastIndexOf('/');
  const base = (slashIdx === -1 ? candidate : candidate.slice(slashIdx + 1)).trim();
  let safeBase: string;
  if (!base || base === '.' || base === '..' || base.includes('\0')) {
    safeBase = `${pageNum}.bin`;
  } else {
    safeBase = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
    if (!safeBase || safeBase === '.' || safeBase === '..') {
      safeBase = `${pageNum}.bin`;
    }
  }
  return `${String(pageNum).padStart(3, '0')}_${safeBase}`;
}

export function resolveSafeChild(root: string, filename: string): string {
  if (
    !filename ||
    filename.includes('\0') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes(':') ||
    filename === '.' ||
    filename === '..'
  ) {
    throw new RangeError(`Unsafe filename: '${filename}'`);
  }
  const rootResolved = path.resolve(root);
  const dest = path.resolve(rootResolved, filename);
  const rel = path.relative(rootResolved, dest);
  if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new RangeError(`Unsafe path escaping root: '${filename}'`);
  }
  return dest;
}

function hasParentTraversal(rawPath: string): boolean {
  return rawPath.split(/[\\/]/).includes('..');
}

function resolveUserPath(rawPath: string, cwd: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);
}

export function detectErrorPayload(head: Buffer, contentType: string, filenameHint = ''): string | null {
  const ext = filenameHint ? path.extname(filenameHint).toLowerCase() : '';
  if (HTML_EXTENSIONS.has(ext)) {
    return null;
  }
  const ctLower = (contentType || '').toLowerCase();
  if (ctLower.includes('text/html') || ctLower.includes('application/xhtml')) {
    return `HTML response (${contentType})`;
  }
  let sampleBuf = head.subarray(0, 512);
  if (sampleBuf.length >= 3 && sampleBuf[0] === 0xef && sampleBuf[1] === 0xbb && sampleBuf[2] === 0xbf) {
    sampleBuf = sampleBuf.subarray(3);
  }
  const sample = sampleBuf
    .toString('latin1')
    .replace(/^[ \t\r\n]+/, '')
    .toLowerCase();
  if (HTML_ERROR_PREFIXES.some((prefix) => sample.startsWith(prefix))) {
    return 'HTML error page';
  }
  if (sample.startsWith('<?xml') && sample.includes('<error>')) {
    return 'S3 XML error response';
  }
  if (ext === '.pdf' && !head.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return 'non-PDF payload';
  }
  return null;
}

function validateDownloadedFile(
  filePath: string,
  options: { readonly url: string; readonly contentType: string; readonly filenameHint?: string }
): number {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Failed reading downloaded file for ${options.url}: ${message}`);
  }
  if (size <= 0) {
    throw new RecordRuntimeError(`Downloaded empty response from ${options.url}`);
  }
  const fd = fs.openSync(filePath, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(Math.min(512, size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  let urlPath = '';
  try {
    urlPath = new URL(options.url).pathname;
  } catch {
    urlPath = '';
  }
  const reason = detectErrorPayload(head, options.contentType, options.filenameHint || urlPath);
  if (reason !== null) {
    throw new RecordRuntimeError(`Refusing ${reason} when downloading ${options.url}`);
  }
  return size;
}

// ---------------------------------------------------------------------------
// Retry Helpers
// ---------------------------------------------------------------------------

function parseRetryAfterSeconds(
  headers: Headers | null | undefined,
  nowMs: () => number,
  capSeconds: number
): number | undefined {
  const raw = headers?.get('retry-after')?.trim();
  if (!raw) {
    return undefined;
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.min(capSeconds, Math.max(0, parsed));
    }
  }
  const parsedDate = Date.parse(raw);
  if (Number.isFinite(parsedDate)) {
    const delta = (parsedDate - nowMs()) / 1000;
    if (Number.isFinite(delta)) {
      return Math.min(capSeconds, Math.max(0, delta));
    }
  }
  return undefined;
}

function retryDelayMs(
  attempt: number,
  response: Response | null,
  nowMs: () => number,
  baseDelayS = 0.5,
  capS = RETRY_AFTER_CAP_S
): number {
  const retryAfterS = parseRetryAfterSeconds(response?.headers, nowMs, capS);
  if (retryAfterS !== undefined) {
    return Math.round(retryAfterS * 1000);
  }
  const jitter = 0.75 + Math.random() * 0.5;
  const delayS = Math.min(capS, baseDelayS * 2 ** (attempt - 1) * jitter);
  return Math.round(delayS * 1000);
}

function census1950RetryDelayMs(attempt: number, response: Response | null, nowMs: () => number): number {
  const retryAfterS = parseRetryAfterSeconds(response?.headers, nowMs, CENSUS1950_RETRY_AFTER_CAP_S);
  if (retryAfterS !== undefined) {
    return Math.round(retryAfterS * 1000);
  }
  const delayS = Math.min(CENSUS1950_RETRY_AFTER_CAP_S, 0.25 * 2 ** (attempt - 1));
  return Math.round(delayS * 1000);
}

// ---------------------------------------------------------------------------
// Query Building, Page Spec, Record Extraction & Projection
// ---------------------------------------------------------------------------

export function normalizeQueryForWafRetry(query: string): string | null {
  let stripped = query.replace(/"/g, ' ');
  stripped = stripped.replace(/\bAND\b/g, ' ');
  const normalized = stripped.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === query.trim()) {
    return null;
  }
  return normalized;
}

export function buildQueryParams(
  query: string | null | undefined,
  options: {
    readonly levels?: readonly string[];
    readonly recordGroups?: readonly string[];
    readonly online?: boolean;
    readonly materialType?: string;
    readonly person?: string;
    readonly title?: string;
    readonly geo?: string;
    readonly control?: string;
    readonly series?: string;
    readonly startDate?: string;
    readonly endDate?: string;
    readonly page?: number;
    readonly limit?: number;
    readonly forApi?: boolean;
  } = {}
): [string, string][] {
  const page = options.page ?? 1;
  const limit = options.limit ?? 20;
  const forApi = options.forApi ?? false;
  const params: [string, string][] = [];

  const rawSeries = options.series?.trim() || null;
  let effectiveStartDate = options.startDate ?? null;
  let effectiveEndDate = options.endDate ?? null;
  let effectiveControl = options.control ?? null;
  let effectiveTitle = options.title ?? null;
  let seriesNaId: string | null = null;
  let extraQuerySeries: string | null = null;

  if (rawSeries) {
    if (/^\d{4}$/.test(rawSeries)) {
      if (!effectiveStartDate) {
        effectiveStartDate = rawSeries;
      }
      if (!effectiveEndDate) {
        effectiveEndDate = rawSeries;
      }
    } else if (/^[A-Za-z]\d{2,5}$/.test(rawSeries)) {
      if (!effectiveControl) {
        effectiveControl = rawSeries.toUpperCase();
      } else {
        extraQuerySeries = rawSeries;
      }
    } else if (/^\d{5,}$/.test(rawSeries)) {
      seriesNaId = rawSeries;
    } else if (!effectiveTitle) {
      effectiveTitle = rawSeries;
    } else {
      extraQuerySeries = rawSeries;
    }
  }

  const combinedQuery =
    query && extraQuerySeries ? `${query} ${extraQuerySeries}` : query || extraQuerySeries;

  if (combinedQuery) {
    params.push(['q', combinedQuery]);
  }
  if (effectiveTitle) {
    params.push(['title', effectiveTitle]);
  }
  if (options.person) {
    params.push(['personOrOrg', options.person]);
  }
  if (options.geo) {
    params.push(['geographicReference', options.geo]);
  }
  if (effectiveControl) {
    params.push(['controlNumbers', effectiveControl]);
  }
  if (seriesNaId) {
    params.push(['ancestorNaIds', seriesNaId]);
  }
  if (options.levels && options.levels.length > 0) {
    const flat = options.levels
      .flatMap((item) => item.split(','))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const validSet: ReadonlySet<string> = new Set(VALID_LEVELS);
    const invalid = flat.filter((lv) => !validSet.has(lv));
    if (invalid.length > 0) {
      throw new CliValidationError(
        `Invalid level(s): ${invalid.join(', ')}. Choose from: ${VALID_LEVELS.join(', ')}`
      );
    }
    if (flat.length > 0) {
      params.push(['levelOfDescription', flat.join(',')]);
    }
  }
  if (options.recordGroups && options.recordGroups.length > 0) {
    const flatRg = options.recordGroups
      .flatMap((item) => item.split(','))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (flatRg.length > 0) {
      params.push(['recordGroupNumber', flatRg.join(',')]);
    }
  }
  if (options.online) {
    params.push(['availableOnline', 'true']);
    if (!forApi) {
      params.push(['dataSource', 'description']);
    }
  }
  if (options.materialType) {
    params.push(['typeOfMaterials', options.materialType]);
  }
  if (effectiveStartDate) {
    params.push(['startDate', effectiveStartDate]);
  }
  if (effectiveEndDate) {
    params.push(['endDate', effectiveEndDate]);
  }
  if (page > 1 || forApi) {
    params.push(['page', String(page)]);
  }
  if (forApi || limit !== 20) {
    params.push(['limit', String(limit)]);
  }
  return params;
}

export function encodeCatalogUrl(params: readonly (readonly [string, string])[], forApi = false): string {
  const base = forApi ? `${CATALOG_API_BASE}/records/search` : `${CATALOG_WEB_BASE}/search`;
  if (params.length === 0) {
    return base;
  }
  const qs = params.map(([k, v]) => `${quotePythonStyle(k, true)}=${quotePythonStyle(v, true)}`).join('&');
  return `${base}?${qs}`;
}

export function parsePageSpec(spec: string | null | undefined, total: number): number[] {
  if (total <= 0) {
    return [];
  }
  if (!spec || spec.trim().toLowerCase() === 'all') {
    return Array.from({ length: total }, (_v, idx) => idx + 1);
  }
  const chosen = new Set<number>();
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    const dashIdx = part.indexOf('-');
    if (dashIdx !== -1) {
      const aStr = part.slice(0, dashIdx).trim();
      const bStr = part.slice(dashIdx + 1).trim();
      if (aStr && !/^\d+$/.test(aStr)) {
        throw new CliValidationError(`Invalid page range '${part}'.`);
      }
      if (bStr && !/^\d+$/.test(bStr)) {
        throw new CliValidationError(`Invalid page range '${part}'.`);
      }
      let a = aStr ? Number.parseInt(aStr, 10) : 1;
      let b = bStr ? Number.parseInt(bStr, 10) : total;
      if (a > b) {
        const tmp = a;
        a = b;
        b = tmp;
      }
      const start = Math.max(1, a);
      const end = Math.min(total, b);
      for (let p = start; p <= end; p += 1) {
        chosen.add(p);
      }
    } else {
      if (!/^\d+$/.test(part)) {
        throw new CliValidationError(`Invalid page number '${part}'.`);
      }
      const idx = Number.parseInt(part, 10);
      if (idx >= 1 && idx <= total) {
        chosen.add(idx);
      }
    }
  }
  return Array.from(chosen).toSorted((x, y) => x - y);
}

export function extractRecord(
  hit: unknown,
  options: {
    readonly includeObjects?: boolean;
    readonly includeText?: boolean;
    readonly pageSpec?: string | null;
  } = {}
): NaraRecordSummary {
  const includeObjects = options.includeObjects ?? false;
  const includeText = options.includeText ?? false;
  const pageSpec = options.pageSpec ?? null;

  const hitObj = isPlainRecord(hit) ? hit : {};
  const src = isPlainRecord(hitObj._source) ? hitObj._source : {};
  const rec = isPlainRecord(src.record) ? src.record : hitObj;

  const naid = rec.naId !== undefined && rec.naId !== null ? String(rec.naId) : '';
  const ancestorsRaw = Array.isArray(rec.ancestors) ? rec.ancestors : [];
  const ancestors = ancestorsRaw.filter(isPlainRecord);
  const rg = ancestors.find((a) => a.levelOfDescription === 'recordGroup');
  const series = ancestors.find((a) => a.levelOfDescription === 'series');
  const microforms = (Array.isArray(rec.microformPublications) ? rec.microformPublications : []).filter(
    isPlainRecord
  );
  const objs = (Array.isArray(rec.digitalObjects) ? rec.digitalObjects : []).filter(isPlainRecord);

  const out: NaraRecordSummary = {
    naId: naid,
    title: typeof rec.title === 'string' ? rec.title : '',
    url: naid ? `${CATALOG_WEB_BASE}/id/${naid}` : '',
  };

  if (typeof rec.levelOfDescription === 'string' && rec.levelOfDescription) {
    out.level = rec.levelOfDescription;
  }

  const rgNum = rg ? rg.recordGroupNumber : rec.recordGroupNumber;
  if (typeof rgNum === 'string' || typeof rgNum === 'number') {
    out.rg = rgNum;
  }
  if (rg && typeof rg.title === 'string' && rg.title) {
    out.rgTitle = rg.title;
  }
  if (series && typeof series.title === 'string' && series.title) {
    out.series = series.title;
  }
  if (series && series.naId !== undefined && series.naId !== null && String(series.naId)) {
    out.seriesNaId = String(series.naId);
  }

  const dates: string[] = [];
  for (const key of [
    'inclusiveStartDate',
    'inclusiveEndDate',
    'productionDateArray',
    'coverageStartDate',
    'coverageEndDate',
  ] as const) {
    const val = rec[key];
    if (isPlainRecord(val) && val.logicalDate) {
      dates.push(String(val.logicalDate));
    } else if (Array.isArray(val)) {
      for (const entry of val) {
        if (isPlainRecord(entry) && entry.logicalDate) {
          dates.push(String(entry.logicalDate));
        }
      }
    }
  }
  if (dates.length > 0) {
    out.dates = dates;
  }

  const mfList: string[] = [];
  for (const m of microforms) {
    const parts = [m.identifier, m.title, m.note]
      .filter((p): p is string | number => p !== null && p !== undefined && String(p).trim() !== '')
      .map((p) => String(p).trim());
    if (parts.length > 0) {
      mfList.push(parts.join(' | '));
    }
  }
  if (mfList.length > 0) {
    out.microform = mfList;
  }

  const access = isPlainRecord(rec.accessRestriction) ? rec.accessRestriction.status : undefined;
  const use = isPlainRecord(rec.useRestriction) ? rec.useRestriction.status : undefined;
  if (typeof access === 'string' && access) {
    out.access = access;
  }
  if (typeof use === 'string' && use) {
    out.use = use;
  }

  if (typeof rec.scopeAndContentNote === 'string' && rec.scopeAndContentNote) {
    out.scope = rec.scopeAndContentNote;
  }

  const locations: string[] = [];
  const phys = Array.isArray(rec.physicalOccurrences) ? rec.physicalOccurrences : [];
  for (const po of phys) {
    if (!isPlainRecord(po)) {
      continue;
    }
    const refUnits = Array.isArray(po.referenceUnits) ? po.referenceUnits : [];
    for (const ru of refUnits) {
      if (isPlainRecord(ru) && typeof ru.name === 'string' && ru.name) {
        if (!locations.includes(ru.name)) {
          locations.push(ru.name);
        }
      }
    }
  }
  if (locations.length > 0) {
    out.location = locations.length === 1 ? locations[0] : locations;
  }

  if (objs.length > 0) {
    out.objectCount = objs.length;
    if (includeObjects) {
      const selected = parsePageSpec(pageSpec, objs.length);
      out.objects = selected.map((p) => {
        const obj = objs[p - 1];
        const filename =
          typeof obj.objectFilename === 'string' && obj.objectFilename
            ? obj.objectFilename
            : obj.objectId !== undefined && obj.objectId !== null
              ? String(obj.objectId)
              : '';
        const url = typeof obj.objectUrl === 'string' ? obj.objectUrl : '';
        return { page: p, filename, url };
      });
    }
    if (includeText) {
      const selected = parsePageSpec(pageSpec, objs.length);
      const texts: NaraExtractedTextItem[] = [];
      for (const p of selected) {
        const obj = objs[p - 1];
        const txt =
          (typeof obj.extractedText === 'string' && obj.extractedText) ||
          (typeof obj.otherExtractedText === 'string' && obj.otherExtractedText) ||
          '';
        if (txt) {
          texts.push({
            page: p,
            filename: typeof obj.objectFilename === 'string' ? obj.objectFilename : '',
            text: txt,
          });
        }
      }
      if (texts.length > 0) {
        out.extractedText = texts;
      }
    }
  }

  return out;
}

export function projectRecord(
  fullRecord: NaraRecordSummary,
  options: {
    readonly includeObjects?: boolean;
    readonly includeText?: boolean;
    readonly pageSpec?: string | null;
  } = {}
): NaraRecordSummary {
  const includeObjects = options.includeObjects ?? false;
  const includeText = options.includeText ?? false;
  const pageSpec = options.pageSpec ?? null;

  const {
    objects: fullObjects,
    extractedText: fullExtractedText,
    transcriptions: fullTranscriptions,
    ...rest
  } = fullRecord;
  const out: NaraRecordSummary = { ...rest };
  const total = fullRecord.objectCount ?? (fullObjects ? fullObjects.length : 0);

  if (includeObjects && fullObjects && fullObjects.length > 0) {
    const selectedPages = new Set(parsePageSpec(pageSpec, total));
    out.objects = fullObjects.filter((obj) => selectedPages.has(obj.page));
  }
  if (includeText) {
    if (fullExtractedText && fullExtractedText.length > 0) {
      const selectedPages = total > 0 ? new Set(parsePageSpec(pageSpec, total)) : new Set<number>();
      const texts = fullExtractedText.filter(
        (item) => selectedPages.size === 0 || selectedPages.has(item.page)
      );
      if (texts.length > 0) {
        out.extractedText = texts;
      }
    }
    if (fullTranscriptions && fullTranscriptions.length > 0) {
      out.transcriptions = [...fullTranscriptions];
    }
  }
  return out;
}

export function formatRecordText(rec: NaraRecordSummary): string {
  if (rec.error) {
    return `NAID ${rec.naId}: ERROR - ${rec.error}`;
  }
  const headerParts: string[] = [`NAID ${rec.naId}`];
  if (rec.level) {
    headerParts.push(`[${rec.level}]`);
  }
  if (rec.rg !== undefined) {
    headerParts.push(`RG ${rec.rg}`);
  }
  if (rec.objectCount) {
    headerParts.push(`${rec.objectCount} files`);
  }
  const lines: string[] = [`${headerParts.join(' ')}: ${rec.title ?? ''}`, `  ${rec.url}`];
  if (rec.series) {
    lines.push(`  Series: ${rec.series}`);
  }
  if (rec.dates && rec.dates.length > 0) {
    lines.push(`  Dates: ${rec.dates.join(' .. ')}`);
  }
  for (const mf of rec.microform ?? []) {
    lines.push(`  Microform: ${mf}`);
  }
  if (rec.access || rec.use) {
    lines.push(`  Access/Use: ${rec.access ?? '?'} / ${rec.use ?? '?'}`);
  }
  if (rec.location) {
    const loc = typeof rec.location === 'string' ? rec.location : rec.location.join('; ');
    lines.push(`  Location: ${loc}`);
  }
  if (rec.scope) {
    lines.push(`  Scope: ${rec.scope}`);
  }
  for (const obj of rec.objects ?? []) {
    lines.push(`  [${String(obj.page).padStart(3, '0')}] ${obj.filename}: ${obj.url}`);
  }
  for (const item of rec.extractedText ?? []) {
    lines.push(`  --- Page ${item.page} (${item.filename}) ---\n${item.text}`);
  }
  for (const tr of rec.transcriptions ?? []) {
    lines.push(`  --- Transcription ---\n${tr}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Catalog Search & Record Disk Cache
// ---------------------------------------------------------------------------

function canonicalSearchParams(query: string | null, filter: SearchFilterOptions): CanonicalSearchParams {
  const levels = filter.levels
    .flatMap((item) => item.split(','))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const recordGroups = filter.recordGroups
    .flatMap((item) => item.split(','))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return {
    query: query ?? null,
    levels,
    record_groups: recordGroups,
    online: Boolean(filter.online),
    material_type: filter.materialType ?? null,
    person: filter.person ?? null,
    title: filter.title ?? null,
    geo: filter.geo ?? null,
    control: filter.control ?? null,
    start_date: filter.startDate ?? null,
    end_date: filter.endDate ?? null,
    page: filter.page,
    limit: filter.limit,
  };
}

function queryCachePath(canonical: CanonicalSearchParams, cacheRoot: string): readonly [string, string] {
  const digest = sha256Hex(canonicalJsonStringify(canonical));
  return [digest, resolveSafeChild(path.join(cacheRoot, '_queries'), `${digest}.json`)];
}

function readCachedSearch(
  canonical: CanonicalSearchParams,
  cacheRoot: string,
  ttlHours: number,
  nowMs: () => number
): NaraSearchPayload | null {
  const ttlSeconds = ttlHours * 3600;
  if (ttlSeconds <= 0) {
    return null;
  }
  const [, filePath] = queryCachePath(canonical, cacheRoot);
  const envelope = readJsonIfValid(filePath);
  if (!envelope) {
    return null;
  }
  const cachedAt = envelope.cached_at;
  const data = envelope.data;
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || !isPlainRecord(data)) {
    return null;
  }
  if (!Array.isArray(data.results)) {
    return null;
  }
  if (nowMs() / 1000 - cachedAt <= ttlSeconds) {
    return data as unknown as NaraSearchPayload;
  }
  return null;
}

async function writeCachedSearch(
  canonical: CanonicalSearchParams,
  payload: NaraSearchPayload,
  cacheRoot: string,
  ctx: RecordCommandContext
): Promise<void> {
  if (!Array.isArray(payload.results)) {
    return;
  }
  const [digest, filePath] = queryCachePath(canonical, cacheRoot);
  const lockPath = resolveSafeChild(path.join(cacheRoot, '_locks'), `query_${digest}.lock`);
  await withAdvisoryLock(
    lockPath,
    async () => {
      atomicWriteCompactJson(filePath, {
        cached_at: ctx.nowMs() / 1000,
        params: canonical,
        data: payload,
      });
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

function recordCachePath(cleanId: string, cacheRoot: string): string {
  return resolveSafeChild(path.join(cacheRoot, 'records'), `${cleanId}.json`);
}

function readCachedRecord(
  cleanId: string,
  cacheRoot: string,
  requireText: boolean
): NaraRecordSummary | null {
  const envelope = readJsonIfValid(recordCachePath(cleanId, cacheRoot));
  if (!envelope) {
    return null;
  }
  const record = envelope.record;
  if (!isPlainRecord(record) || record.error) {
    return null;
  }
  if (requireText && !envelope.has_text) {
    return null;
  }
  return record as unknown as NaraRecordSummary;
}

async function writeCachedRecord(
  cleanId: string,
  fullRecord: NaraRecordSummary,
  cacheRoot: string,
  hasText: boolean,
  ctx: RecordCommandContext
): Promise<void> {
  if (fullRecord.error) {
    return;
  }
  const filePath = recordCachePath(cleanId, cacheRoot);
  const lockPath = resolveSafeChild(path.join(cacheRoot, '_locks'), `record_${cleanId}.lock`);
  await withAdvisoryLock(
    lockPath,
    async () => {
      atomicWriteCompactJson(filePath, {
        cached_at: ctx.nowMs() / 1000,
        naId: cleanId,
        has_text: Boolean(hasText),
        record: fullRecord,
      });
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

// ---------------------------------------------------------------------------
// Low-level Fetch With Timeout & Optional Redirect Validation
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFollowingRedirects(
  startUrl: string,
  options: {
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly fetchImpl: typeof fetch;
    readonly validateUrl?: (u: string) => string;
  }
): Promise<Response> {
  let currentUrl = options.validateUrl ? options.validateUrl(startUrl) : startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const resp = await fetchWithTimeout(
      currentUrl,
      { method: 'GET', headers: options.headers, redirect: 'manual' },
      options.timeoutMs,
      options.fetchImpl
    );
    if (options.validateUrl && resp.url) {
      options.validateUrl(resp.url);
    }
    if (REDIRECT_STATUSES.has(resp.status)) {
      const location = resp.headers.get('location');
      if (!location) {
        return resp;
      }
      if (hop === MAX_REDIRECTS) {
        throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${startUrl}`);
      }
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = options.validateUrl ? options.validateUrl(nextUrl) : nextUrl;
      continue;
    }
    return resp;
  }
  throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${startUrl}`);
}

// ---------------------------------------------------------------------------
// Catalog v2 REST API
// ---------------------------------------------------------------------------

export async function apiGetJson(
  url: string,
  apiKey: string,
  ctx: Pick<RecordCommandContext, 'fetchImpl' | 'sleepFn' | 'nowMs'>
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };

  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt += 1) {
    let resp: Response;
    try {
      resp = await fetchFollowingRedirects(url, {
        headers,
        timeoutMs: API_READ_TIMEOUT_MS,
        fetchImpl: ctx.fetchImpl,
      });
    } catch (err: unknown) {
      if (attempt >= API_ATTEMPTS) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RecordRuntimeError(`Network error fetching ${url}: ${message}`);
      }
      await ctx.sleepFn(retryDelayMs(attempt, null, ctx.nowMs));
      continue;
    }

    const contentType = resp.headers.get('content-type') ?? '';
    if (resp.status === 403 && contentType.toLowerCase().includes('html')) {
      throw new NaraWafOrNonJsonError(url, contentType, 'HTTP 403 HTML response');
    }
    if (TRANSIENT_STATUS_CODES.has(resp.status)) {
      if (attempt >= API_ATTEMPTS) {
        const body = await resp.text().catch(() => '');
        throw new HttpStatusError(resp.status, url, body.slice(0, 200).trim());
      }
      await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
      continue;
    }
    if (resp.status < 200 || resp.status >= 300) {
      const body = await resp.text().catch(() => '');
      throw new HttpStatusError(resp.status, url, body.slice(0, 200).trim());
    }
    if (!contentType.toLowerCase().includes('json')) {
      throw new NaraWafOrNonJsonError(url, contentType);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await resp.text());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new NaraWafOrNonJsonError(url, contentType, message);
    }
    if (!isPlainRecord(parsed)) {
      throw new NaraWafOrNonJsonError(
        url,
        contentType,
        `expected JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
      );
    }
    return parsed;
  }

  throw new RecordRuntimeError('NARA API retry loop ended without a response or error.');
}

function buildSearchPayload(
  query: string | null,
  webUrl: string,
  raw: Record<string, unknown>
): NaraSearchPayload {
  const body = isPlainRecord(raw.body) ? raw.body : raw;
  const hitsObj = isPlainRecord(body.hits) ? body.hits : {};
  const hits = Array.isArray(hitsObj.hits) ? hitsObj.hits : [];
  const totalRaw = hitsObj.total;
  let total = hits.length;
  if (isPlainRecord(totalRaw) && typeof totalRaw.value === 'number') {
    total = totalRaw.value;
  } else if (typeof totalRaw === 'number') {
    total = totalRaw;
  } else if (typeof totalRaw === 'string' && /^\d+$/.test(totalRaw)) {
    total = Number.parseInt(totalRaw, 10);
  }
  const results = hits.map((h) => extractRecord(h));
  if (query !== null) {
    return {
      query,
      searchUrl: webUrl,
      total,
      results,
    };
  }
  return {
    searchUrl: webUrl,
    total,
    results,
  };
}

async function apiSearchOne(
  query: string | null,
  apiKey: string,
  filter: SearchFilterOptions,
  ctx: RecordCommandContext
): Promise<readonly [NaraSearchPayload | null, string]> {
  const apiUrl = encodeCatalogUrl(buildQueryParams(query, { ...filter, forApi: true }), true);
  const webUrl = encodeCatalogUrl(buildQueryParams(query, { ...filter, forApi: false }), false);
  try {
    const raw = await apiGetJson(apiUrl, apiKey, ctx);
    return [buildSearchPayload(query, webUrl, raw), webUrl];
  } catch (err: unknown) {
    if (!(err instanceof NaraWafOrNonJsonError)) {
      throw err;
    }
    const retryQuery = query ? normalizeQueryForWafRetry(query) : null;
    if (retryQuery === null) {
      return [null, webUrl];
    }
    const retryApiUrl = encodeCatalogUrl(buildQueryParams(retryQuery, { ...filter, forApi: true }), true);
    try {
      const raw = await apiGetJson(retryApiUrl, apiKey, ctx);
      return [buildSearchPayload(query, webUrl, raw), webUrl];
    } catch (retryErr: unknown) {
      if (retryErr instanceof NaraWafOrNonJsonError) {
        return [null, webUrl];
      }
      throw retryErr;
    }
  }
}

async function apiGetOneRecord(
  naid: string,
  apiKey: string,
  options: {
    readonly includeObjects: boolean;
    readonly includeText: boolean;
    readonly pageSpec: string;
  },
  ctx: RecordCommandContext
): Promise<NaraRecordSummary | null> {
  const cleanId = validateNaid(naid);
  const flag = options.includeText ? 'true' : 'false';
  const url = `${CATALOG_API_BASE}/records/search?naId_is=${cleanId}&includeExtractedText=${flag}&includeOtherExtractedText=${flag}`;
  let raw: Record<string, unknown>;
  try {
    raw = await apiGetJson(url, apiKey, ctx);
  } catch (err: unknown) {
    if (err instanceof NaraWafOrNonJsonError) {
      return null;
    }
    throw err;
  }
  const body = isPlainRecord(raw.body) ? raw.body : raw;
  const hitsObj = isPlainRecord(body.hits) ? body.hits : {};
  const hits = Array.isArray(hitsObj.hits) ? hitsObj.hits : [];
  if (hits.length > 0) {
    return extractRecord(hits[0], {
      includeObjects: options.includeObjects,
      includeText: options.includeText,
      pageSpec: options.pageSpec,
    });
  }
  return {
    naId: cleanId,
    url: `${CATALOG_WEB_BASE}/id/${cleanId}`,
    error: 'Not found',
  };
}

// ---------------------------------------------------------------------------
// Optional Headless Chromium Fallback (playwright-core via runtime/browser.ts)
// ---------------------------------------------------------------------------

interface PlaywrightResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  json(): Promise<unknown>;
}

interface ExtendedBrowserPage extends OptionalBrowserPage {
  on?: (event: string, listener: (resp: PlaywrightResponseLike) => void) => void;
  removeListener?: (event: string, listener: (resp: PlaywrightResponseLike) => void) => void;
  waitForFunction?: (fn: string, arg?: unknown, options?: { timeout?: number }) => Promise<unknown>;
  waitForTimeout?: (timeout: number) => Promise<void>;
}

async function defaultBrowserSearchMany(
  items: readonly (readonly [string | null, string])[],
  ctx: RecordCommandContext,
  timeoutMs = 30_000
): Promise<NaraSearchPayload[]> {
  const browser = await launchOptionalChromium({
    env: ctx.env,
    overrideEnvVar: 'NARA_BROWSER',
  });
  const results: NaraSearchPayload[] = [];
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = (await context.newPage()) as ExtendedBrowserPage;
    try {
      for (const [query, searchUrl] of items) {
        const captured: Record<string, unknown>[] = [];
        const pendingReads: Promise<void>[] = [];

        const onResponse = (resp: PlaywrightResponseLike): void => {
          const u = resp.url();
          if (u.includes('/proxy/') && u.includes('/records/search') && resp.status() === 200) {
            const ct = resp.headers()['content-type'] ?? '';
            if (ct.toLowerCase().includes('json')) {
              const p = resp
                .json()
                .then((data) => {
                  if (isPlainRecord(data)) {
                    captured.push(data);
                  }
                })
                .catch(() => {
                  // Ignore unreadable response body.
                });
              pendingReads.push(p);
            }
          }
        };

        page.on?.('response', onResponse);
        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          if (page.waitForFunction) {
            try {
              await page.waitForFunction(
                `() => {
                  const t = document.body.innerText || '';
                  return /\\d+\\s+results?\\s+for|No results|0 results|did not match/i.test(t);
                }`,
                undefined,
                { timeout: Math.min(timeoutMs, 20_000) }
              );
            } catch {
              // Fall through to captured responses or DOM scrape.
            }
          }
          if (page.waitForTimeout) {
            await page.waitForTimeout(500);
          } else {
            await ctx.sleepFn(500);
          }
          await Promise.allSettled(pendingReads);
        } finally {
          page.removeListener?.('response', onResponse);
        }

        let entry: NaraSearchPayload | null = null;
        for (let i = captured.length - 1; i >= 0; i -= 1) {
          const cap = captured[i];
          const body = isPlainRecord(cap.body) ? cap.body : cap;
          const hitsObj = isPlainRecord(body.hits) ? body.hits : {};
          if (Array.isArray(hitsObj.hits)) {
            entry = buildSearchPayload(query, searchUrl, cap);
            break;
          }
        }

        if (entry === null) {
          const domItems = await page.evaluate<NaraRecordSummary[]>(
            `(() => {
              const items = [];
              const seen = new Set();
              for (const a of document.querySelectorAll('a[href*="/id/"]')) {
                const m = (a.getAttribute('href') || '').match(/\\/id\\/(\\d+)/);
                if (!m || seen.has(m[1])) continue;
                const title = (a.textContent || '').trim();
                if (!title) continue;
                seen.add(m[1]);
                items.push({ naId: m[1], title, url: 'https://catalog.archives.gov/id/' + m[1] });
              }
              return items;
            })()`
          );
          const safeDom = Array.isArray(domItems) ? domItems : [];
          entry =
            query !== null
              ? { query, searchUrl, total: safeDom.length, results: safeDom }
              : { searchUrl, total: safeDom.length, results: safeDom };
        }
        results.push(entry);
      }
    } finally {
      await page.close();
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

async function defaultBrowserGetRecords(
  naids: readonly string[],
  options: {
    readonly includeObjects: boolean;
    readonly includeText: boolean;
    readonly pageSpec: string | null;
    readonly timeoutMs?: number;
  },
  ctx: RecordCommandContext
): Promise<NaraRecordSummary[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const browser = await launchOptionalChromium({
    env: ctx.env,
    overrideEnvVar: 'NARA_BROWSER',
  });
  const records: NaraRecordSummary[] = [];
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = (await context.newPage()) as ExtendedBrowserPage;
    try {
      for (const naid of naids) {
        const cleanId = String(naid).replace(/\D+/g, '');
        let capturedRecord: NaraRecordSummary | null = null;
        const contributions: Record<string, unknown>[] = [];
        const pendingReads: Promise<void>[] = [];

        const onResponse = (resp: PlaywrightResponseLike): void => {
          const u = resp.url();
          const ct = resp.headers()['content-type'] ?? '';
          if (resp.status() !== 200 || !ct.toLowerCase().includes('json')) {
            return;
          }
          if (u.includes(`naId_is=${cleanId}`) && u.includes('/records/search')) {
            const p = resp
              .json()
              .then((payload) => {
                if (!isPlainRecord(payload)) {
                  return;
                }
                const body = isPlainRecord(payload.body) ? payload.body : payload;
                const hitsObj = isPlainRecord(body.hits) ? body.hits : {};
                const hits = Array.isArray(hitsObj.hits) ? hitsObj.hits : [];
                if (hits.length > 0) {
                  capturedRecord = extractRecord(hits[0], {
                    includeObjects: options.includeObjects,
                    includeText: options.includeText,
                    pageSpec: options.pageSpec,
                  });
                }
              })
              .catch(() => {
                // Ignore parse error.
              });
            pendingReads.push(p);
          } else if (
            options.includeText &&
            u.includes(`targetNaId/${cleanId}`) &&
            u.includes('/contributions/')
          ) {
            const p = resp
              .json()
              .then((c) => {
                if (Array.isArray(c)) {
                  for (const item of c) {
                    if (isPlainRecord(item)) {
                      contributions.push(item);
                    }
                  }
                }
              })
              .catch(() => {
                // Ignore parse error.
              });
            pendingReads.push(p);
          }
        };

        page.on?.('response', onResponse);
        const url = `${CATALOG_WEB_BASE}/id/${cleanId}`;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          if (page.waitForFunction) {
            try {
              await page.waitForFunction(
                `() => /National Archives Identifier/i.test(document.body.innerText || '')`,
                undefined,
                { timeout: Math.min(timeoutMs, 20_000) }
              );
            } catch {
              // Proceed to wait loop.
            }
          }
          for (let tick = 0; tick < 25; tick += 1) {
            await Promise.allSettled(pendingReads);
            if (capturedRecord !== null && (!options.includeText || contributions.length > 0)) {
              break;
            }
            if (page.waitForTimeout) {
              await page.waitForTimeout(200);
            } else {
              await ctx.sleepFn(200);
            }
          }
          await Promise.allSettled(pendingReads);
        } finally {
          page.removeListener?.('response', onResponse);
        }

        if (capturedRecord === null) {
          records.push({
            naId: cleanId,
            url,
            error: 'Record metadata not captured.',
          });
        } else {
          const rec: NaraRecordSummary = capturedRecord;
          if (options.includeText && contributions.length > 0) {
            const transcriptions: string[] = [];
            for (const c of contributions) {
              if (c.contributionType === 'transcription') {
                const textVal =
                  (typeof c.text === 'string' && c.text) ||
                  (typeof c.transcription === 'string' && c.transcription) ||
                  '';
                if (textVal) {
                  transcriptions.push(textVal);
                }
              }
            }
            if (transcriptions.length > 0) {
              rec.transcriptions = transcriptions;
            }
          }
          records.push(rec);
        }
      }
    } finally {
      await page.close();
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return records;
}

// ---------------------------------------------------------------------------
// Load or Fetch Full Records (Cache + API/Browser)
// ---------------------------------------------------------------------------

async function loadOrFetchFullRecordsWithHits(
  naids: readonly string[],
  options: {
    readonly apiKey: string | undefined;
    readonly forceBrowser: boolean;
    readonly includeText: boolean;
    readonly refresh: boolean;
    readonly cacheRoot: string;
  },
  ctx: RecordCommandContext,
  overrides: NaraBrowserOverrides
): Promise<readonly [NaraRecordSummary[], boolean[]]> {
  const cleanIds = naids.map((n) => validateNaid(n));
  const useApi = Boolean(options.apiKey) && !options.forceBrowser;
  const slots: (NaraRecordSummary | null)[] = Array.from({ length: cleanIds.length }, () => null);
  const hitFlags: boolean[] = Array.from({ length: cleanIds.length }, () => false);
  const missIndices: number[] = [];

  for (let idx = 0; idx < cleanIds.length; idx += 1) {
    if (!options.refresh) {
      const cached = readCachedRecord(cleanIds[idx], options.cacheRoot, options.includeText);
      if (cached !== null) {
        slots[idx] = cached;
        hitFlags[idx] = true;
        continue;
      }
    }
    missIndices.push(idx);
  }

  const browserGet = overrides.browserGetRecords ?? defaultBrowserGetRecords;

  if (missIndices.length > 0) {
    const missIds = missIndices.map((idx) => cleanIds[idx]);
    if (useApi && options.apiKey) {
      const activeKey = options.apiKey;
      const fetchedSlots = await mapConcurrent(missIds, API_MAX_WORKERS, (id) =>
        apiGetOneRecord(
          id,
          activeKey,
          {
            includeObjects: true,
            includeText: options.includeText,
            pageSpec: 'all',
          },
          ctx
        )
      );

      const fallbackSlots: number[] = [];
      const fallbackNaids: string[] = [];
      for (let i = 0; i < missIndices.length; i += 1) {
        const slotIdx = missIndices[i];
        const rec = fetchedSlots[i];
        if (rec === null) {
          fallbackSlots.push(slotIdx);
          fallbackNaids.push(cleanIds[slotIdx]);
        } else {
          slots[slotIdx] = rec;
          await writeCachedRecord(cleanIds[slotIdx], rec, options.cacheRoot, options.includeText, ctx);
        }
      }

      if (fallbackNaids.length > 0) {
        const fallbackRecs = await browserGet(
          fallbackNaids,
          { includeObjects: true, includeText: options.includeText, pageSpec: 'all' },
          ctx
        );
        for (let i = 0; i < fallbackSlots.length; i += 1) {
          const slotIdx = fallbackSlots[i];
          const fbRec = fallbackRecs[i];
          if (fbRec) {
            slots[slotIdx] = fbRec;
            await writeCachedRecord(cleanIds[slotIdx], fbRec, options.cacheRoot, options.includeText, ctx);
          }
        }
      }
    } else {
      const fetchedRecs = await browserGet(
        missIds,
        { includeObjects: true, includeText: options.includeText, pageSpec: 'all' },
        ctx
      );
      for (let i = 0; i < missIndices.length; i += 1) {
        const slotIdx = missIndices[i];
        const rec = fetchedRecs[i];
        if (rec) {
          slots[slotIdx] = rec;
          await writeCachedRecord(cleanIds[slotIdx], rec, options.cacheRoot, options.includeText, ctx);
        }
      }
    }
  }

  const records: NaraRecordSummary[] = [];
  const hits: boolean[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    const rec = slots[i];
    if (rec !== null) {
      records.push(rec);
      hits.push(hitFlags[i]);
    }
  }
  return [records, hits];
}

// ---------------------------------------------------------------------------
// Download Helpers (Direct URL & NAID Objects)
// ---------------------------------------------------------------------------

interface CachedDownloadInfo {
  readonly bytes: number;
  readonly content_type: string;
}

function safeUrlFilename(url: string, contentType = ''): string {
  let rawPath = '';
  try {
    rawPath = new URL(url).pathname;
  } catch {
    rawPath = url;
  }
  const slashIdx = rawPath.lastIndexOf('/');
  const lastSeg = slashIdx === -1 ? rawPath : rawPath.slice(slashIdx + 1);
  let rawName: string;
  try {
    rawName = decodeURIComponent(lastSeg).trim();
  } catch {
    rawName = lastSeg.trim();
  }
  const normalized = rawName.replace(/\\/g, '/');
  const normSlash = normalized.lastIndexOf('/');
  const candidate = (normSlash === -1 ? normalized : normalized.slice(normSlash + 1)).trim();
  let safe = candidate.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!safe || safe === '.' || safe === '..' || safe.includes('..')) {
    const ctLower = (contentType || '').toLowerCase();
    if (ctLower.includes('pdf')) {
      safe = 'download.pdf';
    } else if (ctLower.includes('jpeg') || ctLower.includes('jpg')) {
      safe = 'download.jpg';
    } else if (ctLower.includes('png')) {
      safe = 'download.png';
    } else if (ctLower.includes('tiff') || ctLower.includes('tif')) {
      safe = 'download.tif';
    } else {
      safe = 'download.bin';
    }
  }
  return safe;
}

function urlDownloadCachePaths(url: string, cacheRoot: string): readonly [string, string, string] {
  const digest = sha256Hex(url);
  const dir = path.join(cacheRoot, 'downloads');
  return [
    resolveSafeChild(dir, `${digest}.bin`),
    resolveSafeChild(dir, `${digest}.json`),
    resolveSafeChild(dir, `${digest}.lock`),
  ];
}

function readCachedDownloadEntry(
  binPath: string,
  metaPath: string,
  options: {
    readonly url: string;
    readonly ttlHours: number | null;
    readonly filenameHint?: string;
    readonly nowMs: () => number;
  }
): CachedDownloadInfo | null {
  if (options.ttlHours !== null && options.ttlHours <= 0) {
    return null;
  }
  try {
    if (!fs.statSync(binPath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const meta = readJsonIfValid(metaPath);
  if (meta !== null && options.ttlHours !== null) {
    const cachedAt = meta.cached_at;
    if (
      typeof cachedAt === 'number' &&
      Number.isFinite(cachedAt) &&
      options.nowMs() / 1000 - cachedAt > options.ttlHours * 3600
    ) {
      return null;
    }
  }
  const contentType = typeof meta?.content_type === 'string' ? meta.content_type : '';
  let nbytes: number;
  try {
    nbytes = validateDownloadedFile(binPath, {
      url: options.url,
      contentType,
      filenameHint: options.filenameHint ?? '',
    });
  } catch {
    return null;
  }
  if (meta !== null) {
    const expectedBytes = meta.bytes;
    if (typeof expectedBytes === 'number' && Number.isInteger(expectedBytes) && expectedBytes > 0) {
      if (nbytes !== expectedBytes) {
        return null;
      }
    }
  }
  return { bytes: nbytes, content_type: contentType };
}

async function downloadObjectToCache(
  objUrl: string,
  cachedObjPath: string,
  options: {
    readonly metaPath?: string;
    readonly filenameHint?: string;
    readonly timeoutSec: number;
  },
  ctx: RecordCommandContext
): Promise<CachedDownloadInfo> {
  const validatedUrl = validateNaraDownloadUrl(objUrl);
  fs.mkdirSync(path.dirname(cachedObjPath), { recursive: true });
  const timeoutMs = Math.max(1000, Math.round(options.timeoutSec * 1000));
  let lastErrorMessage = '';

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const base = path.basename(cachedObjPath);
    const tmpPath = path.join(
      path.dirname(cachedObjPath),
      `.${base}.${process.pid}.${process.hrtime.bigint()}.tmp`
    );
    try {
      const resp = await fetchFollowingRedirects(validatedUrl, {
        headers: { 'User-Agent': USER_AGENT },
        timeoutMs,
        fetchImpl: ctx.fetchImpl,
        validateUrl: validateNaraDownloadUrl,
      });

      if (TRANSIENT_STATUS_CODES.has(resp.status)) {
        if (attempt < DOWNLOAD_ATTEMPTS) {
          await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
          continue;
        }
        throw new RecordRuntimeError(`HTTP ${resp.status} downloading ${validatedUrl}`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new RecordRuntimeError(`HTTP ${resp.status} downloading ${validatedUrl}`);
      }

      const contentType = (resp.headers.get('content-type') ?? '').split(';', 1)[0].trim();
      const contentEncoding = (resp.headers.get('content-encoding') ?? '').trim().toLowerCase();
      const rawLen = (resp.headers.get('content-length') ?? '').trim();
      let expectedLen: number | null = null;
      if (rawLen && (!contentEncoding || contentEncoding === 'identity')) {
        if (/^\d+$/.test(rawLen)) {
          const parsedLen = Number.parseInt(rawLen, 10);
          if (parsedLen > 0) {
            expectedLen = parsedLen;
          }
        }
      }

      const bytes = Buffer.from(await resp.arrayBuffer());
      if (expectedLen !== null && bytes.length < expectedLen) {
        throw new IncompleteDownloadError(
          `Incomplete download for ${validatedUrl}: received ${bytes.length} of ${expectedLen} bytes`
        );
      }

      fs.writeFileSync(tmpPath, bytes);
      const size = validateDownloadedFile(tmpPath, {
        url: validatedUrl,
        contentType,
        filenameHint: options.filenameHint || path.basename(cachedObjPath),
      });
      fs.renameSync(tmpPath, cachedObjPath);
      const info = {
        url: validatedUrl,
        content_type: contentType,
        bytes: size,
        cached_at: ctx.nowMs() / 1000,
      };
      if (options.metaPath) {
        atomicWriteCompactJson(options.metaPath, info);
      }
      return { bytes: size, content_type: contentType };
    } catch (err: unknown) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure.
      }
      if (err instanceof IncompleteDownloadError) {
        lastErrorMessage = err.message;
        if (attempt >= DOWNLOAD_ATTEMPTS) {
          throw new RecordRuntimeError(
            `Failed downloading ${validatedUrl} after ${DOWNLOAD_ATTEMPTS} attempts: ${err.message}`
          );
        }
        await ctx.sleepFn(retryDelayMs(attempt, null, ctx.nowMs));
        continue;
      }
      if (err instanceof RecordRuntimeError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      lastErrorMessage = message;
      if (attempt >= DOWNLOAD_ATTEMPTS) {
        throw new RecordRuntimeError(
          `Failed downloading ${validatedUrl} after ${DOWNLOAD_ATTEMPTS} attempts: ${message}`
        );
      }
      await ctx.sleepFn(retryDelayMs(attempt, null, ctx.nowMs));
    }
  }

  throw new RecordRuntimeError(`Failed downloading ${validatedUrl}: ${lastErrorMessage}`);
}

function resolveDirectDownloadDest(
  rawOutPath: string | undefined,
  url: string,
  contentType: string,
  cwd: string
): string {
  const filename = safeUrlFilename(url, contentType);
  if (!rawOutPath) {
    return resolveSafeChild(cwd, filename);
  }
  if (rawOutPath.includes('\0')) {
    throw new CliValidationError(`Invalid --out path: ${rawOutPath}`);
  }
  const resolved = resolveUserPath(rawOutPath, cwd);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return resolveSafeChild(resolved, filename);
    }
  } catch {
    // Does not exist yet.
  }
  if (!path.extname(rawOutPath)) {
    if (hasParentTraversal(rawOutPath)) {
      throw new RecordRuntimeError(`Unsafe output path containing '..': ${rawOutPath}`);
    }
    fs.mkdirSync(resolved, { recursive: true });
    return resolveSafeChild(resolved, filename);
  }
  if (hasParentTraversal(rawOutPath)) {
    throw new RecordRuntimeError(`Unsafe output path containing '..': ${rawOutPath}`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

async function downloadDirectUrl(
  url: string,
  options: {
    readonly outPath: string | undefined;
    readonly overwrite: boolean;
    readonly refresh: boolean;
    readonly timeoutSec: number;
    readonly ttlHours: number;
    readonly asJson: boolean;
    readonly cacheRoot: string;
  },
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const validatedUrl = validateNaraDownloadUrl(url);
  const [binPath, metaPath, lockPath] = urlDownloadCachePaths(validatedUrl, options.cacheRoot);
  const filenameHint = safeUrlFilename(validatedUrl);

  let cacheHit = false;
  let finalEntry: CachedDownloadInfo | null = null;
  if (!options.refresh) {
    finalEntry = readCachedDownloadEntry(binPath, metaPath, {
      url: validatedUrl,
      ttlHours: options.ttlHours,
      filenameHint,
      nowMs: ctx.nowMs,
    });
    if (finalEntry !== null) {
      cacheHit = true;
    }
  }

  if (finalEntry === null) {
    const locked = await withAdvisoryLock(
      lockPath,
      async (): Promise<{ readonly entry: CachedDownloadInfo; readonly hit: boolean }> => {
        if (!options.refresh) {
          const cached = readCachedDownloadEntry(binPath, metaPath, {
            url: validatedUrl,
            ttlHours: options.ttlHours,
            filenameHint,
            nowMs: ctx.nowMs,
          });
          if (cached !== null) {
            return { entry: cached, hit: true };
          }
        }
        const downloaded = await downloadObjectToCache(
          validatedUrl,
          binPath,
          {
            metaPath,
            filenameHint,
            timeoutSec: options.timeoutSec,
          },
          ctx
        );
        return { entry: downloaded, hit: false };
      },
      { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
    );
    finalEntry = locked.entry;
    cacheHit = locked.hit;
  }

  const contentType = finalEntry.content_type;
  const nbytes = finalEntry.bytes;
  const dest = resolveDirectDownloadDest(options.outPath, validatedUrl, contentType, ctx.cwd);

  let bytesOut = 0;
  if (fs.existsSync(dest) && !options.overwrite && !options.refresh) {
    if (!options.asJson) {
      bytesOut += emitStdout(ctx.io, `Exists (skip): ${dest}`);
    }
  } else {
    atomicCopyFileSync(binPath, dest);
    if (!options.asJson) {
      const verb = cacheHit ? 'Cached' : 'Downloaded';
      bytesOut += emitStdout(ctx.io, `${verb}: ${dest} (${formatWithCommas(nbytes)} bytes)`);
    }
  }

  if (options.asJson) {
    bytesOut += emitJsonStdout(ctx.io, {
      cache_hit: cacheHit,
      bytes: nbytes,
      path: dest,
      url: validatedUrl,
      content_type: contentType,
    });
  }

  return { exitCode: 0, bytesOut, cacheHit };
}

// ---------------------------------------------------------------------------
// 1950 Census Search & IIIF Images
// ---------------------------------------------------------------------------

export function normalizeCensus1950State(raw: string): string {
  const text = raw.trim();
  if (!text || text.includes('\0')) {
    throw new CliValidationError(`Invalid --state value: '${raw}'`);
  }
  const upper = text.toUpperCase();
  if (Object.hasOwn(CENSUS1950_STATES, upper)) {
    return upper;
  }
  const found = CENSUS1950_STATE_BY_NAME.get(text.toLowerCase());
  if (found) {
    return found;
  }
  throw new CliValidationError(
    `Unknown 1950 Census state: '${raw}'. Use a code such as IL or a name such as Illinois.`
  );
}

function census1950PlainToken(raw: string, flag: string, maxLen: number): string {
  const text = raw.trim();
  if (
    !text ||
    text.length > maxLen ||
    text.includes('\0') ||
    hasControlChar(text) ||
    /[\\/]|\.\./.test(text)
  ) {
    throw new CliValidationError(`Invalid ${flag} value: '${raw}'`);
  }
  return text;
}

export function canonicalCensus1950Query(options: {
  readonly state?: string;
  readonly county?: string;
  readonly name?: string;
  readonly ed?: string;
  readonly limit: number;
  readonly page?: number;
}): CanonicalCensus1950Query {
  const page = options.page ?? 1;
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new CliValidationError(`Invalid --limit value: ${String(options.limit)} (must be 1..100).`);
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new CliValidationError(`Invalid --page value: ${String(page)} (must be >= 1).`);
  }
  const stateCode = options.state && options.state.trim() ? normalizeCensus1950State(options.state) : '';
  const countyText =
    options.county && options.county.trim() ? census1950PlainToken(options.county, '--county', 80) : '';
  const nameText =
    options.name && options.name.trim() ? census1950PlainToken(options.name, '--name', 120) : '';
  let edText = '';
  if (options.ed && options.ed.trim()) {
    edText = census1950PlainToken(options.ed, '--ed', 32);
    if (!/^[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*$/.test(edText)) {
      throw new CliValidationError(`Invalid --ed value: '${options.ed}'`);
    }
  }
  if (!stateCode && !countyText && !nameText && !edText) {
    throw new CliValidationError('Give at least one of --state, --county, --name, or --ed.');
  }
  return {
    state: stateCode,
    county: countyText,
    name: nameText,
    ed: edText,
    limit: options.limit,
    page,
  };
}

export function census1950SearchUrl(canonical: CanonicalCensus1950Query): string {
  const params = new URLSearchParams();
  const entries: readonly (readonly [string, string])[] = [
    ['state', canonical.state],
    ['county', canonical.county],
    ['name', canonical.name],
    ['ed', canonical.ed],
    ['size', String(canonical.limit)],
    ['page', String(canonical.page)],
  ];
  for (const [key, value] of entries) {
    if (value) {
      params.set(key, value);
    }
  }
  return `${CENSUS1950_API_BASE}/search?${params.toString()}`;
}

export function census1950CachePaths(
  canonical: CanonicalCensus1950Query,
  cacheRoot: string
): readonly [string, string] {
  const digest = sha256Hex(canonicalJsonStringify(canonical));
  const dir = path.join(cacheRoot, 'census1950');
  return [resolveSafeChild(dir, `${digest}.json`), resolveSafeChild(dir, `${digest}.lock`)];
}

function readCachedCensus1950(
  filePath: string,
  ttlHours: number,
  nowMs: () => number
): Census1950ApiPayload | null {
  if (ttlHours <= 0) {
    return null;
  }
  const envelope = readJsonIfValid(filePath);
  if (!envelope) {
    return null;
  }
  const cachedAt = envelope.cached_at;
  const data = envelope.data;
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || !isPlainRecord(data)) {
    return null;
  }
  if (!Array.isArray(data.results)) {
    return null;
  }
  if (nowMs() / 1000 - cachedAt <= ttlHours * 3600) {
    return data as unknown as Census1950ApiPayload;
  }
  return null;
}

export async function census1950FetchJson(
  url: string,
  ctx: Pick<RecordCommandContext, 'fetchImpl' | 'sleepFn' | 'nowMs'>
): Promise<Census1950ApiPayload> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'kinloom/1.0 (genealogy research)',
  };

  for (let attempt = 1; attempt <= CENSUS1950_IMAGE_ATTEMPTS; attempt += 1) {
    let resp: Response;
    try {
      resp = await fetchFollowingRedirects(url, {
        headers,
        timeoutMs: 30_000,
        fetchImpl: ctx.fetchImpl,
      });
    } catch (err: unknown) {
      if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RecordRuntimeError(`Network error fetching ${url}: ${message}`);
      }
      await ctx.sleepFn(census1950RetryDelayMs(attempt, null, ctx.nowMs));
      continue;
    }

    if (TRANSIENT_STATUS_CODES.has(resp.status)) {
      if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
        const snippet = (await resp.text().catch(() => '')).slice(0, 200).trim();
        throw new HttpStatusError(resp.status, url, snippet);
      }
      await ctx.sleepFn(census1950RetryDelayMs(attempt, resp, ctx.nowMs));
      continue;
    }
    if (resp.status < 200 || resp.status >= 300) {
      const snippet = (await resp.text().catch(() => '')).slice(0, 200).trim();
      throw new HttpStatusError(resp.status, url, snippet);
    }

    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('json')) {
      throw new RecordRuntimeError(
        `1950 Census API did not return JSON (${contentType || 'no content type'}).`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await resp.text());
    } catch {
      throw new RecordRuntimeError('1950 Census API returned invalid JSON.');
    }
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.results)) {
      throw new RecordRuntimeError('1950 Census API returned an unexpected payload.');
    }
    return parsed as unknown as Census1950ApiPayload;
  }

  throw new RecordRuntimeError('1950 Census search retries ended without a response or error.');
}

function emitCensus1950(
  data: Census1950ApiPayload,
  cacheHit: boolean,
  asJson: boolean,
  ctx: RecordCommandContext
): number {
  if (asJson) {
    return emitJsonStdout(ctx.io, {
      cache_hit: cacheHit,
      total: data.total ?? null,
      page: data.page ?? null,
      size: data.size ?? null,
      results: data.results ?? [],
    });
  }
  let header = `1950 Census population schedules: ${String(data.total ?? 0)} hit(s)`;
  if (cacheHit) {
    header += ' [cache]';
  }
  const lines: string[] = [header];
  for (const row of data.results ?? []) {
    if (!isPlainRecord(row)) {
      continue;
    }
    const image = row.image;
    const rowParts = [
      String(row.abbr || row.state || ''),
      String(row.county || ''),
      row.ed ? `ED ${String(row.ed)}` : '',
      row.scheduleId ? `schedule ${String(row.scheduleId)}` : '',
      typeof image === 'string' && image ? `image ${image}` : '',
    ].filter((part) => part.length > 0);
    lines.push(rowParts.join(' '));
    const names = Array.isArray(row.names) ? row.names : [];
    for (const person of names) {
      if (isPlainRecord(person) && person.name) {
        const prefix = person.row ? `${String(person.row)}: ` : '';
        lines.push(`  ${prefix}${String(person.name)}`);
      }
    }
  }
  return emitStdout(ctx.io, lines.join('\n'));
}

export function validateCensus1950ImagePath(raw: string): string {
  const text = raw.trim();
  if (!text || text.includes('\0') || text.includes('\\') || !CENSUS1950_IMAGE_PATH_RE.test(text)) {
    throw new CliValidationError(`Invalid 1950 Census image path: '${raw}'`);
  }
  const parts = text.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new CliValidationError(`Invalid 1950 Census image path: '${raw}'`);
  }
  return text;
}

export function parseCensus1950ImageSource(raw: string): string {
  let text = raw.trim();
  if (!text || text.includes('\0')) {
    throw new CliValidationError(`Invalid 1950 Census image: '${raw}'`);
  }
  if (text.startsWith('/1950census/')) {
    text = text.replace(/^\/+/, '');
  }
  if (text.startsWith('1950census/')) {
    return validateCensus1950ImagePath(text);
  }
  if (text.toLowerCase().startsWith('1950census%2f')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      throw new CliValidationError(`Invalid 1950 Census image path: '${raw}'`);
    }
    return validateCensus1950ImagePath(decoded);
  }
  if (!text.toLowerCase().startsWith('https://')) {
    throw new CliValidationError(
      'Pass a 1950census/...jpg path or an https://1950census.archives.gov/iiif/2/ URL.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new CliValidationError('1950 Census image URLs must be https://1950census.archives.gov/iiif/2/...');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    host !== '1950census.archives.gov' ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new CliValidationError('1950 Census image URLs must be https://1950census.archives.gov/iiif/2/...');
  }
  const prefix = '/iiif/2/';
  if (!parsed.pathname.startsWith(prefix)) {
    throw new CliValidationError('1950 Census image URLs must be https://1950census.archives.gov/iiif/2/...');
  }
  const rest = parsed.pathname.slice(prefix.length).replace(/\/+$/, '');
  if (!rest) {
    throw new CliValidationError('1950 Census image URLs must be https://1950census.archives.gov/iiif/2/...');
  }

  let encoded: string;
  if (rest.endsWith('/info.json')) {
    encoded = rest.slice(0, -'/info.json'.length);
  } else if (rest.endsWith('/default.jpg')) {
    const fullIdx = rest.indexOf('/full/');
    if (fullIdx !== -1) {
      encoded = rest.slice(0, fullIdx);
    } else {
      const parts = rest.split('/');
      if (parts.length >= 5) {
        encoded = parts.slice(0, parts.length - 4).join('/');
      } else {
        throw new CliValidationError(
          'Pass an IIIF info.json URL, base URL, or default.jpg URL from 1950census.archives.gov.'
        );
      }
    }
  } else if (rest.toLowerCase().endsWith('.jpg')) {
    encoded = rest;
  } else {
    throw new CliValidationError(
      'Pass an IIIF info.json URL, base URL, or default.jpg URL from 1950census.archives.gov.'
    );
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new CliValidationError(`Invalid 1950 Census image path: '${raw}'`);
  }
  return validateCensus1950ImagePath(decoded);
}

export function census1950ImageJpegUrl(imagePath: string, width: number | null): string {
  const size = width === null ? 'full' : `${width},`;
  const encoded = quotePythonStyle(imagePath, false);
  return `${CENSUS1950_IIIF_ORIGIN}/iiif/2/${encoded}/full/${size}/0/default.jpg`;
}

export function census1950ImageCachePaths(
  imagePath: string,
  width: number | null,
  cacheRoot: string
): readonly [string, string] {
  const key = canonicalJsonStringify({ image: imagePath, width });
  const digest = sha256Hex(key);
  const dir = path.join(cacheRoot, 'census1950-images');
  return [resolveSafeChild(dir, `${digest}.jpg`), resolveSafeChild(dir, `${digest}.lock`)];
}

function isExistingDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export function resolveCensus1950ImageOutput(rawOutPath: string, imagePath: string, cwd: string): string {
  if (rawOutPath.includes('\0')) {
    throw new CliValidationError(`Invalid output path: ${rawOutPath}`);
  }
  if (hasParentTraversal(rawOutPath) && !path.isAbsolute(rawOutPath)) {
    throw new RecordRuntimeError(`Unsafe output path containing '..': ${rawOutPath}`);
  }
  const resolvedOut = resolveUserPath(rawOutPath, cwd);
  const slashIdx = imagePath.lastIndexOf('/');
  const filename = slashIdx === -1 ? imagePath : imagePath.slice(slashIdx + 1);
  const ext = path.extname(rawOutPath).toLowerCase();
  const looksLikeFile = CENSUS1950_JPEG_SUFFIXES.has(ext) && !isExistingDirectory(resolvedOut);
  const dest = looksLikeFile ? resolvedOut : path.join(resolvedOut, filename);
  if (dest.includes('\0')) {
    throw new CliValidationError(`Invalid output path: ${rawOutPath}`);
  }
  return dest;
}

export function requireJpegBytes(data: Buffer): Buffer {
  if (!data.subarray(0, 3).equals(JPEG_MAGIC)) {
    throw new RecordRuntimeError('1950 Census image response is not a JPEG.');
  }
  return data;
}

function readCachedCensus1950Image(filePath: string, ttlHours: number, nowMs: () => number): Buffer | null {
  if (ttlHours <= 0) {
    return null;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const ageSeconds = (nowMs() - stat.mtimeMs) / 1000;
  if (ageSeconds > ttlHours * 3600) {
    return null;
  }
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (!data.subarray(0, 3).equals(JPEG_MAGIC)) {
    return null;
  }
  return data;
}

export async function census1950FetchJpeg(
  url: string,
  ctx: Pick<RecordCommandContext, 'fetchImpl' | 'sleepFn' | 'nowMs'>,
  timeoutSec = CENSUS1950_IMAGE_TIMEOUT
): Promise<Buffer> {
  const headers: Record<string, string> = {
    Accept: 'image/jpeg',
    'User-Agent': 'kinloom/1.0 (genealogy research)',
  };
  const timeoutMs = Math.max(1000, Math.round(timeoutSec * 1000));

  for (let attempt = 1; attempt <= CENSUS1950_IMAGE_ATTEMPTS; attempt += 1) {
    try {
      const resp = await fetchWithTimeout(
        url,
        { method: 'GET', headers, redirect: 'manual' },
        timeoutMs,
        ctx.fetchImpl
      );
      if (resp.status < 200 || resp.status >= 300) {
        if (CENSUS1950_TRANSIENT_STATUS.has(resp.status) && attempt < CENSUS1950_IMAGE_ATTEMPTS) {
          await ctx.sleepFn(census1950RetryDelayMs(attempt, resp, ctx.nowMs));
          continue;
        }
        const snippet = (await resp.text().catch(() => '')).slice(0, 200).trim();
        throw new HttpStatusError(resp.status, url, snippet);
      }

      const contentType = resp.headers.get('content-type') ?? '';
      if (contentType.toLowerCase().includes('html')) {
        throw new TransientNonJpegError('1950 Census image response was HTML, not a JPEG.');
      }

      const contentEncoding = (resp.headers.get('content-encoding') ?? '').trim().toLowerCase();
      const rawLen = (resp.headers.get('content-length') ?? '').trim();
      let expectedLen: number | null = null;
      if (rawLen && (!contentEncoding || contentEncoding === 'identity')) {
        if (/^\d+$/.test(rawLen)) {
          const parsedLen = Number.parseInt(rawLen, 10);
          if (parsedLen > 0) {
            expectedLen = parsedLen;
          }
        }
      }

      const body = Buffer.from(await resp.arrayBuffer());
      if (expectedLen !== null && body.length < expectedLen) {
        throw new IncompleteDownloadError(
          `Incomplete 1950 Census JPEG download: received ${body.length} of ${expectedLen} bytes`
        );
      }
      if (!body.subarray(0, 3).equals(JPEG_MAGIC)) {
        throw new TransientNonJpegError('1950 Census image response is not a JPEG.');
      }
      return body;
    } catch (err: unknown) {
      if (err instanceof HttpStatusError) {
        throw err;
      }
      if (err instanceof TransientNonJpegError) {
        if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
          throw new RecordRuntimeError(err.message);
        }
        await ctx.sleepFn(census1950RetryDelayMs(attempt, null, ctx.nowMs));
        continue;
      }
      if (err instanceof IncompleteDownloadError) {
        if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
          throw err;
        }
        await ctx.sleepFn(census1950RetryDelayMs(attempt, null, ctx.nowMs));
        continue;
      }
      if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
        const message = err instanceof Error ? err.message : String(err);
        throw new IncompleteDownloadError(message);
      }
      await ctx.sleepFn(census1950RetryDelayMs(attempt, null, ctx.nowMs));
    }
  }

  throw new RecordRuntimeError('census1950-image retries ended without a JPEG or an error.');
}

async function loadCensus1950ImageBytes(
  imagePath: string,
  options: {
    readonly width: number | null;
    readonly refresh: boolean;
    readonly ttlHours: number;
    readonly timeoutSec: number;
    readonly cacheRoot: string;
  },
  ctx: RecordCommandContext
): Promise<readonly [Buffer, boolean]> {
  const url = census1950ImageJpegUrl(imagePath, options.width);
  const [dataPath, lockPath] = census1950ImageCachePaths(imagePath, options.width, options.cacheRoot);
  if (!options.refresh) {
    const cached = readCachedCensus1950Image(dataPath, options.ttlHours, ctx.nowMs);
    if (cached !== null) {
      return [cached, true];
    }
  }
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const cached = readCachedCensus1950Image(dataPath, options.ttlHours, ctx.nowMs);
        if (cached !== null) {
          return [cached, true] as const;
        }
      }
      const fetched = requireJpegBytes(await census1950FetchJpeg(url, ctx, options.timeoutSec));
      atomicWriteFileSync(dataPath, fetched);
      return [fetched, false] as const;
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

async function storeCensus1950Image(
  imagePath: string,
  options: {
    readonly outPath: string;
    readonly width: number | null;
    readonly refresh: boolean;
    readonly ttlHours: number;
    readonly timeoutSec: number;
    readonly cacheRoot: string;
  },
  ctx: RecordCommandContext
): Promise<Census1950ImageRecord> {
  const dest = resolveCensus1950ImageOutput(options.outPath, imagePath, ctx.cwd);
  const [data, cacheHit] = await loadCensus1950ImageBytes(imagePath, options, ctx);
  const jpeg = requireJpegBytes(data);
  atomicWriteFileSync(dest, jpeg);
  return {
    image: imagePath,
    url: census1950ImageJpegUrl(imagePath, options.width),
    path: dest,
    bytes: jpeg.length,
    width: options.width,
    cache_hit: cacheHit,
  };
}

// ---------------------------------------------------------------------------
// Option Specs & Help Text
// ---------------------------------------------------------------------------

const COMMON_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'levels',
    kind: 'string',
    flags: ['--level'],
    multiple: true,
    metavar: 'LEVEL',
    help: 'Level(s): recordGroup, collection, series, fileUnit, item.',
  },
  {
    key: 'recordGroups',
    kind: 'string',
    flags: ['--rg'],
    multiple: true,
    metavar: 'RG',
    help: 'Record Group number(s), e.g. 109 or 29,109.',
  },
  {
    key: 'online',
    kind: 'boolean',
    flags: ['--online'],
    help: 'Limit to records with viewable digital objects.',
  },
  {
    key: 'materialType',
    kind: 'string',
    flags: ['--type'],
    metavar: 'TYPE',
    help: "Type of material, e.g. 'Textual Records'.",
  },
  {
    key: 'person',
    kind: 'string',
    flags: ['--person'],
    metavar: 'NAME',
    help: 'Person or Organization authority heading.',
  },
  {
    key: 'title',
    kind: 'string',
    flags: ['--title'],
    metavar: 'TITLE',
    help: 'Title search filter.',
  },
  {
    key: 'geo',
    kind: 'string',
    flags: ['--geo'],
    metavar: 'PLACE',
    help: 'Geographic reference filter.',
  },
  {
    key: 'control',
    kind: 'string',
    flags: ['--control'],
    metavar: 'ID',
    help: 'Control number or microform identifier.',
  },
  {
    key: 'series',
    kind: 'string',
    flags: ['--series'],
    metavar: 'SERIES',
    help: 'Series filter: 4-digit year (e.g. 1940), microform ID (e.g. M593), series NAID, or series title.',
  },
  {
    key: 'startDate',
    kind: 'string',
    flags: ['--start-date'],
    metavar: 'DATE',
    help: 'Beginning date (YYYY, YYYY-MM, or YYYY-MM-DD).',
  },
  {
    key: 'endDate',
    kind: 'string',
    flags: ['--end-date'],
    metavar: 'DATE',
    help: 'Ending date (YYYY, YYYY-MM, or YYYY-MM-DD).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    default: 1,
    metavar: 'N',
    help: 'Result page number.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit'],
    default: 20,
    metavar: 'N',
    help: 'Results per page.',
  },
];

const URL_OPTIONS: readonly OptionSpec[] = [
  ...COMMON_SEARCH_OPTIONS,
  {
    key: 'forApi',
    kind: 'boolean',
    flags: ['--api'],
    help: 'Output the v2 API endpoint URL instead of the website URL.',
  },
];

const URL_PARSE_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'query',
};

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  ...COMMON_SEARCH_OPTIONS,
  {
    key: 'apiKey',
    kind: 'string',
    flags: ['--api-key'],
    metavar: 'KEY',
    help: 'NARA Catalog v2 API key (defaults to $NARA_API_KEY).',
  },
  {
    key: 'forceBrowser',
    kind: 'boolean',
    flags: ['--browser'],
    help: 'Force headless Chromium website mode.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the local disk cache and fetch fresh search results.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Override search query cache TTL in hours (default: 168 or $KINLOOM_NARA_QUERY_TTL_HOURS).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON.',
  },
];

const SEARCH_PARSE_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
};

const GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'apiKey',
    kind: 'string',
    flags: ['--api-key'],
    metavar: 'KEY',
    help: 'NARA Catalog v2 API key (defaults to $NARA_API_KEY).',
  },
  {
    key: 'forceBrowser',
    kind: 'boolean',
    flags: ['--browser'],
    help: 'Force headless Chromium website mode.',
  },
  {
    key: 'objects',
    kind: 'boolean',
    flags: ['--objects'],
    help: 'Include compact digital object URLs (omitted by default).',
  },
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages'],
    default: 'all',
    metavar: 'SPEC',
    help: "1-based page slice when using --objects or --text, e.g. '1-10'.",
  },
  {
    key: 'text',
    kind: 'boolean',
    flags: ['--text'],
    help: 'Include extracted OCR text and transcriptions if present.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the local disk cache and fetch fresh record metadata.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON.',
  },
];

const GET_PARSE_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'NAID',
};

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outDir',
    kind: 'string',
    flags: ['-o', '--out', '--out-dir'],
    metavar: 'PATH',
    help: 'Output directory for NAID records (default: ./nara-<naid>) or file/directory for a direct NARA/S3 URL.',
  },
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages'],
    default: 'all',
    metavar: 'SPEC',
    help: "1-based page selection, e.g. '1-5,10' or 'all'.",
  },
  {
    key: 'metadata',
    kind: 'boolean',
    flags: ['--metadata'],
    negatable: true,
    default: true,
    help: 'Save compact provenance metadata.json.',
  },
  {
    key: 'overwrite',
    kind: 'boolean',
    flags: ['--overwrite'],
    help: 'Overwrite existing downloaded files.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local metadata and object caches and re-download from NARA.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_DOWNLOAD_TIMEOUT,
    metavar: 'SECONDS',
    help: 'Per-file download read timeout in seconds.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Cache TTL in hours for direct URL downloads (default 168; 0 disables cache reads).',
  },
  {
    key: 'apiKey',
    kind: 'string',
    flags: ['--api-key'],
    metavar: 'KEY',
    help: 'NARA Catalog v2 API key (defaults to $NARA_API_KEY).',
  },
  {
    key: 'forceBrowser',
    kind: 'boolean',
    flags: ['--browser'],
    help: 'Force headless Chromium website mode.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output structured JSON including boolean cache_hit.',
  },
];

const DOWNLOAD_PARSE_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'NAID or URL',
};

const CENSUS1950_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'state',
    kind: 'string',
    flags: ['--state'],
    metavar: 'STATE',
    help: 'State or territory code (IL) or name (Illinois).',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    metavar: 'COUNTY',
    help: 'County name, as the 1950 Census site spells it.',
  },
  {
    key: 'name',
    kind: 'string',
    flags: ['--name', '--surname'],
    metavar: 'NAME',
    help: 'Person name. Sent as the site name= parameter.',
  },
  {
    key: 'ed',
    kind: 'string',
    flags: ['--ed', '--district'],
    metavar: 'ED',
    help: 'Enumeration district, for example 49-16.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit', '--rows'],
    default: CENSUS1950_DEFAULT_LIMIT,
    metavar: 'N',
    help: 'Results per page (API size=, 1..100).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    default: 1,
    metavar: 'N',
    help: 'Result page number (1-based).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of text.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and query the 1950 Census API.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_NARA_QUERY_TTL_HOURS).',
  },
];

const CENSUS1950_PARSE_SPEC: CommandParseSpec = {
  options: CENSUS1950_OPTIONS,
  allowPositionals: true,
};

const CENSUS1950_IMAGE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outPath',
    kind: 'string',
    flags: ['-o', '--out', '--out-dir', '--output'],
    default: '.',
    metavar: 'PATH',
    help: 'Directory for one or more images, or a .jpg/.jpeg file when you pass one image.',
  },
  {
    key: 'width',
    kind: 'integer',
    flags: ['--width', '--max-width'],
    min: 1,
    max: CENSUS1950_IMAGE_MAX_WIDTH,
    metavar: 'PX',
    help: `IIIF pixel width (1..${CENSUS1950_IMAGE_MAX_WIDTH}). Omit for full resolution.`,
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: CENSUS1950_IMAGE_TIMEOUT,
    metavar: 'SECONDS',
    help: 'Per-image HTTP read timeout in seconds.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of text.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and download the JPEG again.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_NARA_QUERY_TTL_HOURS).',
  },
];

const CENSUS1950_IMAGE_PARSE_SPEC: CommandParseSpec = {
  options: CENSUS1950_IMAGE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'IMAGE_OR_URL',
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom nara <command> [options]',
    summary: 'Search, inspect, and download National Archives Catalog (NARA) records.',
    subcommands: [
      { name: 'url', summary: 'Build and print a verified NARA Catalog search URL.' },
      { name: 'search', summary: 'Search the NARA Catalog (parallel via API or shared browser).' },
      { name: 'get', summary: 'Inspect one or more NARA records by NAID (alias: show).' },
      { name: 'download', summary: 'Download digitized files for a NARA record or direct NARA/S3 URL.' },
      { name: 'census1950', summary: 'Search 1950 Census population schedules on 1950census.archives.gov.' },
      { name: 'census1950-image', summary: 'Download one or more 1950 Census schedule JPEGs via IIIF.' },
    ],
  });
}

// ---------------------------------------------------------------------------
// Subcommand Handlers
// ---------------------------------------------------------------------------

function extractCommonSearchOptions(parsed: ReturnType<typeof parseCommandArgs>): SearchFilterOptions {
  return {
    levels: getStringListOption(parsed, 'levels'),
    recordGroups: getStringListOption(parsed, 'recordGroups'),
    online: getBooleanOption(parsed, 'online'),
    materialType: getStringOption(parsed, 'materialType'),
    person: getStringOption(parsed, 'person'),
    title: getStringOption(parsed, 'title'),
    geo: getStringOption(parsed, 'geo'),
    control: getStringOption(parsed, 'control'),
    series: getStringOption(parsed, 'series'),
    startDate: getStringOption(parsed, 'startDate'),
    endDate: getStringOption(parsed, 'endDate'),
    page: getNumberOption(parsed, 'page') ?? 1,
    limit: getNumberOption(parsed, 'limit') ?? 20,
  };
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara url [QUERY] [options]',
          summary: 'Build and print a verified NARA Catalog search URL.',
          options: URL_OPTIONS,
        })
      ),
    };
  }
  const query = parsed.positionals[0] ?? null;
  const filters = extractCommonSearchOptions(parsed);
  const forApi = getBooleanOption(parsed, 'forApi');
  const params = buildQueryParams(query, { ...filters, forApi });
  const bytesOut = emitStdout(ctx.io, encodeCatalogUrl(params, forApi));
  return { exitCode: 0, bytesOut };
}

async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext,
  overrides: NaraBrowserOverrides
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara search [QUERIES...] [options]',
          summary: 'Search the NARA Catalog. Accepts one or multiple queries.',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }

  const queries: readonly (string | null)[] = parsed.positionals.length > 0 ? parsed.positionals : [null];
  const filters = extractCommonSearchOptions(parsed);
  const apiKey = getStringOption(parsed, 'apiKey') ?? ctx.env.NARA_API_KEY;
  const forceBrowser = getBooleanOption(parsed, 'forceBrowser');
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');
  const asJson = getBooleanOption(parsed, 'asJson');

  const useApi = Boolean(apiKey) && !forceBrowser;
  const ttlHours = resolveQueryTtlHours(cliTtl, ctx.env);
  const cacheRoot = getCacheRoot(ctx);

  // Validate query parameters before consulting cache.
  buildQueryParams(queries[0], { ...filters, forApi: useApi });

  const canonicalList = queries.map((q) => canonicalSearchParams(q, filters));
  const slots: (NaraSearchPayload | null)[] = Array.from({ length: queries.length }, () => null);
  const hitFlags: boolean[] = Array.from({ length: queries.length }, () => false);
  const missIndices: number[] = [];

  for (let idx = 0; idx < canonicalList.length; idx += 1) {
    if (!refresh) {
      const cached = readCachedSearch(canonicalList[idx], cacheRoot, ttlHours, ctx.nowMs);
      if (cached !== null) {
        slots[idx] = cached;
        hitFlags[idx] = true;
        continue;
      }
    }
    missIndices.push(idx);
  }

  const browserSearch = overrides.browserSearchMany ?? defaultBrowserSearchMany;

  if (missIndices.length > 0) {
    const missQueries = missIndices.map((idx) => queries[idx]);
    if (useApi && apiKey) {
      const activeKey = apiKey;
      const outcomes = await mapConcurrent(missQueries, API_MAX_WORKERS, (q) =>
        apiSearchOne(q, activeKey, filters, ctx)
      );

      const fallbackSlots: number[] = [];
      const fallbackPairs: (readonly [string | null, string])[] = [];
      for (let i = 0; i < missIndices.length; i += 1) {
        const slotIdx = missIndices[i];
        const [entry, webUrl] = outcomes[i];
        if (entry === null) {
          fallbackSlots.push(slotIdx);
          fallbackPairs.push([queries[slotIdx], webUrl]);
        } else {
          slots[slotIdx] = entry;
          await writeCachedSearch(canonicalList[slotIdx], entry, cacheRoot, ctx);
        }
      }

      if (fallbackPairs.length > 0) {
        const fallbackResults = await browserSearch(fallbackPairs, ctx);
        for (let i = 0; i < fallbackSlots.length; i += 1) {
          const slotIdx = fallbackSlots[i];
          const fbEntry = fallbackResults[i];
          if (fbEntry) {
            slots[slotIdx] = fbEntry;
            await writeCachedSearch(canonicalList[slotIdx], fbEntry, cacheRoot, ctx);
          }
        }
      }
    } else {
      const urlPairs: (readonly [string | null, string])[] = missQueries.map((q) => [
        q,
        encodeCatalogUrl(buildQueryParams(q, { ...filters, forApi: false }), false),
      ]);
      const fetched = await browserSearch(urlPairs, ctx);
      for (let i = 0; i < missIndices.length; i += 1) {
        const slotIdx = missIndices[i];
        const entry = fetched[i];
        if (entry) {
          slots[slotIdx] = entry;
          await writeCachedSearch(canonicalList[slotIdx], entry, cacheRoot, ctx);
        }
      }
    }
  }

  const payloads: { readonly entry: NaraSearchPayload; readonly isHit: boolean }[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    const entry = slots[i];
    if (entry !== null) {
      payloads.push({ entry, isHit: hitFlags[i] });
    }
  }

  const allCacheHit = payloads.length > 0 && payloads.every((p) => p.isHit);

  if (asJson) {
    const jsonPayloads = payloads.map(({ entry, isHit }) => ({ ...entry, cache_hit: isHit }));
    const bytesOut = emitJsonStdout(ctx.io, jsonPayloads.length === 1 ? jsonPayloads[0] : jsonPayloads);
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  }

  const lines: string[] = [];
  for (let pIdx = 0; pIdx < payloads.length; pIdx += 1) {
    if (pIdx > 0) {
      lines.push('');
    }
    const payload = payloads[pIdx].entry;
    const hdr = payload.query ? `Query: ${payload.query} | ` : '';
    lines.push(`${hdr}Total: ${payload.total} | ${payload.searchUrl}`);
    for (let idx = 0; idx < payload.results.length; idx += 1) {
      const rec = payload.results[idx];
      const metaParts = [
        rec.level,
        rec.rg !== undefined ? `RG ${rec.rg}` : undefined,
        rec.objectCount ? `${rec.objectCount} files` : undefined,
      ].filter((part): part is string => Boolean(part));
      const meta = metaParts.join(' | ');
      const series = rec.series ? ` [${rec.series}]` : '';
      const numStr = String(idx + 1).padStart(2, ' ');
      lines.push(`  ${numStr}. NAID ${rec.naId} (${meta}): ${rec.title ?? ''}${series}`);
    }
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
}

async function runGet(
  argv: readonly string[],
  ctx: RecordCommandContext,
  overrides: NaraBrowserOverrides
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara get <NAID...> [options]',
          summary: 'Inspect one or more NARA records by NAID (compact metadata by default).',
          options: GET_OPTIONS,
        })
      ),
    };
  }

  const naids = parsed.positionals;
  const apiKey = getStringOption(parsed, 'apiKey') ?? ctx.env.NARA_API_KEY;
  const forceBrowser = getBooleanOption(parsed, 'forceBrowser');
  const objects = getBooleanOption(parsed, 'objects');
  const pages = getStringOption(parsed, 'pages') ?? 'all';
  const text = getBooleanOption(parsed, 'text');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const cacheRoot = getCacheRoot(ctx);
  const [fullRecords, hitFlags] = await loadOrFetchFullRecordsWithHits(
    naids,
    { apiKey, forceBrowser, includeText: text, refresh, cacheRoot },
    ctx,
    overrides
  );

  const records = fullRecords.map((rec) =>
    rec.error ? rec : projectRecord(rec, { includeObjects: objects, includeText: text, pageSpec: pages })
  );

  const allCacheHit = hitFlags.length > 0 && hitFlags.every(Boolean);

  if (asJson) {
    const jsonRecords = records.map((rec, idx) => ({ ...rec, cache_hit: hitFlags[idx] }));
    const bytesOut = emitJsonStdout(ctx.io, jsonRecords.length === 1 ? jsonRecords[0] : jsonRecords);
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  }

  const textOutput = records.map((rec) => formatRecordText(rec)).join('\n\n');
  const bytesOut = emitStdout(ctx.io, textOutput);
  return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
}

async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext,
  overrides: NaraBrowserOverrides
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara download <NAID_OR_URL> [options]',
          summary: 'Download digitized files for a NARA record (NAID) or a direct NARA/S3 URL.',
          options: DOWNLOAD_OPTIONS,
        })
      ),
    };
  }

  const target = parsed.positionals[0];
  const rawOutDir = getStringOption(parsed, 'outDir');
  const pages = getStringOption(parsed, 'pages') ?? 'all';
  const metadata = getBooleanOption(parsed, 'metadata');
  const overwrite = getBooleanOption(parsed, 'overwrite');
  const refresh = getBooleanOption(parsed, 'refresh');
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? DEFAULT_DOWNLOAD_TIMEOUT;
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');
  const apiKey = getStringOption(parsed, 'apiKey') ?? ctx.env.NARA_API_KEY;
  const forceBrowser = getBooleanOption(parsed, 'forceBrowser');
  const asJson = getBooleanOption(parsed, 'asJson');

  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(timeoutSec)} (must be > 0).`);
  }

  const cacheRoot = getCacheRoot(ctx);
  if (isDirectDownloadUrl(target)) {
    const ttlHours = resolveQueryTtlHours(cliTtl, ctx.env);
    return downloadDirectUrl(
      target,
      {
        outPath: rawOutDir,
        overwrite,
        refresh,
        timeoutSec,
        ttlHours,
        asJson,
        cacheRoot,
      },
      ctx
    );
  }

  const cleanId = validateNaid(target);
  const ttlOverride = cliTtl !== undefined ? resolveQueryTtlHours(cliTtl, ctx.env) : null;

  const [fullRecords, metaHits] = await loadOrFetchFullRecordsWithHits(
    [cleanId],
    { apiKey, forceBrowser, includeText: false, refresh, cacheRoot },
    ctx,
    overrides
  );
  const fullRec = fullRecords[0];
  const metaCacheHit = metaHits[0] ?? false;
  if (!fullRec) {
    throw new RecordRuntimeError(`NAID ${cleanId}: Record not found.`);
  }
  if (fullRec.error) {
    throw new RecordRuntimeError(`NAID ${cleanId}: ${fullRec.error}`);
  }

  const rec = projectRecord(fullRec, {
    includeObjects: true,
    includeText: false,
    pageSpec: pages,
  });
  const selectedObjs = rec.objects ?? [];
  const totalCount = rec.objectCount ?? selectedObjs.length;
  if (selectedObjs.length === 0) {
    throw new RecordRuntimeError(
      `NAID ${cleanId} (${rec.title ?? ''}) has no matching digital objects for '${pages}'.`
    );
  }

  if (rawOutDir !== undefined && hasParentTraversal(rawOutDir) && !path.isAbsolute(rawOutDir)) {
    throw new RecordRuntimeError(`Unsafe output directory containing '..': ${rawOutDir}`);
  }
  const targetDir = rawOutDir ? resolveUserPath(rawOutDir, ctx.cwd) : path.join(ctx.cwd, `nara-${cleanId}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const objCacheDir = path.join(cacheRoot, 'objects', cleanId);

  interface PreparedObject {
    readonly pageNum: number;
    readonly objUrl: string;
    readonly cacheFilename: string;
    readonly cachedObjPath: string;
    readonly metaSidecar: string;
    readonly dest: string;
  }

  const prepared: PreparedObject[] = [];
  for (const obj of selectedObjs) {
    if (!obj.url) {
      ctx.io.stderr(`Skipping page ${obj.page}: missing url`);
      continue;
    }
    validateNaraDownloadUrl(obj.url);
    const cacheFilename = safeObjectFilename(obj.page, obj.filename);
    const cachedObjPath = resolveSafeChild(objCacheDir, cacheFilename);
    const metaSidecar = resolveSafeChild(objCacheDir, `${cacheFilename}.meta.json`);
    const dest = resolveSafeChild(targetDir, cacheFilename);
    prepared.push({
      pageNum: obj.page,
      objUrl: obj.url,
      cacheFilename,
      cachedObjPath,
      metaSidecar,
      dest,
    });
  }

  interface DownloadSlotResult {
    readonly page: number;
    readonly file: string;
    readonly path: string;
    readonly url: string;
    readonly bytes: number;
    readonly content_type: string;
    readonly cache_hit: boolean;
    readonly cachedPath: string;
    readonly dest: string;
  }

  const results: (DownloadSlotResult | null)[] = Array.from({ length: prepared.length }, () => null);
  const uncachedIndices: number[] = [];

  for (let idx = 0; idx < prepared.length; idx += 1) {
    const item = prepared[idx];
    if (!refresh) {
      const cachedEntry = readCachedDownloadEntry(item.cachedObjPath, item.metaSidecar, {
        url: item.objUrl,
        ttlHours: ttlOverride,
        filenameHint: item.cacheFilename,
        nowMs: ctx.nowMs,
      });
      if (cachedEntry !== null) {
        results[idx] = {
          page: item.pageNum,
          file: path.basename(item.dest),
          path: item.dest,
          url: item.objUrl,
          bytes: cachedEntry.bytes,
          content_type: cachedEntry.content_type,
          cache_hit: true,
          cachedPath: item.cachedObjPath,
          dest: item.dest,
        };
        continue;
      }
    }
    uncachedIndices.push(idx);
  }

  if (uncachedIndices.length > 0) {
    const fetched = await mapConcurrent(uncachedIndices, DOWNLOAD_MAX_WORKERS, async (slotIdx) => {
      const item = prepared[slotIdx];
      const lockPath = resolveSafeChild(
        path.join(cacheRoot, '_locks'),
        `object_${cleanId}_${item.cacheFilename}.lock`
      );
      const locked = await withAdvisoryLock(
        lockPath,
        async (): Promise<{ readonly entry: CachedDownloadInfo; readonly hit: boolean }> => {
          if (!refresh) {
            const cached = readCachedDownloadEntry(item.cachedObjPath, item.metaSidecar, {
              url: item.objUrl,
              ttlHours: ttlOverride,
              filenameHint: item.cacheFilename,
              nowMs: ctx.nowMs,
            });
            if (cached !== null) {
              return { entry: cached, hit: true };
            }
          }
          const downloaded = await downloadObjectToCache(
            item.objUrl,
            item.cachedObjPath,
            {
              metaPath: item.metaSidecar,
              filenameHint: item.cacheFilename,
              timeoutSec,
            },
            ctx
          );
          return { entry: downloaded, hit: false };
        },
        { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
      );
      return {
        slotIdx,
        record: {
          page: item.pageNum,
          file: path.basename(item.dest),
          path: item.dest,
          url: item.objUrl,
          bytes: locked.entry.bytes,
          content_type: locked.entry.content_type,
          cache_hit: locked.hit,
          cachedPath: item.cachedObjPath,
          dest: item.dest,
        } satisfies DownloadSlotResult,
      };
    });

    for (const { slotIdx, record } of fetched) {
      results[slotIdx] = record;
    }
  }

  const downloadedManifest: { readonly page: number; readonly file: string; readonly url: string }[] = [];
  const jsonFiles: {
    readonly page: number;
    readonly file: string;
    readonly path: string;
    readonly url: string;
    readonly bytes: number;
    readonly content_type: string;
    readonly cache_hit: boolean;
  }[] = [];
  let totalBytes = 0;
  let bytesOut = 0;

  for (const item of results) {
    if (!item) {
      continue;
    }
    if (fs.existsSync(item.dest) && !overwrite && !refresh) {
      if (!asJson) {
        bytesOut += emitStdout(ctx.io, `Exists (skip): ${item.dest}`);
      }
    } else {
      atomicCopyFileSync(item.cachedPath, item.dest);
      if (!asJson) {
        const verb = item.cache_hit ? 'Cached' : 'Downloaded';
        const actualSize = fs.statSync(item.dest).size;
        bytesOut += emitStdout(
          ctx.io,
          `${verb} [${item.page}/${totalCount}]: ${item.dest} (${formatWithCommas(actualSize)} bytes)`
        );
      }
    }
    totalBytes += item.bytes;
    downloadedManifest.push({ page: item.page, file: item.file, url: item.url });
    jsonFiles.push({
      page: item.page,
      file: item.file,
      path: item.path,
      url: item.url,
      bytes: item.bytes,
      content_type: item.content_type,
      cache_hit: item.cache_hit,
    });
  }

  let metaPathOut: string | null = null;
  if (metadata) {
    const { objects: _omitted, ...compactMeta } = rec;
    metaPathOut = path.join(targetDir, 'metadata.json');
    atomicWriteFileSync(
      metaPathOut,
      `${JSON.stringify({ ...compactMeta, downloaded: downloadedManifest }, null, 2)}\n`
    );
    if (!asJson) {
      bytesOut += emitStdout(ctx.io, `Saved metadata: ${metaPathOut}`);
    }
  }

  const allCacheHit = metaCacheHit && jsonFiles.length > 0 && jsonFiles.every((f) => f.cache_hit);

  if (asJson) {
    const primaryCt = jsonFiles[0]?.content_type ?? '';
    bytesOut += emitJsonStdout(ctx.io, {
      naId: cleanId,
      url: rec.url || `${CATALOG_WEB_BASE}/id/${cleanId}`,
      path: targetDir,
      bytes: totalBytes,
      count: jsonFiles.length,
      content_type: primaryCt,
      cache_hit: allCacheHit,
      metadata_cache_hit: metaCacheHit,
      metadata_path: metaPathOut,
      files: jsonFiles,
    });
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  }

  bytesOut += emitStdout(ctx.io, `Done: ${downloadedManifest.length} file(s) in ${targetDir}`);
  return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
}

async function runCensus1950(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CENSUS1950_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara census1950 [NAME...] [options]',
          summary: 'Search 1950 Census population schedules on 1950census.archives.gov.',
          options: CENSUS1950_OPTIONS,
        })
      ),
    };
  }

  const posName = parsed.positionals
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(' ')
    .trim();
  const flagName = getStringOption(parsed, 'name');
  if (posName && flagName && flagName.trim()) {
    throw new CliValidationError('Pass either a positional name or --name/--surname, not both.');
  }
  const resolvedName = flagName && flagName.trim() ? flagName : posName || undefined;

  const canonical = canonicalCensus1950Query({
    state: getStringOption(parsed, 'state'),
    county: getStringOption(parsed, 'county'),
    name: resolvedName,
    ed: getStringOption(parsed, 'ed'),
    limit: getNumberOption(parsed, 'limit') ?? CENSUS1950_DEFAULT_LIMIT,
    page: getNumberOption(parsed, 'page') ?? 1,
  });

  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveQueryTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx);
  const [dataPath, lockPath] = census1950CachePaths(canonical, cacheRoot);

  if (!refresh) {
    const cached = readCachedCensus1950(dataPath, ttlHours, ctx.nowMs);
    if (cached !== null) {
      const bytesOut = emitCensus1950(cached, true, asJson, ctx);
      return { exitCode: 0, bytesOut, cacheHit: true };
    }
  }

  const result = await withAdvisoryLock(
    lockPath,
    async () => {
      if (!refresh) {
        const cached = readCachedCensus1950(dataPath, ttlHours, ctx.nowMs);
        if (cached !== null) {
          return { data: cached, cacheHit: true } as const;
        }
      }
      const fetched = await census1950FetchJson(census1950SearchUrl(canonical), ctx);
      atomicWriteCompactJson(dataPath, {
        cached_at: ctx.nowMs() / 1000,
        params: canonical,
        data: fetched,
      });
      return { data: fetched, cacheHit: false } as const;
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );

  const bytesOut = emitCensus1950(result.data, result.cacheHit, asJson, ctx);
  return { exitCode: 0, bytesOut, cacheHit: result.cacheHit };
}

async function runCensus1950Image(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CENSUS1950_IMAGE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara census1950-image <IMAGE_OR_URL...> [options]',
          summary: 'Download one or more 1950 Census schedule JPEGs from the NARA IIIF server.',
          options: CENSUS1950_IMAGE_OPTIONS,
        })
      ),
    };
  }

  const imageOrUrls = parsed.positionals;
  const outPath = getStringOption(parsed, 'outPath') ?? '.';
  const width = getNumberOption(parsed, 'width') ?? null;
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? CENSUS1950_IMAGE_TIMEOUT;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');

  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(timeoutSec)} (must be > 0).`);
  }
  if (imageOrUrls.length > CENSUS1950_IMAGE_MAX_PER_CALL) {
    throw new CliValidationError(
      `Pass at most ${CENSUS1950_IMAGE_MAX_PER_CALL} images per census1950-image call (got ${imageOrUrls.length}).`
    );
  }

  const imagePaths = imageOrUrls.map((raw) => parseCensus1950ImageSource(raw));
  const batch = imagePaths.length > 1;
  const resolvedOut = resolveUserPath(outPath, ctx.cwd);
  const looksLikeJpg =
    CENSUS1950_JPEG_SUFFIXES.has(path.extname(outPath).toLowerCase()) && !isExistingDirectory(resolvedOut);
  if (batch && looksLikeJpg) {
    throw new CliValidationError(
      '--out is a .jpg file, but this command received multiple images. Pass a directory, for example --out ./schedules.'
    );
  }
  for (const imagePath of imagePaths) {
    resolveCensus1950ImageOutput(outPath, imagePath, ctx.cwd);
  }

  const ttlHours = resolveQueryTtlHours(cliTtl, ctx.env);
  const cacheRoot = getCacheRoot(ctx);

  let records: Census1950ImageRecord[];
  try {
    const storeOptions = {
      outPath,
      width,
      refresh,
      ttlHours,
      timeoutSec,
      cacheRoot,
    };
    if (!batch) {
      records = [await storeCensus1950Image(imagePaths[0], storeOptions, ctx)];
    } else {
      records = await mapConcurrent(imagePaths, CENSUS1950_IMAGE_FETCH_WORKERS, (imagePath) =>
        storeCensus1950Image(imagePath, storeOptions, ctx)
      );
    }
  } catch (err: unknown) {
    if (err instanceof HttpStatusError) {
      if (err.status === 404) {
        throw new RecordRuntimeError(
          `1950 Census schedule image not found (HTTP 404) for ${err.url}. Verify the exact image path or sheet number via \`nara census1950\`.`
        );
      }
      if (CENSUS1950_TRANSIENT_STATUS.has(err.status)) {
        throw new RecordRuntimeError(
          `1950 Census IIIF server returned HTTP ${err.status} for ${err.url} after ${CENSUS1950_IMAGE_ATTEMPTS} attempts. Retry shortly or pass --width 2400.`
        );
      }
      throw new RecordRuntimeError(`HTTP ${err.status} downloading 1950 Census image ${err.url}`);
    }
    if (err instanceof IncompleteDownloadError) {
      throw new RecordRuntimeError(
        `1950 Census image download failed after ${CENSUS1950_IMAGE_ATTEMPTS} attempts: ${err.message}. Retry shortly or pass --width 2400.`
      );
    }
    throw err;
  }

  const allCacheHit = records.length > 0 && records.every((item) => item.cache_hit);

  if (!batch) {
    const rec = records[0];
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, rec);
      return { exitCode: 0, bytesOut, cacheHit: rec.cache_hit };
    }
    const verb = rec.cache_hit ? 'Cached' : 'Downloaded';
    const bytesOut = emitStdout(ctx.io, `${verb}: ${rec.path} (${formatWithCommas(rec.bytes)} bytes)`);
    return { exitCode: 0, bytesOut, cacheHit: rec.cache_hit };
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      count: records.length,
      files: records,
      cache_hit: allCacheHit,
    });
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  }

  const lines = records.map((item) => {
    const verb = item.cache_hit ? 'Cached' : 'Downloaded';
    return `${verb}: ${item.path} (${formatWithCommas(item.bytes)} bytes)`;
  });
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
}

// ---------------------------------------------------------------------------
// Public Entrypoint
// ---------------------------------------------------------------------------

const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  show: 'get',
};

export function createNaraCommand(overrides: NaraBrowserOverrides = {}): RecordHandler {
  return async (args, ctx): Promise<RecordCommandOutcome> => {
    try {
      if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
      }
      const [rawSubcmd, ...rest] = args;
      const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);
      switch (subcmd) {
        case 'url':
          return runUrl(rest, ctx);
        case 'search':
          return await runSearch(rest, ctx, overrides);
        case 'get':
          return await runGet(rest, ctx, overrides);
        case 'download':
          return await runDownload(rest, ctx, overrides);
        case 'census1950':
          return await runCensus1950(rest, ctx);
        case 'census1950-image':
          return await runCensus1950Image(rest, ctx);
        default:
          throw new CliValidationError(`No such command '${rawSubcmd}'. Run 'kinloom nara --script-help'.`);
      }
    } catch (err: unknown) {
      if (isEpipeError(err)) {
        return { exitCode: 0, bytesOut: 0 };
      }
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
}

export const runNaraCommand: RecordHandler = createNaraCommand();
