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
import { computeKinshipLoomLayout, computeKinshipLoomSpotlight } from '../../lib/tree/kinshipLoomModel.js';
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

describe('kinshipLoomModel pure layout & spotlight (#72)', () => {
  it('handles empty model cleanly', () => {
    const emptyModel = buildArchivalTreeModel({ people: [], kinship: [], mode: 'full' });
    const layout = computeKinshipLoomLayout({ model: emptyModel });
    expect(layout.nodes).toEqual([]);
    expect(layout.threads).toEqual([]);
    expect(layout.decadeTicks).toEqual([]);
    expect(computeKinshipLoomSpotlight(emptyModel, null)).toBeNull();
    expect(computeKinshipLoomSpotlight(emptyModel, 'missing')).toBeNull();
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
});

describe('TreeKinshipLoom component & TreePage integration (#72)', () => {
  it('supports hover/focus Trace My Thread spotlight, keyboard traversal, and 1-click return controls', () => {
    const { model } = buildMultiBranchModel();
    const onSelectPerson = vi.fn();
    const onReturnToChart = vi.fn();
    const onSwitchToRoll = vi.fn();

    const container = mountEl(
      <TreeKinshipLoom
        model={model}
        selectedPersonId={null}
        familyLabel="Alder"
        onSelectPerson={onSelectPerson}
        onReturnToChart={onReturnToChart}
        onSwitchToRoll={onSwitchToRoll}
      />
    );

    expect(container.textContent).toContain('Kinship Loom');
    expect(container.textContent).toContain('1790–1830');

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

    // 1-click return buttons
    const chartBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Detail Chart'
    );
    const rollBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Reading Roll'
    );
    act(() => {
      chartBtn?.click();
      rollBtn?.click();
    });
    expect(onReturnToChart).toHaveBeenCalledTimes(1);
    expect(onSwitchToRoll).toHaveBeenCalledTimes(1);
  });

  it('opens Kinship Loom via ?surface=loom in TreePage and transitions back to Chart and Roll in 1 click', () => {
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

    expect(container.querySelector('section[aria-label*="Kinship Loom"]')).not.toBeNull();

    // 1-click transition to Detail Chart
    const chartBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Detail Chart'
    );
    act(() => {
      chartBtn?.click();
    });
    expect(container.querySelector('svg.tree-canvas')).not.toBeNull();

    // Toggle Loom back on via TreeZoomControls Loom button
    const loomToggleBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Loom'
    );
    expect(loomToggleBtn).toBeDefined();
    act(() => {
      loomToggleBtn?.click();
    });
    expect(container.querySelector('section[aria-label*="Kinship Loom"]')).not.toBeNull();

    // 1-click transition to Reading Roll
    const rollBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Reading Roll'
    );
    act(() => {
      rollBtn?.click();
    });
    expect(container.querySelector('section[aria-label*="Kinship Loom"]')).toBeNull();
  });
});
