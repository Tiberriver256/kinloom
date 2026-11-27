import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  type CommandParseSpec,
  cachedJsonCall,
  collapseWhitespace,
  emitJsonStdout,
  emitStdout,
  expandHomePath,
  fetchWithCurl,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  loadHtml,
  type OptionSpec,
  parseCacheTtlHours,
  parseCommandArgs,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  resolveCacheDir,
  resolveSubcommandAlias,
  SsrfBlockedError,
  withAdvisoryLock,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const CACHE_SCHEMA = 1;
const BASE = 'https://michigan.access.preservica.com';
const ALLOWED_HOSTS = new Set<string>([
  'michigan.access.preservica.com',
  'michiganology.org',
  'www.michiganology.org',
]);
const ALLOWED_HOSTS_LIST = [...ALLOWED_HOSTS];
const USER_AGENT = 'Mozilla/5.0';

const DEFAULT_TEXT_TIMEOUT_SEC = 120;
const DEFAULT_DOWNLOAD_TIMEOUT_SEC = 180;
const CONNECT_TIMEOUT_SEC = 15;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 250;
const MAX_RETRY_AFTER_MS = 30_000;
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 522, 524]);

const SAFE_ITEM_ID_RE = /^(?:IO|SO)_[A-Za-z0-9-]+$/;
const DOWNLOAD_FILE_EXTS = new Set<string>(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.pdf']);

const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  item: 'get',
  show: 'get',
  info: 'get',
  fetch: 'download',
};

export const COLLECTIONS: readonly (readonly [string, string])[] = [
  ['Death Certificates, 1897-1952', `${BASE}/death-certificates-1897-1952/`],
  ['Michigan State Census, 1827-1894', `${BASE}/michigan-state-census/`],
  ['Naturalization Records', `${BASE}/naturalization-records/`],
  ['World War I, Service Cards', `${BASE}/world-war-i-service-cards/`],
  ['Surveyor Field Notebooks, 1815-1918', `${BASE}/surveyor-field-notebooks/`],
  ['Surveyor Maps, 1816-1860', `${BASE}/surveyor-maps/`],
  ['General Photograph Collection, ca. 1860-1990', `${BASE}/general-photograph-collection/`],
  ['Archives of Michigan Map Collection, ca. 1810-1970', `${BASE}/archives-of-michigan-map-collection/`],
  ['Corporation Annual Reports, 1997-2006', `${BASE}/corporation-annual-reports/`],
];

export interface MichiganologySearchItem {
  readonly title: string;
  readonly url: string;
}

interface MichiganologySearchResult {
  readonly query: string;
  readonly total: number | null;
  readonly results: readonly MichiganologySearchItem[];
}

interface MichiganologyItemData {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly download_url: string | null;
  readonly fields: readonly (readonly [string, string])[];
  readonly parsed: boolean;
}

interface DownloadedFileData {
  readonly body: Buffer;
  readonly filename: string;
  readonly content_type: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_MICHIGANOLOGY_CACHE_DIR'],
    defaultSubdir: 'kinloom-michiganology',
  });
}

function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_MICHIGANOLOGY_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_MICHIGANOLOGY_CACHE_TTL_HOURS'
  );
}

function validateTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(value)} (must be > 0).`);
  }
  return value;
}

export function validateMichiganologyUrl(rawUrl: string): string {
  const text = rawUrl.trim();
  if (!text || text.includes('\0') || [...text].some((ch) => ch.charCodeAt(0) < 32)) {
    throw new RecordRuntimeError(`Invalid Michiganology URL: '${rawUrl}'`);
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new RecordRuntimeError(`Invalid Michiganology URL: '${rawUrl}'`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    !host ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.username ||
    parsed.password
  ) {
    throw new RecordRuntimeError(`Refusing to access non-HTTPS or disallowed URL: ${text}`);
  }
  if (!ALLOWED_HOSTS.has(host)) {
    const allowed = [...ALLOWED_HOSTS].toSorted().join(', ');
    throw new RecordRuntimeError(
      `Refusing to access disallowed host '${host}' (allowed: ${allowed}): ${text}`
    );
  }
  return text;
}

function validateUserFilename(filename: string): string {
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
    throw new CliValidationError(`Unsafe --filename value: '${filename}'`);
  }
  return filename;
}

export function sanitizeServerFilename(raw: string, fallback: string): string {
  const candidate = raw.replace(/\\/g, '/');
  const tail = candidate.split('/').at(-1)?.trim() ?? '';
  const noDots = tail.replace(/\.\./g, '_');
  const cleaned = noDots.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  if (
    !cleaned ||
    cleaned === '.' ||
    cleaned === '..' ||
    cleaned.includes('..') ||
    cleaned.includes('/') ||
    cleaned.includes('\\')
  ) {
    return fallback;
  }
  return cleaned;
}

function resolveSafeChild(root: string, filename: string): string {
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
    throw new RecordRuntimeError(`Unsafe filename: '${filename}'`);
  }
  const rootResolved = path.resolve(root);
  const dest = path.resolve(rootResolved, filename);
  if (dest === rootResolved || !dest.startsWith(`${rootResolved}${path.sep}`)) {
    throw new RecordRuntimeError(`Unsafe path escaping ${root}: '${filename}'`);
  }
  return dest;
}

function isHtmlPayload(contentType: string, body: Uint8Array): boolean {
  const media = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (media === 'text/html' || media === 'application/xhtml+xml') {
    return true;
  }
  const sniff = Buffer.from(body.subarray(0, 512))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return (
    sniff.startsWith('<!doctype') ||
    sniff.startsWith('<html') ||
    sniff.startsWith('<head') ||
    sniff.startsWith('<body') ||
    sniff.startsWith('<title') ||
    sniff.startsWith('<?xml')
  );
}

function filenameFromContentDisposition(headerValue: string | null, fallback: string): string {
  if (!headerValue) {
    return fallback;
  }
  const starMatch = /filename\*\s*=\s*UTF-8''([^\r\n;]+)/i.exec(headerValue);
  if (starMatch) {
    const raw = starMatch[1].trim().replace(/^"|"$/g, '');
    try {
      return sanitizeServerFilename(decodeURIComponent(raw), fallback);
    } catch {
      return sanitizeServerFilename(raw, fallback);
    }
  }
  const plainMatch = /filename\s*=\s*"?([^"\r\n;]+)"?/i.exec(headerValue);
  if (plainMatch) {
    return sanitizeServerFilename(plainMatch[1].trim(), fallback);
  }
  return fallback;
}

function resolveItemRef(urlOrId: string): readonly [string, string] {
  const raw = urlOrId.trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const validated = validateMichiganologyUrl(raw);
    const idMatch = /((?:IO|SO)_[A-Za-z0-9-]+)/.exec(validated);
    if (idMatch) {
      return [idMatch[1], validated];
    }
    const pathname = new URL(validated).pathname.replace(/\/+$/, '');
    const tail = pathname.split('/').at(-1) ?? '';
    if (!tail) {
      throw new CliValidationError(
        'Pass a Michiganology item URL or a Preservica ID starting with IO_ or SO_.'
      );
    }
    return [tail, validated];
  }
  if (SAFE_ITEM_ID_RE.test(raw)) {
    return [raw, `${BASE}/uncategorized/${raw}/`];
  }
  throw new CliValidationError('Pass a Michiganology item URL or a Preservica ID starting with IO_ or SO_.');
}

function encodeQueryPlus(query: string): string {
  return new URLSearchParams({ s: query }).toString().slice(2);
}

async function curlFetchValidated(
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

export function parseSearchHtml(page: string, query: string): MichiganologySearchResult {
  const totalMatch = /([\d,]+)\s+total results/.exec(page);
  const total = totalMatch ? Number.parseInt(totalMatch[1].replace(/,/g, ''), 10) : null;
  const $ = loadHtml(page);
  const results: MichiganologySearchItem[] = [];

  $('div.result-item').each((_idx, el) => {
    const anchor = $(el).find('a[href]').first();
    if (anchor.length === 0) {
      return;
    }
    const href = anchor.attr('href') ?? '';
    if (!href) {
      return;
    }
    const title = collapseWhitespace(anchor.text()) || '(no title)';
    results.push({ title, url: href });
  });

  return { query, total, results };
}

export function parseItemHtml(page: string, itemId: string, itemUrl: string): MichiganologyItemData {
  const $ = loadHtml(page);
  const title = collapseWhitespace($('h1').first().text());
  const fields: [string, string][] = [];
  let curKey = '';
  $('span.metadata-title, span.metadata-content').each((_idx, el) => {
    const span = $(el);
    if (span.hasClass('metadata-title')) {
      curKey = collapseWhitespace(span.text()).replace(/^:+|:+$/g, '');
    } else if (span.hasClass('metadata-content') && curKey) {
      fields.push([curKey, collapseWhitespace(span.text())]);
      curKey = '';
    }
  });

  let downloadUrl: string | null = null;
  $('a[href]').each((_idx, el) => {
    const href = $(el).attr('href') ?? '';
    if (href.includes('/download/file/') && !downloadUrl) {
      downloadUrl = href;
    }
  });
  if (!downloadUrl && itemId.startsWith('IO_')) {
    downloadUrl = `${BASE}/download/file/${itemId}`;
  }

  return {
    id: itemId,
    title: title || itemId,
    url: itemUrl,
    download_url: downloadUrl,
    fields,
    parsed: Boolean(title || fields.length > 0),
  };
}

function fileCachePaths(ctx: RecordCommandContext, itemId: string): readonly [string, string, string] {
  if (!SAFE_ITEM_ID_RE.test(itemId)) {
    throw new RecordRuntimeError(`Invalid Michiganology item identifier: '${itemId}'`);
  }
  const root = path.join(getCacheDir(ctx), 'files', itemId);
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
    if (!fs.statSync(bodyPath).isFile() || !fs.statSync(metaPath).isFile()) {
      return null;
    }
    const size = fs.statSync(bodyPath).size;
    if (size <= 0) {
      return null;
    }
    const rawMeta: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!isPlainRecord(rawMeta) || rawMeta.schema !== CACHE_SCHEMA) {
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
    const body = fs.readFileSync(bodyPath);
    if (body.length === 0 || isHtmlPayload(contentType, body)) {
      return null;
    }
    return { body, filename, content_type: contentType };
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

async function cachedDownload(
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

function resolveDownloadDest(
  out: string,
  filename: string | undefined,
  resolvedName: string,
  ctx: RecordCommandContext
): string {
  if (out.includes('\0')) {
    throw new CliValidationError(`Invalid --out path: '${out}'`);
  }
  const expanded = expandHomePath(out, ctx.env);
  const resolvedOut = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(ctx.cwd, expanded);

  if (filename !== undefined) {
    const safeName = validateUserFilename(filename);
    fs.mkdirSync(resolvedOut, { recursive: true });
    return resolveSafeChild(resolvedOut, safeName);
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
  return resolveSafeChild(resolvedOut, safeServer);
}

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_MICHIGANOLOGY_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  { key: 'queryOpt', kind: 'string', flags: ['--query', '-q'], help: 'Search query string.' },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '-n'],
    min: 1,
    default: 10,
    help: 'Max results to show (first page only).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TEXT_TIMEOUT_SEC,
    help: 'Total timeout budget in seconds (retries fit within this budget).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

const GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TEXT_TIMEOUT_SEC,
    help: 'Total timeout budget in seconds (retries fit within this budget).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    default: '.',
    help: 'Output directory, or a .jpg/.jpeg/.png/.tif/.tiff/.pdf file path when --filename is omitted.',
  },
  {
    key: 'filename',
    kind: 'string',
    flags: ['--filename'],
    help: 'Override output filename (default: from Content-Disposition).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_DOWNLOAD_TIMEOUT_SEC,
    help: 'Total timeout budget in seconds (retries fit within this budget).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

const COLLECTIONS_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
];

const SEARCH_SPEC: CommandParseSpec = { options: SEARCH_OPTIONS, allowPositionals: true };
const GET_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'url_or_id',
};
const DOWNLOAD_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'url_or_id',
};
const COLLECTIONS_SPEC: CommandParseSpec = {
  options: COLLECTIONS_OPTIONS,
  allowPositionals: false,
};
const URL_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'query',
};

function isSearchResult(value: unknown): value is MichiganologySearchResult {
  return isPlainRecord(value) && Array.isArray(value.results);
}

function isItemData(value: unknown): value is MichiganologyItemData {
  return isPlainRecord(value) && typeof value.id === 'string' && Array.isArray(value.fields);
}

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom michiganology <command> [options]',
    summary: 'Search Michiganology (Archives of Michigan digital collections).',
    subcommands: [
      { name: 'search', summary: 'Search all Michiganology collections.' },
      {
        name: 'get',
        summary: 'Inspect a Michiganology item page (aliases: item, show, info).',
      },
      {
        name: 'download',
        summary: 'Download the full-resolution file for an IO_ item (alias: fetch).',
      },
      { name: 'collections', summary: 'List the Michiganology digital collections.' },
      { name: 'url', summary: 'Print the shareable Michiganology search URL for a query.' },
    ],
  });
}

export const runMichiganologyCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [rawSubcmd, ...rest] = args;
    const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);

    switch (subcmd) {
      case 'search': {
        const parsed = parseCommandArgs(rest, SEARCH_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom michiganology search [QUERY]... [options]',
                summary: 'Search all Michiganology collections, e.g. kinloom michiganology search Lincoln.',
                options: SEARCH_OPTIONS,
              })
            ),
          };
        }
        const parts = parsed.positionals.map((p) => p.trim()).filter(Boolean);
        const queryOpt = getStringOption(parsed, 'queryOpt')?.trim();
        if (queryOpt) {
          parts.unshift(queryOpt);
        }
        const query = parts.join(' ').trim();
        if (!query) {
          throw new CliValidationError('Missing search query. Example: michiganology search Lincoln');
        }
        const limit = getNumberOption(parsed, 'limit') ?? 10;
        const budget = validateTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TEXT_TIMEOUT_SEC);
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
        const refresh = getBooleanOption(parsed, 'refresh');
        const asJson = getBooleanOption(parsed, 'asJson');

        const { value: data, cacheHit } = await cachedJsonCall<MichiganologySearchResult>({
          cacheDir: getCacheDir(ctx),
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

        const sliced = data.results.slice(0, limit);
        if (asJson) {
          return {
            exitCode: 0,
            bytesOut: emitJsonStdout(ctx.io, {
              query,
              total: data.total,
              results: sliced,
              cache_hit: cacheHit,
            }),
            cacheHit,
          };
        }
        const marker = cacheHit ? ' [cache]' : '';
        const lines: string[] = [
          `Query: ${query}  |  Total results: ${data.total !== null ? data.total : 'unknown'}${marker}`,
        ];
        if (sliced.length === 0) {
          lines.push('No results on the first page.');
        } else {
          for (const item of sliced) {
            lines.push(`- ${item.title}\n  ${item.url}`);
          }
          lines.push(`(${sliced.length} of ${data.total} shown; first page only)`);
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
      }

      case 'get': {
        const parsed = parseCommandArgs(rest, GET_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom michiganology get <URL_OR_ID> [options]',
                summary: 'Inspect a Michiganology item page (Item Data fields and file download URL).',
                options: GET_OPTIONS,
              })
            ),
          };
        }
        const [itemId, itemUrl] = resolveItemRef(parsed.positionals[0] ?? '');
        const budget = validateTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TEXT_TIMEOUT_SEC);
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
        const refresh = getBooleanOption(parsed, 'refresh');
        const asJson = getBooleanOption(parsed, 'asJson');

        const { value: data, cacheHit } = await cachedJsonCall<MichiganologyItemData>({
          cacheDir: getCacheDir(ctx),
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

        const metadata: Record<string, string | string[]> = {};
        for (const [key, val] of data.fields) {
          const prev = metadata[key];
          if (prev !== undefined) {
            metadata[key] = Array.isArray(prev) ? [...prev, val] : [prev, val];
          } else {
            metadata[key] = val;
          }
        }
        const payload = {
          id: itemId,
          title: data.title,
          url: itemUrl,
          download_url: data.download_url,
          metadata,
          cache_hit: cacheHit,
        };
        if (asJson) {
          return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload), cacheHit };
        }
        const lines: string[] = [
          `Item ${itemId}: ${data.title}${cacheHit ? ' [cache]' : ''}`,
          `  URL: ${itemUrl}`,
        ];
        if (data.download_url) {
          lines.push(`  Download: ${data.download_url}`);
        }
        for (const [key, val] of data.fields) {
          lines.push(`  ${key}: ${val}`);
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
      }

      case 'download': {
        const parsed = parseCommandArgs(rest, DOWNLOAD_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom michiganology download <URL_OR_ID> [options]',
                summary: 'Download the full-resolution file for a Michiganology IO_ item.',
                options: DOWNLOAD_OPTIONS,
              })
            ),
          };
        }
        const [itemId] = resolveItemRef(parsed.positionals[0] ?? '');
        if (!itemId.startsWith('IO_')) {
          throw new RecordRuntimeError(
            `${itemId} is a folder/collection object (SO_); pass an IO_ item URL or ID to download.`
          );
        }
        const out = getStringOption(parsed, 'out') ?? '.';
        const filename = getStringOption(parsed, 'filename');
        if (filename !== undefined) {
          validateUserFilename(filename);
        }
        if (out.includes('\0')) {
          throw new CliValidationError(`Invalid --out path: '${out}'`);
        }
        if (
          filename === undefined &&
          DOWNLOAD_FILE_EXTS.has(path.extname(out).toLowerCase()) &&
          out.split(/[\\/]+/).includes('..')
        ) {
          throw new CliValidationError(`Unsafe --out path containing '..': '${out}'`);
        }

        const budget = validateTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_DOWNLOAD_TIMEOUT_SEC);
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
        const refresh = getBooleanOption(parsed, 'refresh');
        const asJson = getBooleanOption(parsed, 'asJson');

        const { data: fetched, cacheHit } = await cachedDownload(ctx, itemId, refresh, ttlHours, budget);
        const dest = resolveDownloadDest(out, filename, fetched.filename, ctx);
        atomicWriteFileSync(dest, fetched.body);

        const payload = {
          item_id: itemId,
          path: dest,
          bytes: fetched.body.length,
          filename: fetched.filename,
          content_type: fetched.content_type,
          cache_hit: cacheHit,
        };
        if (asJson) {
          return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload), cacheHit };
        }
        return {
          exitCode: 0,
          bytesOut: emitStdout(ctx.io, `${dest} (${fetched.body.length} bytes)`),
          cacheHit,
        };
      }

      case 'collections': {
        const parsed = parseCommandArgs(rest, COLLECTIONS_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom michiganology collections [options]',
                summary: 'List the Michiganology digital collections.',
                options: COLLECTIONS_OPTIONS,
              })
            ),
          };
        }
        if (getBooleanOption(parsed, 'asJson')) {
          return {
            exitCode: 0,
            bytesOut: emitJsonStdout(
              ctx.io,
              COLLECTIONS.map(([name, url]) => ({ name, url }))
            ),
          };
        }
        const text = COLLECTIONS.map(([name, url]) => `- ${name}\n  ${url}`).join('\n');
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
      }

      case 'url': {
        const parsed = parseCommandArgs(rest, URL_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom michiganology url <QUERY>...',
                summary: 'Print the shareable Michiganology search URL for a query.',
              })
            ),
          };
        }
        const query = parsed.positionals
          .map((p) => p.trim())
          .filter(Boolean)
          .join(' ');
        return {
          exitCode: 0,
          bytesOut: emitStdout(ctx.io, `${BASE}/?s=${encodeQueryPlus(query)}`),
        };
      }

      default:
        throw new CliValidationError(
          `No such command '${rawSubcmd}'. Run 'kinloom michiganology --script-help'.`
        );
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
