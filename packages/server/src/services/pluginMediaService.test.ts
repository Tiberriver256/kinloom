import type { MediaStore } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { InMemoryMediaStore } from '../adapters/inMemory.js';
import { readStreamToBytes, sha256Hex } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';
import { computeCrc32, stripImageMetadata } from './imageMetadataStripper.js';
import type { MediaUploadRejectionInfo } from './mediaService.js';
import { extensionForImageMime, PluginMediaService } from './pluginMediaService.js';

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function u16BE(v: number): Uint8Array {
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
}

function u16LE(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}

function u32BE(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function u32LE(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([0xff, marker]), u16BE(payload.byteLength + 2), payload);
}

function buildExifApp1(options: {
  readonly littleEndian: boolean;
  readonly orientation?: number;
  readonly gpsNote: string;
}): Uint8Array {
  const w16 = options.littleEndian ? u16LE : u16BE;
  const w32 = options.littleEndian ? u32LE : u32BE;
  const byteOrder = options.littleEndian ? ascii('II') : ascii('MM');
  const entries =
    options.orientation !== undefined
      ? concatBytes(
          w16(1), // 1 IFD0 entry
          w16(0x0112), // Orientation tag
          w16(3), // SHORT
          w32(1), // count 1
          w16(options.orientation),
          w16(0),
          w32(0) // next IFD offset
        )
      : concatBytes(w16(0), w32(0));
  const payload = concatBytes(
    ascii('Exif\0\0'),
    byteOrder,
    w16(0x002a),
    w32(8), // IFD0 immediately after 8-byte TIFF header
    entries,
    ascii(options.gpsNote)
  );
  return jpegSegment(0xe1, payload);
}

function buildSyntheticJpegWithMetadata(options: {
  readonly width: number;
  readonly height: number;
  readonly littleEndian?: boolean;
  readonly orientation?: number;
  readonly includeIcc?: boolean;
  readonly includeNonIccApp2?: boolean;
}): Uint8Array {
  const jfif = jpegSegment(0xe0, concatBytes(ascii('JFIF\0'), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0])));
  const exif = buildExifApp1({
    littleEndian: options.littleEndian ?? true,
    orientation: options.orientation ?? 6,
    gpsNote: 'GPS_LAT_40_7128_LON_74_0060_CAMERA_SECRET',
  });
  const xmp = jpegSegment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>XMP_SECRET</x:xmpmeta>'));
  const icc = options.includeIcc
    ? jpegSegment(0xe2, concatBytes(ascii('ICC_PROFILE\0'), new Uint8Array([1, 1, 0xaa, 0xbb])))
    : new Uint8Array(0);
  const nonIccApp2 = options.includeNonIccApp2
    ? jpegSegment(0xe2, ascii('FLASHPIX_SECRET_META'))
    : new Uint8Array(0);
  const iptc = jpegSegment(0xed, ascii('Photoshop 3.0\0IPTC_SECRET_BYLINE'));
  const adobe = jpegSegment(0xee, ascii('Adobe\0ADOBE_SECRET'));
  const comment = jpegSegment(0xfe, ascii('PRIVATE_CAMERA_COMMENT'));
  const sof0 = jpegSegment(
    0xc0,
    concatBytes(
      new Uint8Array([8]),
      u16BE(options.height),
      u16BE(options.width),
      new Uint8Array([1, 1, 0x11, 0])
    )
  );
  const rst0 = new Uint8Array([0xff, 0xd0]);
  const sos = concatBytes(
    jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])),
    new Uint8Array([0x12, 0x34, 0x56, 0xff, 0xd9])
  );
  return concatBytes(
    new Uint8Array([0xff, 0xd8]),
    jfif,
    exif,
    xmp,
    icc,
    nonIccApp2,
    iptc,
    adobe,
    comment,
    rst0,
    sof0,
    sos
  );
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = ascii(type);
  const body = concatBytes(typeBytes, data);
  const crc = computeCrc32(body);
  return concatBytes(u32BE(data.byteLength), body, u32BE(crc));
}

function buildSyntheticPngWithMetadata(width: number, height: number): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', concatBytes(u32BE(width), u32BE(height), new Uint8Array([8, 2, 0, 0, 0])));
  const srgb = pngChunk('sRGB', new Uint8Array([0]));
  const exif = pngChunk('eXIf', ascii('PNG_EXIF_GPS_COORDINATES'));
  const text = pngChunk('tEXt', ascii('Author\0PRIVATE_SCANNER_OPERATOR'));
  const time = pngChunk('tIME', new Uint8Array([0x07, 0xea, 11, 27, 12, 0, 0]));
  const idat = pngChunk('IDAT', new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]));
  const iend = pngChunk('IEND', new Uint8Array(0));
  return concatBytes(sig, ihdr, srgb, exif, text, time, idat, iend);
}

function riffChunk(fourCC: string, payload: Uint8Array): Uint8Array {
  const pad = payload.byteLength % 2 === 1 ? new Uint8Array([0]) : new Uint8Array(0);
  return concatBytes(ascii(fourCC), u32LE(payload.byteLength), payload, pad);
}

function buildWebpContainer(...chunks: readonly Uint8Array[]): Uint8Array {
  const body = concatBytes(ascii('WEBP'), ...chunks);
  return concatBytes(ascii('RIFF'), u32LE(body.byteLength), body);
}

function buildSyntheticWebpVp8xWithMetadata(width: number, height: number): Uint8Array {
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  const vp8xPayload = new Uint8Array([
    0x08 | 0x04 | 0x10, // EXIF + XMP + Alpha bits
    0,
    0,
    0,
    wMinus1 & 0xff,
    (wMinus1 >>> 8) & 0xff,
    (wMinus1 >>> 16) & 0xff,
    hMinus1 & 0xff,
    (hMinus1 >>> 8) & 0xff,
    (hMinus1 >>> 16) & 0xff,
  ]);
  const vp8Payload = new Uint8Array([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 100, 0, 80, 0, 0xaa]);
  const exifChunk = riffChunk('EXIF', ascii('WEBP_EXIF_GPS_SECRET'));
  const xmpChunk = riffChunk('XMP ', ascii('<x:xmpmeta>WEBP_XMP_SECRET</x:xmpmeta>'));
  return buildWebpContainer(
    riffChunk('VP8X', vp8xPayload),
    riffChunk('VP8 ', vp8Payload),
    exifChunk,
    xmpChunk
  );
}

describe('stripImageMetadata (pure-TS JPEG/PNG/WebP EXIF/XMP/IPTC scrubber)', () => {
  it('strips EXIF, GPS, XMP, IPTC, Adobe, and COM segments from JPEG while preserving orientation, dimensions, JFIF, and ICC', () => {
    const raw = buildSyntheticJpegWithMetadata({
      width: 640,
      height: 480,
      littleEndian: true,
      orientation: 6,
      includeIcc: true,
      includeNonIccApp2: true,
    });
    const stripped = stripImageMetadata(raw, 'image/jpeg');
    const text = new TextDecoder('latin1').decode(stripped.bytes);

    expect(stripped.width).toBe(640);
    expect(stripped.height).toBe(480);
    expect(stripped.orientation).toBe(6);
    expect(stripped.strippedMetadataBytes).toBeGreaterThan(0);
    expect(text).not.toContain('GPS_LAT_40_7128');
    expect(text).not.toContain('XMP_SECRET');
    expect(text).not.toContain('IPTC_SECRET');
    expect(text).not.toContain('ADOBE_SECRET');
    expect(text).not.toContain('PRIVATE_CAMERA_COMMENT');
    expect(text).not.toContain('FLASHPIX_SECRET_META');
    expect(text).toContain('JFIF');
    expect(text).toContain('ICC_PROFILE');

    // Big-endian (MM) TIFF EXIF orientation
    const rawBe = buildSyntheticJpegWithMetadata({
      width: 1200,
      height: 900,
      littleEndian: false,
      orientation: 3,
    });
    const strippedBe = stripImageMetadata(rawBe, 'image/jpeg');
    expect(strippedBe.orientation).toBe(3);
    expect(strippedBe.width).toBe(1200);
    expect(strippedBe.height).toBe(900);

    // Stripping an already-clean JPEG is idempotent (0 bytes removed)
    const secondPass = stripImageMetadata(stripped.bytes, 'image/jpeg');
    expect(secondPass.strippedMetadataBytes).toBe(0);
    expect(secondPass.bytes).toEqual(stripped.bytes);
  });

  it('handles JPEG EOI terminator and rejects malformed JPEG structures', () => {
    const minimalEoi = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd9]);
    const res = stripImageMetadata(minimalEoi, 'image/jpeg');
    expect(res.orientation).toBe(1);
    expect(res.width).toBeNull();
    expect(res.bytes).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));

    expect(() => stripImageMetadata(new Uint8Array([0x00, 0x00, 0x00, 0x00]), 'image/jpeg')).toThrow(
      KinloomHttpError
    );
    expect(() => stripImageMetadata(new Uint8Array([0xff, 0xd8, 0x00, 0x01]), 'image/jpeg')).toThrow(
      KinloomHttpError
    );
    expect(() => stripImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]), 'image/jpeg')).toThrow(
      KinloomHttpError
    );
    expect(() =>
      stripImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, 0x01]), 'image/jpeg')
    ).toThrow(KinloomHttpError);
  });

  it('strips eXIf, tEXt, and tIME chunks from PNG while preserving IHDR, sRGB, IDAT, and IEND', () => {
    const raw = buildSyntheticPngWithMetadata(320, 240);
    const stripped = stripImageMetadata(raw, 'image/png');
    const text = new TextDecoder('latin1').decode(stripped.bytes);

    expect(stripped.width).toBe(320);
    expect(stripped.height).toBe(240);
    expect(stripped.orientation).toBe(1);
    expect(stripped.strippedMetadataBytes).toBeGreaterThan(0);
    expect(text).not.toContain('PNG_EXIF_GPS_COORDINATES');
    expect(text).not.toContain('PRIVATE_SCANNER_OPERATOR');
    expect(text).toContain('IHDR');
    expect(text).toContain('sRGB');
    expect(text).toContain('IDAT');
    expect(text).toContain('IEND');

    const secondPass = stripImageMetadata(stripped.bytes, 'image/png');
    expect(secondPass.strippedMetadataBytes).toBe(0);
    expect(secondPass.bytes).toEqual(stripped.bytes);
  });

  it('rejects malformed or CRC-corrupt PNG payloads', () => {
    const valid = buildSyntheticPngWithMetadata(16, 16);
    const corruptCrc = valid.slice();
    corruptCrc[corruptCrc.byteLength - 1] ^= 0xff; // Flip bit in IEND CRC
    expect(() => stripImageMetadata(corruptCrc, 'image/png')).toThrow(/CRC verification/);

    expect(() => stripImageMetadata(new Uint8Array([0x01, 0x02, 0x03]), 'image/png')).toThrow(
      KinloomHttpError
    );
    expect(() => stripImageMetadata(valid.subarray(0, 14), 'image/png')).toThrow(KinloomHttpError);
    expect(() => stripImageMetadata(valid.subarray(0, 22), 'image/png')).toThrow(KinloomHttpError);
    // Missing IEND
    const noIend = valid.subarray(0, valid.byteLength - 12);
    expect(() => stripImageMetadata(noIend, 'image/png')).toThrow(/IEND/);
  });

  it('strips EXIF and XMP chunks from WebP, clears VP8X flags, updates RIFF length, and parses VP8/VP8L dimensions', () => {
    const rawVp8x = buildSyntheticWebpVp8xWithMetadata(800, 600);
    const stripped = stripImageMetadata(rawVp8x, 'image/webp');
    const text = new TextDecoder('latin1').decode(stripped.bytes);

    expect(stripped.width).toBe(800);
    expect(stripped.height).toBe(600);
    expect(stripped.orientation).toBe(1);
    expect(stripped.strippedMetadataBytes).toBeGreaterThan(0);
    expect(text).not.toContain('WEBP_EXIF_GPS_SECRET');
    expect(text).not.toContain('WEBP_XMP_SECRET');
    // VP8X flags byte is at offset 12 (RIFF header) + 8 (VP8X header) = 20
    expect(stripped.bytes[20] & (0x08 | 0x04)).toBe(0);
    expect(stripped.bytes[20] & 0x10).toBe(0x10); // Alpha bit preserved
    // RIFF header declared size matches actual buffer size - 8
    const riffSize =
      (stripped.bytes[4] |
        (stripped.bytes[5] << 8) |
        (stripped.bytes[6] << 16) |
        (stripped.bytes[7] << 24)) >>>
      0;
    expect(riffSize).toBe(stripped.bytes.byteLength - 8);

    // Simple lossy VP8 frame
    const vp8Only = buildWebpContainer(
      riffChunk('VP8 ', new Uint8Array([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]))
    );
    const vp8Res = stripImageMetadata(vp8Only, 'image/webp');
    expect(vp8Res.width).toBe(320);
    expect(vp8Res.height).toBe(240);

    // Lossless VP8L frame (width=200 -> 199, height=150 -> 149)
    const packed = ((199 & 0x3fff) | ((149 & 0x3fff) << 14)) >>> 0;
    const vp8lOnly = buildWebpContainer(
      riffChunk('VP8L', concatBytes(new Uint8Array([0x2f]), u32LE(packed)))
    );
    const vp8lRes = stripImageMetadata(vp8lOnly, 'image/webp');
    expect(vp8lRes.width).toBe(200);
    expect(vp8lRes.height).toBe(150);

    // Malformed WebP errors
    expect(() => stripImageMetadata(ascii('NOT_WEBP_DATA'), 'image/webp')).toThrow(KinloomHttpError);
    expect(() =>
      stripImageMetadata(concatBytes(ascii('RIFF'), u32LE(2), ascii('WEBP')), 'image/webp')
    ).toThrow(KinloomHttpError);
    expect(() =>
      stripImageMetadata(concatBytes(ascii('RIFF'), u32LE(8), ascii('WEBP'), ascii('VP8')), 'image/webp')
    ).toThrow(KinloomHttpError);
    expect(() =>
      stripImageMetadata(
        concatBytes(ascii('RIFF'), u32LE(40), ascii('WEBP'), ascii('VP8 '), u32LE(999)),
        'image/webp'
      )
    ).toThrow(KinloomHttpError);
  });
});

describe('PluginMediaService', () => {
  it('stores EXIF-stripped images under namespaced keys, serves with safe headers and 304 ETag, and deletes cleanly', async () => {
    const mediaStore = new InMemoryMediaStore();
    const service = new PluginMediaService({
      mediaStore,
      namespace: 'recipes',
      maxBytes: 1024 * 1024,
    });

    const rawJpeg = buildSyntheticJpegWithMetadata({ width: 500, height: 375, orientation: 6 });
    const stored = await service.storeImage({
      bytes: rawJpeg,
      contentType: 'image/jpeg; charset=binary',
      resourceId: 'rec_1',
      assetId: 'pho_1',
    });

    expect(stored.key).toBe('plugins/recipes/rec_1/pho_1.jpg');
    expect(stored.mimeType).toBe('image/jpeg');
    expect(stored.ext).toBe('jpg');
    expect(stored.width).toBe(500);
    expect(stored.height).toBe(375);
    expect(stored.orientation).toBe(6);
    expect(stored.strippedMetadataBytes).toBeGreaterThan(0);
    expect(extensionForImageMime('image/png')).toBe('png');
    expect(extensionForImageMime('image/webp')).toBe('webp');

    const rawBlob = await mediaStore.get(stored.key);
    expect(rawBlob).not.toBeNull();
    const persistedBytes = await readStreamToBytes(rawBlob!.body);
    expect(await sha256Hex(persistedBytes)).toBe(stored.sha256);
    expect(new TextDecoder('latin1').decode(persistedBytes)).not.toContain('GPS_LAT_40_7128');

    const served = await service.serveImageResponse({
      key: stored.key,
      expectedMimeType: 'image/jpeg',
      sha256: stored.sha256,
      downloadFilename: 'recipe-card-pho_1.jpg',
    });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect(served.headers.get('content-disposition')).toBe('inline; filename="recipe-card-pho_1.jpg"');
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(served.headers.get('etag')).toBe(`"${stored.sha256}"`);

    const notModified = await service.serveImageResponse({
      key: stored.key,
      expectedMimeType: 'image/jpeg',
      sha256: stored.sha256,
      downloadFilename: '../bad/name.jpg',
      ifNoneMatch: `"${stored.sha256}"`,
    });
    expect(notModified.status).toBe(304);

    // Delete cleans up blob from InMemoryMediaStore
    await service.deleteObject(stored.key);
    expect((await mediaStore.head(stored.key)).exists).toBe(false);
    await expect(
      service.serveImageResponse({
        key: stored.key,
        expectedMimeType: 'image/jpeg',
        sha256: stored.sha256,
        downloadFilename: 'recipe-card-pho_1.jpg',
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects empty, oversized, disallowed MIME, spoofed magic bytes, corrupt containers, and traversal keys with rejection callbacks', async () => {
    const mediaStore = new InMemoryMediaStore();
    const rejections: MediaUploadRejectionInfo[] = [];
    const service = new PluginMediaService({
      mediaStore,
      namespace: 'recipes',
      maxBytes: 256,
      onUploadRejected: (info) => {
        rejections.push(info);
      },
    });

    await expect(
      service.storeImage({
        bytes: new Uint8Array(0),
        contentType: 'image/jpeg',
        resourceId: 'rec_1',
        assetId: 'pho_empty',
      })
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });

    await expect(
      service.storeImage({
        bytes: new Uint8Array(300).fill(0xff),
        contentType: 'image/jpeg',
        resourceId: 'rec_1',
        assetId: 'pho_big',
      })
    ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });

    await expect(
      service.storeImage({
        bytes: ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        contentType: 'image/svg+xml',
        resourceId: 'rec_1',
        assetId: 'pho_svg',
      })
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });

    await expect(
      service.storeImage({
        bytes: ascii('<html><script>alert(1)</script></html>'),
        contentType: 'image/jpeg',
        resourceId: 'rec_1',
        assetId: 'pho_spoof',
      })
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });

    // Valid PNG magic header followed by corrupt bytes -> rejected during structural parse
    await expect(
      service.storeImage({
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
        contentType: 'image/png',
        resourceId: 'rec_1',
        assetId: 'pho_corrupt_png',
      })
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });

    expect(rejections.map((r) => r.reason)).toEqual([
      'empty_file',
      'file_too_large',
      'unsupported_media_type',
      'magic_bytes_mismatch',
      'magic_bytes_mismatch',
    ]);

    // Path traversal / invalid key guards
    expect(() => service.buildObjectKey('../escape', 'pho_1', 'jpg')).toThrow(KinloomHttpError);
    expect(service.isScopedKey('plugins/other/rec_1/pho_1.jpg')).toBe(false);
    expect(service.isScopedKey('plugins/recipes/rec_1/sub/pho_1.jpg')).toBe(false);
    expect(service.isScopedKey('plugins/recipes/../pho_1.jpg')).toBe(false);
    await expect(
      service.serveImageResponse({
        key: 'media/other.jpg',
        expectedMimeType: 'image/jpeg',
        sha256: 'a'.repeat(64),
        downloadFilename: 'other.jpg',
      })
    ).rejects.toMatchObject({ status: 404 });

    // Best-effort delete handles missing delete method and throwing delete cleanly
    const throwingStore: MediaStore = {
      head: mediaStore.head.bind(mediaStore),
      put: mediaStore.put.bind(mediaStore),
      get: mediaStore.get.bind(mediaStore),
      delete: async () => {
        throw new Error('transient R2 error');
      },
    };
    const throwingService = new PluginMediaService({ mediaStore: throwingStore, namespace: 'recipes' });
    await expect(throwingService.deleteObject('plugins/recipes/rec_1/pho_1.jpg')).resolves.toBeUndefined();
    await expect(throwingService.deleteObject('media/not-scoped.jpg')).resolves.toBeUndefined();
  });
});
