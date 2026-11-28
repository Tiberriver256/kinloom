import { KinloomHttpError } from '../errors.js';

export const STRIPPABLE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type StrippableImageMime = (typeof STRIPPABLE_IMAGE_MIMES)[number];

export interface StrippedImageResult {
  readonly bytes: Uint8Array;
  readonly mimeType: StrippableImageMime;
  readonly width: number | null;
  readonly height: number | null;
  readonly orientation: number;
  readonly strippedMetadataBytes: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const SAFE_PNG_CHUNKS = new Set<string>([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'bKGD',
  'pHYs',
  'sPLT',
]);

const JPEG_SOF_MARKERS = new Set<number>([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const ICC_PROFILE_PREFIX = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00] as const; // "ICC_PROFILE\0"

const EXIF_HEADER_PREFIX = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] as const; // "Exif\0\0"

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = buildCrc32Table();

/**
 * Computes IEEE 802.3 CRC-32 over a byte range (used to verify PNG chunks).
 */
function dataViewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const CRC32_TABLE_VIEW = dataViewOf(
  new Uint8Array(CRC32_TABLE.buffer, CRC32_TABLE.byteOffset, CRC32_TABLE.byteLength)
);
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function computeCrc32(bytes: Uint8Array, start = 0, end = bytes.byteLength): number {
  const view = dataViewOf(bytes);
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc = CRC32_TABLE_VIEW.getUint32(((crc ^ view.getUint8(i)) & 0xff) * 4, IS_LITTLE_ENDIAN) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return dataViewOf(bytes).getUint16(offset, false);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return dataViewOf(bytes).getUint16(offset, true);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  const view = dataViewOf(bytes);
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return dataViewOf(bytes).getUint32(offset, false);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return dataViewOf(bytes).getUint32(offset, true);
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function matchesPrefixAt(bytes: Uint8Array, offset: number, prefix: readonly number[]): boolean {
  if (offset + prefix.length > bytes.byteLength) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[offset + i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function readAscii4(bytes: Uint8Array, offset: number): string {
  const view = dataViewOf(bytes);
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return out;
}

/**
 * Extracts TIFF IFD0 Orientation tag (0x0112) from a JPEG APP1 Exif payload.
 * Returns a value in 1..8 when present, or null otherwise.
 */
function parseExifOrientation(payload: Uint8Array): number | null {
  if (!matchesPrefixAt(payload, 0, EXIF_HEADER_PREFIX) || payload.byteLength < 14) {
    return null;
  }
  const tiffStart = 6;
  const b0 = payload[tiffStart];
  const b1 = payload[tiffStart + 1];
  let littleEndian: boolean;
  if (b0 === 0x49 && b1 === 0x49) {
    littleEndian = true;
  } else if (b0 === 0x4d && b1 === 0x4d) {
    littleEndian = false;
  } else {
    return null;
  }
  const readU16 = (off: number): number =>
    littleEndian ? readUint16LE(payload, off) : readUint16BE(payload, off);
  const readU32 = (off: number): number =>
    littleEndian ? readUint32LE(payload, off) : readUint32BE(payload, off);

  if (readU16(tiffStart + 2) !== 0x002a) {
    return null;
  }
  const ifd0RelOffset = readU32(tiffStart + 4);
  const ifd0Offset = tiffStart + ifd0RelOffset;
  if (ifd0Offset + 2 > payload.byteLength) {
    return null;
  }
  const entryCount = readU16(ifd0Offset);
  const entriesStart = ifd0Offset + 2;
  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = entriesStart + i * 12;
    if (entryOffset + 12 > payload.byteLength) {
      break;
    }
    const tag = readU16(entryOffset);
    if (tag === 0x0112) {
      const type = readU16(entryOffset + 2);
      const count = readU32(entryOffset + 4);
      if (type === 3 && count === 1) {
        const value = readU16(entryOffset + 8);
        if (value >= 1 && value <= 8) {
          return value;
        }
      }
      return null;
    }
  }
  return null;
}

function stripJpegMetadata(bytes: Uint8Array): StrippedImageResult {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Malformed JPEG image header.');
  }

  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let width: number | null = null;
  let height: number | null = null;
  let orientation = 1;
  let strippedMetadataBytes = 0;

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Malformed JPEG marker structure.');
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.byteLength) {
      break;
    }

    const marker = dataViewOf(bytes).getUint8(offset);
    offset += 1;

    // EOI (0xD9) ends the image stream.
    if (marker === 0xd9) {
      kept.push(new Uint8Array([0xff, 0xd9]));
      break;
    }

    // Standalone markers without a length field (TEM 0x01, RST0..RST7 0xD0..0xD7).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(new Uint8Array([0xff, marker]));
      continue;
    }

    if (offset + 2 > bytes.byteLength) {
      throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Truncated JPEG segment length.');
    }
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Truncated JPEG segment payload.');
    }

    const segmentStart = offset - 2;
    const segmentEnd = offset + segmentLength;

    // SOS (0xDA): preserve header and the entire entropy-coded image stream to the end.
    if (marker === 0xda) {
      kept.push(bytes.subarray(segmentStart));
      break;
    }

    if (JPEG_SOF_MARKERS.has(marker) && segmentLength >= 7) {
      const parsedHeight = readUint16BE(bytes, offset + 3);
      const parsedWidth = readUint16BE(bytes, offset + 5);
      if (parsedWidth > 0 && parsedHeight > 0) {
        width = parsedWidth;
        height = parsedHeight;
      }
    }

    const isApp1 = marker === 0xe1;
    const isApp2 = marker === 0xe2;
    const isOtherApp = marker >= 0xe3 && marker <= 0xef;
    const isComment = marker === 0xfe;

    if (isApp1) {
      const parsedOrientation = parseExifOrientation(bytes.subarray(offset + 2, segmentEnd));
      if (parsedOrientation !== null) {
        orientation = parsedOrientation;
      }
      strippedMetadataBytes += segmentEnd - segmentStart;
      offset = segmentEnd;
      continue;
    }

    if (isComment || isOtherApp) {
      strippedMetadataBytes += segmentEnd - segmentStart;
      offset = segmentEnd;
      continue;
    }

    if (isApp2 && !matchesPrefixAt(bytes, offset + 2, ICC_PROFILE_PREFIX)) {
      strippedMetadataBytes += segmentEnd - segmentStart;
      offset = segmentEnd;
      continue;
    }

    kept.push(bytes.subarray(segmentStart, segmentEnd));
    offset = segmentEnd;
  }

  return {
    bytes: concatChunks(kept),
    mimeType: 'image/jpeg',
    width,
    height,
    orientation,
    strippedMetadataBytes,
  };
}

function stripPngMetadata(bytes: Uint8Array): StrippedImageResult {
  if (!matchesPrefixAt(bytes, 0, PNG_SIGNATURE)) {
    throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Malformed PNG signature.');
  }

  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let width: number | null = null;
  let height: number | null = null;
  let strippedMetadataBytes = 0;
  let sawIend = false;

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Truncated PNG chunk header.');
    }
    const dataLength = readUint32BE(bytes, offset);
    const chunkTotal = 12 + dataLength;
    if (offset + chunkTotal > bytes.byteLength) {
      throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Truncated PNG chunk data.');
    }

    const chunkType = readAscii4(bytes, offset + 4);
    const expectedCrc = readUint32BE(bytes, offset + 8 + dataLength);
    const actualCrc = computeCrc32(bytes, offset + 4, offset + 8 + dataLength);
    if (actualCrc !== expectedCrc) {
      throw new KinloomHttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        `Corrupt PNG chunk '${chunkType}' failed CRC verification.`
      );
    }

    if (chunkType === 'IHDR' && dataLength >= 8) {
      const parsedWidth = readUint32BE(bytes, offset + 8);
      const parsedHeight = readUint32BE(bytes, offset + 12);
      if (parsedWidth > 0 && parsedHeight > 0) {
        width = parsedWidth;
        height = parsedHeight;
      }
    }

    const isCritical = (dataViewOf(bytes).getUint8(offset + 4) & 0x20) === 0;
    if (isCritical || SAFE_PNG_CHUNKS.has(chunkType)) {
      kept.push(bytes.subarray(offset, offset + chunkTotal));
    } else {
      strippedMetadataBytes += chunkTotal;
    }

    offset += chunkTotal;
    if (chunkType === 'IEND') {
      sawIend = true;
      break;
    }
  }

  if (!sawIend) {
    throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'PNG stream missing IEND terminator.');
  }

  return {
    bytes: concatChunks(kept),
    mimeType: 'image/png',
    width,
    height,
    orientation: 1,
    strippedMetadataBytes,
  };
}

function stripWebpMetadata(bytes: Uint8Array): StrippedImageResult {
  if (bytes.byteLength < 12 || readAscii4(bytes, 0) !== 'RIFF' || readAscii4(bytes, 8) !== 'WEBP') {
    throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Malformed WebP RIFF container.');
  }

  const declaredRiffSize = readUint32LE(bytes, 4);
  const riffEnd = Math.min(bytes.byteLength, 8 + declaredRiffSize);
  if (riffEnd < 12) {
    throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Truncated WebP RIFF container.');
  }

  const keptChunks: Uint8Array[] = [];
  let offset = 12;
  let width: number | null = null;
  let height: number | null = null;
  let strippedMetadataBytes = 0;

  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) {
      throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Truncated WebP chunk header.');
    }
    const fourCC = readAscii4(bytes, offset);
    const payloadSize = readUint32LE(bytes, offset + 4);
    const paddedSize = payloadSize + (payloadSize % 2);
    const chunkEnd = offset + 8 + paddedSize;
    if (chunkEnd > bytes.byteLength) {
      throw new KinloomHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Truncated WebP chunk payload.');
    }

    if (fourCC === 'EXIF' || fourCC === 'XMP ') {
      strippedMetadataBytes += chunkEnd - offset;
      offset = chunkEnd;
      continue;
    }

    if (fourCC === 'VP8X' && payloadSize >= 10) {
      const vp8xCopy = bytes.slice(offset, chunkEnd);
      // Clear EXIF (bit 3 = 0x08) and XMP (bit 2 = 0x04) feature flags in VP8X.
      vp8xCopy[8] = dataViewOf(vp8xCopy).getUint8(8) & ~(0x08 | 0x04);
      width = readUint24LE(vp8xCopy, 12) + 1;
      height = readUint24LE(vp8xCopy, 15) + 1;
      keptChunks.push(vp8xCopy);
      offset = chunkEnd;
      continue;
    }

    if (
      width === null &&
      fourCC === 'VP8 ' &&
      payloadSize >= 10 &&
      bytes[offset + 11] === 0x9d &&
      bytes[offset + 12] === 0x01 &&
      bytes[offset + 13] === 0x2a
    ) {
      const parsedWidth = readUint16LE(bytes, offset + 14) & 0x3fff;
      const parsedHeight = readUint16LE(bytes, offset + 16) & 0x3fff;
      if (parsedWidth > 0 && parsedHeight > 0) {
        width = parsedWidth;
        height = parsedHeight;
      }
    } else if (width === null && fourCC === 'VP8L' && payloadSize >= 5 && bytes[offset + 8] === 0x2f) {
      const bits = readUint32LE(bytes, offset + 9);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }

    keptChunks.push(bytes.subarray(offset, chunkEnd));
    offset = chunkEnd;
  }

  let bodyLength = 4; // 'WEBP'
  for (const chunk of keptChunks) {
    bodyLength += chunk.byteLength;
  }
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  writeUint32LE(header, 4, bodyLength);
  header.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP

  return {
    bytes: concatChunks([header, ...keptChunks]),
    mimeType: 'image/webp',
    width,
    height,
    orientation: 1,
    strippedMetadataBytes,
  };
}

/**
 * Pure-TypeScript EXIF/XMP/IPTC metadata stripper for JPEG, PNG, and WebP images.
 * Runs with zero native bindings inside Cloudflare Workers and Node.js.
 */
export function stripImageMetadata(bytes: Uint8Array, mimeType: StrippableImageMime): StrippedImageResult {
  switch (mimeType) {
    case 'image/jpeg':
      return stripJpegMetadata(bytes);
    case 'image/png':
      return stripPngMetadata(bytes);
    case 'image/webp':
      return stripWebpMetadata(bytes);
  }
}
