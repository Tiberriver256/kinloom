import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  cachedJsonCall,
  DEFAULT_USER_AGENT,
  emitJsonStdout,
  emitStdout,
  expandHomePath,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpRequest,
  isPrivateOrReservedIp,
  parseCacheTtlHours,
  parseCommandArgs,
  RecordRuntimeError,
  resolveCacheDir,
  resolveSubcommandAlias,
  sha256Hex,
  SsrfBlockedError,
  withAdvisoryLock,
  type CommandParseSpec,
  type HttpResponseResult,
  type OptionSpec,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  type UrlSecurityPolicy,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const CACHE_SCHEMA = 1;
const API_BASE = 'https://api.openarch.nl/1.0/records';
const WEB_BASE = 'https://www.openarchieven.nl';
const ALLOWED_API_HOSTS: ReadonlySet<string> = new Set(['api.openarch.nl']);
const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504, 520, 522, 524,
]);
const MAX_HTTP_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const MIN_INTERVAL_MS = 250;
const TIMEOUT_MS = 30_000;

const ARCHIVE_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OPENARCH_URL_RE = /openarchieven\.nl\/([a-z0-9_-]+):([A-Za-z0-9_-]+)/i;
const PROXY_THUMB_RE =
  /^https?:\/\/proxy\.archieven\.nl\/thumb\/([^/?#]+)\/([^/?#]+)(?:[?#].*)?$/i;
const IIIF_INFO_RE = /^(https?:\/\/.+)\/info\.json(?:[?#].*)?$/i;
const IIIF_JP2_RE =
  /^(https?:\/\/.+\/full\/[^/?#]+\/[^/?#]+\/default)\.jp2(?:[?#].*)?$/i;

const VIEWER_HOSTS: ReadonlySet<string> = new Set([
  'www.archieven.nl',
  'archieven.nl',
  'www.zeeuwsarchief.nl',
  'zeeuwsarchief.nl',
  'www.zeeuwengezocht.nl',
  'zeeuwengezocht.nl',
  'hdl.handle.net',
  'collectie-delft.nl',
  'www.collectie-delft.nl',
  'allefriezen.nl',
  'www.allefriezen.nl',
  'westbrabantsarchief.nl',
  'www.westbrabantsarchief.nl',
  'stadsarchief.rotterdam.nl',
  'www.stadsarchief.rotterdam.nl',
  'hetutrechtsarchief.nl',
  'www.hetutrechtsarchief.nl',
  'www.bhic.nl',
  'bhic.nl',
  'www.allegroningers.nl',
  'allegroningers.nl',
]);

const KNOWN_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'bevolkingsregister',
  'passagiersregisters',
  'notariële archieven',
  'militieregisters',
  'bidprentjes',
  'familienamen',
  'gezinskaarten',
  'persoonskaarten',
  'woningkaarten',
  'memorie van successie',
]);

const VALID_LANGS = ['nl', 'en', 'de', 'fr'] as const;

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

const HTML_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
]);

const FALLBACK_HTTP_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  get: 'show',
};

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
    super(
      `Scan download failed with HTTP ${statusCode} for ${url}. The response was not cached.`
    );
    this.name = 'ScanHttpError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(val: unknown): unknown[] {
  if (val === null || val === undefined) {
    return [];
  }
  return Array.isArray(val) ? val : [val];
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_OPENARCHIEVEN_CACHE_DIR'],
    defaultSubdir: 'kinloom-openarchieven',
  });
}

function resolveTtlHours(
  cliTtl: number | undefined,
  ctx: RecordCommandContext
): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_OPENARCHIEVEN_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_OPENARCHIEVEN_CACHE_TTL_HOURS'
  );
}

function resolveDestPath(rawDest: string, ctx: RecordCommandContext): string {
  const expanded = expandHomePath(rawDest, ctx.env);
  return path.isAbsolute(expanded) ? expanded : path.resolve(ctx.cwd, expanded);
}

function isExistingDir(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(targetPath: string): boolean {
  try {
    fs.statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function validateApiUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(url, `Refusing invalid API URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(url, `Refusing non-HTTPS API URL: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError(url, 'Refusing API URL containing embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!ALLOWED_API_HOSTS.has(host)) {
    const allowed = Array.from(ALLOWED_API_HOSTS).toSorted().join(', ');
    throw new SsrfBlockedError(url, `Refusing API host '${host}'; allowed hosts: ${allowed}.`);
  }
  return url;
}

export function validateScanUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(
      url,
      `Refusing to download a scan URL that is not http or https: ${url}`
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname
  ) {
    throw new SsrfBlockedError(
      url,
      `Refusing to download a scan URL that is not http or https: ${url}`
    );
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError(url, 'Refusing scan URL containing embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new SsrfBlockedError(url, `Refusing local or private scan host '${host}': ${url}`);
  }
  if (isPrivateOrReservedIp(host)) {
    throw new SsrfBlockedError(
      url,
      `Refusing private or reserved IP scan host '${host}': ${url}`
    );
  }
  return url;
}

async function requestWithRetry(
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
    const target =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
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
      retryStatuses: TRANSIENT_STATUS_CODES,
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
      // Ensure validator's domain-specific message is preserved on redirect blocks.
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

async function getJson(
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
    throw new RecordRuntimeError(
      `OpenArchieven API error ${String(data.error_code)}: ${desc}`
    );
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

function isViewerUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (VIEWER_HOSTS.has(host)) {
    return true;
  }
  if (host === 'sgen.schiedam.nl' && !parsed.pathname.toLowerCase().startsWith('/scans/')) {
    return true;
  }
  return false;
}

function deriveProxyDownloadUrl(url: string): string | undefined {
  if (!url) {
    return undefined;
  }
  const match = PROXY_THUMB_RE.exec(url.trim());
  if (!match) {
    return undefined;
  }
  return `https://proxy.archieven.nl/download/${match[1]}/${match[2]}`;
}

function deriveIiifJpegUrl(url: string): string | undefined {
  if (!url) {
    return undefined;
  }
  const cleaned = url.trim();
  const infoMatch = IIIF_INFO_RE.exec(cleaned);
  if (infoMatch) {
    return `${infoMatch[1]}/full/full/0/default.jpg`;
  }
  const jp2Match = IIIF_JP2_RE.exec(cleaned);
  if (jp2Match) {
    return `${jp2Match[1]}.jpg`;
  }
  return undefined;
}

function appendUniqueUrl(items: string[], candidate: string | undefined): void {
  if (!candidate) {
    return;
  }
  const cleaned = candidate.trim();
  if (cleaned && !items.includes(cleaned)) {
    items.push(cleaned);
  }
}

class ScanImage {
  readonly index: number;
  readonly order: number | null;
  readonly label: string;
  readonly uri: string;
  readonly uriPreview: string;

  constructor(
    index: number,
    order: number | null,
    label: string,
    uri: string,
    uriPreview: string
  ) {
    this.index = index;
    this.order = order;
    this.label = label;
    this.uri = uri;
    this.uriPreview = uriPreview;
  }

  chosenUrl(preview: boolean): string {
    if (preview) {
      return this.uriPreview || this.uri;
    }
    return this.uri || this.uriPreview;
  }

  candidateUrls(preview: boolean): readonly (readonly [string, boolean])[] {
    if (preview) {
      const urls: string[] = [];
      appendUniqueUrl(urls, this.uriPreview);
      appendUniqueUrl(urls, this.uri);
      return urls.map((u) => [u, false] as const);
    }

    const proxyFull =
      deriveProxyDownloadUrl(this.uriPreview) ?? deriveProxyDownloadUrl(this.uri);
    const iiifJpg = deriveIiifJpegUrl(this.uri);
    const candidates: (readonly [string, boolean])[] = [];
    const seen = new Set<string>();

    const add = (url: string | undefined, fallbackOn5xx: boolean): void => {
      if (!url) {
        return;
      }
      const cleaned = url.trim();
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        candidates.push([cleaned, fallbackOn5xx] as const);
      }
    };

    if (this.uri && isViewerUrl(this.uri) && (proxyFull || this.uriPreview)) {
      add(proxyFull, true);
      add(this.uriPreview, false);
      return candidates;
    }

    add(iiifJpg, true);
    add(this.uri, false);
    add(proxyFull, true);
    add(this.uriPreview, false);
    return candidates;
  }
}

function a2aText(node: unknown): string {
  if (node === null || node === undefined) {
    return '';
  }
  if (typeof node === 'string') {
    return node.trim();
  }
  if (typeof node === 'number') {
    return String(node);
  }
  if (isPlainRecord(node)) {
    for (const [key, val] of Object.entries(node)) {
      if (typeof val === 'string' || typeof val === 'number') {
        return String(val).trim();
      }
      if (isPlainRecord(val) && key in val) {
        return a2aText(val[key]);
      }
    }
    for (const val of Object.values(node)) {
      const found = a2aText(val);
      if (found) {
        return found;
      }
    }
  }
  return '';
}

function scanValue(scan: Record<string, unknown>, names: readonly string[]): string {
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(scan)) {
    lowered.set(key.toLowerCase(), value);
  }
  for (const name of names) {
    if (name in scan) {
      const text = a2aText(scan[name]);
      if (text) {
        return text;
      }
    }
    const text = a2aText(lowered.get(name.toLowerCase()));
    if (text) {
      return text;
    }
  }
  return '';
}

function scanOrder(scan: Record<string, unknown>): number | null {
  const raw = scanValue(scan, ['a2a_OrderSequenceNumber', 'a2a_Order', 'order', 'Order']);
  if (!raw || !/^[+-]?\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function asShowRecords(data: unknown): Record<string, unknown>[] {
  if (isPlainRecord(data)) {
    return [data];
  }
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => isPlainRecord(item));
  }
  return [];
}

function extractScans(record: Record<string, unknown>): ScanImage[] {
  const source = record.a2a_Source;
  if (!isPlainRecord(source)) {
    return [];
  }
  const block = source.a2a_SourceAvailableScans;
  let rawScans: unknown[];
  if (isPlainRecord(block)) {
    const raw = block.a2a_Scan;
    if (raw === undefined || raw === null) {
      rawScans = scanValue(block, ['a2a_Uri', 'uri', 'Uri']) ? [block] : [];
    } else {
      rawScans = asList(raw);
    }
  } else if (Array.isArray(block)) {
    rawScans = block;
  } else {
    return [];
  }

  const found: Array<{
    readonly pos: number;
    readonly order: number | null;
    readonly label: string;
    readonly uri: string;
    readonly preview: string;
  }> = [];

  for (const scan of rawScans) {
    if (!isPlainRecord(scan)) {
      continue;
    }
    const uri = scanValue(scan, ['a2a_Uri', 'uri', 'Uri']);
    const preview = scanValue(scan, ['a2a_UriPreview', 'uri_preview', 'UriPreview']);
    if (!uri && !preview) {
      continue;
    }
    const label = scanValue(scan, [
      'a2a_Label',
      'a2a_Caption',
      'a2a_Title',
      'a2a_Description',
      'label',
      'caption',
      'title',
    ]);
    found.push({
      pos: found.length,
      order: scanOrder(scan),
      label,
      uri,
      preview,
    });
  }

  found.sort((a, b) => {
    const aMissing = a.order === null ? 1 : 0;
    const bMissing = b.order === null ? 1 : 0;
    if (aMissing !== bMissing) {
      return aMissing - bMissing;
    }
    const aOrder = a.order ?? 0;
    const bOrder = b.order ?? 0;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return a.pos - b.pos;
  });

  return found.map(
    (item, idx) => new ScanImage(idx + 1, item.order, item.label, item.uri, item.preview)
  );
}

function extractScansFromShow(data: unknown): ScanImage[] {
  const scans: ScanImage[] = [];
  for (const record of asShowRecords(data)) {
    scans.push(...extractScans(record));
  }
  return scans.map(
    (scan, idx) =>
      new ScanImage(idx + 1, scan.order, scan.label, scan.uri, scan.uriPreview)
  );
}

function startsWithBytes(buf: Buffer, bytes: readonly number[]): boolean {
  if (buf.length < bytes.length) {
    return false;
  }
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[i] !== bytes[i]) {
      return false;
    }
  }
  return true;
}

function magicExtension(content: Buffer): string | undefined {
  if (startsWithBytes(content, [0xff, 0xd8, 0xff])) {
    return 'jpg';
  }
  if (startsWithBytes(content, [0x89, 0x50, 0x4e, 0x47])) {
    return 'png';
  }
  if (
    content.subarray(0, 6).equals(Buffer.from('GIF87a')) ||
    content.subarray(0, 6).equals(Buffer.from('GIF89a'))
  ) {
    return 'gif';
  }
  if (content.subarray(0, 4).equals(Buffer.from('%PDF'))) {
    return 'pdf';
  }
  if (
    content.length >= 12 &&
    content.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    content.subarray(8, 12).equals(Buffer.from('WEBP'))
  ) {
    return 'webp';
  }
  if (
    startsWithBytes(content, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWithBytes(content, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return 'tif';
  }
  if (
    startsWithBytes(content, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50]) ||
    startsWithBytes(content, [0xff, 0x4f, 0xff, 0x51])
  ) {
    return 'jp2';
  }
  return undefined;
}

function looksLikeMarkup(content: Buffer): boolean {
  const head = content.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  return (
    head.startsWith('<html') ||
    head.startsWith('<!doctype') ||
    head.startsWith('<head') ||
    head.startsWith('<body') ||
    head.startsWith('<?xml') ||
    head.startsWith('<')
  );
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

function readCachedScan(
  binPath: string,
  metaPath: string,
  ttlHours: number,
  nowMs: () => number
): { readonly body: Buffer; readonly ext: string } | undefined {
  if (ttlHours <= 0) {
    return undefined;
  }
  try {
    if (!fs.statSync(binPath).isFile()) {
      return undefined;
    }
    const raw: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!isPlainRecord(raw) || raw.schema !== CACHE_SCHEMA) {
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
    const data = fs.readFileSync(binPath);
    if (data.length !== nbytes) {
      return undefined;
    }
    const ext = classifyScanPayload(data, 'application/octet-stream');
    return { body: data, ext };
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

async function cachedScanBytesChecked(
  ctx: RecordCommandContext,
  cacheDir: string,
  url: string,
  options: { readonly refresh: boolean; readonly ttlHours: number }
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
      atomicWriteFileSync(
        metaPath,
        JSON.stringify({
          schema: CACHE_SCHEMA,
          fetched_at: ctx.nowMs() / 1000,
          nbytes: body.length,
          ext,
        })
      );
      return { body, ext, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

async function downloadScanCandidates(
  ctx: RecordCommandContext,
  cacheDir: string,
  candidates: readonly (readonly [string, boolean])[],
  options: { readonly refresh: boolean; readonly ttlHours: number }
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
      const { body, ext, cacheHit } = await cachedScanBytesChecked(
        ctx,
        cacheDir,
        candidateUrl,
        options
      );
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

async function loadShow(
  ctx: RecordCommandContext,
  cacheDir: string,
  code: string,
  ident: string,
  lang: string,
  options: { readonly refresh: boolean; readonly ttlHours: number }
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

function scanFilename(archive: string, identifier: string, index: number, ext: string): string {
  const short = identifier.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'record';
  const safeArchive = archive.replace(/[^A-Za-z0-9_-]/g, '').toLowerCase() || 'archive';
  const safeExt = ext.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'img';
  return `${safeArchive}-${short}-scan-${String(index).padStart(2, '0')}.${safeExt}`;
}

function isSourceType(value: string): boolean {
  const low = value.trim().toLowerCase();
  return low.startsWith('bs ') || low.startsWith('dtb ') || KNOWN_SOURCE_TYPES.has(low);
}

function padInt(value: number, width: number): string {
  return String(Math.trunc(value)).padStart(width, '0');
}

function fmtEventdate(dateObj: unknown): string {
  if (!isPlainRecord(dateObj)) {
    return '';
  }
  const year = dateObj.year;
  const month = dateObj.month;
  const day = dateObj.day;
  if (year === undefined || year === null) {
    return '';
  }
  const y = Number(year);
  if (!Number.isFinite(y)) {
    return '';
  }
  const m = month !== undefined && month !== null && month !== '' ? Number(month) : 0;
  const d = day !== undefined && day !== null && day !== '' ? Number(day) : 0;
  if (Number.isFinite(m) && m > 0 && Number.isFinite(d) && d > 0) {
    return `${padInt(y, 4)}-${padInt(m, 2)}-${padInt(d, 2)}`;
  }
  if (Number.isFinite(m) && m > 0) {
    return `${padInt(y, 4)}-${padInt(m, 2)}`;
  }
  return padInt(y, 4);
}

function fmtA2aDate(dateNode: unknown): string {
  if (!isPlainRecord(dateNode)) {
    return a2aText(dateNode);
  }
  const year = a2aText(dateNode.a2a_Year);
  const month = a2aText(dateNode.a2a_Month);
  const day = a2aText(dateNode.a2a_Day);
  if (year && month && day && /^\d+$/.test(year) && /^\d+$/.test(month) && /^\d+$/.test(day)) {
    return `${padInt(Number.parseInt(year, 10), 4)}-${padInt(Number.parseInt(month, 10), 2)}-${padInt(Number.parseInt(day, 10), 2)}`;
  }
  if (year && month && /^\d+$/.test(year) && /^\d+$/.test(month)) {
    return `${padInt(Number.parseInt(year, 10), 4)}-${padInt(Number.parseInt(month, 10), 2)}`;
  }
  if (year) {
    return year;
  }
  return a2aText(dateNode.a2a_LiteralDate);
}

function fmtA2aPersonName(nameNode: unknown): string {
  if (!isPlainRecord(nameNode)) {
    return a2aText(nameNode);
  }
  const parts = [
    a2aText(nameNode.a2a_PersonNameFirstName),
    a2aText(nameNode.a2a_PersonNamePatronym),
    a2aText(nameNode.a2a_PersonNamePrefixLastName),
    a2aText(nameNode.a2a_PersonNameLastName),
  ];
  return parts.filter(Boolean).join(' ');
}

function validateRecordRef(code: string, ident: string): readonly [string, string] {
  const cleanedCode = code.trim();
  const cleanedIdent = ident.trim();
  if (!ARCHIVE_CODE_RE.test(cleanedCode) || !RECORD_ID_RE.test(cleanedIdent)) {
    throw new CliValidationError(
      `Invalid archive or record identifier ('${cleanedCode}', '${cleanedIdent}').`
    );
  }
  return [cleanedCode, cleanedIdent];
}

function parseRecordRef(
  archive: string,
  identifier: string | undefined
): readonly [string, string] {
  if (identifier) {
    return validateRecordRef(archive, identifier);
  }
  const match = OPENARCH_URL_RE.exec(archive);
  if (match) {
    return validateRecordRef(match[1], match[2]);
  }
  const colonIdx = archive.indexOf(':');
  if (colonIdx !== -1) {
    const code = archive.slice(0, colonIdx);
    const rest = archive.slice(colonIdx + 1);
    const ident = (rest.split('/', 1)[0] ?? '').split('?', 1)[0] ?? '';
    if (code.trim() && ident.trim()) {
      return validateRecordRef(code, ident);
    }
  }
  throw new CliValidationError(
    "Pass ARCHIVE and IDENTIFIER, an 'archive:uuid' token, or an openarchieven.nl record URL."
  );
}

function isDirectScanUrl(value: string): boolean {
  const cleaned = value.trim();
  const lower = cleaned.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return false;
  }
  return !OPENARCH_URL_RE.test(cleaned);
}

function isCompleteRecordRef(value: string): boolean {
  const cleaned = value.trim();
  if (isDirectScanUrl(cleaned)) {
    return true;
  }
  if (OPENARCH_URL_RE.test(cleaned)) {
    return true;
  }
  return cleaned.includes(':');
}

function formatA2aRecord(
  archive: string,
  identifier: string,
  record: Record<string, unknown>
): string {
  const lines: string[] = [
    `Record: ${archive}:${identifier}`,
    `  URL: ${WEB_BASE}/${archive}:${identifier}`,
  ];
  const source = isPlainRecord(record.a2a_Source) ? record.a2a_Source : {};
  const sourceType = a2aText(source.a2a_SourceType);
  const sourcePlaceNode = isPlainRecord(source.a2a_SourcePlace) ? source.a2a_SourcePlace : {};
  const sourcePlace = a2aText(sourcePlaceNode.a2a_Place);
  const ref = isPlainRecord(source.a2a_SourceReference) ? source.a2a_SourceReference : {};
  const inst = a2aText(ref.a2a_InstitutionName);
  const book = a2aText(ref.a2a_Book);
  const collection = a2aText(ref.a2a_Collection);
  const docNum = a2aText(ref.a2a_DocumentNumber);
  const archiveNum = a2aText(ref.a2a_Archive);
  const regNum = a2aText(ref.a2a_RegistryNumber);

  if (sourceType) {
    lines.push(`  Source type: ${sourceType}`);
  }
  if (inst) {
    lines.push(`  Institution: ${inst}`);
  }
  if (sourcePlace) {
    lines.push(`  Source place: ${sourcePlace}`);
  }
  const refParts = [
    archiveNum ? `Archive ${archiveNum}` : '',
    regNum ? `Registry ${regNum}` : '',
    book,
    collection,
    docNum ? `Document ${docNum}` : '',
  ].filter(Boolean);
  if (refParts.length > 0) {
    lines.push(`  Reference: ${refParts.join(' | ')}`);
  }

  for (const ev of asList(record.a2a_Event)) {
    if (!isPlainRecord(ev)) {
      continue;
    }
    const evType = a2aText(ev.a2a_EventType);
    const evDate = fmtA2aDate(ev.a2a_EventDate);
    const evPlaceNode = isPlainRecord(ev.a2a_EventPlace) ? ev.a2a_EventPlace : {};
    const evPlace = a2aText(evPlaceNode.a2a_Place);
    const summary = [evType, evDate, evPlace].filter(Boolean).join(' | ');
    if (summary) {
      lines.push(`  Event: ${summary}`);
    }
  }

  const rolesByPid = new Map<string, string[]>();
  for (const rel of asList(record.a2a_RelationEP)) {
    if (!isPlainRecord(rel)) {
      continue;
    }
    const pid = a2aText(rel.a2a_PersonKeyRef);
    const role = a2aText(rel.a2a_RelationType);
    if (pid && role) {
      const existing = rolesByPid.get(pid);
      if (existing) {
        existing.push(role);
      } else {
        rolesByPid.set(pid, [role]);
      }
    }
  }

  const persons = asList(record.a2a_Person);
  if (persons.length > 0) {
    lines.push('  Persons:');
    for (const person of persons) {
      if (!isPlainRecord(person)) {
        continue;
      }
      const pid = person.pid !== undefined && person.pid !== null ? String(person.pid) : '';
      const name = fmtA2aPersonName(person.a2a_PersonName) || '(unnamed)';
      const roleStr = (rolesByPid.get(pid) ?? []).join(', ');
      const bdate = fmtA2aDate(person.a2a_BirthDate);
      const bplaceNode = isPlainRecord(person.a2a_BirthPlace) ? person.a2a_BirthPlace : {};
      const bplace = a2aText(bplaceNode.a2a_Place);
      const resNode = isPlainRecord(person.a2a_Residence) ? person.a2a_Residence : {};
      const res = a2aText(resNode.a2a_Place);
      const occ = a2aText(person.a2a_Profession);
      const details: string[] = [];
      if (roleStr) {
        details.push(roleStr);
      }
      if (bdate || bplace) {
        details.push(`b. ${[bdate, bplace].filter(Boolean).join(', ')}`);
      }
      if (res) {
        details.push(`res. ${res}`);
      }
      if (occ) {
        details.push(`occ. ${occ}`);
      }
      const suffix = details.length > 0 ? ` (${details.join('; ')})` : '';
      lines.push(`    - ${name}${suffix}`);
    }
  }

  const scans = extractScans(record);
  if (scans.length > 0) {
    lines.push('  Scans:');
    for (const scan of scans.slice(0, 5)) {
      lines.push(`    - ${scan.chosenUrl(false)}`);
    }
    if (scans.length > 5) {
      lines.push(`    - (+${scans.length - 5} more)`);
    }
  }

  const orig = a2aText(source.a2a_SourceDigitalOriginal);
  if (orig) {
    lines.push(`  Original: ${orig}`);
  }

  return lines.join('\n');
}

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_OPENARCHIEVEN_CACHE_TTL_HOURS; 0 disables reads).',
  },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'nameOpt',
    kind: 'string',
    flags: ['--name', '--query', '-q'],
    metavar: 'NAME',
    help: "Person name query (may include '&' for two names).",
  },
  {
    key: 'firstName',
    kind: 'string',
    flags: ['--first', '--first-name', '--given', '--given-name'],
    metavar: 'FIRST',
    help: 'Given name (combined with --last/--surname).',
  },
  {
    key: 'lastName',
    kind: 'string',
    flags: ['--last', '--last-name', '--surname'],
    metavar: 'LAST',
    help: 'Surname (combined with --first/--given).',
  },
  {
    key: 'place',
    kind: 'string',
    flags: ['--place'],
    metavar: 'PLACE',
    help: 'Filter by event place (eventplace), e.g. Zundert or Rotterdam.',
  },
  {
    key: 'birthPlace',
    kind: 'string',
    flags: ['--birth-place'],
    metavar: 'PLACE',
    help: 'Filter by person birth place (birthplace).',
  },
  {
    key: 'eventType',
    kind: 'string',
    flags: ['--event-type'],
    metavar: 'TYPE',
    help: "Event type (e.g. Geboorte, Huwelijk, Overlijden) or source type (e.g. 'BS Geboorte', Bevolkingsregister).",
  },
  {
    key: 'sourceType',
    kind: 'string',
    flags: ['--source-type'],
    metavar: 'TYPE',
    help: "Explicit OpenArchieven source type (e.g. 'BS Geboorte', Bevolkingsregister, Passagiersregisters).",
  },
  {
    key: 'year',
    kind: 'string',
    flags: ['--year'],
    metavar: 'YEAR',
    help: 'Year or year range (e.g. 1853 or 1850-1860), appended to the name query.',
  },
  {
    key: 'archive',
    kind: 'string',
    flags: ['--archive'],
    metavar: 'CODE',
    help: 'Archive code filter, e.g. bhi, wba, srt, saa, zal.',
  },
  {
    key: 'relation',
    kind: 'string',
    flags: ['--relation'],
    metavar: 'ROLE',
    help: 'Relation/role filter, e.g. Kind, Vader, Bruid, Geregistreerde.',
  },
  {
    key: 'country',
    kind: 'string',
    flags: ['--country'],
    metavar: 'CODE',
    help: 'Country code filter, e.g. nl, be, fr.',
  },
  {
    key: 'lang',
    kind: 'string',
    flags: ['--lang'],
    choices: VALID_LANGS,
    default: 'nl',
    metavar: 'LANG',
    help: 'Language for returned archive and type labels (default: nl).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '-n', '--rows'],
    default: 10,
    metavar: 'N',
    help: 'Results to return (default: 10, max 100).',
  },
  {
    key: 'start',
    kind: 'integer',
    flags: ['--start', '--offset'],
    default: 0,
    metavar: 'N',
    help: 'Offset for paging (default: 0, max 10000).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    min: 1,
    metavar: 'PAGE',
    help: '1-based page. Sets start to (page - 1) times the limit sent to the API. Do not combine with --start.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit raw API JSON output.',
  },
  ...CACHE_OPTIONS,
];

const SEARCH_PARSE_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

const SHOW_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'lang',
    kind: 'string',
    flags: ['--lang'],
    choices: VALID_LANGS,
    default: 'nl',
    metavar: 'LANG',
    help: 'Language for returned labels (default: nl).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit raw A2A JSON output.',
  },
  ...CACHE_OPTIONS,
];

const SHOW_PARSE_SPEC: CommandParseSpec = {
  options: SHOW_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'archive/identifier',
};

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'scanIndex',
    kind: 'integer',
    flags: ['--scan-index'],
    min: 1,
    default: 1,
    metavar: 'N',
    help: '1-based scan to download. Ignored with --all and with --list (default: 1).',
  },
  {
    key: 'downloadAll',
    kind: 'boolean',
    flags: ['--all'],
    help: 'Download every scan into --out-dir.',
  },
  {
    key: 'listOnly',
    kind: 'boolean',
    flags: ['--list'],
    help: 'Print scan index, label, and URL. Do not download.',
  },
  {
    key: 'preview',
    kind: 'boolean',
    flags: ['--preview'],
    help: 'Use uri_preview instead of the full-resolution scan uri.',
  },
  {
    key: 'dest',
    kind: 'string',
    flags: ['--out', '--output', '-o', '--out-dir', '--output-dir'],
    metavar: 'PATH',
    help: 'Output file for one scan, or the output directory when --all is set.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON with cache_hit and files or scans.',
  },
  {
    key: 'lang',
    kind: 'string',
    flags: ['--lang'],
    choices: VALID_LANGS,
    default: 'nl',
    metavar: 'LANG',
    help: 'Language passed to the cached show lookup (default: nl).',
  },
  ...CACHE_OPTIONS,
];

const DOWNLOAD_PARSE_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'archive/identifier or scan URL',
};

const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'name',
    kind: 'string',
    flags: ['--name'],
    metavar: 'NAME',
    help: 'Person name query.',
  },
  {
    key: 'place',
    kind: 'string',
    flags: ['--place'],
    metavar: 'PLACE',
    help: 'Event place.',
  },
  {
    key: 'year',
    kind: 'string',
    flags: ['--year'],
    metavar: 'YEAR',
    help: 'Year or year range (e.g. 1853 or 1850-1860).',
  },
  {
    key: 'record',
    kind: 'string',
    flags: ['--record'],
    metavar: 'TOKEN',
    help: "Record token 'archive:uuid' to build a direct record URL.",
  },
];

const URL_PARSE_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: false,
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven <command> [options]',
    summary: 'Search and inspect Dutch and Belgian archive records on OpenArchieven.',
    subcommands: [
      { name: 'search', summary: 'Search OpenArchieven records.' },
      {
        name: 'show',
        summary: 'Fetch full A2A details for one record (alias: get).',
      },
      {
        name: 'download',
        summary: 'Download scan images for one OpenArchieven record or a direct scan URL.',
      },
      { name: 'url', summary: 'Print a shareable OpenArchieven website URL offline.' },
    ],
  });
}

function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven search [NAME] [options]',
    summary: 'Search OpenArchieven records.',
    options: SEARCH_OPTIONS,
    notes: [
      'Example:',
      '  kinloom openarchieven search --name "Vincent van Gogh" --place Zundert --year 1853',
    ],
  });
}

function renderShowHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven show <ARCHIVE|ARCHIVE:UUID|URL> [IDENTIFIER] [options]',
    summary:
      'Fetch full A2A details for one record by ARCHIVE IDENTIFIER, archive:uuid, or URL.',
    options: SHOW_OPTIONS,
  });
}

function renderDownloadHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven download <ARCHIVE|ARCHIVE:UUID|URL> [IDENTIFIER|OUT] [options]',
    summary: 'Download scan images for one OpenArchieven record or a direct scan URL.',
    options: DOWNLOAD_OPTIONS,
  });
}

function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven url [options]',
    summary: 'Print a shareable OpenArchieven website URL offline.',
    options: URL_OPTIONS,
  });
}

async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }

  const nameArg = parsed.positionals[0];
  const nameOpt = getStringOption(parsed, 'nameOpt');
  const firstName = getStringOption(parsed, 'firstName');
  const lastName = getStringOption(parsed, 'lastName');
  const place = getStringOption(parsed, 'place');
  const birthPlace = getStringOption(parsed, 'birthPlace');
  const eventType = getStringOption(parsed, 'eventType');
  const sourceType = getStringOption(parsed, 'sourceType');
  const year = getStringOption(parsed, 'year');
  const archive = getStringOption(parsed, 'archive');
  const relation = getStringOption(parsed, 'relation');
  const country = getStringOption(parsed, 'country');
  const lang = getStringOption(parsed, 'lang') ?? 'nl';
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const start = getNumberOption(parsed, 'start') ?? 0;
  const page = getNumberOption(parsed, 'page');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');

  const combinedParts = [firstName, lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(' ');
  let rawName = (nameOpt || nameArg || combinedParts).trim();
  if (!rawName) {
    throw new CliValidationError(
      'Provide a name via --name, --first/--last, or a positional argument.'
    );
  }
  if (year) {
    rawName = `${rawName} ${year.trim()}`;
  }

  const startFromUser = parsed.provided.has('start');
  const [numberShow, effectiveStart] = searchWindow(limit, start, page, startFromUser);

  const params: Record<string, string | number> = {
    name: rawName,
    number_show: numberShow,
    start: effectiveStart,
    lang,
  };
  if (place) {
    params.eventplace = place;
  }
  if (birthPlace) {
    params.birthplace = birthPlace;
  }
  if (sourceType) {
    params.sourcetype = sourceType;
  }
  if (eventType) {
    if (isSourceType(eventType) && !('sourcetype' in params)) {
      params.sourcetype = eventType;
    } else {
      params.eventtype = eventType;
    }
  }
  if (archive) {
    params.archive = archive;
  }
  if (relation) {
    params.relationtype = relation;
  }
  if (country) {
    params.country_code = country;
  }

  const ttlHours = resolveTtlHours(cliTtl, ctx);
  const cacheDir = getCacheDir(ctx);

  const { value: data, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
    cacheDir,
    kind: 'search',
    payload: params,
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: async () => {
      const fetched = await getJson(ctx, 'search.json', params);
      if (!isPlainRecord(fetched)) {
        throw new RecordRuntimeError(
          `Unexpected non-object search response from ${API_BASE}/search.json`
        );
      }
      return fetched;
    },
    cacheable: isSearchCacheable,
    validateCached: isPlainRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...data, cache_hit: Boolean(cacheHit) });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const resp = isPlainRecord(data.response) ? data.response : {};
  const total = typeof resp.number_found === 'number' ? resp.number_found : 0;
  const docs = Array.isArray(resp.docs) ? resp.docs : [];
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `Found ${total} records (showing ${docs.length} from offset ${effectiveStart})${marker}`,
  ];
  for (const rawDoc of docs) {
    if (!isPlainRecord(rawDoc)) {
      continue;
    }
    const code = typeof rawDoc.archive_code === 'string' ? rawDoc.archive_code : '';
    const ident = typeof rawDoc.identifier === 'string' ? rawDoc.identifier : '';
    const person =
      typeof rawDoc.personname === 'string' && rawDoc.personname
        ? rawDoc.personname
        : '(unnamed)';
    const role = typeof rawDoc.relationtype === 'string' ? rawDoc.relationtype : '';
    const stype =
      (typeof rawDoc.sourcetype === 'string' && rawDoc.sourcetype) ||
      (typeof rawDoc.eventtype === 'string' && rawDoc.eventtype) ||
      '';
    const dateStr = fmtEventdate(rawDoc.eventdate);
    const places = rawDoc.eventplace;
    const placeStr = Array.isArray(places)
      ? places.map((p) => String(p)).join(', ')
      : places !== undefined && places !== null
        ? String(places)
        : '';
    const url =
      typeof rawDoc.url === 'string' && rawDoc.url ? rawDoc.url : `${WEB_BASE}/${code}:${ident}`;
    lines.push(`- ${code}:${ident} | ${person} (${role}) | ${stype} | ${dateStr} | ${placeStr}`);
    lines.push(`  ${url}`);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runShow(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SHOW_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderShowHelp()) };
  }

  const archive = parsed.positionals[0];
  const identifier = parsed.positionals[1];
  const lang = getStringOption(parsed, 'lang') ?? 'nl';
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');

  const [code, ident] = parseRecordRef(archive, identifier);
  const ttlHours = resolveTtlHours(cliTtl, ctx);
  const cacheDir = getCacheDir(ctx);

  const { data, cacheHit } = await loadShow(ctx, cacheDir, code, ident, lang, {
    refresh,
    ttlHours,
  });

  if (asJson) {
    const payload = isPlainRecord(data)
      ? { ...data, cache_hit: Boolean(cacheHit) }
      : { records: data, cache_hit: Boolean(cacheHit) };
    const bytesOut = emitJsonStdout(ctx.io, payload);
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const records = Array.isArray(data) ? data : data !== undefined && data !== null ? [data] : [];
  if (records.length === 0) {
    const bytesOut = emitStdout(ctx.io, 'No record data returned.');
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const blocks: string[] = [];
  for (let idx = 0; idx < records.length; idx += 1) {
    const rec = records[idx];
    if (!isPlainRecord(rec)) {
      continue;
    }
    let formatted = formatA2aRecord(code, ident, rec);
    if (idx === 0 && cacheHit) {
      const nlIdx = formatted.indexOf('\n');
      formatted =
        nlIdx === -1
          ? `${formatted} [cache]`
          : `${formatted.slice(0, nlIdx)} [cache]${formatted.slice(nlIdx)}`;
    }
    blocks.push(formatted);
  }

  const bytesOut = emitStdout(ctx.io, blocks.join('\n\n'));
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

  const archive = parsed.positionals[0];
  let identifier: string | undefined = parsed.positionals[1];
  const scanIndex = getNumberOption(parsed, 'scanIndex') ?? 1;
  const downloadAll = getBooleanOption(parsed, 'downloadAll');
  const listOnly = getBooleanOption(parsed, 'listOnly');
  const preview = getBooleanOption(parsed, 'preview');
  let dest = getStringOption(parsed, 'dest');
  const asJson = getBooleanOption(parsed, 'asJson');
  const lang = getStringOption(parsed, 'lang') ?? 'nl';
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');

  if (identifier && !dest && isCompleteRecordRef(archive)) {
    dest = identifier;
    identifier = undefined;
  }

  const ttlHours = resolveTtlHours(cliTtl, ctx);
  const cacheDir = getCacheDir(ctx);

  if (!identifier && isDirectScanUrl(archive)) {
    const directUrl = validateScanUrl(archive.trim());
    if (listOnly) {
      const rows = [{ index: 1, order: 1, label: '', url: directUrl }];
      if (asJson) {
        const bytesOut = emitJsonStdout(ctx.io, {
          url: directUrl,
          scans: rows,
          cache_hit: false,
        });
        return { exitCode: 0, bytesOut, cacheHit: false };
      }
      const bytesOut = emitStdout(ctx.io, `1. order=1\n   ${directUrl}`);
      return { exitCode: 0, bytesOut, cacheHit: false };
    }

    if (!dest) {
      throw new CliValidationError(
        'Pass --out FILE (or a positional output path) to download a direct scan URL.'
      );
    }

    const destPath = resolveDestPath(dest, ctx);
    if (!isExistingDir(destPath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
    }

    const candidates: (readonly [string, boolean])[] = [];
    const iiifJpg = deriveIiifJpegUrl(directUrl);
    if (iiifJpg) {
      candidates.push([iiifJpg, true]);
    }
    const proxyFull = deriveProxyDownloadUrl(directUrl);
    if (proxyFull && !preview) {
      candidates.push([proxyFull, true]);
    }
    candidates.push([directUrl, false]);

    const { body, ext, resolvedUrl, cacheHit: fileHit } = await downloadScanCandidates(
      ctx,
      cacheDir,
      candidates,
      { refresh, ttlHours }
    );

    const outFile = isExistingDir(destPath)
      ? path.join(destPath, `scan-${sha256Hex(resolvedUrl).slice(0, 8)}.${ext}`)
      : destPath;
    atomicWriteFileSync(outFile, body);

    const item = {
      index: 1,
      order: 1,
      label: '',
      url: resolvedUrl,
      path: outFile,
      bytes: body.length,
      cache_hit: fileHit,
    };
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, {
        url: resolvedUrl,
        files: [item],
        cache_hit: Boolean(fileHit),
      });
      return { exitCode: 0, bytesOut, cacheHit: fileHit };
    }
    const marker = fileHit ? ' [cache]' : '';
    const bytesOut = emitStdout(ctx.io, `scan 1: ${item.path} (${item.bytes} bytes)${marker}`);
    return { exitCode: 0, bytesOut, cacheHit: fileHit };
  }

  const [code, ident] = parseRecordRef(archive, identifier);
  const { data, cacheHit: showHit } = await loadShow(ctx, cacheDir, code, ident, lang, {
    refresh,
    ttlHours,
  });
  const scans = extractScansFromShow(data);

  if (listOnly) {
    const rows = scans.map((scan) => ({
      index: scan.index,
      order: scan.order,
      label: scan.label,
      url: scan.chosenUrl(preview),
    }));
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, {
        archive: code,
        identifier: ident,
        scans: rows,
        cache_hit: Boolean(showHit),
      });
      return { exitCode: 0, bytesOut, cacheHit: showHit };
    }
    const marker = showHit ? ' [cache]' : '';
    const lines: string[] = [`Scans for ${code}:${ident} (${rows.length})${marker}`];
    if (rows.length === 0) {
      lines.push('No scans.');
    } else {
      for (const row of rows) {
        const orderStr = row.order === null ? '-' : String(row.order);
        const labelStr = row.label ? ` ${row.label}` : '';
        lines.push(`${row.index}. order=${orderStr}${labelStr}`);
        lines.push(`   ${row.url}`);
      }
    }
    const bytesOut = emitStdout(ctx.io, lines.join('\n'));
    return { exitCode: 0, bytesOut, cacheHit: showHit };
  }

  if (scans.length === 0) {
    throw new RecordRuntimeError(
      `No scans are available for ${code}:${ident}. The record has no a2a_SourceAvailableScans image URL.`
    );
  }
  if (!dest) {
    if (downloadAll) {
      throw new CliValidationError('Pass --out-dir DIR (or --out DIR) when using --all.');
    }
    throw new CliValidationError(
      'Pass --out FILE for one scan, or --all --out-dir DIR for every scan.'
    );
  }

  let selected: readonly ScanImage[] = scans;
  if (!downloadAll) {
    const match = scans.find((scan) => scan.index === scanIndex);
    if (!match) {
      throw new RecordRuntimeError(
        `Scan index ${scanIndex} is outside 1-${scans.length} for ${code}:${ident}.`
      );
    }
    selected = [match];
  }

  const destPath = resolveDestPath(dest, ctx);
  if (downloadAll) {
    if (pathExists(destPath) && !isExistingDir(destPath)) {
      throw new RecordRuntimeError(`--out-dir must be a directory. ${destPath} is a file.`);
    }
    fs.mkdirSync(destPath, { recursive: true });
  } else if (!isExistingDir(destPath)) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
  }

  const files: Array<{
    readonly index: number;
    readonly order: number | null;
    readonly label: string;
    readonly url: string;
    readonly path: string;
    readonly bytes: number;
    readonly cache_hit: boolean;
  }> = [];
  const fileHits: boolean[] = [];

  for (const scan of selected) {
    const candidates = scan.candidateUrls(preview);
    const { body, ext, resolvedUrl, cacheHit: fileHit } = await downloadScanCandidates(
      ctx,
      cacheDir,
      candidates,
      { refresh, ttlHours }
    );
    const filename = scanFilename(code, ident, scan.index, ext);
    const outFile =
      downloadAll || isExistingDir(destPath) ? path.join(destPath, filename) : destPath;
    atomicWriteFileSync(outFile, body);
    fileHits.push(fileHit);
    files.push({
      index: scan.index,
      order: scan.order,
      label: scan.label,
      url: resolvedUrl,
      path: outFile,
      bytes: body.length,
      cache_hit: fileHit,
    });
  }

  const overallHit = Boolean(showHit && fileHits.every(Boolean));
  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      archive: code,
      identifier: ident,
      files,
      cache_hit: overallHit,
    });
    return { exitCode: 0, bytesOut, cacheHit: overallHit };
  }

  const lines = files.map((item) => {
    const marker = item.cache_hit ? ' [cache]' : '';
    return `scan ${item.index}: ${item.path} (${item.bytes} bytes)${marker}`;
  });
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: overallHit };
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const name = getStringOption(parsed, 'name');
  const place = getStringOption(parsed, 'place');
  const year = getStringOption(parsed, 'year');
  const record = getStringOption(parsed, 'record');

  if (record) {
    const [code, ident] = parseRecordRef(record, undefined);
    const bytesOut = emitStdout(ctx.io, `${WEB_BASE}/${code}:${ident}`);
    return { exitCode: 0, bytesOut };
  }
  if (!name) {
    throw new CliValidationError('Pass --name or --record.');
  }
  const q = year ? `${name.trim()} ${year.trim()}` : name.trim();
  const params = new URLSearchParams([['name', q]]);
  if (place) {
    params.append('eventplace', place.trim());
  }
  const bytesOut = emitStdout(ctx.io, `${WEB_BASE}/search.php?${params.toString()}`);
  return { exitCode: 0, bytesOut };
}

function isBrokenPipeError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'EPIPE'
  );
}

export const runOpenarchievenCommand: RecordHandler = async (
  args,
  ctx
): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [rawSubcmd, ...rest] = args;
    const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);
    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'show':
        return await runShow(rest, ctx);
      case 'download':
        return await runDownload(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(
          `No such command '${rawSubcmd}'. Run 'kinloom openarchieven --help'.`
        );
    }
  } catch (err: unknown) {
    if (isBrokenPipeError(err)) {
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
