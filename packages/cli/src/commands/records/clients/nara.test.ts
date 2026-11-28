import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRecordContext,
  HttpStatusError,
  type OptionalBrowser,
  type OptionalBrowserProcess,
  type RecordHandler,
  RecordRuntimeError,
} from '../runtime/index.js';
import {
  apiGetJson,
  CENSUS1950_RETRY_AFTER_CAP_S,
  census1950FetchJpeg,
  census1950FetchJson,
  createNaraCommand,
  type NaraBrowserOverrides,
  type NaraSearchPayload,
  NaraWafOrNonJsonError,
  normalizeQueryForWafRetry,
  parseCensus1950ImageSource,
  resolveSafeChild,
  runNaraCommand,
  safeObjectFilename,
  USER_AGENT,
} from './nara.js';

const LINCOLN_ED_IMAGE =
  '1950census/43290879-Illinois/43290879-Illinois-087558/43290879-Illinois-087558-0002.jpg';
const LINCOLN_ED_INFO =
  'https://1950census.archives.gov/iiif/2/' +
  '1950census%2F43290879-Illinois%2F43290879-Illinois-087558%2F' +
  '43290879-Illinois-087558-0002.jpg/info.json';
const JPEG_FULL = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('full-schedule')]);
const JPEG_PREVIEW = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('width-preview')]);
const JPEG_REFRESHED = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  Buffer.from('refreshed-schedule'),
]);

function censusSheet(index: number): string {
  return `1950census/43290879-Illinois/43290879-Illinois-087558/43290879-Illinois-087558-${String(index).padStart(4, '0')}.jpg`;
}

function sampleRecordResponse(
  naid: string,
  title: string,
  options: { readonly withText?: boolean; readonly pageCount?: number } = {}
): Record<string, unknown> {
  const withText = options.withText ?? false;
  const pageCount = options.pageCount ?? 4;
  const digitalObjects = Array.from({ length: pageCount }, (_v, i) => {
    const idx = i + 1;
    const obj: Record<string, unknown> = {
      objectId: `obj-${idx}`,
      objectFilename: `sheet_${String(idx).padStart(3, '0')}.jpg`,
      objectUrl: `https://s3.amazonaws.com/NARAprodstorage/mock/${naid}/sheet_${String(idx).padStart(3, '0')}.jpg`,
    };
    if (withText) {
      obj['extractedText'] = `Transcribed page ${idx} for ${title}`;
    }
    return obj;
  });
  return {
    body: {
      hits: {
        total: { value: 1 },
        hits: [
          {
            _source: {
              record: {
                naId: Number.parseInt(naid, 10),
                title,
                levelOfDescription: 'fileUnit',
                recordGroupNumber: 29,
                digitalObjects,
              },
            },
          },
        ],
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function getHeader(init: RequestInit | undefined, name: string): string | null {
  if (!init?.headers) {
    return null;
  }
  return new Headers(init.headers).get(name);
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix = 'kinloom-nara-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface InvokeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cacheHit?: boolean;
  readonly bytesOut: number;
}

async function invokeNara(
  args: readonly string[],
  options: {
    readonly cacheDir: string;
    readonly cwd?: string;
    readonly fetchImpl?: typeof fetch;
    readonly env?: NodeJS.ProcessEnv;
    readonly sleepFn?: (ms: number) => Promise<void>;
    readonly nowMs?: () => number;
    readonly handler?: RecordHandler;
    readonly overrides?: NaraBrowserOverrides;
  }
): Promise<InvokeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const defaultFetch: typeof fetch = async (input) => {
    throw new Error(`Unexpected network call in test: ${String(input)}`);
  };
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_NARA_CACHE_DIR: options.cacheDir, ...options.env },
    cwd: options.cwd ?? options.cacheDir,
    fetchImpl: options.fetchImpl ?? defaultFetch,
    sleepFn: options.sleepFn ?? (async () => {}),
    nowMs: options.nowMs ?? (() => Date.now()),
  });
  const runner =
    options.handler ?? (options.overrides ? createNaraCommand(options.overrides) : runNaraCommand);
  const outcome = await runner(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
    bytesOut: outcome.bytesOut,
  };
}

function listFiles(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix) && fs.statSync(path.join(dir, name)).isFile())
    .toSorted()
    .map((name) => path.join(dir, name));
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// ===========================================================================
// 1. WAF & Parallelism (6 tests)
// ===========================================================================

describe('NARA WAF and parallelism', () => {
  it('normalizes queries for WAF retry by stripping quotes and standalone AND', () => {
    expect(normalizeQueryForWafRetry('"Merced" AND "24-7" AND "1940"')).toBe('Merced 24-7 1940');
    expect(normalizeQueryForWafRetry('Merced AND 24-7 AND 1940')).toBe('Merced 24-7 1940');
    expect(normalizeQueryForWafRetry('"Harriet Tubman"')).toBe('Harriet Tubman');
    expect(normalizeQueryForWafRetry('Merced 24-7 1940')).toBeNull();
    expect(normalizeQueryForWafRetry('""')).toBeNull();
  });

  it('apiGetJson throws NaraWafOrNonJsonError on HTTP 200 HTML WAF response', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(getHeader(init, 'accept')).toBe('application/json');
      expect(getHeader(init, 'user-agent')).toBe(USER_AGENT);
      return new Response('<!doctype html><html><body>WAF challenge</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };

    await expect(
      apiGetJson('https://catalog.archives.gov/api/v2/records/search?q=test', 'k', {
        fetchImpl,
        sleepFn: async () => {},
        nowMs: () => Date.now(),
      })
    ).rejects.toBeInstanceOf(NaraWafOrNonJsonError);
  });

  it('apiGetJson throws NaraWafOrNonJsonError on HTTP 403 HTML response', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('<html><body>Forbidden by WAF</body></html>', {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });

    await expect(
      apiGetJson('https://catalog.archives.gov/api/v2/records/search?q=test', 'k', {
        fetchImpl,
        sleepFn: async () => {},
        nowMs: () => Date.now(),
      })
    ).rejects.toBeInstanceOf(NaraWafOrNonJsonError);
  });

  it('search retries WAF-blocked query without quotes or AND without browser fallback', async () => {
    const cacheDir = await makeTempDir();
    const seenUrls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes('%22') || url.includes('AND')) {
        return new Response('<html><body>WAF</body></html>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        });
      }
      return jsonResponse({
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _source: {
                  record: {
                    naId: 123456,
                    title: '1940 Census Merced ED 24-7',
                    levelOfDescription: 'fileUnit',
                    recordGroupNumber: 29,
                  },
                },
              },
            ],
          },
        },
      });
    };

    const res = await invokeNara(
      [
        'search',
        '"Merced" AND "24-7" AND "1940"',
        '--rg',
        '29',
        '--online',
        '--limit',
        '5',
        '--api-key',
        'test-key',
        '--json',
      ],
      {
        cacheDir,
        fetchImpl,
        overrides: {
          browserSearchMany: async () => {
            throw new Error('browser fallback must not run');
          },
        },
      }
    );

    expect(res.exitCode).toBe(0);
    expect(seenUrls).toHaveLength(2);
    expect(seenUrls[1]).toContain('q=Merced%2024-7%201940');
    const payload = JSON.parse(res.stdout) as {
      query: string;
      total: number;
      results: { naId: string }[];
    };
    expect(payload.query).toBe('"Merced" AND "24-7" AND "1940"');
    expect(payload.total).toBe(1);
    expect(payload.results[0].naId).toBe('123456');
  });

  it('search falls back to browser only for failed queries preserving order', async () => {
    const cacheDir = await makeTempDir();
    const browserCalls: (readonly (readonly [string | null, string])[])[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('AlwaysWaf')) {
        return new Response('<html><body>WAF</body></html>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        });
      }
      const naid = url.includes('Harriet') ? '111' : '333';
      return jsonResponse({
        body: {
          hits: {
            total: { value: 1 },
            hits: [{ _source: { record: { naId: naid, title: `Record ${naid}` } } }],
          },
        },
      });
    };

    const res = await invokeNara(
      ['search', 'Harriet Tubman', 'AlwaysWaf', 'Clara Barton', '--api-key', 'test-key', '--json'],
      {
        cacheDir,
        fetchImpl,
        overrides: {
          browserSearchMany: async (pairs): Promise<NaraSearchPayload[]> => {
            browserCalls.push(pairs);
            return pairs.map(([q, u]) => ({
              ...(q !== null ? { query: q } : {}),
              searchUrl: u,
              total: 1,
              results: [
                {
                  naId: '222',
                  title: 'Browser Fallback Record',
                  url: 'https://catalog.archives.gov/id/222',
                },
              ],
            }));
          },
        },
      }
    );

    expect(res.exitCode).toBe(0);
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0]).toHaveLength(1);
    expect(browserCalls[0][0][0]).toBe('AlwaysWaf');
    const payloads = JSON.parse(res.stdout) as { query: string; results: { naId: string }[] }[];
    expect(payloads.map((p) => p.query)).toEqual(['Harriet Tubman', 'AlwaysWaf', 'Clara Barton']);
    expect(payloads.map((p) => p.results[0].naId)).toEqual(['111', '222', '333']);
  });

  it('search and get parallelize API requests and preserve order', async () => {
    const cacheDir = await makeTempDir();

    function makeOverlappingFetch(expectedInflight: number) {
      let current = 0;
      let peak = 0;
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        current += 1;
        peak = Math.max(peak, current);
        if (current >= expectedInflight) {
          releaseBarrier();
        }
        await barrier;
        current -= 1;

        for (const tag of ['300398', '300357', '595367', 'Harriet', 'Clara', 'Frederick']) {
          if (url.includes(tag)) {
            return jsonResponse({
              body: {
                hits: {
                  total: { value: 1 },
                  hits: [{ _source: { record: { naId: tag, title: `Title ${tag}` } } }],
                },
              },
            });
          }
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      return { fetchImpl, getPeak: () => peak };
    }

    const searchMock = makeOverlappingFetch(3);
    const getMock = makeOverlappingFetch(3);

    const resSearch = await invokeNara(
      ['search', 'Harriet', 'Clara', 'Frederick', '--api-key', 'test-key', '--json'],
      { cacheDir, fetchImpl: searchMock.fetchImpl }
    );
    const resGet = await invokeNara(
      ['get', '300398', '300357', '595367', '--api-key', 'test-key', '--json'],
      { cacheDir, fetchImpl: getMock.fetchImpl }
    );

    expect(resSearch.exitCode).toBe(0);
    expect(resGet.exitCode).toBe(0);
    expect(searchMock.getPeak()).toBe(3);
    expect(getMock.getPeak()).toBe(3);

    const searchPayloads = JSON.parse(resSearch.stdout) as { query: string }[];
    expect(searchPayloads.map((p) => p.query)).toEqual(['Harriet', 'Clara', 'Frederick']);
    const getRecords = JSON.parse(resGet.stdout) as { naId: string }[];
    expect(getRecords.map((r) => r.naId)).toEqual(['300398', '300357', '595367']);
  });
});

// ===========================================================================
// 2. Disk Caching & Path Safety (4 tests)
// ===========================================================================

describe('NARA disk caching and path safety', () => {
  it('get caches record, serves --objects/--pages from disk, upgrades --text, and honors --refresh', async () => {
    const baseDir = await makeTempDir('kinloom-nara-cache-');
    const cacheDir = path.join(baseDir, 'cache');
    const apiCalls: string[] = [];
    let version = 1;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      apiCalls.push(url);
      const includeText = url.includes('includeExtractedText=true');
      return jsonResponse(
        sampleRecordResponse('595367', `1940 Census Merced ED 24-7 v${version}`, {
          withText: includeText,
        })
      );
    };

    const res1 = await invokeNara(['get', '595367', '--api-key', 'k', '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(res1.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(1);
    expect(fs.existsSync(path.join(cacheDir, 'records', '595367.json'))).toBe(true);
    expect(JSON.parse(res1.stdout)).not.toHaveProperty('objects');

    // Second call with --objects --pages 2-3 hits disk cache: ZERO HTTP requests.
    const res2 = await invokeNara(
      ['get', '595367', '--objects', '--pages', '2-3', '--api-key', 'k', '--json'],
      { cacheDir, fetchImpl }
    );
    expect(res2.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(1);
    const p2 = JSON.parse(res2.stdout) as { title: string; objects: { page: number }[] };
    expect(p2.objects.map((o) => o.page)).toEqual([2, 3]);
    expect(p2.title).toBe('1940 Census Merced ED 24-7 v1');

    // Requesting --text upgrades cache once, then second --text makes ZERO HTTP requests.
    const res3 = await invokeNara(['get', '595367', '--text', '--pages', '1-2', '--api-key', 'k', '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(res3.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(2);
    const p3 = JSON.parse(res3.stdout) as { extractedText: { page: number }[] };
    expect(p3.extractedText).toHaveLength(2);

    const res4 = await invokeNara(['get', '595367', '--text', '--pages', '2', '--api-key', 'k', '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(res4.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(2);
    const p4 = JSON.parse(res4.stdout) as { extractedText: { page: number }[] };
    expect(p4.extractedText[0].page).toBe(2);

    // --refresh bypasses disk cache and updates stored metadata.
    version = 2;
    const res5 = await invokeNara(['get', '595367', '--refresh', '--api-key', 'k', '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(res5.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(3);
    expect((JSON.parse(res5.stdout) as { title: string }).title).toBe('1940 Census Merced ED 24-7 v2');
  });

  it('download overlapping page ranges reuses cached objects with zero HTTP and honors --refresh', async () => {
    const baseDir = await makeTempDir('kinloom-nara-cache-');
    const cacheDir = path.join(baseDir, 'cache');
    const workDir = path.join(baseDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    const metaCalls: string[] = [];
    const objCalls: string[] = [];
    let byteVersion = 1;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/v2/records/search')) {
        metaCalls.push(url);
        return jsonResponse(sampleRecordResponse('595367', 'Census Roll 595367', { pageCount: 4 }));
      }
      objCalls.push(url);
      const pageName = url.slice(url.lastIndexOf('/') + 1);
      return new Response(`BYTES-${pageName}-v${byteVersion}`, { status: 200 });
    };

    const out1 = path.join(workDir, 'out1');
    const out2 = path.join(workDir, 'out2');
    const out3 = path.join(workDir, 'out3');
    const out4 = path.join(workDir, 'out4');

    // Cold download pages 1-3 -> 1 metadata + 3 object fetches.
    const r1 = await invokeNara(['download', '595367', '--pages', '1-3', '--out', out1, '--api-key', 'k'], {
      cacheDir,
      cwd: workDir,
      fetchImpl,
    });
    expect(r1.exitCode).toBe(0);
    expect(metaCalls).toHaveLength(1);
    expect(objCalls).toHaveLength(3);
    expect(fs.readFileSync(path.join(out1, '002_sheet_002.jpg'), 'utf8')).toBe('BYTES-sheet_002.jpg-v1');
    expect(fs.existsSync(path.join(cacheDir, 'objects', '595367', '002_sheet_002.jpg'))).toBe(true);

    // Overlapping download pages 2-4 -> 0 metadata calls, ONLY page 4 fetched over HTTP!
    const r2 = await invokeNara(['download', '595367', '--pages', '2-4', '--out', out2, '--api-key', 'k'], {
      cacheDir,
      cwd: workDir,
      fetchImpl,
    });
    expect(r2.exitCode).toBe(0);
    expect(metaCalls).toHaveLength(1);
    expect(objCalls).toHaveLength(4);
    expect(objCalls[3].endsWith('sheet_004.jpg')).toBe(true);
    expect(fs.readFileSync(path.join(out2, '002_sheet_002.jpg'), 'utf8')).toBe('BYTES-sheet_002.jpg-v1');
    expect(fs.readFileSync(path.join(out2, '004_sheet_004.jpg'), 'utf8')).toBe('BYTES-sheet_004.jpg-v1');

    // Full cache hit into a brand-new directory -> ZERO HTTP requests!
    const r3 = await invokeNara(['download', '595367', '--pages', '1-4', '--out', out3, '--api-key', 'k'], {
      cacheDir,
      cwd: workDir,
      fetchImpl,
    });
    expect(r3.exitCode).toBe(0);
    expect(metaCalls).toHaveLength(1);
    expect(objCalls).toHaveLength(4);
    expect(fs.readFileSync(path.join(out3, '001_sheet_001.jpg'), 'utf8')).toBe('BYTES-sheet_001.jpg-v1');

    // --refresh bypasses both metadata and object caches.
    byteVersion = 2;
    const r4 = await invokeNara(
      ['download', '595367', '--pages', '2', '--out', out4, '--refresh', '--api-key', 'k'],
      { cacheDir, cwd: workDir, fetchImpl }
    );
    expect(r4.exitCode).toBe(0);
    expect(metaCalls).toHaveLength(2);
    expect(objCalls).toHaveLength(5);
    expect(fs.readFileSync(path.join(out4, '002_sheet_002.jpg'), 'utf8')).toBe('BYTES-sheet_002.jpg-v2');
  });

  it('search caches by canonical SHA-256 and honors --refresh and --cache-ttl-hours 0', async () => {
    const cacheDir = await makeTempDir();
    const apiCalls: string[] = [];
    let seq = 0;

    const fetchImpl: typeof fetch = async (input) => {
      apiCalls.push(String(input));
      seq += 1;
      return jsonResponse({
        body: {
          hits: {
            total: { value: seq },
            hits: [
              {
                _source: {
                  record: {
                    naId: 1000 + seq,
                    title: `Harriet Tubman File v${seq}`,
                  },
                },
              },
            ],
          },
        },
      });
    };

    const r1 = await invokeNara(
      ['search', 'Harriet Tubman', '--rg', '15', '--online', '--api-key', 'k', '--json'],
      { cacheDir, fetchImpl }
    );
    expect(r1.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(1);
    const queryFiles = listFiles(path.join(cacheDir, '_queries'), '.json');
    expect(queryFiles).toHaveLength(1);
    expect(path.basename(queryFiles[0], '.json')).toHaveLength(64);

    // Second identical call -> ZERO HTTP requests and cache_hit: true.
    const r2 = await invokeNara(
      ['search', 'Harriet Tubman', '--rg', '15', '--online', '--api-key', 'k', '--json'],
      { cacheDir, fetchImpl }
    );
    expect(r2.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(1);
    const p1 = JSON.parse(r1.stdout) as Record<string, unknown>;
    const p2 = JSON.parse(r2.stdout) as Record<string, unknown>;
    expect(p1['cache_hit']).toBe(false);
    expect(p2['cache_hit']).toBe(true);
    const { cache_hit: _h1, ...rest1 } = p1;
    const { cache_hit: _h2, ...rest2 } = p2;
    expect(rest2).toEqual(rest1);

    // --refresh bypasses query cache.
    const r3 = await invokeNara(
      ['search', 'Harriet Tubman', '--rg', '15', '--online', '--refresh', '--api-key', 'k', '--json'],
      { cacheDir, fetchImpl }
    );
    expect(r3.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(2);
    const p3 = JSON.parse(r3.stdout) as { cache_hit: boolean; results: { naId: string }[] };
    expect(p3.cache_hit).toBe(false);
    expect(p3.results[0].naId).toBe('1002');

    // --cache-ttl-hours 0 bypasses query cache.
    const r4 = await invokeNara(
      [
        'search',
        'Harriet Tubman',
        '--rg',
        '15',
        '--online',
        '--cache-ttl-hours',
        '0',
        '--api-key',
        'k',
        '--json',
      ],
      { cacheDir, fetchImpl }
    );
    expect(r4.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(3);
    const p4 = JSON.parse(r4.stdout) as { cache_hit: boolean; results: { naId: string }[] };
    expect(p4.cache_hit).toBe(false);
    expect(p4.results[0].naId).toBe('1003');
  });

  it('validates NAIDs, sanitizes object filenames, and blocks path traversal', async () => {
    const cacheDir = await makeTempDir();
    for (const badNaid of ['../etc/passwd', '123/456', '123\\456', 'not-a-number']) {
      const res = await invokeNara(['get', badNaid, '--api-key', 'k'], { cacheDir });
      expect(res.exitCode).toBe(2);
    }

    expect(safeObjectFilename(5, '../../evil.jpg')).toBe('005_evil.jpg');
    expect(safeObjectFilename(5, '..\\win\\scan.tif')).toBe('005_scan.tif');
    expect(safeObjectFilename(5, '..')).toBe('005_5.bin');
    expect(safeObjectFilename(5, '.hidden')).toBe('005_hidden');

    for (const unsafe of ['../escape', 'a/b.jpg', 'a\\b.jpg', '..', '', 'C:evil']) {
      expect(() => resolveSafeChild(cacheDir, unsafe)).toThrow();
    }
  });
});

// ===========================================================================
// 3. 1950 Census Search Cache (4 tests)
// ===========================================================================

describe('1950 Census search cache', () => {
  function makeCensusFixture() {
    const urls: string[] = [];
    const payload = {
      total: 1,
      size: 25,
      page: 1,
      results: [
        {
          scheduleId: '1001',
          state: 'Illinois',
          abbr: 'IL',
          county: 'Sangamon',
          reservation: null,
          ed: '84-1',
          names: [{ row: 1, name: 'Lincoln Smith' }],
          image: 'https://1950census.archives.gov/example.jpg',
          maps: '1',
          transcribe: [],
          highlight: { 'transcribe.name': 'Lincoln' },
          iiifUrl: 'https://1950census.archives.gov/iiif/example',
        },
      ],
    };
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse(structuredClone(payload));
    };
    return { urls, payload, fetchImpl };
  }

  it('repeat search hits disk cache and honors --refresh and --cache-ttl-hours 0', async () => {
    const cacheDir = await makeTempDir();
    const { urls, fetchImpl } = makeCensusFixture();
    const args = ['census1950', '--state', 'Illinois', '--name', 'Lincoln', '--json'];

    const first = await invokeNara(args, { cacheDir, fetchImpl });
    expect(first.exitCode).toBe(0);
    const firstBody = JSON.parse(first.stdout) as {
      cache_hit: boolean;
      results: { scheduleId: string; names: { name: string }[] }[];
    };
    expect(firstBody.cache_hit).toBe(false);
    expect(firstBody.results[0].names[0].name).toBe('Lincoln Smith');
    expect(firstBody.results[0].scheduleId).toBe('1001');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('state=IL');
    expect(urls[0]).toContain('name=Lincoln');
    expect(urls[0]).toContain('size=25');
    expect(urls[0].startsWith('https://1950census.archives.gov/api/search?')).toBe(true);
    const cachedFiles = listFiles(path.join(cacheDir, 'census1950'), '.json');
    expect(cachedFiles).toHaveLength(1);
    expect(path.basename(cachedFiles[0], '.json')).toHaveLength(64);

    const second = await invokeNara(args, { cacheDir, fetchImpl });
    expect(second.exitCode).toBe(0);
    const secondBody = JSON.parse(second.stdout) as {
      cache_hit: boolean;
      results: unknown[];
    };
    expect(secondBody.cache_hit).toBe(true);
    expect(secondBody.results).toEqual(firstBody.results);
    expect(urls).toHaveLength(1);

    const refreshed = await invokeNara([...args, '--refresh'], { cacheDir, fetchImpl });
    expect(refreshed.exitCode).toBe(0);
    const refreshedBody = JSON.parse(refreshed.stdout) as {
      cache_hit: boolean;
      results: { scheduleId: string }[];
    };
    expect(refreshedBody.cache_hit).toBe(false);
    expect(refreshedBody.results[0].scheduleId).toBe('1001');
    expect(urls).toHaveLength(2);

    const expired = await invokeNara([...args, '--cache-ttl-hours', '0'], { cacheDir, fetchImpl });
    expect(expired.exitCode).toBe(0);
    expect((JSON.parse(expired.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(urls).toHaveLength(3);
  });

  it('rejects missing filters, unknown state, and traversal without making requests', async () => {
    const cacheDir = await makeTempDir();
    const { urls, fetchImpl } = makeCensusFixture();

    const missing = await invokeNara(['census1950', '--json'], { cacheDir, fetchImpl });
    expect(missing.exitCode).toBe(2);
    const badState = await invokeNara(['census1950', '--state', 'Atlantis', '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(badState.exitCode).toBe(2);
    const traversal = await invokeNara(['census1950', '--state', 'IL', '--county', '../secret', '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(traversal.exitCode).toBe(2);
    expect(urls).toEqual([]);
    expect(listFilesRecursive(cacheDir).filter((p) => p.endsWith('.json'))).toEqual([]);
  });

  it('selects API page, keeps page 1 cache key, and rejects page 0', async () => {
    const cacheDir = await makeTempDir();
    const { urls, payload, fetchImpl } = makeCensusFixture();
    const base = ['census1950', '--state', 'IL', '--name', 'Lincoln', '--json'];

    const first = await invokeNara(base, { cacheDir, fetchImpl });
    expect(first.exitCode).toBe(0);
    expect(urls[0]).toContain('page=1');
    const pageOneFiles = listFiles(path.join(cacheDir, 'census1950'), '.json');
    expect(pageOneFiles).toHaveLength(1);
    const pageOneName = path.basename(pageOneFiles[0]);

    const explicit = await invokeNara([...base, '--page', '1'], { cacheDir, fetchImpl });
    expect(explicit.exitCode).toBe(0);
    expect((JSON.parse(explicit.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(urls).toHaveLength(1);
    expect(listFiles(path.join(cacheDir, 'census1950'), '.json').map((p) => path.basename(p))).toEqual([
      pageOneName,
    ]);

    payload.page = 2;
    payload.results[0].scheduleId = '2002';
    const second = await invokeNara([...base, '--page', '2'], { cacheDir, fetchImpl });
    expect(second.exitCode).toBe(0);
    const body = JSON.parse(second.stdout) as {
      cache_hit: boolean;
      results: { scheduleId: string }[];
    };
    expect(body.cache_hit).toBe(false);
    expect(body.results[0].scheduleId).toBe('2002');
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('page=2');
    expect(urls[1]).not.toContain('page=1');
    const cachedNames = listFiles(path.join(cacheDir, 'census1950'), '.json').map((p) => path.basename(p));
    expect(cachedNames).toHaveLength(2);
    expect(cachedNames).toContain(pageOneName);

    const rejected = await invokeNara([...base, '--page', '0'], { cacheDir, fetchImpl });
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr).toContain('must be >= 1');
    expect(urls).toHaveLength(2);
  });

  it('text line includes image path and JSON stays the API row', async () => {
    const cacheDir = await makeTempDir();
    const { urls, payload, fetchImpl } = makeCensusFixture();
    payload.results[0].image = LINCOLN_ED_IMAGE;

    const text = await invokeNara(['census1950', '--state', 'IL', '--name', 'Lincoln'], {
      cacheDir,
      fetchImpl,
    });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(`image ${LINCOLN_ED_IMAGE}`);

    const asJson = await invokeNara(['census1950', '--state', 'IL', '--name', 'Lincoln', '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(asJson.exitCode).toBe(0);
    const body = JSON.parse(asJson.stdout) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(['cache_hit', 'page', 'results', 'size', 'total']);
    expect((body['results'] as unknown[])[0]).toEqual(payload.results[0]);
    expect(body['cache_hit']).toBe(true);
    expect(urls).toHaveLength(1);
  });
});

// ===========================================================================
// 4. 1950 Census IIIF Images (14 tests)
// ===========================================================================

describe('1950 Census IIIF images', () => {
  function makeImageFixture() {
    const urls: string[] = [];
    const bodies: Record<string, Buffer> = {
      full: JPEG_FULL,
      '2400': JPEG_PREVIEW,
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/full/2400,/0/default.jpg')) {
        return new Response(bodies['2400'], {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      if (url.includes('/full/full/0/default.jpg')) {
        return new Response(bodies['full'], {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      throw new Error(`unexpected image url: ${url}`);
    };
    return { urls, bodies, fetchImpl };
  }

  function cachedJpegs(cacheDir: string): string[] {
    return listFiles(path.join(cacheDir, 'census1950-images'), '.jpg');
  }

  it('image path miss then hit makes one request', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const { urls, fetchImpl } = makeImageFixture();
    const args = ['census1950-image', LINCOLN_ED_IMAGE, '--out', outDir, '--json'];

    const first = await invokeNara(args, { cacheDir, fetchImpl });
    expect(first.exitCode).toBe(0);
    const firstBody = JSON.parse(first.stdout) as {
      cache_hit: boolean;
      image: string;
      width: number | null;
      bytes: number;
      path: string;
      url: string;
    };
    const dest = path.join(outDir, '43290879-Illinois-087558-0002.jpg');
    expect(firstBody.cache_hit).toBe(false);
    expect(firstBody.image).toBe(LINCOLN_ED_IMAGE);
    expect(firstBody.width).toBeNull();
    expect(firstBody.bytes).toBe(JPEG_FULL.length);
    expect(firstBody.path).toBe(dest);
    expect(firstBody.url).toBe(
      'https://1950census.archives.gov/iiif/2/' +
        '1950census%2F43290879-Illinois%2F43290879-Illinois-087558%2F' +
        '43290879-Illinois-087558-0002.jpg/full/full/0/default.jpg'
    );
    expect(fs.readFileSync(dest).equals(JPEG_FULL)).toBe(true);
    expect(urls).toHaveLength(1);
    expect(cachedJpegs(cacheDir)).toHaveLength(1);
    expect(fs.readFileSync(cachedJpegs(cacheDir)[0]).equals(JPEG_FULL)).toBe(true);

    const second = await invokeNara(args, { cacheDir, fetchImpl });
    expect(second.exitCode).toBe(0);
    const secondBody = JSON.parse(second.stdout) as { cache_hit: boolean; bytes: number };
    expect(secondBody.cache_hit).toBe(true);
    expect(secondBody.bytes).toBe(JPEG_FULL.length);
    expect(fs.readFileSync(dest).equals(JPEG_FULL)).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it('info.json URL uses the same cache entry as the image path', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const { urls, fetchImpl } = makeImageFixture();

    const byPath = await invokeNara(['census1950-image', LINCOLN_ED_IMAGE, '--out', outDir, '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(byPath.exitCode).toBe(0);

    const byUrl = await invokeNara(['census1950-image', LINCOLN_ED_INFO, '--out', outDir, '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(byUrl.exitCode).toBe(0);
    const body = JSON.parse(byUrl.stdout) as { cache_hit: boolean; image: string; url: string };
    expect(body.cache_hit).toBe(true);
    expect(body.image).toBe(LINCOLN_ED_IMAGE);
    expect(body.url).toBe((JSON.parse(byPath.stdout) as { url: string }).url);
    expect(urls).toHaveLength(1);
    expect(cachedJpegs(cacheDir)).toHaveLength(1);
  });

  it('--width selects IIIF size and uses a distinct cache file', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const { urls, fetchImpl } = makeImageFixture();

    const full = await invokeNara(['census1950-image', LINCOLN_ED_IMAGE, '--out', outDir, '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(full.exitCode).toBe(0);

    const previewPath = path.join(outDir, 'preview.jpg');
    const preview = await invokeNara(
      ['census1950-image', LINCOLN_ED_IMAGE, '--width', '2400', '--out', previewPath, '--json'],
      { cacheDir, fetchImpl }
    );
    expect(preview.exitCode).toBe(0);
    const body = JSON.parse(preview.stdout) as {
      cache_hit: boolean;
      width: number;
      bytes: number;
      path: string;
      url: string;
    };
    expect(body.cache_hit).toBe(false);
    expect(body.width).toBe(2400);
    expect(body.bytes).toBe(JPEG_PREVIEW.length);
    expect(body.path).toBe(previewPath);
    expect(body.url).toContain('/full/2400,/0/default.jpg');
    expect(urls[1]).toBe(body.url);
    expect(fs.readFileSync(previewPath).equals(JPEG_PREVIEW)).toBe(true);

    const cached = cachedJpegs(cacheDir);
    expect(cached).toHaveLength(2);
    const cachedContents = new Set(cached.map((p) => fs.readFileSync(p).toString('hex')));
    expect(cachedContents).toEqual(new Set([JPEG_FULL.toString('hex'), JPEG_PREVIEW.toString('hex')]));

    const again = await invokeNara(
      ['census1950-image', LINCOLN_ED_IMAGE, '--width', '2400', '--out', previewPath, '--json'],
      { cacheDir, fetchImpl }
    );
    expect((JSON.parse(again.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(urls).toHaveLength(2);
  });

  it('--refresh and --cache-ttl-hours 0 replace the cached JPEG', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const { urls, bodies, fetchImpl } = makeImageFixture();
    const pagePath = path.join(outDir, 'page.jpg');
    const args = ['census1950-image', LINCOLN_ED_IMAGE, '--out', pagePath, '--json'];

    const first = await invokeNara(args, { cacheDir, fetchImpl });
    expect(first.exitCode).toBe(0);
    expect((JSON.parse(first.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    bodies['full'] = JPEG_REFRESHED;
    const refreshed = await invokeNara([...args, '--refresh'], { cacheDir, fetchImpl });
    expect(refreshed.exitCode).toBe(0);
    const body = JSON.parse(refreshed.stdout) as { cache_hit: boolean; bytes: number };
    expect(body.cache_hit).toBe(false);
    expect(body.bytes).toBe(JPEG_REFRESHED.length);
    expect(fs.readFileSync(pagePath).equals(JPEG_REFRESHED)).toBe(true);
    expect(fs.readFileSync(cachedJpegs(cacheDir)[0]).equals(JPEG_REFRESHED)).toBe(true);
    expect(urls).toHaveLength(2);
    expect(cachedJpegs(cacheDir)).toHaveLength(1);

    const skipped = await invokeNara([...args, '--cache-ttl-hours', '0'], { cacheDir, fetchImpl });
    expect((JSON.parse(skipped.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(urls).toHaveLength(3);
  });

  it('rejects traversal, other hosts, and width 0 without making a request', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const { urls, fetchImpl } = makeImageFixture();

    const rejected = [
      '1950census/../secret.jpg',
      '1950census/ed/../../secret.jpg',
      'https://evil.example/iiif/2/1950census%2Fpage.jpg/info.json',
      'http://1950census.archives.gov/iiif/2/1950census%2Fpage.jpg/info.json',
      'https://user@1950census.archives.gov/iiif/2/1950census%2Fpage.jpg/info.json',
      'https://1950census.archives.gov/iiif/2/1950census%2F..%2Fsecret.jpg/info.json',
      'https://1950census.archives.gov/not-iiif/page.jpg',
    ];
    for (const raw of rejected) {
      const result = await invokeNara(['census1950-image', raw, '--out', outDir, '--json'], {
        cacheDir,
        fetchImpl,
      });
      expect(result.exitCode).toBe(2);
    }
    expect(urls).toEqual([]);
    expect(cachedJpegs(cacheDir)).toEqual([]);

    const width = await invokeNara(['census1950-image', LINCOLN_ED_IMAGE, '--width', '0', '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(width.exitCode).toBe(2);
    expect(urls).toEqual([]);
  });

  it('HTML and non-JPEG payloads are not cached or written to output', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const { fetchImpl } = makeImageFixture();

    const ok = await invokeNara(['census1950-image', LINCOLN_ED_IMAGE, '--out', outDir, '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(ok.exitCode).toBe(0);

    const badFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/full/800,/0/default.jpg')) {
        return new Response(Buffer.from('GIF89a-not-a-jpeg'), {
          status: 200,
          headers: { 'content-type': 'image/gif' },
        });
      }
      return new Response('<html><body>error page</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };

    const htmlResult = await invokeNara(
      [
        'census1950-image',
        LINCOLN_ED_IMAGE,
        '--width',
        '400',
        '--refresh',
        '--out',
        path.join(outDir, 'bad.jpg'),
        '--json',
      ],
      { cacheDir, fetchImpl: badFetch }
    );
    const gifResult = await invokeNara(
      [
        'census1950-image',
        LINCOLN_ED_IMAGE,
        '--width',
        '800',
        '--out',
        path.join(outDir, 'gif.jpg'),
        '--json',
      ],
      { cacheDir, fetchImpl: badFetch }
    );

    expect(htmlResult.exitCode).toBe(1);
    expect(gifResult.exitCode).toBe(1);
    expect(htmlResult.stderr).toContain('not a JPEG');
    expect(gifResult.stderr).toContain('not a JPEG');
    expect(fs.existsSync(path.join(outDir, 'bad.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'gif.jpg'))).toBe(false);

    const cached = cachedJpegs(cacheDir);
    expect(cached).toHaveLength(1);
    expect(fs.readFileSync(cached[0]).equals(JPEG_FULL)).toBe(true);
    for (const p of listFilesRecursive(cacheDir)) {
      if (!p.endsWith('.lock')) {
        const bytes = fs.readFileSync(p);
        expect(bytes.subarray(0, 5).toString('utf8')).not.toBe('<html');
        expect(bytes.subarray(0, 6).toString('utf8')).not.toBe('GIF89a');
      }
    }
  });

  it('census1950FetchJpeg rejects HTML responses and HTTP 404 errors', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/missing.jpg')) {
        return new Response('missing', { status: 404 });
      }
      return new Response('<!doctype html><title>blocked</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    };

    const ctx = { fetchImpl, sleepFn: async () => {}, nowMs: () => Date.now() };
    await expect(
      census1950FetchJpeg('https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg', ctx)
    ).rejects.toThrow(/not a JPEG/);
    await expect(
      census1950FetchJpeg('https://1950census.archives.gov/iiif/2/missing.jpg', ctx)
    ).rejects.toBeInstanceOf(HttpStatusError);
  });

  it('transient 503 retries then returns JPEG honoring Retry-After cap', async () => {
    let calls = 0;
    const slept: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('busy', { status: 503, headers: { 'Retry-After': '12' } });
      }
      return new Response(JPEG_FULL, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };

    const data = await census1950FetchJpeg(
      'https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg',
      {
        fetchImpl,
        sleepFn: async (ms) => {
          slept.push(ms);
        },
        nowMs: () => Date.now(),
      }
    );
    expect(data.equals(JPEG_FULL)).toBe(true);
    expect(calls).toBe(2);
    expect(slept).toEqual([5000]);
  });

  it('timeout retries then returns JPEG', async () => {
    let calls = 0;
    const slept: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('ReadTimeout: slow');
      }
      return new Response(JPEG_PREVIEW, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };

    const data = await census1950FetchJpeg(
      'https://1950census.archives.gov/iiif/2/x/full/2400,/0/default.jpg',
      {
        fetchImpl,
        sleepFn: async (ms) => {
          slept.push(ms);
        },
        nowMs: () => Date.now(),
      }
    );
    expect(data.equals(JPEG_PREVIEW)).toBe(true);
    expect(calls).toBe(2);
    expect(slept).toEqual([250]);
  });

  it('permanent 4xx and exhausted 503 do not keep retrying', async () => {
    for (const status of [400, 403, 404]) {
      let calls = 0;
      const slept: number[] = [];
      const fetchImpl: typeof fetch = async () => {
        calls += 1;
        return new Response('no', { status });
      };
      await expect(
        census1950FetchJpeg('https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg', {
          fetchImpl,
          sleepFn: async (ms) => {
            slept.push(ms);
          },
          nowMs: () => Date.now(),
        })
      ).rejects.toBeInstanceOf(HttpStatusError);
      expect(calls).toBe(1);
      expect(slept).toEqual([]);
    }

    let exhausted = 0;
    const slept: number[] = [];
    const always503: typeof fetch = async () => {
      exhausted += 1;
      return new Response('busy', { status: 503 });
    };
    let caught: unknown;
    try {
      await census1950FetchJpeg('https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg', {
        fetchImpl: always503,
        sleepFn: async (ms) => {
          slept.push(ms);
        },
        nowMs: () => Date.now(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    expect((caught as HttpStatusError).status).toBe(503);
    expect(exhausted).toBe(3);
    expect(slept).toEqual([250, 500]);
  });

  it('failed fetch does not write cache or output', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const fetchImpl: typeof fetch = async () => new Response('missing', { status: 404 });

    const result = await invokeNara(['census1950-image', LINCOLN_ED_IMAGE, '--out', outDir, '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(result.exitCode).toBe(1);
    expect(cachedJpegs(cacheDir)).toEqual([]);
    expect(fs.existsSync(path.join(outDir, '43290879-Illinois-087558-0002.jpg'))).toBe(false);
  });

  it('batch rejects .jpg --out, bad paths, and >25 images before download', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const { urls, fetchImpl } = makeImageFixture();

    const jpgOut = path.join(outDir, 'batch.jpg');
    const rejected = await invokeNara(
      ['census1950-image', LINCOLN_ED_IMAGE, censusSheet(3), '--out', jpgOut, '--json'],
      { cacheDir, fetchImpl }
    );
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr.toLowerCase()).toContain('directory');
    expect(fs.existsSync(jpgOut)).toBe(false);
    expect(urls).toEqual([]);
    expect(cachedJpegs(cacheDir)).toEqual([]);

    const invalid = await invokeNara(
      ['census1950-image', LINCOLN_ED_IMAGE, '1950census/../secret.jpg', '--out', outDir, '--json'],
      { cacheDir, fetchImpl }
    );
    expect(invalid.exitCode).toBe(2);
    expect(urls).toEqual([]);

    const tooMany = await invokeNara(
      ['census1950-image', ...Array.from({ length: 26 }, (_v, idx) => censusSheet(idx + 1)), '--out', outDir],
      { cacheDir, fetchImpl }
    );
    expect(tooMany.exitCode).toBe(2);
    expect(tooMany.stderr).toContain('25');
    expect(urls).toEqual([]);
    expect(cachedJpegs(cacheDir)).toEqual([]);
  });

  it('batch downloads overlap, preserve order, and then hit cache', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });

    const slow = censusSheet(4);
    const fast = censusSheet(3);
    const slowBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('sheet-0004')]);
    const fastBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('sheet-0003')]);
    const slowName = path.basename(slow);
    const fastName = path.basename(fast);

    let arrived = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let releaseFastRecorded!: () => void;
    const fastRecorded = new Promise<void>((resolve) => {
      releaseFastRecorded = resolve;
    });
    const order: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      arrived += 1;
      if (arrived >= 2) {
        releaseBarrier();
      }
      await barrier;
      let body: Buffer;
      if (url.includes(slowName)) {
        await fastRecorded;
        body = slowBytes;
      } else if (url.includes(fastName)) {
        body = fastBytes;
      } else {
        throw new Error(`Unexpected URL: ${url}`);
      }
      order.push(url);
      if (url.includes(fastName)) {
        releaseFastRecorded();
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };

    const args = ['census1950-image', slow, fast, '--out', outDir, '--json'];
    const first = await invokeNara(args, { cacheDir, fetchImpl });
    expect(first.exitCode).toBe(0);
    const body = JSON.parse(first.stdout) as {
      count: number;
      cache_hit: boolean;
      files: { image: string; cache_hit: boolean; bytes: number }[];
    };
    expect(body.count).toBe(2);
    expect(body.cache_hit).toBe(false);
    expect(body.files.map((item) => item.image)).toEqual([slow, fast]);
    expect(body.files.map((item) => item.cache_hit)).toEqual([false, false]);
    expect(body.files[0].bytes).toBe(slowBytes.length);
    expect(body.files[1].bytes).toBe(fastBytes.length);
    expect(fs.readFileSync(path.join(outDir, slowName)).equals(slowBytes)).toBe(true);
    expect(fs.readFileSync(path.join(outDir, fastName)).equals(fastBytes)).toBe(true);
    expect(order[0]).toContain('0003');
    expect(order[1]).toContain('0004');

    const second = await invokeNara(args, { cacheDir, fetchImpl });
    expect(second.exitCode).toBe(0);
    const again = JSON.parse(second.stdout) as {
      cache_hit: boolean;
      files: { image: string; cache_hit: boolean }[];
    };
    expect(again.cache_hit).toBe(true);
    expect(again.files.map((item) => item.cache_hit)).toEqual([true, true]);
    expect(again.files.map((item) => item.image)).toEqual([slow, fast]);
    expect(order).toHaveLength(2);
  });

  it('batch cache_hit is false when any sheet is downloaded', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const { urls, fetchImpl } = makeImageFixture();

    const cachedSheet = censusSheet(3);
    const freshSheet = censusSheet(5);
    const first = await invokeNara(['census1950-image', cachedSheet, '--out', outDir, '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(first.exitCode).toBe(0);
    expect((JSON.parse(first.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    const mixed = await invokeNara(['census1950-image', freshSheet, cachedSheet, '--out', outDir, '--json'], {
      cacheDir,
      fetchImpl,
    });
    expect(mixed.exitCode).toBe(0);
    const body = JSON.parse(mixed.stdout) as {
      count: number;
      cache_hit: boolean;
      files: { image: string; cache_hit: boolean }[];
    };
    expect(body.count).toBe(2);
    expect(body.cache_hit).toBe(false);
    expect(body.files.map((item) => item.image)).toEqual([freshSheet, cachedSheet]);
    expect(body.files.map((item) => item.cache_hit)).toEqual([false, true]);
    expect(urls).toHaveLength(2);
  });
});

// ===========================================================================
// 5. Download Hardening & Telemetry (6 tests)
// ===========================================================================

describe('NARA download hardening and telemetry', () => {
  it('get emits boolean cache_hit in JSON mode across miss, hit, and refresh', async () => {
    const cacheDir = await makeTempDir();
    const apiCalls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      apiCalls.push(String(input));
      return jsonResponse(sampleRecordResponse('595367', 'Census Roll', { pageCount: 2 }));
    };

    const r1 = await invokeNara(['get', '595367', '--api-key', 'k', '--json'], {
      cacheDir,
      fetchImpl,
    });
    const r2 = await invokeNara(['get', '595367', '--api-key', 'k', '--json'], {
      cacheDir,
      fetchImpl,
    });
    const r3 = await invokeNara(['get', '595367', '--refresh', '--api-key', 'k', '--json'], {
      cacheDir,
      fetchImpl,
    });

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(apiCalls).toHaveLength(2);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect((JSON.parse(r3.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r3.cacheHit).toBe(false);
  });

  it('direct URL download caches atomically, emits JSON, and honors --refresh', async () => {
    const baseDir = await makeTempDir();
    const cacheDir = path.join(baseDir, 'cache');
    const workDir = path.join(baseDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    const url = 'https://s3.amazonaws.com/NARAprodstorage/opastorage/live/12/34/sheet_001.jpg';
    const calls: string[] = [];
    let version = 1;

    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`scan-v${version}`)]);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) },
      });
    };

    const out1 = path.join(workDir, 'first.jpg');
    const out2 = path.join(workDir, 'second.jpg');
    const out3 = path.join(workDir, 'third.jpg');
    const expectedV1 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('scan-v1')]);
    const expectedV2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('scan-v2')]);

    const r1 = await invokeNara(['download', url, '--out', out1, '--json'], {
      cacheDir,
      cwd: workDir,
      fetchImpl,
    });
    expect(r1.exitCode).toBe(0);
    const p1 = JSON.parse(r1.stdout) as {
      cache_hit: boolean;
      url: string;
      path: string;
      content_type: string;
      bytes: number;
    };
    expect(p1.cache_hit).toBe(false);
    expect(p1.url).toBe(url);
    expect(p1.path).toBe(out1);
    expect(p1.content_type).toBe('image/jpeg');
    expect(p1.bytes).toBe(expectedV1.length);
    expect(fs.readFileSync(out1).equals(expectedV1)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(listFiles(path.join(cacheDir, 'downloads'), '.bin')).toHaveLength(1);

    const r2 = await invokeNara(['download', url, '--out', out2, '--json'], {
      cacheDir,
      cwd: workDir,
      fetchImpl,
    });
    expect(r2.exitCode).toBe(0);
    const p2 = JSON.parse(r2.stdout) as {
      cache_hit: boolean;
      content_type: string;
      bytes: number;
    };
    expect(p2.cache_hit).toBe(true);
    expect(p2.content_type).toBe('image/jpeg');
    expect(p2.bytes).toBe(expectedV1.length);
    expect(fs.readFileSync(out2).equals(expectedV1)).toBe(true);
    expect(calls).toHaveLength(1);

    version = 2;
    const r3 = await invokeNara(['download', url, '--out', out3, '--refresh', '--json'], {
      cacheDir,
      cwd: workDir,
      fetchImpl,
    });
    expect(r3.exitCode).toBe(0);
    const p3 = JSON.parse(r3.stdout) as { cache_hit: boolean };
    expect(p3.cache_hit).toBe(false);
    expect(fs.readFileSync(out3).equals(expectedV2)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('NAID download JSON reports cache_hit and accepts catalog record URL', async () => {
    const baseDir = await makeTempDir();
    const cacheDir = path.join(baseDir, 'cache');
    const workDir = path.join(baseDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    const metaCalls: string[] = [];
    const objCalls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/v2/records/search')) {
        metaCalls.push(url);
        return jsonResponse(sampleRecordResponse('595367', 'Census Roll', { pageCount: 2 }));
      }
      objCalls.push(url);
      return new Response(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('valid-jpeg')]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    };

    const out1 = path.join(workDir, 'naid1');
    const out2 = path.join(workDir, 'naid2');

    const r1 = await invokeNara(
      [
        'download',
        'https://catalog.archives.gov/id/595367',
        '--pages',
        '1',
        '--out',
        out1,
        '--api-key',
        'k',
        '--json',
      ],
      { cacheDir, cwd: workDir, fetchImpl }
    );
    expect(r1.exitCode).toBe(0);
    const p1 = JSON.parse(r1.stdout) as {
      naId: string;
      cache_hit: boolean;
      metadata_cache_hit: boolean;
      content_type: string;
      count: number;
      files: { cache_hit: boolean }[];
    };
    expect(p1.naId).toBe('595367');
    expect(p1.cache_hit).toBe(false);
    expect(p1.metadata_cache_hit).toBe(false);
    expect(p1.content_type).toBe('image/jpeg');
    expect(p1.count).toBe(1);
    expect(p1.files[0].cache_hit).toBe(false);

    const r2 = await invokeNara(
      ['download', '595367', '--pages', '1', '--out', out2, '--api-key', 'k', '--json'],
      { cacheDir, cwd: workDir, fetchImpl }
    );
    expect(r2.exitCode).toBe(0);
    const p2 = JSON.parse(r2.stdout) as {
      cache_hit: boolean;
      metadata_cache_hit: boolean;
      files: { cache_hit: boolean }[];
    };
    expect(p2.cache_hit).toBe(true);
    expect(p2.metadata_cache_hit).toBe(true);
    expect(p2.files[0].cache_hit).toBe(true);
    expect(metaCalls).toHaveLength(1);
    expect(objCalls).toHaveLength(1);
  });

  it('download retries on 429, 503, timeout, protocol error, and incomplete body', async () => {
    const baseDir = await makeTempDir();
    const cacheDir = path.join(baseDir, 'cache');
    const workDir = path.join(baseDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    const url = 'https://s3.amazonaws.com/NARAprodstorage/opastorage/live/retry.pdf';
    const pdfBytes = Buffer.from('%PDF-1.4\nvalid-pdf-body');

    type StepOutcome = () => Response | never;
    const cases: readonly {
      readonly label: string;
      readonly steps: readonly StepOutcome[];
      readonly expectedSleeps?: readonly number[];
    }[] = [
      {
        label: '429',
        steps: [
          () => new Response('slow down', { status: 429, headers: { 'Retry-After': '4' } }),
          () => new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } }),
        ],
        expectedSleeps: [4000],
      },
      {
        label: '503',
        steps: [
          () => new Response('busy', { status: 503 }),
          () => new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } }),
        ],
      },
      {
        label: 'timeout',
        steps: [
          () => {
            throw new Error('ReadTimeout: timed out');
          },
          () => new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } }),
        ],
      },
      {
        label: 'protocol',
        steps: [
          () => {
            throw new Error('RemoteProtocolError: peer reset');
          },
          () => new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } }),
        ],
      },
      {
        label: 'incomplete',
        steps: [
          () =>
            new Response(Buffer.from('%PDF-1.4\ntrunc'), {
              status: 200,
              headers: { 'content-type': 'application/pdf', 'content-length': '200' },
            }),
          () =>
            new Response(pdfBytes, {
              status: 200,
              headers: { 'content-type': 'application/pdf', 'content-length': String(pdfBytes.length) },
            }),
        ],
      },
    ];

    for (const c of cases) {
      let attempts = 0;
      const sleeps: number[] = [];
      const fetchImpl: typeof fetch = async () => {
        const step = c.steps[attempts];
        attempts += 1;
        return step();
      };
      const dest = path.join(workDir, `retry_${c.label}.pdf`);
      const res = await invokeNara(['download', url, '--out', dest, '--refresh', '--json'], {
        cacheDir,
        cwd: workDir,
        fetchImpl,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(res.exitCode).toBe(0);
      expect(attempts).toBe(2);
      expect(fs.readFileSync(dest).equals(pdfBytes)).toBe(true);
      if (c.expectedSleeps) {
        expect(sleeps).toEqual(c.expectedSleeps);
      } else {
        expect(sleeps).toHaveLength(1);
      }
    }
  });

  it('apiGetJson retries transient 503 and timeout', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('unavailable', { status: 503, headers: { 'Retry-After': '2' } });
      }
      if (attempts === 2) {
        throw new Error('ReadTimeout: slow api');
      }
      return jsonResponse({ body: { hits: { total: 1, hits: [] } } });
    };

    const data = await apiGetJson('https://catalog.archives.gov/api/v2/records/search?q=Lincoln', 'k', {
      fetchImpl,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      nowMs: () => Date.now(),
    });
    expect(attempts).toBe(3);
    expect(sleeps[0]).toBe(2000);
    const body = data['body'] as { hits: { total: number } };
    expect(body.hits.total).toBe(1);
  });

  it('download refuses HTML error pages, disallowed hosts, and traversal', async () => {
    const baseDir = await makeTempDir();
    const cacheDir = path.join(baseDir, 'cache');
    const workDir = path.join(baseDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    const badUrls = [
      'https://evil.example/NARAprodstorage/page.jpg',
      'http://s3.amazonaws.com/NARAprodstorage/page.jpg',
      'https://s3.amazonaws.com/unrelated-bucket/page.jpg',
      'https://user@catalog.archives.gov/file.pdf',
    ];
    for (const badUrl of badUrls) {
      const target = path.join(workDir, 'x.jpg');
      const res = await invokeNara(['download', badUrl, '--out', target, '--json'], {
        cacheDir,
        cwd: workDir,
      });
      expect(res.exitCode).toBe(1);
      expect(fs.existsSync(target)).toBe(false);
    }

    const traversal = await invokeNara(
      [
        'download',
        'https://s3.amazonaws.com/NARAprodstorage/mock/page.jpg',
        '--out',
        '../escape.jpg',
        '--json',
      ],
      {
        cacheDir,
        cwd: workDir,
        fetchImpl: async () =>
          new Response(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('ok')]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
      }
    );
    expect(traversal.exitCode).toBe(1);

    const htmlFetch: typeof fetch = async () =>
      new Response('<!doctype html><html><body>Access Denied</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });

    const outPdf = path.join(workDir, 'bad.pdf');
    const outJpg = path.join(workDir, 'bad.jpg');

    const rPdf = await invokeNara(
      ['download', 'https://s3.amazonaws.com/NARAprodstorage/mock/doc.pdf', '--out', outPdf, '--json'],
      { cacheDir, cwd: workDir, fetchImpl: htmlFetch }
    );
    const rJpg = await invokeNara(
      ['download', 'https://s3.amazonaws.com/NARAprodstorage/mock/scan.jpg', '--out', outJpg, '--json'],
      { cacheDir, cwd: workDir, fetchImpl: htmlFetch }
    );

    expect(rPdf.exitCode).toBe(1);
    expect(rJpg.exitCode).toBe(1);
    expect(rPdf.stderr).toContain('HTML');
    expect(rJpg.stderr).toContain('HTML');
    expect(fs.existsSync(outPdf)).toBe(false);
    expect(fs.existsSync(outJpg)).toBe(false);
    // Clear downloads cache check for the fresh HTML calls (note traversal test cached one bin)
    const cachedBins = listFiles(path.join(cacheDir, 'downloads'), '.bin');
    for (const binPath of cachedBins) {
      expect(fs.readFileSync(binPath, 'utf8')).not.toContain('Access Denied');
    }
  });
});

// ===========================================================================
// 6. Wave 38 Reliability & Aliases (5 tests)
// ===========================================================================

describe('1950 Census Wave 38 reliability and aliases', () => {
  it('census1950-image URL normalization, aliases, .jpeg output, and pre-HTTP validation', async () => {
    const baseDir = await makeTempDir();
    const cacheDir = path.join(baseDir, 'cache');
    const outDir = path.join(baseDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });

    const encoded =
      '1950census%2F43290879-Illinois%2F43290879-Illinois-087558%2F' + '43290879-Illinois-087558-0002.jpg';
    const variants = [
      `/${LINCOLN_ED_IMAGE}`,
      encoded,
      `https://1950census.archives.gov/iiif/2/${encoded}`,
      `https://1950census.archives.gov/iiif/2/${encoded}/`,
      `HTTPS://1950CENSUS.ARCHIVES.GOV/iiif/2/${encoded}/full/1200,/0/default.jpg`,
      `https://1950census.archives.gov/iiif/2/${LINCOLN_ED_IMAGE}/info.json`,
    ];
    for (const raw of variants) {
      expect(parseCensus1950ImageSource(raw)).toBe(LINCOLN_ED_IMAGE);
    }

    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const body = url.includes('/full/1800,/0/default.jpg') ? JPEG_PREVIEW : JPEG_FULL;
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };

    const r1 = await invokeNara(
      [
        'census1950-image',
        `https://1950census.archives.gov/iiif/2/${encoded}`,
        '--out-dir',
        outDir,
        '--max-width',
        '1800',
        '--timeout',
        '20',
        '--json',
      ],
      { cacheDir, cwd: outDir, fetchImpl }
    );
    expect(r1.exitCode).toBe(0);
    const p1 = JSON.parse(r1.stdout) as { cache_hit: boolean; width: number; image: string };
    expect(p1.cache_hit).toBe(false);
    expect(p1.width).toBe(1800);
    expect(p1.image).toBe(LINCOLN_ED_IMAGE);
    expect(calls).toHaveLength(1);

    // Second call with leading slash and .jpeg target reuses cache with zero HTTP calls.
    const jpegDest = path.join(outDir, 'sheet.jpeg');
    const r2 = await invokeNara(
      ['census1950-image', `/${LINCOLN_ED_IMAGE}`, '-o', jpegDest, '--width', '1800', '--json'],
      { cacheDir, cwd: outDir, fetchImpl }
    );
    expect(r2.exitCode).toBe(0);
    const p2 = JSON.parse(r2.stdout) as { cache_hit: boolean; path: string };
    expect(p2.cache_hit).toBe(true);
    expect(p2.path).toBe(jpegDest);
    expect(fs.readFileSync(jpegDest).equals(JPEG_PREVIEW)).toBe(true);
    expect(calls).toHaveLength(1);

    // Relative traversal in --out and non-positive --timeout fail before HTTP.
    const badOut = await invokeNara(['census1950-image', LINCOLN_ED_IMAGE, '--out', '../escape.jpg'], {
      cacheDir,
      cwd: outDir,
      fetchImpl,
    });
    expect(badOut.exitCode).toBe(1);
    const badTimeout = await invokeNara(['census1950-image', LINCOLN_ED_IMAGE, '--timeout', '0'], {
      cacheDir,
      cwd: outDir,
      fetchImpl,
    });
    expect(badTimeout.exitCode).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it('census1950-image retries 522 with HTTP-date Retry-After and truncated stream', async () => {
    const fixedNow = Date.UTC(2026, 10, 26, 12, 0, 0);
    const futureDate = new Date(fixedNow + 2000).toUTCString();
    let attempts = 0;
    const sleeps: number[] = [];

    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('origin timeout', {
          status: 522,
          headers: { 'Retry-After': futureDate },
        });
      }
      if (attempts === 2) {
        return new Response(JPEG_FULL.subarray(0, 8), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '500' },
        });
      }
      return new Response(JPEG_FULL, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG_FULL.length) },
      });
    };

    const body = await census1950FetchJpeg(
      'https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg',
      {
        fetchImpl,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
        nowMs: () => fixedNow,
      }
    );
    expect(body.equals(JPEG_FULL)).toBe(true);
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);
    expect(sleeps[0]).toBeLessThanOrEqual(CENSUS1950_RETRY_AFTER_CAP_S * 1000);
    expect(sleeps[1]).toBe(500);
  });

  it('census1950 search retries transient 503 and timeout', async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('busy', { status: 503, headers: { 'Retry-After': '1' } });
      }
      if (attempts === 2) {
        throw new Error('ReadTimeout: slow');
      }
      return jsonResponse({ total: 1, page: 1, size: 25, results: [{ scheduleId: '42' }] });
    };

    const data = await census1950FetchJson(
      'https://1950census.archives.gov/api/search?state=IL&name=Lincoln',
      {
        fetchImpl,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
        nowMs: () => Date.now(),
      }
    );
    expect(attempts).toBe(3);
    expect(sleeps[0]).toBe(1000);
    expect((data.results[0] as { scheduleId: string }).scheduleId).toBe('42');
  });

  it('broken pipe (EPIPE) on stdout exits cleanly with code 0', async () => {
    const cacheDir = await makeTempDir();
    const ctx = createRecordContext({
      io: {
        stdout: () => {
          const err = new Error('write EPIPE') as NodeJS.ErrnoException;
          err.code = 'EPIPE';
          throw err;
        },
        stderr: () => {},
      },
      env: { KINLOOM_NARA_CACHE_DIR: cacheDir },
      cwd: cacheDir,
    });

    const outcome = await runNaraCommand(['url', 'Harriet Tubman'], ctx);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.bytesOut).toBe(0);
  });

  it('show alias, census1950 aliases, census1950-image HTML retry recovery, and 404 guidance', async () => {
    const baseDir = await makeTempDir();
    const cacheDir = path.join(baseDir, 'cache');
    const outDir = path.join(baseDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });

    // show alias shares record cache with get.
    const apiCalls: string[] = [];
    const recordFetch: typeof fetch = async (input) => {
      apiCalls.push(String(input));
      return jsonResponse(sampleRecordResponse('595367', 'Census Roll', { pageCount: 2 }));
    };
    const s1 = await invokeNara(['show', '595367', '--api-key', 'k', '--json'], {
      cacheDir,
      fetchImpl: recordFetch,
    });
    const s2 = await invokeNara(['get', '595367', '--api-key', 'k', '--json'], {
      cacheDir,
      fetchImpl: recordFetch,
    });
    expect(s1.exitCode).toBe(0);
    expect(s2.exitCode).toBe(0);
    expect((JSON.parse(s1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(s2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(apiCalls).toHaveLength(1);

    // census1950 positional name, --district, and --rows hit same cache as --surname/--ed/--limit.
    const censusUrls: string[] = [];
    const censusFetch: typeof fetch = async (input) => {
      censusUrls.push(String(input));
      return jsonResponse({ total: 1, page: 1, size: 10, results: [{ scheduleId: '77' }] });
    };
    const c1 = await invokeNara(
      ['census1950', 'Lincoln', '--state', 'IL', '--district', '84-1', '--rows', '10', '--json'],
      { cacheDir, fetchImpl: censusFetch }
    );
    const c2 = await invokeNara(
      ['census1950', '--surname', 'Lincoln', '--state', 'IL', '--ed', '84-1', '--limit', '10', '--json'],
      { cacheDir, fetchImpl: censusFetch }
    );
    expect(c1.exitCode).toBe(0);
    expect(c2.exitCode).toBe(0);
    expect((JSON.parse(c1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(c2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(censusUrls).toHaveLength(1);

    // Transient HTTP 200 HTML outage page on census1950-image retries and recovers.
    let attempts = 0;
    const sleeps: number[] = [];
    const htmlThenJpeg: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('<!doctype html><html><body>Temporary outage</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(JPEG_FULL, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    const rec = await invokeNara(
      ['census1950-image', LINCOLN_ED_IMAGE.replace('.jpg', '.JPG'), '--out', outDir, '--json'],
      {
        cacheDir,
        fetchImpl: htmlThenJpeg,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      }
    );
    expect(rec.exitCode).toBe(0);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([250]);

    // Permanent 404 produces clean guidance pointing to `nara census1950`.
    const missing = await invokeNara(['census1950-image', censusSheet(999), '--out', outDir], {
      cacheDir,
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('HTTP 404');
    expect(missing.stderr).toContain('nara census1950');
  });
});

// ===========================================================================
// 7. URL Builder, Help & Environment Defaults
// ===========================================================================

describe('NARA url subcommand, help, and env defaults', () => {
  it('url subcommand builds verified website and v2 API URLs and rejects invalid levels', async () => {
    const cacheDir = await makeTempDir();
    const webRes = await invokeNara(
      ['url', 'Harriet Tubman', '--rg', '15,29', '--level', 'fileUnit', '--online', '--limit', '10'],
      { cacheDir }
    );
    expect(webRes.exitCode).toBe(0);
    expect(webRes.stdout).toBe(
      'https://catalog.archives.gov/search?q=Harriet%20Tubman&levelOfDescription=fileUnit&recordGroupNumber=15%2C29&availableOnline=true&dataSource=description&limit=10'
    );

    const apiRes = await invokeNara(['url', 'Harriet Tubman', '--online', '--api'], { cacheDir });
    expect(apiRes.exitCode).toBe(0);
    expect(apiRes.stdout).toBe(
      'https://catalog.archives.gov/api/v2/records/search?q=Harriet%20Tubman&availableOnline=true&page=1&limit=20'
    );

    const badLevel = await invokeNara(['url', 'test', '--level', 'invalidLevel'], { cacheDir });
    expect(badLevel.exitCode).toBe(2);
    expect(badLevel.stderr).toContain('Invalid level');
  });

  it('prints help, rejects unknown subcommand with exit code 2, and reads NARA_API_KEY from env', async () => {
    const cacheDir = await makeTempDir();
    const helpRes = await invokeNara(['--help'], { cacheDir });
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain('census1950-image');

    const unknownRes = await invokeNara(['bogus-cmd'], { cacheDir });
    expect(unknownRes.exitCode).toBe(2);
    expect(unknownRes.stderr).toContain("No such command 'bogus-cmd'");

    let capturedKey: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedKey = getHeader(init, 'x-api-key');
      return jsonResponse(sampleRecordResponse('595367', 'Env Key Record', { pageCount: 1 }));
    };
    const envRes = await invokeNara(['get', '595367', '--json'], {
      cacheDir,
      env: { NARA_API_KEY: 'env-secret-key' },
      fetchImpl,
    });
    expect(envRes.exitCode).toBe(0);
    expect(capturedKey).toBe('env-secret-key');
    expect(RecordRuntimeError.name).toBe('RecordRuntimeError');
  });

  it('supports --series filter on nara search/url for 4-digit year, microform ID, NAID, and title', async () => {
    const cacheDir = await makeTempDir('nara-series-');

    const yearUrl = await invokeNara(['url', 'Mercer', '--series', '1940', '--api'], { cacheDir });
    expect(yearUrl.exitCode, yearUrl.stderr).toBe(0);
    expect(yearUrl.stdout).toContain('startDate=1940');
    expect(yearUrl.stdout).toContain('endDate=1940');

    const microUrl = await invokeNara(['url', 'Mercer', '--series', 'M593', '--api'], { cacheDir });
    expect(microUrl.exitCode, microUrl.stderr).toBe(0);
    expect(microUrl.stdout).toContain('controlNumbers=M593');

    const naidUrl = await invokeNara(['url', 'Mercer', '--series', '589578', '--api'], { cacheDir });
    expect(naidUrl.exitCode, naidUrl.stderr).toBe(0);
    expect(naidUrl.stdout).toContain('ancestorNaIds=589578');

    const titleUrl = await invokeNara(['url', 'Mercer', '--series', 'Population Schedules', '--api'], {
      cacheDir,
    });
    expect(titleUrl.exitCode, titleUrl.stderr).toBe(0);
    expect(titleUrl.stdout).toContain('title=Population');
  });

  it('bounds browser search and get against hanging launch, evaluate, and close with forced cleanup', async () => {
    const cacheDir = await makeTempDir('nara-browser-timeout-');
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    let signalCode: NodeJS.Signals | null = null;
    const proc: OptionalBrowserProcess = {
      pid: 77701,
      get exitCode() {
        return null;
      },
      get signalCode() {
        return signalCode;
      },
      kill(sig) {
        signals.push(sig);
        if (sig === 'SIGKILL') {
          signalCode = 'SIGKILL';
        }
        return true;
      },
    };

    const hangingEvalBrowser: OptionalBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          content: async () => '',
          evaluate: () => new Promise<never>(() => {}),
          close: () => new Promise<void>(() => {}),
        }),
        close: () => new Promise<void>(() => {}),
      }),
      close: () => new Promise<void>(() => {}),
      process: () => proc,
    };

    const t0 = Date.now();
    const searchRes = await invokeNara(['search', 'Harriet Tubman', '--browser', '--timeout', '0.04'], {
      cacheDir,
      overrides: {
        launcher: async () => hangingEvalBrowser,
        closeTimeoutMs: 20,
        killGraceMs: 10,
      },
    });
    expect(Date.now() - t0).toBeLessThan(600);
    expect(searchRes.exitCode).toBe(1);
    expect(searchRes.stderr).toContain('timed out');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);

    const t1 = Date.now();
    const getRes = await invokeNara(['get', '595367', '--browser', '--timeout', '0.03'], {
      cacheDir,
      overrides: {
        launcher: () => new Promise<OptionalBrowser>(() => {}),
        closeTimeoutMs: 20,
        killGraceMs: 10,
      },
    });
    expect(Date.now() - t1).toBeLessThan(600);
    expect(getRes.exitCode).toBe(1);
    expect(getRes.stderr).toContain('launch');

    const badSearchTimeout = await invokeNara(['search', 'Harriet', '--timeout', '0'], { cacheDir });
    expect(badSearchTimeout.exitCode).toBe(2);

    const badGetTimeout = await invokeNara(['get', '595367', '--timeout', '-1'], { cacheDir });
    expect(badGetTimeout.exitCode).toBe(2);
  });
});
