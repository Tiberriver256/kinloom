import { CliValidationError } from '../../../../errors.js';
import { cachedJsonCall } from '../../runtime/cache.js';
import { DEFAULT_USER_AGENT, httpRequest, SsrfBlockedError } from '../../runtime/http.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  ALLOWED_DIGIHAKEMISTO_HOSTS,
  ALLOWED_HISKI_HOSTS,
  type ArchivesSearchCachePayload,
  DIGIHAKEMISTO_ARCHIVE_BASE,
  DIGIHAKEMISTO_SEARCH_URL,
  type DigihakemistoArchiveDetail,
  decodeIso88591,
  encodeIso88591Form,
  getCacheDir,
  HISKI_ENDPOINT,
  HISKI_PARISHES_URL,
  type HiskiEventDetail,
  type HiskiParish,
  type HiskiSearchResult,
  isArchivesSearchCachePayload,
  isDigihakemistoArchiveDetail,
  isHiskiEventDetail,
  isHiskiSearchResult,
  isParishesCachePayload,
  MAX_HTTP_ATTEMPTS,
  MIN_INTERVAL_MS,
  PARISH_CODE_RE,
  type ParishesCachePayload,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_MS,
  TRANSIENT_STATUS_CODES,
  validateFiUrl,
} from './domain.js';
import {
  parseDigihakemistoArchive,
  parseDigihakemistoSearch,
  parseHiskiEventDetail,
  parseHiskiParishes,
  parseHiskiResults,
} from './parsers.js';

export function checkNotChallenged(headers: Headers, text: string, label: string): void {
  if ((headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') {
    throw new RecordRuntimeError(`${label} returned a Cloudflare challenge; open it in a browser instead.`);
  }
  if (text.includes('Processing JavaScript challenge') || text.includes('<title>Just a moment...</title>')) {
    throw new RecordRuntimeError(
      `${label} returned a JavaScript anti-bot challenge; open it in a browser instead.`
    );
  }
}

export async function requestWithRetry(
  ctx: RecordCommandContext,
  options: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly allowedHosts: readonly string[];
    readonly label: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>> | undefined;
  }
): Promise<{
  readonly status: number;
  readonly url: string;
  readonly headers: Headers;
  readonly bytes: Buffer;
}> {
  validateFiUrl(options.url, options.allowedHosts);
  if (MIN_INTERVAL_MS > 0) {
    await ctx.sleepFn(MIN_INTERVAL_MS);
  }
  try {
    const res = await httpRequest(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      userAgent: DEFAULT_USER_AGENT,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxAttempts: MAX_HTTP_ATTEMPTS,
      baseBackoffMs: RETRY_BASE_MS,
      retryStatuses: TRANSIENT_STATUS_CODES,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: options.allowedHosts },
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
      throwOnHttpError: false,
    });
    validateFiUrl(res.url, options.allowedHosts);
    if (res.status >= 400) {
      if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') {
        throw new RecordRuntimeError(
          `${options.label} returned HTTP ${res.status} (Cloudflare challenge); use a browser.`
        );
      }
      throw new RecordRuntimeError(`${options.label} returned HTTP ${res.status} from ${res.url}`);
    }
    return res;
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      let host = '';
      try {
        host = new URL(err.url).hostname.toLowerCase();
      } catch {
        host = err.url;
      }
      throw new CliValidationError(
        `Refusing host '${host}'; allowed hosts: ${[...options.allowedHosts].toSorted().join(', ')}.`
      );
    }
    if (err instanceof CliValidationError || err instanceof RecordRuntimeError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`${options.label} request failed: ${message}`);
  }
}

export async function loadParishes(
  ctx: RecordCommandContext,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly parishes: HiskiParish[]; readonly cacheHit: boolean }> {
  const { value, cacheHit } = await cachedJsonCall<ParishesCachePayload>({
    cacheDir: getCacheDir(ctx),
    kind: 'hiski_parishes',
    payload: { lang: 'en' },
    ttlHours,
    refresh,
    fetch: async () => {
      const resp = await requestWithRetry(ctx, {
        method: 'GET',
        url: HISKI_PARISHES_URL,
        allowedHosts: ALLOWED_HISKI_HOSTS,
        label: 'HisKi parish list',
      });
      const html = decodeIso88591(resp.bytes);
      checkNotChallenged(resp.headers, html, 'HisKi parish list');
      return { parishes: parseHiskiParishes(html) };
    },
    cacheable: (r) => r.parishes.length > 0,
    validateCached: isParishesCachePayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return { parishes: [...value.parishes], cacheHit };
}

export async function resolveParishSpec(
  ctx: RecordCommandContext,
  parish: string,
  refresh: boolean,
  ttlHours: number
): Promise<string> {
  const cleaned = parish.trim();
  if (!cleaned || ['*', 'all', 'kaikki'].includes(cleaned.toLowerCase())) {
    return '*';
  }
  const parts = cleaned
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.every((p) => PARISH_CODE_RE.test(p))) {
    return parts.join(',');
  }

  const { parishes } = await loadParishes(ctx, refresh, ttlHours);
  const resolved: string[] = [];
  for (const part of parts) {
    if (PARISH_CODE_RE.test(part)) {
      resolved.push(part);
      continue;
    }
    const needle = part.toLowerCase();
    const exact = parishes
      .filter(
        (p) =>
          p.name.toLowerCase() === needle ||
          p.name.split(' - ').some((seg) => seg.trim().toLowerCase() === needle)
      )
      .map((p) => p.code);
    if (exact.length === 1 && exact[0] !== undefined) {
      resolved.push(exact[0]);
      continue;
    }
    const partial = parishes.filter((p) => p.name.toLowerCase().includes(needle));
    if (partial.length === 1 && partial[0] !== undefined) {
      resolved.push(partial[0].code);
      continue;
    }
    if (partial.length > 1) {
      const sample = partial
        .slice(0, 6)
        .map((p) => `${p.code} (${p.name})`)
        .join(', ');
      throw new CliValidationError(
        `Ambiguous parish '${part}'; matches: ${sample}. Pass a 4-digit parish code.`
      );
    }
    throw new CliValidationError(
      `Unknown parish '${part}'. Run \`parishes --query ${part}\` to find its 4-digit code.`
    );
  }
  return resolved.join(',');
}

export async function fetchCachedHiskiSearch(
  ctx: RecordCommandContext,
  formData: Readonly<Record<string, string>>,
  srk: string,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly value: HiskiSearchResult; readonly cacheHit: boolean }> {
  return cachedJsonCall<HiskiSearchResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'hiski_search',
    payload: { ...formData },
    ttlHours,
    refresh,
    fetch: async () => {
      const encoded = encodeIso88591Form(formData);
      const resp = await requestWithRetry(ctx, {
        method: 'POST',
        url: HISKI_ENDPOINT,
        allowedHosts: ALLOWED_HISKI_HOSTS,
        label: 'HisKi search',
        body: encoded,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const html = decodeIso88591(resp.bytes);
      checkNotChallenged(resp.headers, html, 'HisKi search');
      if (html.toLowerCase().includes('unknown parish')) {
        throw new RecordRuntimeError(`HisKi rejected parish code '${srk}'.`);
      }
      return parseHiskiResults(html);
    },
    cacheable: (r) => Array.isArray(r.records),
    validateCached: isHiskiSearchResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}

export async function fetchCachedHiskiEvent(
  ctx: RecordCommandContext,
  ref: { readonly parishCode: string; readonly bookCode: string; readonly rowId: string },
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly value: HiskiEventDetail; readonly cacheHit: boolean }> {
  const url = `${HISKI_ENDPOINT}?en+${ref.parishCode}+${ref.bookCode}+${ref.rowId}`;
  return cachedJsonCall<HiskiEventDetail>({
    cacheDir: getCacheDir(ctx),
    kind: 'hiski_event',
    payload: { parish_code: ref.parishCode, book_code: ref.bookCode, row_id: ref.rowId },
    ttlHours,
    refresh,
    fetch: async () => {
      const resp = await requestWithRetry(ctx, {
        method: 'GET',
        url,
        allowedHosts: ALLOWED_HISKI_HOSTS,
        label: 'HisKi event',
      });
      const html = decodeIso88591(resp.bytes);
      checkNotChallenged(resp.headers, html, 'HisKi event');
      return parseHiskiEventDetail(html, ref);
    },
    cacheable: (r) => Object.keys(r.fields).length > 0 || Boolean(r.parish),
    validateCached: isHiskiEventDetail,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}

export async function fetchCachedDigihakemistoSearch(
  ctx: RecordCommandContext,
  query: string,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly value: ArchivesSearchCachePayload; readonly cacheHit: boolean }> {
  return cachedJsonCall<ArchivesSearchCachePayload>({
    cacheDir: getCacheDir(ctx),
    kind: 'digihakemisto_search',
    payload: { query },
    ttlHours,
    refresh,
    fetch: async () => {
      const resp = await requestWithRetry(ctx, {
        method: 'POST',
        url: DIGIHAKEMISTO_SEARCH_URL,
        allowedHosts: ALLOWED_DIGIHAKEMISTO_HOSTS,
        label: 'Digihakemisto search',
        body: new URLSearchParams({ query }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const html = resp.bytes.toString('utf8');
      checkNotChallenged(resp.headers, html, 'Digihakemisto search');
      return { archives: parseDigihakemistoSearch(html) };
    },
    cacheable: (r) => Array.isArray(r.archives),
    validateCached: isArchivesSearchCachePayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}

export async function fetchCachedDigihakemistoArchive(
  ctx: RecordCommandContext,
  archiveId: string,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly value: DigihakemistoArchiveDetail; readonly cacheHit: boolean }> {
  const url = `${DIGIHAKEMISTO_ARCHIVE_BASE}/${archiveId}`;
  return cachedJsonCall<DigihakemistoArchiveDetail>({
    cacheDir: getCacheDir(ctx),
    kind: 'digihakemisto_archive',
    payload: { id: archiveId },
    ttlHours,
    refresh,
    fetch: async () => {
      const resp = await requestWithRetry(ctx, {
        method: 'GET',
        url,
        allowedHosts: ALLOWED_DIGIHAKEMISTO_HOSTS,
        label: 'Digihakemisto archive',
      });
      const html = resp.bytes.toString('utf8');
      checkNotChallenged(resp.headers, html, 'Digihakemisto archive');
      return parseDigihakemistoArchive(html, archiveId);
    },
    cacheable: (r) => Boolean(r.title) || r.children.length > 0,
    validateCached: isDigihakemistoArchiveDetail,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}
