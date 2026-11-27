import { cachedJsonCall } from '../../runtime/cache.js';
import { httpRequest } from '../../runtime/http.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  BASE,
  getCacheDir,
  isArticlesPayload,
  isCategoriesPayload,
  LOCATION_URL,
  type PersiArticlesPayload,
  type PersiCategoriesPayload,
  parsePersiArticles,
  parsePersiCategories,
  SURNAME_URL,
  TITLE_URL,
  US_STATES,
} from './domain.js';

const PERSI_USER_AGENT = 'Mozilla/5.0';
const PERSI_ALLOWED_HOSTS = ['www.genealogycenter.info', 'genealogycenter.info'] as const;
const RETRY_WAIT_MS = 5000;

export async function fetchPersiForm(
  ctx: RecordCommandContext,
  url: string,
  formData: Readonly<Record<string, string>>,
  referer: string
): Promise<string> {
  const body = new URLSearchParams(formData).toString();
  const headers: Record<string, string> = {
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Referer: referer,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await httpRequest(url, {
        method: 'POST',
        headers,
        body,
        userAgent: PERSI_USER_AGENT,
        timeoutMs: 60_000,
        maxAttempts: 1,
        throwOnHttpError: false,
        urlPolicy: { allowedSchemes: ['https:'], allowedHosts: PERSI_ALLOWED_HOSTS },
        fetchImpl: ctx.fetchImpl,
        sleepFn: ctx.sleepFn,
        nowMs: ctx.nowMs,
      });
      if ((res.status === 412 || res.status === 429) && attempt === 1) {
        await ctx.sleepFn(RETRY_WAIT_MS);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new RecordRuntimeError(`HTTP ${res.status} fetching ${url}`);
      }
      return res.bytes.toString('utf8');
    } catch (err: unknown) {
      lastErr = err;
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new RecordRuntimeError(`PERSI request failed: ${message}`);
}

export async function fetchCachedSurname(
  ctx: RecordCommandContext,
  surname: string,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly value: PersiArticlesPayload; readonly cacheHit: boolean }> {
  return cachedJsonCall<PersiArticlesPayload>({
    cacheDir: getCacheDir(ctx),
    kind: 'surname',
    payload: { surname: surname.trim().toLowerCase() },
    ttlHours,
    refresh,
    fetch: async () => {
      const page = await fetchPersiForm(
        ctx,
        SURNAME_URL,
        { surname, sort: 'title', submit: 'Search' },
        `${BASE}/search_persisurname.php`
      );
      return { articles: parsePersiArticles(page) };
    },
    cacheable: (r) => r.articles.length > 0,
    validateCached: isArticlesPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}

export async function fetchCachedTitle(
  ctx: RecordCommandContext,
  keyword: string,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly value: PersiArticlesPayload; readonly cacheHit: boolean }> {
  return cachedJsonCall<PersiArticlesPayload>({
    cacheDir: getCacheDir(ctx),
    kind: 'title',
    payload: { keyword: keyword.trim().toLowerCase() },
    ttlHours,
    refresh,
    fetch: async () => {
      const page = await fetchPersiForm(
        ctx,
        TITLE_URL,
        { keyword, sort: 'title', submit: 'Search' },
        `${BASE}/search_persiarttitle.php`
      );
      return { articles: parsePersiArticles(page) };
    },
    cacheable: (r) => r.articles.length > 0,
    validateCached: isArticlesPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}

export async function fetchCachedLocation(
  ctx: RecordCommandContext,
  rawState: string,
  county: string,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly value: PersiCategoriesPayload; readonly cacheHit: boolean }> {
  const state = rawState.toUpperCase();
  if (!US_STATES.has(state)) {
    throw new RecordRuntimeError(`Unknown state code: ${state}`);
  }
  return cachedJsonCall<PersiCategoriesPayload>({
    cacheDir: getCacheDir(ctx),
    kind: 'location',
    payload: { state, county: county.trim().toLowerCase() },
    ttlHours,
    refresh,
    fetch: async () => {
      const page = await fetchPersiForm(
        ctx,
        LOCATION_URL,
        { subloc: 'USA', cosearch: 'USA', usloc: state, county, submit: 'Search' },
        `${BASE}/search_persilocation.php`
      );
      return { categories: parsePersiCategories(page) };
    },
    cacheable: (r) => r.categories.length > 0,
    validateCached: isCategoriesPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}
