import fs from 'node:fs';
import path from 'node:path';
import { HTML_ERROR_PREFIXES } from '../../runtime/primitives.js';
import { InputImageError, type OcrLineBox, type OcrWordBox, type ParsedTsvLayout } from './types.js';

export function inferImageMimeType(filePath: string, rawBytes: Buffer): string {
  if (
    rawBytes.length >= 8 &&
    rawBytes[0] === 0x89 &&
    rawBytes[1] === 0x50 &&
    rawBytes[2] === 0x4e &&
    rawBytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 0xff && rawBytes[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (
    rawBytes.length >= 12 &&
    rawBytes.toString('ascii', 0, 4) === 'RIFF' &&
    rawBytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/jpeg';
}

export function readJpegDimensions(data: Buffer): readonly [number, number] | null {
  const n = data.length;
  if (n < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return null;
  }
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let pos = 2;
  while (pos < n) {
    while (pos < n && data[pos] !== 0xff) {
      pos += 1;
    }
    while (pos < n && data[pos] === 0xff) {
      pos += 1;
    }
    if (pos >= n) {
      break;
    }
    const marker = data[pos];
    pos += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (pos + 2 > n) {
      break;
    }
    const segLen = data.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > n) {
      break;
    }
    if (sofMarkers.has(marker)) {
      if (pos + 7 > n) {
        return null;
      }
      const height = data.readUInt16BE(pos + 3);
      const width = data.readUInt16BE(pos + 5);
      return width > 0 && height > 0 ? [width, height] : null;
    }
    pos += segLen;
  }
  return null;
}

export function readTiffDimensions(data: Buffer): readonly [number, number] | null {
  if (data.length < 8) {
    return null;
  }
  let littleEndian: boolean;
  if (data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00) {
    littleEndian = true;
  } else if (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a) {
    littleEndian = false;
  } else {
    return null;
  }
  const readU16 = (off: number): number => (littleEndian ? data.readUInt16LE(off) : data.readUInt16BE(off));
  const readU32 = (off: number): number => (littleEndian ? data.readUInt32LE(off) : data.readUInt32BE(off));

  const ifdOffset = readU32(4);
  if (ifdOffset + 2 > data.length) {
    return null;
  }
  const numEntries = readU16(ifdOffset);
  let width: number | null = null;
  let height: number | null = null;
  let pos = ifdOffset + 2;
  for (let i = 0; i < numEntries; i += 1) {
    if (pos + 12 > data.length) {
      break;
    }
    const tag = readU16(pos);
    const fieldType = readU16(pos + 2);
    const count = readU32(pos + 4);
    if ((tag === 256 || tag === 257) && count >= 1) {
      let val: number | null = null;
      if (fieldType === 3) {
        val = readU16(pos + 8);
      } else if (fieldType === 4) {
        val = readU32(pos + 8);
      }
      if (val !== null) {
        if (tag === 256) {
          width = val;
        } else {
          height = val;
        }
      }
      if (width !== null && height !== null) {
        return width > 0 && height > 0 ? [width, height] : null;
      }
    }
    pos += 12;
  }
  return null;
}

function readWebpDimensions(data: Buffer): readonly [number, number] | null {
  if (
    data.length < 30 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const chunk = data.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && data.length >= 30) {
    const width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
    const height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
    return [width, height];
  }
  if (chunk === 'VP8 ' && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    const width = data.readUInt16LE(26) & 0x3fff;
    const height = data.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? [width, height] : null;
  }
  if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return [width, height];
  }
  return null;
}

export function readImageDimensions(rawBytes: Buffer): readonly [number, number] | null {
  if (
    rawBytes.length >= 24 &&
    rawBytes[0] === 0x89 &&
    rawBytes[1] === 0x50 &&
    rawBytes[2] === 0x4e &&
    rawBytes[3] === 0x47 &&
    rawBytes[4] === 0x0d &&
    rawBytes[5] === 0x0a &&
    rawBytes[6] === 0x1a &&
    rawBytes[7] === 0x0a
  ) {
    const w = rawBytes.readUInt32BE(16);
    const h = rawBytes.readUInt32BE(20);
    return w > 0 && h > 0 ? [w, h] : null;
  }
  if (rawBytes.length >= 10) {
    const sig6 = rawBytes.toString('ascii', 0, 6);
    if (sig6 === 'GIF87a' || sig6 === 'GIF89a') {
      const w = rawBytes.readUInt16LE(6);
      const h = rawBytes.readUInt16LE(8);
      return w > 0 && h > 0 ? [w, h] : null;
    }
  }
  if (rawBytes.length >= 26 && rawBytes[0] === 0x42 && rawBytes[1] === 0x4d) {
    const w = Math.abs(rawBytes.readInt32LE(18));
    const h = Math.abs(rawBytes.readInt32LE(22));
    return w > 0 && h > 0 ? [w, h] : null;
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 0xff && rawBytes[1] === 0xd8) {
    return readJpegDimensions(rawBytes);
  }
  if (
    rawBytes.length >= 4 &&
    ((rawBytes[0] === 0x49 && rawBytes[1] === 0x49 && rawBytes[2] === 0x2a && rawBytes[3] === 0x00) ||
      (rawBytes[0] === 0x4d && rawBytes[1] === 0x4d && rawBytes[2] === 0x00 && rawBytes[3] === 0x2a))
  ) {
    return readTiffDimensions(rawBytes);
  }
  if (
    rawBytes.length >= 12 &&
    rawBytes.toString('ascii', 0, 4) === 'RIFF' &&
    rawBytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return readWebpDimensions(rawBytes);
  }
  return null;
}

export function validateImageFile(imgPath: string): Buffer {
  if (!fs.existsSync(imgPath)) {
    throw new InputImageError(`image file not found: ${imgPath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(imgPath);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new InputImageError(`cannot read image file ${imgPath}: ${detail}`);
  }
  if (!stat.isFile()) {
    throw new InputImageError(`image path is not a regular file: ${imgPath}`);
  }
  let rawBytes: Buffer;
  try {
    rawBytes = fs.readFileSync(imgPath);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new InputImageError(`cannot read image file ${imgPath}: ${detail}`);
  }
  if (rawBytes.length === 0) {
    throw new InputImageError(`image file is empty (0 bytes): ${imgPath}`);
  }
  const headText = rawBytes
    .subarray(0, Math.min(512, rawBytes.length))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/^[ \t\r\n]+/, '');
  if (headText.startsWith('%PDF-')) {
    throw new InputImageError(
      `file is a PDF, not an image: ${imgPath} (render pages first with 'kinloom prep-scan pdf-pages').`
    );
  }
  const headLower = headText.toLowerCase();
  if (HTML_ERROR_PREFIXES.some((prefix) => headLower.startsWith(prefix))) {
    throw new InputImageError(`file is HTML, not an image: ${imgPath}`);
  }
  return rawBytes;
}

export function rescaleTesseractTsv(
  tsv: string,
  origWidth: number,
  origHeight: number,
  scaledWidth: number,
  scaledHeight: number
): string {
  if (
    origWidth <= 0 ||
    origHeight <= 0 ||
    scaledWidth <= 0 ||
    scaledHeight <= 0 ||
    (origWidth === scaledWidth && origHeight === scaledHeight)
  ) {
    return tsv;
  }

  const lines = tsv.split(/\r?\n/);
  if (lines.length === 0 || !lines[0]) {
    return tsv;
  }
  const header = lines[0].split('\t');
  const idxLevel = header.indexOf('level');
  const idxLeft = header.indexOf('left');
  const idxTop = header.indexOf('top');
  const idxWidth = header.indexOf('width');
  const idxHeight = header.indexOf('height');
  if (idxLevel === -1 || idxLeft === -1 || idxTop === -1 || idxWidth === -1 || idxHeight === -1) {
    return tsv;
  }
  const minCols = Math.max(idxLevel, idxLeft, idxTop, idxWidth, idxHeight) + 1;
  const sx = origWidth / scaledWidth;
  const sy = origHeight / scaledHeight;
  const outLines: string[] = [lines[0]];

  for (let i = 1; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (!rawLine.trim()) {
      continue;
    }
    const cols = rawLine.split('\t');
    if (cols.length < minCols) {
      outLines.push(rawLine);
      continue;
    }
    const level = Number.parseInt(cols[idxLevel], 10);
    const left = Number.parseInt(cols[idxLeft], 10);
    const top = Number.parseInt(cols[idxTop], 10);
    const width = Number.parseInt(cols[idxWidth], 10);
    const height = Number.parseInt(cols[idxHeight], 10);
    if (
      !Number.isFinite(level) ||
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      outLines.push(rawLine);
      continue;
    }

    if (level === 1) {
      cols[idxLeft] = '0';
      cols[idxTop] = '0';
      cols[idxWidth] = String(origWidth);
      cols[idxHeight] = String(origHeight);
    } else {
      const x0 = Math.max(0, Math.min(origWidth, Math.round(left * sx)));
      const y0 = Math.max(0, Math.min(origHeight, Math.round(top * sy)));
      const x1 = Math.max(x0, Math.min(origWidth, Math.round((left + width) * sx)));
      const y1 = Math.max(y0, Math.min(origHeight, Math.round((top + height) * sy)));
      let newW = x1 - x0;
      let newH = y1 - y0;
      if (width > 0 && newW === 0 && x0 < origWidth) {
        newW = 1;
      }
      if (height > 0 && newH === 0 && y0 < origHeight) {
        newH = 1;
      }
      cols[idxLeft] = String(x0);
      cols[idxTop] = String(y0);
      cols[idxWidth] = String(newW);
      cols[idxHeight] = String(newH);
    }
    outLines.push(cols.join('\t'));
  }

  const trailing = tsv.endsWith('\n') ? '\n' : '';
  return `${outLines.join('\n')}${trailing}`;
}

export function parseTesseractTsv(tsv: string): ParsedTsvLayout {
  const rows = tsv
    .split(/\r?\n/)
    .filter((row) => row.trim().length > 0)
    .map((row) => row.split('\t'));

  if (rows.length === 0 || rows[0][0] !== 'level') {
    throw new Error('tesseract TSV output is missing its header row.');
  }

  const header = rows[0];
  let imageWidth = 0;
  let imageHeight = 0;
  const lineMap = new Map<
    string,
    {
      readonly page: number;
      readonly block: number;
      readonly par: number;
      readonly line: number;
      readonly words: OcrWordBox[];
    }
  >();

  for (let i = 1; i < rows.length; i += 1) {
    const raw = rows[i];
    if (raw.length < header.length - 1) {
      continue;
    }
    const rec: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      rec[header[c]] = raw[c] ?? '';
    }
    const level = Number.parseInt(rec.level ?? '', 10);
    const left = Number.parseInt(rec.left ?? '', 10);
    const top = Number.parseInt(rec.top ?? '', 10);
    const width = Number.parseInt(rec.width ?? '', 10);
    const height = Number.parseInt(rec.height ?? '', 10);
    const right = left + width;
    const bottom = top + height;

    if (level === 1) {
      imageWidth = Math.max(imageWidth, right);
      imageHeight = Math.max(imageHeight, bottom);
      continue;
    }
    const text = (rec.text ?? '').trim();
    if (level !== 5 || !text) {
      continue;
    }
    const conf = Number.parseFloat(rec.conf ?? '-1');
    const page = Number.parseInt(rec.page_num ?? '0', 10);
    const block = Number.parseInt(rec.block_num ?? '0', 10);
    const par = Number.parseInt(rec.par_num ?? '0', 10);
    const lineNum = Number.parseInt(rec.line_num ?? '0', 10);
    const key = `${page}:${block}:${par}:${lineNum}`;
    let group = lineMap.get(key);
    if (!group) {
      group = { page, block, par, line: lineNum, words: [] };
      lineMap.set(key, group);
    }
    group.words.push({
      text,
      x0: left,
      y0: top,
      x1: right,
      y1: bottom,
      conf,
    });
  }

  const outLines: OcrLineBox[] = [];
  for (const group of lineMap.values()) {
    const { words, page, block, par, line } = group;
    const validConfs = words.map((w) => w.conf).filter((c) => c >= 0);
    const avgConf =
      validConfs.length > 0
        ? Math.round((validConfs.reduce((a, b) => a + b, 0) / validConfs.length) * 100) / 100
        : -1;
    outLines.push({
      text: words.map((w) => w.text).join(' '),
      x0: Math.min(...words.map((w) => w.x0)),
      y0: Math.min(...words.map((w) => w.y0)),
      x1: Math.max(...words.map((w) => w.x1)),
      y1: Math.max(...words.map((w) => w.y1)),
      conf: avgConf,
      page,
      block,
      par,
      line,
      words,
    });
  }

  return {
    image_width: imageWidth,
    image_height: imageHeight,
    lines: outLines,
  };
}
