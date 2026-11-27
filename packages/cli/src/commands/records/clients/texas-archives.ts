import { CliValidationError } from '../../../errors.js';
import {
  type CommandParseSpec,
  cachedJsonCall,
  collapseWhitespace,
  emitJsonStdout,
  emitStdout,
  fetchWithCurl,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpGetJson,
  httpGetText,
  loadHtml,
  type OptionSpec,
  parseCacheTtlHours,
  parseCommandArgs,
  parseXml,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  resolveCacheDir,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const CACHE_SCHEMA = 1;

export const PORTAL_BASE = 'https://texashistory.unt.edu';
export const PORTAL_OPENSEARCH = `${PORTAL_BASE}/search/opensearch/`;
export const PORTAL_OAI = `${PORTAL_BASE}/oai/`;
export const TDA_BASE = 'https://tsl.access.preservica.com';
export const GLO_LAND = 'https://s3.glo.texas.gov/lookup/index.php';
export const TSLAC_HOME = 'https://www.tsl.texas.gov/';
export const TSLAC_RANGERS = 'https://www.tsl.texas.gov/agency/items/texas-rangers';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface TexasOpenSearchEntry {
  readonly ark: string;
  readonly title: string;
  readonly creator: string;
  readonly date: string;
  readonly description: string;
  readonly type: string;
  readonly url: string;
  readonly thumbnail: string;
}

export interface TexasOpenSearchPage {
  readonly total: number;
  readonly page: number;
  readonly entries: readonly TexasOpenSearchEntry[];
}

export interface TexasOaiRecord {
  readonly oai_identifier: string;
  readonly ark: string;
  readonly titles: readonly string[];
  readonly creators: readonly string[];
  readonly subjects: readonly string[];
  readonly dates: readonly string[];
  readonly types: readonly string[];
  readonly descriptions: readonly string[];
  readonly set_specs: readonly string[];
  readonly url: string;
  readonly browser_note?: string;
}

export interface TexasTdaItem {
  readonly title: string;
  readonly url: string;
}

interface TexasTdaCachePayload {
  readonly results: readonly TexasTdaItem[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pyQuote(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

function cleanHtmlText(html: string): string {
  const stripped = html.replace(/<[^>]+>/g, ' ');
  const $ = loadHtml(`<body>${stripped.replace(/</g, '&lt;')}</body>`);
  return collapseWhitespace($('body').text());
}

export function extractArkId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('ark:/')) {
    const match = /metap?th\d+|metadc\d+/.exec(trimmed);
    if (match) {
      return match[0];
    }
    const parts = trimmed.replace(/\/+$/, '').split('/');
    return parts.at(-1) || trimmed;
  }
  return trimmed;
}

export function normalizeArk(arkToken: string): string {
  return `ark:/67531/${extractArkId(arkToken)}`;
}

export function parseIsoDate(raw: string, flagName: string): string {
  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new CliValidationError(`Invalid ${flagName} '${raw}': expected YYYY-MM-DD.`);
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new CliValidationError(`Invalid ${flagName} '${raw}': not a real calendar date.`);
  }
  return trimmed;
}

export function parseItemDate(value: string | undefined): readonly [string | null, string | null] {
  if (!value) {
    return [null, null];
  }
  const trimmed = value.trim();
  const fullMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (fullMatch) {
    const iso = `${fullMatch[1]}-${fullMatch[2]}-${fullMatch[3]}`;
    return [iso, iso];
  }
  const rangeMatch = /^(\d{4})\/(\d{4})$/.exec(trimmed);
  if (rangeMatch) {
    return [`${rangeMatch[1]}-01-01`, `${rangeMatch[2]}-12-31`];
  }
  const yearMatch = /^(\d{4})$/.exec(trimmed);
  if (yearMatch) {
    return [`${yearMatch[1]}-01-01`, `${yearMatch[1]}-12-31`];
  }
  return [null, null];
}

export function entryMatchesFilters(
  entry: TexasOpenSearchEntry & { readonly subjects?: readonly string[] },
  county: string | undefined,
  typeFilter: string | undefined,
  dateFrom: string | undefined,
  dateTo: string | undefined
): boolean {
  if (typeFilter) {
    if ((entry.type || '').toLowerCase() !== typeFilter.toLowerCase()) {
      return false;
    }
  }
  if (county) {
    const blob = [entry.title, entry.description, ...(entry.subjects ?? [])]
      .filter((part): part is string => Boolean(part))
      .join(' ')
      .toLowerCase();
    if (!blob.includes(county.toLowerCase())) {
      return false;
    }
  }
  if (dateFrom || dateTo) {
    const [start, end] = parseItemDate(entry.date);
    if (start === null && end === null) {
      return false;
    }
    const lo = start ?? end;
    const hi = end ?? start;
    if (lo === null || hi === null) {
      return false;
    }
    if (dateFrom && hi < dateFrom) {
      return false;
    }
    if (dateTo && lo > dateTo) {
      return false;
    }
  }
  return true;
}

function buildPortalQuery(query: string, county: string | undefined): string {
  const parts = [query.trim()];
  if (county?.trim()) {
    parts.push(county.trim());
  }
  return parts.filter(Boolean).join(' ');
}

function mapOpenSearchEntry(raw: unknown): TexasOpenSearchEntry {
  const obj = isPlainRecord(raw) ? raw : {};
  const str = (key: string): string => (typeof obj[key] === 'string' ? obj[key] : '');
  return {
    ark: str('id'),
    title: str('title'),
    creator: str('dc:creator'),
    date: str('dc:date'),
    description: str('dc:description'),
    type: str('dc:type'),
    url: str('link'),
    thumbnail: str('thumbnail'),
  };
}

async function fetchOpenSearchPage(
  ctx: RecordCommandContext,
  query: string,
  page: number
): Promise<TexasOpenSearchPage> {
  const params = new URLSearchParams({ q: query, format: 'json', pw: String(page) });
  const url = `${PORTAL_OPENSEARCH}?${params.toString()}`;
  const { data } = await httpGetJson<unknown>(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: UA,
    timeoutMs: 60_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['texashistory.unt.edu'] },
  });
  if (!isPlainRecord(data)) {
    throw new RecordRuntimeError('OpenSearch returned unexpected JSON shape');
  }
  const feed = data.feed ?? {};
  if (!isPlainRecord(feed)) {
    throw new RecordRuntimeError('OpenSearch returned malformed feed');
  }
  const rawTotal = feed['opensearch:totalResults'];
  const parsedTotal = Number.parseInt(String(rawTotal ?? '0'), 10);
  const total = Number.isInteger(parsedTotal) ? parsedTotal : 0;
  const rawEntries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
  const entries = rawEntries.map((item) => mapOpenSearchEntry(item));
  return { total, page, entries };
}

function isTexasOpenSearchPage(value: unknown): value is TexasOpenSearchPage {
  return (
    isPlainRecord(value) &&
    typeof value.total === 'number' &&
    typeof value.page === 'number' &&
    Array.isArray(value.entries)
  );
}

function extractXmlNodeText(node: unknown): string {
  if (typeof node === 'string') {
    return node.trim();
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    return String(node).trim();
  }
  if (isPlainRecord(node) && typeof node['#text'] === 'string') {
    return node['#text'].trim();
  }
  return '';
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value as T];
}

function findChildByLocalName(parent: Record<string, unknown>, localName: string): unknown {
  if (localName in parent) {
    return parent[localName];
  }
  for (const [key, val] of Object.entries(parent)) {
    const colon = key.indexOf(':');
    if (colon !== -1 && key.slice(colon + 1) === localName) {
      return val;
    }
  }
  return undefined;
}

function collectDcValues(node: unknown, dcKey: string, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectDcValues(item, dcKey, out);
    }
    return;
  }
  if (!isPlainRecord(node)) {
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text') {
      continue;
    }
    if (key === dcKey) {
      for (const item of toArray<unknown>(val)) {
        const text = extractXmlNodeText(item);
        if (text) {
          out.push(text);
        }
      }
    } else {
      collectDcValues(val, dcKey, out);
    }
  }
}

export function parseOaiRecord(xmlText: string): TexasOaiRecord {
  let parsed: unknown;
  try {
    parsed = parseXml<unknown>(xmlText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`OAI response was not valid XML: ${message}`);
  }
  if (!isPlainRecord(parsed)) {
    throw new RecordRuntimeError('OAI response was not valid XML');
  }
  const rootRaw = findChildByLocalName(parsed, 'OAI-PMH');
  if (!isPlainRecord(rootRaw)) {
    throw new RecordRuntimeError('OAI response was not valid XML: missing OAI-PMH root');
  }

  const errRaw = findChildByLocalName(rootRaw, 'error');
  if (errRaw !== undefined) {
    const firstErr = toArray<unknown>(errRaw)[0];
    const code =
      isPlainRecord(firstErr) && typeof firstErr['@_code'] === 'string' ? firstErr['@_code'] : 'error';
    const msg = extractXmlNodeText(firstErr);
    throw new RecordRuntimeError(`OAI error ${code}: ${msg}`);
  }

  const getRecord = findChildByLocalName(rootRaw, 'GetRecord');
  const recRaw = isPlainRecord(getRecord)
    ? findChildByLocalName(getRecord, 'record')
    : findChildByLocalName(rootRaw, 'record');
  const rec = toArray<unknown>(recRaw).find(isPlainRecord);
  if (!rec) {
    throw new RecordRuntimeError('OAI response had no record');
  }

  const headerRaw = findChildByLocalName(rec, 'header');
  let identifier = '';
  const setSpecs: string[] = [];
  if (isPlainRecord(headerRaw)) {
    identifier = extractXmlNodeText(findChildByLocalName(headerRaw, 'identifier'));
    for (const s of toArray<unknown>(findChildByLocalName(headerRaw, 'setSpec'))) {
      const val = extractXmlNodeText(s);
      if (val) {
        setSpecs.push(val);
      }
    }
  }

  const titles: string[] = [];
  const creators: string[] = [];
  const subjects: string[] = [];
  const dates: string[] = [];
  const types: string[] = [];
  const descriptions: string[] = [];
  collectDcValues(rec, 'dc:title', titles);
  collectDcValues(rec, 'dc:creator', creators);
  collectDcValues(rec, 'dc:subject', subjects);
  collectDcValues(rec, 'dc:date', dates);
  collectDcValues(rec, 'dc:type', types);
  collectDcValues(rec, 'dc:description', descriptions);

  const arkMatch = /metap?th\d+|metadc\d+/.exec(identifier);
  const ark = arkMatch ? `ark:/67531/${arkMatch[0]}` : '';

  return {
    oai_identifier: identifier,
    ark,
    titles,
    creators,
    subjects,
    dates,
    types,
    descriptions,
    set_specs: setSpecs,
    url: ark ? `${PORTAL_BASE}/${ark}/` : '',
  };
}

function isTexasOaiRecord(value: unknown): value is TexasOaiRecord {
  return (
    isPlainRecord(value) &&
    typeof value.ark === 'string' &&
    Array.isArray(value.titles) &&
    typeof value.url === 'string'
  );
}

async function fetchPortalItem(ctx: RecordCommandContext, arkToken: string): Promise<TexasOaiRecord> {
  const ark = normalizeArk(arkToken);
  const params = new URLSearchParams({
    verb: 'GetRecord',
    identifier: ark,
    metadataPrefix: 'oai_dc',
  });
  const url = `${PORTAL_OAI}?${params.toString()}`;
  const { text } = await httpGetText(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: UA,
    timeoutMs: 60_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['texashistory.unt.edu'] },
  });
  const data = parseOaiRecord(text);
  return {
    ...data,
    ark,
    url: `${PORTAL_BASE}/${ark}/`,
    browser_note: 'Item pages and scans need a browser (ALTCHA challenge on texashistory.unt.edu).',
  };
}

export function parseTdaRss(feed: string, limit?: number): TexasTdaItem[] {
  if (feed.slice(0, 500).includes('403 Forbidden') && !feed.includes('<rss')) {
    throw new RecordRuntimeError('TDA RSS returned a 403 page to curl');
  }
  const results: TexasTdaItem[] = [];
  const seen = new Set<string>();
  try {
    const parsed = parseXml<unknown>(feed, {
      isArray: (tagName) => tagName === 'item',
    });
    if (isPlainRecord(parsed)) {
      const rssNode = isPlainRecord(parsed.rss) ? parsed.rss : parsed;
      const channel = isPlainRecord(rssNode.channel) ? rssNode.channel : undefined;
      const items = channel ? toArray<unknown>(channel.item) : [];
      for (const rawItem of items) {
        if (!isPlainRecord(rawItem)) {
          continue;
        }
        const rawTitle = extractXmlNodeText(rawItem.title);
        const link = extractXmlNodeText(rawItem.link);
        if (!rawTitle || !link || seen.has(link)) {
          continue;
        }
        seen.add(link);
        const title = cleanHtmlText(rawTitle);
        if (title.toLowerCase().startsWith('search results for')) {
          continue;
        }
        if (title) {
          results.push({ title, url: link });
        }
        if (limit !== undefined && results.length >= limit) {
          break;
        }
      }
    }
  } catch {
    // Non-XML response produces empty list so caller won't cache it.
  }
  return results;
}

function isTexasTdaCachePayload(value: unknown): value is TexasTdaCachePayload {
  return isPlainRecord(value) && Array.isArray(value.results);
}

async function fetchTdaRss(ctx: RecordCommandContext, query: string): Promise<TexasTdaItem[]> {
  const url = `${TDA_BASE}/search/${pyQuote(query)}/feed/rss2/`;
  const response = await fetchWithCurl(url, {
    userAgent: UA,
    timeoutMs: 60_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['tsl.access.preservica.com'] },
    execFileImpl: ctx.execFileImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  return parseTdaRss(response.bytes.toString('utf8'));
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_TEXAS_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-texas-archives',
  });
}

function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_TEXAS_ARCHIVES_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_TEXAS_ARCHIVES_CACHE_TTL_HOURS'
  );
}

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_TEXAS_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const PORTAL_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    metavar: 'COUNTY',
    help: 'Add a county term to the query and filter hits that mention it.',
  },
  {
    key: 'dateFrom',
    kind: 'string',
    flags: ['--date-from'],
    metavar: 'YYYY-MM-DD',
    help: 'Keep hits on or after this date (YYYY-MM-DD).',
  },
  {
    key: 'dateTo',
    kind: 'string',
    flags: ['--date-to'],
    metavar: 'YYYY-MM-DD',
    help: 'Keep hits on or before this date (YYYY-MM-DD).',
  },
  {
    key: 'typeFilter',
    kind: 'string',
    flags: ['--type'],
    metavar: 'TYPE',
    help: 'Keep hits whose dc:type matches, e.g. text_newspaper.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Maximum hits to print after filters.',
  },
  {
    key: 'pages',
    kind: 'integer',
    flags: ['--pages'],
    min: 1,
    default: 3,
    help: 'OpenSearch pages to scan (100 hits each).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...CACHE_OPTIONS,
];

const PORTAL_ITEM_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...CACHE_OPTIONS,
];

const TDA_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Maximum items to return.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...CACHE_OPTIONS,
];

const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'portal',
    kind: 'boolean',
    flags: ['--portal'],
    help: 'Portal to Texas History full-text search URL.',
  },
  { key: 'tda', kind: 'boolean', flags: ['--tda'], help: 'Texas Digital Archive search URL.' },
  { key: 'glo', kind: 'boolean', flags: ['--glo'], help: 'Texas GLO land grant lookup (browser-only).' },
  { key: 'rangers', kind: 'boolean', flags: ['--rangers'], help: 'TSLAC Texas Rangers collection pointer.' },
  {
    key: 'tslac',
    kind: 'boolean',
    flags: ['--tslac'],
    help: 'Texas State Library and Archives Commission home.',
  },
];

const PORTAL_SEARCH_SPEC: CommandParseSpec = {
  options: PORTAL_SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'query',
};

const PORTAL_ITEM_SPEC: CommandParseSpec = {
  options: PORTAL_ITEM_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'ark_id',
};

const TDA_SPEC: CommandParseSpec = {
  options: TDA_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

const URL_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'query',
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom texas-archives <command> [options]',
    summary: 'Search Texas archives: Portal to Texas History, Texas Digital Archive, URL builders.',
    subcommands: [
      { name: 'portal', summary: 'The Portal to Texas History (University of North Texas): search, item.' },
      { name: 'tda', summary: 'Search the Texas Digital Archive (TSLAC Preservica RSS feed).' },
      { name: 'url', summary: 'Print verified portal URLs (no search is run).' },
    ],
  });
}

function renderPortalHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom texas-archives portal <command> [options]',
    summary: 'The Portal to Texas History (University of North Texas).',
    subcommands: [
      { name: 'search', summary: 'Search the Portal via its public OpenSearch JSON API.' },
      { name: 'item', summary: 'Fetch Dublin Core metadata for one Portal item (OAI-PMH GetRecord).' },
    ],
  });
}

async function runPortalSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PORTAL_SEARCH_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom texas-archives portal search <QUERY...> [options]',
          summary: 'Search the Portal via its public OpenSearch JSON API.',
          options: PORTAL_SEARCH_OPTIONS,
        })
      ),
    };
  }

  const county = getStringOption(parsed, 'county');
  const rawDateFrom = getStringOption(parsed, 'dateFrom');
  const rawDateTo = getStringOption(parsed, 'dateTo');
  const dateFrom = rawDateFrom ? parseIsoDate(rawDateFrom, '--date-from') : undefined;
  const dateTo = rawDateTo ? parseIsoDate(rawDateTo, '--date-to') : undefined;
  const typeFilter = getStringOption(parsed, 'typeFilter');
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const pages = getNumberOption(parsed, 'pages') ?? 3;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getCacheDir(ctx);

  const q = buildPortalQuery(parsed.positionals.join(' '), county);
  const matched: TexasOpenSearchEntry[] = [];
  let totalReported = 0;
  const pageHits: boolean[] = [];

  for (let page = 1; page <= pages; page += 1) {
    if (matched.length >= limit) {
      break;
    }
    const currentPage = page;
    const { value: batch, cacheHit } = await cachedJsonCall<TexasOpenSearchPage>({
      cacheDir,
      kind: 'portal_opensearch',
      payload: { q, page: currentPage },
      ttlHours,
      refresh,
      schema: CACHE_SCHEMA,
      fetch: () => fetchOpenSearchPage(ctx, q, currentPage),
      cacheable: (r) => r.entries.length > 0 || r.total > 0,
      validateCached: isTexasOpenSearchPage,
      nowMs: ctx.nowMs,
      sleepFn: ctx.sleepFn,
    });
    pageHits.push(cacheHit);
    totalReported = batch.total;
    if (batch.entries.length === 0 && page > 1) {
      break;
    }
    for (const entry of batch.entries) {
      if (entryMatchesFilters({ ...entry, subjects: [] }, county, typeFilter, dateFrom, dateTo)) {
        matched.push(entry);
      }
      if (matched.length >= limit) {
        break;
      }
    }
  }

  const allCached = pageHits.length > 0 && pageHits.every(Boolean);
  const searchUrl = `${PORTAL_BASE}/search/?${new URLSearchParams({ q, t: 'fulltext' }).toString()}`;
  const payload = {
    query: q,
    opensearch_total: totalReported,
    returned: matched.length,
    records: matched,
    search_url: searchUrl,
    note: 'HTML search requires a browser (ALTCHA). Filters apply to OpenSearch fields only.',
    cache_hit: allCached,
  };

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, payload, 1),
      cacheHit: allCached,
    };
  }

  const marker = allCached ? ' [cache]' : '';
  const lines: string[] = [
    `${totalReported} OpenSearch hit(s) for '${q}'; showing ${matched.length} after filters:${marker}`,
    `${searchUrl}  (browser)`,
  ];
  for (const rec of matched) {
    lines.push(rec.title || '(no title)');
    lines.push(`  ${rec.date || ''}  [${rec.type || ''}]  ${rec.creator || ''}`.trimEnd());
    lines.push(`  ${rec.ark}  ${rec.url}`);
    lines.push('');
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit: allCached };
}

async function runPortalItem(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PORTAL_ITEM_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom texas-archives portal item <ARK_ID> [options]',
          summary: 'Fetch Dublin Core metadata for one Portal item (OAI-PMH GetRecord).',
          options: PORTAL_ITEM_OPTIONS,
        })
      ),
    };
  }

  const ark = normalizeArk(parsed.positionals[0]);
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getCacheDir(ctx);

  const { value: data, cacheHit } = await cachedJsonCall<TexasOaiRecord>({
    cacheDir,
    kind: 'portal_item',
    payload: { ark },
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: () => fetchPortalItem(ctx, ark),
    cacheable: (r) => r.titles.length > 0 || Boolean(r.oai_identifier),
    validateCached: isTexasOaiRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...data, cache_hit: cacheHit }, 1),
      cacheHit,
    };
  }

  const title = data.titles[0] ?? '(no title)';
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${title}${marker}`, `  ${data.ark}`];
  if (data.creators.length > 0) {
    lines.push(`  Creator(s): ${data.creators.slice(0, 6).join('; ')}`);
  }
  if (data.dates.length > 0) {
    lines.push(`  Date(s): ${data.dates.slice(0, 6).join('; ')}`);
  }
  if (data.types.length > 0) {
    lines.push(`  Type(s): ${data.types.join(', ')}`);
  }
  if (data.subjects.length > 0) {
    lines.push(`  Subject(s): ${data.subjects.slice(0, 8).join('; ')}`);
  }
  lines.push(`  ${data.url}`);
  if (data.browser_note) {
    lines.push(`  ${data.browser_note}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runTda(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TDA_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom texas-archives tda <QUERY> [options]',
          summary: 'Search the Texas Digital Archive (TSLAC Preservica RSS feed).',
          options: TDA_OPTIONS,
        })
      ),
    };
  }

  const query = parsed.positionals[0];
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getCacheDir(ctx);

  const { value: data, cacheHit } = await cachedJsonCall<TexasTdaCachePayload>({
    cacheDir,
    kind: 'tda_rss',
    payload: { query: query.trim() },
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: async () => ({ results: await fetchTdaRss(ctx, query) }),
    cacheable: (r) => r.results.length > 0,
    validateCached: isTexasTdaCachePayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  const results = data.results.slice(0, limit);
  const payload = {
    search_url: `${TDA_BASE}/?s=${pyQuote(query)}`,
    feed_url: `${TDA_BASE}/search/${pyQuote(query)}/feed/rss2/`,
    returned: results.length,
    results,
    cache_hit: cacheHit,
  };

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, payload, 1),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`TDA search: ${payload.search_url}${marker}`];
  if (results.length === 0) {
    lines.push('No results in the RSS feed (feed returns at most ~25 items per query).');
  } else {
    for (const item of results) {
      lines.push(`- ${item.title}`);
      lines.push(`  ${item.url}`);
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
          usage: 'kinloom texas-archives url [QUERY] [options]',
          summary: 'Print verified portal URLs (no search is run).',
          options: URL_OPTIONS,
        })
      ),
    };
  }

  const portal = getBooleanOption(parsed, 'portal');
  const tda = getBooleanOption(parsed, 'tda');
  const glo = getBooleanOption(parsed, 'glo');
  const rangers = getBooleanOption(parsed, 'rangers');
  const tslac = getBooleanOption(parsed, 'tslac');
  const showAll = !(portal || tda || glo || rangers || tslac);
  const q = parsed.positionals[0] || 'Houston';

  const lines: string[] = [];
  if (portal || showAll) {
    lines.push(
      'Portal to Texas History (browser; ALTCHA on HTML):',
      `  ${PORTAL_BASE}/search/?${new URLSearchParams({ q, t: 'fulltext' }).toString()}`,
      'Portal OpenSearch JSON (CLI uses this):',
      `  ${PORTAL_OPENSEARCH}?${new URLSearchParams({ q, format: 'json' }).toString()}`
    );
  }
  if (tda || showAll) {
    lines.push('Texas Digital Archive:', `  ${TDA_BASE}/?s=${pyQuote(q)}`);
  }
  if (glo || showAll) {
    lines.push(
      'Texas General Land Office Land Grant Search (browser-only; SPA):',
      `  ${GLO_LAND}`,
      '  Texas was not a public-land state; state grants are indexed here, not BLM GLO patents.'
    );
  }
  if (rangers || showAll) {
    lines.push(
      'TSLAC Texas Rangers:',
      `  ${TSLAC_RANGERS}`,
      '  Ranger muster rolls: open records request or in-person at TSLAC.'
    );
  }
  if (tslac || showAll) {
    lines.push('Texas State Library and Archives Commission:', `  ${TSLAC_HOME}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

export const runTexasArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'portal': {
        if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
          return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPortalHelp()) };
        }
        const [portalSub, ...portalRest] = rest;
        switch (portalSub) {
          case 'search':
            return await runPortalSearch(portalRest, ctx);
          case 'item':
            return await runPortalItem(portalRest, ctx);
          default:
            throw new CliValidationError(
              `No such portal command '${portalSub}'. Run 'kinloom texas-archives portal --help'.`
            );
        }
      }
      case 'tda':
        return await runTda(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(
          `No such command '${subcmd}'. Run 'kinloom texas-archives --script-help'.`
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
