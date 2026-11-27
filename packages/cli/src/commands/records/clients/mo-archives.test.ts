import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../runtime/index.js';
import { parseDeathName, runMoArchivesCommand } from './mo-archives.js';

const FORM_HTML = '<form><input type="hidden" name="__ncforminfo" value="tok123" /></form>';

const DEATH_RESULTS_HTML =
  '<p>Showing records 1 to 1 of 1</p>' +
  '<table>' +
  '<tr><th>Name</th><th>Age</th><th>Date of Death</th><th>County</th><th>Cert</th><th>SSN</th><th>Image</th></tr>' +
  '<tr><td>Smith, John</td><td>70</td><td>1920-04-02</td><td>Marion</td><td>1001</td><td></td>' +
  '<td><a href="/images/archives/deathcerts/1920/0001001.PDF">PDF</a></td></tr>' +
  '</table>';

const PRE1910_RESULTS_HTML =
  '<p>Showing records 1 to 1 of 1</p>' +
  '<table>' +
  '<tr><th>Name</th><th>Age</th><th>Sex</th><th>Color</th><th>Date Of Death</th><th>County</th><th>Details</th></tr>' +
  '<tr><td>Smith, Jane</td><td>62</td><td>F</td><td>W</td><td>1885-06-10</td><td>Marion</td>' +
  '<td><a href="Detail?id=555">View</a></td></tr>' +
  '</table>';

const DETAIL_HTML =
  '<table>' +
  '<tr><th>Name</th><th>County</th></tr>' +
  '<tr><td>Smith, Jane</td><td>Marion</td></tr>' +
  '</table>';

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-mo-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeMo(
  args: readonly string[],
  cacheDir: string,
  opts: { readonly fetchImpl?: typeof fetch; readonly cwd?: string } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_MO_ARCHIVES_CACHE_DIR: cacheDir },
    cwd: opts.cwd ?? cacheDir,
    fetchImpl:
      opts.fetchImpl ??
      (async () => {
        throw new Error('unexpected network call');
      }),
    sleepFn: async () => {},
  });
  const outcome = await runMoArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('mo-archives native client', () => {
  it('caches death search with __ncforminfo POST and zero repeat HTTP calls', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    let sawToken = false;
    let sawCookie = false;

    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(FORM_HTML, {
          status: 200,
          headers: { 'set-cookie': 'ASP.NET_SessionId=mo123; Path=/' },
        });
      }
      const headers = new Headers(init?.headers);
      if (headers.get('cookie')?.includes('ASP.NET_SessionId=mo123')) {
        sawCookie = true;
      }
      if (String(init?.body ?? '').includes('__ncforminfo=tok123')) {
        sawToken = true;
      }
      return new Response(DEATH_RESULTS_HTML, { status: 200 });
    };

    const r1 = await invokeMo(['death', '--last', 'Smith', '--json'], cacheDir, { fetchImpl });
    const r2 = await invokeMo(['death', '--last', 'Smith', '--json'], cacheDir, { fetchImpl });
    const r3 = await invokeMo(['death', '--last', 'Smith'], cacheDir, { fetchImpl });

    expect([r1.exitCode, r2.exitCode, r3.exitCode]).toEqual([0, 0, 0]);
    expect(calls).toBe(2);
    expect(sawToken).toBe(true);
    expect(sawCookie).toBe(true);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(r2.cacheHit).toBe(true);
    expect(r3.stdout).toContain('[cache]');
  });

  it('caches pre1910 and detail lookups and honors --refresh and ttl 0', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      if (String(input).includes('Detail')) {
        return new Response(DETAIL_HTML, { status: 200 });
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(FORM_HTML, { status: 200 });
      }
      return new Response(PRE1910_RESULTS_HTML, { status: 200 });
    };

    const p1 = await invokeMo(['pre1910', '--name', 'Smith', '--json'], cacheDir, { fetchImpl });
    const p2 = await invokeMo(['pre1910', '--name', 'Smith', '--json'], cacheDir, { fetchImpl });
    const pRef = await invokeMo(['pre1910', '--name', 'Smith', '--refresh', '--json'], cacheDir, {
      fetchImpl,
    });
    const d1 = await invokeMo(['detail', '555', '--json'], cacheDir, { fetchImpl });
    const d2 = await invokeMo(['detail', '555'], cacheDir, { fetchImpl });
    const dTtl = await invokeMo(
      ['detail', '555', '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      { fetchImpl }
    );

    expect((JSON.parse(p1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(p2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect((JSON.parse(pRef.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(d1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(d2.stdout).toContain('[cache]');
    expect((JSON.parse(dTtl.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(calls).toBe(6);
  });

  it('never caches HTTP 500 errors or unverified empty pages', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;

    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response('server error', { status: 500 });
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(FORM_HTML, { status: 200 });
      }
      if (calls === 3) {
        return new Response('<html><body>Blocked</body></html>', { status: 200 });
      }
      return new Response(DEATH_RESULTS_HTML, { status: 200 });
    };

    const r1 = await invokeMo(['death', '--last', 'Smith'], cacheDir, { fetchImpl });
    const r2 = await invokeMo(['death', '--last', 'Smith', '--json'], cacheDir, { fetchImpl });
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    const r3 = await invokeMo(['death', '--last', 'Smith', '--json'], cacheDir, { fetchImpl });

    expect(r1.exitCode).toBe(1);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('downloads death certificate PDFs, skips existing files, prints mdh info, and parses multi-role names', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'pdfs');
    let dlCalls = 0;

    const fetchImpl: typeof fetch = async () => {
      dlCalls += 1;
      return new Response(PDF_BYTES, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    };

    const url = 'https://s1.sos.mo.gov/images/archives/deathcerts/1920/0001001.PDF';
    const d1 = await invokeMo(['download', url, '--out', outDir], cacheDir, { fetchImpl });
    const d2 = await invokeMo(['download', url, '--out', outDir], cacheDir, { fetchImpl });
    expect(d1.exitCode).toBe(0);
    expect(d2.exitCode).toBe(0);
    expect(dlCalls).toBe(1);
    expect(d1.stdout).toContain('Downloaded:');
    expect(d2.stdout).toContain('Exists (skip):');
    expect(fs.readFileSync(path.join(outDir, '0001001.PDF'))).toEqual(PDF_BYTES);

    const mdh = await invokeMo(['mdh'], cacheDir);
    expect(mdh.exitCode).toBe(0);
    expect(mdh.stdout).toContain('https://www.sos.mo.gov/mdh');
    expect(mdh.stdout).toContain('https://mdh.deepwebaccess.com/mdh/');

    expect(
      parseDeathName('Jane Doe - Deceased John Doe - Spouse Thomas Roe - Father Mary Roe - Mother')
    ).toEqual({
      name: 'Jane Doe',
      deceased: 'Jane Doe',
      spouse: 'John Doe',
      father: 'Thomas Roe',
      mother: 'Mary Roe',
    });
  });
});
