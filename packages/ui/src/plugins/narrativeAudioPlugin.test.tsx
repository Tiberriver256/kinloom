/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, Narrative } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { KinloomApp } from '../KinloomApp.js';
import {
  createNarrativeAudioPlugin,
  readNarrativeAudioMeta,
  resolveNarrativeAudioKind,
  resolveNarrativeAudioLabels,
} from './narrativeAudioPlugin.js';

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

async function waitForCondition(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
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

  it('renders kind-specific labels for biography, family_story, research_note, memoir, custom label override, and surfaces audio onError alerts', async () => {
    const familyStory: Narrative = {
      id: 'nar_story',
      slug: 'mercer-creek-flood',
      kind: 'family_story',
      title: 'The 1798 Creek Flood',
      body_md: 'Shared story of the Mercer household.',
      person_ids: ['p_thomas', 'p_hannah'],
      place_ids: [],
      event_ids: [],
      source_ids: [],
      extensions: {
        narrative_audio: {
          file: '/media/audio/flood-story.mp3',
          duration_seconds: 180,
          editor_notes_start_seconds: 120,
          story_voice: 'Aoede',
          notes_voice: 'Kore',
        },
      },
    };
    const researchNote: Narrative = {
      id: 'nar_note',
      slug: 'mercer-deed-proof',
      kind: 'research_note',
      title: 'Proof Summary for 1774 Patent',
      body_md: 'Deed analysis.',
      person_ids: ['p_thomas'],
      place_ids: [],
      event_ids: [],
      source_ids: [],
      extensions: {
        narrative_audio: {
          file: '/media/audio/deed-proof.mp3',
          duration_seconds: 95,
          story_voice: 'Charon',
        },
      },
    };
    const customLabelMemoir: Narrative = {
      id: 'nar_memoir',
      slug: 'hannah-memoir',
      kind: 'memoir',
      title: 'Winter Journals',
      body_md: 'Memoir excerpt.',
      person_ids: ['p_thomas'],
      place_ids: [],
      event_ids: [],
      source_ids: [],
      extensions: {
        narrative_audio: {
          file: '/media/audio/memoir.mp3',
          duration_seconds: 120,
          story_voice: 'Leda',
          label: 'Proof Summary',
        },
      },
    };

    // Pure kind resolution & label table checks (including memoir default and omitted kind fallbacks)
    expect(resolveNarrativeAudioKind({ ...plainBio, kind: undefined }, testBundle.people[1])).toBe(
      'biography'
    );
    expect(
      resolveNarrativeAudioKind(
        { ...familyStory, kind: undefined, subject_person_id: undefined },
        testBundle.people[0]
      )
    ).toBe('family_story');
    expect(resolveNarrativeAudioLabels({ narrativeKind: 'biography' })).toEqual({
      marginLabel: 'Listen to Biography',
      dockLabel: 'Biography Narration',
      returnLabel: '↩ Biography',
    });
    expect(resolveNarrativeAudioLabels({ narrativeKind: 'family_story' })).toEqual({
      marginLabel: 'Listen to Story',
      dockLabel: 'Story Narration',
      returnLabel: '↩ Story',
    });
    expect(resolveNarrativeAudioLabels({ narrativeKind: 'research_note' })).toEqual({
      marginLabel: 'Listen to Research Note',
      dockLabel: 'Research Note Narration',
      returnLabel: '↩ Note',
    });
    expect(resolveNarrativeAudioLabels({ narrativeKind: 'memoir' })).toEqual({
      marginLabel: 'Listen to Memoir',
      dockLabel: 'Memoir Narration',
      returnLabel: '↩ Memoir',
    });
    expect(resolveNarrativeAudioLabels({ narrativeKind: 'memoir', customLabel: 'Proof Summary' })).toEqual({
      marginLabel: 'Listen to Proof Summary',
      dockLabel: 'Proof Summary Narration',
      returnLabel: '↩ Proof Summary',
    });
    expect(readNarrativeAudioMeta(customLabelMemoir)?.label).toBe('Proof Summary');

    const { bundle: multiKindBundle } = compileArchive({
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
      narratives: [narratedBio, familyStory, researchNote, customLabelMemoir],
    });

    const plugin = createNarrativeAudioPlugin();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={siteConfig}
          initialBundle={multiKindBundle}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/person/thomas-mercer']}
        />
      );
    });

    await waitForCondition(
      () => container.querySelectorAll('[data-testid="narrative-audio-margin-bar"]').length >= 4
    );

    const bars = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="narrative-audio-margin-bar"]')
    );
    const barTexts = bars.map((b) => b.textContent ?? '');
    expect(barTexts.some((t) => t.includes('Listen to Biography · Charon'))).toBe(true);
    expect(barTexts.some((t) => t.includes('Listen to Story · Aoede'))).toBe(true);
    expect(barTexts.some((t) => t.includes('Listen to Research Note · Charon'))).toBe(true);
    expect(barTexts.some((t) => t.includes('Listen to Proof Summary · Leda'))).toBe(true);

    // Play the Family Story -> dock renders "Story Narration (Aoede)", not "Biography Narration"
    const storyBar = bars.find((b) => (b.textContent ?? '').includes('Listen to Story · Aoede'));
    const storyPlayBtn = storyBar?.querySelector<HTMLButtonElement>('.narrative-audio-play-btn');
    await act(async () => {
      storyPlayBtn?.click();
    });
    const dock = container.querySelector<HTMLElement>('[data-testid="narrative-audio-dock"]');
    expect(dock?.textContent).toContain('Story Narration (Aoede)');
    expect(storyPlayBtn?.getAttribute('aria-pressed')).toBe('true');

    // Simulate audio load failure (<audio onError>) -> resets isPlaying=false and shows role="alert" in bar and dock
    const audioEl = container.querySelector<HTMLAudioElement>('audio');
    expect(audioEl).not.toBeNull();
    await act(async () => {
      audioEl?.dispatchEvent(new Event('error'));
    });
    expect(storyPlayBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(storyPlayBtn?.textContent).toContain('▶');
    const inlineAlert = storyBar?.querySelector('[data-testid="narrative-audio-error"]');
    expect(inlineAlert?.getAttribute('role')).toBe('alert');
    expect(inlineAlert?.textContent).toContain('Audio narration could not be loaded');
    const dockAlert = dock?.querySelector('[data-testid="narrative-audio-dock-error"]');
    expect(dockAlert?.getAttribute('role')).toBe('alert');

    // Retrying playback clears the error state
    await act(async () => {
      storyPlayBtn?.click();
    });
    expect(storyBar?.querySelector('[data-testid="narrative-audio-error"]')).toBeNull();
    expect(dock?.querySelector('[data-testid="narrative-audio-dock-error"]')).toBeNull();

    // Media events update duration/time, clear error on canplay/loadedmetadata, and stop playback on ended
    if (audioEl) {
      Object.defineProperty(audioEl, 'duration', { configurable: true, value: 185 });
      Object.defineProperty(audioEl, 'currentTime', { configurable: true, writable: true, value: 42 });
      await act(async () => {
        audioEl.dispatchEvent(new Event('loadedmetadata'));
        audioEl.dispatchEvent(new Event('canplay'));
        audioEl.dispatchEvent(new Event('timeupdate'));
      });
      // Dock play/pause and skip controls exercise togglePlayPause and skip
      const dockPlayBtn = dock?.querySelector<HTMLButtonElement>('.narrative-audio-dock-play');
      const dockSkipBtns = Array.from(
        dock?.querySelectorAll<HTMLButtonElement>('.narrative-audio-skip-btn') ?? []
      );
      await act(async () => {
        dockSkipBtns[0]?.click();
        dockSkipBtns[1]?.click();
        dockPlayBtn?.click();
        dockPlayBtn?.click();
      });
      await act(async () => {
        audioEl.dispatchEvent(new Event('ended'));
      });
      expect(storyPlayBtn?.getAttribute('aria-pressed')).toBe('false');
    }

    // Jumping directly to Editor's Notes on a DIFFERENT track switches active track and starts playback
    const bioBar = bars.find((b) => (b.textContent ?? '').includes('Listen to Biography · Charon'));
    const bioJumpBtn = bioBar?.querySelector<HTMLButtonElement>('.narrative-audio-jump-btn');
    await act(async () => {
      bioJumpBtn?.click();
    });
    expect(dock?.textContent).toContain("Editor's Notes (Kore)");

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
