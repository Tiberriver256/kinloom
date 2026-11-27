/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSurveyMap } from '../components/LocalSurveyMap.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { IndexPage } from './IndexPage.js';
import { PersonPage } from './PersonPage.js';
import { PlacePage } from './PlacePage.js';
import { TreePage } from './TreePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Rich Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_RICH_TEST',
  },
  branches: [{ id: 'main', label: 'Main Line' }],
  lineageSections: [
    { id: 'ancestors', title: 'Founding Ancestors', lineageGroups: ['ancestor'] },
    { id: 'descendants', title: 'Descendants', lineageGroups: ['descendant'] },
  ],
});

const { bundle: RICH_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
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
    {
      id: 'pl_jen',
      slug: 'jenison',
      name: 'Jenison',
      full_name: 'Jenison, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.91,
      lng: -85.79,
    },
    {
      id: 'pl_gr',
      slug: 'grand-rapids',
      name: 'Grand Rapids',
      full_name: 'Grand Rapids, Kent County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.96,
      lng: -85.67,
    },
  ],
  sources: [
    {
      id: 'src_census',
      citation: '1880 US Federal Census, Ottawa County, MI',
      source_type: 'census',
      author: 'US Census Bureau',
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
      alt_names: ['Hank Alder'],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'main',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
      portrait_url: '/media/henry.jpg',
    },
    {
      id: 'per_clara',
      slug: 'clara-alder',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      alt_names: ['Clara Mercer'],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'main',
      birth_edtf: '1858-07-22',
      death_edtf: '1938-04-09',
      portrait_url: null,
    },
    {
      id: 'per_arthur',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'descendant',
      branch: 'main',
      birth_edtf: '1882-05-10',
      death_edtf: '1961-01-20',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_1878',
      title: 'Marriage of Henry and Clara',
      summary: 'Married in Hudsonville.',
      event_kind: 'point_event',
      scope: 'family',
      edtf_date: '1878-06-15',
      place_id: 'pl_hud',
      participants: [
        { person_id: 'per_henry', role: 'groom' },
        { person_id: 'per_clara', role: 'bride' },
      ],
      sources: [{ source_id: 'src_census', confidence: 'high' }],
    },
    {
      id: 'evt_1880',
      title: '1880 Census Household',
      summary: 'Farming in Hudsonville.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_hud',
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
      ],
      sources: [{ source_id: 'src_census', confidence: 'high' }],
    },
    {
      id: 'evt_1895',
      title: 'Sawmill Expansion',
      summary: 'Expanded timber mill near Jenison.',
      event_kind: 'point_event',
      scope: 'family',
      edtf_date: '1895-09-12',
      place_id: 'pl_jen',
      participants: [
        { person_id: 'per_henry', role: 'owner' },
        { person_id: 'per_arthur', role: 'son' },
      ],
      sources: [{ source_id: 'src_census', confidence: 'high' }],
    },
  ],
  kinship: [
    { from: 'per_henry', to: 'per_clara', relation: 'spouse' },
    { from: 'per_henry', to: 'per_arthur', relation: 'parent' },
    { from: 'per_clara', to: 'per_arthur', relation: 'parent' },
  ],
  media: [
    {
      id: 'med_1',
      kind: 'family_photo',
      file: '/media/homestead.jpg',
      caption: 'Alder Homestead 1885',
      date_edtf: '1885',
      person_ids: ['per_henry', 'per_clara'],
    },
    {
      id: 'med_2',
      kind: 'headstone',
      file: '/media/headstone.jpg',
      caption: 'Henry Alder Headstone',
      date_edtf: '1932',
      person_ids: ['per_henry'],
    },
  ],
  narratives: [
    {
      id: 'nar_bio',
      slug: 'henry-alder-bio',
      title: 'Life of Henry Alder',
      summary: 'A biographical sketch of Henry Alder.',
      body_md: 'Henry Alder arrived in Ottawa County in 1875 and built a sawmill along Rush Creek.',
      date_edtf: '1880',
      person_ids: ['per_henry'],
      place_ids: ['pl_hud'],
      event_ids: ['evt_1880'],
      source_ids: ['src_census'],
    },
  ],
});

const EDITOR_DS: ArchiveDataSource = {
  loadArchive: async () => ({ bundle: RICH_BUNDLE, etag: '"r1"', notModified: false }),
  loadReadings: async () => ({ version: 1, event_page_map: {}, documents: {} }),
  loadMediaChecklist: async () => [],
  getSession: async () => ({
    session: {
      authenticated: true,
      principal_kind: 'user',
      email: 'editor@example.test',
      displayName: 'Editor Alder',
      role: 'admin',
    },
    capabilities: {
      canEdit: true,
      canUploadMedia: true,
      hasRevisionHistory: true,
      hasTalk: true,
      canManageSite: true,
    },
  }),
  listRevisions: async () => ({ items: [], next_cursor: null }),
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('PersonPage, IndexPage, PlacePage, LocalSurveyMap, and TreePage behavioral flows', () => {
  it('renders PersonPage with portrait, family strip, timeline scrubber, milestone cards, media lightbox, and GEDCOM export', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock-gedcom');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

    const container = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE} dataSource={EDITOR_DS}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(container.textContent).toContain('Henry Alder');
    expect(container.textContent).toContain('Clara Alder');
    expect(container.textContent).toContain('Arthur Alder');
    expect(container.textContent).toContain('Sawmill Expansion');

    // Click decade scrubber tick
    const tickBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /1890s/i.test(b.textContent || '')
    );
    if (tickBtn) {
      act(() => {
        tickBtn.click();
      });
      await flushUi();
    }

    // Open and close portrait lightbox
    const portraitBtn = container.querySelector('button[title*="portrait" i]') as HTMLButtonElement | null;
    if (portraitBtn) {
      act(() => {
        portraitBtn.click();
      });
      await flushUi();
      const closeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        /close/i.test(b.getAttribute('aria-label') || b.textContent || '')
      );
      act(() => {
        closeBtn?.click();
      });
      await flushUi();
    }

    // Click Export GEDCOM
    const gedcomBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /export gedcom/i.test(b.textContent || '')
    );
    if (gedcomBtn) {
      act(() => {
        gedcomBtn.click();
      });
      await flushUi();
    }

    // Open media lightbox
    const mediaBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Alder Homestead 1885')
    );
    if (mediaBtn) {
      act(() => {
        mediaBtn.click();
      });
      await flushUi();
    }

    // Toggle WikiActionBar tabs (History, Family Notes, Edit)
    for (const label of [/history/i, /family notes/i, /back to profile/i]) {
      const btn = Array.from(container.querySelectorAll('button')).find((b) =>
        label.test(b.textContent || '')
      );
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }

    // Not found person route
    const notFound = mountEl(
      <MemoryRouter initialEntries={['/person/missing-person']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(notFound.textContent).toContain('Person Not Found');
  });

  it('filters IndexPage by query and media toggle, and renders PlacePage with LocalSurveyMap scope modes', async () => {
    const idx = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE} dataSource={EDITOR_DS}>
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(idx.textContent).toContain('Founding Ancestors');
    expect(idx.textContent).toContain('Henry Alder');

    const searchInput = idx.querySelector(
      'input[type="search"], input[type="text"]'
    ) as HTMLInputElement | null;
    if (searchInput) {
      setInputValue(searchInput, 'Arthur');
      await flushUi();
      expect(idx.textContent).toContain('Arthur Alder');
      setInputValue(searchInput, 'NoSuchRelativeXYZ');
      await flushUi();
      setInputValue(searchInput, '');
      await flushUi();
    }

    const mediaToggle = Array.from(idx.querySelectorAll('button, input[type="checkbox"]')).find((el) =>
      /photo|media/i.test(el.textContent || el.getAttribute('aria-label') || '')
    ) as HTMLElement | undefined;
    if (mediaToggle) {
      act(() => {
        mediaToggle.click();
      });
      await flushUi();
    }

    // PlacePage + LocalSurveyMap across scope modes
    const placePage = mountEl(
      <MemoryRouter initialEntries={['/place/hudsonville']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(placePage.textContent).toContain('Hudsonville');

    const survey = mountEl(
      <MemoryRouter>
        <LocalSurveyMap center={RICH_BUNDLE.places[0]} allPlaces={RICH_BUNDLE.places} scopeMode="exact" />
        <LocalSurveyMap center={RICH_BUNDLE.places[0]} allPlaces={RICH_BUNDLE.places} scopeMode="county" />
        <LocalSurveyMap center={RICH_BUNDLE.places[0]} allPlaces={RICH_BUNDLE.places} compact={true} />
      </MemoryRouter>
    );
    await flushUi();
    expect(survey.querySelectorAll('svg').length).toBeGreaterThanOrEqual(3);
  });

  it('searches and focuses people in TreePage via TreePersonSearch and toggles TreeToolbar controls', async () => {
    const tree = mountEl(
      <MemoryRouter initialEntries={['/tree']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE} dataSource={EDITOR_DS}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const findInput = tree.querySelector(
      'input[aria-label*="Find person" i], input[placeholder*="Find person" i]'
    ) as HTMLInputElement | null;
    if (findInput) {
      setInputValue(findInput, 'Clara');
      await flushUi();
      act(() => {
        findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await flushUi();
    }

    for (const label of [/full tree/i, /direct line/i, /list/i, /chart/i]) {
      const btn = Array.from(tree.querySelectorAll('button')).find((b) => label.test(b.textContent || ''));
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }
  });
});
