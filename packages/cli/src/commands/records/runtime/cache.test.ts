import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  CacheHitTracker,
  cachedJsonCall,
  cacheKeyFor,
  canonicalJsonStringify,
  parseCacheTtlHours,
  readBinaryCache,
  readSchemaCacheEntry,
  resolveCacheDir,
  sha256Hex,
  ttlHoursToMs,
  withAdvisoryLock,
} from './cache.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('records runtime cache', () => {
  it('resolves cache directory precedence: flag > envVars > XDG > default home', () => {
    const env: NodeJS.ProcessEnv = {
      HOME: '/tmp/fake-home',
      KINLOOM_TEST_CACHE_DIR: '~/env-cache',
      XDG_CACHE_HOME: '/tmp/xdg-cache',
    };
    expect(
      resolveCacheDir({
        flagValue: '/tmp/explicit-dir',
        env,
        envVars: ['KINLOOM_TEST_CACHE_DIR'],
        defaultSubdir: 'kinloom-test',
      })
    ).toBe('/tmp/explicit-dir');

    expect(
      resolveCacheDir({
        env,
        envVars: ['KINLOOM_TEST_CACHE_DIR'],
        defaultSubdir: 'kinloom-test',
      })
    ).toBe('/tmp/fake-home/env-cache');

    expect(
      resolveCacheDir({
        env: { HOME: '/tmp/fake-home', XDG_CACHE_HOME: '/tmp/xdg-cache' },
        envVars: ['KINLOOM_TEST_CACHE_DIR'],
        defaultSubdir: 'kinloom-test',
        useXdgCacheHome: true,
      })
    ).toBe('/tmp/xdg-cache/kinloom-test');

    expect(
      resolveCacheDir({
        env: { HOME: '/tmp/fake-home' },
        envVars: ['KINLOOM_TEST_CACHE_DIR'],
        defaultSubdir: 'kinloom-test',
      })
    ).toBe('/tmp/fake-home/.cache/kinloom-test');
  });

  it('parses TTL hours and rejects NaN, Infinity, or negative numbers with exit 2', () => {
    expect(parseCacheTtlHours(undefined, 24)).toBe(24);
    expect(parseCacheTtlHours('0', 24)).toBe(0);
    expect(parseCacheTtlHours('12.5', 24)).toBe(12.5);
    expect(() => parseCacheTtlHours('-1', 24)).toThrow(CliValidationError);
    expect(() => parseCacheTtlHours('NaN', 24)).toThrow(CliValidationError);
    expect(() => parseCacheTtlHours('Infinity', 24)).toThrow(CliValidationError);
    expect(() => parseCacheTtlHours('bogus', 24)).toThrow(CliValidationError);
  });

  it('writes JSON and binary files atomically, respects TTL, and validates schema cache entries', async () => {
    const tmp = await makeTempDir('kinloom-runtime-cache-');
    const jsonPath = path.join(tmp, 'nested', 'item.json');
    const binPath = path.join(tmp, 'nested', 'scan.bin');

    const isItemPayload = (value: unknown): value is { ok: boolean; id: number } =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).ok === 'boolean' &&
      typeof (value as Record<string, unknown>).id === 'number';

    const now = Date.now();
    atomicWriteJsonSync(jsonPath, {
      schema: 1,
      fetched_at: now / 1000,
      kind: 'item',
      query: { id: 42 },
      result: { ok: true, id: 42 },
    });
    const hit = readSchemaCacheEntry(jsonPath, 1, 1, () => now, isItemPayload);
    expect(hit).toEqual({ ok: true, id: 42 });

    // TTL 0 disables reads.
    expect(readSchemaCacheEntry(jsonPath, 0, 1, () => now, isItemPayload)).toBeUndefined();
    // Expired entry misses.
    expect(readSchemaCacheEntry(jsonPath, 1, 1, () => now + 7_200_000, isItemPayload)).toBeUndefined();

    // Wrong payload shape fails validation cleanly as a cache miss.
    atomicWriteJsonSync(jsonPath, {
      schema: 1,
      fetched_at: now / 1000,
      kind: 'item',
      query: { id: 42 },
      result: { ok: 'not-a-boolean' },
    });
    expect(readSchemaCacheEntry(jsonPath, 24, 1, () => now, isItemPayload)).toBeUndefined();

    // Corrupt JSON fails open as miss.
    atomicWriteFileSync(jsonPath, '{corrupt');
    expect(readSchemaCacheEntry(jsonPath, 24, 1, () => now, isItemPayload)).toBeUndefined();

    // Binary cache round-trip.
    atomicWriteFileSync(binPath, Buffer.from([1, 2, 3, 4]));
    const binHit = readBinaryCache(binPath, ttlHoursToMs(1), () => now);
    expect(binHit.hit).toBe(true);
    if (binHit.hit) {
      expect(Array.from(binHit.value)).toEqual([1, 2, 3, 4]);
    }
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('acquires and releases advisory lockfile and reclaims stale locks', async () => {
    const tmp = await makeTempDir('kinloom-runtime-lock-');
    const lockPath = path.join(tmp, 'entry.lock');

    const result = await withAdvisoryLock(lockPath, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 'locked-ok';
    });
    expect(result).toBe('locked-ok');
    expect(fs.existsSync(lockPath)).toBe(false);

    // Simulate stale lock with dead PID.
    fs.writeFileSync(lockPath, '99999999\n', 'utf8');
    const reclaimed = await withAdvisoryLock(lockPath, async () => 'reclaimed', {
      staleAfterMs: 120_000,
    });
    expect(reclaimed).toBe('reclaimed');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('tracks multi-lookup cache_hit accurately', () => {
    const tracker = new CacheHitTracker();
    expect(tracker.allHits()).toBeUndefined();
    tracker.note(true);
    expect(tracker.allHits()).toBe(true);
    tracker.note(false);
    expect(tracker.allHits()).toBe(false);
  });

  it('caches schema-versioned JSON entries with canonical sorted keys and respects refresh/ttl', async () => {
    const tmp = await makeTempDir('kinloom-runtime-schema-cache-');
    expect(canonicalJsonStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(cacheKeyFor('bib', { b: 2, a: 1 })).toBe(cacheKeyFor('bib', { a: 1, b: 2 }));

    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return { count: calls };
    };
    const isCountPayload = (value: unknown): value is { count: number } =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).count === 'number';

    const r1 = await cachedJsonCall({
      cacheDir: tmp,
      kind: 'bib',
      payload: { b: 2, a: 1 },
      ttlHours: 24,
      refresh: false,
      fetch,
      validateCached: isCountPayload,
    });
    const r2 = await cachedJsonCall({
      cacheDir: tmp,
      kind: 'bib',
      payload: { a: 1, b: 2 },
      ttlHours: 24,
      refresh: false,
      fetch,
      validateCached: isCountPayload,
    });
    const r3 = await cachedJsonCall({
      cacheDir: tmp,
      kind: 'bib',
      payload: { a: 1, b: 2 },
      ttlHours: 24,
      refresh: true,
      fetch,
      validateCached: isCountPayload,
    });
    expect(r1).toEqual({ value: { count: 1 }, cacheHit: false });
    expect(r2).toEqual({ value: { count: 1 }, cacheHit: true });
    expect(r3).toEqual({ value: { count: 2 }, cacheHit: false });

    // Corrupted cached payload shape triggers refetch instead of returning unvalidated data.
    const key = cacheKeyFor('bib', { a: 1, b: 2 });
    atomicWriteJsonSync(path.join(tmp, `${key}.json`), {
      schema: 1,
      fetched_at: Date.now() / 1000,
      kind: 'bib',
      query: { a: 1, b: 2 },
      result: { count: 'corrupt' },
    });
    const r4 = await cachedJsonCall({
      cacheDir: tmp,
      kind: 'bib',
      payload: { a: 1, b: 2 },
      ttlHours: 24,
      refresh: false,
      fetch,
      validateCached: isCountPayload,
    });
    expect(r4).toEqual({ value: { count: 3 }, cacheHit: false });
  });
});
