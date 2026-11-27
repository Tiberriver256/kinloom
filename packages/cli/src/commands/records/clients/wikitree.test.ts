import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../runtime/index.js';
import { runWikitreeCommand } from './wikitree.js';

const SEARCH_RESP = [
  {
    status: 0,
    total: 1,
    matches: [
      {
        Id: 100,
        Name: 'Lincoln-1',
        FirstName: 'Abraham',
        LastNameAtBirth: 'Lincoln',
        BirthDate: '1809-02-12',
        DeathDate: '1865-04-15',
        BirthLocation: 'Hardin County, Kentucky',
      },
    ],
  },
];

const PERSON_RESP = [
  {
    status: 0,
    person: {
      Id: 100,
      Name: 'Lincoln-1',
      FirstName: 'Abraham',
      LastNameAtBirth: 'Lincoln',
      BirthDate: '1809-02-12',
      DeathDate: '1865-04-15',
      BirthLocation: 'Hardin County, Kentucky',
    },
  },
];

const BIO_RESP = [{ status: 0, bio: '== Biography ==\nBorn in Kentucky.' }];

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-wikitree-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeWikiTree(
  args: readonly string[],
  cacheDir: string,
  fetchImpl: typeof fetch
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_WIKITREE_CACHE_DIR: cacheDir },
    fetchImpl,
    sleepFn: async () => {},
  });
  const outcome = await runWikitreeCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('wikitree native client', () => {
  it('caches search, person, and bio with zero repeat HTTP calls', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const action = new URL(String(input)).searchParams.get('action');
      if (action === 'searchPerson') {
        return new Response(JSON.stringify(SEARCH_RESP), { status: 200 });
      }
      if (action === 'getPerson') {
        return new Response(JSON.stringify(PERSON_RESP), { status: 200 });
      }
      return new Response(JSON.stringify(BIO_RESP), { status: 200 });
    };

    const s1 = await invokeWikiTree(
      ['search', '--first', 'Abraham', '--last', 'Lincoln', '--json'],
      cacheDir,
      fetchImpl
    );
    const s2 = await invokeWikiTree(
      ['search', '--first', 'Abraham', '--last', 'Lincoln', '--json'],
      cacheDir,
      fetchImpl
    );
    const s3 = await invokeWikiTree(
      ['search', '--first', 'Abraham', '--last', 'Lincoln'],
      cacheDir,
      fetchImpl
    );
    const p1 = await invokeWikiTree(['person', 'Lincoln-1', '--json'], cacheDir, fetchImpl);
    const p2 = await invokeWikiTree(['person', 'Lincoln-1'], cacheDir, fetchImpl);
    const b1 = await invokeWikiTree(['bio', 'Lincoln-1', '--json'], cacheDir, fetchImpl);
    const b2 = await invokeWikiTree(['bio', 'Lincoln-1', '--json'], cacheDir, fetchImpl);

    expect(calls).toBe(3);
    expect((JSON.parse(s1.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(false);
    expect((JSON.parse(s2.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(true);
    expect(s3.stdout).toContain('[cache]');
    expect((JSON.parse(p1.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(false);
    expect(p2.stdout).toContain('[cache]');
    expect((JSON.parse(b1.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(false);
    expect((JSON.parse(b2.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(true);
  });

  it('bypasses cache on --refresh and --cache-ttl-hours 0', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(PERSON_RESP), { status: 200 });
    };

    await invokeWikiTree(['person', 'Lincoln-1', '--json'], cacheDir, fetchImpl);
    const rRef = await invokeWikiTree(
      ['person', 'Lincoln-1', '--refresh', '--json'],
      cacheDir,
      fetchImpl
    );
    const rTtl = await invokeWikiTree(
      ['person', 'Lincoln-1', '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      fetchImpl
    );

    expect(calls).toBe(3);
    expect((JSON.parse(rRef.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(false);
    expect((JSON.parse(rTtl.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(false);
  });

  it('never caches HTTP errors or non-zero WikiTree status errors', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('service unavailable', { status: 503 });
      }
      if (calls === 2) {
        return new Response(JSON.stringify([{ status: 'Illegal WikiTree ID' }]), { status: 200 });
      }
      return new Response(JSON.stringify(PERSON_RESP), { status: 200 });
    };

    const r1 = await invokeWikiTree(['person', 'Lincoln-1'], cacheDir, fetchImpl);
    const r2 = await invokeWikiTree(['person', 'Lincoln-1'], cacheDir, fetchImpl);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    const r3 = await invokeWikiTree(['person', 'Lincoln-1', '--json'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(1);
    expect(r2.exitCode).toBe(1);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(3);
  });

  it('supports aliases for get/show/profile, search flags, WikiTree URLs, and -h help', async () => {
    const cacheDir = await makeTempDir();
    const seenParams: Array<Record<string, string>> = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      seenParams.push(Object.fromEntries(url.searchParams.entries()));
      const action = url.searchParams.get('action');
      if (action === 'searchPerson') {
        return new Response(JSON.stringify(SEARCH_RESP), { status: 200 });
      }
      if (action === 'getPerson') {
        return new Response(JSON.stringify(PERSON_RESP), { status: 200 });
      }
      return new Response(JSON.stringify(BIO_RESP), { status: 200 });
    };

    const s1 = await invokeWikiTree(
      [
        'search',
        'Abraham',
        'Lincoln',
        '--birth-year',
        '1809',
        '--birth-place',
        'Kentucky',
        '-n',
        '5',
        '--page',
        '2',
        '--json',
      ],
      cacheDir,
      fetchImpl
    );
    expect(s1.exitCode).toBe(0);
    expect((JSON.parse(s1.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(false);
    expect(seenParams[0].FirstName).toBe('Abraham');
    expect(seenParams[0].LastName).toBe('Lincoln');
    expect(seenParams[0].BirthDate).toBe('1809');
    expect(seenParams[0].BirthLocation).toBe('Kentucky');
    expect(seenParams[0].limit).toBe('5');
    expect(seenParams[0].start).toBe('5');

    const s2 = await invokeWikiTree(
      [
        'search',
        '--given',
        'Abraham',
        '--surname',
        'Lincoln',
        '--born',
        '1809',
        '--place',
        'Kentucky',
        '--rows',
        '5',
        '--offset',
        '5',
        '--json',
      ],
      cacheDir,
      fetchImpl
    );
    expect(s2.exitCode).toBe(0);
    expect((JSON.parse(s2.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(true);
    expect(seenParams).toHaveLength(1);

    const pGet = await invokeWikiTree(
      ['get', 'https://www.wikitree.com/wiki/Lincoln-1', '--json'],
      cacheDir,
      fetchImpl
    );
    const pShow = await invokeWikiTree(['show', 'Lincoln-1', '--json'], cacheDir, fetchImpl);
    const pProf = await invokeWikiTree(['profile', 'Lincoln-1', '--json'], cacheDir, fetchImpl);
    expect(pGet.exitCode).toBe(0);
    expect(pShow.exitCode).toBe(0);
    expect(pProf.exitCode).toBe(0);
    expect((JSON.parse(pGet.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(false);
    expect((JSON.parse(pShow.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(true);
    expect((JSON.parse(pProf.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(true);
    expect(seenParams[1].key).toBe('Lincoln-1');
    expect(seenParams).toHaveLength(2);

    const bad = await invokeWikiTree(['search'], cacheDir, fetchImpl);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('search Abraham Lincoln');

    const helpRes = await invokeWikiTree(['-h'], cacheDir, fetchImpl);
    expect(helpRes.exitCode).toBe(0);
  });
});
