import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext, type OptionalBrowser } from '../runtime/index.js';
import { browserSearch, runCaArchivesCommand } from './ca-archives.js';

const PORTAL_SEARCH_HTML =
  '<html><body><p>Search Results 1 to 1 of 1</p>' +
  '<a href="/Items/Details/42">Lincoln Petition, Sacramento</a>' +
  '</body></html>';

const PORTAL_ITEM_HTML =
  '<html><head><title>Lincoln Petition | California Archives Search</title></head></html>';

const EXHIBITS_SEARCH_JSON = [
  { 'o:id': 99, 'o:title': 'Sacramento Exhibit', '@type': ['o:Item', 'dctype:Image'] },
];

const EXHIBITS_ITEM_JSON = {
  'o:id': 99,
  'o:title': 'Sacramento Exhibit',
  '@type': ['o:Item', 'dctype:Image'],
  'dcterms:description': [{ '@value': 'Historic photo' }],
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-ca-archives-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeCa(
  args: readonly string[],
  cacheDir: string,
  fetchImpl: typeof fetch,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_CA_ARCHIVES_CACHE_DIR: cacheDir, ...extraEnv },
    fetchImpl,
    sleepFn: async () => {},
  });
  const outcome = await runCaArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('ca-archives native client', () => {
  it('caches portal and exhibits search with zero repeat HTTP calls', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).includes('archives.sos.ca.gov')) {
        return new Response(PORTAL_SEARCH_HTML, { status: 200 });
      }
      return new Response(JSON.stringify(EXHIBITS_SEARCH_JSON), {
        status: 200,
        headers: {
          'content-type': 'application/ld+json',
          'Omeka-S-Total-Results': '1',
        },
      });
    };

    const r1 = await invokeCa(
      ['search', 'Sacramento', '--source', 'portal', '--source', 'exhibits', '--json'],
      cacheDir,
      fetchImpl
    );
    const r2 = await invokeCa(
      ['search', 'Sacramento', '--source', 'portal', '--source', 'exhibits', '--json'],
      cacheDir,
      fetchImpl
    );
    const r3 = await invokeCa(['search', 'Sacramento', '--source', 'portal'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r3.cacheHit).toBe(true);
    expect(r3.stdout).toContain('[cache]');
  });

  it('bypasses cache on --refresh and --cache-ttl-hours 0', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(PORTAL_SEARCH_HTML, { status: 200 });
    };

    await invokeCa(['search', 'Lincoln', '--source', 'portal', '--json'], cacheDir, fetchImpl);
    const rRef = await invokeCa(
      ['search', 'Lincoln', '--source', 'portal', '--refresh', '--json'],
      cacheDir,
      fetchImpl
    );
    const rTtl = await invokeCa(
      ['search', 'Lincoln', '--source', 'portal', '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      fetchImpl
    );

    expect(calls).toBe(3);
    expect((JSON.parse(rRef.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(rTtl.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
  });

  it('caches get --portal and get --exhibits', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).includes('Items/Details')) {
        return new Response(PORTAL_ITEM_HTML, { status: 200 });
      }
      return new Response(JSON.stringify(EXHIBITS_ITEM_JSON), {
        status: 200,
        headers: { 'content-type': 'application/ld+json' },
      });
    };

    const rp1 = await invokeCa(['get', '--portal', '42', '--json'], cacheDir, fetchImpl);
    const rp2 = await invokeCa(['get', '--portal', '42'], cacheDir, fetchImpl);
    const re1 = await invokeCa(['get', '--exhibits', '99', '--json'], cacheDir, fetchImpl);
    const re2 = await invokeCa(['get', '--exhibits', '99', '--json'], cacheDir, fetchImpl);

    expect(calls).toBe(2);
    expect((JSON.parse(rp1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(rp2.stdout).toContain('[cache]');
    expect((JSON.parse(re1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(re2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
  });

  it('never caches HTTP errors or blocked empty portal pages', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('error', { status: 500 });
      }
      if (calls === 2) {
        return new Response('<html><body>Temporary block</body></html>', { status: 200 });
      }
      return new Response(PORTAL_SEARCH_HTML, { status: 200 });
    };

    const r1 = await invokeCa(['search', 'Lincoln', '--source', 'portal'], cacheDir, fetchImpl);
    const r2 = await invokeCa(['search', 'Lincoln', '--source', 'portal', '--json'], cacheDir, fetchImpl);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    const r3 = await invokeCa(['search', 'Lincoln', '--source', 'portal', '--json'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).not.toContain('Traceback');
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(3);
  });

  it('builds verified URLs, validates get flags, and supports OAC/Calisphere browser search', async () => {
    const cacheDir = await makeTempDir();
    const unusedFetch: typeof fetch = async () => {
      throw new Error('unexpected HTTP call');
    };

    const urlRes = await invokeCa(['url', 'Gold', 'Rush'], cacheDir, unusedFetch);
    expect(urlRes.exitCode).toBe(0);
    expect(urlRes.stdout).toContain('oac: https://oac.cdlib.org/search?q=Gold%20Rush');
    expect(urlRes.stdout).toContain('calisphere: https://calisphere.org/search/?q=Gold%20Rush');
    expect(urlRes.stdout).toContain('cdnc: https://cdnc.ucr.edu/cgi-bin/cdnc');
    expect(urlRes.stdout).toContain('note: CDNC is behind a Cloudflare challenge');
    expect(urlRes.stdout).toContain('note: Minerva is a catalog');

    const badGet = await invokeCa(['get'], cacheDir, unusedFetch);
    expect(badGet.exitCode).toBe(2);

    const visited: string[] = [];
    const fakeBrowser: OptionalBrowser = {
      newContext: async () => ({
        newPage: async () => {
          let currentUrl = '';
          return {
            goto: async (u) => {
              currentUrl = u;
              visited.push(u);
            },
            content: async () => '',
            evaluate: async <T>(fn: string | (() => T)): Promise<T> => {
              const expr = String(fn);
              if (currentUrl.includes('oac.cdlib.org')) {
                if (expr.includes('innerText')) {
                  return 'Showing 1-2 of 2 entries' as unknown as T;
                }
                return [
                  { href: '/findaid/ark:/13030/c81111', text: 'Sacramento Papers' },
                  { href: '/findaid/ark:/13030/c81111/dsc/#aspace_1_aspace_2', text: 'Box 1' },
                ] as unknown as T;
              }
              if (expr.includes('innerText')) {
                return '3 items found' as unknown as T;
              }
              return [
                { href: '/item/abc123/', text: 'Historic Map' },
                { href: '/item/abc123/', text: 'Historic Map Duplicate' },
              ] as unknown as T;
            },
            close: async () => {},
          };
        },
        close: async () => {},
      }),
      close: async () => {},
    };

    const ctx = createRecordContext({
      env: { KINLOOM_CA_ARCHIVES_CACHE_DIR: cacheDir },
      fetchImpl: unusedFetch,
      sleepFn: async () => {},
    });
    const browserResult = await browserSearch(
      ctx,
      ['oac', 'calisphere'],
      'Sacramento',
      10,
      5000,
      async () => fakeBrowser
    );

    expect(visited).toHaveLength(2);
    expect(browserResult.oac?.total).toBe(2);
    expect(browserResult.oac?.results).toEqual([
      {
        title: 'Sacramento Papers',
        url: 'https://oac.cdlib.org/findaid/ark:/13030/c81111',
        kind: 'collection',
      },
      {
        title: 'Box 1',
        url: 'https://oac.cdlib.org/findaid/ark:/13030/c81111/dsc/#aspace_1_aspace_2',
        kind: 'component',
      },
    ]);
    expect(browserResult.calisphere?.total).toBe(3);
    expect(browserResult.calisphere?.results).toEqual([
      {
        title: 'Historic Map',
        url: 'https://calisphere.org/item/abc123/',
      },
    ]);
  });
});
