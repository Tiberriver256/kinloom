export interface InspectedImageHeader {
  valid: boolean;
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'unknown';
  width: number | null;
  height: number | null;
  error: string | null;
}

export function inspectImageBuffer(buf: Buffer): InspectedImageHeader {
  if (buf.length < 12) {
    return { valid: false, format: 'unknown', width: null, height: null, error: 'file too short' };
  }

  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    if (buf.length < 24) {
      return { valid: false, format: 'png', width: null, height: null, error: 'truncated PNG IHDR' };
    }
    return {
      valid: true,
      format: 'png',
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      error: null,
    };
  }

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let offset = 2;
    while (offset + 4 < buf.length) {
      while (offset < buf.length && buf[offset] !== 0xff) {
        offset += 1;
      }
      while (offset < buf.length && buf[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= buf.length) {
        break;
      }
      const marker = buf[offset];
      if (marker === undefined) continue;
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 2 > buf.length) {
        break;
      }
      const segLen = buf.readUInt16BE(offset);
      if (segLen < 2 || offset + segLen > buf.length) {
        break;
      }
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && segLen >= 7) {
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        return { valid: true, format: 'jpeg', width, height, error: null };
      }
      offset += segLen;
    }
    return { valid: true, format: 'jpeg', width: null, height: null, error: null };
  }

  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + ((buf[24] ?? 0) | ((buf[25] ?? 0) << 8) | ((buf[26] ?? 0) << 16));
      const height = 1 + ((buf[27] ?? 0) | ((buf[28] ?? 0) << 8) | ((buf[29] ?? 0) << 16));
      return { valid: true, format: 'webp', width, height, error: null };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { valid: true, format: 'webp', width, height, error: null };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { valid: true, format: 'webp', width, height, error: null };
    }
    return { valid: true, format: 'webp', width: null, height: null, error: null };
  }

  const sig6 = buf.subarray(0, 6).toString('ascii');
  if ((sig6 === 'GIF87a' || sig6 === 'GIF89a') && buf.length >= 10) {
    return {
      valid: true,
      format: 'gif',
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
      error: null,
    };
  }

  return {
    valid: false,
    format: 'unknown',
    width: null,
    height: null,
    error: 'unrecognized image magic header',
  };
}
