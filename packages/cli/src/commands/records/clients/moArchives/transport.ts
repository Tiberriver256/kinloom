import fs from 'node:fs';
import { atomicWriteFileSync } from '../../runtime/cache.js';
import { CookieJar, httpGetBytes, httpRequest } from '../../runtime/http.js';
import type { RecordCommandContext } from '../../runtime/types.js';
import {
  ALLOWED_HOSTS,
  DEATH_PAGE,
  DEATH_POST,
  DEATH_RESULTS,
  type DeathRecord,
  type DetailRecord,
  extractFormToken,
  PRE1910_DETAIL,
  PRE1910_PAGE,
  PRE1910_POST,
  PRE1910_RESULTS,
  type Pre1910Record,
  parseDeathRows,
  parseDetailFields,
  parsePre1910Rows,
  type SearchCachePayload,
  totalResults,
  USER_AGENT,
} from './domain.js';

async function postSearch(
  ctx: RecordCommandContext,
  jar: CookieJar,
  pageUrl: string,
  postUrl: string,
  data: Readonly<Record<string, string>>
): Promise<string> {
  const pageRes = await httpRequest(pageUrl, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    cookieJar: jar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  const pageHtml = pageRes.bytes.toString('utf8');
  const token = extractFormToken(pageHtml);
  const payload: Record<string, string> = { ...data };
  if (token) {
    payload.__ncforminfo = token;
  }
  const postRes = await httpRequest(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    cookieJar: jar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  return postRes.bytes.toString('utf8');
}

async function fetchPages<T>(
  ctx: RecordCommandContext,
  jar: CookieJar,
  firstHtml: string,
  resultsUrl: string,
  parse: (html: string) => T[],
  limit: number
): Promise<SearchCachePayload<T>> {
  const rawTotal = totalResults(firstHtml);
  const records = parse(firstHtml);
  const total = rawTotal !== null ? rawTotal : records.length;
  let page = 2;
  while (records.length < Math.min(limit, total)) {
    const pagedUrl = `${resultsUrl}?PageNumber=${page}&recordsPerPage=50`;
    const res = await httpRequest(pagedUrl, {
      method: 'GET',
      userAgent: USER_AGENT,
      timeoutMs: 60_000,
      maxAttempts: 1,
      cookieJar: jar,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
    });
    const more = parse(res.bytes.toString('utf8'));
    if (more.length === 0) {
      break;
    }
    records.push(...more);
    page += 1;
  }
  const verified = records.length > 0 || rawTotal !== null;
  return { total, results: records.slice(0, limit), verified };
}

export async function downloadPdf(
  ctx: RecordCommandContext,
  url: string,
  dest: string,
  overwrite: boolean
): Promise<{ readonly dest: string; readonly skipped: boolean; readonly size: number }> {
  if (fs.existsSync(dest) && !overwrite) {
    return { dest, skipped: true, size: fs.statSync(dest).size };
  }
  const res = await httpGetBytes(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    rejectHtml: true,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  atomicWriteFileSync(dest, res.bytes);
  return { dest, skipped: false, size: res.bytes.length };
}

export async function searchDeath(
  ctx: RecordCommandContext,
  data: Readonly<Record<string, string>>,
  limit: number
): Promise<SearchCachePayload<DeathRecord>> {
  const jar = new CookieJar();
  const firstHtml = await postSearch(ctx, jar, DEATH_PAGE, DEATH_POST, data);
  return fetchPages(ctx, jar, firstHtml, DEATH_RESULTS, parseDeathRows, limit);
}

export async function searchPre1910(
  ctx: RecordCommandContext,
  kind: 'birth' | 'death',
  data: Readonly<Record<string, string>>,
  limit: number
): Promise<SearchCachePayload<Pre1910Record>> {
  const jar = new CookieJar();
  const firstHtml = await postSearch(ctx, jar, PRE1910_PAGE, PRE1910_POST, data);
  return fetchPages(ctx, jar, firstHtml, PRE1910_RESULTS, (h) => parsePre1910Rows(h, kind), limit);
}

export async function fetchDetail(ctx: RecordCommandContext, cleanId: string): Promise<DetailRecord> {
  const url = `${PRE1910_DETAIL}?id=${cleanId}`;
  const res = await httpRequest(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  return {
    id: cleanId,
    url,
    fields: parseDetailFields(res.bytes.toString('utf8')),
  };
}
