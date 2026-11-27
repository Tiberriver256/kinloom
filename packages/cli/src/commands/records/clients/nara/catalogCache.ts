import path from 'node:path';
import { z } from 'zod';
import { canonicalJsonStringify, resolveCacheDir, sha256Hex, withAdvisoryLock } from '../../runtime/cache.js';
import { atomicWriteCompactJson, isPlainRecord, readJsonRecordIfValid } from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';
import { resolveSafeChild } from './queryAndRecords.js';
import type {
  CanonicalSearchParams,
  NaraRecordSummary,
  NaraSearchPayload,
  SearchFilterOptions,
} from './types.js';

export function getCacheRoot(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_NARA_CACHE_DIR'],
    defaultSubdir: 'kinloom-nara',
  });
}

export function canonicalSearchParams(
  query: string | null,
  filter: SearchFilterOptions
): CanonicalSearchParams {
  const levels = filter.levels
    .flatMap((item) => item.split(','))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const recordGroups = filter.recordGroups
    .flatMap((item) => item.split(','))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return {
    query: query ?? null,
    levels,
    record_groups: recordGroups,
    online: Boolean(filter.online),
    material_type: filter.materialType ?? null,
    person: filter.person ?? null,
    title: filter.title ?? null,
    geo: filter.geo ?? null,
    control: filter.control ?? null,
    start_date: filter.startDate ?? null,
    end_date: filter.endDate ?? null,
    page: filter.page,
    limit: filter.limit,
  };
}

function queryCachePath(canonical: CanonicalSearchParams, cacheRoot: string): readonly [string, string] {
  const digest = sha256Hex(canonicalJsonStringify(canonical));
  return [digest, resolveSafeChild(path.join(cacheRoot, '_queries'), `${digest}.json`)];
}

const NaraDigitalObjectSummarySchema = z.object({
  page: z.number(),
  filename: z.string(),
  url: z.string(),
});

const NaraExtractedTextItemSchema = z.object({
  page: z.number(),
  filename: z.string(),
  text: z.string(),
});

const NaraRecordSummarySchema = z.object({
  naId: z.string(),
  title: z.string().optional(),
  url: z.string(),
  level: z.string().optional(),
  rg: z.union([z.string(), z.number()]).optional(),
  rgTitle: z.string().optional(),
  series: z.string().optional(),
  seriesNaId: z.string().optional(),
  dates: z.array(z.string()).optional(),
  microform: z.array(z.string()).optional(),
  access: z.string().optional(),
  use: z.string().optional(),
  scope: z.string().optional(),
  location: z.union([z.string(), z.array(z.string())]).optional(),
  objectCount: z.number().optional(),
  objects: z.array(NaraDigitalObjectSummarySchema).optional(),
  extractedText: z.array(NaraExtractedTextItemSchema).optional(),
  transcriptions: z.array(z.string()).optional(),
  error: z.string().optional(),
});

const NaraSearchPayloadSchema = z.object({
  query: z.string().optional(),
  searchUrl: z.string(),
  total: z.number(),
  results: z.array(NaraRecordSummarySchema),
});

export function readCachedSearch(
  canonical: CanonicalSearchParams,
  cacheRoot: string,
  ttlHours: number,
  nowMs: () => number
): NaraSearchPayload | null {
  const ttlSeconds = ttlHours * 3600;
  if (ttlSeconds <= 0) {
    return null;
  }
  const [, filePath] = queryCachePath(canonical, cacheRoot);
  const envelope = readJsonRecordIfValid(filePath);
  if (!envelope) {
    return null;
  }
  const cachedAt = envelope.cached_at;
  const data = envelope.data;
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || !isPlainRecord(data)) {
    return null;
  }
  if (nowMs() / 1000 - cachedAt > ttlSeconds) {
    return null;
  }
  const validated = NaraSearchPayloadSchema.safeParse(data);
  return validated.success ? validated.data : null;
}

export async function writeCachedSearch(
  canonical: CanonicalSearchParams,
  payload: NaraSearchPayload,
  cacheRoot: string,
  ctx: RecordCommandContext
): Promise<void> {
  if (!Array.isArray(payload.results)) {
    return;
  }
  const [digest, filePath] = queryCachePath(canonical, cacheRoot);
  const lockPath = resolveSafeChild(path.join(cacheRoot, '_locks'), `query_${digest}.lock`);
  await withAdvisoryLock(
    lockPath,
    async () => {
      atomicWriteCompactJson(filePath, {
        cached_at: ctx.nowMs() / 1000,
        params: canonical,
        data: payload,
      });
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

function recordCachePath(cleanId: string, cacheRoot: string): string {
  return resolveSafeChild(path.join(cacheRoot, 'records'), `${cleanId}.json`);
}

export function readCachedRecord(
  cleanId: string,
  cacheRoot: string,
  requireText: boolean
): NaraRecordSummary | null {
  const envelope = readJsonRecordIfValid(recordCachePath(cleanId, cacheRoot));
  if (!envelope) {
    return null;
  }
  const record = envelope.record;
  if (!isPlainRecord(record) || record.error) {
    return null;
  }
  if (requireText && !envelope.has_text) {
    return null;
  }
  const validated = NaraRecordSummarySchema.safeParse(record);
  return validated.success ? validated.data : null;
}

export async function writeCachedRecord(
  cleanId: string,
  fullRecord: NaraRecordSummary,
  cacheRoot: string,
  hasText: boolean,
  ctx: RecordCommandContext
): Promise<void> {
  if (fullRecord.error) {
    return;
  }
  const filePath = recordCachePath(cleanId, cacheRoot);
  const lockPath = resolveSafeChild(path.join(cacheRoot, '_locks'), `record_${cleanId}.lock`);
  await withAdvisoryLock(
    lockPath,
    async () => {
      atomicWriteCompactJson(filePath, {
        cached_at: ctx.nowMs() / 1000,
        naId: cleanId,
        has_text: Boolean(hasText),
        record: fullRecord,
      });
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}
