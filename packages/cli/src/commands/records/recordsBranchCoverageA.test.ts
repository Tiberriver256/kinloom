import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError } from '../../errors.js';
import {
  emptyPageIndex,
  ensureItemCache,
  parseScandataXml,
  runArchiveOrgCommand,
} from './clients/archive-org.js';
import {
  ensureDownloadedFile,
  ensurePageImageCache,
  reuseExistingItemArtifact,
} from './clients/archiveOrg/itemCache.js';
import { findItemFile, getMetadataFiles, readPageIndex } from './clients/archiveOrg/itemParsers.js';
import {
  describeLeaf,
  flattenFields,
  grepCachedItem,
  parseLeafSpec,
  parsePrintedPageSpec,
  parsePrintedRange,
  resolvePrintedPageToLeaf,
  resolveSearchQuery,
  segmentForLeaf,
} from './clients/archiveOrg/pageAndGrep.js';
import { cachedQueryJson, httpGetBytesIa, httpGetJsonIa } from './clients/archiveOrg/transport.js';
import type { PageIndex } from './clients/archiveOrg/types.js';
import { browserSearch } from './clients/ca-archives.js';
import {
  dedupeCalisphereLinks,
  dedupeOacLinks,
  extractOmekaTitle,
  parseExhibitsItemPayload,
  parseExhibitsSearchPayload,
} from './clients/caArchives/domain.js';
import {
  buildSearchParams,
  compactResult,
  detectInvalidDownload,
  firstValue,
  formatTextField,
  iiifJpegFromInfo,
  resolveDates,
  resolvePageAssets,
  searchCacheable,
  validateLocUrl,
} from './clients/chronam/domain.js';
import { cachedGetJson, getJson, isTimeoutError, retryDelaySeconds } from './clients/chronam/httpFetch.js';
import { cachedDownloadFile, streamDownloadToPath } from './clients/chronam/transport.js';
import { runChronamCommand } from './clients/chronam.js';
import { DIGIHAKEMISTO_SEARCH_URL, HISKI_ENDPOINT, runFiArchivesCommand } from './clients/fi-archives.js';
import {
  parseDigihakemistoArchive,
  parseDigihakemistoSearch,
  parseHiskiEventDetail,
  parseHiskiResults,
} from './clients/fiArchives/parsers.js';
import {
  compactFeature,
  extractGnisTxt,
  formatSearchResultsText,
  loadGnisRows,
  matchRows,
} from './clients/gnis/domain.js';
import {
  ensureHistoricalFile,
  ensureStateFile,
  queryCachePath,
  readCachedSearch,
} from './clients/gnis/transport.js';
import { runKyArchivesCommand } from './clients/ky-archives.js';
import {
  extractAspState,
  parseLandResults,
  parsePreservicaRss,
  trimCdmSearchData,
} from './clients/kyArchives/domain.js';
import {
  parseItemHtml as parseMichItemHtml,
  parseSearchHtml as parseMichSearchHtml,
  validateMichiganologyUrl,
} from './clients/michiganology/domain.js';
import { cachedDownload as michCachedDownload } from './clients/michiganology/transport.js';
import { runMnArchivesCommand } from './clients/mn-archives.js';
import { buildPeopleQuery, getCacheDir as getMnCacheDir } from './clients/mnArchives/domain.js';
import {
  normalizePeopleHit,
  parseNewspapersMetadataHtml,
  parseNewspapersSearchHtml,
} from './clients/mnArchives/parsers.js';
import {
  downloadNewspaperThumb,
  fetchNewspapersSearch,
  fetchPeopleSearch,
} from './clients/mnArchives/transport.js';
import { runMoArchivesCommand } from './clients/mo-archives.js';
import {
  extractFormToken,
  findResultsTable,
  parseDeathName,
  parseDeathRows,
  parseDetailFields,
  parsePre1910Rows,
  parseTables,
} from './clients/moArchives/domain.js';
import { runNjArchivesCommand } from './clients/nj-archives.js';
import { emitNjResult } from './clients/njArchives/commands.js';
import { formAction, parseGrid, resolveDatabase, selectOptions } from './clients/njArchives/parsers.js';
import { a2aText, extractScans, formatA2aRecord, parseRecordRef } from './clients/openarchieven/domain.js';
import { buildDirectScanCandidates, ScanImage } from './clients/openarchieven/scans.js';
import {
  downloadScanCandidates,
  loadSearch as loadOpenArchSearch,
  readCachedScan,
  requestWithRetry,
  searchWindow,
} from './clients/openarchieven/transport.js';
import { runOpenarchievenCommand } from './clients/openarchieven.js';
import { formatPersiItemsText, parsePersiArticles, parsePersiCategories } from './clients/persi/domain.js';
import { runPersiCommand } from './clients/persi.js';
import { runSeArchivesCommand } from './clients/se-archives.js';
import {
  allLangTexts,
  extractCanvasInfo,
  firstLangText,
  formatCollectionText,
  formatManifestText,
  formatSearchText,
  normalizeSearchItem,
  parseIiifCollectionBody,
  parseIiifManifestBody,
} from './clients/seArchives/parsers.js';
import { runTexasArchivesCommand } from './clients/texas-archives.js';
import {
  entryMatchesFilters,
  extractArkId,
  mapOpenSearchEntry,
  parseOaiRecord,
  parseTdaRss,
} from './clients/texasArchives/domain.js';
import { fetchOpenSearchPage } from './clients/texasArchives/transport.js';
import { runUkArchivesCommand } from './clients/uk-archives.js';
import {
  collectionDepartment,
  mapDiscoveryDetail,
  mapDiscoveryHit,
  parseFreeregResults,
} from './clients/ukArchives/domain.js';
import { runVaArchivesCommand, CACHE_ENV as VA_CACHE_ENV } from './clients/va-archives.js';
import { extForContentType, formatChanceryRecordText, parsePageSpec } from './clients/vaArchives/domain.js';
import {
  parseCasePage,
  parseImagesPage,
  parseRosettaViewer,
  parseSearchPage,
} from './clients/vaArchives/parsers.js';
import { fetchFile, fetchText, isCacheMetaValid, makeState } from './clients/vaArchives/transport.js';
import {
  checkStatus,
  formatAncestorsText,
  formatBioText,
  formatPersonLine,
  formatSearchText as formatWikiSearchText,
} from './clients/wikitree/domain.js';
import type { OptionalBrowser } from './runtime/browser.js';
import {
  CURL_META_MARKER,
  createRecordContext,
  type ExecFileFn,
  type RecordCommandContext,
  type RecordHandler,
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

async function makeTempDir(prefix = 'kinloom-cov-a-'): Promise<string> {
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

function makeCtx(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly fetchImpl?: typeof fetch;
  readonly execFileImpl?: ExecFileFn;
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
    cwd: options.cwd ?? os.tmpdir(),
    fetchImpl:
      options.fetchImpl ??
      (async () => {
        throw new Error('unexpected network call');
      }),
    execFileImpl: options.execFileImpl,
    sleepFn: options.sleepFn ?? (async () => {}),
    nowMs: options.nowMs ?? (() => 1_700_000_000_000),
  });
}

async function invokeHandler(
  handler: RecordHandler,
  args: readonly string[],
  opts: {
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly fetchImpl?: typeof fetch;
    readonly nowMs?: () => number;
  } = {}
): Promise<InvokeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = makeCtx({ ...opts, stdout, stderr });
  const outcome = await handler(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

const SYNTH_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);
const SYNTH_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const SYNTH_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');

// ============================================================================
// 1. archiveOrg (searchCommands, pageAndGrep, itemParsers, itemCache, transport, grepCommand)
// ============================================================================

describe('archiveOrg branch coverage', () => {
  it('covers search, get, download, fulltext, and lookup text formatting, minimal payloads, cache hits, and error paths', async () => {
    const tmp = await makeTempDir('kinloom-ia-a-');
    const cacheDir = path.join(tmp, 'cache');
    const env = { KINLOOM_IA_CACHE_DIR: cacheDir };

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('advancedsearch.php')) {
        if (url.includes('sparse_alder')) {
          return jsonResponse({ response: {} });
        }
        return jsonResponse({
          response: {
            docs: ['not-an-object', {}],
          },
        });
      }
      if (url.includes('/services/search/beta/page_production/')) {
        if (url.includes('empty_resp')) {
          return jsonResponse({ response: {} });
        }
        return jsonResponse({
          response: {
            body: {
              hits: {
                hits: [
                  'bad-hit',
                  { fields: {}, highlight: { text: [42] } },
                  { fields: { date: '1884' }, highlight: {} },
                ],
              },
            },
          },
        });
      }
      if (url.includes('/metadata/missing_alder')) {
        return new Response('not found', { status: 404 });
      }
      if (url.includes('/metadata/forbidden_alder')) {
        return new Response('forbidden', { status: 403 });
      }
      if (url.includes('/metadata/minimal_mercer')) {
        return jsonResponse({
          metadata: 'not-a-record',
          files: [{}, { name: '', format: 'Text' }, { name: 'notes.txt', format: 'Text', size: '11' }],
        });
      }
      if (url.includes('/metadata/stringcol_birch')) {
        return jsonResponse({
          metadata: {
            identifier: 'stringcol_birch',
            title: 'Birch Harbor Ledger',
            date: '1872',
            mediatype: 'texts',
            collection: 'harbor_collection',
            description: 'Synthetic ledger for Harbor township.',
          },
          files: [{ name: 'ledger.txt', format: 'Text', size: '12' }],
        });
      }
      if (url.includes('/download/minimal_mercer/notes.txt')) {
        return new Response('alder notes', { status: 200 });
      }
      if (url.includes('/metadata/empty_idx_cedar')) {
        return jsonResponse({
          metadata: { identifier: 'empty_idx_cedar', title: 'Cedar Index' },
          files: [],
        });
      }
      return new Response('unexpected', { status: 404 });
    };

    // search: sparse response ({}) -> hit cache on second call
    const sSparse1 = await invokeHandler(runArchiveOrgCommand, ['search', 'sparse_alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(sSparse1.exitCode).toBe(0);
    expect(sSparse1.stdout).toBe(' items (fetched)');
    const sSparse2 = await invokeHandler(runArchiveOrgCommand, ['search', 'sparse_alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(sSparse2.exitCode).toBe(0);
    expect(sSparse2.stdout).toBe(' items (cache-hit)');

    // search: non-object doc + empty doc fields
    const sDocs = await invokeHandler(runArchiveOrgCommand, ['search', 'docs_alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(sDocs.exitCode).toBe(0);
    expect(sDocs.stdout).toContain(' |  |  |  |  | https://archive.org/details/');

    // get: 404 ArchiveNotFoundError & 403 non-not-found error
    const g404 = await invokeHandler(runArchiveOrgCommand, ['get', 'missing_alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(g404.exitCode).toBe(1);
    expect(g404.stderr).toContain('No item with identifier missing_alder');

    const g403 = await invokeHandler(runArchiveOrgCommand, ['get', 'forbidden_alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(g403.exitCode).toBe(1);
    expect(g403.stderr).toContain('HTTP 403');

    // get: non-record metadata, missing optional metadata fields, --files with sparse entries, and cache hit
    const gMin = await invokeHandler(runArchiveOrgCommand, ['get', 'minimal_mercer', '--files'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(gMin.exitCode).toBe(0);
    expect(gMin.stdout).toContain('minimal_mercer');
    expect(gMin.stdout).toContain('  Identifier: ');
    expect(gMin.stdout).toContain('     |  |  bytes');

    const gMinHit = await invokeHandler(runArchiveOrgCommand, ['get', 'minimal_mercer'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(gMinHit.exitCode).toBe(0);
    expect(gMinHit.stdout).toContain('(cache-hit)');

    // get: collection as string (not array) + date/mediatype/description
    const gStrCol = await invokeHandler(runArchiveOrgCommand, ['get', 'stringcol_birch'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(gStrCol.exitCode).toBe(0);
    expect(gStrCol.stdout).toContain('  Collection: harbor_collection');
    expect(gStrCol.stdout).toContain('  Date: 1872');
    expect(gStrCol.stdout).toContain('  Description: Synthetic ledger for Harbor township.');

    // download: 404, 403, --list with sparse entry, relative --out path, and absolute --out path
    const d404 = await invokeHandler(runArchiveOrgCommand, ['download', 'missing_alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(d404.exitCode).toBe(1);
    expect(d404.stderr).toContain('No item with identifier missing_alder');

    const d403 = await invokeHandler(runArchiveOrgCommand, ['download', 'forbidden_alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(d403.exitCode).toBe(1);
    expect(d403.stderr).toContain('HTTP 403');

    const dList = await invokeHandler(runArchiveOrgCommand, ['download', 'minimal_mercer', '--list'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(dList.exitCode).toBe(0);
    expect(dList.stdout).toContain(' |  |  bytes');

    const dRel = await invokeHandler(
      runArchiveOrgCommand,
      ['download', 'minimal_mercer', 'notes.txt', '--out', 'rel-downloads'],
      { env, cwd: tmp, fetchImpl }
    );
    expect(dRel.exitCode).toBe(0);
    expect(dRel.stdout).toContain('rel-downloads/notes.txt (11 bytes, fetched)');

    // fulltext: empty response + hits with missing fields / date fallback / non-string highlight + cache hit
    const ftEmpty = await invokeHandler(runArchiveOrgCommand, ['fulltext', 'empty_resp'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(ftEmpty.exitCode).toBe(0);
    expect(ftEmpty.stdout).toBe('0 full-text matches (showing 0, fetched)');

    const ftSparse1 = await invokeHandler(runArchiveOrgCommand, ['fulltext', 'sparse_hits'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(ftSparse1.exitCode).toBe(0);
    expect(ftSparse1.stdout).toContain('0 full-text matches (showing 3, fetched)');
    expect(ftSparse1.stdout).toContain('-  |  | 1884 | https://archive.org/details/');

    const ftSparse2 = await invokeHandler(runArchiveOrgCommand, ['fulltext', 'sparse_hits'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(ftSparse2.exitCode).toBe(0);
    expect(ftSparse2.stdout).toContain('(showing 3, cache-hit)');

    // lookup: empty page index -> printed_page '?' and scandata_leaf '?', plus corrupted page_index.json fallback
    const l1 = await invokeHandler(runArchiveOrgCommand, ['lookup', 'empty_idx_cedar', '--leaf', '0'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(l1.exitCode).toBe(0);
    expect(l1.stdout).toContain('printed page ? | BookReader leaf n0 | scandata leaf ?');

    fs.writeFileSync(path.join(cacheDir, 'empty_idx_cedar', 'page_index.json'), '{"bad":true}', 'utf8');
    const l2 = await invokeHandler(runArchiveOrgCommand, ['lookup', 'empty_idx_cedar', '--leaf', '0'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(l2.exitCode).toBe(0);
    expect(l2.stdout).toContain('BookReader leaf n0');
  });

  it('covers pageAndGrep helpers: segment modes, zero-length regex, limit cap, printed fallback, duplicates, and parsers', async () => {
    const tmp = await makeTempDir('kinloom-ia-pg-');

    const bookreaderIdx: PageIndex = {
      leaf_count: 3,
      access_leaf_count: 3,
      scandata_to_bookreader: {},
      bookreader_to_scandata: { '0': 1 },
      scandata_to_printed: {},
      bookreader_to_printed: { '0': '10' },
      printed_to_bookreader: { '10': 0, '11': 1 },
      printed_to_bookreader_ci: { x: 2 },
      printed_to_scandata: { '99': 2 },
      segment_mode: 'bookreader',
    };

    // bookreader mode: seg 0 has mapping, seg 1 missing in b2s & b2p; case-sensitive; trailing line w/o \n; limit hit
    const [hitsBr, totalBr] = grepCachedItem(
      'alder_book',
      'Alder one\nAlder two\x0cAlder three',
      bookreaderIdx,
      'Alder',
      false,
      { contextChars: 40, limit: 2 }
    );
    expect(totalBr).toBe(3);
    expect(hitsBr).toHaveLength(2);
    expect(hitsBr[0].printed_page).toBe('10');
    expect(hitsBr[0].scandata_leaf).toBe(1);

    // bookreader mode with seg 1 (unmapped in b2s & b2p)
    const [hitsBrUnmapped] = grepCachedItem(
      'alder_book',
      'skip\x0cMercer line\n',
      bookreaderIdx,
      'Mercer',
      false,
      {
        contextChars: 40,
        limit: 5,
      }
    );
    expect(hitsBrUnmapped[0].scandata_leaf).toBeNull();
    expect(hitsBrUnmapped[0].printed_page).toBeNull();

    // zero-length regex match at end of line (exercises iterRegex.lastIndex >= line.length)
    const [zeroHits, zeroTotal] = grepCachedItem('alder_book', 'ab', bookreaderIdx, '$', false, {
      contextChars: 20,
      limit: 5,
    });
    expect(zeroHits).toEqual([]);
    expect(zeroTotal).toBe(0);

    // empty segment_mode falls back to 'scandata'
    const fallbackIdx: PageIndex = {
      ...emptyPageIndex(),
      segment_mode: '',
    };
    const [fallbackHits] = grepCachedItem('alder_book', 'Birch Harbor', fallbackIdx, 'Birch', true, {
      contextChars: 20,
      limit: 5,
    });
    expect(fallbackHits[0].leaf).toBe(0);
    expect(segmentForLeaf(fallbackIdx, 2, null)).toBe(2);

    // resolvePrintedPageToLeaf: exact without b2s entry, CI without b2s entry, printed_to_scandata fallback
    expect(resolvePrintedPageToLeaf(bookreaderIdx, '11')).toEqual([1, null]);
    expect(resolvePrintedPageToLeaf(bookreaderIdx, 'X')).toEqual([2, null]);
    expect(resolvePrintedPageToLeaf(bookreaderIdx, '99')).toEqual([2, 2]);
    expect(describeLeaf(bookreaderIdx, 1)).toEqual({ leaf: 1, scandata_leaf: null, printed_page: null });

    // duplicate elimination in parsePrintedRange, parseLeafSpec, parsePrintedPageSpec, resolveSearchQuery, flattenFields
    expect(parsePrintedRange(bookreaderIdx, '10-11,11')).toEqual([0, 1]);
    expect(parseLeafSpec('n1,N2,3,2')).toEqual([1, 2, 3]);
    expect(parsePrintedPageSpec('10-11,10')).toEqual(['10', '11']);
    expect(resolveSearchQuery(['Mercer'], undefined, { collections: ['harbor, , cedar'] })).toBe(
      'Mercer AND collection:(harbor OR cedar)'
    );
    expect(flattenFields(['title, , title, date'])).toEqual(['title', 'date']);

    // itemParsers: getMetadataFiles non-array, findItemFile missing name / omitted formats / format fallback
    expect(getMetadataFiles({ metadata: {} })).toEqual([]);
    expect(
      findItemFile([{ format: 'Scandata' }, { name: 'ok.xml', format: 'Scandata' }], { suffixes: ['.nope'] })
    ).toBeUndefined();
    expect(
      findItemFile([{ format: 'Scandata' }, { name: 'found_by_fmt.bin', format: 'Scandata' }], {
        suffixes: ['.nope'],
        formats: ['scandata'],
      })
    ).toBe('found_by_fmt.bin');

    // parseScandataXml: empty <pageData/>, single <page> without leafNum, attributed #text, duplicate pageNumber, nested array wrapper
    const emptyPd = parseScandataXml(Buffer.from('<book><pageData/></book>', 'utf8'));
    expect(emptyPd.leaf_count).toBe(0);

    const singlePage = parseScandataXml(
      Buffer.from(
        '<root><book/><book><pageData><page><pageNumber source="ocr">7</pageNumber></page></pageData></book></root>',
        'utf8'
      )
    );
    expect(singlePage.leaf_count).toBe(1);
    expect(singlePage.printed_to_bookreader['7']).toBe(0);

    const dupPages = parseScandataXml(
      Buffer.from(
        `<book><pageData>
          <page leafNum="0"><pageNumber>iv</pageNumber></page>
          <page leafNum="1"><pageNumber>IV</pageNumber></page>
          <page leafNum="2"><pageNumber>iv</pageNumber></page>
        </pageData></book>`,
        'utf8'
      )
    );
    expect(dupPages.printed_to_scandata['iv']).toBe(0);
    expect(dupPages.printed_to_bookreader['iv']).toBe(0);
    expect(dupPages.printed_to_bookreader_ci['iv']).toBe(0);

    const badIdxPath = path.join(tmp, 'bad_index.json');
    fs.writeFileSync(badIdxPath, JSON.stringify({ leaf_count: 'nope' }), 'utf8');
    expect(readPageIndex(badIdxPath)).toBeUndefined();
  });

  it('covers itemCache, transport, and grepCommand edge branches', async () => {
    const tmp = await makeTempDir('kinloom-ia-cache-');
    const cacheDir = path.join(tmp, 'cache');

    // 1. ensureItemCache with hOCR-only item where hOCR synthesis fails -> fetchErrors.hocr + error detail
    const hocrFailCtx = makeCtx({
      env: { KINLOOM_IA_CACHE_DIR: cacheDir },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/metadata/hocr_fail_item')) {
          return jsonResponse({
            metadata: { identifier: 'hocr_fail_item' },
            files: [
              { name: 'hocr_fail_item_hocr_searchtext.txt.gz', format: 'OCR Search Text' },
              { name: 'hocr_fail_item_hocr_pageindex.json.gz', format: 'OCR Page Index' },
            ],
          });
        }
        if (url.endsWith('_hocr_searchtext.txt.gz')) {
          return new Response(gzipSync(Buffer.from('Alder text', 'utf8')), { status: 200 });
        }
        if (url.endsWith('_hocr_pageindex.json.gz')) {
          return new Response(gzipSync(Buffer.from('{not valid json', 'utf8')), { status: 200 });
        }
        return new Response('missing', { status: 404 });
      },
    });
    await expect(
      ensureItemCache('hocr_fail_item', hocrFailCtx, { needDjvu: true, cacheRoot: cacheDir })
    ).rejects.toThrow('hocr:');

    // 2. ensureItemCache with NO OCR files -> empty fetchErrors
    const noOcrCtx = makeCtx({
      env: { KINLOOM_IA_CACHE_DIR: cacheDir },
      fetchImpl: async () =>
        jsonResponse({
          metadata: { identifier: 'no_ocr_item' },
          files: [],
        }),
    });
    await expect(
      ensureItemCache('no_ocr_item', noOcrCtx, { needDjvu: true, cacheRoot: cacheDir })
    ).rejects.toThrow('Item no_ocr_item has no downloadable OCR text');

    // 3. ensureItemCache reusing existing scandata.xml on disk when page_index.json is absent
    const preItemDir = path.join(cacheDir, 'pre_scandata_item');
    fs.mkdirSync(preItemDir, { recursive: true });
    fs.writeFileSync(
      path.join(preItemDir, 'metadata.json'),
      JSON.stringify({
        metadata: { identifier: 'pre_scandata_item' },
        files: [{ name: 'pre_scandata_item_scandata.xml', format: 'Scandata' }],
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(preItemDir, 'scandata.xml'),
      '<book><pageData><page leafNum="0"><pageNumber>1</pageNumber></page></pageData></book>',
      'utf8'
    );
    const preRes = await ensureItemCache('pre_scandata_item', noOcrCtx, {
      needDjvu: false,
      cacheRoot: cacheDir,
    });
    expect(preRes.cached).toBe(false);
    expect(readPageIndex(preRes.pageIndexPath)?.leaf_count).toBe(1);

    // 4. reuseExistingItemArtifact branches: missing page_index.json, size match, size mismatch, no size w/ & w/o hocr
    const reuseDir = path.join(cacheDir, 'reuse_item');
    fs.mkdirSync(reuseDir, { recursive: true });
    fs.writeFileSync(path.join(reuseDir, 'djvu.txt'), '12345', 'utf8');
    const djvuFileList = [{ name: 'reuse_item_djvu.txt', format: 'DjVuTXT', size: '5' }];
    expect(
      reuseExistingItemArtifact(reuseDir, 'reuse_item_djvu.txt', djvuFileList, djvuFileList[0])?.toString(
        'utf8'
      )
    ).toBe('12345');
    expect(
      reuseExistingItemArtifact(reuseDir, 'reuse_item_djvu.txt', djvuFileList, {
        name: 'reuse_item_djvu.txt',
        size: '999',
      })
    ).toBeUndefined();
    expect(
      reuseExistingItemArtifact(reuseDir, 'reuse_item_djvu.txt', [{ name: 'reuse_item_djvu.txt' }], {
        name: 'reuse_item_djvu.txt',
      })?.toString('utf8')
    ).toBe('12345');
    expect(
      reuseExistingItemArtifact(
        reuseDir,
        'reuse_item_djvu.txt',
        [{ name: 'reuse_item_djvu.txt' }, { name: 'reuse_item_hocr_searchtext.txt.gz' }],
        { name: 'reuse_item_djvu.txt' }
      )
    ).toBeUndefined();

    // 5. transport: response.url set, non-Error thrown, ECONNRESET retries exhausted, cachedQueryJson corrupt/invalid payloads
    const respWithUrl = new Response('ok-bytes', { status: 200 });
    Object.defineProperty(respWithUrl, 'url', { value: 'https://archive.org/download/alder/ok.txt' });
    const bytesOk = await httpGetBytesIa(
      'https://archive.org/download/alder/ok.txt',
      makeCtx({ fetchImpl: async () => respWithUrl })
    );
    expect(bytesOk.toString('utf8')).toBe('ok-bytes');

    await expect(
      httpGetBytesIa(
        'https://archive.org/download/alder/nonerr',
        makeCtx({
          fetchImpl: async () => {
            throw 'string-failure';
          },
        })
      )
    ).rejects.toThrow('string-failure');

    await expect(
      httpGetBytesIa(
        'https://archive.org/download/alder/reset',
        makeCtx({
          fetchImpl: async () => {
            const err: Error & { code?: string } = new Error('connection dropped');
            err.code = 'ECONNRESET';
            throw err;
          },
        })
      )
    ).rejects.toThrow('Incomplete response');

    await expect(
      httpGetJsonIa(
        'https://archive.org/metadata/bad_json',
        makeCtx({ fetchImpl: async () => new Response('{broken', { status: 200 }) })
      )
    ).rejects.toThrow('Invalid JSON response');

    // cachedQueryJson: search with non-zero responseHeader.status, fulltext with invalid payload, corrupt cache file
    await expect(
      cachedQueryJson(
        'search',
        { q: 'alder_err' },
        'https://archive.org/advancedsearch.php?q=alder_err',
        makeCtx({
          env: { KINLOOM_IA_CACHE_DIR: cacheDir },
          fetchImpl: async () => jsonResponse({ responseHeader: { status: 500 }, response: {} }),
        }),
        { cacheRoot: cacheDir }
      )
    ).rejects.toThrow('500');

    await expect(
      cachedQueryJson(
        'fulltext',
        { q: 'ft_err' },
        'https://be-api.us.archive.org/search/v1?q=ft_err',
        makeCtx({
          env: { KINLOOM_IA_CACHE_DIR: cacheDir },
          fetchImpl: async () => jsonResponse({ response: 'not-a-record' }),
        }),
        { cacheRoot: cacheDir }
      )
    ).rejects.toThrow('error response');

    // Seed corrupt cache entries and verify cachedQueryJson ignores them and refetches
    const queriesDir = path.join(cacheDir, '_queries', 'search');
    fs.mkdirSync(queriesDir, { recursive: true });
    const [okData] = await cachedQueryJson(
      'search',
      { q: 'corrupt_cache_test' },
      'https://archive.org/advancedsearch.php?q=corrupt_cache_test',
      makeCtx({
        env: { KINLOOM_IA_CACHE_DIR: cacheDir },
        fetchImpl: async () => jsonResponse({ response: { numFound: 1, docs: [] } }),
      }),
      { cacheRoot: cacheDir }
    );
    expect(okData['response']).toBeDefined();
    const cacheFiles = fs.readdirSync(queriesDir).filter((f) => f.endsWith('.json'));
    const targetCacheFile = path.join(queriesDir, cacheFiles[0]);
    fs.writeFileSync(targetCacheFile, JSON.stringify({ cached_at: 'bad', data: {} }), 'utf8');
    const [, hitAfterBadTs] = await cachedQueryJson(
      'search',
      { q: 'corrupt_cache_test' },
      'https://archive.org/advancedsearch.php?q=corrupt_cache_test',
      makeCtx({
        env: { KINLOOM_IA_CACHE_DIR: cacheDir },
        fetchImpl: async () => jsonResponse({ response: { numFound: 2, docs: [] } }),
      }),
      { cacheRoot: cacheDir }
    );
    expect(hitAfterBadTs).toBe(false);

    fs.writeFileSync(
      targetCacheFile,
      JSON.stringify({ cached_at: 1_700_000_000, data: { error: 'stale error' } }),
      'utf8'
    );
    const [, hitAfterInvalidPayload] = await cachedQueryJson(
      'search',
      { q: 'corrupt_cache_test' },
      'https://archive.org/advancedsearch.php?q=corrupt_cache_test',
      makeCtx({
        env: { KINLOOM_IA_CACHE_DIR: cacheDir },
        fetchImpl: async () => jsonResponse({ response: { numFound: 3, docs: [] } }),
      }),
      { cacheRoot: cacheDir }
    );
    expect(hitAfterInvalidPayload).toBe(false);

    // 6. grepCommand: reversed positional (pattern first, item id second), duplicate item ids, flat text (n?, p.?), cache hit
    const grepFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/metadata/harbor_flat_01')) {
        return jsonResponse({
          metadata: { identifier: 'harbor_flat_01' },
          files: [{ name: 'harbor_flat_01_djvu.txt', format: 'DjVuTXT' }],
        });
      }
      if (url.includes('/download/harbor_flat_01/harbor_flat_01_djvu.txt')) {
        return new Response('Alder Mercer flat OCR line without form feeds', { status: 200 });
      }
      return new Response('missing', { status: 404 });
    };

    const g1 = await invokeHandler(runArchiveOrgCommand, ['grep', 'Alder|Mercer', 'harbor_flat_01'], {
      env: { KINLOOM_IA_CACHE_DIR: cacheDir },
      cwd: tmp,
      fetchImpl: grepFetch,
    });
    expect(g1.exitCode).toBe(0);
    expect(g1.stdout).toContain('harbor_flat_01 | n? (p.?)');

    // Duplicate item ID + case-sensitive (-e) + cache-hit
    const g2 = await invokeHandler(
      runArchiveOrgCommand,
      ['grep', 'harbor_flat_01', 'harbor_flat_01', '-e', 'Mercer'],
      { env: { KINLOOM_IA_CACHE_DIR: cacheDir }, cwd: tmp, fetchImpl: grepFetch }
    );
    expect(g2.exitCode).toBe(0);
    expect(g2.stdout).toContain('1 matches across 1 item(s)');
    expect(g2.stdout).toContain('cache-hit');
  });
});

// ============================================================================
// 2. seArchives (searchCommands, parsers)
// ============================================================================

describe('seArchives branch coverage', () => {
  it('exercises all optional search flags in births, marriages, and deeds commands', async () => {
    const tmp = await makeTempDir('kinloom-se-a-');
    const seenUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seenUrls.push(String(input));
      return jsonResponse({
        totalHits: 1,
        items: [{ id: 'SE1', objectType: 'Register', type: 'Birth', caption: 'Alder Entry', metadata: {} }],
      });
    };
    const env = { KINLOOM_SE_ARCHIVES_CACHE_DIR: tmp };

    const bRes = await invokeHandler(
      runSeArchivesCommand,
      [
        'births',
        '--first',
        'Erik',
        '--father',
        'Anders',
        '--mother',
        'Karin',
        '--place',
        'Uppsala',
        '--witness',
        'Nils',
        '--gender',
        'female',
        '--year-min',
        '1840',
        '--year-max',
        '1860',
      ],
      { env, fetchImpl }
    );
    expect(bRes.exitCode).toBe(0);
    expect(seenUrls[0]).toContain('mothers_name=Karin');
    expect(seenUrls[0]).toContain('place=Uppsala');
    expect(seenUrls[0]).toContain('baptismal_witness=Nils');
    expect(seenUrls[0]).toContain('year_min=1840');
    expect(seenUrls[0]).toContain('year_max=1860');

    const mRes = await invokeHandler(
      runSeArchivesCommand,
      [
        'marriages',
        '--groom',
        'Erik',
        '--bride',
        'Anna',
        '--groom-place',
        'Dalby',
        '--bride-place',
        'Lund',
        '--parish',
        'Uppsala',
        '--county',
        'Uppsala',
        '--year-min',
        '1850',
        '--year-max',
        '1870',
      ],
      { env, fetchImpl }
    );
    expect(mRes.exitCode).toBe(0);
    expect(seenUrls[1]).toContain('grooms_home_place=Dalby');
    expect(seenUrls[1]).toContain('brides_home_place=Lund');
    expect(seenUrls[1]).toContain('parish=Uppsala');
    expect(seenUrls[1]).toContain('county=Uppsala');
    expect(seenUrls[1]).toContain('year_min=1850');
    expect(seenUrls[1]).toContain('year_max=1870');

    const dRes = await invokeHandler(
      runSeArchivesCommand,
      [
        'deeds',
        '--parish',
        'Uppsala',
        '--property',
        'Bjorkby',
        '--tax-unit',
        '1/4',
        '--court',
        'Ting1',
        '--admin-unit',
        'Harad',
        '--year-min',
        '1800',
        '--year-max',
        '1850',
      ],
      { env, fetchImpl }
    );
    expect(dRes.exitCode).toBe(0);
    expect(seenUrls[2]).toContain('property_name=Bjorkby');
    expect(seenUrls[2]).toContain('tax_unit=1%2F4');
    expect(seenUrls[2]).toContain('district_court_sessions=Ting1');
    expect(seenUrls[2]).toContain('administrative_unit=Harad');
    expect(seenUrls[2]).toContain('year_min=1800');
    expect(seenUrls[2]).toContain('year_max=1850');
  });

  it('exercises seArchives parser edge branches: language maps, fallbacks, IIIF collections/manifests, and text formatters', () => {
    expect(firstLangText({ de: 'Nur Text', fr: [] })).toBe('');
    expect(allLangTexts({ de: [], it: ['Uno'] })).toEqual(['Uno']);

    // normalizeSearchItem: missing fields, non-record metadata, whitespace-only hierarchy, referenceCode caption, duplicate manifests
    const emptyItem = normalizeSearchItem({
      metadata: 'bad',
      _links: {
        image: ['https://other.example.test/skip', 'https://lbiiif.riksarkivet.se/arkis!C1/manifest'],
      },
      transcribedText: {
        snippets: [{ pages: [{}, { id: '_C1_00001' }] }],
      },
    });
    expect(emptyItem.id).toBe('');
    expect(emptyItem.caption).toBe('');
    expect(emptyItem.iiif_manifests).toEqual(['https://lbiiif.riksarkivet.se/arkis!C1/manifest']);

    const refFallback = normalizeSearchItem({
      metadata: {
        hierarchy: [null, { caption: '   ' }],
        referenceCode: 'SE/ULA/10001',
        note: '   ',
      },
    });
    expect(refFallback.caption).toBe('SE/ULA/10001');
    expect(refFallback.note).toBeUndefined();

    // parseIiifCollectionBody: Datering summary, missing items, non-record item, missing id/type, Manifest with/without arkis match
    const colNoItems = parseIiifCollectionBody(
      {
        type: 'Collection',
        summary: { sv: ['Datering: 1810-1850', 'Other: note'] },
      },
      'ARC1',
      'https://lbiiif.riksarkivet.se/collection/arkiv/ARC1'
    );
    expect(colNoItems.date).toBe('1810-1850');
    expect(colNoItems.items).toEqual([]);

    const colMixed = parseIiifCollectionBody(
      {
        type: 'Collection',
        items: [
          'skip',
          {},
          { id: 'https://lbiiif.riksarkivet.se/other', type: 'Other', label: 'Misc' },
          { id: 'https://lbiiif.riksarkivet.se/plain/manifest', type: 'Manifest', label: 'NoArkis' },
          { id: 'https://lbiiif.riksarkivet.se/arkis!_C0009/manifest', type: 'Manifest', label: 'WithArkis' },
        ],
      },
      'ARC2',
      'https://lbiiif.riksarkivet.se/collection/arkiv/ARC2'
    );
    expect(colMixed.count).toBe(4);
    expect(colMixed.items[3].bildid).toBe('C0009');

    // extractCanvasInfo: empty id, källhänvisning & unrelated metadata
    const emptyCanvas = extractCanvasInfo(1, {
      metadata: [
        'skip',
        { label: { sv: ['Källhänvisning'] }, value: { sv: ['Vol 1 p. 4'] } },
        { label: { sv: ['Other'] }, value: { sv: ['ignored'] } },
      ],
    });
    expect(emptyCanvas.page_id).toBe('');
    expect(emptyCanvas.source_reference).toBe('Vol 1 p. 4');
    expect(emptyCanvas.full_image_url).toBe('');

    // parseIiifManifestBody: non-record metadata, missing value, missing items, non-record canvas
    const man = parseIiifManifestBody(
      {
        type: 'Manifest',
        metadata: [
          'bad',
          { label: { sv: ['Empty'] }, value: { sv: [] } },
          { label: { sv: ['Archive'] }, value: { sv: ['ULA'] } },
        ],
        items: ['bad-canvas', { id: 'https://lbiiif.riksarkivet.se/arkis!C0009_00001/canvas' }],
      },
      'C0009',
      'https://lbiiif.riksarkivet.se/arkis!C0009/manifest'
    );
    expect(man.metadata).toEqual({ Archive: 'ULA' });
    expect(man.canvas_count).toBe(1);

    const manNoItems = parseIiifManifestBody(
      { type: 'Manifest' },
      'C0010',
      'https://lbiiif.riksarkivet.se/arkis!C0010/manifest'
    );
    expect(manNoItems.canvas_count).toBe(0);

    // formatSearchText / formatCollectionText / formatManifestText with empty fallback fields
    const txt = formatSearchText(
      'Search',
      {
        total: 1,
        hits: 1,
        offset: 0,
        results: [
          {
            id: '',
            object_type: '',
            type: '',
            caption: '',
            reference_code: '',
            date: '',
            parish: '',
            institution: '',
            digitized: false,
          },
        ],
        verified: true,
      },
      false
    );
    expect(txt).toContain('Record | (untitled)');

    expect(formatCollectionText('ARC_FALLBACK', { ...colNoItems, label: '' }, false)).toContain(
      'ARC_FALLBACK | items=0'
    );
    expect(formatManifestText('VOL_FALLBACK', { ...manNoItems, label: '' }, 10, false)).toContain(
      'VOL_FALLBACK | canvases=0'
    );
  });
});

// ============================================================================
// 3. mnArchives (commands, parsers, transport)
// ============================================================================

describe('mnArchives branch coverage', () => {
  it('covers minimal people/record/newspaper formatting, cache hits, parser edges, and transport defaults', async () => {
    const tmp = await makeTempDir('kinloom-mn-a-');
    const env = { KINLOOM_CACHE_DIR: path.join(tmp, 'cache') };
    const uuid = '33333333-3333-4333-8333-333333333333';

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/_hcms/api/death/getAllDeathRecords')) {
        return jsonResponse({
          success: true,
          data: {
            hits: [{ id: '', firstName: 123, familyName: null }],
          },
        });
      }
      if (url.includes('/_hcms/api/death/getDeathRecordById')) {
        return jsonResponse({
          success: true,
          data: { id: uuid },
        });
      }
      if (url.includes('newspapers.mnhs.org/jsp/PsSearchResults.jsp')) {
        return new Response(
          `<html><script>var psRecCnt = 1;</script><table><tr>
            <td class="ps-result-cell">
              <a class="ps-result-title" href="/jsp/PsImageViewer.jsp?doc_id=alder_01"></a>
            </td>
          </tr></table></html>`,
          { status: 200 }
        );
      }
      if (url.includes('newspapers.mnhs.org/jsp/PsMetadata.jsp')) {
        return new Response(
          '<table><tr><td class="ps-md-field-value">orphan</td><td class="ps-md-field-label">Title</td><td class="ps-md-field-value">Harbor Gazette</td></tr></table>',
          { status: 200 }
        );
      }
      return new Response(SYNTH_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };

    // People search: unnamed hit with missing date/county/id + missing totalHitCount/pageNum/pageSize
    const pRes = await invokeHandler(runMnArchivesCommand, ['death', '--last', 'Alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(pRes.exitCode).toBe(0);
    expect(pRes.stdout).toContain('(unnamed)');

    // Record detail: minimal hit without date/county/cert/mother/birth_date/birth_place
    const rRes = await invokeHandler(runMnArchivesCommand, ['record', uuid, '--type', 'death'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(rRes.exitCode).toBe(0);
    expect(rRes.stdout).toContain('  Name: (unnamed)');

    // Newspapers search: miss + cache hit with untitled/empty-date item
    const n1 = await invokeHandler(runMnArchivesCommand, ['newspapers', 'search', 'Alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(n1.exitCode).toBe(0);
    expect(n1.stdout).toContain('(untitled)');
    const n2 = await invokeHandler(runMnArchivesCommand, ['newspapers', 'search', 'Alder'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(n2.exitCode).toBe(0);
    expect(n2.stdout).toContain('[cache]');

    // Newspapers metadata: miss + cache hit
    const m1 = await invokeHandler(runMnArchivesCommand, ['newspapers', 'metadata', 'alder_01'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(m1.exitCode).toBe(0);
    expect(m1.stdout).toContain('Title: Harbor Gazette');
    const m2 = await invokeHandler(runMnArchivesCommand, ['newspapers', 'metadata', 'alder_01'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(m2.exitCode).toBe(0);
    expect(m2.stdout).toContain('[cache]');

    // Parser direct edge cases
    const unknownTypeHit = normalizePeopleHit('unknown-type', {
      residence: 'Cedar Twp',
      militaryServices: ['bad', { value: '' }],
    });
    expect(unknownTypeHit.date).toBe('');
    expect(unknownTypeHit.county).toBe('Cedar Twp');
    expect(unknownTypeHit.url).toContain('www.mnhs.org/search/people');
    expect(unknownTypeHit.military_services).toBeUndefined();

    const emptyCountyHit = normalizePeopleHit('unknown-type', {});
    expect(emptyCountyHit.county).toBe('');

    const [parsedTotal, parsedItems] = parseNewspapersSearchHtml(`
      <table>
        <tr><td class="ps-result-cell"><div class="ps-result-detail">First</div><div class="ps-result-detail">Second</div><img class="ps-result-thumb" /></td></tr>
        <tr><td class="ps-result-cell"><a class="ps-result-title" href="/jsp/PsImageViewer.jsp">NoDocId</a></td></tr>
        <tr><td class="ps-result-cell"><a class="ps-result-title">NoHref</a></td></tr>
      </table>
    `);
    expect(parsedTotal).toBeNull();
    expect(parsedItems).toEqual([]);
    expect(
      parseNewspapersMetadataHtml('<table><tr><td class="ps-md-field-value">x</td></tr></table>')
    ).toEqual({});

    // Transport edge cases: fetchPeopleSearch defaults, fetchNewspapersSearch begin-only / end-only / unknown field / unverified 0 results
    const ctx = makeCtx({ env, cwd: tmp, fetchImpl });
    const searchDefaults = await fetchPeopleSearch(
      ctx,
      'death-records',
      { query: '', filters: [], sorts: [] },
      1,
      25
    );
    expect(searchDefaults.total).toBe(0);
    expect(searchDefaults.page).toBe(1);

    const nsNoTotalCtx = makeCtx({
      env,
      cwd: tmp,
      fetchImpl: async () => new Response('<html><body>empty</body></html>', { status: 200 }),
    });
    const nsBeginOnly = await fetchNewspapersSearch(nsNoTotalCtx, {
      query: 'Alder',
      field: 'unknown-field',
      beginDate: '1880-01-01',
      endDate: '',
      county: '',
      city: '',
      title: '',
      limit: 10,
      offset: 0,
    });
    expect(nsBeginOnly.verified).toBe(false);
    expect(nsBeginOnly.total).toBe(0);

    const nsEndOnly = await fetchNewspapersSearch(nsNoTotalCtx, {
      query: 'Alder',
      field: 'content',
      beginDate: '',
      endDate: '1900-12-31',
      county: '',
      city: '',
      title: '',
      limit: 10,
      offset: 0,
    });
    expect(nsEndOnly.total).toBe(0);

    // downloadNewspaperThumb: doc_id param, no param fallback, HTML & non-image with missing content-type header
    const thumbDir = path.join(tmp, 'thumbs');
    fs.mkdirSync(thumbDir, { recursive: true });
    const dlDocId = await downloadNewspaperThumb(
      ctx,
      'https://newspapers.mnhs.org/jsp/PsThumb.jsp?doc_id=alder_doc',
      thumbDir,
      true
    );
    expect(dlDocId.path).toContain('alder_doc.jpg');

    const dlNoParam = await downloadNewspaperThumb(
      ctx,
      'https://newspapers.mnhs.org/jsp/PsThumb.jsp',
      thumbDir,
      true
    );
    expect(dlNoParam.path).toContain('newspaper_thumb.jpg');

    const htmlNoCtCtx = makeCtx({
      env,
      cwd: tmp,
      fetchImpl: async () => new Response('<html>blocked</html>', { status: 200, headers: {} }),
    });
    await expect(
      downloadNewspaperThumb(htmlNoCtCtx, 'alder_01', path.join(tmp, 'h.jpg'), true)
    ).rejects.toThrow('Refusing to save HTML response');

    const rawNoCtCtx = makeCtx({
      env,
      cwd: tmp,
      fetchImpl: async () => {
        const resp = new Response(Buffer.from([0x01, 0x02, 0x03, 0x04]), { status: 200 });
        resp.headers.delete('content-type');
        return resp;
      },
    });
    await expect(
      downloadNewspaperThumb(rawNoCtCtx, 'alder_01', path.join(tmp, 'b.jpg'), true)
    ).rejects.toThrow('Content-Type: unknown');
  });
});

// ============================================================================
// 4. fiArchives (commands, parsers)
// ============================================================================

describe('fiArchives branch coverage', () => {
  it('covers HisKi/Digihakemisto parser edges, cache-hit text formatting, and minimal records', async () => {
    const tmp = await makeTempDir('kinloom-fi-a-');
    const parishBytes = Buffer.from(
      '<HTML><BODY><SELECT NAME=srk><OPTION VALUE="0012">Anjala</SELECT></BODY></HTML>',
      'latin1'
    );
    const sparseHiskiHtml = `
      <HTML><BODY>
        <FONT SIZE="+2"><B>   </B></FONT>
        <TABLE BORDER=1>
          <TR></TR>
          <TR><TD><a href="">empty</a><a href="/other">skip</a></TD><TD>x</TD></TR>
          <TR><TD><a href="/hiski?en+0012+kastetut+1"></a></TD><TD>2.1.1820</TD></TR>
          <TR><TD></TD><TD>   </TD></TR>
          <TR><TD><a href="/hiski?en+0012+vihityt+2"></a></TD><TD>3.1.1820</TD></TR>
          <TR><TD><a href="/hiski?en+0012+haudatut+3"></a></TD><TD>4.1.1820</TD></TR>
          <TR><TD><a href="/hiski?en+0012+smuutt+4">5.1.1820</a></TD><TD></TD></TR>
          <TR><TD><a href="/hiski?en+0012+muut+5">6.1.1820</a></TD></TR>
        </TABLE>
      </BODY></HTML>`;

    const parsed = parseHiskiResults(sparseHiskiHtml);
    expect(parsed.total_reported).toBe(4);
    expect(parsed.records[0].parish).toBe('');

    const unknownDetail = parseHiskiEventDetail(
      '<HTML><BODY><H2>Anjala</H2><TABLE BORDER=4><TR></TR></TABLE></BODY></HTML>',
      { parishCode: '0012', bookCode: 'muut', rowId: '5' }
    );
    expect(unknownDetail.book).toBe('muut');
    expect(unknownDetail.fields).toEqual({});

    const noTableDetail = parseHiskiEventDetail('<HTML><BODY><H2>Anjala</H2></BODY></HTML>', {
      parishCode: '0012',
      bookCode: 'kastetut',
      rowId: '9',
    });
    expect(noTableDetail.fields).toEqual({});

    expect(
      parseDigihakemistoSearch(
        '<table><tr class="searchrow"><td><a class="aineisto" href="">X</a></td></tr></table>'
      )
    ).toEqual([]);

    const archDetail = parseDigihakemistoArchive(
      `<html><head><title>Series</title></head><body>
        <span class="tieto">   </span>
        <div class="msg">   </div>
        <table><tr class="searchrow">
          <td>
            <a class="nodigi" href="/aineisto/slug_one">Slug One</a>
            <a href="/aineisto/slug_two">Slug Two</a>
          </td>
        </tr></table>
      </body></html>`,
      'alpha_series'
    );
    expect(archDetail.astia_url).toBe('');
    expect(archDetail.notes).toEqual([]);
    expect(archDetail.access_notes).toEqual([]);
    expect(archDetail.children).toHaveLength(1);
    expect(archDetail.children[0].astia_url).toBe('');

    const postedBodies: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('en+A00')) {
        return new Response(parishBytes, { status: 200 });
      }
      if (url === HISKI_ENDPOINT && init?.method === 'POST') {
        postedBodies.push(String(init.body ?? ''));
        return new Response(Buffer.from(sparseHiskiHtml, 'latin1'), { status: 200 });
      }
      if (url.includes('hiski?en+0012+kastetut+9')) {
        return new Response(Buffer.from('<HTML><BODY><H2>Anjala</H2></BODY></HTML>', 'latin1'), {
          status: 200,
        });
      }
      if (url === DIGIHAKEMISTO_SEARCH_URL) {
        return new Response(
          '<table><tr class="searchrow"><td><a class="aineisto" href="/aineisto/100">Series One</a></td></tr></table>',
          { status: 200 }
        );
      }
      return new Response(
        `<html><head><title>Series One</title></head><body>
          <table><tr class="searchrow"><td><a class="nodigi" href="/aineisto/slug_two">Unscanned Book</a></td></tr></table>
        </body></html>`,
        { status: 200 }
      );
    };
    const env = { KINLOOM_FI_ARCHIVES_CACHE_DIR: tmp };

    // parishes without --query in --json mode
    const pAll = await invokeHandler(runFiArchivesCommand, ['parishes', '--json'], { env, fetchImpl });
    expect(pAll.exitCode).toBe(0);
    expect(JSON.parse(pAll.stdout).query).toBeNull();

    // hiski non-christened with --father-patronymic, --mother-given, --mother-surname, without --given/--father-given/--surname
    const hNonChr = await invokeHandler(
      runFiArchivesCommand,
      [
        'hiski',
        '--parish',
        '0012',
        '--book',
        'married',
        '--father-patronymic',
        'Juhonp',
        '--mother-given',
        'Aino',
        '--mother-surname',
        'Laine',
      ],
      { env, fetchImpl }
    );
    expect(hNonChr.exitCode).toBe(0);
    expect(postedBodies[0]).toContain('ipatronyymi=Juhonp');
    expect(postedBodies[0]).toContain('aetunimi=Aino');
    expect(postedBodies[0]).toContain('asukunimi=Laine');
    expect(hNonChr.stdout).toContain('0012 | Child: ');

    // Repeat for cache-hit text marker
    const hHit = await invokeHandler(
      runFiArchivesCommand,
      [
        'hiski',
        '--parish',
        '0012',
        '--book',
        'married',
        '--father-patronymic',
        'Juhonp',
        '--mother-given',
        'Aino',
        '--mother-surname',
        'Laine',
      ],
      { env, fetchImpl }
    );
    expect(hHit.exitCode).toBe(0);
    expect(hHit.stdout).toContain('[cache]');

    // event without sshy_url or permalink_url
    const ev = await invokeHandler(runFiArchivesCommand, ['event', '0012/kastetut/9'], { env, fetchImpl });
    expect(ev.exitCode).toBe(0);
    expect(ev.stdout).not.toContain('SSHY scan link:');
    expect(ev.stdout).not.toContain('Permalink:');

    // archives search & archive inspect: cache hit + empty comment + [not-digitized] child
    await invokeHandler(runFiArchivesCommand, ['archives', 'Series'], { env, fetchImpl });
    const aHit = await invokeHandler(runFiArchivesCommand, ['archives', 'Series'], { env, fetchImpl });
    expect(aHit.stdout).toContain('[cache]');

    await invokeHandler(runFiArchivesCommand, ['archive', '100'], { env, fetchImpl });
    const iHit = await invokeHandler(runFiArchivesCommand, ['archive', '100'], { env, fetchImpl });
    expect(iHit.stdout).toContain('[cache]');
    expect(iHit.stdout).toContain('[not-digitized]');
  });
});

// ============================================================================
// 5. moArchives (commands, domain)
// ============================================================================

describe('moArchives branch coverage', () => {
  it('covers table/row/detail domain edge cases and CLI download-skip, pre1910 cache-hit, and multi-detail JSON', async () => {
    const tmp = await makeTempDir('kinloom-mo-a-');
    const env = { KINLOOM_MO_ARCHIVES_CACHE_DIR: path.join(tmp, 'cache') };

    expect(parseTables('<table><tr></tr><tr><td><a href="">empty</a></td></tr></table>')).toEqual([
      [[{ text: 'empty', hrefs: [] }]],
    ]);
    expect(findResultsTable('<table><tr><th>Unrelated</th></tr></table>', ['Date of Death'])).toEqual([
      null,
      [],
    ]);
    expect(extractFormToken('<html><body>no token</body></html>')).toBeNull();
    expect(parseDeathName('Alder - Deceased - Spouse')).toEqual({ deceased: 'Alder', name: 'Alder' });
    expect(parseDeathName('Alder Mercer')).toEqual({ name: 'Alder Mercer' });

    const minimalDeathRows = parseDeathRows(
      '<table><tr><th>Name</th><th>Age</th><th>Date of Death</th><th>County</th><th>Cert</th></tr><tr><td>Alder</td><td></td><td></td><td></td><td></td></tr></table>'
    );
    expect(minimalDeathRows[0]).toMatchObject({ name: 'Alder', ssn4: '', image: '' });

    const sparsePreDeath = parsePre1910Rows(
      '<table><tr><th>Name</th><th>Date Of Death</th></tr><tr><td><a href="/detail?other=1">Birch</a></td></tr></table>',
      'death'
    );
    expect(sparsePreDeath[0]).toMatchObject({ name: 'Birch', age: '', detail_id: '' });

    const sparsePreBirth = parsePre1910Rows(
      '<table><tr><th>Name</th><th>Date Of Birth</th></tr><tr><td>Cedar</td></tr></table>',
      'birth'
    );
    expect(sparsePreBirth[0]).toMatchObject({ name: 'Cedar', father: '', mother: '', detail_id: '' });

    expect(
      parseDetailFields(
        '<table><tr><td></td><td>County</td></tr><tr><td>ignored</td><td>Harbor</td></tr></table>'
      )
    ).toEqual({ County: 'Harbor' });

    const deathTableWithImage = `<html><body>
      Showing records 1 to 2 of 2
      <table>
        <tr><th>Name</th><th>Age</th><th>Date of Death</th><th>County</th><th>Cert</th><th>SSN</th><th>Img</th></tr>
        <tr><td>Alder Mercer - Deceased</td><td></td><td></td><td></td><td></td><td></td><td><a href="/certs/alder1.pdf">PDF</a></td></tr>
        <tr><td>Birch Mercer - Deceased</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
      </table>
    </body></html>`;
    const deathTableNoImages = `<html><body>
      Showing records 1 to 1 of 1
      <table>
        <tr><th>Name</th><th>Age</th><th>Date of Death</th><th>County</th><th>Cert</th></tr>
        <tr><td>Cedar Mercer - Deceased</td><td></td><td></td><td></td><td></td></tr>
      </table>
    </body></html>`;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/DeathCertificates/')) {
        return new Response('<input name="__ncforminfo" value="tok1" />', { status: 200 });
      }
      if (url.includes('/BirthDeath')) {
        return new Response(
          `<html><body>Showing records 1 to 1 of 1
            <table><tr><th>Name</th><th>Date Of Death</th></tr><tr><td>Birch</td></tr></table>
            <table><tr><th>Name</th><th>Date Of Birth</th></tr><tr><td>Cedar</td></tr></table>
          </body></html>`,
          { status: 200 }
        );
      }
      if (url.includes('/ArchivesMvc/')) {
        return new Response(deathTableWithImage, { status: 200 });
      }
      if (url.includes('/certs/alder1.pdf')) {
        return new Response(SYNTH_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      if (url.includes('/birthdeath/Detail')) {
        return new Response('<table><tr><td>Name</td></tr><tr><td>Alder</td></tr></table>', { status: 200 });
      }
      if (url.includes('/birthdeath/')) {
        return new Response('<input name="__ncforminfo" value="tok2" />', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    // death --download-dir: first downloads, second skips existing PDF; record with empty optional fields
    const dlDir = path.join(tmp, 'mo-dl');
    const d1 = await invokeHandler(runMoArchivesCommand, ['death', '--last', 'Mercer', '--download', dlDir], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(d1.exitCode).toBe(0);
    expect(d1.stdout).toContain('Downloaded:');
    const d2 = await invokeHandler(runMoArchivesCommand, ['death', '--last', 'Mercer', '--download', dlDir], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(d2.exitCode).toBe(0);
    expect(d2.stdout).toContain('Exists (skip):');

    // death --download with 0 images (dlLines.length === 0)
    const dNoImg = await invokeHandler(
      runMoArchivesCommand,
      ['death', '--last', 'NoImg', '--download', dlDir],
      {
        env,
        cwd: tmp,
        fetchImpl: async (input) =>
          String(input).includes('/DeathCertificates/')
            ? new Response('<input name="__ncforminfo" value="t" />', { status: 200 })
            : new Response(deathTableNoImages, { status: 200 }),
      }
    );
    expect(dNoImg.exitCode).toBe(0);
    expect(dNoImg.stdout).not.toContain('Downloaded:');

    // pre1910 death & birth: empty optional fields + cache hit
    await invokeHandler(runMoArchivesCommand, ['pre1910', '--type', 'death', '--name', 'Birch'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    const preDeathHit = await invokeHandler(
      runMoArchivesCommand,
      ['pre1910', '--type', 'death', '--name', 'Birch'],
      { env, cwd: tmp, fetchImpl }
    );
    expect(preDeathHit.exitCode).toBe(0);
    expect(preDeathHit.stdout).toContain('[cache]');

    const preBirth = await invokeHandler(
      runMoArchivesCommand,
      ['pre1910', '--type', 'birth', '--name', 'Cedar'],
      { env, cwd: tmp, fetchImpl }
    );
    expect(preBirth.exitCode).toBe(0);
    expect(preBirth.stdout).toContain('Cedar');

    // detail: multiple IDs in JSON mode (returns array) + text mode on miss and hit
    const detMultiJson = await invokeHandler(runMoArchivesCommand, ['detail', '101', '102', '--json'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(detMultiJson.exitCode).toBe(0);
    expect(Array.isArray(JSON.parse(detMultiJson.stdout))).toBe(true);

    const detMissText = await invokeHandler(runMoArchivesCommand, ['detail', '103'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(detMissText.exitCode).toBe(0);
    expect(detMissText.stdout).not.toContain('[cache]');

    const detHitText = await invokeHandler(runMoArchivesCommand, ['detail', '103'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(detHitText.exitCode).toBe(0);
    expect(detHitText.stdout).toContain('[cache]');
  });
});

// ============================================================================
// 6. kyArchives (commands, domain)
// ============================================================================

describe('kyArchives branch coverage', () => {
  it('covers domain parsers and CLI commands across cdm, cdm-item, collections, land, and preservica', async () => {
    const tmp = await makeTempDir('kinloom-ky-a-');
    const env = { KINLOOM_KY_ARCHIVES_CACHE_DIR: path.join(tmp, 'cache') };

    // trimCdmSearchData with non-number total, non-array items, non-record item, missing fields
    expect(trimCdmSearchData({ totalResults: 'bad', items: 'bad' })).toEqual({
      totalResults: 0,
      items: [],
      verified: false,
    });
    const trimmed = trimCdmSearchData({
      totalResults: 1,
      items: ['skip', { metadataFields: ['skip', { value: 'no-field' }, { field: 'date', value: 1850 }] }],
    });
    expect(trimmed.items[0]).toEqual({
      collectionAlias: null,
      itemId: null,
      title: null,
      filetype: null,
      itemLink: null,
      fields: { date: 1850 },
    });

    expect(extractAspState('<html><body></body></html>')).toEqual({
      __VIEWSTATE: '',
      __VIEWSTATEGENERATOR: '',
      __EVENTVALIDATION: '',
    });
    expect(parseLandResults('<html><body>No matches</body></html>')).toEqual({
      totalResults: 0,
      results: [],
      verified: false,
    });

    // parsePreservicaRss: numeric title, attributed #text, missing link, duplicate link, empty-after-HTML title, empty channel
    const rss = parsePreservicaRss(
      `<rss><channel>
        <item><title>1845</title><link>https://kdla.access.preservica.com/item/1</link></item>
        <item><title lang="en">Harbor Deed</title><link>https://kdla.access.preservica.com/item/2</link></item>
        <item><title>Duplicate</title><link>https://kdla.access.preservica.com/item/2</link></item>
        <item><title>No Link</title></item>
        <item><title>&lt;b&gt;   &lt;/b&gt;</title><link>https://kdla.access.preservica.com/item/3</link></item>
      </channel></rss>`,
      'Harbor',
      'https://kdla.access.preservica.com/feed',
      10
    );
    expect(rss.results).toHaveLength(2);
    expect(
      parsePreservicaRss(
        '<rss><channel></channel></rss>',
        'Empty',
        'https://kdla.access.preservica.com/feed',
        5
      ).verified
    ).toBe(true);

    const landHtml = `<html><body>1 Results found
      1) Patent #12.0 Grantee: Alder Mercer Grant Book & Pg: A 10 Acreage: 100 County: Harbor WaterCourse: Cedar Cr Survey Name: Alder Survey Date: 1840 Grant Date: 1841 Grant Note: Synthetic
    </body></html>`;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/search/collection/')) {
        return jsonResponse({
          totalResults: 1,
          items: [{ metadataFields: [{ field: 'date', value: 1850 }] }],
        });
      }
      if (url.includes('/singleitem/collection/col1/id/10')) {
        return jsonResponse({
          fields: ['skip', { key: 'Title' }],
        });
      }
      if (url.includes('/singleitem/collection/col1/id/11')) {
        return jsonResponse({ title: 'Title Only Item' });
      }
      if (url.includes('/singleitem/collection/col1/id/12')) {
        return jsonResponse({ contentType: 'image/jpeg' });
      }
      if (url.includes('/digital/api/collections')) {
        return jsonResponse({ cards: ['skip', {}] });
      }
      if (url.includes('web.sos.ky.gov/land/ccorders.aspx')) {
        return new Response(landHtml, { status: 200 });
      }
      return new Response('missing', { status: 404 });
    };

    // cdm: miss + hit, item with non-string date and null fields
    const cdm1 = await invokeHandler(runKyArchivesCommand, ['cdm', 'Alder'], { env, fetchImpl });
    expect(cdm1.exitCode).toBe(0);
    expect(cdm1.stdout).toContain('- [:] ');
    const cdm2 = await invokeHandler(runKyArchivesCommand, ['cdm', 'Alder'], { env, fetchImpl });
    expect(cdm2.stdout).toContain('[cache]');

    // cdm-item: non-record field, key fallback, missing contentType, cache hit, plus title-only and contentType-only cacheable branches
    const ci1 = await invokeHandler(runKyArchivesCommand, ['cdm-item', 'col1', '10'], { env, fetchImpl });
    expect(ci1.exitCode).toBe(0);
    expect(ci1.stdout).toContain('Title: ');
    const ci2 = await invokeHandler(runKyArchivesCommand, ['cdm-item', 'col1', '10'], { env, fetchImpl });
    expect(ci2.stdout).toContain('[cache]');
    expect(
      (await invokeHandler(runKyArchivesCommand, ['cdm-item', 'col1', '11'], { env, fetchImpl })).exitCode
    ).toBe(0);
    expect(
      (await invokeHandler(runKyArchivesCommand, ['cdm-item', 'col1', '12'], { env, fetchImpl })).exitCode
    ).toBe(0);

    // collections: missing totalCollections, non-record card, empty card, cache hit
    const col1 = await invokeHandler(runKyArchivesCommand, ['collections'], { env, fetchImpl });
    expect(col1.exitCode).toBe(0);
    expect(col1.stdout).toContain('2 collections');
    const col2 = await invokeHandler(runKyArchivesCommand, ['collections'], { env, fetchImpl });
    expect(col2.stdout).toContain('[cache]');

    // land: miss + cache hit; land-patent with --book and --page
    await invokeHandler(runKyArchivesCommand, ['land', 'Alder'], { env, fetchImpl });
    const landHit = await invokeHandler(runKyArchivesCommand, ['land', 'Alder'], { env, fetchImpl });
    expect(landHit.stdout).toContain('[cache]');

    const lp = await invokeHandler(
      runKyArchivesCommand,
      ['land-patent', '12.0', '--book', 'A', '--page', '10'],
      { env, fetchImpl }
    );
    expect(lp.exitCode).toBe(0);
  });
});

// ============================================================================
// 7. gnis (domain)
// ============================================================================

describe('gnis branch coverage', () => {
  it('covers BOM stripping, short pipe rows, null compact features, county filtering, and null text formatting', async () => {
    const tmp = await makeTempDir('kinloom-gnis-a-');
    const bomTxt = '\uFEFFfeature_id|feature_name|feature_class|county_name\n101|Alder Creek|Stream\n';
    const zipBytes = zipSync({ 'DomesticNames_Synth.txt': Buffer.from(bomTxt, 'utf8') });
    const extracted = extractGnisTxt(zipBytes);
    expect(extracted.text.startsWith('feature_id|')).toBe(true);

    const filePath = path.join(tmp, 'bom.txt');
    fs.writeFileSync(filePath, bomTxt, 'utf8');
    const rows = loadGnisRows(filePath);
    expect(rows).toHaveLength(1);
    expect(rows[0]['county_name']).toBe('');

    const compactEmpty = compactFeature({});
    expect(compactEmpty).toEqual({
      feature_id: null,
      feature_name: null,
      feature_class: null,
      state: null,
      county: null,
      map_name: null,
      latitude: null,
      longitude: null,
      date_created: null,
      date_edited: null,
    });

    const filtered = matchRows(
      [{}, { feature_name: 'Alder Creek', feature_class: 'Stream', county_name: 'Harbor' }],
      'alder',
      false,
      'Stream',
      'Cedar'
    );
    expect(filtered).toEqual([]);

    const filteredMissingClass = matchRows(
      [{ feature_name: 'Alder Creek' }],
      'alder',
      false,
      'Stream',
      undefined
    );
    expect(filteredMissingClass).toEqual([]);

    const filteredMissingCounty = matchRows(
      [{ feature_name: 'Alder Creek', feature_class: 'Stream' }],
      'alder',
      false,
      undefined,
      'Harbor'
    );
    expect(filteredMissingCounty).toEqual([]);

    const formatted = formatSearchResultsText({
      source: 'synth',
      matches: 1,
      results: [compactEmpty],
    });
    expect(formatted).toContain('-  |  () |  County,  | ,  | map: ');
  });
});

// ============================================================================
// 8. ukArchives (domain, commands)
// ============================================================================

describe('ukArchives branch coverage', () => {
  it('covers Discovery/FreeREG domain fallbacks and CLI cache-hit/sparse-field branches', async () => {
    const tmp = await makeTempDir('kinloom-uk-a-');
    const env = { KINLOOM_UK_ARCHIVES_CACHE_DIR: path.join(tmp, 'cache') };

    expect(collectionDepartment('12345')).toBeNull();
    expect(mapDiscoveryHit({})).toMatchObject({ id: '', title: '', record_url: '' });

    const detailMixed = mapDiscoveryDetail({
      referencePart: 'PROB 11/999',
      title: 42,
      heldBy: [{ name: 'Harbor Archive' }, {}, 'Cedar Record Office', '', 99],
    });
    expect(detailMixed.id).toBeNull();
    expect(detailMixed.citable_reference).toBe('PROB 11/999');
    expect(detailMixed.title).toBeNull();
    expect(detailMixed.held_by).toEqual(['Harbor Archive', 'Cedar Record Office']);
    expect(mapDiscoveryDetail({ heldBy: 'not-array' }).held_by).toEqual([]);

    const freeregRows = parseFreeregResults(`
      <table><tbody>
        <tr id=""><td>skip</td><td>a</td><td>b</td><td>c</td><td>d</td></tr>
        <tr id="row1">
          <td>
            <a href="/transcripts/1">View 1</a>
            <a href="/transcripts/2">View 2</a>
          </td>
          <td>Alder Mercer</td><td>Baptism</td><td>1840</td><td>NTT</td>
        </tr>
        <tr id="row2">
          <td><a href="/other">Details</a></td>
          <td>Birch Mercer</td><td>Burial</td><td>1842</td><td>NTT</td><td>Harbor Parish</td>
        </tr>
      </tbody></table>
    `);
    expect(freeregRows).toHaveLength(2);
    expect(freeregRows[0].transcript_url).toBe('https://www.freereg.org.uk/transcripts/1');
    expect(freeregRows[0].register).toBe('');
    expect(freeregRows[1].transcript_url).toBe('');

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/API/search/v1/records')) {
        if (url.includes('sparse_tna')) {
          return jsonResponse({ records: 'bad', count: 'bad' });
        }
        return jsonResponse({
          count: 1,
          records: [{ id: 'C9001', reference: 'PROB 11/1', title: 'Will of Alder Mercer', places: [] }],
        });
      }
      if (url.includes('/API/records/v1/details/C9002')) {
        return jsonResponse({ referencePart: 'REF 9002' });
      }
      if (url === 'https://www.freereg.org.uk/' && (!init || init.method === 'GET')) {
        return new Response('<input name="authenticity_token" value="tok123" />', { status: 200 });
      }
      if (url.includes('/search_queries') && init?.method === 'POST') {
        return new Response(
          `<table><tbody>
            <tr id="fr1"><td><a href="/other">Info</a></td><td>Alder Mercer</td><td>Baptism</td><td>1841</td><td>NTT</td><td>Harbor</td></tr>
          </tbody></table>`,
          { status: 200 }
        );
      }
      return new Response('missing', { status: 404 });
    };

    const tnaSparse = await invokeHandler(runUkArchivesCommand, ['tna', 'search', 'sparse_tna'], {
      env,
      fetchImpl,
    });
    expect(tnaSparse.exitCode).toBe(0);
    expect(tnaSparse.stdout).toContain('0 hit(s)');

    // TNA search: hit without places + cache hit
    const tna1 = await invokeHandler(runUkArchivesCommand, ['tna', 'search', 'Alder'], { env, fetchImpl });
    expect(tna1.exitCode).toBe(0);
    expect(tna1.stdout).not.toContain('Places:');
    const tna2 = await invokeHandler(runUkArchivesCommand, ['tna', 'search', 'Alder'], { env, fetchImpl });
    expect(tna2.stdout).toContain('[cache]');

    // TNA get: referencePart only (no id/held_by/legal_status) + cache hit
    const get1 = await invokeHandler(runUkArchivesCommand, ['tna', 'get', 'C9002'], { env, fetchImpl });
    expect(get1.exitCode).toBe(0);
    expect(get1.stdout).toContain('Legal status: n/a');
    const get2 = await invokeHandler(runUkArchivesCommand, ['tna', 'get', 'C9002'], { env, fetchImpl });
    expect(get2.stdout).toContain('[cache]');

    // FreeREG: record without transcript_url + cache hit
    const fr1 = await invokeHandler(runUkArchivesCommand, ['freereg', 'search', '--surname', 'Mercer'], {
      env,
      fetchImpl,
    });
    expect(fr1.exitCode).toBe(0);
    const fr2 = await invokeHandler(runUkArchivesCommand, ['freereg', 'search', '--surname', 'Mercer'], {
      env,
      fetchImpl,
    });
    expect(fr2.stdout).toContain('[cache]');

    // url --notts empty fallback
    const uNotts = await invokeHandler(runUkArchivesCommand, ['url', '--notts', ''], { env });
    expect(uNotts.exitCode).toBe(0);
    expect(uNotts.stdout).toContain('search in CalmView for: Lincoln');
  });
});

// ============================================================================
// 9. Secondary Archive Clients (openarchieven, chronam, texasArchives, vaArchives, njArchives, wikitree, caArchives, michiganology)
// ============================================================================

describe('secondary archive clients branch coverage', () => {
  it('covers openarchieven domain, transport, and command edge cases', async () => {
    const tmp = await makeTempDir('kinloom-oa-a-');
    const env = { KINLOOM_OPENARCHIEVEN_CACHE_DIR: path.join(tmp, 'cache') };

    // domain edges
    expect(a2aText(true)).toBe('');
    expect(a2aText({ a: { b: '' } })).toBe('');
    expect(extractScans({})).toEqual([]);
    expect(extractScans({ a2a_Source: { a2a_SourceAvailableScans: { other: 'x' } } })).toEqual([]);
    const sortedScans = extractScans({
      a2a_Source: {
        a2a_SourceAvailableScans: [
          { a2a_Uri: 'https://scans.example.test/no-order.jpg' },
          { a2a_Uri: 'https://scans.example.test/huge.jpg', a2a_Order: '99999999999999999999999' },
          { a2a_Uri: 'https://scans.example.test/ord1a.jpg', a2a_Order: '1' },
          { a2a_Uri: 'https://scans.example.test/ord1b.jpg', a2a_Order: '1' },
        ],
      },
    });
    expect(sortedScans).toHaveLength(4);
    expect(sortedScans[0].uri).toContain('ord1a');
    expect(() => parseRecordRef('bad:', undefined)).toThrow(CliValidationError);

    const formatted = formatA2aRecord('harbor', 'rec1', {
      a2a_Event: ['skip', {}],
      a2a_RelationEP: ['skip', { a2a_PersonKeyRef: 'p1' }],
      a2a_Person: ['skip', { a2a_PersonName: 'Alder Mercer' }],
    });
    expect(formatted).toContain('Alder Mercer');

    // transport edges
    expect(() => searchWindow(10, 0, 0, false)).toThrow(CliValidationError);
    const dirBin = path.join(tmp, 'adir');
    fs.mkdirSync(dirBin);
    expect(readCachedScan(dirBin, path.join(tmp, 'm.json'), 24, () => 1000)).toBeUndefined();

    await expect(
      requestWithRetry(
        makeCtx({
          fetchImpl: async () => {
            throw 'raw-error';
          },
        }),
        'https://api.openarch.nl/1.0/records/search.json?name=Alder',
        {
          validator: (u) => u,
          urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['api.openarch.nl'] },
          accept: 'application/json',
          label: 'OpenArch',
        }
      )
    ).rejects.toThrow('raw-error');

    const pngDownload = await downloadScanCandidates(
      makeCtx({
        fetchImpl: async () =>
          new Response(SYNTH_PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      }),
      path.join(tmp, 'scancache'),
      [['https://scans.example.test/p.png', false]],
      { refresh: false, ttlHours: 24 }
    );
    expect(pngDownload.ext).toBe('png');

    await expect(
      downloadScanCandidates(
        makeCtx({
          fetchImpl: async () =>
            new Response('<html>denied</html>', {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
            }),
        }),
        path.join(tmp, 'scancache'),
        [['https://scans.example.test/html.bin', false]],
        { refresh: true, ttlHours: 24 }
      )
    ).rejects.toThrow('HTML');

    // commands: sparse search response + show with array containing non-record + empty response
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('search.json')) {
        if (url.includes('empty_resp')) {
          return jsonResponse({ response: 'not-record' });
        }
        return jsonResponse({
          response: {
            number_found: 'bad',
            docs: [{}],
          },
        });
      }
      if (url.includes('show.json')) {
        if (url.includes('id_null')) {
          return jsonResponse(null);
        }
        return jsonResponse([{ a2a_Person: [{ a2a_PersonName: 'Alder Mercer' }] }, 'skip']);
      }
      return new Response('missing', { status: 404 });
    };

    const s1 = await invokeHandler(runOpenarchievenCommand, ['search', 'empty_resp'], { env, fetchImpl });
    expect(s1.exitCode).toBe(0);
    expect(s1.stdout).toContain('Found 0 records');

    const s2 = await invokeHandler(runOpenarchievenCommand, ['search', 'Alder'], { env, fetchImpl });
    expect(s2.exitCode).toBe(0);
    expect(s2.stdout).toContain('(unnamed)');

    const shNull = await invokeHandler(runOpenarchievenCommand, ['show', 'harbor:id_null'], {
      env,
      fetchImpl,
    });
    expect(shNull.exitCode).toBe(0);
    expect(shNull.stdout).toContain('No record data returned.');

    const shArr1 = await invokeHandler(runOpenarchievenCommand, ['show', 'harbor:id_arr'], {
      env,
      fetchImpl,
    });
    expect(shArr1.exitCode).toBe(0);
    const shArr2 = await invokeHandler(runOpenarchievenCommand, ['show', 'harbor:id_arr'], {
      env,
      fetchImpl,
    });
    expect(shArr2.stdout).toContain('[cache]');
  });

  it('covers chronam domain, httpFetch, transport, and command edge cases', async () => {
    const tmp = await makeTempDir('kinloom-chronam-a-');
    const env = { KINLOOM_CHRONAM_CACHE_DIR: path.join(tmp, 'cache') };

    expect(firstValue([])).toBeNull();
    expect(formatTextField(null)).toBe('None');
    expect(() => validateLocUrl('https://www.loc.gov:8443/collections/')).toThrow('Refusing');
    expect(detectInvalidDownload(SYNTH_PDF, '', 'pdf')).toBeNull();
    expect(resolveDates(undefined, '1870', undefined)).toBe('1870/1963');
    expect(resolveDates(undefined, undefined, '1890')).toBe('1736/1890');
    expect(buildSearchParams('Alder', { level: 'all', limit: 5, page: 1 }).some(([k]) => k === 'dl')).toBe(
      false
    );
    expect(compactResult({})).toMatchObject({ title: null, date: null, url: null });
    expect(searchCacheable({})).toBe(false);
    expect(iiifJpegFromInfo('https://tile.loc.gov/img/info.json', 800)).toBe(
      'https://tile.loc.gov/img/full/800,/0/default.jpg'
    );
    expect(resolvePageAssets({ page: [{ url: 'https://tile.loc.gov/a.pdf' }] }).pdf).toBeNull();

    const codeErr: Error & { code?: string } = new Error('timeout');
    codeErr.code = 'ETIMEDOUT';
    expect(isTimeoutError(codeErr, false)).toBe(true);
    expect(isTimeoutError('not-error', false)).toBe(false);
    expect(retryDelaySeconds(0, new Response('', { status: 503 }), () => 1000)).toBeGreaterThan(0);

    // streamDownloadToPath: 429 error, missing content-type, content-length identity, default kind
    const dl429Ctx = makeCtx({
      env,
      cwd: tmp,
      fetchImpl: async () => new Response('rate limited', { status: 429 }),
    });
    await expect(
      streamDownloadToPath(dl429Ctx, 'https://tile.loc.gov/test.pdf', path.join(tmp, 'a.pdf'), { timeout: 1 })
    ).rejects.toThrow('rate limited');

    const okDlCtx = makeCtx({
      env,
      cwd: tmp,
      fetchImpl: async () => {
        const resp = new Response(SYNTH_PDF, {
          status: 200,
          headers: { 'content-length': String(SYNTH_PDF.length), 'content-encoding': 'identity' },
        });
        resp.headers.delete('content-type');
        return resp;
      },
    });
    const dlRes = await cachedDownloadFile(okDlCtx, 'https://tile.loc.gov/ok.bin', {
      timeout: 5,
      refresh: false,
      ttlHours: 24,
    });
    expect(dlRes.nbytes).toBe(SYNTH_PDF.length);

    // Commands: search sparse response & cache hit; get page sparse response; download relative --out & sparse item
    const cliFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('collections/chronicling-america')) {
        if (url.includes('sparse_q')) {
          return jsonResponse({});
        }
        return jsonResponse({
          search: { hits: 1 },
          results: [
            {
              title: 'Harbor Weekly',
              date: '1882',
              url: 'https://www.loc.gov/resource/sn001/1882-01-01/ed-1/?sp=1',
            },
          ],
        });
      }
      if (url.includes('fo=json')) {
        return jsonResponse({
          item: { title: 'Harbor Weekly', lccn: 'sn001' },
          resources: [{ pdf: 'https://tile.loc.gov/p1.pdf' }],
        });
      }
      return new Response(SYNTH_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
    };

    const csSparse = await invokeHandler(runChronamCommand, ['search', 'sparse_q', '--json'], {
      env,
      cwd: tmp,
      fetchImpl: cliFetch,
    });
    expect(csSparse.exitCode).toBe(0);
    expect(JSON.parse(csSparse.stdout).hits).toBeNull();

    await invokeHandler(runChronamCommand, ['search', 'Alder'], { env, cwd: tmp, fetchImpl: cliFetch });
    const csHit = await invokeHandler(runChronamCommand, ['search', 'Alder'], {
      env,
      cwd: tmp,
      fetchImpl: cliFetch,
    });
    expect(csHit.stdout).toContain('[cache]');

    const pgRes = await invokeHandler(
      runChronamCommand,
      ['page', 'https://www.loc.gov/resource/sn001/1882-01-01/ed-1/?sp=1'],
      { env, cwd: tmp, fetchImpl: cliFetch }
    );
    expect(pgRes.exitCode).toBe(0);
    expect(pgRes.stdout).toContain('title: Harbor Weekly');
    expect(pgRes.stdout).toContain('lccn: sn001');

    const dlRel = await invokeHandler(
      runChronamCommand,
      [
        'download',
        'https://www.loc.gov/resource/sn001/1882-01-01/ed-1/?sp=1',
        '--pdf',
        '--out',
        'rel-chronam',
      ],
      { env, cwd: tmp, fetchImpl: cliFetch }
    );
    expect(dlRel.exitCode).toBe(0);
    expect(dlRel.stdout).toContain('loc_nodate_sp1.pdf');
  });

  it('covers texasArchives, vaArchives, njArchives, wikitree, caArchives, and michiganology edge branches', async () => {
    const tmp = await makeTempDir('kinloom-sec-a-');

    // --- texasArchives ---
    expect(extractArkId('ark:/67531/')).toBe('67531');
    expect(mapOpenSearchEntry(null)).toMatchObject({ ark: '', title: '' });
    expect(
      entryMatchesFilters(
        {
          ark: 'a',
          title: 't',
          creator: '',
          date: '1880',
          description: '',
          type: '',
          url: '',
          thumbnail: '',
        },
        undefined,
        'Book',
        undefined,
        undefined
      )
    ).toBe(false);
    expect(() => parseOaiRecord('<OAI-PMH><error>plain error without code</error></OAI-PMH>')).toThrow(
      'OAI error error: plain error without code'
    );
    const oaiMinimal = parseOaiRecord(
      '<OAI-PMH><GetRecord><record><header><identifier>oai:custom:1</identifier><setSpec> </setSpec></header><metadata><dc><dc:title attr="1">Harbor Deed</dc:title><dc:date>1880</dc:date></dc></metadata></record></GetRecord></OAI-PMH>'
    );
    expect(oaiMinimal.ark).toBe('');
    expect(oaiMinimal.url).toBe('');
    expect(oaiMinimal.titles).toEqual(['Harbor Deed']);

    const tdaBare = parseTdaRss(
      `<channel>
        <item><title>1880</title><link>https://tsl.access.preservica.com/1</link></item>
        <item><title>1880</title><link>https://tsl.access.preservica.com/1</link></item>
        <item><title>&lt;b&gt; &lt;/b&gt;</title><link>https://tsl.access.preservica.com/2</link></item>
        <item><title>No Link</title></item>
      </channel>`
    );
    expect(tdaBare).toEqual([{ title: '1880', url: 'https://tsl.access.preservica.com/1' }]);

    const txEnv = { KINLOOM_TEXAS_ARCHIVES_CACHE_DIR: path.join(tmp, 'tx-cache') };
    const txFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/search/opensearch/')) {
        return jsonResponse({
          feed: {
            'opensearch:totalResults': '1',
            entry: [{ id: 'ark:/67531/metapth1', link: 'https://texashistory.unt.edu/ark:/67531/metapth1/' }],
          },
        });
      }
      return new Response(
        '<OAI-PMH><GetRecord><record><header><identifier>oai:unt:metapth1</identifier></header><metadata><dc></dc></metadata></record></GetRecord></OAI-PMH>',
        { status: 200 }
      );
    };
    const txSearch1 = await invokeHandler(
      runTexasArchivesCommand,
      ['portal', 'search', 'Alder', '--pages', '1'],
      {
        env: txEnv,
        fetchImpl: txFetch,
      }
    );
    expect(txSearch1.stdout).toContain('(no title)');
    const txSearch2 = await invokeHandler(
      runTexasArchivesCommand,
      ['portal', 'search', 'Alder', '--pages', '1'],
      {
        env: txEnv,
        fetchImpl: txFetch,
      }
    );
    expect(txSearch2.stdout).toContain('[cache]');

    const txItem1 = await invokeHandler(runTexasArchivesCommand, ['portal', 'item', 'metapth1'], {
      env: txEnv,
      fetchImpl: txFetch,
    });
    expect(txItem1.stdout).toContain('(no title)');
    const txItem2 = await invokeHandler(runTexasArchivesCommand, ['portal', 'item', 'metapth1'], {
      env: txEnv,
      fetchImpl: txFetch,
    });
    expect(txItem2.stdout).toContain('[cache]');

    for (const flag of ['--tda', '--glo', '--rangers', '--tslac']) {
      const u = await invokeHandler(runTexasArchivesCommand, ['url', flag], { env: txEnv });
      expect(u.exitCode).toBe(0);
    }

    // --- vaArchives ---
    expect(
      parseRosettaViewer(`<item id='FL1' title='A'/><item id='FL1' title='Dup'/>JSONObject='{"k":"no-fl"}'`)
        .files
    ).toEqual([{ fl: 'FL1', title: 'A' }]);
    expect(parseSearchPage('<html>empty</html>')).toEqual({ total: 0, first: 0, last: 0, records: [] });
    expect(parseCasePage('<html>empty</html>')).toMatchObject({ locality: '', plaintiffs: [], format: '' });
    expect(parseImagesPage('myImages[0]="https://old.lva.virginia.gov/a.pdf"')).toMatchObject({
      total_pages: 1,
      page_pdfs: ['https://old.lva.virginia.gov/a.pdf'],
    });

    const vaEnv = { [VA_CACHE_ENV]: path.join(tmp, 'va-cache') };
    const vaEmptyCase = await invokeHandler(runVaArchivesCommand, ['chancery', 'case', '099-1850-001'], {
      env: vaEnv,
      cwd: tmp,
      fetchImpl: async () => new Response('<html>empty</html>', { status: 200 }),
    });
    expect(vaEmptyCase.exitCode).toBe(0);
    expect(vaEmptyCase.stdout).toContain('Plaintiff(s): n/a');

    const vaCatalogEmpty = await invokeHandler(runVaArchivesCommand, ['catalog', 'Alder'], {
      env: vaEnv,
      cwd: tmp,
      fetchImpl: async () => jsonResponse({ docs: [{}] }),
    });
    expect(vaCatalogEmpty.exitCode).toBe(0);
    expect(vaCatalogEmpty.stdout).toContain('(no title)');

    const vaGrantNoOut = await invokeHandler(
      runVaArchivesCommand,
      ['grant-tif', '/LONN/LO-1/001/00001.tif'],
      {
        env: vaEnv,
        cwd: tmp,
        fetchImpl: async () => new Response(Buffer.from('tif-bytes', 'utf8'), { status: 200 }),
      }
    );
    expect(vaGrantNoOut.exitCode).toBe(0);
    expect(vaGrantNoOut.stdout).toContain('pass --out FILE to save it');

    const vaDunmoreNoCurrent = await invokeHandler(runVaArchivesCommand, ['dunmore', '0001/W0001', '1'], {
      env: vaEnv,
      cwd: tmp,
      fetchImpl: async () =>
        new Response('<a href="/Microfilm/DW/001/00001.tif">Page 1</a>', { status: 200 }),
    });
    expect(vaDunmoreNoCurrent.exitCode).toBe(0);
    expect(vaDunmoreNoCurrent.stdout).toContain('page unknown');

    // --- njArchives ---
    const njOut: string[] = [];
    const njCtx = makeCtx({ stdout: njOut });
    const rows500 = Array.from({ length: 500 }, (_v, i) => ({
      Name: i === 0 ? [{ text: 'CellLink', href: 'https://example.test/c' }] : `Alder ${i}`,
      links: [{ text: 'View', href: 'https://example.test/info.html' }],
    }));
    emitNjResult(
      njCtx,
      {
        database: 'wills',
        headers: ['Name'],
        rows: rows500,
        capped_500: true,
        pages_read: 2,
      },
      true,
      false,
      2
    );
    expect(njOut.join('\n')).toContain('capped at 500 records');
    expect(njOut.join('\n')).toContain('[cache]');

    const njMissingSurname = await invokeHandler(runNjArchivesCommand, ['search', 'marriages-1848-1900'], {
      cwd: tmp,
    });
    expect(njMissingSurname.exitCode).toBe(2);
    expect(njMissingSurname.stderr).toContain('--spouse-surname');

    const njOrderUrl = await invokeHandler(runNjArchivesCommand, ['url', 'births-1848-1925'], { cwd: tmp });
    expect(njOrderUrl.exitCode).toBe(0);
    expect(njOrderUrl.stdout).toContain('records-request form');

    // --- wikitree ---
    expect(checkStatus([{}], 'test')).toEqual({});
    expect(formatPersonLine({})).toBe('?:   (b. ?)');
    expect(formatWikiSearchText({}, false)).toBe('0 match(es), showing 0:');
    expect(formatWikiSearchText({ matches: [{}] }, false)).toContain('Id ?: sparse match');
    expect(
      formatAncestorsText(
        {
          people: {
            '1': { Name: 'Mercer-2', BirthDate: '1800-01-01' },
            '2': { Name: 'Alder-1', BirthDate: '1800-01-01' },
          },
        },
        'Root-1',
        2,
        false
      )
    ).toContain('Alder-1');
    expect(formatBioText({}, true)).toBe('(no biography text returned) [cache]');

    // --- caArchives ---
    expect(extractOmekaTitle({ 'dcterms:title': [{ '@value': '' }] })).toBe('(untitled)');
    expect(
      parseExhibitsSearchPayload('[{}]', 'https://exhibits.sos.ca.gov/api/items', null).results[0].id
    ).toBe('');
    expect(
      parseExhibitsItemPayload(
        JSON.stringify({ 'dcterms:description': [{ '@value': '' }] }),
        '1',
        'https://exhibits.sos.ca.gov/api/items/1'
      ).description
    ).toBe('');
    expect(dedupeOacLinks([{}], 'https://oac.cdlib.org', 5)).toEqual([]);
    expect(dedupeCalisphereLinks([{}], 'https://calisphere.org', 5)).toEqual([]);

    const mockBrowser: OptionalBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          content: async () => '',
          waitForFunction: async () => {
            throw new Error('Execution context was destroyed');
          },
          evaluate: async <T>(expr: string): Promise<T> =>
            (expr.includes('innerText') ? 123 : 'not-array') as T,
          close: async () => {},
        }),
        close: async () => {},
      }),
      close: async () => {},
    };
    const bSearch = await browserSearch(
      makeCtx({}),
      ['oac', 'calisphere'],
      'Alder',
      5,
      5_000,
      async () => mockBrowser
    );
    expect(bSearch.oac?.total).toBeNull();
    expect(bSearch.calisphere?.total).toBeNull();

    // --- michiganology ---
    expect(() => validateMichiganologyUrl('https://michiganology.org:8443/item/1')).toThrow('Refusing');
    expect(
      parseMichSearchHtml('<div class="result-item"><a href="/item/1">   </a></div>', 'Alder').results[0]
        .title
    ).toBe('(no title)');
    expect(
      parseMichItemHtml(
        '<span class="metadata-content">orphan</span><a href="/download/file/IO_1">1</a><a href="/download/file/IO_2">2</a>',
        'SO_1',
        'https://michigan.access.preservica.com/uncategorized/SO_1/'
      )
    ).toMatchObject({ title: 'SO_1', download_url: '/download/file/IO_1', parsed: false });
  });
});

// ============================================================================
// 10. Deep behavioral branch coverage pass (transport, retries, formatters, fallbacks)
// ============================================================================

describe('deep archive client branch coverage pass', () => {
  it('covers archiveOrg pageCommands, grepCommand, itemCache defaults, and transport edges', async () => {
    const tmp = await makeTempDir('kinloom-ia-deep-');
    const cacheDir = path.join(tmp, 'cache');
    const env = { KINLOOM_IA_CACHE_DIR: cacheDir };

    const scandataXml = `<?xml version="1.0"?>
      <book><pageData>
        <page leafNum="0"><pageType>Cover</pageType><addToAccessFormats>true</addToAccessFormats></page>
        <page leafNum="1"><pageType>Normal</pageType><pageNumber>1</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
      </pageData></book>`;
    const djvuText = 'Cover OCR Alder\x0cPage One Mercer';

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/metadata/birch_vol')) {
        return jsonResponse({
          metadata: { identifier: 'birch_vol', title: 'Birch Volume' },
          files: [
            { name: 'birch_vol_scandata.xml', format: 'Scandata' },
            { name: 'birch_vol_djvu.txt', format: 'DjVuTXT' },
          ],
        });
      }
      if (url.includes('/download/fail_djvu/')) {
        return new Response('server error', { status: 500 });
      }
      if (url.endsWith('_scandata.xml')) {
        return new Response(scandataXml, { status: 200 });
      }
      if (url.endsWith('_djvu.txt')) {
        return new Response(djvuText, { status: 200 });
      }
      if (url.includes('/page/') || url.includes('/BookReader/')) {
        return new Response(SYNTH_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url.includes('/metadata/fail_djvu')) {
        return jsonResponse({
          metadata: { identifier: 'fail_djvu' },
          files: [{ name: 'fail_djvu_djvu.txt', format: 'DjVuTXT' }],
        });
      }
      return new Response('missing', { status: 404 });
    };

    // runPage text output with --printed-page (row.printed_page !== null)
    const p1 = await invokeHandler(
      runArchiveOrgCommand,
      ['page', 'birch_vol', '--printed-page', '1', '--out', path.join(tmp, 'p1.jpg')],
      { env, cwd: tmp, fetchImpl }
    );
    expect(p1.exitCode).toBe(0);
    expect(p1.stdout).toContain('[p.1 -> n1]');

    // runPage --out equal to page cache path (skips extra atomicWriteFileSync)
    const exactCachePage = path.join(cacheDir, 'birch_vol', 'pages', 'n1_w2400.jpg');
    const pSame = await invokeHandler(
      runArchiveOrgCommand,
      ['page', 'birch_vol', '--printed-page', '1', '--out', exactCachePage],
      { env, cwd: tmp, fetchImpl }
    );
    expect(pSame.exitCode).toBe(0);

    // runText on cover leaf (printed_page === null) + valid printed page
    const tCover = await invokeHandler(runArchiveOrgCommand, ['text', 'birch_vol', '--leaf', '0'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(tCover.exitCode).toBe(0);
    expect(tCover.stdout).toContain('n0 (p.?');

    // runText with corrupted page_index.json -> emptyPageIndex fallback + out-of-range segment
    fs.writeFileSync(path.join(cacheDir, 'birch_vol', 'page_index.json'), '{"bad":1}', 'utf8');
    const tEmpty = await invokeHandler(runArchiveOrgCommand, ['text', 'birch_vol', '--leaf', '0'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(tEmpty.exitCode).toBe(0);
    expect(tEmpty.stdout).toContain('n0 (p.?)');

    const tOob = await invokeHandler(runArchiveOrgCommand, ['text', 'birch_vol', '--leaf', '99'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(tOob.exitCode).toBe(1);
    expect(tOob.stderr).toContain('No OCR text segment found');

    // Re-refresh valid page_index and run grep -i (ignoreCase=true) with printed_page & leaf in text mode
    const gValid = await invokeHandler(
      runArchiveOrgCommand,
      ['grep', 'birch_vol', '-e', 'mercer', '-i', '--refresh'],
      { env, cwd: tmp, fetchImpl }
    );
    expect(gValid.exitCode).toBe(0);
    expect(gValid.stdout).toContain('birch_vol | n1 (p.1)');

    // grep with two non-ID tokens (hits else-if false branch)
    const gBadPos = await invokeHandler(runArchiveOrgCommand, ['grep', 'foo|bar', 'baz|qux'], {
      env,
      cwd: tmp,
      fetchImpl,
    });
    expect(gBadPos.exitCode).toBe(2);

    // itemCache defaults (omitted cacheRoot, timeout, refresh) & fetchUrlsMap error capture
    const ctx = makeCtx({ env, cwd: tmp, fetchImpl });
    await expect(ensureItemCache('fail_djvu', ctx, { needDjvu: true })).rejects.toThrow('djvu:');

    const [dlBytes] = await ensureDownloadedFile(
      'birch_vol',
      'birch_vol_djvu.txt',
      [{ name: 'birch_vol_djvu.txt', format: 'DjVuTXT' }],
      { name: 'birch_vol_djvu.txt', format: 'DjVuTXT' },
      ctx
    );
    expect(dlBytes.toString('utf8')).toContain('Mercer');

    const [pgBytes] = await ensurePageImageCache(
      'birch_vol',
      0,
      'w100',
      'https://archive.org/BookReader/BookReaderImages.php?leaf=0',
      ctx
    );
    expect(pgBytes.length).toBeGreaterThan(0);

    // transport: error with undefined code property & cachedQueryJson with custom kind
    await expect(
      httpGetBytesIa(
        'https://archive.org/download/birch_vol/x',
        makeCtx({
          fetchImpl: async () => {
            const err: Error & { code?: unknown } = new Error('plain fail');
            err.code = undefined;
            throw err;
          },
        })
      )
    ).rejects.toThrow('plain fail');

    const [otherKindData] = await cachedQueryJson(
      'custom',
      { q: 'birch' },
      'https://archive.org/advancedsearch.php?q=birch',
      makeCtx({ env, fetchImpl: async () => jsonResponse({ ok: true }) })
    );
    expect(otherKindData['ok']).toBe(true);
  });

  it('covers fiArchives empty-date records, chronam httpFetch/transport retries, and openarchieven scans/cache', async () => {
    const tmp = await makeTempDir('kinloom-deep2-');

    // fiArchives: empty date fields across all 4 book types + 0 total reported
    const fiEnv = { KINLOOM_FI_ARCHIVES_CACHE_DIR: path.join(tmp, 'fi') };
    const zeroDateHtml = `<HTML><BODY>
      <TABLE BORDER=1>
        <TR><TD><a href="/hiski?en+0012+kastetut+11"></a></TD><TD></TD></TR>
        <TR><TD><a href="/hiski?en+0012+vihityt+12"></a></TD><TD></TD></TR>
        <TR><TD><a href="/hiski?en+0012+haudatut+13"></a></TD><TD></TD></TR>
        <TR><TD><a href="/hiski?en+0012+smuutt+14"></a></TD><TD></TD></TR>
      </TABLE>
      <P>0 events found.</P>
    </BODY></HTML>`;
    const fiRes = await invokeHandler(
      runFiArchivesCommand,
      ['hiski', '--parish', '0012', '--surname', 'Alder'],
      {
        env: fiEnv,
        fetchImpl: async () => new Response(Buffer.from(zeroDateHtml, 'latin1'), { status: 200 }),
      }
    );
    expect(fiRes.exitCode).toBe(0);
    expect(fiRes.stdout).toContain('4 found, showing 4:');

    // chronam httpFetch & transport deep branches
    const chronEnv = { KINLOOM_CHRONAM_CACHE_DIR: path.join(tmp, 'chron') };
    // 1. response.url populated + duplicate query params sorting (<, >, ===)
    const respWithUrl = jsonResponse({ ok: 1 });
    Object.defineProperty(respWithUrl, 'url', {
      value: 'https://www.loc.gov/collections/chronicling-america/',
    });
    const cg = await cachedGetJson(
      makeCtx({ env: chronEnv, fetchImpl: async () => respWithUrl }),
      'https://www.loc.gov/collections/chronicling-america/',
      [
        ['fa', 'z'],
        ['fa', 'a'],
        ['fa', 'a'],
      ],
      { timeout: 10, refresh: true, ttlHours: 24 }
    );
    expect(cg.data['ok']).toBe(1);

    // 2. ConnectTimeoutError retrying and succeeding
    let ctCalls = 0;
    const ctRes = await getJson(
      makeCtx({
        env: chronEnv,
        fetchImpl: async () => {
          ctCalls += 1;
          if (ctCalls === 1) {
            const err = new Error('connect timeout');
            err.name = 'ConnectTimeoutError';
            throw err;
          }
          return jsonResponse({ recovered: true });
        },
      }),
      'https://www.loc.gov/collections/chronicling-america/',
      { timeout: 30 }
    );
    expect(ctRes['recovered']).toBe(true);

    // 3. HTTP 429 failing without budget -> rate limited; non-Error thrown; non-JSON & non-record with no content-type
    await expect(
      getJson(
        makeCtx({ env: chronEnv, fetchImpl: async () => new Response('slow down', { status: 429 }) }),
        'https://www.loc.gov/collections/chronicling-america/',
        { timeout: 1 }
      )
    ).rejects.toThrow('rate limited');

    await expect(
      getJson(
        makeCtx({
          env: chronEnv,
          fetchImpl: async () => {
            throw 'raw-net-fail';
          },
        }),
        'https://www.loc.gov/collections/chronicling-america/',
        { timeout: 1 }
      )
    ).rejects.toThrow('raw-net-fail');

    await expect(
      getJson(
        makeCtx({
          env: chronEnv,
          fetchImpl: async () => {
            const r = new Response('not-json', { status: 200 });
            r.headers.delete('content-type');
            return r;
          },
        }),
        'https://www.loc.gov/collections/chronicling-america/',
        { timeout: 5 }
      )
    ).rejects.toThrow('content-type=unknown');

    await expect(
      getJson(
        makeCtx({
          env: chronEnv,
          fetchImpl: async () => {
            const r = new Response('[1,2]', { status: 200 });
            r.headers.delete('content-type');
            return r;
          },
        }),
        'https://www.loc.gov/collections/chronicling-america/',
        { timeout: 5 }
      )
    ).rejects.toThrow('content-type=unknown');

    // 4. Clock advancing past deadline inside getJson -> remainingSec <= 0.25 break
    let tick = 0;
    await expect(
      getJson(
        makeCtx({
          env: chronEnv,
          nowMs: () => {
            tick += 1;
            return tick === 1 ? 1000 : 100_000;
          },
          fetchImpl: async () => jsonResponse({}),
        }),
        'https://www.loc.gov/collections/chronicling-america/',
        { timeout: 1 }
      )
    ).rejects.toThrow('failed after');

    // 5. streamDownloadToPath: content-length: 0, null body response, non-Error throw
    const nullBodyResp = new Response(null, { status: 200, headers: { 'content-length': '0' } });
    await expect(
      streamDownloadToPath(
        makeCtx({ env: chronEnv, fetchImpl: async () => nullBodyResp }),
        'https://tile.loc.gov/empty.bin',
        path.join(tmp, 'empty.bin'),
        { timeout: 2 }
      )
    ).rejects.toThrow('Download was empty');

    await expect(
      streamDownloadToPath(
        makeCtx({
          env: chronEnv,
          fetchImpl: async () => {
            throw 'stream-non-err';
          },
        }),
        'https://tile.loc.gov/fail.bin',
        path.join(tmp, 'fail.bin'),
        { timeout: 1 }
      )
    ).rejects.toThrow('stream-non-err');

    // 6. cachedDownloadFile with corrupt metadata & directory binPath
    const dlUrl = 'https://tile.loc.gov/cache-edge.bin';
    const dl1 = await cachedDownloadFile(
      makeCtx({ env: chronEnv, fetchImpl: async () => new Response(SYNTH_PDF, { status: 200 }) }),
      dlUrl,
      { timeout: 5, refresh: false, ttlHours: 24 }
    );
    const metaPath = dl1.cachePath.replace(/\.bin$/, '.json');
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ schema: 1, fetched_at: 1_700_000_000, nbytes: SYNTH_PDF.length, content_type: 99 }),
      'utf8'
    );
    const dlHitNonStrCt = await cachedDownloadFile(makeCtx({ env: chronEnv }), dlUrl, {
      timeout: 5,
      refresh: false,
      ttlHours: 24,
    });
    expect(dlHitNonStrCt.cacheHit).toBe(true);
    expect(dlHitNonStrCt.contentType).toBe('');

    fs.writeFileSync(metaPath, JSON.stringify({ schema: 1, fetched_at: 'bad', nbytes: 10 }), 'utf8');
    const dlBadMeta = await cachedDownloadFile(
      makeCtx({ env: chronEnv, fetchImpl: async () => new Response(SYNTH_PDF, { status: 200 }) }),
      dlUrl,
      { timeout: 5, refresh: false, ttlHours: 24 }
    );
    expect(dlBadMeta.cacheHit).toBe(false);

    // openarchieven: zero-hit search cacheable + ScanImage & buildDirectScanCandidates edge branches
    const oaCache = path.join(tmp, 'oa');
    const oaZero = await loadOpenArchSearch(
      makeCtx({
        fetchImpl: async () => jsonResponse({ response: { number_found: 0, docs: [] } }),
      }),
      oaCache,
      { name: 'AlderZero' },
      { refresh: false, ttlHours: 24 }
    );
    expect(oaZero.cacheHit).toBe(false);
    const oaZeroHit = await loadOpenArchSearch(
      makeCtx({}),
      oaCache,
      { name: 'AlderZero' },
      { refresh: false, ttlHours: 24 }
    );
    expect(oaZeroHit.cacheHit).toBe(true);

    const previewOnly = new ScanImage(1, 1, 'Front', '', 'https://scans.example.test/thumb.jpg');
    expect(previewOnly.chosenUrl(false)).toBe('https://scans.example.test/thumb.jpg');
    const uriOnly = new ScanImage(2, 2, 'Back', 'https://scans.example.test/full.jpg', '');
    expect(uriOnly.chosenUrl(true)).toBe('https://scans.example.test/full.jpg');
    const proxyCands = buildDirectScanCandidates('https://proxy.archieven.nl/download/12345/abc', false);
    expect(proxyCands.length).toBeGreaterThan(0);
  });

  it('covers texasArchives, njArchives, vaArchives, gnis, michiganology, mnArchives, ukArchives, and persi deep branches', async () => {
    const tmp = await makeTempDir('kinloom-deep3-');

    // texasArchives transport: missing feed, non-integer total, single-object entry
    const txEmpty = await fetchOpenSearchPage(
      makeCtx({ fetchImpl: async () => jsonResponse({}) }),
      'Alder',
      1
    );
    expect(txEmpty.total).toBe(0);
    expect(txEmpty.entries).toEqual([]);

    const txSingle = await fetchOpenSearchPage(
      makeCtx({
        fetchImpl: async () =>
          jsonResponse({
            feed: {
              'opensearch:totalResults': 'not-a-number',
              entry: { id: 'ark:/67531/metapth9', title: 'Single Harbor Entry' },
            },
          }),
      }),
      'Alder',
      1
    );
    expect(txSingle.total).toBe(0);
    expect(txSingle.entries).toHaveLength(1);

    // njArchives parsers & commands
    expect(() => resolveDatabase('zzzzzzzzz')).toThrow("unknown database 'zzzzzzzzz'");
    expect(formAction('<html><body>no form</body></html>')).toBeNull();
    expect(
      selectOptions('<select name="ctl00$ContentPlaceHolder1$ddlC"><option>Bare</option></select>', 'ddlC')
    ).toEqual(['Bare']);
    const [, gridRows] = parseGrid(
      `<table id="ctl00_ContentPlaceHolder1_GridView1">
        <tr><th>Name</th></tr>
        <tr><td><a href="">Empty</a><a href="http://oprs.co.monmouth.nj.us/doc.pdf" onclick="window.open('http://oprs.co.monmouth.nj.us/doc.pdf')">PDF</a></td></tr>
      </table>`,
      'GridView1'
    );
    expect(gridRows).toHaveLength(1);

    const njDbRes = await invokeHandler(runNjArchivesCommand, ['databases'], {
      cwd: tmp,
      fetchImpl: async () =>
        new Response(
          `<table id="ctl00_ContentPlaceHolder1_GridView3">
            <tr><td><a href="javascript:__doPostBack('ctl00$ContentPlaceHolder1$GridView3$ctl02$lbtnColonialMarriages','')">Early Land</a></td></tr>
            <tr><th><a href="javascript:__doPostBack('unknown_target','')">HeaderOnly</a></th></tr>
          </table>`,
          { status: 200 }
        ),
    });
    expect(njDbRes.exitCode).toBe(0);
    expect(njDbRes.stdout).toContain('Early Land');

    const njNg = await invokeHandler(
      runNjArchivesCommand,
      [
        'search',
        'natguard-photos',
        '--keyword',
        'Harbor',
        '--surname',
        'Alder',
        '--from-year',
        '1910',
        '--to-year',
        '1920',
      ],
      {
        cwd: tmp,
        env: { KINLOOM_NJ_ARCHIVES_CACHE_DIR: path.join(tmp, 'nj') },
        fetchImpl: async () =>
          new Response(
            '<form action="NG.aspx"><input name="__VIEWSTATE" value="v"/></form><table id="ctl00_ContentPlaceHolder1_GridView1"><tr><th>Name</th></tr><tr><td>Alder</td></tr></table>',
            { status: 200 }
          ),
      }
    );
    expect(njNg.exitCode).toBe(0);

    // vaArchives collectionCommands, chanceryCommands, domain, transport
    const vaEnv = { [VA_CACHE_ENV]: path.join(tmp, 'va') };
    const vaCatArr = await invokeHandler(runVaArchivesCommand, ['catalog', 'Alder', '--json'], {
      env: vaEnv,
      cwd: tmp,
      fetchImpl: async () => jsonResponse([1, 2]),
    });
    expect(vaCatArr.exitCode).toBe(0);
    expect(JSON.parse(vaCatArr.stdout)).toMatchObject({ total: null, first: null, last: null, records: [] });

    const vaDunNoPage = await invokeHandler(runVaArchivesCommand, ['dunmore', '0001/W0001', '1'], {
      env: vaEnv,
      cwd: tmp,
      fetchImpl: async () => new Response('<a href="/Microfilm/DW/001/00001.tif">Image</a>', { status: 200 }),
    });
    expect(vaDunNoPage.exitCode).toBe(0);
    expect(vaDunNoPage.stdout).toContain('page ?');

    const vaChDl = await invokeHandler(runVaArchivesCommand, ['chancery', 'download', '099-1850-002'], {
      env: vaEnv,
      cwd: tmp,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('case_detail.asp')) {
          return new Response('<html>empty</html>', { status: 200 });
        }
        if (url.includes('case_images.asp')) {
          return new Response('myImages[0]="/ChanceryImg/..."', { status: 200 });
        }
        return new Response(SYNTH_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
      },
    });
    expect(vaChDl.exitCode).toBe(0);
    expect(vaChDl.stdout).toContain('0001.pdf');

    expect(extForContentType('application/x-custom')).toBe('.bin');
    expect(parsePageSpec('99', 3)).toEqual([]);
    expect(
      formatChanceryRecordText({
        index_number: '1850-001',
        cfn: '099-1850-001',
        locality: 'HARBOR',
        plaintiffs: [],
        defendants: [],
        case_url: 'https://old.lva.virginia.gov/chancery/case_detail.asp?CFN=099-1850-001',
      })
    ).not.toContain('P:');

    const vaState = makeState(
      makeCtx({
        env: vaEnv,
        cwd: tmp,
        fetchImpl: async () => new Response('hello', { status: 200 }),
      }),
      false,
      false,
      24
    );
    const fetchedTxt = await fetchText(vaState, 'https://old.lva.virginia.gov/no-allowlist');
    expect(fetchedTxt).toBe('hello');
    const fetchedBin = await fetchFile(vaState, 'https://old.lva.virginia.gov/noext', [
      'old.lva.virginia.gov',
    ]);
    expect(fetchedBin.endsWith('.bin')).toBe(true);

    const metaTarget = path.join(tmp, 'va-meta-test.bin');
    fs.writeFileSync(metaTarget, 'abc', 'utf8');
    fs.writeFileSync(`${metaTarget}.meta.json`, JSON.stringify({ cached_at: 1_700_000_000 }), 'utf8');
    expect(isCacheMetaValid(metaTarget, 24, () => 1_700_000_000_000)).toEqual({
      url: '',
      content_type: '',
      cached_at: 1_700_000_000,
      size: 0,
    });

    // gnis transport: invalid cached schema, unknown state code, cached historical file
    const gnisCache = path.join(tmp, 'gnis');
    const qParams = {
      name: 'Alder',
      state: 'VA',
      exact: false,
      feature_class: null,
      county: null,
      historical: false,
      limit: 10,
    };
    const { filePath: gnisQPath } = queryCachePath(qParams, gnisCache);
    fs.mkdirSync(path.dirname(gnisQPath), { recursive: true });
    fs.writeFileSync(gnisQPath, JSON.stringify({ cached_at: 1_700_000_000, data: { source: 123 } }), 'utf8');
    expect(readCachedSearch(qParams, gnisCache, 24, () => 1_700_000_000_000)).toBeUndefined();

    const gnisCtx = makeCtx({ env: { KINLOOM_GNIS_CACHE_DIR: gnisCache } });
    await expect(ensureStateFile(gnisCtx, 'ZZ', false)).rejects.toThrow('Unknown state/territory code');
    fs.writeFileSync(
      path.join(gnisCache, 'HistoricalFeatures.txt'),
      'feature_id|feature_name\n1|Alder\n',
      'utf8'
    );
    expect(await ensureHistoricalFile(gnisCtx, false)).toContain('HistoricalFeatures.txt');

    // michiganology transport: invalid ID, directory bodyPath, missing content-type fallback
    const michCache = path.join(tmp, 'mich');
    const michCtx = makeCtx({
      env: { KINLOOM_MICHIGANOLOGY_CACHE_DIR: michCache },
      execFileImpl: async (_cmd, args) => {
        const dIdx = args.indexOf('-D');
        if (dIdx !== -1 && dIdx + 1 < args.length) {
          fs.writeFileSync(args[dIdx + 1], 'HTTP/1.1 200 OK\r\n\r\n', 'utf8');
        }
        return {
          stdout: Buffer.concat([
            SYNTH_JPEG,
            Buffer.from(
              `\n${CURL_META_MARKER}\n200\nhttps://michigan.access.preservica.com/download/file/IO_999`,
              'utf8'
            ),
          ]),
          stderr: Buffer.alloc(0),
        };
      },
    });
    await expect(michCachedDownload(michCtx, 'BAD_ID', false, 24, 30)).rejects.toThrow(
      'Invalid Michiganology'
    );
    const dirBody = path.join(michCache, 'files', 'IO_999', 'body');
    fs.mkdirSync(dirBody, { recursive: true });
    // After removing the directory, test missing content-type -> application/octet-stream
    await rm(dirBody, { recursive: true, force: true });
    const michDl = await michCachedDownload(michCtx, 'IO_999', false, 24, 30);
    expect(michDl.data.content_type).toBe('application/octet-stream');

    // mnArchives domain: default homedir fallback, Hennepin county filter, 'County'-only stripped to empty
    expect(getMnCacheDir(makeCtx({ env: {} }))).toContain('mn-archives');
    expect(buildPeopleQuery('death-records', { last: 'Alder', county: 'Hennepin' }).filters).toHaveLength(2);
    expect(buildPeopleQuery('death-records', { last: 'Alder', county: 'County' }).filters).toHaveLength(2);

    // ukArchives domain: string title true branch
    expect(mapDiscoveryDetail({ title: 'Alder Estate Inventory' }).title).toBe('Alder Estate Inventory');

    // persi domain & commands: empty results, articles without publisher/free_link, categories with header row, location empty & search routing
    expect(
      parsePersiArticles(
        '<table><tr></tr><tr><td>Article Title</td><td>Per</td><td>Yr</td></tr><tr><td>Alder Notes</td><td>Harbor Q</td><td>1990</td><td><a href=""></a></td></tr></table>'
      )
    ).toEqual([
      { title: 'Alder Notes', periodical: 'Harbor Q', year: '1990', publisher: '', free_link: null },
    ]);
    expect(
      parsePersiCategories(
        '<table><tr><td>Category</td><td>10</td></tr><tr><td>Wills</td><td>5</td></tr></table>'
      )
    ).toEqual([{ category: 'Wills', articles: 5 }]);
    expect(formatPersiItemsText([], true)).toBe('No results. [cache]');
    expect(
      formatPersiItemsText(
        [{ title: 'Alder', periodical: 'HQ', year: '1990', publisher: 'Pub', free_link: null }],
        false
      )
    ).toContain('Alder | HQ | 1990 | Pub');

    const persiEnv = { KINLOOM_PERSI_CACHE_DIR: path.join(tmp, 'persi') };
    const persiEmptyLoc = await invokeHandler(runPersiCommand, ['location', '--state', 'VA'], {
      env: persiEnv,
      fetchImpl: async () => new Response('<table></table>', { status: 200 }),
    });
    expect(persiEmptyLoc.exitCode).toBe(1);

    const persiBadUrl = await invokeHandler(runPersiCommand, ['url', 'bogus'], { env: persiEnv });
    expect(persiBadUrl.exitCode).toBe(2);
    const persiBadSearch = await invokeHandler(runPersiCommand, ['search'], { env: persiEnv });
    expect(persiBadSearch.exitCode).toBe(2);
    const persiConflict = await invokeHandler(runPersiCommand, ['search', 'Alder', '--state', 'VA'], {
      env: persiEnv,
    });
    expect(persiConflict.exitCode).toBe(2);
  });
});
