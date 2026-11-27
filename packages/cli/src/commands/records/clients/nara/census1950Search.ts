import path from 'node:path';
import { z } from 'zod';
import { CliValidationError } from '../../../../errors.js';
import { canonicalJsonStringify, sha256Hex } from '../../runtime/cache.js';
import { HttpStatusError } from '../../runtime/http.js';
import { hasControlChar, isPlainRecord, readJsonRecordIfValid } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import { fetchFollowingRedirects, parseRetryAfterSeconds } from './catalogTransport.js';
import { resolveSafeChild } from './queryAndRecords.js';
import {
  type CanonicalCensus1950Query,
  CENSUS1950_API_BASE,
  CENSUS1950_IMAGE_ATTEMPTS,
  CENSUS1950_RETRY_AFTER_CAP_S,
  CENSUS1950_STATE_BY_NAME,
  CENSUS1950_STATES,
  type Census1950ApiPayload,
  TRANSIENT_STATUS_CODES,
} from './types.js';

export function census1950RetryDelayMs(
  attempt: number,
  response: Response | null,
  nowMs: () => number
): number {
  const retryAfterS = parseRetryAfterSeconds(response?.headers, nowMs, CENSUS1950_RETRY_AFTER_CAP_S);
  if (retryAfterS !== undefined) {
    return Math.round(retryAfterS * 1000);
  }
  const delayS = Math.min(CENSUS1950_RETRY_AFTER_CAP_S, 0.25 * 2 ** (attempt - 1));
  return Math.round(delayS * 1000);
}

export function normalizeCensus1950State(raw: string): string {
  const text = raw.trim();
  if (!text || text.includes('\0')) {
    throw new CliValidationError(`Invalid --state value: '${raw}'`);
  }
  const upper = text.toUpperCase();
  if (Object.hasOwn(CENSUS1950_STATES, upper)) {
    return upper;
  }
  const found = CENSUS1950_STATE_BY_NAME.get(text.toLowerCase());
  if (found) {
    return found;
  }
  throw new CliValidationError(
    `Unknown 1950 Census state: '${raw}'. Use a code such as IL or a name such as Illinois.`
  );
}

function census1950PlainToken(raw: string, flag: string, maxLen: number): string {
  const text = raw.trim();
  if (
    !text ||
    text.length > maxLen ||
    text.includes('\0') ||
    hasControlChar(text) ||
    /[\\/]|\.\./.test(text)
  ) {
    throw new CliValidationError(`Invalid ${flag} value: '${raw}'`);
  }
  return text;
}

export function canonicalCensus1950Query(options: {
  readonly state?: string;
  readonly county?: string;
  readonly name?: string;
  readonly ed?: string;
  readonly limit: number;
  readonly page?: number;
}): CanonicalCensus1950Query {
  const page = options.page ?? 1;
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new CliValidationError(`Invalid --limit value: ${String(options.limit)} (must be 1..100).`);
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new CliValidationError(`Invalid --page value: ${String(page)} (must be >= 1).`);
  }
  const stateCode = options.state?.trim() ? normalizeCensus1950State(options.state) : '';
  const countyText = options.county?.trim() ? census1950PlainToken(options.county, '--county', 80) : '';
  const nameText = options.name?.trim() ? census1950PlainToken(options.name, '--name', 120) : '';
  let edText = '';
  if (options.ed?.trim()) {
    edText = census1950PlainToken(options.ed, '--ed', 32);
    if (!/^[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*$/.test(edText)) {
      throw new CliValidationError(`Invalid --ed value: '${options.ed}'`);
    }
  }
  if (!stateCode && !countyText && !nameText && !edText) {
    throw new CliValidationError('Give at least one of --state, --county, --name, or --ed.');
  }
  return {
    state: stateCode,
    county: countyText,
    name: nameText,
    ed: edText,
    limit: options.limit,
    page,
  };
}

export function census1950SearchUrl(canonical: CanonicalCensus1950Query): string {
  const params = new URLSearchParams();
  const entries: readonly (readonly [string, string])[] = [
    ['state', canonical.state],
    ['county', canonical.county],
    ['name', canonical.name],
    ['ed', canonical.ed],
    ['size', String(canonical.limit)],
    ['page', String(canonical.page)],
  ];
  for (const [key, value] of entries) {
    if (value) {
      params.set(key, value);
    }
  }
  return `${CENSUS1950_API_BASE}/search?${params.toString()}`;
}

export function census1950CachePaths(
  canonical: CanonicalCensus1950Query,
  cacheRoot: string
): readonly [string, string] {
  const digest = sha256Hex(canonicalJsonStringify(canonical));
  const dir = path.join(cacheRoot, 'census1950');
  return [resolveSafeChild(dir, `${digest}.json`), resolveSafeChild(dir, `${digest}.lock`)];
}

const Census1950ApiPayloadSchema = z
  .object({
    total: z.number().optional(),
    page: z.number().optional(),
    size: z.number().optional(),
    results: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export function readCachedCensus1950(
  filePath: string,
  ttlHours: number,
  nowMs: () => number
): Census1950ApiPayload | null {
  if (ttlHours <= 0) {
    return null;
  }
  const envelope = readJsonRecordIfValid(filePath);
  if (!envelope) {
    return null;
  }
  const cachedAt = envelope.cached_at;
  const data = envelope.data;
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || !isPlainRecord(data)) {
    return null;
  }
  if (nowMs() / 1000 - cachedAt > ttlHours * 3600) {
    return null;
  }
  const validated = Census1950ApiPayloadSchema.safeParse(data);
  return validated.success ? validated.data : null;
}

export async function census1950FetchJson(
  url: string,
  ctx: Pick<RecordCommandContext, 'fetchImpl' | 'sleepFn' | 'nowMs'>
): Promise<Census1950ApiPayload> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'kinloom/1.0 (genealogy research)',
  };

  for (let attempt = 1; attempt <= CENSUS1950_IMAGE_ATTEMPTS; attempt += 1) {
    let resp: Response;
    try {
      resp = await fetchFollowingRedirects(url, {
        headers,
        timeoutMs: 30_000,
        fetchImpl: ctx.fetchImpl,
      });
    } catch (err: unknown) {
      if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RecordRuntimeError(`Network error fetching ${url}: ${message}`);
      }
      await ctx.sleepFn(census1950RetryDelayMs(attempt, null, ctx.nowMs));
      continue;
    }

    if (TRANSIENT_STATUS_CODES.has(resp.status)) {
      if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
        const snippet = (await resp.text().catch(() => '')).slice(0, 200).trim();
        throw new HttpStatusError(resp.status, url, snippet);
      }
      await ctx.sleepFn(census1950RetryDelayMs(attempt, resp, ctx.nowMs));
      continue;
    }
    if (resp.status < 200 || resp.status >= 300) {
      const snippet = (await resp.text().catch(() => '')).slice(0, 200).trim();
      throw new HttpStatusError(resp.status, url, snippet);
    }

    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('json')) {
      throw new RecordRuntimeError(
        `1950 Census API did not return JSON (${contentType || 'no content type'}).`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await resp.text());
    } catch {
      throw new RecordRuntimeError('1950 Census API returned invalid JSON.');
    }
    const validated = Census1950ApiPayloadSchema.safeParse(parsed);
    if (!validated.success) {
      throw new RecordRuntimeError('1950 Census API returned an unexpected payload.');
    }
    return validated.data;
  }

  throw new RecordRuntimeError('1950 Census search retries ended without a response or error.');
}
