import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  defaultExecFile,
  emitJsonStdout,
  emitStdout,
  encodeCompactJpeg,
  escapeSvgText,
  expandHomePath,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  orientedDimensions,
  parseCommandArgs,
  RecordRuntimeError,
  resolveCacheDir,
  withAdvisoryLock,
  type CommandParseSpec,
  type OptionSpec,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  type SavedImageInfo,
} from '../runtime/index.js';

const DEFAULT_MAX_WORKERS = 8;
const DEFAULT_TIMEOUT_S = 12.0;
const DEFAULT_PDF_TIMEOUT_S = 60;
const PDF_PAGE_BATCH_LIMIT = 25;
const PDF_PAGE_MAX_WORKERS = 4;
const USER_AGENT = 'kinloom-prep-scan/1.0 (genealogy archival tooling)';
const PDF_PAGE_NUM_RE = /-(\d+)\.(?:jpe?g|png)$/i;
const PDFINFO_PAGES_RE = /^Pages:\s*(\d+)\s*$/m;
const BOX_FRAGMENT_RE = /^-?[\d.]+(?:-[\d.]+)?(?:\s*,\s*-?[\d.]+(?:-[\d.]+)?)*\s*,$/;
const FOUR_NUM_BOX_RE = /^\d+(?:\.\d+)?(?:[,\s]+\d+(?:\.\d+)?){3}$/;

export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type JoinDirection = 'vertical' | 'horizontal';
export type JoinAlign = 'start' | 'center' | 'end';
export type PdfImageFormat = 'jpg' | 'png';

const NAMED_RGB_COLORS: Readonly<Record<string, RgbColor>> = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  lime: { r: 0, g: 255, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  cyan: { r: 0, g: 255, b: 255 },
  aqua: { r: 0, g: 255, b: 255 },
  magenta: { r: 255, g: 0, b: 255 },
  fuchsia: { r: 255, g: 0, b: 255 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  darkgray: { r: 169, g: 169, b: 169 },
  darkgrey: { r: 169, g: 169, b: 169 },
  lightgray: { r: 211, g: 211, b: 211 },
  lightgrey: { r: 211, g: 211, b: 211 },
  silver: { r: 192, g: 192, b: 192 },
  maroon: { r: 128, g: 0, b: 0 },
  olive: { r: 128, g: 128, b: 0 },
  purple: { r: 128, g: 0, b: 128 },
  teal: { r: 0, g: 128, b: 128 },
  navy: { r: 0, g: 0, b: 128 },
  orange: { r: 255, g: 165, b: 0 },
  beige: { r: 245, g: 245, b: 220 },
  ivory: { r: 255, g: 255, b: 240 },
  cream: { r: 255, g: 253, b: 208 },
};

function roundKb(bytes: number): number {
  return Math.round((bytes / 1024) * 10) / 10;
}

export function safeStem(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'scan';
}

export function parseBox(raw: string): Box {
  const parts = raw
    .trim()
    .split(/[,\s]+/)
    .filter((p) => p.length > 0);
  if (parts.length !== 4) {
    throw new CliValidationError(`Invalid box '${raw}': expected x0,y0,x1,y1.`);
  }
  const nums: number[] = [];
  for (const part of parts) {
    const val = Number(part);
    if (!Number.isFinite(val)) {
      throw new CliValidationError(`Invalid integer coordinates in box '${raw}'.`);
    }
    nums.push(Math.round(val));
  }
  const [x0, y0, x1, y1] = nums;
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) {
    throw new CliValidationError(
      `Invalid box '${raw}': require 0 <= x0 < x1 and 0 <= y0 < y1.`
    );
  }
  return { x0, y0, x1, y1 };
}

export function parsePageSpec(raw: string, maxPages = PDF_PAGE_BATCH_LIMIT): number[] {
  const cleaned = raw.trim();
  if (!cleaned) {
    throw new CliValidationError(
      'Empty --pages spec. Pass 1-based page numbers or inclusive ranges like 1,3,10-12.'
    );
  }
  const seen = new Set<number>();
  const ordered: number[] = [];
  const parts = cleaned.split(',');
  for (const part of parts) {
    const token = part.trim();
    if (!token) {
      throw new CliValidationError(
        `Invalid --pages spec '${raw}': empty page entry. ` +
          'Use 1-based page numbers or inclusive ranges like 1,3,10-12.'
      );
    }
    if (token.includes('-')) {
      const bounds = token.split('-');
      if (bounds.length !== 2 || !bounds[0].trim() || !bounds[1].trim()) {
        throw new CliValidationError(
          `Invalid page range '${token}' in --pages '${raw}'. ` +
            'Use positive 1-based bounds like 10-12.'
        );
      }
      const startStr = bounds[0].trim();
      const endStr = bounds[1].trim();
      if (!/^[+-]?\d+$/.test(startStr) || !/^[+-]?\d+$/.test(endStr)) {
        throw new CliValidationError(
          `Invalid page range '${token}' in --pages '${raw}'. ` +
            'Use integer bounds like 10-12.'
        );
      }
      const start = Number.parseInt(startStr, 10);
      const end = Number.parseInt(endStr, 10);
      if (start < 1 || end < 1) {
        throw new CliValidationError(
          `Invalid page range '${token}' in --pages '${raw}': page numbers must be >= 1.`
        );
      }
      if (end < start) {
        throw new CliValidationError(
          `Invalid page range '${token}' in --pages '${raw}': start (${start}) exceeds end (${end}).`
        );
      }
      const span = end - start + 1;
      if (span > maxPages) {
        throw new CliValidationError(
          `Page range '${token}' requests ${span} pages, exceeding the ${maxPages}-page limit per call. ` +
            `Split into batches of ${maxPages} or fewer pages.`
        );
      }
      for (let num = start; num <= end; num += 1) {
        if (!seen.has(num)) {
          seen.add(num);
          ordered.push(num);
          if (ordered.length > maxPages) {
            throw new CliValidationError(
              `--pages '${raw}' requests more than ${maxPages} pages per call. ` +
                `Split into batches of ${maxPages} or fewer pages.`
            );
          }
        }
      }
    } else {
      if (!/^[+-]?\d+$/.test(token)) {
        throw new CliValidationError(
          `Invalid page number '${token}' in --pages '${raw}'. ` +
            'Use 1-based page numbers or ranges like 1,3,10-12.'
        );
      }
      const num = Number.parseInt(token, 10);
      if (num < 1) {
        throw new CliValidationError(
          `Page number must be >= 1, got ${num} in --pages '${raw}'.`
        );
      }
      if (!seen.has(num)) {
        seen.add(num);
        ordered.push(num);
        if (ordered.length > maxPages) {
          throw new CliValidationError(
            `--pages '${raw}' requests more than ${maxPages} pages per call. ` +
              `Split into batches of ${maxPages} or fewer pages.`
          );
        }
      }
    }
  }
  return ordered;
}

export function coalesceRanges(pages: readonly number[]): Array<readonly [number, number]> {
  if (pages.length === 0) {
    return [];
  }
  const ranges: Array<readonly [number, number]> = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i < pages.length; i += 1) {
    const p = pages[i];
    if (p === prev + 1) {
      prev = p;
    } else {
      ranges.push([start, prev]);
      start = p;
      prev = p;
    }
  }
  ranges.push([start, prev]);
  return ranges;
}

export function formatPageSpec(pages: readonly number[]): string {
  if (pages.length === 0) {
    return '';
  }
  return coalesceRanges(pages)
    .map(([a, b]) => (a === b ? String(a) : `${a}-${b}`))
    .join(',');
}

export function clampBox(
  box: Box,
  width: number,
  height: number,
  label: string,
  outsideHint = ''
): Box {
  if (box.x0 >= width || box.y0 >= height) {
    const extra = outsideHint ? ` ${outsideHint}` : '';
    throw new CliValidationError(
      `${label} (${box.x0},${box.y0},${box.x1},${box.y1}) starts outside ${width}x${height} image.${extra}`
    );
  }
  const x1 = Math.min(box.x1, width);
  const y1 = Math.min(box.y1, height);
  if (x1 <= box.x0 || y1 <= box.y0) {
    throw new CliValidationError(
      `${label} collapses to empty area inside ${width}x${height} image.`
    );
  }
  return { x0: box.x0, y0: box.y0, x1, y1 };
}

export function parseJoinDirection(raw: string): JoinDirection {
  const key = raw.trim().toLowerCase();
  if (key === 'v' || key === 'vertical') {
    return 'vertical';
  }
  if (key === 'h' || key === 'horizontal') {
    return 'horizontal';
  }
  throw new CliValidationError(
    `Invalid --direction '${raw}': expected vertical, horizontal, v, or h.`
  );
}

export function parseJoinAlign(raw: string): JoinAlign {
  const key = raw.trim().toLowerCase();
  if (key === 'start' || key === 'center' || key === 'end') {
    return key;
  }
  throw new CliValidationError(
    `Invalid --align '${raw}': expected start, center, or end.`
  );
}

export function alignOffset(outer: number, inner: number, align: JoinAlign): number {
  const slack = outer - inner;
  if (slack <= 0 || align === 'start') {
    return 0;
  }
  if (align === 'end') {
    return slack;
  }
  return Math.floor(slack / 2);
}

export function parseRgbColor(raw: string): RgbColor {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (/^[0-9a-f]{3}$/.test(hex)) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
      };
    }
    if (/^[0-9a-f]{6}$/.test(hex)) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }
    throw new CliValidationError(
      `Invalid --divider-color '${raw}': expected hex or named RGB color.`
    );
  }

  const rgbMatch = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(trimmed);
  if (rgbMatch) {
    const r = Number.parseInt(rgbMatch[1], 10);
    const g = Number.parseInt(rgbMatch[2], 10);
    const b = Number.parseInt(rgbMatch[3], 10);
    if (r <= 255 && g <= 255 && b <= 255) {
      return { r, g, b };
    }
    throw new CliValidationError(
      `Invalid --divider-color '${raw}': expected hex or named RGB color.`
    );
  }

  const named = NAMED_RGB_COLORS[trimmed];
  if (named) {
    return named;
  }
  throw new CliValidationError(
    `Invalid --divider-color '${raw}': expected hex or named RGB color.`
  );
}

export function normalizePdfFormat(raw: string): PdfImageFormat {
  const fmt = raw.trim().toLowerCase();
  if (fmt === 'jpg' || fmt === 'jpeg') {
    return 'jpg';
  }
  if (fmt === 'png') {
    return 'png';
  }
  throw new CliValidationError(`Invalid --format '${raw}': expected jpg or png.`);
}

export function normalizePrepScanArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of argv) {
    if (out.length > 0 && /^-?[\d.]/.test(token)) {
      const prev = out[out.length - 1];
      if (BOX_FRAGMENT_RE.test(prev)) {
        out[out.length - 1] = prev + token;
        continue;
      }
      if (prev.startsWith('--')) {
        const eqIdx = prev.indexOf('=');
        if (eqIdx !== -1 && BOX_FRAGMENT_RE.test(prev.slice(eqIdx + 1))) {
          out[out.length - 1] = prev + token;
          continue;
        }
      }
    }
    out.push(token);
  }
  return out;
}

function expandMultiBoxArgs(argv: readonly string[], multiFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (multiFlags.has(token) && i + 1 < argv.length) {
      out.push(token, argv[i + 1]);
      i += 2;
      while (i < argv.length && FOUR_NUM_BOX_RE.test(argv[i].trim())) {
        out.push(token, argv[i]);
        i += 1;
      }
      continue;
    }
    out.push(token);
    i += 1;
  }
  return out;
}

function resolveUserPath(rawPath: string, ctx: RecordCommandContext): string {
  const expanded = expandHomePath(rawPath, ctx.env);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(ctx.cwd, expanded);
}

function defaultCacheRoot(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_OCR_CACHE_DIR'],
    defaultSubdir: 'kinloom-ocr',
    useXdgCacheHome: true,
  });
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead <= 0) {
        break;
      }
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256String(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.host);
  } catch {
    return false;
  }
}

function shortLabel(target: string, index: number): string {
  const prefix = `[${String(index).padStart(2, '0')}]`;
  if (isUrl(target)) {
    const parsed = new URL(target);
    const tail = path.posix.basename(parsed.pathname) || parsed.host;
    return `${prefix} ${tail}`;
  }
  return `${prefix} ${path.basename(target)}`;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = Array.from({ length: items.length });
  const limit = Math.max(1, Math.min(maxConcurrency, items.length));
  let cursor = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) {
        return;
      }
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < limit; w += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
  return results;
}

interface LoadedRgbImage {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
}

async function loadRgbBuffer(input: string | Buffer): Promise<LoadedRgbImage> {
  const { data, info } = await sharp(input, { limitInputPixels: false })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

async function loadRgbFromFile(srcPath: string): Promise<LoadedRgbImage> {
  try {
    return await loadRgbBuffer(srcPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(
      `Cannot read image '${srcPath}': ${msg}. Use a JPEG, PNG, WEBP, or TIFF file.`
    );
  }
}

function normalizeRotationAngle(degrees: number | undefined): number {
  if (degrees === undefined) {
    return 0;
  }
  if (!Number.isFinite(degrees)) {
    throw new CliValidationError(`Unsupported rotation '${String(degrees)}': expected a finite angle.`);
  }
  const norm = ((degrees % 360) + 360) % 360;
  return norm === 360 ? 0 : norm;
}

async function rotateImageClockwise(
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
async function deskewImage(image: LoadedRgbImage): Promise<LoadedRgbImage> {
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
          rowSums[y] += 255 - gray[ry * probeW + rx];
        }
      }
    }
    let mean = 0;
    let count = 0;
    for (let y = 0; y < probeH; y += 2) {
      mean += rowSums[y];
      count += 1;
    }
    mean /= Math.max(1, count);
    let variance = 0;
    for (let y = 0; y < probeH; y += 2) {
      const diff = rowSums[y] - mean;
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
async function paintBlackBoxesInclusive(
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
    const clamped = clampBox(boxes[i], image.width, image.height, `${label} #${i + 1}`, outsideHint);
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

async function cropRgbImage(image: LoadedRgbImage, box: Box): Promise<LoadedRgbImage> {
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  const { data, info } = await sharp(image.buffer, { limitInputPixels: false })
    .extract({ left: box.x0, top: box.y0, width, height })
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

async function saveArchivalImage(
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

function resolveOutputAlias(
  subcmd: string,
  posOut: string | undefined,
  optOut: string | undefined,
  ctx: RecordCommandContext
): string {
  if (posOut && optOut) {
    const resolvedPos = resolveUserPath(posOut, ctx);
    const resolvedOpt = resolveUserPath(optOut, ctx);
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
  return resolveUserPath(value, ctx);
}

// ---------------------------------------------------------------------------
// Help text & option specifications
// ---------------------------------------------------------------------------

const PREVIEW_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outDir',
    kind: 'string',
    flags: ['--out-dir', '--out', '-o', '--output-dir', '--output'],
    required: true,
    metavar: 'DIR',
    help: 'Output directory for preview JPEGs (--out/-o/--output-dir are aliases).',
  },
  {
    key: 'maxWidth',
    kind: 'integer',
    flags: ['--max-width'],
    default: 1400,
    min: 1,
    metavar: 'PX',
    help: 'Maximum pixel width (default: 1400).',
  },
  {
    key: 'maxKb',
    kind: 'integer',
    flags: ['--max-kb'],
    default: 280,
    min: 1,
    metavar: 'KB',
    help: 'Maximum file size in KB (default: 280).',
  },
  {
    key: 'rotate',
    kind: 'number',
    flags: ['--rotate'],
    metavar: 'DEG',
    help: 'Optional clockwise rotation in degrees applied before previewing.',
  },
  {
    key: 'deskew',
    kind: 'boolean',
    flags: ['--deskew'],
    help: 'Attempt automatic small-angle deskewing before saving.',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output.',
  },
];

const PREVIEW_PARSE_SPEC: CommandParseSpec = {
  options: PREVIEW_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'image path',
};

const CROP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outOpt',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    metavar: 'PATH',
    help: 'Alias for the positional output path.',
  },
  {
    key: 'quality',
    kind: 'integer',
    flags: ['--quality'],
    default: 92,
    min: 1,
    max: 100,
    metavar: 'N',
    help: 'Archival output JPEG/WEBP quality 1..100 (default: 92).',
  },
  {
    key: 'box',
    kind: 'string',
    flags: ['--box'],
    metavar: 'BOX',
    help: 'Crop box x0,y0,x1,y1 on the rotated image. Omit --box to keep the full rotated frame.',
  },
  {
    key: 'rotate',
    kind: 'number',
    flags: ['--rotate'],
    metavar: 'DEG',
    help: 'Optional clockwise rotation applied before cropping (e.g. 90, 180, 270, or arbitrary degrees).',
  },
  {
    key: 'redact',
    kind: 'string',
    flags: ['--redact'],
    multiple: true,
    metavar: 'BOX',
    help: 'One or more x0,y0,x1,y1 black redaction boxes in cropped-image coordinates.',
  },
  {
    key: 'redactOrig',
    kind: 'string',
    flags: ['--redact-orig'],
    multiple: true,
    metavar: 'BOX',
    help: 'One or more x0,y0,x1,y1 black boxes in rotated-image coordinates (same coordinates as prep-scan grid). Drawn before the crop.',
  },
  {
    key: 'previewOut',
    kind: 'string',
    flags: ['--preview-out'],
    metavar: 'PATH',
    help: 'Optional explicit path for the < 280 KB verification preview (defaults to cache previews dir).',
  },
  {
    key: 'maxWidth',
    kind: 'integer',
    flags: ['--max-width'],
    default: 1400,
    min: 1,
    metavar: 'PX',
    help: 'Preview maximum pixel width (default: 1400).',
  },
  {
    key: 'maxKb',
    kind: 'integer',
    flags: ['--max-kb'],
    default: 280,
    min: 1,
    metavar: 'KB',
    help: 'Preview maximum size in KB (default: 280).',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output.',
  },
];

const CROP_PARSE_SPEC: CommandParseSpec = {
  options: CROP_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'input image',
};

const SHEET_STRIP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    required: true,
    metavar: 'PATH',
    help: 'Output JPEG path for the stitched contact sheet.',
  },
  {
    key: 'band',
    kind: 'string',
    flags: ['--band'],
    default: 'top',
    choices: ['top', 'left'],
    help: 'Band edge to slice (default: top).',
  },
  {
    key: 'bandPct',
    kind: 'number',
    flags: ['--band-pct'],
    default: 18.0,
    metavar: 'PCT',
    help: 'Percent of image height/width to slice (default: 18).',
  },
  {
    key: 'maxKb',
    kind: 'integer',
    flags: ['--max-kb'],
    default: 250,
    min: 1,
    metavar: 'KB',
    help: 'Maximum output file size in KB (default: 250).',
  },
  {
    key: 'width',
    kind: 'integer',
    flags: ['--width'],
    default: 1400,
    min: 1,
    metavar: 'PX',
    help: 'Normalized strip width in pixels (default: 1400).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_S,
    metavar: 'SEC',
    help: 'Per-URL HTTP timeout seconds (default: 12).',
  },
  {
    key: 'noRotateLeft',
    kind: 'boolean',
    flags: ['--no-rotate-left'],
    help: 'Keep --band left vertical instead of rotating 90 deg CW for horizontal reading.',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output.',
  },
];

const SHEET_STRIP_PARSE_SPEC: CommandParseSpec = {
  options: SHEET_STRIP_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'source URL or path',
};

const PDF_PAGES_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages', '--page', '-p'],
    required: true,
    metavar: 'SPEC',
    help: '1-based page numbers and inclusive ranges, e.g. 1,3,10-12 (max 25 per call).',
  },
  {
    key: 'outDir',
    kind: 'string',
    flags: ['--out-dir', '--out', '-o', '--output-dir', '--output'],
    required: true,
    metavar: 'DIR',
    help: 'Output directory for rendered pages and previews (--out/-o are aliases).',
  },
  {
    key: 'dpi',
    kind: 'integer',
    flags: ['--dpi'],
    default: 150,
    min: 1,
    metavar: 'DPI',
    help: 'Rendering DPI for pdftoppm (default: 150).',
  },
  {
    key: 'format',
    kind: 'string',
    flags: ['--format'],
    default: 'jpg',
    metavar: 'FMT',
    help: 'Rendered page image format: jpg or png (default: jpg).',
  },
  {
    key: 'maxWidth',
    kind: 'integer',
    flags: ['--max-width'],
    default: 1400,
    min: 1,
    metavar: 'PX',
    help: 'Preview maximum pixel width (default: 1400).',
  },
  {
    key: 'maxKb',
    kind: 'integer',
    flags: ['--max-kb'],
    default: 280,
    min: 1,
    metavar: 'KB',
    help: 'Maximum preview/strip size in KB (default: 280).',
  },
  {
    key: 'strip',
    kind: 'string',
    flags: ['--strip'],
    metavar: 'PATH',
    help: 'Optional output JPEG path for a labeled contact strip.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Ignore cached rendered pages and re-render via pdftoppm.',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output.',
  },
];

const PDF_PAGES_PARSE_SPEC: CommandParseSpec = {
  options: PDF_PAGES_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'PDF path',
};

const PDF_GREP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'pattern',
    kind: 'string',
    flags: ['--pattern', '-e'],
    required: true,
    metavar: 'REGEX',
    help: 'Regular expression, matched within each text line.',
  },
  {
    key: 'ignoreCase',
    kind: 'boolean',
    flags: ['-i', '--ignore-case'],
    help: 'Case-insensitive match.',
  },
  {
    key: 'context',
    kind: 'integer',
    flags: ['--context'],
    default: 200,
    min: 0,
    metavar: 'CHARS',
    help: 'Characters of page text to show on each side of a match (default: 200).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 25,
    min: 1,
    metavar: 'N',
    help: 'Maximum matches to print (default: 25); all matches still count.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Ignore cached page text and extract the PDF again.',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output.',
  },
];

const PDF_GREP_PARSE_SPEC: CommandParseSpec = {
  options: PDF_GREP_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'PDF path',
};

const GRID_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outOpt',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    metavar: 'PATH',
    help: 'Alias for the positional output path.',
  },
  {
    key: 'step',
    kind: 'integer',
    flags: ['--step'],
    default: 200,
    min: 1,
    metavar: 'PX',
    help: 'Grid line interval in original image pixels (default: 200).',
  },
  {
    key: 'maxWidth',
    kind: 'integer',
    flags: ['--max-width'],
    default: 1600,
    min: 1,
    metavar: 'PX',
    help: 'Maximum preview width in pixels (default: 1600).',
  },
  {
    key: 'maxKb',
    kind: 'integer',
    flags: ['--max-kb'],
    default: 280,
    min: 1,
    metavar: 'KB',
    help: 'Maximum preview file size in KB (default: 280).',
  },
  {
    key: 'rotate',
    kind: 'number',
    flags: ['--rotate'],
    metavar: 'DEG',
    help: 'Optional clockwise rotation applied before measuring coordinates.',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output (always enabled).',
  },
];

const GRID_PARSE_SPEC: CommandParseSpec = {
  options: GRID_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'input image',
};

const STITCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outOpt',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    metavar: 'PATH',
    help: 'Alias for the positional output path.',
  },
  {
    key: 'box',
    kind: 'string',
    flags: ['--box'],
    multiple: true,
    required: true,
    metavar: 'BOX',
    help: 'Crop box x0,y0,x1,y1 in original image coordinates (repeatable; at least 2 required).',
  },
  {
    key: 'redact',
    kind: 'string',
    flags: ['--redact'],
    multiple: true,
    metavar: 'BOX',
    help: 'Optional x0,y0,x1,y1 black redaction boxes in original image coordinates applied before cropping.',
  },
  {
    key: 'rotate',
    kind: 'number',
    flags: ['--rotate'],
    metavar: 'DEG',
    help: 'Optional clockwise rotation applied before redacting and cropping.',
  },
  {
    key: 'direction',
    kind: 'string',
    flags: ['--direction'],
    default: 'vertical',
    metavar: 'DIR',
    help: 'Stack direction: vertical or horizontal (aliases v, h). Default: vertical.',
  },
  {
    key: 'gap',
    kind: 'integer',
    flags: ['--gap'],
    default: 6,
    min: 0,
    metavar: 'PX',
    help: 'Divider gap in pixels between stacked bands (default: 6).',
  },
  {
    key: 'dividerColor',
    kind: 'string',
    flags: ['--divider-color'],
    default: '#222222',
    metavar: 'COLOR',
    help: 'Divider fill color as hex or RGB name (default: "#222222").',
  },
  {
    key: 'labels',
    kind: 'string',
    flags: ['--labels', '--label'],
    multiple: true,
    metavar: 'TEXT',
    help: 'Optional panel header labels (repeatable or comma-separated).',
  },
  {
    key: 'headerHeight',
    kind: 'integer',
    flags: ['--header-height'],
    min: 0,
    metavar: 'PX',
    help: 'Header bar height in pixels when --labels are provided (default: 26).',
  },
  {
    key: 'quality',
    kind: 'integer',
    flags: ['--quality'],
    default: 90,
    min: 1,
    max: 100,
    metavar: 'N',
    help: 'Output JPEG/WEBP quality 1..100 (default: 90).',
  },
  {
    key: 'maxWidth',
    kind: 'integer',
    flags: ['--max-width'],
    min: 1,
    metavar: 'PX',
    help: 'Optional maximum width for compact JPEG output.',
  },
  {
    key: 'maxKb',
    kind: 'integer',
    flags: ['--max-kb'],
    min: 1,
    metavar: 'KB',
    help: 'Optional maximum size in KB for compact JPEG output.',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output (always enabled).',
  },
];

const STITCH_PARSE_SPEC: CommandParseSpec = {
  options: STITCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'input image',
};

const INFO_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output.',
  },
];

const INFO_PARSE_SPEC: CommandParseSpec = {
  options: INFO_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'image path',
};

const JOIN_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    required: true,
    metavar: 'PATH',
    help: 'Archival JPEG or PNG output path.',
  },
  {
    key: 'direction',
    kind: 'string',
    flags: ['--direction'],
    default: 'vertical',
    metavar: 'DIR',
    help: 'Stack direction: vertical or horizontal (aliases v, h). Default: vertical.',
  },
  {
    key: 'gap',
    kind: 'integer',
    flags: ['--gap'],
    default: 8,
    min: 0,
    metavar: 'PX',
    help: 'Pixels of divider color between images (default: 8).',
  },
  {
    key: 'dividerColor',
    kind: 'string',
    flags: ['--divider-color'],
    default: '#222222',
    metavar: 'COLOR',
    help: 'Gap and margin fill color as hex or a named RGB color (default: "#222222").',
  },
  {
    key: 'align',
    kind: 'string',
    flags: ['--align'],
    default: 'center',
    metavar: 'ALIGN',
    help: 'Place a shorter image at start, center, or end of the cross axis (default: center).',
  },
  {
    key: 'quality',
    kind: 'integer',
    flags: ['--quality'],
    default: 92,
    min: 1,
    max: 100,
    metavar: 'N',
    help: 'Archival JPEG/WEBP quality 1..100 (default: 92). Ignored for PNG.',
  },
  {
    key: 'previewOut',
    kind: 'string',
    flags: ['--preview-out'],
    metavar: 'PATH',
    help: 'Optional compact JPEG preview path (max width 1400, max size 280 KB).',
  },
  {
    key: 'maxWidth',
    kind: 'integer',
    flags: ['--max-width'],
    default: 1400,
    min: 1,
    metavar: 'PX',
    help: 'Preview maximum pixel width when --preview-out is set (default: 1400).',
  },
  {
    key: 'maxKb',
    kind: 'integer',
    flags: ['--max-kb'],
    default: 280,
    min: 1,
    metavar: 'KB',
    help: 'Preview maximum size in KB when --preview-out is set (default: 280).',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output (always enabled).',
  },
];

const JOIN_PARSE_SPEC: CommandParseSpec = {
  options: JOIN_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'image paths',
};

const ROTATE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outOpt',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    metavar: 'PATH',
    help: 'Alias for the positional output path.',
  },
  {
    key: 'angle',
    kind: 'number',
    flags: ['--angle', '--rotate', '--degrees', '-a'],
    required: true,
    metavar: 'DEG',
    help: 'Clockwise rotation angle in degrees (e.g. 90, 180, 270, or arbitrary degrees).',
  },
  {
    key: 'quality',
    kind: 'integer',
    flags: ['--quality'],
    default: 92,
    min: 1,
    max: 100,
    metavar: 'N',
    help: 'Archival output JPEG/WEBP quality 1..100 (default: 92).',
  },
  {
    key: 'previewOut',
    kind: 'string',
    flags: ['--preview-out'],
    metavar: 'PATH',
    help: 'Optional compact JPEG preview path.',
  },
  {
    key: 'maxWidth',
    kind: 'integer',
    flags: ['--max-width'],
    default: 1400,
    min: 1,
    metavar: 'PX',
    help: 'Preview maximum pixel width (default: 1400).',
  },
  {
    key: 'maxKb',
    kind: 'integer',
    flags: ['--max-kb'],
    default: 280,
    min: 1,
    metavar: 'KB',
    help: 'Preview maximum size in KB (default: 280).',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON output.',
  },
];

const ROTATE_PARSE_SPEC: CommandParseSpec = {
  options: ROTATE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'input image',
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom prep-scan <subcommand> [options]',
    summary:
      'Report image dimensions, join separate page scans, generate compact inspection previews, ' +
      'redacted archival crops, census sheet-strip contact sheets, and selective PDF page renders.',
    subcommands: [
      { name: 'preview', summary: 'Generate compact JPEG inspection previews in parallel.' },
      { name: 'crop', summary: 'Rotate, optionally crop, draw black redaction boxes, and write a verification preview.' },
      { name: 'sheet-strip', summary: 'Download or read sheet bands in parallel and stitch one labeled contact sheet.' },
      { name: 'pdf-pages', summary: 'Render requested PDF pages in parallel via pdftoppm with disk caching.' },
      { name: 'pdf-grep', summary: 'Search PDF text page by page and report 1-based page numbers.' },
      { name: 'grid', summary: 'Draw an original-pixel coordinate grid overlay onto a compact JPEG preview.' },
      { name: 'stitch', summary: 'Crop 2+ boxes from one scan, apply optional redactions, and stack bands.' },
      { name: 'info', summary: 'Print pixel size, format, mode, and file size for one or more local images.' },
      { name: 'join', summary: 'Join 2 or more images into one archival JPEG or PNG, in input order.' },
      { name: 'rotate', summary: 'Rotate a scan clockwise by any angle and save an archival image.' },
    ],
  });
}

function renderCropHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom prep-scan crop <input> [<output> | --out <output>] [--box BOX] [options]',
    summary:
      'Rotate, optionally crop, draw black redaction boxes, and write a verification preview. ' +
      '--redact-orig uses rotated-image coordinates. --redact uses cropped-image coordinates.',
    options: CROP_OPTIONS,
  });
}

function renderSubcommandHelp(subcmd: string): string {
  switch (subcmd) {
    case 'preview':
      return formatCommandUsage({
        usage: 'kinloom prep-scan preview <images...> --out-dir <dir> [options]',
        summary: 'Generate compact JPEG inspection previews in parallel.',
        options: PREVIEW_OPTIONS,
      });
    case 'crop':
      return renderCropHelp();
    case 'sheet-strip':
      return formatCommandUsage({
        usage: 'kinloom prep-scan sheet-strip <sources...> --out <file> [options]',
        summary: 'Download or read census sheet header/street bands in parallel and stitch one labeled contact sheet.',
        options: SHEET_STRIP_OPTIONS,
      });
    case 'pdf-pages':
      return formatCommandUsage({
        usage: 'kinloom prep-scan pdf-pages <pdf_path> --pages <spec> --out-dir <dir> [options]',
        summary: 'Render requested PDF pages in parallel via pdftoppm with disk caching, compact previews, and optional contact strip.',
        options: PDF_PAGES_OPTIONS,
      });
    case 'pdf-grep':
      return formatCommandUsage({
        usage: 'kinloom prep-scan pdf-grep <pdf_path> --pattern <regex> [options]',
        summary: 'Search PDF text page by page (pdftotext) and print 1-based page numbers + snippets to feed `pdf-pages --pages`.',
        options: PDF_GREP_OPTIONS,
      });
    case 'grid':
      return formatCommandUsage({
        usage: 'kinloom prep-scan grid <image> [<out> | --out <out>] [options]',
        summary: 'Draw an original-pixel coordinate grid overlay onto a compact JPEG preview.',
        options: GRID_OPTIONS,
      });
    case 'stitch':
      return formatCommandUsage({
        usage: 'kinloom prep-scan stitch <image> [<out> | --out <out>] --box <x0,y0,x1,y1> --box <x0,y0,x1,y1> [options]',
        summary: 'Crop 2+ boxes from one scan, apply optional redactions, and stack bands.',
        options: STITCH_OPTIONS,
      });
    case 'info':
      return formatCommandUsage({
        usage: 'kinloom prep-scan info <images...> [--json]',
        summary: 'Print pixel size, format, mode, and file size for one or more local images.',
        options: INFO_OPTIONS,
      });
    case 'join':
      return formatCommandUsage({
        usage: 'kinloom prep-scan join <images...> --out <file> [options]',
        summary: 'Join 2 or more images into one archival JPEG or PNG, in input order.',
        options: JOIN_OPTIONS,
      });
    case 'rotate':
      return formatCommandUsage({
        usage: 'kinloom prep-scan rotate <input> [<output> | --out <output>] --angle <deg> [options]',
        summary: 'Rotate an image clockwise by an angle and save an archival output.',
        options: ROTATE_OPTIONS,
      });
    default:
      return renderRootHelp();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: preview
// ---------------------------------------------------------------------------

async function cmdPreview(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), PREVIEW_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('preview')) };
  }

  const outDir = resolveUserPath(getStringOption(parsed, 'outDir') ?? '', ctx);
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const rotateDeg = getNumberOption(parsed, 'rotate');
  const deskew = getBooleanOption(parsed, 'deskew');
  const asJson = getBooleanOption(parsed, 'json');

  const inputs = parsed.positionals.map((p) => resolveUserPath(p, ctx));
  const missing = inputs.filter((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
  if (missing.length > 0) {
    for (const m of missing) {
      ctx.io.stderr(`Error: input file not found: ${m}`);
    }
    return { exitCode: 1, bytesOut: 0 };
  }

  fs.mkdirSync(outDir, { recursive: true });

  const stemCounts = new Map<string, number>();
  for (const p of inputs) {
    const stem = safeStem(path.parse(p).name);
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }

  interface PreviewItem extends SavedImageInfo {
    readonly source: string;
    readonly source_size: readonly [number, number];
  }

  const results = await mapWithConcurrency(inputs, DEFAULT_MAX_WORKERS, async (src): Promise<PreviewItem> => {
    const stem = safeStem(path.parse(src).name);
    const outName =
      (stemCounts.get(stem) ?? 0) > 1
        ? `${stem}_${sha256String(src).slice(0, 8)}.preview.jpg`
        : `${stem}.preview.jpg`;
    const outPath = path.join(outDir, outName);

    let img = await loadRgbFromFile(src);
    const origW = img.width;
    const origH = img.height;
    if (rotateDeg !== undefined) {
      img = await rotateImageClockwise(img, rotateDeg);
    }
    if (deskew) {
      img = await deskewImage(img);
    }
    const saved = await encodeCompactJpeg(img.buffer, outPath, { maxWidth, maxKb });
    return {
      source: src,
      source_size: [origW, origH],
      ...saved,
    };
  });

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, results) };
  }
  const lines = results.map(
    (item) => `${item.path}  ${item.width}x${item.height}  ${item.kb.toFixed(1)} KB`
  );
  return { exitCode: 0, bytesOut: lines.length > 0 ? emitStdout(ctx.io, lines.join('\n')) : 0 };
}

// ---------------------------------------------------------------------------
// Subcommand: crop
// ---------------------------------------------------------------------------

async function cmdCrop(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const expanded = expandMultiBoxArgs(
    normalizePrepScanArgv(argv),
    new Set(['--redact', '--redact-orig'])
  );
  const parsed = parseCommandArgs(expanded, CROP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCropHelp()) };
  }

  const src = resolveUserPath(parsed.positionals[0], ctx);
  const outPath = resolveOutputAlias(
    'crop',
    parsed.positionals[1],
    getStringOption(parsed, 'outOpt'),
    ctx
  );
  const quality = getNumberOption(parsed, 'quality') ?? 92;
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const rotateDeg = getNumberOption(parsed, 'rotate');
  const boxRaw = getStringOption(parsed, 'box');
  const redactRaws = getStringListOption(parsed, 'redact');
  const redactOrigRaws = getStringListOption(parsed, 'redactOrig');
  const previewOutOpt = getStringOption(parsed, 'previewOut');
  const asJson = getBooleanOption(parsed, 'json');

  const requestedBox = boxRaw !== undefined ? parseBox(boxRaw) : undefined;
  const redactBoxes = redactRaws.map((raw) => parseBox(raw));
  const redactOrigBoxes = redactOrigRaws.map((raw) => parseBox(raw));
  const normalizedRotate = normalizeRotationAngle(rotateDeg);

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    ctx.io.stderr(`Error: input file not found: ${src}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  let img = await loadRgbFromFile(src);
  img = await rotateImageClockwise(img, normalizedRotate);

  const origRedacted = await paintBlackBoxesInclusive(img, redactOrigBoxes, '--redact-orig');
  img = origRedacted.image;

  const targetBox = requestedBox ?? { x0: 0, y0: 0, x1: img.width, y1: img.height };
  const cropBox = clampBox(targetBox, img.width, img.height, 'crop --box');
  let cropped = await cropRgbImage(img, cropBox);

  const postRedacted = await paintBlackBoxesInclusive(
    cropped,
    redactBoxes,
    '--redact',
    'If you read the box from prep-scan grid, pass the same numbers to --redact-orig. ' +
      '--redact uses coordinates on the cropped image.'
  );
  cropped = postRedacted.image;

  const saved = await saveArchivalImage(cropped, outPath, quality);

  let previewPath: string;
  if (previewOutOpt) {
    previewPath = resolveUserPath(previewOutOpt, ctx);
  } else {
    const digest = sha256String(outPath).slice(0, 8);
    previewPath = path.join(
      defaultCacheRoot(ctx),
      'previews',
      `${safeStem(path.parse(outPath).name)}_${digest}.preview.jpg`
    );
  }
  const preview = await encodeCompactJpeg(cropped.buffer, previewPath, { maxWidth, maxKb });

  const payload = {
    source: src,
    rotate: normalizedRotate,
    box: [cropBox.x0, cropBox.y0, cropBox.x1, cropBox.y1],
    redactions: postRedacted.painted,
    redactions_orig: origRedacted.painted,
    output: saved,
    preview,
  };

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const text =
    `output:  ${saved.path}  ${saved.width}x${saved.height}  ${(saved.bytes / 1024).toFixed(1)} KB\n` +
    `preview: ${preview.path}  ${preview.width}x${preview.height}  ${(preview.bytes / 1024).toFixed(1)} KB`;
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
}

// ---------------------------------------------------------------------------
// Subcommand: rotate (bonus clean support)
// ---------------------------------------------------------------------------

async function cmdRotate(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), ROTATE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('rotate')) };
  }

  const src = resolveUserPath(parsed.positionals[0], ctx);
  const outPath = resolveOutputAlias(
    'rotate',
    parsed.positionals[1],
    getStringOption(parsed, 'outOpt'),
    ctx
  );
  const angle = normalizeRotationAngle(getNumberOption(parsed, 'angle'));
  const quality = getNumberOption(parsed, 'quality') ?? 92;
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const previewOutOpt = getStringOption(parsed, 'previewOut');
  const asJson = getBooleanOption(parsed, 'json');

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    ctx.io.stderr(`Error: input file not found: ${src}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  const img = await loadRgbFromFile(src);
  const rotated = await rotateImageClockwise(img, angle);
  const saved = await saveArchivalImage(rotated, outPath, quality);

  let preview: SavedImageInfo | undefined;
  if (previewOutOpt) {
    preview = await encodeCompactJpeg(rotated.buffer, resolveUserPath(previewOutOpt, ctx), {
      maxWidth,
      maxKb,
    });
  }

  const payload = {
    source: src,
    angle,
    width: saved.width,
    height: saved.height,
    bytes: saved.bytes,
    kb: saved.kb,
    out: saved.path,
    ...(preview ? { preview } : {}),
  };

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const text = `${saved.path}  ${saved.width}x${saved.height}  ${saved.kb.toFixed(1)} KB (rotated ${angle} deg)`;
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
}

// ---------------------------------------------------------------------------
// Subcommand: sheet-strip + shared contact strip builder
// ---------------------------------------------------------------------------

async function loadImageFromSource(
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
  const filePath = resolveUserPath(target, ctx);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`file not found: ${filePath}`);
  }
  return loadRgbFromFile(filePath);
}

async function extractBand(
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

async function resizeToWidth(image: LoadedRgbImage, targetWidth: number): Promise<LoadedRgbImage> {
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

function buildHeaderSvg(
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

async function buildContactStripFromItems(
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

async function cmdSheetStrip(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), SHEET_STRIP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('sheet-strip')) };
  }

  const sources = parsed.positionals;
  const outPath = resolveUserPath(getStringOption(parsed, 'out') ?? '', ctx);
  const band = (getStringOption(parsed, 'band') ?? 'top') as 'top' | 'left';
  const bandPct = getNumberOption(parsed, 'bandPct') ?? 18.0;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 250;
  const targetWidth = getNumberOption(parsed, 'width') ?? 1400;
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_S;
  const noRotateLeft = getBooleanOption(parsed, 'noRotateLeft');
  const asJson = getBooleanOption(parsed, 'json');

  interface FetchedBand {
    readonly index: number;
    readonly source: string;
    readonly label: string;
    readonly image: LoadedRgbImage | null;
    readonly error: string | null;
  }

  const fetched = await mapWithConcurrency(
    sources,
    DEFAULT_MAX_WORKERS,
    async (src, idx): Promise<FetchedBand> => {
      const index = idx + 1;
      const label = shortLabel(src, index);
      try {
        const im = await loadImageFromSource(src, timeoutSec, ctx);
        const bandIm = await extractBand(im, band, bandPct, !noRotateLeft);
        const resized = await resizeToWidth(bandIm, targetWidth);
        return { index, source: src, label, image: resized, error: null };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { index, source: src, label, image: null, error: msg };
      }
    }
  );

  const okCount = fetched.filter((row) => row.image !== null).length;
  if (okCount === 0) {
    for (const row of fetched) {
      ctx.io.stderr(`Error ${row.label}: ${row.error ?? 'unknown error'}`);
    }
    return { exitCode: 1, bytesOut: 0 };
  }

  const headerH = 26;
  const errorH = 36;
  const gapH = 6;
  const totalH = Math.max(
    1,
    fetched.reduce(
      (sum, row) => sum + headerH + (row.image ? row.image.height : errorH) + gapH,
      0
    )
  );

  const overlays: OverlayOptions[] = [];
  let y = 0;
  for (const row of fetched) {
    const headerText = row.error ? `${row.label}  ERROR: ${row.error}` : row.label;
    overlays.push({ input: buildHeaderSvg(targetWidth, headerH, headerText), left: 0, top: y });
    y += headerH;
    if (row.image) {
      overlays.push({ input: row.image.buffer, left: 0, top: y });
      y += row.image.height + gapH;
    } else {
      overlays.push({
        input: buildHeaderSvg(targetWidth, errorH, row.error ?? 'Error', '#5a1414', '#ffdcdc'),
        left: 0,
        top: y,
      });
      y += errorH + gapH;
    }
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

  const saved = await encodeCompactJpeg(canvas, outPath, { maxWidth: targetWidth, maxKb });
  const errors = fetched
    .filter((r) => r.error !== null)
    .map((r) => ({ source: r.source, error: r.error }));

  const payload = {
    band,
    band_pct: bandPct,
    count: sources.length,
    ok: okCount,
    errors,
    ...saved,
  };

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const text =
    `${saved.path}  ${saved.width}x${saved.height}  ${(saved.bytes / 1024).toFixed(1)} KB  ` +
    `(${okCount}/${sources.length} bands)`;
  const bytesOut = emitStdout(ctx.io, text);
  for (const err of errors) {
    ctx.io.stderr(`warning: ${err.source}: ${err.error ?? ''}`);
  }
  return { exitCode: 0, bytesOut };
}

// ---------------------------------------------------------------------------
// Subcommand: pdf-pages
// ---------------------------------------------------------------------------

function extractExecErrorDetails(err: unknown): {
  readonly code: number | string | null | undefined;
  readonly killed: boolean;
  readonly detail: string;
} {
  if (typeof err === 'object' && err !== null) {
    const obj = err as {
      code?: number | string | null;
      killed?: boolean;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      message?: string;
    };
    const stderrStr = Buffer.isBuffer(obj.stderr)
      ? obj.stderr.toString('utf8')
      : typeof obj.stderr === 'string'
        ? obj.stderr
        : '';
    const stdoutStr = Buffer.isBuffer(obj.stdout)
      ? obj.stdout.toString('utf8')
      : typeof obj.stdout === 'string'
        ? obj.stdout
        : '';
    const detail = (stderrStr || stdoutStr || obj.message || String(err)).trim();
    return { code: obj.code, killed: Boolean(obj.killed), detail };
  }
  return { code: undefined, killed: false, detail: String(err) };
}

async function getPdfPageCount(pdfPath: string, ctx: RecordCommandContext): Promise<number | null> {
  const execFn = ctx.execFileImpl ?? defaultExecFile;
  try {
    const { stdout } = await execFn('pdfinfo', [pdfPath], { timeout: 15_000, env: ctx.env });
    const match = PDFINFO_PAGES_RE.exec(stdout.toString('utf8'));
    if (match) {
      const count = Number.parseInt(match[1], 10);
      if (count > 0) {
        return count;
      }
    }
  } catch {
    // pdfinfo unavailable or failed; fall back to pdftoppm validation.
  }
  return null;
}

function pdfPageCachePaths(
  pdfSha256: string,
  pageNum: number,
  dpi: number,
  fmt: PdfImageFormat,
  cacheRoot: string
): { readonly cachePath: string; readonly lockPath: string } {
  const dir = path.join(cacheRoot, 'pdf-pages');
  const filename = `${pdfSha256}_p${pageNum}_dpi${dpi}.${fmt}`;
  return {
    cachePath: path.join(dir, filename),
    lockPath: path.join(dir, `.${filename}.lock`),
  };
}

function readNonEmptyFile(filePath: string): Buffer | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0) {
      return fs.readFileSync(filePath);
    }
  } catch {
    // Cache miss.
  }
  return null;
}

async function renderOrLoadPdfPage(
  pdfPath: string,
  pdfSha256: string,
  pageNum: number,
  dpi: number,
  fmt: PdfImageFormat,
  cacheRoot: string,
  refresh: boolean,
  ctx: RecordCommandContext
): Promise<{ readonly data: Buffer; readonly cacheHit: boolean }> {
  const { cachePath, lockPath } = pdfPageCachePaths(pdfSha256, pageNum, dpi, fmt, cacheRoot);
  if (!refresh) {
    const cached = readNonEmptyFile(cachePath);
    if (cached !== null) {
      return { data: cached, cacheHit: true };
    }
  }

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!refresh) {
        const cached = readNonEmptyFile(cachePath);
        if (cached !== null) {
          return { data: cached, cacheHit: true };
        }
      }

      const execFn = ctx.execFileImpl ?? defaultExecFile;
      const cacheDir = path.dirname(cachePath);
      fs.mkdirSync(cacheDir, { recursive: true });
      const stageDir = path.join(
        cacheDir,
        `.stage_${process.pid}_${process.hrtime.bigint()}_${Math.random().toString(36).slice(2, 8)}`
      );
      fs.mkdirSync(stageDir, { recursive: true });
      try {
        const prefix = path.join(stageDir, `p${pageNum}`);
        const fmtFlag = fmt === 'png' ? '-png' : '-jpeg';
        try {
          await execFn(
            'pdftoppm',
            [
              fmtFlag,
              '-r',
              String(dpi),
              '-f',
              String(pageNum),
              '-l',
              String(pageNum),
              pdfPath,
              prefix,
            ],
            { timeout: DEFAULT_PDF_TIMEOUT_S * 1000, env: ctx.env }
          );
        } catch (err: unknown) {
          const info = extractExecErrorDetails(err);
          if (info.code === 'ENOENT') {
            throw new RecordRuntimeError(
              'pdftoppm executable not found on PATH. Install poppler-utils ' +
                '(for example `apt install poppler-utils` or `brew install poppler`).'
            );
          }
          if (info.killed) {
            throw new RecordRuntimeError(
              `pdftoppm timed out after ${DEFAULT_PDF_TIMEOUT_S}s on page ${pageNum}.`
            );
          }
          throw new RecordRuntimeError(
            `pdftoppm failed (exit ${String(info.code ?? 1)}) on page ${pageNum}: ${info.detail.slice(0, 300)}`
          );
        }

        const renderedFiles = fs
          .readdirSync(stageDir)
          .filter((name) => PDF_PAGE_NUM_RE.test(name))
          .toSorted()
          .map((name) => path.join(stageDir, name))
          .filter((full) => fs.statSync(full).isFile());

        if (renderedFiles.length === 0 || fs.statSync(renderedFiles[0]).size === 0) {
          throw new CliValidationError(
            `Page ${pageNum} is out of range or could not be rendered from ${path.basename(pdfPath)}.`
          );
        }
        fs.renameSync(renderedFiles[0], cachePath);
        return { data: fs.readFileSync(cachePath), cacheHit: false };
      } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

async function cmdPdfPages(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), PDF_PAGES_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('pdf-pages')) };
  }

  const dpi = getNumberOption(parsed, 'dpi') ?? 150;
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const fmt = normalizePdfFormat(getStringOption(parsed, 'format') ?? 'jpg');
  const requestedPages = parsePageSpec(getStringOption(parsed, 'pages') ?? '');
  const pdfPath = resolveUserPath(parsed.positionals[0], ctx);
  const outDir = resolveUserPath(getStringOption(parsed, 'outDir') ?? '', ctx);
  const stripOpt = getStringOption(parsed, 'strip');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'json');

  if (!fs.existsSync(pdfPath) || !fs.statSync(pdfPath).isFile()) {
    ctx.io.stderr(`Error: PDF file not found: ${pdfPath}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  const pageCount = await getPdfPageCount(pdfPath, ctx);
  if (pageCount !== null) {
    const outOfBounds = requestedPages.filter((p) => p > pageCount);
    if (outOfBounds.length > 0) {
      throw new CliValidationError(
        `Page(s) ${outOfBounds.join(', ')} out of range for ${path.basename(pdfPath)} ` +
          `(PDF has ${pageCount} page(s): 1..${pageCount}).`
      );
    }
  }

  const pdfSha256 = sha256File(pdfPath);
  const cacheRoot = defaultCacheRoot(ctx);
  fs.mkdirSync(outDir, { recursive: true });

  interface PdfPageRecord {
    readonly page: number;
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
    readonly kb: number;
    readonly cache_hit: boolean;
    readonly preview: SavedImageInfo;
  }

  const pageRecords = await mapWithConcurrency(
    requestedPages,
    PDF_PAGE_MAX_WORKERS,
    async (pageNum): Promise<PdfPageRecord> => {
      const { data: pageData, cacheHit: pageCacheHit } = await renderOrLoadPdfPage(
        pdfPath,
        pdfSha256,
        pageNum,
        dpi,
        fmt,
        cacheRoot,
        refresh,
        ctx
      );
      const padNum = String(pageNum).padStart(3, '0');
      const destPage = path.join(outDir, `page-${padNum}.${fmt}`);
      atomicWriteFileSync(destPage, pageData);
      const previewPath = path.join(outDir, `page-${padNum}.preview.jpg`);

      const meta = await sharp(pageData, { limitInputPixels: false }).metadata();
      const { width: origW, height: origH } = orientedDimensions(meta);
      const savedPrev = await encodeCompactJpeg(pageData, previewPath, { maxWidth, maxKb });
      return {
        page: pageNum,
        path: destPage,
        width: origW,
        height: origH,
        bytes: pageData.length,
        kb: roundKb(pageData.length),
        cache_hit: pageCacheHit,
        preview: savedPrev,
      };
    }
  );

  let stripInfo: SavedImageInfo | undefined;
  if (stripOpt) {
    const stripItems: Array<{ readonly label: string; readonly image: LoadedRgbImage }> = [];
    for (const rec of pageRecords) {
      const im = await loadRgbFromFile(rec.preview.path);
      stripItems.push({
        label: `[p.${String(rec.page).padStart(3, '0')}] ${path.basename(pdfPath)}`,
        image: im,
      });
    }
    stripInfo = await buildContactStripFromItems(
      stripItems,
      resolveUserPath(stripOpt, ctx),
      maxWidth,
      maxKb
    );
  }

  const allCacheHit = pageRecords.length > 0 && pageRecords.every((r) => r.cache_hit);
  const payload = {
    pdf: pdfPath,
    dpi,
    format: fmt,
    requested_pages: requestedPages,
    missing_pages: [] as number[],
    pages: pageRecords,
    ...(stripInfo ? { strip: stripInfo } : {}),
    cache_hit: allCacheHit,
  };

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload), cacheHit: allCacheHit };
  }
  const lines = pageRecords.map(
    (rec) =>
      `p.${String(rec.page).padStart(3, '0')}  ${rec.path} (${rec.kb.toFixed(1)} KB)  ` +
      `preview: ${rec.preview.path} (${rec.preview.kb.toFixed(1)} KB)`
  );
  if (stripInfo) {
    lines.push(
      `strip: ${stripInfo.path}  ${stripInfo.width}x${stripInfo.height}  ${stripInfo.kb.toFixed(1)} KB`
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit: allCacheHit };
}

// ---------------------------------------------------------------------------
// Subcommand: pdf-grep
// ---------------------------------------------------------------------------

function readCachedPdfPages(cachePath: string): string[] | null {
  try {
    if (!fs.statSync(cachePath).isFile()) {
      return null;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const pages = (parsed as Record<string, unknown>).pages;
    if (!Array.isArray(pages) || pages.some((p) => typeof p !== 'string')) {
      return null;
    }
    return pages as string[];
  } catch {
    return null;
  }
}

async function extractPdfPagesText(
  pdfPath: string,
  ctx: RecordCommandContext
): Promise<string[]> {
  const execFn = ctx.execFileImpl ?? defaultExecFile;
  try {
    const { stdout } = await execFn('pdftotext', ['-enc', 'UTF-8', pdfPath, '-'], {
      timeout: 600_000,
      env: ctx.env,
    });
    const pages = stdout.toString('utf8').split('\f');
    if (pages.length > 0 && pages[pages.length - 1].trim().length === 0) {
      pages.pop();
    }
    return pages;
  } catch (err: unknown) {
    const info = extractExecErrorDetails(err);
    if (info.code === 'ENOENT') {
      throw new RecordRuntimeError(
        'pdftotext not found on PATH. Install poppler-utils ' +
          '(for example `apt install poppler-utils` or `brew install poppler`).'
      );
    }
    throw new RecordRuntimeError(
      `pdftotext failed (exit ${String(info.code ?? 1)}): ${info.detail}`
    );
  }
}

async function loadPdfPageTexts(
  pdfPath: string,
  refresh: boolean,
  ctx: RecordCommandContext
): Promise<{ readonly pages: string[]; readonly cacheHit: boolean }> {
  const digest = sha256File(pdfPath);
  const dir = path.join(defaultCacheRoot(ctx), 'pdf-text');
  const dataPath = path.join(dir, `${digest}.json`);
  const lockPath = path.join(dir, `${digest}.lock`);

  if (!refresh) {
    const cached = readCachedPdfPages(dataPath);
    if (cached !== null) {
      return { pages: cached, cacheHit: true };
    }
  }

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!refresh) {
        const cached = readCachedPdfPages(dataPath);
        if (cached !== null) {
          return { pages: cached, cacheHit: true };
        }
      }
      const pages = await extractPdfPagesText(pdfPath, ctx);
      atomicWriteFileSync(dataPath, `${JSON.stringify({ pages }, null, 2)}\n`);
      return { pages, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

async function cmdPdfGrep(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), PDF_GREP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('pdf-grep')) };
  }

  const pdfPath = resolveUserPath(parsed.positionals[0], ctx);
  const pattern = getStringOption(parsed, 'pattern') ?? '';
  const ignoreCase = getBooleanOption(parsed, 'ignoreCase');
  const contextLen = getNumberOption(parsed, 'context') ?? 200;
  const limit = getNumberOption(parsed, 'limit') ?? 25;
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'json');

  if (!fs.existsSync(pdfPath) || !fs.statSync(pdfPath).isFile()) {
    ctx.io.stderr(`Error: PDF file not found: ${pdfPath}`);
    return { exitCode: 1, bytesOut: 0 };
  }
  if (limit < 1 || contextLen < 0) {
    throw new CliValidationError('--limit must be >= 1 and --context must be >= 0.');
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid --pattern regex '${pattern}': ${msg}`);
  }

  const { pages: pageTexts, cacheHit } = await loadPdfPageTexts(pdfPath, refresh, ctx);

  interface PdfGrepMatch {
    readonly page: number;
    readonly line: number;
    readonly match: string;
    readonly snippet: string;
  }

  const matches: PdfGrepMatch[] = [];
  const hitPages: number[] = [];
  let total = 0;

  for (let pIdx = 0; pIdx < pageTexts.length; pIdx += 1) {
    const pageNo = pIdx + 1;
    const text = pageTexts[pIdx];
    let pageHit = false;
    let offset = 0;
    const lines = text.split('\n');
    for (let lIdx = 0; lIdx < lines.length; lIdx += 1) {
      const lineNo = lIdx + 1;
      const line = lines[lIdx];
      regex.lastIndex = 0;
      for (;;) {
        const m = regex.exec(line);
        if (!m) {
          break;
        }
        if (m[0].length === 0) {
          regex.lastIndex += 1;
          if (regex.lastIndex > line.length) {
            break;
          }
          continue;
        }
        total += 1;
        pageHit = true;
        if (matches.length < limit) {
          const start = offset + m.index;
          const end = start + m[0].length;
          const snippet = text
            .slice(Math.max(0, start - contextLen), end + contextLen)
            .trim()
            .replace(/\s+/g, ' ');
          matches.push({ page: pageNo, line: lineNo, match: m[0], snippet });
        }
      }
      offset += line.length + 1;
    }
    if (pageHit) {
      hitPages.push(pageNo);
    }
  }

  const pagesArg = formatPageSpec(hitPages);
  const truncated = total > matches.length;
  const result = {
    pdf: pdfPath,
    pattern,
    ignore_case: ignoreCase,
    page_count: pageTexts.length,
    match_count: total,
    returned: matches.length,
    truncated,
    pages: hitPages,
    pages_arg: pagesArg,
    matches,
    cache_hit: cacheHit,
  };

  let bytesOut: number;
  if (asJson) {
    bytesOut = emitJsonStdout(ctx.io, result);
  } else {
    const outLines = matches.map((m) => `p.${m.page} L${m.line}: ${m.snippet}`);
    const summary =
      `${total} match(es) on ${hitPages.length} of ${pageTexts.length} page(s)` +
      (truncated ? `; showing first ${matches.length} (raise --limit)` : '');
    outLines.push(summary);
    if (pagesArg) {
      outLines.push(`next: kinloom prep-scan pdf-pages ${pdfPath} --pages ${pagesArg} --out-dir <dir>`);
    }
    bytesOut = emitStdout(ctx.io, outLines.join('\n'));
  }

  return { exitCode: total > 0 ? 0 : 1, bytesOut, cacheHit };
}

// ---------------------------------------------------------------------------
// Subcommand: grid
// ---------------------------------------------------------------------------

function buildGridSvg(
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

async function cmdGrid(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), GRID_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('grid')) };
  }

  const src = resolveUserPath(parsed.positionals[0], ctx);
  const outPath = resolveOutputAlias(
    'grid',
    parsed.positionals[1],
    getStringOption(parsed, 'outOpt'),
    ctx
  );
  const step = getNumberOption(parsed, 'step') ?? 200;
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1600;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const rotateDeg = getNumberOption(parsed, 'rotate');

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    ctx.io.stderr(`Error: input file not found: ${src}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  let img = await loadRgbFromFile(src);
  img = await rotateImageClockwise(img, rotateDeg);
  const origW = img.width;
  const origH = img.height;

  const base = origW > maxWidth ? await resizeToWidth(img, maxWidth) : img;
  const gridSvg = buildGridSvg(base.width, base.height, origW, origH, step);
  const composited = await sharp(base.buffer, { limitInputPixels: false })
    .composite([{ input: gridSvg, left: 0, top: 0 }])
    .removeAlpha()
    .png()
    .toBuffer();

  const saved = await encodeCompactJpeg(composited, outPath, { maxWidth, maxKb });
  const payload = {
    original_width: origW,
    original_height: origH,
    preview_width: saved.width,
    preview_height: saved.height,
    step,
    bytes: saved.bytes,
    out: saved.path,
  };
  return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
}

// ---------------------------------------------------------------------------
// Subcommand: stitch
// ---------------------------------------------------------------------------

async function cmdStitch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const expanded = expandMultiBoxArgs(
    normalizePrepScanArgv(argv),
    new Set(['--box', '--redact'])
  );
  const parsed = parseCommandArgs(expanded, STITCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('stitch')) };
  }

  const src = resolveUserPath(parsed.positionals[0], ctx);
  const outPath = resolveOutputAlias(
    'stitch',
    parsed.positionals[1],
    getStringOption(parsed, 'outOpt'),
    ctx
  );
  const boxRaws = getStringListOption(parsed, 'box');
  const redactRaws = getStringListOption(parsed, 'redact');
  const rotateDeg = getNumberOption(parsed, 'rotate');
  const direction = parseJoinDirection(getStringOption(parsed, 'direction') ?? 'vertical');
  const gap = getNumberOption(parsed, 'gap') ?? 6;
  const dividerRgb = parseRgbColor(getStringOption(parsed, 'dividerColor') ?? '#222222');
  const quality = getNumberOption(parsed, 'quality') ?? 90;
  const maxWidth = getNumberOption(parsed, 'maxWidth');
  const maxKb = getNumberOption(parsed, 'maxKb');
  const rawLabels = getStringListOption(parsed, 'labels');
  const labels =
    rawLabels.length === 1 && rawLabels[0].includes(',')
      ? rawLabels[0].split(',').map((s) => s.trim())
      : rawLabels;
  const headerHeightOpt = getNumberOption(parsed, 'headerHeight');
  const headerH = labels.length > 0 ? (headerHeightOpt ?? 26) : 0;

  const boxes = boxRaws.map((raw) => parseBox(raw));
  const redactBoxes = redactRaws.map((raw) => parseBox(raw));

  if (boxes.length < 2) {
    throw new CliValidationError(
      'stitch requires at least 2 --box regions (for example header + target band).'
    );
  }

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    ctx.io.stderr(`Error: input file not found: ${src}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  let img = await loadRgbFromFile(src);
  img = await rotateImageClockwise(img, rotateDeg);

  const redacted = await paintBlackBoxesInclusive(img, redactBoxes, '--redact');
  img = redacted.image;

  const croppedBands: Array<{ readonly box: Box; readonly image: LoadedRgbImage }> = [];
  for (let i = 0; i < boxes.length; i += 1) {
    const clamped = clampBox(boxes[i], img.width, img.height, `--box #${i + 1}`);
    const bandImg = await cropRgbImage(img, clamped);
    croppedBands.push({ box: clamped, image: bandImg });
  }

  let canvasW: number;
  let canvasH: number;
  if (direction === 'horizontal') {
    canvasW =
      croppedBands.reduce((sum, b) => sum + b.image.width, 0) +
      gap * (croppedBands.length - 1);
    canvasH = Math.max(...croppedBands.map((b) => b.image.height + headerH));
  } else {
    canvasW = Math.max(...croppedBands.map((b) => b.image.width));
    canvasH =
      croppedBands.reduce((sum, b) => sum + b.image.height + headerH, 0) +
      gap * (croppedBands.length - 1);
  }

  const overlays: OverlayOptions[] = [];
  const bandReports: Array<{
    readonly box: readonly [number, number, number, number];
    readonly width: number;
    readonly height: number;
    readonly x_offset: number;
    readonly y_offset: number;
    readonly label?: string;
  }> = [];

  if (direction === 'horizontal') {
    let x = 0;
    for (let i = 0; i < croppedBands.length; i += 1) {
      const { box: cbox, image: band } = croppedBands[i];
      const label = labels[i];
      const bandTop = headerH;
      if (headerH > 0) {
        overlays.push({
          input: buildHeaderSvg(band.width, headerH, label ?? `Panel ${i + 1}`),
          left: x,
          top: 0,
        });
      }
      if (band.height + headerH < canvasH) {
        overlays.push({
          input: {
            create: {
              width: band.width,
              height: canvasH - headerH,
              channels: 3,
              background: { r: 255, g: 255, b: 255 },
            },
          },
          left: x,
          top: bandTop,
        });
      }
      const yOffset = bandTop + Math.floor((canvasH - headerH - band.height) / 2);
      overlays.push({ input: band.buffer, left: x, top: yOffset });
      bandReports.push({
        box: [cbox.x0, cbox.y0, cbox.x1, cbox.y1],
        width: band.width,
        height: band.height,
        x_offset: x,
        y_offset: yOffset,
        ...(label !== undefined ? { label } : {}),
      });
      x += band.width + gap;
    }
  } else {
    let y = 0;
    for (let i = 0; i < croppedBands.length; i += 1) {
      const { box: cbox, image: band } = croppedBands[i];
      const label = labels[i];
      if (headerH > 0) {
        overlays.push({
          input: buildHeaderSvg(canvasW, headerH, label ?? `Panel ${i + 1}`),
          left: 0,
          top: y,
        });
        y += headerH;
      }
      if (band.width < canvasW) {
        overlays.push({
          input: {
            create: {
              width: canvasW,
              height: band.height,
              channels: 3,
              background: { r: 255, g: 255, b: 255 },
            },
          },
          left: 0,
          top: y,
        });
      }
      const xOffset = Math.floor((canvasW - band.width) / 2);
      overlays.push({ input: band.buffer, left: xOffset, top: y });
      bandReports.push({
        box: [cbox.x0, cbox.y0, cbox.x1, cbox.y1],
        width: band.width,
        height: band.height,
        x_offset: xOffset,
        y_offset: y,
        ...(label !== undefined ? { label } : {}),
      });
      y += band.height + gap;
    }
  }

  const canvasBuf = await sharp({
    create: {
      width: Math.max(1, canvasW),
      height: Math.max(1, canvasH),
      channels: 3,
      background: dividerRgb,
    },
    limitInputPixels: false,
  })
    .composite(overlays)
    .removeAlpha()
    .png()
    .toBuffer();

  const canvasImage: LoadedRgbImage = {
    buffer: canvasBuf,
    width: Math.max(1, canvasW),
    height: Math.max(1, canvasH),
  };

  const saved =
    maxWidth !== undefined || maxKb !== undefined
      ? await encodeCompactJpeg(canvasBuf, outPath, {
          maxWidth: maxWidth ?? canvasImage.width,
          maxKb: maxKb ?? 280,
        })
      : await saveArchivalImage(canvasImage, outPath, quality);

  const payload = {
    width: saved.width,
    height: saved.height,
    bytes: saved.bytes,
    bands: bandReports,
    redactions: redacted.painted,
    out: saved.path,
  };
  return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
}

// ---------------------------------------------------------------------------
// Subcommand: info
// ---------------------------------------------------------------------------

async function cmdInfo(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), INFO_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('info')) };
  }

  const asJson = getBooleanOption(parsed, 'json');
  interface InfoFileRecord {
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly format: string;
    readonly mode: string;
    readonly bytes: number;
    readonly kb: number;
  }

  const files: InfoFileRecord[] = [];
  const errors: string[] = [];

  for (const raw of parsed.positionals) {
    const src = resolveUserPath(raw, ctx);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      errors.push(`input file not found: ${src}`);
      continue;
    }
    try {
      const nbytes = fs.statSync(src).size;
      const meta = await sharp(src, { limitInputPixels: false }).metadata();
      const { width, height } = orientedDimensions(meta);
      const imageFormat = (meta.format ?? 'UNKNOWN').toUpperCase();
      const mode = mapChannelsToMode(meta.channels, meta.space);
      files.push({
        path: src,
        width,
        height,
        format: imageFormat,
        mode,
        bytes: nbytes,
        kb: roundKb(nbytes),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`cannot read image ${src}: ${msg}. Use a JPEG, PNG, WEBP, or TIFF file.`);
    }
  }

  if (errors.length > 0) {
    for (const message of errors) {
      ctx.io.stderr(`Error: ${message}`);
    }
    return { exitCode: 1, bytesOut: 0 };
  }

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, { count: files.length, files }) };
  }
  const lines = files.map(
    (item) => `${item.path}: ${item.width}x${item.height} ${item.format} (${item.kb.toFixed(1)} KB)`
  );
  return { exitCode: 0, bytesOut: lines.length > 0 ? emitStdout(ctx.io, lines.join('\n')) : 0 };
}

// ---------------------------------------------------------------------------
// Subcommand: join
// ---------------------------------------------------------------------------

async function cmdJoin(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), JOIN_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('join')) };
  }

  if (parsed.positionals.length < 2) {
    throw new CliValidationError(
      'join requires at least 2 images. Pass two or more paths and --out <file>.'
    );
  }

  const outPath = resolveUserPath(getStringOption(parsed, 'out') ?? '', ctx);
  const direction = parseJoinDirection(getStringOption(parsed, 'direction') ?? 'vertical');
  const gap = getNumberOption(parsed, 'gap') ?? 8;
  const align = parseJoinAlign(getStringOption(parsed, 'align') ?? 'center');
  const background = parseRgbColor(getStringOption(parsed, 'dividerColor') ?? '#222222');
  const quality = getNumberOption(parsed, 'quality') ?? 92;
  const previewOutOpt = getStringOption(parsed, 'previewOut');
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;

  const frames: LoadedRgbImage[] = [];
  for (const raw of parsed.positionals) {
    const src = resolveUserPath(raw, ctx);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      ctx.io.stderr(`Error: input file not found: ${src}`);
      return { exitCode: 1, bytesOut: 0 };
    }
    frames.push(await loadRgbFromFile(src));
  }

  let canvasW: number;
  let canvasH: number;
  if (direction === 'horizontal') {
    canvasW = frames.reduce((sum, f) => sum + f.width, 0) + gap * (frames.length - 1);
    canvasH = Math.max(...frames.map((f) => f.height));
  } else {
    canvasW = Math.max(...frames.map((f) => f.width));
    canvasH = frames.reduce((sum, f) => sum + f.height, 0) + gap * (frames.length - 1);
  }

  const overlays: OverlayOptions[] = [];
  let cursor = 0;
  for (const frame of frames) {
    if (direction === 'horizontal') {
      const x = cursor;
      const y = alignOffset(canvasH, frame.height, align);
      overlays.push({ input: frame.buffer, left: x, top: y });
      cursor += frame.width + gap;
    } else {
      const x = alignOffset(canvasW, frame.width, align);
      const y = cursor;
      overlays.push({ input: frame.buffer, left: x, top: y });
      cursor += frame.height + gap;
    }
  }

  const canvasBuf = await sharp({
    create: {
      width: Math.max(1, canvasW),
      height: Math.max(1, canvasH),
      channels: 3,
      background,
    },
    limitInputPixels: false,
  })
    .composite(overlays)
    .removeAlpha()
    .png()
    .toBuffer();

  const canvasImage: LoadedRgbImage = {
    buffer: canvasBuf,
    width: Math.max(1, canvasW),
    height: Math.max(1, canvasH),
  };
  const saved = await saveArchivalImage(canvasImage, outPath, quality);

  let previewPath: string | undefined;
  if (previewOutOpt) {
    const preview = await encodeCompactJpeg(canvasBuf, resolveUserPath(previewOutOpt, ctx), {
      maxWidth,
      maxKb,
    });
    previewPath = preview.path;
  }

  const payload = {
    width: saved.width,
    height: saved.height,
    bytes: saved.bytes,
    count: parsed.positionals.length,
    direction,
    out: saved.path,
    ...(previewPath !== undefined ? { preview_out: previewPath } : {}),
  };
  return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export const runPrepScanCommand: RecordHandler = async (
  args,
  ctx
): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'preview':
        return await cmdPreview(rest, ctx);
      case 'crop':
        return await cmdCrop(rest, ctx);
      case 'sheet-strip':
        return await cmdSheetStrip(rest, ctx);
      case 'pdf-pages':
        return await cmdPdfPages(rest, ctx);
      case 'pdf-grep':
        return await cmdPdfGrep(rest, ctx);
      case 'grid':
        return await cmdGrid(rest, ctx);
      case 'stitch':
        return await cmdStitch(rest, ctx);
      case 'info':
        return await cmdInfo(rest, ctx);
      case 'join':
        return await cmdJoin(rest, ctx);
      case 'rotate':
        return await cmdRotate(rest, ctx);
      default:
        throw new CliValidationError(
          `Unknown prep-scan subcommand '${subcmd}'. Run 'kinloom prep-scan --help'.`
        );
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof RecordRuntimeError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: err.exitCode, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
