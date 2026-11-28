import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { expandHomePath, resolveCacheDir } from '../../runtime/cache.js';
import { isPlainRecord, resolveEnvCacheTtlHours } from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const HISKI_BASE = 'https://hiski.genealogia.fi';
export const HISKI_ENDPOINT = `${HISKI_BASE}/hiski`;
export const HISKI_PARISHES_URL = `${HISKI_ENDPOINT}?en+A00`;

export const DIGIHAKEMISTO_BASE = 'https://digihakemisto.net';
export const DIGIHAKEMISTO_SEARCH_URL = `${DIGIHAKEMISTO_BASE}/haku`;
export const DIGIHAKEMISTO_ARCHIVE_BASE = `${DIGIHAKEMISTO_BASE}/aineisto`;

export const ASTIA_CARD_BASE = 'https://astia.narc.fi/uusiastia/kortti_aineisto.html';
export const ASTIA_SEARCH_URL = 'https://astia.narc.fi/uusiastia/aineistot.html';
export const FINNA_SEARCH_URL = 'https://www.finna.fi/Search/Results';
export const DIGI_NEWSPAPERS_URL = 'https://digi.kansalliskirjasto.fi/search';
export const SSHY_BASE_URL = 'https://www.sukuhistoria.fi/sshy/index_eng.htm';

export const ALLOWED_HISKI_HOSTS = ['hiski.genealogia.fi'] as const;
export const ALLOWED_DIGIHAKEMISTO_HOSTS = ['digihakemisto.net'] as const;
export const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
export const MAX_HTTP_ATTEMPTS = 3;
export const RETRY_BASE_MS = 500;
export const MIN_INTERVAL_MS = 200;
export const REQUEST_TIMEOUT_MS = 30_000;

export const BOOK_ALIASES: Readonly<Record<string, string>> = {
  christened: 'kastetut',
  baptism: 'kastetut',
  baptisms: 'kastetut',
  birth: 'kastetut',
  births: 'kastetut',
  kastetut: 'kastetut',
  married: 'vihityt',
  marriage: 'vihityt',
  marriages: 'vihityt',
  vihityt: 'vihityt',
  buried: 'haudatut',
  burial: 'haudatut',
  burials: 'haudatut',
  death: 'haudatut',
  deaths: 'haudatut',
  haudatut: 'haudatut',
  'moved-in': 'smuutt',
  in: 'smuutt',
  smuutt: 'smuutt',
  'moved-out': 'umuutt',
  out: 'umuutt',
  umuutt: 'umuutt',
  all: 'kaikki',
  kaikki: 'kaikki',
};

export const BOOK_LABELS: Readonly<Record<string, string>> = {
  kastetut: 'christened',
  vihityt: 'married',
  haudatut: 'buried',
  smuutt: 'moved-in',
  umuutt: 'moved-out',
  kaikki: 'all',
};

export const DIGIHAKEMISTO_PRESETS: Readonly<Record<string, string>> = {
  parishes: '*seurakun*, *församl*',
  henkikirjat: 'läänin henkikirjat',
  tax: 'läänin henkikirjat',
  court: 'tuomiokunnan,tuomiokirjat',
  inventories: 'id:perukirjat',
  say: 'id:1585519449',
};

export const PARISH_CODE_RE = /^\d{4}$/;
export const SAFE_ARCHIVE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const HISKI_EVENT_HREF_RE =
  /\/hiski\?(?:en|fi|sv)\+(\d{4})\+(kastetut|vihityt|haudatut|smuutt|umuutt)\+(\d+)/i;
export const HISKI_PERMALINK_RE = /\/hiski\?(?:en|fi|sv)\+(t\d+)/i;
export const TOTAL_EVENTS_RE = /(?:A total of\s+)?(\d+)\s+events?\s+found/gi;
const YEAR_RE = /^\d{4}$/;

export interface HiskiParish {
  readonly code: string;
  readonly name: string;
  readonly url: string;
}

export interface HiskiRecord {
  readonly parish: string;
  readonly parish_code: string;
  readonly book: string;
  readonly book_code: string;
  readonly row_id: string;
  readonly event_url: string;
  comment?: string;
  readonly [key: string]: unknown;
}

export interface HiskiSearchResult {
  readonly total_reported: number;
  readonly records: HiskiRecord[];
}

export interface HiskiEventDetail {
  readonly parish: string;
  readonly parish_code: string;
  readonly book: string;
  readonly book_code: string;
  readonly row_id: string;
  readonly permalink_id: string;
  readonly permalink_url: string;
  readonly event_url: string;
  readonly sshy_url: string;
  readonly fields: Record<string, string>;
}

export interface DigihakemistoArchiveRow {
  readonly id: string;
  readonly title: string;
  readonly comment: string;
  readonly digitized: boolean;
  readonly digihakemisto_url: string;
  readonly astia_url: string;
}

export interface DigihakemistoChildRow {
  readonly id: string;
  readonly kind: 'item' | 'series';
  readonly title: string;
  readonly comment: string;
  readonly digitized: boolean;
  readonly digihakemisto_url: string;
  readonly astia_url: string;
}

export interface DigihakemistoArchiveDetail {
  readonly id: string;
  readonly title: string;
  readonly digihakemisto_url: string;
  readonly astia_url: string;
  readonly notes: string[];
  readonly access_notes: string[];
  readonly children: DigihakemistoChildRow[];
}

export interface ParishesCachePayload {
  readonly parishes: HiskiParish[];
}

export interface ArchivesSearchCachePayload {
  readonly archives: DigihakemistoArchiveRow[];
}

export function getCacheDir(ctx: RecordCommandContext): string {
  const specific = ctx.env['KINLOOM_FI_ARCHIVES_CACHE_DIR'];
  if (specific && specific.trim().length > 0) {
    return path.resolve(expandHomePath(specific, ctx.env));
  }
  const shared = ctx.env['KINLOOM_CACHE_DIR'];
  if (shared && shared.trim().length > 0) {
    return path.resolve(expandHomePath(shared, ctx.env), 'fi-archives');
  }
  return resolveCacheDir({
    env: ctx.env,
    envVars: [],
    defaultSubdir: path.join('kinloom', 'fi-archives'),
  });
}

export function resolveTtlHours(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_FI_ARCHIVES_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export function validateFiUrl(rawUrl: string, allowedHosts: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CliValidationError(`Refusing malformed URL: '${rawUrl}'`);
  }
  if (parsed.protocol !== 'https:') {
    throw new CliValidationError(`Refusing non-HTTPS URL: '${rawUrl}'`);
  }
  if (parsed.username || parsed.password) {
    throw new CliValidationError('Refusing URL containing embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    throw new CliValidationError(
      `Refusing host '${host}'; allowed hosts: ${[...allowedHosts].toSorted().join(', ')}.`
    );
  }
  return rawUrl;
}

export function decodeIso88591(bytes: Buffer): string {
  return bytes.toString('latin1');
}

function encodeIso88591Component(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0xff) {
      continue;
    }
    if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f ||
      code === 0x7e
    ) {
      out += value[i];
    } else if (code === 0x20) {
      out += '+';
    } else {
      out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

export function encodeIso88591Form(formData: Readonly<Record<string, string>>): string {
  return Object.entries(formData)
    .map(([k, v]) => `${encodeIso88591Component(k)}=${encodeIso88591Component(v)}`)
    .join('&');
}

export function isParishesCachePayload(value: unknown): value is ParishesCachePayload {
  return isPlainRecord(value) && Array.isArray(value['parishes']);
}

export function isHiskiSearchResult(value: unknown): value is HiskiSearchResult {
  return isPlainRecord(value) && Array.isArray(value['records']);
}

export function isHiskiEventDetail(value: unknown): value is HiskiEventDetail {
  return isPlainRecord(value) && isPlainRecord(value['fields']);
}

export function isArchivesSearchCachePayload(value: unknown): value is ArchivesSearchCachePayload {
  return isPlainRecord(value) && Array.isArray(value['archives']);
}

export function isDigihakemistoArchiveDetail(value: unknown): value is DigihakemistoArchiveDetail {
  return isPlainRecord(value) && Array.isArray(value['children']);
}

export function validateYears(
  fromYear: string | undefined,
  toYear: string | undefined
): readonly [string, string] {
  const fy = (fromYear ?? '').trim();
  const ty = (toYear ?? '').trim();
  if (fy && !YEAR_RE.test(fy)) {
    throw new CliValidationError(`Invalid --from-year '${fromYear}'; expected 4-digit YYYY.`);
  }
  if (ty && !YEAR_RE.test(ty)) {
    throw new CliValidationError(`Invalid --to-year '${toYear}'; expected 4-digit YYYY.`);
  }
  if (fy && ty && Number.parseInt(fy, 10) > Number.parseInt(ty, 10)) {
    throw new CliValidationError('--from-year must not be greater than --to-year.');
  }
  return [fy, ty];
}

export function hiskiMaxkpl(limit: number): string {
  for (const bucket of [15, 30, 50, 100, 250, 500, 1000]) {
    if (limit <= bucket) {
      return String(bucket);
    }
  }
  return '1000';
}

export function parseEventRef(raw: string): readonly [string, string, string] {
  const text = raw.trim();
  if (text.startsWith('http://') || text.startsWith('https://')) {
    validateFiUrl(text, ALLOWED_HISKI_HOSTS);
    const match = HISKI_EVENT_HREF_RE.exec(text);
    if (!match) {
      throw new CliValidationError(
        'Expected a HisKi event URL like https://hiski.genealogia.fi/hiski?en+0001+kastetut+418.'
      );
    }
    return [match[1], match[2].toLowerCase(), match[3]];
  }
  const tokens = text.split(/[+/:]/);
  if (tokens.length === 3) {
    const parishCode = tokens[0].trim();
    const rawBook = tokens[1].trim().toLowerCase();
    const rowId = tokens[2].trim();
    const bookCode = BOOK_ALIASES[rawBook] ?? '';
    if (
      PARISH_CODE_RE.test(parishCode) &&
      ['kastetut', 'vihityt', 'haudatut', 'smuutt', 'umuutt'].includes(bookCode) &&
      /^\d+$/.test(rowId)
    ) {
      return [parishCode, bookCode, rowId];
    }
  }
  throw new CliValidationError(
    `Invalid HisKi event reference '${raw}'; use '<parish_code>/<book>/<row_id>' (e.g. '0001/kastetut/418') or a full HisKi event URL.`
  );
}

export function parseArchiveId(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('http://') || text.startsWith('https://')) {
    validateFiUrl(text, ALLOWED_DIGIHAKEMISTO_HOSTS);
    const parsed = new URL(text);
    const parts = parsed.pathname.split('/').filter((p) => p.length > 0);
    if (parts.length >= 2 && parts[0] === 'aineisto' && SAFE_ARCHIVE_ID_RE.test(parts[1])) {
      return parts[1];
    }
    throw new CliValidationError(`Expected https://digihakemisto.net/aineisto/<id>, got '${raw}'.`);
  }
  if (text.toLowerCase().startsWith('id:')) {
    text = text.slice(3).trim();
  }
  if (!SAFE_ARCHIVE_ID_RE.test(text)) {
    throw new CliValidationError(`Invalid Digihakemisto archive id '${raw}'.`);
  }
  return text;
}

export function normalizeOptionalValueFlags(
  argv: readonly string[],
  optionalFlags: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    out.push(token);
    if (optionalFlags.has(token)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        out.push('');
      }
    }
  }
  return out;
}
