import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../runtime/index.js';
import { hasPageLink, parseGrid, runNjArchivesCommand, searchPortal } from './nj-archives.js';

const INDEX_HTML =
  '<form action="./index.aspx">' + '<input type="hidden" name="__VIEWSTATE" value="vs_idx" />' + '</form>';

const SEARCH_FORM_HTML =
  '<form action="./DeathIndex1848.aspx">' +
  '<input type="hidden" name="__VIEWSTATE" value="vs_form" />' +
  '<select name="ctl00$ContentPlaceHolder1$ddlCountyList">' +
  '<option value="">All</option>' +
  '<option value="Hunterdon">Hunterdon</option>' +
  '<option value="Mercer">Mercer</option>' +
  '</select>' +
  '</form>';

const ONE_PAGE_RESULT_HTML =
  '<form action="./DeathIndex1848.aspx">' +
  '<input type="hidden" name="__VIEWSTATE" value="vs_res1" />' +
  '<table id="ctl00_ContentPlaceHolder1_GridView1">' +
  '<tr><th>Name</th><th>County</th><th>Date</th></tr>' +
  '<tr><td>Lincoln, A.</td><td>Hunterdon County</td><td>April 1865</td></tr>' +
  '</table>' +
  '</form>';

const LAND_FORM_HTML =
  '<form action="./EarlyLandRecords.aspx">' +
  '<input type="hidden" name="__VIEWSTATE" value="vs_land" />' +
  '</form>';

const LAND_RESULT_HTML =
  '<form action="./EarlyLandRecords.aspx">' +
  '<input type="hidden" name="__VIEWSTATE" value="vs_land_res" />' +
  '<table id="ctl00_ContentPlaceHolder1_GridView1">' +
  '<tr><th>Name</th></tr>' +
  '<tr><td>Smith, John</td></tr>' +
  '</table>' +
  '</form>';

const MONMOUTH_FORM_HTML =
  '<form action="./ASearch.aspx">' + '<input type="hidden" name="__VIEWSTATE" value="vs_mon" />' + '</form>';

const MONMOUTH_RESULT_HTML =
  '<table id="ctl00_ContentPlaceHolder1_dgdArcSearch">' +
  '<tr><td>Name</td><td>Town</td><td>Page</td></tr>' +
  '<tr><td>Alder, Samuel</td><td>Freehold</td>' +
  '<td><a href="javascript:PopUpBig(&#39;/oprs/Archives/pages/p12.pdf&#39;)">12</a></td></tr>' +
  '</table>';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-nj-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeNj(
  args: readonly string[],
  cacheDir: string,
  fetchImpl?: typeof fetch
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_NJ_ARCHIVES_CACHE_DIR: cacheDir },
    fetchImpl:
      fetchImpl ??
      (async () => {
        throw new Error('unexpected network call');
      }),
    sleepFn: async () => {},
  });
  const outcome = await runNjArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('nj-archives pagination, retries, and grid parsing', () => {
  it('stops pagination cleanly when no Page$2 link exists and matches County suffix', async () => {
    const postedEvents: [string, string][] = [];

    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(INDEX_HTML, { status: 200 });
      }
      const body = String(init?.body ?? '');
      if (body.includes('lbtnColonialMarriages')) {
        return new Response(SEARCH_FORM_HTML, { status: 200 });
      }
      if (body.includes('Page%242') || body.includes('Page$2')) {
        postedEvents.push(['page2', body]);
        return new Response('ASP.NET EventValidation error', { status: 500 });
      }
      postedEvents.push(['search', body]);
      return new Response(ONE_PAGE_RESULT_HTML, { status: 200 });
    };

    const ctx = createRecordContext({ fetchImpl, sleepFn: async () => {} });
    const result = await searchPortal(
      ctx,
      'deaths-1848-1878',
      { surname: 'Lincoln', county: 'hunterdon county' },
      3
    );

    expect(postedEvents.map((ev) => ev[0])).toEqual(['search']);
    expect(postedEvents[0][1]).toContain('ddlCountyList=Hunterdon');
    expect(result.pages_read).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].Name).toBe('Lincoln, A.');
  });

  it('retries once on transient 500 and recovers', async () => {
    let searchPosts = 0;

    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(INDEX_HTML, { status: 200 });
      }
      const body = String(init?.body ?? '');
      if (body.includes('lbtnColonialMarriages')) {
        return new Response(SEARCH_FORM_HTML, { status: 200 });
      }
      searchPosts += 1;
      if (searchPosts === 1) {
        return new Response('Transient IIS 500', { status: 500 });
      }
      return new Response(ONE_PAGE_RESULT_HTML, { status: 200 });
    };

    const ctx = createRecordContext({ fetchImpl, sleepFn: async () => {} });
    const result = await searchPortal(ctx, 'deaths-1848-1878', { surname: 'Lincoln' }, 1);
    expect(searchPosts).toBe(2);
    expect(result.rows).toHaveLength(1);
  });

  it('skips multi-cell GridView pager rows and detects Page$ links', () => {
    const htmlWithPager =
      '<table id="ctl00_ContentPlaceHolder1_GridView1">' +
      '<tr><th>Name</th><th>Year</th></tr>' +
      '<tr><td>Smith, John</td><td>1862</td></tr>' +
      '<tr>' +
      '<td><span>1</span></td>' +
      '<td><a href="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$GridView1&#39;,&#39;Page$2&#39;)">2</a></td>' +
      '<td><a href="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$GridView1&#39;,&#39;Page$3&#39;)">3</a></td>' +
      '</tr>' +
      '</table>';

    const [headers, rows] = parseGrid(htmlWithPager, 'GridView1');
    expect(headers).toEqual(['Name', 'Year']);
    expect(rows).toHaveLength(1);
    expect(rows[0].Name).toBe('Smith, John');
    expect(hasPageLink(htmlWithPager, 2)).toBe(true);
    expect(hasPageLink(htmlWithPager, 4)).toBe(false);
  });
});

describe('nj-archives cache, aliases, monmouth, and url', () => {
  function makePortalFetch(searchBodies: string[]): typeof fetch {
    return async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(INDEX_HTML, { status: 200 });
      }
      const body = String(init?.body ?? '');
      if (body.includes('lbtnColonialMarriages')) {
        return new Response(LAND_FORM_HTML, { status: 200 });
      }
      searchBodies.push(body);
      return new Response(LAND_RESULT_HTML, { status: 200 });
    };
  }

  it('serves repeat search from disk cache with [cache] text marker', async () => {
    const cacheDir = await makeTempDir();
    const searches: string[] = [];
    const fetchImpl = makePortalFetch(searches);

    const first = await invokeNj(['search', 'land', '--surname', 'Smith', '--json'], cacheDir, fetchImpl);
    const second = await invokeNj(['search', 'land', '--surname', 'Smith', '--json'], cacheDir, fetchImpl);
    const textHit = await invokeNj(['search', 'land', '--surname', 'Smith'], cacheDir, fetchImpl);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(textHit.exitCode).toBe(0);
    expect(searches).toHaveLength(1);
    expect((JSON.parse(first.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    const p2 = JSON.parse(second.stdout) as { cache_hit: boolean; rows: { Name: string }[] };
    expect(p2.cache_hit).toBe(true);
    expect(second.cacheHit).toBe(true);
    expect(p2.rows[0].Name).toBe('Smith, John');
    expect(textHit.stdout).toContain('[cache]');
  });

  it('bypasses cache on --refresh and distinct criteria (--pages)', async () => {
    const cacheDir = await makeTempDir();
    const searches: string[] = [];
    const fetchImpl = makePortalFetch(searches);

    await invokeNj(['search', 'land', '--surname', 'Smith'], cacheDir, fetchImpl);
    await invokeNj(['search', 'land', '--surname', 'Smith', '--refresh'], cacheDir, fetchImpl);
    await invokeNj(['search', 'land', '--surname', 'Smith', '--pages', '2'], cacheDir, fetchImpl);

    expect(searches).toHaveLength(3);
  });

  it('resolves database aliases and suggests close matches without network calls', async () => {
    const cacheDir = await makeTempDir();
    const targets: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(INDEX_HTML, { status: 200 });
      }
      const body = String(init?.body ?? '');
      if (body.includes('lbtnColonialMarriages')) {
        targets.push(body);
        return new Response(LAND_FORM_HTML, { status: 200 });
      }
      return new Response(LAND_RESULT_HTML, { status: 200 });
    };

    for (const typed of ['marriages-colonial', 'marriage-colonial', 'Colonial_Marriages']) {
      const res = await invokeNj(['search', typed, '--surname', 'Lincoln'], cacheDir, fetchImpl);
      expect(res.exitCode).toBe(0);
    }
    expect(targets).toHaveLength(1);
    expect(targets[0]).toContain('GridView1%24ctl02%24lbtnColonialMarriages');

    const bad = await invokeNj(['search', 'colonial-mariages', '--surname', 'Lincoln'], cacheDir);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('Did you mean: colonial-marriages');
  });

  it('allows spouse-only search on marriage databases and enforces surname + flag aliases elsewhere', async () => {
    const cacheDir = await makeTempDir();
    const searches: string[] = [];
    const fetchImpl = makePortalFetch(searches);

    const spouseOnly = await invokeNj(
      ['search', 'colonial-marriages', '--spouse-surname', 'Lincoln', '--spouse-given', 'Mary'],
      cacheDir,
      fetchImpl
    );
    expect(spouseOnly.exitCode).toBe(0);
    expect(searches[0]).toContain('txtBRLN=Lincoln');
    expect(searches[0]).toContain('txtBRFN=Mary');

    const missing = await invokeNj(['search', 'land', '--given', 'John'], cacheDir);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('--surname');

    const ok = await invokeNj(['search', 'land', '--last', 'Smith', '--first', 'John'], cacheDir, fetchImpl);
    expect(ok.exitCode).toBe(0);
    expect(searches[1]).toContain('txtLN=Smith');
    expect(searches[1]).toContain('txtFN=John');
  });

  it('refuses order-only databases with URL and supports monmouth + url commands', async () => {
    const cacheDir = await makeTempDir();

    const orderOnly = await invokeNj(['search', 'probate', '--surname', 'Smith'], cacheDir);
    expect(orderOnly.exitCode).toBe(2);
    expect(orderOnly.stderr).toContain('ProbateRecordRequest.aspx');

    let monmouthPosts = 0;
    const monmouthFetch: typeof fetch = async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(MONMOUTH_FORM_HTML, { status: 200 });
      }
      monmouthPosts += 1;
      const body = String(init?.body ?? '');
      expect(body).toContain('ddlTown=Freehold');
      expect(body).toContain('txtName=Alder');
      return new Response(MONMOUTH_RESULT_HTML, { status: 200 });
    };

    const m1 = await invokeNj(
      ['monmouth', '--surname', 'Alder', '--town', 'freehold', '--json'],
      cacheDir,
      monmouthFetch
    );
    const m2 = await invokeNj(
      ['monmouth', '--surname', 'Alder', '--town', 'Freehold', '--json'],
      cacheDir,
      monmouthFetch
    );
    expect([m1.exitCode, m2.exitCode]).toEqual([0, 0]);
    expect(monmouthPosts).toBe(1);
    const mp1 = JSON.parse(m1.stdout) as {
      rows: { Name: string; links: { href: string }[] }[];
      cache_hit: boolean;
    };
    expect(mp1.cache_hit).toBe(false);
    expect(mp1.rows[0].Name).toBe('Alder, Samuel');
    expect(mp1.rows[0].links).toContainEqual({
      text: 'census page image',
      href: 'https://oprs.co.monmouth.nj.us/oprs/Archives/pages/p12.pdf',
    });
    expect((JSON.parse(m2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);

    const urlAll = await invokeNj(['url'], cacheDir);
    expect(urlAll.exitCode).toBe(0);
    expect(urlAll.stdout).toContain('index.aspx');
    expect(urlAll.stdout).toContain('ASearch.aspx');

    const urlLand = await invokeNj(['url', 'land'], cacheDir);
    expect(urlLand.exitCode).toBe(0);
    expect(urlLand.stdout).toBe('https://wwwdnet-dos.nj.gov/DOS_ArchivesDBPortal/EarlyLandRecords.aspx');
  });
});
