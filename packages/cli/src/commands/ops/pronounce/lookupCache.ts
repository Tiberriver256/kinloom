import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PronounceLookupResult } from './types.js';

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'kinloom-pronounce');
export const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_FETCH_ATTEMPTS = 4;
const DEFAULT_USER_AGENT = 'KinloomCLI/1.0 (https://kinloom.org; archival pronunciation lookup)';

export type CachedLookupPayload = Omit<PronounceLookupResult, 'rendered' | 'cache_hit'>;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function getPronounceCacheDir(overrideDir?: string): string {
  const raw = overrideDir?.trim() || process.env.KINLOOM_PRONOUNCE_CACHE_DIR?.trim();
  return raw ? path.resolve(raw) : DEFAULT_CACHE_DIR;
}

export function buildLookupCachePath(params: {
  cacheDir: string;
  term: string;
  normalizedLang: string | null;
  normalizedRegion: string | null;
  hasForvoKey: boolean;
}): string {
  const cacheKey = createHash('sha256')
    .update(
      `v2|term:${params.term.toLowerCase()}|lang:${params.normalizedLang ?? ''}|region:${params.normalizedRegion ?? ''}|forvo:${params.hasForvoKey ? '1' : '0'}`
    )
    .digest('hex');
  return path.join(params.cacheDir, `${cacheKey}.json`);
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`
  );
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function readLookupCache(cachePath: string): CachedLookupPayload | null {
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  try {
    const cachedRaw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CachedLookupPayload;
    if (cachedRaw && typeof cachedRaw === 'object' && typeof cachedRaw.term === 'string') {
      return cachedRaw;
    }
  } catch {
    // Corrupt cache entry: fall through and re-fetch cleanly.
  }
  return null;
}

export function writeLookupCache(cachePath: string, payload: CachedLookupPayload): void {
  writeFileAtomic(cachePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function parseRetryAfterMs(headerValue: string | null, attempt: number): number {
  const fallbackMs = Math.min(4000, 300 * 2 ** (attempt - 1));
  if (!headerValue) {
    return fallbackMs;
  }
  const trimmed = headerValue.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.min(10_000, Math.max(0, Math.round(Number(trimmed) * 1000)));
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.min(10_000, Math.max(0, parsedDate - Date.now()));
  }
  return fallbackMs;
}

export async function fetchJsonWithRetry(params: {
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  sleepFn: (ms: number) => Promise<void>;
}): Promise<unknown | null> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, params.timeoutMs);
    try {
      const response = await params.fetchImpl(params.url, {
        headers: {
          accept: 'application/json',
          'user-agent': DEFAULT_USER_AGENT,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status === 404) {
        return null;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_FETCH_ATTEMPTS) {
          const waitMs = parseRetryAfterMs(response.headers.get('retry-after'), attempt);
          await params.sleepFn(waitMs);
          continue;
        }
        throw new Error(`HTTP ${response.status} from ${params.url}`);
      }
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as unknown;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        const waitMs = parseRetryAfterMs(null, attempt);
        await params.sleepFn(waitMs);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
