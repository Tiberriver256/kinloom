import { CookieJar, httpGetJson, httpGetText, httpRequest } from '../../runtime/http.js';
import { encodeUrlPathPreservingSlashes, isPlainRecord } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  CDM_API,
  type CdmSearchPayload,
  extractAspState,
  type KyLandPayload,
  type KyPreservicaPayload,
  LAND_BY,
  LAND_URL,
  PRESERVICA_BASE,
  parseLandResults,
  parsePreservicaRss,
  trimCdmSearchData,
  UA,
} from './domain.js';

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

export async function fetchCdm(
  ctx: RecordCommandContext,
  query: string,
  alias: string,
  field: string,
  limit: number
): Promise<CdmSearchPayload> {
  const encodedQuery = encodeUrlPathPreservingSlashes(query);
  const url = `${CDM_API}/search/collection/${alias}/searchterm/${encodedQuery}/field/${field}/maxRecords/${limit}`;
  const data = await getJsonDict(ctx, url, ['www.kyhistory.com']);
  return trimCdmSearchData(data);
}

export async function fetchCdmItem(
  ctx: RecordCommandContext,
  alias: string,
  itemId: string
): Promise<Record<string, unknown>> {
  const url = `${CDM_API}/singleitem/collection/${alias}/id/${itemId}`;
  return getJsonDict(ctx, url, ['www.kyhistory.com']);
}

export async function fetchCollections(ctx: RecordCommandContext): Promise<Record<string, unknown>> {
  return getJsonDict(ctx, `${CDM_API}/collections`, ['www.kyhistory.com']);
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

export async function fetchLand(
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

export async function fetchLandPatent(
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

export async function fetchPreservica(
  ctx: RecordCommandContext,
  query: string,
  limit: number
): Promise<KyPreservicaPayload> {
  const feedUrl = `${PRESERVICA_BASE}/search/${encodeUrlPathPreservingSlashes(query)}/feed/rss2/`;
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
