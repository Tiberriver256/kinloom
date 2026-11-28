import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError } from '../../errors.js';
import { runArchiveOrgCommand } from './clients/archive-org.js';
import {
  ensureItemCache,
  ensureItemMetadata,
  reuseExistingItemArtifact,
} from './clients/archiveOrg/itemCache.js';
import { findItemFile, parseScandataXml, synthesizeDjvuFromHocr } from './clients/archiveOrg/itemParsers.js';
import {
  grepCachedItem,
  leafFromScandataLeaf,
  parseLeafSpec,
  parsePrintedPageSpec,
  parsePrintedRange,
  resolvePrintedPageToLeaf,
  resolveSearchQuery,
  segmentForLeaf,
  validateLeafInIndex,
} from './clients/archiveOrg/pageAndGrep.js';
import { cachedQueryJson, httpGetBytesIa, httpGetJsonIa } from './clients/archiveOrg/transport.js';
import { ArchiveNotFoundError, type PageIndex } from './clients/archiveOrg/types.js';
import { cachedGetJson, fetchFollowingLocRedirects, isTimeoutError } from './clients/chronam/httpFetch.js';
import {
  buildSearchParams,
  cachedDownloadBytes,
  cachedDownloadFile,
  detectInvalidDownload,
  extractSeqFromUrl,
  getJson,
  iiifJpegFromInfo,
  resolveDates,
  resolvePageAssets,
  resolveSafeChild,
  runChronamCommand,
  safeOutputFilename,
  streamDownloadToPath,
  validateLocUrl,
} from './clients/chronam.js';
import { compactBib, parseHathiId, runHathiCommand } from './clients/hathi.js';
import { runNarrativeAudioCommand } from './clients/narrative-audio.js';
import {
  countWords,
  defaultMp3Path,
  inferAudioMimeType,
  intToWords,
  ordinal,
  parseNarrativesYaml,
  stripWavHeader,
} from './clients/narrativeAudio/script.js';
import {
  encodePcmToMp3,
  findExecutableOnPath,
  defaultExecFile as naDefaultExecFile,
  postJsonWithRetries,
  readNamesJson,
  requireExistingFile,
  resolveCloudTtsHeaders,
  resolveGeminiApiKey,
  synthesizeWithChirp,
  synthesizeWithGemini,
} from './clients/narrativeAudio/synthesis.js';
import { parseOcrArgs, parseOcrBatchArgs } from './clients/ocr/cliArgs.js';
import {
  preparePrintedImage,
  runCursiveCliOcr,
  runCursiveGeminiOcr,
  runCursiveOcr,
  runPrintedOcr,
} from './clients/ocr/engines.js';
import {
  inferImageMimeType,
  parseTesseractTsv,
  readImageDimensions,
  readJpegDimensions,
  readTiffDimensions,
  rescaleTesseractTsv,
  validateImageFile,
} from './clients/ocr/imageAndTsv.js';
import { expandBatchInputs } from './clients/ocr/pipeline.js';
import { runLayoutData, runOcrData } from './clients/ocr/singleRunner.js';
import {
  createDefaultExecFile,
  resolveExecutable,
  runSubprocessWithTimeout,
} from './clients/ocr/subprocess.js';
import { InputImageError, OcrTimeoutError } from './clients/ocr/types.js';
import { runOcrCommand } from './clients/ocr.js';
import {
  clampBox,
  coalesceRanges,
  parseBox,
  parsePageSpec,
  parseRgbColor,
  runPrepScanCommand,
} from './clients/prep-scan.js';
import { expandMultiBoxArgs, normalizeRotationAngle } from './clients/prepScan/geometry.js';
import {
  createRecordContext,
  createSyntheticPng,
  type ExecFileFn,
  type RecordCommandContext,
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

async function makeTempDir(prefix = 'kinloom-c5-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(
  overrides: { [K in keyof RecordCommandContext]?: RecordCommandContext[K] | undefined } = {}
): {
  readonly ctx: RecordCommandContext;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    sleepFn: async () => {},
    ...overrides,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  });
  return { ctx, stdout, stderr };
}

function makeMinimalJpeg(width: number, height: number, sofMarker = 0xc0): Buffer {
  // SOI + APP0 (4 bytes payload) + fill byte + RST0 + SOF segment + EOI
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]);
  const rst0 = Buffer.from([0x00, 0xff, 0xff, 0xd0]);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = sofMarker;
  sof.writeUInt16BE(9, 2); // segLen
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  sof[10] = 1;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, rst0, sof, Buffer.from([0xff, 0xd9])]);
}

function makeMinimalTiff(width: number, height: number, littleEndian: boolean, fieldType: 3 | 4): Buffer {
  const buf = Buffer.alloc(8 + 2 + 24);
  if (littleEndian) {
    buf[0] = 0x49;
    buf[1] = 0x49;
    buf[2] = 0x2a;
    buf[3] = 0x00;
    buf.writeUInt32LE(8, 4);
    buf.writeUInt16LE(2, 8);
    // Entry 0: tag 256 (width)
    buf.writeUInt16LE(256, 10);
    buf.writeUInt16LE(fieldType, 12);
    buf.writeUInt32LE(1, 14);
    if (fieldType === 3) buf.writeUInt16LE(width, 18);
    else buf.writeUInt32LE(width, 18);
    // Entry 1: tag 257 (height)
    buf.writeUInt16LE(257, 22);
    buf.writeUInt16LE(fieldType, 24);
    buf.writeUInt32LE(1, 26);
    if (fieldType === 3) buf.writeUInt16LE(height, 30);
    else buf.writeUInt32LE(height, 30);
  } else {
    buf[0] = 0x4d;
    buf[1] = 0x4d;
    buf[2] = 0x00;
    buf[3] = 0x2a;
    buf.writeUInt32BE(8, 4);
    buf.writeUInt16BE(2, 8);
    buf.writeUInt16BE(256, 10);
    buf.writeUInt16BE(fieldType, 12);
    buf.writeUInt32BE(1, 14);
    if (fieldType === 3) buf.writeUInt16BE(width, 18);
    else buf.writeUInt32BE(width, 18);
    buf.writeUInt16BE(257, 22);
    buf.writeUInt16BE(fieldType, 24);
    buf.writeUInt32BE(1, 26);
    if (fieldType === 3) buf.writeUInt16BE(height, 30);
    else buf.writeUInt32BE(height, 30);
  }
  return buf;
}

function makeWebpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  const wm1 = width - 1;
  const hm1 = height - 1;
  buf[24] = wm1 & 0xff;
  buf[25] = (wm1 >> 8) & 0xff;
  buf[26] = (wm1 >> 16) & 0xff;
  buf[27] = hm1 & 0xff;
  buf[28] = (hm1 >> 8) & 0xff;
  buf[29] = (hm1 >> 16) & 0xff;
  return buf;
}

function makeWebpVp8Lossy(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

function makeWebpVp8l(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf.writeUInt32LE(bits >>> 0, 21);
  return buf;
}

function makeSyntheticWav(pcm: Buffer, sampleRate = 22050): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function createSolidPng(
  filePath: string,
  width: number,
  height: number,
  rgb: readonly [number, number, number]
): Promise<Buffer> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
    limitInputPixels: false,
  })
    .png()
    .toBuffer();
  await writeFile(filePath, buf);
  return buf;
}

// ============================================================================
// 1. OCR: imageAndTsv, cliArgs, engines, subprocess, pipeline, singleRunner
// ============================================================================

describe('ocr imageAndTsv behavioral coverage', () => {
  it('infers image MIME types from magic bytes and filename extension fallbacks', () => {
    expect(inferImageMimeType('scan.unknown', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe(
      'image/png'
    );
    expect(inferImageMimeType('scan.unknown', Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(inferImageMimeType('scan.unknown', Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary'))).toBe(
      'image/webp'
    );

    const opaque = Buffer.from('opaque-bytes');
    expect(inferImageMimeType('page.png', opaque)).toBe('image/png');
    expect(inferImageMimeType('page.webp', opaque)).toBe('image/webp');
    expect(inferImageMimeType('page.gif', opaque)).toBe('image/gif');
    expect(inferImageMimeType('page.tif', opaque)).toBe('image/tiff');
    expect(inferImageMimeType('page.tiff', opaque)).toBe('image/tiff');
    expect(inferImageMimeType('page.dat', opaque)).toBe('image/jpeg');
  });

  it('reads dimensions from JPEG, TIFF (LE/BE, SHORT/LONG), WebP (VP8X/VP8/VP8L), GIF, and BMP headers', () => {
    // JPEG SOF0 & SOF2 + malformed cases
    expect(readImageDimensions(makeMinimalJpeg(1280, 960, 0xc0))).toEqual([1280, 960]);
    expect(readJpegDimensions(makeMinimalJpeg(640, 480, 0xc2))).toEqual([640, 480]);
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]))).toBeNull();
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04, 0x08, 0x00]))).toBeNull();
    expect(readJpegDimensions(makeMinimalJpeg(0, 480))).toBeNull();
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull();

    // TIFF LE/BE, SHORT (3) and LONG (4) + malformed cases
    expect(readImageDimensions(makeMinimalTiff(1024, 768, true, 3))).toEqual([1024, 768]);
    expect(readImageDimensions(makeMinimalTiff(2048, 1536, true, 4))).toEqual([2048, 1536]);
    expect(readImageDimensions(makeMinimalTiff(800, 600, false, 3))).toEqual([800, 600]);
    expect(readImageDimensions(makeMinimalTiff(4096, 3072, false, 4))).toEqual([4096, 3072]);
    expect(readTiffDimensions(Buffer.from([0x49, 0x49, 0x2a]))).toBeNull();
    expect(readTiffDimensions(Buffer.from('NOPE0000'))).toBeNull();
    expect(readTiffDimensions(makeMinimalTiff(0, 600, true, 3))).toBeNull();
    const badIfd = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0xff, 0x00, 0x00, 0x00]);
    expect(readTiffDimensions(badIfd)).toBeNull();
    const truncEntry = Buffer.alloc(14);
    truncEntry.set([0x49, 0x49, 0x2a, 0x00], 0);
    truncEntry.writeUInt32LE(8, 4);
    truncEntry.writeUInt16LE(1, 8);
    expect(readTiffDimensions(truncEntry)).toBeNull();

    // WebP VP8X, VP8 lossy, VP8L lossless + unknown chunk
    expect(readImageDimensions(makeWebpVp8x(1920, 1080))).toEqual([1920, 1080]);
    expect(readImageDimensions(makeWebpVp8Lossy(640, 360))).toEqual([640, 360]);
    expect(readImageDimensions(makeWebpVp8l(512, 256))).toEqual([512, 256]);
    const unknownWebp = Buffer.alloc(30);
    unknownWebp.write('RIFF', 0, 'ascii');
    unknownWebp.write('WEBP', 8, 'ascii');
    unknownWebp.write('ANIM', 12, 'ascii');
    expect(readImageDimensions(unknownWebp)).toBeNull();

    // GIF87a & GIF89a
    const gif89 = Buffer.alloc(10);
    gif89.write('GIF89a', 0, 'ascii');
    gif89.writeUInt16LE(320, 6);
    gif89.writeUInt16LE(240, 8);
    expect(readImageDimensions(gif89)).toEqual([320, 240]);

    // BMP (negative height supported)
    const bmp = Buffer.alloc(26);
    bmp[0] = 0x42;
    bmp[1] = 0x4d;
    bmp.writeInt32LE(400, 18);
    bmp.writeInt32LE(-300, 22);
    expect(readImageDimensions(bmp)).toEqual([400, 300]);
  });

  it('validates image files and rejects missing, directory, empty, PDF, and HTML inputs', async () => {
    const dir = await makeTempDir();
    expect(() => validateImageFile(path.join(dir, 'missing.png'))).toThrow(InputImageError);
    expect(() => validateImageFile(dir)).toThrow(/not a regular file/);

    const emptyPath = path.join(dir, 'empty.png');
    await writeFile(emptyPath, Buffer.alloc(0));
    expect(() => validateImageFile(emptyPath)).toThrow(/empty \(0 bytes\)/);

    const pdfPath = path.join(dir, 'fake.png');
    await writeFile(pdfPath, '%PDF-1.4\n%synthetic');
    expect(() => validateImageFile(pdfPath)).toThrow(/file is a PDF, not an image/);

    const htmlPath = path.join(dir, 'err.png');
    await writeFile(htmlPath, '\uFEFF  <!DOCTYPE html><html><body>Error</body></html>');
    expect(() => validateImageFile(htmlPath)).toThrow(/file is HTML, not an image/);
  });

  it('handles rescaleTesseractTsv edge cases and parseTesseractTsv grouping/errors', () => {
    const header =
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
    expect(rescaleTesseractTsv(header, 0, 100, 100, 100)).toBe(header);
    expect(rescaleTesseractTsv(header, 100, 100, 100, 100)).toBe(header);
    expect(rescaleTesseractTsv('', 200, 200, 100, 100)).toBe('');
    expect(rescaleTesseractTsv('foo\tbar\n1\t2', 200, 200, 100, 100)).toBe('foo\tbar\n1\t2');

    // Includes: blank row, short row, non-numeric row, level 1, and tiny box downscaling clamp to 1px
    const rawTsv = [
      header,
      '',
      'short\trow',
      '5\t1\t1\t1\t1\t1\tbad\t10\t20\t30\t90\tNaNBox',
      '1\t1\t0\t0\t0\t0\t0\t0\t1000\t1000\t-1\t',
      '5\t1\t1\t1\t1\t1\t10\t20\t1\t1\t88\tOakville',
    ].join('\n');
    const downscaledTsv = rescaleTesseractTsv(`${rawTsv}\n`, 100, 100, 1000, 1000);
    expect(downscaledTsv.endsWith('\n')).toBe(true);
    expect(downscaledTsv).toContain('short\trow');
    expect(downscaledTsv).toContain('bad\t10\t20\t30');
    expect(downscaledTsv).toContain('1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t');
    expect(downscaledTsv).toContain('5\t1\t1\t1\t1\t1\t1\t2\t1\t1\t88\tOakville');

    // parseTesseractTsv errors & edge rows
    expect(() => parseTesseractTsv('not_level\ttext\n1\thello')).toThrow(/missing its header row/);
    const layout = parseTesseractTsv(
      [
        header,
        'too\tfew',
        '1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t',
        '4\t1\t1\t1\t1\t0\t10\t10\t100\t20\t-1\tIgnoredLevel4',
        '5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t-1\tJane',
        '5\t1\t1\t1\t1\t2\t60\t12\t30\t20\t-1\tDoe',
      ].join('\n')
    );
    expect(layout.image_width).toBe(800);
    expect(layout.image_height).toBe(600);
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]).toMatchObject({
      text: 'Jane Doe',
      x0: 10,
      y0: 10,
      x1: 90,
      y1: 32,
      conf: -1,
    });
  });
});

describe('ocr cliArgs behavioral coverage', () => {
  it('parses all single-command flags, short aliases, -- terminator, and validation errors', () => {
    expect(parseOcrArgs(['--help']).helpRequested).toBe(true);
    expect(parseOcrArgs(['-h']).helpRequested).toBe(true);

    const parsed = parseOcrArgs([
      '-m=cursive',
      '-t=45.5',
      '--provider=gemini',
      '--psm=3',
      '--effort=xhigh',
      '--workers=99',
      '--max-dim=0',
      '--cache-dir=/tmp/ocr-cache',
      '--prompt=Read {image_path}',
      '--no-cache',
      '--json',
      '--',
      '-dash-file.png',
    ]);
    expect(parsed).toMatchObject({
      helpRequested: false,
      mode: 'cursive',
      timeout: 45.5,
      provider: 'gemini',
      psm: 3,
      effort: 'xhigh',
      workers: 8,
      maxDim: 0,
      cacheDir: '/tmp/ocr-cache',
      prompt: 'Read {image_path}',
      force: true,
      json: true,
      images: ['-dash-file.png'],
    });

    const printed = parseOcrArgs(['--printed', '-m', 'printed', '--concurrency', '2', 'scan.png']);
    expect(printed.mode).toBe('printed');
    expect(printed.workers).toBe(2);

    expect(() => parseOcrArgs([])).toThrow(/Missing required positional argument/);
    expect(() => parseOcrArgs(['-z=1', 'a.png'])).toThrow(/Unknown option: -z=1/);
    expect(() => parseOcrArgs(['-z', 'a.png'])).toThrow(/Unknown option: -z/);
    expect(() => parseOcrArgs(['--psm'])).toThrow(/Option --psm requires a value/);
    expect(() => parseOcrArgs(['--unknown', '1', 'a.png'])).toThrow(/Unknown option: --unknown/);
    expect(() => parseOcrArgs(['--timeout', '0', 'a.png'])).toThrow(/Invalid --timeout/);
    expect(() => parseOcrArgs(['--workers', 'abc', 'a.png'])).toThrow(/Invalid --workers/);
    expect(() => parseOcrArgs(['--workers', '0', 'a.png'])).toThrow(/Invalid --workers/);
    expect(() => parseOcrArgs(['--psm', 'abc', 'a.png'])).toThrow(/Invalid --psm/);
    expect(() => parseOcrArgs(['--psm', '14', 'a.png'])).toThrow(/between 0 and 13/);
    expect(() => parseOcrArgs(['--max-dim', 'abc', 'a.png'])).toThrow(/Invalid --max-dim/);
    expect(() => parseOcrArgs(['--max-dim', '-5', 'a.png'])).toThrow(/Invalid --max-dim/);
    expect(() => parseOcrArgs(['--mode', 'invalid', 'a.png'])).toThrow(/Invalid --mode/);
    expect(() => parseOcrArgs(['--effort', 'ultra', 'a.png'])).toThrow(/Invalid --effort/);
    expect(() => parseOcrArgs(['--provider', 'local', 'a.png'])).toThrow(/Invalid --provider/);
    expect(() => parseOcrArgs(['--find', '[unclosed', 'a.png'])).toThrow(/Invalid --find regex/);
    expect(() => parseOcrArgs(['--boxes', '--tsv', 'a.png'])).toThrow(/--tsv cannot be combined/);
    expect(() => parseOcrArgs(['--cursive', '--boxes', 'a.png'])).toThrow(/require --mode printed/);
  });

  it('parses all batch flags, -- terminator, and validation errors', () => {
    expect(parseOcrBatchArgs(['-h']).helpRequested).toBe(true);
    const parsed = parseOcrBatchArgs([
      '-i',
      '--refresh',
      '--printed',
      '--cursive',
      '--mode',
      'printed',
      '--provider',
      'auto',
      '--psm',
      '4',
      '--effort',
      'medium',
      '--prompt',
      'Transcribe',
      '--max-dim',
      '2000',
      '--cache-dir',
      '/tmp/batch-cache',
      '--workers',
      '3',
      '-t',
      '15',
      '--grep',
      'Oakville',
      '--json',
      '--',
      '-weird.png',
    ]);
    expect(parsed).toMatchObject({
      ignoreCase: true,
      force: true,
      mode: 'printed',
      provider: 'auto',
      psm: 4,
      effort: 'medium',
      prompt: 'Transcribe',
      maxDim: 2000,
      cacheDir: '/tmp/batch-cache',
      concurrency: 3,
      timeout: 15,
      grep: 'Oakville',
      json: true,
      inputs: ['-weird.png'],
    });

    expect(() => parseOcrBatchArgs([])).toThrow(/Missing required positional argument/);
    expect(() => parseOcrBatchArgs(['--grep', '(bad', 'dir'])).toThrow(/Invalid --grep regex/);
    expect(() => parseOcrBatchArgs(['--bogus', '1', 'dir'])).toThrow(/Unknown option: --bogus/);
  });
});

describe('ocr engines, subprocess, pipeline, and singleRunner behavioral coverage', () => {
  it('downscales oversized printed images, rescales TSV, and surfaces engine errors', async () => {
    const dir = await makeTempDir();
    const imgPath = path.join(dir, 'large.png');
    const pngBytes = await createSyntheticPng(400, 200);
    await writeFile(imgPath, pngBytes);
    const workDir = path.join(dir, 'work');

    // maxDim=0 disables downscaling
    const disabled = await preparePrintedImage(imgPath, pngBytes, workDir, 0);
    expect(disabled).toEqual({ sendPath: imgPath, cleanupDir: null, scaleInfo: null });

    // Invalid PNG header claiming huge dimensions causes sharp failure -> graceful unchanged fallback
    const fakeHugePng = Buffer.alloc(24);
    fakeHugePng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    fakeHugePng.writeUInt32BE(5000, 16);
    fakeHugePng.writeUInt32BE(5000, 20);
    const badPath = path.join(dir, 'corrupt.png');
    await writeFile(badPath, fakeHugePng);
    const fallback = await preparePrintedImage(badPath, fakeHugePng, workDir, 1000);
    expect(fallback.scaleInfo).toBeNull();

    // Missing tesseract on PATH
    const { ctx: noPathCtx } = makeCtx({ env: { PATH: '' } });
    await expect(
      runPrintedOcr({
        imgPath,
        rawBytes: pngBytes,
        psm: 6,
        timeoutSeconds: 5,
        tsv: false,
        workDir,
        maxDim: 200,
        ctx: noPathCtx,
      })
    ).rejects.toThrow(/tesseract executable not found on PATH/);

    // Downscaled TSV run rescales boxes back to 400x200
    const tsvOutput = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t200\t100\t-1\t',
      '5\t1\t1\t1\t1\t1\t10\t20\t50\t10\t95\tChronicle',
    ].join('\n');
    const { ctx: tsvCtx } = makeCtx({
      execFileImpl: async () => ({ stdout: Buffer.from(tsvOutput), stderr: Buffer.alloc(0) }),
    });
    const res = await runPrintedOcr({
      imgPath,
      rawBytes: pngBytes,
      psm: 6,
      timeoutSeconds: 5,
      tsv: true,
      workDir,
      maxDim: 200,
      ctx: tsvCtx,
    });
    expect(res.meta['downscaled']).toBe(true);
    expect(res.meta['original_size']).toEqual([400, 200]);
    expect(res.meta['scaled_size']).toEqual([200, 100]);
    const parsedTsv = parseTesseractTsv(res.output);
    expect(parsedTsv.lines[0]).toMatchObject({ text: 'Chronicle', x0: 20, y0: 40, x1: 120, y1: 60 });

    // Non-zero exit code with generic error
    const { ctx: errCtx } = makeCtx({
      execFileImpl: async () => {
        const err = Object.assign(new Error('fail'), { code: 1, stderr: Buffer.from('segfault in engine') });
        throw err;
      },
    });
    await expect(
      runPrintedOcr({
        imgPath,
        rawBytes: pngBytes,
        psm: 6,
        timeoutSeconds: 5,
        tsv: false,
        workDir,
        maxDim: 0,
        ctx: errCtx,
      })
    ).rejects.toThrow(/tesseract exited 1: segfault in engine/);
  });

  it('exercises Gemini and CLI cursive OCR error paths, prompt handling, and provider routing', async () => {
    const dir = await makeTempDir();
    const imgPath = path.join(dir, 'letter.png');
    const pngBytes = await createSyntheticPng(32, 32);
    await writeFile(imgPath, pngBytes);

    // Provider routing errors
    const { ctx: emptyEnvCtx } = makeCtx({ env: { PATH: '' } });
    await expect(
      runCursiveOcr({
        imgPath,
        rawBytes: pngBytes,
        effort: 'low',
        provider: 'gemini',
        timeoutSeconds: 5,
        cacheDir: dir,
        ctx: emptyEnvCtx,
      })
    ).rejects.toThrow(/GEMINI_API_KEY or GOOGLE_API_KEY must be set/);

    await expect(
      runCursiveOcr({
        imgPath,
        rawBytes: pngBytes,
        effort: 'low',
        provider: 'cli',
        timeoutSeconds: 5,
        cacheDir: dir,
        ctx: emptyEnvCtx,
      })
    ).rejects.toThrow(/not found on PATH/);

    await expect(
      runCursiveOcr({
        imgPath,
        rawBytes: pngBytes,
        effort: 'low',
        provider: 'auto',
        timeoutSeconds: 5,
        cacheDir: dir,
        ctx: emptyEnvCtx,
      })
    ).rejects.toThrow(/no GEMINI_API_KEY\/GOOGLE_API_KEY is set/);

    // Gemini error branches: HTTP 500, non-JSON, no candidates, empty text, timeout AbortError
    const makeGeminiCall = (fetchImpl: typeof fetch, timeoutSeconds = 5, rawBytesOverride = pngBytes) =>
      runCursiveGeminiOcr({
        imgPath,
        rawBytes: rawBytesOverride,
        effort: 'low',
        timeoutSeconds,
        apiKey: 'synthetic-key',
        customPrompt: 'Transcribe {image_path}',
        ctx: makeCtx({ fetchImpl }).ctx,
      });

    await expect(makeGeminiCall(async () => new Response('down', { status: 500 }))).rejects.toThrow(
      /gemini OCR HTTP 500/
    );
    await expect(makeGeminiCall(async () => new Response('not-json', { status: 200 }))).rejects.toThrow(
      /returned non-JSON response/
    );
    await expect(
      makeGeminiCall(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }))
    ).rejects.toThrow(/returned no candidates/);
    await expect(
      makeGeminiCall(
        async () =>
          new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '   ' }] } }] }), {
            status: 200,
          })
      )
    ).rejects.toThrow(/empty transcription response/);

    // AbortError via timer firing
    await expect(
      makeGeminiCall(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
        0.02
      )
    ).rejects.toThrow(OcrTimeoutError);

    // Oversized non-image buffer triggers prepareCursiveBuffer catch fallback
    const hugeFake = Buffer.alloc(360 * 1024, 0x41);
    const hugeRes = await makeGeminiCall(
      async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Jane Doe 1895' }] } }] }), {
          status: 200,
        }),
      5,
      hugeFake
    );
    expect(hugeRes.text).toBe('Jane Doe 1895');
    expect(hugeRes.meta['downscaled']).toBe(false);

    // CLI cursive OCR error branches
    const runCli = (execFileImpl: ExecFileFn, customPrompt?: string) =>
      runCursiveCliOcr({
        imgPath,
        rawBytes: pngBytes,
        effort: 'low',
        timeoutSeconds: 5,
        cacheDir: dir,
        customPrompt,
        cliName: 'agy',
        cliBin: 'agy',
        ctx: makeCtx({ execFileImpl }).ctx,
      });

    await expect(
      runCli(async () => {
        throw Object.assign(new Error('bad'), { code: 2, stderr: Buffer.from('cli failure') });
      }, 'No placeholder prompt')
    ).rejects.toThrow(/agy exited 2: cli failure/);

    await expect(
      runCli(async () => ({ stdout: Buffer.from('not-json'), stderr: Buffer.alloc(0) }))
    ).rejects.toThrow(/returned non-JSON stdout/);

    await expect(
      runCli(async () => ({
        stdout: Buffer.from(JSON.stringify({ status: 'FAILED' })),
        stderr: Buffer.alloc(0),
      }))
    ).rejects.toThrow(/returned status=FAILED/);

    await expect(
      runCli(async () => ({
        stdout: Buffer.from(JSON.stringify({ status: 'SUCCESS', response: '  ' })),
        stderr: Buffer.alloc(0),
      }))
    ).rejects.toThrow(/empty transcription response/);
  });

  it('exercises subprocess helpers: resolveExecutable, createDefaultExecFile, and real/injected timeouts', async () => {
    const dir = await makeTempDir();
    expect(resolveExecutable(process.execPath, process.env)).toBe(process.execPath);
    expect(resolveExecutable(path.join(dir, 'does-not-exist'), process.env)).toBeNull();
    expect(resolveExecutable('definitely-not-a-real-binary-xyz', { PATH: dir })).toBeNull();

    const defaultExec = createDefaultExecFile();
    const okRes = await defaultExec(process.execPath, ['-e', 'process.stdout.write("hello-ocr")']);
    expect(okRes.stdout.toString('utf8')).toBe('hello-ocr');

    await expect(
      defaultExec(process.execPath, ['-e', 'process.stderr.write("err-ocr"); process.exit(3)'])
    ).rejects.toMatchObject({ code: 3 });

    // execFileImpl killed / ETIMEDOUT / non-record rethrow
    await expect(
      runSubprocessWithTimeout({
        bin: 'tesseract',
        args: [],
        env: {},
        timeoutSeconds: 5,
        fileForError: 'p1.png',
        timeoutLabel: 'tesseract',
        execFileImpl: async () => {
          throw Object.assign(new Error('killed'), { killed: true });
        },
      })
    ).rejects.toThrow(OcrTimeoutError);

    await expect(
      runSubprocessWithTimeout({
        bin: 'tesseract',
        args: [],
        env: {},
        timeoutSeconds: 5,
        fileForError: 'p1.png',
        timeoutLabel: 'tesseract',
        execFileImpl: async () => {
          throw 'raw-string-error';
        },
      })
    ).rejects.toBe('raw-string-error');

    // Real spawn path: stderr capture, spawn ENOENT, and real timeout kill
    const spawnOk = await runSubprocessWithTimeout({
      bin: process.execPath,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("warn")'],
      env: process.env,
      timeoutSeconds: 5,
      fileForError: 'p1.png',
      timeoutLabel: 'node',
    });
    expect(spawnOk).toEqual({ exitCode: 0, stdout: 'out', stderr: 'warn' });

    await expect(
      runSubprocessWithTimeout({
        bin: path.join(dir, 'nonexistent-bin'),
        args: [],
        env: process.env,
        timeoutSeconds: 5,
        fileForError: 'p1.png',
        timeoutLabel: 'missing',
      })
    ).rejects.toThrow();

    await expect(
      runSubprocessWithTimeout({
        bin: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        env: process.env,
        timeoutSeconds: 0.05,
        fileForError: 'slow.png',
        timeoutLabel: 'node',
      })
    ).rejects.toThrow(OcrTimeoutError);
  });

  it('exercises expandBatchInputs, runOcrBatchCommand text/error output, and runLayoutData/runOcrData caching', async () => {
    const dir = await makeTempDir();
    const subDir = path.join(dir, 'nested');
    fs.mkdirSync(subDir, { recursive: true });
    const cacheDir = path.join(dir, 'cache');

    const imgA = path.join(subDir, 'a.png');
    const imgB = path.join(dir, 'b.png');
    const badImg = path.join(dir, 'c_empty.png');
    const pngA = await createSyntheticPng(32, 32, { r: 240, g: 240, b: 240 });
    const pngB = await createSyntheticPng(32, 32, { r: 200, g: 200, b: 200 });
    await writeFile(imgA, pngA);
    await writeFile(imgB, pngB);
    await writeFile(badImg, Buffer.alloc(0));

    // expandBatchInputs: nested dir + duplicate file dedup + missing path error
    const expanded = expandBatchInputs([dir, imgA], dir);
    expect(expanded.map((e) => e.absPath)).toEqual([imgB, badImg, imgA]);
    expect(() => expandBatchInputs([path.join(dir, 'missing.png')], dir)).toThrow(InputImageError);

    // runOcrBatchCommand: empty glob -> exitCode 2
    const { ctx: emptyGlobCtx, stderr: emptyGlobErr } = makeCtx({ cwd: dir });
    const emptyRes = await runOcrCommand(['batch', '*.nomatch', '--cache-dir', cacheDir], emptyGlobCtx);
    expect(emptyRes.exitCode).toBe(2);
    expect(emptyGlobErr.join('\n')).toContain('no image files matched');

    // runOcrBatchCommand text output with ok + grep match + failed empty file + runtime OCR error
    const { ctx: batchCtx, stdout: batchOut } = makeCtx({
      cwd: dir,
      execFileImpl: async (_bin, args) => {
        if (args[0] === imgB) {
          throw Object.assign(new Error('boom'), { code: 1, stderr: Buffer.from('engine crash') });
        }
        return { stdout: Buffer.from('Oakville Chronicle 1895\nJane Doe'), stderr: Buffer.alloc(0) };
      },
    });
    const batchOutcome = await runOcrCommand(
      ['batch', dir, '--grep', 'oakville', '-i', '--cache-dir', cacheDir],
      batchCtx
    );
    expect(batchOutcome.exitCode).toBe(1);
    const batchText = batchOut.join('\n');
    expect(batchText).toContain('Batch OCR (printed): 1/3 succeeded, 0 timed out, 2 failed');
    expect(batchText).toContain("Grep 'oakville': 1 match(es)");
    expect(batchText).toContain('[FAILED]');

    // runLayoutData: tsvOnly miss -> hit; corrupt boxes JSON falls back to cached TSV; runOcrData corrupt cache
    const validTsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t32\t32\t-1\t',
      '5\t1\t1\t1\t1\t1\t1\t2\t10\t8\t90\tOakville',
    ].join('\n');
    let tessCalls = 0;
    const { ctx: layoutCtx } = makeCtx({
      execFileImpl: async () => {
        tessCalls += 1;
        return { stdout: Buffer.from(validTsv), stderr: Buffer.alloc(0) };
      },
    });
    const sha = 'a'.repeat(64);
    const r1 = await runLayoutData({
      imgPath: imgA,
      rawBytes: pngA,
      sha256HexStr: sha,
      cacheDir,
      psm: 6,
      maxDim: 0,
      timeoutSeconds: 5,
      force: false,
      tsvOnly: true,
      ctx: layoutCtx,
    });
    expect(r1.cached).toBe(false);
    const r2 = await runLayoutData({
      imgPath: imgA,
      rawBytes: pngA,
      sha256HexStr: sha,
      cacheDir,
      psm: 6,
      maxDim: 0,
      timeoutSeconds: 5,
      force: false,
      tsvOnly: true,
      ctx: layoutCtx,
    });
    expect(r2.cached).toBe(true);
    expect(tessCalls).toBe(1);

    // Write corrupt boxes.json and verify runLayoutData recovers from cached TSV without re-running tesseract
    const boxesPath = path.join(cacheDir, `${sha}_printed_psm6.boxes.json`);
    await writeFile(boxesPath, '{not-valid-json');
    const r3 = await runLayoutData({
      imgPath: imgA,
      rawBytes: pngA,
      sha256HexStr: sha,
      cacheDir,
      psm: 6,
      maxDim: 0,
      timeoutSeconds: 5,
      force: false,
      tsvOnly: false,
      find: 'oak',
      ctx: layoutCtx,
    });
    expect(r3.cached).toBe(true);
    expect(tessCalls).toBe(1);

    // Corrupt text cache JSON is ignored and recomputed
    const textCachePath = path.join(cacheDir, `${sha}_printed_psm6.json`);
    await writeFile(textCachePath, '{corrupt');
    const { ctx: dataCtx } = makeCtx({
      execFileImpl: async () => ({ stdout: Buffer.from('Recovered text'), stderr: Buffer.alloc(0) }),
    });
    const dataRes = await runOcrData({
      imgPath: imgA,
      rawBytes: pngA,
      sha256HexStr: sha,
      cacheDir,
      mode: 'printed',
      provider: 'auto',
      psm: 6,
      maxDim: 0,
      effort: 'low',
      force: false,
      ctx: dataCtx,
    });
    expect(dataRes.cached).toBe(false);
    expect(dataRes.record.text).toBe('Recovered text');
  });
});

// ============================================================================
// 2. Archive.org: searchCommands, pageAndGrep, itemCache, transport,
//    pageCommands, grepCommand, itemParsers
// ============================================================================

describe('archive-org behavioral coverage', () => {
  const synthScandata = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<book>
  <pageData>
    <page leafNum="0"><pageType>Delete</pageType><addToAccessFormats>false</addToAccessFormats></page>
    <page leafNum="1"><pageType>Normal</pageType><pageNumber>1</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
    <page leafNum="2"><pageType>Normal</pageType><pageNumber>2</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
  </pageData>
</book>`,
    'utf8'
  );

  it('covers subcommand --help outputs and text rendering for search, get, download, fulltext, lookup, url', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'dl');

    const dummyFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('advancedsearch.php')) {
        return new Response(
          JSON.stringify({
            responseHeader: { status: 0 },
            response: {
              numFound: 1,
              docs: [
                {
                  identifier: 'oakville_1895',
                  title: 'Oakville Directory 1895',
                  creator: 'Jane Doe',
                  date: '1895',
                  mediatype: 'texts',
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('/metadata/missing_item')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes('/metadata/oakville_1895')) {
        return new Response(
          JSON.stringify({
            metadata: {
              identifier: 'oakville_1895',
              title: 'Oakville Directory 1895',
              creator: 'Jane Doe',
              date: '1895',
              mediatype: 'texts',
              collection: ['americana', 'oakville_local'],
              description: 'Directory of Oakville residents in 1895.',
            },
            files: [
              { name: 'oakville_1895_scandata.xml', format: 'Scandata', size: '300' },
              { name: 'oakville_1895_djvu.txt', format: 'DjVuTXT', size: '42' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('page_production')) {
        return new Response(
          JSON.stringify({
            response: {
              body: {
                hits: {
                  total: 1,
                  hits: [
                    {
                      fields: { identifier: 'oakville_1895', title: 'Oakville Directory 1895', year: '1895' },
                      highlight: { text: ['Listed {{{Jane Doe}}} on Maple Street.'] },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('_scandata.xml')) {
        return new Response(synthScandata, { status: 200 });
      }
      if (url.includes('_djvu.txt')) {
        return new Response('\x0cPage one Oakville\x0cPage two Jane Doe', { status: 200 });
      }
      if (url.includes('/page/n')) {
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const runIa = async (args: readonly string[]) => {
      const { ctx, stdout, stderr } = makeCtx({
        cwd: cacheDir,
        env: { KINLOOM_IA_CACHE_DIR: cacheDir },
        fetchImpl: dummyFetch,
      });
      const res = await runArchiveOrgCommand(args, ctx);
      return { exitCode: res.exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    };

    // Help pages
    for (const sub of ['search', 'get', 'download', 'fulltext', 'lookup', 'url', 'page', 'text', 'grep']) {
      const help = await runIa([sub, '--help']);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain(`kinloom ia ${sub}`);
    }

    // search text output + --sort + --page 2
    const searchRes = await runIa(['search', 'Oakville', '--sort', 'date asc', '--page', '2']);
    expect(searchRes.exitCode).toBe(0);
    expect(searchRes.stdout).toContain('1 items (fetched)');
    expect(searchRes.stdout).toContain('oakville_1895 | Oakville Directory 1895 | Jane Doe | 1895 | texts');

    // get text output with --files & ArchiveNotFoundError
    const getRes = await runIa(['get', 'oakville_1895', '--files']);
    expect(getRes.exitCode).toBe(0);
    expect(getRes.stdout).toContain('Collection: americana, oakville_local');
    expect(getRes.stdout).toContain('oakville_1895_scandata.xml | Scandata | 300 bytes');
    const getMissing = await runIa(['get', 'missing_item']);
    expect(getMissing.exitCode).toBe(1);
    expect(getMissing.stderr).toContain('No item with identifier missing_item');

    // download: list mode, missing item, missing file, and actual download
    const dlList = await runIa(['download', 'oakville_1895', '--list']);
    expect(dlList.exitCode).toBe(0);
    expect(dlList.stdout).toContain('oakville_1895_djvu.txt | DjVuTXT | 42 bytes');
    expect((await runIa(['download', 'missing_item'])).exitCode).toBe(1);
    const dlMissingFile = await runIa(['download', 'oakville_1895', 'no_such.pdf', '--out', outDir]);
    expect(dlMissingFile.exitCode).toBe(1);
    expect(dlMissingFile.stderr).toContain('File not in item oakville_1895');

    // fulltext: text output + validation
    const ftRes = await runIa(['fulltext', 'Jane Doe']);
    expect(ftRes.exitCode).toBe(0);
    expect(ftRes.stdout).toContain('1 full-text matches (showing 1, fetched)');
    expect(ftRes.stdout).toContain('OCR: Listed Jane Doe on Maple Street.');
    expect((await runIa(['fulltext', 'Jane', '--rows', '0'])).exitCode).toBe(2);
    expect((await runIa(['fulltext', 'Jane', '--page', '0'])).exitCode).toBe(2);

    // lookup: text output
    const luRes = await runIa(['lookup', 'oakville_1895', '--printed-page', '1']);
    expect(luRes.exitCode).toBe(0);
    expect(luRes.stdout).toContain('oakville_1895: printed page 1 | BookReader leaf n0 | scandata leaf 1');

    // url
    const urlRes = await runIa(['url', 'Oakville', '--mediatype', 'texts', '--collection', 'colA,colB']);
    expect(urlRes.exitCode).toBe(0);
    expect(urlRes.stdout).toContain('advancedsearch.php?q=');
    expect(urlRes.stdout).toContain('colA');

    // text --item <id> <pagePos>, multi-page text formatting, and multi-page JPEG plain text output
    const textByFlag = await runIa(['text', '--item', 'oakville_1895', '1']);
    expect(textByFlag.exitCode).toBe(0);
    expect(textByFlag.stdout).toContain('Page one Oakville');

    const textMulti = await runIa(['text', 'oakville_1895', '1-2']);
    expect(textMulti.exitCode).toBe(0);
    expect(textMulti.stdout).toContain('Page one Oakville');
    expect(textMulti.stdout).toContain('Page two Jane Doe');

    const pageMulti = await runIa(['page', 'oakville_1895', '--leaves', '0-1', '--out', outDir]);
    expect(pageMulti.exitCode).toBe(0);
    expect(pageMulti.stdout).toContain('[n0]');
    expect(pageMulti.stdout).toContain('[n1]');
  });

  it('covers pageAndGrep helpers: flat mode, CRLF, zero-width matches, range/spec errors, and fallback resolvers', () => {
    const flatIdx: PageIndex = {
      leaf_count: 1,
      access_leaf_count: 1,
      scandata_to_bookreader: {},
      bookreader_to_scandata: {},
      scandata_to_printed: {},
      bookreader_to_printed: {},
      printed_to_bookreader: {},
      printed_to_bookreader_ci: {},
      printed_to_scandata: { '9': 4 },
      segment_mode: 'flat',
    };
    const longLine = `${'A'.repeat(60)}Jane Doe${'B'.repeat(60)}\r\nSecond\rThird`;
    const [flatHits, flatTotal] = grepCachedItem('item1', longLine, flatIdx, 'Jane Doe', false, {
      contextChars: 40,
      limit: 5,
    });
    expect(flatTotal).toBe(1);
    expect(flatHits[0]!.leaf).toBeNull();
    expect(flatHits[0]!.snippet.startsWith('...')).toBe(true);
    expect(flatHits[0]!.snippet.endsWith('...')).toBe(true);

    // Zero-length regex terminates cleanly
    const [, zeroTotal] = grepCachedItem('item1', 'abc', flatIdx, '^', false, {
      contextChars: 20,
      limit: 5,
    });
    expect(zeroTotal).toBe(0);

    // resolvePrintedPageToLeaf fallback to printed_to_scandata
    expect(resolvePrintedPageToLeaf(flatIdx, '9')).toEqual([4, 4]);
    expect(() => resolvePrintedPageToLeaf(flatIdx, '999')).toThrow(/no printed page numbers in scandata.xml/);

    // validateLeafInIndex, leafFromScandataLeaf, segmentForLeaf
    expect(() => validateLeafInIndex(flatIdx, -1)).toThrow(/must be >= 0/);
    expect(() => leafFromScandataLeaf(flatIdx, 0)).toThrow(/no scandata.xml mapping cached/);
    expect(segmentForLeaf(flatIdx, 0, null)).toBeNull();
    const scandataEmptyIdx: PageIndex = { ...flatIdx, segment_mode: 'scandata' };
    expect(segmentForLeaf(scandataEmptyIdx, 2, null)).toBe(2);
    const scandataNonEmptyIdx: PageIndex = {
      ...flatIdx,
      segment_mode: 'scandata',
      scandata_to_bookreader: { '1': 0 },
    };
    expect(segmentForLeaf(scandataNonEmptyIdx, 2, null)).toBeNull();

    // parsePrintedRange errors
    expect(() => parsePrintedRange(flatIdx, '  ')).toThrow(/Empty --pages range/);
    expect(() => parsePrintedRange(flatIdx, '1,,2')).toThrow(/Invalid --pages range/);
    expect(() => parsePrintedRange(flatIdx, '9-')).toThrow(/expected <p1>-<p2>/);
    expect(() => parsePrintedRange(flatIdx, 'unknown')).toThrow(/not found in page_index.json/);

    // parseLeafSpec & parsePrintedPageSpec errors
    expect(() => parseLeafSpec('')).toThrow(CliValidationError);
    expect(() => parseLeafSpec('bad')).toThrow(/Invalid --leaves token/);
    expect(() => parseLeafSpec('1-20,21-30')).toThrow(/more than 25 pages/);
    expect(() => parsePrintedPageSpec('')).toThrow(CliValidationError);
    expect(() => parsePrintedPageSpec('10-5')).toThrow(/precedes/);
    expect(() => parsePrintedPageSpec('1-30')).toThrow(/more than 25 pages/);
    expect(() => parsePrintedPageSpec('1-20,21-30')).toThrow(/more than 25 pages/);

    // resolveSearchQuery errors & multi-collection
    expect(() => resolveSearchQuery(['a'], 'b')).toThrow(/not both/);
    expect(resolveSearchQuery(['Oakville'], undefined, { collections: ['c1,c2'] })).toBe(
      'Oakville AND collection:(c1 OR c2)'
    );
  });

  it('covers itemParsers, itemCache flat/hOCR error/artifact reuse, transport retries/errors, page/text/grep edges', async () => {
    const cacheDir = await makeTempDir();

    // itemParsers: format fallback, invalid XML, nested array pageData, #text node, hOCR edge cases
    expect(
      findItemFile([{ name: 'alt_name.xml', format: 'Scandata' }], {
        suffixes: ['_scandata.xml'],
        formats: ['scandata'],
      })
    ).toBe('alt_name.xml');
    expect(() => parseScandataXml(Buffer.from('<broken'))).toThrow(/Invalid scandata.xml/);
    const wrappedXml = Buffer.from(
      '<root><wrap><pageData><page leafNum="0"><pageNumber attr="1">7</pageNumber></page></pageData></wrap></root>'
    );
    const wrappedIdx = parseScandataXml(wrappedXml);
    expect(wrappedIdx.bookreader_to_printed['0']).toBe('7');

    expect(synthesizeDjvuFromHocr(gzipSync(Buffer.from('plain text')), gzipSync(Buffer.from('[]')))).toBe(
      'plain text'
    );
    expect(() =>
      synthesizeDjvuFromHocr(Buffer.from('abc'), Buffer.from(JSON.stringify([['nan', 2]])))
    ).toThrow(/Invalid hOCR page index offset/);
    expect(synthesizeDjvuFromHocr(Buffer.from('abc'), Buffer.from(JSON.stringify(['bad', [0, 3]])))).toBe(
      '\x0cabc'
    );

    // itemCache: ensureItemMetadata empty -> ArchiveNotFoundError
    const { ctx: emptyMetaCtx } = makeCtx({
      env: { KINLOOM_IA_CACHE_DIR: cacheDir },
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    await expect(ensureItemMetadata('empty_item', emptyMetaCtx, { cacheRoot: cacheDir })).rejects.toThrow(
      ArchiveNotFoundError
    );

    // itemCache: flat djvu (no form feed, no scandata) + corrupt hOCR fallback
    const { ctx: flatCtx } = makeCtx({
      env: { KINLOOM_IA_CACHE_DIR: cacheDir },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/metadata/flat_item')) {
          return new Response(
            JSON.stringify({
              metadata: { identifier: 'flat_item' },
              files: [{ name: 'flat_item_djvu.txt', format: 'DjVuTXT' }],
            }),
            { status: 200 }
          );
        }
        return new Response('Single flat block of text without breaks', { status: 200 });
      },
    });
    const flatEntry = await ensureItemCache('flat_item', flatCtx, { needDjvu: true, cacheRoot: cacheDir });
    expect(JSON.parse(fs.readFileSync(flatEntry.pageIndexPath, 'utf8'))).toMatchObject({
      segment_mode: 'flat',
      djvu_source: 'djvu_txt',
    });

    // itemCache: corrupt hOCR + no djvu -> RecordRuntimeError with error details
    const { ctx: badHocrCtx } = makeCtx({
      env: { KINLOOM_IA_CACHE_DIR: cacheDir },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/metadata/bad_hocr')) {
          return new Response(
            JSON.stringify({
              metadata: { identifier: 'bad_hocr' },
              files: [
                { name: 'bad_hocr_hocr_searchtext.txt.gz' },
                { name: 'bad_hocr_hocr_pageindex.json.gz' },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('not-valid-json', { status: 200 });
      },
    });
    await expect(
      ensureItemCache('bad_hocr', badHocrCtx, { needDjvu: true, cacheRoot: cacheDir })
    ).rejects.toThrow(/has no downloadable OCR text/);

    // reuseExistingItemArtifact: missing djvu_source with matching size & without size/hOCR
    const reuseDir = path.join(cacheDir, 'reuse_item');
    fs.mkdirSync(reuseDir, { recursive: true });
    await writeFile(path.join(reuseDir, 'djvu.txt'), '12345');
    await writeFile(path.join(reuseDir, 'page_index.json'), JSON.stringify({ leaf_count: 1 }));
    const reusedBySize = reuseExistingItemArtifact(
      reuseDir,
      'reuse_item_djvu.txt',
      [{ name: 'reuse_item_djvu.txt', size: '5' }],
      { name: 'reuse_item_djvu.txt', size: '5' }
    );
    expect(reusedBySize?.toString('utf8')).toBe('12345');
    const reusedNoSize = reuseExistingItemArtifact(
      reuseDir,
      'reuse_item_djvu.txt',
      [{ name: 'reuse_item_djvu.txt' }],
      { name: 'reuse_item_djvu.txt' }
    );
    expect(reusedNoSize?.toString('utf8')).toBe('12345');

    // transport: AbortError, redirect without location, >10 redirects, HTTP 400, ECONNRESET retries, non-object JSON
    const { ctx: abortCtx } = makeCtx({
      fetchImpl: async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    await expect(httpGetBytesIa('https://archive.org/metadata/x', abortCtx, 1)).rejects.toThrow(
      /The read operation timed out/
    );

    const { ctx: noLocCtx } = makeCtx({
      fetchImpl: async () => new Response('', { status: 302 }),
    });
    await expect(httpGetBytesIa('https://archive.org/metadata/x', noLocCtx, 1)).rejects.toThrow(/HTTP 302/);

    const { ctx: loopCtx } = makeCtx({
      fetchImpl: async () =>
        new Response('', { status: 302, headers: { location: 'https://archive.org/metadata/loop' } }),
    });
    await expect(httpGetBytesIa('https://archive.org/metadata/loop', loopCtx, 1)).rejects.toThrow(
      /Too many redirects/
    );

    const { ctx: resetCtx } = makeCtx({
      fetchImpl: async () => {
        throw Object.assign(new Error('socket hung up'), { code: 'ECONNRESET' });
      },
    });
    await expect(httpGetBytesIa('https://archive.org/metadata/x', resetCtx, 1)).rejects.toThrow(
      /Incomplete response from/
    );

    const { ctx: arrayJsonCtx } = makeCtx({
      fetchImpl: async () => new Response('[1,2,3]', { status: 200 }),
    });
    await expect(
      httpGetJsonIa('https://archive.org/advancedsearch.php?q=a', arrayJsonCtx, { retryTransientJson: true })
    ).rejects.toThrow(/Expected JSON object/);

    const { ctx: badStatusQueryCtx } = makeCtx({
      env: { KINLOOM_IA_CACHE_DIR: cacheDir },
      fetchImpl: async () =>
        new Response(JSON.stringify({ responseHeader: { status: 500 }, response: {} }), { status: 200 }),
    });
    await expect(
      cachedQueryJson(
        'search',
        { q: 'bad' },
        'https://archive.org/advancedsearch.php?q=bad',
        badStatusQueryCtx,
        {
          cacheRoot: cacheDir,
        }
      )
    ).rejects.toThrow(/returned an error response/);

    // pageCommands & grepCommand validation and plain-text edge paths
    const { ctx: valCtx, stderr: valErr } = makeCtx({
      cwd: cacheDir,
      env: { KINLOOM_IA_CACHE_DIR: cacheDir },
      fetchImpl: async () => new Response('missing', { status: 404 }),
    });
    expect((await runArchiveOrgCommand(['page', 'oak', '--scale', '0'], valCtx)).exitCode).toBe(2);
    expect((await runArchiveOrgCommand(['page', 'oak', '--width', '0'], valCtx)).exitCode).toBe(2);
    expect(
      (await runArchiveOrgCommand(['page', 'oak', '--printed-page', '1', '--leaf', '0'], valCtx)).exitCode
    ).toBe(2);
    expect((await runArchiveOrgCommand(['page', 'oak', '0', '--leaf', '0'], valCtx)).exitCode).toBe(2);
    expect(
      (await runArchiveOrgCommand(['page', 'oak', '--printed-pages', '1-2', '--leaf', '0'], valCtx)).exitCode
    ).toBe(2);
    expect((await runArchiveOrgCommand(['page', 'oak'], valCtx)).exitCode).toBe(2);
    expect((await runArchiveOrgCommand(['page', 'oak', '-1'], valCtx)).exitCode).toBe(2);
    expect((await runArchiveOrgCommand(['text'], valCtx)).exitCode).toBe(2);
    expect((await runArchiveOrgCommand(['text', 'oak', '1', '--leaf', '0'], valCtx)).exitCode).toBe(2);
    expect((await runArchiveOrgCommand(['text', 'flat_item', 'n0'], valCtx)).exitCode).toBe(1);
    expect(valErr.join('\n')).toContain('OCR text has no page breaks');

    // grep validation & all-failed multi-item & partial-error plain-text output
    expect((await runArchiveOrgCommand(['grep', 'oak', '-e', 'a', '--context', '-1'], valCtx)).exitCode).toBe(
      2
    );
    expect((await runArchiveOrgCommand(['grep', 'oak', '-e', 'a', '--limit', '-1'], valCtx)).exitCode).toBe(
      2
    );
    expect((await runArchiveOrgCommand(['grep', '-e', 'a'], valCtx)).exitCode).toBe(2);
    expect((await runArchiveOrgCommand(['grep', 'oak', '-e', '[bad'], valCtx)).exitCode).toBe(2);
    expect((await runArchiveOrgCommand(['grep', 'miss_a', 'miss_b', '-e', 'Oak'], valCtx)).exitCode).toBe(1);

    const {
      ctx: partialGrepCtx,
      stdout: pgOut,
      stderr: pgErr,
    } = makeCtx({
      cwd: cacheDir,
      env: { KINLOOM_IA_CACHE_DIR: cacheDir },
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    const pgRes = await runArchiveOrgCommand(
      ['grep', 'flat_item', 'missing_x', '-e', 'flat'],
      partialGrepCtx
    );
    expect(pgRes.exitCode).toBe(0);
    expect(pgOut.join('\n')).toContain('1 matches across 1 item(s)');
    expect(pgErr.join('\n')).toContain('warning: missing_x:');
  });
});

// ============================================================================
// 3. Narrative Audio: synthesis.ts & script.ts
// ============================================================================

describe('narrative-audio synthesis and script behavioral coverage', () => {
  it('covers script.ts edge helpers: countWords, ordinal, intToWords, stripWavHeader, YAML, paths, MIME', () => {
    expect(countWords('   ')).toBe(0);
    expect(ordinal(42)).toBe('42');
    expect(intToWords(-42)).toBe('minus forty-two');
    expect(intToWords(1_000_000_000)).toBe('one billion');

    const shortRaw = Buffer.from([1, 2, 3]);
    expect(stripWavHeader(shortRaw, 16000)).toEqual({ pcm: shortRaw, sampleRate: 16000 });
    const nonRiff = Buffer.from('NOT_A_WAV_HEADER_DATA');
    expect(stripWavHeader(nonRiff, 24000)).toEqual({ pcm: nonRiff, sampleRate: 24000 });

    expect(parseNarrativesYaml('- id: n1\n  title: Oakville\n')).toEqual([
      { id: 'n1', slug: undefined, title: 'Oakville', kind: undefined, body_md: undefined },
    ]);
    expect(parseNarrativesYaml('scalar_only')).toEqual([]);

    expect(defaultMp3Path('/tmp/bio.script.md')).toBe('/tmp/bio.mp3');
    expect(defaultMp3Path('/tmp/bio.md')).toBe('/tmp/bio.mp3');
    expect(defaultMp3Path('/tmp/bio')).toBe('/tmp/bio.mp3');

    expect(inferAudioMimeType('clip.wav')).toBe('audio/wav');
    expect(inferAudioMimeType('clip.ogg')).toBe('audio/ogg');
    expect(inferAudioMimeType('clip.mp3')).toBe('audio/mpeg');
  });

  it('covers synthesis.ts auth resolution, retries, Chirp/Gemini synthesis, ffmpeg encoding, and helper errors', async () => {
    const dir = await makeTempDir();

    // readNamesJson validation errors
    const arrPath = path.join(dir, 'arr.json');
    await writeFile(arrPath, '["Jane"]');
    expect(() => readNamesJson(arrPath)).toThrow(/must be a JSON object/);
    const badValPath = path.join(dir, 'badval.json');
    await writeFile(badValPath, JSON.stringify({ Oakville: 123 }));
    expect(() => readNamesJson(badValPath)).toThrow(/must map to an IPA string/);

    // defaultExecFile & findExecutableOnPath & requireExistingFile
    const okExec = await naDefaultExecFile(process.execPath, ['-e', 'process.stdout.write("na-ok")']);
    expect(okExec.stdout.toString('utf8')).toBe('na-ok');
    await expect(
      naDefaultExecFile(process.execPath, ['-e', 'process.stderr.write("na-err"); process.exit(2)'])
    ).rejects.toMatchObject({ code: 2 });

    const binName = path.basename(process.execPath);
    const binDir = path.dirname(process.execPath);
    expect(findExecutableOnPath(binName, { PATH: binDir })).toBe(process.execPath);
    expect(findExecutableOnPath('no-such-bin-xyz', { PATH: dir })).toBeNull();

    const { ctx: baseCtx } = makeCtx({ cwd: dir, env: { PATH: '' } });
    expect(() => requireExistingFile('missing.md', 'script file', baseCtx)).toThrow(/script file not found/);

    // resolveGeminiApiKey: key-file & missing env error
    const keyFile = path.join(dir, 'gemini.key');
    await writeFile(keyFile, '  test-gemini-key \n');
    expect(resolveGeminiApiKey(keyFile, baseCtx)).toBe('test-gemini-key');
    expect(() => resolveGeminiApiKey(undefined, baseCtx)).toThrow(/Set GEMINI_API_KEY/);

    // resolveCloudTtsHeaders: keyFile, env key, missing gcloud, gcloud failures, empty token, unset project
    expect(await resolveCloudTtsHeaders(undefined, keyFile, baseCtx)).toEqual({
      'x-goog-api-key': 'test-gemini-key',
    });
    const { ctx: envKeyCtx } = makeCtx({ env: { GOOGLE_CLOUD_TTS_API_KEY: 'cloud-key' } });
    expect(await resolveCloudTtsHeaders(undefined, undefined, envKeyCtx)).toEqual({
      'x-goog-api-key': 'cloud-key',
    });
    await expect(resolveCloudTtsHeaders(undefined, undefined, baseCtx)).rejects.toThrow(
      /gcloud not found on PATH/
    );

    const { ctx: gcloudFailCtx } = makeCtx({
      execFileImpl: async () => {
        throw Object.assign(new Error('auth failed'), { stderr: Buffer.from('not logged in') });
      },
    });
    await expect(resolveCloudTtsHeaders(undefined, undefined, gcloudFailCtx)).rejects.toThrow(
      /Failed to get gcloud access token: not logged in/
    );

    const { ctx: gcloudEmptyCtx } = makeCtx({
      execFileImpl: async () => ({ stdout: Buffer.from('   '), stderr: Buffer.alloc(0) }),
    });
    await expect(resolveCloudTtsHeaders(undefined, undefined, gcloudEmptyCtx)).rejects.toThrow(
      /run gcloud auth login/
    );

    // postJsonWithRetries: HTTP 400, non-object JSON, retries exhausted on 503
    const { ctx: http400Ctx } = makeCtx({ fetchImpl: async () => new Response('bad req', { status: 400 }) });
    await expect(
      postJsonWithRetries({
        url: 'https://example.test',
        headers: {},
        body: {},
        label: 'tts',
        ctx: http400Ctx,
      })
    ).rejects.toThrow(/HTTP 400: bad req/);

    const { ctx: nonObjCtx } = makeCtx({ fetchImpl: async () => new Response('[1]', { status: 200 }) });
    await expect(
      postJsonWithRetries({
        url: 'https://example.test',
        headers: {},
        body: {},
        label: 'tts',
        ctx: nonObjCtx,
      })
    ).rejects.toThrow(/unexpected non-object JSON/);

    const { ctx: retry503Ctx } = makeCtx({
      fetchImpl: async () => new Response('busy', { status: 503 }),
    });
    await expect(
      postJsonWithRetries({
        url: 'https://example.test',
        headers: {},
        body: {},
        label: 'tts',
        ctx: retry503Ctx,
        retries: 1,
      })
    ).rejects.toThrow(/HTTP 503/);

    // synthesizeWithChirp: missing audioContent
    const { ctx: chirpBadCtx } = makeCtx({
      env: { GOOGLE_CLOUD_TTS_API_KEY: 'k' },
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    await expect(
      synthesizeWithChirp({
        chunks: [{ text: 'Oakville 1895', voice: 'Charon', pauseBefore: 0.5, isNotes: false }],
        namesMap: {},
        languageCode: 'en-US',
        gcpProject: undefined,
        keyFile: undefined,
        ctx: chirpBadCtx,
      })
    ).rejects.toThrow(/missing audioContent/);

    // synthesizeWithGemini: missing inlineData, then RIFF WAV + notes chunk silence/notesStartSec
    const { ctx: gemBadCtx } = makeCtx({
      env: { GEMINI_API_KEY: 'k' },
      fetchImpl: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    });
    await expect(
      synthesizeWithGemini({
        chunks: [{ text: 'Hello', voice: 'Charon', pauseBefore: 0, isNotes: false }],
        model: 'gemini-3.8-flash-tts',
        keyFile: undefined,
        ctx: gemBadCtx,
      })
    ).rejects.toThrow(/missing inline audio data/);

    const wavBytes = makeSyntheticWav(Buffer.alloc(4410, 1), 22050); // 0.1s at 22050Hz
    const { ctx: gemWavCtx } = makeCtx({
      env: { GEMINI_API_KEY: 'k' },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'audio/wav', data: wavBytes.toString('base64') } }],
                },
              },
            ],
            usageMetadata: { totalTokenCount: 25 },
          }),
          { status: 200 }
        ),
    });
    const gemOut = await synthesizeWithGemini({
      chunks: [
        { text: 'Story part', voice: 'Charon', pauseBefore: 0, isNotes: false },
        { text: 'Notes part', voice: 'Kore', pauseBefore: 0.5, isNotes: true },
      ],
      model: 'gemini-3.8-flash-tts',
      keyFile: undefined,
      ctx: gemWavCtx,
    });
    expect(gemOut.sampleRate).toBe(22050);
    expect(gemOut.notesStartSec).toBeCloseTo(0.6, 2);
    expect(gemOut.usageStr).toBe('50 tokens');

    // encodePcmToMp3: ENOENT vs generic error
    const outMp3 = path.join(dir, 'out.mp3');
    const { ctx: noFfmpegCtx } = makeCtx({
      execFileImpl: async () => {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
    });
    await expect(
      encodePcmToMp3({
        pcm: Buffer.alloc(16),
        sampleRate: 24000,
        bitrate: '96k',
        outPath: outMp3,
        ctx: noFfmpegCtx,
      })
    ).rejects.toThrow(/ffmpeg not found on PATH/);

    const { ctx: failFfmpegCtx } = makeCtx({
      execFileImpl: async () => {
        throw new Error('codec error');
      },
    });
    await expect(
      encodePcmToMp3({
        pcm: Buffer.alloc(16),
        sampleRate: 24000,
        bitrate: '96k',
        outPath: outMp3,
        ctx: failFfmpegCtx,
      })
    ).rejects.toThrow(/codec error/);

    // Verify defaultMp3Path via CLI dry-run + invalid backend
    const scriptPath = path.join(dir, 'sample.script.md');
    await writeFile(scriptPath, '## Oakville\n\nJane Doe lived in Oakville.\n');
    const { ctx: badBeCtx } = makeCtx({ cwd: dir });
    expect(
      (await runNarrativeAudioCommand(['synth', scriptPath, '--backend', 'bad'], badBeCtx)).exitCode
    ).toBe(2);
  });
});

// ============================================================================
// 4. Chronam: httpFetch, commands, transport, domain
// ============================================================================

describe('chronam behavioral coverage', () => {
  it('covers domain helpers: URL validation, invalid download detection, safe paths, dates, assets', () => {
    expect(() => validateLocUrl('https://www.loc.gov/\nfoo')).toThrow(/Invalid URL/);
    expect(() => validateLocUrl('not a url')).toThrow(/Refusing to access/);
    expect(() => validateLocUrl('https://user:pass@www.loc.gov/')).toThrow(/Refusing to access/);
    expect(() => validateLocUrl('https://archive.example.test/')).toThrow(/non-loc.gov host/);

    expect(detectInvalidDownload(Buffer.from('  <!doctype html>'), 'application/octet-stream', 'bin')).toBe(
      'HTML error page'
    );
    expect(detectInvalidDownload(Buffer.from('not-pdf'), 'application/pdf', 'pdf')).toBe('non-PDF payload');
    expect(detectInvalidDownload(Buffer.from('not-img'), 'image/jpeg', 'image')).toBe('non-image payload');
    expect(detectInvalidDownload(Buffer.from('not-jp2'), 'image/jp2', 'jp2')).toBe('non-JP2 payload');
    expect(detectInvalidDownload(Buffer.from([0xff, 0x4f, 0xff, 0x51, 0x00]), 'image/jp2', 'jp2')).toBeNull();

    expect(() => resolveSafeChild('/tmp/root', '../escape.txt')).toThrow();
    expect(safeOutputFilename('...')).toBe('page.bin');
    expect(() => resolveDates(undefined, 'abcd', '1895')).toThrow(/expected YYYY/);
    expect(
      buildSearchParams('Oakville', { level: 'page', limit: 5, page: 1, lccn: 'sn83045462' })
    ).toContainEqual(['fa', 'number_lccn:sn83045462']);
    expect(extractSeqFromUrl('not-a-url', '3')).toBe('3');
    expect(iiifJpegFromInfo('https://tile.loc.gov/other', 800)).toBeNull();

    const assets = resolvePageAssets(
      {
        page: [
          'ignored-non-record',
          { mimetype: 'text/xml', url: 'https://tile.loc.gov/alto.xml' },
          { mimetype: 'image/jpeg', url: 'https://tile.loc.gov/page.jpg' },
          { mimetype: 'application/octet-stream', info: 'https://tile.loc.gov/iiif/p1/info.json' },
        ],
      },
      { imageWidth: 1200 }
    );
    expect(assets.text).toBe('https://tile.loc.gov/alto.xml');
    expect(assets.image).toBe('https://tile.loc.gov/iiif/p1/full/1200,/0/default.jpg');
  });

  it('covers httpFetch redirects, timeouts, non-JSON, connect timeouts, and transport caching', async () => {
    const cacheDir = await makeTempDir();

    expect(isTimeoutError(new Error('x'), true)).toBe(true);
    expect(isTimeoutError('not-error', false)).toBe(false);
    expect(isTimeoutError(Object.assign(new Error('t'), { name: 'ConnectTimeoutError' }), false)).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), false)).toBe(true);

    // fetchFollowingLocRedirects: valid redirect, no location, >10 redirects, disallowed host
    let hopCount = 0;
    const { ctx: redirCtx } = makeCtx({
      fetchImpl: async () => {
        hopCount += 1;
        if (hopCount === 1) {
          return new Response('', {
            status: 302,
            headers: { location: '/collections/chronicling-america/?fo=json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    const redirRes = await fetchFollowingLocRedirects(
      redirCtx,
      'https://www.loc.gov/start',
      {},
      new AbortController().signal
    );
    expect(redirRes.response.status).toBe(200);
    expect(redirRes.finalUrl).toBe('https://www.loc.gov/collections/chronicling-america/?fo=json');

    const { ctx: noLocCtx } = makeCtx({ fetchImpl: async () => new Response('', { status: 301 }) });
    const noLocRes = await fetchFollowingLocRedirects(
      noLocCtx,
      'https://www.loc.gov/a',
      {},
      new AbortController().signal
    );
    expect(noLocRes.response.status).toBe(301);

    const { ctx: loopCtx } = makeCtx({
      fetchImpl: async () =>
        new Response('', { status: 302, headers: { location: 'https://www.loc.gov/loop' } }),
    });
    await expect(
      fetchFollowingLocRedirects(loopCtx, 'https://www.loc.gov/loop', {}, new AbortController().signal)
    ).rejects.toThrow(/Too many redirects/);

    // getJson error paths: HTTP 404, non-JSON text, JSON array, ConnectTimeoutError, generic conn error, timer abort
    await expect(
      getJson(
        makeCtx({ fetchImpl: async () => new Response('nope', { status: 404 }) }).ctx,
        'https://www.loc.gov/x'
      )
    ).rejects.toThrow(/HTTP 404/);

    await expect(
      getJson(
        makeCtx({
          fetchImpl: async () =>
            new Response('<html>err</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        }).ctx,
        'https://www.loc.gov/x'
      )
    ).rejects.toThrow(/non-JSON response/);

    await expect(
      getJson(
        makeCtx({ fetchImpl: async () => new Response('[1,2]', { status: 200 }) }).ctx,
        'https://www.loc.gov/x'
      )
    ).rejects.toThrow(/non-JSON response/);

    await expect(
      getJson(
        makeCtx({
          fetchImpl: async () => {
            const err = new Error('connect timeout');
            err.name = 'ConnectTimeoutError';
            throw err;
          },
        }).ctx,
        'https://www.loc.gov/x',
        { timeout: 1 }
      )
    ).rejects.toThrow(/timed out/);

    await expect(
      getJson(
        makeCtx({
          fetchImpl: async () => {
            throw new Error('ECONNREFUSED');
          },
        }).ctx,
        'https://www.loc.gov/x',
        { timeout: 1 }
      )
    ).rejects.toThrow(/loc.gov connection error: ECONNREFUSED/);

    await expect(
      getJson(
        makeCtx({
          fetchImpl: async (_u, init) =>
            new Promise<Response>((_res, rej) => {
              init?.signal?.addEventListener('abort', () => rej(init.signal?.reason ?? new Error('aborted')));
            }),
        }).ctx,
        'https://www.loc.gov/x',
        { timeout: 0.05 }
      )
    ).rejects.toThrow(/timed out/);

    // cachedGetJson param sorting with duplicate key
    const { ctx: sortCtx } = makeCtx({
      env: { KINLOOM_CHRONAM_CACHE_DIR: cacheDir },
      fetchImpl: async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    });
    const sortedHit = await cachedGetJson(
      sortCtx,
      'https://www.loc.gov/collections/chronicling-america/',
      [
        ['fa', 'z'],
        ['fa', 'a'],
      ],
      { timeout: 5, refresh: false, ttlHours: 1 }
    );
    expect(sortedHit.data).toEqual({ ok: 1 });

    // transport: cachedDownloadBytes + streamDownloadToPath errors + corrupt cache meta recovery
    const pdfPayload = Buffer.from('%PDF-1.4\nOakville Chronicle 1895');
    let dlCalls = 0;
    const { ctx: dlCtx } = makeCtx({
      env: { KINLOOM_CHRONAM_CACHE_DIR: cacheDir },
      fetchImpl: async () => {
        dlCalls += 1;
        return new Response(pdfPayload, { status: 200, headers: { 'content-type': 'application/pdf' } });
      },
    });
    const b1 = await cachedDownloadBytes(dlCtx, 'https://tile.loc.gov/p1.pdf', {
      timeout: 5,
      refresh: false,
      ttlHours: 1,
      kind: 'pdf',
    });
    const b2 = await cachedDownloadBytes(dlCtx, 'https://tile.loc.gov/p1.pdf', {
      timeout: 5,
      refresh: false,
      ttlHours: 1,
      kind: 'pdf',
    });
    expect(b1.cacheHit).toBe(false);
    expect(b2.cacheHit).toBe(true);
    expect(b2.data.equals(pdfPayload)).toBe(true);
    expect(dlCalls).toBe(1);

    // Corrupt cache metadata triggers re-download (bad schema, expired TTL, size mismatch)
    const filesDir = path.join(cacheDir, 'files');
    const jsonMeta = fs.readdirSync(filesDir).find((f) => f.endsWith('.json'));
    const binFile = fs.readdirSync(filesDir).find((f) => f.endsWith('.bin'));
    if (jsonMeta) {
      await writeFile(
        path.join(filesDir, jsonMeta),
        JSON.stringify({ schema: 999, fetched_at: 0, nbytes: 1 })
      );
    }
    const b3 = await cachedDownloadFile(dlCtx, 'https://tile.loc.gov/p1.pdf', {
      timeout: 5,
      refresh: false,
      ttlHours: 1,
      kind: 'pdf',
    });
    expect(b3.cacheHit).toBe(false);
    expect(dlCalls).toBe(2);

    if (jsonMeta && binFile) {
      await writeFile(
        path.join(filesDir, jsonMeta),
        JSON.stringify({
          schema: 1,
          fetched_at: 1,
          nbytes: pdfPayload.length,
          content_type: 'application/pdf',
        })
      );
      const bExpired = await cachedDownloadFile(dlCtx, 'https://tile.loc.gov/p1.pdf', {
        timeout: 5,
        refresh: false,
        ttlHours: 1,
        kind: 'pdf',
      });
      expect(bExpired.cacheHit).toBe(false);
      await writeFile(
        path.join(filesDir, jsonMeta),
        JSON.stringify({
          schema: 1,
          fetched_at: Date.now() / 1000,
          nbytes: pdfPayload.length + 10,
          content_type: 'application/pdf',
        })
      );
      const bMismatch = await cachedDownloadFile(dlCtx, 'https://tile.loc.gov/p1.pdf', {
        timeout: 5,
        refresh: false,
        ttlHours: 1,
        kind: 'pdf',
      });
      expect(bMismatch.cacheHit).toBe(false);
    }

    // Response with null body falls back to arrayBuffer(), and timeout abort fires cleanly
    const nullBodyDest = path.join(cacheDir, 'nullbody.pdf');
    const nullBodyRes = await streamDownloadToPath(
      makeCtx({
        fetchImpl: async () => {
          const resp = new Response(pdfPayload, {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
          Object.defineProperty(resp, 'body', { value: null });
          return resp;
        },
      }).ctx,
      'https://tile.loc.gov/nullbody.pdf',
      nullBodyDest,
      { timeout: 5, kind: 'pdf' }
    );
    expect(nullBodyRes.nbytes).toBe(pdfPayload.length);

    let nowTick = 0;
    await expect(
      streamDownloadToPath(
        makeCtx({
          nowMs: () => {
            nowTick += 1;
            return nowTick === 1 ? 1000 : 1900;
          },
          fetchImpl: async (_u, init) =>
            new Promise<Response>((_res, rej) => {
              init?.signal?.addEventListener('abort', () => rej(init.signal?.reason ?? new Error('aborted')));
            }),
        }).ctx,
        'https://tile.loc.gov/hang.pdf',
        path.join(cacheDir, 'hang.pdf'),
        { timeout: 1, kind: 'pdf' }
      )
    ).rejects.toThrow(/Failed downloading/);

    // streamDownloadToPath: empty response, HTTP 404, HTTP 503 exhausted, incomplete content-length
    const dest = path.join(cacheDir, 'out.pdf');
    await expect(
      streamDownloadToPath(
        makeCtx({ fetchImpl: async () => new Response('', { status: 200 }) }).ctx,
        'https://tile.loc.gov/empty.pdf',
        dest,
        { timeout: 1, kind: 'pdf' }
      )
    ).rejects.toThrow(/Download was empty/);

    await expect(
      streamDownloadToPath(
        makeCtx({ fetchImpl: async () => new Response('no', { status: 404 }) }).ctx,
        'https://tile.loc.gov/missing.pdf',
        dest,
        { timeout: 1, kind: 'pdf' }
      )
    ).rejects.toThrow(/HTTP 404/);

    await expect(
      streamDownloadToPath(
        makeCtx({ fetchImpl: async () => new Response('busy', { status: 503 }) }).ctx,
        'https://tile.loc.gov/busy.pdf',
        dest,
        { timeout: 1, kind: 'pdf' }
      )
    ).rejects.toThrow(/transient service error/);

    await expect(
      streamDownloadToPath(
        makeCtx({
          fetchImpl: async () =>
            new Response(Buffer.from('%PDF-1'), {
              status: 200,
              headers: { 'content-type': 'application/pdf', 'content-length': '9999' },
            }),
        }).ctx,
        'https://tile.loc.gov/short.pdf',
        dest,
        { timeout: 1, kind: 'pdf' }
      )
    ).rejects.toThrow(/Incomplete download/);
  });

  it('covers chronam commands: help, text search + empty-page warning, download fallbacks, and url', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'dl');

    const runCh = async (args: readonly string[], fetchImpl: typeof fetch) => {
      const { ctx, stdout, stderr } = makeCtx({
        cwd: cacheDir,
        env: { KINLOOM_CHRONAM_CACHE_DIR: cacheDir },
        fetchImpl,
      });
      const res = await runChronamCommand(args, ctx);
      return { exitCode: res.exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    };

    const noopFetch: typeof fetch = async () => new Response('{}', { status: 200 });
    for (const sub of ['search', 'get', 'page', 'download', 'url']) {
      const help = await runCh([sub, '--help'], noopFetch);
      expect(help.exitCode).toBe(0);
    }

    // url subcommand
    const urlRes = await runCh(
      ['url', 'Oakville', '--state', 'OH', '--dates', '1895', '--lccn', 'sn83045462'],
      noopFetch
    );
    expect(urlRes.exitCode).toBe(0);
    expect(urlRes.stdout).toContain('https://www.loc.gov/collections/chronicling-america/?');
    expect(urlRes.stdout).toContain('q=Oakville');
    expect(urlRes.stdout).not.toContain('fo=json');

    // search plain text + hits>0 with 0 rows warning
    const warnSearch = await runCh(
      ['search', 'Oakville', '--page', '5'],
      async () => new Response(JSON.stringify({ search: { hits: 12 }, results: [] }), { status: 200 })
    );
    expect(warnSearch.exitCode).toBe(0);
    expect(warnSearch.stderr).toContain('Warning: loc.gov reported 12 total hits');
    expect(warnSearch.stdout).toContain('hits: 12 (showing 0 on this page)');

    const textSearch = await runCh(
      ['search', 'Oakville'],
      async () =>
        new Response(
          JSON.stringify({
            search: { hits: 1 },
            results: [
              {
                partof_title: ['Oakville Chronicle'],
                date: '1895-04-10',
                location_state: ['ohio'],
                url: 'https://www.loc.gov/resource/sn83045462/1895-04-10/ed-1/?sp=1',
              },
            ],
          }),
          { status: 200 }
        )
    );
    expect(textSearch.exitCode).toBe(0);
    expect(textSearch.stdout).toContain('- 1895-04-10 | Oakville Chronicle | ohio |');

    // get & download missing args -> exitCode 2
    expect((await runCh(['get'], noopFetch)).exitCode).toBe(2);
    expect((await runCh(['download'], noopFetch)).exitCode).toBe(2);

    // download: --pdf falls back to image when no PDF, plus --jp2 and --text; and empty assets -> exitCode 1
    const jpgMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const jp2Magic = Buffer.from([0xff, 0x4f, 0xff, 0x51, 0x00, 0x2f]);
    const dlFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('fo=json')) {
        return new Response(
          JSON.stringify({
            item: { date: '1895-04-10', number_lccn: ['sn83045462'] },
            page: [
              { mimetype: 'image/jp2', url: 'https://tile.loc.gov/p1.jp2' },
              { mimetype: 'image/jpeg', url: 'https://tile.loc.gov/p1.jpg' },
              { mimetype: 'text/xml', url: 'https://tile.loc.gov/p1.xml' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('.jpg'))
        return new Response(jpgMagic, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      if (url.endsWith('.jp2'))
        return new Response(jp2Magic, { status: 200, headers: { 'content-type': 'image/jp2' } });
      return new Response('<alto>Oakville</alto>', { status: 200, headers: { 'content-type': 'text/xml' } });
    };
    const dlRes = await runCh(
      [
        'download',
        '--lccn',
        'sn83045462',
        '--date',
        '1895-04-10',
        '--pdf',
        '--jp2',
        '--text',
        '--out',
        outDir,
      ],
      dlFetch
    );
    expect(dlRes.exitCode).toBe(0);
    expect(dlRes.stdout).toContain('image:');
    expect(dlRes.stdout).toContain('jp2:');
    expect(dlRes.stdout).toContain('text:');

    const emptyDl = await runCh(
      ['download', '--lccn', 'sn83045462', '--date', '1895-04-11', '--pdf', '--out', outDir],
      async () =>
        new Response(JSON.stringify({ item: { date: '1895-04-11' }, resources: [], page: [] }), {
          status: 200,
        })
    );
    expect(emptyDl.exitCode).toBe(1);
    expect(emptyDl.stderr).toContain('No downloadable resources found');
  });
});

// ============================================================================
// 5. Prep-scan: geometry, pdfCommands, rasterCommands, sheetAndStitchCommands
// ============================================================================

describe('prep-scan behavioral coverage', () => {
  it('covers geometry edge cases and validation errors', () => {
    expect(() => parseBox('1,notnum,10,20')).toThrow(/Invalid integer coordinates/);
    expect(() => parsePageSpec('1-2-3')).toThrow(/Invalid page range/);
    expect(() => parsePageSpec('a-5')).toThrow(/Use integer bounds/);
    expect(() => parsePageSpec('0-3')).toThrow(/page numbers must be >= 1/);
    expect(() => parsePageSpec('5-2')).toThrow(/exceeds end/);
    expect(() => parsePageSpec('1-20,21-26')).toThrow(/more than 25 pages/);
    expect(() => parsePageSpec('abc')).toThrow(/Invalid page number/);
    expect(() => parsePageSpec('0')).toThrow(/must be >= 1/);
    expect(() => parsePageSpec('1,2,3,4', 3)).toThrow(/more than 3 pages/);
    expect(coalesceRanges([])).toEqual([]);

    expect(() => clampBox({ x0: 10, y0: 10, x1: 10, y1: 20 }, 100, 100, 'test')).toThrow(
      /collapses to empty/
    );
    expect(() => parseRgbColor('#12345')).toThrow(/Invalid --divider-color/);
    expect(() => parseRgbColor('rgb(300,0,0)')).toThrow(/Invalid --divider-color/);
    expect(
      expandMultiBoxArgs(['--box', '0,0,10,10', '0,10,10,20', '--', '0,20,10,30'], new Set(['--box']))
    ).toEqual(['--box', '0,0,10,10', '--box', '0,10,10,20', '--', '0,20,10,30']);
    expect(() => normalizeRotationAngle(Number.NaN)).toThrow(/Unsupported rotation/);
  });

  it('covers pdfCommands error paths, cache recovery, help, and non-JSON outputs', async () => {
    const dir = await makeTempDir();
    const cacheDir = path.join(dir, 'cache');
    const outDir = path.join(dir, 'pages');
    const pdfPath = path.join(dir, 'oakville.pdf');
    await writeFile(pdfPath, '%PDF-1.4\nsynthetic pdf');

    const runPs = async (args: readonly string[], execFileImpl?: ExecFileFn) => {
      const { ctx, stdout, stderr } = makeCtx({
        cwd: dir,
        env: { KINLOOM_OCR_CACHE_DIR: cacheDir },
        execFileImpl,
      });
      const res = await runPrepScanCommand(args, ctx);
      return { exitCode: res.exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    };

    // Help & missing file errors
    expect((await runPs(['pdf-pages', '--help'])).exitCode).toBe(0);
    expect((await runPs(['pdf-grep', '--help'])).exitCode).toBe(0);
    expect((await runPs(['pdf-pages', 'missing.pdf', '--pages', '1', '--out-dir', outDir])).exitCode).toBe(1);
    expect((await runPs(['pdf-grep', 'missing.pdf', '--pattern', 'Oakville'])).exitCode).toBe(1);
    expect((await runPs(['pdf-grep', pdfPath, '--pattern', 'Oak', '--limit', '0'])).exitCode).toBe(2);

    // pdftoppm ENOENT, killed timeout, generic error, empty rendered output
    const enoentRes = await runPs(
      ['pdf-pages', pdfPath, '--pages', '1', '--out-dir', outDir],
      async (bin) => {
        if (bin === 'pdfinfo') throw new Error('no pdfinfo');
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
    );
    expect(enoentRes.exitCode).toBe(1);
    expect(enoentRes.stderr).toContain('pdftoppm executable not found');

    const killedRes = await runPs(
      ['pdf-pages', pdfPath, '--pages', '1', '--out-dir', outDir],
      async (bin) => {
        if (bin === 'pdfinfo') throw new Error('no pdfinfo');
        throw Object.assign(new Error('timeout'), { killed: true });
      }
    );
    expect(killedRes.exitCode).toBe(1);
    expect(killedRes.stderr).toContain('pdftoppm timed out');

    const failRes = await runPs(['pdf-pages', pdfPath, '--pages', '1', '--out-dir', outDir], async (bin) => {
      if (bin === 'pdfinfo') throw new Error('no pdfinfo');
      throw Object.assign(new Error('bad pdf'), { code: 2, stderr: Buffer.from('corrupt xref') });
    });
    expect(failRes.exitCode).toBe(1);
    expect(failRes.stderr).toContain('pdftoppm failed (exit 2)');

    const emptyRenderRes = await runPs(
      ['pdf-pages', pdfPath, '--pages', '1', '--out-dir', outDir],
      async (bin) => {
        if (bin === 'pdfinfo') throw new Error('no pdfinfo');
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
    );
    expect(emptyRenderRes.exitCode).toBe(2);
    expect(emptyRenderRes.stderr).toContain('out of range or could not be rendered');

    // Successful pdf-pages plain-text output with --strip
    const stripPath = path.join(dir, 'strip.jpg');
    const sampleImg = await createSyntheticPng(80, 60);
    const okPdfPages = await runPs(
      ['pdf-pages', pdfPath, '--pages', '1', '--out-dir', outDir, '--strip', stripPath],
      async (bin, args) => {
        if (bin === 'pdfinfo') {
          return { stdout: Buffer.from('Pages: 2\n'), stderr: Buffer.alloc(0) };
        }
        const prefix = args[args.length - 1];
        await writeFile(`${prefix}-1.jpg`, sampleImg);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
    );
    expect(okPdfPages.exitCode).toBe(0);
    expect(okPdfPages.stdout).toContain('strip:');

    // pdftotext ENOENT, then zero-length regex match in pdf-grep
    const noPdftotext = await runPs(['pdf-grep', pdfPath, '--pattern', 'Oakville'], async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect(noPdftotext.exitCode).toBe(1);
    expect(noPdftotext.stderr).toContain('pdftotext not found on PATH');

    const zeroMatchGrep = await runPs(['pdf-grep', pdfPath, '--pattern', '^', '--json'], async () => ({
      stdout: Buffer.from('Oakville 1895\f'),
      stderr: Buffer.alloc(0),
    }));
    expect(zeroMatchGrep.exitCode).toBe(1);
    expect(JSON.parse(zeroMatchGrep.stdout)).toMatchObject({ match_count: 0 });

    // Corrupt cached pdf-text JSON shapes are ignored and re-extracted
    const pdfTextDir = path.join(cacheDir, 'pdf-text');
    const cachedTextFile = fs.readdirSync(pdfTextDir).find((f) => f.endsWith('.json'));
    if (cachedTextFile) {
      await writeFile(path.join(pdfTextDir, cachedTextFile), '[]');
      const rec1 = await runPs(['pdf-grep', pdfPath, '--pattern', 'Oakville', '--json'], async () => ({
        stdout: Buffer.from('Oakville 1895\f'),
        stderr: Buffer.alloc(0),
      }));
      expect(rec1.exitCode).toBe(0);
      expect(JSON.parse(rec1.stdout).cache_hit).toBe(false);

      await writeFile(path.join(pdfTextDir, cachedTextFile), JSON.stringify({ pages: [123] }));
      const rec2 = await runPs(['pdf-grep', pdfPath, '--pattern', 'Oakville', '--json'], async () => ({
        stdout: Buffer.from('Oakville 1895\f'),
        stderr: Buffer.alloc(0),
      }));
      expect(rec2.exitCode).toBe(0);
      expect(JSON.parse(rec2.stdout).cache_hit).toBe(false);
    }
  });

  it('covers rasterCommands and sheetAndStitchCommands help, missing files, text outputs, and padding', async () => {
    const dir = await makeTempDir();
    const cacheDir = path.join(dir, 'cache');
    const img1 = path.join(dir, 'img1.png');
    await createSolidPng(img1, 120, 80, [220, 220, 220]);

    const runPs = async (args: readonly string[]) => {
      const { ctx, stdout, stderr } = makeCtx({
        cwd: dir,
        env: { KINLOOM_OCR_CACHE_DIR: cacheDir },
      });
      const res = await runPrepScanCommand(args, ctx);
      return { exitCode: res.exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    };

    // Help & missing files across raster & sheet/stitch commands
    expect((await runPs(['rotate', '--help'])).exitCode).toBe(0);
    expect((await runPs(['sheet-strip', '--help'])).exitCode).toBe(0);
    expect((await runPs(['stitch', '--help'])).exitCode).toBe(0);
    expect((await runPs(['crop', 'missing.png', path.join(dir, 'c.jpg')])).exitCode).toBe(1);
    expect((await runPs(['rotate', 'missing.png', path.join(dir, 'r.jpg'), '--angle', '90'])).exitCode).toBe(
      1
    );
    expect((await runPs(['grid', 'missing.png', path.join(dir, 'g.jpg')])).exitCode).toBe(1);
    expect((await runPs(['join', img1, 'missing.png', '--out', path.join(dir, 'j.jpg')])).exitCode).toBe(1);
    expect(
      (await runPs(['stitch', 'missing.png', path.join(dir, 's.jpg'), '--box', '0,0,10,10', '10,10,20,20']))
        .exitCode
    ).toBe(1);

    // preview & crop plain-text outputs (default preview cache path for crop)
    const prevText = await runPs(['preview', img1, '--out-dir', path.join(dir, 'prev')]);
    expect(prevText.exitCode).toBe(0);
    expect(prevText.stdout).toContain('img1.preview.jpg');

    const cropText = await runPs(['crop', img1, path.join(dir, 'cropped.jpg'), '--box', '0,0,60,40']);
    expect(cropText.exitCode).toBe(0);
    expect(cropText.stdout).toContain('output:');
    expect(cropText.stdout).toContain('preview:');

    // sheet-strip plain-text output with partial failure warning
    const stripRes = await runPs([
      'sheet-strip',
      img1,
      'missing_band.png',
      '--out',
      path.join(dir, 'ss.jpg'),
    ]);
    expect(stripRes.exitCode).toBe(0);
    expect(stripRes.stdout).toContain('(1/2 bands)');
    expect(stripRes.stderr).toContain('warning: missing_band.png:');

    // stitch horizontal with unequal heights (white vertical padding) + vertical with --labels
    const hStitch = await runPs([
      'stitch',
      img1,
      path.join(dir, 'hstitch.jpg'),
      '--direction',
      'horizontal',
      '--box',
      '0,0,40,20',
      '40,0,80,60',
    ]);
    expect(hStitch.exitCode).toBe(0);
    expect(JSON.parse(hStitch.stdout).height).toBe(60);

    const vStitch = await runPs([
      'stitch',
      img1,
      path.join(dir, 'vstitch.jpg'),
      '--direction',
      'vertical',
      '--labels',
      'Header,Detail',
      '--box',
      '0,0,100,20',
      '0,20,60,60',
    ]);
    expect(vStitch.exitCode).toBe(0);
    expect(JSON.parse(vStitch.stdout).bands).toHaveLength(2);
  });
});

// ============================================================================
// 6. HathiTrust: hathi.ts
// ============================================================================

describe('hathi behavioral coverage', () => {
  it('covers help outputs, url builder, parseHathiId errors, compactBib formatting, and error caching', async () => {
    const cacheDir = await makeTempDir();

    expect(() => parseHathiId('missingcolon')).toThrow(/Use type:value/);
    expect(() => parseHathiId('bogus:123')).toThrow(/Type must be one of/);
    expect(() => parseHathiId('oclc:   ')).toThrow(/Type must be one of/);

    expect(compactBib({ records: {}, items: [] }, false, true)).toBe(
      'No matching HathiTrust record (empty records and items). [cache]'
    );
    const fullText = compactBib(
      {
        records: {
          '001234567': {
            recordURL: 'https://catalog.hathitrust.org/Record/001234567',
            titles: ['Oakville Gazette', 'Oakville Weekly'],
            publishDates: ['1895'],
            oclcs: ['12345'],
            'marc-xml': '<record/>',
          },
        },
        items: [
          {
            htid: 'mdp.39015000000099',
            orig: 'State Library',
            itemURL: 'https://hdl.handle.net/2027/mdp.39015000000099',
            enumcron: 'v.2 (1895)',
            rightsCode: 'pd',
            usRightsString: 'Full view',
          },
        ],
      },
      true,
      false
    );
    expect(fullText).toContain('alt titles: Oakville Weekly');
    expect(fullText).toContain('marc-xml:\n<record/>');
    expect(fullText).toContain('enumcron: v.2 (1895)');

    const runHathi = async (args: readonly string[], fetchImpl: typeof fetch) => {
      const { ctx, stdout, stderr } = makeCtx({
        env: { KINLOOM_HATHI_CACHE_DIR: cacheDir },
        fetchImpl,
      });
      const res = await runHathiCommand(args, ctx);
      return { exitCode: res.exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    };

    const noopFetch: typeof fetch = async () => new Response('{}', { status: 200 });
    expect((await runHathi([], noopFetch)).stdout).toContain('kinloom hathi <command>');
    expect((await runHathi(['bib', '--help'], noopFetch)).stdout).toContain('kinloom hathi bib');
    expect((await runHathi(['url', '--help'], noopFetch)).stdout).toContain('kinloom hathi url');

    const urlOut = await runHathi(['url', 'Oakville History', '--type', 'title'], noopFetch);
    expect(urlOut.exitCode).toBe(0);
    expect(urlOut.stdout).toBe(
      'https://catalog.hathitrust.org/Search/Home?lookfor=Oakville%20History&type=title&inst='
    );

    expect((await runHathi(['unknown'], noopFetch)).exitCode).toBe(2);
    expect((await runHathi(['bib'], noopFetch)).exitCode).toBe(2);
    expect((await runHathi(['bib', 'invalidtype', '123'], noopFetch)).exitCode).toBe(2);

    // Payload with `error` field is never cached (re-fetches on second call)
    let errCalls = 0;
    const errFetch: typeof fetch = async () => {
      errCalls += 1;
      return new Response(
        JSON.stringify({ records: { '1': { titles: ['Temporary'] } }, items: [], error: 'upstream busy' }),
        { status: 200 }
      );
    };
    expect((await runHathi(['bib', 'oclc', '555555'], errFetch)).exitCode).toBe(0);
    expect((await runHathi(['bib', 'oclc', '555555'], errFetch)).exitCode).toBe(0);
    expect(errCalls).toBe(2);
  });
});
