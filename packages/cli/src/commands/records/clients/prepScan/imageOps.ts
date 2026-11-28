import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { CliValidationError } from '../../../../errors.js';
import { atomicWriteFileSync, resolveCacheDir } from '../../runtime/cache.js';
import { encodeCompactJpeg, escapeSvgText, type SavedImageInfo } from '../../runtime/image.js';
import { resolveUserPathFromContext } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import { type Box, clampBox, isUrl, normalizeRotationAngle, roundKb, USER_AGENT } from './geometry.js';

export interface LoadedRgbImage {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
}

export function defaultCacheRoot(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_OCR_CACHE_DIR'],
    defaultSubdir: 'kinloom-ocr',
    useXdgCacheHome: true,
  });
}

export function resolveOutputAlias(
  subcmd: string,
  posOut: string | undefined,
  optOut: string | undefined,
  ctx: RecordCommandContext
): string {
  if (posOut && optOut) {
    const resolvedPos = resolveUserPathFromContext(posOut, ctx);
    const resolvedOpt = resolveUserPathFromContext(optOut, ctx);
    if (resolvedPos !== resolvedOpt) {
      throw new CliValidationError(
        `${subcmd}: output given twice ('${posOut}' and --out '${optOut}'); pass it once.`
      );
    }
  }
  const value = posOut ?? optOut;
  if (!value) {
    throw new CliValidationError(
      `${subcmd}: missing output path; pass it positionally ` +
        `(\`prep-scan ${subcmd} <in> <out.jpg>\`) or with --out <out.jpg>.`
    );
  }
  return resolveUserPathFromContext(value, ctx);
}

export async function loadRgbBuffer(input: string | Buffer): Promise<LoadedRgbImage> {
  const { data, info } = await sharp(input, { limitInputPixels: false })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export async function loadRgbFromFile(srcPath: string): Promise<LoadedRgbImage> {
  try {
    return await loadRgbBuffer(srcPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(
      `Cannot read image '${srcPath}': ${msg}. Use a JPEG, PNG, WEBP, or TIFF file.`
    );
  }
}

export async function loadImageFromSource(
  target: string,
  timeoutSec: number,
  ctx: RecordCommandContext
): Promise<LoadedRgbImage> {
  if (isUrl(target)) {
    const controller = new AbortController();
    const timeoutMs = Math.max(100, Math.round(timeoutSec * 1000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await ctx.fetchImpl(target, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${target}`);
      }
      const bytes = Buffer.from(await resp.arrayBuffer());
      return await loadRgbBuffer(bytes);
    } finally {
      clearTimeout(timer);
    }
  }
  const filePath = resolveUserPathFromContext(target, ctx);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`file not found: ${filePath}`);
  }
  return loadRgbFromFile(filePath);
}

export async function rotateImageClockwise(
  image: LoadedRgbImage,
  degrees: number | undefined
): Promise<LoadedRgbImage> {
  const angle = normalizeRotationAngle(degrees);
  if (angle === 0) {
    return image;
  }
  const { data, info } = await sharp(image.buffer, { limitInputPixels: false })
    .rotate(angle, { background: { r: 255, g: 255, b: 255 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/**
 * Estimate small skew angle (-5..+5 deg) using horizontal projection variance on a
 * downsampled grayscale copy and straighten the scan if skew exceeds 0.35 deg.
 */
export async function deskewImage(image: LoadedRgbImage): Promise<LoadedRgbImage> {
  const probeW = Math.min(400, image.width);
  const probeH = Math.max(1, Math.round((image.height * probeW) / Math.max(1, image.width)));
  const gray = await sharp(image.buffer, { limitInputPixels: false })
    .resize({ width: probeW, height: probeH, fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();

  const scoreAngle = (deg: number): number => {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = probeW / 2;
    const cy = probeH / 2;
    const rowSums = new Float64Array(probeH);
    for (let y = 0; y < probeH; y += 2) {
      for (let x = 0; x < probeW; x += 2) {
        const rx = Math.round((x - cx) * cos + (y - cy) * sin + cx);
        const ry = Math.round(-(x - cx) * sin + (y - cy) * cos + cy);
        if (rx >= 0 && rx < probeW && ry >= 0 && ry < probeH) {
          rowSums[y] = (rowSums[y] ?? 0) + (255 - (gray[ry * probeW + rx] ?? 0));
        }
      }
    }
    let mean = 0;
    let count = 0;
    for (let y = 0; y < probeH; y += 2) {
      mean += rowSums[y] ?? 0;
      count += 1;
    }
    mean /= Math.max(1, count);
    let variance = 0;
    for (let y = 0; y < probeH; y += 2) {
      const diff = (rowSums[y] ?? 0) - mean;
      variance += diff * diff;
    }
    return variance;
  };

  let bestAngle = 0;
  let bestScore = scoreAngle(0);
  for (let deg = -5; deg <= 5; deg += 0.5) {
    if (deg === 0) {
      continue;
    }
    const sc = scoreAngle(deg);
    if (sc > bestScore * 1.02) {
      bestScore = sc;
      bestAngle = deg;
    }
  }
  if (Math.abs(bestAngle) < 0.4) {
    return image;
  }
  return rotateImageClockwise(image, bestAngle);
}

/**
 * Paint black redaction rectangles with inclusive corner coordinates, matching
 * Pillow's ImageDraw.rectangle((x0, y0, x1, y1), fill=(0, 0, 0)).
 */
export async function paintBlackBoxesInclusive(
  image: LoadedRgbImage,
  boxes: readonly Box[],
  label: string,
  outsideHint = ''
): Promise<{ readonly image: LoadedRgbImage; readonly painted: number[][] }> {
  if (boxes.length === 0) {
    return { image, painted: [] };
  }
  const overlays: OverlayOptions[] = [];
  const painted: number[][] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    if (!box) continue;
    const clamped = clampBox(box, image.width, image.height, `${label} #${i + 1}`, outsideHint);
    const rw = Math.min(image.width, clamped.x1 + 1) - clamped.x0;
    const rh = Math.min(image.height, clamped.y1 + 1) - clamped.y0;
    overlays.push({
      input: {
        create: {
          width: rw,
          height: rh,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      },
      left: clamped.x0,
      top: clamped.y0,
    });
    painted.push([clamped.x0, clamped.y0, clamped.x1, clamped.y1]);
  }
  const { data, info } = await sharp(image.buffer, { limitInputPixels: false })
    .composite(overlays)
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    image: { buffer: data, width: info.width, height: info.height },
    painted,
  };
}

export async function cropRgbImage(image: LoadedRgbImage, box: Box): Promise<LoadedRgbImage> {
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  const { data, info } = await sharp(image.buffer, { limitInputPixels: false })
    .extract({ left: box.x0, top: box.y0, width, height })
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export async function extractBand(
  image: LoadedRgbImage,
  band: 'top' | 'left',
  bandPct: number,
  rotateLeft: boolean
): Promise<LoadedRgbImage> {
  const frac = Math.max(0.02, Math.min(1.0, bandPct / 100.0));
  if (band === 'top') {
    const cutH = Math.max(1, Math.round(image.height * frac));
    return cropRgbImage(image, { x0: 0, y0: 0, x1: image.width, y1: cutH });
  }
  const cutW = Math.max(1, Math.round(image.width * frac));
  const strip = await cropRgbImage(image, { x0: 0, y0: 0, x1: cutW, y1: image.height });
  if (rotateLeft) {
    return rotateImageClockwise(strip, 90);
  }
  return strip;
}

export async function resizeToWidth(image: LoadedRgbImage, targetWidth: number): Promise<LoadedRgbImage> {
  if (image.width === targetWidth) {
    return image;
  }
  const scaledH = Math.max(1, Math.round((image.height * targetWidth) / Math.max(1, image.width)));
  const { data, info } = await sharp(image.buffer, { limitInputPixels: false })
    .resize({ width: targetWidth, height: scaledH, kernel: sharp.kernel.lanczos3, fit: 'fill' })
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export async function saveArchivalImage(
  image: LoadedRgbImage,
  outPath: string,
  quality = 92
): Promise<SavedImageInfo> {
  const ext = path.extname(outPath).toLowerCase();
  const base = sharp(image.buffer, { limitInputPixels: false })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha();
  let encoded: Buffer;
  if (ext === '.png') {
    encoded = await base.png({ compressionLevel: 9 }).toBuffer();
  } else if (ext === '.webp') {
    encoded = await base.webp({ quality }).toBuffer();
  } else {
    encoded = await base.jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  atomicWriteFileSync(outPath, encoded);
  return {
    path: outPath,
    width: image.width,
    height: image.height,
    bytes: encoded.length,
    kb: roundKb(encoded.length),
  };
}

export function mapChannelsToMode(channels: number | undefined, space: string | undefined): string {
  if (space === 'b-w' || channels === 1) {
    return 'L';
  }
  if (channels === 2) {
    return 'LA';
  }
  if (channels === 4) {
    return space === 'cmyk' ? 'CMYK' : 'RGBA';
  }
  return 'RGB';
}

export function buildHeaderSvg(
  width: number,
  height: number,
  text: string,
  bgHex = '#141c26',
  textHex = '#ffffff'
): Buffer {
  const fontSize = Math.max(11, Math.min(14, Math.round(height * 0.52)));
  const baseline = Math.round((height + fontSize) / 2) - 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x="0" y="0" width="${width}" height="${height}" fill="${bgHex}"/>` +
      `<text x="8" y="${baseline}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" fill="${textHex}">${escapeSvgText(text.slice(0, 180))}</text>` +
      `</svg>`,
    'utf8'
  );
}

export function buildGridSvg(
  baseW: number,
  baseH: number,
  origW: number,
  origH: number,
  step: number
): Buffer {
  const scaleX = baseW / Math.max(1, origW);
  const scaleY = baseH / Math.max(1, origH);
  const majorStep = step * 5;
  const fontSize = 13;
  const padX = 4;
  const padY = 2;
  const pillH = fontSize + padY * 2 + 2;

  const elements: string[] = [];

  const pushPill = (xPos: number, yPos: number, label: string, accent: string): void => {
    const tw = Math.max(16, Math.round(label.length * fontSize * 0.62));
    const pillW = tw + padX * 2;
    const left = Math.max(0, Math.min(baseW - pillW, xPos));
    const top = Math.max(0, Math.min(baseH - pillH, yPos));
    elements.push(
      `<rect x="${left}" y="${top}" width="${pillW}" height="${pillH}" fill="rgb(15,18,24)" fill-opacity="0.76" stroke="${accent}" stroke-width="1"/>`,
      `<text x="${left + padX}" y="${top + fontSize}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" fill="#ffffff">${escapeSvgText(label)}</text>`
    );
  };

  let lastXLabel = -1000;
  for (let origX = 0; origX < origW; origX += step) {
    const px = Math.min(baseW - 1, Math.round(origX * scaleX));
    const isMajor = origX % majorStep === 0;
    const opacity = isMajor ? '0.69' : '0.43';
    const strokeWidth = isMajor ? 2 : 1;
    elements.push(
      `<line x1="${px}" y1="0" x2="${px}" y2="${baseH - 1}" stroke="rgb(220,38,38)" stroke-opacity="${opacity}" stroke-width="${strokeWidth}"/>`
    );
    if (origX === 0 || px - lastXLabel >= 48) {
      pushPill(px + 2, 2, String(origX), 'rgb(220,38,38)');
      lastXLabel = px;
    }
  }

  let lastYLabel = -1000;
  for (let origY = 0; origY < origH; origY += step) {
    const py = Math.min(baseH - 1, Math.round(origY * scaleY));
    const isMajor = origY % majorStep === 0;
    const opacity = isMajor ? '0.69' : '0.43';
    const strokeWidth = isMajor ? 2 : 1;
    elements.push(
      `<line x1="0" y1="${py}" x2="${baseW - 1}" y2="${py}" stroke="rgb(37,99,235)" stroke-opacity="${opacity}" stroke-width="${strokeWidth}"/>`
    );
    if (origY > 0 && py - lastYLabel >= 24) {
      pushPill(2, py + 2, String(origY), 'rgb(37,99,235)');
      lastYLabel = py;
    }
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${baseW}" height="${baseH}">${elements.join('')}</svg>`,
    'utf8'
  );
}

export async function buildContactStripFromItems(
  items: ReadonlyArray<{ readonly label: string; readonly image: LoadedRgbImage }>,
  outPath: string,
  targetWidth: number,
  maxKb: number
): Promise<SavedImageInfo> {
  const resized: Array<{ readonly label: string; readonly image: LoadedRgbImage }> = [];
  for (const item of items) {
    resized.push({ label: item.label, image: await resizeToWidth(item.image, targetWidth) });
  }
  const headerH = 26;
  const gapH = 6;
  const totalH = Math.max(
    1,
    resized.reduce((sum, item) => sum + headerH + item.image.height + gapH, 0)
  );
  const overlays: OverlayOptions[] = [];
  let y = 0;
  for (const item of resized) {
    overlays.push({ input: buildHeaderSvg(targetWidth, headerH, item.label), left: 0, top: y });
    y += headerH;
    overlays.push({ input: item.image.buffer, left: 0, top: y });
    y += item.image.height + gapH;
  }
  const canvas = await sharp({
    create: {
      width: targetWidth,
      height: totalH,
      channels: 3,
      background: { r: 24, g: 24, b: 24 },
    },
    limitInputPixels: false,
  })
    .composite(overlays)
    .removeAlpha()
    .png()
    .toBuffer();

  return encodeCompactJpeg(canvas, outPath, { maxWidth: targetWidth, maxKb });
}
