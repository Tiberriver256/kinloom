import { CliValidationError } from '../../../../errors.js';
import { resolveCacheDir } from '../../runtime/cache.js';
import { cleanHtmlText, collapseWhitespace, loadHtml } from '../../runtime/parse.js';
import { isPlainRecord, resolveEnvCacheTtlHours } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const DISCOVERY_SEARCH = 'https://discovery.nationalarchives.gov.uk/API/search/v1/records';
export const DISCOVERY_DETAIL = 'https://discovery.nationalarchives.gov.uk/API/records/v1/details';
export const DISCOVERY_WEB = 'https://discovery.nationalarchives.gov.uk/details/r/';
export const FREEREG_BASE = 'https://www.freereg.org.uk';
export const FREEREG_SEARCH = `${FREEREG_BASE}/search_queries`;

export const ALLOWED_TNA_HOSTS = ['discovery.nationalarchives.gov.uk'] as const;
export const ALLOWED_FREEREG_HOSTS = ['www.freereg.org.uk'] as const;

export const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
export const MAX_HTTP_ATTEMPTS = 3;
export const RETRY_BASE_MS = 500;
export const REQUEST_TIMEOUT_MS = 90_000;

const SAFE_IAID_RE = /^[A-Za-z0-9_-]{2,40}$/;
const DATE_VALUE_RE = /^\d{4}(?:-\d{2}-\d{2})?$/;
const COLLECTION_DEPT_RE = /^([A-Z]{1,6})(?:\s+\d.*)?$/;

export const UK_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const CHAPMAN: Readonly<Record<string, string>> = {
  nottinghamshire: 'NTT',
  ntt: 'NTT',
  london: 'LND',
  lnd: 'LND',
  kent: 'KEN',
  ken: 'KEN',
};

export const GENUKI_PARISHES: Readonly<Record<string, string>> = {
  england: 'https://www.genuki.org.uk/big/eng',
  kent: 'https://www.genuki.org.uk/big/eng/KEN',
  london: 'https://www.genuki.org.uk/big/eng/LND',
  nottingham: 'https://www.genuki.org.uk/big/eng/NTT/Nottingham',
  nottinghamshire: 'https://www.genuki.org.uk/big/eng/NTT',
  yorkshire: 'https://www.genuki.org.uk/big/eng/YKS',
};

export const FREEREG_RECORD_TYPES: Readonly<Record<string, string>> = {
  all: '',
  baptism: 'ba',
  marriage: 'ma',
  burial: 'bu',
};

export const TNA_SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  detail: 'get',
  inspect: 'get',
};

export interface DiscoveryHit {
  readonly id: string;
  readonly iaid: string;
  readonly reference: string;
  readonly title: string;
  readonly description: string;
  readonly covering_dates: string;
  readonly department: string;
  readonly places: readonly string[];
  readonly held_by: readonly string[];
  readonly record_url: string;
}

export interface DiscoveryDetailPayload {
  readonly id: string | null;
  readonly iaid: string | null;
  readonly citable_reference: string | null;
  readonly title: string | null;
  readonly covering_dates: string | null;
  readonly covering_from_date: unknown;
  readonly covering_to_date: unknown;
  readonly description: string | null;
  readonly held_by: readonly string[];
  readonly digitised: unknown;
  readonly legal_status: string | null;
  readonly catalogue_level: unknown;
  readonly parent_id: string | null;
  readonly record_url: string;
}

export interface FreeregRecord {
  readonly transcript_id: string;
  readonly persons: string;
  readonly record_type: string;
  readonly event_date: string;
  readonly county: string;
  readonly register: string;
  readonly transcript_url: string;
}

export interface FreeregCachePayload {
  readonly records: FreeregRecord[];
}

export function isFreeregCachePayload(value: unknown): value is FreeregCachePayload {
  return isPlainRecord(value) && Array.isArray(value.records);
}

export function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_UK_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-uk-archives',
  });
}

export function resolveTtlHours(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_UK_ARCHIVES_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export function validateUkArchivesUrl(rawUrl: string, allowedHosts: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RecordRuntimeError(`Refusing malformed URL: '${rawUrl}'`);
  }
  if (parsed.protocol !== 'https:') {
    throw new RecordRuntimeError(`Refusing non-HTTPS URL: '${rawUrl}'`);
  }
  if (parsed.username || parsed.password) {
    throw new RecordRuntimeError('Refusing URL containing embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    throw new RecordRuntimeError(
      `Refusing host '${host}'; allowed hosts: ${[...allowedHosts].toSorted().join(', ')}.`
    );
  }
  return rawUrl;
}

export function validateIaid(iaid: string): string {
  const cleaned = iaid.trim();
  if (!SAFE_IAID_RE.test(cleaned)) {
    throw new CliValidationError(
      `Invalid TNA record id '${iaid}'; expected 2-40 ASCII letters, digits, hyphens, or underscores.`
    );
  }
  return cleaned;
}

export function normalizeDateFrom(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value.trim();
  if (!DATE_VALUE_RE.test(cleaned)) {
    throw new CliValidationError(`Invalid start date '${value}'; expected YYYY or YYYY-MM-DD.`);
  }
  if (/^\d{4}$/.test(cleaned)) {
    return `${cleaned}-01-01`;
  }
  return cleaned;
}

export function normalizeDateTo(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value.trim();
  if (!DATE_VALUE_RE.test(cleaned)) {
    throw new CliValidationError(`Invalid end date '${value}'; expected YYYY or YYYY-MM-DD.`);
  }
  if (/^\d{4}$/.test(cleaned)) {
    return `${cleaned}-12-31`;
  }
  return cleaned;
}

export function collectionDepartment(collection: string | undefined): string | null {
  if (!collection) {
    return null;
  }
  const match = COLLECTION_DEPT_RE.exec(collection.trim().toUpperCase());
  return match ? match[1] : null;
}

export function buildDiscoveryQuery(
  query: string,
  heldBy: string | undefined,
  collection: string | undefined
): string {
  const parts: string[] = [query.trim()];
  if (heldBy?.trim()) {
    parts.push(heldBy.trim());
  }
  if (collection?.trim()) {
    parts.push(`"${collection.trim()}"`);
  }
  return parts.filter((p) => p.length > 0).join(' ');
}

export function resolveChapmanCode(county: string): string {
  return CHAPMAN[county.trim().toLowerCase()] ?? county.trim().toUpperCase();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function mapDiscoveryHit(rec: Record<string, unknown>): DiscoveryHit {
  const recId = typeof rec.id === 'string' ? rec.id : '';
  const ref = typeof rec.reference === 'string' ? rec.reference : '';
  return {
    id: recId,
    iaid: recId,
    reference: ref,
    title: typeof rec.title === 'string' ? rec.title : '',
    description: typeof rec.description === 'string' ? rec.description : '',
    covering_dates: typeof rec.coveringDates === 'string' ? rec.coveringDates : '',
    department: typeof rec.department === 'string' ? rec.department : '',
    places: toStringArray(rec.places),
    held_by: toStringArray(rec.heldBy),
    record_url: recId ? `${DISCOVERY_WEB}${recId}` : '',
  };
}

export function matchesCollection(
  rec: Pick<DiscoveryHit, 'reference' | 'title'>,
  collection: string
): boolean {
  const coll = collection.trim().toUpperCase();
  const ref = rec.reference.toUpperCase();
  if (coll.startsWith('PROB')) {
    return ref.startsWith(coll);
  }
  return ref.includes(coll) || rec.title.toUpperCase().includes(coll);
}

export function mapDiscoveryDetail(raw: Record<string, unknown>): DiscoveryDetailPayload {
  const scope = isPlainRecord(raw.scopeContent) ? raw.scopeContent : {};
  const rawDesc = typeof scope.description === 'string' ? scope.description : null;
  const description = rawDesc ? cleanHtmlText(rawDesc) : null;

  const heldRaw = Array.isArray(raw.heldBy) ? raw.heldBy : [];
  const heldNames: string[] = [];
  for (const item of heldRaw) {
    if (isPlainRecord(item)) {
      const name =
        typeof item.xReferenceName === 'string'
          ? item.xReferenceName
          : typeof item.name === 'string'
            ? item.name
            : '';
      if (name) {
        heldNames.push(name);
      }
    } else if (typeof item === 'string' && item) {
      heldNames.push(item);
    }
  }

  const recId = typeof raw.id === 'string' ? raw.id : null;
  const citableRef =
    typeof raw.citableReference === 'string'
      ? raw.citableReference
      : typeof raw.referencePart === 'string'
        ? raw.referencePart
        : null;

  return {
    id: recId,
    iaid: recId,
    citable_reference: citableRef,
    title: typeof raw.title === 'string' ? raw.title : null,
    covering_dates: typeof raw.coveringDates === 'string' ? raw.coveringDates : null,
    covering_from_date: raw.coveringFromDate ?? null,
    covering_to_date: raw.coveringToDate ?? null,
    description,
    held_by: heldNames,
    digitised: raw.digitised ?? null,
    legal_status: typeof raw.legalStatus === 'string' ? raw.legalStatus : null,
    catalogue_level: raw.catalogueLevel ?? null,
    parent_id: typeof raw.parentId === 'string' ? raw.parentId : null,
    record_url: `${DISCOVERY_WEB}${recId ?? ''}`,
  };
}

export function extractFreeregToken(html: string): string {
  const match = /name="authenticity_token"\s+value="([^"]+)"/i.exec(html);
  if (match) {
    return match[1];
  }
  const $ = loadHtml(html);
  const val = $('input[name="authenticity_token"]').attr('value');
  if (val) {
    return val;
  }
  throw new RecordRuntimeError('FreeREG authenticity_token not found (page layout may have changed).');
}

export function parseFreeregResults(page: string): FreeregRecord[] {
  const $ = loadHtml(page);
  const tbody = $('tbody').first();
  if (tbody.length === 0) {
    return [];
  }
  const out: FreeregRecord[] = [];
  tbody.find('tr[id]').each((_idx, trEl) => {
    const rowId = $(trEl).attr('id') ?? '';
    if (!rowId) {
      return;
    }
    let transcriptPath = '';
    $(trEl)
      .find('a[href]')
      .each((_aIdx, aEl) => {
        if (transcriptPath) {
          return;
        }
        const label = $(aEl).text();
        if (/^\s*View\s*\d+/i.test(label)) {
          transcriptPath = $(aEl).attr('href') ?? '';
        }
      });
    const tds = $(trEl).find('td');
    if (tds.length < 5) {
      return;
    }
    const clean: string[] = [];
    tds.slice(1).each((_cIdx, tdEl) => {
      clean.push(collapseWhitespace($(tdEl).text()));
    });
    const persons = clean[0] ?? '';
    const record_type = clean[1] ?? '';
    const event_date = clean[2] ?? '';
    const county = clean[3] ?? '';
    const register = clean[4] ?? '';
    out.push({
      transcript_id: rowId,
      persons,
      record_type,
      event_date,
      county,
      register,
      transcript_url: transcriptPath ? new URL(transcriptPath, FREEREG_BASE).toString() : '',
    });
  });
  return out;
}
