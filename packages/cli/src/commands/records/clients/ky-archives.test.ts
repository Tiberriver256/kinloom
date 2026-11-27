import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../runtime/index.js';
import { runKyArchivesCommand } from './ky-archives.js';

const CDM_SEARCH_JSON = {
  totalResults: 1,
  items: [
    {
      collectionAlias: 'MS',
      itemId: '101',
      title: 'Lincoln Family Papers',
      filetype: 'pdf',
      itemLink: '/singleitem/collection/MS/id/101',
      metadataFields: [{ field: 'date', value: '1845' }],
    },
  ],
};

const CDM_ITEM_JSON = {
  title: 'Lincoln Family Papers',
  contentType: 'application/pdf',
  fields: [{ key: 'title', label: 'Title', value: 'Lincoln Family Papers' }],
};

const CDM_COLLECTIONS_JSON = {
  totalCollections: 1,
  cards: [{ alias: 'MS', title: 'Manuscripts Collection' }],
};

const LAND_FORM_HTML =
  '<form><input name="__VIEWSTATE" value="vs1" />' +
  '<input name="__VIEWSTATEGENERATOR" value="vg1" />' +
  '<input name="__EVENTVALIDATION" value="ev1" /></form>';

const LAND_RESULT_HTML =
  '<div>1 Results found ' +
  '1) Patent #1234.0 Grantee: Lincoln, Thomas Grant Book &amp; Pg: 12 45 ' +
  'Acreage: 100 County: Hardin WaterCourse: Nolin Creek ' +
  'Survey Name: Thomas Lincoln Survey Date: 1838-05-01 Grant Date: 1839-01-10 ' +
  'Grant Note: none</div>';

const RSS_XML =
  '<rss><channel><item><title>Lincoln Pension Packet</title>' +
  '<link>https://kdla.access.preservica.com/item/1</link></item></channel></rss>';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-ky-archives-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeKy(
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
    env: { KINLOOM_KY_ARCHIVES_CACHE_DIR: cacheDir },
    fetchImpl,
    sleepFn: async () => {},
  });
  const outcome = await runKyArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('ky-archives native client', () => {
  it('caches cdm and cdm-item with zero repeat HTTP calls', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).includes('singleitem')) {
        return new Response(JSON.stringify(CDM_ITEM_JSON), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(CDM_SEARCH_JSON), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const r1 = await invokeKy(['cdm', 'Lincoln', '--json'], cacheDir, fetchImpl);
    const r2 = await invokeKy(['cdm', 'Lincoln', '--json'], cacheDir, fetchImpl);
    const r3 = await invokeKy(['cdm', 'Lincoln'], cacheDir, fetchImpl);
    const i1 = await invokeKy(['cdm-item', 'MS', '101', '--json'], cacheDir, fetchImpl);
    const i2 = await invokeKy(['cdm-item', 'MS', '101'], cacheDir, fetchImpl);

    expect(calls).toBe(2);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(r3.stdout).toContain('[cache]');
    expect((JSON.parse(i1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(i2.stdout).toContain('[cache]');
  });

  it('caches land and preservica, supporting --refresh and zero TTL', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      const url = String(input);
      if (url.includes('preservica')) {
        return new Response(RSS_XML, { status: 200 });
      }
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        return new Response(LAND_FORM_HTML, { status: 200 });
      }
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      if (bodyStr.includes('LbAdvSearch')) {
        return new Response(LAND_FORM_HTML, { status: 200 });
      }
      return new Response(LAND_RESULT_HTML, { status: 200 });
    };

    const l1 = await invokeKy(['land', 'Lincoln', '--json'], cacheDir, fetchImpl);
    const l2 = await invokeKy(['land', 'Lincoln', '--json'], cacheDir, fetchImpl);
    const lRef = await invokeKy(['land', 'Lincoln', '--refresh', '--json'], cacheDir, fetchImpl);
    const p1 = await invokeKy(['preservica', 'Lincoln', '--json'], cacheDir, fetchImpl);
    const p2 = await invokeKy(['preservica', 'Lincoln'], cacheDir, fetchImpl);
    const pTtl = await invokeKy(
      ['preservica', 'Lincoln', '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      fetchImpl
    );

    const parsedL1 = JSON.parse(l1.stdout) as {
      cache_hit: boolean;
      totalResults: number;
      results: { patent: string; grantee: string; county: string }[];
    };
    expect(parsedL1.cache_hit).toBe(false);
    expect(parsedL1.totalResults).toBe(1);
    expect(parsedL1.results[0].patent).toBe('1234.0');
    expect(parsedL1.results[0].grantee).toBe('Lincoln, Thomas');
    expect(parsedL1.results[0].county).toBe('Hardin');

    expect((JSON.parse(l2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect((JSON.parse(lRef.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(p1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(p2.stdout).toContain('[cache]');
    expect((JSON.parse(pTtl.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(calls).toBe(8);
  });

  it('never caches HTTP errors or blocked preservica HTML', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('blocked', { status: 403 });
      }
      if (calls === 2) {
        return new Response('<html><body>Rate limited</body></html>', { status: 200 });
      }
      return new Response(RSS_XML, { status: 200 });
    };

    const r1 = await invokeKy(['preservica', 'Lincoln'], cacheDir, fetchImpl);
    const r2 = await invokeKy(['preservica', 'Lincoln', '--json'], cacheDir, fetchImpl);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    const r3 = await invokeKy(['preservica', 'Lincoln', '--json'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).not.toContain('Traceback');
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(3);
  });

  it('supports collections, land-patent, cdm-url, and urls commands', async () => {
    const cacheDir = await makeTempDir();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/collections')) {
        return new Response(JSON.stringify(CDM_COLLECTIONS_JSON), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(LAND_FORM_HTML, { status: 200 });
      }
      return new Response(LAND_RESULT_HTML, { status: 200 });
    };

    const cols = await invokeKy(['collections', '--json'], cacheDir, fetchImpl);
    expect(cols.exitCode).toBe(0);
    expect((JSON.parse(cols.stdout) as { totalCollections: number }).totalCollections).toBe(1);

    const pat = await invokeKy(['land-patent', '1234', '--book', '12', '--page', '45'], cacheDir, fetchImpl);
    expect(pat.exitCode).toBe(0);
    expect(pat.stdout).toContain('Patent #1234.0: Lincoln, Thomas');

    const cdmUrl = await invokeKy(['cdm-url', 'Boone County'], cacheDir, fetchImpl);
    expect(cdmUrl.exitCode).toBe(0);
    expect(cdmUrl.stdout).toBe(
      'https://www.kyhistory.com/cdm/search/searchterm/Boone%20County/mode/exact'
    );

    const urls = await invokeKy(['urls', 'Lincoln'], cacheDir, fetchImpl);
    expect(urls.exitCode).toBe(0);
    expect(urls.stdout).toContain('https://kdla.access.preservica.com/?s=Lincoln');
    expect(urls.stdout).toContain('https://web.sos.ky.gov/land/ccorders.aspx');
  });
});
