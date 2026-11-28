import fs from 'node:fs';
import path from 'node:path';
import { fastLocaleCompare, type MediaItem, parseMediaYaml } from '@kinloom/core';

export interface LiveMediaFileCollision {
  file: string;
  live_media_id: string;
  staged: Array<{ person_id: string; media_id: string; file: string }>;
}

export interface StagedMediaRef {
  id: string;
  file: string;
  normalizedFile: string;
}

export interface StagedMediaPackage {
  personId: string;
  media: readonly StagedMediaRef[];
}

export interface DuplicateNormalizedMediaFile {
  file: string;
  mediaIds: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeMediaFilePath(file: string): string {
  const trimmed = file.trim();
  if (!trimmed) {
    return '';
  }
  if (
    !trimmed.includes('\\') &&
    !trimmed.includes('//') &&
    !trimmed.includes('/.') &&
    !trimmed.startsWith('.') &&
    !trimmed.endsWith('/')
  ) {
    return trimmed.charCodeAt(0) === 47 ? trimmed.slice(1) : trimmed;
  }
  const parts = trimmed
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  return parts.join('/');
}

export function findDuplicateNormalizedMediaFiles(
  mediaItems: readonly Pick<MediaItem, 'id' | 'file'>[]
): DuplicateNormalizedMediaFile[] {
  const seenSingle = new Map<string, string>();
  const multi = new Map<string, string[]>();

  for (let i = 0; i < mediaItems.length; i += 1) {
    const item = mediaItems[i];
    const normalized = normalizeMediaFilePath(item.file);
    if (!normalized) {
      continue;
    }
    const existingList = multi.get(normalized);
    if (existingList) {
      existingList.push(item.id);
      continue;
    }
    const firstId = seenSingle.get(normalized);
    if (firstId === undefined) {
      seenSingle.set(normalized, item.id);
    } else if (firstId !== item.id) {
      multi.set(normalized, [firstId, item.id]);
    }
  }

  if (multi.size === 0) {
    return [];
  }

  const duplicates: DuplicateNormalizedMediaFile[] = [];
  for (const [file, ids] of multi) {
    const mediaIds = [...new Set(ids)].toSorted(fastLocaleCompare);
    if (mediaIds.length > 1) {
      duplicates.push({ file, mediaIds });
    }
  }
  duplicates.sort((a, b) => fastLocaleCompare(a.file, b.file));
  return duplicates;
}

export function readStagedMediaRefs(rawMedia: unknown): StagedMediaRef[] {
  const media: StagedMediaRef[] = [];
  for (const rawItem of Array.isArray(rawMedia) ? rawMedia : []) {
    if (!isPlainRecord(rawItem) || typeof rawItem['id'] !== 'string' || typeof rawItem['file'] !== 'string') {
      continue;
    }
    const id = rawItem['id'].trim();
    const file = rawItem['file'].trim();
    if (!id || !file) {
      continue;
    }
    media.push({ id, file, normalizedFile: normalizeMediaFilePath(file) });
  }
  return media;
}

export function loadLiveMedia(repoDir: string): Array<{ id: string; file: string }> {
  const mediaPath = path.join(repoDir, 'data', 'media.yaml');
  let rawText: string;
  try {
    rawText = fs.readFileSync(mediaPath, 'utf8');
  } catch {
    return [];
  }
  return parseMediaYaml(rawText).map((item) => ({
    id: item.id,
    file: item.file,
  }));
}

export function collectLiveMediaCollisions(
  packages: readonly StagedMediaPackage[],
  liveMedia: readonly { id: string; file: string }[]
): LiveMediaFileCollision[] {
  const hasAnyStagedMedia = packages.some((pkg) => pkg.media.length > 0);
  if (!hasAnyStagedMedia || liveMedia.length === 0) {
    return [];
  }

  const liveByFile = new Map<string, string[]>();
  for (const item of liveMedia) {
    const normalized = normalizeMediaFilePath(item.file);
    if (!normalized) {
      continue;
    }
    let ids = liveByFile.get(normalized);
    if (!ids) {
      ids = [];
      liveByFile.set(normalized, ids);
    }
    ids.push(item.id);
  }

  const grouped = new Map<string, LiveMediaFileCollision>();
  for (const staged of packages) {
    for (const item of staged.media) {
      const liveIds = liveByFile.get(item.normalizedFile);
      if (!liveIds) {
        continue;
      }
      for (const liveId of liveIds) {
        if (liveId === item.id) {
          continue;
        }
        const key = `${item.normalizedFile}\0${liveId}`;
        let existing = grouped.get(key);
        if (!existing) {
          existing = {
            file: item.normalizedFile,
            live_media_id: liveId,
            staged: [],
          };
          grouped.set(key, existing);
        }
        existing.staged.push({
          person_id: staged.personId,
          media_id: item.id,
          file: item.file,
        });
      }
    }
  }

  if (grouped.size === 0) {
    return [];
  }

  return [...grouped.values()]
    .map((collision) => ({
      ...collision,
      staged: collision.staged.toSorted(
        (a, b) => fastLocaleCompare(a.person_id, b.person_id) || fastLocaleCompare(a.media_id, b.media_id)
      ),
    }))
    .toSorted(
      (a, b) => fastLocaleCompare(a.file, b.file) || fastLocaleCompare(a.live_media_id, b.live_media_id)
    );
}
