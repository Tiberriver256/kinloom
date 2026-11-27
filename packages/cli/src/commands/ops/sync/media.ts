import fs from 'node:fs';
import path from 'node:path';
import type { KinloomSiteConfig, Pronunciation } from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import {
  isPlainRecord,
  type MediaUploadTarget,
  runWithConcurrency,
  type SanitizedLocalEntry,
  type SyncExecutionContext,
} from './types.js';

export interface PronunciationMediaSources {
  readonly siteConfig?: Pick<KinloomSiteConfig, 'pronunciations'>;
  readonly people?: readonly SanitizedLocalEntry[];
  readonly places?: readonly SanitizedLocalEntry[];
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const MEDIA_PROBE_CONCURRENCY = 12;
const PRONUNCIATION_MEDIA_PREFIX = '/media/pronunciation-';

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function collectPronunciationEntryAudioUrls(entry: Pronunciation | null | undefined, out: string[]): void {
  if (!entry) {
    return;
  }
  if (typeof entry.audio_url === 'string' && entry.audio_url.trim()) {
    out.push(entry.audio_url.trim());
  }
  if (Array.isArray(entry.variants)) {
    for (const variant of entry.variants) {
      if (typeof variant.audio_url === 'string' && variant.audio_url.trim()) {
        out.push(variant.audio_url.trim());
      }
    }
  }
}

function extractEntityPronunciation(data: unknown): Pronunciation | null {
  if (!isPlainRecord(data) || !isPlainRecord(data.pronunciation)) {
    return null;
  }
  return data.pronunciation as Pronunciation;
}

function resolvePronunciationLocalPath(
  repoDir: string,
  mediaLayout: 'archive-media' | 'media',
  r2Key: string
): string | null {
  // Check <repo>/media/ before <repo>/archive-media/media/ because `pronounce synth` defaults to ./media/.
  const directPath = path.join(repoDir, r2Key);
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  if (mediaLayout === 'archive-media') {
    const archivePath = path.join(repoDir, 'archive-media', r2Key);
    if (fs.existsSync(archivePath)) {
      return archivePath;
    }
  }
  return null;
}

export function detectSyncMediaLayout(repoDir: string): 'archive-media' | 'media' {
  const archiveMediaDir = path.join(repoDir, 'archive-media');
  if (fs.existsSync(archiveMediaDir) && fs.statSync(archiveMediaDir).isDirectory()) {
    return 'archive-media';
  }
  return 'media';
}

export function resolveMediaUploadTarget(
  repoDir: string,
  mediaLayout: 'archive-media' | 'media',
  rawInput: string
): MediaUploadTarget {
  const mediaRoot = mediaLayout === 'archive-media' ? path.join(repoDir, 'archive-media') : repoDir;

  let localPath: string;
  let r2Key: string;

  if (rawInput.startsWith('/media/') || rawInput.startsWith('media/')) {
    const cleanRel = rawInput.replace(/^\/+/, '');
    const preferredPath = cleanRel.startsWith('media/pronunciation-')
      ? (resolvePronunciationLocalPath(repoDir, mediaLayout, cleanRel) ?? path.join(mediaRoot, cleanRel))
      : path.join(mediaRoot, cleanRel);
    localPath = preferredPath;
    r2Key = cleanRel;
  } else {
    localPath = path.isAbsolute(rawInput) ? path.resolve(rawInput) : path.resolve(repoDir, rawInput);
    const relFromArchiveMedia = path.relative(path.join(repoDir, 'archive-media'), localPath);
    const relFromRepo = path.relative(repoDir, localPath);

    if (mediaLayout === 'archive-media' && !relFromArchiveMedia.startsWith('..')) {
      r2Key = relFromArchiveMedia.split(path.sep).join('/');
    } else if (!relFromRepo.startsWith('..') && relFromRepo.startsWith(`media${path.sep}`)) {
      r2Key = relFromRepo.split(path.sep).join('/');
    } else {
      const base = path.basename(localPath);
      r2Key = mediaLayout === 'archive-media' ? `media/scans/${base}` : `media/${base}`;
    }
  }

  if (!fs.existsSync(localPath)) {
    throw new CliValidationError(`Media file not found on disk: ${localPath} (from '${rawInput}').`);
  }

  return {
    localPath,
    r2Key,
    contentType: guessMimeType(localPath),
  };
}

export async function findMissingRemoteMedia(
  ctx: SyncExecutionContext,
  writeToken: string,
  mediaEntries: readonly SanitizedLocalEntry[],
  pronunciationSources?: PronunciationMediaSources
): Promise<{ checkedCount: number; missing: MediaUploadTarget[] }> {
  const mediaRoot =
    ctx.mediaLayout === 'archive-media' ? path.join(ctx.repoDir, 'archive-media') : ctx.repoDir;

  const candidates: Array<MediaUploadTarget & { url: string }> = [];
  const seenKeys = new Set<string>();
  for (const entry of mediaEntries) {
    const fileUrl = typeof entry.data.file === 'string' ? entry.data.file.trim() : '';
    if (!fileUrl.startsWith('/media/')) {
      continue;
    }
    const r2Key = fileUrl.replace(/^\/+/, '');
    if (seenKeys.has(r2Key)) {
      continue;
    }
    seenKeys.add(r2Key);
    const localPath = path.join(mediaRoot, r2Key);
    if (!fs.existsSync(localPath)) {
      continue;
    }
    const mime =
      typeof entry.data.mime_type === 'string' && entry.data.mime_type.trim()
        ? entry.data.mime_type.trim()
        : guessMimeType(localPath);
    candidates.push({
      localPath,
      r2Key,
      contentType: mime,
      url: `${ctx.bindings.baseUrl}/${r2Key}`,
    });
  }

  if (pronunciationSources) {
    const rawAudioUrls: string[] = [];
    for (const entry of Object.values(pronunciationSources.siteConfig?.pronunciations ?? {})) {
      collectPronunciationEntryAudioUrls(entry, rawAudioUrls);
    }
    for (const personEntry of pronunciationSources.people ?? []) {
      if (personEntry.isLiving) {
        continue;
      }
      if (isPlainRecord(personEntry.data) && personEntry.data.full_name === 'Living') {
        continue;
      }
      collectPronunciationEntryAudioUrls(extractEntityPronunciation(personEntry.data), rawAudioUrls);
    }
    for (const placeEntry of pronunciationSources.places ?? []) {
      collectPronunciationEntryAudioUrls(extractEntityPronunciation(placeEntry.data), rawAudioUrls);
    }

    for (const audioUrl of rawAudioUrls) {
      if (!audioUrl.startsWith(PRONUNCIATION_MEDIA_PREFIX)) {
        continue;
      }
      const r2Key = audioUrl.replace(/^\/+/, '');
      if (r2Key.includes('..') || seenKeys.has(r2Key)) {
        continue;
      }
      const localPath = resolvePronunciationLocalPath(ctx.repoDir, ctx.mediaLayout, r2Key);
      if (!localPath) {
        continue;
      }
      seenKeys.add(r2Key);
      candidates.push({
        localPath,
        r2Key,
        contentType: guessMimeType(localPath),
        url: `${ctx.bindings.baseUrl}/${r2Key}`,
      });
    }
  }

  const probeResults = await runWithConcurrency(candidates, MEDIA_PROBE_CONCURRENCY, async (cand) => {
    const resp = await ctx.fetchImpl(cand.url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${writeToken}`,
        Range: 'bytes=0-0',
      },
    });
    await resp.body?.cancel().catch(() => undefined);
    return {
      localPath: cand.localPath,
      r2Key: cand.r2Key,
      contentType: cand.contentType,
      existsRemote: resp.status === 200 || resp.status === 206,
    };
  });

  return {
    checkedCount: candidates.length,
    missing: probeResults
      .filter((r) => !r.existsRemote)
      .map(({ localPath, r2Key, contentType }) => ({ localPath, r2Key, contentType })),
  };
}

export async function uploadMediaTargets(
  ctx: SyncExecutionContext,
  targets: readonly MediaUploadTarget[],
  concurrency: number
): Promise<string[]> {
  if (targets.length === 0) {
    return [];
  }
  return runWithConcurrency(targets, concurrency, async (target) => {
    await ctx.execWrangler(
      ctx.wranglerBin,
      [
        'r2',
        'object',
        'put',
        `${ctx.bindings.r2Bucket}/${target.r2Key}`,
        '--file',
        target.localPath,
        '--content-type',
        target.contentType,
        '--remote',
        '--config',
        ctx.bindings.configPath,
      ],
      {
        cwd: ctx.repoDir,
        maxBufferBytes: 8 * 1024 * 1024,
        timeoutMs: 60_000,
      }
    );
    return target.r2Key;
  });
}
