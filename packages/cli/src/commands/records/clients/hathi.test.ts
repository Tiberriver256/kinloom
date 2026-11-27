import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheKeyFor, createRecordContext } from '../runtime/index.js';
import { isHathiBibPayload, runHathiCommand } from './hathi.js';

const BIB_PAYLOAD_A = {
  records: {
    '000578050': {
      recordURL: 'https://catalog.hathitrust.org/Record/000578050',
      titles: ['History of Sangamon County, Illinois'],
      publishDates: ['1881'],
      oclcs: ['424023'],
    },
  },
  items: [
    {
      orig: 'University of Illinois',
      htid: 'uiuo.ark:/13960/t00000001',
      itemURL: 'https://hdl.handle.net/2027/uiuo.ark:/13960/t00000001',
      rightsCode: 'pd',
      usRightsString: 'Full view',
    },
  ],
};

const BIB_PAYLOAD_B = {
  records: {
    '000999001': {
      recordURL: 'https://catalog.hathitrust.org/Record/000999001',
      titles: ['Springfield City Directory, 1860'],
      publishDates: ['1860'],
      oclcs: ['999001'],
    },
  },
  items: [
    {
      orig: 'University of Michigan',
      htid: 'mdp.39015000000001',
      itemURL: 'https://hdl.handle.net/2027/mdp.39015000000001',
      rightsCode: 'pd',
      usRightsString: 'Full view',
    },
  ],
};

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-hathi-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeHathi(
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
    env: { KINLOOM_HATHI_CACHE_DIR: cacheDir },
    fetchImpl,
    sleepFn: async () => {},
  });
  const outcome = await runHathiCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('hathi native client', () => {
  it('caches bib responses and makes zero repeat HTTP calls on second run', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(BIB_PAYLOAD_A), { status: 200 });
    };

    const r1 = await invokeHathi(['bib', 'oclc', '424023', '--json'], cacheDir, fetchImpl);
    const r2 = await invokeHathi(['bib', 'oclc', '424023', '--json'], cacheDir, fetchImpl);
    const r3 = await invokeHathi(['bib', 'oclc', '424023'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(1);

    const d1 = JSON.parse(r1.stdout) as { cache_hit: boolean };
    const d2 = JSON.parse(r2.stdout) as {
      cache_hit: boolean;
      records: Record<string, { titles: string[] }>;
    };
    expect(d1.cache_hit).toBe(false);
    expect(d2.cache_hit).toBe(true);
    expect(d2.records['000578050'].titles).toEqual(['History of Sangamon County, Illinois']);
    expect(r3.stdout).toContain('[cache]');
    expect(r3.stdout).toContain('History of Sangamon County, Illinois');
  });

  it('reuses per-identifier cache entries on multi-id lookups', async () => {
    const cacheDir = await makeTempDir();
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      return new Response(JSON.stringify(url.includes('424023') ? BIB_PAYLOAD_A : BIB_PAYLOAD_B), {
        status: 200,
      });
    };

    const r1 = await invokeHathi(['bib', 'oclc', '424023', '--json'], cacheDir, fetchImpl);
    const r2 = await invokeHathi(
      ['bib', '--id', 'oclc:424023', '--id', 'recordnumber:000999001', '--json'],
      cacheDir,
      fetchImpl
    );
    const r3 = await invokeHathi(
      ['bib', '--id', 'oclc:424023', '--id', 'recordnumber:000999001', '--json'],
      cacheDir,
      fetchImpl
    );

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(urls).toHaveLength(2);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    const d3 = JSON.parse(r3.stdout) as { cache_hit: boolean; records: Record<string, unknown> };
    expect(d3.cache_hit).toBe(true);
    expect(Object.keys(d3.records).toSorted()).toEqual(['000578050', '000999001']);
  });

  it('bypasses cache on --refresh and --cache-ttl-hours 0', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(BIB_PAYLOAD_A), { status: 200 });
    };

    await invokeHathi(['bib', 'oclc', '424023', '--json'], cacheDir, fetchImpl);
    const rRef = await invokeHathi(['bib', 'oclc', '424023', '--refresh', '--json'], cacheDir, fetchImpl);
    const rTtl = await invokeHathi(
      ['bib', 'oclc', '424023', '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      fetchImpl
    );

    expect(calls).toBe(3);
    expect((JSON.parse(rRef.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(rTtl.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
  });

  it('never caches HTTP errors, non-JSON, or empty payloads', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('server error', { status: 500 });
      }
      if (calls === 2) {
        return new Response('<html>error</html>', { status: 200 });
      }
      if (calls === 3) {
        return new Response(JSON.stringify({ records: {}, items: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(BIB_PAYLOAD_A), { status: 200 });
    };

    const r1 = await invokeHathi(['bib', 'oclc', '424023'], cacheDir, fetchImpl);
    const r2 = await invokeHathi(['bib', 'oclc', '424023'], cacheDir, fetchImpl);
    const r3 = await invokeHathi(['bib', 'oclc', '424023', '--json'], cacheDir, fetchImpl);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    const r4 = await invokeHathi(['bib', 'oclc', '424023', '--json'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(1);
    expect(r2.exitCode).toBe(1);
    expect(r3.exitCode).toBe(0);
    expect((JSON.parse(r3.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(r4.exitCode).toBe(0);
    expect(calls).toBe(4);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('rejects malformed records and items elements at both HTTP and disk-cache boundaries', async () => {
    expect(isHathiBibPayload({ records: { '1': null }, items: [] })).toBe(false);
    expect(isHathiBibPayload({ records: {}, items: [null, 42] })).toBe(false);
    expect(isHathiBibPayload({ records: { '1': { titles: [123] } }, items: [] })).toBe(false);
    expect(isHathiBibPayload({ records: {}, items: [{ htid: 999 }] })).toBe(false);
    expect(isHathiBibPayload(BIB_PAYLOAD_A)).toBe(true);

    const cacheDir = await makeTempDir();
    const badPayloads: unknown[] = [
      { records: { '1': null }, items: [] },
      { records: {}, items: [null, 42] },
      { records: { '1': { titles: [123] } }, items: [] },
      { records: {}, items: [{ htid: 999 }] },
    ];
    let httpIdx = 0;
    const badFetch: typeof fetch = async () => {
      const payload = badPayloads[httpIdx];
      httpIdx += 1;
      return new Response(JSON.stringify(payload), { status: 200 });
    };

    for (let i = 0; i < badPayloads.length; i += 1) {
      const res = await invokeHathi(['bib', 'oclc', '424023'], cacheDir, badFetch);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('Bib API returned unexpected JSON shape');
    }
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);

    const key = cacheKeyFor('bib', { id_type: 'oclc', value: '424023', full: false });
    const cacheFile = path.join(cacheDir, `${key}.json`);
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        schema: 1,
        fetched_at: Math.floor(Date.now() / 1000),
        kind: 'bib',
        query: { id_type: 'oclc', value: '424023', full: false },
        result: { records: { '1': null }, items: [null, 42] },
      }),
      'utf8'
    );

    let recoveryCalls = 0;
    const recoveryFetch: typeof fetch = async () => {
      recoveryCalls += 1;
      return new Response(JSON.stringify(BIB_PAYLOAD_A), { status: 200 });
    };

    const recovered = await invokeHathi(['bib', 'oclc', '424023', '--json'], cacheDir, recoveryFetch);
    expect(recovered.exitCode).toBe(0);
    expect(recoveryCalls).toBe(1);
    const recoveredJson = JSON.parse(recovered.stdout) as { cache_hit: boolean };
    expect(recoveredJson.cache_hit).toBe(false);

    const cachedAfter = await invokeHathi(['bib', 'oclc', '424023', '--json'], cacheDir, recoveryFetch);
    expect(cachedAfter.exitCode).toBe(0);
    expect(recoveryCalls).toBe(1);
    expect((JSON.parse(cachedAfter.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
  });
});
