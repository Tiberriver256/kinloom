import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  type CommandParseSpec,
  cachedJsonCall,
  collapseWhitespace,
  DEFAULT_USER_AGENT,
  emitJsonStdout,
  emitStdout,
  expandHomePath,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpRequest,
  type OptionSpec,
  parseCacheTtlHours,
  parseCommandArgs,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  resolveCacheDir,
  SsrfBlockedError,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const DATA_API_BASE = 'https://data.riksarkivet.se';
const RECORDS_API_URL = `${DATA_API_BASE}/api/records`;
const BIRTHS_API_URL = `${DATA_API_BASE}/api/records/birthrecords`;
const MARRIAGES_API_URL = `${DATA_API_BASE}/api/records/marriagerecords`;
const DEEDS_API_URL = `${DATA_API_BASE}/api/records/indexoftitledeeds`;
const REGISTER_BASE_URL = `${DATA_API_BASE}/register`;

const IIIF_BASE = 'https://lbiiif.riksarkivet.se';
const IIIF_COLLECTION_BASE = `${IIIF_BASE}/collection/arkiv`;
const BILDVISNING_BASE = 'https://sok.riksarkivet.se/bildvisning';
const FOLKRAKNINGAR_URL = 'https://sok.riksarkivet.se/folkrakningar';
const KYRKOARKIV_URL = 'https://sok.riksarkivet.se/kyrkoarkiv';

export const ALLOWED_API_HOSTS = ['data.riksarkivet.se', 'lbiiif.riksarkivet.se'] as const;
export const ALLOWED_DOWNLOAD_HOSTS = ['lbiiif.riksarkivet.se'] as const;
const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_HTTP_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

const RECORD_TYPE_FACETS: Readonly<Record<string, string>> = {
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

const GENDER_ALIASES: Readonly<Record<string, string>> = {
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

const CENSUS_YEAR_FLAGS: Readonly<Record<number, string>> = {
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
const ARKIS_MANIFEST_RE = /\/arkis!([A-Za-z0-9_]+)(?:\/|$)/;
const EM_TAG_RE = /<\/?em>/gi;

interface SearchSnippet {
  readonly text: string;
  readonly pages: string[];
}

interface NormalizedSearchItem {
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

interface SearchEndpointResult {
  readonly total: number;
  readonly hits: number;
  readonly offset: number;
  readonly results: NormalizedSearchItem[];
  readonly verified: boolean;
}

interface RegisterDetailResult {
  readonly id: string;
  readonly url: string;
  readonly record: Record<string, unknown>;
  readonly verified: boolean;
}

interface CollectionItem {
  readonly type: string;
  readonly label: string;
  readonly url: string;
  readonly archive_id?: string;
  readonly bildid?: string;
}

interface IiifCollectionResult {
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

interface CanvasInfo {
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

interface IiifManifestResult {
  readonly bildid: string;
  readonly manifest_url: string;
  readonly bildvisning_url: string;
  readonly label: string;
  readonly metadata: Record<string, string>;
  readonly canvas_count: number;
  readonly canvases: CanvasInfo[];
  readonly verified: boolean;
}

interface DownloadResult {
  readonly page_id: string;
  readonly url: string;
  readonly bildvisning_url: string;
  readonly path: string;
  readonly bytes: number;
  readonly format: string;
  readonly skipped: boolean;
  readonly cache_hit: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCacheDir(ctx: RecordCommandContext): string {
  const specific = ctx.env.KINLOOM_SE_ARCHIVES_CACHE_DIR;
  if (specific && specific.trim().length > 0) {
    return path.resolve(expandHomePath(specific, ctx.env));
  }
  const shared = ctx.env.KINLOOM_CACHE_DIR;
  if (shared && shared.trim().length > 0) {
    return path.resolve(expandHomePath(shared, ctx.env), 'se-archives');
  }
  return resolveCacheDir({
    env: ctx.env,
    envVars: [],
    defaultSubdir: path.join('kinloom', 'se-archives'),
  });
}

function resolveTtlHours(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS'
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

async function requestWithRetry(
  ctx: RecordCommandContext,
  options: {
    readonly url: string;
    readonly allowedHosts?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
  }
): Promise<{
  readonly status: number;
  readonly url: string;
  readonly headers: Headers;
  readonly bytes: Buffer;
}> {
  const allowedHosts = options.allowedHosts ?? ALLOWED_API_HOSTS;
  validateSeUrl(options.url, allowedHosts);
  try {
    const res = await httpRequest(options.url, {
      method: 'GET',
      headers: options.headers,
      userAgent: DEFAULT_USER_AGENT,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxAttempts: MAX_HTTP_ATTEMPTS,
      baseBackoffMs: RETRY_BASE_MS,
      retryStatuses: TRANSIENT_STATUS_CODES,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts },
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
      throwOnHttpError: false,
    });
    validateSeUrl(res.url, allowedHosts);
    if (res.status >= 400) {
      throw new RecordRuntimeError(`HTTP ${res.status} from ${res.url}`);
    }
    return res;
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      let host = '';
      try {
        host = new URL(err.url).hostname.toLowerCase();
      } catch {
        host = err.url;
      }
      throw new CliValidationError(
        `Refusing host '${host}'; allowed hosts: ${[...allowedHosts].toSorted().join(', ')}.`
      );
    }
    if (err instanceof CliValidationError || err instanceof RecordRuntimeError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Riksarkivet request failed: ${message}`);
  }
}

function validateYearRange(yearMin: number | undefined, yearMax: number | undefined): void {
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

function validatePaging(limit: number, offset: number): void {
  if (limit < 1 || limit > 100) {
    throw new CliValidationError('--limit must be between 1 and 100.');
  }
  if (offset < 0) {
    throw new CliValidationError('--offset must be >= 0.');
  }
}

function firstLangText(value: unknown): string {
  if (typeof value === 'string') {
    return collapseWhitespace(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        return collapseWhitespace(item);
      }
    }
    return '';
  }
  if (isPlainRecord(value)) {
    for (const lang of ['sv', 'en', 'none']) {
      const vals = value[lang];
      if (Array.isArray(vals) && vals.length > 0) {
        return collapseWhitespace(String(vals[0]));
      }
      if (typeof vals === 'string' && vals.trim()) {
        return collapseWhitespace(vals);
      }
    }
    for (const vals of Object.values(value)) {
      if (Array.isArray(vals) && vals.length > 0) {
        return collapseWhitespace(String(vals[0]));
      }
    }
  }
  return '';
}

function allLangTexts(value: unknown): string[] {
  if (typeof value === 'string') {
    const clean = collapseWhitespace(value);
    return clean ? [clean] : [];
  }
  if (isPlainRecord(value)) {
    for (const lang of ['sv', 'en', 'none']) {
      const vals = value[lang];
      if (Array.isArray(vals) && vals.length > 0) {
        return vals.map((v) => collapseWhitespace(String(v))).filter((v) => v.length > 0);
      }
    }
    for (const vals of Object.values(value)) {
      if (Array.isArray(vals) && vals.length > 0) {
        return vals.map((v) => collapseWhitespace(String(v))).filter((v) => v.length > 0);
      }
    }
  }
  return [];
}

function stripLeadingUnderscores(value: string): string {
  return value.replace(/^_+/, '');
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

function normalizeHttps(url: string): string {
  if (url.startsWith('http://data.riksarkivet.se/')) {
    return `https://${url.slice('http://'.length)}`;
  }
  return url;
}

function extractCaptionList(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of items) {
    if (isPlainRecord(entry) && typeof entry.caption === 'string' && entry.caption.trim()) {
      out.push(entry.caption.trim());
    }
  }
  return out;
}

function normalizeSearchItem(raw: Record<string, unknown>): NormalizedSearchItem {
  const itemId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const objType = typeof raw.objectType === 'string' ? raw.objectType.trim() : '';
  const recType = typeof raw.type === 'string' ? raw.type.trim() : '';
  const meta = isPlainRecord(raw.metadata) ? raw.metadata : {};
  const links = isPlainRecord(raw._links) ? raw._links : {};

  const hierarchy = extractCaptionList(meta.hierarchy);
  const institutions = extractCaptionList(meta.archivalInstitution);
  let caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
  if (!caption) {
    if (hierarchy.length > 0) {
      caption = hierarchy.join(' / ');
    } else if (meta.parish && meta.fathersName) {
      caption = `${String(meta.fathersName)} (${String(meta.parish)})`;
    } else if (meta.referenceCode) {
      caption = String(meta.referenceCode);
    }
  }

  const iiifManifests: string[] = [];
  const rawImages = links.image;
  if (Array.isArray(rawImages)) {
    for (const img of rawImages) {
      if (typeof img === 'string' && img.startsWith('https://lbiiif.riksarkivet.se/')) {
        iiifManifests.push(img);
      }
    }
  } else if (typeof rawImages === 'string' && rawImages.startsWith('https://lbiiif.riksarkivet.se/')) {
    iiifManifests.push(rawImages);
  }

  const snippets: SearchSnippet[] = [];
  const transcribed = raw.transcribedText;
  if (isPlainRecord(transcribed) && Array.isArray(transcribed.snippets)) {
    for (const snip of transcribed.snippets.slice(0, 5)) {
      if (!isPlainRecord(snip)) {
        continue;
      }
      const text = String(snip.text ?? '')
        .replace(EM_TAG_RE, '')
        .trim();
      const pages: string[] = [];
      if (Array.isArray(snip.pages)) {
        for (const pg of snip.pages) {
          if (isPlainRecord(pg) && pg.id) {
            pages.push(stripLeadingUnderscores(String(pg.id)));
          }
        }
      }
      snippets.push({ text, pages });
      for (const pgId of pages) {
        const volId = pgId.split('_', 1)[0];
        const manifestUrl = `${IIIF_BASE}/arkis!${volId}/manifest`;
        if (!iiifManifests.includes(manifestUrl)) {
          iiifManifests.push(manifestUrl);
        }
      }
    }
  }

  const out: Record<string, unknown> = {
    id: itemId,
    object_type: objType,
    type: recType,
    caption,
    reference_code: typeof meta.referenceCode === 'string' ? meta.referenceCode.trim() : '',
    date: String(meta.date ?? meta.year ?? '').trim(),
    parish: typeof meta.parish === 'string' ? meta.parish.trim() : '',
    institution: institutions[0] ?? '',
    digitized: Boolean(meta.onlyDigitisedMaterials) || iiifManifests.length > 0,
  };

  if (hierarchy.length > 0) {
    out.hierarchy = hierarchy;
  }
  if (meta.note) {
    out.note = String(meta.note).trim();
  }
  const extraFields: readonly (readonly [string, string])[] = [
    ['childsName', 'child_name'],
    ['fathersName', 'father'],
    ['mothersName', 'mother'],
    ['groomsName', 'groom'],
    ['bridesName', 'bride'],
    ['propertyName', 'property_name'],
    ['taxUnit', 'tax_unit'],
    ['districtCourtSessions', 'court_session'],
  ];
  for (const [srcKey, dstKey] of extraFields) {
    if (meta[srcKey]) {
      out[dstKey] = String(meta[srcKey]).trim();
    }
  }
  if (snippets.length > 0) {
    out.snippets = snippets;
  }
  if (iiifManifests.length > 0) {
    out.iiif_manifests = iiifManifests;
  }
  if (typeof links.self === 'string') {
    out.self_url = normalizeHttps(links.self);
  }
  if ((objType === 'Record' || objType === 'RecordSet') && itemId) {
    out.iiif_collection_url = `${IIIF_COLLECTION_BASE}/${itemId}`;
  }

  return out as unknown as NormalizedSearchItem;
}

async function fetchRecordsEndpoint(
  ctx: RecordCommandContext,
  baseUrl: string,
  params: Readonly<Record<string, string | number>>
): Promise<SearchEndpointResult> {
  const target = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    target.searchParams.set(k, String(v));
  }
  const res = await requestWithRetry(ctx, {
    url: target.toString(),
    headers: { Accept: 'application/json' },
  });
  let body: unknown;
  try {
    body = JSON.parse(res.bytes.toString('utf8'));
  } catch {
    throw new RecordRuntimeError(`Riksarkivet API returned non-JSON response from ${baseUrl}`);
  }
  if (!isPlainRecord(body) || !Array.isArray(body.items)) {
    throw new RecordRuntimeError(`Unexpected Riksarkivet API payload from ${baseUrl}`);
  }
  const items = body.items
    .filter((it): it is Record<string, unknown> => isPlainRecord(it))
    .map(normalizeSearchItem);
  return {
    total: Number(body.totalHits ?? 0),
    hits: Number(body.hits ?? items.length),
    offset: Number(body.offset ?? params.offset ?? 0),
    results: items,
    verified: true,
  };
}

async function fetchRegisterDetail(
  ctx: RecordCommandContext,
  cleanId: string
): Promise<RegisterDetailResult> {
  const url = `${REGISTER_BASE_URL}/${encodeURIComponent(cleanId)}`;
  const res = await requestWithRetry(ctx, {
    url,
    headers: { Accept: 'application/json' },
  });
  let body: unknown;
  try {
    body = JSON.parse(res.bytes.toString('utf8'));
  } catch {
    throw new RecordRuntimeError(`Riksarkivet register endpoint returned non-JSON for ${cleanId}`);
  }
  if (!isPlainRecord(body)) {
    throw new RecordRuntimeError(`Unexpected register detail payload for ${cleanId}`);
  }
  return {
    id: cleanId,
    url,
    record: body,
    verified: true,
  };
}

async function fetchIiifCollection(
  ctx: RecordCommandContext,
  cleanId: string
): Promise<IiifCollectionResult> {
  const url = `${IIIF_COLLECTION_BASE}/${encodeURIComponent(cleanId)}`;
  const res = await requestWithRetry(ctx, {
    url,
    headers: { Accept: 'application/json' },
  });
  let body: unknown;
  try {
    body = JSON.parse(res.bytes.toString('utf8'));
  } catch {
    throw new RecordRuntimeError(`Riksarkivet IIIF collection returned non-JSON for ${cleanId}`);
  }
  if (!isPlainRecord(body) || body.type !== 'Collection') {
    throw new RecordRuntimeError(`Unexpected IIIF Collection payload for ${cleanId}`);
  }

  const summaryLines = allLangTexts(body.summary);
  let referenceCode = '';
  let institution = '';
  let dateText = '';
  for (const line of summaryLines) {
    if (line.startsWith('Referenskod:')) {
      referenceCode = line.slice('Referenskod:'.length).trim();
    } else if (line.startsWith('Arkivinstitution:')) {
      institution = line.slice('Arkivinstitution:'.length).trim();
    } else if (line.startsWith('Datering:')) {
      dateText = line.slice('Datering:'.length).trim();
    }
  }

  const parsedItems: CollectionItem[] = [];
  const rawItems = Array.isArray(body.items) ? body.items : [];
  for (const entry of rawItems) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const itemUrl = typeof entry.id === 'string' ? entry.id.trim() : '';
    const itemType = typeof entry.type === 'string' ? entry.type.trim() : '';
    const itemLabel = firstLangText(entry.label);
    let archiveId: string | undefined;
    let bildid: string | undefined;
    if (itemUrl) {
      try {
        const parsedPath = new URL(itemUrl).pathname;
        if (itemType === 'Collection') {
          const parts = parsedPath.split('/').filter((p) => p.length > 0);
          archiveId = parts.at(-1);
        } else if (itemType === 'Manifest') {
          const match = ARKIS_MANIFEST_RE.exec(parsedPath);
          if (match) {
            bildid = stripLeadingUnderscores(match[1]);
          }
        }
      } catch {
        // Ignore malformed item URL.
      }
    }
    parsedItems.push({
      type: itemType,
      label: itemLabel,
      url: itemUrl,
      ...(archiveId ? { archive_id: archiveId } : {}),
      ...(bildid ? { bildid } : {}),
    });
  }

  return {
    archive_id: cleanId,
    url,
    label: firstLangText(body.label),
    reference_code: referenceCode,
    institution,
    date: dateText,
    count: parsedItems.length,
    items: parsedItems,
    verified: true,
  };
}

function extractCanvasInfo(index: number, canvas: Record<string, unknown>): CanvasInfo {
  const canvasId = typeof canvas.id === 'string' ? canvas.id.trim() : '';
  let pageId = '';
  if (canvasId) {
    try {
      const match = ARKIS_MANIFEST_RE.exec(new URL(canvasId).pathname);
      if (match) {
        pageId = stripLeadingUnderscores(match[1]);
      }
    } catch {
      // Ignore invalid canvas URL.
    }
  }

  let bildvisningUrl = pageId ? `${BILDVISNING_BASE}/${pageId}` : '';
  let sourceRef = '';
  const metaList = Array.isArray(canvas.metadata) ? canvas.metadata : [];
  for (const meta of metaList) {
    if (!isPlainRecord(meta)) {
      continue;
    }
    const label = firstLangText(meta.label).toLowerCase();
    const val = firstLangText(meta.value);
    if ((label === 'bildid' || label === 'image id') && val) {
      pageId = stripLeadingUnderscores(val);
    } else if ((label === 'länk' || label === 'link') && val.startsWith('https://')) {
      bildvisningUrl = val;
    } else if ((label === 'källhänvisning' || label === 'source reference') && val) {
      sourceRef = val;
    }
  }

  const imageBase = pageId ? `${IIIF_BASE}/arkis!${pageId}` : '';
  const fullImageUrl = imageBase ? `${imageBase}/full/max/0/default.jpg` : '';
  return {
    index,
    page_id: pageId,
    label: firstLangText(canvas.label) || `Image ${index}`,
    width: Number(canvas.width ?? 0),
    height: Number(canvas.height ?? 0),
    bildvisning_url: bildvisningUrl,
    source_reference: sourceRef,
    iiif_image_base: imageBase,
    full_image_url: fullImageUrl,
  };
}

async function fetchIiifManifest(ctx: RecordCommandContext, volumeId: string): Promise<IiifManifestResult> {
  const url = `${IIIF_BASE}/arkis!${encodeURIComponent(volumeId)}/manifest`;
  let res: {
    readonly status: number;
    readonly url: string;
    readonly headers: Headers;
    readonly bytes: Buffer;
  };
  try {
    res = await requestWithRetry(ctx, {
      url,
      allowedHosts: ALLOWED_DOWNLOAD_HOSTS,
      headers: { Accept: 'application/json' },
    });
  } catch (err: unknown) {
    if (err instanceof RecordRuntimeError && err.message.includes('HTTP 403')) {
      throw new RecordRuntimeError(
        `HTTP 403 from ${url}: this volume is restricted on the public IIIF endpoint (check ${BILDVISNING_BASE}/${volumeId} in a browser).`
      );
    }
    throw err;
  }

  let body: unknown;
  try {
    body = JSON.parse(res.bytes.toString('utf8'));
  } catch {
    throw new RecordRuntimeError(`Riksarkivet IIIF manifest returned non-JSON from ${url}`);
  }
  if (!isPlainRecord(body) || body.type !== 'Manifest') {
    throw new RecordRuntimeError(`Unexpected IIIF Manifest payload from ${url}`);
  }

  const metadata: Record<string, string> = {};
  const rawMeta = Array.isArray(body.metadata) ? body.metadata : [];
  for (const entry of rawMeta) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const k = firstLangText(entry.label);
    const v = firstLangText(entry.value);
    if (k && v) {
      metadata[k] = v;
    }
  }

  const rawCanvases = Array.isArray(body.items) ? body.items : [];
  const canvases: CanvasInfo[] = [];
  rawCanvases.forEach((canvas, idx) => {
    if (isPlainRecord(canvas)) {
      canvases.push(extractCanvasInfo(idx + 1, canvas));
    }
  });

  return {
    bildid: volumeId,
    manifest_url: url,
    bildvisning_url: `${BILDVISNING_BASE}/${volumeId}`,
    label: firstLangText(body.label),
    metadata,
    canvas_count: canvases.length,
    canvases,
    verified: true,
  };
}

export function detectImageFormat(data: Uint8Array): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpeg';
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'png';
  }
  if (
    data.length >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38 &&
    (data[4] === 0x37 || data[4] === 0x39) &&
    data[5] === 0x61
  ) {
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
  const head = Buffer.from(data.subarray(0, 512)).toString('utf8').trimStart().toLowerCase();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<?xml') ||
    head.startsWith('<head') ||
    head.startsWith('<body')
  );
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
    const resolvedDir = path.resolve(expanded);
    const candidate = path.resolve(resolvedDir, safeLeaf);
    const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : `${resolvedDir}${path.sep}`;
    if (!candidate.startsWith(prefix)) {
      throw new CliValidationError(`Output path escapes target directory: ${candidate}`);
    }
    return candidate;
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

function formatSearchText(title: string, result: SearchEndpointResult, cacheHit: boolean): string {
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${title} | total=${result.total} | offset=${result.offset} | showing ${result.results.length}${marker}`,
  ];
  for (const item of result.results) {
    const parts: string[] = [item.type || item.object_type || 'Record', item.caption || '(untitled)'];
    if (item.date) parts.push(item.date);
    if (item.parish) parts.push(item.parish);
    if (item.reference_code) parts.push(item.reference_code);
    if (item.father) parts.push(`father: ${item.father}`);
    if (item.mother) parts.push(`mother: ${item.mother}`);
    if (item.groom) parts.push(`groom: ${item.groom}`);
    if (item.bride) parts.push(`bride: ${item.bride}`);
    if (item.digitized) parts.push('[digitized]');
    if (item.id) parts.push(`id=${item.id}`);
    lines.push(parts.join(' | '));
    if (item.iiif_manifests && item.iiif_manifests.length > 0) {
      lines.push(`    iiif: ${item.iiif_manifests[0]}`);
    }
    for (const snip of (item.snippets ?? []).slice(0, 2)) {
      const pageStr = snip.pages.length > 0 ? ` [${snip.pages.join(', ')}]` : '';
      const excerpt = snip.text.length > 160 ? `${snip.text.slice(0, 157)}...` : snip.text;
      lines.push(`    text${pageStr}: ${excerpt}`);
    }
  }
  return lines.join('\n');
}

const CACHE_AND_JSON_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request and write the fresh response.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'text',
    kind: 'string',
    flags: ['--text'],
    default: '',
    help: 'Free-text query across titles, notes, and metadata.',
  },
  { key: 'name', kind: 'string', flags: ['--name'], default: '', help: 'Person or organization name query.' },
  {
    key: 'place',
    kind: 'string',
    flags: ['--place'],
    default: '',
    help: 'Parish, town, or county name query.',
  },
  {
    key: 'transcribed',
    kind: 'string',
    flags: ['--transcribed'],
    default: '',
    help: 'Search HTR transcripts across digitized volumes.',
  },
  {
    key: 'recordType',
    kind: 'string',
    flags: ['--type'],
    choices: ['all', ...Object.keys(RECORD_TYPE_FACETS).toSorted()],
    default: 'all',
    help: 'Filter by record type (default: all).',
  },
  {
    key: 'facet',
    kind: 'string',
    flags: ['--facet'],
    default: '',
    help: 'Raw Riksarkivet facet string override.',
  },
  {
    key: 'digitized',
    kind: 'boolean',
    flags: ['--digitized'],
    help: 'Limit results to digitized materials.',
  },
  { key: 'yearMin', kind: 'integer', flags: ['--year-min'], metavar: 'YYYY', help: 'Earliest year (YYYY).' },
  { key: 'yearMax', kind: 'integer', flags: ['--year-max'], metavar: 'YYYY', help: 'Latest year (YYYY).' },
  {
    key: 'sort',
    kind: 'string',
    flags: ['--sort'],
    choices: ['relevance', 'alphaAsc', 'alphaDesc', 'timeAsc', 'timeDesc'],
    default: 'relevance',
    help: 'Sort order (default: relevance).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 20,
    help: 'Results per page, 1-100 (default: 20).',
  },
  {
    key: 'offset',
    kind: 'integer',
    flags: ['--offset'],
    default: 0,
    help: '0-based result offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

const BIRTHS_OPTIONS: readonly OptionSpec[] = [
  { key: 'first', kind: 'string', flags: ['--first'], default: '', help: "Child's given name." },
  { key: 'father', kind: 'string', flags: ['--father'], default: '', help: "Father's name." },
  { key: 'mother', kind: 'string', flags: ['--mother'], default: '', help: "Mother's name." },
  { key: 'place', kind: 'string', flags: ['--place'], default: '', help: 'Parish or birth place.' },
  { key: 'witness', kind: 'string', flags: ['--witness'], default: '', help: 'Baptismal witness name.' },
  {
    key: 'gender',
    kind: 'string',
    flags: ['--gender'],
    default: '',
    help: 'Gender (Kvinna/female, Man/male, Okänt/unknown).',
  },
  {
    key: 'yearMin',
    kind: 'integer',
    flags: ['--year-min'],
    metavar: 'YYYY',
    help: 'Earliest birth year (YYYY).',
  },
  {
    key: 'yearMax',
    kind: 'integer',
    flags: ['--year-max'],
    metavar: 'YYYY',
    help: 'Latest birth year (YYYY).',
  },
  {
    key: 'sort',
    kind: 'string',
    flags: ['--sort'],
    choices: ['first_name', 'date'],
    default: 'date',
    help: 'Sort order (default: date).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 20,
    help: 'Results per page, 1-100 (default: 20).',
  },
  {
    key: 'offset',
    kind: 'integer',
    flags: ['--offset'],
    default: 0,
    help: '0-based result offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

const MARRIAGES_OPTIONS: readonly OptionSpec[] = [
  { key: 'groom', kind: 'string', flags: ['--groom'], default: '', help: "Groom's name." },
  { key: 'bride', kind: 'string', flags: ['--bride'], default: '', help: "Bride's name." },
  { key: 'groomPlace', kind: 'string', flags: ['--groom-place'], default: '', help: "Groom's home place." },
  { key: 'bridePlace', kind: 'string', flags: ['--bride-place'], default: '', help: "Bride's home place." },
  { key: 'parish', kind: 'string', flags: ['--parish'], default: '', help: 'Marriage parish.' },
  { key: 'county', kind: 'string', flags: ['--county'], default: '', help: 'Swedish county (län).' },
  {
    key: 'yearMin',
    kind: 'integer',
    flags: ['--year-min'],
    metavar: 'YYYY',
    help: 'Earliest marriage year (YYYY).',
  },
  {
    key: 'yearMax',
    kind: 'integer',
    flags: ['--year-max'],
    metavar: 'YYYY',
    help: 'Latest marriage year (YYYY).',
  },
  {
    key: 'sort',
    kind: 'string',
    flags: ['--sort'],
    choices: ['grooms_name', 'brides_name', 'date'],
    default: 'date',
    help: 'Sort order (default: date).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 20,
    help: 'Results per page, 1-100 (default: 20).',
  },
  {
    key: 'offset',
    kind: 'integer',
    flags: ['--offset'],
    default: 0,
    help: '0-based result offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

const DEEDS_OPTIONS: readonly OptionSpec[] = [
  { key: 'parish', kind: 'string', flags: ['--parish'], default: '', help: 'Parish name.' },
  { key: 'propertyName', kind: 'string', flags: ['--property'], default: '', help: 'Farm or property name.' },
  {
    key: 'taxUnit',
    kind: 'string',
    flags: ['--tax-unit'],
    default: '',
    help: 'Tax assessment unit (mantal).',
  },
  { key: 'court', kind: 'string', flags: ['--court'], default: '', help: 'District court session (ting).' },
  { key: 'adminUnit', kind: 'string', flags: ['--admin-unit'], default: '', help: 'Administrative unit.' },
  { key: 'yearMin', kind: 'integer', flags: ['--year-min'], metavar: 'YYYY', help: 'Earliest year (YYYY).' },
  { key: 'yearMax', kind: 'integer', flags: ['--year-max'], metavar: 'YYYY', help: 'Latest year (YYYY).' },
  {
    key: 'sort',
    kind: 'string',
    flags: ['--sort'],
    choices: ['parish', 'year'],
    default: 'year',
    help: 'Sort order (default: year).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 20,
    help: 'Results per page, 1-100 (default: 20).',
  },
  {
    key: 'offset',
    kind: 'integer',
    flags: ['--offset'],
    default: 0,
    help: '0-based result offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

const MANIFEST_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 30,
    help: 'Canvases to show in text output (default: 30).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    help: '1-based page number when target is a volume bildid.',
  },
  {
    key: 'width',
    kind: 'integer',
    flags: ['--width'],
    help: 'Scaled pixel width (64-12000; default: full max).',
  },
  {
    key: 'full',
    kind: 'boolean',
    flags: ['--full'],
    help: 'Download full resolution (full/max/0/default.jpg).',
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['--out'],
    required: true,
    metavar: 'PATH',
    help: 'Output JPEG file path or directory.',
  },
  { key: 'overwrite', kind: 'boolean', flags: ['--overwrite'], help: 'Overwrite an existing output file.' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
];

const CENSUS_OPTIONS: readonly OptionSpec[] = [
  { key: 'surname', kind: 'string', flags: ['--surname'], default: '', help: 'Surname (Efternamn).' },
  { key: 'given', kind: 'string', flags: ['--given'], default: '', help: 'Given name (Fornamn).' },
  { key: 'birthYear', kind: 'integer', flags: ['--birth-year'], help: 'Birth year (1700-1930).' },
  { key: 'parish', kind: 'string', flags: ['--parish'], default: '', help: 'Home parish (Hemförsamling).' },
  {
    key: 'year',
    kind: 'integer',
    flags: ['--year'],
    help: 'Census year (1860, 1870, 1880, 1890, 1900, 1910, 1930).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
];

const SEARCH_SPEC: CommandParseSpec = { options: SEARCH_OPTIONS, allowPositionals: false };
const BIRTHS_SPEC: CommandParseSpec = { options: BIRTHS_OPTIONS, allowPositionals: false };
const MARRIAGES_SPEC: CommandParseSpec = { options: MARRIAGES_OPTIONS, allowPositionals: false };
const DEEDS_SPEC: CommandParseSpec = { options: DEEDS_OPTIONS, allowPositionals: false };
const RECORD_SPEC: CommandParseSpec = {
  options: CACHE_AND_JSON_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'record_id',
};
const COLLECTION_SPEC: CommandParseSpec = {
  options: CACHE_AND_JSON_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'archive_id',
};
const MANIFEST_SPEC: CommandParseSpec = {
  options: MANIFEST_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'target',
};
const DOWNLOAD_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'target',
};
const CENSUS_SPEC: CommandParseSpec = { options: CENSUS_OPTIONS, allowPositionals: false };

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives <command> [options]',
    summary: 'Search Swedish National Archives (Riksarkivet) open APIs and download IIIF scans.',
    subcommands: [
      { name: 'search', summary: 'Search archives, digitized volumes, registers, and HTR transcribed text.' },
      { name: 'births', summary: 'Search indexed birth records (Födelseregister).' },
      { name: 'marriages', summary: 'Search indexed marriage records (Vigselregister).' },
      { name: 'deeds', summary: 'Search indexed title deeds (Lagfartsregister).' },
      { name: 'record', summary: 'Fetch full JSON detail for a register record ID or URL.' },
      { name: 'collection', summary: 'Browse an archive or series IIIF Collection.' },
      { name: 'manifest', summary: "Inspect a digitized volume's IIIF Presentation v3 Manifest." },
      { name: 'download', summary: 'Download a verified IIIF page scan JPEG from lbiiif.riksarkivet.se.' },
      {
        name: 'census',
        summary: 'Build browser URLs for Swedish National Censuses (Folkräkningar 1860-1930).',
      },
    ],
  });
}

function isSearchEndpointResult(value: unknown): value is SearchEndpointResult {
  return isPlainRecord(value) && Array.isArray(value.results);
}

function isRegisterDetailResult(value: unknown): value is RegisterDetailResult {
  return isPlainRecord(value) && isPlainRecord(value.record);
}

function isIiifCollectionResult(value: unknown): value is IiifCollectionResult {
  return isPlainRecord(value) && Array.isArray(value.items);
}

function isIiifManifestResult(value: unknown): value is IiifManifestResult {
  return isPlainRecord(value) && Array.isArray(value.canvases);
}

async function runSearch(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom se-archives search [options]',
          summary: 'Search Riksarkivet archives, digitized volumes, registers, and HTR transcribed text.',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const yearMin = getNumberOption(parsed, 'yearMin');
  const yearMax = getNumberOption(parsed, 'yearMax');
  validatePaging(limit, offset);
  validateYearRange(yearMin, yearMax);

  const params: Record<string, string | number> = {
    limit,
    offset,
    sort: getStringOption(parsed, 'sort') ?? 'relevance',
  };
  const text = (getStringOption(parsed, 'text') ?? '').trim();
  const name = (getStringOption(parsed, 'name') ?? '').trim();
  const place = (getStringOption(parsed, 'place') ?? '').trim();
  const transcribed = (getStringOption(parsed, 'transcribed') ?? '').trim();
  if (text) params.text = text;
  if (name) params.name = name;
  if (place) params.place = place;
  if (transcribed) {
    params.transcribed_text = transcribed;
    params.only_digitised_materials = 'true';
  }
  if (getBooleanOption(parsed, 'digitized')) {
    params.only_digitised_materials = 'true';
  }

  if (!('text' in params || 'name' in params || 'place' in params || 'transcribed_text' in params)) {
    throw new CliValidationError(
      'Provide at least one search term: --text, --name, --place, or --transcribed.'
    );
  }
  if (yearMin !== undefined) params.year_min = yearMin;
  if (yearMax !== undefined) params.year_max = yearMax;

  const facetOpt = (getStringOption(parsed, 'facet') ?? '').trim();
  const recordType = getStringOption(parsed, 'recordType') ?? 'all';
  if (facetOpt) {
    params.facet = facetOpt;
  } else if (recordType !== 'all') {
    const facet = RECORD_TYPE_FACETS[recordType];
    if (!facet) {
      throw new CliValidationError(`Unsupported --type: '${recordType}'`);
    }
    params.facet = facet;
  }

  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<SearchEndpointResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'records:search',
    payload: params,
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchRecordsEndpoint(ctx, RECORDS_API_URL, params),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isSearchEndpointResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatSearchText('Riksarkivet Search', result, cacheHit)),
    cacheHit,
  };
}

async function runBirths(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, BIRTHS_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom se-archives births [options]',
          summary: 'Search Riksarkivet indexed birth records (Födelseregister).',
          options: BIRTHS_OPTIONS,
        })
      ),
    };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const yearMin = getNumberOption(parsed, 'yearMin');
  const yearMax = getNumberOption(parsed, 'yearMax');
  validatePaging(limit, offset);
  validateYearRange(yearMin, yearMax);

  const params: Record<string, string | number> = {
    limit,
    offset,
    sort: getStringOption(parsed, 'sort') ?? 'date',
  };
  const first = (getStringOption(parsed, 'first') ?? '').trim();
  const father = (getStringOption(parsed, 'father') ?? '').trim();
  const mother = (getStringOption(parsed, 'mother') ?? '').trim();
  const place = (getStringOption(parsed, 'place') ?? '').trim();
  const witness = (getStringOption(parsed, 'witness') ?? '').trim();
  const gender = (getStringOption(parsed, 'gender') ?? '').trim();
  if (first) params.first_name = first;
  if (father) params.fathers_name = father;
  if (mother) params.mothers_name = mother;
  if (place) params.place = place;
  if (witness) params.baptismal_witness = witness;
  if (gender) {
    const mapped = GENDER_ALIASES[gender.toLowerCase()];
    if (!mapped) {
      throw new CliValidationError(
        `Invalid --gender '${gender}'; use Kvinna/female, Man/male, or Okänt/unknown.`
      );
    }
    params.gender = mapped;
  }
  if (yearMin !== undefined) params.year_min = yearMin;
  if (yearMax !== undefined) params.year_max = yearMax;

  if (
    !(
      'first_name' in params ||
      'fathers_name' in params ||
      'mothers_name' in params ||
      'place' in params ||
      'baptismal_witness' in params ||
      'year_min' in params ||
      'year_max' in params
    )
  ) {
    throw new CliValidationError(
      'Provide at least one filter (--first, --father, --mother, --place, --witness, or --year-min/--year-max).'
    );
  }

  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<SearchEndpointResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'records:births',
    payload: params,
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchRecordsEndpoint(ctx, BIRTHS_API_URL, params),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isSearchEndpointResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatSearchText('Riksarkivet Birth Records', result, cacheHit)),
    cacheHit,
  };
}

async function runMarriages(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, MARRIAGES_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom se-archives marriages [options]',
          summary: 'Search Riksarkivet indexed marriage records (Vigselregister).',
          options: MARRIAGES_OPTIONS,
        })
      ),
    };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const yearMin = getNumberOption(parsed, 'yearMin');
  const yearMax = getNumberOption(parsed, 'yearMax');
  validatePaging(limit, offset);
  validateYearRange(yearMin, yearMax);

  const params: Record<string, string | number> = {
    limit,
    offset,
    sort: getStringOption(parsed, 'sort') ?? 'date',
  };
  const groom = (getStringOption(parsed, 'groom') ?? '').trim();
  const bride = (getStringOption(parsed, 'bride') ?? '').trim();
  const groomPlace = (getStringOption(parsed, 'groomPlace') ?? '').trim();
  const bridePlace = (getStringOption(parsed, 'bridePlace') ?? '').trim();
  const parish = (getStringOption(parsed, 'parish') ?? '').trim();
  const county = (getStringOption(parsed, 'county') ?? '').trim();
  if (groom) params.grooms_name = groom;
  if (bride) params.brides_name = bride;
  if (groomPlace) params.grooms_home_place = groomPlace;
  if (bridePlace) params.brides_home_place = bridePlace;
  if (parish) params.parish = parish;
  if (county) params.county = county;
  if (yearMin !== undefined) params.year_min = yearMin;
  if (yearMax !== undefined) params.year_max = yearMax;

  if (
    !(
      'grooms_name' in params ||
      'brides_name' in params ||
      'grooms_home_place' in params ||
      'brides_home_place' in params ||
      'parish' in params ||
      'county' in params ||
      'year_min' in params ||
      'year_max' in params
    )
  ) {
    throw new CliValidationError(
      'Provide at least one filter (--groom, --bride, --parish, --county, or --year-min/--year-max).'
    );
  }

  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<SearchEndpointResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'records:marriages',
    payload: params,
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchRecordsEndpoint(ctx, MARRIAGES_API_URL, params),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isSearchEndpointResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatSearchText('Riksarkivet Marriage Records', result, cacheHit)),
    cacheHit,
  };
}

async function runDeeds(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DEEDS_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom se-archives deeds [options]',
          summary: 'Search Riksarkivet indexed title deeds (Lagfartsregister).',
          options: DEEDS_OPTIONS,
        })
      ),
    };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const yearMin = getNumberOption(parsed, 'yearMin');
  const yearMax = getNumberOption(parsed, 'yearMax');
  validatePaging(limit, offset);
  validateYearRange(yearMin, yearMax);

  const params: Record<string, string | number> = {
    limit,
    offset,
    sort: getStringOption(parsed, 'sort') ?? 'year',
  };
  const parish = (getStringOption(parsed, 'parish') ?? '').trim();
  const propertyName = (getStringOption(parsed, 'propertyName') ?? '').trim();
  const taxUnit = (getStringOption(parsed, 'taxUnit') ?? '').trim();
  const court = (getStringOption(parsed, 'court') ?? '').trim();
  const adminUnit = (getStringOption(parsed, 'adminUnit') ?? '').trim();
  if (parish) params.parish = parish;
  if (propertyName) params.property_name = propertyName;
  if (taxUnit) params.tax_unit = taxUnit;
  if (court) params.district_court_sessions = court;
  if (adminUnit) params.administrative_unit = adminUnit;
  if (yearMin !== undefined) params.year_min = yearMin;
  if (yearMax !== undefined) params.year_max = yearMax;

  if (
    !(
      'parish' in params ||
      'property_name' in params ||
      'tax_unit' in params ||
      'district_court_sessions' in params ||
      'administrative_unit' in params ||
      'year_min' in params ||
      'year_max' in params
    )
  ) {
    throw new CliValidationError(
      'Provide at least one filter (--parish, --property, --court, or --year-min/--year-max).'
    );
  }

  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<SearchEndpointResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'records:deeds',
    payload: params,
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchRecordsEndpoint(ctx, DEEDS_API_URL, params),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isSearchEndpointResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatSearchText('Riksarkivet Title Deeds Index', result, cacheHit)),
    cacheHit,
  };
}

async function runRecord(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, RECORD_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom se-archives record <RECORD_ID> [options]',
          summary: 'Fetch full JSON detail for a register record ID or URL.',
          options: CACHE_AND_JSON_OPTIONS,
        })
      ),
    };
  }
  const cleanId = parseRegisterId(parsed.positionals[0]);
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<RegisterDetailResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'register:detail',
    payload: { id: cleanId },
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchRegisterDetail(ctx, cleanId),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isRegisterDetailResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`Riksarkivet Register Record (${cleanId})${marker}`];
  for (const [key, value] of Object.entries(result.record)) {
    if (value !== null && value !== undefined && value !== '' && value !== '-') {
      lines.push(`  ${key}: ${String(value)}`);
    }
  }
  lines.push(`  url: ${result.url}`);
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runCollection(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, COLLECTION_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom se-archives collection <ARCHIVE_ID> [options]',
          summary: 'Browse an archive or series IIIF Collection.',
          options: CACHE_AND_JSON_OPTIONS,
        })
      ),
    };
  }
  const cleanId = parseArchiveId(parsed.positionals[0]);
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<IiifCollectionResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'iiif:collection',
    payload: { archive_id: cleanId },
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchIiifCollection(ctx, cleanId),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isIiifCollectionResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${result.label || cleanId} | items=${result.count}${marker}`];
  if (result.reference_code) lines.push(`  Reference: ${result.reference_code}`);
  if (result.institution) lines.push(`  Institution: ${result.institution}`);
  if (result.date) lines.push(`  Date: ${result.date}`);
  for (const item of result.items) {
    const ident = item.bildid ?? item.archive_id ?? '';
    lines.push(`  [${item.type}] ${item.label} | id=${ident} | ${item.url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runManifest(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, MANIFEST_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom se-archives manifest <TARGET> [options]',
          summary: "Inspect a digitized volume's IIIF Presentation v3 Manifest.",
          options: MANIFEST_OPTIONS,
        })
      ),
    };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 30;
  if (limit < 1) {
    throw new CliValidationError('--limit must be >= 1.');
  }
  const [volId] = normalizeBildid(parsed.positionals[0]);
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<IiifManifestResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'iiif:manifest',
    payload: { bildid: volId },
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchIiifManifest(ctx, volId),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isIiifManifestResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${result.label || volId} | canvases=${result.canvas_count}${marker}`,
    `  Manifest: ${result.manifest_url}`,
    `  Viewer: ${result.bildvisning_url}`,
  ];
  for (const [k, v] of Object.entries(result.metadata)) {
    lines.push(`  ${k}: ${v}`);
  }
  for (const canvas of result.canvases.slice(0, limit)) {
    const dims = canvas.width ? `${canvas.width}x${canvas.height}` : '';
    lines.push(`  p.${canvas.index} | ${canvas.page_id} | ${dims} | ${canvas.full_image_url}`);
  }
  if (result.canvas_count > limit) {
    lines.push(`  ... (${result.canvas_count - limit} more pages; pass --limit or --json to view all)`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom se-archives download <TARGET> --out <PATH> [options]',
          summary: 'Download a verified IIIF page scan JPEG from lbiiif.riksarkivet.se.',
          options: DOWNLOAD_OPTIONS,
        })
      ),
    };
  }
  const target = parsed.positionals[0];
  const out = getStringOption(parsed, 'out') ?? '';
  const page = getNumberOption(parsed, 'page');
  const width = getNumberOption(parsed, 'width');
  const full = getBooleanOption(parsed, 'full');
  const overwrite = getBooleanOption(parsed, 'overwrite');
  const asJson = getBooleanOption(parsed, 'asJson');

  const [url, pageId] = buildIiifImageUrl(target, { page, width, full });
  const dest = resolveSafeOutputPath(out, `${pageId}.jpg`, ctx.env);

  let info: DownloadResult;
  if (fs.existsSync(dest) && !overwrite) {
    const data = fs.readFileSync(dest);
    const fmt = detectImageFormat(data);
    if (!fmt) {
      throw new RecordRuntimeError(
        `Existing file at ${dest} is not a valid image; pass --overwrite to replace.`
      );
    }
    info = {
      page_id: pageId,
      url,
      bildvisning_url: `${BILDVISNING_BASE}/${pageId}`,
      path: dest,
      bytes: data.length,
      format: fmt,
      skipped: true,
      cache_hit: true,
    };
  } else {
    const res = await requestWithRetry(ctx, {
      url,
      allowedHosts: ALLOWED_DOWNLOAD_HOSTS,
      headers: { Accept: 'image/jpeg,image/png,image/*;q=0.9' },
    });
    const contentType = res.headers.get('content-type') ?? '';
    const payload = res.bytes;
    if (payload.length === 0) {
      throw new RecordRuntimeError(`Refusing empty response body from ${url}`);
    }
    if (looksLikeHtmlPayload(payload, contentType)) {
      throw new RecordRuntimeError(
        `Refusing to save HTML response (Content-Type: ${contentType || 'unknown'}) as an image from ${url}`
      );
    }
    const fmt = detectImageFormat(payload);
    if (!fmt) {
      throw new RecordRuntimeError(
        `Refusing non-image payload (Content-Type: ${contentType || 'unknown'}) from ${url}`
      );
    }
    atomicWriteFileSync(dest, payload);
    info = {
      page_id: pageId,
      url,
      bildvisning_url: `${BILDVISNING_BASE}/${pageId}`,
      path: dest,
      bytes: payload.length,
      format: fmt,
      skipped: false,
      cache_hit: false,
    };
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, info),
      cacheHit: info.cache_hit,
    };
  }
  const verb = info.skipped ? 'Exists (skip)' : 'Downloaded';
  const lines = [
    `${verb}: ${info.path} (${info.bytes.toLocaleString('en-US')} bytes, ${info.format})`,
    `  Source: ${info.url}`,
    `  Viewer: ${info.bildvisning_url}`,
  ];
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: info.cache_hit,
  };
}

function runCensus(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, CENSUS_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom se-archives census [options]',
          summary:
            'Build browser URLs for Swedish National Censuses (Folkräkningar 1860-1930; CAPTCHA-gated web UI).',
          options: CENSUS_OPTIONS,
        })
      ),
    };
  }

  const surname = (getStringOption(parsed, 'surname') ?? '').trim();
  const given = (getStringOption(parsed, 'given') ?? '').trim();
  const birthYear = getNumberOption(parsed, 'birthYear');
  const parish = (getStringOption(parsed, 'parish') ?? '').trim();
  const year = getNumberOption(parsed, 'year');

  const query = new URLSearchParams({ AvanceradSok: 'False' });
  let hasFilter = false;
  if (surname) {
    query.set('Efternamn', surname);
    hasFilter = true;
  }
  if (given) {
    query.set('Fornamn', given);
    hasFilter = true;
  }
  if (birthYear !== undefined) {
    if (birthYear < 1700 || birthYear > 1930) {
      throw new CliValidationError('--birth-year must be between 1700 and 1930.');
    }
    query.set('Fodelsear', String(birthYear));
    hasFilter = true;
  }
  if (parish) {
    query.set('Hemforsamling', parish);
    hasFilter = true;
  }
  if (year !== undefined) {
    const flag = CENSUS_YEAR_FLAGS[year];
    if (!flag) {
      const valid = Object.keys(CENSUS_YEAR_FLAGS).join(', ');
      throw new CliValidationError(`Unsupported census --year ${year}; choose from: ${valid}.`);
    }
    query.set(flag, 'true');
    hasFilter = true;
  }

  const censusUrl = hasFilter ? `${FOLKRAKNINGAR_URL}?${query.toString()}` : FOLKRAKNINGAR_URL;
  const churchUrl = parish
    ? `${KYRKOARKIV_URL}?${new URLSearchParams({ Arkiv: parish, AvanceradSok: 'False' }).toString()}`
    : KYRKOARKIV_URL;

  const payload = {
    name: 'Riksarkivet Folkräkningar (Swedish National Censuses 1860-1930)',
    status: 'browser-only',
    reason: 'sok.riksarkivet.se redirects automated HTTP clients to /captcha.',
    census_url: censusUrl,
    church_archives_url: churchUrl,
    open_census_years: Object.keys(CENSUS_YEAR_FLAGS).map((k) => Number(k)),
  };

  if (getBooleanOption(parsed, 'asJson')) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const lines = [
    'Riksarkivet Folkräkningar (browser only):',
    `  Census search URL: ${censusUrl}`,
    `  Parish church archives URL: ${churchUrl}`,
    '  Open census years on sok.riksarkivet.se: 1860, 1870, 1880, 1890, 1900, 1910, 1930',
    '  Note: sok.riksarkivet.se web search endpoints enforce a CAPTCHA for automated clients.',
    '  Use `se-archives search`, `births`, `marriages`, `collection`, `manifest`, and `download`',
    '  for the open public data.riksarkivet.se and lbiiif.riksarkivet.se APIs.',
  ];
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

export const runSeArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'births':
        return await runBirths(rest, ctx);
      case 'marriages':
        return await runMarriages(rest, ctx);
      case 'deeds':
        return await runDeeds(rest, ctx);
      case 'record':
        return await runRecord(rest, ctx);
      case 'collection':
        return await runCollection(rest, ctx);
      case 'manifest':
        return await runManifest(rest, ctx);
      case 'download':
        return await runDownload(rest, ctx);
      case 'census':
        return runCensus(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom se-archives --script-help'.`);
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
