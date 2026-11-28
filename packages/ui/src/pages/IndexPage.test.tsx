import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveBundle, KinloomSiteConfig, Person, Place } from '@kinloom/core';
import { parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { IndexPage } from './IndexPage.js';

const mountedRoots: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  while (mountedRoots.length > 0) {
    const entry = mountedRoots.pop();
    if (!entry) {
      break;
    }
    act(() => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
  vi.restoreAllMocks();
});

function mountElement(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  act(() => {
    root.render(element);
  });
  return container;
}

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function setSelectValue(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function makePerson(overrides: Partial<Person> & { id: string; full_name: string }): Person {
  const parts = overrides.full_name.trim().split(/\s+/);
  return {
    slug: overrides.slug ?? overrides.id,
    given_name: overrides.given_name ?? parts[0] ?? '',
    surname: overrides.surname ?? (parts.length > 1 ? (parts.at(-1) ?? '') : ''),
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: overrides.birth_year ? String(overrides.birth_year) : '',
    death_edtf: overrides.death_year ? String(overrides.death_year) : '',
    portrait_url: null,
    birth_year: null,
    death_year: null,
    event_count: 2,
    media_count: 0,
    primary_place_id: null,
    ...overrides,
  };
}

function makeBundle(people: Person[], places: Place[] = []): ArchiveBundle {
  return {
    meta: {
      build_mode: 'private',
      generated_at: '2026-01-01T00:00:00Z',
      counts: {
        people: people.length,
        living_redacted: 0,
        events: 0,
        residence_spans: 0,
        places: places.length,
        sources: 0,
      },
    },
    people,
    places,
    events: [],
    residence_spans: [],
    place_ancestors: {},
    sources: [],
    kinship: [],
    narratives: [],
    media: [],
  };
}

const LocationEcho: React.FC = () => {
  const loc = useLocation();
  return <output data-testid="location-echo">{`${loc.pathname}${loc.search}`}</output>;
};

describe('IndexPage People Directory (#65)', () => {
  it('renders By Era monotonic sections with era-header /time?year= links, subtitles, A–Z switch, URL sync, and demoted GEDCOM export', () => {
    const place: Place = {
      id: 'plc_hud',
      slug: 'hudsonville',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Michigan',
      place_type: 'town',
      parent_id: null,
      lat: 42.87,
      lng: -85.86,
      historical_names: [],
      summary: '',
    };

    const people: Person[] = [
      makePerson({
        id: 'p_1640',
        full_name: 'Gideon Alder',
        birth_year: 1640,
        death_year: 1705,
        branch: 'alder',
        primary_place_id: 'plc_hud',
      }),
      makePerson({
        id: 'p_1821',
        full_name: 'Clara Birch',
        birth_year: 1821,
        death_year: 1898,
        branch: 'birch',
        portrait_url: 'media/clara.jpg',
        media_count: 1,
      }),
      makePerson({
        id: 'p_1855',
        full_name: 'Henry Alder',
        birth_year: 1855,
        death_year: 1928,
        branch: 'alder',
        media_count: 2,
        primary_place_id: 'plc_hud',
      }),
      makePerson({
        id: 'p_living',
        full_name: 'Sam Rowan',
        birth_year: 1991,
        is_living: true,
        branch: 'birch',
        event_count: 0,
        primary_place_id: null,
      }),
    ];

    const siteConfig: KinloomSiteConfig = parseKinloomConfig({
      site: {
        title: 'Alder & Birch Archive',
        familyName: 'Alder & Birch',
        gedcomSourceName: 'ALDER_BIRCH',
        description: 'Three centuries of orchards and timber.',
      },
      branches: [
        { id: 'alder', label: 'Alder Line', description: 'Michigan orchard homesteaders.' },
        { id: 'birch', label: 'Birch Line', description: 'Coastal Maine shipwrights.' },
      ],
      defaultBranchId: 'alder',
    });

    const container = mountElement(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={makeBundle(people, [place])}>
          <IndexPage />
          <LocationEcho />
        </ArchiveProvider>
      </MemoryRouter>
    );

    // Calm browse toolbar: filter input, By Era | A–Z switch, All Branches select, With photos (N)
    const filterBar = container.querySelector('.index-filter-bar');
    expect(filterBar).toBeTruthy();
    const filterInput = filterBar?.querySelector<HTMLInputElement>('input[type="search"]');
    expect(filterInput?.placeholder).toBe('Filter people by name or place…');
    expect(filterBar?.textContent).toContain('By Era');
    expect(filterBar?.textContent).toContain('A–Z');
    expect(filterBar?.textContent).toContain('With photos (2)');
    // Demoted Export GEDCOM must NOT be in the browse filter bar
    expect(filterBar?.textContent).not.toContain('Export GEDCOM');

    // Demoted utility footer bar owns Export GEDCOM (N)
    const utilityBar = container.querySelector('.index-archive-utility-bar');
    expect(utilityBar?.textContent).toContain('Showing 4 of 4 people');
    expect(utilityBar?.textContent).toContain('Export GEDCOM (4)');

    // Monotonic era headings with inline counts, zero redundant date-range subtitles, and standalone snapshot links
    const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent ?? '');
    expect(headings[0]).toContain('Before 1700');
    expect(headings[0]).toContain('(1)');
    expect(headings[1]).toContain('1800–1849');
    expect(headings[1]).toContain('(1)');
    expect(headings[2]).toContain('1850–1899');
    expect(headings[2]).toContain('(1)');
    expect(headings[3]).toContain('Living relatives');
    expect(headings[3]).toContain('(1)');
    expect(container.textContent).not.toContain('Born in the early nineteenth century');
    expect(container.querySelector('a[href="/time?year=1850"]')?.textContent).toBe('1850 snapshot →');
    expect(container.querySelector('a[href="/time?year=1880"]')?.textContent).toBe('1880 snapshot →');
    expect(container.querySelector('.index-section-meta-sep')).toBeNull();

    // Compact living section renders named living relative with b. YYYY · Living and suppresses boilerplate
    const livingSection = container.querySelector('section[aria-label="Living relatives"]');
    expect(livingSection?.textContent).toContain('Sam Rowan');
    expect(livingSection?.textContent).toContain('b. 1991 · Living');
    expect(livingSection?.textContent).not.toContain('Location unrecorded');
    expect(livingSection?.textContent).not.toContain('0 milestones');

    // Branch selector updates URL (?branch=birch) and renders Family Tree scent link
    const branchSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by family branch"]'
    );
    expect(branchSelect).toBeTruthy();
    if (branchSelect) {
      setSelectValue(branchSelect, 'birch');
    }
    expect(container.querySelector('[data-testid="location-echo"]')?.textContent).toBe('/?branch=birch');
    expect(container.textContent).toContain('Coastal Maine shipwrights.');
    expect(container.querySelector('a[href="/tree?branch=birch"]')?.textContent).toContain(
      'View branch in Family Tree'
    );
    expect(container.textContent).toContain('Clara Birch');
    expect(container.textContent).not.toContain('Henry Alder');

    // Switch to A–Z updates URL (?branch=birch&view=az) and includes living relative in surname bucket without boilerplate
    const azBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'A–Z'
    );
    act(() => {
      azBtn?.click();
    });
    expect(container.querySelector('[data-testid="location-echo"]')?.textContent).toBe(
      '/?branch=birch&view=az'
    );
    expect(container.querySelector('section[aria-label="Living relatives"]')).toBeNull();
    const rSection = container.querySelector('section[aria-label="R"]');
    expect(rSection?.textContent).toContain('Sam Rowan');
    expect(rSection?.textContent).toContain('b. 1991 · Living');
    expect(rSection?.textContent).not.toContain('Location unrecorded');
    expect(rSection?.textContent).not.toContain('0 milestones');

    // With photos toggle filters down to Clara Birch
    const photosBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('With photos (1)')
    );
    act(() => {
      photosBtn?.click();
    });
    expect(container.textContent).toContain('Clara Birch');
    expect(container.textContent).not.toContain('Sam Rowan');

    // Clear resets query, branch, and photo filter
    const clearBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Clear'
    );
    act(() => {
      clearBtn?.click();
    });
    expect(container.querySelector('[data-testid="location-echo"]')?.textContent).toBe('/?view=az');
    expect(container.textContent).toContain('Henry Alder');
  });

  it('hides All Branches selector for single-branch archives and restores ?view=az&branch= on initial load', () => {
    const singleBranchConfig = parseKinloomConfig({
      site: { title: 'Rowan Archive', familyName: 'Rowan', gedcomSourceName: 'ROWAN' },
      branches: [{ id: 'rowan', label: 'Rowan Line' }],
      defaultBranchId: 'rowan',
    });
    const people = [
      makePerson({ id: 'p1', full_name: 'Ada Rowan', birth_year: 1860, death_year: 1930, branch: 'rowan' }),
      makePerson({ id: 'p2', full_name: 'Owen Cedar', birth_year: 1865, death_year: 1940, branch: 'rowan' }),
    ];

    const container = mountElement(
      <MemoryRouter initialEntries={['/?view=az']}>
        <ArchiveProvider siteConfig={singleBranchConfig} initialBundle={makeBundle(people)}>
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    expect(container.querySelector('select[aria-label="Filter by family branch"]')).toBeNull();
    const azBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'A–Z'
    );
    expect(azBtn?.getAttribute('aria-pressed')).toBe('true');
    const sectionLabels = [...container.querySelectorAll('section[id^="dir-sec-"]')].map((s) =>
      s.getAttribute('aria-label')
    );
    expect(sectionLabels).toEqual(['C', 'R']);
  });

  it('auto-collapses Living relatives (> 12), renders Sticky Jump Strip (> 25), and enforces 18-card section growth guard (> 24)', () => {
    // 25 historical ancestors in 1850-1899 + 14 living relatives = 39 total (> 25 triggers Jump Strip)
    const historical25: Person[] = Array.from({ length: 25 }, (_, idx) =>
      makePerson({
        id: `hist_${idx}`,
        full_name: `Ancestor ${String(idx + 1).padStart(2, '0')} Alder`,
        birth_year: 1850 + idx,
        death_year: 1920 + idx,
      })
    );
    const living14: Person[] = Array.from({ length: 14 }, (_, idx) =>
      makePerson({
        id: `liv_${idx}`,
        full_name: `Cousin ${String(idx + 1).padStart(2, '0')} Rowan`,
        birth_year: 1980 + idx,
        is_living: true,
        event_count: 0,
      })
    );

    const config = parseKinloomConfig({
      site: { title: 'Large Archive', familyName: 'Alder', gedcomSourceName: 'ALDER' },
    });

    const container = mountElement(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={config} initialBundle={makeBundle([...historical25, ...living14])}>
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    // Sticky Jump Strip rendered (> 25 people)
    const jumpNav = container.querySelector('nav[aria-label="Jump to era"]');
    expect(jumpNav).toBeTruthy();
    expect(jumpNav?.querySelector('a[href="#dir-sec-1850-1899"]')).toBeTruthy();
    const livingJumpLink = jumpNav?.querySelector<HTMLAnchorElement>('a[href="#dir-sec-living"]');
    expect(livingJumpLink).toBeTruthy();

    // Growth guard caps 25-person era section at 18 visible cards with inline Show all 25 button
    const eraSection = container.querySelector('#dir-sec-1850-1899');
    expect(eraSection?.querySelectorAll('.person-card').length).toBe(18);
    const showAllBtn = [...(eraSection?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (b) => b.textContent?.trim() === 'Show all 25'
    );
    expect(showAllBtn).toBeTruthy();
    act(() => {
      showAllBtn?.click();
    });
    expect(eraSection?.querySelectorAll('.person-card').length).toBe(25);

    // Living relatives (> 12) auto-collapsed behind Show 14 living relatives
    const livingSection = container.querySelector('#dir-sec-living');
    expect(livingSection?.querySelector('ul')).toBeNull();
    const showLivingBtn = livingSection?.querySelector<HTMLButtonElement>('button');
    expect(showLivingBtn?.textContent?.trim()).toBe('Show 14 living relatives');
    expect(showLivingBtn?.getAttribute('aria-expanded')).toBe('false');

    // Clicking the Jump Strip Living link expands the Living relatives list
    act(() => {
      livingJumpLink?.click();
    });
    expect(livingSection?.querySelectorAll('li').length).toBe(14);
    expect(livingSection?.querySelector('button')?.textContent?.trim()).toBe('Hide living relatives');

    // Clicking Hide collapses again, and clicking Show re-expands
    act(() => {
      livingSection?.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(livingSection?.querySelector('ul')).toBeNull();
    act(() => {
      livingSection?.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(livingSection?.querySelectorAll('li').length).toBe(14);

    // Switching to A–Z renders A–Z Jump Strip and switching back to By Era restores era jump strip
    const azBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'A–Z'
    );
    const eraBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'By Era'
    );
    act(() => {
      azBtn?.click();
    });
    expect(container.querySelector('nav[aria-label="Jump to surname letter"]')).toBeTruthy();
    act(() => {
      eraBtn?.click();
    });
    expect(container.querySelector('nav[aria-label="Jump to era"]')).toBeTruthy();

    // Searching auto-expands matching living relatives immediately
    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (searchInput) {
      setInputValue(searchInput, 'Cousin 03');
    }
    expect(container.querySelector('#dir-sec-living')?.textContent).toContain('Cousin 03 Rowan');
    expect(container.querySelector('#dir-sec-living')?.textContent).toContain('b. 1982 · Living');
  });

  it('renders optional Archive Frontispiece with kicker, editorial intro, high-priority ArchivalImage, caption, and featured links', () => {
    const config = parseKinloomConfig({
      site: { title: 'Cedar Archive', familyName: 'Cedar', gedcomSourceName: 'CEDAR' },
      extensions: {
        frontispiece: {
          kicker: 'Archival Folio',
          headline: 'The Cedar Valley Papers',
          intro: 'Letters, survey plats, and census ledgers from 1790 to 1960.',
          image: 'media/valley.jpg',
          imageAlt: 'Cedar Valley orchard survey',
          imageCaption: 'Survey plat, 1884',
          featuredLinks: [
            { label: 'Explore 1880', to: '/time?year=1880' },
            { label: 'Open Tree', to: '/tree' },
          ],
        },
      },
    });
    const people = [makePerson({ id: 'p1', full_name: 'Ada Cedar', birth_year: 1852, death_year: 1924 })];

    const container = mountElement(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={config} initialBundle={makeBundle(people)} baseUrl="/archive/">
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    expect(container.textContent).toContain('Archival Folio');
    expect(container.querySelector('h1')?.textContent).toBe('The Cedar Valley Papers');
    expect(container.textContent).toContain('Letters, survey plats, and census ledgers from 1790 to 1960.');
    expect(container.textContent).toContain('1 person · 1852–1924');
    expect(container.textContent).toContain('Survey plat, 1884');
    const featuredNav = container.querySelector('nav[aria-label="Featured archive entry points"]');
    expect(featuredNav?.querySelector('a[href="/time?year=1880"]')?.textContent).toBe('Explore 1880');
    expect(featuredNav?.querySelector('a[href="/tree"]')?.textContent).toBe('Open Tree');
    const img = container.querySelector<HTMLImageElement>('.index-frontispiece-img');
    expect(img?.getAttribute('loading')).toBe('eager');
    expect(img?.getAttribute('alt')).toBe('Cedar Valley orchard survey');
  });

  it('simplifies era headers, supports progressive Filters popover, separates + Add Person, and renders living-safe story hooks (#89)', () => {
    const place: Place = {
      id: 'plc_hingham',
      slug: 'hingham',
      name: 'Hingham',
      full_name: 'Hingham, Massachusetts',
      place_type: 'town',
      parent_id: null,
      lat: 42.24,
      lng: -70.89,
      historical_names: [],
      summary: '',
    };
    const pre1700People: Person[] = Array.from({ length: 8 }, (_, idx) =>
      makePerson({
        id: `pre_${idx}`,
        full_name: `Founder ${String(idx + 1).padStart(2, '0')} Alder`,
        birth_year: 1640 + idx,
        death_year: 1700 + idx,
        branch: 'alder',
        primary_place_id: idx === 0 ? 'plc_hingham' : null,
      })
    );
    const late1800People: Person[] = Array.from({ length: 20 }, (_, idx) =>
      makePerson({
        id: `late_${idx}`,
        full_name: `Heir ${String(idx + 1).padStart(2, '0')} Birch`,
        birth_year: 1850 + idx,
        death_year: 1920 + idx,
        branch: 'birch',
      })
    );
    const livingPerson = makePerson({
      id: 'liv_0',
      full_name: 'Jordan Alder',
      birth_year: 1995,
      is_living: true,
      branch: 'alder',
      event_count: 0,
    });
    const undatedPerson = makePerson({
      id: 'undated_0',
      full_name: 'Ezra Alder',
      birth_year: null,
      death_year: null,
      branch: 'alder',
    });
    const bundle: ArchiveBundle = {
      ...makeBundle([...pre1700People, ...late1800People, livingPerson, undatedPerson], [place]),
      events: [
        {
          id: 'evt_pre_0',
          title: 'Sailed from Great Yarmouth to Hingham, Massachusetts',
          scope: 'personal',
          event_kind: 'residence_anchor',
          category: 'migration',
          edtf_date: '1655',
          display_date: '1655',
          year: 1655,
          time_min: 1655,
          time_max: 1655,
          place_id: 'plc_hingham',
          summary: '',
          participants: [{ person_id: 'pre_0', role: 'principal' }],
          sources: [],
        },
        {
          id: 'evt_liv_0',
          title: 'Private living career note that must not leak',
          scope: 'personal',
          event_kind: 'point_event',
          category: 'career',
          edtf_date: '2020',
          display_date: '2020',
          year: 2020,
          time_min: 2020,
          time_max: 2020,
          place_id: 'plc_hingham',
          summary: '',
          participants: [{ person_id: 'liv_0', role: 'principal' }],
          sources: [],
        },
      ],
    };
    const config = parseKinloomConfig({
      site: {
        title: 'Alder & Birch Archive',
        familyName: 'Alder & Birch',
        gedcomSourceName: 'ALDER_89',
        description: 'Three centuries of orchards and timber across two coasts.',
      },
      branches: [
        { id: 'alder', label: 'Alder Line' },
        { id: 'birch', label: 'Birch Line' },
      ],
      defaultBranchId: 'alder',
    });

    const container = mountElement(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={config} initialBundle={bundle} capabilities={{ canEdit: true }}>
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    // 1. + Add Person sits in the banner header, separate from read-only view filters
    const bannerAddBtn = container.querySelector<HTMLButtonElement>(
      '.index-banner-head .index-add-person-btn'
    );
    expect(bannerAddBtn?.textContent?.trim()).toBe('+ Add Person');
    expect(container.querySelector('.index-filter-actions .index-add-person-btn')).toBeNull();

    // 2. Mobile About this archive disclosure toggles intro visibility state
    const aboutToggle = container.querySelector<HTMLButtonElement>('.index-about-toggle');
    expect(aboutToggle?.textContent?.trim()).toBe('About this archive');
    expect(aboutToggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      aboutToggle?.click();
    });
    expect(aboutToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(aboutToggle?.textContent?.trim()).toBe('Hide info');
    expect(container.querySelector('.index-banner-about')?.classList.contains('is-open')).toBe(true);

    // 3. Single-row mobile toolbar with Filters trigger, active count badge, Done, outside click, and Escape
    const filtersToggle = container.querySelector<HTMLButtonElement>('.index-filters-toggle-btn');
    const filtersPanel = container.querySelector<HTMLElement>('.index-filters-panel');
    expect(filtersToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(filtersPanel?.getAttribute('data-filters-open')).toBe('false');
    expect(filtersToggle?.querySelector('.index-filters-badge')).toBeNull();

    act(() => {
      filtersToggle?.click();
    });
    expect(filtersToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(filtersPanel?.getAttribute('data-filters-open')).toBe('true');

    // Selecting a filter updates active filter badge count
    const photosBtn = container.querySelector<HTMLButtonElement>('.index-media-filter-btn');
    act(() => {
      photosBtn?.click();
    });
    expect(filtersToggle?.querySelector('.index-filters-badge')?.textContent).toBe('1');
    expect(filtersToggle?.getAttribute('aria-label')).toBe('Filters (1 active)');

    // Done button closes panel
    const doneBtn = container.querySelector<HTMLButtonElement>('.index-filters-sheet-close');
    act(() => {
      doneBtn?.click();
    });
    expect(filtersToggle?.getAttribute('aria-expanded')).toBe('false');

    // Reopen and dismiss with Escape
    act(() => {
      filtersToggle?.click();
    });
    expect(filtersToggle?.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(filtersToggle?.getAttribute('aria-expanded')).toBe('false');

    // Reopen and dismiss via outside click
    act(() => {
      filtersToggle?.click();
    });
    expect(filtersToggle?.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(filtersToggle?.getAttribute('aria-expanded')).toBe('false');

    // Clear active photo filter
    act(() => {
      container.querySelector<HTMLButtonElement>('.index-clear-btn')?.click();
    });
    expect(filtersToggle?.querySelector('.index-filters-badge')).toBeNull();

    // 4. Jump Strip counts formatted with parentheses: "Before 1700 (8)", "1850–99 (20)"
    const jumpLinks = [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Jump to era"] a')];
    expect(jumpLinks[0]?.textContent).toBe('Before 1700 (8)');
    expect(jumpLinks[1]?.textContent).toBe('1850–99 (20)');

    // 5. Simplified era section headers: inline count on left, standalone snapshot link on right, zero middot
    const pre1700Heading = container.querySelector('#dir-sec-before-1700 .index-section-heading');
    expect(pre1700Heading?.querySelector('.index-section-heading-title')?.textContent).toBe('Before 1700(8)');
    expect(pre1700Heading?.querySelector('.index-era-snapshot-link')?.textContent).toBe('1665 snapshot →');
    expect(pre1700Heading?.querySelector('.index-section-meta-sep')).toBeNull();
    expect(container.querySelector('#dir-sec-before-1700 .index-section-subtitle')).toBeNull();
    expect(container.querySelector('#dir-sec-undated .index-section-subtitle')?.textContent).toBe(
      'Birth year not yet documented'
    );

    // 6. Story hook renders for historical ancestor and never leaks for living relative
    const firstCard = container.querySelector('#dir-sec-before-1700 .person-card');
    expect(firstCard?.querySelector('.person-card-hook')?.textContent).toBe(
      'Sailed from Great Yarmouth to Hingham, Massachusetts'
    );
    expect(container.textContent).not.toContain('Private living career note that must not leak');

    // Switch to A–Z: Jump Strip omits counts, living card still omits story hook
    const azBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'A–Z'
    );
    act(() => {
      azBtn?.click();
    });
    expect(container.querySelector('.jump-count')).toBeNull();
    expect(container.textContent).not.toContain('Private living career note that must not leak');

    // 7. Verify IndexPage.module.css enforces mobile <= 640px progressive disclosure and DirectoryJumpStrip enforces fade mask
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, 'IndexPage.module.css'), 'utf8');
    const jumpCss = readFileSync(resolve(here, '../components/atoms/DirectoryJumpStrip.module.css'), 'utf8');
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain('.index-toolbar-primary');
    expect(css).toContain('.index-filters-panel:global(.is-open)');
    expect(css).toContain('.person-card-hook');
    expect(jumpCss).toContain('scrollbar-width: none;');
    expect(jumpCss).toContain('.jump-strip::-webkit-scrollbar');
    expect(jumpCss).toContain('@property --jump-fade-end');
    expect(jumpCss).toContain('animation-timeline: scroll(self inline);');
  });
});
