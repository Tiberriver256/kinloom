import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError } from '../../errors.js';
import { extractGnisTxt, loadGnisRows } from './clients/gnis/domain.js';
import { queryCachePath, readCachedSearch } from './clients/gnis/transport.js';
import { runGnisCommand } from './clients/gnis.js';
import { parseLandResults, parsePreservicaRss, runKyArchivesCommand } from './clients/ky-archives.js';
import {
  filenameFromContentDisposition,
  isHtmlPayload,
  parseItemHtml,
  parseSearchHtml,
  resolveItemRef,
  sanitizeServerFilename,
  validateMichiganologyUrl,
  validateTimeout,
} from './clients/michiganology/domain.js';
import { resolveDownloadDest } from './clients/michiganology/transport.js';
import { runMichiganologyCommand } from './clients/michiganology.js';
import {
  buildPeopleQuery,
  detectImageFormat,
  normalizeIsoDate,
  parseNewspapersSearchHtml,
  resolveRecordType,
  runMnArchivesCommand,
  validateMnUrl,
  validateNewspaperDocId,
} from './clients/mn-archives.js';
import { getCacheDir as getMnCacheDir } from './clients/mnArchives/domain.js';
import { looksLikeHtml, normalizePeopleHit } from './clients/mnArchives/parsers.js';
import { fetchPeopleRecord } from './clients/mnArchives/transport.js';
import {
  parseDeathRows,
  parseDetailFields,
  parsePre1910Rows,
  runMoArchivesCommand,
} from './clients/mo-archives.js';
import { extractFormToken, findResultsTable, safePdfFilename } from './clients/moArchives/domain.js';
import {
  matchOptionValue,
  DATABASES as NJ_DATABASES,
  parseGrid,
  runNjArchivesCommand,
  searchPortal,
  sequenceSimilarity,
} from './clients/nj-archives.js';
import { parsePortalDatabaseList, validateCriteria } from './clients/njArchives/parsers.js';
import { parsePersiArticles, parsePersiCategories, runPersiCommand } from './clients/persi.js';
import {
  entryMatchesFilters,
  extractArkId,
  parseIsoDate,
  parseItemDate,
  parseOaiRecord,
  parseTdaRss,
  runTexasArchivesCommand,
} from './clients/texas-archives.js';
import { fetchOpenSearchPage } from './clients/texasArchives/transport.js';
import { parseFreeregResults, runUkArchivesCommand, validateUkArchivesUrl } from './clients/uk-archives.js';
import {
  extractFreeregToken,
  mapDiscoveryDetail,
  matchesCollection,
  normalizeDateFrom,
  normalizeDateTo,
} from './clients/ukArchives/domain.js';
import {
  normalizeLvaImageUrl,
  parsePageSpec,
  parseRosettaViewer,
  resolveTtlHours as resolveVaTtlHours,
  runVaArchivesCommand,
  CACHE_ENV as VA_CACHE_ENV,
} from './clients/va-archives.js';
import { formatChanceryRecordText } from './clients/vaArchives/domain.js';
import { mapPnxsRecord } from './clients/vaArchives/parsers.js';
import { isCacheMetaValid } from './clients/vaArchives/transport.js';
import {
  CURL_META_MARKER,
  createRecordContext,
  type ExecFileFn,
  type RecordCommandContext,
  type RecordHandler,
  RecordRuntimeError,
} from './runtime/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix = 'kinloom-c6b-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface InvokeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cacheHit?: boolean;
}

async function invokeHandler(
  handler: RecordHandler,
  args: readonly string[],
  opts: {
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly fetchImpl?: typeof fetch;
    readonly execFileImpl?: ExecFileFn;
    readonly nowMs?: () => number;
    readonly sleepFn?: (ms: number) => Promise<void>;
  } = {}
): Promise<InvokeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: RecordCommandContext = createRecordContext({
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
    execFileImpl: opts.execFileImpl,
    nowMs: opts.nowMs,
    sleepFn: opts.sleepFn ?? (async () => {}),
  });
  const outcome = await handler(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

function makeCurlStdout(body: string | Buffer, status: number, effectiveUrl: string): Buffer {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return Buffer.concat([bodyBuf, Buffer.from(`\n${CURL_META_MARKER}\n${status}\n${effectiveUrl}`, 'utf8')]);
}

function writeCurlHeaders(args: readonly string[], rawHeaders: string): void {
  const idx = args.indexOf('-D');
  if (idx !== -1 && idx + 1 < args.length) {
    fs.writeFileSync(args[idx + 1], rawHeaders, 'utf8');
  }
}

const SYNTHETIC_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');
const SYNTHETIC_ZIP = Buffer.from('PK\x03\x04synthetic-zip-archive', 'utf8');
const SYNTHETIC_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const SYNTHETIC_GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'ascii');
const SYNTHETIC_WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('VP8 ', 'ascii'),
]);
const SYNTHETIC_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

// ============================================================================
// 1. Virginia Archives (vaArchives)
// ============================================================================
describe('va-archives behavioral coverage', () => {
  const CHANCERY_PAGE_1 = `<html><body>
<p>Your search returned 25 record(s). You are now viewing records 1 through 20</p>
<table><tr>
  <td><span><strong>Index Number:</strong> 1851-010</span>
      <a href="case_detail.asp?CFN=099-1851-010">View</a></td>
  <td><strong>Locality:</strong> OAKVILLE CO</td>
  <td valign="top">Carter, Samuel</td>
  <td valign="top">Doe, Jane</td>
</tr></table>
</body></html>`;

  const CHANCERY_PAGE_2 = `<html><body>
<p>Your search returned 25 record(s). You are now viewing records 21 through 25</p>
<table><tr>
  <td><span><strong>Index Number:</strong> 1852-020</span>
      <a href="case_detail.asp?CFN=099-1852-020">View</a></td>
  <td><strong>Locality:</strong> OAKVILLE CO</td>
  <td valign="top">Carter, Hannah</td>
  <td valign="top"></td>
</tr></table>
</body></html>`;

  const CHANCERY_CASE_HTML = `<html><body>
<table>
  <tr><td><strong>Locality</strong></td><td><strong>Index Number</strong></td><td><strong>Original Case Number</strong></td></tr>
  <tr><td>OAKVILLE CO</td><td>1851-010</td><td>7B</td></tr>
  <tr><td><strong>Plaintiff(s)</strong></td><td><strong>Defendant(s)</strong></td></tr>
  <tr><td>Carter, Samuel</td><td>Doe, Jane</td></tr>
  <tr><td><strong>Surname(s)</strong></td></tr>
  <tr><td>Carter<br />Doe</td></tr>
  <tr><td><strong>Wills</strong></td><td><strong>Plat?</strong></td></tr>
  <tr><td>Samuel Carter 1849</td><td>Yes</td></tr>
  <tr><td><strong>Format</strong></td></tr>
  <tr><td>Digital</td></tr>
</table>
</body></html>`;

  const CHANCERY_IMAGES_HTML = `<html><script>
myImages[0] = "/ChanceryImg/Oakville/Box1/099-1851-010_0001.pdf";
</script><body>Page 1 of 2 prev next <a href="/chancery/zip/download.php?cfn=099-1851-010">ZIP</a></body></html>`;

  const LOCALITIES_HTML = `<table>
<TR><TD>OAKVILLE CO</td><TD>Riverbend</td><TD>1790-1910</td><TD>Available Online</td><TD>Complete</td></TR>
<TR><TD>MAPLE CO</td><TD>Valley</td><TD>1800-1890</td><TD>Microfilm Only</td><TD>In progress</td></TR>
</table>`;

  it('paginates chancery search with filters and formats text output; rejects bad --match', async () => {
    const tmp = await makeTempDir('kinloom-va-c6b-');
    const cacheDir = path.join(tmp, 'cache');
    const postedBodies: string[] = [];

    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? '');
      postedBodies.push(body);
      if (body.includes('intPage=2')) {
        return new Response(CHANCERY_PAGE_2, { status: 200 });
      }
      return new Response(CHANCERY_PAGE_1, { status: 200 });
    };

    const badMatch = await invokeHandler(
      runVaArchivesCommand,
      ['chancery', 'search', 'Carter', '--match', 'fuzzy'],
      {
        env: { [VA_CACHE_ENV]: cacheDir },
        cwd: tmp,
      }
    );
    expect(badMatch.exitCode).toBe(2);
    expect(badMatch.stderr).toContain("Invalid value 'fuzzy' for '--match'");

    const res = await invokeHandler(
      runVaArchivesCommand,
      [
        'chancery',
        'search',
        'Carter',
        '--surname2',
        'Doe',
        '--enslaved',
        '--free',
        '--plats',
        '--match',
        'includes',
        '--pages',
        'all',
      ],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl }
    );

    expect(res.exitCode).toBe(0);
    expect(postedBodies).toHaveLength(2);
    expect(postedBodies[0]).toContain('surname2=Doe');
    expect(postedBodies[0]).toContain('sn2select=Includes');
    expect(postedBodies[0]).toContain('chkEnslaved=on');
    expect(postedBodies[0]).toContain('chkFree=on');
    expect(postedBodies[0]).toContain('chkPlat=on');
    expect(postedBodies[1]).toContain('intPage=2');
    expect(res.stdout).toContain('25 record(s); showing 2:');
    expect(res.stdout).toContain('099-1851-010  OAKVILLE CO  index 1851-010');
    expect(res.stdout).toContain('  P: Carter, Samuel');
    expect(res.stdout).toContain('  D: Doe, Jane');
    expect(res.stdout).toContain('099-1852-020  OAKVILLE CO  index 1852-020');
  });

  it('formats chancery case text with images, skips existing downloads, filters localities, and validates CFN', async () => {
    const tmp = await makeTempDir('kinloom-va-c6b-');
    const cacheDir = path.join(tmp, 'cache');

    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/case_detail.asp')) {
        return new Response(CHANCERY_CASE_HTML, { status: 200 });
      }
      if (url.pathname.endsWith('/case_images.asp')) {
        return new Response(CHANCERY_IMAGES_HTML, { status: 200 });
      }
      if (url.pathname.endsWith('/available.asp')) {
        return new Response(LOCALITIES_HTML, { status: 200 });
      }
      if (url.pathname.endsWith('.pdf')) {
        return new Response(SYNTHETIC_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      if (url.pathname.endsWith('/zip/download.php')) {
        return new Response(SYNTHETIC_ZIP, { status: 200, headers: { 'content-type': 'application/zip' } });
      }
      return new Response('not found', { status: 404 });
    };

    const caseText = await invokeHandler(
      runVaArchivesCommand,
      ['chancery', 'case', '099-1851-010', '--images'],
      {
        env: { [VA_CACHE_ENV]: cacheDir },
        cwd: tmp,
        fetchImpl,
      }
    );
    expect(caseText.exitCode).toBe(0);
    expect(caseText.stdout).toContain('099-1851-010  OAKVILLE CO  index 1851-010 (original case no. 7B)');
    expect(caseText.stdout).toContain('Plaintiff(s): Carter, Samuel');
    expect(caseText.stdout).toContain('Defendant(s): Doe, Jane');
    expect(caseText.stdout).toContain('Wills: Samuel Carter 1849  Plat: Yes  Format: Digital');
    expect(caseText.stdout).toContain('Images: 2 page(s)');
    expect(caseText.stdout).toContain(
      'ZIP: https://old.lva.virginia.gov/chancery/zip/download.php?cfn=099-1851-010'
    );

    const badCfn = await invokeHandler(runVaArchivesCommand, ['chancery', 'download', 'bad/cfn'], {
      env: { [VA_CACHE_ENV]: cacheDir },
      cwd: tmp,
    });
    expect(badCfn.exitCode).toBe(2);
    expect(badCfn.stderr).toContain('Invalid CFN');

    const outDir = path.join(tmp, 'pdfs');
    const dl1 = await invokeHandler(
      runVaArchivesCommand,
      ['chancery', 'download', '099-1851-010', '--pages', 'all', '--out', outDir],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl }
    );
    expect(dl1.exitCode).toBe(0);
    expect(dl1.stdout).toContain('saved ');
    expect(dl1.stdout).toContain('metadata: ');

    const dl2 = await invokeHandler(
      runVaArchivesCommand,
      ['chancery', 'download', '099-1851-010', '--pages', '1', '--out', outDir],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl }
    );
    expect(dl2.exitCode).toBe(0);
    expect(dl2.stdout).toContain('exists, skipping: 099-1851-010_0001.pdf');

    const zipDir = path.join(tmp, 'zip');
    await invokeHandler(
      runVaArchivesCommand,
      ['chancery', 'download', '099-1851-010', '--zip', '--out', zipDir],
      {
        env: { [VA_CACHE_ENV]: cacheDir },
        cwd: tmp,
        fetchImpl,
      }
    );
    const zipSkip = await invokeHandler(
      runVaArchivesCommand,
      ['chancery', 'download', '099-1851-010', '--zip', '--out', zipDir],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl }
    );
    expect(zipSkip.exitCode).toBe(0);
    expect(zipSkip.stdout).toContain('exists, skipping:');

    const locText = await invokeHandler(
      runVaArchivesCommand,
      ['chancery', 'localities', '--status', 'available'],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl }
    );
    expect(locText.exitCode).toBe(0);
    expect(locText.stdout).toContain('OAKVILLE CO');
    expect(locText.stdout).not.toContain('MAPLE CO');
    expect(locText.stdout).toContain('1 localities');
  });

  it('handles catalog mapping/errors, url flags, dunmore errors/text, and rosetta fallback/HTML-rejection', async () => {
    const tmp = await makeTempDir('kinloom-va-c6b-');
    const cacheDir = path.join(tmp, 'cache');

    const primoPayload = {
      info: { total: 1, first: 1, last: 1 },
      docs: [
        {
          pnx: {
            control: { recordid: ['LVA_SYNTH_001'] },
            display: {
              title: ['Oakville County Deed Book 1'],
              creator: ['Samuel Carter'],
              creationdate: ['1848'],
              type: ['manuscript'],
              source: ['LVA'],
            },
          },
        },
      ],
    };

    const catText = await invokeHandler(runVaArchivesCommand, ['catalog', 'Oakville'], {
      env: { [VA_CACHE_ENV]: cacheDir },
      cwd: tmp,
      fetchImpl: async () => new Response(JSON.stringify(primoPayload), { status: 200 }),
    });
    expect(catText.exitCode).toBe(0);
    expect(catText.stdout).toContain('1 result(s); showing 1-1:');
    expect(catText.stdout).toContain('Oakville County Deed Book 1');
    expect(catText.stdout).toContain('Samuel Carter 1848 [manuscript]');
    expect(catText.stdout).toContain('docid=LVA_SYNTH_001');

    const badJson = await invokeHandler(runVaArchivesCommand, ['catalog', 'Broken', '--refresh'], {
      env: { [VA_CACHE_ENV]: cacheDir },
      cwd: tmp,
      fetchImpl: async () => new Response('{not valid json', { status: 200 }),
    });
    expect(badJson.exitCode).toBe(1);
    expect(badJson.stderr).toContain('Invalid Primo PNXS JSON');

    const urlAll = await invokeHandler(
      runVaArchivesCommand,
      ['url', '--catalog', 'Oakville', '--chancery', '--chronicle', '--arvas'],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp }
    );
    expect(urlAll.exitCode).toBe(0);
    expect(urlAll.stdout).toContain('query=any,contains,Oakville');
    expect(urlAll.stdout).toContain('https://www.lva.virginia.gov/collections/chancery');
    expect(urlAll.stdout).toContain('https://www.virginiachronicle.com/');
    expect(urlAll.stdout).toContain('https://arvasarchive.org/');

    const urlDefault = await invokeHandler(runVaArchivesCommand, ['url'], {
      env: { [VA_CACHE_ENV]: cacheDir },
      cwd: tmp,
    });
    expect(urlDefault.exitCode).toBe(0);
    expect(urlDefault.stdout).toContain('https://www.lva.virginia.gov/collections/digital-collections');

    // Dunmore empty page, missing page, and text output with --out
    const emptyDrawer = await invokeHandler(runVaArchivesCommand, ['dunmore', '0001/W0001', '1'], {
      env: { [VA_CACHE_ENV]: cacheDir },
      cwd: tmp,
      fetchImpl: async () => new Response('<html><body>No links here</body></html>', { status: 200 }),
    });
    expect(emptyDrawer.exitCode).toBe(1);
    expect(emptyDrawer.stderr).toContain("No page images found on the Dunmore's War drawer page.");

    const drawerHtml = `<html><body>Dunmore's War - Page 4
      <a href="/Microfilm/DW/001/00004.tif">current</a>
      <a href="/Microfilm/DW/001/00005.tif">Page 5</a></body></html>`;
    const drawerFetch: typeof fetch = async (input) => {
      if (String(input).endsWith('.tif')) {
        return new Response(Buffer.from('synthetic-tif', 'utf8'), { status: 200 });
      }
      return new Response(drawerHtml, { status: 200 });
    };
    const missingPage = await invokeHandler(
      runVaArchivesCommand,
      ['dunmore', '0001/W0002', '2', '--page', '99'],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl: drawerFetch }
    );
    expect(missingPage.exitCode).toBe(1);
    expect(missingPage.stderr).toContain('Page 99 is not listed for this card.');

    const dunmoreOut = path.join(tmp, 'dw-out.tif');
    const dunmoreText = await invokeHandler(
      runVaArchivesCommand,
      ['dunmore', '0001/W0002', '2', '--out', dunmoreOut],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl: drawerFetch }
    );
    expect(dunmoreText.exitCode).toBe(0);
    expect(dunmoreText.stdout).toContain("Dunmore's War drawer 0001/W0002 card 2: page 4");
    expect(dunmoreText.stdout).toContain(
      '* page 4: https://image.lva.virginia.gov/Microfilm/DW/001/00004.tif'
    );
    expect(dunmoreText.stdout).toContain(`saved ${dunmoreOut} (raw)`);

    // Rosetta: fallback viewer URL when iframe points off-host, text --list, --fl valid, --file out of range, HTML stream error, 0 files error
    const rosettaFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/delivery/DeliveryManagerServlet') {
        const pid = url.searchParams.get('dps_pid') ?? '';
        if (pid === 'IE800001') {
          return new Response(
            '<iframe src="https://archive.example.test/view/action/ieViewer.do?dps_pid=IE800001"></iframe>dps_dvs=55~66',
            { status: 200, headers: { 'set-cookie': 'JSESSIONID=s1; Path=/' } }
          );
        }
        if (pid === 'IE800002') {
          return new Response('<iframe src="http://[invalid-url"></iframe>', { status: 200 });
        }
        if (pid === 'FL800002') {
          return new Response('<html><body>Access Restricted</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        if (pid === 'FL800003') {
          return new Response(SYNTHETIC_PDF, {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }
      }
      if (url.pathname === '/view/action/ieViewer.do') {
        const pid = url.searchParams.get('dps_pid');
        if (pid === 'IE800002') {
          return new Response('<html><body>Empty viewer</body></html>', { status: 200 });
        }
        return new Response(
          `<script>initialSelect="FL800002"; var toc="<item id='FL800002' title='Front'></item>"; var JSONObject='{"extra":"FL800003"}';</script>`,
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const listText = await invokeHandler(runVaArchivesCommand, ['download-rosetta', 'IE800001', '--list'], {
      env: { [VA_CACHE_ENV]: cacheDir },
      cwd: tmp,
      fetchImpl: rosettaFetch,
    });
    expect(listText.exitCode).toBe(0);
    expect(listText.stdout).toContain('* 1. FL800002  Front');
    expect(listText.stdout).toContain('  2. FL800003  ');

    const badFileIndex = await invokeHandler(
      runVaArchivesCommand,
      ['download-rosetta', 'IE800001', '--file', '9'],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl: rosettaFetch }
    );
    expect(badFileIndex.exitCode).toBe(2);
    expect(badFileIndex.stderr).toContain('--file must be 1..2');

    const htmlDenied = await invokeHandler(
      runVaArchivesCommand,
      ['download-rosetta', 'IE800001', '--fl', 'FL800002'],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl: rosettaFetch }
    );
    expect(htmlDenied.exitCode).toBe(1);
    expect(htmlDenied.stderr).toContain('Rosetta returned HTML instead of a file');
    expect(fs.existsSync(path.join(cacheDir, 'rosetta', 'IE800001', 'FL800002.bin'))).toBe(false);

    const flOkOut = path.join(tmp, 'rosetta-fl3.pdf');
    const flOk = await invokeHandler(
      runVaArchivesCommand,
      ['download-rosetta', 'IE800001', '--fl', 'FL800003', '--out', flOkOut],
      { env: { [VA_CACHE_ENV]: cacheDir }, cwd: tmp, fetchImpl: rosettaFetch }
    );
    expect(flOk.exitCode).toBe(0);
    expect(fs.readFileSync(flOkOut)).toEqual(SYNTHETIC_PDF);

    const noFiles = await invokeHandler(runVaArchivesCommand, ['download-rosetta', 'IE800002', '--list'], {
      env: { [VA_CACHE_ENV]: cacheDir },
      cwd: tmp,
      fetchImpl: rosettaFetch,
    });
    expect(noFiles.exitCode).toBe(1);
    expect(noFiles.stderr).toContain('No delivered files found for IE800002');
  });

  it('exercises vaArchives domain, parsers, transport cache validation, and help screens', async () => {
    const tmp = await makeTempDir('kinloom-va-c6b-');

    expect(resolveVaTtlHours({}, 12)).toBe(12);
    expect(() => normalizeLvaImageUrl('/LONN/%ZZ.tif')).toThrow('Double/odd percent-encoding');
    expect(() => normalizeLvaImageUrl('/LONN/%25ZZ.tif')).toThrow('Double/odd percent-encoding');
    expect(() => normalizeLvaImageUrl('/LONN/bad!name.tif')).toThrow('Unsafe characters');

    expect(parsePageSpec('all', 3)).toEqual([1, 2, 3]);
    expect(parsePageSpec('3, , 1-2, 9', 4)).toEqual([1, 2, 3]);
    expect(() => parsePageSpec('a-b', 4)).toThrow(CliValidationError);
    expect(() => parsePageSpec('xyz', 4)).toThrow(CliValidationError);

    expect(
      formatChanceryRecordText({
        index_number: '1855-001',
        cfn: '099-1855-001',
        locality: 'OAKVILLE CO',
        plaintiffs: ['Jane Doe'],
        defendants: ['Samuel Carter'],
        case_url: 'https://old.lva.virginia.gov/chancery/case_detail.asp?CFN=099-1855-001',
      })
    ).toContain('P: Jane Doe');

    expect(parseRosettaViewer(`var JSONObject = '["not-record"]'; var JSONObject = '{bad';`).files).toEqual(
      []
    );
    expect(mapPnxsRecord(null)).toEqual({
      recordid: '',
      title: '',
      creator: '',
      date: '',
      type: '',
      source: '',
      record_url: '',
    });

    // isCacheMetaValid edge cases: directory path, missing file, non-finite cached_at
    const dirTarget = path.join(tmp, 'adir');
    fs.mkdirSync(dirTarget);
    fs.writeFileSync(`${dirTarget}.meta.json`, JSON.stringify({ cached_at: 100 }), 'utf8');
    expect(isCacheMetaValid(dirTarget, 10, () => 100_000)).toBeUndefined();

    const missingTarget = path.join(tmp, 'missing.body');
    fs.writeFileSync(`${missingTarget}.meta.json`, JSON.stringify({ cached_at: 100 }), 'utf8');
    expect(isCacheMetaValid(missingTarget, 10, () => 100_000)).toBeUndefined();

    const badMetaTarget = path.join(tmp, 'badmeta.body');
    fs.writeFileSync(badMetaTarget, 'ok', 'utf8');
    fs.writeFileSync(`${badMetaTarget}.meta.json`, JSON.stringify({ cached_at: 'bad' }), 'utf8');
    expect(isCacheMetaValid(badMetaTarget, 10, () => 100_000)).toBeUndefined();

    for (const helpArgs of [
      ['chancery', '--help'],
      ['chancery', 'search', '--help'],
      ['chancery', 'case', '--help'],
      ['chancery', 'download', '--help'],
      ['chancery', 'localities', '--help'],
      ['catalog', '--help'],
      ['url', '--help'],
      ['grant-tif', '--help'],
      ['dunmore', '--help'],
      ['download-rosetta', '--help'],
    ]) {
      const h = await invokeHandler(runVaArchivesCommand, helpArgs, { cwd: tmp });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });
});

// ============================================================================
// 2. Minnesota Archives (mnArchives)
// ============================================================================
describe('mn-archives behavioral coverage', () => {
  it('validates people query builders, dates, URLs, and record types', () => {
    expect(getMnCacheDir(createRecordContext({ env: { HOME: '/tmp/synth-home' } }))).toBe(
      path.join('/tmp/synth-home', '.cache', 'kinloom', 'mn-archives')
    );

    expect(() => validateMnUrl('not-a-url')).toThrow(CliValidationError);
    expect(() => validateMnUrl('http://www.mnhs.org/')).toThrow('Refusing non-HTTPS URL');
    expect(() => validateMnUrl('https://user:pass@www.mnhs.org/')).toThrow('embedded credentials');
    expect(() => resolveRecordType('nonexistent-collection')).toThrow('Unknown record type');

    expect(normalizeIsoDate('1918-04-15')).toBe('1918-04-15');
    expect(() => normalizeIsoDate('19xx')).toThrow('Invalid date');
    expect(() => normalizeIsoDate('1918-13')).toThrow('Invalid month');
    expect(() => normalizeIsoDate('1918-02-30')).toThrow('Invalid calendar date');

    const startsQuery = buildPeopleQuery('death-records', {
      last: 'Carter',
      first: 'Samuel',
      middle: 'J',
      match: 'starts-with',
      county: '   ',
    });
    expect(startsQuery.filters).toEqual([
      {
        conjunction: 'and',
        filters: [
          { field: 'familyName', term: 'Carter.*', op: '*' },
          { field: 'firstName', term: 'Samuel.*', op: '*' },
          { field: 'middleName', term: 'J.*', op: '*' },
        ],
      },
    ]);

    expect(buildPeopleQuery('death-records', { last: 'Doe', match: 'ends-with' }).filters[0]).toEqual({
      conjunction: 'and',
      filters: [{ field: 'familyName', term: '.*Doe', op: '*' }],
    });
    expect(buildPeopleQuery('death-records', { last: 'Doe', match: 'contains' }).filters[0]).toEqual({
      conjunction: 'and',
      filters: [{ field: 'familyName', term: '.*Doe.*', op: '*' }],
    });
    expect(buildPeopleQuery('death-records', { last: 'Doe', match: 'soundex' }).filters[0]).toEqual({
      conjunction: 'and',
      filters: [{ field: 'familyName', term: 'Doe', op: '$' }],
    });
    expect(buildPeopleQuery('death-records', { certId: '1920-MN-0001' }).filters).toEqual([
      { field: 'certificateId', term: '1920-MN-0001', op: '=' },
    ]);
    expect(buildPeopleQuery('gold-star', { county: 'Oakville County' }).filters).toEqual([
      {
        conjunction: 'or',
        filters: [{ field: 'residencePriorToService', term: '.*Oakville.*', op: '*' }],
      },
    ]);

    expect(() => buildPeopleQuery('death-records', { last: 'Doe', match: 'fuzzy' })).toThrow(
      "Unsupported --match value: 'fuzzy'"
    );
    expect(() => buildPeopleQuery('census', { last: 'Doe', motherMaiden: 'Carter' })).toThrow(
      '--mother-maiden is only supported'
    );
    expect(() => buildPeopleQuery('wwi-bonuses', { last: 'Doe', beginDate: '1918' })).toThrow(
      'Date filters are not supported'
    );
    expect(() => buildPeopleQuery('wwi-bonuses', { last: 'Doe', endDate: '1919' })).toThrow(
      'Date filters are not supported'
    );
    expect(() => buildPeopleQuery('death-records', {})).toThrow('Provide at least one filter');
  });

  it('exercises people/record CLI validation, API error shapes, militaryServices normalization, and text formatting', async () => {
    const tmp = await makeTempDir('kinloom-mn-c6b-');
    const env = { KINLOOM_CACHE_DIR: path.join(tmp, 'cache') };

    const hit = normalizePeopleHit('vets-graves', {
      id: '11111111-1111-4111-8111-111111111111',
      firstName: 'Samuel',
      familyName: 'Carter',
      deathDateStart: 1920,
      burialLocation: 'Oakville',
      militaryServices: [{ value: 'US Army' }, { value: 'Infantry' }],
    });
    expect(hit.date).toBe('');
    expect(hit.military_services).toEqual(['US Army', 'Infantry']);

    const badPage = await invokeHandler(runMnArchivesCommand, ['death', '--last', 'Carter', '--page', '0'], {
      env,
    });
    expect(badPage.exitCode).toBe(2);
    expect(badPage.stderr).toContain('--page must be >= 1');

    const badLimit = await invokeHandler(
      runMnArchivesCommand,
      ['death', '--last', 'Carter', '--limit', '101'],
      {
        env,
      }
    );
    expect(badLimit.exitCode).toBe(2);
    expect(badLimit.stderr).toContain('--limit must be between 1 and 100');

    const badUuid = await invokeHandler(runMnArchivesCommand, ['record', 'not-a-uuid', '--type', 'death'], {
      env,
    });
    expect(badUuid.exitCode).toBe(2);
    expect(badUuid.stderr).toContain('Invalid MNHS record UUID');

    await expect(
      fetchPeopleRecord(createRecordContext({ env }), 'death-records', 'bad-uuid')
    ).rejects.toThrow(CliValidationError);

    // API error shapes on search
    for (const [bodyText, expectedErr] of [
      ['not-json', 'returned non-JSON response'],
      [JSON.stringify({ success: false }), 'returned unsuccessful status'],
      [JSON.stringify({ success: true, data: 'bad' }), "missing 'data' object"],
      [JSON.stringify({ success: true, data: { hits: 'bad' } }), "missing 'hits' list"],
    ] as const) {
      const res = await invokeHandler(runMnArchivesCommand, ['death', '--last', 'Carter'], {
        env,
        fetchImpl: async () => new Response(bodyText, { status: 200 }),
      });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain(expectedErr);
    }

    // API error shapes on detail
    const uuid = '22222222-2222-4222-8222-222222222222';
    for (const [bodyText, expectedErr] of [
      ['not-json', 'returned non-JSON detail response'],
      [JSON.stringify({ success: false }), 'detail lookup failed'],
      [JSON.stringify({ success: true, data: {} }), 'MNHS record not found'],
    ] as const) {
      const res = await invokeHandler(runMnArchivesCommand, ['record', uuid, '--type', 'death'], {
        env,
        fetchImpl: async () => new Response(bodyText, { status: 200 }),
      });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain(expectedErr);
    }

    // Full text formatting for census search (locality + age) and record detail (birth_date + birth_place + cache hit)
    const detailPayload = {
      success: true,
      data: {
        id: uuid,
        deathDateStart: '1932-05-10T00:00:00',
        county: 'Oakville County',
        certificateId: '1932-MN-0042',
        firstName: 'Jane',
        familyName: 'Doe',
        mothersMaidenName: 'Carter',
        birthDate: '1860-03-01T00:00:00',
        birthPlace: 'Riverbend',
      },
    };
    const censusPayload = {
      success: true,
      data: {
        totalHitCount: 1,
        pageNum: 1,
        pageSize: 25,
        pageCount: 1,
        hits: [
          {
            id: uuid,
            censusDateStart: '1895-01-01T00:00:00',
            county: 'Oakville County',
            locality: 'Riverbend',
            age: '35',
            firstName: 'Jane',
            familyName: 'Doe',
          },
        ],
      },
    };
    let detailCalls = 0;
    const okFetch: typeof fetch = async (input) => {
      if (String(input).includes('getDeathRecordById')) {
        detailCalls += 1;
        return new Response(JSON.stringify(detailPayload), { status: 200 });
      }
      return new Response(JSON.stringify(censusPayload), { status: 200 });
    };

    const censusText = await invokeHandler(runMnArchivesCommand, ['census', '--last', 'Doe'], {
      env,
      fetchImpl: okFetch,
    });
    expect(censusText.exitCode).toBe(0);
    expect(censusText.stdout).toContain('Jane Doe | 1895-01-01 | Oakville County | Riverbend | age 35');

    const det1 = await invokeHandler(runMnArchivesCommand, ['record', uuid, '--type', 'death'], {
      env,
      fetchImpl: okFetch,
    });
    const det2 = await invokeHandler(runMnArchivesCommand, ['record', uuid, '--type', 'death'], {
      env,
      fetchImpl: okFetch,
    });
    expect(det1.exitCode).toBe(0);
    expect(det2.exitCode).toBe(0);
    expect(detailCalls).toBe(1);
    expect(det1.stdout).toContain("Mother's maiden name: Carter");
    expect(det1.stdout).toContain('Birth date: 1860-03-01');
    expect(det1.stdout).toContain('Birth place: Riverbend');
    expect(det2.stdout).toContain('[cache]');
  });

  it('exercises newspaper search filters, parsers, image format checks, download edge cases, mdl text, and help', async () => {
    const tmp = await makeTempDir('kinloom-mn-c6b-');
    const env = { KINLOOM_CACHE_DIR: path.join(tmp, 'cache') };

    // Parsers: image formats & HTML/XML sniff
    expect(detectImageFormat(SYNTHETIC_PNG)).toBe('png');
    expect(detectImageFormat(SYNTHETIC_GIF)).toBe('gif');
    expect(detectImageFormat(SYNTHETIC_WEBP)).toBe('webp');
    expect(detectImageFormat(Buffer.from('plain text', 'utf8'))).toBeNull();
    expect(
      looksLikeHtml(Buffer.from('<html><body>hi</body></html>', 'utf8'), 'application/octet-stream')
    ).toBe(true);
    expect(looksLikeHtml(Buffer.from('<?xml version="1.0"?>', 'utf8'), 'application/octet-stream')).toBe(
      true
    );
    expect(() => validateNewspaperDocId('../escape')).toThrow(CliValidationError);
    expect(() => validateNewspaperDocId('bad%E0%A4%A_ok')).toThrow(CliValidationError);

    const [, parsedNews] = parseNewspapersSearchHtml(`
      <table><tr>
        <td class="ps-result-cell">
          <a class="ps-result-title" href="/jsp/PsImageViewer.jsp?doc_id=oak/issue01">Oakville Gazette</a>
          <div class="ps-result-detail">Riverbend weekly edition</div>
        </td>
        <td class="ps-result-cell">
          <a class="ps-result-title" href="http://[::invalid">Broken Href</a>
        </td>
      </tr></table>`);
    expect(parsedNews).toHaveLength(1);
    expect(parsedNews[0].detail).toBe('Riverbend weekly edition');
    expect(parsedNews[0].thumb_url).toBe(
      'https://newspapers.mnhs.org/servlet/PsObjThumb?tnName=oak%2Fissue01'
    );

    // Validation errors on newspapers commands
    for (const [args, expected] of [
      [['newspapers', 'unknown'], "No such newspapers command 'unknown'"],
      [['newspapers', 'search', 'a'], 'at least 2 non-wildcard characters'],
      [['newspapers', 'search', 'foo:bar'], "cannot contain ':' or ';'"],
      [['newspapers', 'search', 'Carter', '--limit', '101'], '--limit must be between 1 and 100'],
      [['newspapers', 'search', 'Carter', '--offset', '-1'], '--offset must be >= 0'],
      [
        ['newspapers', 'search', 'Carter', '--begin-year', '1930', '--end-year', '1920'],
        'Begin date must not be after end date',
      ],
    ] as const) {
      const r = await invokeHandler(runMnArchivesCommand, args, { env });
      expect(r.exitCode, args.join(' ')).toBe(2);
      expect(r.stderr).toContain(expected);
    }

    // Newspaper search with county/city/title filters + text output
    let seenNewsUrl = '';
    const newsFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/jsp/PsSearchResults.jsp') {
        seenNewsUrl = url.toString();
        return new Response(
          `<script>var psRecCnt = 1;</script><table><tr><td class="ps-result-cell">
            <a class="ps-result-title" href="/jsp/PsImageViewer.jsp?doc_id=oak/issue01">Oakville Gazette</a>
            <div class="ps-result-detail">Publication Date: May 1, 1919</div>
          </td></tr></table>`,
          { status: 200 }
        );
      }
      if (url.pathname === '/jsp/PsMetadata.jsp') {
        if (url.searchParams.get('doc_id') === 'oak/empty') {
          return new Response('<html><body>No metadata table</body></html>', { status: 200 });
        }
        return new Response(
          '<table><tr><td class="ps-md-field-label">Title</td><td class="ps-md-field-value">Oakville Gazette</td></tr></table>',
          { status: 200 }
        );
      }
      if (url.searchParams.get('tnName') === 'oak/empty-bytes') {
        return new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url.searchParams.get('tnName') === 'oak/bad-bytes') {
        return new Response(Buffer.from('not-an-image', 'utf8'), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return new Response(SYNTHETIC_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };

    const newsText = await invokeHandler(
      runMnArchivesCommand,
      [
        'newspapers',
        'search',
        'Carter',
        '--county',
        'Oakville County',
        '--city',
        'Riverbend',
        '--title',
        'Gazette',
      ],
      { env, fetchImpl: newsFetch }
    );
    expect(newsText.exitCode).toBe(0);
    expect(seenNewsUrl).toContain('SUBJECT_COUNTY');
    expect(seenNewsUrl).toContain('SUBJECT_CITY');
    expect(seenNewsUrl).toContain('TITLE');
    expect(newsText.stdout).toContain('Oakville Gazette | May 1, 1919 | oak/issue01');

    const metaText = await invokeHandler(runMnArchivesCommand, ['newspapers', 'metadata', 'oak/issue01'], {
      env,
      fetchImpl: newsFetch,
    });
    expect(metaText.exitCode).toBe(0);
    expect(metaText.stdout).toContain('Newspaper Metadata (oak/issue01)');
    expect(metaText.stdout).toContain('  Title: Oakville Gazette');

    const metaEmpty = await invokeHandler(runMnArchivesCommand, ['newspapers', 'metadata', 'oak/empty'], {
      env,
      fetchImpl: newsFetch,
    });
    expect(metaEmpty.exitCode).toBe(1);
    expect(metaEmpty.stderr).toContain("No metadata found for newspaper doc_id 'oak/empty'");

    // Download via full HTTPS URL into directory, text output, skip, corrupt existing file, empty & non-image body
    const thumbDir = path.join(tmp, 'thumbs');
    fs.mkdirSync(thumbDir);
    const thumbUrl = 'https://newspapers.mnhs.org/servlet/PsObjThumb?tnName=oak/issue01';
    const dl1 = await invokeHandler(
      runMnArchivesCommand,
      ['newspapers', 'download', thumbUrl, '--out', thumbDir],
      { env, fetchImpl: newsFetch }
    );
    expect(dl1.exitCode).toBe(0);
    expect(dl1.stdout).toContain('Downloaded:');
    expect(dl1.stdout).toContain('jpeg');

    const dlSkip = await invokeHandler(
      runMnArchivesCommand,
      ['newspapers', 'download', thumbUrl, '--out', thumbDir],
      { env, fetchImpl: newsFetch }
    );
    expect(dlSkip.exitCode).toBe(0);
    expect(dlSkip.stdout).toContain('Exists (skip):');

    const corruptPath = path.join(tmp, 'corrupt.jpg');
    fs.writeFileSync(corruptPath, 'corrupt-data', 'utf8');
    const dlCorrupt = await invokeHandler(
      runMnArchivesCommand,
      ['newspapers', 'download', 'oak/issue01', '--out', corruptPath],
      { env, fetchImpl: newsFetch }
    );
    expect(dlCorrupt.exitCode).toBe(1);
    expect(dlCorrupt.stderr).toContain('not a valid image; pass --overwrite');

    const dlEmpty = await invokeHandler(
      runMnArchivesCommand,
      ['newspapers', 'download', 'oak/empty-bytes', '--out', path.join(tmp, 'empty.jpg')],
      { env, fetchImpl: newsFetch }
    );
    expect(dlEmpty.exitCode).toBe(1);
    expect(dlEmpty.stderr).toContain('Refusing empty response body');

    const dlNonImg = await invokeHandler(
      runMnArchivesCommand,
      ['newspapers', 'download', 'oak/bad-bytes', '--out', path.join(tmp, 'bad.jpg')],
      { env, fetchImpl: newsFetch }
    );
    expect(dlNonImg.exitCode).toBe(1);
    expect(dlNonImg.stderr).toContain('Refusing non-image payload');

    const dlBlankOut = await invokeHandler(
      runMnArchivesCommand,
      ['newspapers', 'download', 'oak/issue01', '--out', '   '],
      { env, fetchImpl: newsFetch }
    );
    expect(dlBlankOut.exitCode).toBe(2);
    expect(dlBlankOut.stderr).toContain('Invalid output path');

    // MDL text output + help screens
    const mdlText = await invokeHandler(runMnArchivesCommand, ['mdl'], { env });
    expect(mdlText.exitCode).toBe(0);
    expect(mdlText.stdout).toContain('Minnesota Digital Library (browser only):');

    for (const helpArgs of [
      ['death', '--help'],
      ['record', '--help'],
      ['newspapers', '--help'],
      ['newspapers', 'search', '--help'],
      ['newspapers', 'metadata', '--help'],
      ['newspapers', 'download', '--help'],
      ['mdl', '--help'],
    ]) {
      const h = await invokeHandler(runMnArchivesCommand, helpArgs, { env });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });
});

// ============================================================================
// 3. New Jersey Archives (njArchives)
// ============================================================================
describe('nj-archives behavioral coverage', () => {
  const PORTAL_LIST_HTML = `<html><body>
<table id="ctl00_ContentPlaceHolder1_GridView3">
  <tr>
    <td><a href="javascript:__doPostBack('ctl00$ContentPlaceHolder1$GridView3$ctl02$lbtnColonialMarriages','')">Early Land Records</a></td>
    <td>75,685 land records</td>
  </tr>
  <tr>
    <td><a href="javascript:__doPostBack('ctl00$ContentPlaceHolder1$GridView3$ctl99$lbtnUnknown','')">Custom Archive</a></td>
    <td>120 records</td>
  </tr>
  <tr><td>Header Without Postback</td><td>Count</td></tr>
</table>
<table id="OtherTable"><tr><td>Ignored</td></tr></table>
</body></html>`;

  it('lists live portal databases in text and JSON, parses grid edge cases, and validates options/roles', async () => {
    const cacheDir = await makeTempDir('kinloom-nj-c6b-');

    const parsedList = parsePortalDatabaseList(PORTAL_LIST_HTML);
    expect(parsedList).toEqual([
      { key: 'land', title: 'Early Land Records', count: '75,685 land records' },
      { key: '', title: 'Custom Archive', count: '120 records' },
    ]);

    const dbText = await invokeHandler(runNjArchivesCommand, ['databases'], {
      env: { KINLOOM_NJ_ARCHIVES_CACHE_DIR: cacheDir },
      fetchImpl: async () => new Response(PORTAL_LIST_HTML, { status: 200 }),
    });
    expect(dbText.exitCode).toBe(0);
    expect(dbText.stdout).toContain('Early Land Records [land] -- 75,685 land records');
    expect(dbText.stdout).toContain('Custom Archive -- 120 records');
    expect(dbText.stdout).toContain('Order-form only');

    const dbJson = await invokeHandler(runNjArchivesCommand, ['databases', '--json'], {
      env: { KINLOOM_NJ_ARCHIVES_CACHE_DIR: cacheDir },
      fetchImpl: async () => new Response(PORTAL_LIST_HTML, { status: 200 }),
    });
    expect(dbJson.exitCode).toBe(0);
    expect((JSON.parse(dbJson.stdout) as { key: string }[])[0].key).toBe('land');

    // sequenceSimilarity & parseGrid edge cases
    expect(sequenceSimilarity('', '')).toBe(1);
    expect(parseGrid('<html><body>no table</body></html>', 'GridView1')).toEqual([[], []]);
    expect(
      parseGrid(
        `<table id="GridView1">
          <tr></tr>
          <tr><td>  </td><td></td></tr>
          <tr><td>No Records Found</td></tr>
        </table>`,
        'GridView1'
      )
    ).toEqual([[], []]);

    const [synthHeaders, synthRows] = parseGrid(
      `<table id="GridView1">
        <tr><td>1 2 3</td></tr>
        <tr><td>Carter, Samuel</td><td>1845</td></tr>
      </table>
      <table id="GridView1_second"><tr><td>Ignored</td></tr></table>`,
      'GridView1'
    );
    expect(synthHeaders).toEqual(['col1', 'col2']);
    expect(synthRows).toHaveLength(1);
    expect(synthRows[0]['col1']).toBe('Carter, Samuel');

    // validateCriteria: bad select option, bad role, valid role
    const landFormHtml = `<select name="ctl00$ContentPlaceHolder1$ddlCounty">
      <option value="">All</option>
      <option value="Oakville">Oakville</option>
    </select>`;
    expect(matchOptionValue('Riverbend', ['Oakville'])).toBeNull();
    expect(() =>
      validateCriteria({ surname: 'Carter', county: 'Riverbend' }, NJ_DATABASES['land'], landFormHtml)
    ).toThrow('is not a valid choice for Early Land Records');
    expect(() =>
      validateCriteria({ surname: 'Carter', role: 'Witness' }, NJ_DATABASES['land'], landFormHtml)
    ).toThrow("--role 'Witness' is not valid here");
    expect(
      validateCriteria({ surname: 'Carter', role: 'grantor' }, NJ_DATABASES['land'], landFormHtml)['role']
    ).toBe('Grantor');
  });

  it('paginates multi-page portal results, retries/surfaces HTTP & network errors, and handles natguard/monmouth/url/help', async () => {
    const cacheDir = await makeTempDir('kinloom-nj-c6b-');
    const env = { KINLOOM_NJ_ARCHIVES_CACHE_DIR: cacheDir };

    const indexHtml =
      '<form action="./index.aspx"><input type="hidden" name="__VIEWSTATE" value="v0" /></form>';
    const formHtml =
      '<form action="./EarlyLandRecords.aspx"><input type="hidden" name="__VIEWSTATE" value="v1" /></form>';
    const page1Html =
      '<form action="./EarlyLandRecords.aspx"><input type="hidden" name="__VIEWSTATE" value="v2" />' +
      '<table id="ctl00_ContentPlaceHolder1_GridView1">' +
      '<tr><th>Name</th><th>PDF</th></tr>' +
      '<tr><td>Carter, Samuel</td><td><a href="https://wwwdnet-dos.nj.gov/scans/deed1.pdf">Scan</a></td></tr>' +
      "<tr><td><a href=\"javascript:__doPostBack('ctl00$ContentPlaceHolder1$GridView1','Page$2')\">2</a></td></tr>" +
      '</table></form>';
    const page2Html =
      '<form action="./EarlyLandRecords.aspx"><input type="hidden" name="__VIEWSTATE" value="v3" />' +
      '<table id="ctl00_ContentPlaceHolder1_GridView1">' +
      '<tr><th>Name</th><th>PDF</th></tr>' +
      '<tr><td>Doe, Jane</td><td></td></tr>' +
      "<tr><td><a href=\"javascript:__doPostBack('ctl00$ContentPlaceHolder1$GridView1','Page$3')\">3</a></td></tr>" +
      '</table></form>';
    const page3EmptyHtml =
      '<form action="./EarlyLandRecords.aspx"><table id="ctl00_ContentPlaceHolder1_GridView1">' +
      '<tr><td>No Records Found</td></tr></table></form>';

    const multiPageFetch: typeof fetch = async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(indexHtml, { status: 200 });
      }
      const body = String(init?.body ?? '');
      if (body.includes('lbtnColonialMarriages')) {
        return new Response(formHtml, { status: 200 });
      }
      if (body.includes('Page%242')) {
        return new Response(page2Html, { status: 200 });
      }
      if (body.includes('Page%243')) {
        return new Response(page3EmptyHtml, { status: 200 });
      }
      return new Response(page1Html, { status: 200 });
    };

    const multiRes = await invokeHandler(
      runNjArchivesCommand,
      ['search', 'land', '--surname', 'Carter', '--pages', '3'],
      { env, fetchImpl: multiPageFetch }
    );
    expect(multiRes.exitCode).toBe(0);
    expect(multiRes.stdout).toContain('2 result(s) (pages read: 2)');
    expect(multiRes.stdout).toContain('PDF: https://wwwdnet-dos.nj.gov/scans/deed1.pdf');
    expect(multiRes.stdout).toContain('2. Doe, Jane');

    // Empty result text
    const zeroRes = await invokeHandler(runNjArchivesCommand, ['search', 'land', '--surname', 'Nobody'], {
      env,
      fetchImpl: async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET') return new Response(indexHtml, { status: 200 });
        if (String(init?.body ?? '').includes('lbtnColonialMarriages'))
          return new Response(formHtml, { status: 200 });
        return new Response(page3EmptyHtml, { status: 200 });
      },
    });
    expect(zeroRes.exitCode).toBe(0);
    expect(zeroRes.stdout).toBe('Early Land Records, ca. 1650-1900s: no records found.');

    // Persistent 503 after retry, network failure after retry, and immediate CliValidationError without retry
    let fail503Calls = 0;
    await expect(
      searchPortal(
        createRecordContext({
          fetchImpl: async () => {
            fail503Calls += 1;
            return new Response('down', { status: 503 });
          },
          sleepFn: async () => {},
        }),
        'land',
        { surname: 'Carter' },
        1
      )
    ).rejects.toThrow('portal returned HTTP 503 for land after one retry');
    expect(fail503Calls).toBe(2);

    let netFailCalls = 0;
    await expect(
      searchPortal(
        createRecordContext({
          fetchImpl: async () => {
            netFailCalls += 1;
            throw new TypeError('socket hang up');
          },
          sleepFn: async () => {},
        }),
        'land',
        { surname: 'Carter' },
        1
      )
    ).rejects.toThrow(/portal request failed for land:.*socket hang up/);
    expect(netFailCalls).toBe(2);

    let validationAttempts = 0;
    await expect(
      searchPortal(
        createRecordContext({
          fetchImpl: async (_input, init) => {
            if ((init?.method ?? 'GET') === 'GET') {
              validationAttempts += 1;
              return new Response(indexHtml, { status: 200 });
            }
            return new Response(formHtml, { status: 200 });
          },
          sleepFn: async () => {},
        }),
        'land',
        { surname: 'Carter', role: 'BadRole' },
        1
      )
    ).rejects.toThrow(CliValidationError);
    expect(validationAttempts).toBe(1);

    // Monmouth HTTP error, network error, and invalid --town / --category
    const monHttpErr = await invokeHandler(runNjArchivesCommand, ['monmouth', '--surname', 'Carter'], {
      env,
      fetchImpl: async () => new Response('blocked', { status: 503 }),
    });
    expect(monHttpErr.exitCode).toBe(1);
    expect(monHttpErr.stderr).toContain('Monmouth OPRS returned HTTP 503');

    const monNetErr = await invokeHandler(runNjArchivesCommand, ['monmouth', '--surname', 'Doe'], {
      env,
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
    });
    expect(monNetErr.exitCode).toBe(1);
    expect(monNetErr.stderr).toContain('Monmouth OPRS request failed:');
    expect(monNetErr.stderr).toContain('connection refused');

    const badTown = await invokeHandler(
      runNjArchivesCommand,
      ['monmouth', '--surname', 'Carter', '--town', 'Oakville'],
      { env }
    );
    expect(badTown.exitCode).toBe(2);
    expect(badTown.stderr).toContain("--town 'Oakville' is not valid");

    const badCat = await invokeHandler(
      runNjArchivesCommand,
      ['monmouth', '--surname', 'Carter', '--category', 'InvalidCat'],
      { env }
    );
    expect(badCat.exitCode).toBe(2);
    expect(badCat.stderr).toContain("--category 'InvalidCat' is not valid");

    // natguard-photos missing keyword/surname, surname fallback, search monmouth error, url variants, help
    const monSearchErr = await invokeHandler(
      runNjArchivesCommand,
      ['search', 'monmouth', '--surname', 'Carter'],
      {
        env,
      }
    );
    expect(monSearchErr.exitCode).toBe(2);
    expect(monSearchErr.stderr).toContain('nj-archives monmouth');

    const natMissing = await invokeHandler(runNjArchivesCommand, ['search', 'natguard-photos'], { env });
    expect(natMissing.exitCode).toBe(2);
    expect(natMissing.stderr).toContain('natguard-photos requires --keyword');

    let natPosted = '';
    const natOk = await invokeHandler(
      runNjArchivesCommand,
      ['search', 'natguard-photos', '--surname', 'Riverbend'],
      {
        env,
        fetchImpl: async (_input, init) => {
          if ((init?.method ?? 'GET') === 'GET') return new Response(indexHtml, { status: 200 });
          const body = String(init?.body ?? '');
          if (body.includes('lbtnColonialMarriages')) return new Response(formHtml, { status: 200 });
          natPosted = body;
          return new Response(page3EmptyHtml, { status: 200 });
        },
      }
    );
    expect(natOk.exitCode).toBe(0);
    expect(natPosted).toContain('txtSearch=Riverbend');
    expect(natPosted).toContain('btnSearch=Search');

    const urlMon = await invokeHandler(runNjArchivesCommand, ['url', 'monmouth'], { env });
    expect(urlMon.exitCode).toBe(0);
    expect(urlMon.stdout).toBe('https://oprs.co.monmouth.nj.us/oprs/Archives/ASearch.aspx');

    const urlOrderOnly = await invokeHandler(runNjArchivesCommand, ['url', 'probate'], { env });
    expect(urlOrderOnly.exitCode).toBe(0);
    expect(urlOrderOnly.stdout).toContain('ProbateRecordRequest.aspx');

    for (const helpArgs of [
      ['databases', '--help'],
      ['search', '--help'],
      ['monmouth', '--help'],
      ['url', '--help'],
    ]) {
      const h = await invokeHandler(runNjArchivesCommand, helpArgs, { env });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });
});

// ============================================================================
// 4. Texas Archives (texasArchives)
// ============================================================================
describe('texas-archives behavioral coverage', () => {
  it('parses ARK tokens, item dates, OAI-PMH edge cases, TDA RSS edge cases, and entry filters', () => {
    expect(extractArkId('ark:/67531/custom123/')).toBe('custom123');
    expect(() => parseIsoDate('1874/05', '--date-from')).toThrow('expected YYYY-MM-DD');

    expect(parseItemDate(undefined)).toEqual([null, null]);
    expect(parseItemDate('1870/1875')).toEqual(['1870-01-01', '1875-12-31']);
    expect(parseItemDate('1880')).toEqual(['1880-01-01', '1880-12-31']);
    expect(parseItemDate('circa 1880')).toEqual([null, null]);

    const entry = {
      ark: 'ark:/67531/metapth1',
      title: 'Oakville Ledger',
      creator: 'Samuel Carter',
      date: '1875',
      description: 'Riverbend deeds',
      type: 'text_book',
      url: 'https://texashistory.unt.edu/ark:/67531/metapth1/',
      thumbnail: '',
    };
    expect(entryMatchesFilters(entry, 'Maple', undefined, undefined, undefined)).toBe(false);
    expect(entryMatchesFilters({ ...entry, date: '' }, undefined, undefined, '1870-01-01', undefined)).toBe(
      false
    );
    expect(entryMatchesFilters(entry, undefined, undefined, '1880-01-01', undefined)).toBe(false);
    expect(entryMatchesFilters(entry, undefined, undefined, undefined, '1870-12-31')).toBe(false);
    expect(entryMatchesFilters(entry, 'Oakville', 'text_book', '1870-01-01', '1880-12-31')).toBe(true);

    // OAI-PMH parser: namespaced elements, multiple subjects, errors
    const namespacedOai = `<?xml version="1.0" encoding="UTF-8"?>
      <oai:OAI-PMH xmlns:oai="http://www.openarchives.org/OAI/2.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <oai:GetRecord><oai:record>
          <oai:header>
            <oai:identifier>ark:/67531/metadc2001</oai:identifier>
            <oai:setSpec>partner:OAK</oai:setSpec>
          </oai:header>
          <oai:metadata><dc:dc>
            <dc:title>Riverbend Tax Roll</dc:title>
            <dc:date>1879</dc:date>
            <dc:subject>Oakville County</dc:subject>
            <dc:subject>Taxation</dc:subject>
          </dc:dc></oai:metadata>
        </oai:record></oai:GetRecord>
      </oai:OAI-PMH>`;
    const parsedOai = parseOaiRecord(namespacedOai);
    expect(parsedOai.ark).toBe('ark:/67531/metadc2001');
    expect(parsedOai.dates).toEqual(['1879']);
    expect(parsedOai.subjects).toEqual(['Oakville County', 'Taxation']);

    expect(() => parseOaiRecord('<!DOCTYPE x [ <!ENTITY a "b">')).toThrow('OAI response was not valid XML');
    expect(() => parseOaiRecord('<OtherRoot/>')).toThrow('missing OAI-PMH root');
    expect(() => parseOaiRecord('<OAI-PMH><GetRecord></GetRecord></OAI-PMH>')).toThrow(
      'OAI response had no record'
    );

    // TDA RSS edge cases
    expect(() => parseTdaRss('<html><body>403 Forbidden</body></html>')).toThrow(
      'TDA RSS returned a 403 page to curl'
    );
    const rssFeed = `<rss><channel>
      <item><title>Search Results for Carter</title><link>https://tsl.access.preservica.com/s</link></item>
      <item><title>Oakville Deed 1</title><link>https://tsl.access.preservica.com/io/1</link></item>
      <item><title>Duplicate Link</title><link>https://tsl.access.preservica.com/io/1</link></item>
      <item><title></title><link>https://tsl.access.preservica.com/io/empty</link></item>
      <item><title>Oakville Deed 2</title><link>https://tsl.access.preservica.com/io/2</link></item>
    </channel></rss>`;
    expect(parseTdaRss(rssFeed, 1)).toEqual([
      { title: 'Oakville Deed 1', url: 'https://tsl.access.preservica.com/io/1' },
    ]);
    expect(parseTdaRss('<rss><broken')).toEqual([]);
  });

  it('handles portal pagination stopping, malformed OpenSearch shapes, empty TDA text, and help', async () => {
    const cacheDir = await makeTempDir('kinloom-tx-c6b-');
    const env = { KINLOOM_TEXAS_ARCHIVES_CACHE_DIR: cacheDir };

    // Malformed OpenSearch JSON shapes
    await expect(
      fetchOpenSearchPage(
        createRecordContext({ fetchImpl: async () => new Response('[]', { status: 200 }) }),
        'Carter',
        1
      )
    ).rejects.toThrow('OpenSearch returned unexpected JSON shape');

    await expect(
      fetchOpenSearchPage(
        createRecordContext({
          fetchImpl: async () => new Response(JSON.stringify({ feed: 'bad' }), { status: 200 }),
        }),
        'Carter',
        1
      )
    ).rejects.toThrow('OpenSearch returned malformed feed');

    // Multi-page search: stops when limit reached on page 1, and breaks on empty page 2
    let pageCalls = 0;
    const pagedFetch: typeof fetch = async (input) => {
      pageCalls += 1;
      const pw = new URL(String(input)).searchParams.get('pw');
      if (pw === '1') {
        return new Response(
          JSON.stringify({
            feed: {
              'opensearch:totalResults': '5',
              entry: [
                {
                  id: 'ark:/67531/metapth10',
                  title: 'Oakville Gazette',
                  'dc:date': '1875-01-01',
                  'dc:type': 'text_newspaper',
                  link: 'https://texashistory.unt.edu/ark:/67531/metapth10/',
                },
                {
                  id: 'ark:/67531/metapth11',
                  title: 'Riverbend Gazette',
                  'dc:date': '1876-01-01',
                  'dc:type': 'text_newspaper',
                  link: 'https://texashistory.unt.edu/ark:/67531/metapth11/',
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ feed: { 'opensearch:totalResults': '5', entry: [] } }), {
        status: 200,
      });
    };

    const limited = await invokeHandler(
      runTexasArchivesCommand,
      ['portal', 'search', 'Carter', '--limit', '1', '--pages', '3', '--json'],
      { env, fetchImpl: pagedFetch }
    );
    expect(limited.exitCode).toBe(0);
    expect(pageCalls).toBe(1);
    expect((JSON.parse(limited.stdout) as { returned: number }).returned).toBe(1);

    const multi = await invokeHandler(
      runTexasArchivesCommand,
      ['portal', 'search', 'Carter', '--limit', '5', '--pages', '3', '--json'],
      { env, fetchImpl: pagedFetch }
    );
    expect(multi.exitCode).toBe(0);
    expect(pageCalls).toBe(2); // Page 1 cached hit, page 2 fetched empty -> stops before page 3

    // TDA empty RSS text output
    const emptyTda = await invokeHandler(runTexasArchivesCommand, ['tda', 'Nobody'], {
      env,
      execFileImpl: async (_file, args) => ({
        stdout: makeCurlStdout('<rss><channel></channel></rss>', 200, args.at(-1) ?? ''),
        stderr: Buffer.alloc(0),
      }),
    });
    expect(emptyTda.exitCode).toBe(0);
    expect(emptyTda.stdout).toContain('No results in the RSS feed');

    for (const helpArgs of [
      ['portal', '--help'],
      ['portal', 'search', '--help'],
      ['portal', 'item', '--help'],
      ['tda', '--help'],
      ['url', '--help'],
    ]) {
      const h = await invokeHandler(runTexasArchivesCommand, helpArgs, { env });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });
});

// ============================================================================
// 5. Missouri Archives (moArchives)
// ============================================================================
describe('mo-archives behavioral coverage', () => {
  const FORM_HTML = '<form><input type="hidden" name="__ncforminfo" value="tok999" /></form>';

  it('paginates death search, downloads PDFs via --download-dir, formats pre1910 birth/death text, and validates CLI flags', async () => {
    const cacheDir = await makeTempDir('kinloom-mo-c6b-');
    const env = { KINLOOM_MO_ARCHIVES_CACHE_DIR: cacheDir };

    // CLI validation errors
    for (const [args, expected] of [
      [['death', '--last', 'Carter', '--begin-year', '1900'], 'year range must sit inside 1910-1975'],
      [['death', '--last', 'Carter', '--begin-month', '13'], 'months must be 0-12'],
      [['death', '--last', 'Carter', '--limit', '0'], '--limit must be at least 1'],
      [['pre1910', '--name', 'Carter', '--limit', '0'], '--limit must be at least 1'],
      [['detail', 'abc'], "Invalid detail ID: 'abc'"],
    ] as const) {
      const r = await invokeHandler(runMoArchivesCommand, args, { env, cwd: cacheDir });
      expect(r.exitCode, args.join(' ')).toBe(2);
      expect(r.stderr).toContain(expected);
    }

    // Multi-page death search + --download-dir
    const page1Html =
      '<p>Showing records 1 to 1 of 3</p><table>' +
      '<tr><th>Name</th><th>Age</th><th>Date of Death</th><th>County</th><th>Cert</th><th>SSN</th><th>Image</th></tr>' +
      '<tr><td>Carter, Samuel</td><td>68</td><td>1925-03-11</td><td>Oakville</td><td>2001</td><td></td>' +
      '<td><a href="/images/archives/deathcerts/1925/0002001.PDF">PDF</a></td></tr></table>';
    const page2Html =
      '<p>Showing records 2 to 2 of 3</p><table>' +
      '<tr><th>Name</th><th>Age</th><th>Date of Death</th><th>County</th><th>Cert</th><th>SSN</th><th>Image</th></tr>' +
      '<tr><td>Doe, Jane</td><td>72</td><td>1926-07-04</td><td>Oakville</td><td>2002</td><td></td><td></td></tr></table>';
    const page3EmptyHtml = '<table><tr><th>Name</th><th>Date of Death</th></tr></table>';

    const dlDir = path.join(cacheDir, 'certs');
    const moFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('.PDF')) {
        return new Response(SYNTHETIC_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      if (url.includes('PageNumber=2')) {
        return new Response(page2Html, { status: 200 });
      }
      if (url.includes('PageNumber=3')) {
        return new Response(page3EmptyHtml, { status: 200 });
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(FORM_HTML, { status: 200 });
      }
      return new Response(page1Html, { status: 200 });
    };

    const deathRes = await invokeHandler(
      runMoArchivesCommand,
      ['death', '--last', 'Carter', '--limit', '5', '--download', dlDir],
      { env, cwd: cacheDir, fetchImpl: moFetch }
    );
    expect(deathRes.exitCode).toBe(0);
    expect(deathRes.stdout).toContain('Downloaded:');
    expect(deathRes.stdout).toContain('Total: 3 | showing 2');
    expect(fs.readFileSync(path.join(dlDir, '0002001.PDF'))).toEqual(SYNTHETIC_PDF);

    // Pre-1910 birth and death text formatting
    const preBirthHtml =
      '<p>Showing records 1 to 1 of 1</p><table>' +
      '<tr><th>Name</th><th>Place</th><th>County</th><th>Date Of Birth</th><th>Father</th><th>Mother</th><th>Attendant</th><th>Details</th></tr>' +
      '<tr><td>Doe, Clara</td><td>Riverbend</td><td>Oakville</td><td>1884-09-02</td><td>Samuel Doe</td><td>Jane Carter</td><td>Dr. Reed</td>' +
      '<td><a href="Detail?id=801">View</a></td></tr></table>';
    const preDeathHtml =
      '<p>Showing records 1 to 1 of 1</p><table>' +
      '<tr><th>Name</th><th>Age</th><th>Sex</th><th>Color</th><th>Date Of Death</th><th>County</th><th>Details</th></tr>' +
      '<tr><td>Carter, Samuel</td><td>55</td><td>M</td><td>W</td><td>1886-01-14</td><td>Oakville</td>' +
      '<td><a href="Detail?id=802">View</a></td></tr></table>';

    const birthRes = await invokeHandler(
      runMoArchivesCommand,
      ['pre1910', '--type', 'birth', '--name', 'Doe'],
      {
        env,
        cwd: cacheDir,
        fetchImpl: async (_input, init) =>
          new Response((init?.method ?? 'GET') === 'GET' ? FORM_HTML : preBirthHtml, { status: 200 }),
      }
    );
    expect(birthRes.exitCode).toBe(0);
    expect(birthRes.stdout).toContain(
      'Doe, Clara | Riverbend | Oakville | 1884-09-02 | father Samuel Doe | mother Jane Carter | detail 801'
    );

    const preDeathRes = await invokeHandler(
      runMoArchivesCommand,
      ['pre1910', '--type', 'death', '--name', 'Carter'],
      {
        env,
        cwd: cacheDir,
        fetchImpl: async (_input, init) =>
          new Response((init?.method ?? 'GET') === 'GET' ? FORM_HTML : preDeathHtml, { status: 200 }),
      }
    );
    expect(preDeathRes.exitCode).toBe(0);
    expect(preDeathRes.stdout).toContain(
      'Carter, Samuel | age 55 | M | W | 1886-01-14 | Oakville | detail 802'
    );

    // Domain edge cases
    expect(
      findResultsTable('<table></table><table><tr><th>Date of Death</th></tr></table>', ['Date of Death'])[0]
    ).toEqual(['Date of Death']);
    expect(extractFormToken('name="__ncforminfo" value="regexTok"')).toBe('regexTok');
    expect(parseDeathRows('<table><tr><th>Date of Death</th></tr><tr><td>Short</td></tr></table>')).toEqual(
      []
    );
    expect(
      parsePre1910Rows('<table><tr><th>Date Of Birth</th></tr><tr><td></td></tr></table>', 'birth')
    ).toEqual([]);
    expect(
      parseDetailFields(`<table>
        <tr><td>NOTE</td></tr>
        <tr><td>Certified copy</td></tr>
        <tr><th>Name</th><th>County</th></tr>
        <tr><td>Jane Doe</td><td>Oakville</td></tr>
        <tr><td>Odd</td><td>Row</td><td>Extra</td></tr>
      </table>`)
    ).toEqual({ Name: 'Jane Doe', County: 'Oakville', notes: 'Certified copy' });
    expect(safePdfFilename('not a url')).toBe('certificate.pdf');
    expect(safePdfFilename('https://s1.sos.mo.gov/')).toBe('certificate.pdf');

    for (const helpArgs of [
      ['death', '--help'],
      ['pre1910', '--help'],
      ['detail', '--help'],
      ['download', '--help'],
      ['mdh', '--help'],
    ]) {
      const h = await invokeHandler(runMoArchivesCommand, helpArgs, { env, cwd: cacheDir });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });
});

// ============================================================================
// 6. Michiganology (michiganology)
// ============================================================================
describe('michiganology behavioral coverage', () => {
  it('validates domain helpers, URL/filename sanitizers, and HTML parsers', () => {
    expect(() => validateTimeout(0)).toThrow(CliValidationError);
    expect(() => validateTimeout(Number.NaN)).toThrow(CliValidationError);

    expect(() => validateMichiganologyUrl('')).toThrow(RecordRuntimeError);
    expect(() => validateMichiganologyUrl('https://michiganology.org/\x07bad')).toThrow(RecordRuntimeError);
    expect(() => validateMichiganologyUrl('not-a-valid-url')).toThrow(RecordRuntimeError);

    expect(sanitizeServerFilename('../../...', 'fallback.bin')).toBe('fallback.bin');
    expect(
      isHtmlPayload('application/octet-stream', Buffer.from('<html><body>Wait</body></html>', 'utf8'))
    ).toBe(true);
    expect(isHtmlPayload('application/octet-stream', Buffer.from('<title>Login</title>', 'utf8'))).toBe(true);

    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8''Oakville%20Deed.pdf", 'fallback.bin')
    ).toBe('Oakville_Deed.pdf');
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''%E0%A4%A.pdf", 'fallback.bin')).toBe(
      'E0_A4_A.pdf'
    );
    expect(filenameFromContentDisposition('inline', 'fallback.bin')).toBe('fallback.bin');

    expect(resolveItemRef('https://michigan.access.preservica.com/uncategorized/IO_777/')).toEqual([
      'IO_777',
      'https://michigan.access.preservica.com/uncategorized/IO_777/',
    ]);
    expect(resolveItemRef('https://michigan.access.preservica.com/collection/oakville-deeds/')).toEqual([
      'oakville-deeds',
      'https://michigan.access.preservica.com/collection/oakville-deeds/',
    ]);
    expect(() => resolveItemRef('https://michigan.access.preservica.com/')).toThrow(CliValidationError);
    expect(() => resolveItemRef('bad-id')).toThrow(CliValidationError);

    const parsedSearch = parseSearchHtml(
      `<div class="result-item">No anchor</div>
       <div class="result-item"><a href="">Empty href</a></div>
       <div class="result-item"><a href="https://michigan.access.preservica.com/uncategorized/IO_1/">Carter</a></div>`,
      'Carter'
    );
    expect(parsedSearch.results).toEqual([
      { title: 'Carter', url: 'https://michigan.access.preservica.com/uncategorized/IO_1/' },
    ]);

    const parsedItem = parseItemHtml(
      '<html><body><h1>Samuel Carter</h1></body></html>',
      'IO_synth99',
      'https://michigan.access.preservica.com/uncategorized/IO_synth99/'
    );
    expect(parsedItem.download_url).toBe('https://michigan.access.preservica.com/download/file/IO_synth99');
  });

  it('exercises command validation, empty search text, repeated metadata, corrupt file cache recovery, and help', async () => {
    const cacheDir = await makeTempDir('kinloom-mich-c6b-');
    const env = { KINLOOM_MICHIGANOLOGY_CACHE_DIR: cacheDir };

    // Missing query
    const noQuery = await invokeHandler(runMichiganologyCommand, ['search'], { env, cwd: cacheDir });
    expect(noQuery.exitCode).toBe(2);
    expect(noQuery.stderr).toContain('Missing search query');

    // Empty first-page search text output
    const emptySearch = await invokeHandler(runMichiganologyCommand, ['search', 'Nobody'], {
      env,
      cwd: cacheDir,
      execFileImpl: async (_file, args) => ({
        stdout: makeCurlStdout('<html><body>0 total results</body></html>', 200, args.at(-1) ?? ''),
        stderr: Buffer.alloc(0),
      }),
    });
    expect(emptySearch.exitCode).toBe(0);
    expect(emptySearch.stdout).toContain('No results on the first page.');

    // Repeated metadata fields in get --json
    const dupMetaHtml =
      '<html><body><h1>Oakville Map</h1>' +
      '<span class="metadata-title">Subject:</span><span class="metadata-content">Maps</span>' +
      '<span class="metadata-title">Subject:</span><span class="metadata-content">Riverbend</span>' +
      '<span class="metadata-title">Subject:</span><span class="metadata-content">Oakville</span>' +
      '</body></html>';
    const dupGet = await invokeHandler(runMichiganologyCommand, ['get', 'IO_map1', '--json'], {
      env,
      cwd: cacheDir,
      execFileImpl: async (_file, args) => ({
        stdout: makeCurlStdout(dupMetaHtml, 200, args.at(-1) ?? ''),
        stderr: Buffer.alloc(0),
      }),
    });
    expect(dupGet.exitCode).toBe(0);
    expect((JSON.parse(dupGet.stdout) as { metadata: { Subject: string[] } }).metadata.Subject).toEqual([
      'Maps',
      'Riverbend',
      'Oakville',
    ]);

    // Download SO_ error and null byte --out error
    const soErr = await invokeHandler(runMichiganologyCommand, ['download', 'SO_folder1'], {
      env,
      cwd: cacheDir,
    });
    expect(soErr.exitCode).toBe(1);
    expect(soErr.stderr).toContain('folder/collection object (SO_)');

    const nullOut = await invokeHandler(
      runMichiganologyCommand,
      ['download', 'IO_map1', '--out', 'bad\0path'],
      { env, cwd: cacheDir }
    );
    expect(nullOut.exitCode).toBe(2);
    expect(nullOut.stderr).toContain('Invalid --out path');

    expect(() =>
      resolveDownloadDest('bad\0path', undefined, 'file.jpg', createRecordContext({ cwd: cacheDir }))
    ).toThrow(CliValidationError);
    expect(() =>
      resolveDownloadDest('../escape.jpg', undefined, 'file.jpg', createRecordContext({ cwd: cacheDir }))
    ).toThrow(CliValidationError);

    // Corrupt file cache entries (empty body, bad schema, byte mismatch, expired TTL, HTML body) all refetch cleanly
    const fileCacheDir = path.join(cacheDir, 'files', 'IO_cache1');
    fs.mkdirSync(fileCacheDir, { recursive: true });
    const bodyPath = path.join(fileCacheDir, 'body');
    const metaPath = path.join(fileCacheDir, 'meta.json');
    const outDir = path.join(cacheDir, 'out');
    const nowSec = 1_700_000_000;

    const corruptCases: Array<{ body: Buffer; meta: Record<string, unknown> }> = [
      {
        body: Buffer.alloc(0),
        meta: { schema: 1, fetched_at: nowSec, filename: 'a.jpg', content_type: 'image/jpeg', bytes: 0 },
      },
      {
        body: SYNTHETIC_JPEG,
        meta: {
          schema: 99,
          fetched_at: nowSec,
          filename: 'a.jpg',
          content_type: 'image/jpeg',
          bytes: SYNTHETIC_JPEG.length,
        },
      },
      {
        body: SYNTHETIC_JPEG,
        meta: { schema: 1, fetched_at: nowSec, filename: 'a.jpg', content_type: 'image/jpeg', bytes: 999 },
      },
      {
        body: SYNTHETIC_JPEG,
        meta: {
          schema: 1,
          fetched_at: nowSec - 999_999,
          filename: 'a.jpg',
          content_type: 'image/jpeg',
          bytes: SYNTHETIC_JPEG.length,
        },
      },
      {
        body: Buffer.from('<html><body>stale</body></html>', 'utf8'),
        meta: {
          schema: 1,
          fetched_at: nowSec,
          filename: 'a.jpg',
          content_type: 'image/jpeg',
          bytes: 31,
        },
      },
    ];

    for (const c of corruptCases) {
      fs.writeFileSync(bodyPath, c.body);
      fs.writeFileSync(metaPath, JSON.stringify(c.meta), 'utf8');
      let fetched = 0;
      const r = await invokeHandler(
        runMichiganologyCommand,
        ['download', 'IO_cache1', '--out', outDir, '--json'],
        {
          env,
          cwd: cacheDir,
          nowMs: () => nowSec * 1000,
          execFileImpl: async (_file, args) => {
            fetched += 1;
            writeCurlHeaders(
              args,
              'HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Disposition: attachment; filename="fresh.jpg"\r\n\r\n'
            );
            return {
              stdout: makeCurlStdout(SYNTHETIC_JPEG, 200, args.at(-1) ?? ''),
              stderr: Buffer.alloc(0),
            };
          },
        }
      );
      expect(r.exitCode).toBe(0);
      expect(fetched).toBe(1);
    }

    // Collections text output & help screens
    const colsText = await invokeHandler(runMichiganologyCommand, ['collections'], { env, cwd: cacheDir });
    expect(colsText.exitCode).toBe(0);
    expect(colsText.stdout).toContain('Death Certificates, 1897-1952');

    for (const helpArgs of [
      ['search', '--help'],
      ['get', '--help'],
      ['download', '--help'],
      ['collections', '--help'],
      ['url', '--help'],
    ]) {
      const h = await invokeHandler(runMichiganologyCommand, helpArgs, { env, cwd: cacheDir });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });
});

// ============================================================================
// 7. Kentucky Archives, UK Archives, GNIS, PERSI uncovered paths
// ============================================================================
describe('ky-archives, uk-archives, gnis, and persi behavioral coverage', () => {
  it('covers ky-archives collections text, empty preservica text, non-object JSON, parsers, and help', async () => {
    const cacheDir = await makeTempDir('kinloom-ky-c6b-');
    const env = { KINLOOM_KY_ARCHIVES_CACHE_DIR: cacheDir };

    const colsText = await invokeHandler(runKyArchivesCommand, ['collections'], {
      env,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ totalCollections: 1, cards: [{ alias: 'oak', title: 'Oakville Deeds' }] }),
          { status: 200 }
        ),
    });
    expect(colsText.exitCode).toBe(0);
    expect(colsText.stdout).toContain('1 collections');
    expect(colsText.stdout).toContain('- oak: Oakville Deeds');

    const badJsonShape = await invokeHandler(runKyArchivesCommand, ['cdm', 'Carter'], {
      env,
      fetchImpl: async () => new Response('["not-object"]', { status: 200 }),
    });
    expect(badJsonShape.exitCode).toBe(1);
    expect(badJsonShape.stderr).toContain('Unexpected JSON response');

    const emptyPres = await invokeHandler(runKyArchivesCommand, ['preservica', 'Nobody'], {
      env,
      fetchImpl: async () => new Response('<rss><channel></channel></rss>', { status: 200 }),
    });
    expect(emptyPres.exitCode).toBe(0);
    expect(emptyPres.stdout).toContain('No results in the search feed.');

    expect(parseLandResults('1 Results found 1) Patent #malformed chunk').results).toEqual([]);
    const rss = parsePreservicaRss(
      `<rss><channel>
        <item><title>1845</title><link>https://kdla.access.preservica.com/1</link></item>
        <item><title>Dup</title><link>https://kdla.access.preservica.com/1</link></item>
        <item><title>Second</title><link>https://kdla.access.preservica.com/2</link></item>
      </channel></rss>`,
      'Carter',
      'https://kdla.access.preservica.com/search/Carter/feed/rss2/',
      1
    );
    expect(rss.results).toEqual([{ title: '1845', url: 'https://kdla.access.preservica.com/1' }]);

    for (const helpArgs of [
      ['cdm', '--help'],
      ['cdm-item', '--help'],
      ['collections', '--help'],
      ['cdm-url', '--help'],
      ['land', '--help'],
      ['land-patent', '--help'],
      ['preservica', '--help'],
      ['urls', '--help'],
    ]) {
      const h = await invokeHandler(runKyArchivesCommand, helpArgs, { env });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });

  it('covers uk-archives validation, TNA search/detail/errors, FreeREG params/parsers, url defaults, and help', async () => {
    const cacheDir = await makeTempDir('kinloom-uk-c6b-');
    const env = { KINLOOM_UK_ARCHIVES_CACHE_DIR: cacheDir };

    expect(() => validateUkArchivesUrl('not a url', ['discovery.nationalarchives.gov.uk'])).toThrow(
      'Refusing malformed URL'
    );
    expect(normalizeDateFrom('1851-03-30')).toBe('1851-03-30');
    expect(normalizeDateTo('1861-04-07')).toBe('1861-04-07');
    expect(() => normalizeDateFrom('bad')).toThrow(CliValidationError);
    expect(() => normalizeDateTo('bad')).toThrow(CliValidationError);
    expect(matchesCollection({ reference: 'RG 9/100', title: 'Oakville Census' }, 'RG 9')).toBe(true);
    expect(matchesCollection({ reference: 'HO 107', title: 'Riverbend Militia' }, 'MILITIA')).toBe(true);
    expect(mapDiscoveryDetail({ id: 'C1', heldBy: ['Oakville Archive'] }).held_by).toEqual([
      'Oakville Archive',
    ]);

    expect(extractFreeregToken('<input value="tok-dom" name="authenticity_token" />')).toBe('tok-dom');
    expect(parseFreeregResults('<html><body>no table</body></html>')).toEqual([]);
    expect(parseFreeregResults('<table><tbody><tr id="r1"><td>only1</td></tr></tbody></table>')).toEqual([]);

    const missingQ = await invokeHandler(runUkArchivesCommand, ['tna', 'search'], { env });
    expect(missingQ.exitCode).toBe(2);
    expect(missingQ.stderr).toContain('Provide QUERY');

    let seenTnaUrl = '';
    const tnaRes = await invokeHandler(
      runUkArchivesCommand,
      ['tna', 'search', 'Carter', '--held-by', 'TNA', '--collection', 'RG 9', '--page', '2', '--json'],
      {
        env,
        fetchImpl: async (input) => {
          seenTnaUrl = String(input);
          return new Response(
            JSON.stringify({
              count: 1,
              records: [{ id: 'C999', reference: 'RG 9/10', title: 'Oakville Census', places: ['Oakville'] }],
            }),
            { status: 200 }
          );
        },
      }
    );
    expect(tnaRes.exitCode).toBe(0);
    expect(seenTnaUrl).toContain('sps.page=2');

    const tnaBadJson = await invokeHandler(runUkArchivesCommand, ['tna', 'get', 'C12345'], {
      env,
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    });
    expect(tnaBadJson.exitCode).toBe(1);
    expect(tnaBadJson.stderr).toContain('returned non-JSON');

    const tnaArrJson = await invokeHandler(runUkArchivesCommand, ['tna', 'get', 'C12346'], {
      env,
      fetchImpl: async () => new Response('[]', { status: 200 }),
    });
    expect(tnaArrJson.exitCode).toBe(1);
    expect(tnaArrJson.stderr).toContain('unexpected JSON shape');

    const badRt = await invokeHandler(
      runUkArchivesCommand,
      ['freereg', 'search', '--surname', 'Carter', '--record-type', 'census'],
      { env }
    );
    expect(badRt.exitCode).toBe(2);
    expect(badRt.stderr).toContain("Invalid value 'census' for '--record-type'");

    let freeregBody = '';
    const freeregRes = await invokeHandler(
      runUkArchivesCommand,
      [
        'freereg',
        'search',
        '--surname',
        'Carter',
        '--given',
        'Jane',
        '--from-year',
        '1820',
        '--to-year',
        '1840',
        '--record-type',
        'baptism',
        '--json',
      ],
      {
        env,
        fetchImpl: async (_input, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return new Response('<input name="authenticity_token" value="frtok" />', { status: 200 });
          }
          freeregBody = String(init?.body ?? '');
          return new Response(
            `<table><tbody><tr id="tr1">
              <td><a href="/search_records/1">View 1</a></td>
              <td>Jane Carter</td><td>Baptism</td><td>1825-04-02</td><td>NTT</td><td>Oakville St Mary</td>
            </tr></tbody></table>`,
            { status: 200 }
          );
        },
      }
    );
    expect(freeregRes.exitCode).toBe(0);
    expect(freeregBody).toContain('search_query%5Bfirst_name%5D=Jane');
    expect(freeregBody).toContain('search_query%5Bstart_year%5D=1820');
    expect(freeregBody).toContain('search_query%5Bend_year%5D=1840');
    expect(freeregBody).toContain('search_query%5Brecord_type%5D=ba');

    const urlNotts = await invokeHandler(runUkArchivesCommand, ['url', '--notts', 'Carter'], { env });
    expect(urlNotts.exitCode).toBe(0);
    expect(urlNotts.stdout).toContain('https://nawcat.nottinghamshire.gov.uk/CalmView/');

    const urlDefault = await invokeHandler(runUkArchivesCommand, ['url'], { env });
    expect(urlDefault.exitCode).toBe(0);
    expect(urlDefault.stdout).toContain('https://www.british-history.ac.uk/');

    for (const helpArgs of [
      ['tna', '--help'],
      ['tna', 'search', '--help'],
      ['tna', 'get', '--help'],
      ['freereg', '--help'],
      ['freereg', 'search', '--help'],
      ['url', '--help'],
    ]) {
      const h = await invokeHandler(runUkArchivesCommand, helpArgs, { env });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });

  it('covers gnis zip/file edge cases, get text/historical formatting, filters, validation, and help', async () => {
    const cacheDir = await makeTempDir('kinloom-gnis-c6b-');
    const env = { KINLOOM_GNIS_CACHE_DIR: cacheDir };

    // Zip without .txt member & empty GNIS file
    const noTxtZip = zipSync({ 'README.md': Buffer.from('no txt here', 'utf8') });
    expect(() => extractGnisTxt(noTxtZip)).toThrow('No .txt member in downloaded zip');

    const emptyPath = path.join(cacheDir, 'empty.txt');
    fs.writeFileSync(emptyPath, '', 'utf8');
    expect(loadGnisRows(emptyPath)).toEqual([]);

    // readCachedSearch corrupt cached_at & expired TTL
    const params = {
      name: 'Oakville',
      state: 'CA',
      exact: false,
      feature_class: null,
      county: null,
      historical: false,
      limit: 10,
    };
    const { filePath } = queryCachePath(params, cacheDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ cached_at: 'bad', data: {} }), 'utf8');
    expect(readCachedSearch(params, cacheDir, 10, () => 10_000)).toBeUndefined();
    fs.writeFileSync(
      filePath,
      JSON.stringify({ cached_at: 1, data: { source: 'x', matches: 0, results: [] } }),
      'utf8'
    );
    expect(readCachedSearch(params, cacheDir, 1, () => 10_000_000)).toBeUndefined();

    // Validation errors
    expect((await invokeHandler(runGnisCommand, ['download', 'ZZ'], { env })).exitCode).toBe(1);
    expect((await invokeHandler(runGnisCommand, ['search', 'Oakville'], { env })).exitCode).toBe(2);
    expect((await invokeHandler(runGnisCommand, ['get', '1001'], { env })).exitCode).toBe(2);
    expect((await invokeHandler(runGnisCommand, ['get', '1001', '--state', 'ZZ'], { env })).exitCode).toBe(1);

    // Search with feature-class & county filters + get text output & historical
    const gnisText = [
      'feature_id|feature_name|feature_class|state_name|county_name|map_name|prim_lat_dec|prim_long_dec|date_created|date_edited',
      '1001|Oakville|Populated Place|California|Oakville|Oakville Quad|38.1|-122.2|01/01/1980|',
      '1002|Oakville Creek|Stream|California|Riverbend|Riverbend Quad|38.2|-122.3|01/01/1980|',
    ].join('\n');
    const histZip = zipSync({ 'HistoricalFeatures.txt': Buffer.from(gnisText, 'utf8') });

    const fetchHist: typeof fetch = async () =>
      new Response(Buffer.from(histZip), { status: 200, headers: { 'content-type': 'application/zip' } });

    const filtered = await invokeHandler(
      runGnisCommand,
      ['search', 'Oakville', '--historical', '--class', 'Populated Place', '--county', 'Oakville', '--json'],
      { env, fetchImpl: fetchHist }
    );
    expect(filtered.exitCode).toBe(0);
    expect((JSON.parse(filtered.stdout) as { matches: number }).matches).toBe(1);

    const getText = await invokeHandler(runGnisCommand, ['get', '1001', '--historical'], {
      env,
      fetchImpl: fetchHist,
    });
    expect(getText.exitCode).toBe(0);
    expect(getText.cacheHit).toBe(true);
    expect(getText.stdout).toContain('feature_name: Oakville');
    expect(getText.stdout).not.toContain('date_edited:');

    for (const helpArgs of [
      ['download', '--help'],
      ['search', '--help'],
      ['get', '--help'],
      ['url', '--help'],
    ]) {
      const h = await invokeHandler(runGnisCommand, helpArgs, { env });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });

  it('covers persi url modes, search router errors, empty location, 412/429 retry, parser skips, and help', async () => {
    const cacheDir = await makeTempDir('kinloom-persi-c6b-');
    const env = { KINLOOM_PERSI_CACHE_DIR: cacheDir };

    // Parsers skip short rows & category header row
    expect(parsePersiArticles('<table><tr><td>Only</td><td>Two</td></tr></table>')).toEqual([]);
    expect(
      parsePersiCategories(
        '<table><tr><td>Category</td><td>10</td></tr><tr><td>Cemeteries</td><td>42</td></tr></table>'
      )
    ).toEqual([{ category: 'Cemeteries', articles: 42 }]);

    // URL command modes + error + help
    const urlSurname = await invokeHandler(runPersiCommand, ['url', 'surname'], { env });
    expect(urlSurname.exitCode).toBe(0);
    expect(urlSurname.stdout).toBe('https://www.genealogycenter.info/search_persisurname.php');
    expect((await invokeHandler(runPersiCommand, ['url', 'badmode'], { env })).exitCode).toBe(2);

    // Search router errors & routing to location
    const comboErr = await invokeHandler(runPersiCommand, ['search', 'Carter', '--state', 'MI'], { env });
    expect(comboErr.exitCode).toBe(2);
    expect(comboErr.stderr).toContain('do not accept a --state filter');

    const emptySearchErr = await invokeHandler(runPersiCommand, ['search'], { env });
    expect(emptySearchErr.exitCode).toBe(2);
    expect(emptySearchErr.stderr).toContain('Pass a surname, --title');

    const badState = await invokeHandler(runPersiCommand, ['location', '--state', 'ZZ'], { env });
    expect(badState.exitCode).toBe(1);
    expect(badState.stderr).toContain('Unknown state code: ZZ');

    const emptyLoc = await invokeHandler(
      runPersiCommand,
      ['search', '--state', 'MI', '--county', 'Oakville'],
      {
        env,
        fetchImpl: async () => new Response('<table><tr><td>Nothing</td></tr></table>', { status: 200 }),
      }
    );
    expect(emptyLoc.exitCode).toBe(1);
    expect(emptyLoc.stdout).toContain('No category counts returned');

    // Retry on HTTP 412 and succeed on attempt 2
    let attempts = 0;
    const retryRes = await invokeHandler(runPersiCommand, ['surname', 'Carter', '--json'], {
      env,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('precondition', { status: 412 });
        }
        return new Response(
          '<table><tr><td>Carter Family Bible</td><td>Oakville Quarterly</td><td>1995</td><td>OHS</td></tr></table>',
          { status: 200 }
        );
      },
    });
    expect(retryRes.exitCode).toBe(0);
    expect(attempts).toBe(2);
    expect((JSON.parse(retryRes.stdout) as { title: string }[])[0].title).toBe('Carter Family Bible');

    for (const helpArgs of [
      ['surname', '--help'],
      ['title', '--help'],
      ['location', '--help'],
      ['search', '--help'],
      ['url', '--help'],
    ]) {
      const h = await invokeHandler(runPersiCommand, helpArgs, { env });
      expect(h.exitCode, helpArgs.join(' ')).toBe(0);
      expect(h.stdout.length).toBeGreaterThan(20);
    }
  });
});
