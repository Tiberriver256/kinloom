import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError } from '../../errors.js';
import {
  browserSearch,
  type CaArchivesOverrides,
  createCaArchivesCommand,
  runCaArchivesCommand,
} from './clients/ca-archives.js';
import {
  dedupeCalisphereLinks,
  dedupeOacLinks,
  extractOmekaTitle,
  extractOmekaTypes,
  formatSourceText,
  isNavigationContextDestroyed,
  isTimeoutFailure,
  parseExhibitsItemPayload,
  parseExhibitsSearchPayload,
  parsePortalItemHtml,
  parsePortalSearchHtml,
} from './clients/caArchives/domain.js';
import { DIGIHAKEMISTO_SEARCH_URL, HISKI_ENDPOINT, runFiArchivesCommand } from './clients/fi-archives.js';
import {
  ALLOWED_HISKI_HOSTS,
  encodeIso88591Form,
  getCacheDir as getFiCacheDir,
  hiskiMaxkpl,
  parseEventRef,
  parseArchiveId as parseFiArchiveId,
  validateFiUrl,
  validateYears,
} from './clients/fiArchives/domain.js';
import {
  parseDigihakemistoArchive,
  parseDigihakemistoSearch,
  parseHiskiEventDetail,
  parseHiskiResults,
} from './clients/fiArchives/parsers.js';
import { checkNotChallenged, resolveParishSpec } from './clients/fiArchives/transport.js';
import {
  a2aText,
  asList,
  deriveIiifJpegUrl,
  deriveProxyDownloadUrl,
  extractScans,
  fmtEventdate,
  formatA2aRecord,
  isSourceType,
  isViewerUrl,
  parseRecordRef,
  ScanImage,
  scanFilename,
  validateApiUrl,
  validateScanUrl,
} from './clients/openarchieven/domain.js';
import { downloadScanCandidates, readCachedScan } from './clients/openarchieven/transport.js';
import { runOpenarchievenCommand } from './clients/openarchieven.js';
import { runSeArchivesCommand } from './clients/se-archives.js';
import {
  buildIiifImageUrl,
  detectImageFormat,
  getCacheDir as getSeCacheDir,
  isIiifCollectionResult,
  isIiifManifestResult,
  isRegisterDetailResult,
  isSearchEndpointResult,
  looksLikeHtmlPayload,
  normalizeBildid,
  parseRegisterId,
  parseArchiveId as parseSeArchiveId,
  resolveSafeOutputPath,
  validatePaging,
  validateSeUrl,
  validateYearRange,
} from './clients/seArchives/domain.js';
import {
  allLangTexts,
  extractCanvasInfo,
  firstLangText,
  formatCollectionText,
  formatManifestText,
  formatRegisterDetailText,
  formatSearchText,
  normalizeSearchItem,
  parseIiifCollectionBody,
  parseIiifManifestBody,
} from './clients/seArchives/parsers.js';
import {
  checkStatus,
  formatPersonLine,
  jsonWithCacheHit,
  normalizeProfileKey,
  resolveSearchName,
} from './clients/wikitree/domain.js';
import { runWikitreeCommand } from './clients/wikitree.js';
import { BrowserTimeoutError, type OptionalBrowser } from './runtime/browser.js';
import { SsrfBlockedError } from './runtime/http.js';
import { createRecordContext } from './runtime/index.js';
import type { RecordCommandContext } from './runtime/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix = 'kinloom-c6a-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly stdout?: string[];
  readonly stderr?: string[];
}): RecordCommandContext {
  const stdout = options.stdout ?? [];
  const stderr = options.stderr ?? [];
  return createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: options.env ?? {},
    cwd: options.cwd,
    fetchImpl:
      options.fetchImpl ??
      (async () => {
        throw new Error('unexpected network call');
      }),
    sleepFn: options.sleepFn ?? (async () => {}),
    nowMs: options.nowMs,
  });
}

function jsonResp(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function bytesResp(bytes: Uint8Array, contentType: string, status = 200): Response {
  const copy = Uint8Array.from(bytes);
  return new Response(copy, {
    status,
    headers: { 'content-type': contentType },
  });
}

const JPEG_MAGIC = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF87_MAGIC = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
const GIF89_MAGIC = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_MAGIC = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const PDF_MAGIC = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const TIFF_LE_MAGIC = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
const TIFF_BE_MAGIC = Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x08]);
const JP2_BOX_MAGIC = Uint8Array.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20]);
const JP2_STREAM_MAGIC = Uint8Array.from([0xff, 0x4f, 0xff, 0x51, 0x00, 0x2f]);

// ============================================================================
// 1. fiArchives (HisKi & Digihakemisto)
// ============================================================================

describe('fiArchives behavioral edge cases', () => {
  const PARISH_LIST_BYTES = Buffer.from(
    `<HTML><BODY><SELECT NAME=srk>
<OPTION VALUE="0001">Ahlainen
<OPTION VALUE="0012">Anjala
<OPTION VALUE="0565">Turku - Åbo
<OPTION VALUE="0389">Oulu
</SELECT></BODY></HTML>`,
    'latin1'
  );

  const MULTI_BOOK_HISKI_HTML = `
<HTML><BODY>
<FONT SIZE="+2"><B>Anjala - christened</B></FONT>
<TABLE BORDER=1>
  <TR><TH>Born</TH><TH>Christened</TH><TH>Village</TH><TH>Farm</TH><TH>Father</TH><TH>Mother</TH><TH>Child</TH></TR>
  <TR><TD><a href="/hiski?en+0012+kastetut+101">1.2.1820</a></TD><TD>3.2.1820</TD><TD>Kylä</TD><TD>Talo</TD><TD>Matti Korhonen</TD><TD>Aino Laine</TD><TD>Mikko</TD></TR>
  <TR><TD></TD><TD COLSPAN=6>first note</TD></TR>
  <TR><TD></TD><TD COLSPAN=6>second note</TD></TR>
  <TR><TD><TABLE BORDER=1><TR><TD>nested ignored</TD></TR></TABLE></TD></TR>
</TABLE>
<FONT SIZE="+2"><B>Turku</B></FONT>
<TABLE BORDER=1>
  <TR><TD><a href="/hiski?en+0565+vihityt+202">10.5.1845</a></TD><TD>20.5.1845</TD><TD>Keskusta</TD><TD>1</TD><TD>Mikko Korhonen</TD><TD>Sanna Salonen</TD><TD>Satama</TD><TD>2</TD></TR>
  <TR><TD><a href="/hiski?en+0565+haudatut+303">4.9.1880</a></TD><TD>10.9.1880</TD><TD>Keskusta</TD><TD>1</TD><TD>Matti Korhonen</TD><TD>old age</TD><TD>78</TD><TD>2</TD><TD>1</TD><TD>3</TD></TR>
  <TR><TD><a href="/hiski?en+0565+smuutt+404">12.3.1850</a></TD><TD>15.3.1850</TD><TD>Keskusta</TD><TD>1</TD><TD>Mikko Korhonen</TD><TD>Oulu</TD></TR>
  <TR><TD><a href="/hiski?en+0565+umuutt+405">1.6.1852</a></TD><TD></TD><TD>Keskusta</TD><TD>1</TD><TD>Sanna Salonen</TD><TD>Anjala</TD></TR>
</TABLE>
<P>A total of 2 events found.</P>
<P>3 events found.</P>
</BODY></HTML>`;

  async function runFi(
    args: readonly string[],
    cacheDir: string,
    fetchImpl?: typeof fetch,
    envOverride?: NodeJS.ProcessEnv
  ): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx = makeCtx({
      stdout,
      stderr,
      env: envOverride ?? { KINLOOM_FI_ARCHIVES_CACHE_DIR: cacheDir },
      fetchImpl,
    });
    const out = await runFiArchivesCommand(args, ctx);
    return {
      exitCode: out.exitCode,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      cacheHit: out.cacheHit,
    };
  }

  it('validates domain helpers: URL checks, years, maxkpl buckets, refs, archive IDs, encoding, cache dirs', () => {
    expect(() => validateFiUrl('not-a-url', ALLOWED_HISKI_HOSTS)).toThrow(
      "Refusing malformed URL: 'not-a-url'"
    );
    expect(() => validateFiUrl('http://hiski.genealogia.fi/hiski', ALLOWED_HISKI_HOSTS)).toThrow(
      "Refusing non-HTTPS URL: 'http://hiski.genealogia.fi/hiski'"
    );
    expect(() => validateFiUrl('https://user:pass@hiski.genealogia.fi/hiski', ALLOWED_HISKI_HOSTS)).toThrow(
      'Refusing URL containing embedded credentials.'
    );

    expect(encodeIso88591Form({ a: 'Matti Korhonen', b: 'a-b.c_d~e', c: 'ok€' })).toBe(
      'a=Matti+Korhonen&b=a-b.c_d~e&c=ok'
    );

    expect(validateYears('1800', '1850')).toEqual(['1800', '1850']);
    expect(() => validateYears('18a0', undefined)).toThrow(
      "Invalid --from-year '18a0'; expected 4-digit YYYY."
    );
    expect(() => validateYears(undefined, '99')).toThrow("Invalid --to-year '99'; expected 4-digit YYYY.");
    expect(() => validateYears('1860', '1850')).toThrow('--from-year must not be greater than --to-year.');

    expect(hiskiMaxkpl(1)).toBe('15');
    expect(hiskiMaxkpl(30)).toBe('30');
    expect(hiskiMaxkpl(101)).toBe('250');
    expect(hiskiMaxkpl(1500)).toBe('1000');

    expect(parseEventRef('0001+married+12')).toEqual(['0001', 'vihityt', '12']);
    expect(parseEventRef('0001:buried:99')).toEqual(['0001', 'haudatut', '99']);
    expect(() => parseEventRef('https://hiski.genealogia.fi/hiski?en+A00')).toThrow(
      'Expected a HisKi event URL like https://hiski.genealogia.fi/hiski?en+0001+kastetut+418.'
    );

    expect(parseFiArchiveId('id:1299923671')).toBe('1299923671');
    expect(() => parseFiArchiveId('https://digihakemisto.net/other/123')).toThrow(
      "Expected https://digihakemisto.net/aineisto/<id>, got 'https://digihakemisto.net/other/123'."
    );

    const sharedCtx = makeCtx({ env: { KINLOOM_CACHE_DIR: '/tmp/shared-kinloom' } });
    expect(getFiCacheDir(sharedCtx)).toBe(path.resolve('/tmp/shared-kinloom', 'fi-archives'));
    const defaultCtx = makeCtx({ env: { HOME: '/tmp/home-kinloom' } });
    expect(getFiCacheDir(defaultCtx)).toBe(
      path.resolve('/tmp/home-kinloom', '.cache', 'kinloom', 'fi-archives')
    );
  });

  it('parses all HisKi book types, concatenated comments, summed totals, and Digihakemisto archive edge cases', () => {
    const parsed = parseHiskiResults(MULTI_BOOK_HISKI_HTML);
    expect(parsed.total_reported).toBe(5);
    expect(parsed.records).toHaveLength(5);
    expect(parsed.records[0]).toEqual({
      parish: 'Anjala',
      parish_code: '0012',
      book: 'christened',
      book_code: 'kastetut',
      row_id: '101',
      event_url: 'https://hiski.genealogia.fi/hiski?en+0012+kastetut+101',
      born: '1.2.1820',
      christened: '3.2.1820',
      village: 'Kylä',
      farm: 'Talo',
      father: 'Matti Korhonen',
      mother: 'Aino Laine',
      child: 'Mikko',
      comment: 'first note; second note',
    });
    expect(parsed.records[1]).toMatchObject({
      parish: 'Turku',
      book_code: 'vihityt',
      announced: '10.5.1845',
      married: '20.5.1845',
      groom: 'Mikko Korhonen',
      bride: 'Sanna Salonen',
      bride_village: 'Satama',
      bride_farm: '2',
    });
    expect(parsed.records[2]).toMatchObject({
      book_code: 'haudatut',
      died: '4.9.1880',
      buried: '10.9.1880',
      person: 'Matti Korhonen',
      cause: 'old age',
      age_years: '78',
      age_days: '3',
    });
    expect(parsed.records[3]).toMatchObject({
      book_code: 'smuutt',
      departure: '12.3.1850',
      arrival: '15.3.1850',
      person: 'Mikko Korhonen',
      other_place: 'Oulu',
    });
    expect(parsed.records[4]).toMatchObject({
      book_code: 'umuutt',
      departure: '1.6.1852',
      arrival: '',
      person: 'Sanna Salonen',
      other_place: 'Anjala',
    });

    const minimalDetail = parseHiskiEventDetail(
      `<HTML><BODY><H2>Oulu</H2><TABLE BORDER=4>
        <TR><TD>Child:</TD><TD>Aino</TD></TR>
        <TR><TD>Links</TD><TD>ignored</TD></TR>
      </TABLE></BODY></HTML>`,
      { parishCode: '0389', bookCode: 'kastetut', rowId: '77' }
    );
    expect(minimalDetail).toEqual({
      parish: 'Oulu',
      parish_code: '0389',
      book: 'christened',
      book_code: 'kastetut',
      row_id: '77',
      permalink_id: '',
      permalink_url: '',
      event_url: 'https://hiski.genealogia.fi/hiski?en+0389+kastetut+77',
      sshy_url: '',
      fields: { Child: 'Aino' },
    });

    const searchRows = parseDigihakemistoSearch(`
      <table>
        <tr class="searchrow"><td>no link</td></tr>
        <tr class="searchrow"><td><a class="aineisto" href="/bad/path">Skip</a></td></tr>
        <tr class="searchrow">
          <td><a class="aineisto nodigi" href="/aineisto/perukirjat">Estate Inventories</a></td>
          <td><span class="searchtarget searchtarget2">Summary</span></td>
        </tr>
      </table>`);
    expect(searchRows).toEqual([
      {
        id: 'perukirjat',
        title: 'Estate Inventories',
        comment: 'Summary',
        digitized: false,
        digihakemisto_url: 'https://digihakemisto.net/aineisto/perukirjat',
        astia_url: '',
      },
    ]);

    const archiveDetail = parseDigihakemistoArchive(
      `<html><head><title>Oulu Series</title></head><body>
        <div class="msg">Restricted reading room access</div>
        <table>
          <tr class="searchrow"><td><a href="/other/99">Ignored</a></td></tr>
          <tr class="searchrow">
            <td><a href="/item/998877">Volume 1</a></td>
            <td><span class="searchtarget searchtarget2">1800-1820</span></td>
          </tr>
        </table>
      </body></html>`,
      '123456'
    );
    expect(archiveDetail.astia_url).toBe('https://astia.narc.fi/uusiastia/kortti_aineisto.html?id=123456');
    expect(archiveDetail.access_notes).toEqual(['Restricted reading room access']);
    expect(archiveDetail.children).toEqual([
      {
        id: '998877',
        kind: 'item',
        title: 'Volume 1',
        comment: '1800-1820',
        digitized: true,
        digihakemisto_url: 'https://digihakemisto.net/item/998877',
        astia_url: 'https://astia.narc.fi/uusiastia/kortti_aineisto.html?id=998877',
      },
    ]);
  });

  it('resolves parish specs (codes, exact Swedish segment, partial, ambiguous, unknown) and detects anti-bot challenges', async () => {
    const cacheDir = await makeTempDir();
    const ctx = makeCtx({
      env: { KINLOOM_FI_ARCHIVES_CACHE_DIR: cacheDir },
      fetchImpl: async () => bytesResp(PARISH_LIST_BYTES, 'text/html'),
    });

    expect(await resolveParishSpec(ctx, 'all', false, 168)).toBe('*');
    expect(await resolveParishSpec(ctx, '0001, 0012', false, 168)).toBe('0001,0012');
    expect(await resolveParishSpec(ctx, '0001, Åbo, Oul', false, 168)).toBe('0001,0565,0389');

    await expect(resolveParishSpec(ctx, 'a', false, 168)).rejects.toThrow("Ambiguous parish 'a'; matches:");
    await expect(resolveParishSpec(ctx, 'Nowhere', false, 168)).rejects.toThrow("Unknown parish 'Nowhere'");

    expect(() => checkNotChallenged(new Headers({ 'cf-mitigated': 'challenge' }), 'ok', 'HisKi')).toThrow(
      'HisKi returned a Cloudflare challenge; open it in a browser instead.'
    );
    expect(() =>
      checkNotChallenged(new Headers(), '<html><title>Just a moment...</title></html>', 'HisKi')
    ).toThrow('HisKi returned a JavaScript anti-bot challenge; open it in a browser instead.');
  });

  it('handles CLI help, validation errors, text output, presets, URL builder, and transport errors', async () => {
    const cacheDir = await makeTempDir();
    const postedBodies: string[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('en+A00')) {
        return bytesResp(PARISH_LIST_BYTES, 'text/html');
      }
      if (url === HISKI_ENDPOINT && init?.method === 'POST') {
        const body = String(init.body ?? '');
        postedBodies.push(body);
        if (body.includes('srk=9999')) {
          return new Response('<html>Unknown parish code</html>', { status: 200 });
        }
        return new Response(Buffer.from(MULTI_BOOK_HISKI_HTML, 'latin1'), { status: 200 });
      }
      if (url.includes('hiski?en+0012+kastetut+101')) {
        return new Response(
          Buffer.from(
            `<HTML><BODY><H2>Anjala</H2><H3>Christened</H3>
             <A HREF="/hiski?en+t555">Link</A>
             <TABLE BORDER=4>
               <TR><TD>Child</TD><TD>Mikko</TD></TR>
               <TR><TD>Links</TD><TD><A HREF="https://www.sukuhistoria.fi/sshy/scan1">SSHY</A></TD></TR>
             </TABLE></BODY></HTML>`,
            'latin1'
          ),
          { status: 200 }
        );
      }
      if (url === DIGIHAKEMISTO_SEARCH_URL) {
        return new Response(
          `<table>
             <tr class="searchrow"><td><a class="aineisto" href="/aineisto/100">Series One</a></td><td><span class="searchtarget searchtarget2">1800-1850</span></td></tr>
             <tr class="searchrow"><td><a class="aineisto nodigi" href="/aineisto/101">Series Two</a></td><td><span class="searchtarget searchtarget2">ei digitoitu</span></td></tr>
           </table>`,
          { status: 200 }
        );
      }
      if (url.endsWith('/aineisto/100')) {
        return new Response(
          `<html><head><title>Series One</title></head><body>
             <span class="tieto">Parish books</span>
             <table>
               <tr class="searchrow"><td><a href="/aineisto/200">Book A</a></td><td><span class="searchtarget searchtarget2">1800-1820</span></td></tr>
             </table>
           </body></html>`,
          { status: 200 }
        );
      }
      return new Response('blocked', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    };

    // Subcommand help + unknown subcommand
    for (const sub of ['parishes', 'hiski', 'event', 'archives', 'archive', 'url']) {
      const h = await runFi([sub, '--help'], cacheDir, fetchImpl);
      expect(h.exitCode).toBe(0);
      expect(h.stdout).toContain(`kinloom fi-archives ${sub}`);
    }
    expect((await runFi(['bogus'], cacheDir, fetchImpl)).exitCode).toBe(2);

    // Parishes text output + --limit validation + query by 4-digit code
    expect((await runFi(['parishes', '--limit', '0'], cacheDir, fetchImpl)).exitCode).toBe(2);
    const pText = await runFi(['parishes', '--query', '0565', '--limit', '1'], cacheDir, fetchImpl);
    expect(pText.exitCode).toBe(0);
    expect(pText.stdout).toBe(
      'Showing 1 of 4 HisKi parish(es):\n  0565  Turku - Åbo  https://hiski.genealogia.fi/hiski?en+0565'
    );
    const pCached = await runFi(['parishes', '--query', '0565'], cacheDir, fetchImpl);
    expect(pCached.stdout).toContain('[cache]');

    // HisKi validations
    expect((await runFi(['hiski', '--limit', '0', '--surname', 'Korhonen'], cacheDir)).exitCode).toBe(2);
    expect((await runFi(['hiski', '--book', 'nope', '--surname', 'Korhonen'], cacheDir)).exitCode).toBe(2);
    expect(
      (await runFi(['hiski', '--parish', '*', '--book', 'all', '--surname', 'Korhonen'], cacheDir)).exitCode
    ).toBe(2);
    expect((await runFi(['hiski', '--parish', '0012'], cacheDir)).exitCode).toBe(2);

    // HisKi christened with all fields + text formatting across all 4 book types
    const hChr = await runFi(
      [
        'hiski',
        '--parish',
        '0012',
        '--book',
        'christened',
        '--given',
        'Mikko',
        '--father-given',
        'Matti',
        '--father-patronymic',
        'Juhonp',
        '--surname',
        'Korhonen',
        '--mother-given',
        'Aino',
        '--mother-surname',
        'Laine',
        '--village',
        'Kylä',
        '--from-year',
        '1800',
        '--to-year',
        '1890',
      ],
      cacheDir,
      fetchImpl
    );
    expect(hChr.exitCode).toBe(0);
    expect(postedBodies[0]).toContain('etunimi=Mikko');
    expect(postedBodies[0]).toContain('ietunimi=Matti');
    expect(postedBodies[0]).toContain('ipatronyymi=Juhonp');
    expect(postedBodies[0]).toContain('aetunimi=Aino');
    expect(postedBodies[0]).toContain('asukunimi=Laine');
    expect(hChr.stdout).toContain('Child: Mikko | Parents: Matti Korhonen & Aino Laine');
    expect(hChr.stdout).toContain('Mikko Korhonen & Sanna Salonen');
    expect(hChr.stdout).toContain('Matti Korhonen | Cause: old age');
    expect(hChr.stdout).toContain('Mikko Korhonen | Place: Oulu');

    // Non-christened book maps --given or --father-given into ietunimi
    const hMar = await runFi(
      ['hiski', '--parish', '0565', '--book', 'married', '--given', 'Mikko', '--surname', 'Korhonen'],
      cacheDir,
      fetchImpl
    );
    expect(hMar.exitCode).toBe(0);
    expect(postedBodies[1]).toContain('ietunimi=Mikko');
    const hBur = await runFi(
      ['hiski', '--parish', '0565', '--book', 'buried', '--father-given', 'Matti', '--surname', 'Korhonen'],
      cacheDir,
      fetchImpl
    );
    expect(hBur.exitCode).toBe(0);
    expect(postedBodies[2]).toContain('ietunimi=Matti');

    // Unknown parish rejection from HisKi HTML
    const hBadParish = await runFi(
      ['hiski', '--parish', '9999', '--surname', 'Korhonen'],
      cacheDir,
      fetchImpl
    );
    expect(hBadParish.exitCode).toBe(1);
    expect(hBadParish.stderr).toContain("HisKi rejected parish code '9999'.");

    // Event text output (miss + cache hit)
    const e1 = await runFi(['event', '0012/kastetut/101'], cacheDir, fetchImpl);
    expect(e1.exitCode).toBe(0);
    expect(e1.stdout).toContain('Anjala (0012) - Christened #101');
    expect(e1.stdout).toContain('  Child: Mikko');
    expect(e1.stdout).toContain('  SSHY scan link: https://www.sukuhistoria.fi/sshy/scan1');
    expect(e1.stdout).toContain('  Permalink: https://hiski.genealogia.fi/hiski?en+t555');
    const e2 = await runFi(['event', '0012/kastetut/101'], cacheDir, fetchImpl);
    expect(e2.stdout).toContain('[cache]');

    // Archives search text output + presets + validation
    expect((await runFi(['archives', '--limit', '0', 'test'], cacheDir)).exitCode).toBe(2);
    expect((await runFi(['archives'], cacheDir)).exitCode).toBe(2);
    const aText = await runFi(['archives', '--preset', 'henkikirjat'], cacheDir, fetchImpl);
    expect(aText.exitCode).toBe(0);
    expect(aText.stdout).toContain('Digihakemisto "läänin henkikirjat": 2 match(es), showing 2:');
    expect(aText.stdout).toContain('- 100 [digitized] Series One');
    expect(aText.stdout).toContain('- 101 [not-digitized] Series Two');

    // Archive inspect text output + validation
    expect((await runFi(['archive', '100', '--limit', '501'], cacheDir)).exitCode).toBe(2);
    const iText = await runFi(['archive', '100'], cacheDir, fetchImpl);
    expect(iText.exitCode).toBe(0);
    expect(iText.stdout).toContain('100  Series One');
    expect(iText.stdout).toContain('  Note: Parish books');
    expect(iText.stdout).toContain('  Children: 1 of 1');
    expect(iText.stdout).toContain('  - 200 [digitized] Book A');

    // Cloudflare 403 challenge vs plain 404 vs network failure
    const cfErr = await runFi(['archive', '999'], cacheDir, fetchImpl);
    expect(cfErr.exitCode).toBe(1);
    expect(cfErr.stderr).toContain('HTTP 403 (Cloudflare challenge)');
    const plain404 = await runFi(
      ['archive', '998'],
      cacheDir,
      async () => new Response('missing', { status: 404 })
    );
    expect(plain404.exitCode).toBe(1);
    expect(plain404.stderr).toContain('returned HTTP 404');
    const netFail = await runFi(['archive', '997'], cacheDir, async () => {
      throw new Error('socket hangup');
    });
    expect(netFail.exitCode).toBe(1);
    expect(netFail.stderr).toContain(
      'Network error fetching https://digihakemisto.net/aineisto/997: socket hangup'
    );

    // URL command branches: --astia, --hiski <code>, --digihakemisto, and default no-flags listing
    const uSpecific = await runFi(['url', '--astia', '--hiski', '0565', '--digihakemisto'], cacheDir);
    expect(uSpecific.stdout).toBe(
      [
        'https://astia.narc.fi/uusiastia/aineistot.html',
        'https://hiski.genealogia.fi/hiski?en+0565',
        'https://digihakemisto.net/',
      ].join('\n')
    );
    const uDefault = await runFi(['url'], cacheDir);
    expect(uDefault.stdout).toContain('HisKi:         https://hiski.genealogia.fi/hiski?en');
    expect(uDefault.stdout).toContain('Digi (NLF):    https://digi.kansalliskirjasto.fi/search');
  });
});

// ============================================================================
// 2. seArchives (Swedish National Archives / Riksarkivet)
// ============================================================================

describe('seArchives behavioral edge cases', () => {
  async function runSe(
    args: readonly string[],
    cacheDir: string,
    fetchImpl?: typeof fetch
  ): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx = makeCtx({
      stdout,
      stderr,
      env: { KINLOOM_SE_ARCHIVES_CACHE_DIR: cacheDir },
      fetchImpl,
    });
    const out = await runSeArchivesCommand(args, ctx);
    return {
      exitCode: out.exitCode,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      cacheHit: out.cacheHit,
    };
  }

  it('validates domain URLs, ranges, paging, IDs, image magic, HTML detection, output paths, IIIF URLs, and type guards', async () => {
    const tmp = await makeTempDir('kinloom-se-dom-');

    expect(getSeCacheDir(makeCtx({ env: { KINLOOM_SE_ARCHIVES_CACHE_DIR: tmp } }))).toBe(path.resolve(tmp));
    expect(getSeCacheDir(makeCtx({ env: { HOME: tmp } }))).toBe(
      path.resolve(tmp, '.cache', 'kinloom', 'se-archives')
    );

    expect(() => validateSeUrl('not-a-url')).toThrow("Refusing malformed URL: 'not-a-url'");
    expect(() => validateSeUrl('http://data.riksarkivet.se/api/records')).toThrow('Refusing non-HTTPS URL');
    expect(() => validateSeUrl('https://u:p@data.riksarkivet.se/api/records')).toThrow(
      'Refusing URL containing embedded credentials.'
    );

    expect(() => validateYearRange(999, undefined)).toThrow('Invalid --year-min 999');
    expect(() => validateYearRange(undefined, 2101)).toThrow('Invalid --year-max 2101');
    expect(() => validateYearRange(1900, 1850)).toThrow('--year-min must not be greater than --year-max.');

    expect(() => validatePaging(0, 0)).toThrow('--limit must be between 1 and 100.');
    expect(() => validatePaging(101, 0)).toThrow('--limit must be between 1 and 100.');
    expect(() => validatePaging(10, -1)).toThrow('--offset must be >= 0.');

    // normalizeBildid branches
    expect(() => normalizeBildid('   ')).toThrow('Empty bildid or URL.');
    expect(() => normalizeBildid('https://[bad-url')).toThrow("Invalid URL: 'https://[bad-url'");
    expect(normalizeBildid('https://lbiiif.riksarkivet.se/arkis!_C0001234_00005/manifest')).toEqual([
      'C0001234',
      'C0001234_00005',
    ]);
    expect(() => normalizeBildid('https://lbiiif.riksarkivet.se/collection/other')).toThrow(
      'Could not extract arkis bildid from IIIF URL'
    );
    expect(() => normalizeBildid('http://sok.riksarkivet.se/bildvisning/C0001234')).toThrow(
      'Refusing non-HTTPS URL'
    );
    expect(() => normalizeBildid('https://sok.riksarkivet.se/other/C0001234')).toThrow(
      'Expected a sok.riksarkivet.se/bildvisning/<bildid> URL'
    );
    expect(() => normalizeBildid('https://archive.example.test/bildvisning/C0001234')).toThrow(
      "Refusing host 'archive.example.test'"
    );
    expect(normalizeBildid('arkis!_C0001234')).toEqual(['C0001234', null]);
    expect(() => normalizeBildid('bad!id')).toThrow("Invalid Riksarkivet bildid: 'bad!id'");

    // parseArchiveId & parseRegisterId
    expect(() => parseSeArchiveId('')).toThrow('Archive ID cannot be empty.');
    expect(() => parseSeArchiveId('https://[bad')).toThrow("Invalid URL: 'https://[bad'");
    expect(() => parseSeArchiveId('https://archive.example.test/arkiv/ABC123')).toThrow('Refusing host');
    expect(() => parseSeArchiveId('http://data.riksarkivet.se/arkiv/ABC123')).toThrow(
      'Refusing non-HTTPS URL'
    );
    expect(parseSeArchiveId('https://data.riksarkivet.se/archive/Arch123.jsonld')).toBe('Arch123');
    expect(parseSeArchiveId('https://lbiiif.riksarkivet.se/collection/arkiv/Arch456.rdfxml')).toBe('Arch456');
    expect(() => parseSeArchiveId('ab')).toThrow("Invalid Riksarkivet archive ID: 'ab'");

    expect(() => parseRegisterId('')).toThrow('Register record ID cannot be empty.');
    expect(parseRegisterId('https://data.riksarkivet.se/register/RecId123')).toBe('RecId123');
    expect(() => parseRegisterId('https://data.riksarkivet.se/other/RecId123')).toThrow(
      'Expected https://data.riksarkivet.se/register/<id>'
    );
    expect(() => parseRegisterId('ab')).toThrow("Invalid Riksarkivet register record ID: 'ab'");

    // detectImageFormat & looksLikeHtmlPayload
    expect(detectImageFormat(JPEG_MAGIC)).toBe('jpeg');
    expect(detectImageFormat(PNG_MAGIC)).toBe('png');
    expect(detectImageFormat(GIF87_MAGIC)).toBe('gif');
    expect(detectImageFormat(GIF89_MAGIC)).toBe('gif');
    expect(detectImageFormat(WEBP_MAGIC)).toBe('webp');
    expect(detectImageFormat(Uint8Array.from([1, 2, 3]))).toBeNull();

    expect(looksLikeHtmlPayload(Uint8Array.from([0x01]), 'application/xhtml+xml')).toBe(true);
    expect(
      looksLikeHtmlPayload(Buffer.from('<?xml version="1.0"?><error/>'), 'application/octet-stream')
    ).toBe(true);
    expect(looksLikeHtmlPayload(JPEG_MAGIC, 'image/jpeg')).toBe(false);

    // resolveSafeOutputPath
    expect(() => resolveSafeOutputPath('', 'scan.jpg')).toThrow('Invalid output path.');
    expect(() => resolveSafeOutputPath('dir\0file.jpg', 'scan.jpg')).toThrow('Invalid output path.');
    expect(resolveSafeOutputPath(tmp, 'C0001_00001.jpg')).toBe(path.join(tmp, 'C0001_00001.jpg'));
    expect(resolveSafeOutputPath(`${tmp}/`, '...')).toBe(path.join(tmp, 'scan.jpg'));

    // buildIiifImageUrl
    expect(() => buildIiifImageUrl('C0001', { width: 32 })).toThrow(
      '--width must be between 64 and 12000 pixels.'
    );
    expect(() => buildIiifImageUrl('C0001', { page: 0 })).toThrow('--page must be >= 1.');
    expect(() => buildIiifImageUrl('https://[bad')).toThrow("Invalid URL: 'https://[bad'");
    expect(
      buildIiifImageUrl('https://lbiiif.riksarkivet.se/arkis!_C0001_00002/full/max/0/default.png')
    ).toEqual(['https://lbiiif.riksarkivet.se/arkis!_C0001_00002/full/max/0/default.png', 'C0001_00002']);
    expect(buildIiifImageUrl('https://lbiiif.riksarkivet.se/plain/scan.webp')).toEqual([
      'https://lbiiif.riksarkivet.se/plain/scan.webp',
      'riksarkivet_scan',
    ]);
    expect(buildIiifImageUrl('C0001_00002', { page: 7 })).toEqual([
      'https://lbiiif.riksarkivet.se/arkis!C0001_00007/full/max/0/default.jpg',
      'C0001_00007',
    ]);
    expect(buildIiifImageUrl('C0001')).toEqual([
      'https://lbiiif.riksarkivet.se/arkis!C0001_00001/full/max/0/default.jpg',
      'C0001_00001',
    ]);

    // Type guards
    expect(isSearchEndpointResult({ results: [] })).toBe(true);
    expect(isSearchEndpointResult({ results: 'no' })).toBe(false);
    expect(isRegisterDetailResult({ record: {} })).toBe(true);
    expect(isRegisterDetailResult({ record: null })).toBe(false);
    expect(isIiifCollectionResult({ items: [] })).toBe(true);
    expect(isIiifManifestResult({ canvases: [] })).toBe(true);
  });

  it('parses IIIF language maps, search fallbacks, canvases, collections, manifests, and formats text output', () => {
    expect(firstLangText('  Hello   world  ')).toBe('Hello world');
    expect(firstLangText(['  ', 'Second'])).toBe('Second');
    expect(firstLangText(['  '])).toBe('');
    expect(firstLangText({ en: 'English Title' })).toBe('English Title');
    expect(firstLangText({ de: ['Deutsch'] })).toBe('Deutsch');
    expect(firstLangText(42)).toBe('');

    expect(allLangTexts('  Single line  ')).toEqual(['Single line']);
    expect(allLangTexts('   ')).toEqual([]);
    expect(allLangTexts({ fr: ['Ligne 1', '  ', 'Ligne 2'] })).toEqual(['Ligne 1', 'Ligne 2']);
    expect(allLangTexts(null)).toEqual([]);

    const fatherCaption = normalizeSearchItem({
      id: 'Rec1',
      objectType: 'Register',
      type: 'BirthRecord',
      metadata: { parish: 'Uppsala', fathersName: 'Anders Lindholm', note: '  twin  ' },
      _links: { image: 'https://lbiiif.riksarkivet.se/arkis!0001/manifest' },
      transcribedText: { snippets: ['skip-me', { text: '<em>Match</em>', pages: [] }] },
    });
    expect(fatherCaption.caption).toBe('Anders Lindholm (Uppsala)');
    expect(fatherCaption.note).toBe('twin');
    expect(fatherCaption.iiif_manifests).toEqual(['https://lbiiif.riksarkivet.se/arkis!0001/manifest']);
    expect(fatherCaption.iiif_collection_url).toBeUndefined();

    const refCaption = normalizeSearchItem({
      id: 'Set1',
      objectType: 'RecordSet',
      type: 'Archive',
      metadata: { referenceCode: 'SE/ULA/999' },
    });
    expect(refCaption.caption).toBe('SE/ULA/999');
    expect(refCaption.iiif_collection_url).toBe('https://lbiiif.riksarkivet.se/collection/arkiv/Set1');

    expect(() => parseIiifCollectionBody({ type: 'Manifest' }, 'A1', 'https://x')).toThrow(
      'Unexpected IIIF Collection payload for A1'
    );
    const coll = parseIiifCollectionBody(
      {
        type: 'Collection',
        label: { sv: ['Uppsala Kyrkoarkiv'] },
        summary: { sv: ['Referenskod: SE/ULA/1', 'Arkivinstitution: Riksarkivet', 'Datering: 1800-1850'] },
        items: [
          'ignored',
          {
            id: 'https://lbiiif.riksarkivet.se/collection/arkiv/SubCol1',
            type: 'Collection',
            label: { en: ['Sub Series'] },
          },
          { id: 'not-a-valid-url', type: 'Manifest', label: { en: ['Malformed'] } },
        ],
      },
      'A1',
      'https://lbiiif.riksarkivet.se/collection/arkiv/A1'
    );
    expect(coll.items[0].archive_id).toBe('SubCol1');
    expect(coll.items[1].bildid).toBeUndefined();

    const canvas = extractCanvasInfo(3, {
      id: 'not-a-url',
      metadata: [
        'skip',
        { label: { en: ['Image ID'] }, value: { none: ['_C0001_00003'] } },
        { label: { en: ['Link'] }, value: { none: ['https://sok.riksarkivet.se/bildvisning/C0001_00003'] } },
        { label: { en: ['Source reference'] }, value: { en: ['Ref C:3'] } },
      ],
    });
    expect(canvas).toEqual({
      index: 3,
      page_id: 'C0001_00003',
      label: 'Image 3',
      width: 0,
      height: 0,
      bildvisning_url: 'https://sok.riksarkivet.se/bildvisning/C0001_00003',
      source_reference: 'Ref C:3',
      iiif_image_base: 'https://lbiiif.riksarkivet.se/arkis!C0001_00003',
      full_image_url: 'https://lbiiif.riksarkivet.se/arkis!C0001_00003/full/max/0/default.jpg',
    });

    expect(() =>
      parseIiifManifestBody({ type: 'Collection' }, 'V1', 'https://lbiiif.riksarkivet.se/arkis!V1/manifest')
    ).toThrow('Unexpected IIIF Manifest payload');

    const longSnippet = 'A'.repeat(180);
    const searchText = formatSearchText(
      'Riksarkivet Search',
      {
        total: 1,
        hits: 1,
        offset: 0,
        verified: true,
        results: [
          {
            id: 'M1',
            object_type: 'Register',
            type: 'MarriageRecord',
            caption: 'Erik Berg & Karin Holm',
            reference_code: 'SE/ULA/2',
            date: '1855-06-10',
            parish: 'Vänge',
            institution: 'Riksarkivet',
            digitized: true,
            father: 'Anders Lindholm',
            mother: 'Sofia Ek',
            groom: 'Erik Berg',
            bride: 'Karin Holm',
            iiif_manifests: ['https://lbiiif.riksarkivet.se/arkis!0002/manifest'],
            snippets: [{ text: longSnippet, pages: [] }],
          },
        ],
      },
      false
    );
    expect(searchText).toContain(
      'father: Anders Lindholm | mother: Sofia Ek | groom: Erik Berg | bride: Karin Holm'
    );
    expect(searchText).toContain(`    text: ${'A'.repeat(157)}...`);

    const regText = formatRegisterDetailText(
      'R1',
      {
        id: 'R1',
        url: 'https://data.riksarkivet.se/register/R1',
        record: { parish: 'Vänge', empty: '', dash: '-', missing: null },
        verified: true,
      },
      true
    );
    expect(regText).toBe(
      'Riksarkivet Register Record (R1) [cache]\n  parish: Vänge\n  url: https://data.riksarkivet.se/register/R1'
    );

    const collText = formatCollectionText('A1', coll, true);
    expect(collText).toContain('Uppsala Kyrkoarkiv | items=2 [cache]');
    expect(collText).toContain('  Reference: SE/ULA/1');
    expect(collText).toContain('  [Collection] Sub Series | id=SubCol1');

    const manText = formatManifestText(
      'V1',
      {
        bildid: 'V1',
        manifest_url: 'https://lbiiif.riksarkivet.se/arkis!V1/manifest',
        bildvisning_url: 'https://sok.riksarkivet.se/bildvisning/V1',
        label: 'Volume V1',
        metadata: { Arkiv: 'Uppsala' },
        canvas_count: 2,
        canvases: [canvas, { ...canvas, index: 4, width: 1000, height: 800 }],
        verified: true,
      },
      1,
      true
    );
    expect(manText).toContain('Volume V1 | canvases=2 [cache]');
    expect(manText).toContain('  Arkiv: Uppsala');
    expect(manText).toContain('  ... (1 more pages; pass --limit or --json to view all)');
  });

  it('exercises all seArchives command help, text outputs, download edge cases, census validation, and transport errors', async () => {
    const tmp = await makeTempDir('kinloom-se-cmd-');
    const cacheDir = path.join(tmp, 'cache');

    for (const sub of [
      'search',
      'births',
      'marriages',
      'deeds',
      'record',
      'collection',
      'manifest',
      'download',
      'census',
    ]) {
      const h = await runSe([sub, '--help'], cacheDir);
      expect(h.exitCode).toBe(0);
      expect(h.stdout).toContain(`se-archives ${sub}`);
    }
    expect((await runSe(['unknown'], cacheDir)).exitCode).toBe(2);

    // Search/births/marriages/deeds validations
    expect((await runSe(['search'], cacheDir)).exitCode).toBe(2);
    expect((await runSe(['search', '--text', 'Uppsala', '--type', 'bogus'], cacheDir)).exitCode).toBe(2);
    expect((await runSe(['births', '--first', 'Erik', '--gender', 'invalid'], cacheDir)).exitCode).toBe(2);
    expect((await runSe(['births'], cacheDir)).exitCode).toBe(2);
    expect((await runSe(['marriages'], cacheDir)).exitCode).toBe(2);
    expect((await runSe(['deeds'], cacheDir)).exitCode).toBe(2);
    expect((await runSe(['manifest', '00124895', '--limit', '0'], cacheDir)).exitCode).toBe(2);

    // Census text output & validation errors
    const cDefault = await runSe(['census'], cacheDir);
    expect(cDefault.exitCode).toBe(0);
    expect(cDefault.stdout).toContain('Census search URL: https://sok.riksarkivet.se/folkrakningar');
    expect(cDefault.stdout).toContain('Parish church archives URL: https://sok.riksarkivet.se/kyrkoarkiv');
    const cBirth = await runSe(['census', '--birth-year', '1880', '--json'], cacheDir);
    expect(cBirth.exitCode).toBe(0);
    expect(JSON.parse(cBirth.stdout).census_url).toContain('Fodelsear=1880');
    expect((await runSe(['census', '--birth-year', '1650'], cacheDir)).exitCode).toBe(2);
    expect((await runSe(['census', '--year', '1855'], cacheDir)).exitCode).toBe(2);

    // Transport error handling (non-JSON, unexpected payload, 404 on manifest, network error)
    const nonJsonFetch: typeof fetch = async () => new Response('not json', { status: 200 });
    expect(
      (await runSe(['search', '--text', 'Uppsala', '--facet', 'ObjectType:Record'], cacheDir, nonJsonFetch))
        .stderr
    ).toContain('returned non-JSON response');
    expect((await runSe(['record', 'RecId123'], cacheDir, nonJsonFetch)).stderr).toContain(
      'register endpoint returned non-JSON'
    );
    expect((await runSe(['collection', 'Arch123'], cacheDir, nonJsonFetch)).stderr).toContain(
      'IIIF collection returned non-JSON'
    );
    expect((await runSe(['manifest', 'C0001234'], cacheDir, nonJsonFetch)).stderr).toContain(
      'IIIF manifest returned non-JSON'
    );

    const badShapeFetch: typeof fetch = async () => jsonResp(['not-an-object']);
    expect(
      (
        await runSe(
          ['search', '--name', 'Anders Lindholm', '--place', 'Lund', '--digitized'],
          cacheDir,
          badShapeFetch
        )
      ).stderr
    ).toContain('Unexpected Riksarkivet API payload');
    expect((await runSe(['record', 'RecId123'], cacheDir, badShapeFetch)).stderr).toContain(
      'Unexpected register detail payload'
    );

    expect(
      (await runSe(['manifest', 'C0001234'], cacheDir, async () => new Response('nope', { status: 404 })))
        .stderr
    ).toContain('HTTP 404');
    expect(
      (
        await runSe(['record', 'RecId123'], cacheDir, async () => {
          throw new Error('connection reset');
        })
      ).stderr
    ).toContain('Network error fetching https://data.riksarkivet.se/register/RecId123: connection reset');

    // Resource text outputs for record, collection, manifest
    const okFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/register/')) {
        return jsonResp({ parish: 'Lund', childsName: 'Erik Berg' });
      }
      if (url.pathname.startsWith('/collection/arkiv/')) {
        return jsonResp({
          type: 'Collection',
          label: { sv: ['Lunds Kyrkoarkiv'] },
          items: [
            {
              id: 'https://lbiiif.riksarkivet.se/arkis!00099999/manifest',
              type: 'Manifest',
              label: { sv: ['C I:1'] },
            },
          ],
        });
      }
      if (url.pathname.endsWith('/manifest')) {
        return jsonResp({
          type: 'Manifest',
          label: { sv: ['Lund C I:1'] },
          items: [
            {
              id: 'https://lbiiif.riksarkivet.se/arkis!00099999_00001/canvas',
              type: 'Canvas',
              label: { sv: ['Bild 1'] },
              width: 1200,
              height: 900,
            },
          ],
        });
      }
      return jsonResp({ totalHits: 0, hits: 0, offset: 0, items: [] });
    };

    const recOut = await runSe(['record', 'RecId123'], cacheDir, okFetch);
    expect(recOut.exitCode).toBe(0);
    expect(recOut.stdout).toContain('Riksarkivet Register Record (RecId123)');
    const colOut = await runSe(['collection', 'Arch123'], cacheDir, okFetch);
    expect(colOut.exitCode).toBe(0);
    expect(colOut.stdout).toContain('Lunds Kyrkoarkiv | items=1');
    const manOut = await runSe(['manifest', '00099999'], cacheDir, okFetch);
    expect(manOut.exitCode).toBe(0);
    expect(manOut.stdout).toContain('Lund C I:1 | canvases=1');

    // Download edge cases: empty body, non-image body, text output, corrupt existing file without/with --overwrite
    const emptyRes = await runSe(
      ['download', '00099999_00001', '--out', path.join(tmp, 'empty.jpg')],
      cacheDir,
      async () => new Response(new Uint8Array(), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    );
    expect(emptyRes.exitCode).toBe(1);
    expect(emptyRes.stderr).toContain('Refusing empty response body');

    const nonImgRes = await runSe(
      ['download', '00099999_00001', '--out', path.join(tmp, 'bin.jpg')],
      cacheDir,
      async () =>
        new Response(Buffer.from('plain text bytes'), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
    );
    expect(nonImgRes.exitCode).toBe(1);
    expect(nonImgRes.stderr).toContain('Refusing non-image payload');

    const corruptPath = path.join(tmp, 'corrupt.jpg');
    fs.writeFileSync(corruptPath, 'not-an-image');
    const corruptFail = await runSe(
      ['download', '00099999_00001', '--out', corruptPath],
      cacheDir,
      async () => bytesResp(PNG_MAGIC, 'image/png')
    );
    expect(corruptFail.exitCode).toBe(1);
    expect(corruptFail.stderr).toContain('is not a valid image; pass --overwrite to replace.');

    const overwriteOk = await runSe(
      ['download', '00099999_00001', '--out', corruptPath, '--overwrite'],
      cacheDir,
      async () => bytesResp(PNG_MAGIC, 'image/png')
    );
    expect(overwriteOk.exitCode).toBe(0);
    expect(overwriteOk.stdout).toContain(`Downloaded: ${corruptPath} (8 bytes, png)`);

    const skipText = await runSe(['download', '00099999_00001', '--out', corruptPath], cacheDir, async () => {
      throw new Error('should skip');
    });
    expect(skipText.exitCode).toBe(0);
    expect(skipText.stdout).toContain(`Exists (skip): ${corruptPath} (8 bytes, png)`);
  });
});

// ============================================================================
// 3. openarchieven
// ============================================================================

describe('openarchieven behavioral edge cases', () => {
  async function runOa(
    args: readonly string[],
    cacheDir: string,
    fetchImpl?: typeof fetch
  ): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx = makeCtx({
      stdout,
      stderr,
      cwd: cacheDir,
      env: { KINLOOM_OPENARCHIEVEN_CACHE_DIR: cacheDir },
      fetchImpl,
    });
    const out = await runOpenarchievenCommand(args, ctx);
    return {
      exitCode: out.exitCode,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      cacheHit: out.cacheHit,
    };
  }

  it('covers A2A text/date/name/record formatting, scan extraction, URL validators, and scan candidate builders', () => {
    expect(asList(null)).toEqual([]);
    expect(asList('one')).toEqual(['one']);
    expect(a2aText(null)).toBe('');
    expect(a2aText(1855)).toBe('1855');
    expect(a2aText({ a2a_Place: { a2a_Place: 'Delft' } })).toBe('Delft');
    expect(a2aText({ wrapper: { nested: 'Fallback Value' } })).toBe('Fallback Value');

    expect(isSourceType('BS Huwelijk')).toBe(true);
    expect(isSourceType('DTB Dopen')).toBe(true);
    expect(isSourceType('Bevolkingsregister')).toBe(true);
    expect(isSourceType('Geboorte')).toBe(false);

    expect(fmtEventdate(null)).toBe('');
    expect(fmtEventdate({})).toBe('');
    expect(fmtEventdate({ year: 'bad' })).toBe('');
    expect(fmtEventdate({ year: 1850 })).toBe('1850');
    expect(fmtEventdate({ year: 1850, month: 4 })).toBe('1850-04');
    expect(fmtEventdate({ year: 1850, month: 4, day: 7 })).toBe('1850-04-07');

    expect(parseRecordRef('bhi:abc-123/extra?lang=en', undefined)).toEqual(['bhi', 'abc-123']);
    expect(() => parseRecordRef('no-colon', undefined)).toThrow(CliValidationError);
    expect(() => parseRecordRef('bhi:bad!id', undefined)).toThrow(CliValidationError);

    expect(() => validateApiUrl('not-a-url')).toThrow(SsrfBlockedError);
    expect(() => validateScanUrl('not-a-url')).toThrow(SsrfBlockedError);
    expect(() => validateScanUrl('ftp://scans.example.test/a.jpg')).toThrow(SsrfBlockedError);
    expect(() => validateScanUrl('https://sub.localhost/a.jpg')).toThrow(SsrfBlockedError);
    expect(() => validateScanUrl('https://host.local/a.jpg')).toThrow(SsrfBlockedError);
    expect(() => validateScanUrl('https://service.internal/a.jpg')).toThrow(SsrfBlockedError);

    expect(isViewerUrl('not-a-url')).toBe(false);
    expect(isViewerUrl('https://sgen.schiedam.nl/viewer/1')).toBe(true);
    expect(isViewerUrl('https://sgen.schiedam.nl/scans/page1.jpg')).toBe(false);

    expect(deriveProxyDownloadUrl('')).toBeUndefined();
    expect(deriveProxyDownloadUrl('https://scans.example.test/thumb/1/2')).toBeUndefined();
    expect(deriveIiifJpegUrl('')).toBeUndefined();
    expect(deriveIiifJpegUrl('https://images.example.test/iiif/abc/info.json')).toBe(
      'https://images.example.test/iiif/abc/full/full/0/default.jpg'
    );

    const previewScan = new ScanImage(
      1,
      null,
      '',
      'https://scans.example.test/full.jpg',
      'https://scans.example.test/thumb.jpg'
    );
    expect(previewScan.candidateUrls(true)).toEqual([
      ['https://scans.example.test/thumb.jpg', false],
      ['https://scans.example.test/full.jpg', false],
    ]);
    expect(scanFilename('!!!', '---', 2, '???')).toBe('archive-record-scan-02.img');

    // extractScans: direct block without a2a_Scan, array form, null order sorted after numeric order
    const directBlock = extractScans({
      a2a_Source: { a2a_SourceAvailableScans: { uri: 'https://scans.example.test/single.jpg' } },
    });
    expect(directBlock).toHaveLength(1);
    expect(directBlock[0].uri).toBe('https://scans.example.test/single.jpg');

    const arrayScans = extractScans({
      a2a_Source: {
        a2a_SourceAvailableScans: [
          'skip',
          { label: 'no-url' },
          { uri: 'https://scans.example.test/unnumbered.jpg' },
          { uri: 'https://scans.example.test/second.jpg', order: '2' },
          { uri: 'https://scans.example.test/first.jpg', order: '1' },
        ],
      },
    });
    expect(arrayScans.map((s) => s.uri)).toEqual([
      'https://scans.example.test/first.jpg',
      'https://scans.example.test/second.jpg',
      'https://scans.example.test/unnumbered.jpg',
    ]);

    // Full formatA2aRecord including ref parts, multiple roles, birth/res/occ, >5 scans, original
    const richRecord = {
      a2a_Source: {
        a2a_SourceType: 'BS Huwelijk',
        a2a_SourcePlace: { a2a_Place: 'Delft' },
        a2a_SourceDigitalOriginal: 'https://archive.example.test/orig/1',
        a2a_SourceReference: {
          a2a_InstitutionName: 'Stadsarchief Delft',
          a2a_Archive: '14',
          a2a_RegistryNumber: '205',
          a2a_Book: 'Huwelijksregister',
          a2a_Collection: 'Burgerlijke Stand',
          a2a_DocumentNumber: '42',
        },
        a2a_SourceAvailableScans: Array.from({ length: 6 }, (_, i) => ({
          order: i + 1,
          uri: `https://scans.example.test/p${i + 1}.jpg`,
        })),
      },
      a2a_Event: [
        {
          a2a_EventType: 'Huwelijk',
          a2a_EventDate: { a2a_Year: '1872', a2a_Month: '5' },
          a2a_EventPlace: { a2a_Place: 'Delft' },
        },
        {
          a2a_EventType: 'Melding',
          a2a_EventDate: { a2a_LiteralDate: 'mei 1872' },
        },
      ],
      a2a_RelationEP: [
        { a2a_PersonKeyRef: 'P1', a2a_RelationType: 'Bruidegom' },
        { a2a_PersonKeyRef: 'P1', a2a_RelationType: 'Getuige' },
      ],
      a2a_Person: [
        {
          pid: 'P1',
          a2a_PersonName: {
            a2a_PersonNameFirstName: 'Pieter',
            a2a_PersonNamePatronym: 'Jansz',
            a2a_PersonNamePrefixLastName: 'van',
            a2a_PersonNameLastName: 'Dijk',
          },
          a2a_BirthDate: '1848',
          a2a_BirthPlace: { a2a_Place: 'Zundert' },
          a2a_Residence: { a2a_Place: 'Delft' },
          a2a_Profession: 'Timmerman',
        },
        { pid: 'P2' },
      ],
    };
    const formatted = formatA2aRecord('bhi', 'rec-1', richRecord);
    expect(formatted).toContain(
      '  Reference: Archive 14 | Registry 205 | Huwelijksregister | Burgerlijke Stand | Document 42'
    );
    expect(formatted).toContain('  Event: Huwelijk | 1872-05 | Delft');
    expect(formatted).toContain('  Event: Melding | mei 1872');
    expect(formatted).toContain(
      '    - Pieter Jansz van Dijk (Bruidegom, Getuige; b. 1848, Zundert; res. Delft; occ. Timmerman)'
    );
    expect(formatted).toContain('    - (unnamed)');
    expect(formatted).toContain('    - (+1 more)');
    expect(formatted).toContain('  Original: https://archive.example.test/orig/1');
  });

  it('exercises search filters, show arrays/empty, direct scan listing/saving, and download error cases', async () => {
    const cacheDir = await makeTempDir('kinloom-oa-cmd-');
    const seenSearchUrls: URL[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('search.json')) {
        seenSearchUrls.push(url);
        return jsonResp({
          response: {
            number_found: 2,
            docs: [
              'skip-non-object',
              {
                archive_code: 'bhi',
                identifier: 'id-1',
                eventtype: 'Geboorte',
                eventplace: 'Delft',
                eventdate: { year: 1860 },
              },
            ],
          },
        });
      }
      if (url.pathname.endsWith('show.json')) {
        const id = url.searchParams.get('identifier');
        if (id === 'empty-arr') {
          return jsonResp([]);
        }
        if (id === 'multi-rec') {
          return jsonResp([
            {
              a2a_Source: {
                a2a_SourceAvailableScans: [
                  { uri: 'https://scans.example.test/s1.png' },
                  { uri: 'https://scans.example.test/s2.gif', order: 2, label: 'back' },
                ],
              },
            },
            { a2a_Source: { a2a_SourceType: 'BS Overlijden' } },
          ]);
        }
        return jsonResp({});
      }
      if (url.href === 'https://scans.example.test/direct.pdf') {
        return bytesResp(PDF_MAGIC, 'application/pdf');
      }
      if (url.href === 'https://scans.example.test/s1.png') {
        return bytesResp(PNG_MAGIC, 'image/png');
      }
      if (url.href === 'https://scans.example.test/s2.gif') {
        return bytesResp(GIF89_MAGIC, 'image/gif');
      }
      return new Response('missing', { status: 404 });
    };

    // Help & unknown subcommand
    for (const sub of ['search', 'show', 'download', 'url']) {
      const h = await runOa([sub, '--help'], cacheDir, fetchImpl);
      expect(h.exitCode).toBe(0);
      expect(h.stdout).toContain(sub);
    }
    expect((await runOa(['nope'], cacheDir, fetchImpl)).exitCode).toBe(2);

    // Search validation + all query filter flags + text formatting fallbacks
    expect((await runOa(['search'], cacheDir, fetchImpl)).exitCode).toBe(2);
    const sRes = await runOa(
      [
        'search',
        'Pieter van Dijk',
        '--year',
        '1860',
        '--place',
        'Delft',
        '--birth-place',
        'Zundert',
        '--event-type',
        'BS Geboorte',
        '--archive',
        'bhi',
        '--relation',
        'Kind',
        '--country',
        'NL',
      ],
      cacheDir,
      fetchImpl
    );
    expect(sRes.exitCode).toBe(0);
    expect(seenSearchUrls[0].searchParams.get('name')).toBe('Pieter van Dijk 1860');
    expect(seenSearchUrls[0].searchParams.get('sourcetype')).toBe('BS Geboorte');
    expect(seenSearchUrls[0].searchParams.get('birthplace')).toBe('Zundert');
    expect(seenSearchUrls[0].searchParams.get('archive')).toBe('bhi');
    expect(seenSearchUrls[0].searchParams.get('relationtype')).toBe('Kind');
    expect(seenSearchUrls[0].searchParams.get('country_code')).toBe('NL');
    expect(sRes.stdout).toContain('- bhi:id-1 | (unnamed) () | Geboorte | 1860 | Delft');
    expect(sRes.stdout).toContain('  https://www.openarchieven.nl/bhi:id-1');

    // Non-source-type event-type goes into eventtype param
    await runOa(
      ['search', 'Pieter', '--event-type', 'Geboorte', '--source-type', 'BS Geboorte'],
      cacheDir,
      fetchImpl
    );
    expect(seenSearchUrls[1].searchParams.get('eventtype')).toBe('Geboorte');
    expect(seenSearchUrls[1].searchParams.get('sourcetype')).toBe('BS Geboorte');

    // Show empty array & multi-record array (JSON + text)
    const emptyShow = await runOa(['show', 'bhi:empty-arr'], cacheDir, fetchImpl);
    expect(emptyShow.exitCode).toBe(0);
    expect(emptyShow.stdout).toBe('No record data returned.');

    const multiJson = await runOa(['show', 'bhi:multi-rec', '--json'], cacheDir, fetchImpl);
    expect(multiJson.exitCode).toBe(0);
    expect(JSON.parse(multiJson.stdout).records).toHaveLength(2);
    const multiText = await runOa(['show', 'bhi:multi-rec'], cacheDir, fetchImpl);
    expect(multiText.stdout).toContain('Record: bhi:multi-rec [cache]');

    // Direct scan URL: --list text & json, missing --out, save into existing directory + text cache hit
    const directListText = await runOa(
      ['download', 'https://scans.example.test/direct.pdf', '--list'],
      cacheDir,
      fetchImpl
    );
    expect(directListText.stdout).toBe('1. order=1\n   https://scans.example.test/direct.pdf');
    const directListJson = await runOa(
      ['download', 'https://scans.example.test/direct.pdf', '--list', '--json'],
      cacheDir,
      fetchImpl
    );
    expect(JSON.parse(directListJson.stdout).scans[0].url).toBe('https://scans.example.test/direct.pdf');
    expect(
      (await runOa(['download', 'https://scans.example.test/direct.pdf'], cacheDir, fetchImpl)).exitCode
    ).toBe(2);

    const outDir = path.join(cacheDir, 'direct-dir');
    fs.mkdirSync(outDir, { recursive: true });
    const dMiss = await runOa(
      ['download', 'https://scans.example.test/direct.pdf', '--out', outDir],
      cacheDir,
      fetchImpl
    );
    expect(dMiss.exitCode).toBe(0);
    expect(dMiss.stdout).toMatch(/^scan 1: .*\.pdf \(8 bytes\)$/);
    const dHit = await runOa(
      ['download', 'https://scans.example.test/direct.pdf', '--out', outDir],
      cacheDir,
      fetchImpl
    );
    expect(dHit.stdout).toContain('[cache]');

    // Record scan list text (with scans and with zero scans), missing --out, bad index, --out-dir is file
    const listText = await runOa(['download', 'bhi:multi-rec', '--list'], cacheDir, fetchImpl);
    expect(listText.stdout).toContain('Scans for bhi:multi-rec (2) [cache]');
    expect(listText.stdout).toContain('1. order=2 back');
    expect(listText.stdout).toContain('2. order=-');

    const zeroListText = await runOa(['download', 'bhi:empty-arr', '--list'], cacheDir, fetchImpl);
    expect(zeroListText.stdout).toContain('No scans.');

    expect((await runOa(['download', 'bhi:multi-rec', '--all'], cacheDir, fetchImpl)).exitCode).toBe(2);
    expect((await runOa(['download', 'bhi:multi-rec'], cacheDir, fetchImpl)).exitCode).toBe(2);
    const badIdx = await runOa(
      ['download', 'bhi:multi-rec', '--scan-index', '9', '--out', path.join(cacheDir, 'x.png')],
      cacheDir,
      fetchImpl
    );
    expect(badIdx.exitCode).toBe(1);
    expect(badIdx.stderr).toContain('Scan index 9 is outside 1-2');

    const fileNotDir = path.join(cacheDir, 'regular-file');
    fs.writeFileSync(fileNotDir, 'x');
    const dirErr = await runOa(
      ['download', 'bhi:multi-rec', '--all', '--out-dir', fileNotDir],
      cacheDir,
      fetchImpl
    );
    expect(dirErr.exitCode).toBe(1);
    expect(dirErr.stderr).toContain('--out-dir must be a directory');

    // Text output for downloaded record scan + cache hit
    const recDl1 = await runOa(['download', 'bhi:multi-rec', '--out', outDir], cacheDir, fetchImpl);
    expect(recDl1.exitCode).toBe(0);
    expect(recDl1.stdout).toMatch(/^scan 1: .*bhi-multirec-scan-01\.gif \(6 bytes\)$/);
    const recDl2 = await runOa(['download', 'bhi:multi-rec', '--out', outDir], cacheDir, fetchImpl);
    expect(recDl2.stdout).toContain('[cache]');

    // URL command without --year/--place
    const simpleUrl = await runOa(['url', '--name', 'Pieter van Dijk'], cacheDir, fetchImpl);
    expect(simpleUrl.stdout).toBe('https://www.openarchieven.nl/search.php?name=Pieter+van+Dijk');
  });

  it('classifies all scan binary formats, rejects corrupt cache/markup/empty payloads, and handles candidate fallbacks', async () => {
    const cacheDir = await makeTempDir('kinloom-oa-scan-');

    const formatCases: ReadonlyArray<readonly [string, Uint8Array, string, string]> = [
      ['https://scans.example.test/a.webp', WEBP_MAGIC, 'application/octet-stream', 'webp'],
      ['https://scans.example.test/a.tif', TIFF_LE_MAGIC, 'application/octet-stream', 'tif'],
      ['https://scans.example.test/b.tif', TIFF_BE_MAGIC, 'application/octet-stream', 'tif'],
      ['https://scans.example.test/a.jp2', JP2_BOX_MAGIC, 'application/octet-stream', 'jp2'],
      ['https://scans.example.test/b.jp2', JP2_STREAM_MAGIC, 'application/octet-stream', 'jp2'],
      ['https://scans.example.test/a.gif', GIF87_MAGIC, 'application/octet-stream', 'gif'],
      ['https://scans.example.test/ct.png', Uint8Array.from([0x01, 0x02, 0x03]), 'image/png', 'png'],
    ];

    for (const [url, bytes, ct, expectedExt] of formatCases) {
      const ctx = makeCtx({
        fetchImpl: async () => bytesResp(bytes, ct),
      });
      const res = await downloadScanCandidates(ctx, cacheDir, [[url, false]], {
        refresh: true,
        ttlHours: 168,
      });
      expect(res.ext).toBe(expectedExt);
    }

    // Empty body, XML markup, and unknown binary with missing content-type fail cleanly
    const errCases: ReadonlyArray<readonly [Response, string]> = [
      [new Response(new Uint8Array(), { status: 200 }), 'The download was empty.'],
      [
        new Response('<?xml version="1.0"?><error/>', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
        'The server returned HTML, not an image or PDF.',
      ],
      [
        new Response(Uint8Array.from([0x01, 0x02, 0x03]), { status: 200 }),
        'The server did not return an image or PDF (missing content-type).',
      ],
    ];
    for (const [response, expectedMsg] of errCases) {
      const ctx = makeCtx({ fetchImpl: async () => response });
      await expect(
        downloadScanCandidates(ctx, cacheDir, [['https://scans.example.test/bad', false]], {
          refresh: true,
          ttlHours: 168,
        })
      ).rejects.toThrow(expectedMsg);
    }

    // Empty candidates list and fallbackOn5xx=true recovery
    const fallbackCtx = makeCtx({
      fetchImpl: async (input) => {
        if (String(input).endsWith('/primary')) {
          return new Response('err', { status: 500 });
        }
        return bytesResp(JPEG_MAGIC, 'image/jpeg');
      },
    });
    await expect(
      downloadScanCandidates(fallbackCtx, cacheDir, [], { refresh: false, ttlHours: 168 })
    ).rejects.toThrow('No downloadable scan URL was found.');
    const recovered = await downloadScanCandidates(
      fallbackCtx,
      cacheDir,
      [
        ['https://scans.example.test/primary', true],
        ['https://scans.example.test/secondary', false],
      ],
      { refresh: true, ttlHours: 168 }
    );
    expect(recovered.resolvedUrl).toBe('https://scans.example.test/secondary');
    expect(recovered.ext).toBe('jpg');

    // readCachedScan invalidation cases
    const binPath = path.join(cacheDir, 'c.bin');
    const metaPath = path.join(cacheDir, 'c.json');
    const now = () => 2_000_000_000_000;
    expect(readCachedScan(binPath, metaPath, 0, now)).toBeUndefined();
    expect(readCachedScan(binPath, metaPath, 10, now)).toBeUndefined();
    fs.writeFileSync(binPath, JPEG_MAGIC);
    fs.writeFileSync(metaPath, JSON.stringify({ schema: 99, fetched_at: 2_000_000_000, nbytes: 8 }));
    expect(readCachedScan(binPath, metaPath, 10, now)).toBeUndefined();
    fs.writeFileSync(metaPath, JSON.stringify({ schema: 1, fetched_at: 'bad', nbytes: 8 }));
    expect(readCachedScan(binPath, metaPath, 10, now)).toBeUndefined();
    fs.writeFileSync(metaPath, JSON.stringify({ schema: 1, fetched_at: 100, nbytes: 8 }));
    expect(readCachedScan(binPath, metaPath, 1, now)).toBeUndefined();
    fs.writeFileSync(metaPath, JSON.stringify({ schema: 1, fetched_at: 2_000_000_000, nbytes: 999 }));
    expect(readCachedScan(binPath, metaPath, 10, now)).toBeUndefined();

    // getJson invalid JSON, API error fallback, and non-object search payload
    expect(
      (
        await runOa(
          ['search', '--name', 'Pieter'],
          cacheDir,
          async () => new Response('not-json', { status: 200 })
        )
      ).stderr
    ).toContain('Invalid JSON from');
    expect(
      (
        await runOa(['search', '--name', 'Pieter'], cacheDir, async () =>
          jsonResp({ error_code: 9, error: 'Quota' })
        )
      ).stderr
    ).toContain('OpenArchieven API error 9: Quota');
    expect(
      (await runOa(['search', '--name', 'Pieter'], cacheDir, async () => jsonResp({ error_code: 10 }))).stderr
    ).toContain('Unknown API error');
    expect(
      (await runOa(['search', '--name', 'Pieter'], cacheDir, async () => jsonResp(['not-object']))).stderr
    ).toContain('Unexpected non-object search response');
  });
});

// ============================================================================
// 4. wikitree
// ============================================================================

describe('wikitree behavioral edge cases', () => {
  async function runWt(
    args: readonly string[],
    cacheDir: string,
    fetchImpl?: typeof fetch,
    extraEnv: NodeJS.ProcessEnv = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx = makeCtx({
      stdout,
      stderr,
      env: { KINLOOM_WIKITREE_CACHE_DIR: cacheDir, ...extraEnv },
      fetchImpl,
    });
    const out = await runWikitreeCommand(args, ctx);
    return {
      exitCode: out.exitCode,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      cacheHit: out.cacheHit,
    };
  }

  it('covers domain helpers: name resolution conflicts, status checks, cache hit wrapper, and person line formatting', () => {
    expect(normalizeProfileKey('https://wikitree.com/wiki/Doe-101?ref=test')).toBe('Doe-101');
    expect(resolveSearchName(['Jane', 'Ann', 'Doe'], undefined, undefined, undefined)).toEqual([
      'Jane Ann',
      'Doe',
    ]);
    expect(resolveSearchName(['Doe'], undefined, undefined, undefined)).toEqual([undefined, 'Doe']);
    expect(resolveSearchName(['Doe'], undefined, 'Jane', undefined)).toEqual(['Jane', 'Doe']);
    expect(resolveSearchName(['Jane'], undefined, undefined, 'Doe')).toEqual(['Jane', 'Doe']);
    expect(() => resolveSearchName(['Jane'], 'John Doe', undefined, undefined)).toThrow(
      'Pass either positional name arguments or --name, not both.'
    );
    expect(() => resolveSearchName(['Extra'], undefined, 'Jane', 'Doe')).toThrow(
      'Pass either positional name / --name or --first/--last, not both.'
    );

    expect(() => checkStatus([], 'getPerson')).toThrow('getPerson: empty response from WikiTree API');
    expect(jsonWithCacheHit([], true)).toEqual([]);

    expect(
      formatPersonLine({
        Id: 404,
        FirstName: 'Jane',
        LastNameCurrent: 'Doe',
        BirthDate: '0000-00-00',
        DeathDate: '0000-00-00',
      })
    ).toBe('404: Jane Doe (b. ?)');
  });

  it('runs ancestors, person bio/redirect/profile fallbacks, sparse search, empty bio, help, and non-array transport errors', async () => {
    const cacheDir = await makeTempDir('kinloom-wt-');
    const seenUrls: URL[] = [];

    const ANCESTORS_RESP = [
      {
        status: 0,
        resultByKey: { 'Doe-101': { Id: 101 } },
        people: {
          '101': {
            Id: 101,
            Name: 'Doe-101',
            FirstName: 'Jane',
            LastNameAtBirth: 'Doe',
            BirthDate: '1900-01-01',
          },
          '102': {
            Id: 102,
            Name: 'Doe-102',
            FirstName: 'John',
            LastNameAtBirth: 'Doe',
            BirthDate: '1870-03-04',
            BirthLocation: 'Oakville, Ohio',
          },
          '103': { Id: 103, Name: 'Smith-10', FirstName: 'Mary', LastNameAtBirth: 'Smith', BirthDate: '' },
          '104': { Id: 104, Name: 'Brown-10', FirstName: 'Alice', LastNameAtBirth: 'Brown', BirthDate: '' },
        },
      },
    ];

    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      seenUrls.push(url);
      const action = url.searchParams.get('action');
      if (action === 'searchPerson') {
        return jsonResp([
          {
            status: 0,
            total: 1,
            matches: [{ Id: 555 }],
          },
        ]);
      }
      if (action === 'getPerson') {
        const key = url.searchParams.get('key');
        if (key === 'Missing-1') {
          return jsonResp([{ status: 0 }]);
        }
        return jsonResp([
          {
            status: 0,
            profile: {
              Id: 101,
              Name: 'Doe-101',
              FirstName: 'Jane',
              LastNameAtBirth: 'Doe',
              BirthDate: '1900-01-01',
              Bio: '== Bio ==\nSynthetic test biography.',
            },
          },
        ]);
      }
      if (action === 'getPeople') {
        return jsonResp(ANCESTORS_RESP);
      }
      if (action === 'getBio') {
        if (url.searchParams.get('key') === 'Empty-1') {
          return jsonResp([{ status: 0, bio: '' }]);
        }
        return jsonResp([{ status: 0, bio: '== Biography ==\nOakville resident.' }]);
      }
      return jsonResp({ not: 'an-array' });
    };

    // Help & unknown subcommand
    for (const sub of ['search', 'person', 'ancestors', 'bio']) {
      const h = await runWt([sub, '--help'], cacheDir, fetchImpl);
      expect(h.exitCode).toBe(0);
      expect(h.stdout).toContain(`kinloom wikitree ${sub}`);
    }
    expect((await runWt(['unknown'], cacheDir, fetchImpl)).exitCode).toBe(2);

    // Search conflicting --page & --start
    expect(
      (await runWt(['search', 'Jane', 'Doe', '--page', '1', '--start', '0'], cacheDir, fetchImpl)).exitCode
    ).toBe(2);

    // Search with death date/location/date-include + sparse match text formatting + custom WIKITREE_APP_ID
    const sSparse = await runWt(
      [
        'search',
        '--name',
        'Jane Doe',
        '--death-date',
        '1970',
        '--death-location',
        'Oakville',
        '--date-include',
        'both',
      ],
      cacheDir,
      fetchImpl,
      { WIKITREE_APP_ID: 'KinloomTestApp' }
    );
    expect(sSparse.exitCode).toBe(0);
    expect(seenUrls[0].searchParams.get('appId')).toBe('KinloomTestApp');
    expect(seenUrls[0].searchParams.get('DeathDate')).toBe('1970');
    expect(seenUrls[0].searchParams.get('DeathLocation')).toBe('Oakville');
    expect(seenUrls[0].searchParams.get('dateInclude')).toBe('both');
    expect(sSparse.stdout).toBe(
      '1 match(es), showing 1:\nId 555: sparse match, run `person 555` for details'
    );

    // Person with --bio-format auto-adding Bio, --resolve-redirect, profile fallback, and missing profile error
    const pBio = await runWt(
      ['person', 'Doe-101', '--bio-format', 'wiki', '--resolve-redirect'],
      cacheDir,
      fetchImpl
    );
    expect(pBio.exitCode).toBe(0);
    expect(seenUrls[1].searchParams.get('fields')).toContain(',Bio');
    expect(seenUrls[1].searchParams.get('resolveRedirect')).toBe('1');
    expect(pBio.stdout).toBe('Doe-101: Jane Doe (b. 1900-01-01)\n== Bio ==\nSynthetic test biography.');

    const pStar = await runWt(
      ['person', 'Doe-101', '--fields', '*', '--bio-format', 'html', '--json'],
      cacheDir,
      fetchImpl
    );
    expect(pStar.exitCode).toBe(0);
    expect(seenUrls[2].searchParams.get('fields')).toBe('*');

    const pMissing = await runWt(['person', 'Missing-1'], cacheDir, fetchImpl);
    expect(pMissing.exitCode).toBe(1);
    expect(pMissing.stderr).toContain('getPerson Missing-1: no profile returned');

    // Ancestors text output (excludes subject 101, sorts by BirthDate then Name) + JSON + cache hit
    const aText = await runWt(['ancestors', 'Doe-101', '--depth', '2'], cacheDir, fetchImpl);
    expect(aText.exitCode).toBe(0);
    expect(aText.stdout).toBe(
      [
        '3 ancestor(s) within 2 generation(s) of Doe-101:',
        'Doe-102: John Doe (b. 1870-03-04), born Oakville, Ohio',
        'Brown-10: Alice Brown (b. ?)',
        'Smith-10: Mary Smith (b. ?)',
      ].join('\n')
    );
    const aJson = await runWt(['ancestors', 'Doe-101', '--depth', '2', '--json'], cacheDir, fetchImpl);
    expect(aJson.exitCode).toBe(0);
    expect(JSON.parse(aJson.stdout)[0].cache_hit).toBe(true);
    const aTextCached = await runWt(['ancestors', 'Doe-101', '--depth', '2'], cacheDir, fetchImpl);
    expect(aTextCached.stdout).toContain('3 ancestor(s) within 2 generation(s) of Doe-101: [cache]');

    // Bio text output (populated + empty miss + empty cache hit)
    const bText = await runWt(['bio', 'Doe-101'], cacheDir, fetchImpl);
    expect(bText.exitCode).toBe(0);
    expect(bText.stdout).toBe('== Biography ==\nOakville resident.');

    const bEmpty1 = await runWt(['bio', 'Empty-1'], cacheDir, fetchImpl);
    expect(bEmpty1.stdout).toBe('(no biography text returned)');
    const bEmpty2 = await runWt(['bio', 'Empty-1'], cacheDir, fetchImpl);
    expect(bEmpty2.stdout).toBe('(no biography text returned) [cache]');

    // Non-array JSON response from transport
    const nonArr = await runWt(['bio', 'Bad-1'], cacheDir, async () => jsonResp({ error: 'unexpected' }));
    expect(nonArr.exitCode).toBe(1);
    expect(nonArr.stderr).toContain('Unexpected API response:');
  });
});

// ============================================================================
// 5. caArchives (California Archives: OAC, Calisphere, Portal, Exhibits)
// ============================================================================

describe('caArchives behavioral edge cases', () => {
  async function runCa(
    args: readonly string[],
    cacheDir: string,
    fetchImpl?: typeof fetch,
    overrides?: CaArchivesOverrides
  ): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const ctx = makeCtx({
      stdout,
      stderr,
      env: { KINLOOM_CA_ARCHIVES_CACHE_DIR: cacheDir },
      fetchImpl,
    });
    const handler = overrides ? createCaArchivesCommand(overrides) : runCaArchivesCommand;
    const out = await handler(args, ctx);
    return {
      exitCode: out.exitCode,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      cacheHit: out.cacheHit,
    };
  }

  it('covers domain parsers, dedupers, timeout/nav predicates, and text formatter branches', () => {
    expect(isTimeoutFailure(new BrowserTimeoutError('goto', 50))).toBe(true);
    const namedTimeout = new Error('operation aborted');
    namedTimeout.name = 'TimeoutError';
    expect(isTimeoutFailure(namedTimeout)).toBe(true);
    expect(isTimeoutFailure(new Error('Request timed out'))).toBe(true);
    expect(isTimeoutFailure(new Error('regular error'))).toBe(false);
    expect(isTimeoutFailure('string')).toBe(false);

    expect(
      isNavigationContextDestroyed(
        new Error('Execution context was destroyed, most likely because of a navigation')
      )
    ).toBe(true);
    expect(isNavigationContextDestroyed('unrelated')).toBe(false);

    const portalParsed = parsePortalSearchHtml(
      `<html><body>
        <a href="/other/1">Ignored</a>
        <a href="/Items/Details/10">   </a>
        <a href="/Items/Details/11">Riverbend Petition</a>
        <a href="/Items/Details/11">Riverbend Petition Duplicate</a>
        <a href="/Items/Details/12">Oakville Ledger</a>
      </body></html>`,
      'https://archives.sos.ca.gov/Items?SearchText=Oakville',
      1
    );
    expect(portalParsed).toEqual({
      source: 'portal',
      url: 'https://archives.sos.ca.gov/Items?SearchText=Oakville',
      total: null,
      results: [
        { id: '11', title: 'Riverbend Petition', url: 'https://archives.sos.ca.gov/Items/Details/11' },
      ],
    });

    expect(parsePortalItemHtml('<html><body>No title tag</body></html>', '11', 'https://u')).toEqual({
      source: 'portal',
      id: '11',
      title: '(no title)',
      url: 'https://u',
    });

    expect(extractOmekaTitle({ 'dcterms:title': [{ '@value': 'Valley Map' }] })).toBe('Valley Map');
    expect(extractOmekaTitle({})).toBe('(untitled)');
    expect(extractOmekaTypes({ '@type': 'not-array' })).toBe('');

    expect(() => parseExhibitsSearchPayload('{bad', 'https://u', null)).toThrow(
      'Invalid JSON from https://u'
    );
    expect(() => parseExhibitsSearchPayload('{}', 'https://u', null)).toThrow(
      'Unexpected JSON response from https://u'
    );
    const exSearch = parseExhibitsSearchPayload(
      JSON.stringify(['skip', { 'o:id': 5, 'dcterms:title': [{ '@value': 'Valley Exhibit' }] }]),
      'https://u',
      null
    );
    expect(exSearch.total).toBe(2);
    expect(exSearch.results).toEqual([
      {
        id: '5',
        title: 'Valley Exhibit',
        type: '',
        url: 'https://exhibits.sos.ca.gov/s/exhibits/item/5',
      },
    ]);

    expect(() => parseExhibitsItemPayload('{bad', '5', 'https://u')).toThrow('Invalid JSON from https://u');
    expect(() => parseExhibitsItemPayload('[]', '5', 'https://u')).toThrow(
      'Unexpected JSON response from https://u'
    );
    const longDesc = 'D'.repeat(600);
    const exItem = parseExhibitsItemPayload(
      JSON.stringify({
        'o:title': 'Valley Exhibit',
        '@type': ['o:Item', 'dctype:StillImage'],
        'dcterms:description': [{ '@value': longDesc }],
      }),
      '5',
      'https://u'
    );
    expect(exItem.description).toHaveLength(500);
    expect(exItem.type).toBe('dctype:StillImage');

    expect(
      dedupeOacLinks(
        [
          { href: '', text: 'Empty href' },
          { href: '/findaid/1', text: '   ' },
          { href: '/findaid/1', text: 'First' },
          { href: '/findaid/1', text: 'Dup' },
          { href: '/findaid/2', text: 'Second' },
        ],
        'https://oac.cdlib.org',
        1
      )
    ).toEqual([{ title: 'First', url: 'https://oac.cdlib.org/findaid/1', kind: 'collection' }]);

    expect(
      dedupeCalisphereLinks(
        [
          { href: '/not-item/1', text: 'Skip' },
          { href: '/item/1', text: 'One' },
          { href: '/item/2', text: 'Two' },
        ],
        'https://calisphere.org',
        1
      )
    ).toEqual([{ title: 'One', url: 'https://calisphere.org/item/1' }]);

    // formatSourceText branches
    expect(
      formatSourceText({
        source: 'oac',
        url: 'https://oac.cdlib.org/search?q=Oakville',
        total: 10,
        results: [
          { title: 'Box 1', url: 'https://oac.cdlib.org/findaid/1', kind: 'component', type: 'dctype:Text' },
        ],
        cache_hit: false,
      })
    ).toEqual([
      'oac (10 total, showing 1)',
      '  https://oac.cdlib.org/search?q=Oakville',
      '  1. Box 1 [component] (dctype:Text)',
      '     https://oac.cdlib.org/findaid/1',
    ]);
    expect(
      formatSourceText({
        source: 'portal',
        url: 'https://u',
        total: null,
        results: [],
        cache_hit: false,
      })
    ).toEqual(['portal (showing 0)', '  https://u', '  No results.']);
    expect(
      formatSourceText({
        source: 'portal',
        url: 'https://u',
        total: null,
        results: [],
        error: 'HTTP 502',
        cache_hit: false,
      })
    ).toEqual(['portal (showing 0)', '  https://u', '  Error: HTTP 502']);
    expect(
      formatSourceText({
        source: 'oac',
        url: 'https://u',
        total: null,
        results: [],
        timed_out: true,
        error: 'Timed out waiting',
        cache_hit: false,
      })
    ).toEqual(['oac (showing 0)', '  https://u', '  Timed out: Timed out waiting']);
  });

  it('handles browser navigation-context retries, browser cache reuse, multi-source timeouts, and CLI help/validation', async () => {
    const cacheDir = await makeTempDir('kinloom-ca-cmd-');

    // Help & unknown subcommand & get validation
    for (const sub of ['search', 'url', 'get']) {
      const h = await runCa([sub, '--help'], cacheDir);
      expect(h.exitCode).toBe(0);
      expect(h.stdout).toContain(`ca-archives ${sub}`);
    }
    expect((await runCa(['bogus'], cacheDir)).exitCode).toBe(2);
    expect((await runCa(['get', '--portal', '1', '--exhibits', '2'], cacheDir)).exitCode).toBe(2);

    const urlOacOnly = await runCa(['url', 'Oakville', '--source', 'oac'], cacheDir);
    expect(urlOacOnly.stdout).toBe('oac: https://oac.cdlib.org/search?q=Oakville');

    // Browser navigation-context retry in waitForFunction & evaluate (using ctx.sleepFn fallback when waitForTimeout omitted)
    let launchCount = 0;
    let waitAttempts = 0;
    let evalAttempts = 0;
    const navRetryBrowser: OptionalBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          content: async () => '',
          waitForFunction: async () => {
            waitAttempts += 1;
            if (waitAttempts === 1) {
              throw new Error('Execution context was destroyed, most likely because of a navigation');
            }
            if (waitAttempts === 2) {
              throw new Error('heuristic missed');
            }
            return true;
          },
          evaluate: async <T>(fn: string | (() => T)): Promise<T> => {
            const expr = String(fn);
            evalAttempts += 1;
            if (evalAttempts === 1) {
              throw new Error('Execution context was destroyed, most likely because of a navigation');
            }
            const payload = expr.includes('innerText')
              ? 'Showing 1-1 of 1 entries'
              : [{ href: '/findaid/ark:/13030/c80001', text: 'Oakville Papers' }];
            return JSON.parse(JSON.stringify(payload));
          },
          close: async () => {},
        }),
        close: async () => {},
      }),
      close: async () => {},
    };

    const launcher = async (): Promise<OptionalBrowser> => {
      launchCount += 1;
      return navRetryBrowser;
    };

    // First run populates OAC cache; second run hits cache with zero extra browser launches!
    const oac1 = await runCa(['search', 'Oakville', '--source', 'oac'], cacheDir, undefined, { launcher });
    const oac2 = await runCa(['search', 'Oakville', '--source', 'oac', '--json'], cacheDir, undefined, {
      launcher,
    });
    expect(oac1.exitCode).toBe(0);
    expect(oac1.stdout).toContain('1. Oakville Papers [collection]');
    expect(oac2.exitCode).toBe(0);
    expect(JSON.parse(oac2.stdout).cache_hit).toBe(true);
    expect(launchCount).toBe(1);
    expect(waitAttempts).toBe(2);
    expect(evalAttempts).toBe(3);

    // Non-timeout error in browserSearch rethrows
    const failingBrowser: OptionalBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {
            throw new Error('fatal browser crash');
          },
          content: async () => '',
          evaluate: async <T>() => JSON.parse('null') as T,
          close: async () => {},
        }),
        close: async () => {},
      }),
      close: async () => {},
    };
    const ctx = makeCtx({ env: { KINLOOM_CA_ARCHIVES_CACHE_DIR: cacheDir } });
    await expect(
      browserSearch(ctx, ['oac'], 'Oakville', 5, 5000, async () => failingBrowser)
    ).rejects.toThrow('fatal browser crash');

    // Budget exhausted before second source in browserSearch
    let fakeNow = 1000;
    const budgetCtx = makeCtx({
      env: { KINLOOM_CA_ARCHIVES_CACHE_DIR: cacheDir },
      nowMs: () => fakeNow,
    });
    const slowFirstBrowser: OptionalBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          content: async () => '',
          evaluate: async <T>(fn: string | (() => T)): Promise<T> => {
            const expr = String(fn);
            if (expr.includes('innerText')) {
              return JSON.parse(JSON.stringify('Showing 1-1 of 1 entries'));
            }
            fakeNow += 200;
            return JSON.parse(JSON.stringify([{ href: '/findaid/1', text: 'First Source' }]));
          },
          close: async () => {},
        }),
        close: async () => {},
      }),
      close: async () => {},
    };
    const budgetRes = await browserSearch(
      budgetCtx,
      ['oac', 'calisphere'],
      'Oakville',
      5,
      100,
      async () => slowFirstBrowser
    );
    expect(budgetRes.oac?.results).toHaveLength(1);
    expect(budgetRes.calisphere?.timed_out).toBe(true);
    expect(budgetRes.calisphere?.error).toContain('budget (100ms) exhausted before calisphere');

    // Multi-source portal timeout degrades gracefully when paired with exhibits, and vice versa
    const portalTimeoutFetch: typeof fetch = async (input) => {
      if (new URL(String(input)).hostname === 'archives.sos.ca.gov') {
        throw new Error('Request timed out');
      }
      return jsonResp([{ 'o:id': 7, 'o:title': 'Oakville Exhibit', '@type': ['o:Item'] }], 200, {
        'Omeka-S-Total-Results': '1',
      });
    };
    const degraded1 = await runCa(
      ['search', 'Oakville', '--source', 'portal', '--source', 'exhibits', '--json'],
      cacheDir,
      portalTimeoutFetch
    );
    expect(degraded1.exitCode).toBe(0);
    expect(degraded1.stderr).toContain('Warning: portal timed out:');
    expect(JSON.parse(degraded1.stdout).timed_out_sources).toEqual(['portal']);

    const exhibitsTimeoutFetch: typeof fetch = async (input) => {
      if (new URL(String(input)).hostname === 'exhibits.sos.ca.gov') {
        throw new Error('Request timed out');
      }
      return new Response(
        '<html><body><p>Search Results 1 to 1 of 1</p><a href="/Items/Details/7">Oakville Deed</a></body></html>',
        { status: 200 }
      );
    };
    const degraded2 = await runCa(
      ['search', 'Oakville', '--source', 'portal', '--source', 'exhibits', '--refresh'],
      cacheDir,
      exhibitsTimeoutFetch
    );
    expect(degraded2.exitCode).toBe(0);
    expect(degraded2.stderr).toContain('Warning: exhibits timed out:');
    expect(degraded2.stdout).toContain(
      'Timed out: Network error fetching https://exhibits.sos.ca.gov/api/items?search=Oakville&per_page=10: Request timed out'
    );

    // Single-source timeout throws and exits 1
    const singleTimeout = await runCa(
      ['search', 'Oakville', '--source', 'exhibits', '--refresh'],
      cacheDir,
      exhibitsTimeoutFetch
    );
    expect(singleTimeout.exitCode).toBe(1);
    expect(singleTimeout.stderr).toContain('timed out');
  });
});
