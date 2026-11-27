import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext, RecordRuntimeError } from '../runtime/index.js';
import {
  GRAPHQL_URL,
  resolveSafeChild,
  runFindagraveCommand,
  runGraphqlQuery,
  safePhotoFilename,
  validatePhotoUrl,
} from './findagrave.js';

interface SamplePhoto {
  readonly id: string;
  readonly type: string;
  readonly caption: string;
  readonly path: string;
}

function sampleMemorial(
  mid: string,
  first = 'Abraham',
  last = 'Lincoln',
  photos: readonly SamplePhoto[] = []
): Record<string, unknown> {
  return {
    id: mid,
    name: [{ first, last, maiden: null }],
    birth: { date: { year: 1809, month: 2, day: 12, circa: false }, place: null },
    death: { date: { year: 1865, month: 4, day: 15, circa: false }, place: null },
    coordinates: { lat: 39.823216, lon: -89.655715 },
    cemetery: {
      id: '107259',
      names: [{ name: 'Oak Ridge Cemetery' }],
      memorialCount: 74982,
      coordinates: { lat: 39.8246994, lon: -89.6592026 },
      physicalAddress: { full: { value: '1441 Monument Avenue' } },
    },
    plot: 'Lincoln Tomb',
    inscription: null,
    bio: null,
    isVeteran: true,
    hasGravePhoto: true,
    hasPersonPhoto: true,
    dateCreated: '2000-01-01',
    dateModified: '2026-01-01',
    relationships: [],
    photos: { total: photos.length, photos: [...photos] },
  };
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

async function makeTempEnv(): Promise<{ cacheRoot: string; workDir: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'kinloom-fg-test-'));
  tempDirs.push(base);
  const cacheRoot = path.join(base, 'cache');
  const workDir = path.join(base, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  return { cacheRoot, workDir };
}

interface InvokeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly bytesOut: number;
  readonly cacheHit?: boolean;
}

async function invokeFindagrave(
  args: readonly string[],
  options: {
    readonly cacheRoot: string;
    readonly cwd?: string;
    readonly fetchImpl: typeof fetch;
    readonly sleepFn?: (ms: number) => Promise<void>;
    readonly envExtra?: Record<string, string>;
  }
): Promise<InvokeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    cwd: options.cwd ?? options.cacheRoot,
    env: {
      KINLOOM_FINDAGRAVE_CACHE_DIR: options.cacheRoot,
      ...options.envExtra,
    },
    fetchImpl: options.fetchImpl,
    sleepFn: options.sleepFn ?? (async () => {}),
  });
  const outcome = await runFindagraveCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    bytesOut: outcome.bytesOut,
    cacheHit: outcome.cacheHit,
  };
}

function parseGqlBody(init?: RequestInit): { query: string; variables: Record<string, unknown> } {
  const raw = typeof init?.body === 'string' ? init.body : '';
  return JSON.parse(raw) as { query: string; variables: Record<string, unknown> };
}

function gqlJsonResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('findagrave native client', () => {
  it('1. get and memorial alias emit cemetery coordinates', async () => {
    const { cacheRoot } = await makeTempEnv();
    const fetchImpl: typeof fetch = async () =>
      gqlJsonResponse({ memorialsById: [sampleMemorial('627')] });

    for (const subcmd of ['get', 'memorial']) {
      const res = await invokeFindagrave([subcmd, '627', '--json'], { cacheRoot, fetchImpl });
      expect(res.exitCode, res.stderr).toBe(0);
      const payload = JSON.parse(res.stdout) as Array<{
        cemetery_lat: number;
        cemetery_lng: number;
        cemetery: { lat: number; lng: number };
      }>;
      expect(payload[0].cemetery_lat).toBe(39.8246994);
      expect(payload[0].cemetery_lng).toBe(-89.6592026);
      expect(payload[0].cemetery.lat).toBe(39.8246994);
      expect(payload[0].cemetery.lng).toBe(-89.6592026);
    }
  });

  it('2. cemetery accepts positional id and emits coordinates', async () => {
    const { cacheRoot } = await makeTempEnv();
    const seenVars: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const { variables } = parseGqlBody(init);
      seenVars.push(variables);
      return gqlJsonResponse({
        cemeteries: {
          total: 1,
          cemeteries: [
            {
              id: '107259',
              names: [{ name: 'Oak Ridge Cemetery' }],
              memorialCount: 74982,
              coordinates: { lat: 39.8246994, lon: -89.6592026 },
            },
          ],
        },
      });
    };

    const res = await invokeFindagrave(['cemetery', '107259', '--json'], { cacheRoot, fetchImpl });
    expect(res.exitCode, res.stderr).toBe(0);
    expect(seenVars[0]).toEqual({ ids: ['107259'] });
    const payload = JSON.parse(res.stdout) as {
      cemeteries: Array<{ lat: number; lng: number }>;
    };
    expect(payload.cemeteries[0].lat).toBe(39.8246994);
    expect(payload.cemeteries[0].lng).toBe(-89.6592026);
  });

  it('3. memorial cache zero HTTP, partial batch, and --refresh', async () => {
    const { cacheRoot } = await makeTempEnv();
    const gqlCalls: Record<string, unknown>[] = [];
    let rev = 1;

    const fetchImpl: typeof fetch = async (_input, init) => {
      const { variables } = parseGqlBody(init);
      gqlCalls.push(variables);
      const ids = Array.isArray(variables.ids) ? (variables.ids as string[]) : [];
      const items: Record<string, unknown>[] = [];
      for (const mid of ids) {
        if (mid === '627') {
          items.push(sampleMemorial('627', `Abraham v${rev}`, 'Lincoln'));
        } else if (mid === '628') {
          items.push(sampleMemorial('628', 'Mary', 'Lincoln'));
        }
      }
      return gqlJsonResponse({ memorialsById: items });
    };

    const r1 = await invokeFindagrave(['get', '627', '--json'], { cacheRoot, fetchImpl });
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect(Array.isArray(JSON.parse(r1.stdout))).toBe(true);
    expect(gqlCalls).toHaveLength(1);
    expect(fs.statSync(path.join(cacheRoot, 'memorials', '627.json')).isFile()).toBe(true);

    // Second call via alias makes ZERO GraphQL requests.
    const r2 = await invokeFindagrave(['memorial', '627', '--json'], { cacheRoot, fetchImpl });
    expect(r2.exitCode, r2.stderr).toBe(0);
    expect(gqlCalls).toHaveLength(1);
    const p2 = JSON.parse(r2.stdout) as Array<{ name: Array<{ first: string }> }>;
    expect(p2[0].name[0].first).toBe('Abraham v1');

    // Batch of [627, 628] fetches ONLY 628 and preserves order.
    const r3 = await invokeFindagrave(['get', '627', '628', '--json'], { cacheRoot, fetchImpl });
    expect(r3.exitCode, r3.stderr).toBe(0);
    expect(gqlCalls).toHaveLength(2);
    expect(gqlCalls[1]).toEqual({ ids: ['628'] });
    const batch = JSON.parse(r3.stdout) as Array<{ id: string }>;
    expect(batch.map((m) => m.id)).toEqual(['627', '628']);

    // --refresh bypasses cache and updates disk entry.
    rev = 2;
    const r4 = await invokeFindagrave(['get', '627', '--refresh', '--json'], {
      cacheRoot,
      fetchImpl,
    });
    expect(r4.exitCode, r4.stderr).toBe(0);
    expect(gqlCalls).toHaveLength(3);
    const p4 = JSON.parse(r4.stdout) as Array<{ name: Array<{ first: string }> }>;
    expect(p4[0].name[0].first).toBe('Abraham v2');
  });

  it('4. cemetery cache zero HTTP and --refresh', async () => {
    const { cacheRoot } = await makeTempEnv();
    const gqlCalls: Record<string, unknown>[] = [];
    let rev = 1;

    const fetchImpl: typeof fetch = async (_input, init) => {
      const { variables } = parseGqlBody(init);
      gqlCalls.push(variables);
      return gqlJsonResponse({
        cemeteries: {
          total: 1,
          cemeteries: [
            {
              id: '107259',
              names: [{ name: `Oak Ridge Cemetery v${rev}` }],
              memorialCount: 74982,
              coordinates: { lat: 39.8246994, lon: -89.6592026 },
            },
          ],
        },
      });
    };

    const r1 = await invokeFindagrave(['cemetery', '107259', '--json'], { cacheRoot, fetchImpl });
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect(gqlCalls).toHaveLength(1);
    expect(fs.statSync(path.join(cacheRoot, 'cemeteries', '107259.json')).isFile()).toBe(true);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    // Second call makes ZERO GraphQL requests.
    const r2 = await invokeFindagrave(['cemetery', '107259', '--json'], { cacheRoot, fetchImpl });
    expect(r2.exitCode, r2.stderr).toBe(0);
    expect(gqlCalls).toHaveLength(1);
    const p2 = JSON.parse(r2.stdout) as {
      cache_hit: boolean;
      cemeteries: Array<{ names: Array<{ name: string }> }>;
    };
    expect(p2.cache_hit).toBe(true);
    expect(p2.cemeteries[0].names[0].name).toBe('Oak Ridge Cemetery v1');

    // --refresh fetches fresh cemetery JSON.
    rev = 2;
    const r3 = await invokeFindagrave(['cemetery', '107259', '--refresh', '--json'], {
      cacheRoot,
      fetchImpl,
    });
    expect(r3.exitCode, r3.stderr).toBe(0);
    expect(gqlCalls).toHaveLength(2);
    const p3 = JSON.parse(r3.stdout) as {
      cemeteries: Array<{ names: Array<{ name: string }> }>;
    };
    expect(p3.cemeteries[0].names[0].name).toBe('Oak Ridge Cemetery v2');
  });

  it('5. photo caches files across dirs and prefixes with zero HTTP', async () => {
    const { cacheRoot, workDir } = await makeTempEnv();
    const gqlCalls: Record<string, unknown>[] = [];
    const httpCalls: string[] = [];
    let imgRev = 1;

    const photoMeta: SamplePhoto[] = [
      {
        id: '9901',
        type: 'Grave',
        caption: 'Headstone',
        path: 'https://images.findagrave.com/photos/9901.jpg?size=full',
      },
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        gqlCalls.push(parseGqlBody(init).variables);
        return gqlJsonResponse({ memorialsById: [sampleMemorial('627', 'Abraham', 'Lincoln', photoMeta)] });
      }
      httpCalls.push(url);
      const body = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.from(`JPEG-BYTES-v${imgRev}`),
      ]);
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };

    const out1 = path.join(workDir, 'bio-a');
    const out2 = path.join(workDir, 'bio-b');
    const out3 = path.join(workDir, 'bio-refresh');

    const r1 = await invokeFindagrave(
      ['photo', '627', '--out', out1, '--prefix', 'lincoln-abraham', '--metadata'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect(gqlCalls).toHaveLength(1);
    expect(httpCalls).toHaveLength(1);
    expect(fs.statSync(path.join(cacheRoot, 'photos', '627', '9901.jpg')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(out1, 'lincoln-abraham_9901.jpg'))).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('JPEG-BYTES-v1')])
    );

    // Different --out and --prefix reuses BOTH memorial and photo caches -> ZERO HTTP requests.
    const r2 = await invokeFindagrave(
      ['photo', '627', '--out', out2, '--prefix', 'lincoln-mary'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(r2.exitCode, r2.stderr).toBe(0);
    expect(gqlCalls).toHaveLength(1);
    expect(httpCalls).toHaveLength(1);
    expect(fs.readFileSync(path.join(out2, 'lincoln-mary_9901.jpg'))).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('JPEG-BYTES-v1')])
    );

    // --refresh bypasses both memorial and photo caches.
    imgRev = 2;
    const r3 = await invokeFindagrave(['photo', '627', '--out', out3, '--refresh'], {
      cacheRoot,
      cwd: workDir,
      fetchImpl,
    });
    expect(r3.exitCode, r3.stderr).toBe(0);
    expect(gqlCalls).toHaveLength(2);
    expect(httpCalls).toHaveLength(2);
    expect(fs.readFileSync(path.join(out3, '9901.jpg'))).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('JPEG-BYTES-v2')])
    );
  });

  it('6. photo json cache_hit, refresh, ttl, html/empty rejection, and .type sidecar', async () => {
    const { cacheRoot, workDir } = await makeTempEnv();
    const gqlCalls: Record<string, unknown>[] = [];
    const httpCalls: string[] = [];
    const okJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('JPEG-OK')]);
    let mode: { body: Buffer; type: string } = { body: okJpeg, type: 'image/jpeg' };

    const photoMeta: SamplePhoto[] = [
      {
        id: '9901',
        type: 'Grave',
        caption: 'Headstone',
        path: 'https://images.findagrave.com/photos/9901.jpg',
      },
      {
        id: '9902',
        type: 'Portrait',
        caption: 'Portrait',
        path: 'https://images.findagrave.com/photos/9902.jpg',
      },
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        gqlCalls.push(parseGqlBody(init).variables);
        return gqlJsonResponse({ memorialsById: [sampleMemorial('700', 'Abraham', 'Lincoln', photoMeta)] });
      }
      httpCalls.push(url);
      return new Response(new Uint8Array(mode.body), {
        status: 200,
        headers: { 'content-type': mode.type },
      });
    };

    const out = path.join(workDir, 'photos-json');

    const first = await invokeFindagrave(
      ['photo', '700', '--out', out, '--type', 'Grave', '--json'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(first.exitCode, first.stderr).toBe(0);
    const firstBody = JSON.parse(first.stdout) as {
      memorial_id: string;
      cache_hit: boolean;
      files: Array<Record<string, unknown>>;
    };
    expect(firstBody.memorial_id).toBe('700');
    expect(firstBody.cache_hit).toBe(false);
    expect(gqlCalls).toHaveLength(1);
    expect(httpCalls).toHaveLength(1);
    expect(firstBody.files).toEqual([
      {
        id: '9901',
        type: 'Grave',
        caption: 'Headstone',
        url: 'https://images.findagrave.com/photos/9901.jpg',
        file: '9901.jpg',
        bytes: okJpeg.length,
        cache_hit: false,
      },
    ]);
    expect(fs.readFileSync(path.join(out, '9901.jpg'))).toEqual(okJpeg);

    const second = await invokeFindagrave(
      ['photo', '700', '--out', out, '--type', 'Grave', '--json'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(second.exitCode, second.stderr).toBe(0);
    const secondBody = JSON.parse(second.stdout) as {
      cache_hit: boolean;
      files: Array<{ cache_hit: boolean }>;
    };
    expect(secondBody.cache_hit).toBe(true);
    expect(secondBody.files[0].cache_hit).toBe(true);
    expect(gqlCalls).toHaveLength(1);
    expect(httpCalls).toHaveLength(1);

    const refreshed = await invokeFindagrave(
      ['photo', '700', '--out', out, '--type', 'Grave', '--json', '--refresh'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(refreshed.exitCode, refreshed.stderr).toBe(0);
    expect((JSON.parse(refreshed.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(gqlCalls).toHaveLength(2);
    expect(httpCalls).toHaveLength(2);

    const expired = await invokeFindagrave(
      ['photo', '700', '--out', out, '--type', 'Grave', '--json', '--cache-ttl-hours', '0'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(expired.exitCode, expired.stderr).toBe(0);
    expect((JSON.parse(expired.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(gqlCalls).toHaveLength(3);
    expect(httpCalls).toHaveLength(3);

    mode = {
      body: Buffer.from('<!DOCTYPE html><html><body>blocked</body></html>'),
      type: 'text/html',
    };
    const htmlOut = path.join(workDir, 'photos-html');
    const rejected = await invokeFindagrave(
      ['photo', '700', '--out', htmlOut, '--type', 'Portrait', '--json'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(rejected.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(cacheRoot, 'photos', '700', '9902.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(htmlOut, '9902.jpg'))).toBe(false);
    const rejectedBody = JSON.parse(rejected.stdout) as {
      memorial_id: string;
      files: unknown[];
      cache_hit: boolean;
    };
    expect(rejectedBody.memorial_id).toBe('700');
    expect(rejectedBody.files).toEqual([]);
    expect(rejectedBody.cache_hit).toBe(false);

    mode = { body: Buffer.alloc(0), type: 'image/jpeg' };
    const empty = await invokeFindagrave(
      ['photo', '700', '--out', htmlOut, '--type', 'Portrait', '--refresh'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(empty.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(cacheRoot, 'photos', '700', '9902.jpg'))).toBe(false);

    mode = { body: Buffer.from('portrait-bytes'), type: 'image/jpeg' };
    const typed = await invokeFindagrave(
      ['photo', '700', '--out', htmlOut, '--type', 'Portrait', '--json'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(typed.exitCode, typed.stderr).toBe(0);
    expect((JSON.parse(typed.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(fs.statSync(path.join(cacheRoot, 'photos', '700', '9902.jpg.type')).isFile()).toBe(true);

    const again = await invokeFindagrave(
      ['photo', '700', '--out', htmlOut, '--all', '--json'],
      { cacheRoot, cwd: workDir, fetchImpl }
    );
    expect(again.exitCode, again.stderr).toBe(0);
    const againBody = JSON.parse(again.stdout) as {
      cache_hit: boolean;
      files: Array<{ file: string }>;
    };
    expect(againBody.cache_hit).toBe(true);
    expect(againBody.files.map((item) => item.file)).toEqual(['9901.jpg', '9902.jpg']);
    expect(httpCalls).toHaveLength(6);
    expect(gqlCalls).toHaveLength(4);
  });

  it('7. id, prefix, and filename path safety', async () => {
    const { cacheRoot, workDir } = await makeTempEnv();
    const neverFetch: typeof fetch = async () => {
      throw new Error('should not fetch');
    };

    for (const badId of ['../627', '627/../../etc', '627\\bad', '..']) {
      expect((await invokeFindagrave(['get', badId], { cacheRoot, fetchImpl: neverFetch })).exitCode).not.toBe(0);
      expect((await invokeFindagrave(['cemetery', badId], { cacheRoot, fetchImpl: neverFetch })).exitCode).not.toBe(0);
      expect((await invokeFindagrave(['photo', badId], { cacheRoot, fetchImpl: neverFetch })).exitCode).not.toBe(0);
    }

    const badPrefix = await invokeFindagrave(
      ['photo', '627', '--prefix', '../escape', '--out', workDir],
      { cacheRoot, cwd: workDir, fetchImpl: neverFetch }
    );
    expect(badPrefix.exitCode).not.toBe(0);

    const safeName = safePhotoFilename('../../evil', 'https://example.com/pic.png?v=1');
    expect(safeName).not.toContain('/');
    expect(safeName).not.toContain('..');
    expect(safeName.endsWith('.png')).toBe(true);

    for (const unsafe of ['../escape', 'a/b.jpg', 'a\\b.jpg', '..', '', 'C:evil']) {
      expect(() => resolveSafeChild(cacheRoot, unsafe)).toThrow();
    }
  });

  it('8. search and subcommand aliases, URLs, get per-item cache_hit, and -h', async () => {
    const { cacheRoot } = await makeTempEnv();
    const seenVars: Record<string, unknown>[] = [];

    const fetchImpl: typeof fetch = async (_input, init) => {
      const { variables } = parseGqlBody(init);
      seenVars.push(variables);
      if (Array.isArray(variables.ids)) {
        const ids = variables.ids as string[];
        if (ids.length === 1 && ids[0] === '107259') {
          return gqlJsonResponse({
            cemeteries: {
              total: 1,
              cemeteries: [
                {
                  id: '107259',
                  names: [{ name: 'Oak Ridge Cemetery' }],
                  memorialCount: 10,
                },
              ],
            },
          });
        }
        return gqlJsonResponse({ memorialsById: ids.map((mid) => sampleMemorial(mid)) });
      }
      const s = (variables.s ?? {}) as Record<string, unknown>;
      if ('firstName' in s || 'lastName' in s) {
        return gqlJsonResponse({
          memorialSearch: { total: 1, memorials: [sampleMemorial('627')] },
        });
      }
      return gqlJsonResponse({
        locationsByTypeahead: {
          total: 1,
          locations: [
            { __typename: 'Location', id: 'city_1', names: [{ name: 'Springfield' }] },
          ],
        },
      });
    };

    // Positional full name + -n + --page + --death-range + cemetery URL + case-insensitive filter.
    const r1 = await invokeFindagrave(
      [
        'search',
        'Abraham',
        'Lincoln',
        '-n',
        '5',
        '--page',
        '2',
        '--death-year',
        '1865',
        '--death-range',
        '2',
        '--death-year-filter',
        'EXACT',
        '--cemetery',
        'https://www.findagrave.com/cemetery/107259/oak-ridge-cemetery',
        '--location',
        'city_1',
        '--json',
      ],
      { cacheRoot, fetchImpl }
    );
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    const sent = seenVars[seenVars.length - 1].s as Record<string, unknown>;
    expect(sent.firstName).toBe('Abraham');
    expect(sent.lastName).toBe('Lincoln');
    expect(sent.size).toBe(5);
    expect(sent.from).toBe(5);
    expect(sent.deathYearRange).toBe(2);
    expect(sent.deathYearFilter).toBe('exact');
    expect(sent.cemeteryIds).toEqual(['107259']);
    expect(sent.locationId).toBe('city_1');

    // Equivalent call using --first-name / --last-name / --rows / --offset hits cache.
    const r2 = await invokeFindagrave(
      [
        'search',
        '--first-name',
        'Abraham',
        '--last-name',
        'Lincoln',
        '--rows',
        '5',
        '--offset',
        '5',
        '--death-year',
        '1865',
        '--year-range',
        '2',
        '--death-year-filter',
        'exact',
        '--cemetery-id',
        '107259',
        '--location-id',
        'city_1',
        '--json',
      ],
      { cacheRoot, fetchImpl }
    );
    expect(r2.exitCode, r2.stderr).toBe(0);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(seenVars).toHaveLength(1);

    // get accepts full memorial URL and emits per-item boolean cache_hit while keeping list shape.
    const g1 = await invokeFindagrave(
      ['get', 'https://www.findagrave.com/memorial/627/abraham-lincoln', '--json'],
      { cacheRoot, fetchImpl }
    );
    expect(g1.exitCode, g1.stderr).toBe(0);
    const g1List = JSON.parse(g1.stdout) as Array<{ cache_hit: boolean }>;
    expect(Array.isArray(g1List)).toBe(true);
    expect(g1List[0].cache_hit).toBe(false);

    const g2 = await invokeFindagrave(['memorial', '627', '--json'], { cacheRoot, fetchImpl });
    expect(g2.exitCode, g2.stderr).toBe(0);
    const g2List = JSON.parse(g2.stdout) as Array<{ cache_hit: boolean }>;
    expect(g2List[0].cache_hit).toBe(true);

    // cemetery accepts full cemetery URL; place accepts positional name.
    const c1 = await invokeFindagrave(
      ['cemetery', 'https://www.findagrave.com/cemetery/107259/oak-ridge', '--json'],
      { cacheRoot, fetchImpl }
    );
    expect(c1.exitCode, c1.stderr).toBe(0);
    expect((JSON.parse(c1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    const pl1 = await invokeFindagrave(['place', 'Springfield', '-n', '5', '--json'], {
      cacheRoot,
      fetchImpl,
    });
    expect(pl1.exitCode, pl1.stderr).toBe(0);
    expect((JSON.parse(pl1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    // Invalid year filter exits 2 before making a GraphQL call.
    const before = seenVars.length;
    const bad = await invokeFindagrave(
      ['search', '--last', 'Lincoln', '--birth-year-filter', 'bogus'],
      { cacheRoot, fetchImpl }
    );
    expect(bad.exitCode).toBe(2);
    expect(seenVars).toHaveLength(before);

    // -h works on root CLI.
    const helpRes = await invokeFindagrave(['-h'], { cacheRoot, fetchImpl });
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain('Search and read Find a Grave');
  });

  it('9. gql retries 429, HTML, and timeout, and fails fast on 403', async () => {
    const futureDate = new Date(Date.now() + 2000).toUTCString();
    let attempts = 0;
    const sleeps: number[] = [];

    const flakyFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': futureDate },
        });
      }
      if (attempts === 2) {
        return new Response('<!DOCTYPE html><html><body>Temporary outage</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return gqlJsonResponse({ memorialSearch: { total: 1, memorials: [] } });
    };

    const ctx1 = createRecordContext({
      fetchImpl: flakyFetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    const data = await runGraphqlQuery(ctx1, 'query {}', {});
    expect(attempts).toBe(3);
    expect((data.memorialSearch as { total: number }).total).toBe(1);
    // 1 initial rate-limit sleep + 2 retry sleeps.
    expect(sleeps).toHaveLength(3);

    // Timeout / transport error recovers on retry.
    attempts = 0;
    sleeps.length = 0;
    const timeoutFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('ReadTimeout: slow');
      }
      return gqlJsonResponse({ ok: true });
    };
    const ctx2 = createRecordContext({
      fetchImpl: timeoutFetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(await runGraphqlQuery(ctx2, 'query {}', {})).toEqual({ ok: true });
    expect(attempts).toBe(2);

    // 403 Cloudflare fails fast with 0 retries.
    attempts = 0;
    sleeps.length = 0;
    const cf403Fetch: typeof fetch = async () => {
      attempts += 1;
      return new Response('challenge', { status: 403 });
    };
    const ctx3 = createRecordContext({
      fetchImpl: cf403Fetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(runGraphqlQuery(ctx3, 'query {}', {})).rejects.toThrow(RecordRuntimeError);
    expect(attempts).toBe(1);
  });

  it('10. photo retries 503 and truncated Content-Length, enforces host allowlist, aliases, and --out traversal guard', async () => {
    const { cacheRoot, workDir } = await makeTempEnv();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('HEADSTONE-OK')]);
    const photoMeta: SamplePhoto[] = [
      {
        id: '5501',
        type: 'Grave',
        caption: 'Stone',
        path: 'https://images.findagrave.com/photos/5501.jpg',
      },
    ];
    let attempts = 0;
    const sleeps: number[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === GRAPHQL_URL) {
        return gqlJsonResponse({
          memorialsById: [sampleMemorial('808', 'Abraham', 'Lincoln', photoMeta)],
        });
      }
      attempts += 1;
      if (attempts === 1) {
        return new Response('busy', { status: 503, headers: { 'Retry-After': '1' } });
      }
      if (attempts === 2) {
        return new Response(new Uint8Array(jpeg.subarray(0, 6)), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '500' },
        });
      }
      return new Response(new Uint8Array(jpeg), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) },
      });
    };

    const out = path.join(workDir, 'photos-alias');
    const res = await invokeFindagrave(
      [
        'photos',
        'https://www.findagrave.com/memorial/808/abraham-lincoln',
        '--out-dir',
        out,
        '--json',
      ],
      {
        cacheRoot,
        cwd: workDir,
        fetchImpl,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      }
    );
    expect(res.exitCode, res.stderr).toBe(0);
    const body = JSON.parse(res.stdout) as { memorial_id: string; cache_hit: boolean };
    expect(body.memorial_id).toBe('808');
    expect(body.cache_hit).toBe(false);
    expect(attempts).toBe(3);
    expect(fs.readFileSync(path.join(out, '5501.jpg'))).toEqual(jpeg);

    // Disallowed hosts and non-HTTPS URLs are refused without fetching.
    for (const badUrl of [
      'http://images.findagrave.com/photos/5501.jpg',
      'https://evil.example/photos/5501.jpg',
      'https://user@images.findagrave.com/photos/5501.jpg',
    ]) {
      expect(() => validatePhotoUrl(badUrl)).toThrow(RecordRuntimeError);
    }

    // Relative traversal in --out is refused.
    const badOut = await invokeFindagrave(['photo', '808', '--out', '../escape'], {
      cacheRoot,
      cwd: workDir,
      fetchImpl,
    });
    expect(badOut.exitCode).toBe(1);
    expect(badOut.stderr).toContain('Unsafe output directory');
  });

  it('11. show alias, search --given/--surname/--name/--born/--died/--birth-year-range/--death-year-range, and url aliases', async () => {
    const { cacheRoot } = await makeTempEnv();
    const seenVars: Record<string, unknown>[] = [];

    const fetchImpl: typeof fetch = async (_input, init) => {
      const { variables } = parseGqlBody(init);
      seenVars.push(variables);
      if (Array.isArray(variables.ids)) {
        const ids = variables.ids as string[];
        return gqlJsonResponse({ memorialsById: ids.map((mid) => sampleMemorial(mid)) });
      }
      return gqlJsonResponse({
        memorialSearch: { total: 1, memorials: [sampleMemorial('627')] },
      });
    };

    const rSearch = await invokeFindagrave(
      [
        'search',
        '--given',
        'Abraham',
        '--surname',
        'Lincoln',
        '--born',
        '1809',
        '--died',
        '1865',
        '--birth-year-range',
        '2',
        '--json',
      ],
      { cacheRoot, fetchImpl }
    );
    expect(rSearch.exitCode, rSearch.stderr).toBe(0);
    expect((JSON.parse(rSearch.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    const sent = seenVars[seenVars.length - 1].s as Record<string, unknown>;
    expect(sent.firstName).toBe('Abraham');
    expect(sent.lastName).toBe('Lincoln');
    expect(sent.birthYear).toBe(1809);
    expect(sent.deathYear).toBe(1865);
    expect(sent.birthYearRange).toBe(2);
    expect(sent.deathYearRange).toBe(2);

    // --name splits into the identical query and hits disk cache with zero new GraphQL calls.
    const rName = await invokeFindagrave(
      [
        'search',
        '--name',
        'Abraham Lincoln',
        '--birth',
        '1809',
        '--death',
        '1865',
        '--death-year-range',
        '2',
        '--json',
      ],
      { cacheRoot, fetchImpl }
    );
    expect(rName.exitCode, rName.stderr).toBe(0);
    expect((JSON.parse(rName.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(seenVars).toHaveLength(1);

    // show aliases get and shares the memorial disk cache.
    const s1 = await invokeFindagrave(['show', '627', '--json'], { cacheRoot, fetchImpl });
    const s2 = await invokeFindagrave(['get', '627', '--json'], { cacheRoot, fetchImpl });
    expect(s1.exitCode, s1.stderr).toBe(0);
    expect(s2.exitCode, s2.stderr).toBe(0);
    expect((JSON.parse(s1.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(false);
    expect((JSON.parse(s2.stdout) as Array<{ cache_hit: boolean }>)[0].cache_hit).toBe(true);
    expect(seenVars).toHaveLength(2);

    // url accepts --given/--surname/--born/--died.
    const u = await invokeFindagrave(
      ['url', '--given', 'Clara', '--surname', 'Barton', '--born', '1821', '--died', '1912'],
      { cacheRoot, fetchImpl }
    );
    expect(u.exitCode, u.stderr).toBe(0);
    expect(u.stdout).toContain('firstname=Clara&lastname=Barton&birthyear=1821&deathyear=1912');
  });

  it('supports findagrave memorial <id> alias sharing the get cache', async () => {
    const { cacheRoot } = await makeTempEnv();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return gqlJsonResponse({
        memorialsById: [sampleMemorial('627', 'Abraham', 'Lincoln')],
      });
    };

    const r1 = await invokeFindagrave(['memorial', '627', '--json'], { cacheRoot, fetchImpl });
    expect(r1.exitCode, r1.stderr).toBe(0);
    const parsed1 = JSON.parse(r1.stdout) as Array<{ id: string; cache_hit: boolean }>;
    expect(parsed1[0]?.id).toBe('627');
    expect(parsed1[0]?.cache_hit).toBe(false);
    expect(calls).toBe(1);

    const r2 = await invokeFindagrave(['memorial', '627', '--json'], { cacheRoot, fetchImpl });
    expect(r2.exitCode, r2.stderr).toBe(0);
    const parsed2 = JSON.parse(r2.stdout) as Array<{ cache_hit: boolean }>;
    expect(parsed2[0]?.cache_hit).toBe(true);
    expect(calls).toBe(1);
  });
});
