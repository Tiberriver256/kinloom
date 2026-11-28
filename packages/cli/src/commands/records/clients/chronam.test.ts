import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext, RecordRuntimeError } from '../runtime/index.js';
import {
  COLLECTION_BASE,
  cachedDownloadFile,
  DEFAULT_TIMEOUT,
  getJson,
  MAX_ATTEMPTS,
  runChronamCommand,
} from './chronam.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix = 'kinloom-chronam-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

interface InvokeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly bytesOut: number;
  readonly cacheHit?: boolean | undefined;
}

async function invokeChronam(
  args: readonly string[],
  options: {
    readonly cacheDir: string;
    readonly fetchImpl: typeof fetch;
    readonly cwd?: string | undefined;
    readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  }
): Promise<InvokeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: {
      KINLOOM_CHRONAM_CACHE_DIR: options.cacheDir,
      ...options.env,
    },
    cwd: options.cwd ?? options.cacheDir,
    fetchImpl: options.fetchImpl,
    sleepFn: options.sleepFn ?? (async () => {}),
  });
  const outcome = await runChronamCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    bytesOut: outcome.bytesOut,
    cacheHit: outcome.cacheHit,
  };
}

function makeEveningStarItem(): Record<string, unknown> {
  return {
    item: {
      title: 'Evening Star',
      date: '1865-04-15',
      number_lccn: ['sn83045462'],
      location_city: ['washington'],
      location_state: ['district of columbia'],
    },
    resource: { title: 'Evening Star' },
    resources: [
      {
        pdf: 'https://tile.loc.gov/storage-services/service/ndnp/sn83045462/print.pdf',
        image: 'https://tile.loc.gov/image-services/iiif/example/full/pct:50/0/default.jpg',
        fulltext_file: 'https://tile.loc.gov/storage-services/service/ndnp/sn83045462/ocr.xml',
      },
    ],
  };
}

function readHeaderValue(init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(init?.headers);
  return headers.get(name);
}

describe('chronam CLI & HTTP retry behavior', () => {
  it('1. search sends at=search,results and handles flag aliases', async () => {
    const cacheDir = await makeTempDir();
    const capturedUrls: URL[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      capturedUrls.push(new URL(String(input)));
      return new Response(
        JSON.stringify({
          search: { hits: 1 },
          results: [
            {
              partof_title: ['Chicago daily tribune'],
              date: '1860-11-07',
              location_state: ['illinois'],
              location_county: ['cook'],
              location_city: ['chicago'],
              number_lccn: ['sn84031490'],
              number_page: ['1'],
              url: 'https://www.loc.gov/resource/sn84031490/1860-11-07/ed-1/?sp=1',
              id: 'http://www.loc.gov/resource/sn84031490/1860-11-07/ed-1/?sp=1',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const res = await invokeChronam(
      [
        'search',
        '--terms',
        'Lincoln',
        '--date-from',
        '1860',
        '--date-to',
        '1865',
        '--state',
        'Illinois',
        '--per-page',
        '5',
        '--json',
      ],
      { cacheDir, fetchImpl }
    );

    expect(res.exitCode, res.stderr).toBe(0);
    expect(capturedUrls).toHaveLength(1);
    const params = capturedUrls[0]!.searchParams;
    expect(params.get('q')).toBe('Lincoln');
    expect(params.get('at')).toBe('search,results');
    expect(params.get('dates')).toBe('1860/1865');
    expect(params.get('c')).toBe('5');
    expect(params.get('fa')).toBe('location_state:illinois');

    const payload = JSON.parse(res.stdout) as {
      hits: number;
      cache_hit: boolean;
      results: { title: string }[];
    };
    expect(payload.hits).toBe(1);
    expect(payload.cache_hit).toBe(false);
    expect(payload.results[0]!.title).toBe('Chicago daily tribune');
  });

  it('2. read timeout fails fast without retrying under short timeout budget', async () => {
    let attempts = 0;
    const ctx = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        throw new DOMException('The read operation timed out', 'TimeoutError');
      },
      sleepFn: async () => {},
    });

    const t0 = Date.now();
    let caught: unknown;
    try {
      await getJson(ctx, COLLECTION_BASE, { params: [['q', 'Lincoln']], timeout: 5.0 });
    } catch (err) {
      caught = err;
    }
    const elapsedMs = Date.now() - t0;

    expect(caught).toBeInstanceOf(RecordRuntimeError);
    expect(attempts).toBe(1);
    expect(elapsedMs).toBeLessThan(2000);
    expect((caught as Error).message).toContain('timed out after 5.0s');
    expect((caught as Error).message).toContain('chronam url');
  });

  it('3. 503 retries until exhausted and raises actionable error', async () => {
    let attempts = 0;
    const ctx = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        return new Response('Service Unavailable', { status: 503 });
      },
      sleepFn: async () => {},
    });

    await expect(getJson(ctx, COLLECTION_BASE, { params: [['q', 'Lincoln']], timeout: 8.0 })).rejects.toThrow(
      /HTTP 503/
    );
    expect(attempts).toBe(MAX_ATTEMPTS);
  });

  it('4. read timeout retries inside full budget (>= 90s) and recovers', async () => {
    let attempts = 0;
    const ctx = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new DOMException('stalled socket', 'TimeoutError');
        }
        return new Response(JSON.stringify({ search: { hits: 5 }, results: [] }), { status: 200 });
      },
      sleepFn: async () => {},
    });

    const data = await getJson(ctx, COLLECTION_BASE, {
      params: [['q', 'Lincoln']],
      timeout: 120.0,
    });

    expect(attempts).toBe(2);
    expect((data['search'] as { hits: number }).hits).toBe(5);
  });

  it('5. multi-attempt 429 and 503 recover with Retry-After', async () => {
    let attempts = 0;
    const sleepsMs: number[] = [];
    const ctx = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } });
        }
        if (attempts === 2) {
          return new Response('busy', { status: 503, headers: { 'Retry-After': '3' } });
        }
        return new Response(JSON.stringify({ search: { hits: 7 }, results: [{ date: '1902' }] }), {
          status: 200,
        });
      },
      sleepFn: async (ms) => {
        sleepsMs.push(ms);
      },
    });

    const data = await getJson(ctx, COLLECTION_BASE, {
      params: [['q', 'railroad']],
      timeout: 60.0,
    });

    expect(attempts).toBe(3);
    expect(sleepsMs).toEqual([2000, 3000]);
    expect((data['search'] as { hits: number }).hits).toBe(7);
  });

  it('6. remote protocol / transport error recovers on retry', async () => {
    let attempts = 0;
    const ctx = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError('peer closed connection');
        }
        return new Response(JSON.stringify({ search: { hits: 2 }, results: [] }), { status: 200 });
      },
      sleepFn: async () => {},
    });

    const data = await getJson(ctx, COLLECTION_BASE, {
      params: [['q', 'Lincoln']],
      timeout: 8.0,
    });

    expect(attempts).toBe(2);
    expect((data['search'] as { hits: number }).hits).toBe(2);
  });

  it('7. 429 honors Retry-After then succeeds', async () => {
    let attempts = 0;
    const sleepsMs: number[] = [];
    const ctx = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } });
        }
        return new Response(JSON.stringify({ search: { hits: 1 }, results: [{ date: '1880' }] }), {
          status: 200,
        });
      },
      sleepFn: async (ms) => {
        sleepsMs.push(ms);
      },
    });

    const data = await getJson(ctx, COLLECTION_BASE, {
      params: [['q', 'x']],
      timeout: 60.0,
    });

    expect(attempts).toBe(2);
    expect(sleepsMs).toEqual([3000]);
    expect((data['search'] as { hits: number }).hits).toBe(1);
  });

  it('8. default timeout covers measured loc.gov latency (>= 90s)', () => {
    expect(DEFAULT_TIMEOUT).toBeGreaterThanOrEqual(90.0);
  });
});

describe('chronam search cache and aliases', () => {
  function createSearchHarness() {
    const calls: URLSearchParams[] = [];
    let responsePayload: Record<string, unknown> = {
      search: { hits: 3 },
      results: [
        {
          partof_title: ['Sacramento daily union'],
          date: '1885-01-02',
          location_state: ['california'],
          url: 'https://www.loc.gov/resource/x/',
        },
      ],
    };

    const fetchImpl: typeof fetch = async (input) => {
      calls.push(new URL(String(input)).searchParams);
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    return {
      calls,
      fetchImpl,
      setResponse(next: Record<string, unknown>) {
        responsePayload = next;
      },
    };
  }

  it('9. repeat search is served from disk cache', async () => {
    const cacheDir = await makeTempDir();
    const harness = createSearchHarness();

    const first = await invokeChronam(
      ['search', 'Sacramento', '--state', 'California', '--dates', '1880/1900', '--json'],
      { cacheDir, fetchImpl: harness.fetchImpl }
    );
    const t0 = Date.now();
    const second = await invokeChronam(
      ['search', 'Sacramento', '--state', 'California', '--dates', '1880/1900', '--json'],
      { cacheDir, fetchImpl: harness.fetchImpl }
    );
    const elapsedMs = Date.now() - t0;

    expect(first.exitCode, first.stderr).toBe(0);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(harness.calls).toHaveLength(1);

    const p1 = JSON.parse(first.stdout) as { cache_hit: boolean };
    const p2 = JSON.parse(second.stdout) as { cache_hit: boolean; results: { title: string }[] };
    expect(p1.cache_hit).toBe(false);
    expect(p2.cache_hit).toBe(true);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(p2.results[0]!.title).toBe('Sacramento daily union');
    expect(elapsedMs).toBeLessThan(1000);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('10. --refresh bypasses cache', async () => {
    const cacheDir = await makeTempDir();
    const harness = createSearchHarness();

    await invokeChronam(['search', 'Merced', '--json'], { cacheDir, fetchImpl: harness.fetchImpl });
    await invokeChronam(['search', 'Merced', '--refresh', '--json'], {
      cacheDir,
      fetchImpl: harness.fetchImpl,
    });
    expect(harness.calls).toHaveLength(2);
  });

  it('11. --cache-ttl-hours 0 refetches', async () => {
    const cacheDir = await makeTempDir();
    const harness = createSearchHarness();

    await invokeChronam(['search', 'Merced', '--json'], { cacheDir, fetchImpl: harness.fetchImpl });
    await invokeChronam(['search', 'Merced', '--cache-ttl-hours', '0', '--json'], {
      cacheDir,
      fetchImpl: harness.fetchImpl,
    });
    expect(harness.calls).toHaveLength(2);
  });

  it('12. zero-hit answers are not cached', async () => {
    const cacheDir = await makeTempDir();
    const harness = createSearchHarness();
    harness.setResponse({ search: { hits: 0 }, results: [] });

    const first = await invokeChronam(['search', 'Zzyzx', '--json'], {
      cacheDir,
      fetchImpl: harness.fetchImpl,
    });
    await invokeChronam(['search', 'Zzyzx', '--json'], {
      cacheDir,
      fetchImpl: harness.fetchImpl,
    });

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain('never cached');
    expect(harness.calls).toHaveLength(2);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('13. unquoted multiword query and flag aliases work', async () => {
    const cacheDir = await makeTempDir();
    const harness = createSearchHarness();

    const res = await invokeChronam(
      [
        'search',
        'Abraham',
        'Lincoln',
        '--state',
        'IL',
        '--date1',
        '1860',
        '--date2',
        '1865',
        '--rows',
        '5',
        '--json',
      ],
      { cacheDir, fetchImpl: harness.fetchImpl }
    );

    expect(res.exitCode, res.stderr).toBe(0);
    expect(harness.calls).toHaveLength(1);
    const params = harness.calls[0]!;
    expect(params.get('q')).toBe('Abraham Lincoln');
    expect(params.get('fa')).toBe('location_state:illinois');
    expect(params.get('dates')).toBe('1860/1865');
    expect(params.get('c')).toBe('5');
  });

  it('14. --query flag alias and single-year --dates expand to YYYY/YYYY', async () => {
    const cacheDir = await makeTempDir();
    const harness = createSearchHarness();

    const res = await invokeChronam(['search', '--query', 'Lincoln', '--dates', '1865', '--json'], {
      cacheDir,
      fetchImpl: harness.fetchImpl,
    });

    expect(res.exitCode, res.stderr).toBe(0);
    expect(harness.calls[0]!.get('dates')).toBe('1865/1865');
  });

  it('15. bad --dates exits with code 2 without network call', async () => {
    const cacheDir = await makeTempDir();
    const harness = createSearchHarness();

    const res = await invokeChronam(['search', 'Lincoln', '--dates', '18601865', '--json'], {
      cacheDir,
      fetchImpl: harness.fetchImpl,
    });

    expect(res.exitCode).toBe(2);
    expect(harness.calls).toEqual([]);
  });

  it('16. missing query exits with code 2 and mentions QUERY', async () => {
    const cacheDir = await makeTempDir();
    const harness = createSearchHarness();

    const res = await invokeChronam(['search', '--json'], {
      cacheDir,
      fetchImpl: harness.fetchImpl,
    });

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('QUERY');
  });
});

describe('chronam get, page, and download cache', () => {
  it('17. get repeat is a cache hit and --refresh fetches', async () => {
    const cacheDir = await makeTempDir();
    const item = makeEveningStarItem();
    const getCalls: string[] = [];
    const downloadCalls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://tile.loc.gov/')) {
        downloadCalls.push(url);
        return new Response(Buffer.from('%PDF-1.4 Lincoln'), { status: 200 });
      }
      getCalls.push(url);
      return new Response(JSON.stringify(item), { status: 200 });
    };

    const args = ['get', '--lccn', 'sn83045462', '--date', '1865-04-15', '--seq', '1'];
    const first = await invokeChronam(args, { cacheDir, fetchImpl });
    const second = await invokeChronam(args, { cacheDir, fetchImpl });

    expect(first.exitCode, first.stderr).toBe(0);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout).toContain('Evening Star');
    expect(second.stdout).toContain('[cache]');
    expect(getCalls).toEqual(['https://www.loc.gov/resource/sn83045462/1865-04-15/ed-1/?sp=1&fo=json']);
    expect(downloadCalls).toEqual([]);

    const refreshed = await invokeChronam([...args, '--refresh'], { cacheDir, fetchImpl });
    expect(refreshed.exitCode, refreshed.stderr).toBe(0);
    expect(refreshed.stdout).toContain('Evening Star');
    expect(getCalls).toHaveLength(2);
  });

  it('18. download repeat copies bytes with no HTTP and --refresh/--cache-ttl-hours 0 bypass', async () => {
    const cacheDir = await makeTempDir();
    const workDir = await makeTempDir('kinloom-chronam-work-');
    const outDir = path.join(workDir, 'papers');
    const item = makeEveningStarItem();
    const getCalls: string[] = [];
    const downloadCalls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://tile.loc.gov/')) {
        downloadCalls.push(url);
        return new Response(Buffer.from('%PDF-1.4 Lincoln'), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      getCalls.push(url);
      return new Response(JSON.stringify(item), { status: 200 });
    };

    const args = [
      'download',
      '--lccn',
      'sn83045462',
      '--date',
      '1865-04-15',
      '--seq',
      '1',
      '--out',
      outDir,
      '--no-image',
      '--no-text',
    ];

    const first = await invokeChronam(args, { cacheDir, fetchImpl });
    expect(first.exitCode, first.stderr).toBe(0);
    const pdfs = fs.readdirSync(outDir).filter((f) => f.endsWith('.pdf'));
    expect(pdfs).toHaveLength(1);
    const pdfPath = path.join(outDir, pdfs[0]!);
    expect(fs.readFileSync(pdfPath)).toEqual(Buffer.from('%PDF-1.4 Lincoln'));
    expect(first.stdout).not.toContain('[cache]');
    expect(getCalls).toHaveLength(1);
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0]!.startsWith('https://tile.loc.gov/')).toBe(true);

    const second = await invokeChronam(args, { cacheDir, fetchImpl });
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout).toContain('[cache]');
    expect(fs.readFileSync(pdfPath)).toEqual(Buffer.from('%PDF-1.4 Lincoln'));
    expect(getCalls).toHaveLength(1);
    expect(downloadCalls).toHaveLength(1);

    const refreshed = await invokeChronam([...args, '--refresh'], { cacheDir, fetchImpl });
    expect(refreshed.exitCode, refreshed.stderr).toBe(0);
    expect(refreshed.stdout).not.toContain('[cache]');
    expect(fs.readFileSync(pdfPath)).toEqual(Buffer.from('%PDF-1.4 Lincoln'));
    expect(getCalls).toHaveLength(2);
    expect(downloadCalls).toHaveLength(2);

    const expired = await invokeChronam([...args, '--cache-ttl-hours', '0'], {
      cacheDir,
      fetchImpl,
    });
    expect(expired.exitCode, expired.stderr).toBe(0);
    expect(downloadCalls).toHaveLength(3);
    expect(fs.readFileSync(pdfPath)).toEqual(Buffer.from('%PDF-1.4 Lincoln'));
  });

  it('19. download rejects path traversal in item fields', async () => {
    const cacheDir = await makeTempDir();
    const workDir = await makeTempDir('kinloom-chronam-work-');
    const outDir = path.join(workDir, 'out');
    const item = makeEveningStarItem();
    const itemMeta = item['item'] as Record<string, unknown>;
    itemMeta['date'] = '../../outside';
    itemMeta['number_lccn'] = ['../sn83045462'];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://tile.loc.gov/')) {
        return new Response(Buffer.from('%PDF-1.4 Lincoln'), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      return new Response(JSON.stringify(item), { status: 200 });
    };

    const res = await invokeChronam(
      ['download', '--lccn', 'sn83045462', '--date', '1865-04-15', '--seq', '1', '--out', outDir],
      { cacheDir, fetchImpl }
    );

    expect(res.exitCode, res.stderr).toBe(0);
    const written = listFilesRecursive(workDir);
    const pdfs = written.filter((p) => p.endsWith('.pdf'));
    expect(pdfs).toHaveLength(1);
    expect(fs.readFileSync(pdfs[0]!)).toEqual(Buffer.from('%PDF-1.4 Lincoln'));

    const resolvedOut = path.resolve(outDir);
    for (const filePath of written) {
      const rel = path.relative(resolvedOut, path.resolve(filePath));
      expect(rel.startsWith('..')).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(path.basename(filePath)).not.toContain('..');
    }
  });

  it('20. get and page emit cache_hit and strip query highlight (?q=)', async () => {
    const cacheDir = await makeTempDir();
    const item = makeEveningStarItem();
    const getCalls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      getCalls.push(String(input));
      return new Response(JSON.stringify(item), { status: 200 });
    };

    const u1 = 'https://www.loc.gov/resource/sn83045462/1865-04-15/ed-1/?sp=4&q=railroad';
    const u2 = 'https://www.loc.gov/resource/sn83045462/1865-04-15/ed-1/?sp=4&q=lincoln';

    const first = await invokeChronam(['get', u1, '--json'], { cacheDir, fetchImpl });
    const second = await invokeChronam(['page', u2, '--json'], { cacheDir, fetchImpl });

    expect(first.exitCode, first.stderr).toBe(0);
    expect(second.exitCode, second.stderr).toBe(0);
    expect((JSON.parse(first.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(second.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(getCalls).toEqual(['https://www.loc.gov/resource/sn83045462/1865-04-15/ed-1/?sp=4&fo=json']);
  });

  it('21. download --json emits cache_hit and resolves page-specific IIIF and sp', async () => {
    const cacheDir = await makeTempDir();
    const workDir = await makeTempDir('kinloom-chronam-work-');
    const outDir = path.join(workDir, 'papers');
    const item = makeEveningStarItem();
    item['page'] = [
      {
        mimetype: 'image/jp2',
        url: 'https://tile.loc.gov/storage-services/service/ndnp/sn83045462/0004.jp2',
        info: 'https://tile.loc.gov/image-services/iiif/service:ndnp:sn83045462:0004/info.json',
      },
      {
        mimetype: 'application/pdf',
        url: 'https://tile.loc.gov/storage-services/service/ndnp/sn83045462/0004.pdf',
      },
    ];

    const downloadCalls: string[] = [];
    const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('page-4-jpeg')]);

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://tile.loc.gov/')) {
        downloadCalls.push(url);
        if (url.endsWith('.jpg')) {
          return new Response(jpegBytes, {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          });
        }
        return new Response(Buffer.from('%PDF-1.4 page-4-pdf'), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      return new Response(JSON.stringify(item), { status: 200 });
    };

    const url = 'https://www.loc.gov/resource/sn83045462/1865-04-15/ed-1/?sp=4&q=railroad';
    const args = ['download', url, '--out', outDir, '--no-pdf', '--image', '--image-width', '2000', '--json'];

    const r1 = await invokeChronam(args, { cacheDir, fetchImpl });
    expect(r1.exitCode, r1.stderr).toBe(0);
    const p1 = JSON.parse(r1.stdout) as {
      cache_hit: boolean;
      metadata_cache_hit: boolean;
      files: { url: string; path: string; cache_hit: boolean }[];
    };
    expect(p1.cache_hit).toBe(false);
    expect(p1.metadata_cache_hit).toBe(false);
    expect(p1.files[0]!.url).toBe(
      'https://tile.loc.gov/image-services/iiif/service:ndnp:sn83045462:0004/full/2000,/0/default.jpg'
    );
    expect(p1.files[0]!.path.endsWith('_sp4.jpg')).toBe(true);
    expect(fs.readFileSync(p1.files[0]!.path)).toEqual(jpegBytes);

    const r2 = await invokeChronam(args, { cacheDir, fetchImpl });
    expect(r2.exitCode, r2.stderr).toBe(0);
    const p2 = JSON.parse(r2.stdout) as {
      cache_hit: boolean;
      metadata_cache_hit: boolean;
      files: { cache_hit: boolean }[];
    };
    expect(p2.cache_hit).toBe(true);
    expect(p2.metadata_cache_hit).toBe(true);
    expect(p2.files[0]!.cache_hit).toBe(true);
    expect(downloadCalls).toHaveLength(1);
  });
});

describe('chronam download hardening', () => {
  it('22. stream download retries 429, timeout, 503, sends loc.gov Referer, and caches', async () => {
    const cacheDir = await makeTempDir();
    const pdfUrl = 'https://tile.loc.gov/storage-services/service/ndnp/sn83045462/0001.pdf';
    const pdfBytes = Buffer.from('%PDF-1.4\nreliable-newspaper');
    let attempts = 0;
    const sleepsMs: number[] = [];

    const ctx = createRecordContext({
      env: { KINLOOM_CHRONAM_CACHE_DIR: cacheDir },
      fetchImpl: async (_input, init) => {
        attempts += 1;
        expect(readHeaderValue(init, 'referer')).toBe('https://www.loc.gov/');
        if (attempts === 1) {
          return new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } });
        }
        if (attempts === 2) {
          throw new DOMException('slow tile server', 'TimeoutError');
        }
        if (attempts === 3) {
          return new Response('busy', { status: 503 });
        }
        return new Response(pdfBytes, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(pdfBytes.byteLength),
          },
        });
      },
      sleepFn: async (ms) => {
        sleepsMs.push(ms);
      },
    });

    const first = await cachedDownloadFile(ctx, pdfUrl, {
      timeout: 60.0,
      refresh: false,
      ttlHours: 24.0,
      kind: 'pdf',
    });
    const second = await cachedDownloadFile(ctx, pdfUrl, {
      timeout: 60.0,
      refresh: false,
      ttlHours: 24.0,
      kind: 'pdf',
    });

    expect(attempts).toBe(4);
    expect(sleepsMs[0]).toBe(2000);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(first.nbytes).toBe(pdfBytes.byteLength);
    expect(second.nbytes).toBe(pdfBytes.byteLength);
    expect(first.contentType).toBe('application/pdf');
    expect(second.contentType).toBe('application/pdf');
    expect(fs.readFileSync(first.cachePath)).toEqual(pdfBytes);
    expect(first.cachePath).toBe(second.cachePath);
  });

  it('23. download refuses HTML error pages and non-loc.gov hosts', async () => {
    const cacheDir = await makeTempDir();
    const htmlCtx = createRecordContext({
      env: { KINLOOM_CHRONAM_CACHE_DIR: cacheDir },
      fetchImpl: async () =>
        new Response('<!doctype html><html><body>Rate limit page</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      sleepFn: async () => {},
    });

    for (const badUrl of [
      'https://evil.example/page.pdf',
      'http://tile.loc.gov/storage-services/page.pdf',
      'https://user@tile.loc.gov/storage-services/page.pdf',
    ]) {
      await expect(
        cachedDownloadFile(htmlCtx, badUrl, {
          timeout: 10.0,
          refresh: false,
          ttlHours: 24.0,
          kind: 'pdf',
        })
      ).rejects.toThrow(RecordRuntimeError);
    }

    await expect(
      cachedDownloadFile(htmlCtx, 'https://tile.loc.gov/storage-services/page.pdf', {
        timeout: 10.0,
        refresh: false,
        ttlHours: 24.0,
        kind: 'pdf',
      })
    ).rejects.toThrow(/HTML/);

    await expect(
      cachedDownloadFile(htmlCtx, 'https://tile.loc.gov/image-services/iiif/x/full/pct:50/0/default.jpg', {
        timeout: 10.0,
        refresh: false,
        ttlHours: 24.0,
        kind: 'image',
      })
    ).rejects.toThrow(/HTML/);

    const filesDir = path.join(cacheDir, 'files');
    const cachedBins = fs.existsSync(filesDir)
      ? fs.readdirSync(filesDir).filter((f) => f.endsWith('.bin'))
      : [];
    expect(cachedBins).toEqual([]);
  });

  it('24. download CLI rejects parent traversal --out directory', async () => {
    const cacheDir = await makeTempDir();
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network should not be called');
    };

    const res = await invokeChronam(
      ['download', '--lccn', 'sn83045462', '--date', '1865-04-15', '--out', '../escape-dir'],
      { cacheDir, fetchImpl }
    );

    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('Unsafe output directory');
  });
});
