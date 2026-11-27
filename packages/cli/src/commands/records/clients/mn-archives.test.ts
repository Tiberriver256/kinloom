import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../runtime/index.js';
import { runMnArchivesCommand } from './mn-archives.js';

const SAMPLE_DEATH_RESPONSE = {
  success: true,
  data: {
    totalHitCount: 1,
    pageNum: 1,
    pageSize: 25,
    pageCount: 1,
    hits: [
      {
        id: 'a96a5503-6d05-4bf7-9045-098ca3e7f6fa',
        deathDateStart: '1916-07-09T00:00:00',
        county: 'Hennepin County',
        certificateId: '1916-MN-007499',
        firstName: 'Arthur',
        middleName: 'E.',
        familyName: 'Alder',
        mothersMaidenName: 'Maple',
      },
    ],
  },
};

const SAMPLE_BIRTH_RESPONSE = {
  success: true,
  data: {
    totalHitCount: 1,
    pageNum: 1,
    pageSize: 25,
    pageCount: 1,
    hits: [
      {
        id: 'bd6df19c-2e99-4708-9813-cd16386cfd7f',
        birthDateStart: '1920-01-03T00:00:00',
        county: 'Steele County',
        certificateId: 'DC-78215',
        firstName: 'Helen',
        middleName: 'M.',
        familyName: 'Maple',
        mothersMaidenName: 'Alder',
      },
    ],
  },
};

const SAMPLE_CENSUS_RESPONSE = {
  success: true,
  data: {
    totalHitCount: 1,
    pageNum: 1,
    pageSize: 25,
    pageCount: 1,
    hits: [
      {
        id: '9d6c96ea-6374-426c-8213-aef509f3572b',
        censusDateStart: '1895-01-01T00:00:00',
        county: 'Big Stone County',
        locality: 'Prior',
        age: '15',
        lineInImage: 38,
        certificateId: '1895-mnv290_49-0661-38',
        firstName: 'Ezra',
        familyName: 'Maple',
      },
    ],
  },
};

const SAMPLE_RECORD_DETAIL = {
  success: true,
  data: {
    id: 'a96a5503-6d05-4bf7-9045-098ca3e7f6fa',
    deathDateStart: '1916-07-09T00:00:00',
    county: 'Hennepin County',
    certificateId: '1916-MN-007499',
    firstName: 'Arthur',
    middleName: 'E.',
    familyName: 'Alder',
    mothersMaidenName: 'Maple',
  },
};

const SAMPLE_NEWS_SEARCH_HTML = `
<html><head><script>var psRecCnt = 42;</script></head><body>
<table><tr>
<td class="ps-result-cell">
  <img class="ps-result-thumb" src="/servlet/PsObjThumb;jsessionid=ABC123?tnName=2802b576-860c-4805-9aea-e1c8bb675319%2Fmnhi0031%2F1H1BCU5B%2F18012301" />
  <a class="ps-result-title ps-truncated" title="Willmar tribune." href="/jsp/PsImageViewer.jsp;jsessionid=ABC123?doc_id=2802b576-860c-4805-9aea-e1c8bb675319%2Fmnhi0031%2F1H1BCU5B%2F18012301">Willmar tribune.</a>
  <div class="ps-result-detail">Publication Date:&nbsp;January 23, 1918</div>
</td>
</tr></table>
</body></html>
`;

const SAMPLE_NEWS_METADATA_HTML = `
<html><body><div id="ps-metadata-div"><table id="ps-metadata-table">
<tr><td class="ps-md-field-label">Title</td><td class="ps-md-field-value">Willmar tribune.</td></tr>
<tr><td class="ps-md-field-label">Date Published</td><td class="ps-md-field-value">January 23, 1918</td></tr>
<tr><td class="ps-md-field-label">Subject-County</td><td class="ps-md-field-value">Kandiyohi</td></tr>
<tr><td class="ps-md-field-label">LCCN </td><td class="ps-md-field-value">sn89081022</td></tr>
</table></div></body></html>
`;

const MINIMAL_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
  0x00, 0x00, 0xff, 0xd9,
]);

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-mn-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeMn(
  args: readonly string[],
  opts: {
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly fetchImpl?: typeof fetch;
  } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: opts.env ?? {},
    cwd: opts.cwd ?? os.tmpdir(),
    fetchImpl:
      opts.fetchImpl ??
      (async () => {
        throw new Error('unexpected network call');
      }),
    sleepFn: async () => {},
  });
  const outcome = await runMnArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('mn-archives native client', () => {
  it('builds death search payload and serves repeat queries from disk cache', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    const seenBodies: Record<string, unknown>[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('www.mnhs.org');
      expect(url.pathname).toBe('/_hcms/api/death/getAllDeathRecords');
      seenBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify(SAMPLE_DEATH_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const env = { KINLOOM_CACHE_DIR: cacheRoot };
    const args = [
      'death',
      '--last',
      'Alder',
      '--county',
      'Hennepin County',
      '--begin-year',
      '1910',
      '--end-year',
      '1920',
      '--json',
    ];

    const r1 = await invokeMn(args, { env, fetchImpl });
    const r2 = await invokeMn(args, { env, fetchImpl });
    const r3 = await invokeMn(args.slice(0, -1), { env, fetchImpl });
    const r4 = await invokeMn([...args, '--refresh'], { env, fetchImpl });

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(r4.exitCode).toBe(0);
    expect(seenBodies).toHaveLength(2);

    expect(seenBodies[0].filters).toEqual([
      { conjunction: 'and', filters: [{ field: 'familyName', term: 'Alder', op: '=' }] },
      { conjunction: 'or', filters: [{ field: 'county', term: 'Hennepin.*', op: '*' }] },
      {
        conjunction: 'and',
        filters: [
          { field: 'deathDateStart', term: '1910-01-01', op: '>=' },
          { field: 'deathDateStart', term: '1920-12-31', op: '<=' },
        ],
      },
    ]);

    const p1 = JSON.parse(r1.stdout) as {
      cache_hit: boolean;
      results: { certificate_id: string; date: string }[];
    };
    const p2 = JSON.parse(r2.stdout) as { cache_hit: boolean };
    const p4 = JSON.parse(r4.stdout) as { cache_hit: boolean };
    expect(p1.cache_hit).toBe(false);
    expect(p2.cache_hit).toBe(true);
    expect(p4.cache_hit).toBe(false);
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r3.cacheHit).toBe(true);
    expect(p1.results[0].certificate_id).toBe('1916-MN-007499');
    expect(p1.results[0].date).toBe('1916-07-09');
    expect(r3.stdout).toContain('[cache]');
    expect(
      fs.readdirSync(path.join(cacheRoot, 'mn-archives')).filter((f) => f.endsWith('.json'))
    ).toHaveLength(1);
  });

  it('honors KINLOOM_MN_ARCHIVES_CACHE_DIR over KINLOOM_CACHE_DIR', async () => {
    const tmp = await makeTempDir();
    const specificDir = path.join(tmp, 'specific-mn');
    const sharedDir = path.join(tmp, 'shared');
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(SAMPLE_DEATH_RESPONSE), { status: 200 });

    const r = await invokeMn(['death', '--last', 'Alder', '--json'], {
      env: { KINLOOM_MN_ARCHIVES_CACHE_DIR: specificDir, KINLOOM_CACHE_DIR: sharedDir },
      fetchImpl,
    });
    expect(r.exitCode).toBe(0);
    expect(fs.readdirSync(specificDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(fs.existsSync(sharedDir)).toBe(false);
  });

  it('handles birth, census, vets (with Fort Snelling), and record detail', async () => {
    const tmp = await makeTempDir();
    const env = { KINLOOM_CACHE_DIR: path.join(tmp, 'cache') };

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('getAllBirthRecords')) {
        return new Response(JSON.stringify(SAMPLE_BIRTH_RESPONSE), { status: 200 });
      }
      if (url.pathname.endsWith('getAllCensusRecords')) {
        return new Response(JSON.stringify(SAMPLE_CENSUS_RESPONSE), { status: 200 });
      }
      if (url.pathname.endsWith('getAllVetsGravesRecords')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          filters: { filters: unknown[] }[];
        };
        expect(body.filters[1].filters).toEqual([
          { field: 'burialLocation', term: 'Hennepin.*', op: '*' },
          { field: 'burialLocation', term: 'Fort Snelling.*', op: '*' },
        ]);
        return new Response(JSON.stringify({ success: true, data: { totalHitCount: 0, hits: [] } }), {
          status: 200,
        });
      }
      if (url.pathname.endsWith('getDeathRecordById')) {
        return new Response(JSON.stringify(SAMPLE_RECORD_DETAIL), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const rb = await invokeMn(['birth', '--last', 'Maple', '--mother-maiden', 'Alder', '--json'], {
      env,
      fetchImpl,
    });
    const rc = await invokeMn(['census', '--last', 'Maple', '--begin-year', '1895', '--json'], {
      env,
      fetchImpl,
    });
    const rv = await invokeMn(['vets', '--last', 'Maple', '--county', 'Hennepin', '--json'], {
      env,
      fetchImpl,
    });
    const rr = await invokeMn(
      ['record', 'a96a5503-6d05-4bf7-9045-098ca3e7f6fa', '--type', 'death', '--json'],
      { env, fetchImpl }
    );

    expect([rb.exitCode, rc.exitCode, rv.exitCode, rr.exitCode]).toEqual([0, 0, 0, 0]);
    expect(
      (JSON.parse(rb.stdout) as { results: { mothers_maiden_name: string }[] }).results[0].mothers_maiden_name
    ).toBe('Alder');
    expect((JSON.parse(rc.stdout) as { results: { locality: string }[] }).results[0].locality).toBe('Prior');
    expect((JSON.parse(rv.stdout) as { total: number }).total).toBe(0);
    const rec = JSON.parse(rr.stdout) as {
      summary: { certificate_id: string };
      url: string;
    };
    expect(rec.summary.certificate_id).toBe('1916-MN-007499');
    expect(rec.url).toBe(
      'https://www.mnhs.org/search/people/record?uuid=a96a5503-6d05-4bf7-9045-098ca3e7f6fa&recordType=death-records'
    );
  });

  it('retries transient 429/503 responses and never caches HTTP 500 errors', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    const env = { KINLOOM_CACHE_DIR: cacheRoot };
    let attempts = 0;

    const flakyFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      }
      if (attempts === 2) {
        return new Response('busy', { status: 503 });
      }
      return new Response(JSON.stringify(SAMPLE_DEATH_RESPONSE), { status: 200 });
    };

    const ok = await invokeMn(['death', '--last', 'Alder', '--json'], {
      env,
      fetchImpl: flakyFetch,
    });
    expect(ok.exitCode).toBe(0);
    expect(attempts).toBe(3);
    expect((JSON.parse(ok.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    const beforeFiles = fs
      .readdirSync(path.join(cacheRoot, 'mn-archives'))
      .filter((f) => f.endsWith('.json'));
    const failed = await invokeMn(['death', '--last', 'Cedar', '--json'], {
      env,
      fetchImpl: async () => new Response('internal error', { status: 500 }),
    });
    const afterFiles = fs.readdirSync(path.join(cacheRoot, 'mn-archives')).filter((f) => f.endsWith('.json'));

    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('HTTP 500');
    expect(afterFiles).toEqual(beforeFiles);
  });

  it('searches and fetches metadata from Digital Newspaper Hub with caching', async () => {
    const tmp = await makeTempDir();
    const env = { KINLOOM_CACHE_DIR: path.join(tmp, 'cache') };
    let calls = 0;

    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const url = new URL(String(input));
      if (url.pathname === '/jsp/PsSearchResults.jsp') {
        expect(url.searchParams.get('query1')).toBe('Alder');
        expect(url.searchParams.get('query1_field')).toBe('CONTENT');
        expect(url.searchParams.get('query2_field')).toBe('DATE_PUBLISHED_MILLIS');
        return new Response(SAMPLE_NEWS_SEARCH_HTML, { status: 200 });
      }
      if (url.pathname === '/jsp/PsMetadata.jsp') {
        return new Response(SAMPLE_NEWS_METADATA_HTML, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const s1 = await invokeMn(
      ['newspapers', 'search', 'Alder', '--begin-year', '1915', '--end-year', '1920', '--json'],
      { env, fetchImpl }
    );
    const s2 = await invokeMn(
      ['newspapers', 'search', 'Alder', '--begin-year', '1915', '--end-year', '1920', '--json'],
      { env, fetchImpl }
    );
    const docId = '2802b576-860c-4805-9aea-e1c8bb675319/mnhi0031/1H1BCU5B/18012301';
    const m1 = await invokeMn(['newspapers', 'metadata', docId, '--json'], { env, fetchImpl });
    const m2 = await invokeMn(['newspapers', 'metadata', docId, '--json'], { env, fetchImpl });

    expect([s1.exitCode, s2.exitCode, m1.exitCode, m2.exitCode]).toEqual([0, 0, 0, 0]);
    expect(calls).toBe(2);

    const sp1 = JSON.parse(s1.stdout) as {
      total: number;
      cache_hit: boolean;
      results: { title: string; publication_date: string; doc_id: string }[];
    };
    expect(sp1.total).toBe(42);
    expect(sp1.cache_hit).toBe(false);
    expect((JSON.parse(s2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(sp1.results[0].title).toBe('Willmar tribune.');
    expect(sp1.results[0].publication_date).toBe('January 23, 1918');
    expect(sp1.results[0].doc_id).toBe(docId);

    const mp1 = JSON.parse(m1.stdout) as {
      cache_hit: boolean;
      fields: Record<string, string>;
    };
    expect(mp1.cache_hit).toBe(false);
    expect((JSON.parse(m2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(mp1.fields['Subject-County']).toBe('Kandiyohi');
    expect(mp1.fields.LCCN).toBe('sn89081022');
  });

  it('validates host, path traversal, and image magic bytes on newspaper download', async () => {
    const tmp = await makeTempDir();
    const env = { KINLOOM_CACHE_DIR: path.join(tmp, 'cache') };
    const docId = '2802b576-860c-4805-9aea-e1c8bb675319/mnhi0031/1H1BCU5B/18012301';
    const outJpg = path.join(tmp, 'issue.jpg');

    let calls = 0;
    const jpegFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(MINIMAL_JPEG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    };

    const d1 = await invokeMn(['newspapers', 'download', docId, '--out', outJpg, '--json'], {
      env,
      fetchImpl: jpegFetch,
    });
    const d2 = await invokeMn(['newspapers', 'download', docId, '--out', outJpg, '--json'], {
      env,
      fetchImpl: jpegFetch,
    });
    expect([d1.exitCode, d2.exitCode]).toEqual([0, 0]);
    expect(calls).toBe(1);
    const p1 = JSON.parse(d1.stdout) as { format: string; skipped: boolean };
    const p2 = JSON.parse(d2.stdout) as { skipped: boolean };
    expect(p1.format).toBe('jpeg');
    expect(p1.skipped).toBe(false);
    expect(p2.skipped).toBe(true);
    expect(fs.readFileSync(outJpg)).toEqual(MINIMAL_JPEG_BYTES);

    const badJpg = path.join(tmp, 'html-trap.jpg');
    const htmlFetch: typeof fetch = async () =>
      new Response('<!DOCTYPE html><html><body>Error page</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });

    const dHtml = await invokeMn(['newspapers', 'download', docId, '--out', badJpg], {
      env,
      fetchImpl: htmlFetch,
    });
    expect(dHtml.exitCode).toBe(1);
    expect(dHtml.stderr).toContain('Refusing to save HTML');
    expect(fs.existsSync(badJpg)).toBe(false);

    const dHost = await invokeMn(
      ['newspapers', 'download', 'https://example.invalid/thumb.jpg', '--out', badJpg],
      { env, fetchImpl: jpegFetch }
    );
    expect(dHost.exitCode).toBe(2);
    expect(dHost.stderr).toContain('Refusing host');

    const dTrav = await invokeMn(['newspapers', 'download', docId, '--out', '../escape.jpg'], {
      env,
      cwd: tmp,
      fetchImpl: jpegFetch,
    });
    expect(dTrav.exitCode).toBe(2);
    expect(dTrav.stderr).toContain('traversal');
  });

  it('outputs browser-only metadata for mdl subcommand and help output', async () => {
    const res = await invokeMn(['mdl', '--json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as { status: string; home_url: string };
    expect(payload.status).toBe('browser-only');
    expect(payload.home_url).toBe('https://collection.mndigital.org/');

    const help = await invokeMn(['--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('kinloom mn-archives');
  });
});
