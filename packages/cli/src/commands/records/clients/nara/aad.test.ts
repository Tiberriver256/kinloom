import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../../runtime/index.js';
import { runNaraCommand } from '../nara.js';
import {
  buildAadRecordUrl,
  parseAadRecordHtml,
  parseAadSearchHtml,
  parseExtraFields,
  resolveAadDatabase,
  validateAadUrl,
} from './aad.js';

const AAD_SEARCH_HTML = `
<html><body>
  <p>Total records found: 2</p>
  <table><tr><th>Single</th></tr></table>
  <table><tr><th>OnlyOneCol</th></tr><tr><td>x</td></tr></table>
  <table>
    <tr><th>Serial Number</th><th>Name</th><th>State</th><th>Details</th></tr>
    <tr><th>HeaderOnly</th></tr>
    <tr>
      <td>36123456</td>
      <td>STOUT JOHN H</td>
      <td>MICHIGAN</td>
      <td><a href="/aad/record-detail.jsp?dt=893&amp;rid=987654">View</a></td>
    </tr>
    <tr>
      <td>36999999</td>
      <td>STOUT WILLIAM</td>
      <td></td>
      <td><a href="https://other.example.com/x">Other</a></td>
    </tr>
  </table>
</body></html>
`;

const AAD_RECORD_HTML = `
<html><head><title>WWII Army Enlistment Record</title></head><body>
  <h1>WWII Army Enlistment Record</h1>
  <table>
    <tr><th>ARMY SERIAL NUMBER:</th><td>36123456</td></tr>
    <tr><th>NAME:</th><td>STOUT JOHN H</td></tr>
    <tr><th>STATE OF RESIDENCE:</th><td>MICHIGAN</td></tr>
    <tr><th>EMPTY:</th><td></td></tr>
  </table>
</body></html>
`;

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-nara-aad-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeNara(
  args: readonly string[],
  cacheDir: string,
  fetchImpl?: typeof fetch
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cacheHit?: boolean | undefined;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_NARA_CACHE_DIR: cacheDir },
    cwd: cacheDir,
    fetchImpl: fetchImpl ?? (async () => new Response('not found', { status: 404 })),
    sleepFn: async () => {},
  });
  const outcome = await runNaraCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('kinloom nara aad', () => {
  it('renders help and exits 0', async () => {
    const cacheDir = await makeTempDir();
    const res = await invokeNara(['aad', '--help'], cacheDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('kinloom nara aad [QUERY...] [options]');
    expect(res.stdout).toContain('wwii-enlistment');
  });

  it('searches AAD HTML tables, caches results, and emits deterministic --json and text output', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const seenUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      seenUrls.push(String(input));
      return new Response(AAD_SEARCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    };

    const r1 = await invokeNara(
      ['aad', 'Stout', '--db', 'wwii-enlistment', '--field', 'bc=sl', '--json'],
      cacheDir,
      fetchImpl
    );
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect(calls).toBe(1);
    expect(seenUrls[0]).toContain('cat=WR26');
    expect(seenUrls[0]).toContain('bc=sl');

    const p1 = JSON.parse(r1.stdout) as {
      mode: string;
      database: string;
      total: number;
      returned: number;
      cache_hit: boolean;
      records: Array<{ record_id: string | null; detail_url: string | null; fields: Record<string, string> }>;
    };
    expect(p1.mode).toBe('search');
    expect(p1.database).toBe('WR26');
    expect(p1.total).toBe(2);
    expect(p1.returned).toBe(2);
    expect(p1.cache_hit).toBe(false);
    expect(p1.records[0]?.record_id).toBe('987654');
    expect(p1.records[1]?.record_id).toBeNull();
    expect(p1.records[0]?.fields['Name']).toBe('STOUT JOHN H');

    // Second call hits cache with zero network requests and renders text with [cache].
    const r2 = await invokeNara(
      ['aad', '--query', 'Stout', '--db', 'WR26', '--field', 'bc=sl'],
      cacheDir,
      fetchImpl
    );
    expect(r2.exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(r2.cacheHit).toBe(true);
    expect(r2.stdout).toContain('[cache]');
    expect(r2.stdout).toContain('STOUT JOHN H');

    // --refresh bypasses cache.
    const r3 = await invokeNara(
      ['aad', 'Stout', '--db', 'wwii-enlistment', '--field', 'bc=sl', '--refresh', '--json'],
      cacheDir,
      fetchImpl
    );
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect((JSON.parse(r3.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
  });

  it('supports JSON search payloads (records/results) and cached AAD record detail lookups (HTML and JSON)', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes('record-detail.jsp') && url.includes('rid=987654')) {
        return new Response(AAD_RECORD_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.includes('record-detail.jsp') && url.includes('rid=555')) {
        return new Response(
          JSON.stringify({ title: 'POW Record', fields: { NAME: 'LINCOLN', CAMP: 'STALAG' } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('record-detail.jsp') && url.includes('rid=556')) {
        return new Response(JSON.stringify({ NAME: 'FLAT', RANK: 'PVT' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('q=Flat')) {
        return new Response(
          JSON.stringify({
            results: ['skip', { rid: '700', NAME: 'FLAT RES' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          total: 1,
          records: [
            {
              record_id: '555',
              detail_url: 'https://aad.archives.gov/aad/record-detail.jsp?rid=555',
              fields: { NAME: 'LINCOLN' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const sJson = await invokeNara(['aad', 'Lincoln', '--db', 'wwii-pow', '--json'], cacheDir, fetchImpl);
    expect(sJson.exitCode).toBe(0);
    expect(
      (JSON.parse(sJson.stdout) as { records: Array<{ record_id: string }> }).records[0]?.record_id
    ).toBe('555');

    const sFlat = await invokeNara(['aad', 'Flat'], cacheDir, fetchImpl);
    expect(sFlat.exitCode).toBe(0);
    expect(sFlat.stdout).toContain('FLAT RES');

    const d1 = await invokeNara(['aad', '--record', '987654', '--db', 'WR26', '--json'], cacheDir, fetchImpl);
    expect(d1.exitCode).toBe(0);
    const pd1 = JSON.parse(d1.stdout) as {
      mode: string;
      title: string;
      fields: Record<string, string>;
      cache_hit: boolean;
    };
    expect(pd1.mode).toBe('record');
    expect(pd1.title).toBe('WWII Army Enlistment Record');
    expect(pd1.fields['NAME']).toBe('STOUT JOHN H');
    expect(pd1.cache_hit).toBe(false);

    const d2 = await invokeNara(['aad', '--record', '987654', '--db', 'WR26'], cacheDir, fetchImpl);
    expect(d2.exitCode).toBe(0);
    expect(d2.stdout).toContain('[cache]');

    const d3 = await invokeNara(
      ['aad', '--record', 'https://aad.archives.gov/aad/record-detail.jsp?dt=WR25&rid=555', '--json'],
      cacheDir,
      fetchImpl
    );
    expect(d3.exitCode).toBe(0);
    expect((JSON.parse(d3.stdout) as { fields: Record<string, string> }).fields['CAMP']).toBe('STALAG');

    const d4 = await invokeNara(['aad', '--record', '556', '--json'], cacheDir, fetchImpl);
    expect(d4.exitCode).toBe(0);
    expect((JSON.parse(d4.stdout) as { title: string }).title).toBe('AAD Record 556');
    expect(calls).toBe(5);
  });

  it('rejects invalid inputs, non-AAD URLs, non-object JSON, network failures, and HTTP/error pages without caching', async () => {
    const cacheDir = await makeTempDir();

    expect((await invokeNara(['aad'], cacheDir)).exitCode).toBe(2);
    expect((await invokeNara(['aad', 'Stout', '--db', 'bad/db!'], cacheDir)).exitCode).toBe(2);
    expect((await invokeNara(['aad', 'Stout', '--field', 'noequals'], cacheDir)).exitCode).toBe(2);
    expect((await invokeNara(['aad', '--record', 'https://evil.example.com/aad'], cacheDir)).exitCode).toBe(
      2
    );
    expect((await invokeNara(['aad', '--record', 'bad/rid!'], cacheDir)).exitCode).toBe(2);

    expect(resolveAadDatabase(undefined)).toBeNull();
    expect(resolveAadDatabase('   ')).toBeNull();
    expect(() => validateAadUrl('not-a-url')).toThrow();
    expect(() => validateAadUrl('https://user:pass@aad.archives.gov/aad/')).toThrow();
    expect(() => parseExtraFields(['=val'])).toThrow();
    expect(buildAadRecordUrl('123', null).url).toContain('rid=123');
    expect(
      parseAadRecordHtml('<html><body></body></html>', {
        recordId: '1',
        database: null,
        url: 'https://aad.archives.gov/aad/',
      }).title
    ).toBe('AAD Record 1');
    expect(
      parseAadSearchHtml('<html><body>No tables</body></html>', {
        query: 'x',
        database: null,
        url: 'https://aad.archives.gov/aad/',
        page: 1,
        limit: 5,
      }).total
    ).toBe(0);

    const errHttp = await invokeNara(
      ['aad', 'Stout'],
      cacheDir,
      async () => new Response('err', { status: 500 })
    );
    expect(errHttp.exitCode).toBe(1);

    const errPage = await invokeNara(
      ['aad', 'Stout'],
      cacheDir,
      async () => new Response('<html><body>Service Unavailable</body></html>', { status: 200 })
    );
    expect(errPage.exitCode).toBe(1);
    expect(errPage.stderr).toContain('error page');

    const errNet = await invokeNara(['aad', 'Stout'], cacheDir, async () => {
      throw new Error('ECONNRESET');
    });
    expect(errNet.exitCode).toBe(1);
    expect(errNet.stderr).toContain('ECONNRESET');

    const badJsonSearch = await invokeNara(
      ['aad', 'Stout', '--json'],
      cacheDir,
      async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    expect(badJsonSearch.exitCode).toBe(1);

    const badJsonRecord = await invokeNara(
      ['aad', '--record', '999', '--json'],
      cacheDir,
      async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    expect(badJsonRecord.exitCode).toBe(1);
  });
});
