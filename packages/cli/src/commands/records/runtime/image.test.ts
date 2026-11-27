import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyBlackBoxes,
  buildLabeledContactStrip,
  convertTiffToJpeg,
  createSyntheticPng,
  downscaleForOcr,
  encodeCompactJpeg,
  readImageInfo,
  renderGridOverlay,
} from './image.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-image-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('records runtime sharp image helpers', () => {
  it('reads image metadata, encodes compact JPEG within KB budget, and applies redaction boxes', async () => {
    const dir = makeTempDir();
    const srcPath = path.join(dir, 'sample.png');
    const png = await createSyntheticPng(800, 600, { r: 230, g: 220, b: 200 });
    fs.writeFileSync(srcPath, png);

    const info = await readImageInfo(srcPath);
    expect(info.width).toBe(800);
    expect(info.height).toBe(600);
    expect(info.format).toBe('PNG');
    expect(info.mode).toBe('RGB');

    const redacted = await applyBlackBoxes(png, 800, 600, [{ x0: 100, y0: 100, x1: 200, y1: 200 }]);
    const { data, info: rawInfo } = await sharp(redacted).raw().toBuffer({ resolveWithObject: true });
    // Center of redacted box (150, 150) should be pure black (0, 0, 0).
    const idx = (150 * 800 + 150) * rawInfo.channels;
    expect(data[idx]).toBe(0);
    expect(data[idx + 1]).toBe(0);
    expect(data[idx + 2]).toBe(0);
    // Pixel outside redacted box (10, 10) keeps original color.
    const outIdx = (10 * 800 + 10) * rawInfo.channels;
    expect(data[outIdx]).toBe(230);
    expect(data[outIdx + 1]).toBe(220);
    expect(data[outIdx + 2]).toBe(200);

    const jpgPath = path.join(dir, 'compact.jpg');
    const saved = await encodeCompactJpeg(redacted, jpgPath, { maxWidth: 400, maxKb: 40 });
    expect(saved.width).toBeLessThanOrEqual(400);
    expect(saved.bytes).toBeLessThanOrEqual(40 * 1024);
    expect(fs.existsSync(jpgPath)).toBe(true);
  });

  it('renders coordinate grid overlays, labeled contact strips, TIFF-to-JPEG, and OCR downscaling', async () => {
    const dir = makeTempDir();
    const widePath = path.join(dir, 'wide.png');
    const wideBuf = await createSyntheticPng(4000, 1000, { r: 240, g: 240, b: 240 });
    fs.writeFileSync(widePath, wideBuf);

    const gridOut = path.join(dir, 'grid.jpg');
    const grid = await renderGridOverlay(widePath, gridOut, { step: 500, maxWidth: 1000, maxKb: 150 });
    expect(grid.origWidth).toBe(4000);
    expect(grid.origHeight).toBe(1000);
    expect(grid.saved.width).toBeLessThanOrEqual(1000);
    expect(fs.existsSync(gridOut)).toBe(true);

    const down = await downscaleForOcr(widePath, 2000);
    expect(down.downscaled).toBe(true);
    expect(down.width).toBe(2000);
    expect(down.height).toBe(500);
    expect(down.scale).toBeCloseTo(0.5, 4);

    const panelA = await createSyntheticPng(200, 100, { r: 210, g: 220, b: 230 });
    const panelB = await createSyntheticPng(200, 100, { r: 230, g: 210, b: 220 });
    const stripOut = path.join(dir, 'strip.jpg');
    const strip = await buildLabeledContactStrip(
      [
        { buffer: panelA, width: 200, height: 100, label: 'Page 1' },
        { buffer: panelB, width: 200, height: 100, label: 'Page 2' },
      ],
      stripOut,
      { direction: 'vertical', gap: 10, headerHeight: 30 }
    );
    expect(strip.width).toBe(200);
    expect(strip.height).toBe(100 + 30 + 10 + 100 + 30);

    const tiffPath = path.join(dir, 'scan.tif');
    const tiffBuf = await sharp(panelA).tiff().toBuffer();
    fs.writeFileSync(tiffPath, tiffBuf);
    const jpegFromTiff = path.join(dir, 'scan.jpg');
    const converted = await convertTiffToJpeg(tiffPath, jpegFromTiff);
    expect(converted.width).toBe(200);
    expect(converted.height).toBe(100);
    expect(fs.readFileSync(jpegFromTiff).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});
