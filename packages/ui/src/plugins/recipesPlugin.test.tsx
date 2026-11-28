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
import type { UiRecipeComment, UiRecipeDetail, UiRecipePhoto } from '../lib/recipesModel.js';
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

function setNativeValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
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
    const mobileMenuItems = [
      ...container.querySelectorAll('.topbar-account-menu a, .topbar-account-menu button'),
    ].map((el) => el.textContent);
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

  it('supports structured recipe creation, editing with side-by-side reference photos, 409 conflict recovery, unsaved guard, XSS-safe markdown preview, and soft-delete', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const setTextareaValue = (el: HTMLTextAreaElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const storedRecipes = new Map<string, UiRecipeDetail>(SAMPLE_RECIPES.map((r) => [r.slug, r]));
    const createCalls: unknown[] = [];
    const updateCalls: Array<{ slug: string; expectedVersion: number; title: string }> = [];
    const deleteCalls: string[] = [];
    let simulateConflictOnce = true;

    const fullClient: RecipesClient = {
      async listRecipes() {
        const list = [...storedRecipes.values()];
        return {
          recipes: list,
          total: list.length,
          limit: 24,
          offset: 0,
          facets: { courses: ['bread', 'dessert'], tags: ['heirloom', 'winter'] },
          display: { show_home_widget: true },
          permissions: { can_create: true },
        };
      },
      async getRecipe(slugOrId) {
        const found = storedRecipes.get(slugOrId);
        if (!found) {
          return null;
        }
        return {
          recipe: found,
          photos: [
            ...(SAMPLE_PHOTOS[found.id] ?? []),
            ...(found.id === 'rec_1'
              ? [
                  {
                    ...SAMPLE_PHOTOS.rec_1[0],
                    id: 'pho_2',
                    url: '/media/biscuits-back.jpg',
                    caption: 'Handwritten card back',
                    card_side: 'back' as const,
                    sort_order: 1,
                  },
                ]
              : []),
          ],
          viewer_has_starred: found.viewer_has_starred,
          permissions: {
            can_edit: true,
            can_delete: true,
            can_upload: true,
            can_star: true,
            can_comment: true,
          },
        };
      },
      async listRecipesByPerson(personId) {
        const matched = [...storedRecipes.values()].filter((r) => r.attributed_person_id === personId);
        return { person_id: personId, recipes: matched, total: matched.length };
      },
      async createRecipe(input) {
        createCalls.push(input);
        const created: UiRecipeDetail = {
          ...SAMPLE_RECIPES[1],
          id: 'rec_new_1',
          slug: input.slug ?? 'spiced-oat-scones',
          title: input.title,
          summary: input.summary,
          story_md: input.story_md,
          ingredients: [...input.ingredients],
          steps: [...input.steps],
          prep_minutes: input.prep_minutes,
          cook_minutes: input.cook_minutes,
          servings: input.servings,
          course: input.course,
          tags: [...input.tags],
          provenance_note: input.provenance_note,
          source_era: input.source_era,
          attributed_person_id: input.attributed_person_id,
          attributed_person:
            input.attributed_person_id === 'p_ada'
              ? { id: 'p_ada', slug: 'ada-lovelace', full_name: 'Ada Lovelace' }
              : null,
          version: 1,
        };
        storedRecipes.set(created.slug, created);
        return { recipe: created };
      },
      async updateRecipe(slugOrId, input) {
        updateCalls.push({ slug: slugOrId, expectedVersion: input.expected_version, title: input.title });
        const existing = storedRecipes.get(slugOrId) ?? SAMPLE_RECIPES[0];
        if (simulateConflictOnce) {
          simulateConflictOnce = false;
          const serverRecipe: UiRecipeDetail = {
            ...existing,
            title: 'Server Updated Biscuits',
            version: existing.version + 1,
            updated_by_name: 'Archive Steward',
            updated_at: '2026-11-27T15:30:00.000Z',
          };
          storedRecipes.set(slugOrId, serverRecipe);
          const conflictErr = Object.assign(new Error('Recipe was updated by another member.'), {
            status: 409,
            code: 'RECIPE_VERSION_CONFLICT',
            details: {
              expected_version: input.expected_version,
              server_version: serverRecipe.version,
              server_updated_at: serverRecipe.updated_at,
              server_updated_by_name: serverRecipe.updated_by_name,
              server_recipe: serverRecipe,
            },
          });
          throw conflictErr;
        }
        const updated: UiRecipeDetail = {
          ...existing,
          ...input,
          ingredients: [...input.ingredients],
          steps: [...input.steps],
          tags: [...input.tags],
          version: input.expected_version + 1,
        };
        storedRecipes.set(updated.slug, updated);
        return { recipe: updated };
      },
      async deleteRecipe(slugOrId) {
        deleteCalls.push(slugOrId);
        storedRecipes.delete(slugOrId);
      },
    };

    const editorPlugin = createRecipesUiPlugin({ client: fullClient });

    // 1. Catalog shows "+ Add Recipe" for authorized editors
    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[editorPlugin]}
          initialEntries={['/recipes']}
          session={{
            authenticated: true,
            principal_kind: 'user',
            email: 'editor@archive.example.test',
            role: 'editor',
          }}
          capabilities={{
            canEdit: true,
            canUploadMedia: true,
            hasRevisionHistory: true,
            hasTalk: true,
            canManageSite: false,
          }}
        />
      );
    });
    await flushUi();
    const addRecipeLink = [...container.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Add Recipe')
    );
    expect(addRecipeLink).toBeDefined();

    // 2. Navigate to /recipes/new, test validation, ancestor picker (living excluded!), ingredient/step reordering, XSS-safe markdown preview, and create
    await act(async () => {
      addRecipeLink?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Add Family Recipe');

    // Ancestor picker shows Ada Lovelace and NEVER shows living relative
    expect(container.textContent).toContain('Ada Lovelace');
    expect(container.textContent).not.toContain('living-relative');

    // Submit empty form triggers inline validation error
    const submitBtn = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => {
      submitBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Enter a recipe title of at least 2 characters.');

    // Fill title, prep/cook, pick deceased ancestor Ada Lovelace, add tag, add & reorder ingredients and steps
    const titleInput = container.querySelector<HTMLInputElement>('input[name="title"]');
    const prepInput = container.querySelector<HTMLInputElement>('input[name="prep_minutes"]');
    const cookInput = container.querySelector<HTMLInputElement>('input[name="cook_minutes"]');
    const storyInput = container.querySelector<HTMLTextAreaElement>('textarea[name="story_md"]');
    expect(titleInput).not.toBeNull();
    act(() => {
      setNativeValue(titleInput!, 'Spiced Oat Scones');
      setNativeValue(prepInput!, '15');
      setNativeValue(cookInput!, '20');
      setTextareaValue(
        storyInput!,
        'Baked for tea. [bad](javascript:alert(1)) <script>window.__xss=1</script> **Warm**'
      );
    });

    // Switch story tab to Preview and verify XSS-safe rendering (no <script> tag or javascript: href)
    const previewTab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
      (b) => b.textContent === 'Preview'
    );
    act(() => {
      previewTab?.click();
    });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.textContent).toContain('Warm');

    // Pick deceased ancestor Ada Lovelace
    const adaBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Ada Lovelace')
    );
    act(() => {
      adaBtn?.click();
    });
    expect(container.textContent).toContain('Clear ancestor');

    // Add a tag
    const tagInput = container.querySelector<HTMLInputElement>('input[placeholder*="holiday"]');
    const addTagBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Add Tag'
    );
    act(() => {
      setNativeValue(tagInput!, 'Teatime');
    });
    act(() => {
      addTagBtn?.click();
    });
    expect(container.textContent).toContain('#teatime');

    // Fill first ingredient and add second ingredient, then move second up
    const firstIngItem = container.querySelector<HTMLInputElement>('input[placeholder="rolled oats"]');
    act(() => {
      setNativeValue(firstIngItem!, 'oats');
    });
    const addIngBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Add Ingredient')
    );
    act(() => {
      addIngBtn?.click();
    });
    const allIngItems = container.querySelectorAll<HTMLInputElement>('input[placeholder="rolled oats"]');
    expect(allIngItems).toHaveLength(2);
    act(() => {
      setNativeValue(allIngItems[1], 'cinnamon');
    });
    const moveIngUpBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Move ingredient 2 up"]'
    );
    act(() => {
      moveIngUpBtn?.click();
    });
    const reorderedIngItems = container.querySelectorAll<HTMLInputElement>(
      'input[placeholder="rolled oats"]'
    );
    expect(reorderedIngItems[0].value).toBe('cinnamon');

    // Fill step
    const firstStep = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder*="preparation step"]'
    );
    act(() => {
      setTextareaValue(firstStep!, 'Bake until golden.');
    });

    // Trigger unsaved-changes guard modal on Cancel, then click Keep Editing
    const cancelBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Cancel'
    );
    act(() => {
      cancelBtn?.click();
    });
    expect(container.textContent).toContain('Discard unsaved changes?');
    const keepEditingBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Keep Editing'
    );
    act(() => {
      keepEditingBtn?.click();
    });

    // Submit create form -> navigates to newly created recipe detail page
    await act(async () => {
      submitBtn?.click();
    });
    await flushUi();
    expect(createCalls).toHaveLength(1);
    expect(container.textContent).toContain('Spiced Oat Scones');

    // 3. Edit an existing recipe with photos -> side-by-side photo switcher + 409 conflict recovery + save
    await act(async () => {
      root.unmount();
    });
    container.remove();
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    await act(async () => {
      root2.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[editorPlugin]}
          initialEntries={['/recipes/oatmeal-honey-biscuits/edit']}
          session={{
            authenticated: true,
            principal_kind: 'user',
            email: 'editor@archive.example.test',
            role: 'editor',
          }}
        />
      );
    });
    await flushUi();
    expect(container2.textContent).toContain('Reference Card');
    expect(container2.textContent).toContain('Handwritten card front');

    // Switch reference photo to Card Back and open lightbox preview
    const cardBackSwitch = [...container2.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('2. Card Back')
    );
    act(() => {
      cardBackSwitch?.click();
    });
    expect(container2.textContent).toContain('Handwritten card back');
    const inspectBtn = [...container2.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Inspect full size')
    );
    act(() => {
      inspectBtn?.click();
    });
    const closeLightboxBtn = [...container2.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Close'
    );
    act(() => {
      closeLightboxBtn?.click();
    });

    // Edit title and submit -> hits simulated 409 conflict without losing edits
    const editTitleInput = container2.querySelector<HTMLInputElement>('input[name="title"]');
    act(() => {
      setNativeValue(editTitleInput!, 'My Edited Honey Biscuits');
    });
    const saveChangesBtn = container2.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => {
      saveChangesBtn?.click();
    });
    await flushUi();
    expect(container2.textContent).toContain('Newer version saved by Archive Steward');
    expect(editTitleInput?.value).toBe('My Edited Honey Biscuits');

    // Choose "Keep My Edits & Save Over v2", then save again -> succeeds with expected_version 2!
    const keepOverBtn = [...container2.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Keep My Edits')
    );
    act(() => {
      keepOverBtn?.click();
    });
    await act(async () => {
      saveChangesBtn?.click();
    });
    await flushUi();
    expect(updateCalls.map((c) => c.expectedVersion)).toEqual([1, 2]);
    expect(container2.textContent).toContain('My Edited Honey Biscuits');

    // 4. Delete recipe from detail page via confirmation modal
    const deleteRecipeBtn = [...container2.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Delete Recipe'
    );
    expect(deleteRecipeBtn).toBeDefined();
    act(() => {
      deleteRecipeBtn?.click();
    });
    expect(container2.textContent).toContain('Delete this recipe?');
    const confirmDelRecipeBtn = [...container2.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Confirm Delete'
    );
    await act(async () => {
      confirmDelRecipeBtn?.click();
    });
    await flushUi();
    expect(deleteCalls).toEqual(['oatmeal-honey-biscuits']);

    act(() => {
      root2.unmount();
    });
    container2.remove();
  });

  it('hides Add, Edit, and Delete controls for viewers and blocks unauthorized direct navigation to /recipes/new and /recipes/:slug/edit', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const staticPlugin = createRecipesUiPlugin({
      staticRecipes: SAMPLE_RECIPES,
      staticPhotosByRecipeId: SAMPLE_PHOTOS,
    });

    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[staticPlugin]}
          initialEntries={['/recipes/oatmeal-honey-biscuits']}
        />
      );
    });
    await flushUi();
    expect(container.textContent).not.toContain('Edit Recipe');
    expect(container.textContent).not.toContain('Delete Recipe');

    await act(async () => {
      root.unmount();
    });
    container.remove();

    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    await act(async () => {
      root2.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[staticPlugin]}
          initialEntries={['/recipes/new']}
        />
      );
    });
    await flushUi();
    expect(container2.textContent).toContain('Editor sign-in required');

    act(() => {
      root2.unmount();
    });
    container2.remove();

    const container3 = document.createElement('div');
    document.body.appendChild(container3);
    const root3 = createRoot(container3);
    await act(async () => {
      root3.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[staticPlugin]}
          initialEntries={['/recipes/oatmeal-honey-biscuits/edit']}
        />
      );
    });
    await flushUi();
    expect(container3.textContent).toContain('Editing is not permitted for your account');

    act(() => {
      root3.unmount();
    });
    container3.remove();
  });

  it('exercises Reload Latest Version on 409, slug/400 API errors, step/ingredient row edits, tag removal, discard confirm, and missing edit 404', async () => {
    const setTextareaValue = (el: HTMLTextAreaElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    let modeToThrow: 'conflict' | 'slug' | 'validation' | 'generic' = 'conflict';
    const editorClient: RecipesClient = {
      async listRecipes() {
        return {
          recipes: [...SAMPLE_RECIPES],
          total: SAMPLE_RECIPES.length,
          limit: 24,
          offset: 0,
          facets: { courses: ['bread'], tags: ['winter'] },
          display: { show_home_widget: true },
          permissions: { can_create: true },
        };
      },
      async getRecipe(slugOrId) {
        if (slugOrId === 'missing-slug') {
          return null;
        }
        return {
          recipe: SAMPLE_RECIPES[0],
          photos: [...(SAMPLE_PHOTOS.rec_1 ?? [])],
          viewer_has_starred: true,
          permissions: {
            can_edit: true,
            can_delete: true,
            can_upload: true,
            can_star: true,
            can_comment: true,
          },
        };
      },
      async listRecipesByPerson() {
        return { person_id: 'p_ada', recipes: [], total: 0 };
      },
      async createRecipe() {
        if (modeToThrow === 'slug') {
          throw Object.assign(new Error('Slug already taken.'), {
            status: 409,
            code: 'RECIPE_SLUG_CONFLICT',
          });
        }
        if (modeToThrow === 'validation') {
          throw Object.assign(new Error('Validation failed.'), {
            status: 400,
            code: 'VALIDATION_ERROR',
            details: [{ path: 'title', message: 'Server rejected title.' }],
          });
        }
        throw new Error('Network offline');
      },
      async updateRecipe() {
        throw Object.assign(new Error('Version conflict.'), {
          status: 409,
          code: 'RECIPE_VERSION_CONFLICT',
          details: {
            expected_version: 1,
            server_version: 3,
            server_updated_at: '2026-11-27T16:00:00.000Z',
            server_updated_by_name: 'Archive Steward',
            server_recipe: {
              ...SAMPLE_RECIPES[0],
              title: 'Reloaded Server Biscuits',
              version: 3,
            },
          },
        });
      },
    };

    const plugin = createRecipesUiPlugin({ client: editorClient });

    // 1. Missing recipe on /recipes/:slug/edit renders Not Found empty state
    const c1 = document.createElement('div');
    document.body.appendChild(c1);
    const r1 = createRoot(c1);
    await act(async () => {
      r1.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes/missing-slug/edit']}
          session={{
            authenticated: true,
            principal_kind: 'user',
            email: 'editor@archive.example.test',
            role: 'editor',
          }}
        />
      );
    });
    await flushUi();
    expect(c1.textContent).toContain('Recipe not found');
    act(() => {
      r1.unmount();
    });
    c1.remove();

    // 2. Edit page: field edits, blur validation, tag remove, clear ancestor, add/move/remove step & ingredient, 409 Reload Latest Version, and Discard Changes
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const r2 = createRoot(c2);
    await act(async () => {
      r2.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes/oatmeal-honey-biscuits/edit']}
          session={{
            authenticated: true,
            principal_kind: 'user',
            email: 'editor@archive.example.test',
            role: 'editor',
          }}
        />
      );
    });
    await flushUi();

    const courseSelect = c2.querySelector<HTMLSelectElement>('select[name="course"]');
    const slugInput = c2.querySelector<HTMLInputElement>('input[name="slug"]');
    const summaryInput = c2.querySelector<HTMLTextAreaElement>('textarea[name="summary"]');
    const servingsInput = c2.querySelector<HTMLInputElement>('input[name="servings"]');
    const eraInput = c2.querySelector<HTMLInputElement>('input[name="source_era"]');
    const provInput = c2.querySelector<HTMLInputElement>('input[name="provenance_note"]');
    const tagInput = c2.querySelector<HTMLInputElement>('input[placeholder*="holiday"]');
    const qtyInput = c2.querySelector<HTMLInputElement>('input[placeholder="2"]');
    const unitInput = c2.querySelector<HTMLInputElement>('input[placeholder="cups"]');
    const noteInput = c2.querySelector<HTMLInputElement>('input[placeholder="sifted"]');
    const groupInput = c2.querySelector<HTMLInputElement>('input[placeholder="Dry / Glaze"]');
    const stepNoteInput = c2.querySelector<HTMLInputElement>('input[placeholder*="middle rack"]');

    act(() => {
      setNativeValue(courseSelect!, 'dessert');
      setNativeValue(slugInput!, 'oatmeal-honey-biscuits');
      slugInput!.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      setTextareaValue(summaryInput!, 'Updated summary line.');
      setNativeValue(servingsInput!, '16 biscuits');
      setNativeValue(eraInput!, 'c. 1845');
      setNativeValue(provInput!, 'Updated ledger note');
      setNativeValue(qtyInput!, '3');
      setNativeValue(unitInput!, 'tbsp');
      setNativeValue(noteInput!, 'warm');
      setNativeValue(groupInput!, 'Topping');
      setNativeValue(stepNoteInput!, 'Check at 15 min');
    });

    // Invalid tag error + Enter key tag add + tag remove
    act(() => {
      setNativeValue(tagInput!, '!!!');
      tagInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(c2.textContent).toContain('Tags may contain letters');
    act(() => {
      setNativeValue(tagInput!, 'cozy');
      tagInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(c2.textContent).toContain('#cozy');
    const removeTagBtn = c2.querySelector<HTMLButtonElement>('button[aria-label="Remove #cozy"]');
    act(() => {
      removeTagBtn?.click();
    });

    // Clear ancestor & search deceased ancestor
    const clearAncBtn = [...c2.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Clear ancestor'
    );
    act(() => {
      clearAncBtn?.click();
    });
    const ancSearch = c2.querySelector<HTMLInputElement>('input[placeholder*="Search deceased ancestors"]');
    act(() => {
      setNativeValue(ancSearch!, 'Charles');
    });
    expect(c2.textContent).toContain('Charles Babbage');

    // Move Down ingredient 1 and Remove ingredient 2; Add Step, Move Down, Move Up, Remove Step
    act(() => {
      c2.querySelector<HTMLButtonElement>('button[aria-label="Move ingredient 1 down"]')?.click();
      c2.querySelector<HTMLButtonElement>('button[aria-label="Remove ingredient 2"]')?.click();
    });
    const addStepBtn = [...c2.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Add Step')
    );
    act(() => {
      addStepBtn?.click();
    });
    act(() => {
      c2.querySelector<HTMLButtonElement>('button[aria-label="Move step 1 down"]')?.click();
      c2.querySelector<HTMLButtonElement>('button[aria-label="Move step 2 up"]')?.click();
      c2.querySelector<HTMLButtonElement>('button[aria-label="Remove step 3"]')?.click();
    });

    // Submit -> hits 409 conflict -> click "Reload Latest Version"
    const submitEditBtn = c2.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => {
      submitEditBtn?.click();
    });
    await flushUi();
    const reloadBtn = [...c2.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Reload Latest Version'
    );
    expect(reloadBtn).toBeDefined();
    act(() => {
      reloadBtn?.click();
    });
    expect(c2.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe('Reloaded Server Biscuits');

    // Make form dirty again, open Discard modal, and confirm Discard Changes
    act(() => {
      setNativeValue(c2.querySelector<HTMLInputElement>('input[name="title"]')!, 'Dirty Title');
    });
    const cancelBtn = [...c2.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Cancel'
    );
    act(() => {
      cancelBtn?.click();
    });
    const discardBtn = [...c2.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Discard Changes'
    );
    await act(async () => {
      discardBtn?.click();
    });
    await flushUi();

    act(() => {
      r2.unmount();
    });
    c2.remove();

    // 3. Create page error branches: 409 slug conflict, 400 field errors, and generic network error
    const c3 = document.createElement('div');
    document.body.appendChild(c3);
    const r3 = createRoot(c3);
    await act(async () => {
      r3.render(
        <KinloomApp
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes/new']}
          session={{
            authenticated: true,
            principal_kind: 'user',
            email: 'editor@archive.example.test',
            role: 'editor',
          }}
        />
      );
    });
    await flushUi();

    const newTitle = c3.querySelector<HTMLInputElement>('input[name="title"]');
    act(() => {
      setNativeValue(newTitle!, 'Test Error Handling Pie');
    });

    modeToThrow = 'slug';
    await act(async () => {
      c3.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await flushUi();
    expect(c3.textContent).toContain('Slug already taken.');

    modeToThrow = 'validation';
    await act(async () => {
      c3.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await flushUi();
    expect(c3.textContent).toContain('Server rejected title.');

    modeToThrow = 'generic';
    await act(async () => {
      c3.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await flushUi();
    expect(c3.textContent).toContain('Network offline');

    act(() => {
      r3.unmount();
    });
    c3.remove();
  });
});

describe('Recipe Starring, Optimistic Rollback, and My Favorites UI (#50)', () => {
  it('toggles stars optimistically on catalog cards and detail page, rolls back with alert on API error, and hides My Favorites when can_star is false', async () => {
    let failNextStar = false;
    let canStarFlag = true;
    let recipesState: UiRecipeDetail[] = SAMPLE_RECIPES.map((r) => ({ ...r }));
    const starCalls: string[] = [];

    const interactiveClient: RecipesClient = {
      async listRecipes(params = {}) {
        const filtered = recipesState.filter((r) => !params.favorites || r.viewer_has_starred);
        const sorted = [...filtered].sort((a, b) => {
          if (params.sort === 'alpha') {
            return a.title.localeCompare(b.title);
          }
          if (params.sort === 'newest') {
            return b.created_at.localeCompare(a.created_at);
          }
          if (b.star_count !== a.star_count) {
            return b.star_count - a.star_count;
          }
          return b.updated_at.localeCompare(a.updated_at);
        });
        return {
          recipes: sorted,
          total: sorted.length,
          limit: 24,
          offset: 0,
          facets: { courses: ['bread', 'dessert'], tags: ['autumn', 'heirloom', 'winter'] },
          display: { show_home_widget: true },
          permissions: { can_create: false, can_star: canStarFlag },
        };
      },
      async getRecipe(slugOrId) {
        const found = recipesState.find((r) => r.slug === slugOrId || r.id === slugOrId);
        if (!found) {
          return null;
        }
        return {
          recipe: found,
          photos: [...(SAMPLE_PHOTOS[found.id] ?? [])],
          viewer_has_starred: found.viewer_has_starred,
          permissions: {
            can_edit: false,
            can_delete: false,
            can_upload: false,
            can_star: canStarFlag,
            can_comment: false,
          },
        };
      },
      async listRecipesByPerson(personId) {
        const matched = recipesState.filter((r) => r.attributed_person_id === personId);
        return {
          person_id: personId,
          recipes: matched,
          total: matched.length,
          permissions: { can_star: canStarFlag },
        };
      },
      async starRecipe(slugOrId) {
        starCalls.push(`POST:${slugOrId}`);
        if (failNextStar) {
          failNextStar = false;
          throw new Error('Star service temporarily unavailable');
        }
        const target = recipesState.find((r) => r.slug === slugOrId || r.id === slugOrId);
        if (!target) {
          throw new Error('Not found');
        }
        const nextCount = target.viewer_has_starred ? target.star_count : target.star_count + 1;
        recipesState = recipesState.map((r) =>
          r.id === target.id ? { ...r, star_count: nextCount, viewer_has_starred: true } : r
        );
        return { recipe_id: target.id, star_count: nextCount, viewer_has_starred: true };
      },
      async unstarRecipe(slugOrId) {
        starCalls.push(`DELETE:${slugOrId}`);
        if (failNextStar) {
          failNextStar = false;
          throw new Error('Unable to remove star right now');
        }
        const target = recipesState.find((r) => r.slug === slugOrId || r.id === slugOrId);
        if (!target) {
          throw new Error('Not found');
        }
        const nextCount = target.viewer_has_starred ? Math.max(0, target.star_count - 1) : target.star_count;
        recipesState = recipesState.map((r) =>
          r.id === target.id ? { ...r, star_count: nextCount, viewer_has_starred: false } : r
        );
        return { recipe_id: target.id, star_count: nextCount, viewer_has_starred: false };
      },
    };

    const plugin = createRecipesUiPlugin({ client: interactiveClient });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    // 1. Authenticated member sees My Favorites tab & interactive star buttons on /recipes
    await act(async () => {
      root.render(
        <KinloomApp
          key="star-catalog"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes?sort=most_starred']}
        />
      );
    });
    await flushUi();

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    const pieStarBtn = container.querySelector<HTMLButtonElement>('button[aria-label*="Autumn Cider Pie"]');
    expect(pieStarBtn?.getAttribute('aria-pressed')).toBe('false');

    // Star Autumn Cider Pie -> updates optimistically and reconciles
    await act(async () => {
      pieStarBtn?.click();
    });
    await flushUi();
    expect(starCalls).toContain('POST:autumn-cider-pie');
    const pieStarBtnAfter = container.querySelector<HTMLButtonElement>(
      'button[aria-label*="Autumn Cider Pie"]'
    );
    expect(pieStarBtnAfter?.getAttribute('aria-pressed')).toBe('true');
    expect(pieStarBtnAfter?.textContent).toContain('2');

    // Rollback on failure surfaces accessible role="alert" toast and restores previous star state
    failNextStar = true;
    await act(async () => {
      pieStarBtnAfter?.click();
    });
    await flushUi();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Unable to remove star right now'
    );
    expect(
      container
        .querySelector<HTMLButtonElement>('button[aria-label*="Autumn Cider Pie"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');

    // Switch to My Favorites tab (?favorites=1 bookmark route) and unstar with rollback then success
    await act(async () => {
      root.render(
        <KinloomApp
          key="star-favorites-url"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes?favorites=1']}
        />
      );
    });
    await flushUi();
    const favTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) =>
      t.textContent?.includes('My Favorites')
    );
    expect(favTab?.getAttribute('aria-selected')).toBe('true');

    failNextStar = true;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label*="Autumn Cider Pie"]')?.click();
    });
    await flushUi();
    // Rollback restored Autumn Cider Pie into My Favorites list
    expect(container.textContent).toContain('Autumn Cider Pie');

    // Now succeed unstarring Autumn Cider Pie from My Favorites
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label*="Autumn Cider Pie"]')?.click();
    });
    await flushUi();
    expect(container.textContent).not.toContain('Autumn Cider Pie');

    // 2. Detail page star toggle & rollback
    await act(async () => {
      root.render(
        <KinloomApp
          key="star-detail"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes/autumn-cider-pie']}
        />
      );
    });
    await flushUi();

    const detailStarBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label*="Autumn Cider Pie"]'
    );
    expect(detailStarBtn?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      detailStarBtn?.click();
    });
    await flushUi();
    expect(
      container
        .querySelector<HTMLButtonElement>('button[aria-label*="Autumn Cider Pie"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');

    failNextStar = true;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label*="Autumn Cider Pie"]')?.click();
    });
    await flushUi();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Unable to remove star right now'
    );
    expect(
      container
        .querySelector<HTMLButtonElement>('button[aria-label*="Autumn Cider Pie"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');

    // 3. Viewer without can_star sees read-only star count badges (zero star buttons) and no My Favorites tab
    canStarFlag = false;
    await act(async () => {
      root.render(
        <KinloomApp
          key="star-readonly-catalog"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes']}
        />
      );
    });
    await flushUi();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(
      container.querySelector('button[aria-label*="Star recipe"], button[aria-label*="Remove star"]')
    ).toBeNull();
    expect(container.textContent).toContain('4 stars');

    await act(async () => {
      root.render(
        <KinloomApp
          key="star-readonly-detail"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes/oatmeal-honey-biscuits']}
        />
      );
    });
    await flushUi();
    expect(container.querySelector('button[aria-label*="Oatmeal Honey Biscuits"]')).toBeNull();
    expect(container.textContent).toContain('4 stars');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders threaded family discussion with XSS-safe markdown, bounded replies, inline edits, accessible delete modal, tombstones, and read-only states (#51)', async () => {
    let canCommentFlag = true;
    let failNextMutation: string | null = null;
    let nextId = 1;
    let commentsState: UiRecipeComment[] = [];

    const commentsClient: RecipesClient = {
      async listRecipes() {
        return {
          recipes: [...SAMPLE_RECIPES],
          total: SAMPLE_RECIPES.length,
          limit: 40,
          offset: 0,
          facets: { courses: ['bread', 'dessert'], tags: ['heirloom'] },
        };
      },
      async getRecipe(slugOrId) {
        const found = SAMPLE_RECIPES.find((r) => r.slug === slugOrId || r.id === slugOrId);
        if (!found) {
          return null;
        }
        return {
          recipe: { ...found, comment_count: commentsState.filter((c) => !c.deleted).length },
          photos: [...(SAMPLE_PHOTOS[found.id] ?? [])],
          viewer_has_starred: found.viewer_has_starred,
          permissions: {
            can_edit: false,
            can_delete: false,
            can_upload: false,
            can_star: false,
            can_comment: canCommentFlag,
          },
        };
      },
      async listRecipesByPerson() {
        return { person_id: 'p_ada', recipes: [], total: 0 };
      },
      async listRecipeComments() {
        const rootsWithActiveReplies = new Set(
          commentsState
            .filter((c) => !c.deleted && c.parent_comment_id !== null)
            .map((c) => c.parent_comment_id)
        );
        const visible = commentsState.filter(
          (c) => !c.deleted || (c.depth === 0 && rootsWithActiveReplies.has(c.id))
        );
        return {
          recipe_id: 'rec_1',
          comments: visible,
          comment_count: visible.filter((c) => !c.deleted).length,
          permissions: { can_comment: canCommentFlag },
        };
      },
      async createRecipeComment(_slugOrId, input) {
        if (failNextMutation) {
          const msg = failNextMutation;
          failNextMutation = null;
          throw new Error(msg);
        }
        const id = `cmt_ui_${nextId}`;
        nextId += 1;
        const created: UiRecipeComment = {
          id,
          parent_comment_id: input.parent_comment_id ?? null,
          depth: input.parent_comment_id ? 1 : 0,
          deleted: false,
          deleted_by_role: null,
          author_name: input.parent_comment_id ? 'Jonah Baker' : 'Clara Baker',
          author_key: input.parent_comment_id ? 'usr_jonah' : 'usr_clara',
          body_md: input.body_md,
          created_at: '2026-11-27T12:00:00.000Z',
          edited_at: null,
          can_edit: true,
          can_delete: true,
        };
        commentsState = [...commentsState, created];
        return {
          comment: created,
          comment_count: commentsState.filter((c) => !c.deleted).length,
        };
      },
      async updateRecipeComment(_slugOrId, commentId, input) {
        if (failNextMutation) {
          const msg = failNextMutation;
          failNextMutation = null;
          throw new Error(msg);
        }
        const target = commentsState.find((c) => c.id === commentId);
        if (!target) {
          throw new Error('Comment not found');
        }
        const updated: UiRecipeComment = {
          ...target,
          body_md: input.body_md,
          edited_at: '2026-11-27T12:10:00.000Z',
        };
        commentsState = commentsState.map((c) => (c.id === commentId ? updated : c));
        return { comment: updated };
      },
      async deleteRecipeComment(_slugOrId, commentId) {
        if (failNextMutation) {
          const msg = failNextMutation;
          failNextMutation = null;
          throw new Error(msg);
        }
        commentsState = commentsState.map((c) =>
          c.id === commentId
            ? {
                ...c,
                deleted: true,
                deleted_by_role: 'author',
                author_name: null,
                author_key: null,
                body_md: '',
                edited_at: null,
                can_edit: false,
                can_delete: false,
              }
            : c
        );
      },
    };

    const plugin = createRecipesUiPlugin({ client: commentsClient });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <KinloomApp
          key="comments-member"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes/oatmeal-honey-biscuits']}
        />
      );
    });
    await flushUi();

    // Empty state copy is displayed
    expect(container.textContent).toContain('Family Discussion');
    expect(container.textContent).toContain('Share a memory or cooking note about this recipe.');

    // Submitting empty comment flags aria-invalid and displays error alert
    const postBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Post Comment'
    );
    await act(async () => {
      postBtn?.click();
    });
    await flushUi();
    const composer = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(composer?.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter a comment before posting.'
    );

    // Post top-level comment containing XSS payloads -> rendered strictly as inert text
    const xssPayload =
      '**Great** biscuit tip: <script>alert(1)</script> [click](javascript:alert(1)) <img src=x onerror=alert(1)>';
    act(() => {
      if (composer) {
        setNativeValue(composer, xssPayload);
      }
    });
    await act(async () => {
      postBtn?.click();
    });
    await flushUi();

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.textContent).toContain('Clara Baker');
    expect(container.textContent).toContain('1 comment');
    expect(container.querySelector('time[title="2026-11-27T12:00:00.000Z"]')).not.toBeNull();

    // Reply to root comment -> creates indented depth-1 reply with NO nested Reply button on the reply
    const replyTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reply to Clara Baker"]'
    );
    act(() => {
      replyTrigger?.click();
    });
    await flushUi();
    const replyTextarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Write a reply…"]'
    );
    const postReplyBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Post Reply'
    );
    // Empty reply shows validation error
    await act(async () => {
      postReplyBtn?.click();
    });
    expect(replyTextarea?.getAttribute('aria-invalid')).toBe('true');

    act(() => {
      if (replyTextarea) {
        setNativeValue(replyTextarea, 'Baked these for Sunday breakfast.');
      }
    });
    await act(async () => {
      postReplyBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Jonah Baker');
    expect(container.textContent).toContain('Baked these for Sunday breakfast.');
    expect(container.textContent).toContain('2 comments');
    expect(container.querySelector('button[aria-label="Reply to Jonah Baker"]')).toBeNull();

    // Inline edit on reply -> updates body and displays (edited) badge
    const editReplyBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit comment by Jonah Baker"]'
    );
    act(() => {
      editReplyBtn?.click();
    });
    await flushUi();
    const editTextarea = container.querySelector<HTMLTextAreaElement>('article textarea');
    act(() => {
      if (editTextarea) {
        setNativeValue(editTextarea, 'Baked these for Sunday brunch with jam.');
      }
    });
    const saveEditBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Save Changes'
    );
    await act(async () => {
      saveEditBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Baked these for Sunday brunch with jam.');
    expect(container.textContent).toContain('(edited)');

    // Delete root comment via accessible ArchivalModal -> leaves [Comment removed] tombstone while keeping reply
    const deleteRootBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete comment by Clara Baker"]'
    );
    act(() => {
      deleteRootBtn?.click();
    });
    await flushUi();
    const modal = container.querySelector('dialog');
    expect(modal?.textContent).toContain('Delete this comment?');
    expect(modal?.textContent).toContain('[Comment removed]');

    const confirmDelBtn = [...(modal?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (b) => b.textContent === 'Confirm Delete'
    );
    await act(async () => {
      confirmDelBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('[Comment removed]');
    expect(container.textContent).toContain('Baked these for Sunday brunch with jam.');
    expect(container.textContent).toContain('1 comment');

    // Mutation error surfaces accessible toast cleanly
    failNextMutation = 'Delete failed temporarily';
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Delete comment by Jonah Baker"]')
        ?.click();
    });
    await flushUi();
    const errModalConfirm = [...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent === 'Confirm Delete'
    );
    await act(async () => {
      errModalConfirm?.click();
    });
    await flushUi();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Delete failed temporarily');

    // Now succeed deleting reply -> clears tombstone and returns to empty state
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Delete comment by Jonah Baker"]')
        ?.click();
    });
    await flushUi();
    const finalModalConfirm = [...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent === 'Confirm Delete'
    );
    await act(async () => {
      finalModalConfirm?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Share a memory or cooking note about this recipe.');
    expect(container.textContent).toContain('0 comments');

    // Read-only / non-permitted viewer sees no composer and no comment mutation buttons
    canCommentFlag = false;
    await act(async () => {
      root.render(
        <KinloomApp
          key="comments-readonly"
          siteConfig={SITE_CONFIG}
          initialBundle={TEST_BUNDLE}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[plugin]}
          initialEntries={['/recipes/oatmeal-honey-biscuits']}
        />
      );
    });
    await flushUi();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).toContain('Sign in as a family archive member to join the discussion.');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
