import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError } from '../../../errors.js';
import {
  CacheHitTracker,
  atomicWriteFileSync,
  atomicWriteJsonSync,
  cacheKeyFor,
  cachedJsonCall,
  canonicalJsonStringify,
  parseCacheTtlHours,
  readBinaryCache,
  readJsonCache,
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

  it('writes JSON and binary files atomically, respects TTL, and falls back on corrupt JSON', async () => {
    const tmp = await makeTempDir('kinloom-runtime-cache-');
    const jsonPath = path.join(tmp, 'nested', 'item.json');
    const binPath = path.join(tmp, 'nested', 'scan.bin');

    atomicWriteJsonSync(jsonPath, { ok: true, id: 42 });
    const now = Date.now();
    const hit = readJsonCache<{ ok: boolean; id: number }>(jsonPath, ttlHoursToMs(1), () => now);
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      expect(hit.value).toEqual({ ok: true, id: 42 });
    }

    // TTL 0 disables reads.
    expect(readJsonCache(jsonPath, 0, () => now).hit).toBe(false);
    // Expired entry misses.
    expect(readJsonCache(jsonPath, 1_000, () => now + 60_000).hit).toBe(false);

    // Corrupt JSON fails open as miss.
    atomicWriteFileSync(jsonPath, '{corrupt');
    expect(readJsonCache(jsonPath, ttlHoursToMs(24), () => now).hit).toBe(false);

    // Binary cache round-trip.
    atomicWriteFileSync(binPath, Buffer.from([1, 2, 3, 4]));
    const binHit = readBinaryCache(binPath, ttlHoursToMs(1), () => now);
    expect(binHit.hit).toBe(true);
    if (binHit.hit) {
      expect(Array.from(binHit.value)).toEqual([1, 2, 3, 4]);
    }
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
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

    const r1 = await cachedJsonCall({
      cacheDir: tmp,
      kind: 'bib',
      payload: { b: 2, a: 1 },
      ttlHours: 24,
      refresh: false,
      fetch,
    });
    const r2 = await cachedJsonCall({
      cacheDir: tmp,
      kind: 'bib',
      payload: { a: 1, b: 2 },
      ttlHours: 24,
      refresh: false,
      fetch,
    });
    const r3 = await cachedJsonCall({
      cacheDir: tmp,
      kind: 'bib',
      payload: { a: 1, b: 2 },
      ttlHours: 24,
      refresh: true,
      fetch,
    });
    expect(r1).toEqual({ value: { count: 1 }, cacheHit: false });
    expect(r2).toEqual({ value: { count: 1 }, cacheHit: true });
    expect(r3).toEqual({ value: { count: 2 }, cacheHit: false });
  });
});
