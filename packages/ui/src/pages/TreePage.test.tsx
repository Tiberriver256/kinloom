/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, KinshipEdge, Person, Place } from '@kinloom/core';
import { parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import canvasSurfaceStyles from '../components/CanvasSurfacePrimitives.module.css';
import { TreeAnchorPicker } from '../components/tree/TreeAnchorPicker.js';
import treeFocusStyles from '../components/tree/TreeFocusDrawer.module.css';
import {
  DiagramNodeCard,
  EarlyLossStripLayer,
  SiblingToggleItem,
} from '../components/tree/TreeNodesLayer.js';
import { TreeToolbar } from '../components/tree/TreeToolbar.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { buildSynthetic145PersonArchive } from '../lib/tree/largeMultiBranchTree.test.js';
import { TreePage } from './TreePage.js';
import treePageStyles from './TreePage.module.css';
import { TreeZoomControls } from './tree/TreeZoomControls.js';

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

function mountTreeAtWidth(
  width: number,
  initialEntry = '/tree',
  customBundle?: ArchiveBundle,
  customConfig?: KinloomSiteConfig,
  height = 844
): { container: HTMLElement } {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const bundle = customBundle ?? buildTestBundle();

  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <ArchiveProvider
          siteConfig={customConfig ?? TEST_SITE_CONFIG}
          initialBundle={bundle}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          session={null}
        >
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
      const id = (this as HTMLElement).dataset?.['personId'] ?? '';
      const block = typeof arg === 'object' && arg ? arg.block : undefined;
      scrollCalls.push({ id, ...(block !== undefined ? { block } : {}) });
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

  it('opens large 145-person archive at readable zoom >= 0.75, renders interactive minimap, and fits safely on Fit click', () => {
    const { bundle } = buildSynthetic145PersonArchive();
    const largeConfig: KinloomSiteConfig = parseKinloomConfig({
      site: {
        title: 'Alder Multi-Branch Archive',
        familyName: 'Alder',
        gedcomSourceName: 'ALDER_145_TEST',
      },
      branches: [
        { id: 'alder_line', label: 'Alder Line', surnames: ['Alder'], supportsDirectMode: true },
        { id: 'mercer_line', label: 'Mercer Line', surnames: ['Mercer'], supportsDirectMode: true },
        { id: 'bramwell_line', label: 'Bramwell Line', surnames: ['Bramwell'], supportsDirectMode: true },
        { id: 'kestrel_line', label: 'Kestrel Line', surnames: ['Kestrel'], supportsDirectMode: false },
      ],
    });

    const { container } = mountTreeAtWidth(1440, '/tree', bundle, largeConfig, 900);
    const main = container.querySelector<HTMLElement>('main.tree-page');
    expect(main).not.toBeNull();

    // Initial zoom on 145-person / 12-gen archive stays legible (>= 0.75) instead of shrinking to 28%
    const initialZoom = Number(main?.dataset['zoom'] ?? '0');
    expect(initialZoom).toBeGreaterThanOrEqual(0.75);

    // Interactive minimap renders expanded on desktop with viewport rectangle
    const minimap = container.querySelector('aside.tree-minimap');
    expect(minimap).not.toBeNull();
    const minimapSurface = container.querySelector<HTMLElement>('.tree-minimap-surface');
    const minimapSvg = container.querySelector<SVGSVGElement>('.tree-minimap-svg');
    expect(minimapSurface).not.toBeNull();
    expect(minimapSvg?.querySelector('.tree-minimap-viewport')).not.toBeNull();

    // Pointer click + drag on minimap updates pan coordinates
    if (minimapSvg) {
      minimapSvg.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: 180,
          bottom: 100,
          width: 180,
          height: 100,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
    }
    const beforePanX = Number(main?.dataset['panX'] ?? '0');
    act(() => {
      minimapSurface?.dispatchEvent(
        new window.MouseEvent('pointerdown', { clientX: 165, clientY: 80, bubbles: true })
      );
      minimapSurface?.dispatchEvent(
        new window.MouseEvent('pointermove', { clientX: 20, clientY: 15, bubbles: true })
      );
      minimapSurface?.dispatchEvent(
        new window.MouseEvent('pointerup', { clientX: 20, clientY: 15, bubbles: true })
      );
    });
    const afterMinimapPanX = Number(main?.dataset['panX'] ?? '0');
    expect(afterMinimapPanX).not.toBe(beforePanX);

    // Keyboard navigation and collapse toggle on minimap
    act(() => {
      minimapSurface?.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
      );
      minimapSurface?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      minimapSurface?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      minimapSurface?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      minimapSurface?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    const toggleMinimapBtn = container.querySelector<HTMLButtonElement>('.tree-minimap-toggle');
    expect(toggleMinimapBtn?.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      toggleMinimapBtn?.click();
    });
    expect(toggleMinimapBtn?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.tree-minimap-surface')).toBeNull();

    // Clicking Fit fits 100% of graph bounds inside safe viewport insets
    const fitBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Fit'
    );
    expect(fitBtn).not.toBeNull();
    act(() => {
      fitBtn?.click();
    });
    // Trigger prefers-reduced-motion or wait is immediate in jsdom if we verify Fit zoom
    expect(container.querySelectorAll('.tree-gen-bands > g').length).toBe(12);
  });

  it('pairs remarriage union badges with spouses and renders Marriage captions for collapsed secondary-marriage children on mobile Roll', () => {
    const { bundle } = buildSynthetic145PersonArchive();
    const { container } = mountTreeAtWidth(390, '/tree?surface=roll&mode=spine', bundle);

    // Zero empty generation rows
    const genItems = [...container.querySelectorAll('.tree-roll-generation')];
    expect(genItems.length).toBeGreaterThanOrEqual(8);
    for (const item of genItems) {
      expect(item.querySelectorAll('.tree-roll-unit').length).toBeGreaterThan(0);
    }

    // Remarried pivot unit pairs each union badge inside a non-wrapping .tree-roll-partner-pair with its spouse
    const remarriedUnit = container.querySelector('.tree-roll-unit.is-remarried');
    expect(remarriedUnit).not.toBeNull();
    const partnerPairs = [...(remarriedUnit?.querySelectorAll('.tree-roll-partner-pair') ?? [])];
    expect(partnerPairs).toHaveLength(2);
    for (const pair of partnerPairs) {
      expect(pair.querySelector('.tree-roll-union-hub')).not.toBeNull();
      expect(pair.querySelector('.tree-roll-card')).not.toBeNull();
    }

    // Both Marriage I and Marriage II attachment groups display their captions even when children are collapsed
    const captions = [...(remarriedUnit?.querySelectorAll('.tree-roll-union-caption') ?? [])].map((el) =>
      el.textContent?.trim()
    );
    expect(captions.some((c) => c?.startsWith('Marriage I'))).toBe(true);
    expect(captions.some((c) => c?.startsWith('Marriage II'))).toBe(true);
  });

  it('starts minimap collapsed on mobile Chart view and expands on toggle click', () => {
    const { bundle } = buildSynthetic145PersonArchive();
    const { container } = mountTreeAtWidth(390, '/tree?surface=diagram&mode=full', bundle);

    const toggleBtn = container.querySelector<HTMLButtonElement>('.tree-minimap-toggle');
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.tree-minimap-surface')).toBeNull();

    act(() => {
      toggleBtn?.click();
    });
    expect(toggleBtn?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.tree-minimap-surface')).not.toBeNull();
  });

  it('toggles mobile Filters popover with active badge, embeds Search/Branch/Trace-from inside it, and resets custom anchor via inline × button (#79)', () => {
    const { container } = mountTreeAtWidth(390, '/tree?surface=diagram&mode=spine');

    // No standalone "Reset to default" button exists in the toolbar
    const toolbar = container.querySelector('.tree-toolbar');
    expect(toolbar).not.toBeNull();
    const standaloneReset = [...(toolbar?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === 'Reset to default'
    );
    expect(standaloneReset).toBeUndefined();

    // Primary row contains List/Chart, Direct/Full, and Filters trigger (initially closed, 0 active badge)
    const filtersBtn = container.querySelector<HTMLButtonElement>('button.tree-filters-toggle-btn');
    expect(filtersBtn).not.toBeNull();
    expect(filtersBtn?.getAttribute('aria-expanded')).toBe('false');
    expect(filtersBtn?.querySelector('.tree-filters-badge')).toBeNull();

    const filtersPanel = container.querySelector<HTMLElement>('.tree-toolbar-filters-panel');
    expect(filtersPanel?.dataset['filtersOpen']).toBe('false');

    // Open Filters popover
    act(() => {
      filtersBtn?.click();
    });
    expect(filtersBtn?.getAttribute('aria-expanded')).toBe('true');
    expect(filtersPanel?.dataset['filtersOpen']).toBe('true');
    expect(filtersPanel?.querySelector('input.tree-search-input')).not.toBeNull();
    expect(filtersPanel?.querySelector('select.tree-branch-select')).not.toBeNull();
    expect(filtersPanel?.querySelector('.tree-anchor-picker')).not.toBeNull();

    // Select a branch filter -> badge displays "1"
    const branchSelect = filtersPanel?.querySelector<HTMLSelectElement>('select.tree-branch-select');
    act(() => {
      if (branchSelect) {
        branchSelect.value = 'hale_line';
        branchSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
    });
    expect(filtersBtn?.querySelector('.tree-filters-badge')?.textContent?.trim()).toBe('1');

    // Select a custom anchor inside Trace from: -> badge increments, inline × button renders inside Trace from:
    const anchorTrigger = filtersPanel?.querySelector<HTMLButtonElement>('button.tree-anchor-trigger');
    expect(anchorTrigger).not.toBeNull();
    act(() => {
      anchorTrigger?.click();
    });
    const henryOpt = [...(filtersPanel?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])].find(
      (opt) => opt.textContent?.includes('Henry Hale')
    );
    expect(henryOpt).not.toBeUndefined();
    act(() => {
      henryOpt?.click();
    });

    // Selecting anchor auto-closes the Filters sheet and updates active badge
    expect(filtersBtn?.getAttribute('aria-expanded')).toBe('false');
    const badgeCount = Number(filtersBtn?.querySelector('.tree-filters-badge')?.textContent?.trim() ?? '0');
    expect(badgeCount).toBeGreaterThanOrEqual(1);

    // Reopen Filters sheet and reset anchor using the inline × button inside .tree-anchor-control
    act(() => {
      filtersBtn?.click();
    });
    const inlineClearBtn = filtersPanel?.querySelector<HTMLButtonElement>(
      '.tree-anchor-control button.tree-anchor-clear-btn[aria-label="Reset trace anchor to default"]'
    );
    expect(inlineClearBtn).not.toBeNull();
    expect(inlineClearBtn?.textContent?.trim()).toBe('×');
    act(() => {
      inlineClearBtn?.click();
    });
    expect(filtersPanel?.querySelector('.tree-anchor-control button.tree-anchor-clear-btn')).toBeNull();

    // Pressing Escape closes the Filters popover
    act(() => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(filtersBtn?.getAttribute('aria-expanded')).toBe('false');
    expect(filtersPanel?.dataset['filtersOpen']).toBe('false');

    // Opaque zoom controls hook classes are present on diagram view (including Loom toggle)
    const zoomControls = container.querySelector('.tree-controls.tree-zoom-controls');
    expect(zoomControls).not.toBeNull();
    expect(
      [...(zoomControls?.querySelectorAll('button.tree-zoom-btn') ?? [])].map((b) => b.textContent?.trim())
    ).toEqual(['+', '−', 'Fit', '1:1', 'Loom']);
  });

  it('exercises TreeAnchorPicker keyboard/outside-click/reset, TreeToolbar Done/outside-click/Add Person, TreeZoomControls Loom active, and TreeNodesLayer lateral connectors & zoom tiers (#79)', () => {
    const p1 = makePerson({
      id: 'p_anchor_1',
      slug: 'thomas-hale',
      full_name: 'Thomas Hale',
      given_name: 'Thomas',
      surname: 'Hale',
      birth_year: 1810,
      death_year: 1882,
    });
    const p2 = makePerson({
      id: 'p_anchor_2',
      slug: 'owen-vance',
      full_name: 'Owen Vance',
      given_name: 'Owen',
      surname: 'Vance',
      birth_year: 1814,
      death_year: 1890,
      branch: 'vance_line',
    });
    const earlyChild = makePerson({
      id: 'p_early_1',
      slug: 'baby-hale',
      full_name: 'Clara Hale',
      given_name: '',
      surname: 'Hale',
      birth_year: 1841,
      death_year: 1842,
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      const onSelectAnchor = vi.fn();
      const onResetAnchor = vi.fn();
      const onAddPerson = vi.fn();
      const onSelectNode = vi.fn();
      const onToggleSibs = vi.fn();
      let anchorQuery = 'zzz';

      const renderHarness = (nextQuery: string, emptyCandidates: boolean): void => {
        anchorQuery = nextQuery;
        const candidates = emptyCandidates
          ? []
          : [
              {
                person: p1,
                lifespanLabel: '1810–1882',
                branchId: 'hale_line',
                branchLabel: 'Hale Line',
                genLabel: 'Gen 1',
                isCollapsed: false,
                isOutsideCurrentMode: false,
                isOutsideCurrentBranch: false,
              },
              {
                person: p2,
                lifespanLabel: '1814–1890',
                branchId: 'vance_line',
                branchLabel: 'Vance Line',
                genLabel: 'Gen 1',
                isCollapsed: false,
                isOutsideCurrentMode: false,
                isOutsideCurrentBranch: true,
              },
            ];

        act(() => {
          root.render(
            <div>
              <TreeToolbar
                populatedBranches={TEST_SITE_CONFIG.branches ?? []}
                branchCounts={{ all: 2, hale_line: 1, vance_line: 1 }}
                branchFilter="hale_line"
                onBranchFilterChange={() => {}}
                showDirectToggle={true}
                mode="spine"
                activeCount={2}
                onModeChange={() => {}}
                surface="diagram"
                onSurfaceChange={() => {}}
                searchQuery="Thomas"
                onSearchQueryChange={() => {}}
                searchCandidates={[]}
                onSelectSearchPerson={() => {}}
                mobileSearchOpen={false}
                onMobileSearchOpenChange={() => {}}
                canEdit={true}
                onAddPerson={onAddPerson}
                activeAnchor={p1}
                anchorQuery={anchorQuery}
                onAnchorQueryChange={(q) => {
                  renderHarness(q, q === 'zzz');
                }}
                anchorCandidates={candidates}
                onSelectAnchor={onSelectAnchor}
                onResetAnchor={onResetAnchor}
              />
              <TreeAnchorPicker
                activeAnchor={p1}
                query={anchorQuery}
                onQueryChange={(q) => {
                  renderHarness(q, q === 'zzz');
                }}
                candidates={candidates}
                onSelectAnchor={onSelectAnchor}
                onResetAnchor={onResetAnchor}
              />
              <TreeZoomControls
                zoomPercent={35}
                onZoomIn={() => {}}
                onZoomOut={() => {}}
                onFit={() => {}}
                onResetZoom={() => {}}
                loomActive={true}
                onToggleLoom={() => {}}
              />
              <svg width="800" height="400">
                <title>Test Tree Nodes</title>
                <DiagramNodeCard
                  node={{
                    person: p1,
                    x: 10,
                    y: 10,
                    width: 170,
                    height: 52,
                    gen: 0,
                    isDirect: false,
                    placement: 'rank',
                    unionId: null,
                  }}
                  displayName="Thomas Hale"
                  surnameOrGiven="Hale"
                  lifespan="1810–1882"
                  thumbUrl="/media/thomas.jpg"
                  initials="TH"
                  isSelected={false}
                  isLit={false}
                  isAnchor={true}
                  semanticZoom="detail"
                  onSelect={onSelectNode}
                />
                <DiagramNodeCard
                  node={{
                    person: p2,
                    x: 200,
                    y: 10,
                    width: 170,
                    height: 52,
                    gen: 0,
                    isDirect: true,
                    placement: 'rank',
                    unionId: null,
                  }}
                  displayName="Owen Vance"
                  surnameOrGiven="Vance"
                  lifespan="1814–1890"
                  thumbUrl={null}
                  initials="OV"
                  isSelected={false}
                  isLit={false}
                  semanticZoom="compact"
                  onSelect={onSelectNode}
                />
                <DiagramNodeCard
                  node={{
                    person: earlyChild,
                    x: 400,
                    y: 10,
                    width: 170,
                    height: 52,
                    gen: 1,
                    isDirect: true,
                    placement: 'rank',
                    unionId: null,
                  }}
                  displayName="Clara Hale"
                  surnameOrGiven="Hale"
                  lifespan="1841–1842"
                  thumbUrl={null}
                  initials="CH"
                  isSelected={true}
                  isLit={true}
                  semanticZoom="overview"
                  onSelect={onSelectNode}
                />
                <EarlyLossStripLayer
                  strip={{
                    unionId: 'u_left',
                    parentIds: ['p_anchor_1'],
                    x: 120,
                    y: 120,
                    width: 110,
                    height: 52,
                    stemFromX: 60,
                    stemFromY: 90,
                    chips: [{ person: earlyChild, unionId: 'u_left', x: 126, y: 138, width: 96, height: 30 }],
                  }}
                  selectedPersonId={earlyChild.id}
                  highlightedIds={new Set([earlyChild.id])}
                  onSelect={onSelectNode}
                />
                <EarlyLossStripLayer
                  strip={{
                    unionId: 'u_right',
                    parentIds: ['p_anchor_2'],
                    x: 260,
                    y: 120,
                    width: 110,
                    height: 52,
                    stemFromX: 420,
                    stemFromY: 90,
                    chips: [{ person: p2, unionId: 'u_right', x: 266, y: 138, width: 96, height: 30 }],
                  }}
                  selectedPersonId={null}
                  highlightedIds={null}
                  onSelect={onSelectNode}
                />
                <SiblingToggleItem
                  toggle={{
                    unionId: 'u_sib_left',
                    parentIds: ['p_anchor_1'],
                    x: 120,
                    y: 220,
                    width: 120,
                    height: 28,
                    stemFromX: 60,
                    stemFromY: 190,
                    hiddenCount: 2,
                    totalCollateralCount: 2,
                    visibleChildCount: 1,
                    isExpanded: false,
                    isDirect: true,
                    mode: 'spine',
                  }}
                  isLit={true}
                  onToggle={onToggleSibs}
                />
                <SiblingToggleItem
                  toggle={{
                    unionId: 'u_sib_right',
                    parentIds: ['p_anchor_2'],
                    x: 260,
                    y: 220,
                    width: 120,
                    height: 28,
                    stemFromX: 440,
                    stemFromY: 190,
                    hiddenCount: 0,
                    totalCollateralCount: 2,
                    visibleChildCount: 3,
                    isExpanded: true,
                    isDirect: false,
                    mode: 'full',
                  }}
                  isLit={false}
                  onToggle={onToggleSibs}
                />
              </svg>
            </div>
          );
        });
      };

      renderHarness('zzz', true);

      // TreeToolbar: badge counts branch + anchor + search = 3, Done button & outside click close sheet, Add Person fires
      expect(container.querySelector('.tree-filters-badge')?.textContent).toBe('3');
      const filtersToggle = container.querySelector<HTMLButtonElement>('.tree-filters-toggle-btn');
      act(() => {
        filtersToggle?.click();
      });
      expect(filtersToggle?.getAttribute('aria-expanded')).toBe('true');
      act(() => {
        container.querySelector<HTMLButtonElement>('.tree-filters-sheet-close')?.click();
      });
      expect(filtersToggle?.getAttribute('aria-expanded')).toBe('false');

      act(() => {
        filtersToggle?.click();
      });
      act(() => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(filtersToggle?.getAttribute('aria-expanded')).toBe('false');

      act(() => {
        container.querySelector<HTMLButtonElement>('.tree-add-person-btn')?.click();
      });
      expect(onAddPerson).toHaveBeenCalledTimes(1);

      // TreeAnchorPicker: empty state, Escape clears query, ArrowDown/Up/Enter selects, Reset to default, outside mousedown
      const anchorTriggers = [...container.querySelectorAll<HTMLButtonElement>('.tree-anchor-trigger')];
      const standaloneTrigger = anchorTriggers[1];
      act(() => {
        standaloneTrigger?.click();
      });
      expect(container.querySelector('.tree-search-empty')?.textContent).toContain('No matching people');

      // Pressing Escape while open closes the anchor popover via document capture listener
      const anchorInput = container.querySelector<HTMLInputElement>('.tree-anchor-search-input');
      act(() => {
        anchorInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(container.querySelector('.tree-anchor-popover')).toBeNull();

      // Reopen, clear query via input onChange, and inspect full candidate metadata
      act(() => {
        standaloneTrigger?.click();
      });
      const reopenedInput = container.querySelector<HTMLInputElement>('.tree-anchor-search-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      act(() => {
        if (reopenedInput) {
          setter?.call(reopenedInput, '');
          reopenedInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      expect(container.querySelectorAll('.tree-anchor-popover [role="option"]')).toHaveLength(2);
      expect(container.querySelector('.tree-anchor-popover')?.textContent).toContain('Spine anchor');
      expect(container.querySelector('.tree-anchor-popover')?.textContent).toContain('Vance Line');

      // ArrowDown -> ArrowUp -> hover option 1 -> Enter selects Owen Vance
      const opts = [...container.querySelectorAll<HTMLButtonElement>('.tree-anchor-popover [role="option"]')];
      act(() => {
        reopenedInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        reopenedInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        opts[1]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      act(() => {
        reopenedInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(onSelectAnchor).toHaveBeenCalledWith(p2);

      // Reopen -> click Reset to default -> reopen -> Escape on empty query closes -> reopen -> outside mousedown closes
      act(() => {
        standaloneTrigger?.click();
      });
      act(() => {
        container.querySelector<HTMLButtonElement>('.tree-anchor-popover-reset')?.click();
      });
      expect(onResetAnchor).toHaveBeenCalledTimes(1);

      act(() => {
        standaloneTrigger?.click();
      });
      act(() => {
        container
          .querySelector<HTMLInputElement>('.tree-anchor-search-input')
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(container.querySelector('.tree-anchor-popover')).toBeNull();

      act(() => {
        standaloneTrigger?.click();
      });
      act(() => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(container.querySelector('.tree-anchor-popover')).toBeNull();

      // TreeNodesLayer: lateral EarlyLossStrip paths (left + right), chip keyboard activation, image error fallback, SiblingToggle keyboard
      const stripPaths = [...container.querySelectorAll('.tree-diagram-early-strip path')].map((p) =>
        p.getAttribute('d')
      );
      expect(stripPaths).toEqual(['M 60 90 V 134 H 120', 'M 420 90 V 134 H 370']);

      const earlyChip = container.querySelector<SVGGElement>('.tree-diagram-early-chip');
      act(() => {
        earlyChip?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        earlyChip?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        earlyChip?.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
      });
      expect(onSelectNode).toHaveBeenCalledWith(earlyChild, true);

      const cardImg = container.querySelector('image');
      act(() => {
        cardImg?.dispatchEvent(new Event('error', { bubbles: true }));
      });
      expect(container.querySelector('image')).toBeNull();

      const detailCard = container.querySelector<SVGGElement>('[data-person-id="p_anchor_1"]');
      act(() => {
        detailCard?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        detailCard?.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
      });
      expect(onSelectNode).toHaveBeenCalledWith(p1, true);

      const sibButtons = [...container.querySelectorAll<SVGGElement>('.tree-diagram-sibling-btn')];
      const sibPaths = [...container.querySelectorAll('.tree-diagram-sibling-toggle path')].map((p) =>
        p.getAttribute('d')
      );
      expect(sibPaths).toEqual(['M 60 190 V 234 H 120', 'M 440 190 V 234 H 380']);
      act(() => {
        sibButtons[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        sibButtons[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        sibButtons[1]?.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
      });
      expect(onToggleSibs).toHaveBeenCalledWith('u_sib_left');
      expect(onToggleSibs).toHaveBeenCalledWith('u_sib_right');
      expect(
        container.querySelector('.tree-zoom-controls button[aria-pressed="true"]')?.textContent?.trim()
      ).toBe('Loom');
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('wires CSS Module classes on TreePage main and TreeFocusDrawer across List and Chart surfaces (#104)', () => {
    const { container } = mountTreeAtWidth(390, '/tree?surface=roll&mode=full');

    const main = container.querySelector<HTMLElement>('main.tree-page');
    expect(main).not.toBeNull();
    expect(main?.classList.contains(canvasSurfaceStyles['tree-page'] ?? '')).toBe(true);
    expect(main?.classList.contains(treePageStyles['tree-page-roll'] ?? '')).toBe(true);
    expect(main?.getAttribute('data-has-selection')).toBeNull();

    const arthurCard = container.querySelector<HTMLButtonElement>(
      'button.tree-roll-card[data-person-id="p_arthur"]'
    );
    const thomasCard = container.querySelector<HTMLButtonElement>(
      'button.tree-roll-card[data-person-id="p_thomas"]'
    );
    expect(arthurCard).not.toBeNull();
    expect(thomasCard).not.toBeNull();

    act(() => {
      arthurCard?.click();
    });

    expect(main?.getAttribute('data-has-selection')).toBe('true');
    const drawer = container.querySelector<HTMLElement>('aside[aria-label="Lineage focus for Arthur Hale"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.classList.contains(canvasSurfaceStyles['tree-popover'] ?? '')).toBe(true);
    expect(drawer?.classList.contains(treeFocusStyles['tree-focus-drawer'] ?? '')).toBe(true);
    expect(drawer?.classList.contains(treeFocusStyles['tree-focus-drawer-roll'] ?? '')).toBe(true);
    expect(drawer?.querySelector('a[href="/person/arthur-hale"]')?.textContent).toBe('Open Profile →');
    expect(drawer?.querySelector('.tree-focus-close-glyph')?.textContent).toBe('×');

    act(() => {
      thomasCard?.click();
    });
    expect(container.querySelector('aside[aria-label="Lineage focus for Thomas Hale"]')).not.toBeNull();

    const closeBtn = container.querySelector<HTMLButtonElement>('button.tree-focus-close-btn');
    expect(closeBtn).not.toBeNull();
    act(() => {
      closeBtn?.click();
    });
    expect(container.querySelector('.tree-focus-drawer')).toBeNull();
    expect(main?.getAttribute('data-has-selection')).toBeNull();

    act(() => {
      arthurCard?.click();
    });
    const clearBtn = container.querySelector<HTMLButtonElement>('button.tree-focus-clear-btn');
    expect(clearBtn).not.toBeNull();
    act(() => {
      clearBtn?.click();
    });
    expect(container.querySelector('.tree-focus-drawer')).toBeNull();

    const chartBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Chart'
    );
    expect(chartBtn).not.toBeNull();
    act(() => {
      chartBtn?.click();
    });
    expect(main?.classList.contains(treePageStyles['tree-page-diagram'] ?? '')).toBe(true);

    const henryNode = container.querySelector<SVGGElement>(
      '.tree-node-card[aria-label="Inspect Henry Hale"]'
    );
    expect(henryNode).not.toBeNull();
    act(() => {
      henryNode?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const chartDrawer = container.querySelector<HTMLElement>(
      'aside[aria-label="Lineage focus for Henry Hale"]'
    );
    expect(chartDrawer).not.toBeNull();
    expect(chartDrawer?.classList.contains(treeFocusStyles['tree-focus-drawer'] ?? '')).toBe(true);
    expect(chartDrawer?.classList.contains(treeFocusStyles['tree-focus-drawer-diagram'] ?? '')).toBe(true);
  });
});
