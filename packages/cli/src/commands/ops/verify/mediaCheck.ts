import fs from 'node:fs';
import path from 'node:path';
import type { MediaItem } from '@kinloom/core';
import { findDuplicateNormalizedMediaFiles } from '../shared/mediaFiles.js';
import type { VerifyMediaResult, VerifyMissingMediaFile } from './types.js';

export { findDuplicateNormalizedMediaFiles };

export function verifyMediaFilesOnDisk(repoDir: string, mediaItems: readonly MediaItem[]): VerifyMediaResult {
  const archiveMediaRoot = path.join(repoDir, 'archive-media');
  const hasArchiveMedia = fs.existsSync(archiveMediaRoot) && fs.statSync(archiveMediaRoot).isDirectory();
  const mediaLayout: 'archive-media' | 'media' = hasArchiveMedia ? 'archive-media' : 'media';
  const mediaRoot = hasArchiveMedia ? archiveMediaRoot : repoDir;
  const publicMediaDir = path.resolve(repoDir, 'public', 'media');
  const rootPrefix = `${path.resolve(mediaRoot)}${path.sep}`;

  const missingFiles: VerifyMissingMediaFile[] = [];
  let checkedCount = 0;

  for (const item of mediaItems) {
    const fileUrl = item.file.trim();
    if (/^https?:\/\//i.test(fileUrl)) {
      continue;
    }
    checkedCount += 1;

    if (!fileUrl.startsWith('/media/')) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath: fileUrl,
        reason: "media file path must start with '/media/'",
      });
      continue;
    }

    const parts = fileUrl.slice(1).split('/');
    if (parts.some((seg) => !seg || seg === '.' || seg === '..')) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath: fileUrl,
        reason: 'unsafe path traversal segment',
      });
      continue;
    }

    const expectedPath = path.resolve(mediaRoot, ...parts);
    if (expectedPath === publicMediaDir || expectedPath.startsWith(`${publicMediaDir}${path.sep}`)) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'resolves inside forbidden public/media/',
      });
      continue;
    }
    if (!expectedPath.startsWith(rootPrefix)) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'escapes media root',
      });
      continue;
    }
    if (!fs.existsSync(expectedPath)) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'file not found on disk',
      });
      continue;
    }
    const stat = fs.statSync(expectedPath);
    if (!stat.isFile()) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'path is not a regular file',
      });
      continue;
    }
    if (stat.size === 0) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'file is empty (0 bytes)',
      });
    }
  }

  const duplicateFiles = findDuplicateNormalizedMediaFiles(mediaItems);
  return {
    ok: missingFiles.length === 0 && duplicateFiles.length === 0,
    mediaLayout,
    checkedCount,
    missingFiles,
    duplicateFiles,
  };
}
