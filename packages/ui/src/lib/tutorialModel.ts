import type { KinloomTutorialChapter, KinloomTutorialStep, OnboardingRole } from '@kinloom/core';
import type { CompiledKinloomTutorialChapter } from '../plugins/validatePlugins.js';

const ROLE_RANK: Readonly<Record<OnboardingRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

const CHAPTER_ID_ALIASES: Readonly<Record<string, string>> = {
  'core-getting-started': 'core-navigation-search',
};

export interface ResolvedTutorialCatalog {
  readonly role: OnboardingRole;
  readonly coreChapters: readonly CompiledKinloomTutorialChapter[];
  readonly pluginChapters: readonly CompiledKinloomTutorialChapter[];
  readonly chapters: readonly CompiledKinloomTutorialChapter[];
  readonly completedCount: number;
  readonly totalCount: number;
  readonly firstIncompleteChapterId: string | null;
}

export type TutorialMediaDisplayMode =
  | {
      readonly kind: 'video';
      readonly mp4Url?: string;
      readonly webmUrl?: string;
      readonly posterUrl?: string;
      readonly posterAlt: string;
      readonly captionsVttUrl?: string;
      readonly durationSeconds?: number;
    }
  | {
      readonly kind: 'static-slide';
      readonly posterUrl: string;
      readonly posterAlt: string;
      readonly reason: 'reduced-motion' | 'video-error' | 'no-video';
    }
  | {
      readonly kind: 'card-only';
    };

export function resolveTutorialChapterIdAlias(chapterId: string | null | undefined): string | null {
  if (!chapterId) {
    return null;
  }
  const trimmed = chapterId.trim();
  if (!trimmed) {
    return null;
  }
  return CHAPTER_ID_ALIASES[trimmed] ?? trimmed;
}

export function isChapterVisibleForRole(
  chapter: Pick<KinloomTutorialChapter, 'minRole' | 'roles'>,
  role: OnboardingRole
): boolean {
  if (chapter.roles && chapter.roles.length > 0) {
    return chapter.roles.includes(role);
  }
  const minRole = chapter.minRole ?? 'viewer';
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export function resolveTutorialCatalog(params: {
  readonly role: OnboardingRole;
  readonly coreChapters: readonly CompiledKinloomTutorialChapter[];
  readonly pluginChapters: readonly CompiledKinloomTutorialChapter[];
  readonly completedChapterIds: readonly string[];
}): ResolvedTutorialCatalog {
  const { role, coreChapters, pluginChapters, completedChapterIds } = params;
  const visibleCore = coreChapters.filter((chapter) => isChapterVisibleForRole(chapter, role));
  const visiblePlugin = pluginChapters.filter((chapter) => isChapterVisibleForRole(chapter, role));
  const chapters = [...visibleCore, ...visiblePlugin];
  const completedSet = new Set(completedChapterIds);

  let completedCount = 0;
  let firstIncompleteChapterId: string | null = null;
  for (const chapter of chapters) {
    if (completedSet.has(chapter.id)) {
      completedCount += 1;
    } else if (firstIncompleteChapterId === null) {
      firstIncompleteChapterId = chapter.id;
    }
  }

  return {
    role,
    coreChapters: visibleCore,
    pluginChapters: visiblePlugin,
    chapters,
    completedCount,
    totalCount: chapters.length,
    firstIncompleteChapterId,
  };
}

export function resolveInitialTutorialChapterId(
  catalog: ResolvedTutorialCatalog,
  requestedChapterId?: string | null
): string | null {
  if (catalog.chapters.length === 0) {
    return null;
  }
  const canonicalRequested = resolveTutorialChapterIdAlias(requestedChapterId);
  if (canonicalRequested && catalog.chapters.some((chapter) => chapter.id === canonicalRequested)) {
    return canonicalRequested;
  }
  return catalog.firstIncompleteChapterId ?? catalog.chapters[0]?.id ?? null;
}

export function resolveTutorialAssetUrl(
  rawUrl: string | undefined,
  mediaBaseUrl: string | undefined,
  baseUrl: string
): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return undefined;
  }
  const preferredBase = mediaBaseUrl?.trim() || baseUrl.trim() || '/';
  if (preferredBase === '/') {
    return trimmed;
  }
  const normalizedBase = preferredBase.replace(/\/+$/, '');
  if (trimmed.startsWith(`${normalizedBase}/`)) {
    return trimmed;
  }
  return `${normalizedBase}${trimmed}`;
}

export function resolveTutorialMediaMode(params: {
  readonly step: KinloomTutorialStep;
  readonly reducedMotion: boolean;
  readonly videoFailed: boolean;
  readonly mediaBaseUrl?: string | undefined;
  readonly baseUrl: string;
}): TutorialMediaDisplayMode {
  const { step, reducedMotion, videoFailed, mediaBaseUrl, baseUrl } = params;
  const media = step.media;
  if (!media) {
    return { kind: 'card-only' };
  }

  const mp4Url = resolveTutorialAssetUrl(media.videoMp4Url, mediaBaseUrl, baseUrl);
  const webmUrl = resolveTutorialAssetUrl(media.videoWebmUrl, mediaBaseUrl, baseUrl);
  const posterUrl = resolveTutorialAssetUrl(media.posterUrl, mediaBaseUrl, baseUrl);
  const captionsVttUrl = resolveTutorialAssetUrl(media.captionsVttUrl, mediaBaseUrl, baseUrl);
  const hasVideoSource = Boolean(mp4Url || webmUrl);

  if (hasVideoSource && !reducedMotion && !videoFailed) {
    return {
      kind: 'video',
      ...(mp4Url ? { mp4Url } : {}),
      ...(webmUrl ? { webmUrl } : {}),
      ...(posterUrl ? { posterUrl } : {}),
      posterAlt: media.posterAlt,
      ...(captionsVttUrl ? { captionsVttUrl } : {}),
      ...(media.durationSeconds !== undefined ? { durationSeconds: media.durationSeconds } : {}),
    };
  }

  if (posterUrl) {
    return {
      kind: 'static-slide',
      posterUrl,
      posterAlt: media.posterAlt,
      reason: videoFailed ? 'video-error' : reducedMotion && hasVideoSource ? 'reduced-motion' : 'no-video',
    };
  }

  return { kind: 'card-only' };
}

export function formatTutorialDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const rounded = Math.round(seconds);
  if (rounded < 60) {
    return `${rounded}s`;
  }
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}

export function readTutorialQueryParam(search: string): string | null {
  if (!search) {
    return null;
  }
  const params = new URLSearchParams(search);
  const raw = params.get('tutorial');
  return resolveTutorialChapterIdAlias(raw);
}

export function stripTutorialQueryParam(search: string): string {
  if (!search) {
    return '';
  }
  const params = new URLSearchParams(search);
  if (!params.has('tutorial')) {
    return search;
  }
  params.delete('tutorial');
  const next = params.toString();
  return next ? `?${next}` : '';
}
