import { type ArchiveBundle, compileArchive, parseKinloomConfig } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import type { CompiledKinloomTutorialChapter } from '../plugins/validatePlugins.js';
import { buildCoreTutorialChapters, CORE_TUTORIAL_CHAPTERS } from './coreTutorialChapters.js';
import {
  formatTutorialDuration,
  isChapterVisibleForRole,
  readTutorialQueryParam,
  resolveInitialTutorialChapterId,
  resolveTutorialAssetUrl,
  resolveTutorialCatalog,
  resolveTutorialChapterIdAlias,
  resolveTutorialMediaMode,
  stripTutorialQueryParam,
} from './tutorialModel.js';

const SITE_CONFIG = parseKinloomConfig({
  site: {
    title: 'Synthetic Tutorial Model Archive',
    familyName: 'Synthetic Family',
    gedcomSourceName: 'TUTORIAL_MODEL_TEST',
  },
});

const SEEDED_BUNDLE: ArchiveBundle = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  people: [
    {
      id: 'p_abraham',
      slug: 'abraham-lincoln-1809',
      full_name: 'Abraham Lincoln',
      given_name: 'Abraham',
      surname: 'Lincoln',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1809-02-12',
      death_edtf: '1865-04-15',
      portrait_url: null,
    },
  ],
  places: [],
  events: [],
  sources: [],
  kinship: [],
}).bundle;

describe('coreTutorialChapters and tutorialModel pure logic', () => {
  it('defines all 6 core chapters matching #54 IDs and hydrates Person Profile route from loaded bundle', () => {
    expect(CORE_TUTORIAL_CHAPTERS.map((c) => c.id)).toEqual([
      'core-navigation-search',
      'core-person-dossier',
      'core-tree-pedigree',
      'core-map-timeline',
      'core-editing-records',
      'core-admin-settings',
    ]);
    expect(CORE_TUTORIAL_CHAPTERS.every((c) => c.source === 'core')).toBe(true);

    const hydrated = buildCoreTutorialChapters(SEEDED_BUNDLE);
    const dossier = hydrated.find((c) => c.id === 'core-person-dossier');
    expect(dossier?.steps[0]?.targetRoute).toBe('/person/abraham-lincoln-1809');
    expect(dossier?.steps[0]?.targetRouteLabel).toBe('Open Abraham Lincoln');

    expect(buildCoreTutorialChapters(null)).toBe(CORE_TUTORIAL_CHAPTERS);
  });

  it('filters chapters by hierarchical minRole and exact roles overrides', () => {
    expect(isChapterVisibleForRole({ minRole: 'viewer' }, 'viewer')).toBe(true);
    expect(isChapterVisibleForRole({ minRole: 'editor' }, 'viewer')).toBe(false);
    expect(isChapterVisibleForRole({ minRole: 'editor' }, 'editor')).toBe(true);
    expect(isChapterVisibleForRole({ minRole: 'editor' }, 'admin')).toBe(true);
    expect(isChapterVisibleForRole({ minRole: 'admin', roles: ['admin'] }, 'editor')).toBe(false);
    expect(isChapterVisibleForRole({ minRole: 'admin', roles: ['admin'] }, 'admin')).toBe(true);
    expect(isChapterVisibleForRole({ minRole: 'viewer', roles: ['viewer'] }, 'admin')).toBe(false);
  });

  it('resolves role-filtered tutorial catalogs, completion counts, aliases, and initial selection', () => {
    const pluginChapter: CompiledKinloomTutorialChapter = {
      id: 'kinloom-recipes:overview',
      title: 'Heirloom Recipes',
      summary: 'Browse family recipes.',
      minRole: 'viewer',
      order: 200,
      source: 'plugin',
      pluginId: 'kinloom-recipes',
      pluginName: 'Family Recipes',
      steps: [
        {
          id: 'browse-recipes',
          title: 'Browse recipes',
          instructions: 'Open the Recipes page.',
          transcript: 'Open Recipes from the top bar.',
          targetRoute: '/recipes',
        },
      ],
    };

    const viewerCatalog = resolveTutorialCatalog({
      role: 'viewer',
      coreChapters: CORE_TUTORIAL_CHAPTERS,
      pluginChapters: [pluginChapter],
      completedChapterIds: ['core-navigation-search'],
    });
    expect(viewerCatalog.coreChapters.map((c) => c.id)).toEqual([
      'core-navigation-search',
      'core-person-dossier',
      'core-tree-pedigree',
      'core-map-timeline',
    ]);
    expect(viewerCatalog.pluginChapters.map((c) => c.id)).toEqual(['kinloom-recipes:overview']);
    expect(viewerCatalog.completedCount).toBe(1);
    expect(viewerCatalog.totalCount).toBe(5);
    expect(viewerCatalog.firstIncompleteChapterId).toBe('core-person-dossier');

    expect(resolveTutorialChapterIdAlias('core-getting-started')).toBe('core-navigation-search');
    expect(resolveTutorialChapterIdAlias('  ')).toBeNull();
    expect(resolveTutorialChapterIdAlias(undefined)).toBeNull();

    expect(resolveInitialTutorialChapterId(viewerCatalog, 'core-getting-started')).toBe(
      'core-navigation-search'
    );
    expect(resolveInitialTutorialChapterId(viewerCatalog, 'core-admin-settings')).toBe('core-person-dossier');
    expect(resolveInitialTutorialChapterId(viewerCatalog)).toBe('core-person-dossier');

    const allDoneCatalog = resolveTutorialCatalog({
      role: 'viewer',
      coreChapters: CORE_TUTORIAL_CHAPTERS,
      pluginChapters: [],
      completedChapterIds: [
        'core-navigation-search',
        'core-person-dossier',
        'core-tree-pedigree',
        'core-map-timeline',
      ],
    });
    expect(allDoneCatalog.firstIncompleteChapterId).toBeNull();
    expect(resolveInitialTutorialChapterId(allDoneCatalog)).toBe('core-navigation-search');

    const emptyCatalog = resolveTutorialCatalog({
      role: 'viewer',
      coreChapters: [],
      pluginChapters: [],
      completedChapterIds: [],
    });
    expect(resolveInitialTutorialChapterId(emptyCatalog)).toBeNull();
  });

  it('resolves tutorial asset URLs and graceful zero-CDN media fallback modes', () => {
    expect(resolveTutorialAssetUrl(undefined, undefined, '/')).toBeUndefined();
    expect(resolveTutorialAssetUrl('   ', undefined, '/')).toBeUndefined();
    expect(resolveTutorialAssetUrl('//evil.example/a.mp4', undefined, '/')).toBeUndefined();
    expect(resolveTutorialAssetUrl('https://archive.example.test/t/v.mp4', '/media', '/')).toBe(
      'https://archive.example.test/t/v.mp4'
    );
    expect(resolveTutorialAssetUrl('/tutorials/a.mp4', undefined, '/')).toBe('/tutorials/a.mp4');
    expect(resolveTutorialAssetUrl('/tutorials/a.mp4', '/media', '/')).toBe('/media/tutorials/a.mp4');
    expect(resolveTutorialAssetUrl('/media/tutorials/a.mp4', '/media', '/')).toBe('/media/tutorials/a.mp4');

    const baseStep = CORE_TUTORIAL_CHAPTERS[2].steps[0];
    expect(
      resolveTutorialMediaMode({
        step: baseStep,
        reducedMotion: false,
        videoFailed: false,
        baseUrl: '/',
      })
    ).toEqual({ kind: 'card-only' });

    const stepWithMedia = {
      ...baseStep,
      media: {
        videoMp4Url: '/tutorials/tree.mp4',
        videoWebmUrl: '/tutorials/tree.webm',
        posterUrl: '/tutorials/tree.png',
        posterAlt: 'Family Tree preview',
        captionsVttUrl: '/tutorials/tree.vtt',
        durationSeconds: 30,
      },
    };

    expect(
      resolveTutorialMediaMode({
        step: stepWithMedia,
        reducedMotion: false,
        videoFailed: false,
        mediaBaseUrl: '/assets',
        baseUrl: '/',
      })
    ).toEqual({
      kind: 'video',
      mp4Url: '/assets/tutorials/tree.mp4',
      webmUrl: '/assets/tutorials/tree.webm',
      posterUrl: '/assets/tutorials/tree.png',
      posterAlt: 'Family Tree preview',
      captionsVttUrl: '/assets/tutorials/tree.vtt',
      durationSeconds: 30,
    });

    expect(
      resolveTutorialMediaMode({
        step: stepWithMedia,
        reducedMotion: true,
        videoFailed: false,
        baseUrl: '/',
      })
    ).toEqual({
      kind: 'static-slide',
      posterUrl: '/tutorials/tree.png',
      posterAlt: 'Family Tree preview',
      reason: 'reduced-motion',
    });

    expect(
      resolveTutorialMediaMode({
        step: stepWithMedia,
        reducedMotion: false,
        videoFailed: true,
        baseUrl: '/',
      })
    ).toEqual({
      kind: 'static-slide',
      posterUrl: '/tutorials/tree.png',
      posterAlt: 'Family Tree preview',
      reason: 'video-error',
    });

    expect(
      resolveTutorialMediaMode({
        step: {
          ...baseStep,
          media: { posterUrl: '/tutorials/only-poster.png', posterAlt: 'Static poster' },
        },
        reducedMotion: false,
        videoFailed: false,
        baseUrl: '/',
      })
    ).toEqual({
      kind: 'static-slide',
      posterUrl: '/tutorials/only-poster.png',
      posterAlt: 'Static poster',
      reason: 'no-video',
    });

    expect(
      resolveTutorialMediaMode({
        step: {
          ...baseStep,
          media: { videoMp4Url: '/tutorials/no-poster.mp4', posterAlt: 'No poster fallback' },
        },
        reducedMotion: false,
        videoFailed: true,
        baseUrl: '/',
      })
    ).toEqual({ kind: 'card-only' });
  });

  it('formats durations and reads/strips tutorial query params without disturbing other params', () => {
    expect(formatTutorialDuration(undefined)).toBeNull();
    expect(formatTutorialDuration(0)).toBeNull();
    expect(formatTutorialDuration(45)).toBe('45s');
    expect(formatTutorialDuration(60)).toBe('1m');
    expect(formatTutorialDuration(85)).toBe('1m 25s');

    expect(readTutorialQueryParam('')).toBeNull();
    expect(readTutorialQueryParam('?tab=citations')).toBeNull();
    expect(readTutorialQueryParam('?tutorial=core-tree-pedigree')).toBe('core-tree-pedigree');
    expect(readTutorialQueryParam('?tutorial=core-getting-started&view=az')).toBe('core-navigation-search');

    expect(stripTutorialQueryParam('')).toBe('');
    expect(stripTutorialQueryParam('?view=az')).toBe('?view=az');
    expect(stripTutorialQueryParam('?tutorial=core-tree-pedigree')).toBe('');
    expect(stripTutorialQueryParam('?view=az&tutorial=core-tree-pedigree&branch=lincoln')).toBe(
      '?view=az&branch=lincoln'
    );
  });
});
