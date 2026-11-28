import { CliValidationError } from '../../../../errors.js';
import { collapseWhitespace, loadHtml } from '../../runtime/parse.js';
import {
  hasControlChar,
  isPlainRecord,
  looksLikeHtmlBuffer,
  stripLeadingBomAndWs,
} from '../../runtime/primitives.js';
import { RecordRuntimeError } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const CACHE_SCHEMA = 1;
export const BASE = 'https://michigan.access.preservica.com';
export const ALLOWED_HOSTS = new Set<string>([
  'michigan.access.preservica.com',
  'michiganology.org',
  'www.michiganology.org',
]);
export const ALLOWED_HOSTS_LIST = [...ALLOWED_HOSTS];
export const USER_AGENT = 'Mozilla/5.0';

export const DEFAULT_TEXT_TIMEOUT_SEC = 120;
export const DEFAULT_DOWNLOAD_TIMEOUT_SEC = 180;
export const CONNECT_TIMEOUT_SEC = 15;
export const MAX_ATTEMPTS = 4;
export const BASE_BACKOFF_MS = 250;
export const MAX_RETRY_AFTER_MS = 30_000;
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 522, 524]);

export const SAFE_ITEM_ID_RE = /^(?:IO|SO)_[A-Za-z0-9-]+$/;
export const DOWNLOAD_FILE_EXTS = new Set<string>(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.pdf']);

export const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
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

export interface MichiganologySearchResult {
  readonly query: string;
  readonly total: number | null;
  readonly results: readonly MichiganologySearchItem[];
}

export interface MichiganologyItemData {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly download_url: string | null;
  readonly fields: readonly (readonly [string, string])[];
  readonly parsed: boolean;
}

export interface DownloadedFileData {
  readonly body: Buffer;
  readonly filename: string;
  readonly content_type: string;
}

export function isSearchResult(value: unknown): value is MichiganologySearchResult {
  return isPlainRecord(value) && Array.isArray(value['results']);
}

export function isItemData(value: unknown): value is MichiganologyItemData {
  return isPlainRecord(value) && typeof value['id'] === 'string' && Array.isArray(value['fields']);
}

export function validateTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(value)} (must be > 0).`);
  }
  return value;
}

export function validateMichiganologyUrl(rawUrl: string): string {
  const text = rawUrl.trim();
  if (!text || hasControlChar(text)) {
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

export function validateUserFilename(filename: string): string {
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

export function isHtmlPayload(contentType: string, body: Uint8Array): boolean {
  const media = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (media === 'text/html' || media === 'application/xhtml+xml') {
    return true;
  }
  if (looksLikeHtmlBuffer(body, 512)) {
    return true;
  }
  const sniff = stripLeadingBomAndWs(body, 512);
  return sniff.startsWith('<title') || sniff.startsWith('<?xml');
}

export function filenameFromContentDisposition(headerValue: string | null, fallback: string): string {
  if (!headerValue) {
    return fallback;
  }
  const starMatch = /filename\*\s*=\s*UTF-8''([^\r\n;]+)/i.exec(headerValue);
  if (starMatch) {
    const raw = (starMatch[1] ?? '').trim().replace(/^"|"$/g, '');
    try {
      return sanitizeServerFilename(decodeURIComponent(raw), fallback);
    } catch {
      return sanitizeServerFilename(raw, fallback);
    }
  }
  const plainMatch = /filename\s*=\s*"?([^"\r\n;]+)"?/i.exec(headerValue);
  if (plainMatch) {
    return sanitizeServerFilename((plainMatch[1] ?? '').trim(), fallback);
  }
  return fallback;
}

export function resolveItemRef(urlOrId: string): readonly [string, string] {
  const raw = urlOrId.trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const validated = validateMichiganologyUrl(raw);
    const idMatch = /((?:IO|SO)_[A-Za-z0-9-]+)/.exec(validated);
    if (idMatch) {
      return [idMatch[1] ?? '', validated];
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

export function encodeQueryPlus(query: string): string {
  return new URLSearchParams({ s: query }).toString().slice(2);
}

export function parseSearchHtml(page: string, query: string): MichiganologySearchResult {
  const totalMatch = /([\d,]+)\s+total results/.exec(page);
  const total = totalMatch ? Number.parseInt((totalMatch[1] ?? '').replace(/,/g, ''), 10) : null;
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
