import fs from 'node:fs';
import path from 'node:path';
import { type MediaItem, parseMediaYaml } from '@kinloom/core';

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
  const parts = file
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  return parts.join('/');
}

export function findDuplicateNormalizedMediaFiles(
  mediaItems: readonly Pick<MediaItem, 'id' | 'file'>[]
): DuplicateNormalizedMediaFile[] {
  const grouped = new Map<string, string[]>();
  for (const item of mediaItems) {
    const normalized = normalizeMediaFilePath(item.file);
    if (!normalized) {
      continue;
    }
    const ids = grouped.get(normalized) ?? [];
    ids.push(item.id);
    grouped.set(normalized, ids);
  }

  const duplicates: DuplicateNormalizedMediaFile[] = [];
  for (const [file, ids] of grouped) {
    const mediaIds = [...new Set(ids)].toSorted((a, b) => a.localeCompare(b));
    if (mediaIds.length > 1) {
      duplicates.push({ file, mediaIds });
    }
  }
  duplicates.sort((a, b) => a.file.localeCompare(b.file));
  return duplicates;
}

export function readStagedMediaRefs(rawMedia: unknown): StagedMediaRef[] {
  const media: StagedMediaRef[] = [];
  for (const rawItem of Array.isArray(rawMedia) ? rawMedia : []) {
    if (!isPlainRecord(rawItem) || typeof rawItem.id !== 'string' || typeof rawItem.file !== 'string') {
      continue;
    }
    const id = rawItem.id.trim();
    const file = rawItem.file.trim();
    if (!id || !file) {
      continue;
    }
    media.push({ id, file, normalizedFile: normalizeMediaFilePath(file) });
  }
  return media;
}

export function loadLiveMedia(repoDir: string): Array<{ id: string; file: string }> {
  const mediaPath = path.join(repoDir, 'data', 'media.yaml');
  if (!fs.existsSync(mediaPath)) {
    return [];
  }
  return parseMediaYaml(fs.readFileSync(mediaPath, 'utf8')).map((item) => ({
    id: item.id,
    file: item.file,
  }));
}

export function collectLiveMediaCollisions(
  packages: readonly StagedMediaPackage[],
  liveMedia: readonly { id: string; file: string }[]
): LiveMediaFileCollision[] {
  const liveByFile = new Map<string, string[]>();
  for (const item of liveMedia) {
    const normalized = normalizeMediaFilePath(item.file);
    if (!normalized) {
      continue;
    }
    const ids = liveByFile.get(normalized) ?? [];
    ids.push(item.id);
    liveByFile.set(normalized, ids);
  }

  const grouped = new Map<string, LiveMediaFileCollision>();
  for (const staged of packages) {
    for (const item of staged.media) {
      const liveIds = liveByFile.get(item.normalizedFile) ?? [];
      for (const liveId of liveIds) {
        if (liveId === item.id) {
          continue;
        }
        const key = `${item.normalizedFile}\0${liveId}`;
        const existing = grouped.get(key) ?? {
          file: item.normalizedFile,
          live_media_id: liveId,
          staged: [],
        };
        existing.staged.push({
          person_id: staged.personId,
          media_id: item.id,
          file: item.file,
        });
        grouped.set(key, existing);
      }
    }
  }

  return [...grouped.values()]
    .map((collision) => ({
      ...collision,
      staged: collision.staged.toSorted(
        (a, b) => a.person_id.localeCompare(b.person_id) || a.media_id.localeCompare(b.media_id)
      ),
    }))
    .toSorted((a, b) => a.file.localeCompare(b.file) || a.live_media_id.localeCompare(b.live_media_id));
}
