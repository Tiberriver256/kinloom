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
  httpGetJson,
  httpGetText,
  httpRequest,
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

export const CDM_BASE = 'https://www.kyhistory.com';
export const CDM_API = `${CDM_BASE}/digital/api`;
export const LAND_URL = 'https://web.sos.ky.gov/land/ccorders.aspx';
export const PRESERVICA_BASE = 'https://kdla.access.preservica.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const LAND_BY: Readonly<Record<string, string>> = {
  grantee: 'GrantHR',
  patent: 'Patent',
  'grant-book': 'GRNTBKPG',
  county: 'County',
  watercourse: 'Water',
  'survey-name': 'SurName',
  'survey-year': 'Sur_Date',
  'grant-year': 'GrantDte',
  warrant: 'Warrant',
};

const LAND_BY_CHOICES = Object.keys(LAND_BY).toSorted();
const LAND_LIMIT_CHOICES = ['10', '25', '50', '100'] as const;

export interface CdmTrimmedItem {
  readonly collectionAlias: unknown;
  readonly itemId: unknown;
  readonly title: unknown;
  readonly filetype: unknown;
  readonly itemLink: unknown;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface CdmSearchPayload {
  readonly totalResults: number;
  readonly items: readonly CdmTrimmedItem[];
  readonly verified: boolean;
}

export interface KyLandRecord {
  readonly patent: string;
  readonly grantee: string;
  readonly grant_book_page: string;
  readonly acreage: string;
  readonly county: string;
  readonly watercourse: string;
  readonly survey_name: string;
  readonly survey_date: string;
  readonly grant_date: string;
  readonly grant_note: string;
}

export interface KyLandPayload {
  readonly totalResults: number;
  readonly results: readonly KyLandRecord[];
  readonly verified: boolean;
}

export interface KyPreservicaItem {
  readonly title: string;
  readonly url: string;
}

export interface KyPreservicaPayload {
  readonly search_url: string;
  readonly feed_url: string;
  readonly results: readonly KyPreservicaItem[];
  readonly verified: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pyQuote(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

export function cleanHtmlText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const $ = loadHtml(`<body>${stripped.replace(/</g, '&lt;')}</body>`);
  return collapseWhitespace($('body').text());
}

function extractXmlText(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (isPlainRecord(node) && typeof node['#text'] === 'string') {
    return node['#text'];
  }
  return '';
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value as T];
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_KY_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-ky-archives',
  });
}

function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_KY_ARCHIVES_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_KY_ARCHIVES_CACHE_TTL_HOURS'
  );
}

async function getJsonDict(
  ctx: RecordCommandContext,
  url: string,
  allowedHosts: readonly string[]
): Promise<Record<string, unknown>> {
  const { data } = await httpGetJson<unknown>(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: UA,
    timeoutMs: 30_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts },
  });
  if (!isPlainRecord(data)) {
    throw new RecordRuntimeError(`Unexpected JSON response from ${url}`);
  }
  return data;
}

async function fetchCdm(
  ctx: RecordCommandContext,
  query: string,
  alias: string,
  field: string,
  limit: number
): Promise<CdmSearchPayload> {
  const url = `${CDM_API}/search/collection/${alias}/searchterm/${pyQuote(query)}/field/${field}/maxRecords/${limit}`;
  const data = await getJsonDict(ctx, url, ['www.kyhistory.com']);
  const rawTotal = data.totalResults;
  const total = typeof rawTotal === 'number' ? rawTotal : 0;
  const rawItems = Array.isArray(data.items) ? data.items : [];

  const trimmed: CdmTrimmedItem[] = [];
  for (const item of rawItems) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const fields: Record<string, unknown> = {};
    const metaFields = item.metadataFields;
    if (Array.isArray(metaFields)) {
      for (const entry of metaFields) {
        if (isPlainRecord(entry) && typeof entry.field === 'string') {
          fields[entry.field] = entry.value;
        }
      }
    }
    trimmed.push({
      collectionAlias: item.collectionAlias ?? null,
      itemId: item.itemId ?? null,
      title: item.title ?? null,
      filetype: item.filetype ?? null,
      itemLink: item.itemLink ?? null,
      fields,
    });
  }

  const verified = Array.isArray(data.items) && typeof data.totalResults === 'number';
  return { totalResults: total, items: trimmed, verified };
}

function isCdmSearchPayload(value: unknown): value is CdmSearchPayload {
  return (
    isPlainRecord(value) &&
    typeof value.totalResults === 'number' &&
    Array.isArray(value.items) &&
    typeof value.verified === 'boolean'
  );
}

async function fetchCdmItem(
  ctx: RecordCommandContext,
  alias: string,
  itemId: string
): Promise<Record<string, unknown>> {
  const url = `${CDM_API}/singleitem/collection/${alias}/id/${itemId}`;
  return getJsonDict(ctx, url, ['www.kyhistory.com']);
}

async function fetchCollections(ctx: RecordCommandContext): Promise<Record<string, unknown>> {
  return getJsonDict(ctx, `${CDM_API}/collections`, ['www.kyhistory.com']);
}

export function extractAspState(htmlText: string): Record<string, string> {
  const $ = loadHtml(htmlText);
  return {
    __VIEWSTATE: $('input[name="__VIEWSTATE"]').attr('value') ?? '',
    __VIEWSTATEGENERATOR: $('input[name="__VIEWSTATEGENERATOR"]').attr('value') ?? '',
    __EVENTVALIDATION: $('input[name="__EVENTVALIDATION"]').attr('value') ?? '',
  };
}

export function parseLandResults(pageHtml: string): KyLandPayload {
  const text = cleanHtmlText(pageHtml);
  const totalMatch = /(\d+) Results found/.exec(text);
  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : 0;
  const body = totalMatch ? text.slice(totalMatch.index + totalMatch[0].length) : text;
  const entries = body.split(/\d+\) Patent #/);
  const fieldRe =
    /^\s*([\d.]+)\s+Grantee:\s*([\s\S]*?)\s+Grant Book & Pg:\s*([\s\S]*?)\s+Acreage:\s*([\s\S]*?)\s+County:\s*([\s\S]*?)\s+WaterCourse:\s*([\s\S]*?)\s+Survey Name:\s*([\s\S]*?)\s+Survey Date:\s*([\s\S]*?)\s+Grant Date:\s*([\s\S]*?)\s+Grant Note:\s*([\s\S]*?)\s*$/;

  const results: KyLandRecord[] = [];
  for (const chunk of entries.slice(1)) {
    const match = fieldRe.exec(chunk);
    if (!match) {
      continue;
    }
    results.push({
      patent: match[1].trim(),
      grantee: match[2].trim(),
      grant_book_page: match[3].trim(),
      acreage: match[4].trim(),
      county: match[5].trim(),
      watercourse: match[6].trim(),
      survey_name: match[7].trim(),
      survey_date: match[8].trim(),
      grant_date: match[9].trim(),
      grant_note: match[10].trim(),
    });
  }

  const verified = results.length > 0 || totalMatch !== null;
  return { totalResults: total, results, verified };
}

function isKyLandPayload(value: unknown): value is KyLandPayload {
  return (
    isPlainRecord(value) &&
    typeof value.totalResults === 'number' &&
    Array.isArray(value.results) &&
    typeof value.verified === 'boolean'
  );
}

async function postLandForm(
  ctx: RecordCommandContext,
  jar: CookieJar,
  formData: Readonly<Record<string, string>>
): Promise<string> {
  const res = await httpRequest(LAND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(formData).toString(),
    userAgent: UA,
    timeoutMs: 30_000,
    maxAttempts: 1,
    cookieJar: jar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['web.sos.ky.gov'] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  return res.bytes.toString('utf8');
}

async function fetchLand(
  ctx: RecordCommandContext,
  term: string,
  by: string,
  limit: string
): Promise<KyLandPayload> {
  const jar = new CookieJar();
  const initial = await httpGetText(LAND_URL, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: UA,
    timeoutMs: 30_000,
    maxAttempts: 1,
    cookieJar: jar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['web.sos.ky.gov'] },
  });
  const advHtml = await postLandForm(ctx, jar, {
    ...extractAspState(initial.text),
    __EVENTTARGET: 'ctl00$ContentPlaceHolder1$LbAdvSearch',
    __EVENTARGUMENT: '',
  });
  const resultsHtml = await postLandForm(ctx, jar, {
    ...extractAspState(advHtml),
    __EVENTTARGET: '',
    __EVENTARGUMENT: '',
    ctl00$ContentPlaceHolder1$DdlAdvSearchBy: LAND_BY[by],
    ctl00$ContentPlaceHolder1$TxtAdvSearchFor: term,
    ctl00$ContentPlaceHolder1$ddlMatch: 'All',
    ctl00$ContentPlaceHolder1$ddlShow: limit,
    ctl00$ContentPlaceHolder1$ddlSortBy: '',
    ctl00$ContentPlaceHolder1$ddlSortDir: 'ASC',
    ctl00$ContentPlaceHolder1$BtnAdvSearch: 'Search',
  });
  return parseLandResults(resultsHtml);
}

async function fetchLandPatent(
  ctx: RecordCommandContext,
  number: string,
  book: string | undefined,
  page: string | undefined
): Promise<KyLandPayload> {
  const jar = new CookieJar();
  const initial = await httpGetText(LAND_URL, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: UA,
    timeoutMs: 30_000,
    maxAttempts: 1,
    cookieJar: jar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['web.sos.ky.gov'] },
  });
  const resultsHtml = await postLandForm(ctx, jar, {
    ...extractAspState(initial.text),
    __EVENTTARGET: '',
    __EVENTARGUMENT: '',
    ctl00$ContentPlaceHolder1$TxtSPatent: number,
    ctl00$ContentPlaceHolder1$TxtSBook: book ?? '',
    ctl00$ContentPlaceHolder1$TxtSPage: page ?? '',
    ctl00$ContentPlaceHolder1$BtnSearch: 'Search',
  });
  return parseLandResults(resultsHtml);
}

export function parsePreservicaRss(
  feed: string,
  query: string,
  feedUrl: string,
  limit: number
): KyPreservicaPayload {
  const lower = feed.toLowerCase();
  const isRss = lower.includes('<rss') || lower.includes('<channel>');
  const results: KyPreservicaItem[] = [];
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
        const rawTitle = extractXmlText(rawItem.title);
        const rawLink = extractXmlText(rawItem.link).trim();
        if (!rawTitle || !rawLink || seen.has(rawLink)) {
          continue;
        }
        seen.add(rawLink);
        const title = cleanHtmlText(rawTitle);
        if (title) {
          results.push({ title, url: rawLink });
        }
        if (results.length >= limit) {
          break;
        }
      }
    }
  } catch {
    // Non-XML responses (e.g. HTML block pages) yield empty unverified results.
  }

  return {
    search_url: `${PRESERVICA_BASE}/?s=${pyQuote(query)}`,
    feed_url: feedUrl,
    results,
    verified: results.length > 0 || isRss,
  };
}

function isKyPreservicaPayload(value: unknown): value is KyPreservicaPayload {
  return (
    isPlainRecord(value) &&
    typeof value.search_url === 'string' &&
    typeof value.feed_url === 'string' &&
    Array.isArray(value.results) &&
    typeof value.verified === 'boolean'
  );
}

async function fetchPreservica(
  ctx: RecordCommandContext,
  query: string,
  limit: number
): Promise<KyPreservicaPayload> {
  const feedUrl = `${PRESERVICA_BASE}/search/${pyQuote(query)}/feed/rss2/`;
  const { text } = await httpGetText(feedUrl, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: UA,
    timeoutMs: 30_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['kdla.access.preservica.com'] },
  });
  return parsePreservicaRss(text, query, feedUrl, limit);
}

function emitLandResults(
  ctx: RecordCommandContext,
  data: KyLandPayload,
  asJson: boolean,
  cacheHit: boolean
): RecordCommandOutcome {
  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        totalResults: data.totalResults,
        results: data.results,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${data.totalResults} patent(s) found${marker}`];
  for (const r of data.results) {
    lines.push(
      `- Patent #${r.patent}: ${r.grantee} (${r.county} Co., grant ${r.grant_date}, survey ${r.survey_date}, ${r.acreage} acres)`
    );
    lines.push(
      `  Grant Book & Pg: ${r.grant_book_page}; watercourse: ${r.watercourse}; survey name: ${r.survey_name}`
    );
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit,
  };
}

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_KY_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const CDM_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'alias',
    kind: 'string',
    flags: ['--collection'],
    default: 'all',
    metavar: 'ALIAS',
    help: 'CONTENTdm collection alias (default: all). See `collections`.',
  },
  {
    key: 'field',
    kind: 'string',
    flags: ['--field'],
    default: 'all',
    metavar: 'FIELD',
    help: 'Search field: all, title, descri, date, subjec, publis, source (default: all).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Maximum records to return.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print raw trimmed JSON.' },
  ...CACHE_OPTIONS,
];

const JSON_CACHE_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print raw JSON.' },
  ...CACHE_OPTIONS,
];

const LAND_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'by',
    kind: 'string',
    flags: ['--by'],
    choices: LAND_BY_CHOICES,
    default: 'grantee',
    help: 'Advanced-search field.',
  },
  {
    key: 'limit',
    kind: 'string',
    flags: ['--limit'],
    choices: LAND_LIMIT_CHOICES,
    default: '10',
    help: 'Results per page.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print JSON.' },
  ...CACHE_OPTIONS,
];

const LAND_PATENT_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'book',
    kind: 'string',
    flags: ['--book'],
    metavar: 'BOOK',
    help: 'Grant book number (quick search).',
  },
  {
    key: 'page',
    kind: 'string',
    flags: ['--page'],
    metavar: 'PAGE',
    help: 'Grant book page (quick search).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print JSON.' },
  ...CACHE_OPTIONS,
];

const PRESERVICA_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Maximum items to return.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print JSON.' },
  ...CACHE_OPTIONS,
];

const CDM_SPEC: CommandParseSpec = {
  options: CDM_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

const CDM_ITEM_SPEC: CommandParseSpec = {
  options: JSON_CACHE_OPTIONS,
  allowPositionals: true,
  minPositionals: 2,
  maxPositionals: 2,
  positionalLabel: 'alias item_id',
};

const COLLECTIONS_SPEC: CommandParseSpec = {
  options: JSON_CACHE_OPTIONS,
  allowPositionals: false,
};

const SINGLE_QUERY_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

const LAND_SPEC: CommandParseSpec = {
  options: LAND_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'term',
};

const LAND_PATENT_SPEC: CommandParseSpec = {
  options: LAND_PATENT_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'number',
};

const PRESERVICA_SPEC: CommandParseSpec = {
  options: PRESERVICA_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives <command> [options]',
    summary: 'Search Kentucky archives: KHS, KDLA Preservica, Land Office.',
    subcommands: [
      { name: 'cdm', summary: 'Search KHS Digital Collections (CONTENTdm API).' },
      { name: 'cdm-item', summary: 'Show full metadata for one CONTENTdm item: ALIAS ITEM_ID.' },
      { name: 'collections', summary: 'List the KHS Digital Collections (CONTENTdm aliases).' },
      { name: 'cdm-url', summary: 'Print the verified KHS catalog web search URL for QUERY.' },
      { name: 'land', summary: 'Advanced search of County Court Orders patents (1835-2000).' },
      { name: 'land-patent', summary: 'Quick search of County Court Orders patents by patent number.' },
      { name: 'preservica', summary: 'Search the KDLA Preservica e-archives (WordPress search RSS feed).' },
      { name: 'urls', summary: 'Print every verified Kentucky search URL for QUERY (no requests).' },
    ],
  });
}

export const runKyArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    const cacheDir = getCacheDir(ctx);

    switch (subcmd) {
      case 'cdm': {
        const parsed = parseCommandArgs(rest, CDM_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom ky-archives cdm <QUERY> [options]',
                summary: 'Search KHS Digital Collections (CONTENTdm API).',
                options: CDM_OPTIONS,
              })
            ),
          };
        }
        const query = parsed.positionals[0];
        const alias = getStringOption(parsed, 'alias') ?? 'all';
        const field = getStringOption(parsed, 'field') ?? 'all';
        const limit = getNumberOption(parsed, 'limit') ?? 10;
        const asJson = getBooleanOption(parsed, 'asJson');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        const { value: data, cacheHit } = await cachedJsonCall<CdmSearchPayload>({
          cacheDir,
          kind: 'cdm',
          payload: { query, alias, field, limit },
          ttlHours,
          refresh,
          schema: CACHE_SCHEMA,
          fetch: () => fetchCdm(ctx, query, alias, field, limit),
          cacheable: (r) => r.verified,
          validateCached: isCdmSearchPayload,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });

        if (asJson) {
          return {
            exitCode: 0,
            bytesOut: emitJsonStdout(ctx.io, {
              totalResults: data.totalResults,
              items: data.items,
              cache_hit: cacheHit,
            }),
            cacheHit,
          };
        }

        const marker = cacheHit ? ' [cache]' : '';
        const lines: string[] = [
          `${data.totalResults} result(s) for '${query}' in KHS Digital Collections${marker}`,
        ];
        for (const it of data.items) {
          const dateVal = typeof it.fields.date === 'string' ? it.fields.date : '';
          const dateSuffix = dateVal ? ` (${dateVal})` : '';
          lines.push(
            `- [${String(it.collectionAlias ?? '')}:${String(it.itemId ?? '')}] ${String(it.title ?? '')}${dateSuffix}`
          );
          lines.push(`  ${CDM_BASE}/digital${String(it.itemLink ?? '')}`);
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
      }

      case 'cdm-item': {
        const parsed = parseCommandArgs(rest, CDM_ITEM_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom ky-archives cdm-item <ALIAS> <ITEM_ID> [options]',
                summary: 'Show full metadata for one CONTENTdm item: ALIAS ITEM_ID.',
                options: JSON_CACHE_OPTIONS,
              })
            ),
          };
        }
        const [alias, itemId] = parsed.positionals;
        const asJson = getBooleanOption(parsed, 'asJson');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        const { value: data, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
          cacheDir,
          kind: 'cdm-item',
          payload: { alias, item_id: itemId },
          ttlHours,
          refresh,
          schema: CACHE_SCHEMA,
          fetch: () => fetchCdmItem(ctx, alias, itemId),
          cacheable: (r) =>
            (Array.isArray(r.fields) && r.fields.length > 0) || Boolean(r.title) || Boolean(r.contentType),
          validateCached: isPlainRecord,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });

        if (asJson) {
          return {
            exitCode: 0,
            bytesOut: emitJsonStdout(ctx.io, { ...data, cache_hit: cacheHit }),
            cacheHit,
          };
        }

        const marker = cacheHit ? ' [cache]' : '';
        const lines: string[] = [`${CDM_BASE}/digital/singleitem/collection/${alias}/id/${itemId}${marker}`];
        if (Array.isArray(data.fields)) {
          for (const rawField of data.fields) {
            if (!isPlainRecord(rawField)) {
              continue;
            }
            const label = String(rawField.label ?? rawField.key ?? '');
            lines.push(`${label}: ${String(rawField.value ?? '')}`);
          }
        }
        if (data.contentType) {
          lines.push(`Content-Type: ${String(data.contentType)}`);
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
      }

      case 'collections': {
        const parsed = parseCommandArgs(rest, COLLECTIONS_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom ky-archives collections [options]',
                summary: 'List the KHS Digital Collections (CONTENTdm aliases).',
                options: JSON_CACHE_OPTIONS,
              })
            ),
          };
        }
        const asJson = getBooleanOption(parsed, 'asJson');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        const { value: data, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
          cacheDir,
          kind: 'collections',
          payload: {},
          ttlHours,
          refresh,
          schema: CACHE_SCHEMA,
          fetch: () => fetchCollections(ctx),
          cacheable: (r) => Array.isArray(r.cards) && r.cards.length > 0,
          validateCached: isPlainRecord,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });

        const cards = Array.isArray(data.cards) ? data.cards : [];
        const totalCollections =
          typeof data.totalCollections === 'number' ? data.totalCollections : cards.length;

        if (asJson) {
          return {
            exitCode: 0,
            bytesOut: emitJsonStdout(ctx.io, {
              totalCollections,
              cards,
              cache_hit: cacheHit,
            }),
            cacheHit,
          };
        }

        const marker = cacheHit ? ' [cache]' : '';
        const lines: string[] = [`${totalCollections} collections${marker}`];
        for (const card of cards) {
          if (isPlainRecord(card)) {
            lines.push(`- ${String(card.alias ?? '')}: ${String(card.title ?? '')}`);
          }
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
      }

      case 'cdm-url': {
        const parsed = parseCommandArgs(rest, SINGLE_QUERY_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom ky-archives cdm-url <QUERY>',
                summary: 'Print the verified KHS catalog web search URL for QUERY.',
              })
            ),
          };
        }
        const query = parsed.positionals[0];
        return {
          exitCode: 0,
          bytesOut: emitStdout(ctx.io, `${CDM_BASE}/cdm/search/searchterm/${pyQuote(query)}/mode/exact`),
        };
      }

      case 'land': {
        const parsed = parseCommandArgs(rest, LAND_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom ky-archives land <TERM> [options]',
                summary: 'Advanced search of County Court Orders patents (1835-2000).',
                options: LAND_OPTIONS,
              })
            ),
          };
        }
        const term = parsed.positionals[0];
        const by = getStringOption(parsed, 'by') ?? 'grantee';
        const limit = getStringOption(parsed, 'limit') ?? '10';
        const asJson = getBooleanOption(parsed, 'asJson');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        const { value: data, cacheHit } = await cachedJsonCall<KyLandPayload>({
          cacheDir,
          kind: 'land',
          payload: { term, by, limit },
          ttlHours,
          refresh,
          schema: CACHE_SCHEMA,
          fetch: () => fetchLand(ctx, term, by, limit),
          cacheable: (r) => r.verified,
          validateCached: isKyLandPayload,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });
        return emitLandResults(ctx, data, asJson, cacheHit);
      }

      case 'land-patent': {
        const parsed = parseCommandArgs(rest, LAND_PATENT_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom ky-archives land-patent <NUMBER> [options]',
                summary: 'Quick search of County Court Orders patents by patent number.',
                options: LAND_PATENT_OPTIONS,
              })
            ),
          };
        }
        const number = parsed.positionals[0];
        const book = getStringOption(parsed, 'book');
        const page = getStringOption(parsed, 'page');
        const asJson = getBooleanOption(parsed, 'asJson');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        const { value: data, cacheHit } = await cachedJsonCall<KyLandPayload>({
          cacheDir,
          kind: 'land-patent',
          payload: { number, book: book ?? '', page: page ?? '' },
          ttlHours,
          refresh,
          schema: CACHE_SCHEMA,
          fetch: () => fetchLandPatent(ctx, number, book, page),
          cacheable: (r) => r.verified,
          validateCached: isKyLandPayload,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });
        return emitLandResults(ctx, data, asJson, cacheHit);
      }

      case 'preservica': {
        const parsed = parseCommandArgs(rest, PRESERVICA_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom ky-archives preservica <QUERY> [options]',
                summary: 'Search the KDLA Preservica e-archives (WordPress search RSS feed).',
                options: PRESERVICA_OPTIONS,
              })
            ),
          };
        }
        const query = parsed.positionals[0];
        const limit = getNumberOption(parsed, 'limit') ?? 10;
        const asJson = getBooleanOption(parsed, 'asJson');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        const { value: data, cacheHit } = await cachedJsonCall<KyPreservicaPayload>({
          cacheDir,
          kind: 'preservica',
          payload: { query, limit },
          ttlHours,
          refresh,
          schema: CACHE_SCHEMA,
          fetch: () => fetchPreservica(ctx, query, limit),
          cacheable: (r) => r.verified,
          validateCached: isKyPreservicaPayload,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });

        if (asJson) {
          return {
            exitCode: 0,
            bytesOut: emitJsonStdout(ctx.io, {
              search_url: data.search_url,
              feed_url: data.feed_url,
              results: data.results,
              cache_hit: cacheHit,
            }),
            cacheHit,
          };
        }

        const marker = cacheHit ? ' [cache]' : '';
        const lines: string[] = [`KDLA Preservica search: ${data.search_url}${marker}`];
        if (data.results.length === 0) {
          lines.push('No results in the search feed.');
        } else {
          for (const item of data.results) {
            lines.push(`- ${item.title}`);
            lines.push(`  ${item.url}`);
          }
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
      }

      case 'urls': {
        const parsed = parseCommandArgs(rest, SINGLE_QUERY_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom ky-archives urls <QUERY>',
                summary: 'Print every verified Kentucky search URL for QUERY (no requests).',
              })
            ),
          };
        }
        const query = parsed.positionals[0];
        const lines = [
          'KHS Digital Collections (CONTENTdm web search):',
          `  ${CDM_BASE}/cdm/search/searchterm/${pyQuote(query)}/mode/exact`,
          'KDLA Preservica e-archives (WordPress search):',
          `  ${PRESERVICA_BASE}/?s=${pyQuote(query)}`,
          'Land Office, County Court Orders patents (form search, no GET URL):',
          `  ${LAND_URL}`,
          'Pass the Word oral histories (browse/search in browser):',
          '  https://passtheword.ky.gov/',
          'KHS research starting page:',
          '  https://history.ky.gov/research-genealogy',
        ];
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
      }

      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom ky-archives --script-help'.`);
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
