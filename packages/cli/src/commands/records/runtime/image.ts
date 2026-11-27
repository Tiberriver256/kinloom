import fs from 'node:fs';
import sharp, { type Metadata, type OverlayOptions } from 'sharp';
import { atomicWriteFileSync } from './cache.js';

export interface ImageBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface ImageInfo {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly mode: string;
  readonly bytes: number;
  readonly kb: number;
}

export interface SavedImageInfo {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly kb: number;
}

export const DEFAULT_COMPACT_SCALES: readonly number[] = [1.0, 0.88, 0.76, 0.64, 0.52, 0.42, 0.34, 0.25];
export const DEFAULT_COMPACT_QUALITIES: readonly number[] = [84, 76, 68, 60, 52, 44, 36];

function mapChannelsToMode(channels: number | undefined, space: string | undefined): string {
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

export function orientedDimensions(meta: Metadata): { width: number; height: number } {
  const rawW = meta.width ?? 0;
  const rawH = meta.height ?? 0;
  const orient = meta.orientation ?? 1;
  if (orient >= 5 && orient <= 8) {
    return { width: rawH, height: rawW };
  }
  return { width: rawW, height: rawH };
}

export async function readImageInfo(filePath: string): Promise<ImageInfo> {
  const stat = fs.statSync(filePath);
  const meta = await sharp(filePath, { limitInputPixels: false }).metadata();
  const { width, height } = orientedDimensions(meta);
  const format = (meta.format ?? 'unknown').toUpperCase();
  const mode = mapChannelsToMode(meta.channels, meta.space);
  return {
    path: filePath,
    width,
    height,
    format,
    mode,
    bytes: stat.size,
    kb: Math.round((stat.size / 1024) * 10) / 10,
  };
}

export interface CompactJpegOptions {
  readonly maxWidth?: number;
  readonly maxKb?: number;
  readonly scales?: readonly number[];
  readonly qualities?: readonly number[];
}

export async function encodeCompactJpegBuffer(
  input: Buffer | string,
  options: CompactJpegOptions = {}
): Promise<{ readonly buffer: Buffer; readonly width: number; readonly height: number }> {
  const maxWidth = options.maxWidth ?? 1600;
  const maxKb = options.maxKb ?? 285;
  const targetBytes = Math.max(1024, Math.round(maxKb * 1024));
  const scales = options.scales ?? DEFAULT_COMPACT_SCALES;
  const qualities = options.qualities ?? DEFAULT_COMPACT_QUALITIES;

  const oriented = await sharp(input, { limitInputPixels: false })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toBuffer({ resolveWithObject: true });

  const baseW = oriented.info.width;
  const baseH = oriented.info.height;
  const initialW = maxWidth > 0 && baseW > maxWidth ? maxWidth : baseW;

  let bestBuf: Buffer | null = null;
  let bestW = initialW;
  let bestH = Math.max(1, Math.round((baseH * initialW) / Math.max(1, baseW)));

  for (const scale of scales) {
    const w = Math.max(1, Math.round(initialW * scale));
    const h = Math.max(1, Math.round((baseH * w) / Math.max(1, baseW)));
    const resizedBuf =
      w === baseW && h === baseH
        ? oriented.data
        : await sharp(oriented.data, { limitInputPixels: false })
            .resize({ width: w, height: h, kernel: sharp.kernel.lanczos3, fit: 'fill' })
            .toBuffer();

    for (const quality of qualities) {
      const encoded = await sharp(resizedBuf, { limitInputPixels: false })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (bestBuf === null || encoded.length < bestBuf.length) {
        bestBuf = encoded;
        bestW = w;
        bestH = h;
      }
      if (encoded.length <= targetBytes) {
        return { buffer: encoded, width: w, height: h };
      }
    }
  }

  return {
    buffer: bestBuf ?? oriented.data,
    width: bestW,
    height: bestH,
  };
}

export async function encodeCompactJpeg(
  input: Buffer | string,
  destPath: string,
  options: CompactJpegOptions = {}
): Promise<SavedImageInfo> {
  const { buffer, width, height } = await encodeCompactJpegBuffer(input, options);
  atomicWriteFileSync(destPath, buffer);
  return {
    path: destPath,
    width,
    height,
    bytes: buffer.length,
    kb: Math.round((buffer.length / 1024) * 10) / 10,
  };
}

export function escapeSvgText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildBlackBoxesSvg(width: number, height: number, boxes: readonly ImageBox[]): Buffer {
  const rects = boxes
    .map((b) => {
      const x = Math.max(0, Math.min(width, b.x0));
      const y = Math.max(0, Math.min(height, b.y0));
      const rw = Math.max(0, Math.min(width, b.x1) - x);
      const rh = Math.max(0, Math.min(height, b.y1) - y);
      return `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="#000000"/>`;
    })
    .join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`,
    'utf8'
  );
}

export async function applyBlackBoxes(
  input: Buffer,
  width: number,
  height: number,
  boxes: readonly ImageBox[]
): Promise<Buffer> {
  if (boxes.length === 0) {
    return input;
  }
  const overlays: OverlayOptions[] = [];
  for (const b of boxes) {
    const x = Math.max(0, Math.min(width, Math.round(b.x0)));
    const y = Math.max(0, Math.min(height, Math.round(b.y0)));
    const rw = Math.max(0, Math.min(width, Math.round(b.x1)) - x);
    const rh = Math.max(0, Math.min(height, Math.round(b.y1)) - y);
    if (rw <= 0 || rh <= 0) {
      continue;
    }
    overlays.push({
      input: {
        create: {
          width: rw,
          height: rh,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      },
      left: x,
      top: y,
    });
  }
  if (overlays.length === 0) {
    return input;
  }
  return sharp(input, { limitInputPixels: false }).composite(overlays).png().toBuffer();
}

export function chooseDefaultGridStep(origWidth: number, origHeight: number): number {
  const longest = Math.max(origWidth, origHeight);
  if (longest >= 3200) return 500;
  if (longest >= 1800) return 250;
  if (longest >= 900) return 200;
  return 100;
}

export async function renderGridOverlay(
  srcPath: string,
  destPath: string,
  options: { readonly step?: number; readonly maxWidth?: number; readonly maxKb?: number } = {}
): Promise<{
  readonly saved: SavedImageInfo;
  readonly origWidth: number;
  readonly origHeight: number;
  readonly step: number;
  readonly scale: number;
}> {
  const maxWidth = options.maxWidth ?? 1600;
  const maxKb = options.maxKb ?? 285;

  const oriented = await sharp(srcPath, { limitInputPixels: false })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toBuffer({ resolveWithObject: true });

  const origWidth = oriented.info.width;
  const origHeight = oriented.info.height;
  const step = options.step && options.step > 0 ? options.step : chooseDefaultGridStep(origWidth, origHeight);
  const scale = maxWidth > 0 && origWidth > maxWidth ? maxWidth / origWidth : 1;
  const dispW = Math.max(1, Math.round(origWidth * scale));
  const dispH = Math.max(1, Math.round(origHeight * scale));

  const resized =
    scale < 1
      ? await sharp(oriented.data, { limitInputPixels: false })
          .resize({ width: dispW, height: dispH, kernel: sharp.kernel.lanczos3, fit: 'fill' })
          .toBuffer()
      : oriented.data;

  const parts: string[] = [];
  const fontSize = Math.max(11, Math.min(16, Math.round(Math.min(dispW, dispH) / 55)));
  const pillH = fontSize + 6;

  for (let x = step; x < origWidth; x += step) {
    const dx = Math.round(x * scale);
    parts.push(
      `<line x1="${dx}" y1="0" x2="${dx}" y2="${dispH}" stroke="#cc2222" stroke-opacity="0.72" stroke-width="1"/>`
    );
    const label = String(x);
    const pillW = Math.max(24, label.length * Math.round(fontSize * 0.65) + 8);
    const px = Math.min(Math.max(2, dx - Math.floor(pillW / 2)), Math.max(2, dispW - pillW - 2));
    parts.push(
      `<rect x="${px}" y="3" width="${pillW}" height="${pillH}" rx="3" fill="#ffffff" fill-opacity="0.88" stroke="#cc2222" stroke-width="1"/>`,
      `<text x="${px + pillW / 2}" y="${3 + fontSize}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#aa1111">${label}</text>`
    );
  }

  for (let y = step; y < origHeight; y += step) {
    const dy = Math.round(y * scale);
    parts.push(
      `<line x1="0" y1="${dy}" x2="${dispW}" y2="${dy}" stroke="#1c5ec9" stroke-opacity="0.72" stroke-width="1"/>`
    );
    const label = String(y);
    const pillW = Math.max(24, label.length * Math.round(fontSize * 0.65) + 8);
    const py = Math.min(Math.max(2, dy - Math.floor(pillH / 2)), Math.max(2, dispH - pillH - 2));
    parts.push(
      `<rect x="3" y="${py}" width="${pillW}" height="${pillH}" rx="3" fill="#ffffff" fill-opacity="0.88" stroke="#1c5ec9" stroke-width="1"/>`,
      `<text x="${3 + pillW / 2}" y="${py + fontSize}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#134599">${label}</text>`
    );
  }

  const cornerLabel = `${origWidth}x${origHeight}`;
  const cornerW = cornerLabel.length * Math.round(fontSize * 0.65) + 12;
  parts.push(
    `<rect x="3" y="3" width="${cornerW}" height="${pillH}" rx="3" fill="#111111" fill-opacity="0.82"/>`,
    `<text x="${3 + cornerW / 2}" y="${3 + fontSize}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#ffffff">${escapeSvgText(cornerLabel)}</text>`
  );

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dispW}" height="${dispH}">${parts.join('')}</svg>`,
    'utf8'
  );
  const overlaid = await sharp(resized, { limitInputPixels: false })
    .composite([{ input: svg, top: 0, left: 0 }])
    .toBuffer();

  const saved = await encodeCompactJpeg(overlaid, destPath, { maxWidth: dispW, maxKb });
  return {
    saved,
    origWidth,
    origHeight,
    step,
    scale,
  };
}

export interface ContactStripPanel {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
  readonly label?: string;
}

export async function buildLabeledContactStrip(
  panels: readonly ContactStripPanel[],
  destPath: string,
  options: {
    readonly direction?: 'vertical' | 'horizontal';
    readonly gap?: number;
    readonly headerHeight?: number;
    readonly maxWidth?: number;
    readonly maxKb?: number;
  } = {}
): Promise<SavedImageInfo> {
  const direction = options.direction ?? 'vertical';
  const gap = Math.max(0, options.gap ?? 12);
  const hasLabels = panels.some((p) => Boolean(p.label && p.label.trim().length > 0));
  const headerH = hasLabels ? Math.max(24, options.headerHeight ?? 32) : 0;

  let canvasW = 0;
  let canvasH = 0;
  if (direction === 'vertical') {
    canvasW = Math.max(...panels.map((p) => p.width), 1);
    canvasH = panels.reduce((sum, p) => sum + p.height + headerH, 0) + Math.max(0, panels.length - 1) * gap;
  } else {
    canvasW = panels.reduce((sum, p) => sum + p.width, 0) + Math.max(0, panels.length - 1) * gap;
    canvasH = Math.max(...panels.map((p) => p.height + headerH), 1);
  }

  const composites: OverlayOptions[] = [];
  let offset = 0;

  for (const panel of panels) {
    const left = direction === 'vertical' ? 0 : offset;
    const top = direction === 'vertical' ? offset : 0;

    if (headerH > 0) {
      const label = escapeSvgText(panel.label ?? '');
      const barW = direction === 'vertical' ? canvasW : panel.width;
      const barSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${barW}" height="${headerH}">` +
          `<rect x="0" y="0" width="${barW}" height="${headerH}" fill="#222222"/>` +
          `<text x="10" y="${Math.round(headerH * 0.68)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.max(12, Math.round(headerH * 0.52))}" font-weight="bold" fill="#ffffff">${label}</text>` +
          `</svg>`,
        'utf8'
      );
      composites.push({ input: barSvg, top, left });
    }

    composites.push({ input: panel.buffer, top: top + headerH, left });
    offset += (direction === 'vertical' ? panel.height + headerH : panel.width) + gap;
  }

  const composed = await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 240, g: 240, b: 240 },
    },
    limitInputPixels: false,
  })
    .composite(composites)
    .png()
    .toBuffer();

  return encodeCompactJpeg(composed, destPath, {
    maxWidth: options.maxWidth ?? canvasW,
    maxKb: options.maxKb ?? 285,
  });
}

export async function convertTiffToJpeg(
  srcPathOrBytes: string | Buffer,
  destPath: string,
  quality = 88
): Promise<SavedImageInfo> {
  const { data, info } = await sharp(srcPathOrBytes, { limitInputPixels: false })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  atomicWriteFileSync(destPath, data);
  return {
    path: destPath,
    width: info.width,
    height: info.height,
    bytes: data.length,
    kb: Math.round((data.length / 1024) * 10) / 10,
  };
}

export async function downscaleForOcr(
  srcPath: string,
  maxDim: number
): Promise<{
  readonly buffer: Buffer;
  readonly origWidth: number;
  readonly origHeight: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly downscaled: boolean;
}> {
  const meta = await sharp(srcPath, { limitInputPixels: false }).metadata();
  const { width: origWidth, height: origHeight } = orientedDimensions(meta);
  const longest = Math.max(origWidth, origHeight);

  if (maxDim <= 0 || longest <= maxDim) {
    return {
      buffer: fs.readFileSync(srcPath),
      origWidth,
      origHeight,
      width: origWidth,
      height: origHeight,
      scale: 1,
      downscaled: false,
    };
  }

  const scale = maxDim / longest;
  const targetW = Math.max(1, Math.round(origWidth * scale));
  const targetH = Math.max(1, Math.round(origHeight * scale));
  const { data, info } = await sharp(srcPath, { limitInputPixels: false })
    .rotate()
    .resize({ width: targetW, height: targetH, kernel: sharp.kernel.lanczos3, fit: 'fill' })
    .png()
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    origWidth,
    origHeight,
    width: info.width,
    height: info.height,
    scale: info.width / Math.max(1, origWidth),
    downscaled: true,
  };
}

export async function downscaleForCursiveOcr(
  srcPath: string,
  options: {
    readonly triggerBytes?: number;
    readonly targetKb?: number;
    readonly maxWidth?: number;
  } = {}
): Promise<{
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly downscaled: boolean;
}> {
  const triggerBytes = options.triggerBytes ?? 350 * 1024;
  const targetKb = options.targetKb ?? 285;
  const maxWidth = options.maxWidth ?? 2400;
  const raw = fs.readFileSync(srcPath);
  const meta = await sharp(raw, { limitInputPixels: false }).metadata();
  const { width, height } = orientedDimensions(meta);

  if (raw.length <= triggerBytes && width <= maxWidth) {
    return {
      buffer: raw,
      width,
      height,
      bytes: raw.length,
      downscaled: false,
    };
  }

  const encoded = await encodeCompactJpegBuffer(raw, { maxWidth, maxKb: targetKb });
  return {
    buffer: encoded.buffer,
    width: encoded.width,
    height: encoded.height,
    bytes: encoded.buffer.length,
    downscaled: true,
  };
}

export async function createSyntheticPng(
  width: number,
  height: number,
  rgb: { readonly r: number; readonly g: number; readonly b: number } = { r: 245, g: 245, b: 245 }
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: rgb,
    },
    limitInputPixels: false,
  })
    .png()
    .toBuffer();
}
