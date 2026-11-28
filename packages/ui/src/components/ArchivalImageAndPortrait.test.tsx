/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, Person } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import type { DiagramPlacedNode } from '../lib/archivalTreeModel.js';
import { KinshipPage } from '../pages/KinshipPage.js';
import { PlacePage } from '../pages/PlacePage.js';
import { ArchivalImage, PersonPortrait } from './Atoms.js';
import { DiagramNodeCard } from './tree/TreeNodesLayer.js';

function must<T>(val: T | undefined, label = 'value'): T {
  if (val === undefined) throw new Error(`Expected ${label}`);
  return val;
}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activeRoots: { root: ReturnType<typeof createRoot>; container: HTMLDivElement }[] = [];

function mount(element: React.ReactElement): {
  container: HTMLDivElement;
  rerender: (next: React.ReactElement) => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  activeRoots.push({ root, container });
  return {
    container,
    rerender: (next: React.ReactElement) => {
      act(() => {
        root.render(next);
      });
    },
  };
}

afterEach(() => {
  while (activeRoots.length > 0) {
    const entry = activeRoots.pop();
    if (entry) {
      act(() => {
        entry.root.unmount();
      });
      entry.container.remove();
    }
  }
});

const TEST_SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Portrait Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_PORTRAIT_TEST',
  },
  branches: [{ id: 'main', label: 'Main Line' }],
  featuredKinshipPairs: [
    {
      label: 'Henry Alder ↔ Clara Alder',
      fromId: 'per_henry',
      toId: 'per_clara',
    },
  ],
});

const { bundle: TEST_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: TEST_SITE_CONFIG,
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
      photo_url: '/media/hudsonville-1890.jpg',
      photo_caption: 'Hudsonville mill pond, 1890',
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
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'main',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
      portrait_url: '/media/henry-alder.jpg',
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
      branch: 'main',
      birth_edtf: '1858-07-22',
      death_edtf: '1938-04-09',
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
  ],
  kinship: [{ from: 'per_henry', to: 'per_clara', relation: 'spouse' }],
  media: [],
});

function createStaticSource(bundle: ArchiveBundle): ArchiveDataSource {
  return {
    loadArchive: async () => ({ bundle, etag: '"portrait-test"', notModified: false }),
    loadReadings: async () => ({ version: 1, event_page_map: {}, documents: {} }),
    loadMediaChecklist: async () => [],
  };
}

describe('ArchivalImage', () => {
  it('starts in warm linen loading state, transitions to loaded on load, and resolves baseUrl', () => {
    const onLoad = vi.fn();
    const { container } = mount(
      <ArchivalImage
        src="/media/barn-1884.jpg"
        baseUrl="/archive"
        alt="Alder homestead barn, 1884"
        onLoad={onLoad}
      />
    );

    const frame = container.querySelector<HTMLElement>('[data-image-status]');
    expect(frame?.getAttribute('data-image-status')).toBe('loading');
    const img = container.querySelector<HTMLImageElement>('img');
    expect(img?.getAttribute('src')).toBe('/archive/media/barn-1884.jpg');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.className).not.toContain('is-loaded');

    act(() => {
      img?.dispatchEvent(new Event('load'));
    });

    expect(frame?.getAttribute('data-image-status')).toBe('loaded');
    expect(img?.className).toContain('is-loaded');
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('immediately marks already-cached images (complete && naturalWidth > 0) as loaded', () => {
    const origComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
    const origNaturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
    Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
      configurable: true,
      get: () => 640,
    });

    try {
      const { container } = mount(
        <ArchivalImage src="/media/cached-plate.jpg" alt="Cached archival plate" />
      );
      const frame = container.querySelector<HTMLElement>('[data-image-status]');
      const img = container.querySelector<HTMLImageElement>('img');
      expect(frame?.getAttribute('data-image-status')).toBe('loaded');
      expect(img?.className).toContain('is-loaded');
    } finally {
      if (origComplete) {
        Object.defineProperty(HTMLImageElement.prototype, 'complete', origComplete);
      } else {
        Reflect.deleteProperty(HTMLImageElement.prototype, 'complete');
      }
      if (origNaturalWidth) {
        Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', origNaturalWidth);
      } else {
        Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
      }
    }
  });

  it('swaps failed images into an editorial archival fallback plate and resets cleanly when src changes', () => {
    const onError = vi.fn();
    const { container, rerender } = mount(
      <ArchivalImage
        src="/media/missing-404.jpg"
        alt="Missing 1890 survey map"
        fallbackCaption="1890 survey map unavailable"
        onError={onError}
      />
    );

    const brokenImg = container.querySelector<HTMLImageElement>('img');
    expect(brokenImg?.getAttribute('src')).toBe('/media/missing-404.jpg');

    act(() => {
      brokenImg?.dispatchEvent(new Event('error'));
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).toBeNull();
    const fallback = container.querySelector<HTMLElement>('[data-image-status="error"]');
    expect(fallback?.getAttribute('role')).toBe('img');
    expect(fallback?.getAttribute('aria-label')).toBe('Missing 1890 survey map');
    expect(fallback?.textContent).toBe('1890 survey map unavailable');

    // Switching src resets error state and mounts a fresh <img>
    rerender(
      <ArchivalImage
        src="/media/recovered-1890.jpg"
        alt="Recovered 1890 survey map"
        fallbackCaption="1890 survey map unavailable"
      />
    );

    const recoveredImg = container.querySelector<HTMLImageElement>('img');
    expect(recoveredImg?.getAttribute('src')).toBe('/media/recovered-1890.jpg');
    expect(container.querySelector('[data-image-status="loading"]')).not.toBeNull();

    act(() => {
      recoveredImg?.dispatchEvent(new Event('load'));
    });

    expect(container.querySelector('[data-image-status="loaded"]')).not.toBeNull();
    expect(recoveredImg?.className).toContain('is-loaded');
  });

  it('supports compact fallback, custom fallback, null fallback, and forces eager loading for fetchPriority="high"', () => {
    const { container, rerender } = mount(
      <ArchivalImage
        src="/media/hero.jpg"
        alt="Hero plate"
        loading="lazy"
        fetchPriority="high"
        allowOverflow
      />
    );
    const heroImg = container.querySelector<HTMLImageElement>('img');
    expect(heroImg?.getAttribute('loading')).toBe('eager');

    rerender(<ArchivalImage src={null} alt="" fallbackCompact />);
    expect(container.querySelector('img')).toBeNull();
    const compactFallback = container.querySelector<HTMLElement>('[data-image-status="empty"]');
    expect(compactFallback?.getAttribute('aria-hidden')).toBe('true');
    expect(compactFallback?.textContent).toBe('');

    rerender(<ArchivalImage src="" alt="Empty" fallback={<span data-testid="custom">No scan</span>} />);
    expect(container.querySelector('[data-testid="custom"]')?.textContent).toBe('No scan');

    rerender(<ArchivalImage src={null} alt="Hidden on empty" fallback={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('PersonPortrait', () => {
  it('renders archival monogram underlay while loading, reveals image on load, and falls back cleanly on 404', () => {
    const onLoad = vi.fn();
    const onError = vi.fn();
    const { container, rerender } = mount(
      <PersonPortrait
        name="Henry Alder"
        src="/media/henry-alder.jpg"
        baseUrl="/family"
        alt="Archival portrait of Henry Alder"
        variant="print"
        size="lg"
        fetchPriority="high"
        decorative={false}
        onLoad={onLoad}
        onError={onError}
      />
    );

    const rootEl = container.querySelector<HTMLElement>('[data-portrait-status]');
    expect(rootEl?.getAttribute('data-portrait-status')).toBe('loading');
    expect(rootEl?.textContent).toBe('HA');
    const img = container.querySelector<HTMLImageElement>('img');
    expect(img?.getAttribute('src')).toBe('/family/media/henry-alder.jpg');
    expect(img?.getAttribute('loading')).toBe('eager');

    act(() => {
      img?.dispatchEvent(new Event('load'));
    });
    expect(rootEl?.getAttribute('data-portrait-status')).toBe('loaded');
    expect(img?.className).toContain('is-loaded');
    expect(onLoad).toHaveBeenCalledTimes(1);

    // Trigger error on a broken URL and verify broken <img> is removed and monogram remains
    rerender(
      <PersonPortrait
        name="Henry Alder"
        src="/media/missing-henry.jpg"
        alt="Archival portrait of Henry Alder"
        variant="print"
        size="lg"
        decorative={false}
        onError={onError}
      />
    );
    const nextImg = container.querySelector<HTMLImageElement>('img');
    expect(nextImg?.getAttribute('src')).toBe('/media/missing-henry.jpg');

    act(() => {
      nextImg?.dispatchEvent(new Event('error'));
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).toBeNull();
    expect(rootEl?.getAttribute('data-portrait-status')).toBe('error');
    expect(rootEl?.getAttribute('role')).toBe('img');
    expect(rootEl?.getAttribute('aria-label')).toBe('Archival portrait of Henry Alder');
    expect(rootEl?.textContent).toBe('HA');
  });

  it('renders monogram-only circle without an <img> when src is absent', () => {
    const { container } = mount(
      <PersonPortrait name="Clara Alder" src={null} variant="circle" size="sm" selected />
    );

    expect(container.querySelector('img')).toBeNull();
    const rootEl = container.querySelector<HTMLElement>('[data-portrait-status="empty"]');
    expect(rootEl?.textContent).toBe('CA');
    expect(rootEl?.className).toContain('is-selected');
    expect(rootEl?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('PersonPortrait integration across Kinship, Place residents, and Tree SVG nodes', () => {
  it('renders portraits on Kinship lineage nodes when portrait_url exists and falls back to monogram on error', async () => {
    const source = createStaticSource(TEST_BUNDLE);
    const { container } = mount(
      <MemoryRouter initialEntries={['/kinship']}>
        <ArchiveProvider siteConfig={TEST_SITE_CONFIG} dataSource={source}>
          <Routes>
            <Route path="/kinship" element={<KinshipPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const nodePills = [...container.querySelectorAll<HTMLAnchorElement>('.kinship-node-pill')];
    expect(nodePills).toHaveLength(2);

    const henryPill = nodePills.find((el) => el.textContent?.includes('Henry Alder'));
    const claraPill = nodePills.find((el) => el.textContent?.includes('Clara Alder'));
    expect(henryPill).toBeDefined();
    expect(claraPill).toBeDefined();

    // Henry has a portrait_url so Kinship renders an <img> rather than dropping to monogram-only
    const henryImg = henryPill?.querySelector<HTMLImageElement>('img');
    expect(henryImg?.getAttribute('src')).toBe('/media/henry-alder.jpg');
    expect(henryImg?.getAttribute('loading')).toBe('eager');

    // Clara has no portrait_url so Kinship renders monogram CA with no <img>
    expect(claraPill?.querySelector('img')).toBeNull();
    expect(claraPill?.querySelector('[data-portrait-status="empty"]')?.textContent).toBe('CA');

    // When Henry's portrait returns 404, the broken <img> unmounts and HA monogram remains
    act(() => {
      henryImg?.dispatchEvent(new Event('error'));
    });
    expect(henryPill?.querySelector('img')).toBeNull();
    expect(henryPill?.querySelector('[data-portrait-status="error"]')?.textContent).toBe('HA');
  });

  it('renders PersonPortrait medallions in Place Dossier resident occupancy rows and protects historical photo', async () => {
    const source = createStaticSource(TEST_BUNDLE);
    const { container } = mount(
      <MemoryRouter initialEntries={['/place/hudsonville']}>
        <ArchiveProvider siteConfig={TEST_SITE_CONFIG} dataSource={source}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );

    await act(async () => {
      await Promise.resolve();
    });

    const rows = [...container.querySelectorAll<HTMLAnchorElement>('.occupancy-row')];
    expect(rows).toHaveLength(2);
    const henryRow = rows.find((el) => el.textContent?.includes('Henry Alder'));
    const henryImg = henryRow?.querySelector<HTMLImageElement>('img');
    expect(henryImg?.getAttribute('src')).toBe('/media/henry-alder.jpg');

    // Historical profile photo is protected by ArchivalImage onError fallback
    const placeFigure = container.querySelector<HTMLElement>('.place-history-figure');
    const placeImg = placeFigure?.querySelector<HTMLImageElement>('img');
    expect(placeImg?.getAttribute('src')).toBe('/media/hudsonville-1890.jpg');
    act(() => {
      placeImg?.dispatchEvent(new Event('error'));
    });
    expect(placeFigure?.querySelector('img')).toBeNull();
    expect(placeFigure?.querySelector('[data-image-status="error"]')?.textContent).toBe(
      'Hudsonville mill pond, 1890'
    );
  });

  it('falls back SVG <image> in DiagramNodeCard to initials monogram on error and resets when thumbUrl changes', () => {
    const person: Person = must(TEST_BUNDLE.people[0]);
    const node: DiagramPlacedNode = {
      person,
      x: 0,
      y: 0,
      width: 180,
      height: 52,
      gen: 0,
      isDirect: true,
      placement: 'rank',
      unionId: null,
    };

    const { container, rerender } = mount(
      <svg aria-hidden="true">
        <DiagramNodeCard
          node={node}
          displayName="Henry Alder"
          surnameOrGiven="Henry"
          lifespan="1855–1932"
          thumbUrl="/media/broken-node.jpg"
          initials="HA"
          isSelected={false}
          isLit={false}
          semanticZoom="detail"
          onSelect={vi.fn()}
        />
      </svg>
    );

    const svgImage = container.querySelector('image');
    expect(svgImage?.getAttribute('href')).toBe('/media/broken-node.jpg');

    act(() => {
      svgImage?.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('image')).toBeNull();
    const texts = [...container.querySelectorAll('text')].map((el) => el.textContent);
    expect(texts).toContain('HA');

    rerender(
      <svg aria-hidden="true">
        <DiagramNodeCard
          node={node}
          displayName="Henry Alder"
          surnameOrGiven="Henry"
          lifespan="1855–1932"
          thumbUrl="/media/fixed-node.jpg"
          initials="HA"
          isSelected={false}
          isLit={false}
          semanticZoom="detail"
          onSelect={vi.fn()}
        />
      </svg>
    );

    expect(container.querySelector('image')?.getAttribute('href')).toBe('/media/fixed-node.jpg');
  });
});
