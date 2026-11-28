/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, RevisionRecord } from '@kinloom/core';
import { asBatchId, asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecipesClient } from '../adapters/recipesClient.js';
import { EvidenceLegend } from '../components/EvidenceLegend.js';
import { AuthSignInFlow } from '../components/wiki/AuthSignInFlow.js';
import { AuthorPill, formatAgentAuthorLabel } from '../components/wiki/WikiBadges.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { KinloomApp } from '../KinloomApp.js';
import { formatPersonDirectoryLifespan } from '../lib/peopleDirectoryModel.js';
import { parsePlaceRegion } from '../lib/placesDirectoryModel.js';
import { createOpenFinancePlugin } from '../plugins/openFinancePlugin.js';
import { createRecipesUiPlugin } from '../plugins/recipesPlugin.js';
import { KinshipPage } from './KinshipPage.js';
import { RecentChangesPage } from './RecentChangesPage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(HERE, '..');

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
    await new Promise((r) => setTimeout(r, 25));
  });
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Family Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ISSUE_112_TEST',
  },
  featuredKinshipPairs: [
    {
      label: 'Clara Alder <-> Henry Alder',
      fromId: 'p_clara',
      toId: 'p_henry',
    },
  ],
});

const { bundle: TEST_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  people: [
    {
      id: 'p_clara',
      slug: 'clara-alder',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1840',
      death_edtf: '1910',
      portrait_url: null,
    },
    {
      id: 'p_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'direct_ancestor',
      birth_edtf: '1865',
      death_edtf: '1938',
      portrait_url: null,
    },
    {
      id: 'p_undated',
      slug: 'unknown-alder',
      full_name: 'Unknown Alder',
      given_name: 'Unknown',
      surname: 'Alder',
      alt_names: [],
      sex: 'U',
      is_living: false,
      lineage_group: 'direct_ancestor',
      birth_edtf: '',
      death_edtf: '',
      portrait_url: null,
    },
  ],
  places: [],
  events: [
    {
      id: 'ev_1',
      title: '1880 Federal Census',
      summary: 'Enumerated in Hudsonville.',
      event_kind: 'point_event',
      scope: 'personal',
      edtf_date: '1880',
      place_id: null,
      participants: [{ person_id: 'p_clara', role: 'principal' }],
      sources: [],
    },
    {
      id: 'ev_2',
      title: '1880 Census Record',
      summary: 'Duplicate census entry.',
      event_kind: 'point_event',
      scope: 'personal',
      edtf_date: '1880',
      place_id: null,
      participants: [{ person_id: 'p_clara', role: 'principal' }],
      sources: [],
    },
    {
      id: 'ev_3',
      title: '1900 Federal Census',
      summary: 'Enumerated in Grand Rapids.',
      event_kind: 'point_event',
      scope: 'personal',
      edtf_date: '1900',
      place_id: null,
      participants: [{ person_id: 'p_henry', role: 'principal' }],
      sources: [],
    },
    {
      id: 'ev_4',
      title: '1900 Census Record',
      summary: 'Duplicate 1900 census entry.',
      event_kind: 'point_event',
      scope: 'personal',
      edtf_date: '1900',
      place_id: null,
      participants: [{ person_id: 'p_henry', role: 'principal' }],
      sources: [],
    },
  ],
  sources: [],
  kinship: [{ from: 'p_clara', to: 'p_henry', relation: 'parent' }],
});

describe('Issue #112 — /recipes empty-state filter hiding & recovery CTA', () => {
  it('hides the 4-control filter bar when 0 recipes exist and shows viewer Sign-In CTA', async () => {
    const mockClient: RecipesClient = {
      listRecipes: vi.fn(async () => ({
        recipes: [],
        total: 0,
        limit: 24,
        offset: 0,
        facets: { courses: [], tags: [] },
        permissions: { can_create: false, can_star: false, can_comment: false },
      })),
      getRecipe: vi.fn(async () => null),
      listRecipesByPerson: vi.fn(async () => null),
    };
    const plugin = createRecipesUiPlugin({ client: mockClient });
    const dataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: TEST_BUNDLE, etag: null, notModified: false }),
      loadReadings: async () => null,
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: {
          authenticated: false,
          principal_kind: 'anonymous',
        },
        capabilities: {
          canReadArchive: true,
          canEdit: false,
          canManageSite: false,
          canUploadMedia: false,
          canRevert: false,
          canModerateTalk: false,
          canManageInvites: false,
          canManageTokens: false,
          hasRevisionHistory: false,
          hasTalk: false,
        },
        authProviders: { google: false, magicLink: true },
      }),
      requestMagicLink: async () => ({ sent: true }),
    };

    const container = mountEl(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        initialBundle={TEST_BUNDLE}
        dataSource={dataSource}
        plugins={[plugin]}
        initialEntries={['/recipes']}
      />
    );
    await flushUi();

    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.querySelector('select')).toBeNull();

    const signInCta = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Sign in to add a recipe')
    );
    expect(signInCta).toBeDefined();

    await act(async () => {
      signInCta?.click();
    });
    expect(container.querySelector('dialog[open]')).not.toBeNull();
  });

  it('shows + Add Recipe CTA for editors when 0 recipes exist', async () => {
    const mockClient: RecipesClient = {
      listRecipes: vi.fn(async () => ({
        recipes: [],
        total: 0,
        limit: 24,
        offset: 0,
        facets: { courses: [], tags: [] },
        permissions: { can_create: true, can_star: true, can_comment: true },
      })),
      getRecipe: vi.fn(async () => null),
      listRecipesByPerson: vi.fn(async () => null),
      createRecipe: vi.fn(),
    };
    const plugin = createRecipesUiPlugin({ client: mockClient });

    const container = mountEl(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        initialBundle={TEST_BUNDLE}
        plugins={[plugin]}
        initialEntries={['/recipes']}
      />
    );
    await flushUi();

    expect(container.querySelector('input[type="search"]')).toBeNull();
    const addLink = Array.from(container.querySelectorAll('a')).find((a) =>
      a.textContent?.includes('+ Add Recipe')
    );
    expect(addLink).toBeDefined();
  });
});

describe('Issue #112 — /support Open Finance empty-state KPIs, plain copy, and surface shifts', () => {
  it('hides zeroed KPI tiles when no cost items or platforms exist and avoids developer jargon', async () => {
    const plugin = createOpenFinancePlugin({
      liveSync: false,
      config: {
        page_title: 'Support the Alder Archive',
        supporter_message: 'Help keep our family stories online.',
        currency: 'USD',
        visibility: { show_support_page: true, show_in_nav: true, show_in_footer: true },
        platforms: [],
        cost_items: [],
      },
    });

    const container = mountEl(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        initialBundle={TEST_BUNDLE}
        plugins={[plugin]}
        initialEntries={['/support']}
      />
    );
    await flushUi();

    expect(container.querySelector('[data-testid="open-finance-monthly-total"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-finance-annual-total"]')).toBeNull();
    expect(container.textContent).not.toContain('$0.00');
    expect(container.textContent).not.toContain('Zero payment custody');
    expect(container.textContent).not.toContain('Amortized recurring cost / month');
    expect(container.textContent).not.toContain('Allowlisted HTTPS channels');
    expect(container.textContent).toContain('never collects payment details');

    const css = readFileSync(resolve(UI_SRC, 'plugins/openFinance/OpenFinance.module.css'), 'utf8');
    expect(css).toContain('background: var(--surface-subtle);');
    expect(css).not.toMatch(/\.of-custody-note\s*\{[^}]*--font-mono/);
  });
});

describe('Issue #112 — /changes duplicate warning collapse, pagination, and agent author formatting', () => {
  it('formats raw CLI sync tokens and agent identifiers cleanly', () => {
    expect(formatAgentAuthorLabel('cli-sync-token')).toBe('Archive sync');
    expect(formatAgentAuthorLabel('kinloom_cli_sync_a1b2c3')).toBe('Archive sync');
    expect(formatAgentAuthorLabel('census-research-agent')).toBe('Census Research Agent');
    expect(formatAgentAuthorLabel('Ada Researcher')).toBe('Ada Researcher');

    const container = mountEl(<AuthorPill authorType="agent" authorName="cli-sync-token" />);
    expect(container.textContent).toContain('Research agent · Archive sync');
  });

  it('collapses multiple duplicate warnings behind a single disclosure button and supports pagination', async () => {
    const batchId = asBatchId('bat_dup_1');
    const makeRev = (id: number, entityId: string, summary: string): RevisionRecord => ({
      revision_id: asRevisionId(id),
      parent_revision_id: null,
      reverted_revision_id: null,
      batch_id: batchId,
      author_id: 'agent:cli-sync',
      entity_type: 'event',
      entity_id: entityId,
      action: 'create',
      author_type: 'agent',
      author_name: 'cli-sync-token',
      summary,
      has_primary_source: false,
      before_json: null,
      after_json: null,
      created_at: '2026-11-27T12:00:00.000Z',
    });

    const page1 = [
      makeRev(104, 'ev_1', 'Added 1880 census'),
      makeRev(103, 'ev_2', 'Added 1880 census copy'),
      makeRev(102, 'ev_3', 'Added 1900 census'),
      makeRev(101, 'ev_4', 'Added 1900 census copy'),
    ];
    const page2 = [
      {
        ...makeRev(100, 'ev_old', 'Older revision'),
        batch_id: null,
      },
    ];

    const listRevisions = vi.fn(async (query: { cursor?: number }) => {
      if (query.cursor === 101) {
        return { items: page2, next_cursor: null, total: 5 };
      }
      return { items: page1, next_cursor: asRevisionId(101), total: 5 };
    });

    const dataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: TEST_BUNDLE, etag: null, notModified: false }),
      loadReadings: async () => null,
      loadMediaChecklist: async () => [],
      listRevisions,
    };

    const container = mountEl(
      <MemoryRouter initialEntries={['/changes']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE} dataSource={dataSource}>
          <RecentChangesPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    expect(container.textContent).toContain('Showing 4 of 5 changes');
    expect(container.textContent).toContain('Research agent · Archive sync');

    const dupToggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('2 possible duplicate events to inspect')
    );
    expect(dupToggle).toBeDefined();
    expect(dupToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Possible duplicate event detected:');

    await act(async () => {
      dupToggle?.click();
    });
    expect(dupToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Possible duplicate event detected:');

    const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Load older changes')
    );
    expect(loadMoreBtn).toBeDefined();
    await act(async () => {
      loadMoreBtn?.click();
    });
    await flushUi();

    expect(listRevisions).toHaveBeenCalledWith(expect.objectContaining({ cursor: asRevisionId(101) }));
    expect(container.textContent).toContain('Older revision');
  });
});

describe('Issue #112 — Sign-In Gate typography, Directories, Evidence, Kinship & A-Z undated cards', () => {
  it('sets Sign-In Gate labels and invite toggle in --font-ui without dashed borders', () => {
    const authCss = readFileSync(resolve(UI_SRC, 'components/wiki/WikiAuth.module.css'), 'utf8');
    expect(authCss).toMatch(/\.wiki-auth-label\s*\{[^}]*font-family:\s*var\(--font-ui\)/);
    expect(authCss).toMatch(/\.wiki-divider-label\s*\{[^}]*font-family:\s*var\(--font-ui\)/);
    expect(authCss).toMatch(/\.wiki-invite-toggle\s*\{[^}]*font-family:\s*var\(--font-ui\)/);
    expect(authCss).not.toContain('border: 1px dashed');

    const dataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: TEST_BUNDLE, etag: null, notModified: false }),
      loadReadings: async () => null,
      loadMediaChecklist: async () => [],
      requestMagicLink: async () => ({ sent: true }),
    };
    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE} dataSource={dataSource}>
          <AuthSignInFlow showInviteHelper />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(container.textContent).toContain('Email address');
    expect(container.textContent).toContain('Have a family invite link?');
  });

  it('constrains /places and /time intro prose to <= 66ch, preserves Nordic diacritics, and fixes EvidenceLegend underline', () => {
    const atomsCss = readFileSync(resolve(UI_SRC, 'components/Atoms.module.css'), 'utf8');
    expect(atomsCss).toMatch(/\.axis-page-header \.folio-lead\s*\{[^}]*max-width:\s*66ch;/);

    const ostfold = parsePlaceRegion({
      name: 'Fredrikstad',
      full_name: 'Fredrikstad, Østfold, Norway',
      place_type: 'town',
    });
    expect(ostfold.heading).toBe('Østfold, Norway');
    expect(ostfold.shortLabel).toBe('Østfold');
    expect(ostfold.key).toBe('region-norway-ostfold');

    const aland = parsePlaceRegion({
      name: 'Mariehamn',
      full_name: 'Mariehamn, Åland, Finland',
      place_type: 'town',
    });
    expect(aland.heading).toBe('Åland, Finland');
    expect(aland.shortLabel).toBe('Åland');

    const legendCss = readFileSync(resolve(UI_SRC, 'components/EvidenceLegend.module.css'), 'utf8');
    expect(legendCss).toMatch(/\.evidence-legend-toggle\s*\{[^}]*text-decoration:\s*none;/);
    expect(legendCss).toMatch(/\.evidence-legend-toggle-label\s*\{[^}]*text-decoration:\s*underline dotted;/);

    const legendContainer = mountEl(
      <MemoryRouter>
        <EvidenceLegend />
      </MemoryRouter>
    );
    expect(legendContainer.textContent).toContain('How we weigh evidence');

    const evidenceCss = readFileSync(resolve(UI_SRC, 'pages/EvidencePage.module.css'), 'utf8');
    expect(evidenceCss).toContain('.evidence-banner-lead');
    expect(evidenceCss).toContain('display: none;');
  });

  it('replaces ASCII <-> with ↔, renders labeled overlap timeline bars on /kinship, and renders Dates unknown for undated people', () => {
    const undated = TEST_BUNDLE.people.find((p) => p.id === 'p_undated');
    expect(undated).toBeDefined();
    if (undated) {
      expect(formatPersonDirectoryLifespan(undated)).toBe('Dates unknown');
    }

    const container = mountEl(
      <MemoryRouter initialEntries={['/kinship']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <KinshipPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(container.textContent).not.toContain('<->');
    expect(container.textContent).toContain('1840–1910');
    expect(container.textContent).toContain('1865–1938');
    expect(container.textContent).toContain('Overlap 1865–1910');

    const altContainer = mountEl(
      <MemoryRouter initialEntries={['/kinship?from=p_undated&to=p_clara']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={TEST_BUNDLE}>
          <KinshipPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(altContainer.textContent).toContain('Clara Alder ↔ Henry Alder');
    expect(altContainer.textContent).not.toContain('<->');
  });
});
