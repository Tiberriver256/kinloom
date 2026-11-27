/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, KinshipEdge, Person, Place } from '@kinloom/core';
import { parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { TreePage } from './TreePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEST_SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Hale Historical Archive',
    familyName: 'Hale',
    gedcomSourceName: 'HALE_TREE_TEST',
  },
  theme: {
    accent: '#7a4612',
  },
  branches: [
    {
      id: 'hale_line',
      label: 'Hale Line',
      surnames: ['Hale'],
      lineageGroups: ['ancestor', 'pivot_ancestor', 'descendant'],
      supportsDirectMode: true,
    },
    {
      id: 'vance_line',
      label: 'Vance Line',
      surnames: ['Vance'],
      lineageGroups: ['ancestor'],
      supportsDirectMode: false,
    },
  ],
});

function makePerson(overrides: Partial<Person> & Pick<Person, 'id' | 'slug' | 'full_name'>): Person {
  const parts = overrides.full_name.split(' ');
  return {
    given_name: parts[0] ?? overrides.full_name,
    surname: parts.at(-1) ?? '',
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'collateral',
    branch: 'hale_line',
    birth_edtf: '',
    death_edtf: '',
    birth_year: null,
    death_year: null,
    portrait_url: null,
    event_count: 1,
    primary_place_id: 'plc_harbor',
    ...overrides,
  };
}

function buildTestBundle(): ArchiveBundle {
  const places: Place[] = [
    {
      id: 'plc_harbor',
      slug: 'harbor-town',
      name: 'Harbor Town',
      full_name: 'Harbor Town, Maine, USA',
      place_type: 'town',
      parent_id: null,
      lat: 43.65,
      lng: -70.25,
    },
  ];
  const people: Person[] = [
    makePerson({
      id: 'p_thomas',
      slug: 'thomas-hale',
      full_name: 'Thomas Hale',
      lineage_group: 'ancestor',
      birth_year: 1790,
      death_year: 1862,
      birth_edtf: '1790',
      death_edtf: '1862',
    }),
    makePerson({
      id: 'p_eliza',
      slug: 'eliza-brent',
      full_name: 'Eliza Brent',
      lineage_group: 'ancestor',
      birth_year: 1794,
      death_year: 1870,
      birth_edtf: '1794',
      death_edtf: '1870',
    }),
    makePerson({
      id: 'p_arthur',
      slug: 'arthur-hale',
      full_name: 'Arthur Hale',
      lineage_group: 'pivot_ancestor',
      birth_year: 1820,
      death_year: 1898,
      birth_edtf: '1820',
      death_edtf: '1898',
    }),
    makePerson({
      id: 'p_clara',
      slug: 'clara-finch',
      full_name: 'Clara Finch',
      lineage_group: 'ancestor',
      birth_year: 1824,
      death_year: 1858,
      birth_edtf: '1824',
      death_edtf: '1858',
    }),
    makePerson({
      id: 'p_nora',
      slug: 'nora-vance',
      full_name: 'Nora Vance',
      lineage_group: 'descendant_spouse',
      birth_year: 1835,
      death_year: 1912,
      birth_edtf: '1835',
      death_edtf: '1912',
    }),
    makePerson({
      id: 'p_henry',
      slug: 'henry-hale',
      full_name: 'Henry Hale',
      lineage_group: 'descendant',
      birth_year: 1846,
      death_year: 1922,
      birth_edtf: '1846',
      death_edtf: '1922',
    }),
    makePerson({
      id: 'p_sib_1',
      slug: 'martha-hale',
      full_name: 'Martha Hale',
      lineage_group: 'collateral',
      birth_year: 1848,
      death_year: 1910,
    }),
    makePerson({
      id: 'p_sib_2',
      slug: 'samuel-hale',
      full_name: 'Samuel Hale',
      lineage_group: 'collateral',
      birth_year: 1850,
      death_year: 1918,
    }),
    makePerson({
      id: 'p_sib_3',
      slug: 'grace-hale',
      full_name: 'Grace Hale',
      lineage_group: 'collateral',
      birth_year: 1852,
      death_year: 1924,
    }),
    makePerson({
      id: 'p_sib_4',
      slug: 'walter-hale',
      full_name: 'Walter Hale',
      lineage_group: 'collateral',
      birth_year: 1854,
      death_year: 1930,
    }),
    makePerson({
      id: 'p_infant_1',
      slug: 'peter-hale',
      full_name: 'Peter Hale',
      lineage_group: 'collateral',
      birth_year: 1855,
      death_year: 1856,
      birth_edtf: '1855',
      death_edtf: '1856',
    }),
    makePerson({
      id: 'p_living_redacted',
      slug: 'living-person',
      full_name: 'Living',
      lineage_group: 'descendant',
      is_living: true,
    }),
    makePerson({
      id: 'p_living_named',
      slug: 'rowan-hale',
      full_name: 'Rowan Hale',
      lineage_group: 'descendant',
      is_living: true,
      birth_year: 1995,
      birth_edtf: '1995',
    }),
    makePerson({
      id: 'p_vance_elder',
      slug: 'owen-vance',
      full_name: 'Owen Vance',
      lineage_group: 'ancestor',
      branch: 'vance_line',
      birth_year: 1805,
      death_year: 1879,
    }),
  ];

  const kinship: KinshipEdge[] = [
    { from: 'p_thomas', to: 'p_eliza', relation: 'spouse' },
    { from: 'p_eliza', to: 'p_thomas', relation: 'spouse' },
    { from: 'p_thomas', to: 'p_arthur', relation: 'parent' },
    { from: 'p_eliza', to: 'p_arthur', relation: 'parent' },
    { from: 'p_arthur', to: 'p_clara', relation: 'spouse' },
    { from: 'p_clara', to: 'p_arthur', relation: 'spouse' },
    { from: 'p_arthur', to: 'p_nora', relation: 'spouse' },
    { from: 'p_nora', to: 'p_arthur', relation: 'spouse' },
    ...['p_henry', 'p_sib_1', 'p_sib_2', 'p_sib_3', 'p_sib_4', 'p_infant_1'].flatMap((cid): KinshipEdge[] => [
      { from: 'p_arthur', to: cid, relation: 'parent' },
      { from: 'p_clara', to: cid, relation: 'parent' },
    ]),
    { from: 'p_henry', to: 'p_living_named', relation: 'parent' },
    { from: 'p_henry', to: 'p_living_redacted', relation: 'parent' },
  ];

  return {
    meta: {
      build_mode: 'public',
      generated_at: '2026-01-01T00:00:00Z',
      counts: {
        people: people.length,
        living_redacted: 1,
        events: 0,
        residence_spans: 0,
        places: 1,
        sources: 0,
      },
    },
    people,
    events: [],
    residence_spans: [],
    places,
    place_ancestors: {},
    kinship,
    sources: [],
  };
}

let activeCleanup: (() => void) | null = null;

function mountTreeAtWidth(width: number, initialEntry = '/tree'): { container: HTMLElement } {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 844,
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const bundle = buildTestBundle();

  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <ArchiveProvider siteConfig={TEST_SITE_CONFIG} initialBundle={bundle}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
  });

  activeCleanup = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.documentElement.classList.remove('tree-viewport-lock');
  };

  return { container };
}

afterEach(() => {
  activeCleanup?.();
  activeCleanup = null;
});

describe('TreePage', () => {
  it('defaults to Portrait Pedigree Roll + Direct Spine on mobile (390px) with expandable hanging grid and early-loss memorial chip', () => {
    const { container } = mountTreeAtWidth(390);

    const main = container.querySelector('main.tree-page');
    expect(main?.getAttribute('data-surface')).toBe('roll');
    expect(main?.getAttribute('data-mode')).toBe('spine');
    expect(document.documentElement.classList.contains('tree-viewport-lock')).toBe(false);

    // Redacted Living placeholder never renders; named living person displays calmly
    expect(container.querySelector('[aria-label="Inspect Living"]')).toBeNull();
    expect(container.textContent).toContain('Rowan Hale');
    expect(container.textContent).toContain('b. 1995 · Living');

    // Early loss child renders as compact chip inside "Died young" strip with accessible tooltip
    expect(container.textContent).toContain('Died young (1)');
    const earlyStrip = container.querySelector('.tree-early-strip');
    expect(earlyStrip?.getAttribute('aria-label')).toBe('Children who died at age 5 or younger');
    expect(earlyStrip?.getAttribute('title')).toBe('Children who died at age 5 or younger');
    const infantChip = container.querySelector<HTMLButtonElement>(
      'button.tree-early-chip[aria-label="Inspect Peter Hale"]'
    );
    expect(infantChip).not.toBeNull();

    // Collateral siblings start collapsed behind +4 siblings pill
    expect(container.querySelector('.tree-hanging-grid')).toBeNull();
    const sibToggle = container.querySelector<HTMLButtonElement>('button.tree-sibling-pill');
    expect(sibToggle?.textContent).toContain('+4 other children (1 in direct line below)');
    expect(sibToggle?.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      sibToggle?.click();
    });
    expect(sibToggle?.getAttribute('aria-expanded')).toBe('true');
    const hangingItems = container.querySelectorAll('.tree-hanging-grid .tree-roll-card');
    expect(hangingItems).toHaveLength(4);

    // Tapping an early-loss chip opens focus drawer with biography link and Died young label
    act(() => {
      infantChip?.click();
    });
    const drawer = container.querySelector('.tree-popover.tree-focus-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer?.textContent).toContain('Died young');
    expect(drawer?.textContent).toContain('Peter Hale');
    expect(drawer?.querySelector('a[href="/person/peter-hale"]')?.textContent).toContain('Open Profile →');
  });

  it('defaults to Chart View + Full Tree on desktop (1280px) with remarriage hubs, tap-to-trace spotlighting, and keyboard controls', () => {
    const { container } = mountTreeAtWidth(1280);

    const main = container.querySelector('main.tree-page');
    expect(main?.getAttribute('data-surface')).toBe('diagram');
    expect(main?.getAttribute('data-mode')).toBe('full');
    expect(document.documentElement.classList.contains('tree-viewport-lock')).toBe(true);

    const svg = container.querySelector('svg[role="group"]');
    expect(svg?.getAttribute('aria-label')).toBe('Hale family tree chart');

    // Discrete remarriage hubs I and II exist inside SVG
    const hubs = container.querySelectorAll('.tree-union-hub');
    expect(hubs.length).toBeGreaterThanOrEqual(3);
    expect(svg?.textContent).toContain('I');
    expect(svg?.textContent).toContain('II');

    // Orthogonal bus routes exist (no cubic Beziers)
    const busPaths = [...container.querySelectorAll<SVGPathElement>('.tree-layer-buses path')];
    expect(busPaths.length).toBeGreaterThan(0);
    for (const path of busPaths) {
      expect(path.getAttribute('d')).not.toContain('C ');
    }

    // Expand collapsed siblings inside SVG diagram
    const svgSibBtn = container.querySelector<SVGGElement>('.tree-diagram-sibling-btn');
    expect(svgSibBtn?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      svgSibBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(svgSibBtn?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.tree-hanging-rail').length).toBe(1);

    // Keyboard Enter selects Henry Hale, spotlights direct lineage, and displays clickable ancestor breadcrumb
    const henryNode = container.querySelector<SVGGElement>(
      '.tree-node-card[aria-label="Inspect Henry Hale"]'
    );
    expect(henryNode).not.toBeNull();
    act(() => {
      henryNode?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(svg?.classList.contains('has-selection')).toBe(true);
    expect(henryNode?.classList.contains('is-lit')).toBe(true);

    const drawer = container.querySelector('.tree-popover.tree-focus-drawer');
    expect(drawer?.textContent).toContain('Henry Hale');
    expect(drawer?.textContent).toContain('Child of Arthur Hale');
    const crumbButtons = [...(drawer?.querySelectorAll<HTMLButtonElement>('.tree-focus-crumb-btn') ?? [])];
    expect(crumbButtons.map((b) => b.textContent)).toEqual(['Thomas', 'Arthur']);

    // Clicking ancestor breadcrumb shifts focus to Thomas Hale
    act(() => {
      crumbButtons[0]?.click();
    });
    expect(container.querySelector('.tree-focus-name')?.textContent).toBe('Thomas Hale');

    // Escape clears focus and restores un-dimmed canvas
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('.tree-focus-drawer')).toBeNull();
    expect(svg?.classList.contains('has-selection')).toBe(false);
  });

  it('switches between List and Chart surfaces and filters branches cleanly', () => {
    const { container } = mountTreeAtWidth(1280);

    const listBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'List'
    );
    expect(listBtn).not.toBeNull();
    act(() => {
      listBtn?.click();
    });
    expect(container.querySelector('main.tree-page')?.getAttribute('data-surface')).toBe('roll');
    expect(document.documentElement.classList.contains('tree-viewport-lock')).toBe(false);

    const branchSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Select family branch"]'
    );
    expect(branchSelect).not.toBeNull();
    act(() => {
      if (branchSelect) {
        branchSelect.value = 'vance_line';
        branchSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
    });
    expect(container.textContent).toContain('Owen Vance');
    expect(container.textContent).not.toContain('Thomas Hale');
  });

  it('finds a collapsed sibling via desktop Find person combobox, auto-expands their sibling tray, spotlights lineage, and excludes living names', () => {
    const { container } = mountTreeAtWidth(1280);

    const searchInput = container.querySelector<HTMLInputElement>('input.tree-search-input[role="combobox"]');
    expect(searchInput).not.toBeNull();

    // Living names and redacted Living placeholders never appear in public search results
    const setInputValue = (input: HTMLInputElement, nextVal: string): void => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, nextVal);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    act(() => {
      searchInput?.focus();
      if (searchInput) {
        setInputValue(searchInput, 'Rowan');
      }
    });
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(container.querySelector('.tree-search-empty')?.textContent).toContain('No matching people');

    act(() => {
      if (searchInput) {
        setInputValue(searchInput, 'Living');
      }
    });
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);

    // Searching for collapsed sibling Martha Hale shows her in the listbox and auto-expands her tray on selection
    expect(container.querySelector('.tree-hanging-rail')).toBeNull();
    act(() => {
      if (searchInput) {
        setInputValue(searchInput, 'Martha');
      }
    });
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('Martha Hale');
    expect(options[0]?.textContent).toContain('Other children');

    act(() => {
      options[0]?.click();
    });

    // Collapsed sibling tray expanded automatically, Martha Hale is focused & spotlighted
    expect(container.querySelectorAll('.tree-hanging-rail')).toHaveLength(1);
    expect(container.querySelector('.tree-focus-name')?.textContent).toBe('Martha Hale');
    const svg = container.querySelector('svg[role="group"]');
    expect(svg?.classList.contains('has-selection')).toBe(true);
    const marthaNode = container.querySelector('.tree-node-card[aria-label="Inspect Martha Hale"]');
    expect(marthaNode?.classList.contains('is-selected')).toBe(true);
    expect(marthaNode?.classList.contains('is-lit')).toBe(true);
  });

  it('opens compact mobile search toggle on roll surface, auto-expands collapsed sibling, and scrolls them into view', () => {
    const scrollCalls: Array<{ id: string; block?: string }> = [];
    const origScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function mockScroll(arg?: boolean | ScrollIntoViewOptions) {
      const id = (this as HTMLElement).dataset?.personId ?? '';
      const block = typeof arg === 'object' && arg ? arg.block : undefined;
      scrollCalls.push({ id, block });
    };

    try {
      const { container } = mountTreeAtWidth(390);
      const toggleBtn = container.querySelector<HTMLButtonElement>(
        'button.tree-search-toggle-btn[aria-label="Find person in tree"]'
      );
      expect(toggleBtn).not.toBeNull();
      expect(toggleBtn?.getAttribute('aria-expanded')).toBe('false');

      act(() => {
        toggleBtn?.click();
      });
      expect(toggleBtn?.getAttribute('aria-expanded')).toBe('true');

      const mobileInput = container.querySelector<HTMLInputElement>('input.tree-search-mobile-input');
      expect(mobileInput).not.toBeNull();

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      act(() => {
        if (mobileInput) {
          setter?.call(mobileInput, 'Walter');
          mobileInput.dispatchEvent(new window.Event('input', { bubbles: true }));
        }
      });

      const walterOpt = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((el) =>
        el.textContent?.includes('Walter Hale')
      );
      expect(walterOpt).not.toBeUndefined();

      act(() => {
        walterOpt?.click();
      });

      expect(container.querySelector('.tree-hanging-grid')).not.toBeNull();
      expect(container.querySelector('.tree-focus-name')?.textContent).toBe('Walter Hale');
      expect(scrollCalls.some((c) => c.id === 'p_sib_4' && c.block === 'center')).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView;
    }
  });
});
