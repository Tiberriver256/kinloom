import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  atomicWriteFileSync,
  canonicalJsonStringify,
  sha256Hex,
  withAdvisoryLock,
} from '../../runtime/cache.js';
import { httpGetBytes } from '../../runtime/http.js';
import { atomicWriteCompactJson, isPlainRecord, readJsonRecordIfValid } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  compactFeature,
  extractGnisTxt,
  GNIS_STATE_CODES,
  type GnisQueryParams,
  type GnisRow,
  type GnisSearchPayload,
  getCacheDir,
  historicalZipUrl,
  loadGnisRows,
  matchRows,
  resolveSafeChild,
  stateZipUrl,
} from './domain.js';

const GNIS_USER_AGENT = 'kinloom/1.0 (genealogy research)';
const GNIS_ALLOWED_HOSTS = ['prd-tnm.s3.amazonaws.com'] as const;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export function queryCachePath(
  canonicalParams: GnisQueryParams,
  cacheDir: string
): { readonly digest: string; readonly filePath: string } {
  const canonical = canonicalJsonStringify(canonicalParams);
  const digest = sha256Hex(canonical);
  const filePath = resolveSafeChild(path.join(cacheDir, '_queries'), `${digest}.json`);
  return { digest, filePath };
}

const GnisCompactFeatureSchema = z.object({
  feature_id: z.string().nullable(),
  feature_name: z.string().nullable(),
  feature_class: z.string().nullable(),
  state: z.string().nullable(),
  county: z.string().nullable(),
  map_name: z.string().nullable(),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  date_created: z.string().nullable(),
  date_edited: z.string().nullable(),
});

const GnisSearchPayloadSchema = z.object({
  source: z.string(),
  matches: z.number(),
  results: z.array(GnisCompactFeatureSchema),
});

export function readCachedSearch(
  canonicalParams: GnisQueryParams,
  cacheDir: string,
  ttlHours: number,
  nowMs: () => number
): GnisSearchPayload | undefined {
  const ttlSeconds = ttlHours * 3600;
  if (ttlSeconds <= 0) {
    return undefined;
  }
  const { filePath } = queryCachePath(canonicalParams, cacheDir);
  const parsed = readJsonRecordIfValid(filePath);
  if (!parsed) {
    return undefined;
  }
  const cachedAt = parsed['cached_at'];
  const data = parsed['data'];
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || !isPlainRecord(data)) {
    return undefined;
  }
  if (nowMs() / 1000 - cachedAt > ttlSeconds) {
    return undefined;
  }
  const validated = GnisSearchPayloadSchema.safeParse(data);
  return validated.success ? validated.data : undefined;
}

async function downloadZip(ctx: RecordCommandContext, url: string): Promise<Buffer> {
  const res = await httpGetBytes(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: GNIS_USER_AGENT,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxAttempts: 2,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: GNIS_ALLOWED_HOSTS },
  });
  return res.bytes;
}

export async function ensureStateFile(
  ctx: RecordCommandContext,
  rawState: string,
  refresh: boolean
): Promise<string> {
  const state = rawState.toUpperCase();
  if (!GNIS_STATE_CODES.has(state)) {
    throw new RecordRuntimeError(`Unknown state/territory code: ${state}`);
  }
  const cdir = getCacheDir(ctx);
  fs.mkdirSync(cdir, { recursive: true });
  const filePath = resolveSafeChild(cdir, `${state}.txt`);
  if (fs.existsSync(filePath) && !refresh) {
    return filePath;
  }
  const lockPath = resolveSafeChild(path.join(cdir, '_locks'), `state_${state}.lock`);
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (fs.existsSync(filePath) && !refresh) {
        return filePath;
      }
      ctx.io.stderr(`Downloading GNIS data for ${state} ...`);
      const zipBytes = await downloadZip(ctx, stateZipUrl(state));
      const { text } = extractGnisTxt(zipBytes);
      atomicWriteFileSync(filePath, text);
      const count = Math.max(0, text.split(/\r?\n/).filter((l) => l.length > 0).length - 1);
      ctx.io.stderr(`Cached ${filePath} (${count} features)`);
      return filePath;
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function ensureHistoricalFile(ctx: RecordCommandContext, refresh: boolean): Promise<string> {
  const cdir = getCacheDir(ctx);
  fs.mkdirSync(cdir, { recursive: true });
  const filePath = resolveSafeChild(cdir, 'HistoricalFeatures.txt');
  if (fs.existsSync(filePath) && !refresh) {
    return filePath;
  }
  const lockPath = resolveSafeChild(path.join(cdir, '_locks'), 'historical.lock');
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (fs.existsSync(filePath) && !refresh) {
        return filePath;
      }
      ctx.io.stderr('Downloading national Historical Features file (large) ...');
      const zipBytes = await downloadZip(ctx, historicalZipUrl());
      const { text } = extractGnisTxt(zipBytes);
      atomicWriteFileSync(filePath, text);
      const count = Math.max(0, text.split(/\r?\n/).filter((l) => l.length > 0).length - 1);
      ctx.io.stderr(`Cached ${filePath} (${count} features)`);
      return filePath;
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function executeCachedSearch(options: {
  readonly ctx: RecordCommandContext;
  readonly canonicalParams: GnisQueryParams;
  readonly featureClass: string | undefined;
  readonly county: string | undefined;
  readonly refresh: boolean;
  readonly ttlHours: number;
}): Promise<{ readonly payload: GnisSearchPayload; readonly cacheHit: boolean }> {
  const { ctx, canonicalParams, featureClass, county, refresh, ttlHours } = options;
  const cdir = getCacheDir(ctx);

  if (!refresh) {
    const cached = readCachedSearch(canonicalParams, cdir, ttlHours, ctx.nowMs);
    if (cached !== undefined) {
      return { payload: cached, cacheHit: true };
    }
  }

  const { digest, filePath: cachePath } = queryCachePath(canonicalParams, cdir);
  const lockPath = resolveSafeChild(path.join(cdir, '_locks'), `query_${digest}.lock`);
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!refresh) {
        const hit = readCachedSearch(canonicalParams, cdir, ttlHours, ctx.nowMs);
        if (hit !== undefined) {
          return { payload: hit, cacheHit: true };
        }
      }
      let rows: GnisRow[];
      let source: string;
      if (canonicalParams.historical) {
        const histPath = await ensureHistoricalFile(ctx, refresh);
        rows = loadGnisRows(histPath);
        source = 'HistoricalFeatures (national)';
      } else {
        const stateCode = canonicalParams.state ?? '';
        const statePath = await ensureStateFile(ctx, stateCode, refresh);
        rows = loadGnisRows(statePath);
        source = `DomesticNames_${stateCode}`;
      }
      const matches = matchRows(
        rows,
        canonicalParams.name,
        canonicalParams.exact,
        featureClass,
        county
      ).slice(0, canonicalParams.limit);
      const freshPayload: GnisSearchPayload = {
        source,
        matches: matches.length,
        results: matches.map(compactFeature),
      };
      atomicWriteCompactJson(cachePath, {
        cached_at: ctx.nowMs() / 1000,
        params: canonicalParams,
        data: freshPayload,
      });
      return { payload: freshPayload, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}
