/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, ReadingsBundle } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchivalPhotoFrame, SourceCitationTag } from '../components/Atoms.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { GlobalSearchModal } from '../components/GlobalSearchModal.js';
import { SourceInspectorDrawer } from '../components/SourceInspectorDrawer.js';
import { SourceReaderDrawer } from '../components/SourceReaderDrawer.js';
import { EntityEditDrawer } from '../components/wiki/EntityEditDrawer.js';
import { TalkPanel } from '../components/wiki/TalkPanel.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { KinloomApp } from '../KinloomApp.js';
import { AdminPage } from './AdminPage.js';
import { EvidencePage } from './EvidencePage.js';
import { IndexPage } from './IndexPage.js';
import { KinshipPage } from './KinshipPage.js';
import { PersonPage } from './PersonPage.js';
import { PlacePage } from './PlacePage.js';
import { PlacesIndexPage } from './PlacesIndexPage.js';
import { RecentChangesPage } from './RecentChangesPage.js';
import { TimePage } from './TimePage.js';
import { TreePage } from './TreePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder States Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_STATES_TEST',
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
      author: 'C. Vance',
      has_primary_source: true,
      url: 'https://example.test/ottawa',
    },
    {
      id: 'src_oral',
      citation: 'Oral Tradition',
      source_type: 'family_tree',
      has_primary_source: false,
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
      birth_edtf: '1882-05-10',
      death_edtf: '1961-01-20',
      portrait_url: null,
    },
    {
      id: 'per_edith',
      slug: 'edith-alder',
      full_name: 'Edith Alder',
      given_name: 'Edith',
      surname: 'Alder',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'descendant',
      birth_edtf: '1884-09-01',
      death_edtf: '1965-03-10',
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
      sources: [
        {
          source_id: 'src_book',
          confidence: 'high',
          citation_detail: 'p. 12',
          scan_url: '/sources/p1.jpg',
          scan_title: 'Page 1 Scan',
        },
      ],
      alternate_dates: [{ edtf_date: '1881', source_id: 'src_book', note: 'Tax roll' }],
      alternate_places: [{ place_name: 'Georgetown', source_id: 'src_book', note: 'Deed' }],
      fact_conflicts: [{ claim: '40 acres', source_id: 'src_book', note: 'Plat 38 acres' }],
    },
    ...Array.from({ length: 28 }, (_, i) => ({
      id: `evt_uncited_${i}`,
      title: `Uncited Note ${i}`,
      summary: 'Family recollection.',
      event_kind: 'point_event' as const,
      scope: 'family' as const,
      edtf_date: `${1885 + (i % 10)}`,
      place_id: 'pl_hud',
      participants: [{ person_id: 'per_henry', role: 'principal' }],
      sources: [{ source_id: 'src_oral', confidence: 'low' as const }],
    })),
  ],
  kinship: [
    { from: 'per_henry', to: 'per_clara', relation: 'spouse' },
    { from: 'per_henry', to: 'per_arthur', relation: 'parent' },
    { from: 'per_clara', to: 'per_arthur', relation: 'parent' },
    { from: 'per_henry', to: 'per_edith', relation: 'parent' },
    { from: 'per_clara', to: 'per_edith', relation: 'parent' },
  ],
  media: Array.from({ length: 28 }, (_, i) => ({
    id: `med_${i}`,
    kind: 'family_photo' as const,
    file: `/media/photo_${i}.jpg`,
    caption: `Alder Photo ${i}`,
    date_edtf: '1890',
    person_ids: ['per_henry'],
  })),
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
      pages: [{ page: 1, label: 'Page 1', file: 'p1.txt', text: 'Henry Alder settled in 1880.' }],
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

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const OpenSearchOnMount: React.FC = () => {
  const { openSearch } = useArchiveUi();
  useEffect(() => {
    openSearch();
  }, [openSearch]);
  return null;
};

const PushPivotOnMount: React.FC = () => {
  const { pushPivot } = useArchiveUi();
  useEffect(() => {
    pushPivot({ slug: 'henry-alder', name: 'Henry Alder', year: 1880 });
  }, [pushPivot]);
  return null;
};

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('Loading/error states, KinloomApp routes, ExplorerTopBar, Atoms actions, Evidence pagination, TalkPanel, and Tree search', () => {
  it('renders loading and error states across major pages and routes through KinloomApp', async () => {
    const neverDs: ArchiveDataSource = {
      loadArchive: () => new Promise(() => {}),
      loadReadings: () => new Promise(() => {}),
      loadMediaChecklist: () => new Promise(() => {}),
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

    const failDs: ArchiveDataSource = {
      loadArchive: async () => {
        throw new Error('HTTP 503 Unavailable');
      },
      loadReadings: async () => {
        throw new Error('HTTP 503 Unavailable');
      },
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
      listRevisions: async () => {
        throw new Error('Revisions failed');
      },
    };

    // Loading state across pages
    for (const [path, el] of [
      ['/', <IndexPage key="idx" />],
      ['/places', <PlacesIndexPage key="pls" />],
      ['/place/hudsonville', <PlacePage key="pl" />],
      ['/person/henry-alder', <PersonPage key="per" />],
      ['/time', <TimePage key="tm" />],
      ['/tree', <TreePage key="tr" />],
      ['/kinship', <KinshipPage key="kn" />],
      ['/evidence', <EvidencePage key="ev" />],
    ] as const) {
      const c = mountEl(
        <MemoryRouter initialEntries={[path]}>
          <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={neverDs}>
            <Routes>
              <Route
                path={
                  path.includes('hudsonville')
                    ? '/place/:slug'
                    : path.includes('henry-alder')
                      ? '/person/:slug'
                      : path
                }
                element={el}
              />
            </Routes>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await flushUi();
      expect(c.textContent?.length).toBeGreaterThan(0);
    }

    // Error state across pages
    for (const [path, el] of [
      ['/', <IndexPage key="idx" />],
      ['/places', <PlacesIndexPage key="pls" />],
      ['/place/hudsonville', <PlacePage key="pl" />],
      ['/person/henry-alder', <PersonPage key="per" />],
      ['/time', <TimePage key="tm" />],
      ['/tree', <TreePage key="tr" />],
      ['/evidence', <EvidencePage key="ev" />],
      ['/changes', <RecentChangesPage key="ch" />],
      ['/admin', <AdminPage key="ad" />],
    ] as const) {
      const c = mountEl(
        <MemoryRouter initialEntries={[path]}>
          <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={failDs}>
            <Routes>
              <Route
                path={
                  path.includes('hudsonville')
                    ? '/place/:slug'
                    : path.includes('henry-alder')
                      ? '/person/:slug'
                      : path
                }
                element={el}
              />
            </Routes>
          </ArchiveProvider>
        </MemoryRouter>
      );
      await flushUi();
      await flushUi();
      expect(c.textContent?.length).toBeGreaterThan(0);
    }

    // KinloomApp lazy routes
    for (const route of [
      '/people',
      '/places',
      '/time',
      '/kinship',
      '/evidence',
      '/changes',
      '/admin',
      '/person/henry-alder',
      '/place/hudsonville',
      '/unknown-route',
    ]) {
      mountEl(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={SAMPLE_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          initialEntries={[route]}
        />
      );
      await flushUi();
      await flushUi();
    }
  });

  it('exercises Atoms citation/photo actions, GlobalSearchModal Enter/empty, ExplorerTopBar pivot/menu, Evidence Load More, TalkPanel, and EntityEditDrawer pronunciation/citation toggles', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => SAMPLE_READINGS,
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
      listTalkComments: async () => [],
      postTalkComment: async () => {
        throw new Error('Rate limited');
      },
    };

    const sourcesById = new Map(SAMPLE_BUNDLE.sources.map((s) => [s.id, s]));
    const ev = SAMPLE_BUNDLE.events[0];

    const c = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <PushPivotOnMount />
          <ExplorerTopBar />
          <ArchivalPhotoFrame caption="Missing photo" photoUrl={null} />
          {ev && (
            <SourceCitationTag
              sources={ev.sources}
              alternateDates={ev.alternate_dates}
              alternatePlaces={ev.alternate_places}
              factConflicts={ev.fact_conflicts}
              sourcesById={sourcesById}
              eventId={ev.id}
            />
          )}
          <SourceInspectorDrawer />
          <SourceReaderDrawer />
          <TalkPanel entityType="person" entityId="per_henry" />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    // Open placeholder ArchivalPhotoFrame lightbox and close
    const placeholderBtn = Array.from(c.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Missing photo')
    );
    act(() => {
      placeholderBtn?.click();
    });
    await flushUi();
    const closeLb = Array.from(c.querySelectorAll('button')).find((b) =>
      /Close.*Esc/i.test(b.textContent || '')
    );
    act(() => {
      closeLb?.click();
    });
    await flushUi();

    // Expand SourceCitationTag and click Copy, Read Text, Inspect Source, and conflict inline buttons
    const toggleBtn = Array.from(c.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-expanded') === 'false'
    );
    act(() => {
      toggleBtn?.click();
    });
    await flushUi();
    for (const pattern of [/^copy$/i, /read text/i, /inspect source/i]) {
      const btn = Array.from(c.querySelectorAll('button')).find((b) =>
        pattern.test((b.textContent || '').trim())
      );
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }

    // Open mobile menu button in ExplorerTopBar if present
    const menuBtn = c.querySelector('button[aria-label*="Archive menu" i]') as HTMLButtonElement | null;
    if (menuBtn) {
      act(() => {
        menuBtn.click();
      });
      await flushUi();
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await flushUi();
    }

    // TalkPanel submit error path
    const talkTextarea = c.querySelector('textarea') as HTMLTextAreaElement | null;
    if (talkTextarea) {
      setInputValue(talkTextarea, 'Does anyone remember the exact date of the barn raising?');
      await flushUi();
      const postBtn = Array.from(c.querySelectorAll('button[type="submit"]')).at(-1) as
        | HTMLButtonElement
        | undefined;
      if (postBtn && !postBtn.disabled) {
        act(() => {
          postBtn.click();
        });
        await flushUi();
      }
    }

    // GlobalSearchModal no-match + Enter navigation
    const gs = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <OpenSearchOnMount />
          <GlobalSearchModal />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const gsInput = gs.querySelector('input[type="search"], input[type="text"]') as HTMLInputElement | null;
    if (gsInput) {
      setInputValue(gsInput, 'NoMatchEntityXYZ');
      await flushUi();
      setInputValue(gsInput, 'Hudsonville');
      await flushUi();
      act(() => {
        gsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await flushUi();
    }

    // EvidencePage pagination: Load More Items + Show All Unverified
    const evMedia = mountEl(
      <MemoryRouter initialEntries={['/evidence?tab=media']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <EvidencePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const loadMoreBtn = Array.from(evMedia.querySelectorAll('button')).find((b) =>
      /load more/i.test(b.textContent || '')
    );
    act(() => {
      loadMoreBtn?.click();
    });
    await flushUi();

    const evUncited = mountEl(
      <MemoryRouter initialEntries={['/evidence?tab=uncited']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <EvidencePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const showAllBtn = Array.from(evUncited.querySelectorAll('button')).find((b) =>
      /show all/i.test(b.textContent || '')
    );
    act(() => {
      showAllBtn?.click();
    });
    await flushUi();

    // EntityEditDrawer opened directly to pronunciation section + toggling citation mode & living checkbox
    const drawer = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <EntityEditDrawer
            open={true}
            initialSection="pronunciation"
            entityType="person"
            entityId="per_henry"
            revisionId={1}
            initialData={SAMPLE_BUNDLE.people[0] as unknown as Record<string, unknown>}
            onClose={() => {}}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    const livingCb = drawer.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (livingCb) {
      act(() => {
        livingCb.click();
      });
      await flushUi();
    }
    const radios = Array.from(drawer.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    for (const r of radios) {
      act(() => {
        r.click();
      });
      await flushUi();
    }
  });
});
