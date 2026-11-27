import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  cachedJsonCall,
  collapseWhitespace,
  emitJsonStdout,
  emitStdout,
  expandHomePath,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpRequest,
  loadHtml,
  parseCacheTtlHours,
  parseCommandArgs,
  RecordRuntimeError,
  type CommandParseSpec,
  type OptionSpec,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const USER_AGENT =
  'Kinloom/0.18 (genealogy research CLI; +https://github.com/tiberriver256/kinloom)';

const MNHS_BASE = 'https://www.mnhs.org';
const MNHS_PEOPLE_API = `${MNHS_BASE}/_hcms/api`;
const MNHS_PEOPLE_RECORD_URL = `${MNHS_BASE}/search/people/record`;
const MNHS_PEOPLE_SEARCH_URL = `${MNHS_BASE}/search/people`;

const NEWSPAPERS_BASE = 'https://newspapers.mnhs.org';
const NEWSPAPERS_SEARCH_URL = `${NEWSPAPERS_BASE}/jsp/PsSearchResults.jsp`;
const NEWSPAPERS_METADATA_URL = `${NEWSPAPERS_BASE}/jsp/PsMetadata.jsp`;
const NEWSPAPERS_VIEWER_URL = `${NEWSPAPERS_BASE}/jsp/PsImageViewer.jsp`;
const NEWSPAPERS_THUMB_URL = `${NEWSPAPERS_BASE}/servlet/PsObjThumb`;

const MDL_HOME_URL = 'https://collection.mndigital.org/';
const MDL_DPLA_URL = 'https://dp.la/search?partner=%22Minnesota+Digital+Library%22';

const ALLOWED_HOSTS = new Set<string>(['www.mnhs.org', 'newspapers.mnhs.org']);
const ALLOWED_DOWNLOAD_HOSTS = new Set<string>(['newspapers.mnhs.org']);
const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_HTTP_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

interface RecordTypeSpec {
  readonly alias: string;
  readonly label: string;
  readonly searchPath: string;
  readonly detailPath: string;
  readonly dateField: string | null;
  readonly countyField: string;
}

export const RECORD_TYPE_SPECS: Readonly<Record<string, RecordTypeSpec>> = {
  'death-records': {
    alias: 'death',
    label: 'Death Records (1904-2001)',
    searchPath: '/death/getAllDeathRecords',
    detailPath: '/death/getDeathRecordById',
    dateField: 'deathDateStart',
    countyField: 'county',
  },
  'birth-records': {
    alias: 'birth',
    label: 'Birth Records (1900-1934)',
    searchPath: '/birth/getAllBirthRecords',
    detailPath: '/birth/getBirthRecordById',
    dateField: 'birthDateStart',
    countyField: 'county',
  },
  census: {
    alias: 'census',
    label: 'Minnesota State Censuses (1849-1905)',
    searchPath: '/census/getAllCensusRecords',
    detailPath: '/census/getCensusRecordById',
    dateField: 'censusDateStart',
    countyField: 'county',
  },
  'vets-graves': {
    alias: 'vets',
    label: 'Veterans Graves Registration (1857-1975)',
    searchPath: '/vets-graves/getAllVetsGravesRecords',
    detailPath: '/vets-graves/vetsGravesRecordById',
    dateField: 'deathDateStart',
    countyField: 'burialLocation',
  },
  'gold-star': {
    alias: 'gold-star',
    label: 'WWI Gold Star Roll (1915-1921)',
    searchPath: '/gold-star/getAllGoldStarRecords',
    detailPath: '/gold-star/getGoldStarRecordById',
    dateField: 'deathDateStart',
    countyField: 'residencePriorToService',
  },
  'wwi-bonuses': {
    alias: 'wwi-bonuses',
    label: 'WWI Bonuses',
    searchPath: '/wwi-bonuses-record/getAllWwiBonusesRecord',
    detailPath: '/wwi-bonuses-record/wwiBonusesRecordById',
    dateField: null,
    countyField: 'residence',
  },
  'wwi-service': {
    alias: 'wwi-service',
    label: 'WWI Service Questionnaires',
    searchPath: '/wwi-service-record/getAllWwiServiceRecord',
    detailPath: '/wwi-service-record/wwiServiceRecordById',
    dateField: null,
    countyField: 'residencePriorToService',
  },
  'wwi-soldiers-photos': {
    alias: 'wwi-photos',
    label: 'WWI Soldier Photos',
    searchPath: '/wwi-soldier-photos-record/getAllWwiSoldierPhotosRecord',
    detailPath: '/wwi-soldier-photos-record/wwiSoldierPhotosRecordById',
    dateField: null,
    countyField: 'residence',
  },
};

const RECORD_TYPE_ALIASES: Readonly<Record<string, string>> = {
  death: 'death-records',
  deaths: 'death-records',
  'death-records': 'death-records',
  birth: 'birth-records',
  births: 'birth-records',
  'birth-records': 'birth-records',
  census: 'census',
  'state-census': 'census',
  vets: 'vets-graves',
  veterans: 'vets-graves',
  'vets-graves': 'vets-graves',
  'gold-star': 'gold-star',
  'wwi-bonuses': 'wwi-bonuses',
  'wwi-service': 'wwi-service',
  'wwi-photos': 'wwi-soldiers-photos',
  'wwi-soldiers-photos': 'wwi-soldiers-photos',
};

const NEWSPAPER_FIELD_MAP: Readonly<Record<string, string>> = {
  all: 'ALL',
  content: 'CONTENT',
  title: 'TITLE',
  place: 'PLACE_OF_PUBLICATION',
  county: 'SUBJECT_COUNTY',
  city: 'SUBJECT_CITY',
  date: 'DATE_PUBLISHED',
};

const MATCH_CHOICES = ['equals', 'starts-with', 'ends-with', 'contains', 'soundex'] as const;
const NEWSPAPER_FIELD_CHOICES = Object.keys(NEWSPAPER_FIELD_MAP).toSorted();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const DOC_ID_SAFE_RE = /^[A-Za-z0-9._/-]+$/;

export interface PeopleQueryClause {
  readonly field: string;
  readonly term: string;
  readonly op: string;
}

export interface PeopleQueryGroup {
  readonly conjunction: 'and' | 'or';
  readonly filters: readonly PeopleQueryClause[];
}

export interface PeopleQueryBody {
  readonly query: string;
  readonly sorts: readonly {
    readonly field: string;
    readonly direction: string;
    readonly sortNulls: string;
  }[];
  readonly filters: readonly (PeopleQueryClause | PeopleQueryGroup)[];
}

export interface NormalizedPeopleHit {
  readonly id: string;
  readonly record_type: string;
  readonly name: string;
  readonly first_name: string;
  readonly middle_name: string;
  readonly family_name: string;
  readonly certificate_id: string;
  readonly date: string;
  readonly county: string;
  readonly url: string;
  readonly mothers_maiden_name?: string;
  readonly birth_date?: string;
  readonly birth_place?: string;
  readonly age?: string;
  readonly locality?: string;
  readonly line?: unknown;
  readonly military_services?: readonly string[];
}

interface PeopleSearchResult {
  readonly record_type: string;
  readonly total: number;
  readonly page: number;
  readonly page_size: number;
  readonly page_count: number;
  readonly results: readonly NormalizedPeopleHit[];
  readonly verified: boolean;
}

interface PeopleRecordDetailResult {
  readonly record_type: string;
  readonly id: string;
  readonly summary: NormalizedPeopleHit;
  readonly record: Record<string, unknown>;
  readonly url: string;
  readonly verified: boolean;
}

export interface NewspaperSearchItem {
  title?: string;
  doc_id?: string;
  publication_date?: string;
  detail?: string;
  thumb_url?: string;
  viewer_url?: string;
  metadata_url?: string;
}

interface NewspaperSearchResult {
  readonly query: string;
  readonly field: string;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly results: readonly NewspaperSearchItem[];
  readonly verified: boolean;
}

interface NewspaperMetadataResult {
  readonly doc_id: string;
  readonly url: string;
  readonly viewer_url: string;
  readonly thumb_url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly verified: boolean;
}

interface DownloadResult {
  readonly url: string;
  readonly path: string;
  readonly bytes: number;
  readonly format: string;
  readonly skipped: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCacheDir(ctx: RecordCommandContext): string {
  const specific = ctx.env.KINLOOM_MN_ARCHIVES_CACHE_DIR;
  if (specific && specific.trim().length > 0) {
    return path.resolve(expandHomePath(specific, ctx.env));
  }
  const shared = ctx.env.KINLOOM_CACHE_DIR;
  if (shared && shared.trim().length > 0) {
    return path.resolve(expandHomePath(shared, ctx.env), 'mn-archives');
  }
  const home = ctx.env.HOME || os.homedir();
  return path.join(home, '.cache', 'kinloom', 'mn-archives');
}

function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS'
  );
}

export function validateMnUrl(
  rawUrl: string,
  allowedHosts: ReadonlySet<string> = ALLOWED_HOSTS
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CliValidationError(`Invalid URL: '${rawUrl}'`);
  }
  if (parsed.protocol !== 'https:') {
    throw new CliValidationError(`Refusing non-HTTPS URL: '${rawUrl}'`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    const allowed = [...allowedHosts].toSorted().join(', ');
    throw new CliValidationError(`Refusing host '${host}'; allowed hosts: ${allowed}.`);
  }
  if (parsed.username || parsed.password) {
    throw new CliValidationError('Refusing URL containing embedded credentials.');
  }
  return rawUrl;
}

export function resolveRecordType(raw: string): string {
  const key = raw.trim().toLowerCase();
  const resolved = RECORD_TYPE_ALIASES[key];
  if (!resolved) {
    const valid = Object.keys(RECORD_TYPE_SPECS).toSorted().join(', ');
    throw new CliValidationError(`Unknown record type '${raw}'. Choose from: ${valid}.`);
  }
  return resolved;
}

export function normalizeIsoDate(raw: string, endOfPeriod = false): string {
  const text = raw.trim();
  const match = ISO_DATE_RE.exec(text);
  if (!match) {
    throw new CliValidationError(
      `Invalid date '${raw}'; expected YYYY, YYYY-MM, or YYYY-MM-DD.`
    );
  }
  const year = Number.parseInt(match[1], 10);
  const month = match[2] ? Number.parseInt(match[2], 10) : endOfPeriod ? 12 : 1;
  if (month < 1 || month > 12) {
    throw new CliValidationError(`Invalid month in date '${raw}'.`);
  }
  let day: number;
  if (match[3]) {
    day = Number.parseInt(match[3], 10);
  } else if (endOfPeriod) {
    day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  } else {
    day = 1;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    throw new CliValidationError(`Invalid calendar date '${raw}'.`);
  }
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dateToUtcMillis(raw: string, endOfPeriod = false): number {
  const iso = normalizeIsoDate(raw, endOfPeriod);
  const [y, m, d] = iso.split('-').map((n) => Number.parseInt(n, 10));
  return Date.UTC(y, m - 1, d);
}

function nameFilter(field: string, value: string, match: string): PeopleQueryClause {
  const clean = value.trim();
  switch (match) {
    case 'equals':
      return { field, term: clean, op: '=' };
    case 'starts-with':
      return { field, term: `${clean}.*`, op: '*' };
    case 'ends-with':
      return { field, term: `.*${clean}`, op: '*' };
    case 'contains':
      return { field, term: `.*${clean}.*`, op: '*' };
    case 'soundex':
      return { field, term: clean, op: '$' };
    default:
      throw new CliValidationError(`Unsupported --match value: '${match}'`);
  }
}

function countyFilters(recordType: string, county: string): PeopleQueryClause[] {
  const clean = county.trim().replace(/\s+County$/i, '');
  if (!clean) {
    return [];
  }
  const spec = RECORD_TYPE_SPECS[recordType];
  const field = spec?.countyField || 'county';
  if (recordType === 'vets-graves') {
    const items: PeopleQueryClause[] = [{ field, term: `${clean}.*`, op: '*' }];
    if (clean.toLowerCase().startsWith('hennepin')) {
      items.push({ field, term: 'Fort Snelling.*', op: '*' });
    }
    return items;
  }
  if (
    recordType === 'gold-star' ||
    recordType === 'wwi-service' ||
    recordType === 'wwi-bonuses' ||
    recordType === 'wwi-soldiers-photos'
  ) {
    return [{ field, term: `.*${clean}.*`, op: '*' }];
  }
  return [{ field, term: `${clean}.*`, op: '*' }];
}

export interface PeopleQueryParams {
  readonly last?: string;
  readonly first?: string;
  readonly middle?: string;
  readonly motherMaiden?: string;
  readonly county?: string;
  readonly match?: string;
  readonly beginDate?: string;
  readonly endDate?: string;
  readonly certId?: string;
}

export function buildPeopleQuery(
  recordType: string,
  params: PeopleQueryParams
): PeopleQueryBody {
  const filters: (PeopleQueryClause | PeopleQueryGroup)[] = [];
  const certId = (params.certId ?? '').trim();
  if (certId) {
    filters.push({ field: 'certificateId', term: certId, op: '=' });
  } else {
    const match = params.match ?? 'equals';
    const nameClauses: PeopleQueryClause[] = [];
    if ((params.last ?? '').trim()) {
      nameClauses.push(nameFilter('familyName', params.last ?? '', match));
    }
    if ((params.first ?? '').trim()) {
      nameClauses.push(nameFilter('firstName', params.first ?? '', match));
    }
    if ((params.middle ?? '').trim()) {
      nameClauses.push(nameFilter('middleName', params.middle ?? '', match));
    }
    if ((params.motherMaiden ?? '').trim()) {
      if (recordType !== 'birth-records' && recordType !== 'death-records') {
        throw new CliValidationError(
          '--mother-maiden is only supported for birth-records and death-records.'
        );
      }
      nameClauses.push(nameFilter('mothersMaidenName', params.motherMaiden ?? '', match));
    }
    if (nameClauses.length > 0) {
      filters.push({ conjunction: 'and', filters: nameClauses });
    }

    if ((params.county ?? '').trim()) {
      const clauses = countyFilters(recordType, params.county ?? '');
      if (clauses.length > 0) {
        filters.push({ conjunction: 'or', filters: clauses });
      }
    }

    const dateField = RECORD_TYPE_SPECS[recordType]?.dateField ?? null;
    const dateClauses: PeopleQueryClause[] = [];
    if ((params.beginDate ?? '').trim()) {
      if (!dateField) {
        throw new CliValidationError(`Date filters are not supported for ${recordType}.`);
      }
      dateClauses.push({
        field: dateField,
        term: normalizeIsoDate(params.beginDate ?? '', false),
        op: '>=',
      });
    }
    if ((params.endDate ?? '').trim()) {
      if (!dateField) {
        throw new CliValidationError(`Date filters are not supported for ${recordType}.`);
      }
      dateClauses.push({
        field: dateField,
        term: normalizeIsoDate(params.endDate ?? '', true),
        op: '<=',
      });
    }
    if (dateClauses.length > 0) {
      filters.push({ conjunction: 'and', filters: dateClauses });
    }
  }

  if (filters.length === 0) {
    throw new CliValidationError(
      'Provide at least one filter (--last, --first, --county, --begin-year/--end-year, or --cert-id).'
    );
  }

  return {
    query: '',
    sorts: [
      { field: 'familyName', direction: 'asc', sortNulls: 'last' },
      { field: 'firstName', direction: 'asc', sortNulls: 'last' },
    ],
    filters,
  };
}

function trimIsoDate(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.split('T', 1)[0]?.trim() ?? '';
}

function stringField(raw: Record<string, unknown>, key: string): string {
  const val = raw[key];
  return typeof val === 'string' ? val : val !== null && val !== undefined ? String(val) : '';
}

function normalizePeopleHit(
  recordType: string,
  raw: Record<string, unknown>
): NormalizedPeopleHit {
  const recordId = stringField(raw, 'id').trim();
  const nameParts = [raw.firstName, raw.middleName, raw.familyName, raw.suffix]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim());
  const fullName = nameParts.join(' ');
  const dateField = RECORD_TYPE_SPECS[recordType]?.dateField ?? null;
  const primaryDate = dateField ? trimIsoDate(raw[dateField]) : '';
  const countyRaw =
    raw.county ?? raw.burialLocation ?? raw.residencePriorToService ?? raw.residence ?? '';
  const county = String(countyRaw ?? '').trim();
  const recordUrl = recordId
    ? `${MNHS_PEOPLE_RECORD_URL}?uuid=${encodeURIComponent(recordId)}&recordType=${encodeURIComponent(recordType)}`
    : MNHS_PEOPLE_SEARCH_URL;

  const base: NormalizedPeopleHit = {
    id: recordId,
    record_type: recordType,
    name: fullName,
    first_name: typeof raw.firstName === 'string' ? raw.firstName : '',
    middle_name: typeof raw.middleName === 'string' ? raw.middleName : '',
    family_name: typeof raw.familyName === 'string' ? raw.familyName : '',
    certificate_id: stringField(raw, 'certificateId'),
    date: primaryDate,
    county,
    url: recordUrl,
    ...(raw.mothersMaidenName
      ? { mothers_maiden_name: String(raw.mothersMaidenName) }
      : {}),
    ...(raw.birthDate ? { birth_date: trimIsoDate(raw.birthDate) } : {}),
    ...(raw.birthPlace ? { birth_place: String(raw.birthPlace) } : {}),
    ...(raw.age !== null && raw.age !== undefined && String(raw.age).trim()
      ? { age: String(raw.age).trim() }
      : {}),
    ...(raw.locality ? { locality: String(raw.locality).trim() } : {}),
    ...(raw.lineInImage !== null && raw.lineInImage !== undefined
      ? { line: raw.lineInImage }
      : {}),
  };

  if (Array.isArray(raw.militaryServices) && raw.militaryServices.length > 0) {
    const services: string[] = [];
    for (const item of raw.militaryServices) {
      if (isPlainRecord(item) && item.value) {
        services.push(String(item.value).trim());
      }
    }
    if (services.length > 0) {
      return { ...base, military_services: services };
    }
  }

  return base;
}

async function fetchPeopleSearch(
  ctx: RecordCommandContext,
  recordType: string,
  queryBody: PeopleQueryBody,
  page: number,
  limit: number
): Promise<PeopleSearchResult> {
  const spec = RECORD_TYPE_SPECS[recordType];
  const url = `${MNHS_PEOPLE_API}${spec.searchPath}?pageNum=${page}&pageSize=${limit}`;
  validateMnUrl(url, ALLOWED_HOSTS);
  const response = await httpRequest(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(queryBody),
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  let body: unknown;
  try {
    body = JSON.parse(response.bytes.toString('utf8')) as unknown;
  } catch {
    throw new RecordRuntimeError(`MNHS People API returned non-JSON response from ${url}`);
  }
  if (!isPlainRecord(body) || !(body.success === true || body.status === 200)) {
    throw new RecordRuntimeError(`MNHS People API returned unsuccessful status from ${url}`);
  }
  const data = body.data;
  if (!isPlainRecord(data)) {
    throw new RecordRuntimeError(`MNHS People API missing 'data' object from ${url}`);
  }
  const rawHits = data.hits;
  if (!Array.isArray(rawHits)) {
    throw new RecordRuntimeError(`MNHS People API missing 'hits' list from ${url}`);
  }
  const records = rawHits
    .filter((item): item is Record<string, unknown> => isPlainRecord(item))
    .map((item) => normalizePeopleHit(recordType, item));

  const total = Number(data.totalHitCount ?? 0) || 0;
  return {
    record_type: recordType,
    total,
    page: Number(data.pageNum ?? page) || page,
    page_size: Number(data.pageSize ?? limit) || limit,
    page_count: Number(data.pageCount ?? 0) || 0,
    results: records,
    verified: true,
  };
}

async function fetchPeopleRecord(
  ctx: RecordCommandContext,
  recordType: string,
  recordId: string
): Promise<PeopleRecordDetailResult> {
  const cleanId = recordId.trim();
  if (!UUID_RE.test(cleanId)) {
    throw new CliValidationError(`Invalid MNHS record UUID: '${recordId}'`);
  }
  const spec = RECORD_TYPE_SPECS[recordType];
  const url = `${MNHS_PEOPLE_API}${spec.detailPath}?id=${encodeURIComponent(cleanId)}`;
  validateMnUrl(url, ALLOWED_HOSTS);
  const response = await httpRequest(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  let body: unknown;
  try {
    body = JSON.parse(response.bytes.toString('utf8')) as unknown;
  } catch {
    throw new RecordRuntimeError(`MNHS People API returned non-JSON detail response from ${url}`);
  }
  if (!isPlainRecord(body) || !(body.success === true || body.status === 200)) {
    throw new RecordRuntimeError(`MNHS People API detail lookup failed for ${cleanId}`);
  }
  const data = body.data;
  if (!isPlainRecord(data) || !data.id) {
    throw new RecordRuntimeError(`MNHS record not found: ${cleanId} (${recordType})`);
  }
  return {
    record_type: recordType,
    id: cleanId,
    summary: normalizePeopleHit(recordType, data),
    record: data,
    url: `${MNHS_PEOPLE_RECORD_URL}?uuid=${encodeURIComponent(cleanId)}&recordType=${encodeURIComponent(recordType)}`,
    verified: true,
  };
}

function extractDocIdFromHref(href: string): string {
  const cleaned = href.replace(/;jsessionid=[^?]+/i, '');
  try {
    const parsed = new URL(cleaned, NEWSPAPERS_BASE);
    const val = parsed.searchParams.get('doc_id');
    return val ? val.trim() : '';
  } catch {
    return '';
  }
}

export function parseNewspapersSearchHtml(
  html: string
): readonly [number | null, NewspaperSearchItem[]] {
  const countMatch = /\bpsRecCnt\s*=\s*(\d+)\b/.exec(html);
  const total = countMatch ? Number.parseInt(countMatch[1], 10) : null;
  const $ = loadHtml(html);
  const items: NewspaperSearchItem[] = [];

  $('td.ps-result-cell').each((_idx, cellEl) => {
    const cell = $(cellEl);
    const item: NewspaperSearchItem = {};

    const titleAnchor = cell.find('a.ps-result-title').first();
    if (titleAnchor.length > 0) {
      const href = titleAnchor.attr('href') ?? '';
      const attrTitle = (titleAnchor.attr('title') ?? '').trim();
      const textTitle = collapseWhitespace(titleAnchor.text());
      const resolvedTitle = attrTitle || textTitle;
      if (resolvedTitle) {
        item.title = resolvedTitle;
      }
      const docId = extractDocIdFromHref(href);
      if (docId) {
        item.doc_id = docId;
      }
    }

    cell.find('div.ps-result-detail').each((_dIdx, divEl) => {
      const text = collapseWhitespace($(divEl).text());
      const pubMatch = /^Publication Date:\s*(.+)$/i.exec(text);
      if (pubMatch) {
        item.publication_date = pubMatch[1].trim();
      } else if (text && !item.detail) {
        item.detail = text;
      }
    });

    const thumbImg = cell.find('img.ps-result-thumb').first();
    if (thumbImg.length > 0) {
      const src = thumbImg.attr('src') ?? '';
      if (src) {
        const cleaned = src.replace(/;jsessionid=[^?]+/i, '');
        item.thumb_url = new URL(cleaned, NEWSPAPERS_BASE).toString();
      }
    }

    if (item.doc_id) {
      const quoted = encodeURIComponent(item.doc_id);
      item.viewer_url = `${NEWSPAPERS_VIEWER_URL}?doc_id=${quoted}`;
      item.metadata_url = `${NEWSPAPERS_METADATA_URL}?doc_id=${quoted}`;
      if (!item.thumb_url) {
        item.thumb_url = `${NEWSPAPERS_THUMB_URL}?tnName=${quoted}`;
      }
      items.push(item);
    }
  });

  return [total, items];
}

export function parseNewspapersMetadataHtml(html: string): Record<string, string> {
  const $ = loadHtml(html);
  const fields: Record<string, string> = {};
  let currentLabel: string | null = null;
  $('td.ps-md-field-label, td.ps-md-field-value').each((_idx, el) => {
    const td = $(el);
    const text = collapseWhitespace(td.text());
    if (td.hasClass('ps-md-field-label')) {
      currentLabel = text;
    } else if (td.hasClass('ps-md-field-value') && currentLabel) {
      fields[currentLabel] = text;
      currentLabel = null;
    }
  });
  return fields;
}

export function validateNewspaperDocId(raw: string): string {
  let clean: string;
  try {
    clean = decodeURIComponent(raw.trim());
  } catch {
    clean = raw.trim();
  }
  if (!clean || clean.includes('..') || clean.startsWith('/') || !DOC_ID_SAFE_RE.test(clean)) {
    throw new CliValidationError(`Invalid MNHS newspaper doc_id: '${raw}'`);
  }
  return clean;
}

async function fetchNewspapersSearch(
  ctx: RecordCommandContext,
  opts: {
    readonly query: string;
    readonly field: string;
    readonly beginDate: string;
    readonly endDate: string;
    readonly county: string;
    readonly city: string;
    readonly title: string;
    readonly limit: number;
    readonly offset: number;
  }
): Promise<NewspaperSearchResult> {
  const cleanQuery = opts.query.trim();
  if (cleanQuery.replace(/[*?]/g, '').length < 2) {
    throw new CliValidationError(
      'Newspaper query must contain at least 2 non-wildcard characters.'
    );
  }
  if (cleanQuery.includes(':') || cleanQuery.includes(';')) {
    throw new CliValidationError("Newspaper query cannot contain ':' or ';' characters.");
  }

  const params = new URLSearchParams();
  params.set('query1', cleanQuery);
  params.set('query1_field', NEWSPAPER_FIELD_MAP[opts.field] ?? 'CONTENT');
  params.set('query1_modifier', 'AND');
  params.set('result_items', String(opts.limit));
  params.set('start_index', String(opts.offset));

  let clause = 2;
  if (opts.beginDate.trim() || opts.endDate.trim()) {
    const minMs = dateToUtcMillis(opts.beginDate || '1849-01-01', false);
    const maxMs = dateToUtcMillis(opts.endDate || '2026-12-31', true);
    if (minMs > maxMs) {
      throw new CliValidationError('Begin date must not be after end date.');
    }
    params.set(`query${clause}_field`, 'DATE_PUBLISHED_MILLIS');
    params.set(`query${clause}_modifier`, 'AND');
    params.set(`query${clause}_min`, String(minMs));
    params.set(`query${clause}_max`, String(maxMs));
    clause += 1;
  }
  if (opts.county.trim()) {
    params.set(`query${clause}`, opts.county.trim().replace(/\s+County$/i, ''));
    params.set(`query${clause}_field`, 'SUBJECT_COUNTY');
    params.set(`query${clause}_modifier`, 'AND');
    clause += 1;
  }
  if (opts.city.trim()) {
    params.set(`query${clause}`, opts.city.trim());
    params.set(`query${clause}_field`, 'SUBJECT_CITY');
    params.set(`query${clause}_modifier`, 'AND');
    clause += 1;
  }
  if (opts.title.trim()) {
    params.set(`query${clause}`, opts.title.trim());
    params.set(`query${clause}_field`, 'TITLE');
    params.set(`query${clause}_modifier`, 'AND');
  }

  const url = `${NEWSPAPERS_SEARCH_URL}?${params.toString()}`;
  validateMnUrl(url, ALLOWED_HOSTS);
  const response = await httpRequest(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  const [rawTotal, items] = parseNewspapersSearchHtml(response.bytes.toString('utf8'));
  const verified = rawTotal !== null || items.length > 0;
  return {
    query: cleanQuery,
    field: opts.field,
    total: rawTotal !== null ? rawTotal : items.length,
    offset: opts.offset,
    limit: opts.limit,
    results: items.slice(0, opts.limit),
    verified,
  };
}

async function fetchNewspapersMetadata(
  ctx: RecordCommandContext,
  docId: string
): Promise<NewspaperMetadataResult> {
  const cleanId = validateNewspaperDocId(docId);
  const quoted = encodeURIComponent(cleanId);
  const url = `${NEWSPAPERS_METADATA_URL}?doc_id=${quoted}`;
  validateMnUrl(url, ALLOWED_HOSTS);
  const response = await httpRequest(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  const fields = parseNewspapersMetadataHtml(response.bytes.toString('utf8'));
  if (Object.keys(fields).length === 0) {
    throw new RecordRuntimeError(`No metadata found for newspaper doc_id '${cleanId}'.`);
  }
  return {
    doc_id: cleanId,
    url,
    viewer_url: `${NEWSPAPERS_VIEWER_URL}?doc_id=${quoted}`,
    thumb_url: `${NEWSPAPERS_THUMB_URL}?tnName=${quoted}`,
    fields,
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
  const head6 = Buffer.from(data.subarray(0, 6)).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return 'gif';
  }
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

function looksLikeHtml(data: Uint8Array, contentType: string): boolean {
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

function resolveSafeOutputPath(
  out: string,
  defaultName: string,
  ctx: RecordCommandContext
): string {
  const raw = out.trim();
  if (!raw || raw.includes('\0')) {
    throw new CliValidationError('Invalid output path.');
  }
  const normalizedSegments = raw.split(/[\\/]+/);
  if (normalizedSegments.includes('..')) {
    throw new CliValidationError(
      `Refusing output path with parent traversal segment ('..'): '${raw}'`
    );
  }
  const expanded = expandHomePath(raw, ctx.env);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(ctx.cwd, expanded);

  const isExistingDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  if (raw.endsWith('/') || raw.endsWith('\\') || isExistingDir) {
    const safeLeaf =
      defaultName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '') ||
      'image.jpg';
    const candidate = path.resolve(resolved, safeLeaf);
    if (!candidate.startsWith(`${resolved}${path.sep}`)) {
      throw new CliValidationError(`Output path escapes target directory: ${candidate}`);
    }
    return candidate;
  }
  return resolved;
}

async function downloadNewspaperThumb(
  ctx: RecordCommandContext,
  docIdOrUrl: string,
  out: string,
  overwrite: boolean
): Promise<DownloadResult> {
  const raw = docIdOrUrl.trim();
  let url: string;
  let stem: string;
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    url = validateMnUrl(raw, ALLOWED_DOWNLOAD_HOSTS);
    const parsed = new URL(url);
    const tn = parsed.searchParams.get('tnName') ?? parsed.searchParams.get('doc_id') ?? '';
    stem = tn ? tn.replace(/[^A-Za-z0-9._-]+/g, '_') : 'newspaper_thumb';
  } else {
    const docId = validateNewspaperDocId(raw);
    url = `${NEWSPAPERS_THUMB_URL}?tnName=${encodeURIComponent(docId)}`;
    stem = docId.replace(/[^A-Za-z0-9._-]+/g, '_');
  }

  const dest = resolveSafeOutputPath(out, `${stem}.jpg`, ctx);
  if (fs.existsSync(dest) && !overwrite) {
    const data = fs.readFileSync(dest);
    const fmt = detectImageFormat(data);
    if (!fmt) {
      throw new RecordRuntimeError(
        `Existing file at ${dest} is not a valid image; pass --overwrite to replace.`
      );
    }
    return {
      url,
      path: dest,
      bytes: data.length,
      format: fmt,
      skipped: true,
    };
  }

  const response = await httpRequest(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_DOWNLOAD_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = response.bytes;
  if (payload.length === 0) {
    throw new RecordRuntimeError(`Refusing empty response body from ${url}`);
  }
  if (looksLikeHtml(payload, contentType)) {
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
  return {
    url,
    path: dest,
    bytes: payload.length,
    format: fmt,
    skipped: false,
  };
}

function formatPeopleText(result: PeopleSearchResult, cacheHit: boolean): string {
  const marker = cacheHit ? ' [cache]' : '';
  const label = RECORD_TYPE_SPECS[result.record_type]?.label ?? result.record_type;
  const lines: string[] = [
    `${label} | total=${result.total} | page ${result.page}/${Math.max(result.page_count, 1)} | showing ${result.results.length}${marker}`,
  ];
  for (const rec of result.results) {
    const parts: string[] = [rec.name || '(unnamed)'];
    if (rec.date) parts.push(rec.date);
    if (rec.county) parts.push(rec.county);
    if (rec.locality) parts.push(rec.locality);
    if (rec.age) parts.push(`age ${rec.age}`);
    if (rec.mothers_maiden_name) parts.push(`mother ${rec.mothers_maiden_name}`);
    if (rec.certificate_id) parts.push(`cert ${rec.certificate_id}`);
    if (rec.id) parts.push(`id ${rec.id}`);
    lines.push(parts.join(' | '));
  }
  return lines.join('\n');
}

const CACHE_AND_JSON_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request and refresh the cached entry.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
];

function peopleSearchOptions(includeMother: boolean, includeType: boolean): OptionSpec[] {
  const opts: OptionSpec[] = [];
  if (includeType) {
    opts.push({
      key: 'recordType',
      kind: 'string',
      flags: ['--type'],
      default: 'death-records',
      metavar: 'TYPE',
      help: 'Record collection (death, birth, census, vets-graves, gold-star, wwi-bonuses, wwi-service, wwi-soldiers-photos).',
    });
  }
  opts.push(
    { key: 'last', kind: 'string', flags: ['--last'], default: '', help: 'Family (last) name.' },
    { key: 'first', kind: 'string', flags: ['--first'], default: '', help: 'Given (first) name.' },
    { key: 'middle', kind: 'string', flags: ['--middle'], default: '', help: 'Middle name.' }
  );
  if (includeMother) {
    opts.push({
      key: 'motherMaiden',
      kind: 'string',
      flags: ['--mother-maiden'],
      default: '',
      help: "Mother's maiden surname (birth 1900-1934; death 1955-2001).",
    });
  }
  opts.push(
    {
      key: 'county',
      kind: 'string',
      flags: ['--county'],
      default: '',
      help: 'Minnesota county name (e.g. Hennepin, Ramsey).',
    },
    {
      key: 'match',
      kind: 'string',
      flags: ['--match'],
      choices: MATCH_CHOICES,
      default: 'equals',
      help: 'Name match operator (default: equals).',
    },
    {
      key: 'beginYear',
      kind: 'string',
      flags: ['--begin-year'],
      default: '',
      help: 'Earliest year or date (YYYY or YYYY-MM-DD).',
    },
    {
      key: 'endYear',
      kind: 'string',
      flags: ['--end-year'],
      default: '',
      help: 'Latest year or date (YYYY or YYYY-MM-DD).',
    },
    {
      key: 'certId',
      kind: 'string',
      flags: ['--cert-id'],
      default: '',
      help: 'Exact MNHS certificate ID.',
    },
    {
      key: 'page',
      kind: 'integer',
      flags: ['--page'],
      default: 1,
      help: '1-based results page (default: 1).',
    },
    {
      key: 'limit',
      kind: 'integer',
      flags: ['--limit'],
      default: 25,
      help: 'Results per page, 1-100 (default: 25).',
    },
    ...CACHE_AND_JSON_OPTIONS
  );
  return opts;
}

const RECORD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'recordType',
    kind: 'string',
    flags: ['--type'],
    required: true,
    metavar: 'TYPE',
    help: 'Record collection (death, birth, census, vets-graves, gold-star, wwi-bonuses, wwi-service, wwi-soldiers-photos).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

const NEWSPAPERS_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'field',
    kind: 'string',
    flags: ['--field'],
    choices: NEWSPAPER_FIELD_CHOICES,
    default: 'content',
    help: 'Field to search (default: content).',
  },
  {
    key: 'beginYear',
    kind: 'string',
    flags: ['--begin-year'],
    default: '',
    help: 'Earliest publication date (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'endYear',
    kind: 'string',
    flags: ['--end-year'],
    default: '',
    help: 'Latest publication date (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: '',
    help: 'Filter by Minnesota county.',
  },
  { key: 'city', kind: 'string', flags: ['--city'], default: '', help: 'Filter by city.' },
  {
    key: 'title',
    kind: 'string',
    flags: ['--title'],
    default: '',
    help: 'Filter by newspaper title.',
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
    help: '0-based start offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

const NEWSPAPERS_DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out'],
    required: true,
    metavar: 'PATH',
    help: 'Output file path or directory.',
  },
  {
    key: 'overwrite',
    kind: 'boolean',
    flags: ['--overwrite'],
    help: 'Overwrite an existing output file.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
];

const MDL_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
];

function isPeopleSearchResult(value: unknown): value is PeopleSearchResult {
  return (
    isPlainRecord(value) &&
    typeof value.record_type === 'string' &&
    Array.isArray(value.results)
  );
}

function isPeopleRecordDetailResult(value: unknown): value is PeopleRecordDetailResult {
  return (
    isPlainRecord(value) &&
    typeof value.id === 'string' &&
    isPlainRecord(value.summary) &&
    isPlainRecord(value.record)
  );
}

function isNewspaperSearchResult(value: unknown): value is NewspaperSearchResult {
  return isPlainRecord(value) && Array.isArray(value.results);
}

function isNewspaperMetadataResult(value: unknown): value is NewspaperMetadataResult {
  return isPlainRecord(value) && isPlainRecord(value.fields);
}

async function runPeopleCommand(
  ctx: RecordCommandContext,
  rest: readonly string[],
  fixedRecordType: string | null,
  subcmdName: string,
  summary: string,
  includeMother: boolean
): Promise<RecordCommandOutcome> {
  const options = peopleSearchOptions(includeMother, fixedRecordType === null);
  const spec: CommandParseSpec = { options, allowPositionals: false };
  const parsed = parseCommandArgs(rest, spec);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: `kinloom mn-archives ${subcmdName} [options]`,
          summary,
          options,
        })
      ),
    };
  }

  const recordType =
    fixedRecordType ?? resolveRecordType(getStringOption(parsed, 'recordType') ?? 'death-records');
  const page = getNumberOption(parsed, 'page') ?? 1;
  const limit = getNumberOption(parsed, 'limit') ?? 25;
  if (page < 1) {
    throw new CliValidationError('--page must be >= 1.');
  }
  if (limit < 1 || limit > 100) {
    throw new CliValidationError('--limit must be between 1 and 100.');
  }

  const queryBody = buildPeopleQuery(recordType, {
    last: getStringOption(parsed, 'last') ?? '',
    first: getStringOption(parsed, 'first') ?? '',
    middle: getStringOption(parsed, 'middle') ?? '',
    motherMaiden: includeMother ? (getStringOption(parsed, 'motherMaiden') ?? '') : '',
    county: getStringOption(parsed, 'county') ?? '',
    match: getStringOption(parsed, 'match') ?? 'equals',
    beginDate: getStringOption(parsed, 'beginYear') ?? '',
    endDate: getStringOption(parsed, 'endYear') ?? '',
    certId: getStringOption(parsed, 'certId') ?? '',
  });

  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const { value: result, cacheHit } = await cachedJsonCall<PeopleSearchResult>({
    cacheDir: getCacheDir(ctx),
    kind: `people:${recordType}`,
    payload: { record_type: recordType, query: queryBody, page, limit },
    ttlHours,
    refresh,
    fetch: () => fetchPeopleSearch(ctx, recordType, queryBody, page, limit),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isPeopleSearchResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatPeopleText(result, cacheHit)),
    cacheHit,
  };
}

async function runRecordCommand(
  ctx: RecordCommandContext,
  rest: readonly string[]
): Promise<RecordCommandOutcome> {
  const spec: CommandParseSpec = {
    options: RECORD_OPTIONS,
    allowPositionals: true,
    minPositionals: 1,
    maxPositionals: 1,
    positionalLabel: 'uuid',
  };
  const parsed = parseCommandArgs(rest, spec);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom mn-archives record <UUID> --type <TYPE> [options]',
          summary: 'Fetch a single MNHS People Record by UUID and --type.',
          options: RECORD_OPTIONS,
        })
      ),
    };
  }

  const rawUuid = parsed.positionals[0] ?? '';
  const recordType = resolveRecordType(getStringOption(parsed, 'recordType') ?? '');
  const cleanId = rawUuid.trim();
  if (!UUID_RE.test(cleanId)) {
    throw new CliValidationError(`Invalid MNHS record UUID: '${rawUuid}'`);
  }

  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const { value: result, cacheHit } = await cachedJsonCall<PeopleRecordDetailResult>({
    cacheDir: getCacheDir(ctx),
    kind: `record:${recordType}`,
    payload: { record_type: recordType, id: cleanId },
    ttlHours,
    refresh,
    fetch: () => fetchPeopleRecord(ctx, recordType, cleanId),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isPeopleRecordDetailResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const summary = result.summary;
  const label = RECORD_TYPE_SPECS[recordType]?.label ?? recordType;
  const lines: string[] = [
    `${label}${marker}`,
    `  Name: ${summary.name || '(unnamed)'}`,
  ];
  if (summary.date) lines.push(`  Date: ${summary.date}`);
  if (summary.county) lines.push(`  County: ${summary.county}`);
  if (summary.certificate_id) lines.push(`  Certificate ID: ${summary.certificate_id}`);
  if (summary.mothers_maiden_name) {
    lines.push(`  Mother's maiden name: ${summary.mothers_maiden_name}`);
  }
  if (summary.birth_date) lines.push(`  Birth date: ${summary.birth_date}`);
  if (summary.birth_place) lines.push(`  Birth place: ${summary.birth_place}`);
  lines.push(`  URL: ${result.url}`);
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runNewspapersCommand(
  ctx: RecordCommandContext,
  rest: readonly string[]
): Promise<RecordCommandOutcome> {
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom mn-archives newspapers <command> [options]',
          summary: 'Search and inspect MNHS Digital Newspaper Hub issues.',
          subcommands: [
            { name: 'search', summary: 'Search digitized Minnesota newspapers.' },
            { name: 'metadata', summary: 'Fetch structured metadata for a newspaper issue doc_id.' },
            { name: 'download', summary: 'Download a verified newspaper issue thumbnail image.' },
          ],
        })
      ),
    };
  }

  const [sub, ...subRest] = rest;
  switch (sub) {
    case 'search': {
      const parsed = parseCommandArgs(subRest, {
        options: NEWSPAPERS_SEARCH_OPTIONS,
        allowPositionals: true,
        minPositionals: 1,
        maxPositionals: 1,
        positionalLabel: 'query',
      });
      if (parsed.helpRequested) {
        return {
          exitCode: 0,
          bytesOut: emitStdout(
            ctx.io,
            formatCommandUsage({
              usage: 'kinloom mn-archives newspapers search <QUERY> [options]',
              summary: 'Search digitized Minnesota newspapers.',
              options: NEWSPAPERS_SEARCH_OPTIONS,
            })
          ),
        };
      }
      const query = parsed.positionals[0] ?? '';
      const field = getStringOption(parsed, 'field') ?? 'content';
      const beginYear = getStringOption(parsed, 'beginYear') ?? '';
      const endYear = getStringOption(parsed, 'endYear') ?? '';
      const county = getStringOption(parsed, 'county') ?? '';
      const city = getStringOption(parsed, 'city') ?? '';
      const title = getStringOption(parsed, 'title') ?? '';
      const limit = getNumberOption(parsed, 'limit') ?? 20;
      const offset = getNumberOption(parsed, 'offset') ?? 0;
      if (limit < 1 || limit > 100) {
        throw new CliValidationError('--limit must be between 1 and 100.');
      }
      if (offset < 0) {
        throw new CliValidationError('--offset must be >= 0.');
      }
      const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
      const refresh = getBooleanOption(parsed, 'refresh');
      const asJson = getBooleanOption(parsed, 'asJson');

      const { value: result, cacheHit } = await cachedJsonCall<NewspaperSearchResult>({
        cacheDir: getCacheDir(ctx),
        kind: 'newspapers:search',
        payload: {
          query: query.trim(),
          field,
          begin_year: beginYear,
          end_year: endYear,
          county,
          city,
          title,
          limit,
          offset,
        },
        ttlHours,
        refresh,
        fetch: () =>
          fetchNewspapersSearch(ctx, {
            query,
            field,
            beginDate: beginYear,
            endDate: endYear,
            county,
            city,
            title,
            limit,
            offset,
          }),
        cacheable: (r) => Boolean(r.verified),
        validateCached: isNewspaperSearchResult,
        nowMs: ctx.nowMs,
        sleepFn: ctx.sleepFn,
      });

      if (asJson) {
        return {
          exitCode: 0,
          bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
          cacheHit,
        };
      }
      const marker = cacheHit ? ' [cache]' : '';
      const lines: string[] = [
        `MNHS Digital Newspaper Hub | total=${result.total} | offset=${result.offset} | showing ${result.results.length}${marker}`,
      ];
      for (const item of result.results) {
        const parts = [
          item.title || '(untitled)',
          item.publication_date || '',
          item.doc_id || '',
          item.viewer_url || '',
        ].filter(Boolean);
        lines.push(parts.join(' | '));
      }
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
    }

    case 'metadata': {
      const parsed = parseCommandArgs(subRest, {
        options: CACHE_AND_JSON_OPTIONS,
        allowPositionals: true,
        minPositionals: 1,
        maxPositionals: 1,
        positionalLabel: 'doc_id',
      });
      if (parsed.helpRequested) {
        return {
          exitCode: 0,
          bytesOut: emitStdout(
            ctx.io,
            formatCommandUsage({
              usage: 'kinloom mn-archives newspapers metadata <DOC_ID> [options]',
              summary: 'Fetch structured metadata for a newspaper issue doc_id.',
              options: CACHE_AND_JSON_OPTIONS,
            })
          ),
        };
      }
      const cleanId = validateNewspaperDocId(parsed.positionals[0] ?? '');
      const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
      const refresh = getBooleanOption(parsed, 'refresh');
      const asJson = getBooleanOption(parsed, 'asJson');

      const { value: result, cacheHit } = await cachedJsonCall<NewspaperMetadataResult>({
        cacheDir: getCacheDir(ctx),
        kind: 'newspapers:metadata',
        payload: { doc_id: cleanId },
        ttlHours,
        refresh,
        fetch: () => fetchNewspapersMetadata(ctx, cleanId),
        cacheable: (r) => Boolean(r.verified),
        validateCached: isNewspaperMetadataResult,
        nowMs: ctx.nowMs,
        sleepFn: ctx.sleepFn,
      });

      if (asJson) {
        return {
          exitCode: 0,
          bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
          cacheHit,
        };
      }
      const marker = cacheHit ? ' [cache]' : '';
      const lines: string[] = [`Newspaper Metadata (${cleanId})${marker}`];
      for (const [key, val] of Object.entries(result.fields)) {
        lines.push(`  ${key}: ${val}`);
      }
      lines.push(`  Viewer: ${result.viewer_url}`);
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
    }

    case 'download': {
      const parsed = parseCommandArgs(subRest, {
        options: NEWSPAPERS_DOWNLOAD_OPTIONS,
        allowPositionals: true,
        minPositionals: 1,
        maxPositionals: 1,
        positionalLabel: 'target',
      });
      if (parsed.helpRequested) {
        return {
          exitCode: 0,
          bytesOut: emitStdout(
            ctx.io,
            formatCommandUsage({
              usage: 'kinloom mn-archives newspapers download <TARGET> --out <PATH> [options]',
              summary: 'Download a verified newspaper issue thumbnail image.',
              options: NEWSPAPERS_DOWNLOAD_OPTIONS,
            })
          ),
        };
      }
      const target = parsed.positionals[0] ?? '';
      const out = getStringOption(parsed, 'out') ?? '';
      const overwrite = getBooleanOption(parsed, 'overwrite');
      const asJson = getBooleanOption(parsed, 'asJson');
      const info = await downloadNewspaperThumb(ctx, target, out, overwrite);
      if (asJson) {
        return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, info) };
      }
      const verb = info.skipped ? 'Exists (skip)' : 'Downloaded';
      return {
        exitCode: 0,
        bytesOut: emitStdout(
          ctx.io,
          `${verb}: ${info.path} (${info.bytes.toLocaleString('en-US')} bytes, ${info.format})`
        ),
      };
    }

    default:
      throw new CliValidationError(
        `No such newspapers command '${sub}'. Choose from: search, metadata, download.`
      );
  }
}

function runMdlCommand(
  ctx: RecordCommandContext,
  rest: readonly string[]
): RecordCommandOutcome {
  const parsed = parseCommandArgs(rest, {
    options: MDL_OPTIONS,
    allowPositionals: false,
  });
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom mn-archives mdl [options]',
          summary: 'Show browser-only URLs for Minnesota Digital Library.',
          options: MDL_OPTIONS,
        })
      ),
    };
  }
  const payload = {
    name: 'Minnesota Digital Library',
    status: 'browser-only',
    reason:
      'Automated HTTP requests to collection.mndigital.org receive HTTP 403 (Cloudflare challenge).',
    home_url: MDL_HOME_URL,
    dpla_url: MDL_DPLA_URL,
  };
  if (getBooleanOption(parsed, 'asJson')) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const text = [
    'Minnesota Digital Library (browser only):',
    `  Home: ${MDL_HOME_URL}`,
    `  DPLA partner search: ${MDL_DPLA_URL}`,
    '  Note: collection.mndigital.org gates automated HTTP requests behind Cloudflare (HTTP 403).',
    '  Use a browser for MDL photographs, county histories, plats, and archival manuscripts.',
  ].join('\n');
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
}

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom mn-archives <command> [options]',
    summary:
      'Search Minnesota Historical Society People Records and Digital Newspaper Hub (no key, no login).',
    subcommands: [
      { name: 'death', summary: 'Search MNHS Death Records Index (1904-2001).' },
      { name: 'birth', summary: 'Search MNHS Birth Records Index (1900-1934).' },
      { name: 'census', summary: 'Search MNHS Minnesota State Censuses (1849-1905).' },
      { name: 'vets', summary: 'Search MNHS Veterans Graves Registration (1857-1975).' },
      {
        name: 'people',
        summary:
          'Search any MNHS People Records collection (--type death|birth|census|vets-graves|gold-star|wwi-*).',
      },
      { name: 'record', summary: 'Fetch a single MNHS People Record by UUID and --type.' },
      { name: 'newspapers', summary: 'Search and inspect MNHS Digital Newspaper Hub issues.' },
      { name: 'mdl', summary: 'Show browser-only URLs for Minnesota Digital Library.' },
    ],
  });
}

export const runMnArchivesCommand: RecordHandler = async (
  args,
  ctx
): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'death':
        return await runPeopleCommand(
          ctx,
          rest,
          'death-records',
          'death',
          'Search MNHS Death Records Index (1904-2001).',
          true
        );
      case 'birth':
        return await runPeopleCommand(
          ctx,
          rest,
          'birth-records',
          'birth',
          'Search MNHS Birth Records Index (1900-1934).',
          true
        );
      case 'census':
        return await runPeopleCommand(
          ctx,
          rest,
          'census',
          'census',
          'Search MNHS Minnesota State Censuses (1849-1905).',
          false
        );
      case 'vets':
        return await runPeopleCommand(
          ctx,
          rest,
          'vets-graves',
          'vets',
          'Search MNHS Veterans Graves Registration (1857-1975).',
          false
        );
      case 'people':
        return await runPeopleCommand(
          ctx,
          rest,
          null,
          'people',
          'Search any MNHS People Records collection.',
          true
        );
      case 'record':
        return await runRecordCommand(ctx, rest);
      case 'newspapers':
        return await runNewspapersCommand(ctx, rest);
      case 'mdl':
        return runMdlCommand(ctx, rest);
      default:
        throw new CliValidationError(
          `No such command '${subcmd}'. Run 'kinloom mn-archives --script-help'.`
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
