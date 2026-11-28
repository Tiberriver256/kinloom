import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';

export interface ResolveCacheDirOptions {
  readonly flagValue?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly envVars: readonly string[];
  readonly defaultSubdir: string;
  readonly useXdgCacheHome?: boolean;
}

export function expandHomePath(rawPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = rawPath.trim();
  const home = env['HOME'] || os.homedir();
  if (trimmed === '~') {
    return home;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

export function resolveCacheDir(options: ResolveCacheDirOptions): string {
  if (options.flagValue && options.flagValue.trim().length > 0) {
    return path.resolve(expandHomePath(options.flagValue, options.env));
  }
  for (const envKey of options.envVars) {
    const val = options.env[envKey];
    if (val && val.trim().length > 0) {
      return path.resolve(expandHomePath(val, options.env));
    }
  }
  if (options.useXdgCacheHome) {
    const xdg = options.env['XDG_CACHE_HOME'];
    if (xdg && xdg.trim().length > 0) {
      return path.resolve(expandHomePath(xdg, options.env), options.defaultSubdir);
    }
  }
  const home = options.env['HOME'] || os.homedir();
  return path.join(home, '.cache', options.defaultSubdir);
}

export function parseCacheTtlHours(
  raw: string | number | undefined,
  defaultHours: number,
  label = 'cache TTL'
): number {
  if (raw === undefined || raw === '') {
    return defaultHours;
  }
  const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new CliValidationError(
      `Invalid ${label} '${String(raw)}': must be a finite non-negative number of hours.`
    );
  }
  return numeric;
}

export function ttlHoursToMs(ttlHours: number): number {
  return ttlHours * 3_600_000;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .toSorted();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(obj[key])}`);
  return `{${pairs.join(',')}}`;
}

export function cacheKeyFor(kind: string, payload: unknown): string {
  return sha256Hex(canonicalJsonStringify([kind, payload]));
}

export interface SchemaCacheEntry<T> {
  readonly schema: number;
  readonly fetched_at: number;
  readonly kind: string;
  readonly query: unknown;
  readonly result: T;
}

export interface CachedJsonCallOptions<T> {
  readonly cacheDir: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly ttlHours: number;
  readonly refresh: boolean;
  readonly schema?: number | undefined;
  readonly fetch: () => Promise<T>;
  readonly cacheable?: ((value: T) => boolean) | undefined;
  readonly validateCached: (value: unknown) => value is T;
  readonly nowMs?: (() => number) | undefined;
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
}

export function readSchemaCacheEntry<T>(
  filePath: string,
  ttlHours: number,
  schema: number,
  nowMs: () => number,
  validateCached: (value: unknown) => value is T
): T | undefined {
  if (ttlHours <= 0) {
    return undefined;
  }
  try {
    const fd = fs.openSync(filePath, 'r');
    let rawText: string;
    try {
      if (!fs.fstatSync(fd).isFile()) {
        return undefined;
      }
      rawText = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    const raw: unknown = JSON.parse(rawText);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return undefined;
    }
    const entry = raw as Record<string, unknown>;
    if (entry['schema'] !== schema) {
      return undefined;
    }
    const fetchedAt = entry['fetched_at'];
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) {
      return undefined;
    }
    const nowSec = nowMs() / 1000;
    if (nowSec - fetchedAt > ttlHours * 3600) {
      return undefined;
    }
    const result = entry['result'];
    return validateCached(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

export async function cachedJsonCall<T>(
  options: CachedJsonCallOptions<T>
): Promise<{ readonly value: T; readonly cacheHit: boolean }> {
  const schema = options.schema ?? 1;
  const nowMs = options.nowMs ?? (() => Date.now());
  const key = cacheKeyFor(options.kind, options.payload);
  const entryPath = path.join(options.cacheDir, `${key}.json`);
  const lockPath = path.join(options.cacheDir, `${key}.lock`);

  if (!options.refresh) {
    const cached = readSchemaCacheEntry<T>(
      entryPath,
      options.ttlHours,
      schema,
      nowMs,
      options.validateCached
    );
    if (cached !== undefined) {
      return { value: cached, cacheHit: true };
    }
  }

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const cached = readSchemaCacheEntry<T>(
          entryPath,
          options.ttlHours,
          schema,
          nowMs,
          options.validateCached
        );
        if (cached !== undefined) {
          return { value: cached, cacheHit: true };
        }
      }
      const fresh = await options.fetch();
      const shouldCache = options.cacheable ? options.cacheable(fresh) : true;
      if (shouldCache) {
        const envelope: SchemaCacheEntry<T> = {
          schema,
          fetched_at: nowMs() / 1000,
          kind: options.kind,
          query: options.payload,
          result: fresh,
        };
        atomicWriteFileSync(entryPath, JSON.stringify(envelope));
      }
      return { value: fresh, cacheHit: false };
    },
    { nowMs, sleepFn: options.sleepFn }
  );
}

export function atomicWriteFileSync(targetPath: string, data: string | Uint8Array): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(dir, '.kinloom-tmp-'));
  const tmpPath = path.join(tmpDir, 'payload');
  try {
    fs.writeFileSync(tmpPath, data, { flag: 'wx' });
    fs.renameSync(tmpPath, targetPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function atomicWriteJsonSync(targetPath: string, payload: unknown): void {
  atomicWriteFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export type CacheReadResult<T> =
  | { readonly hit: true; readonly value: T; readonly mtimeMs: number }
  | { readonly hit: false };

export function readBinaryCache(
  filePath: string,
  ttlMs: number,
  nowMs: () => number = () => Date.now()
): CacheReadResult<Buffer> {
  if (ttlMs <= 0) {
    return { hit: false };
  }
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        return { hit: false };
      }
      const ageMs = nowMs() - stat.mtimeMs;
      if (ageMs > ttlMs) {
        return { hit: false };
      }
      const data = fs.readFileSync(fd);
      return { hit: true, value: data, mtimeMs: stat.mtimeMs };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { hit: false };
  }
}

export interface AdvisoryLockOptions {
  readonly timeoutMs?: number | undefined;
  readonly staleAfterMs?: number;
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
  readonly nowMs?: (() => number) | undefined;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function tryReclaimStaleLock(lockPath: string, staleAfterMs: number, now: number): boolean {
  try {
    const fd = fs.openSync(lockPath, 'r');
    let ageMs: number;
    let ownerDead = false;
    try {
      const stat = fs.fstatSync(fd);
      ageMs = now - stat.mtimeMs;
      try {
        const content = fs.readFileSync(fd, 'utf8').trim();
        const pid = Number.parseInt(content, 10);
        if (Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
          ownerDead = true;
        }
      } catch {
        // Ignore unreadable lock payload.
      }
    } finally {
      fs.closeSync(fd);
    }
    if (ageMs > staleAfterMs || ownerDead) {
      fs.rmSync(lockPath, { force: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function withAdvisoryLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: AdvisoryLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const staleAfterMs = options.staleAfterMs ?? 120_000;
  const nowMs = options.nowMs ?? (() => Date.now());
  const sleepFn =
    options.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const deadline = nowMs() + timeoutMs;
  let acquired = false;
  let backoffMs = 15;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
      if (code !== 'EEXIST') {
        throw err;
      }
      const now = nowMs();
      if (tryReclaimStaleLock(lockPath, staleAfterMs, now)) {
        continue;
      }
      if (now >= deadline) {
        // Proceed unlocked after timeout to avoid indefinite hang on orphaned locks.
        break;
      }
      await sleepFn(Math.min(backoffMs, Math.max(1, deadline - now)));
      backoffMs = Math.min(250, backoffMs * 2);
    }
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Ignore already-removed lockfile.
      }
    }
  }
}

export class CacheHitTracker {
  private hits = 0;
  private misses = 0;

  note(hit: boolean): void {
    if (hit) {
      this.hits += 1;
    } else {
      this.misses += 1;
    }
  }

  allHits(): boolean | undefined {
    const total = this.hits + this.misses;
    if (total === 0) {
      return undefined;
    }
    return this.misses === 0;
  }

  hasAny(): boolean {
    return this.hits + this.misses > 0;
  }
}
