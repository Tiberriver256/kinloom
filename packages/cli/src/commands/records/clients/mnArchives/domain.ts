import os from 'node:os';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { expandHomePath } from '../../runtime/cache.js';
import { resolveEnvCacheTtlHours } from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const USER_AGENT = 'Kinloom/0.18 (genealogy research CLI; +https://github.com/tiberriver256/kinloom)';

export const MNHS_BASE = 'https://www.mnhs.org';
export const MNHS_PEOPLE_API = `${MNHS_BASE}/_hcms/api`;
export const MNHS_PEOPLE_RECORD_URL = `${MNHS_BASE}/search/people/record`;
export const MNHS_PEOPLE_SEARCH_URL = `${MNHS_BASE}/search/people`;

export const NEWSPAPERS_BASE = 'https://newspapers.mnhs.org';
export const NEWSPAPERS_SEARCH_URL = `${NEWSPAPERS_BASE}/jsp/PsSearchResults.jsp`;
export const NEWSPAPERS_METADATA_URL = `${NEWSPAPERS_BASE}/jsp/PsMetadata.jsp`;
export const NEWSPAPERS_VIEWER_URL = `${NEWSPAPERS_BASE}/jsp/PsImageViewer.jsp`;
export const NEWSPAPERS_THUMB_URL = `${NEWSPAPERS_BASE}/servlet/PsObjThumb`;

export const MDL_HOME_URL = 'https://collection.mndigital.org/';
export const MDL_DPLA_URL = 'https://dp.la/search?partner=%22Minnesota+Digital+Library%22';

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set<string>(['www.mnhs.org', 'newspapers.mnhs.org']);
export const ALLOWED_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set<string>(['newspapers.mnhs.org']);
export const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
export const MAX_HTTP_ATTEMPTS = 3;
export const RETRY_BASE_MS = 500;

export interface RecordTypeSpec {
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

export const NEWSPAPER_FIELD_MAP: Readonly<Record<string, string>> = {
  all: 'ALL',
  content: 'CONTENT',
  title: 'TITLE',
  place: 'PLACE_OF_PUBLICATION',
  county: 'SUBJECT_COUNTY',
  city: 'SUBJECT_CITY',
  date: 'DATE_PUBLISHED',
};

export const MATCH_CHOICES = ['equals', 'starts-with', 'ends-with', 'contains', 'soundex'] as const;
export const NEWSPAPER_FIELD_CHOICES = Object.keys(NEWSPAPER_FIELD_MAP).toSorted();

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
export const DOC_ID_SAFE_RE = /^[A-Za-z0-9._/-]+$/;

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

export interface PeopleSearchResult {
  readonly record_type: string;
  readonly total: number;
  readonly page: number;
  readonly page_size: number;
  readonly page_count: number;
  readonly results: readonly NormalizedPeopleHit[];
  readonly verified: boolean;
}

export interface PeopleRecordDetailResult {
  readonly record_type: string;
  readonly id: string;
  readonly summary: NormalizedPeopleHit;
  readonly record: Record<string, unknown>;
  readonly url: string;
  readonly verified: boolean;
}

export interface NewspaperSearchItem {
  title?: string | undefined;
  doc_id?: string;
  publication_date?: string;
  detail?: string;
  thumb_url?: string;
  viewer_url?: string;
  metadata_url?: string;
}

export interface NewspaperSearchResult {
  readonly query: string;
  readonly field: string;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly results: readonly NewspaperSearchItem[];
  readonly verified: boolean;
}

export interface NewspaperMetadataResult {
  readonly doc_id: string;
  readonly url: string;
  readonly viewer_url: string;
  readonly thumb_url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly verified: boolean;
}

export interface DownloadResult {
  readonly url: string;
  readonly path: string;
  readonly bytes: number;
  readonly format: string;
  readonly skipped: boolean;
}

export interface PeopleQueryParams {
  readonly last?: string;
  readonly first?: string;
  readonly middle?: string;
  readonly motherMaiden?: string;
  readonly county?: string | undefined;
  readonly match?: string;
  readonly beginDate?: string;
  readonly endDate?: string;
  readonly certId?: string;
}

export function getCacheDir(ctx: RecordCommandContext): string {
  const specific = ctx.env['KINLOOM_MN_ARCHIVES_CACHE_DIR'];
  if (specific && specific.trim().length > 0) {
    return path.resolve(expandHomePath(specific, ctx.env));
  }
  const shared = ctx.env['KINLOOM_CACHE_DIR'];
  if (shared && shared.trim().length > 0) {
    return path.resolve(expandHomePath(shared, ctx.env), 'mn-archives');
  }
  const home = ctx.env['HOME'] || os.homedir();
  return path.join(home, '.cache', 'kinloom', 'mn-archives');
}

export function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export function validateMnUrl(rawUrl: string, allowedHosts: ReadonlySet<string> = ALLOWED_HOSTS): string {
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
    throw new CliValidationError(`Invalid date '${raw}'; expected YYYY, YYYY-MM, or YYYY-MM-DD.`);
  }
  const year = Number.parseInt(match[1] ?? '', 10);
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
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new CliValidationError(`Invalid calendar date '${raw}'.`);
  }
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dateToUtcMillis(raw: string, endOfPeriod = false): number {
  const iso = normalizeIsoDate(raw, endOfPeriod);
  const [y = 0, m = 1, d = 1] = iso.split('-').map((n) => Number.parseInt(n, 10));
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

export function buildPeopleQuery(recordType: string, params: PeopleQueryParams): PeopleQueryBody {
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
