/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  DocumentaryStory,
  KinloomSiteConfig,
  MapStory,
  ScrollStory,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpStoriesClient,
  createStaticStoriesClient,
  type StoriesClient,
} from '../adapters/storiesClient.js';
import { KinloomApp } from '../KinloomApp.js';
import {
  clampBeatIndex,
  filterStorySummaries,
  formatStoryDurationLabel,
  formatStoryFormatLabel,
  projectMapStops,
  resolveActiveWordIndex,
  resolveDocumentaryBeatAtTime,
} from '../lib/storiesModel.js';
import { useStoriesPlugin } from './stories/StoriesContext.js';
import { createStoriesUiPlugin, STORIES_UI_PLUGIN_ID, storiesUiPlugin } from './storiesPlugin.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

async function waitForCondition(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for UI condition.`);
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Family Archive',
    familyName: 'Archive Example',
    gedcomSourceName: 'STORIES_UI_TEST',
  },
});

const { bundle: TEST_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  people: [
    {
      id: 'person-ada',
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
    {
      id: 'person-empty',
      slug: 'charles-babbage',
      full_name: 'Charles Babbage',
      given_name: 'Charles',
      surname: 'Babbage',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'direct_ancestor',
      birth_edtf: '1791-12-26',
      death_edtf: '1871-10-18',
      portrait_url: null,
    },
    {
      id: 'person-living',
      slug: 'living-descendant',
      full_name: 'Living',
      given_name: 'Living',
      surname: '',
      alt_names: [],
      sex: 'U',
      is_living: true,
      lineage_group: 'descendant',
      birth_edtf: '',
      death_edtf: '',
      portrait_url: null,
    },
  ],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

const DOC_STORY: DocumentaryStory = {
  schemaVersion: 1,
  id: 'story-doc-1',
  slug: 'ada-engine-film',
  personId: 'person-ada',
  personName: 'Ada Lovelace',
  title: 'The Analytical Engine',
  summary: 'Timed visual documentary of the 1843 notes.',
  format: 'documentary',
  aspectRatio: '16:9',
  citations: [
    {
      id: 'c1',
      label: 'Scientific Memoirs (1843)',
      url: 'https://archive.example/memoirs',
      detail: 'Note G',
    },
  ],
  beats: [
    {
      id: 'b1',
      title: 'Opening Scene',
      startMs: 0,
      durationMs: 4000,
      dateLabel: '1843',
      placeLabel: 'London',
      narration: 'Ada Lovelace authored the first published algorithm.',
      caption: 'Caption One: 1843 London',
      media: { asset: 'https://archive.example/note-g.png', alt: 'Note G scan' },
      citationIds: ['c1'],
      wordTimestamps: [
        { word: 'Ada', startMs: 0, endMs: 500 },
        { word: 'Lovelace', startMs: 500, endMs: 1200 },
      ],
    },
    {
      id: 'b2',
      title: 'Closing Vision',
      startMs: 4000,
      durationMs: 5000,
      narration: 'She imagined machines weaving algebraic patterns.',
      caption: 'Caption Two: Symbolic weaving',
      citationIds: ['c1'],
    },
  ],
};

const PORTRAIT_AUDIO_STORY: DocumentaryStory = {
  ...DOC_STORY,
  id: 'story-doc-2',
  slug: 'ada-portrait-short',
  aspectRatio: '9:16',
  audio: {
    asset: 'https://archive.example/narration.mp3',
    durationMs: 9000,
  },
};

const SCROLL_STORY: ScrollStory = {
  schemaVersion: 1,
  id: 'story-scroll-1',
  slug: 'ada-letters-scroll',
  personId: 'person-ada',
  personName: 'Ada Lovelace',
  title: 'Letters in Ink',
  summary: 'Scrollytelling archival chapter.',
  format: 'scroll',
  citations: [{ id: 'c1', label: 'Bodleian Correspondence' }],
  beats: [
    {
      id: 's1',
      key: 'start',
      title: 'Chapter One',
      dateLabel: '1833',
      body: 'Early correspondence with Charles Babbage.',
      caption: 'Stage Caption One',
      pullQuote: 'That brain of mine is something more than merely mortal.',
      media: { asset: 'https://archive.example/letter.png', alt: 'Handwritten letter' },
      citationIds: ['c1'],
    },
    {
      id: 's2',
      key: 'end',
      title: 'Chapter Two',
      dateLabel: '1843',
      body: 'Publication of the annotated translation.',
      caption: 'Stage Caption Two',
      citationIds: ['c1'],
    },
  ],
};

const MAP_STORY: MapStory = {
  schemaVersion: 1,
  id: 'story-map-1',
  slug: 'ada-england-map',
  personId: 'person-ada',
  personName: 'Ada Lovelace',
  title: 'Across England',
  summary: 'Chronological places in Ada’s life.',
  format: 'map',
  citations: [{ id: 'c1', label: 'Estate Registers' }],
  beats: [
    {
      id: 'm1',
      title: 'London Birthplace',
      date: '1815',
      year: 1815,
      placeLabel: 'Piccadilly, London',
      coordinates: { lat: 51.509, lng: -0.141 },
      narrative: 'Born in Piccadilly, London.',
      caption: '1815 London',
      media: { asset: 'https://archive.example/piccadilly.png', alt: 'Piccadilly map' },
      citationIds: ['c1'],
    },
    {
      id: 'm2',
      title: 'Ockham Park',
      date: '1838',
      year: 1838,
      placeLabel: 'Ockham, Surrey',
      coordinates: { lat: 51.295, lng: -0.464 },
      narrative: 'Lived at Ockham Park in Surrey.',
      caption: '1838 Surrey',
      citationIds: ['c1'],
    },
  ],
};

const ContextOutsideProbe: React.FC = () => {
  useStoriesPlugin();
  return null;
};

describe('storiesModel and storiesClient helpers', () => {
  it('formats labels, durations, beat clocks, words, and map projections', async () => {
    expect(formatStoryFormatLabel('documentary')).toBe('Documentary');
    expect(formatStoryFormatLabel('scroll')).toBe('Scroll Story');
    expect(formatStoryFormatLabel('map')).toBe('Journey Map');
    expect(formatStoryDurationLabel(undefined)).toBe('');
    expect(formatStoryDurationLabel(0)).toBe('');
    expect(formatStoryDurationLabel(15_000)).toBe('15s');
    expect(formatStoryDurationLabel(60_000)).toBe('1m');
    expect(formatStoryDurationLabel(95_000)).toBe('1m 35s');

    expect(clampBeatIndex(-2, 3)).toBe(0);
    expect(clampBeatIndex(9, 3)).toBe(2);
    expect(clampBeatIndex(0, 0)).toBe(0);

    expect(resolveDocumentaryBeatAtTime(DOC_STORY, 1000)).toBe(0);
    expect(resolveDocumentaryBeatAtTime(DOC_STORY, 4500)).toBe(1);
    expect(resolveDocumentaryBeatAtTime(DOC_STORY, 99_999)).toBe(1);
    expect(resolveDocumentaryBeatAtTime({ ...DOC_STORY, beats: [] }, 0)).toBe(0);

    const firstWords = DOC_STORY.beats[0]?.wordTimestamps;
    expect(resolveActiveWordIndex(firstWords, 200)).toBe(0);
    expect(resolveActiveWordIndex(firstWords, 800)).toBe(1);
    expect(resolveActiveWordIndex(firstWords, 5000)).toBe(-1);
    expect(resolveActiveWordIndex(undefined, 0)).toBe(-1);

    const projected = projectMapStops(MAP_STORY.beats);
    expect(projected).toHaveLength(2);
    expect(projected[0]?.x).toBeGreaterThan(0);
    expect(projectMapStops([])).toEqual([]);

    const staticClient = createStaticStoriesClient({ stories: [DOC_STORY, SCROLL_STORY, MAP_STORY] });
    const allSummaries = await staticClient.listStories();
    expect(filterStorySummaries(allSummaries, { format: 'map', personId: 'person-ada' })).toHaveLength(1);
    expect(filterStorySummaries(allSummaries, { personId: 'person-other' })).toEqual([]);
  });

  it('loads stories over HTTP and handles non-OK or malformed payloads gracefully', async () => {
    const mockFetch: typeof fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('stories-manifest.json')) {
        return new Response(
          JSON.stringify({
            version: 1,
            updatedAt: '2026-11-28T00:00:00.000Z',
            stories: [
              {
                id: 'story-doc-1',
                slug: 'ada-engine-film',
                personId: 'person-ada',
                title: 'The Analytical Engine',
                summary: 'Summary',
                format: 'documentary',
                beatCount: 2,
                citationCount: 1,
                publishedAt: '2026-11-28T00:00:00.000Z',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('ada-engine-film.story.json')) {
        return new Response(JSON.stringify(DOC_STORY), { status: 200 });
      }
      if (url.endsWith('corrupt.story.json')) {
        return new Response(JSON.stringify({ bad: true }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const client = createHttpStoriesClient({ baseUrl: 'https://archive.example', fetchImpl: mockFetch });
    const all = await client.listStories();
    expect(all).toHaveLength(1);
    expect(await client.listStories({ personId: 'person-other' })).toEqual([]);
    expect((await client.getStory('ada-engine-film'))?.slug).toBe('ada-engine-film');
    expect(await client.getStory('corrupt')).toBeNull();
    expect(await client.getStory('missing')).toBeNull();

    const failClient = createHttpStoriesClient({
      fetchImpl: (async () => new Response('err', { status: 500 })) as typeof fetch,
    });
    expect(await failClient.listStories()).toEqual([]);

    const badManifestClient = createHttpStoriesClient({
      fetchImpl: (async () => new Response(JSON.stringify({ version: 99 }), { status: 200 })) as typeof fetch,
    });
    expect(await badManifestClient.listStories()).toEqual([]);
  });
});

describe('storiesUiPlugin behavioral rendering', () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  async function renderAt(
    initialRoute: string,
    options: {
      readonly stories?: readonly (DocumentaryStory | ScrollStory | MapStory)[];
      readonly client?: StoriesClient;
      readonly basePath?: string;
    } = {}
  ): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const plugin = createStoriesUiPlugin({
      ...(options.client
        ? { client: options.client }
        : { staticStories: options.stories ?? [DOC_STORY, PORTRAIT_AUDIO_STORY, SCROLL_STORY, MAP_STORY] }),
      ...(options.basePath ? { basePath: options.basePath } : {}),
    });
    await act(async () => {
      root?.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialEntries={[initialRoute]}
          plugins={[plugin]}
        />
      );
    });
    return container;
  }

  it('exports default storiesUiPlugin, supports disabled mode, and guards useStoriesPlugin outside provider', () => {
    expect(storiesUiPlugin.id).toBe(STORIES_UI_PLUGIN_ID);
    expect(storiesUiPlugin.status).toBe('active');
    const disabled = createStoriesUiPlugin({ enabled: false });
    expect(disabled.status).toBe('disabled');
    expect(disabled.routes).toBeUndefined();
    expect(disabled.slots).toBeUndefined();

    const tempDiv = document.createElement('div');
    const tempRoot = createRoot(tempDiv);
    expect(() => {
      act(() => {
        tempRoot.render(<ContextOutsideProbe />);
      });
    }).toThrow('useStoriesPlugin must be used inside a KinloomApp');
    tempRoot.unmount();
  });

  it('renders Specialty Stories in personDetail slot, handles errors, and hides cleanly when none exist', async () => {
    const adaDom = await renderAt('/person/ada-lovelace', { basePath: '/stories/' });
    await waitForCondition(() => (adaDom.textContent ?? '').includes('Specialty Stories'));
    expect(adaDom.textContent).toContain('The Analytical Engine');
    expect(adaDom.textContent).toContain('Documentary');
    expect(adaDom.textContent).toContain('Launch story');

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const emptyDom = await renderAt('/person/charles-babbage');
    await waitForCondition(() => (emptyDom.textContent ?? '').includes('Charles Babbage'));
    expect(emptyDom.textContent).not.toContain('Specialty Stories');

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const errClient: StoriesClient = {
      listStories: async () => {
        throw new Error('network down');
      },
      getStory: async () => {
        throw new Error('network down');
      },
    };
    const errPersonDom = await renderAt('/person/ada-lovelace', { client: errClient });
    await waitForCondition(() => (errPersonDom.textContent ?? '').includes('Ada Lovelace'));
    expect(errPersonDom.textContent).not.toContain('Specialty Stories');
  });

  it('renders /stories index with format filters and empty states', async () => {
    const dom = await renderAt('/stories', { stories: [DOC_STORY, MAP_STORY] });
    await waitForCondition(() => (dom.textContent ?? '').includes('The Analytical Engine'));
    expect(dom.textContent).toContain('Across England');

    const mapBtn = Array.from(dom.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Journey Map')
    );
    await act(async () => {
      mapBtn?.click();
    });
    expect(dom.textContent).toContain('Across England');
    expect(dom.textContent).not.toContain('The Analytical Engine');

    // Scroll Story filter has 0 stories -> empty state
    const scrollBtn = Array.from(dom.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Scroll Story')
    );
    await act(async () => {
      scrollBtn?.click();
    });
    expect(dom.textContent).toContain('No specialty stories found');
  });

  it('plays, scrubs, toggles captions, and handles keyboard nav and audio in Documentary player', async () => {
    const dom = await renderAt('/stories/ada-engine-film');
    await waitForCondition(() => (dom.textContent ?? '').includes('Opening Scene'));
    expect(dom.textContent).toContain('Caption One: 1843 London');
    expect(dom.textContent).toContain('Scientific Memoirs (1843)');

    // Jump via beat scrubber segment 2
    const beat2Btn = dom.querySelector('button[aria-label*="Jump to beat 2"]') as HTMLButtonElement | null;
    await act(async () => {
      beat2Btn?.click();
    });
    expect(dom.textContent).toContain('Closing Vision');

    // Previous via button
    const prevBtn = Array.from(dom.querySelectorAll('button')).find((b) => b.textContent === 'Previous');
    await act(async () => {
      prevBtn?.click();
    });
    expect(dom.textContent).toContain('Opening Scene');

    // Keyboard ArrowRight / ArrowLeft / c / Space
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(dom.textContent).toContain('Closing Vision');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });
    expect(dom.textContent).toContain('Opening Scene');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
    });
    expect(dom.textContent).not.toContain('Caption One: 1843 London');

    // Captions toggle button brings it back
    const capBtn = Array.from(dom.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Show Captions')
    );
    await act(async () => {
      capBtn?.click();
    });
    expect(dom.textContent).toContain('Caption One: 1843 London');

    // Play via Space
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    });
    expect(dom.textContent).toContain('Pause');

    act(() => {
      root?.unmount();
    });
    container?.remove();

    // Portrait 9:16 with <audio> element
    const portraitDom = await renderAt('/stories/ada-portrait-short');
    await waitForCondition(() => (portraitDom.textContent ?? '').includes('Opening Scene'));
    const audioEl = portraitDom.querySelector('audio');
    expect(audioEl).not.toBeNull();
    if (audioEl) {
      Object.defineProperty(audioEl, 'currentTime', { value: 4.5, writable: true });
      await act(async () => {
        audioEl.dispatchEvent(new Event('timeupdate'));
      });
      expect(portraitDom.textContent).toContain('Closing Vision');
      await act(async () => {
        audioEl.dispatchEvent(new Event('ended'));
      });
    }
  });

  it('synchronizes Scroll player stage and steps through Map player stops via buttons, pins, and keyboard', async () => {
    const scrollDom = await renderAt('/stories/ada-letters-scroll');
    await waitForCondition(() => (scrollDom.textContent ?? '').includes('Stage Caption One'));
    const focusSecondBtn = scrollDom.querySelector(
      '[data-beat-index="1"] button'
    ) as HTMLButtonElement | null;
    expect(focusSecondBtn).not.toBeNull();
    await act(async () => {
      focusSecondBtn?.click();
    });
    expect(scrollDom.textContent).toContain('Stage Caption Two');

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const mapDom = await renderAt('/stories/ada-england-map');
    await waitForCondition(() => (mapDom.textContent ?? '').includes('Piccadilly, London'));

    // Next Stop button
    const nextStopBtn = Array.from(mapDom.querySelectorAll('button')).find(
      (b) => b.textContent === 'Next Stop'
    );
    await act(async () => {
      nextStopBtn?.click();
    });
    expect(mapDom.textContent).toContain('Ockham Park');

    // Previous Stop button
    const prevStopBtn = Array.from(mapDom.querySelectorAll('button')).find(
      (b) => b.textContent === 'Previous Stop'
    );
    await act(async () => {
      prevStopBtn?.click();
    });
    expect(mapDom.textContent).toContain('London Birthplace');

    // Keyboard ArrowRight / ArrowLeft
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(mapDom.textContent).toContain('Ockham Park');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });
    expect(mapDom.textContent).toContain('London Birthplace');

    // Click year button 1838 and SVG pin 1
    const yearBtn = Array.from(mapDom.querySelectorAll('button')).find((b) => b.textContent === '1838');
    await act(async () => {
      yearBtn?.click();
    });
    expect(mapDom.textContent).toContain('Ockham Park');

    const firstPin = mapDom.querySelector('circle[role="button"]');
    await act(async () => {
      firstPin?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mapDom.textContent).toContain('London Birthplace');

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const missingDom = await renderAt('/stories/does-not-exist');
    await waitForCondition(() => (missingDom.textContent ?? '').includes('Story not found'));
  });
});
