import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../../runtime/index.js';
import { runFiArchivesCommand } from '../fi-archives.js';
import {
  classifyAstiaImageExtension,
  parseAstiaFolderHtml,
  parseAstiaFolderJson,
  parseAstiaFolderRef,
  parseAstiaPageSpec,
} from './astia.js';

const JPEG_ONE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]);
const PNG_TWO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF\n');
const TIFF_LE_BYTES = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]);
const TIFF_BE_BYTES = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x08]);
const JP2_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20]);

const IIIF_V2_MANIFEST = {
  label: 'Turun rippikirja 1800-1810',
  sequences: [
    {
      canvases: [
        'not-an-object',
        { label: 'Missing image' },
        {
          '@id': 'https://astia.narc.fi/canvas/1',
          label: 'Kuva 1',
          thumbnail: { '@id': 'https://astia.narc.fi/thumbs/1.jpg' },
          images: [{ resource: { '@id': 'https://astia.narc.fi/scans/1.jpg' } }],
        },
        {
          label: null,
          thumbnail: 'https://astia.narc.fi/thumbs/2.png',
          images: [{ resource: { id: 'https://astia.narc.fi/scans/2.png' } }],
        },
      ],
    },
  ],
};

const IIIF_V3_MANIFEST = {
  label: { fi: ['V3 Folder'] },
  items: [
    'skip',
    { id: 'empty-item' },
    {
      id: 'canvas-1',
      label: { fi: ['Sivu 1'] },
      items: [{ items: [{ body: { id: 'https://astia.narc.fi/scans/v3-1.jpg' } }] }],
    },
  ],
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-fi-astia-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeFi(
  args: readonly string[],
  cacheDir: string,
  fetchImpl?: typeof fetch
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cacheHit?: boolean | undefined;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_FI_ARCHIVES_CACHE_DIR: cacheDir },
    cwd: cacheDir,
    fetchImpl: fetchImpl ?? (async () => new Response('not found', { status: 404 })),
    sleepFn: async () => {},
  });
  const outcome = await runFiArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('kinloom fi-archives astia', () => {
  it('renders help and exits 0', async () => {
    const cacheDir = await makeTempDir();
    const res = await invokeFi(['astia', '--help'], cacheDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('kinloom fi-archives astia <folder-id-or-url>');
  });

  it('lists Astia IIIF folder scans with caching and downloads selected scans into --out-dir', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'downloads');
    const calls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/manifest')) {
        return new Response(JSON.stringify(IIIF_V2_MANIFEST), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/1.jpg')) {
        return new Response(new Uint8Array(JPEG_ONE), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      if (url.endsWith('/2.png')) {
        return new Response(new Uint8Array(PNG_TWO), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const list1 = await invokeFi(
      ['astia', '1299923671', '--list', '--limit', '1', '--json'],
      cacheDir,
      fetchImpl
    );
    expect(list1.exitCode, list1.stderr).toBe(0);
    const pList1 = JSON.parse(list1.stdout) as {
      folder_id: string;
      total_scans: number;
      returned: number;
      cache_hit: boolean;
    };
    expect(pList1.folder_id).toBe('1299923671');
    expect(pList1.total_scans).toBe(2);
    expect(pList1.returned).toBe(1);
    expect(pList1.cache_hit).toBe(false);

    const list2 = await invokeFi(
      ['astia', 'https://astia.narc.fi/uusiastia/kortti_aineisto.html?id=1299923671'],
      cacheDir,
      fetchImpl
    );
    expect(list2.exitCode).toBe(0);
    expect(list2.cacheHit).toBe(true);
    expect(list2.stdout).toContain('[cache]');
    expect(list2.stdout).toContain('Kuva 1');
    expect(calls).toHaveLength(1);

    const dl1 = await invokeFi(
      ['astia', '1299923671', '--pages', '1-2', '--out-dir', outDir, '--json'],
      cacheDir,
      fetchImpl
    );
    expect(dl1.exitCode, dl1.stderr).toBe(0);
    expect(calls).toHaveLength(3);
    const pDl1 = JSON.parse(dl1.stdout) as {
      downloaded: number;
      cache_hit: boolean;
      files: Array<{ path: string; bytes: number; cache_hit: boolean }>;
    };
    expect(pDl1.downloaded).toBe(2);
    expect(pDl1.cache_hit).toBe(false);
    expect(fs.existsSync(pDl1.files[0]!.path)).toBe(true);
    expect(fs.existsSync(pDl1.files[1]!.path)).toBe(true);

    const dl2 = await invokeFi(['astia', '1299923671', '--pages', '1', '--out', outDir], cacheDir, fetchImpl);
    expect(dl2.exitCode).toBe(0);
    expect(calls).toHaveLength(3);
    expect(dl2.cacheHit).toBe(true);
    expect(dl2.stdout).toContain('[cache]');
  });

  it('parses IIIF v3/flat JSON, HTML folder pages, image magic types, and rejects invalid inputs', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'out');

    const v3 = parseAstiaFolderJson(
      IIIF_V3_MANIFEST,
      '100',
      'https://astia.narc.fi/uusiastia/digitized/iiif/100/manifest'
    );
    expect(v3.title).toBe('V3 Folder');
    expect(v3.scans).toHaveLength(1);

    const flatFiles = parseAstiaFolderJson(
      {
        files: [
          {
            file_id: 'f1',
            name: 'File 1',
            url: 'https://astia.narc.fi/scans/f1.jpg',
            thumbnail_url: 'https://astia.narc.fi/t/f1.jpg',
          },
        ],
      },
      '101',
      'https://astia.narc.fi/uusiastia/files.json'
    );
    expect(flatFiles.title).toBe('Astia 101');
    expect(flatFiles.scans[0]?.file_id).toBe('f1');
    expect(() => parseAstiaFolderJson([], '101', 'https://astia.narc.fi/x')).toThrow();

    const htmlParsed = parseAstiaFolderHtml(
      '<html><body><a href="/about">About</a><a href="/scans/p1.jpg" title="Page One">Open</a><a href="/scans/p1.jpg">Dup</a><img src="/scans/p2.png" alt="Img Two" /><a href="/viewer?fileId=99"></a></body></html>',
      '200',
      'https://astia.narc.fi/uusiastia/viewer/?aineistoId=200'
    );
    expect(htmlParsed.title).toBe('Astia 200');
    expect(htmlParsed.scans).toHaveLength(3);
    expect(htmlParsed.scans[0]?.label).toBe('Page One');
    expect(htmlParsed.scans[1]?.label).toBe('Img Two');
    expect(htmlParsed.scans[2]?.label).toBe('Page 3');

    expect(
      parseAstiaFolderRef('https://astia.narc.fi/uusiastia/digitized/iiif/12345/manifest').folderId
    ).toBe('12345');
    expect(parseAstiaFolderRef('https://astia.narc.fi/uusiastia/viewer/?fileId=7777').folderId).toBe('7777');
    expect(
      parseAstiaFolderRef('https://astia.narc.fi/uusiastia/digitized/iiif/meta.json?id=5555').manifestUrl
    ).toContain('meta.json');
    expect(() => parseAstiaFolderRef('https://astia.narc.fi/')).toThrow();
    expect(() => parseAstiaFolderRef('')).toThrow();
    expect(() => parseAstiaFolderRef('bad/id!')).toThrow();

    expect(parseAstiaPageSpec('all', 3)).toEqual([1, 2, 3]);
    expect(parseAstiaPageSpec('1,,3', 3)).toEqual([1, 3]);
    expect(() => parseAstiaPageSpec('5-2', 3)).toThrow();
    expect(() => parseAstiaPageSpec('4', 3)).toThrow();
    expect(() => parseAstiaPageSpec('abc', 3)).toThrow();

    expect(classifyAstiaImageExtension(PDF_BYTES, 'application/pdf')).toBe('pdf');
    expect(classifyAstiaImageExtension(TIFF_LE_BYTES, 'image/tiff')).toBe('tif');
    expect(classifyAstiaImageExtension(TIFF_BE_BYTES, 'image/tiff')).toBe('tif');
    expect(classifyAstiaImageExtension(JP2_BYTES, 'image/jp2')).toBe('jp2');
    expect(() => classifyAstiaImageExtension(Buffer.alloc(0), 'image/jpeg')).toThrow(/empty/);
    expect(() => classifyAstiaImageExtension(Buffer.from('RANDOM_BYTES'), '')).toThrow(/not a recognized/);

    const badHost = await invokeFi(['astia', 'https://evil.example.com/123'], cacheDir);
    expect(badHost.exitCode).toBe(2);

    const htmlScanErr = await invokeFi(['astia', '999', '--out-dir', outDir], cacheDir, async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest')) {
        return new Response(
          JSON.stringify({ scans: [{ label: 'S1', image_url: 'https://astia.narc.fi/scans/html.jpg' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('<!DOCTYPE html><html><body>Login</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    expect(htmlScanErr.exitCode).toBe(1);
    expect(htmlScanErr.stderr).toContain('HTML instead of a scan image');

    const emptyFolder = await invokeFi(
      ['astia', '888', '--out-dir', outDir],
      cacheDir,
      async () =>
        new Response('<html><body>No scans</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    );
    expect(emptyFolder.exitCode).toBe(1);
    expect(emptyFolder.stderr).toContain('No digitized scans found');
  });
});
