import { CliValidationError } from '../../../../errors.js';
import { parseCacheTtlHours, resolveCacheDir } from '../../runtime/cache.js';
import {
  HTML_ERROR_PREFIXES,
  hasControlChar,
  hasMagicPrefix,
  isPlainRecord,
  JPEG_MAGIC,
  PDF_MAGIC,
  PNG_MAGIC,
  resolveSafeChildPath,
  stripLeadingBomAndWs,
} from '../../runtime/primitives.js';
import { RecordRuntimeError } from '../../runtime/types.js';

export const COLLECTION_BASE = 'https://www.loc.gov/collections/chronicling-america/';
export const USER_AGENT = 'kinloom/1.0 (genealogy research; +https://github.com/Tiberriver256/kinloom)';
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
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 522, 524]);
export const MAX_RETRY_AFTER_S = 30.0;
export const COLLECTION_START_YEAR = '1736';
export const COLLECTION_END_YEAR = '1963';
export const DEFAULT_CACHE_TTL_HOURS = 168.0;
export const CACHE_SCHEMA = 1;

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

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function firstValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : null;
  }
  return value ?? null;
}

export function formatTextField(value: unknown): string {
  return value === null || value === undefined ? 'None' : String(value);
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
    env['KINLOOM_CHRONAM_CACHE_TTL_HOURS'],
    DEFAULT_CACHE_TTL_HOURS,
    'KINLOOM_CHRONAM_CACHE_TTL_HOURS'
  );
}

export function validateLocUrl(url: string): string {
  const text = (url ?? '').trim();
  if (!text || hasControlChar(text)) {
    throw new RecordRuntimeError(`Invalid URL: ${JSON.stringify(url)}`);
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
  if (kind === 'pdf' && !hasMagicPrefix(head, PDF_MAGIC)) {
    return 'non-PDF payload';
  }
  if (kind === 'image' && !(hasMagicPrefix(head, JPEG_MAGIC) || hasMagicPrefix(head, PNG_MAGIC))) {
    return 'non-image payload';
  }
  if (kind === 'jp2' && !JP2_MAGICS.some((magic) => hasMagicPrefix(head, magic))) {
    return 'non-JP2 payload';
  }
  return null;
}

export function resolveSafeChild(root: string, filename: string): string {
  return resolveSafeChildPath(root, filename, {
    rejectDoubleDotSubstring: true,
    formatName: (n) => JSON.stringify(n),
    escapeRootLabel: root,
  });
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

// --- query & asset helpers ---------------------------------------------------

export function resolveQuery(words: readonly string[], termsOpt: string | undefined): string {
  const joined = words
    .filter((w) => w.length > 0)
    .join(' ')
    .trim();
  const query = joined || (termsOpt ?? '').trim();
  if (!query) {
    throw new CliValidationError('Provide QUERY words as positional arguments or via --terms/--query.');
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
    readonly dates?: string | undefined;
    readonly level: string;
    readonly limit: number;
    readonly page: number;
    readonly state?: string | undefined;
    readonly lccn?: string | undefined;
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

export function compactResult(item: Record<string, unknown>): Record<string, unknown> {
  const partofTitle = firstValue(item['partof_title']);
  const title = partofTitle ? partofTitle : (item['title'] ?? null);
  return {
    title,
    date: item['date'] ?? null,
    state: firstValue(item['location_state']),
    county: firstValue(item['location_county']),
    city: firstValue(item['location_city']),
    lccn: item['number_lccn'] ?? null,
    page: item['number_page'] ?? null,
    url: item['url'] ?? null,
    id: item['id'] ?? null,
  };
}

export function searchCacheable(data: Record<string, unknown>): boolean {
  // loc.gov sometimes answers a valid query with a transient 0-hit page.
  // Never cache an empty answer, so the next call asks loc.gov again.
  const searchObj = isPlainRecord(data['search']) ? data['search'] : undefined;
  const hits = searchObj?.['hits'];
  const results = Array.isArray(data['results']) ? data['results'] : [];
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

export function iiifJpegFromInfo(infoUrl: string, imageWidth: number | undefined): string | null {
  if (!infoUrl?.endsWith('/info.json')) {
    return null;
  }
  const base = infoUrl.slice(0, -'/info.json'.length);
  const size = imageWidth !== undefined ? `${imageWidth},` : 'pct:50';
  return `${base}/full/${size}/0/default.jpg`;
}

export function resolvePageAssets(
  data: Record<string, unknown>,
  options: { readonly imageWidth?: number | undefined } = {}
): PageAssets {
  const rawResources =
    Array.isArray(data['resources']) && data['resources'].length > 0 ? data['resources'][0] : undefined;
  const resources = isPlainRecord(rawResources) ? rawResources : {};
  const pageEntries = Array.isArray(data['page']) ? data['page'] : [];

  let pdfUrl: string | null = null;
  let jp2Url: string | null = null;
  let xmlUrl: string | null = null;
  let iiifImageUrl: string | null = null;
  let bestJpegUrl: string | null = null;

  for (const entry of pageEntries) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const mime = String(entry['mimetype'] ?? '').toLowerCase();
    const entryUrl = asNonEmptyString(entry['url']);
    const infoUrl = asNonEmptyString(entry['info']);

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
    pdf: pdfUrl ?? asNonEmptyString(resources['pdf']) ?? null,
    image: iiifImageUrl ?? bestJpegUrl ?? asNonEmptyString(resources['image']) ?? null,
    jp2: jp2Url,
    text: asNonEmptyString(resources['fulltext_file']) ?? xmlUrl ?? null,
    iiif_manifest_url: asNonEmptyString(resources['iiif_manifest_url']) ?? null,
  };
}

export function buildResourceUrl(lccn: string, date: string, edition: string, seq: string): string {
  return `https://www.loc.gov/resource/${lccn}/${date}/ed-${edition}/?sp=${seq}`;
}
