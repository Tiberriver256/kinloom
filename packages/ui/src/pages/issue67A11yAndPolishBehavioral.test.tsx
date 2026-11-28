/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { GlobalSearchModal } from '../components/GlobalSearchModal.js';
import { TreeFocusDrawer } from '../components/tree/TreeFocusDrawer.js';
import { TreePedigreeRoll } from '../components/tree/TreePedigreeRoll.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { buildArchivalTreeModel, computeLineageSpotlight } from '../lib/archivalTreeModel.js';
import { AdminPage } from './AdminPage.js';
import { NotFoundPage } from './NotFoundPage.js';
import { RecentChangesPage } from './RecentChangesPage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Bramwell Archive',
    familyName: 'Bramwell',
    gedcomSourceName: 'BRAMWELL_A11Y_TEST',
  },
  branches: [{ id: 'main', label: 'Main Line' }],
});

const { bundle: TEST_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'private',
  places: [
    {
      id: 'pl_1',
      slug: 'holland',
      name: 'Holland',
      full_name: 'Holland, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.7875,
      lng: -86.1089,
    },
  ],
  sources: [],
  people: [
    {
      id: 'per_g1',
      slug: 'thomas-bramwell',
      full_name: 'Thomas Bramwell',
      given_name: 'Thomas',
      surname: 'Bramwell',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'main',
      birth_edtf: '1820',
      death_edtf: '1892',
      portrait_url: null,
    },
    {
      id: 'per_g2',
      slug: 'edith-bramwell',
      full_name: 'Edith Bramwell',
      given_name: 'Edith',
      surname: 'Bramwell',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'main',
      birth_edtf: '1850',
      death_edtf: '1924',
      portrait_url: null,
    },
    {
      id: 'per_g3',
      slug: 'walter-bramwell',
      full_name: 'Walter Bramwell',
      given_name: 'Walter',
      surname: 'Bramwell',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'main',
      birth_edtf: '1882',
      death_edtf: '1960',
      portrait_url: null,
    },
    {
      id: 'per_g4',
      slug: 'helen-bramwell',
      full_name: 'Helen Bramwell',
      given_name: 'Helen',
      surname: 'Bramwell',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'descendant',
      branch: 'main',
      birth_edtf: '1915',
      death_edtf: '2001',
      portrait_url: null,
    },
  ],
  events: [],
  kinship: [
    { from: 'per_g1', to: 'per_g2', relation: 'parent' },
    { from: 'per_g2', to: 'per_g3', relation: 'parent' },
    { from: 'per_g3', to: 'per_g4', relation: 'parent' },
  ],
  media: [],
  narratives: [],
});

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

const OpenSearchHarness: React.FC = () => {
  const { openSearch } = useArchiveUi();
  return (
    <>
      <button type="button" onClick={openSearch}>
        Open Search Harness
      </button>
      <GlobalSearchModal />
    </>
  );
};

describe('Issue #67: A11y hardening, keycaps, pedigree roll focus, and sticky footer shell', () => {
  it('hardens GlobalSearchModal with combobox ARIA, live result count, mark highlights, hairline suggestions, and kbd keycaps', async () => {
    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <OpenSearchHarness />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const trigger = container.querySelector('button');
    act(() => {
      trigger?.click();
    });
    await flushUi();

    const input = container.querySelector('input[role="combobox"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.getAttribute('aria-controls')).toBeTruthy();
    expect(container.querySelector('kbd')?.textContent).toBe('Esc');

    // Type a query and verify listbox, option, activedescendant, live region, and <mark> highlighting
    if (input) {
      setInputValue(input, 'Bramwell');
      await flushUi();
    }

    const listboxId = input?.getAttribute('aria-controls') ?? '';
    const listbox = document.getElementById(listboxId);
    expect(listbox?.getAttribute('role')).toBe('listbox');
    expect(input?.getAttribute('aria-expanded')).toBe('true');

    const activeDescendant = input?.getAttribute('aria-activedescendant') ?? '';
    expect(activeDescendant).toBeTruthy();
    expect(document.getElementById(activeDescendant)?.getAttribute('role')).toBe('option');
    expect(document.getElementById(activeDescendant)?.getAttribute('aria-selected')).toBe('true');

    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion?.textContent).toMatch(/matching results? for Bramwell/i);

    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]?.textContent?.toLowerCase()).toBe('bramwell');
  });

  it('uses semantic h2 generation headings, moves focus on jump activation, and omits silencing aria-label on TreePedigreeRoll', async () => {
    const model = buildArchivalTreeModel({
      people: TEST_BUNDLE.people,
      kinship: TEST_BUNDLE.kinship,
      mode: 'full',
      expandedUnionIds: new Set(),
    });
    const spotlight = computeLineageSpotlight({
      selectedPersonId: 'per_g2',
      model,
      bundle: TEST_BUNDLE,
      placesById: new Map(TEST_BUNDLE.places.map((p) => [p.id, p])),
    });
    const onSelect = vi.fn();

    const container = mountEl(
      <MemoryRouter>
        <TreePedigreeRoll
          model={model}
          spotlight={spotlight}
          selectedPersonId="per_g2"
          personThumbMap={new Map()}
          baseUrl=""
          familyLabel="Bramwell"
          onSelectPerson={onSelect}
          onToggleUnionSiblings={vi.fn()}
        />
      </MemoryRouter>
    );
    await flushUi();

    const headings = container.querySelectorAll('h2[id^="tree-roll-gen-heading-"]');
    expect(headings.length).toBeGreaterThanOrEqual(4);

    // RollPersonCard does not override accessible name with "Inspect ..."
    const personBtn = container.querySelector('button[data-person-id="per_g1"]');
    expect(personBtn?.getAttribute('aria-label')).toBeNull();
    expect(personBtn?.textContent).toContain('Thomas Bramwell');

    // Activating a generation jump chip moves focus to the target <h2>
    const jumpChips = container.querySelectorAll('nav[aria-label="Jump to generation"] button');
    expect(jumpChips.length).toBeGreaterThanOrEqual(4);
    act(() => {
      (jumpChips[2] as HTMLButtonElement).click();
    });
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.id).toContain('tree-roll-gen-heading-');
  });

  it('renders real kbd keycaps in ExplorerTopBar and TreeFocusDrawer and polishes AdminPage/RecentChangesPage/NotFoundPage shells', async () => {
    const model = buildArchivalTreeModel({
      people: TEST_BUNDLE.people,
      kinship: TEST_BUNDLE.kinship,
      mode: 'full',
      expandedUnionIds: new Set(),
    });
    const person = TEST_BUNDLE.people[0];
    const placesById = new Map(TEST_BUNDLE.places.map((p) => [p.id, p]));

    const topAndDrawer = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <ExplorerTopBar />
          <TreeFocusDrawer
            person={person}
            model={model}
            spotlight={null}
            placesById={placesById}
            thumbUrl={null}
            baseUrl=""
            onSelectPerson={vi.fn()}
            onClearFocus={vi.fn()}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const kbds = Array.from(topAndDrawer.querySelectorAll('kbd')).map((el) => el.textContent);
    expect(kbds).toContain('/');
    expect(kbds).toContain('Esc');

    // AdminPage unauthenticated gate has Sign in + Return to archive CTAs and sticky footer shell
    const adminEl = mountEl(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <AdminPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    expect(adminEl.firstElementChild?.className).toContain('page-shell');
    expect(adminEl.textContent).toContain('Sign in');
    expect(adminEl.textContent).toContain('Return to archive');

    const signInBtn = Array.from(adminEl.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Sign in'
    );
    act(() => {
      signInBtn?.click();
    });
    await flushUi();
    expect(adminEl.querySelector('dialog[open]')).not.toBeNull();

    // RecentChangesPage and NotFoundPage use sticky page-shell
    const changesEl = mountEl(
      <MemoryRouter initialEntries={['/changes']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <RecentChangesPage initialRevisions={[]} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(changesEl.firstElementChild?.className).toContain('page-shell');

    const notFoundEl = mountEl(
      <MemoryRouter initialEntries={['/missing']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <NotFoundPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(notFoundEl.firstElementChild?.className).toContain('page-shell');
  });
});
