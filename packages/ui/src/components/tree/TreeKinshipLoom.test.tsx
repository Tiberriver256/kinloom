/** @vitest-environment jsdom */
import type { ArchiveBundle, KinshipEdge, Person } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { buildArchivalTreeModel } from '../../lib/archivalTreeModel.js';
import {
  computeKinshipLoomLabelPlacements,
  computeKinshipLoomLayout,
  computeKinshipLoomSpotlight,
} from '../../lib/tree/kinshipLoomModel.js';
import { TreePage } from '../../pages/TreePage.js';
import { TreeKinshipLoom } from './TreeKinshipLoom.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makePerson(overrides: Partial<Person> & { id: string; slug: string; full_name: string }): Person {
  const parts = overrides.full_name.split(' ');
  return {
    given_name: parts[0] ?? overrides.full_name,
    surname: parts[parts.length - 1] ?? 'Alder',
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '1850',
    death_edtf: '1920',
    birth_year: 1850,
    death_year: 1920,
    primary_place_id: null,
    event_count: 1,
    portrait_url: null,
    ...overrides,
  };
}

function buildMultiBranchModel() {
  const people: Person[] = [
    makePerson({
      id: 'per_alder_root',
      slug: 'william-alder',
      full_name: 'William Alder',
      surname: 'Alder',
      branch: 'alder',
      birth_edtf: '1790',
      birth_year: 1790,
      death_edtf: '1865',
      death_year: 1865,
    }),
    makePerson({
      id: 'per_mercer_spouse',
      slug: 'hannah-mercer',
      full_name: 'Hannah Mercer',
      surname: 'Mercer',
      branch: 'mercer',
      birth_edtf: '1794',
      birth_year: 1794,
      death_edtf: '1870',
      death_year: 1870,
    }),
    makePerson({
      id: 'per_alder_child',
      slug: 'thomas-alder',
      full_name: 'Thomas Alder',
      surname: 'Alder',
      branch: 'alder',
      birth_edtf: '1824',
      birth_year: 1824,
      death_edtf: '1898',
      death_year: 1898,
    }),
    makePerson({
      id: 'per_alder_grandchild',
      slug: 'clara-alder',
      full_name: 'Clara Alder',
      surname: 'Alder',
      branch: 'alder',
      birth_edtf: '',
      birth_year: null,
      death_edtf: '',
      death_year: null,
    }),
    makePerson({
      id: 'per_unrelated_vance',
      slug: 'henry-vance',
      full_name: 'Henry Vance',
      surname: 'Vance',
      branch: 'vance',
      birth_edtf: '1830',
      birth_year: 1830,
      death_edtf: '1900',
      death_year: 1900,
    }),
  ];

  const kinship: KinshipEdge[] = [
    { from: 'per_alder_root', to: 'per_mercer_spouse', relation: 'spouse' },
    { from: 'per_alder_root', to: 'per_alder_child', relation: 'parent' },
    { from: 'per_mercer_spouse', to: 'per_alder_child', relation: 'parent' },
    { from: 'per_alder_child', to: 'per_alder_grandchild', relation: 'parent' },
  ];

  const model = buildArchivalTreeModel({
    people,
    kinship,
    mode: 'full',
  });

  return { people, kinship, model };
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

describe('kinshipLoomModel pure layout, label collision avoidance & spotlight (#72, #123)', () => {
  it('handles empty model cleanly', () => {
    const emptyModel = buildArchivalTreeModel({ people: [], kinship: [], mode: 'full' });
    const layout = computeKinshipLoomLayout({ model: emptyModel });
    expect(layout.nodes).toEqual([]);
    expect(layout.threads).toEqual([]);
    expect(layout.decadeTicks).toEqual([]);
    expect(computeKinshipLoomSpotlight(emptyModel, null)).toBeNull();
    expect(computeKinshipLoomSpotlight(emptyModel, 'missing')).toBeNull();
    expect(
      computeKinshipLoomLabelPlacements({
        nodes: [],
        visiblePersonIds: new Set(),
        width: 960,
        height: 640,
      }).size
    ).toBe(0);
  });

  it('positions ancestors monotonically along birth-year river with cross-branch weaving threads and spotlight', () => {
    const { model } = buildMultiBranchModel();
    const layout = computeKinshipLoomLayout({ model, width: 900, height: 600 });

    expect(layout.nodes.length).toBe(5);
    expect(layout.minYear).toBe(1790);
    expect(layout.maxYear).toBe(1830);
    expect(layout.decadeTicks.length).toBeGreaterThan(0);

    const rootNode = layout.nodes.find((n) => n.person.id === 'per_alder_root');
    const childNode = layout.nodes.find((n) => n.person.id === 'per_alder_child');
    const grandNode = layout.nodes.find((n) => n.person.id === 'per_alder_grandchild');
    expect(rootNode && childNode && rootNode.y < childNode.y).toBe(true);
    expect(grandNode?.isEstimatedYear).toBe(true);

    // Cross-branch union thread (Alder <-> Mercer) and lineage Bézier threads
    expect(layout.threads.some((t) => t.kind === 'union' && t.isCrossBranch)).toBe(true);
    expect(layout.threads.some((t) => t.kind === 'lineage' && t.path.startsWith('M '))).toBe(true);

    // Spotlight on Thomas Alder includes his parents (William + Hannah) and child (Clara), excluding unrelated Henry Vance
    const spotlight = computeKinshipLoomSpotlight(model, 'per_alder_child');
    expect(spotlight).not.toBeNull();
    expect(spotlight?.highlightedPersonIds.has('per_alder_root')).toBe(true);
    expect(spotlight?.highlightedPersonIds.has('per_mercer_spouse')).toBe(true);
    expect(spotlight?.highlightedPersonIds.has('per_alder_child')).toBe(true);
    expect(spotlight?.highlightedPersonIds.has('per_alder_grandchild')).toBe(true);
    expect(spotlight?.highlightedPersonIds.has('per_unrelated_vance')).toBe(false);
  });

  it('avoids label collisions for closely clustered spouses and siblings (#123)', () => {
    const clusteredPeople: Person[] = [
      makePerson({
        id: 'p_sam',
        slug: 'samuel-lincoln',
        full_name: 'Samuel Lincoln',
        surname: 'Lincoln',
        branch: 'lincoln',
        birth_year: 1622,
        birth_edtf: '1622',
      }),
      makePerson({
        id: 'p_martha',
        slug: 'martha-lyford',
        full_name: 'Martha Lyford',
        surname: 'Lyford',
        branch: 'lincoln',
        birth_year: 1622,
        birth_edtf: '1622',
      }),
      makePerson({
        id: 'p_robert',
        slug: 'robert-todd-lincoln',
        full_name: 'Robert Todd Lincoln',
        surname: 'Lincoln',
        branch: 'lincoln',
        birth_year: 1843,
        birth_edtf: '1843',
      }),
      makePerson({
        id: 'p_eddie',
        slug: 'edward-baker-lincoln',
        full_name: 'Edward Baker Lincoln',
        surname: 'Lincoln',
        branch: 'lincoln',
        birth_year: 1846,
        birth_edtf: '1846',
      }),
      makePerson({
        id: 'p_willie',
        slug: 'william-wallace-lincoln',
        full_name: 'William Wallace Lincoln',
        surname: 'Lincoln',
        branch: 'lincoln',
        birth_year: 1850,
        birth_edtf: '1850',
      }),
      makePerson({
        id: 'p_tad',
        slug: 'thomas-tad-lincoln',
        full_name: 'Thomas Tad Lincoln',
        surname: 'Lincoln',
        branch: 'lincoln',
        birth_year: 1853,
        birth_edtf: '1853',
      }),
    ];

    const model = buildArchivalTreeModel({ people: clusteredPeople, kinship: [], mode: 'full' });
    const layout = computeKinshipLoomLayout({ model, width: 960, height: 640 });
    const placements = [
      ...computeKinshipLoomLabelPlacements({
        nodes: layout.nodes,
        visiblePersonIds: new Set(clusteredPeople.map((p) => p.id)),
        width: layout.width,
        height: layout.height,
      }).values(),
    ];

    expect(placements).toHaveLength(6);
    for (let i = 0; i < placements.length; i += 1) {
      const a = placements[i];
      if (!a) {
        continue;
      }
      for (let j = i + 1; j < placements.length; j += 1) {
        const b = placements[j];
        if (!b) {
          continue;
        }
        const overlapsX = a.boxX < b.boxX + b.width && a.boxX + a.width > b.boxX;
        const overlapsY = a.boxY < b.boxY + b.height && a.boxY + a.height > b.boxY;
        expect(overlapsX && overlapsY, `Labels ${a.personId} and ${b.personId} overlapped`).toBe(false);
      }
    }
  });
});

describe('TreeKinshipLoom component & TreePage integration (#72, #123)', () => {
  it('supports Trace My Thread spotlight, r=14 touch targets, zoom controls, and touch-friendly hint without redundant bar buttons', () => {
    const { model } = buildMultiBranchModel();
    const onSelectPerson = vi.fn();

    const container = mountEl(
      <TreeKinshipLoom
        model={model}
        selectedPersonId={null}
        familyLabel="Alder"
        onSelectPerson={onSelectPerson}
      />
    );

    expect(container.textContent).toContain('Kinship Loom');
    expect(container.textContent).toContain('1790–1830');
    expect(container.textContent).toContain('Tap or hover any person to trace their thread');

    // Redundant Detail Chart / Reading Roll buttons removed from bar
    const barButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].map((b) =>
      b.textContent?.trim()
    );
    expect(barButtons).not.toContain('Detail Chart');
    expect(barButtons).not.toContain('Reading Roll');

    // Every ancestor node includes a transparent r=14 (>= 28x28px) touch hit circle
    const nodeGroups = [...container.querySelectorAll<SVGGElement>('[data-person-id]')];
    expect(nodeGroups).toHaveLength(5);
    for (const group of nodeGroups) {
      const hitCircle = group.querySelector<SVGCircleElement>('circle[r="14"]');
      expect(hitCircle).not.toBeNull();
    }

    // Zoom controls (+, −, Fit)
    const section = container.querySelector<HTMLElement>('section[aria-label*="Kinship Loom"]');
    const svg = container.querySelector<SVGSVGElement>('svg');
    expect(section?.getAttribute('data-zoom-mode')).toBe('auto');
    expect(section?.getAttribute('data-zoom-scale')).toBe('1');
    expect(svg?.style.width).toBe('960px');

    const zoomInBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in Kinship Loom"]');
    const zoomOutBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Zoom out Kinship Loom"]'
    );
    const fitBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Fit'
    );
    expect(zoomInBtn).not.toBeNull();
    expect(zoomOutBtn).not.toBeNull();
    expect(fitBtn).toBeDefined();

    act(() => {
      zoomInBtn?.click();
    });
    expect(section?.getAttribute('data-zoom-mode')).toBe('custom');
    expect(Number(section?.getAttribute('data-zoom-scale'))).toBeGreaterThan(1);

    act(() => {
      zoomOutBtn?.click();
    });
    expect(Number(section?.getAttribute('data-zoom-scale'))).toBe(1);

    act(() => {
      fitBtn?.click();
    });
    expect(section?.getAttribute('data-zoom-mode')).toBe('fit');
    expect(fitBtn?.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      fitBtn?.click();
    });
    expect(section?.getAttribute('data-zoom-mode')).toBe('auto');
    expect(fitBtn?.getAttribute('aria-pressed')).toBe('false');

    const thomasNode = container.querySelector<SVGGElement>('[data-person-id="per_alder_child"]');
    const vanceNode = container.querySelector<SVGGElement>('[data-person-id="per_unrelated_vance"]');
    expect(thomasNode).not.toBeNull();
    expect(vanceNode).not.toBeNull();

    // Hover/focus activates Trace My Thread: Thomas lit, unrelated Vance dimmed
    act(() => {
      thomasNode?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(container.textContent).toContain('Trace My Thread:');
    expect(container.textContent).toContain('Thomas Alder');
    expect(thomasNode?.getAttribute('data-lit')).toBe('true');
    expect(vanceNode?.getAttribute('data-lit')).toBe('false');

    // Keyboard Enter selects person; ArrowDown/ArrowUp traverse; Escape clears trace
    act(() => {
      thomasNode?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      thomasNode?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      thomasNode?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      thomasNode?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onSelectPerson).toHaveBeenCalledTimes(1);
  });

  it('promotes Loom to a first-class 3rd segment in TreeToolbar and switches cleanly between List, Chart, and Loom (#123)', () => {
    const siteConfig = parseKinloomConfig({
      site: {
        title: 'Alder Archive',
        familyName: 'Alder',
        gedcomSourceName: 'ALDER_ARCHIVE',
        footerCredit: 'Alder Archive',
      },
    });
    const { people, kinship } = buildMultiBranchModel();
    const { bundle }: { bundle: ArchiveBundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [],
      sources: [],
      people: people.map((p) => ({
        id: p.id,
        slug: p.slug,
        full_name: p.full_name,
        given_name: p.given_name,
        surname: p.surname,
        alt_names: [],
        sex: p.sex,
        is_living: false,
        lineage_group: p.lineage_group,
        branch: p.branch,
        birth_edtf: p.birth_edtf,
        death_edtf: p.death_edtf,
        portrait_url: null,
      })),
      events: [],
      kinship,
    });

    const container = mountEl(
      <MemoryRouter initialEntries={['/tree?surface=loom']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const layoutGroup = container.querySelector<HTMLElement>('[role="group"][aria-label="Tree layout"]');
    expect(layoutGroup).not.toBeNull();
    const layoutButtons = [...(layoutGroup?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    expect(layoutButtons.map((b) => b.textContent?.trim())).toEqual(['List', 'Chart', 'Loom']);

    const [listBtn, chartBtn, loomBtn] = layoutButtons;
    expect(listBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(chartBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(loomBtn?.getAttribute('aria-pressed')).toBe('true');

    const main = container.querySelector<HTMLElement>('main#main-content');
    expect(main?.getAttribute('data-surface')).toBe('loom');
    expect(container.querySelector('section[aria-label*="Kinship Loom"]')).not.toBeNull();

    // Switch to Chart via primary toolbar segmented control
    act(() => {
      chartBtn?.click();
    });
    expect(chartBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(loomBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(main?.getAttribute('data-surface')).toBe('diagram');
    expect(container.querySelector('svg.tree-canvas')).not.toBeNull();

    // Switch back to Loom via primary toolbar segmented control
    act(() => {
      loomBtn?.click();
    });
    expect(loomBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(main?.getAttribute('data-surface')).toBe('loom');
    expect(container.querySelector('section[aria-label*="Kinship Loom"]')).not.toBeNull();

    // Switch to List via primary toolbar segmented control
    act(() => {
      listBtn?.click();
    });
    expect(listBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(main?.getAttribute('data-surface')).toBe('roll');
    expect(container.querySelector('section[aria-label*="Kinship Loom"]')).toBeNull();
  });
});
