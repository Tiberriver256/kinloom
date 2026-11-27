import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext, SsrfBlockedError } from '../runtime/index.js';
import { runOpenarchievenCommand, validateApiUrl, validateScanUrl } from './openarchieven.js';

const SEARCH_PAYLOAD = {
  response: {
    number_found: 1,
    docs: [
      {
        archive_code: 'bhi',
        identifier: '11111111-2222-3333-4444-555555555555',
        personname: 'Jan Jansen',
        relationtype: 'Kind',
        sourcetype: 'BS Geboorte',
        eventdate: { year: 1853, month: 3, day: 30 },
        eventplace: ['Zundert'],
        url: 'https://www.openarchieven.nl/bhi:11111111-2222-3333-4444-555555555555',
      },
    ],
  },
};

const SHOW_PAYLOAD = {
  a2a_Source: {
    a2a_SourceType: { a2a_SourceType: 'BS Geboorte' },
    a2a_SourcePlace: { a2a_Place: 'Zundert' },
    a2a_SourceReference: { a2a_InstitutionName: 'BHIC' },
  },
  a2a_Event: {
    a2a_EventType: 'Geboorte',
    a2a_EventDate: { a2a_Year: '1853', a2a_Month: '3', a2a_Day: '30' },
    a2a_EventPlace: { a2a_Place: 'Zundert' },
  },
  a2a_Person: [
    {
      pid: 'Person:1',
      a2a_PersonName: {
        a2a_PersonNameFirstName: 'Jan',
        a2a_PersonNameLastName: 'Jansen',
      },
    },
  ],
  a2a_RelationEP: [{ a2a_PersonKeyRef: 'Person:1', a2a_RelationType: 'Kind' }],
};

const JPEG_ONE = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
const JPEG_TWO = Buffer.from([0xff, 0xd8, 0xff, 0x02]);
const RECORD_REF = '11111111-2222-3333-4444-555555555555';
const FULL_ONE = 'https://scans.invalid/full-1.jpg';
const FULL_TWO = 'https://scans.invalid/full-2.jpg';
const PREVIEW_ONE = 'https://scans.invalid/preview-1.jpg';

const SCAN_RECORD = {
  a2a_Source: {
    a2a_SourceAvailableScans: {
      a2a_Scan: [
        {
          a2a_OrderSequenceNumber: { a2a_OrderSequenceNumber: '2' },
          a2a_Uri: { a2a_Uri: FULL_TWO },
          a2a_UriPreview: { a2a_UriPreview: 'https://scans.invalid/preview-2.jpg' },
          a2a_Label: { a2a_Label: 'page two' },
        },
        {
          uri: FULL_ONE,
          uri_preview: PREVIEW_ONE,
          order: 1,
          label: 'page one',
        },
      ],
    },
  },
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-openarchieven-test-'));
  tempDirs.push(dir);
  return dir;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bytesResponse(body: Buffer, contentType: string, status = 200): Response {
  return new Response(new Uint8Array(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

async function invokeOpenarchieven(
  args: readonly string[],
  cacheDir: string,
  fetchImpl: typeof fetch,
  overrides: {
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly onStdout?: (line: string) => void;
  } = {}
): Promise<{
  readonly exitCode: number;
  readonly bytesOut: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cacheHit?: boolean;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => {
        if (overrides.onStdout) {
          overrides.onStdout(line);
        }
        stdout.push(line);
      },
      stderr: (line) => stderr.push(line),
    },
    env: {
      KINLOOM_OPENARCHIEVEN_CACHE_DIR: cacheDir,
      ...overrides.env,
    },
    cwd: overrides.cwd ?? cacheDir,
    fetchImpl,
    sleepFn: async () => {},
  });
  const outcome = await runOpenarchievenCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    bytesOut: outcome.bytesOut,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('openarchieven cache', () => {
  it('1. search caches and second run makes zero HTTP calls', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(SEARCH_PAYLOAD);
    };

    const r1 = await invokeOpenarchieven(['search', '--name', 'Jan Jansen', '--json'], cacheDir, fetchImpl);
    const r2 = await invokeOpenarchieven(['search', '--name', 'Jan Jansen', '--json'], cacheDir, fetchImpl);
    const r3 = await invokeOpenarchieven(['search', '--name', 'Jan Jansen'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(1);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r3.cacheHit).toBe(true);
    expect(r3.stdout).toContain('[cache]');
  });

  it('2. refresh and zero ttl bypass cache', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(SEARCH_PAYLOAD);
    };

    await invokeOpenarchieven(['search', '--name', 'Jan Jansen', '--json'], cacheDir, fetchImpl);
    const rRef = await invokeOpenarchieven(
      ['search', '--name', 'Jan Jansen', '--refresh', '--json'],
      cacheDir,
      fetchImpl
    );
    const rTtl = await invokeOpenarchieven(
      ['search', '--name', 'Jan Jansen', '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      fetchImpl
    );

    expect(calls).toBe(3);
    expect((JSON.parse(rRef.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(rTtl.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
  });

  it('3. show caches and marks text hit', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(SHOW_PAYLOAD);
    };

    const r1 = await invokeOpenarchieven(['show', `bhi:${RECORD_REF}`, '--json'], cacheDir, fetchImpl);
    const r2 = await invokeOpenarchieven(['show', `bhi:${RECORD_REF}`], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(calls).toBe(1);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(r2.stdout).toContain('[cache]');
    expect(r2.stdout).toContain('Jan Jansen');
  });

  it('4. HTTP and API errors are never cached', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    let step: 'http500' | 'api_error' | 'ok' = 'http500';
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (step === 'http500') {
        return new Response('server error', { status: 500 });
      }
      if (step === 'api_error') {
        return jsonResponse({ error_code: 1, error_description: 'Invalid archive' });
      }
      return jsonResponse(SEARCH_PAYLOAD);
    };

    const r1 = await invokeOpenarchieven(['search', '--name', 'Jan Jansen'], cacheDir, fetchImpl);
    step = 'api_error';
    const r2 = await invokeOpenarchieven(['search', '--name', 'Jan Jansen'], cacheDir, fetchImpl);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    step = 'ok';
    const r3 = await invokeOpenarchieven(['search', '--name', 'Jan Jansen', '--json'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).not.toContain('Traceback');
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).not.toContain('Traceback');
    expect(r3.exitCode).toBe(0);
    // 3 attempts on persistent 500 + 1 non-retried API error + 1 ok = 5
    expect(calls).toBe(5);
  });

  it('5. --page matches --start cache and rejects conflicts', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const seen: Array<{ readonly start: string | null; readonly number_show: string | null }> = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const parsed = new URL(String(input));
      seen.push({
        start: parsed.searchParams.get('start'),
        number_show: parsed.searchParams.get('number_show'),
      });
      return jsonResponse(SEARCH_PAYLOAD);
    };

    const first = await invokeOpenarchieven(
      ['search', '--name', 'Jan Jansen', '--limit', '10', '--json'],
      cacheDir,
      fetchImpl
    );
    const pageOne = await invokeOpenarchieven(
      ['search', '--name', 'Jan Jansen', '--limit', '10', '--page', '1', '--json'],
      cacheDir,
      fetchImpl
    );
    const pageTwo = await invokeOpenarchieven(
      ['search', '--name', 'Jan Jansen', '--limit', '10', '--page', '2', '--json'],
      cacheDir,
      fetchImpl
    );
    const sameStart = await invokeOpenarchieven(
      ['search', '--name', 'Jan Jansen', '--limit', '10', '--start', '10', '--json'],
      cacheDir,
      fetchImpl
    );
    const both = await invokeOpenarchieven(
      ['search', '--name', 'Jan Jansen', '--page', '2', '--start', '10', '--json'],
      cacheDir,
      fetchImpl
    );
    const zero = await invokeOpenarchieven(
      ['search', '--name', 'Jan Jansen', '--page', '0', '--json'],
      cacheDir,
      fetchImpl
    );

    expect(first.exitCode).toBe(0);
    expect(pageOne.exitCode).toBe(0);
    expect(pageTwo.exitCode).toBe(0);
    expect(sameStart.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(seen).toEqual([
      { start: '0', number_show: '10' },
      { start: '10', number_show: '10' },
    ]);
    expect((JSON.parse(first.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(pageOne.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect((JSON.parse(pageTwo.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(sameStart.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain('--page');
    expect(zero.exitCode).toBe(2);

    const queries: Array<Record<string, unknown>> = [];
    for (const file of fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))) {
      const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8')) as {
        query: Record<string, unknown>;
        result: Record<string, unknown>;
      };
      queries.push(entry.query);
      expect('cache_hit' in entry.result).toBe(false);
    }
    expect(queries.map((q) => Number(q.start)).toSorted((a, b) => a - b)).toEqual([0, 10]);
    expect(queries.every((q) => !('page' in q))).toBe(true);
  });
});

describe('openarchieven download', () => {
  it('6. single scan downloads then hits cache', async () => {
    const cacheDir = await makeTempDir();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('show.json')) {
        return jsonResponse([SCAN_RECORD]);
      }
      if (url === FULL_ONE) {
        return bytesResponse(JPEG_ONE, 'image/jpeg');
      }
      return new Response('missing', { status: 404 });
    };

    const out = path.join(cacheDir, 'one.jpg');
    const first = await invokeOpenarchieven(
      ['download', `https://www.openarchieven.nl/bhi:${RECORD_REF}`, '--out', out, '--json'],
      cacheDir,
      fetchImpl
    );
    const second = await invokeOpenarchieven(
      ['download', 'bhi', RECORD_REF, '-o', out, '--json'],
      cacheDir,
      fetchImpl
    );

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const firstBody = JSON.parse(first.stdout) as {
      cache_hit: boolean;
      files: Array<{ url: string; bytes: number }>;
    };
    const secondBody = JSON.parse(second.stdout) as { cache_hit: boolean };
    expect(firstBody.cache_hit).toBe(false);
    expect(secondBody.cache_hit).toBe(true);
    expect(firstBody.files[0].url).toBe(FULL_ONE);
    expect(firstBody.files[0].bytes).toBe(JPEG_ONE.length);
    expect(fs.readFileSync(out)).toEqual(JPEG_ONE);
    expect(calls.filter((u) => u.includes('show.json'))).toHaveLength(1);
    expect(calls.filter((u) => u === FULL_ONE)).toHaveLength(1);
    expect(calls).not.toContain(PREVIEW_ONE);
  });

  it('7. --all scans use order and deterministic names', async () => {
    const cacheDir = await makeTempDir();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('show.json')) {
        return jsonResponse([SCAN_RECORD]);
      }
      if (url === FULL_ONE) {
        return bytesResponse(JPEG_ONE, 'image/jpeg');
      }
      if (url === FULL_TWO) {
        return bytesResponse(JPEG_TWO, 'image/jpeg');
      }
      return new Response('missing', { status: 404 });
    };

    const outDir = path.join(cacheDir, 'scans-out');
    const result = await invokeOpenarchieven(
      ['download', `bhi:${RECORD_REF}`, '--all', '--out-dir', outDir, '--json'],
      cacheDir,
      fetchImpl
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      cache_hit: boolean;
      files: Array<{ index: number; label: string; path: string }>;
    };
    expect(body.files.map((item) => item.index)).toEqual([1, 2]);
    expect(body.files[0].label).toBe('page one');
    expect(body.files[1].label).toBe('page two');
    expect(path.basename(body.files[0].path)).toBe('bhi-11111111-scan-01.jpg');
    expect(path.basename(body.files[1].path)).toBe('bhi-11111111-scan-02.jpg');
    expect(fs.readFileSync(body.files[0].path)).toEqual(JPEG_ONE);
    expect(fs.readFileSync(body.files[1].path)).toEqual(JPEG_TWO);
    expect(body.cache_hit).toBe(false);
  });

  it('8. refresh and zero ttl download again', async () => {
    const cacheDir = await makeTempDir();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('show.json')) {
        return jsonResponse([SCAN_RECORD]);
      }
      if (url === FULL_ONE) {
        return bytesResponse(JPEG_ONE, 'image/jpeg');
      }
      return new Response('missing', { status: 404 });
    };

    const out = path.join(cacheDir, 'one.jpg');
    const baseArgs = ['download', `bhi:${RECORD_REF}`, '--scan-index', '1', '--output', out, '--json'];
    await invokeOpenarchieven(baseArgs, cacheDir, fetchImpl);
    const refreshed = await invokeOpenarchieven([...baseArgs, '--refresh'], cacheDir, fetchImpl);
    const expired = await invokeOpenarchieven([...baseArgs, '--cache-ttl-hours', '0'], cacheDir, fetchImpl);

    expect(refreshed.exitCode).toBe(0);
    expect(expired.exitCode).toBe(0);
    expect((JSON.parse(refreshed.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(expired.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(calls.filter((u) => u === FULL_ONE)).toHaveLength(3);
  });

  it('9. --list prints full and preview URLs without downloading', async () => {
    const cacheDir = await makeTempDir();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('show.json')) {
        return jsonResponse([SCAN_RECORD]);
      }
      return new Response('should not download', { status: 500 });
    };

    const listed = await invokeOpenarchieven(
      ['download', `bhi:${RECORD_REF}`, '--list', '--json'],
      cacheDir,
      fetchImpl
    );
    const preview = await invokeOpenarchieven(
      ['download', `bhi:${RECORD_REF}`, '--list', '--preview', '--json'],
      cacheDir,
      fetchImpl
    );

    expect(listed.exitCode).toBe(0);
    const body = JSON.parse(listed.stdout) as {
      cache_hit: boolean;
      scans: Array<{ url: string; index: number; label: string }>;
    };
    expect(body.scans[0].url).toBe(FULL_ONE);
    expect(body.scans[0].index).toBe(1);
    expect(body.scans[0].label).toBe('page one');
    expect(body.cache_hit).toBe(false);

    const previewBody = JSON.parse(preview.stdout) as {
      cache_hit: boolean;
      scans: Array<{ url: string }>;
    };
    expect(previewBody.scans[0].url).toBe(PREVIEW_ONE);
    expect(previewBody.cache_hit).toBe(true);
    expect(calls.filter((u) => u.includes('scans.invalid'))).toHaveLength(0);
  });

  it('10. HTML and HTTP errors are not cached or saved', async () => {
    const cacheDir = await makeTempDir();
    const calls: string[] = [];
    let mode: 'html' | 'http' | 'ok' = 'html';
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('show.json')) {
        return jsonResponse([SCAN_RECORD]);
      }
      if (mode === 'html') {
        return new Response('<html><body>viewer</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (mode === 'http') {
        return new Response('bad gateway', { status: 502 });
      }
      return bytesResponse(JPEG_ONE, 'image/jpeg');
    };

    const out = path.join(cacheDir, 'one.jpg');
    const args = ['download', `bhi:${RECORD_REF}`, '--out', out];
    const html = await invokeOpenarchieven(args, cacheDir, fetchImpl);
    const htmlAgain = await invokeOpenarchieven(args, cacheDir, fetchImpl);
    mode = 'http';
    const httpErr = await invokeOpenarchieven(args, cacheDir, fetchImpl);
    const scansCacheDir = path.join(cacheDir, 'scans');
    const cachedBins = fs.existsSync(scansCacheDir)
      ? fs.readdirSync(scansCacheDir).filter((f) => f.endsWith('.bin'))
      : [];
    expect(cachedBins).toEqual([]);
    expect(fs.existsSync(out)).toBe(false);
    mode = 'ok';
    const ok = await invokeOpenarchieven([...args, '--json'], cacheDir, fetchImpl);

    expect(html.exitCode).toBe(1);
    expect(html.stderr).toContain('HTML');
    expect(html.stderr).not.toContain('Traceback');
    expect(htmlAgain.exitCode).toBe(1);
    expect(httpErr.exitCode).toBe(1);
    expect(httpErr.stderr).toContain('HTTP 502');
    expect(ok.exitCode).toBe(0);
    expect(fs.readFileSync(out)).toEqual(JPEG_ONE);
    const imageCalls = calls.filter((u) => u.includes('scans.invalid'));
    // 2 html runs x (full + preview fallback) = 4, + 3 retries on 502 + 1 ok = 8
    expect(imageCalls).toHaveLength(8);
  });

  it('11. zero-scan record lists empty and download fails', async () => {
    const cacheDir = await makeTempDir();
    const fetchImpl: typeof fetch = async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname.endsWith('show.json')) {
        return jsonResponse(SHOW_PAYLOAD);
      }
      return new Response('no scans to fetch', { status: 500 });
    };

    const listed = await invokeOpenarchieven(
      ['download', `bhi:${RECORD_REF}`, '--list', '--json'],
      cacheDir,
      fetchImpl
    );
    const failed = await invokeOpenarchieven(
      ['download', `bhi:${RECORD_REF}`, '--out', path.join(cacheDir, 'x.jpg')],
      cacheDir,
      fetchImpl
    );

    expect(listed.exitCode).toBe(0);
    expect((JSON.parse(listed.stdout) as { scans: unknown[] }).scans).toEqual([]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('No scans');
    expect(failed.stderr).not.toContain('Traceback');
  });
});

describe('openarchieven hardening & Wave 45 fallbacks', () => {
  it('12. search and show retry transient 429, 503, and timeout', async () => {
    const cacheDir = await makeTempDir();
    let searchCalls = 0;
    let showCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname.endsWith('search.json')) {
        searchCalls += 1;
        if (searchCalls === 1) {
          return new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '0' },
          });
        }
        if (searchCalls === 2) {
          throw new Error('transient timeout');
        }
        return jsonResponse(SEARCH_PAYLOAD);
      }
      if (parsed.pathname.endsWith('show.json')) {
        showCalls += 1;
        if (showCalls === 1) {
          return new Response('service unavailable', { status: 503 });
        }
        return jsonResponse([SHOW_PAYLOAD]);
      }
      return new Response('missing', { status: 404 });
    };

    const rSearch = await invokeOpenarchieven(
      ['search', '--name', 'Jan Bakker', '--json'],
      cacheDir,
      fetchImpl
    );
    const rShow = await invokeOpenarchieven(['show', `bhi:${RECORD_REF}`, '--json'], cacheDir, fetchImpl);
    const rShowCached = await invokeOpenarchieven(
      ['show', `bhi:${RECORD_REF}`, '--json'],
      cacheDir,
      fetchImpl
    );

    expect(rSearch.exitCode).toBe(0);
    expect(rShow.exitCode).toBe(0);
    expect(rShowCached.exitCode).toBe(0);
    expect(searchCalls).toBe(3);
    expect(showCalls).toBe(2);
    expect((JSON.parse(rSearch.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(rShow.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(rShowCached.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
  });

  it('13. download retries transient 503 scan response', async () => {
    const cacheDir = await makeTempDir();
    let scanCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('show.json')) {
        return jsonResponse([SCAN_RECORD]);
      }
      if (url === FULL_ONE) {
        scanCalls += 1;
        if (scanCalls === 1) {
          return new Response('busy', { status: 503 });
        }
        return bytesResponse(JPEG_ONE, 'image/jpeg');
      }
      return new Response('missing', { status: 404 });
    };

    const out = path.join(cacheDir, 'retried.jpg');
    const res = await invokeOpenarchieven(
      ['download', `bhi:${RECORD_REF}`, '--out', out, '--json'],
      cacheDir,
      fetchImpl
    );

    expect(res.exitCode).toBe(0);
    expect(scanCalls).toBe(2);
    expect(fs.readFileSync(out)).toEqual(JPEG_ONE);
    expect((JSON.parse(res.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
  });

  it('14. host allowlist, SSRF guard, path traversal guard, and broken pipe handling', async () => {
    const cacheDir = await makeTempDir();

    expect(() => validateApiUrl('https://evil.example/1.0/records/search.json')).toThrow(SsrfBlockedError);
    expect(() => validateApiUrl('http://api.openarch.nl/1.0/records/search.json')).toThrow(SsrfBlockedError);
    expect(() => validateApiUrl('https://user:pass@api.openarch.nl/1.0/records/search.json')).toThrow(
      SsrfBlockedError
    );
    expect(() => validateScanUrl('http://127.0.0.1/secret.jpg')).toThrow(SsrfBlockedError);
    expect(() => validateScanUrl('http://169.254.169.254/latest/meta-data/')).toThrow(SsrfBlockedError);
    expect(() => validateScanUrl('https://user:pass@scans.invalid/scan.jpg')).toThrow(SsrfBlockedError);

    const redirectApi: typeof fetch = async (input) => {
      const parsed = new URL(String(input));
      if (parsed.hostname === 'api.openarch.nl') {
        return new Response('', {
          status: 302,
          headers: { Location: 'https://evil.example/hijack' },
        });
      }
      return jsonResponse(SEARCH_PAYLOAD);
    };

    const blocked = await invokeOpenarchieven(['search', '--name', 'Jan Bakker'], cacheDir, redirectApi);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain('Refusing API host');

    const badRef = await invokeOpenarchieven(['show', '../etc', 'passwd'], cacheDir, redirectApi);
    expect(badRef.exitCode).toBe(2);

    const pipeErr = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    const piped = await invokeOpenarchieven(['url', '--record', `bhi:${RECORD_REF}`], cacheDir, redirectApi, {
      onStdout: () => {
        throw pipeErr;
      },
    });
    expect(piped.exitCode).toBe(0);
  });

  it('15. get alias, viewer fallbacks, proxy upgrade, direct IIIF JP2->JPG, and search aliases', async () => {
    const cacheDir = await makeTempDir();
    const viewerFilesRecord = {
      a2a_Source: {
        a2a_SourceAvailableScans: {
          a2a_Scan: {
            a2a_Uri: 'http://www.archieven.nl/nl/zoeken?mivast=239&mizig=210',
            a2a_UriPreview: 'http://files.archieven.nl/php/show_file.php?adt_id=239&file=demo.jpg',
          },
        },
      },
    };
    const hdlProxyRecord = {
      a2a_Source: {
        a2a_SourceAvailableScans: {
          a2a_Scan: {
            a2a_Uri: 'https://hdl.handle.net/21.12133/DEMO-1234',
            a2a_UriPreview: 'https://proxy.archieven.nl/thumb/239/AABBCCDD',
          },
        },
      },
    };
    const unknownHtmlRecord = {
      a2a_Source: {
        a2a_SourceAvailableScans: {
          a2a_Scan: {
            a2a_Uri: 'https://viewer.example/page/42',
            a2a_UriPreview: 'https://images.example/scan-42.jpg',
          },
        },
      },
    };

    let failFullProxy = false;
    let protoAttempts = 0;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('search.json')) {
        expect(parsed.searchParams.get('name')).toBe('Jan Bakker');
        expect(parsed.searchParams.get('number_show')).toBe('5');
        expect(parsed.searchParams.get('start')).toBe('10');
        return jsonResponse(SEARCH_PAYLOAD);
      }
      if (parsed.pathname.endsWith('show.json')) {
        const ident = parsed.searchParams.get('identifier');
        if (ident === 'zar-files-1') {
          return jsonResponse([viewerFilesRecord]);
        }
        if (ident === 'zar-proxy-1') {
          return jsonResponse([hdlProxyRecord]);
        }
        if (ident === 'unk-html-1') {
          return jsonResponse([unknownHtmlRecord]);
        }
        return jsonResponse([SHOW_PAYLOAD]);
      }
      if (url === 'http://www.archieven.nl/nl/zoeken?mivast=239&mizig=210') {
        throw new Error('Known HTML viewer URL should be skipped when preview image exists');
      }
      if (url === 'http://files.archieven.nl/php/show_file.php?adt_id=239&file=demo.jpg') {
        protoAttempts += 1;
        if (protoAttempts === 1) {
          throw new Error('server disconnected');
        }
        return bytesResponse(JPEG_ONE, 'image/jpeg');
      }
      if (url === 'https://proxy.archieven.nl/download/239/AABBCCDD') {
        if (failFullProxy) {
          return new Response('not found', { status: 404 });
        }
        return bytesResponse(JPEG_TWO, 'image/jpeg');
      }
      if (url === 'https://proxy.archieven.nl/thumb/239/AABBCCDD') {
        return bytesResponse(JPEG_ONE, 'image/jpeg');
      }
      if (url === 'https://viewer.example/page/42') {
        return new Response('<!doctype html><html>viewer</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url === 'https://images.example/scan-42.jpg') {
        return bytesResponse(JPEG_ONE, 'image/jpeg');
      }
      if (url === 'https://images.memorix.nl/bhic/iiif/demo/full/full/0/default.jpg') {
        return bytesResponse(JPEG_TWO, 'image/jpeg');
      }
      return new Response('missing', { status: 404 });
    };

    // 1. `openarchieven get` aliases `show` and shares the disk cache.
    const g1 = await invokeOpenarchieven(['get', `bhi:${RECORD_REF}`, '--json'], cacheDir, fetchImpl);
    const g2 = await invokeOpenarchieven(['show', `bhi:${RECORD_REF}`, '--json'], cacheDir, fetchImpl);
    expect(g1.exitCode).toBe(0);
    expect(g2.exitCode).toBe(0);
    expect((JSON.parse(g1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(g2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);

    // 2. `search` accepts --given/--surname, --rows, --offset.
    const s1 = await invokeOpenarchieven(
      ['search', '--given', 'Jan', '--surname', 'Bakker', '--rows', '5', '--offset', '10', '--json'],
      cacheDir,
      fetchImpl
    );
    expect(s1.exitCode).toBe(0);
    expect((JSON.parse(s1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    // 3. Known archieven.nl viewer URL skips HTML, retries disconnect, downloads files.archieven.nl.
    const outFiles = path.join(cacheDir, 'zar-files.jpg');
    const d1 = await invokeOpenarchieven(
      ['download', 'zar:zar-files-1', outFiles, '--json'],
      cacheDir,
      fetchImpl
    );
    expect(d1.exitCode).toBe(0);
    const d1Body = JSON.parse(d1.stdout) as {
      cache_hit: boolean;
      files: Array<{ url: string }>;
    };
    expect(d1Body.cache_hit).toBe(false);
    expect(d1Body.files[0].url).toBe('http://files.archieven.nl/php/show_file.php?adt_id=239&file=demo.jpg');
    expect(fs.readFileSync(outFiles)).toEqual(JPEG_ONE);
    expect(protoAttempts).toBe(2);

    // 4. hdl.handle.net + proxy.archieven.nl/thumb upgrades to /download/ full-res, falls back on 404.
    const outProxy = path.join(cacheDir, 'zar-proxy.jpg');
    const d2 = await invokeOpenarchieven(
      ['download', 'zar:zar-proxy-1', '--out', outProxy, '--json'],
      cacheDir,
      fetchImpl
    );
    expect(d2.exitCode).toBe(0);
    expect((JSON.parse(d2.stdout) as { files: Array<{ url: string }> }).files[0].url).toBe(
      'https://proxy.archieven.nl/download/239/AABBCCDD'
    );
    expect(fs.readFileSync(outProxy)).toEqual(JPEG_TWO);

    failFullProxy = true;
    const d2Fb = await invokeOpenarchieven(
      ['download', 'zar:zar-proxy-1', '--out', outProxy, '--refresh', '--json'],
      cacheDir,
      fetchImpl
    );
    expect(d2Fb.exitCode).toBe(0);
    expect((JSON.parse(d2Fb.stdout) as { files: Array<{ url: string }> }).files[0].url).toBe(
      'https://proxy.archieven.nl/thumb/239/AABBCCDD'
    );
    expect(fs.readFileSync(outProxy)).toEqual(JPEG_ONE);

    // 5. Unknown host returning HTML on a2a_Uri falls back to a2a_UriPreview JPEG without caching HTML.
    const outUnk = path.join(cacheDir, 'unk.jpg');
    const d3 = await invokeOpenarchieven(
      ['download', 'bhi:unk-html-1', '--out', outUnk, '--json'],
      cacheDir,
      fetchImpl
    );
    expect(d3.exitCode).toBe(0);
    expect((JSON.parse(d3.stdout) as { files: Array<{ url: string }> }).files[0].url).toBe(
      'https://images.example/scan-42.jpg'
    );
    expect(fs.readFileSync(outUnk)).toEqual(JPEG_ONE);

    // 6. Direct IIIF .jp2 URL upgrades to .jpg and caches cleanly (miss -> hit).
    const outDirect = path.join(cacheDir, 'direct.jpg');
    const directIn = 'https://images.memorix.nl/bhic/iiif/demo/full/full/0/default.jp2';
    const d4 = await invokeOpenarchieven(
      ['download', directIn, '--out', outDirect, '--json'],
      cacheDir,
      fetchImpl
    );
    const d5 = await invokeOpenarchieven(
      ['download', directIn, '--out', outDirect, '--json'],
      cacheDir,
      fetchImpl
    );
    expect(d4.exitCode).toBe(0);
    expect(d5.exitCode).toBe(0);
    expect((JSON.parse(d4.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(d5.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(fs.readFileSync(outDirect)).toEqual(JPEG_TWO);
  });

  it('16. url subcommand generates offline record and search URLs', async () => {
    const cacheDir = await makeTempDir();
    const failFetch: typeof fetch = async () => {
      throw new Error('url command should be offline');
    };

    const recUrl = await invokeOpenarchieven(['url', '--record', `bhi:${RECORD_REF}`], cacheDir, failFetch);
    const searchUrl = await invokeOpenarchieven(
      ['url', '--name', 'Jan Jansen', '--year', '1853', '--place', 'Zundert'],
      cacheDir,
      failFetch
    );
    const missing = await invokeOpenarchieven(['url'], cacheDir, failFetch);

    expect(recUrl.exitCode).toBe(0);
    expect(recUrl.stdout).toBe(`https://www.openarchieven.nl/bhi:${RECORD_REF}`);
    expect(searchUrl.exitCode).toBe(0);
    expect(searchUrl.stdout).toBe(
      'https://www.openarchieven.nl/search.php?name=Jan+Jansen+1853&eventplace=Zundert'
    );
    expect(missing.exitCode).toBe(2);
  });
});
