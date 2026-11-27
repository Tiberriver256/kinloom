/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, ReadingsBundle } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { GlobalSearchModal } from '../components/GlobalSearchModal.js';
import { SourceReaderDrawer } from '../components/SourceReaderDrawer.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { TreePage } from '../pages/TreePage.js';
import { createNarrativeAudioPlugin, readNarrativeAudioMeta } from './narrativeAudioPlugin.js';
import { PluginSlot } from './PluginContext.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Audio & Chrome Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_AUDIO_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  places: [
    {
      id: 'pl_hud',
      slug: 'hudsonville',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.87,
      lng: -85.86,
    },
  ],
  sources: [
    {
      id: 'src_book',
      citation: 'History of Ottawa County (1905)',
      source_type: 'published_history',
      has_primary_source: true,
    },
  ],
  people: [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
      portrait_url: null,
    },
    {
      id: 'per_clara',
      slug: 'clara-alder',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1858-07-22',
      death_edtf: '1938-04-09',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_1880',
      title: '1880 Homestead',
      summary: 'Settled in Hudsonville.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_hud',
      participants: [{ person_id: 'per_henry', role: 'head' }],
      sources: [{ source_id: 'src_book', confidence: 'high' }],
    },
  ],
  kinship: [{ from: 'per_henry', to: 'per_clara', relation: 'spouse' }],
  narratives: [
    {
      id: 'nar_audio',
      slug: 'rush-creek-story',
      title: 'The Rush Creek Sawmill',
      summary: 'Audio narration of the sawmill.',
      body_md: 'Henry Alder operated the mill.',
      date_edtf: '1884',
      person_ids: ['per_henry'],
      place_ids: ['pl_hud'],
      event_ids: ['evt_1880'],
      source_ids: ['src_book'],
      extensions: {
        narrative_audio: {
          file: '/audio/rush-creek.mp3',
          duration_seconds: 185,
          editor_notes_start_seconds: 120,
          story_voice: 'Charon',
          notes_voice: 'Kore',
        },
      },
    },
  ],
});

const SAMPLE_READINGS: ReadingsBundle = {
  version: 1,
  event_page_map: { evt_1880: { src_book: 1 } },
  documents: {
    src_book: {
      source_id: 'src_book',
      title: 'History of Ottawa County',
      author: 'C. Vance',
      provenance: 'Ottawa Historical Society',
      pages: [
        { page: 1, label: 'Page 1', file: 'p1.txt', text: 'Page one text.', image_url: '/sources/p1.jpg' },
        { page: 2, label: 'Page 2', file: 'p2.txt', text: 'Page two text.', image_url: '/sources/p2.jpg' },
      ],
    },
  },
};

const cleanups: Array<() => void> = [];

function mountEl(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const OpenReader: React.FC = () => {
  const { openSourceReader } = useArchiveUi();
  useEffect(() => {
    openSourceReader({ sourceId: 'src_book', page: 1 });
  }, [openSourceReader]);
  return null;
};

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('NarrativeAudioPlugin controls, SourceReaderDrawer keyboard/zoom, ExplorerTopBar shortcuts, and TreePage animation frames', () => {
  it('controls playback speed, notes jump, seek, audio events, and dismiss in narrativeAudioPlugin', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

    const narrative = SAMPLE_BUNDLE.narratives?.[0];
    expect(readNarrativeAudioMeta(narrative)?.duration_seconds).toBe(185);
    expect(readNarrativeAudioMeta(undefined)).toBeNull();

    const plugin = createNarrativeAudioPlugin();
    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} plugins={[plugin]}>
          <PluginSlot name="narrativeHeader" narrative={narrative} person={SAMPLE_BUNDLE.people[0]} />
          <PluginSlot name="appShell" />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Start playing narration
    const playBtn = container.querySelector('button') ?? undefined;
    expect(playBtn).toBeDefined();
    act(() => {
      playBtn?.click();
    });
    await flushUi();

    const audio = container.querySelector('audio') as HTMLAudioElement | null;
    if (audio) {
      act(() => {
        audio.dispatchEvent(new Event('loadedmetadata'));
        audio.dispatchEvent(new Event('timeupdate'));
        audio.dispatchEvent(new Event('pause'));
        audio.dispatchEvent(new Event('play'));
        audio.dispatchEvent(new Event('ended'));
      });
      await flushUi();
    }

    // Cycle playback speed, jump to notes, seek slider, and close mini player
    for (const pattern of [/1×|1x|speed/i, /editor|notes/i, /pause|play/i, /close|dismiss/i]) {
      const btn = Array.from(container.querySelectorAll('button')).find((b) =>
        pattern.test(b.getAttribute('aria-label') || b.textContent || '')
      );
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }
  });

  it('exercises SourceReaderDrawer keyboard navigation, ExplorerTopBar shortcuts & mobile menu, and TreePage rAF animation', async () => {
    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => SAMPLE_READINGS,
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: { authenticated: false, principal_kind: 'anonymous' },
        capabilities: {
          canEdit: false,
          canUploadMedia: false,
          hasRevisionHistory: false,
          hasTalk: false,
          canManageSite: false,
        },
      }),
    };

    mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <OpenReader />
          <SourceReaderDrawer />
          <ExplorerTopBar />
          <GlobalSearchModal />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    // Keyboard ArrowRight / ArrowLeft in SourceReaderDrawer
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    await flushUi();

    // Global '/' shortcut to open search from ExplorerTopBar
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    await flushUi();

    // TreePage with synchronous rAF to exercise viewport transform animations
    let rafCount = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCount += 1;
      if (rafCount <= 8) {
        cb(performance.now() + rafCount * 16);
      }
      return rafCount;
    });

    const treeEl = mountEl(
      <MemoryRouter initialEntries={['/tree?view=chart&focus=henry-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    // Click zoom buttons + search clear button
    const zoomBtns = Array.from(treeEl.querySelectorAll('[aria-label="Chart zoom controls"] button'));
    for (const btn of zoomBtns) {
      act(() => {
        (btn as HTMLElement).click();
      });
      await flushUi();
    }
  });
});
