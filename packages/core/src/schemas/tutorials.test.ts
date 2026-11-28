import { describe, expect, it } from 'vitest';
import { parseKinloomConfig } from './config.js';
import {
  isSafeTutorialMediaUrl,
  isSafeTutorialRoute,
  KinloomTutorialChapterSchema,
  KinloomTutorialStepSchema,
  SiteTutorialsConfigSchema,
  TutorialCaptionCueSchema,
  TutorialMediaManifestSchema,
  TutorialStepMediaSchema,
} from './tutorials.js';

describe('@kinloom/core tutorial schemas and URL validators', () => {
  it('validates safe tutorial routes and media URLs while blocking unsafe schemes', () => {
    expect(isSafeTutorialRoute('/')).toBe(true);
    expect(isSafeTutorialRoute('/person/abraham-lincoln-1809')).toBe(true);
    expect(isSafeTutorialRoute('/evidence?tab=citations')).toBe(true);
    expect(isSafeTutorialRoute('/admin#invites')).toBe(true);

    expect(isSafeTutorialRoute('//evil.example/tree')).toBe(false);
    expect(isSafeTutorialRoute('https://evil.example/tree')).toBe(false);
    expect(isSafeTutorialRoute('javascript:alert(1)')).toBe(false);
    expect(isSafeTutorialRoute('/javascript:alert(1)')).toBe(false);
    expect(isSafeTutorialRoute('/bad\\path')).toBe(false);
    expect(isSafeTutorialRoute('/bad\u0000path')).toBe(false);
    expect(isSafeTutorialRoute('tree')).toBe(false);

    expect(isSafeTutorialMediaUrl('/tutorials/core-tree.mp4')).toBe(true);
    expect(isSafeTutorialMediaUrl('https://archive.example.test/tutorials/core-tree.mp4')).toBe(true);

    expect(isSafeTutorialMediaUrl('http://insecure.example.test/video.mp4')).toBe(false);
    expect(isSafeTutorialMediaUrl('//cdn.example.test/video.mp4')).toBe(false);
    expect(isSafeTutorialMediaUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeTutorialMediaUrl('/javascript:alert(1)')).toBe(false);
    expect(isSafeTutorialMediaUrl('data:video/mp4;base64,AAAA')).toBe(false);
    expect(isSafeTutorialMediaUrl('blob:https://archive.example.test/123')).toBe(false);
    expect(isSafeTutorialMediaUrl('/media\\evil.mp4')).toBe(false);
    expect(isSafeTutorialMediaUrl('/media\u0000.mp4')).toBe(false);
  });

  it('validates caption cues and enforces endSeconds > startSeconds', () => {
    const validCue = TutorialCaptionCueSchema.parse({
      startSeconds: 0,
      endSeconds: 4.2,
      text: 'Open Family Tree in the top bar.',
    });
    expect(validCue.endSeconds).toBe(4.2);

    expect(() =>
      TutorialCaptionCueSchema.parse({
        startSeconds: 5,
        endSeconds: 5,
        text: 'Zero-length cue.',
      })
    ).toThrow(/greater than startSeconds/);

    expect(() =>
      TutorialCaptionCueSchema.parse({
        startSeconds: 6,
        endSeconds: 3,
        text: 'Inverted cue.',
      })
    ).toThrow(/greater than startSeconds/);
  });

  it('validates tutorial step media, step schema, and chapter defaults and uniqueness', () => {
    const media = TutorialStepMediaSchema.parse({
      videoMp4Url: '/tutorials/core-tree-pedigree/tree-chart-and-list.mp4',
      videoWebmUrl: 'https://archive.example.test/tutorials/tree-chart-and-list.webm',
      posterUrl: '/tutorials/core-tree-pedigree/tree-chart-and-list.png',
      posterAlt: 'Family Tree page displaying Chart and List view controls.',
      captionsVttUrl: '/tutorials/core-tree-pedigree/tree-chart-and-list.vtt',
      durationSeconds: 28,
    });
    expect(media.durationSeconds).toBe(28);

    const step = KinloomTutorialStepSchema.parse({
      id: 'tree-chart-and-list',
      title: 'Switch between Chart View and List View',
      instructions: 'Toggle between the pan-and-zoom pedigree chart and the generation list.',
      transcript: 'Open Family Tree in the top bar and switch between Chart View and List View.',
      targetRoute: '/tree',
      targetRouteLabel: 'Open Family Tree',
      highlights: ['Pan and zoom in Chart View', 'Read generation cards in List View'],
      media,
    });
    expect(step.id).toBe('tree-chart-and-list');

    const chapter = KinloomTutorialChapterSchema.parse({
      id: 'core-tree-pedigree',
      title: 'Exploring the Family Tree',
      summary: 'Learn how to switch views, filter branches, and inspect focused relatives.',
      steps: [step],
    });
    expect(chapter.minRole).toBe('viewer');
    expect(chapter.order).toBe(200);

    expect(() =>
      KinloomTutorialChapterSchema.parse({
        id: 'core-dup-steps',
        title: 'Duplicate Step IDs',
        summary: 'Should fail unique step check.',
        steps: [step, { ...step }],
      })
    ).toThrow(/Step IDs within a tutorial chapter must be unique/);

    expect(() =>
      KinloomTutorialChapterSchema.parse({
        id: 'INVALID UPPERCASE ID',
        title: 'Bad ID',
        summary: 'Bad ID format.',
        steps: [step],
      })
    ).toThrow();
  });

  it('validates tutorial media manifest and optional siteConfig.tutorials', () => {
    const manifest = TutorialMediaManifestSchema.parse({
      schemaVersion: 1,
      generatedAt: '2026-11-28T00:00:00.000Z',
      ttsModel: 'gemini-3.8-flash-tts',
      voice: 'Charon',
      chapters: {
        'core-tree-pedigree': {
          durationSeconds: 56,
          steps: {
            'tree-chart-and-list': {
              videoMp4Url: '/tutorials/core-tree-pedigree/tree-chart-and-list.mp4',
              posterUrl: '/tutorials/core-tree-pedigree/tree-chart-and-list.png',
              posterAlt: 'Family Tree chart and list switcher.',
              captionsVttUrl: '/tutorials/core-tree-pedigree/tree-chart-and-list.vtt',
              durationSeconds: 28,
            },
          },
        },
      },
    });
    expect(manifest.chapters['core-tree-pedigree']?.durationSeconds).toBe(56);

    const tutorialsCfg = SiteTutorialsConfigSchema.parse({
      mediaBaseUrl: '/media/tutorials',
    });
    expect(tutorialsCfg.mediaBaseUrl).toBe('/media/tutorials');

    const siteConfig = parseKinloomConfig({
      site: {
        title: 'Lincoln & Todd Demo Archive',
        familyName: 'Lincoln & Todd',
        gedcomSourceName: 'LINCOLN_TODD_DEMO',
      },
      tutorials: {
        mediaBaseUrl: 'https://archive.example.test/tutorials',
      },
    });
    expect(siteConfig.tutorials?.mediaBaseUrl).toBe('https://archive.example.test/tutorials');
  });
});
