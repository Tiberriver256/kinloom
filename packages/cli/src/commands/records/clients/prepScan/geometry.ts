import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';

export const DEFAULT_MAX_WORKERS = 8;
export const DEFAULT_TIMEOUT_S = 12.0;
export const DEFAULT_PDF_TIMEOUT_S = 60;
export const PDF_PAGE_BATCH_LIMIT = 25;
export const PDF_PAGE_MAX_WORKERS = 4;
export const USER_AGENT = 'kinloom-prep-scan/1.0 (genealogy archival tooling)';
export const PDF_PAGE_NUM_RE = /-(\d+)\.(?:jpe?g|png)$/i;
export const PDFINFO_PAGES_RE = /^Pages:\s*(\d+)\s*$/m;

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

export function roundKb(bytes: number): number {
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
  if (
    x0 === undefined ||
    y0 === undefined ||
    x1 === undefined ||
    y1 === undefined ||
    x0 < 0 ||
    y0 < 0 ||
    x1 <= x0 ||
    y1 <= y0
  ) {
    throw new CliValidationError(`Invalid box '${raw}': require 0 <= x0 < x1 and 0 <= y0 < y1.`);
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
      const b0 = bounds[0]?.trim() ?? '';
      const b1 = bounds[1]?.trim() ?? '';
      if (bounds.length !== 2 || !b0 || !b1) {
        throw new CliValidationError(
          `Invalid page range '${token}' in --pages '${raw}'. Use positive 1-based bounds like 10-12.`
        );
      }
      const startStr = b0;
      const endStr = b1;
      if (!/^[+-]?\d+$/.test(startStr) || !/^[+-]?\d+$/.test(endStr)) {
        throw new CliValidationError(
          `Invalid page range '${token}' in --pages '${raw}'. Use integer bounds like 10-12.`
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
        throw new CliValidationError(`Page number must be >= 1, got ${num} in --pages '${raw}'.`);
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
  if (start === undefined || prev === undefined) return ranges;
  for (let i = 1; i < pages.length; i += 1) {
    const p = pages[i];
    if (p === undefined) continue;
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

export function clampBox(box: Box, width: number, height: number, label: string, outsideHint = ''): Box {
  if (box.x0 >= width || box.y0 >= height) {
    const extra = outsideHint ? ` ${outsideHint}` : '';
    throw new CliValidationError(
      `${label} (${box.x0},${box.y0},${box.x1},${box.y1}) starts outside ${width}x${height} image.${extra}`
    );
  }
  const x1 = Math.min(box.x1, width);
  const y1 = Math.min(box.y1, height);
  if (x1 <= box.x0 || y1 <= box.y0) {
    throw new CliValidationError(`${label} collapses to empty area inside ${width}x${height} image.`);
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
  throw new CliValidationError(`Invalid --direction '${raw}': expected vertical, horizontal, v, or h.`);
}

export function parseJoinAlign(raw: string): JoinAlign {
  const key = raw.trim().toLowerCase();
  if (key === 'start' || key === 'center' || key === 'end') {
    return key;
  }
  throw new CliValidationError(`Invalid --align '${raw}': expected start, center, or end.`);
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
      const h0 = hex.charAt(0);
      const h1 = hex.charAt(1);
      const h2 = hex.charAt(2);
      return {
        r: Number.parseInt(h0 + h0, 16),
        g: Number.parseInt(h1 + h1, 16),
        b: Number.parseInt(h2 + h2, 16),
      };
    }
    if (/^[0-9a-f]{6}$/.test(hex)) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }
    throw new CliValidationError(`Invalid --divider-color '${raw}': expected hex or named RGB color.`);
  }

  const rgbMatch = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(trimmed);
  if (rgbMatch) {
    const r = Number.parseInt(rgbMatch[1] ?? '', 10);
    const g = Number.parseInt(rgbMatch[2] ?? '', 10);
    const b = Number.parseInt(rgbMatch[3] ?? '', 10);
    if (r <= 255 && g <= 255 && b <= 255) {
      return { r, g, b };
    }
    throw new CliValidationError(`Invalid --divider-color '${raw}': expected hex or named RGB color.`);
  }

  const named = NAMED_RGB_COLORS[trimmed];
  if (named) {
    return named;
  }
  throw new CliValidationError(`Invalid --divider-color '${raw}': expected hex or named RGB color.`);
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
      if (prev === undefined) continue;
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

export function expandMultiBoxArgs(argv: readonly string[], multiFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (token === undefined) {
      i += 1;
      continue;
    }
    if (multiFlags.has(token) && i + 1 < argv.length) {
      const nextVal = argv[i + 1];
      if (nextVal !== undefined) out.push(token, nextVal);
      i += 2;
      while (i < argv.length) {
        const curArg = argv[i];
        if (curArg === undefined || !FOUR_NUM_BOX_RE.test(curArg.trim())) break;
        out.push(token, curArg);
        i += 1;
      }
      continue;
    }
    out.push(token);
    i += 1;
  }
  return out;
}

export function normalizeRotationAngle(degrees: number | undefined): number {
  if (degrees === undefined) {
    return 0;
  }
  if (!Number.isFinite(degrees)) {
    throw new CliValidationError(`Unsupported rotation '${String(degrees)}': expected a finite angle.`);
  }
  const norm = ((degrees % 360) + 360) % 360;
  return norm === 360 ? 0 : norm;
}

export function isUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.host);
  } catch {
    return false;
  }
}

export function shortLabel(target: string, index: number): string {
  const prefix = `[${String(index).padStart(2, '0')}]`;
  if (isUrl(target)) {
    const parsed = new URL(target);
    const tail = path.posix.basename(parsed.pathname) || parsed.host;
    return `${prefix} ${tail}`;
  }
  return `${prefix} ${path.basename(target)}`;
}
