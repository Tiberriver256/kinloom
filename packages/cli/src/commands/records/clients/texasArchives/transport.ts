import { cachedJsonCall, resolveCacheDir } from '../../runtime/cache.js';
import { fetchWithCurl, httpGetJson, httpGetText } from '../../runtime/http.js';
import {
  encodeUrlPathPreservingSlashes,
  isPlainRecord,
  resolveEnvCacheTtlHours,
} from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  CACHE_SCHEMA,
  DEFAULT_CACHE_TTL_HOURS,
  isTexasOaiRecord,
  isTexasOpenSearchPage,
  isTexasTdaCachePayload,
  mapOpenSearchEntry,
  normalizeArk,
  PORTAL_BASE,
  PORTAL_OAI,
  PORTAL_OPENSEARCH,
  parseOaiRecord,
  parseTdaRss,
  TDA_BASE,
  type TexasOaiRecord,
  type TexasOpenSearchPage,
  type TexasTdaCachePayload,
  type TexasTdaItem,
  UA,
} from './domain.js';

export function getTexasArchivesCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_TEXAS_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-texas-archives',
  });
}

export function resolveTexasArchivesTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_TEXAS_ARCHIVES_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export async function fetchOpenSearchPage(
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

export async function fetchPortalItem(ctx: RecordCommandContext, arkToken: string): Promise<TexasOaiRecord> {
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

export async function fetchTdaRss(ctx: RecordCommandContext, query: string): Promise<TexasTdaItem[]> {
  const url = `${TDA_BASE}/search/${encodeUrlPathPreservingSlashes(query)}/feed/rss2/`;
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

export async function cachedOpenSearchPage(
  ctx: RecordCommandContext,
  cacheDir: string,
  query: string,
  page: number,
  ttlHours: number,
  refresh: boolean
): Promise<{ readonly value: TexasOpenSearchPage; readonly cacheHit: boolean }> {
  return cachedJsonCall<TexasOpenSearchPage>({
    cacheDir,
    kind: 'portal_opensearch',
    payload: { q: query, page },
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: () => fetchOpenSearchPage(ctx, query, page),
    cacheable: (r) => r.entries.length > 0 || r.total > 0,
    validateCached: isTexasOpenSearchPage,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}

export async function cachedPortalItem(
  ctx: RecordCommandContext,
  cacheDir: string,
  ark: string,
  ttlHours: number,
  refresh: boolean
): Promise<{ readonly value: TexasOaiRecord; readonly cacheHit: boolean }> {
  return cachedJsonCall<TexasOaiRecord>({
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
}

export async function cachedTdaRss(
  ctx: RecordCommandContext,
  cacheDir: string,
  query: string,
  ttlHours: number,
  refresh: boolean
): Promise<{ readonly value: TexasTdaCachePayload; readonly cacheHit: boolean }> {
  return cachedJsonCall<TexasTdaCachePayload>({
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
}
