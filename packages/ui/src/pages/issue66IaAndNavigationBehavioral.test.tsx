/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, ReadingsBundle } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRecentlyViewed, recordRecentlyViewed } from '../browser/recentlyViewed.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { GlobalSearchModal } from '../components/GlobalSearchModal.js';
import { SourceReaderDrawer } from '../components/SourceReaderDrawer.js';
import { TreeFocusDrawer } from '../components/tree/TreeFocusDrawer.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { buildArchivalTreeModel } from '../lib/archivalTreeModel.js';
import { PersonPage } from './PersonPage.js';
import { PlacePage } from './PlacePage.js';

function must<T>(val: T | undefined, label = 'value'): T {
  if (val === undefined) throw new Error(`Expected ${label}`);
  return val;
}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Hale Family Archive',
    familyName: 'Hale',
    gedcomSourceName: 'HALE_IA_TEST',
  },
  branches: [{ id: 'main', label: 'Main Line' }],
});

const { bundle: TEST_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'private',
  places: [
    {
      id: 'pl_1',
      slug: 'zeeland',
      name: 'Zeeland',
      full_name: 'Zeeland, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.8125,
      lng: -86.0186,
    },
  ],
  sources: [
    {
      id: 'src_diary',
      citation: 'Hale Farm Diary, 1874',
      source_type: 'diary',
    },
  ],
  people: [
    {
      id: 'per_samuel',
      slug: 'samuel-hale',
      full_name: 'Samuel Hale',
      given_name: 'Samuel',
      surname: 'Hale',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'main',
      birth_edtf: '1840',
      death_edtf: '1918',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_barn',
      title: 'Barn Raising at Zeeland',
      summary: 'Neighbors raised the timber barn.',
      event_kind: 'point_event',
      scope: 'family',
      edtf_date: '1874-06-10',
      place_id: 'pl_1',
      participants: [{ person_id: 'per_samuel', role: 'owner' }],
      sources: [{ source_id: 'src_diary', confidence: 'high' }],
    },
  ],
  kinship: [],
  media: [],
  narratives: [],
});

const TEST_READINGS: ReadingsBundle = {
  version: 1,
  event_page_map: {
    evt_barn: { src_diary: 2 },
  },
  documents: {
    src_diary: {
      source_id: 'src_diary',
      title: 'Hale Farm Diary',
      author: 'Samuel Hale',
      provenance: 'Family collection',
      pages: [
        { page: 1, label: 'Page 1', file: 'p1.txt', text: 'Spring planting.' },
        {
          page: 2,
          label: 'Page 2',
          file: 'p2.txt',
          text: 'June 10, 1874: Raised the timber barn in Zeeland.',
        },
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

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

const SearchAndReaderHarness: React.FC = () => {
  const { openSearch, openSourceReader } = useArchiveUi();
  return (
    <>
      <button type="button" onClick={openSearch}>
        Trigger Search
      </button>
      <button
        type="button"
        onClick={() => {
          openSourceReader({ sourceId: 'src_diary', page: 2 });
        }}
      >
        Trigger Reader
      </button>
      <GlobalSearchModal />
      <SourceReaderDrawer />
    </>
  );
};

describe('Issue #66: IA topbar grouping, semantic disclosure, cross-object links, Cited by, and Recently viewed', () => {
  it('groups Object Directories before Lenses, uses Reading Room trigger, and renders semantic disclosure list without role=menuitem', async () => {
    const container = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const navLinks = Array.from(container.querySelectorAll('nav[aria-label="Primary"] a')).map((a) =>
      a.textContent?.trim()
    );
    expect(navLinks.slice(0, 7)).toEqual(['People', 'Places', 'Evidence', 'Time', 'Tree', 'Map', 'Kinship']);

    // Slide-over reader trigger is renamed to Reading Room
    const readingRoomBtn = Array.from(container.querySelectorAll('header button')).find(
      (b) => b.textContent?.trim() === 'Reading Room'
    );
    expect(readingRoomBtn).toBeDefined();

    // Mobile archive disclosure opens a semantic <ul> without role="menu" or role="menuitem"
    const menuTrigger = container.querySelector(
      'button[aria-label="Archive menu"]'
    ) as HTMLButtonElement | null;
    expect(menuTrigger?.getAttribute('aria-haspopup')).toBeNull();
    expect(menuTrigger?.getAttribute('aria-controls')).toBeTruthy();
    act(() => {
      menuTrigger?.click();
    });
    await flushUi();

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[role="menuitem"]')).toBeNull();
    const listItems = container.querySelectorAll('nav[aria-label="Archive menu"] ul li');
    expect(listItems.length).toBeGreaterThanOrEqual(3);
  });

  it('adds In Tree and Trace Kinship links on PersonPage, links Primary place in TreeFocusDrawer, and renders Cited by in SourceReaderDrawer', async () => {
    const personEl = mountEl(
      <MemoryRouter initialEntries={['/person/samuel-hale']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const hrefs = Array.from(personEl.querySelectorAll('header a')).map((a) => ({
      href: a.getAttribute('href'),
      text: a.textContent?.trim(),
    }));
    expect(hrefs).toContainEqual({ href: '/tree?focus=samuel-hale', text: 'In Tree' });
    expect(hrefs).toContainEqual({ href: '/kinship?from=samuel-hale', text: 'Trace Kinship' });

    // TreeFocusDrawer links Primary place to /place/zeeland
    const model = buildArchivalTreeModel({
      people: TEST_BUNDLE.people,
      kinship: TEST_BUNDLE.kinship,
      mode: 'full',
      expandedUnionIds: new Set(),
    });
    const drawerEl = mountEl(
      <MemoryRouter>
        <TreeFocusDrawer
          person={must(TEST_BUNDLE.people[0])}
          model={model}
          spotlight={null}
          placesById={new Map(TEST_BUNDLE.places.map((p) => [p.id, p]))}
          thumbUrl={null}
          baseUrl=""
          onSelectPerson={vi.fn()}
          onClearFocus={vi.fn()}
        />
      </MemoryRouter>
    );
    await flushUi();
    const placeLink = drawerEl.querySelector('a[href="/place/zeeland"]');
    expect(placeLink?.textContent).toContain('Zeeland');

    // SourceReaderDrawer renders Cited by strip and <kbd>Esc</kbd>
    const readerEl = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE} initialReadings={TEST_READINGS}>
          <SearchAndReaderHarness />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const openReaderBtn = Array.from(readerEl.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Trigger Reader'
    );
    act(() => {
      openReaderBtn?.click();
    });
    await flushUi();

    const citedByNav = readerEl.querySelector('nav[aria-label="Cited by"]');
    expect(citedByNav).not.toBeNull();
    expect(citedByNav?.textContent).toContain('Samuel Hale');
    expect(citedByNav?.textContent).toContain('Barn Raising at Zeeland');
    expect(readerEl.querySelector('a[href="/person/samuel-hale?event=evt_barn"]')).not.toBeNull();
    expect(readerEl.querySelector('dialog kbd')?.textContent).toBe('Esc');
  });

  it('persists last 5 recently viewed Person/Place profiles and surfaces them in zero-query GlobalSearchModal', async () => {
    for (let i = 1; i <= 6; i += 1) {
      recordRecentlyViewed({ kind: 'person', slug: `p-${i}`, label: `Person ${i}`, meta: `18${i}0–19${i}0` });
    }
    const stored = readRecentlyViewed();
    expect(stored).toHaveLength(5);
    expect(stored[0]?.slug).toBe('p-6');

    // Visiting PlacePage records the place in recentlyViewed
    mountEl(
      <MemoryRouter initialEntries={['/place/zeeland']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const searchEl = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <SearchAndReaderHarness />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const openSearchBtn = Array.from(searchEl.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Trigger Search'
    );
    act(() => {
      openSearchBtn?.click();
    });
    await flushUi();

    expect(searchEl.textContent).toContain('Recently viewed');
    expect(searchEl.textContent).toContain('Zeeland');
  });
});

describe('Issue #66: recentlyViewed edge cases and GlobalSearchModal navigation', () => {
  it('handles corrupt/non-array localStorage, blank entries, storage errors, and clicking recently viewed items', async () => {
    window.localStorage.setItem('kinloom:recently-viewed:v1', '{not-json');
    expect(readRecentlyViewed()).toEqual([]);

    window.localStorage.setItem('kinloom:recently-viewed:v1', JSON.stringify({ invalid: true }));
    expect(readRecentlyViewed()).toEqual([]);

    window.localStorage.setItem(
      'kinloom:recently-viewed:v1',
      JSON.stringify([
        null,
        { kind: 'invalid', slug: 'x', label: 'X' },
        { kind: 'person', slug: '', label: 'Blank' },
        { kind: 'place', slug: 'zeeland', label: 'Zeeland', meta: 'Ottawa County' },
      ])
    );
    expect(readRecentlyViewed()).toEqual([
      { kind: 'place', slug: 'zeeland', label: 'Zeeland', meta: 'Ottawa County' },
    ]);

    // Blank slug/label is ignored
    expect(recordRecentlyViewed({ kind: 'person', slug: '  ', label: 'Nobody' })).toHaveLength(1);

    // Clicking a recently viewed chip in GlobalSearchModal closes the modal and navigates
    const searchEl = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <SearchAndReaderHarness />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const triggerBtn = Array.from(searchEl.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Trigger Search'
    );
    act(() => {
      triggerBtn?.click();
    });
    await flushUi();

    const recentChip = Array.from(searchEl.querySelectorAll<HTMLButtonElement>('dialog button')).find((b) =>
      b.textContent?.includes('Zeeland')
    );
    expect(recentChip).toBeDefined();
    act(() => {
      recentChip?.click();
    });
    await flushUi();
    expect(searchEl.querySelector('dialog[open]')).toBeNull();

    // Storage write error fails safely without throwing
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() =>
      recordRecentlyViewed({ kind: 'person', slug: 'samuel-hale', label: 'Samuel Hale' })
    ).not.toThrow();
    spy.mockRestore();
  });
});
