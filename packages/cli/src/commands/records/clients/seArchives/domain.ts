import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { expandHomePath, resolveCacheDir } from '../../runtime/cache.js';
import {
  hasMagicPrefix,
  isPlainRecord,
  JPEG_MAGIC,
  looksLikeHtmlBuffer,
  PNG_MAGIC,
  resolveEnvCacheTtlHours,
  resolveSafeChildPath,
} from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const DATA_API_BASE = 'https://data.riksarkivet.se';
export const RECORDS_API_URL = `${DATA_API_BASE}/api/records`;
export const BIRTHS_API_URL = `${DATA_API_BASE}/api/records/birthrecords`;
export const MARRIAGES_API_URL = `${DATA_API_BASE}/api/records/marriagerecords`;
export const DEEDS_API_URL = `${DATA_API_BASE}/api/records/indexoftitledeeds`;
export const REGISTER_BASE_URL = `${DATA_API_BASE}/register`;

export const IIIF_BASE = 'https://lbiiif.riksarkivet.se';
export const IIIF_COLLECTION_BASE = `${IIIF_BASE}/collection/arkiv`;
export const BILDVISNING_BASE = 'https://sok.riksarkivet.se/bildvisning';
export const FOLKRAKNINGAR_URL = 'https://sok.riksarkivet.se/folkrakningar';
export const KYRKOARKIV_URL = 'https://sok.riksarkivet.se/kyrkoarkiv';

export const ALLOWED_API_HOSTS = ['data.riksarkivet.se', 'lbiiif.riksarkivet.se'] as const;
export const ALLOWED_DOWNLOAD_HOSTS = ['lbiiif.riksarkivet.se'] as const;
export const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
export const MAX_HTTP_ATTEMPTS = 3;
export const RETRY_BASE_MS = 500;
export const REQUEST_TIMEOUT_MS = 30_000;

export const RECORD_TYPE_FACETS: Readonly<Record<string, string>> = {
  volume: 'ObjectType:Record;Type:Volume',
  archive: 'ObjectType:RecordSet',
  recordset: 'ObjectType:RecordSet',
  birth: 'ObjectType:Register;Type:BirthRecord',
  marriage: 'ObjectType:Register;Type:MarriageRecord',
  deed: 'ObjectType:Register;Type:IndexOfTitleDeedsRecord',
  'title-deed': 'ObjectType:Register;Type:IndexOfTitleDeedsRecord',
  map: 'ObjectType:Record;Type:MapDrawing',
  photo: 'ObjectType:Record;Type:Photography',
  document: 'ObjectType:Record;Type:Document',
  agent: 'ObjectType:Agent',
};

export const GENDER_ALIASES: Readonly<Record<string, string>> = {
  kvinna: 'Kvinna',
  female: 'Kvinna',
  f: 'Kvinna',
  man: 'Man',
  male: 'Man',
  m: 'Man',
  okänt: 'Okänt',
  okant: 'Okänt',
  unknown: 'Okänt',
};

export const CENSUS_YEAR_FLAGS: Readonly<Record<number, string>> = {
  1860: 'Folk1860',
  1870: 'Folk1870',
  1880: 'Folk1880',
  1890: 'Folk1890',
  1900: 'Folk1900',
  1910: 'Folk1910',
  1930: 'Folk1930',
};

const SAFE_ID_RE = /^[A-Za-z0-9_-]{3,80}$/;
const BILDID_RE = /^([A-Za-z0-9]+)(?:_(\d{1,6}))?$/;
export const ARKIS_MANIFEST_RE = /\/arkis!([A-Za-z0-9_]+)(?:\/|$)/;
export const EM_TAG_RE = /<\/?em>/gi;

const GIF87_MAGIC = Buffer.from('GIF87a', 'ascii');
const GIF89_MAGIC = Buffer.from('GIF89a', 'ascii');

export interface SearchSnippet {
  readonly text: string;
  readonly pages: string[];
}

export interface NormalizedSearchItem {
  readonly id: string;
  readonly object_type: string;
  readonly type: string;
  readonly caption: string;
  readonly reference_code: string;
  readonly date: string;
  readonly parish: string;
  readonly institution: string;
  readonly digitized: boolean;
  readonly hierarchy?: string[];
  readonly note?: string;
  readonly child_name?: string;
  readonly father?: string;
  readonly mother?: string;
  readonly groom?: string;
  readonly bride?: string;
  readonly property_name?: string;
  readonly tax_unit?: string;
  readonly court_session?: string;
  readonly snippets?: SearchSnippet[];
  readonly iiif_manifests?: string[];
  readonly self_url?: string;
  readonly iiif_collection_url?: string;
}

export interface SearchEndpointResult {
  readonly total: number;
  readonly hits: number;
  readonly offset: number;
  readonly results: NormalizedSearchItem[];
  readonly verified: boolean;
}

export interface RegisterDetailResult {
  readonly id: string;
  readonly url: string;
  readonly record: Record<string, unknown>;
  readonly verified: boolean;
}

export interface CollectionItem {
  readonly type: string;
  readonly label: string;
  readonly url: string;
  readonly archive_id?: string;
  readonly bildid?: string;
}

export interface IiifCollectionResult {
  readonly archive_id: string;
  readonly url: string;
  readonly label: string;
  readonly reference_code: string;
  readonly institution: string;
  readonly date: string;
  readonly count: number;
  readonly items: CollectionItem[];
  readonly verified: boolean;
}

export interface CanvasInfo {
  readonly index: number;
  readonly page_id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly bildvisning_url: string;
  readonly source_reference: string;
  readonly iiif_image_base: string;
  readonly full_image_url: string;
}

export interface IiifManifestResult {
  readonly bildid: string;
  readonly manifest_url: string;
  readonly bildvisning_url: string;
  readonly label: string;
  readonly metadata: Record<string, string>;
  readonly canvas_count: number;
  readonly canvases: CanvasInfo[];
  readonly verified: boolean;
}

export interface DownloadResult {
  readonly page_id: string;
  readonly url: string;
  readonly bildvisning_url: string;
  readonly path: string;
  readonly bytes: number;
  readonly format: string;
  readonly skipped: boolean;
  readonly cache_hit: boolean;
}

export function getCacheDir(ctx: RecordCommandContext): string {
  const specific = ctx.env['KINLOOM_SE_ARCHIVES_CACHE_DIR'];
  if (specific && specific.trim().length > 0) {
    return path.resolve(expandHomePath(specific, ctx.env));
  }
  const shared = ctx.env['KINLOOM_CACHE_DIR'];
  if (shared && shared.trim().length > 0) {
    return path.resolve(expandHomePath(shared, ctx.env), 'se-archives');
  }
  return resolveCacheDir({
    env: ctx.env,
    envVars: [],
    defaultSubdir: path.join('kinloom', 'se-archives'),
  });
}

export function resolveTtlHours(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export function validateSeUrl(rawUrl: string, allowedHosts: readonly string[] = ALLOWED_API_HOSTS): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CliValidationError(`Refusing malformed URL: '${rawUrl}'`);
  }
  if (parsed.protocol !== 'https:') {
    throw new CliValidationError(`Refusing non-HTTPS URL: '${rawUrl}'`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    throw new CliValidationError(
      `Refusing host '${host}'; allowed hosts: ${[...allowedHosts].toSorted().join(', ')}.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new CliValidationError('Refusing URL containing embedded credentials.');
  }
  return rawUrl;
}

export function validateYearRange(yearMin: number | undefined, yearMax: number | undefined): void {
  if (yearMin !== undefined && (yearMin < 1000 || yearMin > 2100)) {
    throw new CliValidationError(`Invalid --year-min ${yearMin}; expected a 4-digit year.`);
  }
  if (yearMax !== undefined && (yearMax < 1000 || yearMax > 2100)) {
    throw new CliValidationError(`Invalid --year-max ${yearMax}; expected a 4-digit year.`);
  }
  if (yearMin !== undefined && yearMax !== undefined && yearMin > yearMax) {
    throw new CliValidationError('--year-min must not be greater than --year-max.');
  }
}

export function validatePaging(limit: number, offset: number): void {
  if (limit < 1 || limit > 100) {
    throw new CliValidationError('--limit must be between 1 and 100.');
  }
  if (offset < 0) {
    throw new CliValidationError('--offset must be >= 0.');
  }
}

export function stripLeadingUnderscores(value: string): string {
  return value.replace(/^_+/, '');
}

export function normalizeHttps(url: string): string {
  if (url.startsWith('http://data.riksarkivet.se/')) {
    return `https://${url.slice('http://'.length)}`;
  }
  return url;
}

export function normalizeBildid(raw: string): readonly [string, string | null] {
  const text = raw.trim();
  if (!text) {
    throw new CliValidationError('Empty bildid or URL.');
  }
  let token: string;
  if (text.startsWith('http://') || text.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      throw new CliValidationError(`Invalid URL: '${raw}'`);
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'lbiiif.riksarkivet.se') {
      validateSeUrl(text, ALLOWED_DOWNLOAD_HOSTS);
      const match = ARKIS_MANIFEST_RE.exec(parsed.pathname);
      if (!match) {
        throw new CliValidationError(`Could not extract arkis bildid from IIIF URL: '${raw}'`);
      }
      token = stripLeadingUnderscores(match[1]);
    } else if (host === 'sok.riksarkivet.se') {
      if (parsed.protocol !== 'https:') {
        throw new CliValidationError(`Refusing non-HTTPS URL: '${raw}'`);
      }
      const parts = parsed.pathname.split('/').filter((p) => p.length > 0);
      if (parts.length < 2 || parts[0].toLowerCase() !== 'bildvisning') {
        throw new CliValidationError(`Expected a sok.riksarkivet.se/bildvisning/<bildid> URL, got: '${raw}'`);
      }
      token = stripLeadingUnderscores(parts[1]);
    } else {
      throw new CliValidationError(
        `Refusing host '${host}'; allowed hosts: lbiiif.riksarkivet.se, sok.riksarkivet.se.`
      );
    }
  } else {
    token = stripLeadingUnderscores(text);
    if (token.startsWith('arkis!')) {
      token = stripLeadingUnderscores(token.slice('arkis!'.length));
    }
  }

  const m = BILDID_RE.exec(token);
  if (!m) {
    throw new CliValidationError(`Invalid Riksarkivet bildid: '${raw}'`);
  }
  const volId = m[1];
  const pageNum = m[2];
  const pageId = pageNum ? `${volId}_${pageNum}` : null;
  return [volId, pageId];
}

export function parseArchiveId(raw: string): string {
  let text = raw.trim();
  if (!text) {
    throw new CliValidationError('Archive ID cannot be empty.');
  }
  if (text.startsWith('http://') || text.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      throw new CliValidationError(`Invalid URL: '${raw}'`);
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'data.riksarkivet.se' && host !== 'lbiiif.riksarkivet.se') {
      throw new CliValidationError(
        `Refusing host '${host}'; expected data.riksarkivet.se or lbiiif.riksarkivet.se.`
      );
    }
    if (parsed.protocol !== 'https:') {
      throw new CliValidationError(`Refusing non-HTTPS URL: '${raw}'`);
    }
    const parts = parsed.pathname.split('/').filter((p) => p.length > 0);
    let leaf = parts.at(-1) ?? '';
    for (const suffix of ['.jsonld', '.rdfxml']) {
      if (leaf.endsWith(suffix)) {
        leaf = leaf.slice(0, -suffix.length);
      }
    }
    text = leaf;
  }
  if (!SAFE_ID_RE.test(text)) {
    throw new CliValidationError(`Invalid Riksarkivet archive ID: '${raw}'`);
  }
  return text;
}

export function parseRegisterId(raw: string): string {
  let text = raw.trim();
  if (!text) {
    throw new CliValidationError('Register record ID cannot be empty.');
  }
  if (text.startsWith('http://') || text.startsWith('https://')) {
    validateSeUrl(text, ['data.riksarkivet.se']);
    const parsed = new URL(text);
    const parts = parsed.pathname.split('/').filter((p) => p.length > 0);
    if (parts.length < 2 || parts[0] !== 'register') {
      throw new CliValidationError(`Expected https://data.riksarkivet.se/register/<id>, got: '${raw}'`);
    }
    text = parts[1];
  }
  if (!SAFE_ID_RE.test(text)) {
    throw new CliValidationError(`Invalid Riksarkivet register record ID: '${raw}'`);
  }
  return text;
}

export function detectImageFormat(data: Uint8Array): string | null {
  if (hasMagicPrefix(data, JPEG_MAGIC)) {
    return 'jpeg';
  }
  if (hasMagicPrefix(data, PNG_MAGIC)) {
    return 'png';
  }
  if (hasMagicPrefix(data, GIF87_MAGIC) || hasMagicPrefix(data, GIF89_MAGIC)) {
    return 'gif';
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

export function looksLikeHtmlPayload(data: Uint8Array, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) {
    return true;
  }
  if (looksLikeHtmlBuffer(data, 512)) {
    return true;
  }
  const head = Buffer.from(data.subarray(0, 512)).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<?xml');
}

export function resolveSafeOutputPath(
  out: string,
  defaultName: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = out.trim();
  if (!raw || raw.includes('\0')) {
    throw new CliValidationError('Invalid output path.');
  }
  const segments = raw.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new CliValidationError(`Refusing output path with parent traversal segment ('..'): '${raw}'`);
  }
  const expanded = expandHomePath(raw, env);
  const isDirHint =
    raw.endsWith('/') ||
    raw.endsWith('\\') ||
    (fs.existsSync(expanded) && fs.statSync(expanded).isDirectory());
  if (isDirHint) {
    const safeLeaf =
      defaultName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'scan.jpg';
    return resolveSafeChildPath(path.resolve(expanded), safeLeaf, {
      errorFactory: (msg) => new CliValidationError(msg),
      escapeRootLabel: 'target directory',
    });
  }
  return path.resolve(expanded);
}

export function buildIiifImageUrl(
  target: string,
  options: { readonly page?: number; readonly width?: number; readonly full?: boolean } = {}
): readonly [string, string] {
  const { page, width, full = false } = options;
  if (width !== undefined && full) {
    throw new CliValidationError('Pass either --width or --full, not both.');
  }
  if (width !== undefined && (width < 64 || width > 12_000)) {
    throw new CliValidationError('--width must be between 64 and 12000 pixels.');
  }
  if (page !== undefined && page < 1) {
    throw new CliValidationError('--page must be >= 1.');
  }

  const raw = target.trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new CliValidationError(`Invalid URL: '${raw}'`);
    }
    const host = parsed.hostname.toLowerCase();
    const lowerPath = parsed.pathname.toLowerCase();
    if (
      host === 'lbiiif.riksarkivet.se' &&
      (lowerPath.endsWith('.jpg') ||
        lowerPath.endsWith('.jpeg') ||
        lowerPath.endsWith('.png') ||
        lowerPath.endsWith('.webp'))
    ) {
      const url = validateSeUrl(raw, ALLOWED_DOWNLOAD_HOSTS);
      const match = ARKIS_MANIFEST_RE.exec(parsed.pathname);
      const stem = match ? stripLeadingUnderscores(match[1]) : 'riksarkivet_scan';
      return [url, stem];
    }
  }

  const [volId, existingPageId] = normalizeBildid(raw);
  let pageId = existingPageId;
  if (pageId === null) {
    const pageNum = page ?? 1;
    pageId = `${volId}_${String(pageNum).padStart(5, '0')}`;
  } else if (page !== undefined) {
    pageId = `${volId}_${String(page).padStart(5, '0')}`;
  }

  const sizeSeg = width !== undefined ? `${width},` : 'max';
  const url = `${IIIF_BASE}/arkis!${encodeURIComponent(pageId)}/full/${sizeSeg}/0/default.jpg`;
  return [url, pageId];
}

export function isSearchEndpointResult(value: unknown): value is SearchEndpointResult {
  return isPlainRecord(value) && Array.isArray(value['results']);
}

export function isRegisterDetailResult(value: unknown): value is RegisterDetailResult {
  return isPlainRecord(value) && isPlainRecord(value['record']);
}

export function isIiifCollectionResult(value: unknown): value is IiifCollectionResult {
  return isPlainRecord(value) && Array.isArray(value['items']);
}

export function isIiifManifestResult(value: unknown): value is IiifManifestResult {
  return isPlainRecord(value) && Array.isArray(value['canvases']);
}
