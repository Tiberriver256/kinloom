import fs from 'node:fs';
import path from 'node:path';
import {
  type AuditedScanFile,
  type InspectedImageHeader,
  isPlainRecord,
  type LooseRecord,
  type ScansCheckResult,
} from './types.js';

const MIN_SCAN_WARN_BYTES = 10 * 1024;
const MAX_SCAN_WARN_BYTES = 10 * 1024 * 1024;

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
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
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

export function runScanInventoryCheck(
  repoDir: string,
  packageDir: string,
  patch: LooseRecord
): ScansCheckResult {
  const scansDir = path.join(packageDir, 'scans');
  const archiveMediaRoot = path.join(repoDir, 'archive-media');
  const hasArchiveMedia = fs.existsSync(archiveMediaRoot) && fs.statSync(archiveMediaRoot).isDirectory();
  const mediaRoot = hasArchiveMedia ? archiveMediaRoot : repoDir;

  const errors: string[] = [];
  const warnings: string[] = [];
  const files: AuditedScanFile[] = [];
  const checkedPaths = new Set<string>();

  const inspectFile = (
    diskPath: string,
    mediaId: string | null,
    fileUrl: string | null,
    source: AuditedScanFile['source']
  ): void => {
    const resolved = path.resolve(diskPath);
    if (checkedPaths.has(resolved)) {
      return;
    }
    checkedPaths.add(resolved);
    if (!fs.existsSync(resolved)) {
      errors.push(`Missing scan file for ${mediaId ?? 'scans/'}: ${fileUrl ?? resolved}`);
      return;
    }
    const stat = fs.statSync(resolved);
    if (stat.size === 0) {
      errors.push(`Empty (0 byte) scan file: ${resolved}`);
      return;
    }
    const fd = fs.openSync(resolved, 'r');
    const readLen = Math.min(stat.size, 65_536);
    const buf = Buffer.allocUnsafe(readLen);
    try {
      fs.readSync(fd, buf, 0, readLen, 0);
    } finally {
      fs.closeSync(fd);
    }
    const info = inspectImageBuffer(buf);
    if (!info.valid) {
      errors.push(`Invalid image file (${info.error}): ${resolved}`);
    }
    if (stat.size < MIN_SCAN_WARN_BYTES) {
      warnings.push(`Tiny scan (< 10 KB, ${stat.size} bytes): ${path.basename(resolved)}`);
    } else if (stat.size > MAX_SCAN_WARN_BYTES) {
      warnings.push(
        `Huge scan (> 10 MB, ${(stat.size / (1024 * 1024)).toFixed(1)} MB): ${path.basename(resolved)}`
      );
    }
    files.push({
      media_id: mediaId,
      file: fileUrl ?? path.basename(resolved),
      disk_path: resolved,
      source,
      format: info.format,
      width: info.width,
      height: info.height,
      bytes: stat.size,
      kb: Number((stat.size / 1024).toFixed(1)),
      valid: info.valid,
    });
  };

  const referencedBasenames = new Set<string>();
  for (const rawItem of Array.isArray(patch.media) ? patch.media : []) {
    const item = isPlainRecord(rawItem) ? rawItem : {};
    const mediaId = typeof item.id === 'string' ? item.id : null;
    const fileUrl = typeof item.file === 'string' ? item.file : null;
    if (!fileUrl) {
      errors.push(`Media entry '${mediaId ?? 'unknown'}' missing 'file' field.`);
      continue;
    }
    const base = path.basename(fileUrl);
    referencedBasenames.add(base);
    const stagedCandidate = path.join(scansDir, base);
    const repoCandidate = path.resolve(mediaRoot, ...fileUrl.replace(/^\/+/, '').split('/'));
    if (fs.existsSync(stagedCandidate)) {
      inspectFile(stagedCandidate, mediaId, fileUrl, 'package_scans');
    } else if (fs.existsSync(repoCandidate)) {
      inspectFile(repoCandidate, mediaId, fileUrl, 'repo_media');
    } else {
      errors.push(
        `Missing scan for media '${mediaId ?? 'unknown'}': '${fileUrl}' not found in scans/ or repo media.`
      );
    }
  }

  const unreferencedScans: string[] = [];
  if (fs.existsSync(scansDir) && fs.statSync(scansDir).isDirectory()) {
    const entries = fs
      .readdirSync(scansDir, { withFileTypes: true })
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        errors.push(`Forbidden subdirectory inside scans/: ${entry.name}`);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fullPath = path.join(scansDir, entry.name);
      if (!referencedBasenames.has(entry.name)) {
        unreferencedScans.push(entry.name);
        warnings.push(`Unreferenced file in scans/: ${entry.name}`);
        inspectFile(fullPath, null, entry.name, 'unreferenced_scan');
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedCount: files.length,
    unreferencedScans,
    files,
    errors,
    warnings,
  };
}
