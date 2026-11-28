import fs from 'node:fs';
import path from 'node:path';
import {
  getMediaPersonIds,
  MediaItemSchema,
  type RawEvent,
  type RawPerson,
  validateMediaForPrivacy,
} from '@kinloom/core';
import { sha256File } from './primitives.js';
import type { IntegrateExecutionOverlay, MediaLayout, PlannedScan, StagedScanReportItem } from './types.js';

export function detectMediaLayout(repoDir: string): MediaLayout {
  const archiveMediaRoot = path.join(repoDir, 'archive-media');
  if (fs.existsSync(archiveMediaRoot) && fs.statSync(archiveMediaRoot).isDirectory()) {
    // Archives with an `archive-media/` directory store `/media/scans/<file>` at
    // `archive-media/media/scans/<file>` so R2 uploads map directly to `media/scans/<file>`.
    return {
      layout: 'archive-media',
      mediaUrlRoot: archiveMediaRoot,
      scanDestDir: path.join(archiveMediaRoot, 'media', 'scans'),
      scanUrlPrefix: '/media/scans/',
      r2KeyPrefix: 'media/scans/',
    };
  }
  return {
    layout: 'media',
    mediaUrlRoot: repoDir,
    scanDestDir: path.join(repoDir, 'media'),
    scanUrlPrefix: '/media/',
    r2KeyPrefix: 'media/',
  };
}

function resolveMediaDiskPath(fileUrl: string, repoDir: string, mediaLayout: MediaLayout): string {
  if (!fileUrl.startsWith('/media/')) {
    throw new Error(`Media file URL must start with '/media/', got '${fileUrl}'.`);
  }
  const relPosix = fileUrl.slice(1);
  const parts = relPosix.split('/');
  if (parts.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error(`Unsafe media file URL '${fileUrl}'.`);
  }
  const diskPath = path.resolve(mediaLayout.mediaUrlRoot, ...parts);
  const publicMediaDir = path.resolve(repoDir, 'public', 'media');
  if (diskPath === publicMediaDir || diskPath.startsWith(`${publicMediaDir}${path.sep}`)) {
    throw new Error(`Media file URL '${fileUrl}' resolves inside forbidden public/media/.`);
  }
  const rootPrefix = `${path.resolve(mediaLayout.mediaUrlRoot)}${path.sep}`;
  if (!diskPath.startsWith(rootPrefix)) {
    throw new Error(`Media file URL '${fileUrl}' escapes media root.`);
  }
  return diskPath;
}

export function planScanStaging(
  repoDir: string,
  packageDir: string,
  mediaLayout: MediaLayout,
  virtualStagedScans?: ReadonlyMap<string, string>
): PlannedScan[] {
  const scansSourceDir = path.join(packageDir, 'scans');
  if (!fs.existsSync(scansSourceDir)) {
    return [];
  }
  const entries = fs
    .readdirSync(scansSourceDir, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const planned: PlannedScan[] = [];
  const publicDir = path.resolve(repoDir, 'public');

  for (const entry of entries) {
    if (entry.isDirectory()) {
      throw new Error(
        `Unexpected subdirectory '${entry.name}' inside ${scansSourceDir}. Place scan files directly in scans/.`
      );
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.includes('/') || entry.name.includes('\\') || entry.name === '..' || entry.name === '.') {
      throw new Error(`Unsafe scan filename '${entry.name}'.`);
    }
    const sourcePath = path.join(scansSourceDir, entry.name);
    const destPath = path.resolve(mediaLayout.scanDestDir, entry.name);
    if (destPath === publicDir || destPath.startsWith(`${publicDir}${path.sep}`)) {
      throw new Error(`Scan destination '${destPath}' must never target public/.`);
    }
    const { sizeBytes, sha256 } = sha256File(sourcePath);
    if (sizeBytes === 0) {
      throw new Error(`Scan file '${sourcePath}' is empty (0 bytes).`);
    }
    let alreadyIdentical = false;
    const virtualHash = virtualStagedScans?.get(destPath);
    if (virtualHash !== undefined) {
      alreadyIdentical = virtualHash === sha256;
    } else if (fs.existsSync(destPath)) {
      const existing = sha256File(destPath);
      alreadyIdentical = existing.sha256 === sha256;
    }
    planned.push({
      filename: entry.name,
      sourcePath,
      destPath,
      url: `${mediaLayout.scanUrlPrefix}${entry.name}`,
      r2Key: `${mediaLayout.r2KeyPrefix}${entry.name}`,
      sizeBytes,
      sha256,
      alreadyIdentical,
    });
  }

  return planned;
}

export interface ValidatePatchMediaInput {
  patchMedia: readonly unknown[];
  repoDir: string;
  packageDir: string;
  mediaLayout: MediaLayout;
  plannedScans: readonly PlannedScan[];
  peopleById: ReadonlyMap<string, RawPerson>;
  livingIds: ReadonlySet<string>;
  eventsById: ReadonlyMap<string, RawEvent>;
  sourceIds: ReadonlySet<string>;
  overlay?: IntegrateExecutionOverlay | undefined;
}

export function validatePatchMedia(input: ValidatePatchMediaInput): void {
  const {
    patchMedia,
    repoDir,
    packageDir,
    mediaLayout,
    plannedScans,
    peopleById,
    livingIds,
    eventsById,
    sourceIds,
    overlay,
  } = input;
  const stagedDestSet = new Set(plannedScans.map((s) => s.destPath));

  for (const rawMedia of patchMedia) {
    const item = MediaItemSchema.parse(rawMedia);
    const privacyCheck = validateMediaForPrivacy(item, livingIds, eventsById);
    if (!privacyCheck.ok) {
      throw new Error(`PRIVACY REFUSAL: ${privacyCheck.message}`);
    }
    for (const pid of getMediaPersonIds(item)) {
      if (!peopleById.has(pid)) {
        throw new Error(`Media '${item.id}' references missing person_id '${pid}'.`);
      }
    }
    if (item.event_id && !eventsById.has(item.event_id)) {
      throw new Error(`Media '${item.id}' references missing event_id '${item.event_id}'.`);
    }
    if (item.source_id && !sourceIds.has(item.source_id)) {
      throw new Error(`Media '${item.id}' references missing source_id '${item.source_id}'.`);
    }

    const expectedDiskPath = resolveMediaDiskPath(item.file, repoDir, mediaLayout);
    if (
      !fs.existsSync(expectedDiskPath) &&
      !stagedDestSet.has(expectedDiskPath) &&
      !overlay?.virtualStagedScans.has(expectedDiskPath)
    ) {
      throw new Error(
        `Missing scan file for media '${item.id}': '${item.file}' expected at '${expectedDiskPath}' (not on disk and not staged from ${path.join(packageDir, 'scans')}).`
      );
    }
  }
}

export function stagePlannedScans(
  plannedScans: readonly PlannedScan[],
  dryRun: boolean,
  overlay?: IntegrateExecutionOverlay
): StagedScanReportItem[] {
  const stagedScansReport: StagedScanReportItem[] = [];
  for (const scan of plannedScans) {
    let status: StagedScanReportItem['status'];
    if (dryRun) {
      status = scan.alreadyIdentical ? 'unchanged' : 'would_stage';
      if (overlay && !scan.alreadyIdentical) {
        overlay.virtualStagedScans.set(scan.destPath, scan.sha256);
      }
    } else if (scan.alreadyIdentical) {
      status = 'unchanged';
    } else {
      fs.mkdirSync(path.dirname(scan.destPath), { recursive: true });
      fs.copyFileSync(scan.sourcePath, scan.destPath);
      status = 'staged';
    }
    stagedScansReport.push({
      filename: scan.filename,
      sourcePath: scan.sourcePath,
      destPath: scan.destPath,
      url: scan.url,
      r2Key: scan.r2Key,
      status,
      sizeBytes: scan.sizeBytes,
      sha256: scan.sha256,
    });
  }
  return stagedScansReport;
}
