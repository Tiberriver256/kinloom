import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext, SsrfBlockedError } from '../runtime/index.js';
import {
  ArchiveNotFoundError,
  ensurePageImageCache,
  httpGetBytesIa,
  MAX_RETRY_AFTER_SECONDS,
  PAGE_BATCH_WORKERS,
  pageImageUrl,
  parseScandataXml,
  runArchiveOrgCommand,
} from './archive-org.js';

const SYNTHETIC_SCANDATA = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>
<book>
  <pageData>
    <page leafNum="0"><pageType>Delete</pageType><addToAccessFormats>false</addToAccessFormats></page>
    <page leafNum="1"><pageType>Cover</pageType><addToAccessFormats>true</addToAccessFormats></page>
    <page leafNum="2"><pageType>Title</pageType><addToAccessFormats>true</addToAccessFormats></page>
    <page leafNum="3"><pageType>Normal</pageType><pageNumber>iv</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
    <page leafNum="4"><pageType>Normal</pageType><pageNumber>1</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
    <page leafNum="5"><pageType>Normal</pageType><pageNumber>2</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
  </pageData>
</book>
`,
  'utf8'
);

const SYNTHETIC_TEXT_PAGES = [
  '',
  'Cover Text',
  'Title Page: Gazetteer of Oakridge County',
  'Preface signed by Clara Barton on page iv.',
  'Page one records the 1848 mill survey at Oakridge Creek.',
  'Page two lists ferry tolls across Maple River.',
];

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-ia-test-'));
  tempDirs.push(dir);
  return dir;
}

function bytesResponse(body: Uint8Array | string, status = 200, headers?: Record<string, string>): Response {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  return new Response(payload, { status, headers });
}

interface InvokeOptions {
  readonly cacheDir: string;
  readonly fetchImpl: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
  readonly stdoutOverride?: (line: string) => void;
}

async function invokeIa(
  args: readonly string[],
  options: InvokeOptions
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cacheHit?: boolean;
}> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout:
        options.stdoutOverride ??
        ((line) => {
          stdoutLines.push(line);
        }),
      stderr: (line) => {
        stderrLines.push(line);
      },
    },
    env: {
      KINLOOM_IA_CACHE_DIR: options.cacheDir,
      ...options.env,
    },
    fetchImpl: options.fetchImpl,
    sleepFn: options.sleepFn ?? (async () => {}),
    nowMs: options.nowMs ?? (() => Date.now()),
  });
  const outcome = await runArchiveOrgCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdoutLines.join('\n'),
    stderr: stderrLines.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

function makeTextAndLookupFetch(itemId: string, djvuPages: readonly string[], seen: string[]): typeof fetch {
  const fakeMeta = {
    metadata: { identifier: itemId, title: 'Synthetic Gazetteer' },
    files: [
      { name: `${itemId}_scandata.xml`, format: 'Scandata' },
      { name: `${itemId}_djvu.txt`, format: 'DjVuTXT' },
    ],
  };

  return async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('/page/n') || url.endsWith('.jpg')) {
      throw new Error(`JPEG must not be fetched: ${url}`);
    }
    if (url.endsWith(`/metadata/${itemId}`)) {
      return bytesResponse(JSON.stringify(fakeMeta));
    }
    if (url.endsWith(`/${itemId}_scandata.xml`)) {
      return bytesResponse(SYNTHETIC_SCANDATA);
    }
    if (url.endsWith(`/${itemId}_djvu.txt`)) {
      return bytesResponse(djvuPages.join('\x0c'));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

describe('archive-org native client: cached grep and page', () => {
  it('1. parseScandataXml handles deleted leaf offset', () => {
    const idx = parseScandataXml(SYNTHETIC_SCANDATA);
    expect(idx.leaf_count).toBe(6);
    expect(idx.access_leaf_count).toBe(5);
    expect(idx.printed_to_bookreader['1']).toBe(3);
    expect(idx.printed_to_bookreader['2']).toBe(4);
    expect(idx.printed_to_bookreader_ci.iv).toBe(2);
    expect(idx.bookreader_to_printed['3']).toBe('1');
    expect(idx.scandata_to_bookreader['4']).toBe(3);
    expect(idx.bookreader_to_scandata['3']).toBe(4);
  });

  it('2. grep populates cache, skips hOCR when djvu has breaks, and hits cache', async () => {
    const itemId = 'synthetic_town_history_1892';
    const fakeMeta = {
      metadata: { identifier: itemId, title: 'Synthetic Town History' },
      files: [
        { name: `${itemId}_scandata.xml`, format: 'Scandata' },
        { name: `${itemId}_djvu.txt`, format: 'DjVuTXT' },
        { name: `${itemId}_hocr_searchtext.txt.gz`, format: 'OCR Search Text' },
        { name: `${itemId}_hocr_pageindex.json.gz`, format: 'OCR Page Index' },
      ],
    };
    const fakeDjvu = Buffer.from(
      [
        '',
        'Cover Text',
        'Title Page: Gazetteer of Oakridge County',
        'Preface signed by Clara Barton on page iv.',
        'Page one records the 1848 mill survey at Oakridge Creek.\nFrederick Douglass spoke here.',
        'Page two lists ferry tolls across Maple River.',
      ].join('\x0c'),
      'utf8'
    );

    const fetchCalls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.endsWith(`/metadata/${itemId}`)) {
        return bytesResponse(JSON.stringify(fakeMeta));
      }
      if (url.endsWith(`/${itemId}_scandata.xml`)) {
        return bytesResponse(SYNTHETIC_SCANDATA);
      }
      if (url.endsWith(`/${itemId}_djvu.txt`)) {
        return bytesResponse(fakeDjvu);
      }
      throw new Error(`Unexpected eager URL fetch: ${url}`);
    };

    const tmpdir = await makeTempDir();
    const r1 = await invokeIa(['grep', itemId, '--pattern', 'Frederick Douglass', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r1.exitCode).toBe(0);
    const out1 = JSON.parse(r1.stdout) as {
      cached: boolean;
      cache_hit: boolean;
      total_matches: number;
      hits: {
        leaf: number;
        scandata_leaf: number;
        printed_page: string;
        image_url: string;
        cached: boolean;
      }[];
    };
    expect(out1.cached).toBe(false);
    expect(out1.cache_hit).toBe(false);
    expect(out1.total_matches).toBe(1);
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls.some((u) => u.includes('hocr'))).toBe(false);
    const hit = out1.hits[0];
    expect(hit.leaf).toBe(3);
    expect(hit.scandata_leaf).toBe(4);
    expect(hit.printed_page).toBe('1');
    expect(hit.image_url).toBe(`https://archive.org/download/${itemId}/page/n3_s2.jpg`);
    expect(hit.cached).toBe(false);

    const itemDir = path.join(tmpdir, itemId);
    for (const fname of ['metadata.json', 'scandata.xml', 'page_index.json', 'djvu.txt']) {
      expect(fs.statSync(path.join(itemDir, fname)).isFile()).toBe(true);
    }

    // Second grep call makes zero HTTP requests.
    fetchCalls.length = 0;
    const r2 = await invokeIa(['grep', itemId, '--pattern', 'Clara Barton', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r2.exitCode).toBe(0);
    expect(fetchCalls).toEqual([]);
    const out2 = JSON.parse(r2.stdout) as typeof out1;
    expect(out2.cached).toBe(true);
    expect(out2.cache_hit).toBe(true);
    expect(out2.hits[0].leaf).toBe(2);
    expect(out2.hits[0].printed_page).toBe('iv');
    expect(out2.hits[0].cached).toBe(true);

    // --refresh forces fresh fetches and updates cached content.
    const r3 = await invokeIa(['grep', itemId, '--pattern', 'Clara Barton', '--refresh', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r3.exitCode).toBe(0);
    expect(fetchCalls).toHaveLength(3);
    const out3 = JSON.parse(r3.stdout) as typeof out1;
    expect(out3.cached).toBe(false);
  });

  it('3. grep falls back to hOCR when djvu lacks breaks or is missing', async () => {
    const pages = ['', 'Cover', 'Title', 'Intro iv', 'Page one alpha', 'Page two Harriet Tubman'];
    const joined = pages.join('');
    const offsets: number[][] = [];
    let pos = 0;
    for (const p of pages) {
      offsets.push([pos, pos + p.length, 0, 0]);
      pos += p.length;
    }

    for (const [caseName, includeDjvu] of [
      ['flat_djvu', true],
      ['missing_djvu', false],
    ] as const) {
      const itemId = `synthetic_${caseName}_1901`;
      const files = [
        { name: `${itemId}_scandata.xml`, format: 'Scandata' },
        { name: `${itemId}_hocr_searchtext.txt.gz`, format: 'OCR Search Text' },
        { name: `${itemId}_hocr_pageindex.json.gz`, format: 'OCR Page Index' },
        ...(includeDjvu ? [{ name: `${itemId}_djvu.txt`, format: 'DjVuTXT' }] : []),
      ];
      const fakeMeta = { metadata: { identifier: itemId, title: 'Synthetic' }, files };
      const seenUrls: string[] = [];

      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        seenUrls.push(url);
        if (url.endsWith(`/metadata/${itemId}`)) {
          return bytesResponse(JSON.stringify(fakeMeta));
        }
        if (url.endsWith(`/${itemId}_scandata.xml`)) {
          return bytesResponse(SYNTHETIC_SCANDATA);
        }
        if (url.endsWith(`/${itemId}_djvu.txt`)) {
          return bytesResponse('Flat text with zero form feeds Harriet Tubman');
        }
        if (url.endsWith(`/${itemId}_hocr_searchtext.txt.gz`)) {
          return bytesResponse(gzipSync(Buffer.from(joined, 'utf8')));
        }
        if (url.endsWith(`/${itemId}_hocr_pageindex.json.gz`)) {
          return bytesResponse(gzipSync(Buffer.from(JSON.stringify(offsets), 'utf8')));
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const tmpdir = await makeTempDir();
      const res = await invokeIa(['grep', itemId, '--pattern', 'Harriet Tubman', '--json'], {
        cacheDir: tmpdir,
        fetchImpl,
      });
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as {
        hits: { leaf: number; scandata_leaf: number; printed_page: string }[];
      };
      expect(out.hits[0].leaf).toBe(4);
      expect(out.hits[0].scandata_leaf).toBe(5);
      expect(out.hits[0].printed_page).toBe('2');
      expect(seenUrls.some((u) => u.endsWith('_hocr_searchtext.txt.gz'))).toBe(true);
      expect(seenUrls.some((u) => u.endsWith('_hocr_pageindex.json.gz'))).toBe(true);
    }
  });

  it('4. get caches metadata and refreshes on flag', async () => {
    const itemId = 'synthetic_get_item_1875';
    const version = { title: 'First Edition Gazetteer' };
    const fetchCalls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.endsWith(`/metadata/${itemId}`)) {
        return bytesResponse(
          JSON.stringify({
            metadata: { identifier: itemId, title: version.title },
            files: [{ name: `${itemId}.pdf`, format: 'Text PDF', size: '123' }],
          })
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tmpdir = await makeTempDir();
    const r1 = await invokeIa(['get', itemId, '--json'], { cacheDir: tmpdir, fetchImpl });
    expect(r1.exitCode).toBe(0);
    const d1 = JSON.parse(r1.stdout) as { metadata: { title: string }; cache_hit: boolean };
    expect(d1.metadata.title).toBe('First Edition Gazetteer');
    expect(d1.cache_hit).toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(fs.statSync(path.join(tmpdir, itemId, 'metadata.json')).isFile()).toBe(true);

    // Second call hits disk cache with zero HTTP requests.
    version.title = 'Updated Edition Gazetteer';
    const r2 = await invokeIa(['get', itemId, '--json'], { cacheDir: tmpdir, fetchImpl });
    expect(r2.exitCode).toBe(0);
    const d2 = JSON.parse(r2.stdout) as typeof d1;
    expect(d2.metadata.title).toBe('First Edition Gazetteer');
    expect(d2.cache_hit).toBe(true);
    expect(fetchCalls).toHaveLength(1);

    // --refresh fetches updated metadata and overwrites metadata.json.
    const r3 = await invokeIa(['get', itemId, '--refresh', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r3.exitCode).toBe(0);
    const d3 = JSON.parse(r3.stdout) as typeof d1;
    expect(d3.metadata.title).toBe('Updated Edition Gazetteer');
    expect(fetchCalls).toHaveLength(2);
  });

  it('5. page caches JPEG and respects --refresh', async () => {
    const itemId = 'synthetic_atlas_1888';
    const fakeMeta = {
      metadata: { identifier: itemId, title: 'Synthetic Atlas' },
      files: [{ name: `${itemId}_scandata.xml`, format: 'Scandata' }],
    };
    const jpegState = { bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]) };
    const seenUrls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.endsWith(`/metadata/${itemId}`)) {
        return bytesResponse(JSON.stringify(fakeMeta));
      }
      if (url.endsWith(`/${itemId}_scandata.xml`)) {
        return bytesResponse(SYNTHETIC_SCANDATA);
      }
      if (url.includes('/page/n')) {
        return bytesResponse(jpegState.bytes);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tmpdir = await makeTempDir();
    const outFile1 = path.join(tmpdir, 'page2_first.jpg');
    const outFile2 = path.join(tmpdir, 'page2_second.jpg');
    const legacyDir = path.join(tmpdir, 'legacy_out');

    const r1 = await invokeIa(
      ['page', itemId, '--printed-page', '2', '--scale', '2', '--out', outFile1, '--json'],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(r1.exitCode).toBe(0);
    const p1 = JSON.parse(r1.stdout) as {
      leaf: number;
      scandata_leaf: number;
      printed_page: string;
      url: string;
      index_cached: boolean | null;
      page_cached: boolean;
      cache_hit: boolean;
    };
    expect(p1.leaf).toBe(4);
    expect(p1.scandata_leaf).toBe(5);
    expect(p1.printed_page).toBe('2');
    expect(p1.url).toBe(`https://archive.org/download/${itemId}/page/n4_s2.jpg`);
    expect(p1.page_cached).toBe(false);
    expect(p1.cache_hit).toBe(false);
    expect(fs.readFileSync(outFile1).equals(jpegState.bytes)).toBe(true);
    expect(fs.statSync(path.join(tmpdir, itemId, 'pages', 'n4_s2.jpg')).isFile()).toBe(true);
    const callCountAfterFirst = seenUrls.length;
    expect(callCountAfterFirst).toBe(3);

    // Second call to same page (different --out path) makes zero HTTP calls.
    const r2 = await invokeIa(
      ['page', itemId, '--printed-page', '2', '--scale', '2', '--out', outFile2, '--json'],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(r2.exitCode).toBe(0);
    expect(seenUrls).toHaveLength(callCountAfterFirst);
    const p2 = JSON.parse(r2.stdout) as typeof p1;
    expect(p2.index_cached).toBe(true);
    expect(p2.page_cached).toBe(true);
    expect(p2.cache_hit).toBe(true);
    expect(fs.readFileSync(outFile2).equals(jpegState.bytes)).toBe(true);

    // Text output reports cache-hit on cached leaf fetch.
    const rTxt = await invokeIa(['page', itemId, '--leaf', '4', '--scale', '2', '--out', outFile2], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rTxt.exitCode).toBe(0);
    expect(rTxt.stdout).toContain('cache-hit');
    expect(seenUrls).toHaveLength(callCountAfterFirst);

    // --refresh forces fresh page JPEG fetch and updates cache.
    jpegState.bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 2)]);
    const rRef = await invokeIa(
      ['page', itemId, '--leaf', '4', '--scale', '2', '--out', outFile2, '--refresh', '--json'],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(rRef.exitCode).toBe(0);
    const pRef = JSON.parse(rRef.stdout) as typeof p1;
    expect(pRef.page_cached).toBe(false);
    expect(seenUrls).toHaveLength(callCountAfterFirst + 1);
    expect(fs.readFileSync(outFile2).equals(jpegState.bytes)).toBe(true);

    // Legacy positional leaf + --width + directory --out caches n3_w1200.jpg.
    const r3 = await invokeIa(['page', itemId, '3', '--width', '1200', '--out', legacyDir], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r3.exitCode).toBe(0);
    expect(fs.statSync(path.join(legacyDir, `${itemId}_n3_w1200.jpg`)).isFile()).toBe(true);
    expect(fs.statSync(path.join(tmpdir, itemId, 'pages', 'n3_w1200.jpg')).isFile()).toBe(true);
    expect(seenUrls).toContain(`https://archive.org/download/${itemId}/page/n3_w1200.jpg`);
  });

  it('6. page batch is parallel, bounded, and cached repeat hits', async () => {
    const itemId = 'synthetic_city_directory_1894';
    const leaves = [5, 1, 3, 8, 2, 6];
    let inflight = 0;
    let maxInflight = 0;
    const seen: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (!url.includes('/page/n')) {
        throw new Error(`Unexpected URL: ${url}`);
      }
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      seen.push(url);
      try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const match = /\/page\/n(\d+)_/.exec(url);
        if (!match) {
          throw new Error(`Missing leaf in URL: ${url}`);
        }
        const leaf = Number.parseInt(match[1], 10);
        return bytesResponse(Buffer.concat([Buffer.from([0xff, 0xd8, leaf]), Buffer.alloc(24, 0)]));
      } finally {
        inflight -= 1;
      }
    };

    const tmpdir = await makeTempDir();
    const outDir = path.join(tmpdir, 'pages');

    const r1 = await invokeIa(
      ['page', itemId, '--leaves', '5,1,3,8,2,6', '--scale', '2', '--out', outDir, '--json'],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(r1.exitCode).toBe(0);
    const p1 = JSON.parse(r1.stdout) as {
      count: number;
      cache_hit: boolean;
      pages: { leaf: number; path: string; page_cached: boolean }[];
    };
    expect(p1.count).toBe(6);
    expect(p1.cache_hit).toBe(false);
    expect(p1.pages.map((p) => p.leaf)).toEqual(leaves);
    expect(p1.pages.map((p) => p.page_cached)).toEqual([false, false, false, false, false, false]);
    for (const page of p1.pages) {
      const expected = Buffer.concat([Buffer.from([0xff, 0xd8, page.leaf]), Buffer.alloc(24, 0)]);
      expect(fs.readFileSync(page.path).equals(expected)).toBe(true);
      expect(page.path.endsWith(`${itemId}_n${page.leaf}_s2.jpg`)).toBe(true);
    }
    expect(maxInflight).toBeGreaterThanOrEqual(2);
    expect(maxInflight).toBeLessThanOrEqual(PAGE_BATCH_WORKERS);
    expect(seen).toHaveLength(6);
    const callsAfterMiss = seen.length;

    const r2 = await invokeIa(
      ['page', itemId, '--leaves', '5,1,3,8,2,6', '--scale', '2', '--out', outDir, '--json'],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(r2.exitCode).toBe(0);
    const p2 = JSON.parse(r2.stdout) as typeof p1;
    expect(p2.cache_hit).toBe(true);
    expect(p2.pages.map((p) => p.page_cached)).toEqual([true, true, true, true, true, true]);
    expect(seen).toHaveLength(callsAfterMiss);

    const rRange = await invokeIa(
      ['page', itemId, '--leaves', '1-3,5', '--scale', '2', '--out', outDir, '--json'],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(rRange.exitCode).toBe(0);
    const ranged = JSON.parse(rRange.stdout) as typeof p1;
    expect(ranged.pages.map((p) => p.leaf)).toEqual([1, 2, 3, 5]);
    expect(ranged.cache_hit).toBe(true);
    expect(seen).toHaveLength(callsAfterMiss);

    const rConflict = await invokeIa(['page', itemId, '--leaf', '1', '--leaves', '2,3', '--out', outDir], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rConflict.exitCode).toBe(2);
    expect(rConflict.stderr).toContain('--leaves');

    const rBoth = await invokeIa(
      ['page', itemId, '--leaves', '1,2', '--printed-pages', '1,2', '--out', outDir],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(rBoth.exitCode).toBe(2);
    expect(rBoth.stderr).toContain('--printed-pages');

    const batchJpg = path.join(tmpdir, 'batch.jpg');
    const rJpg = await invokeIa(['page', itemId, '--leaves', '1,2', '--out', batchJpg], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rJpg.exitCode).toBe(2);
    expect(rJpg.stderr).toContain('directory');
    expect(fs.existsSync(batchJpg)).toBe(false);

    const rCap = await invokeIa(['page', itemId, '--leaves', '0-25', '--out', outDir], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rCap.exitCode).toBe(2);
    expect(rCap.stderr).toContain('25');
    expect(seen).toHaveLength(callsAfterMiss);

    const rBadRange = await invokeIa(['page', itemId, '--leaves', '4-2', '--out', outDir], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rBadRange.exitCode).toBe(2);
    expect(rBadRange.stderr).toContain('precedes');
  });

  it('7. printed-pages range resolves once and second call is a cache hit', async () => {
    const itemId = 'synthetic_atlas_pages_1888';
    const fakeMeta = {
      metadata: { identifier: itemId, title: 'Synthetic Atlas' },
      files: [{ name: `${itemId}_scandata.xml`, format: 'Scandata' }],
    };
    const seen: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith(`/metadata/${itemId}`)) {
        return bytesResponse(JSON.stringify(fakeMeta));
      }
      if (url.endsWith(`/${itemId}_scandata.xml`)) {
        return bytesResponse(SYNTHETIC_SCANDATA);
      }
      if (url.includes('/page/n')) {
        const match = /\/page\/n(\d+)_/.exec(url);
        if (!match) {
          throw new Error(`Missing leaf in URL: ${url}`);
        }
        return bytesResponse(
          Buffer.concat([Buffer.from([0xff, 0xd8, Number.parseInt(match[1], 10)]), Buffer.alloc(16, 0xab)])
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tmpdir = await makeTempDir();
    const outDir = path.join(tmpdir, 'printed');

    const r1 = await invokeIa(
      ['page', itemId, '--printed-pages', '1-2', '--scale', '2', '--out', outDir, '--json'],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(r1.exitCode).toBe(0);
    const p1 = JSON.parse(r1.stdout) as {
      count: number;
      cache_hit: boolean;
      pages: { printed_page: string; leaf: number; scandata_leaf: number; path: string }[];
    };
    expect(p1.count).toBe(2);
    expect(p1.cache_hit).toBe(false);
    expect(p1.pages.map((p) => p.printed_page)).toEqual(['1', '2']);
    expect(p1.pages.map((p) => p.leaf)).toEqual([3, 4]);
    expect(p1.pages.map((p) => p.scandata_leaf)).toEqual([4, 5]);
    expect(seen.filter((u) => u.endsWith(`/metadata/${itemId}`))).toHaveLength(1);
    expect(seen.filter((u) => u.endsWith('_scandata.xml'))).toHaveLength(1);
    const callsAfterMiss = seen.length;

    const r2 = await invokeIa(
      ['page', itemId, '--printed-pages', '1,2', '--scale', '2', '--out', outDir, '--json'],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(r2.exitCode).toBe(0);
    const p2 = JSON.parse(r2.stdout) as typeof p1;
    expect(p2.cache_hit).toBe(true);
    expect(p2.count).toBe(2);
    expect(seen).toHaveLength(callsAfterMiss);
    expect(
      fs
        .readFileSync(p2.pages[0].path)
        .subarray(0, 2)
        .equals(Buffer.from([0xff, 0xd8]))
    ).toBe(true);

    const rSingle = await invokeIa(
      [
        'page',
        itemId,
        '--printed-page',
        '2',
        '--scale',
        '2',
        '--out',
        path.join(outDir, 'one.jpg'),
        '--json',
      ],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(rSingle.exitCode).toBe(0);
    const single = JSON.parse(rSingle.stdout) as { leaf: number; cache_hit: boolean; count?: number };
    expect(single.leaf).toBe(4);
    expect('count' in single).toBe(false);
    expect(single.cache_hit).toBe(true);
    expect(seen).toHaveLength(callsAfterMiss);
  });

  it('8. download caches files, reuses metadata and artifacts, and rejects path traversal', async () => {
    const itemId = 'synthetic_county_record_1865';
    const pdfBytes = { data: Buffer.from('%PDF-1.4 synthetic county record v1', 'utf8') };
    const djvuBytes = Buffer.from('Page zero\x0cPage one Oakridge\x0cPage two', 'utf8');
    const fakeMeta = {
      metadata: { identifier: itemId, title: 'County Record' },
      files: [
        { name: `${itemId}_scandata.xml`, format: 'Scandata', size: String(SYNTHETIC_SCANDATA.length) },
        { name: `${itemId}_djvu.txt`, format: 'DjVuTXT', size: String(djvuBytes.length) },
        { name: `${itemId}.pdf`, format: 'Text PDF', size: String(pdfBytes.data.length) },
        { name: '../evil.txt', format: 'Text', size: '4' },
      ],
    };
    const fetchCalls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.endsWith(`/metadata/${itemId}`)) {
        return bytesResponse(JSON.stringify(fakeMeta));
      }
      if (url.endsWith(`/${itemId}_scandata.xml`)) {
        return bytesResponse(SYNTHETIC_SCANDATA);
      }
      if (url.endsWith(`/${itemId}_djvu.txt`)) {
        return bytesResponse(djvuBytes);
      }
      if (url.endsWith(`/${itemId}.pdf`)) {
        return bytesResponse(pdfBytes.data);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tmpdir = await makeTempDir();
    const out1 = path.join(tmpdir, 'out1');
    const out2 = path.join(tmpdir, 'out2');

    // Populate metadata + scandata + djvu via grep first.
    const rGrep = await invokeIa(['grep', itemId, '--pattern', 'Oakridge', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rGrep.exitCode).toBe(0);
    expect(fetchCalls).toHaveLength(3);

    // Downloading scandata.xml and _djvu.txt reuses cached item artifacts with zero HTTP calls.
    fetchCalls.length = 0;
    const rReuse = await invokeIa(
      ['download', itemId, `${itemId}_scandata.xml`, `${itemId}_djvu.txt`, '--out', out1],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(rReuse.exitCode).toBe(0);
    expect(fetchCalls).toEqual([]);
    expect(fs.readFileSync(path.join(out1, `${itemId}_scandata.xml`)).equals(SYNTHETIC_SCANDATA)).toBe(true);
    expect(fs.readFileSync(path.join(out1, `${itemId}_djvu.txt`)).equals(djvuBytes)).toBe(true);
    expect(rReuse.stdout).toContain('cache-hit');

    // Downloading PDF fetches once into files/<name>, reusing cached metadata.json.
    const rPdf1 = await invokeIa(['download', itemId, `${itemId}.pdf`, '--out', out1], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rPdf1.exitCode).toBe(0);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].endsWith(`/${itemId}.pdf`)).toBe(true);
    expect(fs.statSync(path.join(tmpdir, itemId, 'files', `${itemId}.pdf`)).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(out1, `${itemId}.pdf`)).equals(pdfBytes.data)).toBe(true);

    // Second download of PDF into another directory makes zero HTTP calls.
    fetchCalls.length = 0;
    const rPdf2 = await invokeIa(['download', itemId, `${itemId}.pdf`, '--out', out2], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rPdf2.exitCode).toBe(0);
    expect(fetchCalls).toEqual([]);
    expect(fs.readFileSync(path.join(out2, `${itemId}.pdf`)).equals(pdfBytes.data)).toBe(true);
    expect(rPdf2.stdout).toContain('cache-hit');

    // --refresh re-fetches metadata and PDF and updates cache.
    pdfBytes.data = Buffer.from('%PDF-1.4 synthetic county record v2', 'utf8');
    const rRef = await invokeIa(['download', itemId, `${itemId}.pdf`, '--out', out2, '--refresh'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rRef.exitCode).toBe(0);
    expect(fetchCalls).toHaveLength(2);
    expect(fs.readFileSync(path.join(out2, `${itemId}.pdf`)).equals(pdfBytes.data)).toBe(true);

    // Path traversal filenames are rejected with exit code 2 and zero HTTP calls.
    fetchCalls.length = 0;
    for (const badName of ['../evil.txt', '/etc/passwd', 'sub/../../escape.txt', 'a\\b.txt', 'C:drive.txt']) {
      const rBad = await invokeIa(['download', itemId, badName, '--out', out2], {
        cacheDir: tmpdir,
        fetchImpl,
      });
      expect(rBad.exitCode).toBe(2);
      expect(rBad.stderr).toContain('Unsafe file path');
    }
    expect(fetchCalls).toEqual([]);
  });

  it('9. search and fulltext cache with TTL and --refresh', async () => {
    const searchVersion = { numFound: 1 };
    const ftVersion = { total: 2 };
    const fetchCalls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes('advancedsearch.php')) {
        return bytesResponse(
          JSON.stringify({
            responseHeader: { status: 0 },
            response: {
              numFound: searchVersion.numFound,
              docs: [{ identifier: 'demo_book_1', title: 'Demo Book' }],
            },
          })
        );
      }
      if (url.includes('page_production')) {
        return bytesResponse(
          JSON.stringify({
            response: {
              body: {
                hits: {
                  total: ftVersion.total,
                  hits: [
                    {
                      fields: { identifier: 'demo_book_1', title: 'Demo Book', year: 1890 },
                      highlight: { text: ['Sample {{{Oakridge}}} match'] },
                    },
                  ],
                },
              },
            },
          })
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tmpdir = await makeTempDir();

    // search: first call fetches, second hits cache, --refresh fetches again.
    const s1 = await invokeIa(['search', 'title:(Oakridge)', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(s1.exitCode).toBe(0);
    const sd1 = JSON.parse(s1.stdout) as { response: { numFound: number }; cache_hit: boolean };
    expect(sd1.response.numFound).toBe(1);
    expect(sd1.cache_hit).toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(
      fs.readdirSync(path.join(tmpdir, '_queries', 'search')).filter((f) => f.endsWith('.json'))
    ).toHaveLength(1);

    searchVersion.numFound = 9;
    const s2 = await invokeIa(['search', 'title:(Oakridge)', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(s2.exitCode).toBe(0);
    const sd2 = JSON.parse(s2.stdout) as typeof sd1;
    expect(sd2.response.numFound).toBe(1);
    expect(sd2.cache_hit).toBe(true);
    expect(fetchCalls).toHaveLength(1);

    const s3 = await invokeIa(['search', 'title:(Oakridge)', '--refresh', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(s3.exitCode).toBe(0);
    const sd3 = JSON.parse(s3.stdout) as typeof sd1;
    expect(sd3.response.numFound).toBe(9);
    expect(sd3.cache_hit).toBe(false);
    expect(fetchCalls).toHaveLength(2);

    // fulltext: first call fetches, second hits cache, TTL=0 bypasses cache.
    fetchCalls.length = 0;
    const f1 = await invokeIa(['fulltext', '"Oakridge Mill"', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(f1.exitCode).toBe(0);
    const fd1 = JSON.parse(f1.stdout) as {
      response: { body: { hits: { total: number } } };
      cache_hit: boolean;
    };
    expect(fd1.response.body.hits.total).toBe(2);
    expect(fd1.cache_hit).toBe(false);
    expect(fetchCalls).toHaveLength(1);
    const ftDir = path.join(tmpdir, '_queries', 'fulltext');
    const ftFiles = fs.readdirSync(ftDir).filter((f) => f.endsWith('.json'));
    expect(ftFiles).toHaveLength(1);

    ftVersion.total = 7;
    const f2 = await invokeIa(['fulltext', '"Oakridge Mill"', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(f2.exitCode).toBe(0);
    const fd2 = JSON.parse(f2.stdout) as typeof fd1;
    expect(fd2.response.body.hits.total).toBe(2);
    expect(fd2.cache_hit).toBe(true);
    expect(fetchCalls).toHaveLength(1);

    const f3 = await invokeIa(['fulltext', '"Oakridge Mill"', '--cache-ttl-hours', '0', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(f3.exitCode).toBe(0);
    const fd3 = JSON.parse(f3.stdout) as typeof fd1;
    expect(fd3.response.body.hits.total).toBe(7);
    expect(fetchCalls).toHaveLength(2);

    // Stale cache entry older than TTL triggers fresh fetch.
    const ftCacheFile = path.join(ftDir, ftFiles[0]);
    const envelope = JSON.parse(fs.readFileSync(ftCacheFile, 'utf8')) as Record<string, unknown>;
    envelope.cached_at = Date.now() / 1000 - 200 * 3600;
    fs.writeFileSync(ftCacheFile, JSON.stringify(envelope), 'utf8');

    ftVersion.total = 11;
    const f4 = await invokeIa(['fulltext', '"Oakridge Mill"', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(f4.exitCode).toBe(0);
    const fd4 = JSON.parse(f4.stdout) as typeof fd1;
    expect(fd4.response.body.hits.total).toBe(11);
    expect(fetchCalls).toHaveLength(3);

    // KINLOOM_IA_QUERY_TTL_HOURS=0 env var also bypasses cache.
    ftVersion.total = 13;
    const f5 = await invokeIa(['fulltext', '"Oakridge Mill"', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
      env: { KINLOOM_IA_QUERY_TTL_HOURS: '0' },
    });
    expect(f5.exitCode).toBe(0);
    expect((JSON.parse(f5.stdout) as typeof fd1).response.body.hits.total).toBe(13);
    expect(fetchCalls).toHaveLength(4);
  });

  it('10. httpGetBytesIa retries 429/503 politely and fails fast on 403/404/timeout', async () => {
    const url = 'https://archive.org/metadata/demo_item';

    // 429 (Retry-After: 12 capped to 5000ms) -> 503 (Retry-After: 1.5 -> 1500ms) -> 200 OK.
    let attempts = 0;
    const sleeps: number[] = [];
    const ctxRetry = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return bytesResponse('', 429, { 'Retry-After': '12' });
        }
        if (attempts === 2) {
          return bytesResponse('', 503, { 'Retry-After': '1.5' });
        }
        return bytesResponse('{"ok":true}', 200);
      },
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    const data = await httpGetBytesIa(url, ctxRetry);
    expect(data.toString('utf8')).toBe('{"ok":true}');
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([5000, 1500]);

    // 504 exhausts max 2 retries (3 total attempts) and throws RecordRuntimeError.
    attempts = 0;
    sleeps.length = 0;
    const ctx504 = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        return bytesResponse('', 504);
      },
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(httpGetBytesIa(url, ctx504)).rejects.toThrow(/HTTP 504/);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([500, 1000]);

    // 403 fails immediately with 0 retries.
    attempts = 0;
    sleeps.length = 0;
    const ctx403 = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        return bytesResponse('', 403);
      },
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(httpGetBytesIa(url, ctx403)).rejects.toThrow(/HTTP 403/);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);

    // 404 fails immediately with ArchiveNotFoundError and 0 retries.
    attempts = 0;
    sleeps.length = 0;
    const ctx404 = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        return bytesResponse('', 404);
      },
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(httpGetBytesIa(url, ctx404)).rejects.toBeInstanceOf(ArchiveNotFoundError);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);

    // ReadTimeout / TimeoutError fails immediately with 0 retries.
    attempts = 0;
    sleeps.length = 0;
    const ctxTimeout = createRecordContext({
      fetchImpl: async () => {
        attempts += 1;
        throw new Error('The read operation timed out');
      },
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(httpGetBytesIa(url, ctxTimeout)).rejects.toThrow(/timed out/);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('11. concurrent page requests deduplicate via item/page lock', async () => {
    const itemId = 'synthetic_concurrent_book_1880';
    const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48, 9)]);
    let fetchCount = 0;

    const ctx = createRecordContext({
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        fetchCount += 1;
        return bytesResponse(jpegBytes);
      },
      sleepFn: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
      },
    });

    const tmpdir = await makeTempDir();
    const url = pageImageUrl(itemId, 7, { width: 2400 });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        ensurePageImageCache(itemId, 7, 'w2400', url, ctx, { cacheRoot: tmpdir })
      )
    );

    expect(fetchCount).toBe(1);
    expect(results.every(([content]) => content.equals(jpegBytes))).toBe(true);
    expect(results.filter(([, , cached]) => !cached)).toHaveLength(1);
    expect(results.filter(([, , cached]) => cached)).toHaveLength(3);
  });
});

describe('archive-org native client: text and lookup', () => {
  it('12. text printed-page caches and refreshes without fetching JPEG', async () => {
    const itemId = 'synthetic_text_gazetteer_1890';
    const seen: string[] = [];
    const fetchImpl = makeTextAndLookupFetch(itemId, SYNTHETIC_TEXT_PAGES, seen);
    const tmpdir = await makeTempDir();

    const r1 = await invokeIa(['text', itemId, '--printed-page', '1', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r1.exitCode).toBe(0);
    const p1 = JSON.parse(r1.stdout) as {
      identifier: string;
      cached: boolean;
      pages: {
        leaf: number;
        scandata_leaf: number;
        printed_page: string | null;
        text: string;
        image_url: string;
        details_url: string;
      }[];
    };
    expect(p1.identifier).toBe(itemId);
    expect(p1.cached).toBe(false);
    expect(p1.pages).toHaveLength(1);
    const page = p1.pages[0];
    expect(page.leaf).toBe(3);
    expect(page.scandata_leaf).toBe(4);
    expect(page.printed_page).toBe('1');
    expect(page.text).toContain('1848 mill survey');
    expect(page.image_url).toBe(`https://archive.org/download/${itemId}/page/n3_s2.jpg`);
    expect(page.details_url).toBe(`https://archive.org/details/${itemId}/page/n3`);
    expect(seen).toHaveLength(3);
    expect(seen.some((u) => u.includes('/page/n'))).toBe(false);
    expect(fs.existsSync(path.join(tmpdir, itemId, 'pages'))).toBe(false);

    // Cache hit: zero HTTP requests, leaf selector works.
    seen.length = 0;
    const r2 = await invokeIa(['text', itemId, '--leaf', '0', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r2.exitCode).toBe(0);
    const p2 = JSON.parse(r2.stdout) as typeof p1;
    expect(p2.cached).toBe(true);
    expect(p2.pages[0].text).toBe('Cover Text');
    expect(p2.pages[0].scandata_leaf).toBe(1);
    expect(p2.pages[0].printed_page).toBeNull();
    expect(seen).toEqual([]);

    // Human-readable output includes metadata and URLs.
    const r3 = await invokeIa(['text', itemId, '--printed-page', 'IV'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r3.exitCode).toBe(0);
    expect(r3.stdout).toContain('n2 (p.iv, scandata leaf 3)');
    expect(r3.stdout).toContain(`https://archive.org/download/${itemId}/page/n2_s2.jpg`);
    expect(r3.stdout).toContain('Clara Barton');
    expect(seen).toEqual([]);

    // --refresh re-fetches metadata, scandata, and OCR text (still no JPEG).
    const r4 = await invokeIa(['text', itemId, '--printed-page', '2', '--refresh', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r4.exitCode).toBe(0);
    expect((JSON.parse(r4.stdout) as typeof p1).cached).toBe(false);
    expect(seen).toHaveLength(3);
    expect(seen.some((u) => u.includes('/page/n'))).toBe(false);
  });

  it('13. text --pages range works in both scandata and bookreader segment modes', async () => {
    for (const [caseName, djvuPages] of [
      ['scandata_mode', SYNTHETIC_TEXT_PAGES],
      ['bookreader_mode', SYNTHETIC_TEXT_PAGES.slice(1)],
    ] as const) {
      const itemId = `synthetic_range_${caseName}_1899`;
      const seen: string[] = [];
      const fetchImpl = makeTextAndLookupFetch(itemId, djvuPages, seen);
      const tmpdir = await makeTempDir();

      const r1 = await invokeIa(['text', itemId, '--pages', 'iv-2', '--json'], {
        cacheDir: tmpdir,
        fetchImpl,
      });
      expect(r1.exitCode).toBe(0);
      const pages = (
        JSON.parse(r1.stdout) as {
          pages: { leaf: number; printed_page: string; scandata_leaf: number; text: string }[];
        }
      ).pages;
      expect(pages.map((p) => p.leaf)).toEqual([2, 3, 4]);
      expect(pages.map((p) => p.printed_page)).toEqual(['iv', '1', '2']);
      expect(pages.map((p) => p.scandata_leaf)).toEqual([3, 4, 5]);
      expect(pages[0].text).toContain('Clara Barton');
      expect(pages[1].text).toContain('1848 mill survey');
      expect(pages[2].text).toContain('ferry tolls');

      const r2 = await invokeIa(['text', itemId, '--pages', '1-1', '--json'], {
        cacheDir: tmpdir,
        fetchImpl,
      });
      expect(r2.exitCode).toBe(0);
      const p2 = (JSON.parse(r2.stdout) as { pages: { leaf: number }[] }).pages;
      expect(p2.map((p) => p.leaf)).toEqual([3]);
      expect(seen).toHaveLength(3);
    }
  });

  it('14. lookup uses page_index only and refreshes without fetching djvu or JPEG', async () => {
    const itemId = 'synthetic_lookup_atlas_1877';
    const seen: string[] = [];
    const fetchImpl = makeTextAndLookupFetch(itemId, SYNTHETIC_TEXT_PAGES, seen);
    const tmpdir = await makeTempDir();

    const r1 = await invokeIa(['lookup', itemId, '--printed-page', '2', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r1.exitCode).toBe(0);
    const p1 = JSON.parse(r1.stdout) as {
      leaf: number;
      scandata_leaf: number;
      printed_page: string;
      cached: boolean;
      image_url: string;
    };
    expect(p1.leaf).toBe(4);
    expect(p1.scandata_leaf).toBe(5);
    expect(p1.printed_page).toBe('2');
    expect(p1.cached).toBe(false);
    expect(p1.image_url).toBe(`https://archive.org/download/${itemId}/page/n4_s2.jpg`);
    expect(seen).toHaveLength(2);
    expect(seen.some((u) => u.endsWith('_djvu.txt'))).toBe(false);
    expect(seen.some((u) => u.includes('/page/n'))).toBe(false);
    expect(fs.existsSync(path.join(tmpdir, itemId, 'djvu.txt'))).toBe(false);
    expect(fs.statSync(path.join(tmpdir, itemId, 'page_index.json')).isFile()).toBe(true);

    seen.length = 0;
    const r2 = await invokeIa(['lookup', itemId, '--leaf', '3', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r2.exitCode).toBe(0);
    const p2 = JSON.parse(r2.stdout) as typeof p1;
    expect(p2.cached).toBe(true);
    expect(p2.printed_page).toBe('1');
    expect(p2.scandata_leaf).toBe(4);

    const r3 = await invokeIa(['lookup', itemId, '--scandata-leaf', '3'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r3.exitCode).toBe(0);
    expect(r3.stdout).toContain('printed page iv | BookReader leaf n2 | scandata leaf 3');
    expect(seen).toEqual([]);

    const r4 = await invokeIa(['lookup', itemId, '--leaf', '0', '--refresh', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r4.exitCode).toBe(0);
    expect((JSON.parse(r4.stdout) as typeof p1).scandata_leaf).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen.some((u) => u.endsWith('_djvu.txt'))).toBe(false);
  });

  it('15. text and lookup error on unresolvable pages and bad selectors', async () => {
    const itemId = 'synthetic_errors_registry_1866';
    const seen: string[] = [];
    const fetchImpl = makeTextAndLookupFetch(itemId, SYNTHETIC_TEXT_PAGES, seen);
    const tmpdir = await makeTempDir();

    const e1 = await invokeIa(['text', itemId, '--printed-page', '999'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(e1.exitCode).toBe(1);
    expect(e1.stderr).toContain("Printed page '999' not found");

    const e2 = await invokeIa(['lookup', itemId, '--printed-page', 'xlii'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(e2.exitCode).toBe(1);
    expect(e2.stderr).toContain('not found');

    const e3 = await invokeIa(['text', itemId, '--leaf', '42'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(e3.exitCode).toBe(1);
    expect(e3.stderr).toContain('out of range');

    const e4 = await invokeIa(['lookup', itemId, '--scandata-leaf', '0'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(e4.exitCode).toBe(1);
    expect(e4.stderr).toContain('not an access leaf');

    const e5 = await invokeIa(['text', itemId, '--pages', '2-iv'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(e5.exitCode).toBe(1);
    expect(e5.stderr).toContain('precedes');

    const e6 = await invokeIa(['text', itemId, '--pages', '1-999'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(e6.exitCode).toBe(1);
    expect(e6.stderr).toContain("'999' not found");

    seen.length = 0;
    const u1 = await invokeIa(['text', itemId], { cacheDir: tmpdir, fetchImpl });
    expect(u1.exitCode).toBe(2);
    const u2 = await invokeIa(['text', itemId, '--leaf', '1', '--printed-page', '1'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(u2.exitCode).toBe(2);
    const u3 = await invokeIa(['lookup', itemId], { cacheDir: tmpdir, fetchImpl });
    expect(u3.exitCode).toBe(2);
    expect(seen).toEqual([]);
  });
});

describe('archive-org native client: hardening', () => {
  it('16. grep retries 429, 500, 503, IncompleteRead, and HTTP-date Retry-After', async () => {
    const itemId = 'synthetic_retry_gazetteer_1885';
    const fakeMeta = {
      metadata: { identifier: itemId, title: 'Retry Gazetteer' },
      files: [
        { name: `${itemId}_scandata.xml`, format: 'Scandata' },
        { name: `${itemId}_djvu.txt`, format: 'DjVuTXT' },
      ],
    };
    const fakeDjvu = Buffer.from(
      ['', 'Cover', 'Title', 'Intro', 'Harriet Tubman spoke at Oakridge.', 'Closing'].join('\x0c'),
      'utf8'
    );

    const counts = { meta: 0, scandata: 0, djvu: 0 };
    const sleeps: number[] = [];
    const fixedNow = Date.UTC(2026, 4, 1, 12, 0, 0);
    const futureDate = new Date(fixedNow + 2000).toUTCString();

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(`/metadata/${itemId}`)) {
        counts.meta += 1;
        if (counts.meta === 1) {
          return bytesResponse('', 429, { 'Retry-After': '1.25' });
        }
        return bytesResponse(JSON.stringify(fakeMeta));
      }
      if (url.endsWith(`/${itemId}_scandata.xml`)) {
        counts.scandata += 1;
        if (counts.scandata === 1) {
          return bytesResponse('', 503, { 'Retry-After': futureDate });
        }
        return bytesResponse(SYNTHETIC_SCANDATA);
      }
      if (url.endsWith(`/${itemId}_djvu.txt`)) {
        counts.djvu += 1;
        if (counts.djvu === 1) {
          return bytesResponse('', 500);
        }
        if (counts.djvu === 2) {
          const err = new Error('IncompleteRead: partial');
          err.name = 'IncompleteRead';
          throw err;
        }
        return bytesResponse(fakeDjvu);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tmpdir = await makeTempDir();
    const r1 = await invokeIa(['grep', itemId, '-e', 'Harriet Tubman', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      nowMs: () => fixedNow,
    });
    expect(r1.exitCode).toBe(0);
    const out1 = JSON.parse(r1.stdout) as {
      cache_hit: boolean;
      total_matches: number;
      hits: { printed_page: string }[];
    };
    expect(out1.cache_hit).toBe(false);
    expect(out1.total_matches).toBe(1);
    expect(out1.hits[0].printed_page).toBe('1');
    expect(counts).toEqual({ meta: 2, scandata: 2, djvu: 3 });
    expect(sleeps).toHaveLength(4);
    expect(sleeps.every((s) => s >= 0 && s <= MAX_RETRY_AFTER_SECONDS * 1000)).toBe(true);

    // Second call hits disk cache with zero HTTP attempts.
    const r2 = await invokeIa(['grep', itemId, '-e', 'Oakridge', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      nowMs: () => fixedNow,
    });
    expect(r2.exitCode).toBe(0);
    const out2 = JSON.parse(r2.stdout) as typeof out1;
    expect(out2.cache_hit).toBe(true);
    expect(out2.total_matches).toBe(1);
    expect(counts).toEqual({ meta: 2, scandata: 2, djvu: 3 });
  });

  it('17. grep handles aliases, zero matches, non-UTF-8, corrupt scandata, and partial batch', async () => {
    const goodId = 'synthetic_good_almanac_1870';
    const badId = 'synthetic_borrow_only_1871';
    const corruptXml = Buffer.from('<html><body>503 Service Unavailable</body></html>', 'utf8');
    const metaBytes = Buffer.concat([
      Buffer.from(`{"metadata":{"identifier":"${goodId}","title":"Almanac `, 'ascii'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(
        `"},"files":[{"name":"${goodId}_SCANDATA.XML","format":"Scandata"},{"name":"${goodId}_DJVU.TXT","format":"DjVuTXT"}]}`,
        'ascii'
      ),
    ]);
    const djvuBytes = Buffer.concat([
      Buffer.from('Page zero ', 'ascii'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(' Frederick Douglass\x0cPage one Clara Barton', 'ascii'),
    ]);

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(`/metadata/${goodId}`)) {
        return bytesResponse(metaBytes);
      }
      if (url.endsWith(`/${goodId}_SCANDATA.XML`)) {
        return bytesResponse(corruptXml);
      }
      if (url.endsWith(`/${goodId}_DJVU.TXT`)) {
        return bytesResponse(djvuBytes);
      }
      if (url.endsWith(`/metadata/${badId}`)) {
        return bytesResponse('', 403);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tmpdir = await makeTempDir();
    const r1 = await invokeIa(
      ['grep', goodId, badId, '-e', 'Douglass', '-e', 'Barton', '-C', '80', '-m', '10', '--json'],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(r1.exitCode).toBe(0);
    const payload = JSON.parse(r1.stdout) as {
      total_matches: number;
      cache_hit: boolean;
      errors: { identifier: string; error: string }[];
    };
    expect(payload.total_matches).toBe(2);
    expect(payload.cache_hit).toBe(false);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].identifier).toBe(badId);
    expect(payload.errors[0].error).toContain('HTTP 403');
    expect(fs.existsSync(path.join(tmpdir, goodId, 'scandata.xml'))).toBe(false);

    // Zero-match grep exits 0 cleanly and reports cache_hit: true.
    const rZero = await invokeIa(['grep', goodId, '-e', 'NonexistentTermXYZ', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rZero.exitCode).toBe(0);
    const zeroPayload = JSON.parse(rZero.stdout) as {
      total_matches: number;
      returned: number;
      hits: unknown[];
      cache_hit: boolean;
    };
    expect(zeroPayload.total_matches).toBe(0);
    expect(zeroPayload.returned).toBe(0);
    expect(zeroPayload.hits).toEqual([]);
    expect(zeroPayload.cache_hit).toBe(true);

    // Zero-width regex yields 0 matches instead of infinite loop or matching every boundary.
    const rZw = await invokeIa(['grep', goodId, '--pattern', '^', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rZw.exitCode).toBe(0);
    expect((JSON.parse(rZw.stdout) as { total_matches: number }).total_matches).toBe(0);

    // All-failing batch exits 1.
    const rFail = await invokeIa(['grep', badId, '--pattern', 'Douglass', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rFail.exitCode).toBe(1);
  });

  it('18. page JSON emits boolean cache_hit with dedup and --out-dir alias', async () => {
    const itemId = 'synthetic_page_telemetry_1890';
    const seen: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      const match = /\/page\/n(\d+)_/.exec(url);
      if (!match) {
        throw new Error(`Unexpected URL: ${url}`);
      }
      return bytesResponse(
        Buffer.concat([Buffer.from([0xff, 0xd8, Number.parseInt(match[1], 10)]), Buffer.alloc(32, 0x11)])
      );
    };

    const tmpdir = await makeTempDir();
    const outDir = path.join(tmpdir, 'out');

    // Single-page via --leaves with duplicate leaf deduplicates to 1 fetch.
    const r1 = await invokeIa(['page', itemId, '--leaves', '4,4', '--out-dir', outDir, '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r1.exitCode).toBe(0);
    const p1 = JSON.parse(r1.stdout) as { cache_hit: boolean; leaf: number };
    expect(p1.cache_hit).toBe(false);
    expect(p1.leaf).toBe(4);
    expect(seen).toHaveLength(1);

    // Repeat single-page hits cache.
    const r2 = await invokeIa(['page', itemId, '--leaf', '4', '--out-dir', outDir, '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r2.exitCode).toBe(0);
    const p2 = JSON.parse(r2.stdout) as typeof p1;
    expect(p2.cache_hit).toBe(true);
    expect(seen).toHaveLength(1);

    // Multi-page partial hit (leaf 4 cached, leaf 5 uncached) -> cache_hit is false.
    const r3 = await invokeIa(['page', itemId, '--leaves', '4,5,4', '-o', outDir, '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r3.exitCode).toBe(0);
    const p3 = JSON.parse(r3.stdout) as {
      cache_hit: boolean;
      pages: { leaf: number; page_cached: boolean }[];
    };
    expect(p3.cache_hit).toBe(false);
    expect(p3.pages.map((p) => p.leaf)).toEqual([4, 5]);
    expect(p3.pages.map((p) => p.page_cached)).toEqual([true, false]);
    expect(seen).toHaveLength(2);

    // Repeat multi-page -> cache_hit is true and zero new HTTP calls.
    const r4 = await invokeIa(['page', itemId, '--leaves', '4-5', '-o', outDir, '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(r4.exitCode).toBe(0);
    const p4 = JSON.parse(r4.stdout) as typeof p3;
    expect(p4.cache_hit).toBe(true);
    expect(p4.pages.map((p) => p.page_cached)).toEqual([true, true]);
    expect(seen).toHaveLength(2);
  });

  it('19. broken pipe exits zero', async () => {
    const tmpdir = await makeTempDir();
    const res = await invokeIa(['url', 'title:(Oakridge)'], {
      cacheDir: tmpdir,
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
      stdoutOverride: () => {
        const err = new Error('Broken pipe') as NodeJS.ErrnoException;
        err.code = 'EPIPE';
        throw err;
      },
    });
    expect(res.exitCode).toBe(0);
  });

  it('20. search aliases, multiword, collection, metadata alias, and transient outage recovery', async () => {
    const seenUrls: string[] = [];
    const searchPayload = {
      responseHeader: { status: 0 },
      response: {
        numFound: 1,
        docs: [
          {
            identifier: 'oakridge_history_1880',
            title: 'Oakridge County History',
            creator: 'Alder',
            date: '1880',
            mediatype: 'texts',
          },
        ],
      },
    };
    const metaPayload = {
      metadata: { identifier: 'oakridge_history_1880', title: 'Oakridge County History' },
      files: [{ name: 'oakridge_history_1880.pdf', format: 'Text PDF', size: '42' }],
    };

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes('/metadata/oakridge_history_1880')) {
        return bytesResponse(JSON.stringify(metaPayload));
      }
      if (url.includes('advancedsearch.php')) {
        return bytesResponse(JSON.stringify(searchPayload));
      }
      if (url.includes('page_production')) {
        return bytesResponse(
          JSON.stringify({
            response: {
              body: {
                hits: {
                  total: 1,
                  hits: [
                    {
                      fields: { identifier: 'oakridge_history_1880', title: 'Oakridge' },
                      highlight: { text: ['Oakridge'] },
                    },
                  ],
                },
              },
            },
          })
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tmpdir = await makeTempDir();

    // Multi-word positional query + -n/--limit + --collection + --type + --fields CSV.
    const rSearch = await invokeIa(
      [
        'search',
        'Oakridge',
        'county',
        'history',
        '-n',
        '5',
        '--page',
        '2',
        '--collection',
        'americana',
        '--type',
        'texts',
        '--fields',
        'identifier,title',
        '--json',
      ],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(rSearch.exitCode).toBe(0);
    const body = JSON.parse(rSearch.stdout) as { cache_hit: boolean; response: { numFound: number } };
    expect(body.cache_hit).toBe(false);
    expect(body.response.numFound).toBe(1);
    const reqUrl = seenUrls[seenUrls.length - 1];
    expect(reqUrl).toContain('rows=5');
    expect(reqUrl).toContain('page=2');
    expect(reqUrl).toContain(
      'Oakridge+county+history+AND+mediatype%3A%28texts%29+AND+collection%3A%28americana%29'
    );
    expect(reqUrl).toContain('fl%5B%5D=identifier');
    expect(reqUrl).toContain('fl%5B%5D=title');

    // Equivalent invocation via --limit and -q hits disk cache with zero HTTP calls.
    const rHit = await invokeIa(
      [
        'search',
        '-q',
        'Oakridge county history',
        '--limit',
        '5',
        '--page',
        '2',
        '--collection',
        'americana',
        '--mediatype',
        'texts',
        '--field',
        'identifier',
        '--field',
        'title',
        '--json',
      ],
      { cacheDir: tmpdir, fetchImpl }
    );
    expect(rHit.exitCode).toBe(0);
    expect((JSON.parse(rHit.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(seenUrls).toHaveLength(1);

    // fulltext accepts multi-word query and --limit.
    const rFt = await invokeIa(['fulltext', 'Oakridge', 'Mill', '--limit', '3', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rFt.exitCode).toBe(0);
    expect((JSON.parse(rFt.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(seenUrls[seenUrls.length - 1]).toContain('hits_per_page=3');

    // metadata subcommand alias maps to get.
    const rMeta = await invokeIa(['metadata', 'oakridge_history_1880', '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rMeta.exitCode).toBe(0);
    const metaOut = JSON.parse(rMeta.stdout) as { metadata: { title: string }; cache_hit: boolean };
    expect(metaOut.metadata.title).toBe('Oakridge County History');
    expect(metaOut.cache_hit).toBe(false);

    // Invalid --rows and empty query exit 2 with no HTTP requests.
    const before = seenUrls.length;
    for (const badArgv of [['search'], ['search', 'Oak', '--limit', '0'], ['search', 'Oak', '--page', '0']]) {
      const rBad = await invokeIa(badArgv, { cacheDir: tmpdir, fetchImpl });
      expect(rBad.exitCode).toBe(2);
    }
    expect(seenUrls).toHaveLength(before);

    // Transient HTML outage page + timeout recover cleanly on 3rd attempt.
    const tmpFlaky = await makeTempDir();
    const sleeps: number[] = [];
    let flakyIdx = 0;
    const flakyFetch: typeof fetch = async () => {
      const current = flakyIdx;
      flakyIdx += 1;
      if (current === 0) {
        return bytesResponse('<!DOCTYPE html><html><body>Temporarily Offline</body></html>');
      }
      if (current === 1) {
        throw new Error('The read operation timed out');
      }
      return bytesResponse(JSON.stringify(searchPayload));
    };

    const rOk = await invokeIa(['search', 'title:(Oakridge)', '--json'], {
      cacheDir: tmpFlaky,
      fetchImpl: flakyFetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(rOk.exitCode).toBe(0);
    expect(flakyIdx).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect((JSON.parse(rOk.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    // Persistent HTML outage or Solr error JSON fails with exit 1 and writes NOTHING to cache.
    const tmpOutage = await makeTempDir();
    for (const badBody of [
      '<!DOCTYPE html><html><body>503 Outage</body></html>',
      '{"responseHeader":{"status":500},"error":"backend error"}',
      '{truncated-json',
    ]) {
      const rOutage = await invokeIa(['search', 'title:(OutageTest)', '--json'], {
        cacheDir: tmpOutage,
        fetchImpl: async () => bytesResponse(badBody),
      });
      expect(rOutage.exitCode).toBe(1);
      const searchCacheDir = path.join(tmpOutage, '_queries', 'search');
      const entries = fs.existsSync(searchCacheDir)
        ? fs.readdirSync(searchCacheDir).filter((f) => f.endsWith('.json'))
        : [];
      expect(entries).toEqual([]);
    }

    // IncompleteRead on search recovers cleanly.
    const tmpInc = await makeTempDir();
    let incCalls = 0;
    const rInc = await invokeIa(['search', 'title:(Oakridge)', '--json'], {
      cacheDir: tmpInc,
      fetchImpl: async () => {
        incCalls += 1;
        if (incCalls === 1) {
          const err = new Error('IncompleteRead: partial');
          err.name = 'IncompleteRead';
          throw err;
        }
        return bytesResponse(JSON.stringify(searchPayload));
      },
    });
    expect(rInc.exitCode).toBe(0);
    expect(incCalls).toBe(2);
  });

  it('21. text and grep CLI aliases, leaf n-prefix, and URL identifiers', async () => {
    const itemId = 'synthetic_wave45_book_1895';
    const fakeMeta = {
      metadata: { identifier: itemId, title: 'Wave 45 Synthetic Book' },
      files: [
        { name: `${itemId}_scandata.xml`, format: 'Scandata' },
        { name: `${itemId}_djvu.txt`, format: 'DjVuTXT' },
      ],
    };
    const fakeDjvu = Buffer.from(SYNTHETIC_TEXT_PAGES.join('\x0c'), 'utf8');

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(`/metadata/${itemId}`)) {
        return bytesResponse(JSON.stringify(fakeMeta));
      }
      if (url.endsWith(`/${itemId}_scandata.xml`)) {
        return bytesResponse(SYNTHETIC_SCANDATA);
      }
      if (url.endsWith(`/${itemId}_djvu.txt`)) {
        return bytesResponse(fakeDjvu);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tmpdir = await makeTempDir();

    // `show` aliases `get` and accepts full archive.org/details/<id> URLs.
    const rShow = await invokeIa(['show', `https://archive.org/details/${itemId}`, '--json'], {
      cacheDir: tmpdir,
      fetchImpl,
    });
    expect(rShow.exitCode).toBe(0);
    expect((JSON.parse(rShow.stdout) as { metadata: { identifier: string } }).metadata.identifier).toBe(
      itemId
    );

    // `text`: --page / -p, --printed-pages comma list, --leaf n3, --leaves n2-n3, --item, positional page/leaf.
    const textCases: readonly (readonly [readonly string[], readonly number[]])[] = [
      [['text', itemId, '--page', '1', '--json'], [3]],
      [['text', itemId, '-p', 'iv', '--json'], [2]],
      [
        ['text', itemId, '--printed-pages', 'iv,2', '--json'],
        [2, 4],
      ],
      [['text', itemId, '--leaf', 'n3', '--json'], [3]],
      [
        ['text', itemId, '--leaves', 'n2-n3', '--json'],
        [2, 3],
      ],
      [['text', '--item', itemId, '--page', '2', '--json'], [4]],
      [['text', itemId, 'n4', '--json'], [4]],
      [
        ['text', itemId, '1-2', '--json'],
        [3, 4],
      ],
    ];
    for (const [argv, expectedLeaves] of textCases) {
      const res = await invokeIa(argv, { cacheDir: tmpdir, fetchImpl });
      expect(res.exitCode).toBe(0);
      const pages = (JSON.parse(res.stdout) as { pages: { leaf: number }[] }).pages;
      expect(pages.map((p) => p.leaf)).toEqual(expectedLeaves);
    }

    // `grep`: -q / --query / --regex, -n / --max, --item / --id, and positional pattern disambiguation.
    const grepCases: readonly (readonly string[])[] = [
      ['grep', itemId, '-q', 'Clara Barton', '-n', '5', '--json'],
      ['grep', '--item', itemId, '--regex', 'Clara Barton', '--max', '5', '--json'],
      ['grep', itemId, 'Clara Barton', '--json'],
      ['grep', 'Clara Barton', `https://archive.org/details/${itemId}`, '--json'],
      ['grep', '--id', itemId, 'Clara Barton', '--json'],
    ];
    for (const argv of grepCases) {
      const res = await invokeIa(argv, { cacheDir: tmpdir, fetchImpl });
      expect(res.exitCode).toBe(0);
      const payload = JSON.parse(res.stdout) as {
        total_matches: number;
        hits: { printed_page: string }[];
      };
      expect(payload.total_matches).toBe(1);
      expect(payload.hits[0].printed_page).toBe('iv');
    }

    // `grep` with no pattern exits 2 with a helpful hint.
    const rNoPattern = await invokeIa(['grep', itemId], { cacheDir: tmpdir, fetchImpl });
    expect(rNoPattern.exitCode).toBe(2);
    expect(rNoPattern.stderr).toContain('--pattern');
  });

  it('22. enforces archive.org host allowlist and blocks unsafe redirects (SSRF guard)', async () => {
    const ctxBlocked = createRecordContext({
      fetchImpl: async () => bytesResponse('should never be reached'),
      sleepFn: async () => {},
    });
    await expect(
      httpGetBytesIa('https://169.254.169.254/latest/meta-data/', ctxBlocked)
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(httpGetBytesIa('https://evil.example.com/metadata/demo', ctxBlocked)).rejects.toBeInstanceOf(
      SsrfBlockedError
    );

    // Redirect to evil host is blocked; redirect to ia801405.us.archive.org is allowed.
    const ctxBadRedirect = createRecordContext({
      fetchImpl: async () => bytesResponse('', 302, { Location: 'https://evil.example.com/stolen' }),
      sleepFn: async () => {},
    });
    await expect(
      httpGetBytesIa('https://archive.org/download/demo/file.txt', ctxBadRedirect)
    ).rejects.toBeInstanceOf(SsrfBlockedError);

    const ctxGoodRedirect = createRecordContext({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === 'https://archive.org/download/demo/file.txt') {
          return bytesResponse('', 302, {
            Location: 'https://ia801405.us.archive.org/22/items/demo/file.txt',
          });
        }
        return bytesResponse('redirected-ok', 200);
      },
      sleepFn: async () => {},
    });
    const redirected = await httpGetBytesIa('https://archive.org/download/demo/file.txt', ctxGoodRedirect);
    expect(redirected.toString('utf8')).toBe('redirected-ok');
  });

  it('supports archive-org pages alias with --pages, --out-dir, --scale, --concurrency, and skip-if-cached resume', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    const outDir = path.join(tmp, 'out');
    const itemId = 'demo_batch_book';
    const fakeMeta = {
      metadata: { identifier: itemId, title: 'Demo Batch Book' },
      files: [{ name: `${itemId}_scandata.xml`, format: 'Scandata' }],
    };
    const fakeScandata = `<?xml version="1.0" encoding="UTF-8"?>
<book><pageData>
  <page leafNum="0"><pageType>Cover</pageType><addToAccessFormats>true</addToAccessFormats></page>
  <page leafNum="1"><pageType>Normal</pageType><pageNumber>1</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
  <page leafNum="2"><pageType>Normal</pageType><pageNumber>2</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
  <page leafNum="3"><pageType>Normal</pageType><pageNumber>3</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
  <page leafNum="4"><pageType>Normal</pageType><pageNumber>4</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
  <page leafNum="5"><pageType>Normal</pageType><pageNumber>5</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
</pageData></book>`;

    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const fetchedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/metadata/')) {
        return bytesResponse(JSON.stringify(fakeMeta), 200, { 'content-type': 'application/json' });
      }
      if (url.endsWith(`/${itemId}_scandata.xml`)) {
        return bytesResponse(fakeScandata, 200, { 'content-type': 'application/xml' });
      }
      fetchedUrls.push(url);
      return bytesResponse(jpegBytes, 200, { 'content-type': 'image/jpeg' });
    };

    const run1 = await invokeIa(
      [
        'pages',
        itemId,
        '--pages',
        '1-3,5',
        '--out-dir',
        outDir,
        '--scale',
        '4',
        '--concurrency',
        '4',
        '--json',
      ],
      { cacheDir: cacheRoot, fetchImpl }
    );
    expect(run1.exitCode, run1.stderr).toBe(0);
    const body1 = JSON.parse(run1.stdout) as {
      count: number;
      cache_hit: boolean;
      pages: Array<{ leaf: number; path: string; page_cached: boolean }>;
    };
    expect(body1.count).toBe(4);
    expect(body1.cache_hit).toBe(false);
    expect(body1.pages.map((p) => p.leaf)).toEqual([1, 2, 3, 5]);
    expect(fetchedUrls).toHaveLength(4);
    expect(fetchedUrls.every((u) => u.includes('_s4.jpg'))).toBe(true);
    for (const p of body1.pages) {
      expect(fs.existsSync(p.path)).toBe(true);
    }

    // Second run resumes cleanly from disk cache with 0 new HTTP fetches
    const run2 = await invokeIa(
      [
        'pages',
        itemId,
        '--pages',
        '1-3,5',
        '--out-dir',
        outDir,
        '--scale',
        '4',
        '--concurrency',
        '4',
        '--json',
      ],
      { cacheDir: cacheRoot, fetchImpl }
    );
    expect(run2.exitCode, run2.stderr).toBe(0);
    const body2 = JSON.parse(run2.stdout) as { count: number; cache_hit: boolean };
    expect(body2.count).toBe(4);
    expect(body2.cache_hit).toBe(true);
    expect(fetchedUrls).toHaveLength(4);

    // Invalid --concurrency exits 2
    const badConc = await invokeIa(
      ['pages', itemId, '--pages', '1', '--out-dir', outDir, '--concurrency', '99'],
      { cacheDir: cacheRoot, fetchImpl }
    );
    expect(badConc.exitCode).toBe(2);
    expect(badConc.stderr).toContain('--concurrency');
  });
});
