import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext, RecordRuntimeError } from '../runtime/index.js';
import {
  ALLOWED_TNA_HOSTS,
  runUkArchivesCommand,
  validateUkArchivesUrl,
} from './uk-archives.js';

const DISCOVERY_SEARCH_PAYLOAD = {
  count: 1,
  records: [
    {
      id: 'D123456',
      reference: 'PROB 11/200/15',
      title: 'Will of Thomas Lincoln of Hingham, Norfolk',
      description: 'Probate copy of will.',
      coveringDates: '1638',
      department: 'PROB',
      places: ['Hingham, Norfolk'],
      heldBy: ['The National Archives, Kew'],
    },
  ],
};

const DISCOVERY_DETAIL_PAYLOAD = {
  id: 'D123456',
  citableReference: 'PROB 11/200/15',
  coveringDates: '1638',
  scopeContent: { description: '<p>Will of Thomas Lincoln of Hingham, Norfolk.</p>' },
  heldBy: [{ xReferenceName: 'The National Archives, Kew' }],
  digitised: true,
  legalStatus: 'Public Record',
  catalogueLevel: 7,
};

const FREEREG_HOME_HTML =
  '<html><body><form><input name="authenticity_token" value="csrf-test-token-123" /></form></body></html>';

const FREEREG_RESULTS_HTML = `
<html><body><table><tbody>
  <tr id="fr_row_1">
    <td><a href="/search_records/fr_row_1">View 1</a></td>
    <td>Samuel LINCOLN</td>
    <td>Baptism</td>
    <td>24 Aug 1622</td>
    <td>Norfolk</td>
    <td>Hingham : St Andrew : Parish Register</td>
  </tr>
  <tr id="fr_row_2">
    <td><a href="/search_records/fr_row_2">View 2</a></td>
    <td>Edward LINCOLN</td>
    <td>Burial</td>
    <td>11 Feb 1639</td>
    <td>Norfolk</td>
    <td>Swanton Morley : All Saints : Parish Register</td>
  </tr>
</tbody></table></body></html>
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-uk-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeUk(
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
    env: { KINLOOM_UK_ARCHIVES_CACHE_DIR: cacheDir },
    fetchImpl,
    sleepFn: async () => {},
  });
  const outcome = await runUkArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('uk-archives native client', () => {
  it('caches discovery search and detail with zero repeat HTTP calls', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).includes('/details/')) {
        return new Response(JSON.stringify(DISCOVERY_DETAIL_PAYLOAD), { status: 200 });
      }
      return new Response(JSON.stringify(DISCOVERY_SEARCH_PAYLOAD), { status: 200 });
    };

    const rs1 = await invokeUk(
      ['discovery', 'search', 'Lincoln', '--collection', 'PROB 11', '--json'],
      cacheDir,
      fetchImpl
    );
    const rs2 = await invokeUk(
      ['discovery', 'search', 'Lincoln', '--collection', 'PROB 11', '--json'],
      cacheDir,
      fetchImpl
    );
    const rs3 = await invokeUk(
      ['discovery', 'search', 'Lincoln', '--collection', 'PROB 11'],
      cacheDir,
      fetchImpl
    );
    const rd1 = await invokeUk(['discovery', 'detail', 'D123456', '--json'], cacheDir, fetchImpl);
    const rd2 = await invokeUk(['discovery', 'inspect', 'D123456'], cacheDir, fetchImpl);

    expect(rs1.exitCode).toBe(0);
    expect(rs2.exitCode).toBe(0);
    expect(rs3.exitCode).toBe(0);
    expect(rd1.exitCode).toBe(0);
    expect(rd2.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect((JSON.parse(rs1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(rs2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(rs3.stdout).toContain('[cache]');
    expect((JSON.parse(rd1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(rd2.stdout).toContain('[cache]');
    expect(rd2.stdout).toContain('PROB 11/200/15');
  });

  it('caches FreeREG results and filters --place-contains locally', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(FREEREG_HOME_HTML, { status: 200 });
      }
      return new Response(FREEREG_RESULTS_HTML, { status: 200 });
    };

    const r1 = await invokeUk(
      ['freereg', 'search', '--surname', 'Lincoln', '--county', 'NFK', '--json'],
      cacheDir,
      fetchImpl
    );
    const r2 = await invokeUk(
      [
        'freereg',
        'search',
        '--surname',
        'Lincoln',
        '--county',
        'NFK',
        '--place-contains',
        'Hingham',
        '--json',
      ],
      cacheDir,
      fetchImpl
    );
    const r3 = await invokeUk(
      ['freereg', 'search', '--surname', 'Lincoln', '--county', 'NFK'],
      cacheDir,
      fetchImpl
    );

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect((JSON.parse(r1.stdout) as { returned: number }).returned).toBe(2);
    const d2 = JSON.parse(r2.stdout) as {
      cache_hit: boolean;
      returned: number;
      records: { persons: string }[];
    };
    expect(d2.cache_hit).toBe(true);
    expect(d2.returned).toBe(1);
    expect(d2.records[0].persons).toBe('Samuel LINCOLN');
    expect(r3.stdout).toContain('[cache]');
  });

  it('slices FreeREG --limit after --place-contains and reuses cache without limit in cache key', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(FREEREG_HOME_HTML, { status: 200 });
      }
      return new Response(FREEREG_RESULTS_HTML, { status: 200 });
    };

    const rAll = await invokeUk(
      ['freereg', 'search', '--surname', 'Lincoln', '--county', 'NFK', '--json'],
      cacheDir,
      fetchImpl
    );
    const rLimit = await invokeUk(
      ['freereg', 'search', '--surname', 'Lincoln', '--county', 'NFK', '--limit', '1', '--json'],
      cacheDir,
      fetchImpl
    );
    const rPlace = await invokeUk(
      [
        'freereg',
        'search',
        '--surname',
        'Lincoln',
        '--county',
        'NFK',
        '--place-contains',
        'Swanton',
        '--limit',
        '1',
        '--json',
      ],
      cacheDir,
      fetchImpl
    );
    const rBad = await invokeUk(
      ['freereg', 'search', '--surname', 'Lincoln', '--county', 'NFK', '--limit', '0'],
      cacheDir,
      fetchImpl
    );

    expect(rAll.exitCode).toBe(0);
    expect(rLimit.exitCode).toBe(0);
    expect(rPlace.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect((JSON.parse(rAll.stdout) as { returned: number; cache_hit: boolean }).returned).toBe(2);
    expect((JSON.parse(rAll.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    const limited = JSON.parse(rLimit.stdout) as {
      cache_hit: boolean;
      returned: number;
      records: { persons: string }[];
    };
    expect(limited.cache_hit).toBe(true);
    expect(limited.returned).toBe(1);
    expect(limited.records[0].persons).toBe('Samuel LINCOLN');

    const placed = JSON.parse(rPlace.stdout) as {
      cache_hit: boolean;
      returned: number;
      records: { persons: string }[];
    };
    expect(placed.cache_hit).toBe(true);
    expect(placed.returned).toBe(1);
    expect(placed.records[0].persons).toBe('Edward LINCOLN');

    expect(rBad.exitCode).toBe(2);
    const cacheFiles = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    expect(cacheFiles).toHaveLength(1);
    const stored = JSON.parse(fs.readFileSync(path.join(cacheDir, cacheFiles[0]), 'utf8')) as {
      query: Record<string, unknown>;
      result: Record<string, unknown>;
    };
    expect('limit' in stored.query).toBe(false);
    expect('cache_hit' in stored.result).toBe(false);
  });

  it('bypasses cache on --refresh and --cache-ttl-hours 0', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(DISCOVERY_SEARCH_PAYLOAD), { status: 200 });
    };

    await invokeUk(['discovery', 'search', 'Lincoln', '--json'], cacheDir, fetchImpl);
    const rRef = await invokeUk(
      ['discovery', 'search', 'Lincoln', '--refresh', '--json'],
      cacheDir,
      fetchImpl
    );
    const rTtl = await invokeUk(
      ['discovery', 'search', 'Lincoln', '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      fetchImpl
    );

    expect(calls).toBe(3);
    expect((JSON.parse(rRef.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(rTtl.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
  });

  it('never caches HTTP errors, missing CSRF token, or empty payloads', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    let step: 'http500' | 'freereg_no_token' | 'empty' | 'ok' = 'http500';

    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (step === 'http500') {
        return new Response('server error', { status: 500 });
      }
      if (step === 'freereg_no_token') {
        return new Response('<html>no token here</html>', { status: 200 });
      }
      if (step === 'empty') {
        return new Response(JSON.stringify({ count: 0, records: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(DISCOVERY_SEARCH_PAYLOAD), { status: 200 });
    };

    const r1 = await invokeUk(['discovery', 'search', 'Smith'], cacheDir, fetchImpl);
    step = 'freereg_no_token';
    const r2 = await invokeUk(['freereg', 'search', '--surname', 'Smith'], cacheDir, fetchImpl);
    step = 'empty';
    const r3 = await invokeUk(['discovery', 'search', 'Smith', '--json'], cacheDir, fetchImpl);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    step = 'ok';
    const r4 = await invokeUk(['discovery', 'search', 'Smith', '--json'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).not.toContain('Traceback');
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).not.toContain('Traceback');
    expect(r3.exitCode).toBe(0);
    expect((JSON.parse(r3.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(r4.exitCode).toBe(0);
    // 3 attempts on persistent 500 + 1 FreeREG GET + 1 empty + 1 ok = 6
    expect(calls).toBe(6);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('handles tna search/get caching, date expansion, department param, and collection filter', async () => {
    const cacheDir = await makeTempDir();
    const seenUrls: URL[] = [];
    const multiPayload = {
      count: 2,
      records: [
        {
          id: 'D980036',
          reference: 'PROB 11/44/39',
          title: 'Will of Richard Smith of Norfolk',
          description: 'Probate copy of will.',
          coveringDates: '04 February 1561',
          department: 'PROB',
          places: ['Norfolk'],
          heldBy: ['The National Archives, Kew'],
        },
        {
          id: 'C999999',
          reference: 'WARD 7/29/17',
          title: 'Inquisition post mortem',
          description: 'Non-PROB record that should be filtered out.',
          coveringDates: '1590',
          department: 'WARD',
          places: ['Norfolk'],
          heldBy: ['The National Archives, Kew'],
        },
      ],
    };
    const detailPayload = {
      id: 'D980036',
      citableReference: 'PROB 11/44/39',
      coveringDates: '04 February 1561',
      coveringFromDate: 15610204,
      coveringToDate: 15610204,
      scopeContent: {
        description:
          '<emph altrender="doctype">W</emph><persname>Richard Smith</persname><geogname>Norfolk</geogname>',
      },
      heldBy: [{ xReferenceName: 'The National Archives, Kew' }],
      digitised: true,
      legalStatus: 'Public Record(s)',
      catalogueLevel: 7,
      parentId: 'C1903347',
    };

    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      seenUrls.push(url);
      if (url.pathname.includes('/API/records/v1/details/D980036')) {
        return new Response(JSON.stringify(detailPayload), { status: 200 });
      }
      return new Response(JSON.stringify(multiPayload), { status: 200 });
    };

    const searchArgs = [
      'tna',
      'search',
      '--query',
      'Smith Norfolk',
      '--collection',
      'PROB 11',
      '--start-date',
      '1550',
      '--end-date',
      '1620',
      '--limit',
      '5',
      '--json',
    ];
    const s1 = await invokeUk(searchArgs, cacheDir, fetchImpl);
    const s2 = await invokeUk(searchArgs, cacheDir, fetchImpl);
    const g1 = await invokeUk(['tna', 'get', 'D980036', '--json'], cacheDir, fetchImpl);
    const g2 = await invokeUk(['tna', 'get', 'D980036', '--json'], cacheDir, fetchImpl);

    expect(s1.exitCode).toBe(0);
    expect(s2.exitCode).toBe(0);
    expect(g1.exitCode).toBe(0);
    expect(g2.exitCode).toBe(0);
    expect(seenUrls).toHaveLength(2);
    expect(seenUrls[0].searchParams.get('sps.dateFrom')).toBe('1550-01-01');
    expect(seenUrls[0].searchParams.get('sps.dateTo')).toBe('1620-12-31');
    expect(seenUrls[0].searchParams.get('sps.departments')).toBe('PROB');

    const body1 = JSON.parse(s1.stdout) as {
      cache_hit: boolean;
      returned: number;
      records: { reference: string; iaid: string }[];
    };
    const body2 = JSON.parse(s2.stdout) as { cache_hit: boolean };
    expect(body1.cache_hit).toBe(false);
    expect(body2.cache_hit).toBe(true);
    expect(body1.returned).toBe(1);
    expect(body1.records[0].reference).toBe('PROB 11/44/39');
    expect(body1.records[0].iaid).toBe('D980036');

    const det1 = JSON.parse(g1.stdout) as {
      cache_hit: boolean;
      citable_reference: string;
      description: string;
      parent_id: string;
    };
    const det2 = JSON.parse(g2.stdout) as { cache_hit: boolean };
    expect(det1.cache_hit).toBe(false);
    expect(det2.cache_hit).toBe(true);
    expect(det1.citable_reference).toBe('PROB 11/44/39');
    expect(det1.description).toBe('W Richard Smith Norfolk');
    expect(det1.parent_id).toBe('C1903347');
  });

  it('retries transient 429 with Retry-After and 503 responses', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
      }
      if (calls === 2) {
        return new Response('temporarily unavailable', { status: 503 });
      }
      return new Response(JSON.stringify(DISCOVERY_SEARCH_PAYLOAD), { status: 200 });
    };

    const res = await invokeUk(['tna', 'search', '--query', 'Smith', '--json'], cacheDir, fetchImpl);
    expect(res.exitCode).toBe(0);
    expect(calls).toBe(3);
    const payload = JSON.parse(res.stdout) as { cache_hit: boolean; returned: number };
    expect(payload.cache_hit).toBe(false);
    expect(payload.returned).toBe(1);
  });

  it('enforces TNA host allowlist, IAID validation, date ordering, and blocks off-host redirects', async () => {
    const cacheDir = await makeTempDir();
    const dummyFetch: typeof fetch = async () => new Response('', { status: 500 });

    const badIaid = await invokeUk(['tna', 'get', '../etc/passwd'], cacheDir, dummyFetch);
    expect(badIaid.exitCode).toBe(2);

    const badDates = await invokeUk(
      ['tna', 'search', '--query', 'Smith', '--start-date', '1620', '--end-date', '1550'],
      cacheDir,
      dummyFetch
    );
    expect(badDates.exitCode).toBe(2);

    expect(() =>
      validateUkArchivesUrl(
        'http://discovery.nationalarchives.gov.uk/API/search/v1/records',
        ALLOWED_TNA_HOSTS
      )
    ).toThrow(RecordRuntimeError);
    expect(() =>
      validateUkArchivesUrl('https://evil.example/API/search/v1/records', ALLOWED_TNA_HOSTS)
    ).toThrow(RecordRuntimeError);
    expect(() =>
      validateUkArchivesUrl(
        'https://user:pass@discovery.nationalarchives.gov.uk/API/search/v1/records',
        ALLOWED_TNA_HOSTS
      )
    ).toThrow(RecordRuntimeError);

    const redirectFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'discovery.nationalarchives.gov.uk') {
        return new Response(null, { status: 302, headers: { Location: 'https://evil.example/leak' } });
      }
      return new Response(JSON.stringify(DISCOVERY_SEARCH_PAYLOAD), { status: 200 });
    };

    const blocked = await invokeUk(['tna', 'search', '--query', 'Smith'], cacheDir, redirectFetch);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain('Refusing host');
  });

  it('prints portal URLs and help offline', async () => {
    const cacheDir = await makeTempDir();
    const dummyFetch: typeof fetch = async () => new Response('', { status: 500 });

    const u = await invokeUk(
      ['url', '--discovery', 'Lincoln', '--freereg', '--bho', 'Norfolk', '--genuki', 'kent'],
      cacheDir,
      dummyFetch
    );
    expect(u.exitCode).toBe(0);
    expect(u.stdout).toContain('https://discovery.nationalarchives.gov.uk/results/r?_q=Lincoln&_p=100');
    expect(u.stdout).toContain('https://www.freereg.org.uk/');
    expect(u.stdout).toContain('https://www.british-history.ac.uk/search?query=Norfolk');
    expect(u.stdout).toContain('https://www.genuki.org.uk/big/eng/KEN');

    const help = await invokeUk(['--help'], cacheDir, dummyFetch);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('kinloom uk-archives');
  });
});
