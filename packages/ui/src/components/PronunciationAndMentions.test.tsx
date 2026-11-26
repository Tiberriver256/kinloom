/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveDataSource,
  EntityPayload,
  KinloomSiteConfig,
  Person,
  Place,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchivalMarkdown } from './ArchivalMarkdown.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { EntityEditDrawer } from './wiki/EntityEditDrawer.js';
import { PersonPage } from '../pages/PersonPage.js';
import { PlacePage } from '../pages/PlacePage.js';
import { PronunciationBadge } from './PronunciationBadge.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEST_SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Mercer Synthetic Archive',
    familyName: 'Mercer Family',
    gedcomSourceName: 'MERCER_TEST',
  },
});

function renderIntoDom(element: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function buildTestBundle(): ArchiveBundle {
  const { bundle } = compileArchive({
    siteConfig: TEST_SITE_CONFIG,
    mode: 'public',
    people: [
      {
        id: 'per_thomas',
        slug: 'thomas-mercer',
        full_name: 'Thomas Mercer',
        given_name: 'Thomas',
        surname: 'Mercer',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1842-05-10',
        death_edtf: '1911-08-19',
        portrait_url: null,
        pronunciation: {
          phonetic: 'MER-ser',
          ipa: '/ˈmɜːr.sər/',
          language: 'en-US',
          audio_url: '/audio/per_thomas.mp3',
          note: 'Stress on first syllable',
        },
      },
      {
        id: 'per_hannah',
        slug: 'hannah-mercer',
        full_name: 'Hannah Mercer',
        given_name: 'Hannah',
        surname: 'Mercer',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1846-09-02',
        death_edtf: '1920-01-15',
        portrait_url: null,
        pronunciation: {
          phonetic: 'HAN-uh MER-ser',
          language: 'en-US',
          audio_url: '/audio/per_hannah.mp3',
        },
      },
      {
        id: 'per_living',
        slug: 'living-relative',
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
    places: [
      {
        id: 'plc_leiden',
        slug: 'leiden',
        name: 'Leiden',
        full_name: 'Leiden, South Holland',
        place_type: 'town',
        parent_id: null,
        lat: 52.16,
        lng: 4.49,
        pronunciation: {
          phonetic: 'LAY-den',
          ipa: '/ˈlɛi.də(n)/',
          language: 'nl',
          audio_url: '/audio/plc_leiden.mp3',
        },
      },
      {
        id: 'plc_oxford_twp',
        slug: 'oxford-township',
        name: 'Oxford Township',
        full_name: 'Oxford Township, Massachusetts',
        place_type: 'county',
        parent_id: null,
        lat: 42.12,
        lng: -71.86,
      },
      {
        id: 'plc_oxford',
        slug: 'oxford',
        name: 'Oxford',
        full_name: 'Oxford, Massachusetts',
        place_type: 'town',
        parent_id: null,
        lat: 42.11,
        lng: -71.87,
      },
    ],
    events: [],
    sources: [],
    kinship: [],
    narratives: [
      {
        id: 'nar_thomas_bio',
        slug: 'thomas-mercer-bio',
        kind: 'biography',
        subject_person_id: 'per_thomas',
        title: 'Early Years in Leiden',
        body_md:
          'Thomas Mercer sailed from [[place:plc_leiden|Leiden]] with Hannah Mercer before settling in Oxford Township.',
        person_ids: ['per_thomas', 'per_hannah'],
        place_ids: ['plc_leiden', 'plc_oxford_twp', 'plc_oxford'],
        event_ids: [],
        source_ids: [],
      },
    ],
  });
  return bundle;
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('PronunciationBadge playback and fallback', () => {
  it('plays resolved audio_url via HTML Audio, stops prior clip, and toggles active state', () => {
    const createdAudios: {
      src: string;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      listeners: Map<string, () => void>;
    }[] = [];

    class MockAudio {
      src: string;
      currentTime = 0;
      listeners = new Map<string, () => void>();
      play = vi.fn(() => Promise.resolve());
      pause = vi.fn();

      constructor(src: string) {
        this.src = src;
        createdAudios.push(this);
      }

      addEventListener(event: string, cb: () => void): void {
        this.listeners.set(event, cb);
      }
    }

    vi.stubGlobal('Audio', MockAudio);

    const { container, unmount } = renderIntoDom(
      <div>
        <PronunciationBadge
          pronunciation={{
            phonetic: 'LAY-den',
            ipa: '/ˈlɛi.də(n)/',
            language: 'nl',
            audio_url: '/audio/plc_leiden.mp3',
          }}
          label="Leiden"
          baseUrl="/archive/"
        />
        <PronunciationBadge
          pronunciation={{
            phonetic: 'MER-ser',
            audio_url: '/audio/per_thomas.mp3',
          }}
          label="Thomas Mercer"
          baseUrl="/archive/"
          compact
        />
      </div>,
    );

    const leidenBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Listen to pronunciation of Leiden"]',
    );
    const thomasBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Listen to pronunciation of Thomas Mercer"]',
    );
    expect(leidenBtn).not.toBeNull();
    expect(thomasBtn).not.toBeNull();
    expect(container.textContent).toContain('LAY-den');
    expect(container.textContent).toContain('/ˈlɛi.də(n)/');
    expect(container.textContent).toContain('nl');

    act(() => {
      leidenBtn!.click();
    });

    expect(createdAudios).toHaveLength(1);
    expect(createdAudios[0].src).toBe('/archive/audio/plc_leiden.mp3');
    expect(createdAudios[0].play).toHaveBeenCalledTimes(1);
    expect(leidenBtn!.getAttribute('aria-pressed')).toBe('true');

    // Playing a second badge stops the first audio clip
    act(() => {
      thomasBtn!.click();
    });

    expect(createdAudios[0].pause).toHaveBeenCalledTimes(1);
    expect(leidenBtn!.getAttribute('aria-pressed')).toBe('false');
    expect(createdAudios).toHaveLength(2);
    expect(createdAudios[1].src).toBe('/archive/audio/per_thomas.mp3');
    expect(thomasBtn!.getAttribute('aria-pressed')).toBe('true');

    // Trigger ended event resets playing state
    act(() => {
      createdAudios[1].listeners.get('ended')?.();
    });
    expect(thomasBtn!.getAttribute('aria-pressed')).toBe('false');

    unmount();
  });

  it('falls back to window.speechSynthesis using native label for non-English and phonetic guide for English', () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    class MockUtterance {
      text: string;
      lang = '';
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak, cancel },
    });
    vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance);

    const { container, unmount } = renderIntoDom(
      <div>
        <PronunciationBadge
          pronunciation={{ phonetic: 'KRAH-koof', language: 'pl' }}
          label="Kraków"
        />
        <PronunciationBadge
          pronunciation={{ phonetic: 'HOOS', ipa: '/ɣus/', language: 'nl' }}
          label="Goes"
        />
        <PronunciationBadge
          pronunciation={{ phonetic: 'MER-ser', language: 'en-US' }}
          label="Mercer"
        />
      </div>,
    );

    const krakowBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Listen to pronunciation of Kraków"]',
    );
    const goesBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Listen to pronunciation of Goes"]',
    );
    const mercerBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Listen to pronunciation of Mercer"]',
    );
    expect(krakowBtn).not.toBeNull();
    expect(goesBtn).not.toBeNull();
    expect(mercerBtn).not.toBeNull();

    // Polish: speaks native label "Kraków", NOT English respelling "KRAH-koof"
    act(() => {
      krakowBtn!.click();
    });
    expect(speak).toHaveBeenCalledTimes(1);
    const plUtterance = speak.mock.calls[0][0] as MockUtterance;
    expect(plUtterance.text).toBe('Kraków');
    expect(plUtterance.lang).toBe('pl');
    expect(krakowBtn!.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      plUtterance.onend?.();
    });
    expect(krakowBtn!.getAttribute('aria-pressed')).toBe('false');

    // Dutch: speaks native label "Goes", NOT English respelling "HOOS"
    act(() => {
      goesBtn!.click();
    });
    expect(speak).toHaveBeenCalledTimes(2);
    const nlUtterance = speak.mock.calls[1][0] as MockUtterance;
    expect(nlUtterance.text).toBe('Goes');
    expect(nlUtterance.lang).toBe('nl');

    // English: speaks phonetic guide "MER-ser"
    act(() => {
      mercerBtn!.click();
    });
    expect(speak).toHaveBeenCalledTimes(3);
    const enUtterance = speak.mock.calls[2][0] as MockUtterance;
    expect(enUtterance.text).toBe('MER-ser');
    expect(enUtterance.lang).toBe('en-US');

    unmount();
  });

  it('displays source attribution and switches/plays variants on non-compact badges without cluttering compact badges', () => {
    const createdAudios: { src: string; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }[] = [];
    class MockAudio {
      src: string;
      currentTime = 0;
      play = vi.fn(() => Promise.resolve());
      pause = vi.fn();
      constructor(src: string) {
        this.src = src;
        createdAudios.push(this);
      }
      addEventListener(): void {}
    }
    vi.stubGlobal('Audio', MockAudio);

    const multiVariant = {
      phonetic: 'ZAY-lahnt',
      ipa: '/ˈzeː.lɑnt/',
      language: 'nl',
      region: 'Netherlands',
      audio_url: '/audio/zeeland-nl.wav',
      source_label: 'Wiktionary (Dutch IPA)',
      source_url: 'https://en.wiktionary.org/wiki/Zeeland',
      variants: [
        {
          label: 'West Michigan',
          phonetic: 'ZEE-lund',
          ipa: '/ˈziː.lənd/',
          language: 'en-US',
          audio_url: '/audio/zeeland-mi.wav',
          source_label: 'Family oral tradition',
        },
      ],
    };

    const { container, unmount } = renderIntoDom(
      <div>
        <div data-testid="full-badge">
          <PronunciationBadge pronunciation={multiVariant} label="Zeeland" baseUrl="/" />
        </div>
        <div data-testid="compact-badge">
          <PronunciationBadge pronunciation={multiVariant} label="Zeeland" baseUrl="/" compact />
        </div>
      </div>,
    );

    const fullBadge = container.querySelector('[data-testid="full-badge"]')!;
    const compactBadge = container.querySelector('[data-testid="compact-badge"]')!;

    expect(fullBadge.textContent).toContain('ZAY-lahnt');
    expect(fullBadge.querySelector('a.pronunciation-source-link')?.getAttribute('href')).toBe(
      'https://en.wiktionary.org/wiki/Zeeland',
    );
    expect(fullBadge.querySelector('a.pronunciation-source-link')?.textContent).toBe(
      'Wiktionary (Dutch IPA)',
    );

    // Compact badge omits source links and variant buttons
    expect(compactBadge.querySelector('.pronunciation-variants')).toBeNull();
    expect(compactBadge.querySelector('.pronunciation-source')).toBeNull();

    // Switch to the West Michigan variant and play its clip
    const miVariantBtn = Array.from(
      fullBadge.querySelectorAll<HTMLButtonElement>('button.pronunciation-variant-btn'),
    ).find((b) => b.textContent?.trim() === 'West Michigan');
    expect(miVariantBtn).toBeDefined();

    act(() => {
      miVariantBtn!.click();
    });
    expect(fullBadge.textContent).toContain('ZEE-lund');
    expect(fullBadge.textContent).toContain('/ˈziː.lənd/');
    expect(fullBadge.textContent).toContain('Family oral tradition');

    const playBtn = fullBadge.querySelector<HTMLButtonElement>('button.pronunciation-play-btn');
    act(() => {
      playBtn!.click();
    });
    expect(createdAudios).toHaveLength(1);
    expect(createdAudios[0].src).toBe('/audio/zeeland-mi.wav');

    unmount();
  });
});

describe('PersonPage and PlacePage pronunciation mounting & living-person redaction', () => {
  it('renders PronunciationBadge on deceased PersonPage and PlacePage, and redacts for living person', () => {
    const bundle = buildTestBundle();
    // Inject a pronunciation onto the living record to assert UI never renders it
    const livingPerson = bundle.people.find((p) => p.id === 'per_living');
    if (livingPerson) {
      livingPerson.pronunciation = {
        phonetic: 'SHOULD-NOT-SHOW',
        audio_url: '/audio/living.mp3',
      };
    }

    const deceasedRender = renderIntoDom(
      <MemoryRouter initialEntries={['/person/thomas-mercer']}>
        <ArchiveProvider siteConfig={TEST_SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );

    expect(
      deceasedRender.container.querySelector(
        'button[aria-label="Listen to pronunciation of Thomas Mercer"]',
      ),
    ).not.toBeNull();
    // Biography should also render inline entity mentions from PersonPage props
    expect(
      deceasedRender.container.querySelector('a.inline-entity-link[href="/place/leiden"]'),
    ).not.toBeNull();
    expect(
      deceasedRender.container.querySelector('a.inline-entity-link[href="/person/hannah-mercer"]'),
    ).not.toBeNull();
    deceasedRender.unmount();

    const livingRender = renderIntoDom(
      <MemoryRouter initialEntries={['/person/living-relative']}>
        <ArchiveProvider siteConfig={TEST_SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );

    expect(livingRender.container.textContent).not.toContain('SHOULD-NOT-SHOW');
    expect(livingRender.container.querySelector('.pronunciation-badge')).toBeNull();
    livingRender.unmount();

    const placeRender = renderIntoDom(
      <MemoryRouter initialEntries={['/place/leiden']}>
        <ArchiveProvider siteConfig={TEST_SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );

    expect(
      placeRender.container.querySelector(
        'button[aria-label="Listen to pronunciation of Leiden"]',
      ),
    ).not.toBeNull();
    expect(placeRender.container.textContent).toContain('LAY-den');
    placeRender.unmount();
  });

  it('renders compositional full-name pronunciation without prefix clutter and labels surname-only fallbacks as Surname:', () => {
    const composedConfig: KinloomSiteConfig = parseKinloomConfig({
      site: {
        title: 'Mercer Compositional Archive',
        familyName: 'Mercer Family',
        gedcomSourceName: 'MERCER_COMP',
      },
      pronunciations: {
        Thomas: {
          phonetic: 'TOM-us',
          ipa: '/ˈtɒm.əs/',
          language: 'en-US',
          source_label: 'Wiktionary (English IPA)',
        },
        Mercer: {
          phonetic: 'MER-ser',
          ipa: '/ˈmɜːr.sər/',
          language: 'en-US',
          source_label: 'Wiktionary (English IPA)',
        },
      },
    });
    const { bundle } = compileArchive({
      siteConfig: composedConfig,
      mode: 'public',
      people: [
        {
          id: 'per_thomas',
          slug: 'thomas-mercer',
          full_name: 'Thomas Mercer',
          given_name: 'Thomas',
          surname: 'Mercer',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'pivot_ancestor',
          birth_edtf: '1842',
          death_edtf: '1911',
          portrait_url: null,
        },
        {
          id: 'per_barnabas',
          slug: 'barnabas-mercer',
          full_name: 'Barnabas Mercer',
          given_name: 'Barnabas',
          surname: 'Mercer',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1815',
          death_edtf: '1888',
          portrait_url: null,
        },
      ],
      places: [],
      events: [],
      sources: [],
      kinship: [],
    });

    // Full-name compositional match: no single-word prefix clutter, full respelling shown
    const fullRender = renderIntoDom(
      <MemoryRouter initialEntries={['/person/thomas-mercer']}>
        <ArchiveProvider siteConfig={composedConfig} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );
    const fullBadge = fullRender.container.querySelector('.person-pronunciation-row .pronunciation-badge');
    expect(fullBadge?.getAttribute('data-coverage')).toBe('full');
    expect(fullBadge?.querySelector('.pronunciation-prefix')).toBeNull();
    expect(fullBadge?.textContent).toContain('TOM-us MER-ser');
    expect(fullBadge?.textContent).toContain('/ˈtɒm.əs ˈmɜːr.sər/');
    fullRender.unmount();

    // Surname-only fallback: clearly labeled with canonical "Surname:" prefix
    const surnameRender = renderIntoDom(
      <MemoryRouter initialEntries={['/person/barnabas-mercer']}>
        <ArchiveProvider siteConfig={composedConfig} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );
    const surnameBadge = surnameRender.container.querySelector(
      '.person-pronunciation-row .pronunciation-badge',
    );
    expect(surnameBadge?.getAttribute('data-coverage')).toBe('surname');
    expect(surnameBadge?.querySelector('.pronunciation-prefix')?.textContent).toBe('Surname:');
    expect(surnameBadge?.textContent).toContain('MER-ser');
    surnameRender.unmount();
  });
});

describe('EntityEditDrawer pronunciation editing and audio generation', () => {
  it('edits pronunciation fields, generates audio via POST /api/pronunciation/generate, and cleans empty pronunciation on save', async () => {
    const bundle = buildTestBundle();
    const savedSnapshots: EntityPayload[] = [];

    const dataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle, etag: null, notModified: false }),
      loadReadings: async () => null,
      updateEntity: async (_type, _id, input) => {
        savedSnapshots.push(input.data);
        return {
          ok: true,
          entity: input.data,
          revision: {
            revision_id: 2,
            entity_type: 'place',
            entity_id: 'plc_leiden',
            parent_revision_id: 1,
            reverted_revision_id: null,
            batch_id: null,
            action: 'update',
            author_id: 'editor@example.com',
            author_name: 'Editor',
            author_type: 'human',
            summary: input.summary,
            has_primary_source: input.has_primary_source,
            before_json: null,
            after_json: input.data,
            created_at: '2026-11-26T10:00:00Z',
          },
          etag: '"r2"',
        };
      },
    };

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ audio_url: '/audio/generated-leiden.mp3' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { container, unmount } = renderIntoDom(
      <ArchiveProvider
        siteConfig={TEST_SITE_CONFIG}
        initialBundle={bundle}
        dataSource={dataSource}
      >
        <EntityEditDrawer
          open
          entityType="place"
          entityId="plc_leiden"
          revisionId={1}
          initialData={{
            id: 'plc_leiden',
            slug: 'leiden',
            name: 'Leiden',
            full_name: 'Leiden, South Holland',
            place_type: 'town',
            parent_id: null,
            lat: 52.16,
            lng: 4.49,
            pronunciation: null,
          }}
          title="Leiden, South Holland"
          onClose={() => {}}
        />
      </ArchiveProvider>,
    );

    const phoneticInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. MER-ser or LAY-den"]',
    );
    const ipaInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. /ˈmɜːr.sər/"]',
    );
    const langInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. nl, pl, en-US"]',
    );
    expect(phoneticInput).not.toBeNull();
    expect(ipaInput).not.toBeNull();
    expect(langInput).not.toBeNull();

    act(() => {
      setNativeInputValue(phoneticInput!, 'LAY-den');
    });
    act(() => {
      setNativeInputValue(ipaInput!, '/ˈlɛi.də(n)/');
    });
    act(() => {
      setNativeInputValue(langInput!, 'nl');
    });

    // Live preview badge appears
    expect(container.querySelector('.wiki-pronunciation-preview .pronunciation-badge')).not.toBeNull();

    const genBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Generate Audio'),
    );
    expect(genBtn).toBeDefined();

    await act(async () => {
      genBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/pronunciation/generate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      entity_type: 'place',
      entity_id: 'plc_leiden',
      text: 'Leiden',
      phonetic: 'LAY-den',
      ipa: '/ˈlɛi.də(n)/',
      language: 'nl',
    });

    expect(container.textContent).toContain('Regenerate Audio');
    expect(container.textContent).toContain('Pronunciation audio generated');

    // Now clear all pronunciation fields and submit to verify empty pronunciation cleans to null
    const summaryInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Corrected birth year from 1880 census or family Bible"]',
    );
    act(() => {
      setNativeInputValue(phoneticInput!, '');
    });
    act(() => {
      setNativeInputValue(ipaInput!, '');
    });
    act(() => {
      setNativeInputValue(langInput!, '');
    });
    act(() => {
      setNativeInputValue(summaryInput!, 'Updated pronunciation guide');
    });

    const form = container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(container.querySelector('.wiki-error-list')?.textContent ?? null).toBeNull();
    expect(savedSnapshots).toHaveLength(1);
    // audio_url was still set from Generate Audio, so only audio_url remains without empty strings
    expect(savedSnapshots[0].pronunciation).toEqual({
      audio_url: '/audio/generated-leiden.mp3',
    });

    unmount();

    // Also verify clearing all pronunciation fields (with no audio_url) saves pronunciation: null
    const emptySaveSnapshots: EntityPayload[] = [];
    const emptyDataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle, etag: null, notModified: false }),
      loadReadings: async () => null,
      updateEntity: async (_type, _id, input) => {
        emptySaveSnapshots.push(input.data);
        return {
          ok: true,
          entity: input.data,
          revision: {
            revision_id: 3,
            entity_type: 'place',
            entity_id: 'plc_oxford',
            parent_revision_id: 1,
            reverted_revision_id: null,
            batch_id: null,
            action: 'update',
            author_id: 'editor@example.com',
            author_name: 'Editor',
            author_type: 'human',
            summary: input.summary,
            has_primary_source: input.has_primary_source,
            before_json: null,
            after_json: input.data,
            created_at: '2026-11-26T10:05:00Z',
          },
          etag: '"r3"',
        };
      },
    };

    const secondRender = renderIntoDom(
      <ArchiveProvider
        siteConfig={TEST_SITE_CONFIG}
        initialBundle={bundle}
        dataSource={emptyDataSource}
      >
        <EntityEditDrawer
          open
          entityType="place"
          entityId="plc_oxford"
          revisionId={1}
          initialData={{
            id: 'plc_oxford',
            slug: 'oxford',
            name: 'Oxford',
            full_name: 'Oxford, Massachusetts',
            place_type: 'town',
            parent_id: null,
            lat: 42.11,
            lng: -71.87,
            pronunciation: { phonetic: 'OX-ferd' },
          }}
          title="Oxford, Massachusetts"
          onClose={() => {}}
        />
      </ArchiveProvider>,
    );

    const oxfordPhonetic = secondRender.container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. MER-ser or LAY-den"]',
    );
    const oxfordSummary = secondRender.container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Corrected birth year from 1880 census or family Bible"]',
    );
    act(() => {
      setNativeInputValue(oxfordPhonetic!, '   ');
      setNativeInputValue(oxfordSummary!, 'Cleared phonetic pronunciation');
    });

    const oxfordForm = secondRender.container.querySelector('form')!;
    await act(async () => {
      oxfordForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(emptySaveSnapshots).toHaveLength(1);
    expect(emptySaveSnapshots[0].pronunciation).toBeNull();
    secondRender.unmount();
  });

  it('edits shared surname pronunciation via PUT /api/pronunciations/:term and updates ArchiveDataContext live', async () => {
    const sharedSiteConfig: KinloomSiteConfig = parseKinloomConfig({
      site: {
        title: 'Mercer Synthetic Archive',
        familyName: 'Mercer Family',
        gedcomSourceName: 'MERCER_TEST',
      },
      pronunciations: {
        Mercer: {
          phonetic: 'MER-ser',
          ipa: '/ˈmɜːr.sər/',
          language: 'en-US',
        },
      },
    });
    const bundle = buildTestBundle();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/pronunciations/Mercer' && init?.method === 'PUT') {
        return new Response(
          JSON.stringify({
            term: 'Mercer',
            pronunciation: {
              phonetic: 'MUR-ser',
              ipa: '/ˈmɜːr.sər/',
              language: 'en-US',
              audio_url: '/audio/shared-mercer.mp3',
            },
            pronunciations: {
              Mercer: {
                phonetic: 'MUR-ser',
                ipa: '/ˈmɜːr.sər/',
                language: 'en-US',
                audio_url: '/audio/shared-mercer.mp3',
              },
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response(JSON.stringify({ pronunciations: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const LexiconProbe: React.FC = () => {
      const { pronunciations } = useArchiveData();
      return (
        <div data-testid="lexicon-probe">
          {pronunciations.Mercer?.phonetic ?? 'none'}|{pronunciations.Mercer?.audio_url ?? ''}
        </div>
      );
    };

    const { container, unmount } = renderIntoDom(
      <ArchiveProvider siteConfig={sharedSiteConfig} initialBundle={bundle}>
        <LexiconProbe />
        <EntityEditDrawer
          open
          entityType="person"
          entityId="per_thomas"
          revisionId={1}
          initialData={{
            id: 'per_thomas',
            slug: 'thomas-mercer',
            full_name: 'Thomas Mercer',
            given_name: 'Thomas',
            surname: 'Mercer',
            alt_names: [],
            sex: 'M',
            is_living: false,
            lineage_group: 'pivot_ancestor',
            birth_edtf: '1842-05-10',
            death_edtf: '1911-08-19',
            portrait_url: null,
            pronunciation: null,
          }}
          title="Thomas Mercer"
          onClose={() => {}}
        />
      </ArchiveProvider>,
    );

    expect(container.textContent).toContain('Personal override (first / middle / full name)');
    expect(container.querySelector('[data-testid="lexicon-probe"]')?.textContent).toBe('MER-ser|');

    const editSharedBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Edit shared "Mercer"',
    );
    expect(editSharedBtn).toBeDefined();

    act(() => {
      editSharedBtn!.click();
    });

    const sharedEditor = container.querySelector('.wiki-pronunciation-shared-editor');
    expect(sharedEditor).not.toBeNull();

    const sharedPhoneticInput = sharedEditor!.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. MER-ser"]',
    );
    expect(sharedPhoneticInput).not.toBeNull();
    expect(sharedPhoneticInput!.value).toBe('MER-ser');

    act(() => {
      setNativeInputValue(sharedPhoneticInput!, 'MUR-ser');
    });

    const saveSharedBtn = Array.from(sharedEditor!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save for all Mercer records',
    );
    expect(saveSharedBtn).toBeDefined();

    await act(async () => {
      saveSharedBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const putCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/pronunciations/Mercer' && init?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    expect(putCall![1]?.credentials).toBe('include');
    expect(JSON.parse(String(putCall![1]?.body))).toEqual({
      phonetic: 'MUR-ser',
      ipa: '/ˈmɜːr.sər/',
      language: 'en-US',
    });

    // Context and breakdown card both update live without reload
    expect(container.querySelector('[data-testid="lexicon-probe"]')?.textContent).toBe(
      'MUR-ser|/audio/shared-mercer.mp3',
    );
    expect(container.querySelector('.wiki-pronunciation-part-shared')?.textContent).toContain(
      'MUR-ser',
    );
    expect(container.textContent).toContain('Saved shared pronunciation for "Mercer"');

    unmount();
  });
});

describe('ArchivalMarkdown inline entity mentions and hover popovers', () => {
  it('supports explicit [[place:...]]/[[person:...]], auto-linking, hover popover, Escape close, and inline audio playback', () => {
    const bundle = buildTestBundle();
    const peopleById = new Map<string, Person>(bundle.people.map((p) => [p.id, p]));
    const placesById = new Map<string, Place>(bundle.places.map((p) => [p.id, p]));

    const playMock = vi.fn(() => Promise.resolve());
    class MockAudio {
      src: string;
      currentTime = 0;
      play = playMock;
      pause = vi.fn();
      constructor(src: string) {
        this.src = src;
      }
      addEventListener(): void {}
    }
    vi.stubGlobal('Audio', MockAudio);

    const markdown = [
      'Thomas Mercer lived in [[place:plc_leiden|old Leiden]] with [[person:per_hannah]] and [[person:per_living]].',
      '',
      'Later Hannah Mercer moved from Oxford Township to Oxford Township, then visited Oxford and Leiden.',
    ].join('\n');

    const { container, unmount } = renderIntoDom(
      <MemoryRouter>
        <ArchivalMarkdown
          markdown={markdown}
          subjectPersonId="per_thomas"
          peopleById={peopleById}
          placesById={placesById}
          linkedPersonIds={['per_thomas', 'per_hannah', 'per_living']}
          linkedPlaceIds={['plc_oxford_twp', 'plc_oxford']}
          baseUrl="/"
        />
      </MemoryRouter>,
    );

    // Subject person (Thomas Mercer) is NOT auto-highlighted
    const allEntityLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.inline-entity-link'));
    expect(allEntityLinks.some((a) => a.textContent === 'Thomas Mercer')).toBe(false);

    // Living person explicit syntax is redacted to plain 'Living'
    expect(allEntityLinks.some((a) => a.getAttribute('href')?.includes('living'))).toBe(false);
    expect(container.textContent).toContain('Living');

    // Explicit [[place:plc_leiden|old Leiden]] and [[person:per_hannah]]
    const explicitLeiden = allEntityLinks.find((a) => a.textContent === 'old Leiden');
    expect(explicitLeiden?.getAttribute('href')).toBe('/place/leiden');

    // Second paragraph: longest match first (Oxford Township before Oxford), first occurrence per paragraph
    const oxfordTwpLinks = allEntityLinks.filter((a) => a.textContent === 'Oxford Township');
    expect(oxfordTwpLinks).toHaveLength(1);
    expect(oxfordTwpLinks[0].getAttribute('href')).toBe('/place/oxford-township');

    const oxfordLinks = allEntityLinks.filter((a) => a.textContent === 'Oxford');
    expect(oxfordLinks).toHaveLength(1);
    expect(oxfordLinks[0].getAttribute('href')).toBe('/place/oxford');

    // Leiden has pronunciation so it auto-links in paragraph 2 even though not in linkedPlaceIds
    const autoLeiden = allEntityLinks.find((a) => a.textContent === 'Leiden');
    expect(autoLeiden?.getAttribute('href')).toBe('/place/leiden');

    // Inline speaker button beside Leiden plays audio in one click
    const inlinePlayBtn = container.querySelector<HTMLButtonElement>(
      '.inline-entity-pronunciation button[aria-label="Listen to pronunciation of Leiden"]',
    );
    expect(inlinePlayBtn).not.toBeNull();
    act(() => {
      inlinePlayBtn!.click();
    });
    expect(playMock).toHaveBeenCalledTimes(1);

    // Hovering / focusing an entity link opens the hover popover card
    act(() => {
      explicitLeiden!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const popover = document.body.querySelector<HTMLDivElement>('.entity-popover[role="dialog"]');
    expect(popover).not.toBeNull();
    expect(popover!.textContent).toContain('Leiden, South Holland');
    expect(popover!.textContent).toContain('Town');
    expect(popover!.textContent).toContain('LAY-den');
    expect(popover!.querySelector('a[href="/place/leiden"]')?.textContent).toContain('View profile');

    // Escape closes the popover
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('.entity-popover')).toBeNull();

    unmount();
  });
});

describe('Live-lexicon partial-update merge regression (PersonPage + EntityEditDrawer + InlineEntityMention)', () => {
  it('immediately updates PersonPage heading badge and inline mentions with zero stale fields when shared surname lexicon is edited', async () => {
    const configWithSharedSurname: KinloomSiteConfig = parseKinloomConfig({
      site: {
        title: 'Mercer Synthetic Archive',
        familyName: 'Mercer Family',
        gedcomSourceName: 'MERCER_LIVE_TEST',
      },
      pronunciations: {
        Mercer: {
          phonetic: 'MER-ser-OLD',
          ipa: '/ˈmɜːr.sər.old/',
          language: 'nl',
        },
      },
    });

    // Compile archive from raw people that have NO personal pronunciation override
    const { bundle } = compileArchive({
      siteConfig: configWithSharedSurname,
      mode: 'private',
      people: [
        {
          id: 'per_thomas',
          slug: 'thomas-mercer',
          full_name: 'Thomas Mercer',
          given_name: 'Thomas',
          surname: 'Mercer',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'pivot_ancestor',
          birth_edtf: '1842-05-10',
          death_edtf: '1911-08-19',
          portrait_url: null,
        },
        {
          id: 'per_hannah',
          slug: 'hannah-mercer',
          full_name: 'Hannah Mercer',
          given_name: 'Hannah',
          surname: 'Mercer',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'pivot_ancestor',
          birth_edtf: '1846-09-02',
          death_edtf: '1920-01-15',
          portrait_url: null,
        },
      ],
      places: [],
      events: [],
      sources: [],
      kinship: [],
      narratives: [
        {
          id: 'nar_thomas',
          slug: 'thomas-bio',
          kind: 'biography',
          subject_person_id: 'per_thomas',
          title: 'Thomas Mercer',
          body_md: 'Thomas worked alongside [[person:per_hannah|Hannah Mercer]].',
          person_ids: ['per_thomas', 'per_hannah'],
          place_ids: [],
          event_ids: [],
          source_ids: [],
        },
      ],
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/pronunciations/Mercer' && init?.method === 'PUT') {
        return new Response(
          JSON.stringify({
            term: 'Mercer',
            pronunciation: {
              phonetic: 'MUR-ser-NEW',
              ipa: '/ˈmɜːr.sər.new/',
              language: 'en-US',
              note: 'Updated family pronunciation note',
              source_label: 'Family oral tradition',
              audio_url: '/media/pronunciation-new.wav',
            },
            pronunciations: {
              Mercer: {
                phonetic: 'MUR-ser-NEW',
                ipa: '/ˈmɜːr.sər.new/',
                language: 'en-US',
                note: 'Updated family pronunciation note',
                source_label: 'Family oral tradition',
                audio_url: '/media/pronunciation-new.wav',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/pronunciations') {
        return new Response(
          JSON.stringify({
            pronunciations: configWithSharedSurname.pronunciations,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container, unmount } = renderIntoDom(
      <MemoryRouter initialEntries={['/person/thomas-mercer']}>
        <ArchiveProvider
          siteConfig={configWithSharedSurname}
          initialBundle={bundle}
          capabilities={{ canEdit: true }}
        >
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );

    const headingRow = container.querySelector('.person-pronunciation-row')!;
    expect(headingRow.textContent).toContain('MER-ser-OLD');
    expect(headingRow.textContent).toContain('/ˈmɜːr.sər.old/');

    // Open Edit drawer via the Edit button on the pronunciation row
    const editBtn = headingRow.querySelector<HTMLButtonElement>('button.pronunciation-edit-link');
    expect(editBtn).not.toBeNull();
    act(() => {
      editBtn!.click();
    });

    const editSharedBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Edit shared "Mercer"',
    );
    expect(editSharedBtn).toBeDefined();
    act(() => {
      editSharedBtn!.click();
    });

    const sharedEditor = container.querySelector('.wiki-pronunciation-shared-editor')!;
    const phoneticInput = sharedEditor.querySelector<HTMLInputElement>('input[placeholder="e.g. MER-ser"]')!;
    const ipaInput = sharedEditor.querySelector<HTMLInputElement>('input[placeholder="e.g. /ˈmɜːr.sər/"]')!;
    const langInput = sharedEditor.querySelector<HTMLInputElement>('input[placeholder="e.g. en-US, nl, pl"]')!;
    const noteInput = sharedEditor.querySelector<HTMLInputElement>('input[placeholder="e.g. Stress on first syllable"]')!;

    act(() => {
      setNativeInputValue(phoneticInput, 'MUR-ser-NEW');
      setNativeInputValue(ipaInput, '/ˈmɜːr.sər.new/');
      setNativeInputValue(langInput, 'en-US');
      setNativeInputValue(noteInput, 'Updated family pronunciation note');
    });

    const saveSharedBtn = Array.from(sharedEditor.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save for all Mercer records',
    )!;

    await act(async () => {
      saveSharedBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // PersonPage heading badge MUST show NEW phonetic, NEW IPA, NEW language, NEW note, and ZERO old fields
    const updatedHeadingRow = container.querySelector('.person-pronunciation-row')!;
    expect(updatedHeadingRow.textContent).toContain('MUR-ser-NEW');
    expect(updatedHeadingRow.textContent).toContain('/ˈmɜːr.sər.new/');
    expect(updatedHeadingRow.textContent).toContain('en-US');
    expect(updatedHeadingRow.textContent).toContain('Updated family pronunciation note');
    expect(updatedHeadingRow.textContent).toContain('Family oral tradition');
    expect(updatedHeadingRow.textContent).not.toContain('MER-ser-OLD');
    expect(updatedHeadingRow.textContent).not.toContain('/ˈmɜːr.sər.old/');

    // Hover Hannah Mercer's inline mention and verify its popover ALSO shows the NEW live pronunciation
    const hannahLink = container.querySelector<HTMLAnchorElement>(
      'a.inline-entity-link[href="/person/hannah-mercer"]',
    );
    expect(hannahLink).not.toBeNull();
    act(() => {
      hannahLink!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const popover = document.body.querySelector<HTMLDivElement>('.entity-popover[role="dialog"]');
    expect(popover).not.toBeNull();
    expect(popover!.textContent).toContain('MUR-ser-NEW');
    expect(popover!.textContent).not.toContain('MER-ser-OLD');

    unmount();
  });
});
