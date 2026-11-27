import { CliValidationError } from '../../../errors.js';
import {
  type CommandParseSpec,
  CookieJar,
  cachedJsonCall,
  collapseWhitespace,
  emitJsonStdout,
  emitStdout,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpRequest,
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
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const DISCOVERY_SEARCH = 'https://discovery.nationalarchives.gov.uk/API/search/v1/records';
const DISCOVERY_DETAIL = 'https://discovery.nationalarchives.gov.uk/API/records/v1/details';
const DISCOVERY_WEB = 'https://discovery.nationalarchives.gov.uk/details/r/';
const FREEREG_BASE = 'https://www.freereg.org.uk';
const FREEREG_SEARCH = `${FREEREG_BASE}/search_queries`;

export const ALLOWED_TNA_HOSTS = ['discovery.nationalarchives.gov.uk'] as const;
export const ALLOWED_FREEREG_HOSTS = ['www.freereg.org.uk'] as const;

const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_HTTP_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const REQUEST_TIMEOUT_MS = 90_000;

const SAFE_IAID_RE = /^[A-Za-z0-9_-]{2,40}$/;
const DATE_VALUE_RE = /^\d{4}(?:-\d{2}-\d{2})?$/;
const COLLECTION_DEPT_RE = /^([A-Z]{1,6})(?:\s+\d.*)?$/;

const UK_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHAPMAN: Readonly<Record<string, string>> = {
  nottinghamshire: 'NTT',
  ntt: 'NTT',
  london: 'LND',
  lnd: 'LND',
  kent: 'KEN',
  ken: 'KEN',
};

const GENUKI_PARISHES: Readonly<Record<string, string>> = {
  england: 'https://www.genuki.org.uk/big/eng',
  kent: 'https://www.genuki.org.uk/big/eng/KEN',
  london: 'https://www.genuki.org.uk/big/eng/LND',
  nottingham: 'https://www.genuki.org.uk/big/eng/NTT/Nottingham',
  nottinghamshire: 'https://www.genuki.org.uk/big/eng/NTT',
  yorkshire: 'https://www.genuki.org.uk/big/eng/YKS',
};

const FREEREG_RECORD_TYPES: Readonly<Record<string, string>> = {
  all: '',
  baptism: 'ba',
  marriage: 'ma',
  burial: 'bu',
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_UK_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-uk-archives',
  });
}

function resolveTtlHours(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_UK_ARCHIVES_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_UK_ARCHIVES_CACHE_TTL_HOURS'
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

async function requestWithRetry(
  ctx: RecordCommandContext,
  options: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly allowedHosts: readonly string[];
    readonly label: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly cookieJar?: CookieJar;
  }
): Promise<{ readonly status: number; readonly url: string; readonly bytes: Buffer }> {
  validateUkArchivesUrl(options.url, options.allowedHosts);
  try {
    const res = await httpRequest(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      userAgent: UK_USER_AGENT,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxAttempts: MAX_HTTP_ATTEMPTS,
      baseBackoffMs: RETRY_BASE_MS,
      retryStatuses: TRANSIENT_STATUS_CODES,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: options.allowedHosts },
      cookieJar: options.cookieJar,
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
      throwOnHttpError: false,
    });
    validateUkArchivesUrl(res.url, options.allowedHosts);
    if (res.status >= 400) {
      throw new RecordRuntimeError(`${options.label} returned HTTP ${res.status}`);
    }
    return { status: res.status, url: res.url, bytes: res.bytes };
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      let host = '';
      try {
        host = new URL(err.url).hostname.toLowerCase();
      } catch {
        host = err.url;
      }
      throw new RecordRuntimeError(
        `Refusing host '${host}'; allowed hosts: ${[...options.allowedHosts].toSorted().join(', ')}.`
      );
    }
    if (err instanceof RecordRuntimeError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`${options.label} request failed: ${message}`);
  }
}

async function getJson(
  ctx: RecordCommandContext,
  baseUrl: string,
  params: Readonly<Record<string, string | number>> | undefined,
  allowedHosts: readonly string[],
  label: string
): Promise<Record<string, unknown>> {
  const target = new URL(baseUrl);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      target.searchParams.set(k, String(v));
    }
  }
  const res = await requestWithRetry(ctx, {
    method: 'GET',
    url: target.toString(),
    allowedHosts,
    label,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.bytes.toString('utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`${label} returned non-JSON: ${message}`);
  }
  if (!isPlainRecord(parsed)) {
    throw new RecordRuntimeError(`${label} returned unexpected JSON shape`);
  }
  return parsed;
}

function validateIaid(iaid: string): string {
  const cleaned = iaid.trim();
  if (!SAFE_IAID_RE.test(cleaned)) {
    throw new CliValidationError(
      `Invalid TNA record id '${iaid}'; expected 2-40 ASCII letters, digits, hyphens, or underscores.`
    );
  }
  return cleaned;
}

function normalizeDateFrom(value: string | undefined): string | null {
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

function normalizeDateTo(value: string | undefined): string | null {
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

function collectionDepartment(collection: string | undefined): string | null {
  if (!collection) {
    return null;
  }
  const match = COLLECTION_DEPT_RE.exec(collection.trim().toUpperCase());
  return match ? match[1] : null;
}

function buildDiscoveryQuery(
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

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function mapDiscoveryHit(rec: Record<string, unknown>): DiscoveryHit {
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

function matchesCollection(rec: Pick<DiscoveryHit, 'reference' | 'title'>, collection: string): boolean {
  const coll = collection.trim().toUpperCase();
  const ref = rec.reference.toUpperCase();
  if (coll.startsWith('PROB')) {
    return ref.startsWith(coll);
  }
  return ref.includes(coll) || rec.title.toUpperCase().includes(coll);
}

function stripTagsWithSpaces(html: string): string {
  const spaced = html.replace(/<[^>]+>/g, ' ');
  const $ = loadHtml(`<div>${spaced}</div>`);
  return collapseWhitespace($('div').text());
}

function mapDiscoveryDetail(raw: Record<string, unknown>): DiscoveryDetailPayload {
  const scope = isPlainRecord(raw.scopeContent) ? raw.scopeContent : {};
  const rawDesc = typeof scope.description === 'string' ? scope.description : null;
  const description = rawDesc ? stripTagsWithSpaces(rawDesc) : null;

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

function extractFreeregToken(html: string): string {
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

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_UK_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const TNA_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'queryOpt',
    kind: 'string',
    flags: ['--query', '-q'],
    metavar: 'QUERY',
    help: 'Search query text (alias for positional QUERY).',
  },
  {
    key: 'heldBy',
    kind: 'string',
    flags: ['--held-by'],
    metavar: 'TEXT',
    help: 'Extra place or repository text added to the query (e.g. Norfolk).',
  },
  {
    key: 'dateFrom',
    kind: 'string',
    flags: ['--start-date', '--date-from', '--from-year'],
    metavar: 'DATE',
    help: 'Covering start date (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'dateTo',
    kind: 'string',
    flags: ['--end-date', '--date-to', '--to-year'],
    metavar: 'DATE',
    help: 'Covering end date (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'collection',
    kind: 'string',
    flags: ['--collection'],
    metavar: 'REF',
    help: 'Series or department reference filter (e.g. "PROB 11"). Appended to query and post-filtered.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 1,
    default: 10,
    help: 'Maximum records to return (default: 10).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    min: 1,
    help: '1-based page number sent as sps.page.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON with boolean cache_hit.',
  },
  ...CACHE_OPTIONS,
];

const TNA_SEARCH_SPEC: CommandParseSpec = {
  options: TNA_SEARCH_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'query',
};

const TNA_GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON with boolean cache_hit.',
  },
  ...CACHE_OPTIONS,
];

const TNA_GET_SPEC: CommandParseSpec = {
  options: TNA_GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'iaid',
};

const FREEREG_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'surname',
    kind: 'string',
    flags: ['--surname'],
    required: true,
    metavar: 'SURNAME',
    help: 'Last name (required).',
  },
  {
    key: 'given',
    kind: 'string',
    flags: ['--given'],
    metavar: 'GIVEN',
    help: 'First name.',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: 'NTT',
    metavar: 'COUNTY',
    help: 'Chapman county code or name (e.g. NTT / nottinghamshire; default: NTT).',
  },
  {
    key: 'fromYear',
    kind: 'string',
    flags: ['--from-year', '--date-from'],
    metavar: 'YYYY',
    help: 'Start year (YYYY).',
  },
  {
    key: 'toYear',
    kind: 'string',
    flags: ['--to-year', '--date-to'],
    metavar: 'YYYY',
    help: 'End year (YYYY).',
  },
  {
    key: 'recordType',
    kind: 'string',
    flags: ['--record-type'],
    default: 'all',
    metavar: 'TYPE',
    help: 'Record type: all, baptism, marriage, burial (default: all).',
  },
  {
    key: 'placeContains',
    kind: 'string',
    flags: ['--place-contains'],
    metavar: 'TEXT',
    help: 'Keep only hits whose register column contains this text.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 1,
    help: 'Maximum rows after --place-contains. Does not change the cache key.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON.',
  },
  ...CACHE_OPTIONS,
];

const FREEREG_SEARCH_SPEC: CommandParseSpec = {
  options: FREEREG_SEARCH_OPTIONS,
  allowPositionals: false,
};

const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'discoveryQuery',
    kind: 'string',
    flags: ['--discovery'],
    metavar: 'QUERY',
    help: 'Discovery web search URL for a query.',
  },
  {
    key: 'freereg',
    kind: 'boolean',
    flags: ['--freereg'],
    help: 'FreeREG search form home.',
  },
  {
    key: 'nottsQuery',
    kind: 'string',
    flags: ['--notts'],
    metavar: 'QUERY',
    help: 'Nottinghamshire Archives CalmView search hint (browser).',
  },
  {
    key: 'bhoQuery',
    kind: 'string',
    flags: ['--bho'],
    metavar: 'QUERY',
    help: 'British History Online search query.',
  },
  {
    key: 'genuki',
    kind: 'string',
    flags: ['--genuki'],
    choices: Object.keys(GENUKI_PARISHES),
    metavar: 'PLACE',
    help: 'GENUKI county/parish page for England research.',
  },
];

const URL_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: false,
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom uk-archives <group|command> [options]',
    summary: 'Search UK archives: TNA Discovery and FreeREG parish registers.',
    subcommands: [
      { name: 'tna', summary: 'The National Archives (UK) Discovery API (search, get|detail|inspect).' },
      { name: 'discovery', summary: 'The National Archives Discovery catalogue (alias for `tna`).' },
      { name: 'freereg', summary: 'FreeREG parish register transcriptions (search).' },
      { name: 'url', summary: 'Print verified portal URLs (no search is run).' },
    ],
  });
}

function renderTnaHelp(groupName: string): string {
  return formatCommandUsage({
    usage: `kinloom uk-archives ${groupName} <command> [options]`,
    summary: 'The National Archives (UK) Discovery API (PROB 11 wills, Tudor/Stuart records).',
    subcommands: [
      { name: 'search', summary: 'Search UK National Archives Discovery catalogue.' },
      { name: 'get', summary: 'Fetch one TNA Discovery record by IAID (aliases: detail, inspect).' },
    ],
  });
}

function renderFreeregHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom uk-archives freereg <command> [options]',
    summary: 'FreeREG parish register transcriptions (Rails form POST, no API key).',
    subcommands: [{ name: 'search', summary: 'Search FreeREG parish register transcriptions.' }],
  });
}

async function runTnaSearch(
  argv: readonly string[],
  ctx: RecordCommandContext,
  groupName: string
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TNA_SEARCH_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: `kinloom uk-archives ${groupName} search [QUERY] [options]`,
          summary: 'Search UK National Archives Discovery catalogue (including PROB 11 PCC wills).',
          options: TNA_SEARCH_OPTIONS,
        })
      ),
    };
  }

  const resolvedQuery = parsed.positionals[0] ?? getStringOption(parsed, 'queryOpt');
  if (!resolvedQuery || !resolvedQuery.trim()) {
    throw new CliValidationError('Provide QUERY as a positional argument or via --query.');
  }

  const heldBy = getStringOption(parsed, 'heldBy');
  const collection = getStringOption(parsed, 'collection');
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const page = getNumberOption(parsed, 'page');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const q = buildDiscoveryQuery(resolvedQuery, heldBy, collection);
  const df = normalizeDateFrom(getStringOption(parsed, 'dateFrom'));
  const dt = normalizeDateTo(getStringOption(parsed, 'dateTo'));
  if (df && dt && df > dt) {
    throw new CliValidationError('--start-date must not be later than --end-date.');
  }

  const params: Record<string, string | number> = {
    'sps.searchQuery': q,
    rows: Math.min(Math.max(limit, 1), 100),
  };
  const dept = collectionDepartment(collection);
  if (dept) {
    params['sps.departments'] = dept;
  }
  if (df) {
    params['sps.dateFrom'] = df;
  }
  if (dt) {
    params['sps.dateTo'] = dt;
  }
  if (page !== undefined) {
    params['sps.page'] = page;
  }

  const { value: data, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
    cacheDir: getCacheDir(ctx),
    kind: 'discovery_search',
    payload: params,
    ttlHours,
    refresh,
    fetch: () => getJson(ctx, DISCOVERY_SEARCH, params, ALLOWED_TNA_HOSTS, 'Discovery search'),
    cacheable: (r) => Array.isArray(r.records) && (r.records.length > 0 || Number(r.count ?? 0) > 0),
    validateCached: isPlainRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  const rawRecords = Array.isArray(data.records) ? data.records : [];
  let records: DiscoveryHit[] = rawRecords
    .filter((item): item is Record<string, unknown> => isPlainRecord(item))
    .map(mapDiscoveryHit);

  if (collection) {
    records = records.filter((rec) => matchesCollection(rec, collection));
  }
  records = records.slice(0, limit);
  const total = typeof data.count === 'number' ? data.count : records.length;

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(
        ctx.io,
        {
          query: q,
          collection: collection ?? null,
          start_date: df,
          end_date: dt,
          total,
          returned: records.length,
          records,
          cache_hit: cacheHit,
        },
        1
      ),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${total} hit(s) for "${q}"; showing ${records.length}:${marker}`];
  for (const rec of records) {
    const places = rec.places.join(', ');
    lines.push(`${rec.id}  ${rec.reference}  ${rec.covering_dates}`);
    lines.push(`  ${rec.title}`);
    if (places) {
      lines.push(`  Places: ${places}`);
    }
    lines.push(`  ${rec.record_url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runTnaGet(
  argv: readonly string[],
  ctx: RecordCommandContext,
  groupName: string
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TNA_GET_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: `kinloom uk-archives ${groupName} get <IAID> [options]`,
          summary: 'Fetch one TNA Discovery record by IAID (e.g. D980036).',
          options: TNA_GET_OPTIONS,
        })
      ),
    };
  }

  const iaid = validateIaid(parsed.positionals[0]);
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const url = `${DISCOVERY_DETAIL}/${iaid}`;

  const { value: raw, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
    cacheDir: getCacheDir(ctx),
    kind: 'discovery_detail',
    payload: { id: iaid },
    ttlHours,
    refresh,
    fetch: () => getJson(ctx, url, undefined, ALLOWED_TNA_HOSTS, 'Discovery detail'),
    cacheable: (r) => Boolean(r.id || r.citableReference || r.referencePart),
    validateCached: isPlainRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  const detail = mapDiscoveryDetail(raw);
  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...detail, cache_hit: cacheHit }, 1),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${detail.id ?? ''}  ${detail.citable_reference ?? ''}  ${detail.covering_dates ?? ''}${marker}`,
  ];
  if (detail.description) {
    lines.push(`  ${detail.description}`);
  }
  if (detail.held_by.length > 0) {
    lines.push(`  Held by: ${detail.held_by.join('; ')}`);
  }
  lines.push(`  Digitised: ${String(detail.digitised)}  Legal status: ${detail.legal_status ?? 'n/a'}`);
  lines.push(`  ${detail.record_url}`);
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

interface FreeregCachePayload {
  readonly records: FreeregRecord[];
}

function isFreeregCachePayload(value: unknown): value is FreeregCachePayload {
  return isPlainRecord(value) && Array.isArray(value.records);
}

async function runFreeregSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, FREEREG_SEARCH_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom uk-archives freereg search --surname <SURNAME> [options]',
          summary: 'Search FreeREG parish register transcriptions.',
          options: FREEREG_SEARCH_OPTIONS,
        })
      ),
    };
  }

  const surname = getStringOption(parsed, 'surname') ?? '';
  const given = getStringOption(parsed, 'given');
  const county = getStringOption(parsed, 'county') ?? 'NTT';
  const fromYear = getStringOption(parsed, 'fromYear');
  const toYear = getStringOption(parsed, 'toYear');
  const rawRecordType = (getStringOption(parsed, 'recordType') ?? 'all').toLowerCase();
  if (!(rawRecordType in FREEREG_RECORD_TYPES)) {
    throw new CliValidationError(
      `Invalid value '${rawRecordType}' for '--record-type'. Expected one of: all, baptism, marriage, burial.`
    );
  }
  const placeContains = getStringOption(parsed, 'placeContains');
  const limit = getNumberOption(parsed, 'limit');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const chapman = CHAPMAN[county.trim().toLowerCase()] ?? county.trim().toUpperCase();
  const formData: Record<string, string> = {
    utf8: '✓',
    'search_query[last_name]': surname,
    'search_query[chapman_codes][]': chapman,
    commit: 'Search',
  };
  if (given) {
    formData['search_query[first_name]'] = given;
  }
  if (fromYear) {
    formData['search_query[start_year]'] = fromYear;
  }
  if (toYear) {
    formData['search_query[end_year]'] = toYear;
  }
  const rtCode = FREEREG_RECORD_TYPES[rawRecordType];
  if (rtCode) {
    formData['search_query[record_type]'] = rtCode;
  }

  const queryPayload = {
    surname: surname.trim().toLowerCase(),
    given: (given ?? '').trim().toLowerCase(),
    county: chapman,
    from_year: (fromYear ?? '').trim(),
    to_year: (toYear ?? '').trim(),
    record_type: rawRecordType,
  };

  const { value: cachedData, cacheHit } = await cachedJsonCall<FreeregCachePayload>({
    cacheDir: getCacheDir(ctx),
    kind: 'freereg_search',
    payload: queryPayload,
    ttlHours,
    refresh,
    fetch: async () => {
      const cookieJar = new CookieJar();
      const home = await requestWithRetry(ctx, {
        method: 'GET',
        url: `${FREEREG_BASE}/`,
        allowedHosts: ALLOWED_FREEREG_HOSTS,
        label: 'FreeREG home',
        cookieJar,
      });
      const token = extractFreeregToken(home.bytes.toString('utf8'));
      const postParams = new URLSearchParams({ ...formData, authenticity_token: token });
      const resp = await requestWithRetry(ctx, {
        method: 'POST',
        url: FREEREG_SEARCH,
        allowedHosts: ALLOWED_FREEREG_HOSTS,
        label: 'FreeREG search',
        body: postParams.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        cookieJar,
      });
      return { records: parseFreeregResults(resp.bytes.toString('utf8')) };
    },
    cacheable: (r) => r.records.length > 0,
    validateCached: isFreeregCachePayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  let records = [...cachedData.records];
  if (placeContains) {
    const needle = placeContains.toLowerCase();
    records = records.filter((rec) => rec.register.toLowerCase().includes(needle));
  }
  if (limit !== undefined) {
    records = records.slice(0, limit);
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(
        ctx.io,
        {
          surname,
          county: chapman,
          returned: records.length,
          records,
          cache_hit: cacheHit,
        },
        1
      ),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${records.length} FreeREG hit(s) for ${surname} (${chapman}):${marker}`];
  for (const rec of records) {
    lines.push(`${rec.event_date}  ${rec.record_type}  ${rec.persons}`);
    lines.push(`  ${rec.register}  (${rec.county})`);
    if (rec.transcript_url) {
      lines.push(`  ${rec.transcript_url}`);
    }
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom uk-archives url [options]',
          summary: 'Print verified portal URLs (no search is run).',
          options: URL_OPTIONS,
        })
      ),
    };
  }

  const discoveryQuery = getStringOption(parsed, 'discoveryQuery');
  const freereg = getBooleanOption(parsed, 'freereg');
  const nottsProvided = parsed.provided.has('nottsQuery');
  const nottsQuery = getStringOption(parsed, 'nottsQuery');
  const bhoQuery = getStringOption(parsed, 'bhoQuery');
  const genuki = getStringOption(parsed, 'genuki');

  const lines: string[] = [];
  if (discoveryQuery) {
    lines.push(
      `https://discovery.nationalarchives.gov.uk/results/r?_q=${encodeURIComponent(discoveryQuery)}&_p=100`
    );
  }
  if (freereg) {
    lines.push(`${FREEREG_BASE}/`);
  }
  if (nottsProvided) {
    lines.push('https://nawcat.nottinghamshire.gov.uk/CalmView/');
    lines.push(
      `  (browser-only: HTTPS to nawcat timed out after 45s in automated checks; search in CalmView for: ${nottsQuery || 'Lincoln'})`
    );
  }
  if (bhoQuery) {
    lines.push(
      `https://www.british-history.ac.uk/search?${new URLSearchParams({ query: bhoQuery }).toString()}`
    );
  }
  if (genuki && GENUKI_PARISHES[genuki]) {
    lines.push(GENUKI_PARISHES[genuki]);
  }
  if (lines.length === 0) {
    lines.push(
      DISCOVERY_WEB.replace(/\/$/, ''),
      `${FREEREG_BASE}/`,
      'https://www.british-history.ac.uk/',
      GENUKI_PARISHES.nottinghamshire
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

const TNA_SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  detail: 'get',
  inspect: 'get',
};

export const runUkArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [group, ...rest] = args;
    switch (group) {
      case 'tna':
      case 'discovery': {
        if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
          return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderTnaHelp(group)) };
        }
        const subcmd = resolveSubcommandAlias(rest[0], TNA_SUBCOMMAND_ALIASES);
        const subArgs = rest.slice(1);
        switch (subcmd) {
          case 'search':
            return await runTnaSearch(subArgs, ctx, group);
          case 'get':
            return await runTnaGet(subArgs, ctx, group);
          default:
            throw new CliValidationError(
              `No such command '${rest[0]}' under '${group}'. Run 'kinloom uk-archives ${group} --help'.`
            );
        }
      }

      case 'freereg': {
        if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
          return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderFreeregHelp()) };
        }
        const [subcmd, ...subArgs] = rest;
        if (subcmd === 'search') {
          return await runFreeregSearch(subArgs, ctx);
        }
        throw new CliValidationError(
          `No such command '${subcmd}' under 'freereg'. Run 'kinloom uk-archives freereg --help'.`
        );
      }

      case 'url':
        return runUrl(rest, ctx);

      default:
        throw new CliValidationError(`No such command '${group}'. Run 'kinloom uk-archives --script-help'.`);
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
