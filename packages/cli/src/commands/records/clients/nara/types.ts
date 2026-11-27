import type { ChromiumLauncher } from '../../runtime/browser.js';
import { IncompleteDownloadError, JPEG_MAGIC } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';

export { IncompleteDownloadError, JPEG_MAGIC };

export const CATALOG_WEB_BASE = 'https://catalog.archives.gov';
export const CATALOG_API_BASE = 'https://catalog.archives.gov/api/v2';
export const API_MAX_WORKERS = 6;
export const API_ATTEMPTS = 3;
export const API_READ_TIMEOUT_MS = 30_000;
export const DEFAULT_BROWSER_TIMEOUT_S = 60.0;
export const DEFAULT_BROWSER_TIMEOUT_MS = DEFAULT_BROWSER_TIMEOUT_S * 1000;
export const DOWNLOAD_MAX_WORKERS = 4;
export const DOWNLOAD_ATTEMPTS = 4;
export const DEFAULT_DOWNLOAD_TIMEOUT = 60.0;
export const RETRY_AFTER_CAP_S = 30.0;
export const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 522, 524]);
export const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm', '.xhtml']);
export const DEFAULT_QUERY_TTL_HOURS = 168.0;
export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const VALID_LEVELS = ['recordGroup', 'collection', 'series', 'fileUnit', 'item'] as const;

export const S3_PATH_HOST_RE = /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
export const NARA_BUCKET_HOST_RE =
  /^(?:naraprodstorage|nara-[a-z0-9-]*|opaexport[a-z0-9-]*)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
export const NARA_PATH_PREFIXES = ['/naraprodstorage/', '/opaexport', '/nara-'] as const;
export const CATALOG_RECORD_URL_RE = /^https:\/\/catalog\.archives\.gov\/id\/(\d+)\/?(?:[?#].*)?$/i;

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

export const CENSUS1950_STATE_BY_NAME: ReadonlyMap<string, string> = new Map(
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
export const CENSUS1950_JPEG_SUFFIXES: ReadonlySet<string> = new Set(['.jpg', '.jpeg']);

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
export const MAX_REDIRECTS = 10;

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
  readonly launcher?: ChromiumLauncher;
  readonly closeTimeoutMs?: number;
  readonly killGraceMs?: number;
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

export interface CachedDownloadInfo {
  readonly bytes: number;
  readonly content_type: string;
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
