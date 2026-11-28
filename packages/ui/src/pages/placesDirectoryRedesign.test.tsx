/** @vitest-environment jsdom */
import type { ArchiveBundle, MigrationEraConfig, Place, PlaceDirectoryEntry } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import {
  buildPlacesDirectorySearchParams,
  buildPlacesDirectorySections,
  classifyPlaceEraBand,
  computeStageCounts,
  filterPlacesDirectory,
  getPlaceInitialLetter,
  PLACES_SECTION_INITIAL_VISIBLE,
  parsePlaceRegion,
  parsePlacesDirectorySearchParams,
  slicePlacesSection,
} from '../lib/placesDirectoryModel.js';
import { PlacesIndexPage } from './PlacesIndexPage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makePlace(overrides: Partial<Place> & { id: string; slug: string; name: string }): Place {
  return {
    full_name: `${overrides.name}, Kent County, Michigan, United States`,
    place_type: 'town',
    parent_id: null,
    lat: 42.96,
    lng: -85.67,
    ...overrides,
  };
}

function makeEntry(
  place: Place,
  overrides: Partial<Omit<PlaceDirectoryEntry, 'place'>> = {}
): PlaceDirectoryEntry {
  return {
    place,
    stage: 'midwest',
    minYear: 1860,
    maxYear: 1890,
    eventCount: 2,
    people: [],
    ...overrides,
  };
}

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

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const LocationSpy: React.FC = () => {
  const loc = useLocation();
  return <output data-testid="places-url">{`${loc.pathname}${loc.search}`}</output>;
};

describe('placesDirectoryModel pure helpers (#78)', () => {
  it('parses Country/State/Province regions deterministically across US, European, single-part, and empty names', () => {
    expect(
      parsePlaceRegion({
        name: 'Alder Creek',
        full_name: 'Alder Creek, Kent County, Michigan, United States',
        place_type: 'town',
      })
    ).toEqual({
      key: 'region-united-states-michigan',
      heading: 'Michigan, United States',
      shortLabel: 'Michigan',
    });

    expect(
      parsePlaceRegion({
        name: 'Mercer',
        full_name: 'Mercer, Ohio, USA',
        place_type: 'town',
      })
    ).toEqual({
      key: 'region-united-states-ohio',
      heading: 'Ohio, United States',
      shortLabel: 'Ohio',
    });

    expect(
      parsePlaceRegion({
        name: 'Hingham',
        full_name: 'Hingham, Norfolk, England',
        place_type: 'town',
      })
    ).toEqual({
      key: 'region-england-norfolk',
      heading: 'Norfolk, England',
      shortLabel: 'Norfolk',
    });

    expect(
      parsePlaceRegion({
        name: 'Bramwell',
        full_name: 'Bramwell, Kent County, Michigan',
        place_type: 'town',
      })
    ).toEqual({
      key: 'region-michigan',
      heading: 'Michigan',
      shortLabel: 'Michigan',
    });

    expect(parsePlaceRegion({ name: 'England', full_name: 'England', place_type: 'country' })).toEqual({
      key: 'region-england',
      heading: 'England',
      shortLabel: 'England',
    });

    expect(
      parsePlaceRegion({ name: 'England', full_name: 'England, England', place_type: 'country' })
    ).toEqual({
      key: 'region-england',
      heading: 'England',
      shortLabel: 'England',
    });

    expect(parsePlaceRegion({ name: '???', full_name: '   ', place_type: 'town' })).toEqual({
      key: 'region-other',
      heading: 'Other Regions',
      shortLabel: 'Other',
    });

    expect(parsePlaceRegion({ name: '---', full_name: '---', place_type: 'town' }).key).toBe('region-other');
  });

  it('classifies era bands, initial letters, stage counts, filtering, section grouping, growth guard, and URL sync', () => {
    expect(classifyPlaceEraBand(null)).toBe('undated');
    expect(classifyPlaceEraBand(0)).toBe('undated');
    expect(classifyPlaceEraBand(1650)).toBe('before-1700');
    expect(classifyPlaceEraBand(1776)).toBe('1700s');
    expect(classifyPlaceEraBand(1832)).toBe('1800-1849');
    expect(classifyPlaceEraBand(1885)).toBe('1850-1899');
    expect(classifyPlaceEraBand(1920)).toBe('1900-plus');

    expect(getPlaceInitialLetter('Alder')).toBe('A');
    expect(getPlaceInitialLetter('Évreux')).toBe('E');
    expect(getPlaceInitialLetter('1st Ward')).toBe('#');
    expect(getPlaceInitialLetter('   ')).toBe('#');

    const eras: MigrationEraConfig[] = [
      { id: 'europe', label: 'European Roots', startYear: 1600, endYear: 1750, minLng: -10, maxLng: 20 },
      { id: 'midwest', label: 'Midwest Frontier', startYear: 1800, endYear: 1920, minLng: -95, maxLng: -80 },
    ];

    const entries: PlaceDirectoryEntry[] = [
      makeEntry(
        makePlace({
          id: 'pl_farm',
          slug: 'alder-farm',
          name: 'Alder Farm',
          full_name: 'Alder Farm, Kent County, Michigan, United States',
          place_type: 'homestead',
        }),
        { stage: 'midwest', minYear: 1865, maxYear: 1895 }
      ),
      makeEntry(
        makePlace({
          id: 'pl_county',
          slug: 'kent-county',
          name: 'Kent County',
          full_name: 'Kent County, Michigan, United States',
          place_type: 'county',
        }),
        { stage: 'midwest', minYear: 1850, maxYear: 1900 }
      ),
      makeEntry(
        makePlace({
          id: 'pl_old',
          slug: 'hingham',
          name: 'Hingham',
          full_name: 'Hingham, Norfolk, England',
          place_type: 'town',
        }),
        { stage: 'europe', minYear: 1640, maxYear: 1680 }
      ),
      makeEntry(
        makePlace({
          id: 'pl_undated',
          slug: '9th-district',
          name: '9th District',
          full_name: '9th District, Norfolk, England',
          place_type: 'town',
        }),
        { stage: '', minYear: null, maxYear: null }
      ),
    ];

    const counts = computeStageCounts(entries, eras);
    expect(counts['all']).toBe(4);
    expect(counts['europe']).toBe(1);
    expect(counts['midwest']).toBe(2);

    expect(filterPlacesDirectory({ directory: entries, stage: 'midwest', query: '' })).toHaveLength(2);
    expect(filterPlacesDirectory({ directory: entries, stage: 'all', query: 'Hingham' })).toHaveLength(1);
    expect(filterPlacesDirectory({ directory: entries, stage: 'all', query: 'no-such-place' })).toHaveLength(
      0
    );

    expect(buildPlacesDirectorySections({ entries: [], view: 'region' })).toEqual([]);

    const regionSections = buildPlacesDirectorySections({ entries, view: 'region' });
    expect(regionSections.map((s) => s.heading)).toEqual(['Michigan, United States', 'Norfolk, England']);
    // Within Michigan, county precedes homestead
    expect(regionSections[0]?.entries.map((e) => e.place.place_type)).toEqual(['county', 'homestead']);
    expect(regionSections[0]?.scentLink?.to).toBe('/map?era=midwest');

    // Undated-only region with empty stage falls back to /map
    const undatedOnlyRegion = buildPlacesDirectorySections({ entries: [entries[3]!], view: 'region' });
    expect(undatedOnlyRegion[0]?.scentLink?.to).toBe('/map');

    const eraSections = buildPlacesDirectorySections({ entries, view: 'era' });
    expect(eraSections.map((s) => s.shortLabel)).toEqual(['Before 1700', '1850–99', 'Undated']);
    expect(eraSections[0]?.scentLink?.to).toBe('/time?year=1665');
    expect(eraSections[2]?.scentLink?.to).toBe('/map');

    const azSections = buildPlacesDirectorySections({ entries, view: 'az' });
    expect(azSections.map((s) => s.heading)).toEqual(['A', 'H', 'K', '#']);
    expect(azSections[0]?.scentLink).toBeNull();

    // Section growth guard
    const smallSlice = slicePlacesSection(entries, false);
    expect(smallSlice.isCapped).toBe(false);
    expect(smallSlice.visible).toHaveLength(4);

    const manyEntries = Array.from({ length: 28 }, (_, i) =>
      makeEntry(makePlace({ id: `p_${i}`, slug: `p-${i}`, name: `Place ${i}` }))
    );
    const capped = slicePlacesSection(manyEntries, false);
    expect(capped.isCapped).toBe(true);
    expect(capped.visible).toHaveLength(PLACES_SECTION_INITIAL_VISIBLE);
    expect(capped.hiddenCount).toBe(10);

    const expanded = slicePlacesSection(manyEntries, true);
    expect(expanded.isCapped).toBe(false);
    expect(expanded.visible).toHaveLength(28);

    // URL query sync
    const validStages = new Set(['all', 'europe', 'midwest']);
    expect(
      parsePlacesDirectorySearchParams(new URLSearchParams('?view=era&stage=midwest&q=Kent'), validStages)
    ).toEqual({ view: 'era', stage: 'midwest', query: 'Kent' });
    expect(
      parsePlacesDirectorySearchParams(new URLSearchParams('?view=bogus&stage=nope'), validStages)
    ).toEqual({ view: 'region', stage: 'all', query: '' });

    expect(buildPlacesDirectorySearchParams({ view: 'region', stage: 'all', query: '' }).toString()).toBe('');
    expect(
      buildPlacesDirectorySearchParams({ view: 'az', stage: 'europe', query: 'Hingham' }).toString()
    ).toBe('view=az&stage=europe&q=Hingham');
  });
});

describe('PlacesIndexPage redesigned directory UI (#78)', () => {
  function buildLargeArchive(): {
    siteConfig: ReturnType<typeof parseKinloomConfig>;
    bundle: ArchiveBundle;
  } {
    const siteConfig = parseKinloomConfig({
      site: {
        title: 'Alder Archive',
        familyName: 'Alder',
        gedcomSourceName: 'ALDER_ARCHIVE',
        footerCredit: 'Alder Archive',
      },
      migrationEras: [
        { id: 'europe', label: 'European Roots', startYear: 1600, endYear: 1750, minLng: -10, maxLng: 20 },
        {
          id: 'midwest',
          label: 'Midwest Frontier',
          startYear: 1800,
          endYear: 1930,
          minLng: -95,
          maxLng: -80,
        },
      ],
    });

    // 26 places in Michigan + 2 places in England => 28 total (>25 triggers Jump Strip; 26 in one section triggers >24 growth guard!)
    const places: Place[] = [
      ...Array.from({ length: 26 }, (_, i) =>
        makePlace({
          id: `pl_mi_${i}`,
          slug: `alder-town-${i}`,
          name: `${String.fromCharCode(65 + (i % 26))}lder Town ${i + 1}`,
          full_name: `${String.fromCharCode(65 + (i % 26))}lder Town ${i + 1}, Kent County, Michigan, United States`,
          lat: 42.96,
          lng: -85.67,
        })
      ),
      makePlace({
        id: 'pl_uk_1',
        slug: 'hingham',
        name: 'Hingham',
        full_name: 'Hingham, Norfolk, England',
        lat: 52.58,
        lng: 0.98,
      }),
      makePlace({
        id: 'pl_uk_2',
        slug: 'norwich',
        name: 'Norwich',
        full_name: 'Norwich, Norfolk, England',
        lat: 52.63,
        lng: 1.29,
      }),
    ];

    const { bundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places,
      sources: [{ id: 'src_1', citation: '1880 Census', source_type: 'census', has_primary_source: true }],
      people: [
        {
          id: 'per_alder',
          slug: 'thomas-alder',
          full_name: 'Thomas Alder',
          given_name: 'Thomas',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1835',
          death_edtf: '1902',
          portrait_url: null,
        },
      ],
      events: places.map((pl, idx) => ({
        id: `evt_${idx}`,
        title: `Recorded at ${pl.name}`,
        summary: `Event in ${pl.name}`,
        event_kind: 'residence_anchor' as const,
        scope: 'family' as const,
        edtf_date: pl.id.startsWith('pl_uk') ? '1680' : '1870',
        place_id: pl.id,
        participants: [{ person_id: 'per_alder', role: 'primary' }],
        sources: [{ source_id: 'src_1', confidence: 'high' as const }],
      })),
      kinship: [],
    });

    return { siteConfig, bundle };
  }

  it('renders grouped sections, sticky Jump Strip (>25), section growth guard (>24 -> 18 + Show all), view switcher, and URL query sync', () => {
    const { siteConfig, bundle } = buildLargeArchive();
    const container = mountEl(
      <MemoryRouter initialEntries={['/places']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <LocationSpy />
          <PlacesIndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    // Sticky Jump Strip rendered because 28 > 25
    const jumpNav = container.querySelector('nav[aria-label="Jump to places section"]');
    expect(jumpNav).not.toBeNull();
    expect(jumpNav?.textContent).toContain('Norfolk');
    expect(jumpNav?.textContent).toContain('(2)');
    expect(jumpNav?.textContent).toContain('Michigan');
    expect(jumpNav?.textContent).toContain('(26)');

    // Michigan section (26 places) capped at 18 with Show all 26 button
    const showAllBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Show all 26')
    );
    expect(showAllBtn).toBeDefined();
    expect(container.querySelectorAll('article').length).toBe(2 + 18);

    act(() => {
      showAllBtn?.click();
    });
    expect(container.querySelectorAll('article').length).toBe(28);

    // Switch to By Era -> updates URL ?view=era and shows Inspect in Time scent link
    const byEraBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'By Era'
    );
    act(() => {
      byEraBtn?.click();
    });
    expect(container.querySelector('[data-testid="places-url"]')?.textContent).toBe('/places?view=era');
    expect(container.textContent).toContain('Before 1700');
    expect(container.textContent).toContain('Inspect in Time →');

    // Switch to A–Z -> updates URL ?view=az
    const azBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'A–Z'
    );
    act(() => {
      azBtn?.click();
    });
    expect(container.querySelector('[data-testid="places-url"]')?.textContent).toBe('/places?view=az');

    // Competing migration-stage dropdown is removed (#95); search filters and Clear resets cleanly
    expect(container.querySelector('select[aria-label="Filter places by migration region"]')).toBeNull();
    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(searchInput).not.toBeNull();
    act(() => {
      if (searchInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(searchInput, 'Hingham');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const clearBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Clear'
    );
    expect(clearBtn).toBeDefined();
    act(() => {
      clearBtn?.click();
    });
    expect(container.querySelector('[data-testid="places-url"]')?.textContent).toBe('/places?view=az');
    expect(container.querySelectorAll('article').length).toBe(28);
  });

  it('restores view, stage, and search query from URL search params on initial mount', () => {
    const { siteConfig, bundle } = buildLargeArchive();
    const container = mountEl(
      <MemoryRouter initialEntries={['/places?view=era&stage=europe&q=Hingham']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <PlacesIndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const byEraBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'By Era'
    );
    expect(byEraBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('article').length).toBe(1);
    expect(container.textContent).toContain('Hingham');
  });
});
