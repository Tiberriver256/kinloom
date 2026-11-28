import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecordContext } from '../runtime/index.js';
import { resolveSafeChild, runGnisCommand } from './gnis.js';

interface SampleRow {
  readonly feature_id: string;
  readonly feature_name: string;
  readonly feature_class: string;
  readonly state_name: string;
  readonly county_name: string;
  readonly map_name: string;
  readonly prim_lat_dec: string;
  readonly prim_long_dec: string;
  readonly date_created: string;
  readonly date_edited: string;
}

const COLUMNS: readonly (keyof SampleRow)[] = [
  'feature_id',
  'feature_name',
  'feature_class',
  'state_name',
  'county_name',
  'map_name',
  'prim_lat_dec',
  'prim_long_dec',
  'date_created',
  'date_edited',
];

function sampleRows(version = 1): SampleRow[] {
  return [
    {
      feature_id: '277544',
      feature_name: 'Merced',
      feature_class: 'Populated Place',
      state_name: 'California',
      county_name: 'Merced',
      map_name: `Merced v${version}`,
      prim_lat_dec: '37.3021632',
      prim_long_dec: '-120.4829677',
      date_created: '01/19/1981',
      date_edited: '01/01/2026',
    },
    {
      feature_id: '277516',
      feature_name: 'Fresno',
      feature_class: 'Populated Place',
      state_name: 'California',
      county_name: 'Fresno',
      map_name: 'Fresno South',
      prim_lat_dec: '36.7477272',
      prim_long_dec: '-119.7723661',
      date_created: '01/19/1981',
      date_edited: '01/01/2026',
    },
  ];
}

function makeGnisZip(rows: readonly SampleRow[], entryName = 'DomesticNames_CA.txt'): Buffer {
  const lines = [COLUMNS.join('|'), ...rows.map((row) => COLUMNS.map((col) => row[col]).join('|'))];
  const content = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  return Buffer.from(zipSync({ [entryName]: new Uint8Array(content) }));
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-gnis-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeGnis(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env,
    fetchImpl,
    sleepFn: async () => {},
  });
  const outcome = await runGnisCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('gnis native client', () => {
  it('caches query and state file with zero repeat HTTP calls and zero table re-parses', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    const env: NodeJS.ProcessEnv = { KINLOOM_GNIS_CACHE_DIR: cacheRoot };
    const downloadUrls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      downloadUrls.push(String(input));
      return new Response(new Uint8Array(makeGnisZip(sampleRows(1))), { status: 200 });
    };

    const realReadFileSync = fs.readFileSync.bind(fs);
    let stateTableReads = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation((...callArgs: Parameters<typeof fs.readFileSync>) => {
      const target = String(callArgs[0]);
      if (target.endsWith(`${path.sep}CA.txt`)) {
        stateTableReads += 1;
      }
      return realReadFileSync(...callArgs);
    });

    // Cold search downloads state zip once and populates CA.txt and _queries/<sha256>.json.
    const r1 = await invokeGnis(['search', 'Merced', '--state', 'CA', '--json'], env, fetchImpl);
    expect(r1.exitCode).toBe(0);
    expect(downloadUrls).toHaveLength(1);
    expect(stateTableReads).toBe(1);
    expect(fs.existsSync(path.join(cacheRoot, 'CA.txt'))).toBe(true);
    const queryFiles = fs.readdirSync(path.join(cacheRoot, '_queries')).filter((f) => f.endsWith('.json'));
    expect(queryFiles).toHaveLength(1);
    expect(path.basename(queryFiles[0], '.json')).toHaveLength(64);
    const p1 = JSON.parse(r1.stdout) as {
      matches: number;
      results: { feature_id: string }[];
      cache_hit: boolean;
    };
    expect(p1.matches).toBe(1);
    expect(p1.results[0].feature_id).toBe('277544');
    expect(p1.cache_hit).toBe(false);
    expect(r1.cacheHit).toBe(false);

    // Warm JSON search hits _queries/<sha256>.json: ZERO HTTP and ZERO table parses.
    const r2 = await invokeGnis(['search', 'Merced', '--state', 'CA', '--json'], env, fetchImpl);
    expect(r2.exitCode).toBe(0);
    expect(downloadUrls).toHaveLength(1);
    expect(stateTableReads).toBe(1);
    const p2 = JSON.parse(r2.stdout) as Record<string, unknown>;
    expect(p2['cache_hit']).toBe(true);
    expect(r2.cacheHit).toBe(true);
    const { cache_hit: _h1, ...rest1 } = p1;
    const { cache_hit: _h2, ...rest2 } = p2;
    expect(rest2).toEqual(rest1);

    // Warm text search reuses the same cached query JSON with ZERO HTTP and ZERO table parses.
    const r3 = await invokeGnis(['search', 'Merced', '--state', 'CA'], env, fetchImpl);
    expect(r3.exitCode).toBe(0);
    expect(downloadUrls).toHaveLength(1);
    expect(stateTableReads).toBe(1);
    expect(r3.stdout).toContain('277544 | Merced (Populated Place)');

    // Different query in same state reuses CA.txt with ZERO HTTP downloads.
    const r4 = await invokeGnis(['search', 'Fresno', '--state', 'CA', '--json'], env, fetchImpl);
    expect(r4.exitCode).toBe(0);
    expect(downloadUrls).toHaveLength(1);
    expect(stateTableReads).toBe(2);
    const p4 = JSON.parse(r4.stdout) as { results: { feature_id: string }[] };
    expect(p4.results[0].feature_id).toBe('277516');
  });

  it('supports --refresh, --cache-ttl-hours 0, and rejects negative TTL with exit 2', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    const env: NodeJS.ProcessEnv = { KINLOOM_GNIS_CACHE_DIR: cacheRoot };
    const downloadUrls: string[] = [];
    let version = 1;

    const fetchImpl: typeof fetch = async (input) => {
      downloadUrls.push(String(input));
      return new Response(new Uint8Array(makeGnisZip(sampleRows(version))), { status: 200 });
    };

    const r1 = await invokeGnis(['search', 'Merced', '--state', 'CA', '--json'], env, fetchImpl);
    expect(r1.exitCode).toBe(0);
    expect(downloadUrls).toHaveLength(1);
    expect((JSON.parse(r1.stdout) as { results: { map_name: string }[] }).results[0].map_name).toBe(
      'Merced v1'
    );

    // --refresh bypasses query and state caches to fetch updated USGS data.
    version = 2;
    const r2 = await invokeGnis(['search', 'Merced', '--state', 'CA', '--refresh', '--json'], env, fetchImpl);
    expect(r2.exitCode).toBe(0);
    expect(downloadUrls).toHaveLength(2);
    expect((JSON.parse(r2.stdout) as { results: { map_name: string }[] }).results[0].map_name).toBe(
      'Merced v2'
    );

    // --cache-ttl-hours 0 bypasses query cache (re-reads cached state table, 0 HTTP).
    const realReadFileSync = fs.readFileSync.bind(fs);
    let tableReads = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation((...callArgs: Parameters<typeof fs.readFileSync>) => {
      if (String(callArgs[0]).endsWith(`${path.sep}CA.txt`)) {
        tableReads += 1;
      }
      return realReadFileSync(...callArgs);
    });

    const r3 = await invokeGnis(
      ['search', 'Merced', '--state', 'CA', '--cache-ttl-hours', '0', '--json'],
      env,
      fetchImpl
    );
    expect(r3.exitCode).toBe(0);
    expect(downloadUrls).toHaveLength(2);
    expect(tableReads).toBe(1);
    expect((JSON.parse(r3.stdout) as { results: { map_name: string }[] }).results[0].map_name).toBe(
      'Merced v2'
    );

    // Negative TTL rejected with exit code 2.
    const rBad = await invokeGnis(
      ['search', 'Merced', '--state', 'CA', '--cache-ttl-hours', '-5'],
      env,
      fetchImpl
    );
    expect(rBad.exitCode).toBe(2);
  });

  it('validates state codes and blocks unsafe child paths', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    const env: NodeJS.ProcessEnv = { KINLOOM_GNIS_CACHE_DIR: cacheRoot };
    const fetchImpl: typeof fetch = async () => new Response('', { status: 500 });

    for (const badState of ['../CA', 'ZZ', 'CA/../../etc']) {
      const res = await invokeGnis(['search', 'Merced', '--state', badState], env, fetchImpl);
      expect(res.exitCode).not.toBe(0);
    }

    for (const unsafe of ['../escape', 'a/b.txt', 'a\\b.txt', '..', '', 'C:evil']) {
      expect(() => resolveSafeChild(cacheRoot, unsafe)).toThrow();
    }
  });

  it('supports download, get, url, historical search, and GNIS_CACHE_DIR env var', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'gnis-cache');
    const env: NodeJS.ProcessEnv = { GNIS_CACHE_DIR: cacheRoot };
    let calls = 0;

    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes('HistoricalFeatures')) {
        return new Response(new Uint8Array(makeGnisZip(sampleRows(1), 'HistoricalFeatures_National.txt')), {
          status: 200,
        });
      }
      return new Response(new Uint8Array(makeGnisZip(sampleRows(1))), { status: 200 });
    };

    const dl1 = await invokeGnis(['download', 'CA'], env, fetchImpl);
    const dl2 = await invokeGnis(['download', 'CA'], env, fetchImpl);
    expect(dl1.exitCode).toBe(0);
    expect(dl2.exitCode).toBe(0);
    expect(dl2.stdout).toContain('Already cached');
    expect(dl2.cacheHit).toBe(true);
    expect(calls).toBe(1);

    const g1 = await invokeGnis(['get', '277544', '--state', 'CA', '--json'], env, fetchImpl);
    expect(g1.exitCode).toBe(0);
    const parsedGet = JSON.parse(g1.stdout) as { feature_name: string; cache_hit: boolean };
    expect(parsedGet.feature_name).toBe('Merced');
    expect(parsedGet.cache_hit).toBe(true);

    const gMiss = await invokeGnis(['get', '999999', '--state', 'CA'], env, fetchImpl);
    expect(gMiss.exitCode).toBe(1);
    expect(gMiss.stderr).toContain('not found');

    const hist = await invokeGnis(['search', 'Merced', '--historical', '--exact', '--json'], env, fetchImpl);
    expect(hist.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect((JSON.parse(hist.stdout) as { source: string }).source).toBe('HistoricalFeatures (national)');

    const u = await invokeGnis(['url', 'Merced'], env, fetchImpl);
    expect(u.exitCode).toBe(0);
    expect(u.stdout).toContain('https://edits.nationalmap.gov/apps/gaz-domestic/public/search/names');
    expect(u.stdout).toContain('Merced');

    const help = await invokeGnis(['--help'], env, fetchImpl);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('kinloom gnis');
  });
});
