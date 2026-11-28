import fs from 'node:fs';
import path from 'node:path';
import { inspectImageBuffer } from '../shared/imageHeader.js';
import { type AuditedScanFile, isPlainRecord, type LooseRecord, type ScansCheckResult } from './types.js';

export { inspectImageBuffer };

const MIN_SCAN_WARN_BYTES = 10 * 1024;
const MAX_SCAN_WARN_BYTES = 10 * 1024 * 1024;

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
    let fd: number;
    try {
      fd = fs.openSync(resolved, 'r');
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
        errors.push(`Missing scan file for ${mediaId ?? 'scans/'}: ${fileUrl ?? resolved}`);
        return;
      }
      throw err;
    }
    let stat: fs.Stats;
    let buf: Buffer;
    try {
      stat = fs.fstatSync(fd);
      if (stat.size === 0) {
        errors.push(`Empty (0 byte) scan file: ${resolved}`);
        return;
      }
      const readLen = Math.min(stat.size, 65_536);
      buf = Buffer.allocUnsafe(readLen);
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
  for (const rawItem of Array.isArray(patch['media']) ? patch['media'] : []) {
    const item = isPlainRecord(rawItem) ? rawItem : {};
    const mediaId = typeof item['id'] === 'string' ? item['id'] : null;
    const fileUrl = typeof item['file'] === 'string' ? item['file'] : null;
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
