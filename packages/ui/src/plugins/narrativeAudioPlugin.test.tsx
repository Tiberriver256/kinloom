/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, Narrative } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { KinloomApp } from '../KinloomApp.js';
import { createNarrativeAudioPlugin, readNarrativeAudioMeta } from './narrativeAudioPlugin.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Audio Plugin Archive',
    familyName: 'Mercer Family',
    gedcomSourceName: 'AUDIO_PLUGIN_TEST',
  },
});

const narratedBio: Narrative = {
  id: 'nar_mercer_bio',
  slug: 'thomas-mercer-biography',
  kind: 'biography',
  subject_person_id: 'p_thomas',
  title: 'Miller and Surveyor on Mercer Creek',
  summary: 'From a 1774 gristmill patent to an 1811 probate inventory.',
  body_md: 'Thomas Mercer settled on Mercer Creek before 1774.',
  date_edtf: '1742/1811',
  person_ids: ['p_thomas'],
  place_ids: [],
  event_ids: [],
  source_ids: [],
  extensions: {
    narrative_audio: {
      file: '/media/audio/thomas-mercer.mp3',
      duration_seconds: 342,
      editor_notes_start_seconds: 274,
      story_voice: 'Charon',
      notes_voice: 'Kore',
    },
  },
};

const plainBio: Narrative = {
  id: 'nar_hannah_bio',
  slug: 'hannah-mercer-biography',
  kind: 'biography',
  subject_person_id: 'p_hannah',
  title: 'Hannah Caldwell Mercer',
  body_md: 'Hannah managed the Mercer household after 1811.',
  person_ids: ['p_hannah'],
  place_ids: [],
  event_ids: [],
  source_ids: [],
};

const { bundle: testBundle }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig,
  mode: 'public',
  people: [
    {
      id: 'p_thomas',
      slug: 'thomas-mercer',
      full_name: 'Thomas Mercer',
      given_name: 'Thomas',
      surname: 'Mercer',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1742',
      death_edtf: '1811',
      portrait_url: null,
    },
    {
      id: 'p_hannah',
      slug: 'hannah-mercer',
      full_name: 'Hannah Caldwell Mercer',
      given_name: 'Hannah',
      surname: 'Mercer',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1748',
      death_edtf: '1824',
      portrait_url: null,
    },
  ],
  places: [],
  events: [],
  sources: [],
  kinship: [],
  narratives: [narratedBio, plainBio],
});

async function waitForCondition(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

describe('createNarrativeAudioPlugin (Idea 1 + Idea 4)', () => {
  it('validates narrative_audio metadata cleanly', () => {
    expect(readNarrativeAudioMeta(narratedBio)).toEqual({
      file: '/media/audio/thomas-mercer.mp3',
      duration_seconds: 342,
      editor_notes_start_seconds: 274,
      story_voice: 'Charon',
      notes_voice: 'Kore',
    });
    expect(readNarrativeAudioMeta(plainBio)).toBeNull();
  });

  it('mounts inline margin bar on PersonPage and persists dock across route navigation', async () => {
    const plugin = createNarrativeAudioPlugin();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={siteConfig}
          initialBundle={testBundle}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/person/thomas-mercer']}
        />
      );
    });

    await waitForCondition(
      () => container.querySelector('[data-testid="narrative-audio-margin-bar"]') !== null
    );

    // Inline Archival Margin Bar renders inside the biography entry
    const marginBar = container.querySelector('[data-testid="narrative-audio-margin-bar"]');
    expect(marginBar).not.toBeNull();
    expect(marginBar?.textContent).toContain('Listen to Biography · Charon');
    expect(marginBar?.textContent).toContain("Editor's notes 4:34");

    // Dock stays hidden until playback begins
    expect(container.querySelector('[data-testid="narrative-audio-dock"]')).toBeNull();

    // Start playback
    const playBtn = marginBar?.querySelector<HTMLButtonElement>('.narrative-audio-play-btn');
    expect(playBtn).not.toBeNull();
    await act(async () => {
      playBtn?.click();
    });

    // Persistent dock appears in appShell slot
    const dock = container.querySelector('[data-testid="narrative-audio-dock"]');
    expect(dock).not.toBeNull();
    expect(dock?.textContent).toContain('Thomas Mercer');
    expect(dock?.textContent).toContain('Miller and Surveyor on Mercer Creek');
    expect(dock?.textContent).toContain('Biography Narration (Charon)');

    // Jump to Editor's Notes switches voice indicator in both bar and dock
    const jumpBtn = marginBar?.querySelector<HTMLButtonElement>('.narrative-audio-jump-btn');
    await act(async () => {
      jumpBtn?.click();
    });
    expect(marginBar?.textContent).toContain("Editor's Notes · Kore");
    expect(dock?.textContent).toContain("Editor's Notes (Kore)");

    // Cycle playback speed updates across bar and dock
    const speedBtn = marginBar?.querySelector<HTMLButtonElement>('.narrative-audio-pill');
    await act(async () => {
      speedBtn?.click();
    });
    expect(speedBtn?.textContent).toBe('1.25×');
    expect(dock?.textContent).toContain('1.25×');

    // Navigate away to /places — dock survives route change!
    const placesLink = [...container.querySelectorAll<HTMLAnchorElement>('.nav-links a')].find(
      (a) => a.getAttribute('href') === '/places'
    );
    expect(placesLink).not.toBeNull();
    await act(async () => {
      placesLink?.click();
    });
    await waitForCondition(
      () =>
        container.querySelector('[data-testid="narrative-audio-margin-bar"]') === null &&
        container.querySelector('.archive-loading-shell') === null
    );
    expect(container.querySelector('[data-testid="narrative-audio-margin-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="narrative-audio-dock"]')).not.toBeNull();

    // Dismissing the dock removes it cleanly
    const dismissBtn = container.querySelector<HTMLButtonElement>('.narrative-audio-dock-dismiss');
    await act(async () => {
      dismissBtn?.click();
    });
    expect(container.querySelector('[data-testid="narrative-audio-dock"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('omits the margin bar for biographies without narrative_audio extensions', async () => {
    const plugin = createNarrativeAudioPlugin();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={siteConfig}
          initialBundle={testBundle}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/person/hannah-mercer']}
        />
      );
    });

    await waitForCondition(
      () =>
        container.querySelector('.archive-loading-shell') === null &&
        (container.textContent?.includes('Hannah Caldwell Mercer') ?? false)
    );

    expect(container.textContent).toContain('Hannah Caldwell Mercer');
    expect(container.querySelector('[data-testid="narrative-audio-margin-bar"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
