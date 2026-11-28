import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWriteFileSync,
  canonicalJsonStringify,
  sha256Hex,
  withAdvisoryLock,
} from '../../runtime/cache.js';
import { assertSafeUrl, DEFAULT_RETRY_STATUSES, parseRetryAfterMs } from '../../runtime/http.js';
import {
  atomicWriteCompactJson,
  fetchWithTimeout,
  IncompleteDownloadError,
  isPlainRecord,
  looksLikeHtmlBuffer,
  readJsonRecordIfValid,
  resolveSafeChildPath,
} from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  type CacheOptions,
  CEMETERY_BY_ID_QUERY,
  enrichCemetery,
  enrichMemorial,
  GET_QUERY,
  GRAPHQL_URL,
  hasImageMagic,
  imageContentType,
  type JsonRecord,
  SAFE_ID_RE,
  validateEntityId,
  validatePhotoUrl,
} from './domain.js';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const MIN_INTERVAL_MS = 300;
const GQL_ATTEMPTS = 3;
const PHOTO_ATTEMPTS = 3;
const GQL_TIMEOUT_MS = 30_000;
const PHOTO_TIMEOUT_MS = 60_000;
const RETRY_AFTER_CAP_MS = 10_000;
const MAX_REDIRECTS = 10;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const GQL_ALLOWED_HOSTS = ['.findagrave.com'] as const;

function readFreshEnvelope(filePath: string, ttlHours: number, nowMs: () => number): JsonRecord | undefined {
  const ttlSeconds = ttlHours * 3600;
  if (ttlSeconds <= 0) {
    return undefined;
  }
  const envelope = readJsonRecordIfValid(filePath);
  if (!envelope) {
    return undefined;
  }
  const cachedAt = envelope.cached_at;
  const data = envelope.data;
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || !isPlainRecord(data)) {
    return undefined;
  }
  if (nowMs() / 1000 - cachedAt <= ttlSeconds) {
    return data;
  }
  return undefined;
}

function retryDelayMs(attempt: number, response: Response | undefined, nowMs: () => number): number {
  if (response) {
    const parsed = parseRetryAfterMs(response.headers.get('retry-after'), nowMs(), RETRY_AFTER_CAP_MS);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return Math.min(RETRY_AFTER_CAP_MS, 500 * 2 ** (attempt - 1));
}

function photoTypeNotePath(filePath: string): string {
  return `${filePath}.type`;
}

function cachedPhotoBytesOk(filePath: string, content: Uint8Array): boolean {
  if (content.length === 0 || looksLikeHtmlBuffer(content, 128)) {
    return false;
  }
  if (hasImageMagic(content)) {
    return true;
  }
  const notePath = photoTypeNotePath(filePath);
  try {
    const fd = fs.openSync(notePath, 'r');
    try {
      if (!fs.fstatSync(fd).isFile()) {
        return false;
      }
      const stored = fs.readFileSync(fd, 'utf8');
      return imageContentType(stored) !== undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function photoCacheFresh(filePath: string, ttlHours: number, nowMs: () => number): boolean {
  const ttlSeconds = ttlHours * 3600;
  if (ttlSeconds <= 0) {
    return false;
  }
  try {
    const fd = fs.openSync(filePath, 'r');
    let content: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        return false;
      }
      if ((nowMs() - stat.mtimeMs) / 1000 > ttlSeconds) {
        return false;
      }
      content = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return cachedPhotoBytesOk(filePath, content);
  } catch {
    return false;
  }
}

export function storePhotoCache(filePath: string, content: Uint8Array, contentType: string | null): void {
  atomicWriteFileSync(filePath, content);
  const notePath = photoTypeNotePath(filePath);
  const imgType = imageContentType(contentType);
  if (imgType && !hasImageMagic(content)) {
    atomicWriteFileSync(notePath, `${imgType}\n`);
  } else {
    try {
      fs.rmSync(notePath, { force: true });
    } catch {
      // Ignore missing or unremovable .type sidecar.
    }
  }
}

export async function runGraphqlQuery(
  ctx: RecordCommandContext,
  query: string,
  variables: JsonRecord
): Promise<JsonRecord> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
  const bodyString = JSON.stringify({ query, variables });

  await ctx.sleepFn(MIN_INTERVAL_MS);

  for (let attempt = 1; attempt <= GQL_ATTEMPTS; attempt += 1) {
    let resp: Response | undefined;
    try {
      let currentUrl = GRAPHQL_URL;
      let currentMethod: 'POST' | 'GET' = 'POST';
      let currentBody: string | undefined = bodyString;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        assertSafeUrl(currentUrl, {
          allowedSchemes: ['https:'],
          allowedHosts: GQL_ALLOWED_HOSTS,
        });
        const init: RequestInit = {
          method: currentMethod,
          headers,
          redirect: 'manual',
          ...(currentBody !== undefined && currentMethod === 'POST' ? { body: currentBody } : {}),
        };
        resp = await fetchWithTimeout(currentUrl, init, GQL_TIMEOUT_MS, ctx.fetchImpl);
        if (REDIRECT_STATUSES.has(resp.status)) {
          const location = resp.headers.get('location');
          if (!location) {
            break;
          }
          if (hop === MAX_REDIRECTS) {
            throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${GRAPHQL_URL}`);
          }
          const nextUrl = new URL(location, currentUrl).toString();
          assertSafeUrl(nextUrl, {
            allowedSchemes: ['https:'],
            allowedHosts: GQL_ALLOWED_HOSTS,
          });
          currentUrl = nextUrl;
          if (resp.status === 303 || resp.status === 301 || resp.status === 302) {
            currentMethod = 'GET';
            currentBody = undefined;
          }
          continue;
        }
        break;
      }
    } catch (err: unknown) {
      if (err instanceof RecordRuntimeError) {
        throw err;
      }
      if (attempt < GQL_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, undefined, ctx.nowMs));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(`Request failed after ${GQL_ATTEMPTS} attempts: ${message}`);
    }

    if (!resp) {
      throw new RecordRuntimeError(`Request failed for ${GRAPHQL_URL}`);
    }

    if (resp.status === 403) {
      throw new RecordRuntimeError(
        'Find a Grave returned 403 (Cloudflare challenge). Wait a few minutes and retry, or use the website in a browser.'
      );
    }

    if (DEFAULT_RETRY_STATUSES.has(resp.status)) {
      if (attempt < GQL_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
        continue;
      }
      throw new RecordRuntimeError(`HTTP ${resp.status} from ${GRAPHQL_URL} after ${GQL_ATTEMPTS} attempts`);
    }

    if (resp.status !== 200) {
      throw new RecordRuntimeError(`HTTP ${resp.status} from ${GRAPHQL_URL}`);
    }

    const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();
    const rawBytes = Buffer.from(await resp.arrayBuffer());

    if (contentType.includes('html') || looksLikeHtmlBuffer(rawBytes, 128)) {
      if (attempt < GQL_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
        continue;
      }
      throw new RecordRuntimeError(
        `Find a Grave returned an HTML error page instead of JSON from ${GRAPHQL_URL}`
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBytes.toString('utf8'));
    } catch (err: unknown) {
      if (attempt < GQL_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(`Invalid JSON from ${GRAPHQL_URL}: ${message}`);
    }

    if (!isPlainRecord(parsedBody)) {
      throw new RecordRuntimeError(`Unexpected GraphQL payload from ${GRAPHQL_URL}`);
    }

    if (Array.isArray(parsedBody.errors) && parsedBody.errors.length > 0) {
      const messages = parsedBody.errors.map((item) => {
        const msg = isPlainRecord(item) ? String(item.message ?? '') : String(item);
        return `GraphQL error: ${msg}`;
      });
      throw new RecordRuntimeError(messages.join('\n'));
    }

    return isPlainRecord(parsedBody.data) ? parsedBody.data : {};
  }

  throw new RecordRuntimeError(`Request failed for ${GRAPHQL_URL}`);
}

export async function fetchPhotoBytes(
  ctx: RecordCommandContext,
  url: string
): Promise<{ readonly content: Buffer; readonly contentType: string | null }> {
  const validatedUrl = validatePhotoUrl(url);

  for (let attempt = 1; attempt <= PHOTO_ATTEMPTS; attempt += 1) {
    try {
      let currentUrl = validatedUrl;
      let resp: Response | undefined;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        validatePhotoUrl(currentUrl);
        resp = await fetchWithTimeout(
          currentUrl,
          {
            method: 'GET',
            headers: { 'User-Agent': USER_AGENT },
            redirect: 'manual',
          },
          PHOTO_TIMEOUT_MS,
          ctx.fetchImpl
        );
        if (resp.url) {
          validatePhotoUrl(resp.url);
        }
        if (REDIRECT_STATUSES.has(resp.status)) {
          const location = resp.headers.get('location');
          if (!location) {
            break;
          }
          if (hop === MAX_REDIRECTS) {
            throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${validatedUrl}`);
          }
          currentUrl = validatePhotoUrl(new URL(location, currentUrl).toString());
          continue;
        }
        break;
      }

      if (!resp) {
        throw new RecordRuntimeError(`Failed downloading ${validatedUrl}`);
      }

      if (DEFAULT_RETRY_STATUSES.has(resp.status)) {
        if (attempt < PHOTO_ATTEMPTS) {
          await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
          continue;
        }
        throw new RecordRuntimeError(`HTTP ${resp.status} downloading ${validatedUrl}`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new RecordRuntimeError(`HTTP ${resp.status} downloading ${validatedUrl}`);
      }

      const contentType = resp.headers.get('content-type');
      const contentEncoding = (resp.headers.get('content-encoding') ?? '').trim().toLowerCase();
      const rawLen = (resp.headers.get('content-length') ?? '').trim();
      let expectedLen: number | undefined;
      if (rawLen && (!contentEncoding || contentEncoding === 'identity') && /^\d+$/.test(rawLen)) {
        const parsedLen = Number.parseInt(rawLen, 10);
        if (parsedLen > 0) {
          expectedLen = parsedLen;
        }
      }

      const content = Buffer.from(await resp.arrayBuffer());
      if (expectedLen !== undefined && content.length < expectedLen) {
        throw new IncompleteDownloadError(
          `Incomplete photo download for ${validatedUrl}: received ${content.length} of ${expectedLen} bytes`
        );
      }

      return { content, contentType };
    } catch (err: unknown) {
      if (err instanceof RecordRuntimeError && !(err instanceof IncompleteDownloadError)) {
        throw err;
      }
      if (attempt < PHOTO_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, undefined, ctx.nowMs));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(
        `Failed downloading ${validatedUrl} after ${PHOTO_ATTEMPTS} attempts: ${message}`
      );
    }
  }

  throw new RecordRuntimeError(`Failed downloading ${validatedUrl}`);
}

export async function cachedGqlQuery(
  ctx: RecordCommandContext,
  kind: string,
  canonicalParams: JsonRecord,
  query: string,
  variables: JsonRecord,
  options: CacheOptions
): Promise<{ readonly data: JsonRecord; readonly cacheHit: boolean }> {
  const canonical = canonicalJsonStringify(canonicalParams);
  const digest = sha256Hex(canonical);
  const cachePath = resolveSafeChildPath(path.join(options.cacheRoot, '_queries', kind), `${digest}.json`);

  if (!options.refresh) {
    const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
    if (cached !== undefined) {
      return { data: cached, cacheHit: true };
    }
  }

  const lockPath = resolveSafeChildPath(
    path.join(options.cacheRoot, '_locks'),
    `query_${kind}_${digest}.lock`
  );

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
        if (cached !== undefined) {
          return { data: cached, cacheHit: true };
        }
      }
      const data = await runGraphqlQuery(ctx, query, variables);
      atomicWriteCompactJson(cachePath, {
        cached_at: ctx.nowMs() / 1000,
        params: canonicalParams,
        data,
      });
      return { data, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function loadOrFetchMemorialsWithHits(
  ctx: RecordCommandContext,
  memorialIds: readonly string[],
  options: CacheOptions
): Promise<{
  readonly memorials: JsonRecord[];
  readonly hits: boolean[];
  readonly allHit: boolean;
}> {
  const cleanIds = memorialIds.map((mid) => validateEntityId(mid, 'memorial id'));
  const byId = new Map<string, JsonRecord>();
  const hitById = new Map<string, boolean>();
  const missingIds: string[] = [];

  for (const mid of cleanIds) {
    if (byId.has(mid) || missingIds.includes(mid)) {
      continue;
    }
    const cachePath = resolveSafeChildPath(path.join(options.cacheRoot, 'memorials'), `${mid}.json`);
    if (!options.refresh) {
      const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
      if (cached !== undefined) {
        byId.set(mid, enrichMemorial(cached));
        hitById.set(mid, true);
        continue;
      }
    }
    missingIds.push(mid);
  }

  let fetched = false;
  if (missingIds.length > 0) {
    fetched = true;
    const data = await runGraphqlQuery(ctx, GET_QUERY, { ids: missingIds });
    const rawList = Array.isArray(data.memorialsById) ? data.memorialsById : [];
    for (const rawMem of rawList) {
      if (!isPlainRecord(rawMem)) {
        continue;
      }
      const mem = enrichMemorial(rawMem);
      const fetchedId = String(mem.id ?? '').trim();
      if (!fetchedId || !SAFE_ID_RE.test(fetchedId)) {
        continue;
      }
      byId.set(fetchedId, mem);
      hitById.set(fetchedId, false);
      const cachePath = resolveSafeChildPath(path.join(options.cacheRoot, 'memorials'), `${fetchedId}.json`);
      const lockPath = resolveSafeChildPath(
        path.join(options.cacheRoot, '_locks'),
        `memorial_${fetchedId}.lock`
      );
      await withAdvisoryLock(
        lockPath,
        async () => {
          atomicWriteCompactJson(cachePath, {
            cached_at: ctx.nowMs() / 1000,
            data: mem,
          });
        },
        { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
      );
    }
  }

  const ordered: JsonRecord[] = [];
  const orderedHits: boolean[] = [];
  for (const mid of cleanIds) {
    const found = byId.get(mid);
    if (found) {
      ordered.push(found);
      orderedHits.push(Boolean(hitById.get(mid)));
    }
  }

  return { memorials: ordered, hits: orderedHits, allHit: !fetched };
}

export async function loadOrFetchCemeteryById(
  ctx: RecordCommandContext,
  cemeteryId: string,
  options: CacheOptions
): Promise<{ readonly result: JsonRecord; readonly cacheHit: boolean }> {
  const cleanId = validateEntityId(cemeteryId, 'cemetery id');
  const cachePath = resolveSafeChildPath(path.join(options.cacheRoot, 'cemeteries'), `${cleanId}.json`);

  if (!options.refresh) {
    const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
    if (cached !== undefined) {
      const cem = enrichCemetery(cached);
      return { result: { total: 1, cemeteries: [cem] }, cacheHit: true };
    }
  }

  const lockPath = resolveSafeChildPath(path.join(options.cacheRoot, '_locks'), `cemetery_${cleanId}.lock`);

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
        if (cached !== undefined) {
          const cem = enrichCemetery(cached);
          return { result: { total: 1, cemeteries: [cem] }, cacheHit: true };
        }
      }
      const data = await runGraphqlQuery(ctx, CEMETERY_BY_ID_QUERY, { ids: [cleanId] });
      const rawResult = isPlainRecord(data.cemeteries) ? data.cemeteries : {};
      const rawCems = Array.isArray(rawResult.cemeteries) ? rawResult.cemeteries : [];
      const cemeteriesList = rawCems.map((c) => enrichCemetery(c));
      const result: JsonRecord = { ...rawResult, cemeteries: cemeteriesList };
      if (cemeteriesList.length > 0) {
        atomicWriteCompactJson(cachePath, {
          cached_at: ctx.nowMs() / 1000,
          data: cemeteriesList[0],
        });
      }
      return { result, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}
