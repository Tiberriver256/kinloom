import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext, type ExecFileFn, type RecordCommandContext } from '../runtime/index.js';
import {
  alignOffset,
  clampBox,
  coalesceRanges,
  formatPageSpec,
  normalizePdfFormat,
  normalizePrepScanArgv,
  parseBox,
  parseJoinAlign,
  parseJoinDirection,
  parsePageSpec,
  parseRgbColor,
  runPrepScanCommand,
  safeStem,
} from './prep-scan.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface InvokeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cacheHit?: boolean | undefined;
}

async function invokePrepScan(
  args: readonly string[],
  overrides: { [K in keyof RecordCommandContext]?: RecordCommandContext[K] | undefined } = {}
): Promise<InvokeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    sleepFn: async () => {},
    ...overrides,
  });
  const outcome = await runPrepScanCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

async function createSolidPng(
  filePath: string,
  width: number,
  height: number,
  rgb: readonly [number, number, number]
): Promise<void> {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
    limitInputPixels: false,
  })
    .png({ compressionLevel: 1 })
    .toBuffer();
  await writeFile(filePath, buf);
}

async function createSyntheticSheetPng(filePath: string): Promise<void> {
  // 2000x1200 light-cream sheet with top blue stripe (0..180) and lower green stripe (700..960)
  const buf = await sharp({
    create: {
      width: 2000,
      height: 1200,
      channels: 3,
      background: { r: 248, g: 244, b: 232 },
    },
    limitInputPixels: false,
  })
    .composite([
      {
        input: {
          create: {
            width: 2000,
            height: 181,
            channels: 3,
            background: { r: 210, g: 225, b: 240 },
          },
        },
        left: 0,
        top: 0,
      },
      {
        input: {
          create: {
            width: 2000,
            height: 261,
            channels: 3,
            background: { r: 225, g: 240, b: 215 },
          },
        },
        left: 0,
        top: 700,
      },
    ])
    .png({ compressionLevel: 1 })
    .toBuffer();
  await writeFile(filePath, buf);
}

async function readPixels(
  filePath: string,
  points: readonly (readonly [number, number])[]
): Promise<{ readonly size: readonly [number, number]; readonly px: number[][] }> {
  const { data, info } = await sharp(filePath, { limitInputPixels: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = points.map(([x, y]) => {
    const idx = (y * info.width + x) * info.channels;
    return [data[idx]!, data[idx + 1]!, data[idx + 2]!];
  });
  return { size: [info.width, info.height], px };
}

/** Build a minimal valid PDF with one line of Helvetica text per page. */
function buildTextPdf(pageTexts: readonly string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pageTexts.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageTexts.forEach((text, i) => {
    const pageId = pageIds[i]!;
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('prep-scan pure helpers', () => {
  it('parses boxes, clamps boxes, and normalizes comma-split argv', () => {
    expect(parseBox('10,20,30,40')).toEqual({ x0: 10, y0: 20, x1: 30, y1: 40 });
    expect(parseBox('10, 20, 30, 40')).toEqual({ x0: 10, y0: 20, x1: 30, y1: 40 });
    expect(parseBox('10 20 30 40')).toEqual({ x0: 10, y0: 20, x1: 30, y1: 40 });
    expect(parseBox('10.4, 20.6, 30.2, 40.8')).toEqual({ x0: 10, y0: 21, x1: 30, y1: 41 });
    expect(() => parseBox('10,20,30')).toThrow(/expected x0,y0,x1,y1/);
    expect(() => parseBox('10,20,10,40')).toThrow(/0 <= x0 < x1/);
    expect(() => parseBox('-1,0,10,10')).toThrow(/0 <= x0 < x1/);

    expect(clampBox({ x0: 5, y0: 10, x1: 120, y1: 90 }, 100, 80, 'test')).toEqual({
      x0: 5,
      y0: 10,
      x1: 100,
      y1: 80,
    });
    expect(() => clampBox({ x0: 100, y0: 10, x1: 120, y1: 20 }, 100, 80, 'test', 'hint')).toThrow(
      /starts outside 100x80 image\. hint/
    );

    expect(normalizePrepScanArgv(['--box', '10,', '20,', '30,', '40'])).toEqual(['--box', '10,20,30,40']);
    expect(normalizePrepScanArgv(['--pages', '4,', '1-3,', '2'])).toEqual(['--pages', '4,1-3,2']);
    expect(normalizePrepScanArgv(['--box=10,', '20,', '30,', '40'])).toEqual(['--box=10,20,30,40']);
  });

  it('parses page specs, coalesces ranges, and parses colors/directions/alignments', () => {
    expect(parsePageSpec('4, 1-3, 2')).toEqual([4, 1, 2, 3]);
    expect(coalesceRanges([1, 2, 3, 5, 7, 8])).toEqual([
      [1, 3],
      [5, 5],
      [7, 8],
    ]);
    expect(formatPageSpec([1, 2, 3, 5, 7, 8])).toBe('1-3,5,7-8');
    expect(formatPageSpec([])).toBe('');

    expect(() => parsePageSpec('')).toThrow(/Empty --pages/);
    expect(() => parsePageSpec('3-1')).toThrow(/exceeds end/);
    expect(() => parsePageSpec('0')).toThrow(/>= 1/);
    expect(() => parsePageSpec('1,,3')).toThrow(/empty page entry/);
    expect(() => parsePageSpec('1-26')).toThrow(/25/);

    expect(parseJoinDirection('v')).toBe('vertical');
    expect(parseJoinDirection('HORIZONTAL')).toBe('horizontal');
    expect(() => parseJoinDirection('diag')).toThrow(/Invalid --direction/);

    expect(parseJoinAlign('START')).toBe('start');
    expect(parseJoinAlign('center')).toBe('center');
    expect(parseJoinAlign('end')).toBe('end');
    expect(() => parseJoinAlign('middle')).toThrow(/Invalid --align/);

    expect(alignOffset(80, 40, 'start')).toBe(0);
    expect(alignOffset(80, 40, 'center')).toBe(20);
    expect(alignOffset(80, 40, 'end')).toBe(40);

    expect(parseRgbColor('#222222')).toEqual({ r: 34, g: 34, b: 34 });
    expect(parseRgbColor('#f0a')).toEqual({ r: 255, g: 0, b: 170 });
    expect(parseRgbColor('white')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseRgbColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 });
    expect(() => parseRgbColor('notacolor')).toThrow(/Invalid --divider-color/);

    expect(normalizePdfFormat('JPEG')).toBe('jpg');
    expect(normalizePdfFormat('png')).toBe('png');
    expect(() => normalizePdfFormat('tiff')).toThrow(/Invalid --format/);

    expect(safeStem('scan #1 (copy)')).toBe('scan_1_copy');
    expect(safeStem('___')).toBe('scan');
  });
});

describe('prep-scan native client', () => {
  it('runs grid and stitch on a synthetic image with divider, redaction, and output flag aliases', async () => {
    const tmp = await makeTempDir('kinloom-prep-grid-stitch-');
    const srcImg = path.join(tmp, 'synthetic-sheet.png');
    const gridOut = path.join(tmp, 'grid.jpg');
    const stitchOut = path.join(tmp, 'stitched.jpg');
    await createSyntheticSheetPng(srcImg);

    const gridRes = await invokePrepScan([
      'grid',
      srcImg,
      gridOut,
      '--step',
      '200',
      '--max-width',
      '1000',
      '--max-kb',
      '200',
    ]);
    expect(gridRes.exitCode, gridRes.stderr).toBe(0);
    const gridMeta = JSON.parse(gridRes.stdout) as {
      original_width: number;
      original_height: number;
      preview_width: number;
      preview_height: number;
      step: number;
      bytes: number;
      out: string;
    };
    expect(gridMeta.original_width).toBe(2000);
    expect(gridMeta.original_height).toBe(1200);
    expect(gridMeta.preview_width).toBeLessThanOrEqual(1000);
    expect(gridMeta.preview_height).toBeLessThanOrEqual(600);
    expect(gridMeta.step).toBe(200);
    expect(gridMeta.out).toBe(gridOut);
    expect(fs.statSync(gridOut).size).toBeLessThanOrEqual(200 * 1024);

    // Stitch header band (1800x160) + household band (1600x220) with redaction and 8px gap.
    const stitchRes = await invokePrepScan([
      'stitch',
      srcImg,
      stitchOut,
      '--box',
      '100,20,1900,180',
      '--box',
      '200,720,1800,940',
      '--redact',
      '250,750,600,830',
      '--gap',
      '8',
      '--divider-color',
      '#222222',
      '--quality',
      '90',
    ]);
    expect(stitchRes.exitCode, stitchRes.stderr).toBe(0);
    const stitchMeta = JSON.parse(stitchRes.stdout) as {
      width: number;
      height: number;
      bytes: number;
      bands: Array<{ box: number[]; width: number; height: number; y_offset: number }>;
      out: string;
    };
    expect(stitchMeta.width).toBe(1800);
    expect(stitchMeta.height).toBe(160 + 8 + 220);
    expect(stitchMeta.bytes).toBeGreaterThan(0);
    expect(stitchMeta.bands).toHaveLength(2);
    expect(stitchMeta.bands[0]).toMatchObject({ width: 1800, height: 160, y_offset: 0 });
    expect(stitchMeta.bands[1]).toMatchObject({ width: 1600, height: 220, y_offset: 168 });
    expect(stitchMeta.out).toBe(stitchOut);

    // Verify actual image dimensions, dark divider band at y=164, and redacted black region inside band #2.
    const stitchPixels = await readPixels(stitchOut, [
      [900, 164],
      [300, 230],
    ]);
    expect(stitchPixels.size).toEqual([1800, 388]);
    expect(Math.max(...stitchPixels.px[0]!)).toBeLessThan(55);
    expect(Math.max(...stitchPixels.px[1]!)).toBeLessThan(20);

    // Poka-yoke: --out/-o works the same as positional output, and comma-split boxes are rejoined.
    const gridAliasOut = path.join(tmp, 'grid-alias.jpg');
    const gridAliasRes = await invokePrepScan(['grid', srcImg, '--out', gridAliasOut, '--step', '400']);
    expect(gridAliasRes.exitCode, gridAliasRes.stderr).toBe(0);
    expect((JSON.parse(gridAliasRes.stdout) as { out: string }).out).toBe(gridAliasOut);
    expect(fs.existsSync(gridAliasOut)).toBe(true);

    const stitchAliasOut = path.join(tmp, 'stitch-alias.jpg');
    const stitchAliasRes = await invokePrepScan([
      'stitch',
      srcImg,
      '-o',
      stitchAliasOut,
      '--box',
      '100,',
      '20,',
      '1900,',
      '180',
      '--box',
      '200 720 1800 940',
    ]);
    expect(stitchAliasRes.exitCode, stitchAliasRes.stderr).toBe(0);
    const stitchAlias = JSON.parse(stitchAliasRes.stdout) as { out: string; width: number };
    expect(stitchAlias.out).toBe(stitchAliasOut);
    expect(stitchAlias.width).toBe(1800);

    const cropAliasOut = path.join(tmp, 'crop-alias.jpg');
    const cropAliasRes = await invokePrepScan([
      'crop',
      srcImg,
      '--out',
      cropAliasOut,
      '--box',
      '0,0,1000,600',
      '--quality',
      '85',
      '--preview-out',
      path.join(tmp, 'crop-alias.preview.jpg'),
      '--json',
    ]);
    expect(cropAliasRes.exitCode, cropAliasRes.stderr).toBe(0);
    const cropAlias = JSON.parse(cropAliasRes.stdout) as {
      output: { path: string; width: number };
    };
    expect(cropAlias.output.path).toBe(cropAliasOut);
    expect(cropAlias.output.width).toBe(1000);

    const previewDir = path.join(tmp, 'previews-alias');
    const previewRes = await invokePrepScan(['preview', srcImg, '--out', previewDir, '--json']);
    expect(previewRes.exitCode, previewRes.stderr).toBe(0);
    expect(fs.readdirSync(previewDir)).toHaveLength(1);
  });

  it('crop blacks out --redact-orig in pre-crop pixels, allows missing --box, and names --redact-orig on out-of-bounds --redact', async () => {
    const cropHelp = await invokePrepScan(['crop', '--help']);
    expect(cropHelp.exitCode).toBe(0);
    expect(cropHelp.stdout).toContain('--redact-orig');
    expect(cropHelp.stdout).toContain('[--box BOX]');
    expect(cropHelp.stdout.replace(/\s+/g, ' ')).toContain('Omit --box to keep the full rotated frame.');

    const tmp = await makeTempDir('kinloom-prep-crop-redact-');
    const srcImg = path.join(tmp, 'sheet.png');
    await createSolidPng(srcImg, 80, 60, [200, 180, 160]);

    const cream = [200, 180, 160];
    const black = [0, 0, 0];

    const origOut = path.join(tmp, 'orig.png');
    const origRes = await invokePrepScan([
      'crop',
      srcImg,
      origOut,
      '--box',
      '10,20,50,50',
      '--redact-orig',
      '8,',
      '22,',
      '18,',
      '28',
      '--redact',
      '20,10,24,14',
      '--json',
      '--preview-out',
      path.join(tmp, 'orig.preview.jpg'),
    ]);
    expect(origRes.exitCode, origRes.stderr).toBe(0);
    const origMeta = JSON.parse(origRes.stdout) as {
      box: number[];
      redactions: number[][];
      redactions_orig: number[][];
      output: { width: number; height: number };
    };
    expect(origMeta.box).toEqual([10, 20, 50, 50]);
    expect(origMeta.output).toMatchObject({ width: 40, height: 30 });
    expect(origMeta.redactions_orig).toEqual([[8, 22, 18, 28]]);
    expect(origMeta.redactions).toEqual([[20, 10, 24, 14]]);
    const origPx = await readPixels(origOut, [
      [0, 4],
      [9, 4],
      [0, 0],
      [20, 10],
      [24, 14],
      [25, 10],
    ]);
    expect(origPx.size).toEqual([40, 30]);
    expect(origPx.px).toEqual([black, cream, cream, black, black, cream]);

    const legacyOut = path.join(tmp, 'legacy.png');
    const legacyRes = await invokePrepScan([
      'crop',
      srcImg,
      legacyOut,
      '--box',
      '10,20,50,50',
      '--redact',
      '5,5,12,12',
      '--json',
      '--preview-out',
      path.join(tmp, 'legacy.preview.jpg'),
    ]);
    expect(legacyRes.exitCode, legacyRes.stderr).toBe(0);
    const legacyMeta = JSON.parse(legacyRes.stdout) as {
      redactions: number[][];
      redactions_orig: number[][];
    };
    expect(legacyMeta.redactions).toEqual([[5, 5, 12, 12]]);
    expect(legacyMeta.redactions_orig).toEqual([]);
    const legacyPx = await readPixels(legacyOut, [
      [5, 5],
      [12, 12],
      [13, 5],
      [4, 5],
    ]);
    expect(legacyPx.px).toEqual([black, black, cream, cream]);

    const turned = path.join(tmp, 'turned.png');
    await createSolidPng(turned, 40, 20, [200, 180, 160]);
    const rotOut = path.join(tmp, 'rotated.png');
    const rotRes = await invokePrepScan([
      'crop',
      turned,
      rotOut,
      '--rotate',
      '90',
      '--redact-orig',
      '2,4,6,8',
      '--json',
      '--preview-out',
      path.join(tmp, 'rotated.preview.jpg'),
    ]);
    expect(rotRes.exitCode, rotRes.stderr).toBe(0);
    const rotMeta = JSON.parse(rotRes.stdout) as {
      box: number[];
      rotate: number;
      redactions: number[][];
      redactions_orig: number[][];
    };
    expect(rotMeta.rotate).toBe(90);
    expect(rotMeta.box).toEqual([0, 0, 20, 40]);
    expect(rotMeta.redactions).toEqual([]);
    expect(rotMeta.redactions_orig).toEqual([[2, 4, 6, 8]]);
    const rotPx = await readPixels(rotOut, [
      [2, 4],
      [6, 8],
      [1, 4],
      [7, 4],
      [2, 3],
      [2, 9],
    ]);
    expect(rotPx.size).toEqual([20, 40]);
    expect(rotPx.px).toEqual([black, black, cream, cream, cream, cream]);

    const redactOnly = path.join(tmp, 'redact-only.png');
    const redactOnlyRes = await invokePrepScan([
      'crop',
      turned,
      redactOnly,
      '--rotate',
      '90',
      '--redact',
      '2 4 6 8',
      '--json',
      '--preview-out',
      path.join(tmp, 'redact-only.preview.jpg'),
    ]);
    expect(redactOnlyRes.exitCode, redactOnlyRes.stderr).toBe(0);
    const redactOnlyMeta = JSON.parse(redactOnlyRes.stdout) as {
      box: number[];
      redactions: number[][];
      redactions_orig: number[][];
    };
    expect(redactOnlyMeta.box).toEqual([0, 0, 20, 40]);
    expect(redactOnlyMeta.redactions).toEqual([[2, 4, 6, 8]]);
    expect(redactOnlyMeta.redactions_orig).toEqual([]);
    const redactOnlyPx = await readPixels(redactOnly, [
      [2, 4],
      [6, 8],
      [1, 4],
    ]);
    expect(redactOnlyPx.px).toEqual([black, black, cream]);

    const oobOut = path.join(tmp, 'oob.png');
    const oob = await invokePrepScan([
      'crop',
      srcImg,
      oobOut,
      '--box',
      '0,0,30,40',
      '--redact',
      '40,5,50,15',
      '--preview-out',
      path.join(tmp, 'oob.preview.jpg'),
    ]);
    expect(oob.exitCode).toBe(2);
    expect(oob.stderr).toContain('--redact #1 (40,5,50,15) starts outside 30x40 image.');
    expect(oob.stderr).toContain('--redact-orig');
    expect(oob.stderr).toContain('prep-scan grid');
    expect(fs.existsSync(oobOut)).toBe(false);
  });

  it('runs info and join on synthetic images including EXIF orientation and pixel checks', async () => {
    const infoHelp = await invokePrepScan(['info', '--help']);
    expect(infoHelp.exitCode).toBe(0);
    expect(infoHelp.stdout).toContain('--json');

    const joinHelp = await invokePrepScan(['join', '--help']);
    expect(joinHelp.exitCode).toBe(0);
    expect(joinHelp.stdout).toContain('--direction');
    expect(joinHelp.stdout).toContain('--align');
    expect(joinHelp.stdout).toContain('--preview-out');

    const tmp = await makeTempDir('kinloom-prep-info-join-');
    const red = path.join(tmp, 'red.png');
    const blue = path.join(tmp, 'blue.png');
    const turned = path.join(tmp, 'turned.jpg');
    const note = path.join(tmp, 'note.txt');
    await writeFile(note, 'not an image');
    await createSolidPng(red, 80, 30, [255, 0, 0]);
    await createSolidPng(blue, 40, 20, [0, 0, 255]);

    const turnedBuf = await sharp({
      create: {
        width: 20,
        height: 40,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
      limitInputPixels: false,
    })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 90 })
      .toBuffer();
    await writeFile(turned, turnedBuf);

    const infoText = await invokePrepScan(['info', red, blue]);
    expect(infoText.exitCode, infoText.stderr).toBe(0);
    expect(infoText.stdout).toBe(
      `${red}: 80x30 PNG (${(fs.statSync(red).size / 1024).toFixed(1)} KB)\n` +
        `${blue}: 40x20 PNG (${(fs.statSync(blue).size / 1024).toFixed(1)} KB)`
    );

    const infoJsonRes = await invokePrepScan(['info', red, turned, '--json']);
    expect(infoJsonRes.exitCode, infoJsonRes.stderr).toBe(0);
    const infoJson = JSON.parse(infoJsonRes.stdout) as {
      count: number;
      files: Array<{
        path: string;
        width: number;
        height: number;
        format: string;
        mode: string;
        bytes: number;
        kb: number;
      }>;
    };
    expect(infoJson.count).toBe(2);
    expect(infoJson.files[0]).toEqual({
      path: red,
      width: 80,
      height: 30,
      format: 'PNG',
      mode: 'RGB',
      bytes: fs.statSync(red).size,
      kb: Number((fs.statSync(red).size / 1024).toFixed(1)),
    });
    expect(infoJson.files[1]).toMatchObject({
      path: turned,
      width: 40,
      height: 20,
      format: 'JPEG',
      mode: 'RGB',
      bytes: fs.statSync(turned).size,
    });

    const missing = await invokePrepScan(['info', path.join(tmp, 'missing.png')]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('input file not found');
    expect(missing.stdout).toBe('');

    const notImage = await invokePrepScan(['info', note]);
    expect(notImage.exitCode).toBe(1);
    expect(notImage.stderr).toContain('cannot read image');
    expect(notImage.stderr).toContain(note);
    expect(notImage.stdout).toBe('');

    const verticalOut = path.join(tmp, 'vertical.png');
    const previewOut = path.join(tmp, 'vertical.preview.jpg');
    const verticalRes = await invokePrepScan([
      'join',
      red,
      blue,
      '--out',
      verticalOut,
      '--direction',
      'v',
      '--gap',
      '8',
      '--align',
      'center',
      '--divider-color',
      '#222222',
      '--quality',
      '92',
      '--preview-out',
      previewOut,
      '--json',
    ]);
    expect(verticalRes.exitCode, verticalRes.stderr).toBe(0);
    expect(JSON.parse(verticalRes.stdout)).toEqual({
      width: 80,
      height: 58,
      bytes: fs.statSync(verticalOut).size,
      count: 2,
      direction: 'vertical',
      out: verticalOut,
      preview_out: previewOut,
    });

    const horizontalOut = path.join(tmp, 'horizontal.png');
    const horizontalRes = await invokePrepScan([
      'join',
      red,
      blue,
      '-o',
      horizontalOut,
      '--direction',
      'horizontal',
      '--gap',
      '8',
      '--align',
      'end',
    ]);
    expect(horizontalRes.exitCode, horizontalRes.stderr).toBe(0);
    expect(JSON.parse(horizontalRes.stdout)).toMatchObject({
      width: 128,
      height: 30,
      count: 2,
      direction: 'horizontal',
      out: horizontalOut,
    });

    const startOut = path.join(tmp, 'start.png');
    const startRes = await invokePrepScan([
      'join',
      red,
      blue,
      '--output',
      startOut,
      '--direction',
      'h',
      '--gap',
      '8',
      '--align',
      'start',
    ]);
    expect(startRes.exitCode, startRes.stderr).toBe(0);

    const vPx = await readPixels(verticalOut, [
      [0, 0],
      [0, 33],
      [0, 38],
      [20, 38],
      [59, 57],
      [60, 38],
    ]);
    expect(vPx.size).toEqual([80, 58]);
    expect(vPx.px).toEqual([
      [255, 0, 0],
      [34, 34, 34],
      [34, 34, 34],
      [0, 0, 255],
      [0, 0, 255],
      [34, 34, 34],
    ]);

    const hPx = await readPixels(horizontalOut, [
      [84, 0],
      [88, 0],
      [88, 10],
      [127, 29],
    ]);
    expect(hPx.size).toEqual([128, 30]);
    expect(hPx.px).toEqual([
      [34, 34, 34],
      [34, 34, 34],
      [0, 0, 255],
      [0, 0, 255],
    ]);

    const sPx = await readPixels(startOut, [
      [88, 0],
      [88, 20],
    ]);
    expect(sPx.px).toEqual([
      [0, 0, 255],
      [34, 34, 34],
    ]);

    const previewMeta = await sharp(previewOut).metadata();
    expect([previewMeta.width, previewMeta.height]).toEqual([80, 58]);
    expect(previewMeta.format).toBe('jpeg');

    const tooFew = await invokePrepScan(['join', red, '--out', path.join(tmp, 'one.jpg')]);
    expect(tooFew.exitCode).toBe(2);
    expect(tooFew.stderr).toContain('at least 2');
    expect(fs.existsSync(path.join(tmp, 'one.jpg'))).toBe(false);

    const noOut = await invokePrepScan(['join', red, blue]);
    expect(noOut.exitCode).toBe(2);
    expect(noOut.stderr.toLowerCase()).toContain('out');
  });

  it('pdf-grep reports exact 1-based page numbers, caches text, supports --refresh, and handles errors', async () => {
    const tmp = await makeTempDir('kinloom-pdf-grep-');
    const pdfPath = path.join(tmp, 'synthetic.pdf');
    const cacheRoot = path.join(tmp, 'ocr-cache');
    const pageTexts = [
      'Abraham Lincoln born 1809 Hardin County',
      'Nothing relevant on this page',
      'Jansen family moved to Lincoln County',
      'Index of names',
      'LINCOLN, A. page 1',
    ];
    const pdfBytes = buildTextPdf(pageTexts);
    await writeFile(pdfPath, pdfBytes);
    const digest = crypto.createHash('sha256').update(pdfBytes).digest('hex');
    const cacheFile = path.join(cacheRoot, 'pdf-text', `${digest}.json`);

    let pdftotextCalls = 0;
    const mockExec: ExecFileFn = async (file, args) => {
      if (file === 'pdftotext') {
        pdftotextCalls += 1;
        const target = args[2];
        if (target?.endsWith('not-a.pdf')) {
          const err = new Error('Syntax Error: not a PDF') as Error & {
            code: number;
            stderr: Buffer;
          };
          err.code = 1;
          err.stderr = Buffer.from('Syntax Error: May not be a PDF file\n');
          throw err;
        }
        return {
          stdout: Buffer.from(`${pageTexts.join('\f')}\f`, 'utf8'),
          stderr: Buffer.alloc(0),
        };
      }
      throw new Error(`Unexpected binary ${file}`);
    };

    const env = { KINLOOM_OCR_CACHE_DIR: cacheRoot };
    const run = (args: readonly string[]) => invokePrepScan(args, { env, execFileImpl: mockExec });

    // 1. Cold case-insensitive search
    const hit = await run(['pdf-grep', pdfPath, '--pattern', 'lincoln', '-i', '--context', '10', '--json']);
    expect(hit.exitCode, hit.stderr).toBe(0);
    expect(hit.cacheHit).toBe(false);
    const parsed = JSON.parse(hit.stdout) as {
      page_count: number;
      pages: number[];
      pages_arg: string;
      match_count: number;
      cache_hit: boolean;
      matches: Array<{ page: number; line: number; match: string }>;
    };
    expect(parsed.page_count).toBe(5);
    expect(parsed.pages).toEqual([1, 3, 5]);
    expect(parsed.pages_arg).toBe('1,3,5');
    expect(parsed.match_count).toBe(3);
    expect(parsed.cache_hit).toBe(false);
    expect(parsed.matches[0]).toMatchObject({ page: 1, line: 1, match: 'Lincoln' });
    expect(pdftotextCalls).toBe(1);
    const initialCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { pages: string[] };
    expect(initialCache.pages).toHaveLength(5);

    // 2. Warm cached search skips pdftotext
    const caseSensitive = await run(['pdf-grep', pdfPath, '--pattern', 'Lincoln', '--limit', '1']);
    expect(caseSensitive.exitCode, caseSensitive.stderr).toBe(0);
    expect(caseSensitive.cacheHit).toBe(true);
    expect(caseSensitive.stdout).toContain('p.1 L1:');
    expect(caseSensitive.stdout).toContain('2 match(es) on 2 of 5 page(s)');
    expect(caseSensitive.stdout).toContain('--pages 1,3');
    expect(pdftotextCalls).toBe(1);

    // 3. --refresh re-invokes pdftotext
    const refreshed = await run(['pdf-grep', pdfPath, '--pattern', 'Hardin', '--refresh', '--json']);
    expect(refreshed.exitCode).toBe(0);
    expect((JSON.parse(refreshed.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(pdftotextCalls).toBe(2);

    // 4. Corrupt cache file is treated as a miss and repaired
    await writeFile(cacheFile, '{\n');
    const repaired = await run(['pdf-grep', pdfPath, '--pattern', 'Hardin', '--json']);
    expect(repaired.exitCode).toBe(0);
    expect((JSON.parse(repaired.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(pdftotextCalls).toBe(3);
    const repairedCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { pages: string[] };
    expect(repairedCache.pages).toHaveLength(5);

    // 5. Zero matches exits 1
    const miss = await run(['pdf-grep', pdfPath, '--pattern', 'Washington']);
    expect(miss.exitCode).toBe(1);
    expect(miss.stdout).toContain('0 match(es)');

    // 6. Invalid regex exits 2
    const badRegex = await run(['pdf-grep', pdfPath, '--pattern', '(']);
    expect(badRegex.exitCode).toBe(2);
    expect(badRegex.stderr).toContain('Invalid --pattern');

    // 7. Failed extraction exits 1 and writes no cache file
    const badPath = path.join(tmp, 'not-a.pdf');
    const badBytes = Buffer.from('this is not a pdf');
    await writeFile(badPath, badBytes);
    const badDigest = crypto.createHash('sha256').update(badBytes).digest('hex');
    const bad = await run(['pdf-grep', badPath, '--pattern', 'pdf', '--json']);
    expect(bad.exitCode).toBe(1);
    expect(fs.existsSync(path.join(cacheRoot, 'pdf-text', `${badDigest}.json`))).toBe(false);
  });

  it('pdf-pages parses ranges in order, renders in parallel, caches per page, supports --strip, and rejects bad specs', async () => {
    const tmp = await makeTempDir('kinloom-pdf-pages-cache-');
    const pdfPath = path.join(tmp, 'synthetic-book.pdf');
    const cacheRoot = path.join(tmp, 'ocr-cache');
    const pdfBytes = buildTextPdf([
      'Page one: Oakridge Township 1850',
      'Page two: Maple Creek Survey',
      'Page three: Pine Hill Cemetery',
      'Page four: River Bend Ferry',
      'Page five: Index of Settlers',
    ]);
    await writeFile(pdfPath, pdfBytes);
    const pdfDigest = crypto.createHash('sha256').update(pdfBytes).digest('hex');

    const sampleJpg = await sharp({
      create: { width: 320, height: 420, channels: 3, background: { r: 245, g: 242, b: 235 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    const samplePng = await sharp({
      create: { width: 320, height: 420, channels: 3, background: { r: 245, g: 242, b: 235 } },
    })
      .png({ compressionLevel: 1 })
      .toBuffer();

    let pdftoppmCalls = 0;
    let activeRenders = 0;
    let maxConcurrency = 0;

    const mockExec: ExecFileFn = async (file, args) => {
      if (file === 'pdfinfo') {
        return { stdout: Buffer.from('Title: Synthetic\nPages: 5\n', 'utf8'), stderr: Buffer.alloc(0) };
      }
      if (file === 'pdftoppm') {
        pdftoppmCalls += 1;
        activeRenders += 1;
        maxConcurrency = Math.max(maxConcurrency, activeRenders);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const fmtFlag = args[0];
        const pageNum = args[4];
        const prefix = args[args.length - 1];
        const ext = fmtFlag === '-png' ? 'png' : 'jpg';
        fs.writeFileSync(`${prefix}-${pageNum}.${ext}`, ext === 'png' ? samplePng : sampleJpg);
        activeRenders -= 1;
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      throw new Error(`Unexpected binary ${file}`);
    };

    const env = { KINLOOM_OCR_CACHE_DIR: cacheRoot };
    const run = (args: readonly string[]) => invokePrepScan(args, { env, execFileImpl: mockExec });

    // 1. Cold parallel multi-page render with range + dedup in requested order (4, 1-3, 2 -> [4, 1, 2, 3])
    const outDir1 = path.join(tmp, 'out1');
    const stripOut = path.join(tmp, 'strip.jpg');
    const first = await run([
      'pdf-pages',
      pdfPath,
      '--pages',
      '4, 1-3, 2',
      '--dpi',
      '72',
      '--out-dir',
      outDir1,
      '--strip',
      stripOut,
      '--json',
    ]);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.cacheHit).toBe(false);
    const body1 = JSON.parse(first.stdout) as {
      dpi: number;
      format: string;
      requested_pages: number[];
      cache_hit: boolean;
      strip?: { path: string; width: number; height: number };
      pages: Array<{
        page: number;
        path: string;
        width: number;
        height: number;
        bytes: number;
        cache_hit: boolean;
      }>;
    };
    expect(body1.dpi).toBe(72);
    expect(body1.format).toBe('jpg');
    expect(body1.requested_pages).toEqual([4, 1, 2, 3]);
    expect(body1.cache_hit).toBe(false);
    expect(body1.pages.map((p) => [p.page, p.cache_hit])).toEqual([
      [4, false],
      [1, false],
      [2, false],
      [3, false],
    ]);
    expect(body1.strip?.path).toBe(stripOut);
    expect(fs.existsSync(stripOut)).toBe(true);
    for (const page of body1.pages) {
      expect(page.width).toBe(320);
      expect(page.height).toBe(420);
      expect(page.bytes).toBe(fs.statSync(page.path).size);
    }
    expect(pdftoppmCalls).toBe(4);
    expect(maxConcurrency).toBeGreaterThanOrEqual(2);
    expect(maxConcurrency).toBeLessThanOrEqual(4);
    expect(fs.existsSync(path.join(cacheRoot, 'pdf-pages', `${pdfDigest}_p1_dpi72.jpg`))).toBe(true);

    // 2. Warm cache hit into brand-new output directory invokes pdftoppm 0 times
    const outDir2 = path.join(tmp, 'out2');
    const second = await run([
      'pdf-pages',
      pdfPath,
      '--pages',
      '1,2-3',
      '--dpi',
      '72',
      '--out-dir',
      outDir2,
      '--json',
    ]);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.cacheHit).toBe(true);
    const body2 = JSON.parse(second.stdout) as {
      requested_pages: number[];
      cache_hit: boolean;
      pages: Array<{ page: number; cache_hit: boolean }>;
    };
    expect(body2.requested_pages).toEqual([1, 2, 3]);
    expect(body2.cache_hit).toBe(true);
    expect(body2.pages.map((p) => [p.page, p.cache_hit])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
    expect(pdftoppmCalls).toBe(4);
    expect(fs.existsSync(path.join(outDir2, 'page-001.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(outDir2, 'page-003.jpg'))).toBe(true);

    // 3. Partial overlap (page 1 cached, page 5 uncached)
    const outDir3 = path.join(tmp, 'out3');
    const partial = await run([
      'pdf-pages',
      pdfPath,
      '--pages',
      '1,5',
      '--dpi',
      '72',
      '--out-dir',
      outDir3,
      '--json',
    ]);
    expect(partial.exitCode, partial.stderr).toBe(0);
    expect(partial.cacheHit).toBe(false);
    const body3 = JSON.parse(partial.stdout) as {
      cache_hit: boolean;
      pages: Array<{ page: number; cache_hit: boolean }>;
    };
    expect(body3.cache_hit).toBe(false);
    expect(body3.pages.map((p) => [p.page, p.cache_hit])).toEqual([
      [1, true],
      [5, false],
    ]);
    expect(pdftoppmCalls).toBe(5);

    // 4. --refresh bypasses disk cache
    const refreshed = await run([
      'pdf-pages',
      pdfPath,
      '--page',
      '1',
      '--dpi',
      '72',
      '--out-dir',
      outDir3,
      '--refresh',
      '--json',
    ]);
    expect(refreshed.exitCode).toBe(0);
    expect((JSON.parse(refreshed.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(pdftoppmCalls).toBe(6);

    // 5. PNG format caches separately
    const outDirPng = path.join(tmp, 'out-png');
    const pngRun = await run([
      'pdf-pages',
      pdfPath,
      '--pages',
      '1',
      '--dpi',
      '72',
      '--format',
      'png',
      '--out-dir',
      outDirPng,
      '--json',
    ]);
    expect(pngRun.exitCode).toBe(0);
    const pngBody = JSON.parse(pngRun.stdout) as {
      format: string;
      cache_hit: boolean;
      pages: Array<{ path: string }>;
    };
    expect(pngBody.format).toBe('png');
    expect(pngBody.cache_hit).toBe(false);
    expect(pngBody.pages[0]!.path.endsWith('page-001.png')).toBe(true);
    expect(pdftoppmCalls).toBe(7);

    // 6. Text mode works on cache hit
    const textRun = await run(['pdf-pages', pdfPath, '-p', '1', '--dpi', '72', '--out-dir', outDir2]);
    expect(textRun.exitCode).toBe(0);
    expect(textRun.cacheHit).toBe(true);
    expect(textRun.stdout).toContain('p.001');
    expect(textRun.stdout).toContain('preview:');
    expect(pdftoppmCalls).toBe(7);

    // 7. Invalid, reversed, non-positive, >25-page, and out-of-bounds specs exit 2 with 0 new calls
    const badSpecs = [
      { pages: '3-1', expectText: 'exceeds end' },
      { pages: '0', expectText: '>= 1' },
      { pages: '1,,3', expectText: 'empty page entry' },
      { pages: '1-26', expectText: '25' },
      { pages: '99', expectText: 'out of range' },
    ];
    for (const spec of badSpecs) {
      const badRun = await run(['pdf-pages', pdfPath, '--pages', spec.pages, '--out-dir', outDir2]);
      expect(badRun.exitCode, `spec=${spec.pages} stderr=${badRun.stderr}`).toBe(2);
      expect(badRun.stderr).toContain(spec.expectText);
    }
    expect(pdftoppmCalls).toBe(7);
  });

  it('rejects missing or doubled output path with actionable exit-2 message and renders help', async () => {
    const missing = await invokePrepScan(['grid', 'scan.jpg']);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('missing output path');
    expect(missing.stderr).toContain('--out');

    const doubled = await invokePrepScan([
      'stitch',
      'scan.jpg',
      'a.jpg',
      '--out',
      'b.jpg',
      '--box',
      '0,0,10,10',
      '--box',
      '0,10,10,20',
    ]);
    expect(doubled.exitCode).toBe(2);
    expect(doubled.stderr).toContain('output given twice');

    const gridHelp = await invokePrepScan(['grid', '--help']);
    expect(gridHelp.exitCode).toBe(0);
    expect(gridHelp.stdout).toContain('--out');

    const previewHelp = await invokePrepScan(['preview', '--help']);
    expect(previewHelp.exitCode).toBe(0);
    expect(previewHelp.stdout).toContain('--out-dir');

    const rootHelp = await invokePrepScan(['--help']);
    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout).toContain('preview');
    expect(rootHelp.stdout).toContain('pdf-pages');
    expect(rootHelp.stdout).toContain('rotate');

    const unknown = await invokePrepScan(['nonexistent']);
    expect(unknown.exitCode).toBe(2);
  });

  it('preview handles duplicate stems, resizing, rotation, deskew, and missing files', async () => {
    const tmp = await makeTempDir('kinloom-prep-preview-');
    const dirA = path.join(tmp, 'a');
    const dirB = path.join(tmp, 'b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const imgA = path.join(dirA, 'page.png');
    const imgB = path.join(dirB, 'page.png');
    await createSolidPng(imgA, 1200, 600, [240, 235, 220]);
    await createSolidPng(imgB, 800, 400, [220, 235, 240]);

    const outDir = path.join(tmp, 'out');
    const res = await invokePrepScan([
      'preview',
      imgA,
      imgB,
      '--output-dir',
      outDir,
      '--max-width',
      '400',
      '--max-kb',
      '100',
      '--rotate',
      '90',
      '--deskew',
      '--json',
    ]);
    expect(res.exitCode, res.stderr).toBe(0);
    const items = JSON.parse(res.stdout) as Array<{
      source: string;
      source_size: [number, number];
      path: string;
      width: number;
      height: number;
      bytes: number;
    }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.source_size).toEqual([1200, 600]);
    expect(items[0]!.width).toBeLessThanOrEqual(400);
    // Rotated 90 deg: 600x1200 scaled to width 400 -> height 800
    expect(items[0]!.height).toBeGreaterThan(items[0]!.width);
    expect(items[0]!.path).not.toBe(items[1]!.path);
    expect(fs.existsSync(items[0]!.path)).toBe(true);
    expect(fs.existsSync(items[1]!.path)).toBe(true);

    const missing = await invokePrepScan(['preview', path.join(tmp, 'nope.png'), '--out-dir', outDir]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('input file not found');
  });

  it('sheet-strip fetches URLs and local files concurrently, slices bands, and handles partial/full failures', async () => {
    const tmp = await makeTempDir('kinloom-prep-sheet-strip-');
    const localImg = path.join(tmp, 'local.png');
    await createSolidPng(localImg, 400, 300, [210, 225, 240]);
    const remotePng = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 230, g: 240, b: 215 } },
    })
      .png({ compressionLevel: 1 })
      .toBuffer();

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('good.png')) {
        return new Response(new Uint8Array(remotePng), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };

    const outTop = path.join(tmp, 'strip-top.jpg');
    const resTop = await invokePrepScan(
      [
        'sheet-strip',
        localImg,
        'https://archives.example.org/scans/good.png',
        'https://archives.example.org/scans/missing.png',
        '--out',
        outTop,
        '--band',
        'top',
        '--band-pct',
        '20',
        '--width',
        '600',
        '--max-kb',
        '150',
        '--json',
      ],
      { fetchImpl }
    );
    expect(resTop.exitCode, resTop.stderr).toBe(0);
    const metaTop = JSON.parse(resTop.stdout) as {
      band: string;
      count: number;
      ok: number;
      errors: Array<{ source: string; error: string }>;
      width: number;
      height: number;
      path: string;
    };
    expect(metaTop.band).toBe('top');
    expect(metaTop.count).toBe(3);
    expect(metaTop.ok).toBe(2);
    expect(metaTop.errors).toHaveLength(1);
    expect(metaTop.width).toBeLessThanOrEqual(600);
    expect(fs.existsSync(outTop)).toBe(true);

    // Left band with 90 deg rotation vs --no-rotate-left
    const outLeft = path.join(tmp, 'strip-left.jpg');
    const resLeft = await invokePrepScan([
      'sheet-strip',
      localImg,
      '--out',
      outLeft,
      '--band',
      'left',
      '--band-pct',
      '25',
      '--width',
      '300',
      '--json',
    ]);
    expect(resLeft.exitCode, resLeft.stderr).toBe(0);
    const metaLeft = JSON.parse(resLeft.stdout) as { width: number; height: number };
    expect(metaLeft.width).toBe(300);

    // All sources failing returns exit 1
    const allBad = await invokePrepScan(
      ['sheet-strip', 'https://archives.example.org/scans/missing.png', '--out', path.join(tmp, 'fail.jpg')],
      { fetchImpl }
    );
    expect(allBad.exitCode).toBe(1);
    expect(allBad.stderr).toContain('HTTP 404');
  });

  it('stitch supports horizontal direction, labels, header-height, and compact max-kb mode', async () => {
    const tmp = await makeTempDir('kinloom-prep-stitch-labeled-');
    const srcImg = path.join(tmp, 'sheet.png');
    await createSyntheticSheetPng(srcImg);

    const outHoriz = path.join(tmp, 'labeled-h.jpg');
    const res = await invokePrepScan([
      'stitch',
      srcImg,
      '--out',
      outHoriz,
      '--box',
      '0,0,400,200',
      '--box',
      '0,700,300,900',
      '--direction',
      'h',
      '--gap',
      '10',
      '--labels',
      'Header,Household',
      '--header-height',
      '30',
      '--max-width',
      '710',
      '--max-kb',
      '120',
    ]);
    expect(res.exitCode, res.stderr).toBe(0);
    const meta = JSON.parse(res.stdout) as {
      width: number;
      height: number;
      bands: Array<{ label?: string; x_offset: number; y_offset: number }>;
    };
    expect(meta.width).toBe(710);
    expect(meta.height).toBe(230);
    expect(meta.bands[0]).toMatchObject({ label: 'Header', x_offset: 0, y_offset: 30 });
    expect(meta.bands[1]).toMatchObject({ label: 'Household', x_offset: 410, y_offset: 30 });

    const tooFew = await invokePrepScan([
      'stitch',
      srcImg,
      path.join(tmp, 'bad.jpg'),
      '--box',
      '0,0,100,100',
    ]);
    expect(tooFew.exitCode).toBe(2);
    expect(tooFew.stderr).toContain('at least 2');
  });

  it('rotate subcommand rotates by 90 and arbitrary angles with optional preview', async () => {
    const tmp = await makeTempDir('kinloom-prep-rotate-');
    const srcImg = path.join(tmp, 'rect.png');
    await createSolidPng(srcImg, 120, 60, [210, 220, 230]);

    const rot90Out = path.join(tmp, 'rot90.png');
    const rot90Preview = path.join(tmp, 'rot90.preview.jpg');
    const res90 = await invokePrepScan([
      'rotate',
      srcImg,
      rot90Out,
      '--angle',
      '90',
      '--preview-out',
      rot90Preview,
      '--json',
    ]);
    expect(res90.exitCode, res90.stderr).toBe(0);
    const meta90 = JSON.parse(res90.stdout) as {
      angle: number;
      width: number;
      height: number;
      out: string;
      preview?: { path: string };
    };
    expect(meta90.angle).toBe(90);
    expect(meta90.width).toBe(60);
    expect(meta90.height).toBe(120);
    expect(meta90.out).toBe(rot90Out);
    expect(meta90.preview?.path).toBe(rot90Preview);
    expect(fs.existsSync(rot90Preview)).toBe(true);

    const rot45Out = path.join(tmp, 'rot45.jpg');
    const res45 = await invokePrepScan(['rotate', srcImg, '--out', rot45Out, '--angle', '45']);
    expect(res45.exitCode, res45.stderr).toBe(0);
    expect(res45.stdout).toContain('rotated 45 deg');
    const meta45 = await sharp(rot45Out).metadata();
    expect(meta45.width ?? 0).toBeGreaterThan(100);
    expect(meta45.height ?? 0).toBeGreaterThan(100);
  });
});
