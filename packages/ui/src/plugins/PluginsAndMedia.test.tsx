/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, MediaItem } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { MediaPlayer } from '../components/MediaPlayer.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { KinloomApp } from '../KinloomApp.js';
import type { KinloomUiPlugin } from './types.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Plugin Test Archive',
    familyName: 'Test Family',
    gedcomSourceName: 'PLUGIN_TEST',
  },
});

const { bundle: testBundle }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig,
  mode: 'public',
  people: [
    {
      id: 'p_ada',
      slug: 'ada-lovelace',
      full_name: 'Ada Lovelace',
      given_name: 'Ada',
      surname: 'Lovelace',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1815-12-10',
      death_edtf: '1852-11-27',
      portrait_url: null,
    },
  ],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

describe('KinloomUiPlugin seam and MediaPlayer', () => {
  it('mounts custom plugin routes, nav links, and indexHero slot cleanly', async () => {
    const CustomStoryPage = () => <main data-testid="custom-story">Interactive Video Essay</main>;
    const storyPlugin: KinloomUiPlugin = {
      id: 'story-plugin',
      name: 'Story Plugin',
      routes: [
        {
          path: '/stories/essay',
          navLabel: 'Stories',
          component: CustomStoryPage,
        },
      ],
      slots: {
        indexHero: ({ siteConfig: cfg }) => (
          <section data-testid="hero-slot">Featured Story for {cfg.site.familyName}</section>
        ),
      },
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    // 1. Index renders plugin nav link + indexHero slot
    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={siteConfig}
          initialBundle={testBundle}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[storyPlugin]}
          initialEntries={['/']}
        />
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.querySelector('[data-testid="hero-slot"]')?.textContent).toBe(
      'Featured Story for Test Family'
    );
    const navLinks = [...container.querySelectorAll('.nav-links a')].map((a) => a.textContent);
    expect(navLinks).toContain('Stories');

    // 2. Navigating directly to custom plugin route renders CustomStoryPage
    await act(async () => {
      root.render(
        <KinloomApp
          key="story-route"
          siteConfig={siteConfig}
          initialBundle={testBundle}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[storyPlugin]}
          initialEntries={['/stories/essay']}
        />
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.querySelector('[data-testid="custom-story"]')?.textContent).toBe(
      'Interactive Video Essay'
    );

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders native HTML5 video with poster & captions, audio, and allows plugin mediaRenderer override', async () => {
    const videoMedia: MediaItem = {
      id: 'med_vid_1',
      kind: 'video_story',
      file: '/media/story.mp4',
      caption: 'Homestead Oral Story',
      mime_type: 'video/mp4',
      duration_seconds: 125,
      poster_url: '/media/story-poster.jpg',
      transcript_url: '/media/story.vtt',
    };
    const audioMedia: MediaItem = {
      id: 'med_aud_1',
      kind: 'audio_oral_history',
      file: '/media/interview.mp3',
      caption: 'Oral History Recording',
      mime_type: 'audio/mpeg',
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle}>
          <MediaPlayer media={videoMedia} variant="full" />
          <MediaPlayer media={audioMedia} variant="full" />
        </ArchiveProvider>
      );
    });

    const videoEl = container.querySelector('video');
    expect(videoEl).not.toBeNull();
    expect(videoEl?.getAttribute('poster')).toBe('/media/story-poster.jpg');
    expect(videoEl?.querySelector('track[kind="captions"]')?.getAttribute('src')).toBe('/media/story.vtt');
    expect(container.querySelector('audio')).not.toBeNull();

    // Custom plugin mediaRenderer takes precedence over native video player
    const customPlayerPlugin: KinloomUiPlugin = {
      id: 'custom-player',
      name: 'Custom Video Player',
      mediaRenderers: [
        {
          match: (m) => m.kind === 'video_story',
          render: ({ media, src }) => (
            <div data-testid="custom-video-player">
              Custom Player: {media.caption} ({src})
            </div>
          ),
        },
      ],
    };

    await act(async () => {
      root.render(
        <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle} plugins={[customPlayerPlugin]}>
          <MediaPlayer media={videoMedia} variant="full" />
        </ArchiveProvider>
      );
    });

    expect(container.querySelector('[data-testid="custom-video-player"]')?.textContent).toBe(
      'Custom Player: Homestead Oral Story (/media/story.mp4)'
    );
    expect(container.querySelector('video')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
