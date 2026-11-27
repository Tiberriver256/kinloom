/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { RecipesClient } from '../adapters/recipesClient.js';
import { ArchivalFileDropzone } from '../components/ArchivalFileDropzone.js';
import { ArchivalLightbox } from '../components/ArchivalLightbox.js';
import {
  ArchivalCardGrid,
  ArchivalDrawer,
  ArchivalEmptyState,
  ArchivalFilterBar,
  ArchivalModal,
  ArchivalTabs,
  ArchivalTagPill,
  ArchivalToast,
} from '../components/ArchivalPrimitives.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { KinloomApp } from '../KinloomApp.js';
import type { UiRecipeDetail, UiRecipePhoto } from '../lib/recipesModel.js';
import { useKinloomPluginContext, validateAndCompileUiPlugins } from './PluginContext.js';
import { useRecipesPlugin } from './recipes/RecipesContext.js';
import { createRecipesUiPlugin } from './recipesPlugin.js';
import type { KinloomUiPlugin } from './types.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Family Archive',
    familyName: 'Archive Example',
    gedcomSourceName: 'RECIPES_UI_TEST',
  },
});

const { bundle: TEST_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  people: [
    {
      id: 'p_ada',
      slug: 'ada-lovelace',
      full_name: 'Ada Lovelace',
      given_name: 'Ada',
      surname: 'Lovelace',
      alt_names: ['Augusta Byron'],
      sex: 'F',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1815-12-10',
      death_edtf: '1852-11-27',
      portrait_url: null,
    },
    {
      id: 'p_charles',
      slug: 'charles-babbage',
      full_name: 'Charles Babbage',
      given_name: 'Charles',
      surname: 'Babbage',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'direct_ancestor',
      birth_edtf: '1791-12-26',
      death_edtf: '1871-10-18',
      portrait_url: null,
    },
    {
      id: 'p_living',
      slug: 'living-relative',
      full_name: 'Living',
      given_name: 'Living',
      surname: '',
      alt_names: [],
      sex: 'U',
      is_living: true,
      lineage_group: 'descendant',
      birth_edtf: '',
      death_edtf: '',
      portrait_url: null,
    },
  ],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

const SAMPLE_RECIPES: readonly UiRecipeDetail[] = [
  {
    id: 'rec_1',
    slug: 'oatmeal-honey-biscuits',
    title: 'Oatmeal Honey Biscuits',
    summary: 'Cast-iron biscuits copied from the 1840 notebook.',
    story_md: 'Baked every Sunday morning.\n\n- Served with wildflower honey.',
    ingredients: [
      { id: 'ing_1', quantity: '2', unit: 'cups', item: 'rolled oats', note: 'toasted', group: 'Dry' },
      { id: 'ing_2', quantity: '1', unit: 'cup', item: 'buttermilk', note: '', group: 'Wet' },
    ],
    steps: [
      { id: 'stp_1', instruction: 'Preheat oven to 400F.', note: 'Use middle rack.' },
      { id: 'stp_2', instruction: 'Fold wet ingredients into dry and bake 18 minutes.', note: '' },
    ],
    prep_minutes: 15,
    cook_minutes: 20,
    servings: '12 biscuits',
    course: 'bread',
    tags: ['heirloom', 'winter'],
    provenance_note: 'Copied from kitchen ledger page 14.',
    source_era: 'c. 1840',
    attributed_person_id: 'p_ada',
    attributed_person: { id: 'p_ada', slug: 'ada-lovelace', full_name: 'Ada Lovelace' },
    cover_photo_id: 'pho_1',
    cover_photo_url: '/media/biscuits-card.jpg',
    star_count: 4,
    comment_count: 1,
    viewer_has_starred: true,
    version: 1,
    created_by_name: 'Clara Baker',
    updated_by_name: 'Archive Steward',
    created_at: '2026-11-26T10:00:00.000Z',
    updated_at: '2026-11-27T10:00:00.000Z',
  },
  {
    id: 'rec_2',
    slug: 'autumn-cider-pie',
    title: 'Autumn Cider Pie',
    summary: 'Spiced orchard apple pie.',
    story_md: '',
    ingredients: [],
    steps: [],
    prep_minutes: 30,
    cook_minutes: 45,
    servings: '8 slices',
    course: 'dessert',
    tags: ['autumn'],
    provenance_note: '',
    source_era: '1920s',
    attributed_person_id: null,
    attributed_person: null,
    cover_photo_id: null,
    cover_photo_url: null,
    star_count: 1,
    comment_count: 0,
    viewer_has_starred: false,
    version: 1,
    created_by_name: 'Clara Baker',
    updated_by_name: 'Clara Baker',
    created_at: '2026-11-27T10:00:00.000Z',
    updated_at: '2026-11-27T10:00:00.000Z',
  },
];

const SAMPLE_PHOTOS: Readonly<Record<string, readonly UiRecipePhoto[]>> = {
  rec_1: [
    {
      id: 'pho_1',
      recipe_id: 'rec_1',
      url: '/media/biscuits-card.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 1200,
      width: 800,
      height: 600,
      orientation: 1,
      caption: 'Handwritten card front',
      card_side: 'front',
      sort_order: 0,
      uploaded_by_name: 'Clara Baker',
      created_at: '2026-11-26T10:05:00.000Z',
    },
  ],
};

function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for UI condition.`);
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

const DummyRouteComponent: React.FC = () => <div>Dummy</div>;

const ProbeOutsideRecipesProvider: React.FC = () => {
  useRecipesPlugin();
  return null;
};

interface ContextProbeSnapshot {
  deceasedAda: string;
  living: unknown;
  searchCount: number;
  apiUrl: string;
}

const PluginContextProbe: React.FC<{ readonly onCapture: (snap: ContextProbeSnapshot) => void }> = ({
  onCapture,
}) => {
  const ctx = useKinloomPluginContext();
  onCapture({
    deceasedAda: ctx.getDeceasedPersonById('p_ada')?.full_name ?? '',
    living: ctx.getDeceasedPersonById('p_living'),
    searchCount: ctx.searchDeceasedPeople('Augusta').length,
    apiUrl: ctx.apiClient.resolveUrl('/api/plugins/recipes'),
  });
  return <div data-testid="ctx-probe">ok</div>;
};

const ArchivalPrimitivesHarness: React.FC<{
  readonly onTagRemove: () => void;
  readonly onToastDismiss: () => void;
}> = ({ onTagRemove, onToastDismiss }) => {
  const [tab, setTab] = useState('one');
  const [modalOpen, setModalOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activePill, setActivePill] = useState(false);

  return (
    <div>
      <ArchivalTabs
        ariaLabel="Demo tabs"
        tabs={[
          { id: 'one', label: 'First', badge: 2 },
          { id: 'two', label: 'Second' },
          { id: 'three', label: 'Third' },
        ]}
        activeTabId={tab}
        onSelectTab={setTab}
      />
      <ArchivalFilterBar actions={<button type="button">Action</button>}>
        <ArchivalTagPill
          label="#winter"
          active={activePill}
          onClick={() => {
            setActivePill((v) => !v);
          }}
        />
        <ArchivalTagPill label="#heirloom" onRemove={onTagRemove} />
      </ArchivalFilterBar>
      <ArchivalToast message="Saved changes" tone="success" onDismiss={onToastDismiss} />
      <ArchivalToast message="Notice info" tone="info" />
      <ArchivalToast message="Load failed" tone="error" />
      <ArchivalCardGrid>
        <ArchivalEmptyState title="Empty" description="No items yet" action={<span>CTA</span>} />
      </ArchivalCardGrid>
      <button
        type="button"
        data-testid="open-drawer-btn"
        onClick={() => {
          setDrawerOpen(true);
        }}
      >
        Open Drawer
      </button>
      <ArchivalModal
        open={modalOpen}
        title="Preview Dialog"
        onClose={() => {
          setModalOpen(false);
        }}
      >
        <p>Modal content</p>
      </ArchivalModal>
      <ArchivalDrawer
        open={drawerOpen}
        title="Side Drawer"
        onClose={() => {
          setDrawerOpen(false);
        }}
      >
        <p>Drawer content</p>
      </ArchivalDrawer>
    </div>
  );
};

describe('KinloomUiPlugin seams, ArchivalPrimitives, and Family Recipes UI (#47)', () => {
  it('enforces default-off zero footprint when plugins are empty or recipes plugin is disabled', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[]}
          initialEntries={['/']}
        />
      );
    });
    await flushUi();

    expect([...container.querySelectorAll('.nav-links a')].map((a) => a.textContent)).not.toContain(
      'Recipes'
    );
    expect(container.querySelector('[data-slot="indexWidgets"]')).toBeNull();

    // Navigating to /recipes without plugin falls through to NotFoundPage
    await act(async () => {
      root.render(
        <KinloomApp
          key="recipes-off-route"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[createRecipesUiPlugin({ enabled: false })]}
          initialEntries={['/recipes']}
        />
      );
    });
    await flushUi();
    expect(container.textContent).not.toContain('Family Recipe Box');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('validates navMatchPrefix and navOrder and exposes deceased-only helpers via useKinloomPluginContext', async () => {
    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-prefix',
          name: 'Bad Prefix',
          routes: [{ path: '/items', navMatchPrefix: 'items', component: DummyRouteComponent }],
        },
      ])
    ).toThrow(RangeError);
    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-order',
          name: 'Bad Order',
          routes: [{ path: '/items', navOrder: Number.NaN, component: DummyRouteComponent }],
        },
      ])
    ).toThrow(RangeError);

    let captured: ContextProbeSnapshot | null = null;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <PluginContextProbe
            onCapture={(snap) => {
              captured = snap;
            }}
          />
        </ArchiveProvider>
      );
    });

    expect(captured).toEqual({
      deceasedAda: 'Ada Lovelace',
      living: null,
      searchCount: 1,
      apiUrl: '/api/plugins/recipes',
    });

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('exercises ArchivalPrimitives keyboard tabs, tag pills, toasts, modal, and drawer', async () => {
    const onTagRemove = vi.fn();
    const onToastDismiss = vi.fn();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ArchivalPrimitivesHarness onTagRemove={onTagRemove} onToastDismiss={onToastDismiss} />);
    });

    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

    act(() => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');

    act(() => {
      tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');

    act(() => {
      tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');

    act(() => {
      tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

    // Toggleable & removable tag pills + toast dismiss
    const winterBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === '#winter'
    );
    act(() => {
      winterBtn?.click();
    });
    expect(winterBtn?.getAttribute('aria-pressed')).toBe('true');

    container.querySelector<HTMLButtonElement>('button[aria-label="Remove #heirloom"]')?.click();
    expect(onTagRemove).toHaveBeenCalledTimes(1);

    container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notice"]')?.click();
    expect(onToastDismiss).toHaveBeenCalledTimes(1);

    // Modal closes on button click, then open drawer and close via backdrop
    expect(container.querySelector('dialog')?.textContent).toContain('Modal content');
    const closeBtn = [...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent === 'Close'
    );
    act(() => {
      closeBtn?.click();
    });
    expect(container.querySelector('dialog')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-drawer-btn"]')?.click();
    });
    expect(container.querySelector('dialog')?.textContent).toContain('Drawer content');
    act(() => {
      container.querySelector<HTMLButtonElement>('dialog .lightbox-backdrop-close')?.click();
    });
    expect(container.querySelector('dialog')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders Recipe Box catalog, keeps nav active across nested routes, filters, and opens detail with checklist & print', async () => {
    const recipesPlugin = createRecipesUiPlugin({
      staticRecipes: SAMPLE_RECIPES,
      staticPhotosByRecipeId: SAMPLE_PHOTOS,
    });
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    // 1. IndexPage shows indexWidgets shelf and Recipes topbar nav link
    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[recipesPlugin]}
          initialEntries={['/']}
        />
      );
    });
    await flushUi();

    expect(container.querySelector('[data-slot="indexWidgets"]')?.textContent).toContain(
      'Oatmeal Honey Biscuits'
    );
    const desktopNavRecipes = [...container.querySelectorAll<HTMLAnchorElement>('.nav-links a')].find((a) =>
      a.textContent?.includes('Recipes')
    );
    expect(desktopNavRecipes).toBeDefined();

    // Mobile archive menu also lists plugin nav link
    const archiveMenuBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Archive menu"]');
    act(() => {
      archiveMenuBtn?.click();
    });
    const mobileMenuItems = [...container.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
    expect(mobileMenuItems.some((txt) => txt?.includes('Recipes'))).toBe(true);

    // 2. PersonPage renders personRelated for deceased Ada Lovelace, and hides it for living person
    await act(async () => {
      root.render(
        <KinloomApp
          key="person-ada"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[recipesPlugin]}
          initialEntries={['/person/ada-lovelace']}
        />
      );
    });
    await waitForCondition(() =>
      Boolean(
        container.querySelector('[data-slot="personRelated"]')?.textContent?.includes('Heirloom Recipes')
      )
    );
    expect(container.querySelector('[data-slot="personRelated"]')?.textContent).toContain(
      'Oatmeal Honey Biscuits'
    );

    await act(async () => {
      root.render(
        <KinloomApp
          key="person-living"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[recipesPlugin]}
          initialEntries={['/person/living-relative']}
        />
      );
    });
    await waitForCondition(() => Boolean(container.querySelector('h1')));
    expect(container.querySelector('[data-slot="personRelated"]')).toBeNull();

    // 3. Catalog page filtering, tabs, ancestor filter excludes living person
    await act(async () => {
      root.render(
        <KinloomApp
          key="recipes-catalog"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[recipesPlugin]}
          initialEntries={['/recipes']}
        />
      );
    });
    await flushUi();

    expect(container.querySelector('h1')?.textContent).toBe('Family Recipe Box');
    const activeCatalogLink = [...container.querySelectorAll<HTMLAnchorElement>('.nav-links a')].find((a) =>
      a.textContent?.includes('Recipes')
    );
    expect(activeCatalogLink?.getAttribute('aria-current')).toBe('page');

    // Verify living person never appears in Ancestor filter dropdown
    const ancestorSelect = [...container.querySelectorAll<HTMLSelectElement>('select')].find((s) =>
      s.textContent?.includes('All ancestors')
    );
    expect(ancestorSelect?.textContent).toContain('Ada Lovelace');
    expect(ancestorSelect?.textContent).not.toContain('Living');

    // Switch to My Favorites tab
    const favTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) =>
      t.textContent?.includes('My Favorites')
    );
    act(() => {
      favTab?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Oatmeal Honey Biscuits');
    expect(container.textContent).not.toContain('Autumn Cider Pie');

    // Switch back to All Recipes and filter by search, course, tag, ancestor, sort, and clear
    const allTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) =>
      t.textContent?.includes('All Recipes')
    );
    act(() => {
      allTab?.click();
    });
    await flushUi();

    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]');
    act(() => {
      if (searchInput) {
        setNativeValue(searchInput, 'cider');
      }
    });
    await flushUi();
    expect(container.textContent).toContain('Autumn Cider Pie');
    expect(container.textContent).not.toContain('Oatmeal Honey Biscuits');

    const clearBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Clear filters'
    );
    act(() => {
      clearBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Oatmeal Honey Biscuits');

    // Exercise course, tag, ancestor, and sort selects + tag pill toggle & removal
    const selects = [...container.querySelectorAll<HTMLSelectElement>('select')];
    const courseSelect = selects.find((s) => s.textContent?.includes('All courses'));
    const tagSelect = selects.find((s) => s.textContent?.includes('All tags'));
    const sortSelect = selects.find((s) => s.textContent?.includes('Most Starred'));
    const ancestorSelect2 = selects.find((s) => s.textContent?.includes('All ancestors'));

    act(() => {
      if (courseSelect) setNativeValue(courseSelect, 'bread');
    });
    await flushUi();
    expect(container.textContent).toContain('Oatmeal Honey Biscuits');
    expect(container.textContent).not.toContain('Autumn Cider Pie');

    act(() => {
      if (courseSelect) setNativeValue(courseSelect, '');
      if (tagSelect) setNativeValue(tagSelect, 'winter');
    });
    await flushUi();
    expect(container.querySelector('button[aria-label="Remove #winter"]')).not.toBeNull();
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove #winter"]')?.click();
    });
    await flushUi();

    act(() => {
      if (ancestorSelect2) setNativeValue(ancestorSelect2, 'p_ada');
      if (sortSelect) setNativeValue(sortSelect, 'alpha');
    });
    await flushUi();
    expect(container.textContent).toContain('Oatmeal Honey Biscuits');

    // Click card tag pill to toggle filter on/off
    const cardTagBtn = [...container.querySelectorAll<HTMLButtonElement>('article button')].find(
      (b) => b.textContent === '#heirloom'
    );
    act(() => {
      cardTagBtn?.click();
    });
    await flushUi();
    act(() => {
      cardTagBtn?.click();
    });
    await flushUi();

    // Clear filters via empty state action when ancestor + search yields 0 results
    act(() => {
      if (searchInput) setNativeValue(searchInput, 'no-such-dish-xyz');
    });
    await flushUi();
    expect(container.textContent).toContain('No recipes match the active filters');
    const emptyClearBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Clear filters'
    );
    act(() => {
      emptyClearBtn?.click();
    });
    await flushUi();

    // 4. Detail page keeps Recipes nav pill active via navMatchPrefix, supports checklist, photo modal, print
    await act(async () => {
      root.render(
        <KinloomApp
          key="recipes-detail"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[recipesPlugin]}
          initialEntries={['/recipes/oatmeal-honey-biscuits']}
        />
      );
    });
    await flushUi();

    const activeDetailLink = [...container.querySelectorAll<HTMLAnchorElement>('.nav-links a')].find((a) =>
      a.textContent?.includes('Recipes')
    );
    expect(activeDetailLink?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('h1')?.textContent).toBe('Oatmeal Honey Biscuits');
    expect(container.textContent).toContain('Attributed to Ada Lovelace');
    expect(container.textContent).toContain('2 cups rolled oats, toasted');
    expect(container.textContent).toContain('Preheat oven to 400F.');
    expect(container.textContent).toContain('Baked every Sunday morning.');

    // Toggle ingredient checkbox on and off
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(false);
    act(() => {
      checkbox?.click();
    });
    expect(checkbox?.checked).toBe(true);
    act(() => {
      checkbox?.click();
    });
    expect(checkbox?.checked).toBe(false);

    // Open photo modal and close
    const photoBtn = container.querySelector<HTMLButtonElement>(
      'section[aria-label="Recipe card photographs"] button'
    );
    act(() => {
      photoBtn?.click();
    });
    expect(container.querySelector('dialog')?.textContent).toContain('Handwritten card front');
    const modalCloseBtn = [...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent === 'Close'
    );
    act(() => {
      modalCloseBtn?.click();
    });
    expect(container.querySelector('dialog')).toBeNull();

    // Print recipe card button calls window.print()
    const printBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Print Recipe Card')
    );
    act(() => {
      printBtn?.click();
    });
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('handles disabled server 404, missing recipe 404, and network errors cleanly', async () => {
    let failNext = true;
    const customClient: RecipesClient = {
      async listRecipes() {
        if (failNext) {
          failNext = false;
          throw new Error('Temporary network error');
        }
        return null;
      },
      async getRecipe() {
        return null;
      },
      async listRecipesByPerson() {
        return null;
      },
    };

    const plugin: KinloomUiPlugin = createRecipesUiPlugin({
      client: customClient,
      showIndexWidget: false,
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    // Catalog error -> retry -> 404 disabled message
    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes']}
        />
      );
    });
    await flushUi();
    expect(container.textContent).toContain('Temporary network error');

    const retryBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Try again'
    );
    act(() => {
      retryBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('not enabled on this server');

    // Missing recipe detail -> clean 404 empty state
    await act(async () => {
      root.render(
        <KinloomApp
          key="missing-detail"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes/missing-slug']}
        />
      );
    });
    await flushUi();
    expect(container.textContent).toContain('Recipe not found');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('covers pagination, empty-ingredient detail, living ancestor redaction, slot edge states, and missing provider error', async () => {
    // 1. Pagination across > 24 recipes
    const manyRecipes: UiRecipeDetail[] = Array.from({ length: 26 }, (_, idx) => ({
      ...SAMPLE_RECIPES[1],
      id: `rec_page_${idx + 1}`,
      slug: `recipe-item-${idx + 1}`,
      title: `Heirloom Dish ${String(idx + 1).padStart(2, '0')}`,
      star_count: 30 - idx,
    }));
    const paginatedPlugin = createRecipesUiPlugin({ staticRecipes: manyRecipes });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[paginatedPlugin]}
          initialEntries={['/recipes']}
        />
      );
    });
    await flushUi();
    expect(container.textContent).toContain('Showing 1–24 of 26');

    const nextBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Next'
    );
    act(() => {
      nextBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Showing 25–26 of 26');

    const prevBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Previous'
    );
    act(() => {
      prevBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Showing 1–24 of 26');

    // 2. Detail page with empty ingredients/steps and living attributed person gets redacted
    const livingAttributedRecipe: UiRecipeDetail = {
      ...SAMPLE_RECIPES[1],
      id: 'rec_living_attr',
      slug: 'living-attributed-pie',
      attributed_person_id: 'p_living',
      attributed_person: { id: 'p_living', slug: 'living-relative', full_name: 'Living' },
    };
    const livingAttrPlugin = createRecipesUiPlugin({ staticRecipes: [livingAttributedRecipe] });
    await act(async () => {
      root.render(
        <KinloomApp
          key="detail-empty-and-redacted"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[livingAttrPlugin]}
          initialEntries={['/recipes/living-attributed-pie']}
        />
      );
    });
    await flushUi();
    expect(container.textContent).toContain('No structured ingredients recorded yet.');
    expect(container.textContent).toContain('No preparation steps recorded yet.');
    expect(container.textContent).not.toContain('Attributed to');

    // 3. Detail page error + toast dismiss & IndexWidget show_home_widget: false + PersonSlot error
    const errorClient: RecipesClient = {
      async listRecipes() {
        return {
          recipes: [...SAMPLE_RECIPES],
          total: SAMPLE_RECIPES.length,
          limit: 4,
          offset: 0,
          facets: { courses: ['bread'], tags: ['winter'] },
          display: { show_home_widget: false },
        };
      },
      async getRecipe() {
        throw new Error('Detail load failed');
      },
      async listRecipesByPerson() {
        throw new Error('Person recipes failed');
      },
    };
    const errorPlugin = createRecipesUiPlugin({ client: errorClient });

    await act(async () => {
      root.render(
        <KinloomApp
          key="index-hidden-by-server"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[errorPlugin]}
          initialEntries={['/']}
        />
      );
    });
    await flushUi();
    expect(container.querySelector('[data-slot="indexWidgets"]')?.textContent ?? '').not.toContain(
      'Oatmeal Honey Biscuits'
    );

    await act(async () => {
      root.render(
        <KinloomApp
          key="person-slot-error"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[errorPlugin]}
          initialEntries={['/person/charles-babbage']}
        />
      );
    });
    await waitForCondition(() => Boolean(container.querySelector('h1')));
    expect(container.textContent).not.toContain('Heirloom Recipes');

    await act(async () => {
      root.render(
        <KinloomApp
          key="detail-error"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[errorPlugin]}
          initialEntries={['/recipes/broken']}
        />
      );
    });
    await flushUi();
    expect(container.textContent).toContain('Detail load failed');
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notice"]')?.click();
    });
    expect(container.textContent).not.toContain('Detail load failed');

    // 4. Rejecting listRecipes inside IndexRecipesWidget renders null cleanly
    const throwingIndexPlugin = createRecipesUiPlugin({
      client: {
        async listRecipes() {
          throw new Error('Index offline');
        },
        async getRecipe() {
          return null;
        },
        async listRecipesByPerson() {
          return null;
        },
      },
    });
    await act(async () => {
      root.render(
        <KinloomApp
          key="index-throw"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[throwingIndexPlugin]}
          initialEntries={['/']}
        />
      );
    });
    await flushUi();
    expect(container.textContent).not.toContain('Browse all recipes');

    // 5. useRecipesPlugin throws outside provider
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      act(() => {
        root.render(<ProbeOutsideRecipesProvider />);
      });
    }).toThrow('useRecipesPlugin must be used inside');
    consoleErr.mockRestore();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

const LIGHTBOX_TEST_ITEMS = [
  {
    id: 'p1',
    url: '/api/plugins/recipes/photos/p1',
    alt: 'Front of card',
    caption: 'Front of card',
    meta: 'Card Front · 800×600',
  },
  {
    id: 'p2',
    url: '/api/plugins/recipes/photos/p2',
    alt: 'Back of card',
    caption: 'Back of card',
    meta: 'Card Back · 800×600',
  },
] as const;

const LightboxTestHarness: React.FC = () => {
  const [idx, setIdx] = useState<number | null>(0);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setIdx(0);
        }}
      >
        Reopen Lightbox
      </button>
      <ArchivalLightbox
        items={LIGHTBOX_TEST_ITEMS}
        activeIndex={idx}
        onClose={() => {
          setIdx(null);
        }}
        onChangeIndex={setIdx}
      />
    </div>
  );
};

describe('ArchivalLightbox, ArchivalFileDropzone, and RecipeDetailPage photo management (Issue #48)', () => {
  it('operates ArchivalLightbox zoom, pan, multi-photo keyboard navigation, thumbnail jump, and Esc/backdrop dismissal', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<LightboxTestHarness />);
    });

    const dialog = container.querySelector<HTMLDialogElement>('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(dialog?.getAttribute('closedby')).toBe('any');
    expect(container.textContent).toContain('Front of card');
    expect(container.textContent).toContain('1 / 2');
    expect(container.textContent).toContain('100%');

    // Zoom in via button and keyboard '+' / '-' / '0'
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')?.click();
    });
    expect(container.textContent).toContain('150%');

    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    });
    expect(container.textContent).toContain('200%');

    // Keyboard arrow panning when zoomed
    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    // Pointer pan drag on stage
    const stage = container.querySelector<HTMLDivElement>('img')?.parentElement;
    expect(stage).not.toBeNull();
    act(() => {
      stage?.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
      stage?.dispatchEvent(new MouseEvent('pointermove', { clientX: 140, clientY: 120, bubbles: true }));
      stage?.dispatchEvent(new MouseEvent('pointerup', { clientX: 140, clientY: 120, bubbles: true }));
      stage?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    });
    expect(container.textContent).toContain('250%');

    // Zoom out and Reset
    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }));
    });
    expect(container.textContent).toContain('200%');
    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    });
    expect(container.textContent).toContain('100%');

    // Navigate next/prev via keyboard and buttons
    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(container.textContent).toContain('Back of card');
    expect(container.textContent).toContain('2 / 2');

    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Previous photo"]')?.click();
    });
    expect(container.textContent).toContain('Front of card');

    // Jump via thumbnail button
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="View photo 2: Back of card"]')?.click();
    });
    expect(container.textContent).toContain('Back of card');

    // Close via Escape (jsdom fallback)
    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('dialog')).toBeNull();

    // Reopen and close via Close button
    act(() => {
      const reopen = [...container.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Reopen Lightbox')
      );
      reopen?.click();
    });
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    act(() => {
      const closeBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Close');
      closeBtn?.click();
    });
    expect(container.querySelector('dialog')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('validates dropped and picked files in ArchivalFileDropzone', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const acceptedNames: string[] = [];
    const rejectedMsgs: string[] = [];

    await act(async () => {
      root.render(
        <ArchivalFileDropzone
          maxBytes={1024}
          progressLabel="Uploading card 1 of 1…"
          onFilesAccepted={(files) => {
            acceptedNames.push(...files.map((f) => f.name));
          }}
          onFilesRejected={(errs) => {
            rejectedMsgs.push(...errs);
          }}
        />
      );
    });

    expect(container.textContent).toContain('Uploading card 1 of 1…');
    const dropzoneEl = container.firstElementChild as HTMLDivElement;
    const goodFile = new File([new Uint8Array(64)], 'front.jpg', { type: 'image/jpeg' });
    const badFile = new File([new Uint8Array(64)], 'bad.svg', { type: 'image/svg+xml' });

    act(() => {
      dropzoneEl.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
      dropzoneEl.dispatchEvent(new Event('dragleave', { bubbles: true, cancelable: true }));
      const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [goodFile, badFile] },
      });
      dropzoneEl.dispatchEvent(dropEvent);
    });

    expect(acceptedNames).toEqual(['front.jpg']);
    expect(rejectedMsgs).toHaveLength(1);
    expect(rejectedMsgs[0]).toContain('unsupported image type');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('supports editor upload, caption edit, set cover, reorder, and delete on RecipeDetailPage while hiding controls for viewers', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const photo1: UiRecipePhoto = {
      id: 'pho_1',
      recipe_id: 'rec_1',
      url: '/api/plugins/recipes/photos/pho_1',
      mime_type: 'image/jpeg',
      size_bytes: 1200,
      width: 800,
      height: 600,
      orientation: 1,
      caption: 'Front of card',
      card_side: 'front',
      sort_order: 0,
      uploaded_by_name: 'Clara Baker',
      created_at: '2026-11-27T10:00:00.000Z',
    };
    let photosState: UiRecipePhoto[] = [photo1];
    let coverId: string | null = 'pho_1';

    const editorClient: RecipesClient = {
      async listRecipes() {
        return {
          recipes: [SAMPLE_RECIPES[0]],
          total: 1,
          limit: 40,
          offset: 0,
          facets: { courses: ['bread'], tags: ['heirloom'] },
        };
      },
      async getRecipe() {
        return {
          recipe: { ...SAMPLE_RECIPES[0], cover_photo_id: coverId },
          photos: [...photosState],
          viewer_has_starred: false,
          permissions: {
            can_edit: true,
            can_delete: true,
            can_upload: true,
            can_star: true,
            can_comment: true,
          },
          media_limits: { max_photo_mb: 10, max_photos_per_recipe: 12 },
        };
      },
      async listRecipesByPerson() {
        return { person_id: 'p_ada', recipes: [], total: 0 };
      },
      async uploadRecipePhoto(_slug, input) {
        const next: UiRecipePhoto = {
          id: 'pho_2',
          recipe_id: 'rec_1',
          url: '/api/plugins/recipes/photos/pho_2',
          mime_type: 'image/png',
          size_bytes: input.file.size,
          width: 640,
          height: 480,
          orientation: 1,
          caption: input.caption ?? '',
          card_side: input.card_side ?? 'front',
          sort_order: photosState.length,
          uploaded_by_name: 'Clara Baker',
          created_at: '2026-11-27T11:00:00.000Z',
        };
        photosState = [...photosState, next];
        if (input.set_cover) {
          coverId = next.id;
        }
        return { photo: next, cover_photo_id: coverId, cover_photo_url: next.url };
      },
      async updateRecipePhoto(_slug, photoId, patch) {
        photosState = photosState.map((p) =>
          p.id === photoId
            ? {
                ...p,
                caption: patch.caption ?? p.caption,
                card_side: patch.card_side ?? p.card_side,
              }
            : p
        );
        if (patch.set_cover) {
          coverId = photoId;
        }
        const updated = photosState.find((p) => p.id === photoId)!;
        return { photo: updated, cover_photo_id: coverId, cover_photo_url: updated.url };
      },
      async reorderRecipePhotos(_slug, photoIds) {
        photosState = photoIds
          .map((id, idx) => {
            const found = photosState.find((p) => p.id === id);
            return found ? { ...found, sort_order: idx } : null;
          })
          .filter((p): p is UiRecipePhoto => p !== null);
        return { photos: [...photosState] };
      },
      async deleteRecipePhoto(_slug, photoId) {
        photosState = photosState.filter((p) => p.id !== photoId);
        if (coverId === photoId) {
          coverId = photosState[0]?.id ?? null;
        }
      },
    };

    const editorPlugin = createRecipesUiPlugin({ client: editorClient });
    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[editorPlugin]}
          initialEntries={['/recipes/oatmeal-honey-biscuits']}
        />
      );
    });
    await flushUi();

    expect(container.textContent).toContain('Add recipe card photos');
    expect(container.textContent).toContain('Front of card');

    // Fill caption + card side and upload second photo via file input
    const captionInput = container.querySelector<HTMLInputElement>('input[placeholder*="handwritten"]');
    expect(captionInput).not.toBeNull();
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    const backFile = new File([new Uint8Array(128)], 'card-back.png', { type: 'image/png' });
    await act(async () => {
      Object.defineProperty(fileInput!, 'files', { value: [backFile], configurable: true });
      fileInput!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushUi();
    expect(container.textContent).toContain('Recipe card photo uploaded.');
    expect(photosState).toHaveLength(2);

    // Click Set Cover on second photo
    const setCoverBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Set Cover');
    expect(setCoverBtn).toBeDefined();
    await act(async () => {
      setCoverBtn?.click();
    });
    await flushUi();
    expect(coverId).toBe('pho_2');
    expect(container.textContent).toContain('Primary cover photo updated.');

    // Reorder second photo earlier
    const moveEarlierBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Move photo 2 earlier"]'
    );
    expect(moveEarlierBtn).not.toBeNull();
    await act(async () => {
      moveEarlierBtn?.click();
    });
    await flushUi();
    expect(photosState.map((p) => p.id)).toEqual(['pho_2', 'pho_1']);

    // Edit photo caption inline
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Edit');
    act(() => {
      editBtn?.click();
    });
    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    await act(async () => {
      saveBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Photo details saved.');

    // Delete photo via two-step confirm
    const deleteBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Delete');
    act(() => {
      deleteBtn?.click();
    });
    const confirmDeleteBtn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Confirm Delete'
    );
    expect(confirmDeleteBtn).toBeDefined();
    await act(async () => {
      confirmDeleteBtn?.click();
    });
    await flushUi();
    expect(photosState).toHaveLength(1);
    expect(container.textContent).toContain('Recipe card photo deleted.');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
