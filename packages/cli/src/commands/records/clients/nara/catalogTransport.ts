import { HttpStatusError } from '../../runtime/http.js';
import { fetchWithTimeout, isPlainRecord, runWithConcurrency } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import { defaultBrowserGetRecords } from './browserFallback.js';
import { readCachedRecord, writeCachedRecord } from './catalogCache.js';
import {
  buildQueryParams,
  buildSearchPayload,
  encodeCatalogUrl,
  extractRecord,
  normalizeQueryForWafRetry,
  validateNaid,
} from './queryAndRecords.js';
import {
  API_ATTEMPTS,
  API_MAX_WORKERS,
  API_READ_TIMEOUT_MS,
  CATALOG_API_BASE,
  CATALOG_WEB_BASE,
  MAX_REDIRECTS,
  type NaraBrowserOverrides,
  type NaraRecordSummary,
  type NaraSearchPayload,
  NaraWafOrNonJsonError,
  REDIRECT_STATUSES,
  RETRY_AFTER_CAP_S,
  type SearchFilterOptions,
  TRANSIENT_STATUS_CODES,
  USER_AGENT,
} from './types.js';

export {
  canonicalSearchParams,
  getCacheRoot,
  readCachedSearch,
  writeCachedSearch,
} from './catalogCache.js';

export function parseRetryAfterSeconds(
  headers: Headers | null | undefined,
  nowMs: () => number,
  capSeconds: number
): number | undefined {
  const raw = headers?.get('retry-after')?.trim();
  if (!raw) {
    return undefined;
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.min(capSeconds, Math.max(0, parsed));
    }
  }
  const parsedDate = Date.parse(raw);
  if (Number.isFinite(parsedDate)) {
    const delta = (parsedDate - nowMs()) / 1000;
    if (Number.isFinite(delta)) {
      return Math.min(capSeconds, Math.max(0, delta));
    }
  }
  return undefined;
}

export function retryDelayMs(
  attempt: number,
  response: Response | null,
  nowMs: () => number,
  baseDelayS = 0.5,
  capS = RETRY_AFTER_CAP_S
): number {
  const retryAfterS = parseRetryAfterSeconds(response?.headers, nowMs, capS);
  if (retryAfterS !== undefined) {
    return Math.round(retryAfterS * 1000);
  }
  const jitter = 0.75 + Math.random() * 0.5;
  const delayS = Math.min(capS, baseDelayS * 2 ** (attempt - 1) * jitter);
  return Math.round(delayS * 1000);
}

export async function fetchFollowingRedirects(
  startUrl: string,
  options: {
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly fetchImpl: typeof fetch;
    readonly validateUrl?: (u: string) => string;
  }
): Promise<Response> {
  let currentUrl = options.validateUrl ? options.validateUrl(startUrl) : startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const resp = await fetchWithTimeout(
      currentUrl,
      { method: 'GET', headers: options.headers, redirect: 'manual' },
      options.timeoutMs,
      options.fetchImpl
    );
    if (options.validateUrl && resp.url) {
      options.validateUrl(resp.url);
    }
    if (REDIRECT_STATUSES.has(resp.status)) {
      const location = resp.headers.get('location');
      if (!location) {
        return resp;
      }
      if (hop === MAX_REDIRECTS) {
        throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${startUrl}`);
      }
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = options.validateUrl ? options.validateUrl(nextUrl) : nextUrl;
      continue;
    }
    return resp;
  }
  throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${startUrl}`);
}

export async function apiGetJson(
  url: string,
  apiKey: string,
  ctx: Pick<RecordCommandContext, 'fetchImpl' | 'sleepFn' | 'nowMs'>
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };

  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt += 1) {
    let resp: Response;
    try {
      resp = await fetchFollowingRedirects(url, {
        headers,
        timeoutMs: API_READ_TIMEOUT_MS,
        fetchImpl: ctx.fetchImpl,
      });
    } catch (err: unknown) {
      if (attempt >= API_ATTEMPTS) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RecordRuntimeError(`Network error fetching ${url}: ${message}`);
      }
      await ctx.sleepFn(retryDelayMs(attempt, null, ctx.nowMs));
      continue;
    }

    const contentType = resp.headers.get('content-type') ?? '';
    if (resp.status === 403 && contentType.toLowerCase().includes('html')) {
      throw new NaraWafOrNonJsonError(url, contentType, 'HTTP 403 HTML response');
    }
    if (TRANSIENT_STATUS_CODES.has(resp.status)) {
      if (attempt >= API_ATTEMPTS) {
        const body = await resp.text().catch(() => '');
        throw new HttpStatusError(resp.status, url, body.slice(0, 200).trim());
      }
      await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
      continue;
    }
    if (resp.status < 200 || resp.status >= 300) {
      const body = await resp.text().catch(() => '');
      throw new HttpStatusError(resp.status, url, body.slice(0, 200).trim());
    }
    if (!contentType.toLowerCase().includes('json')) {
      throw new NaraWafOrNonJsonError(url, contentType);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await resp.text());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new NaraWafOrNonJsonError(url, contentType, message);
    }
    if (!isPlainRecord(parsed)) {
      throw new NaraWafOrNonJsonError(
        url,
        contentType,
        `expected JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
      );
    }
    return parsed;
  }

  throw new RecordRuntimeError('NARA API retry loop ended without a response or error.');
}

export async function apiSearchOne(
  query: string | null,
  apiKey: string,
  filter: SearchFilterOptions,
  ctx: RecordCommandContext
): Promise<readonly [NaraSearchPayload | null, string]> {
  const apiUrl = encodeCatalogUrl(buildQueryParams(query, { ...filter, forApi: true }), true);
  const webUrl = encodeCatalogUrl(buildQueryParams(query, { ...filter, forApi: false }), false);
  try {
    const raw = await apiGetJson(apiUrl, apiKey, ctx);
    return [buildSearchPayload(query, webUrl, raw), webUrl];
  } catch (err: unknown) {
    if (!(err instanceof NaraWafOrNonJsonError)) {
      throw err;
    }
    const retryQuery = query ? normalizeQueryForWafRetry(query) : null;
    if (retryQuery === null) {
      return [null, webUrl];
    }
    const retryApiUrl = encodeCatalogUrl(buildQueryParams(retryQuery, { ...filter, forApi: true }), true);
    try {
      const raw = await apiGetJson(retryApiUrl, apiKey, ctx);
      return [buildSearchPayload(query, webUrl, raw), webUrl];
    } catch (retryErr: unknown) {
      if (retryErr instanceof NaraWafOrNonJsonError) {
        return [null, webUrl];
      }
      throw retryErr;
    }
  }
}

async function apiGetOneRecord(
  naid: string,
  apiKey: string,
  options: {
    readonly includeObjects: boolean;
    readonly includeText: boolean;
    readonly pageSpec: string;
  },
  ctx: RecordCommandContext
): Promise<NaraRecordSummary | null> {
  const cleanId = validateNaid(naid);
  const flag = options.includeText ? 'true' : 'false';
  const url = `${CATALOG_API_BASE}/records/search?naId_is=${cleanId}&includeExtractedText=${flag}&includeOtherExtractedText=${flag}`;
  let raw: Record<string, unknown>;
  try {
    raw = await apiGetJson(url, apiKey, ctx);
  } catch (err: unknown) {
    if (err instanceof NaraWafOrNonJsonError) {
      return null;
    }
    throw err;
  }
  const body = isPlainRecord(raw['body']) ? raw['body'] : raw;
  const hitsObj = isPlainRecord(body['hits']) ? body['hits'] : {};
  const hits = Array.isArray(hitsObj['hits']) ? hitsObj['hits'] : [];
  if (hits.length > 0) {
    return extractRecord(hits[0], {
      includeObjects: options.includeObjects,
      includeText: options.includeText,
      pageSpec: options.pageSpec,
    });
  }
  return {
    naId: cleanId,
    url: `${CATALOG_WEB_BASE}/id/${cleanId}`,
    error: 'Not found',
  };
}

export async function loadOrFetchFullRecordsWithHits(
  naids: readonly string[],
  options: {
    readonly apiKey: string | undefined;
    readonly forceBrowser: boolean;
    readonly includeText: boolean;
    readonly refresh: boolean;
    readonly cacheRoot: string;
    readonly browserTimeoutMs?: number;
  },
  ctx: RecordCommandContext,
  overrides: NaraBrowserOverrides
): Promise<readonly [NaraRecordSummary[], boolean[]]> {
  const cleanIds = naids.map((n) => validateNaid(n));
  const useApi = Boolean(options.apiKey) && !options.forceBrowser;
  const slots: (NaraRecordSummary | null)[] = Array.from({ length: cleanIds.length }, () => null);
  const hitFlags: boolean[] = Array.from({ length: cleanIds.length }, () => false);
  const missIndices: number[] = [];

  for (let idx = 0; idx < cleanIds.length; idx += 1) {
    if (!options.refresh) {
      const cached = readCachedRecord(cleanIds[idx], options.cacheRoot, options.includeText);
      if (cached !== null) {
        slots[idx] = cached;
        hitFlags[idx] = true;
        continue;
      }
    }
    missIndices.push(idx);
  }

  const browserGet =
    overrides.browserGetRecords ??
    ((ids, opts, cmdCtx) =>
      defaultBrowserGetRecords(ids, opts, cmdCtx, {
        launcher: overrides.launcher,
        closeTimeoutMs: overrides.closeTimeoutMs,
        killGraceMs: overrides.killGraceMs,
      }));

  if (missIndices.length > 0) {
    const missIds = missIndices.map((idx) => cleanIds[idx]);
    if (useApi && options.apiKey) {
      const activeKey = options.apiKey;
      const fetchedSlots = await runWithConcurrency(missIds, API_MAX_WORKERS, (id) =>
        apiGetOneRecord(
          id,
          activeKey,
          { includeObjects: true, includeText: options.includeText, pageSpec: 'all' },
          ctx
        )
      );

      const fallbackSlots: number[] = [];
      const fallbackNaids: string[] = [];
      for (let i = 0; i < missIndices.length; i += 1) {
        const slotIdx = missIndices[i];
        const rec = fetchedSlots[i];
        if (rec === null) {
          fallbackSlots.push(slotIdx);
          fallbackNaids.push(cleanIds[slotIdx]);
        } else {
          slots[slotIdx] = rec;
          await writeCachedRecord(cleanIds[slotIdx], rec, options.cacheRoot, options.includeText, ctx);
        }
      }

      if (fallbackNaids.length > 0) {
        const fallbackRecs = await browserGet(
          fallbackNaids,
          {
            includeObjects: true,
            includeText: options.includeText,
            pageSpec: 'all',
            timeoutMs: options.browserTimeoutMs,
          },
          ctx
        );
        for (let i = 0; i < fallbackSlots.length; i += 1) {
          const slotIdx = fallbackSlots[i];
          const fbRec = fallbackRecs[i];
          if (fbRec) {
            slots[slotIdx] = fbRec;
            await writeCachedRecord(cleanIds[slotIdx], fbRec, options.cacheRoot, options.includeText, ctx);
          }
        }
      }
    } else {
      const fetchedRecs = await browserGet(
        missIds,
        {
          includeObjects: true,
          includeText: options.includeText,
          pageSpec: 'all',
          timeoutMs: options.browserTimeoutMs,
        },
        ctx
      );
      for (let i = 0; i < missIndices.length; i += 1) {
        const slotIdx = missIndices[i];
        const rec = fetchedRecs[i];
        if (rec) {
          slots[slotIdx] = rec;
          await writeCachedRecord(cleanIds[slotIdx], rec, options.cacheRoot, options.includeText, ctx);
        }
      }
    }
  }

  const records: NaraRecordSummary[] = [];
  const hits: boolean[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    const rec = slots[i];
    if (rec !== null) {
      records.push(rec);
      hits.push(hitFlags[i]);
    }
  }
  return [records, hits];
}
