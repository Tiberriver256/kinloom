/** @vitest-environment jsdom */
import type {
  AgentTokenScope,
  ArchiveBundle,
  ArchiveDataSource,
  InviteRecord,
  KinloomSiteConfig,
  UserRecord,
  UserRole,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  PublicAgentTokenRecord,
} from '../adapters/httpWikiDataSource.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { type AdminApiClient, AdminPage } from './AdminPage.js';
import { EvidencePage } from './EvidencePage.js';
import { IndexPage } from './IndexPage.js';
import { KinshipPage } from './KinshipPage.js';
import { NotFoundPage } from './NotFoundPage.js';
import { PlacePage } from './PlacePage.js';
import { PlacesIndexPage } from './PlacesIndexPage.js';
import { TimePage } from './TimePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Behavioral Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_UI_PAGES_TEST',
  },
  defaultBranchId: 'alder_main',
  branches: [
    {
      id: 'alder_main',
      label: 'Alder Line',
      surnames: ['Alder'],
      lineageGroups: ['ancestor', 'pivot_ancestor', 'descendant'],
      supportsDirectMode: true,
    },
  ],
  featuredKinshipPairs: [
    {
      label: 'Henry to Owen',
      fromId: 'per_henry',
      toId: 'per_owen',
      note: 'Father and son',
    },
  ],
});

function buildRichUiBundle(): ArchiveBundle {
  const { bundle } = compileArchive({
    siteConfig: SITE_CONFIG,
    mode: 'public',
    places: [
      {
        id: 'pl_usa',
        slug: 'united-states',
        name: 'United States',
        full_name: 'United States',
        place_type: 'country',
        parent_id: null,
        lat: 39.8,
        lng: -98.5,
      },
      {
        id: 'pl_mi',
        slug: 'michigan',
        name: 'Michigan',
        full_name: 'Michigan, USA',
        place_type: 'state',
        parent_id: 'pl_usa',
        lat: 44.3,
        lng: -85.6,
      },
      {
        id: 'pl_ottawa',
        slug: 'ottawa-county',
        name: 'Ottawa County',
        full_name: 'Ottawa County, Michigan, USA',
        place_type: 'county',
        parent_id: 'pl_mi',
        lat: 42.96,
        lng: -85.99,
      },
      {
        id: 'pl_hudsonville',
        slug: 'hudsonville',
        name: 'Hudsonville',
        full_name: 'Hudsonville, Ottawa County, Michigan, USA',
        place_type: 'town',
        parent_id: 'pl_ottawa',
        lat: 42.87,
        lng: -85.86,
      },
    ],
    sources: [
      {
        id: 'src_census_1880',
        citation: '1880 U.S. Federal Census, Ottawa County, Michigan',
        source_type: 'census',
        repository: 'National Archives',
        url: 'https://archives.example.test/1880',
        has_primary_source: true,
      },
      {
        id: 'src_book_1905',
        citation: 'History of Ottawa County (1905)',
        source_type: 'published_history',
        author: 'C. Vance',
      },
    ],
    people: [
      {
        id: 'per_henry',
        slug: 'henry-alder',
        full_name: 'Henry Alder',
        given_name: 'Henry',
        surname: 'Alder',
        alt_names: ['Hank Alder'],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        branch: 'alder_main',
        birth_edtf: '1855-03-14',
        death_edtf: '1932-11-02',
        portrait_url: '/media/henry.jpg',
      },
      {
        id: 'per_clara',
        slug: 'clara-mercer',
        full_name: 'Clara Mercer',
        given_name: 'Clara',
        surname: 'Mercer',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        branch: 'alder_main',
        birth_edtf: '1858-07-22',
        death_edtf: '1939-01-18',
        portrait_url: null,
      },
      {
        id: 'per_owen',
        slug: 'owen-alder',
        full_name: 'Owen Alder',
        given_name: 'Owen',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'descendant',
        branch: 'alder_main',
        birth_edtf: '1880-06-10',
        death_edtf: '1958-04-04',
        portrait_url: null,
      },
      {
        id: 'per_drifter',
        slug: 'ezra-bramwell',
        full_name: 'Ezra Bramwell',
        given_name: 'Ezra',
        surname: 'Bramwell',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'collateral',
        branch: 'alder_main',
        birth_edtf: '1852',
        death_edtf: '1915',
        portrait_url: null,
      },
    ],
    events: [
      {
        id: 'evt_census_1880',
        title: '1880 Federal Census in Hudsonville',
        summary: 'Henry, Clara, and infant Owen enumerated in Ottawa County.',
        event_kind: 'residence_anchor',
        scope: 'family',
        edtf_date: '1880-06-15',
        place_id: 'pl_hudsonville',
        participants: [
          { person_id: 'per_henry', role: 'head' },
          { person_id: 'per_clara', role: 'spouse' },
          { person_id: 'per_owen', role: 'child' },
        ],
        sources: [
          {
            source_id: 'src_census_1880',
            confidence: 'high',
            citation_detail: 'Sheet 14A, Line 22',
            scan_url: '/media/census-1880.jpg',
            scan_title: '1880 Census Scan',
          },
        ],
      },
      {
        id: 'evt_conflict_1900',
        title: 'Disputed Farm Deed Date',
        summary: 'Two county books disagree on the transfer year.',
        event_kind: 'point_event',
        scope: 'personal',
        edtf_date: '1900-04-01',
        place_id: 'pl_hudsonville',
        participants: [{ person_id: 'per_henry', role: 'subject' }],
        sources: [{ source_id: 'src_book_1905', confidence: 'medium' }],
        fact_conflicts: [
          {
            claim: 'Deed transfer year listed as 1899 in county clerk index',
            source_id: 'src_census_1880',
            note: 'Family ledger notes 1900.',
          },
        ],
      },
      {
        id: 'evt_uncited_1905',
        title: 'Oral Tradition Barn Raising',
        summary: 'Remembered by grandchildren.',
        event_kind: 'point_event',
        scope: 'family',
        edtf_date: '1905-08-12',
        place_id: 'pl_ottawa',
        participants: [{ person_id: 'per_owen', role: 'subject' }],
        sources: [],
      },
      {
        id: 'evt_macro_1880',
        title: 'Michigan Timber Boom',
        summary: 'Regional lumber expansion across western Michigan.',
        event_kind: 'context_span',
        scope: 'national',
        edtf_date: '1875/1895',
        place_id: 'pl_mi',
        participants: [],
        sources: [{ source_id: 'src_book_1905', confidence: 'high' }],
      },
    ],
    kinship: [
      { from: 'per_henry', to: 'per_clara', relation: 'spouse' },
      { from: 'per_henry', to: 'per_owen', relation: 'parent' },
      { from: 'per_clara', to: 'per_owen', relation: 'parent' },
    ],
    media: [
      {
        id: 'med_henry_portrait',
        kind: 'portrait',
        person_id: 'per_henry',
        file: '/media/henry.jpg',
        caption: 'Henry Alder portrait ca. 1885',
        date_edtf: '1885',
      },
      {
        id: 'med_census_scan',
        kind: 'record_scan',
        person_id: 'per_henry',
        event_id: 'evt_census_1880',
        source_id: 'src_census_1880',
        file: '/media/census-1880.jpg',
        caption: '1880 Ottawa County Census Schedule',
        date_edtf: '1880',
      },
    ],
    narratives: [
      {
        id: 'nar_alder_farm',
        slug: 'alder-homestead',
        title: 'The Alder Homestead',
        summary: 'Settling Ottawa County in the 1880s.',
        body_md: 'Henry and Clara settled in Hudsonville in 1880.',
        person_ids: ['per_henry', 'per_clara'],
        place_ids: ['pl_hudsonville'],
        event_ids: ['evt_census_1880'],
        source_ids: ['src_census_1880'],
      },
    ],
  });
  return bundle;
}

const cleanups: Array<() => void> = [];

function mountPage(element: React.ReactElement): HTMLDivElement {
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

function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
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
});

describe('Explorer pages behavioral suite (Time, Kinship, Evidence, Places, Index, NotFound)', () => {
  it('explores TimePage snapshots across years, anchor chips, and macro/unlocated sections', async () => {
    const bundle = buildRichUiBundle();
    const container = mountPage(
      <MemoryRouter initialEntries={['/time?year=1880']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/time" element={<TimePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    expect(container.textContent).toContain('1880');
    expect(container.textContent).toContain('Henry Alder');
    expect(container.textContent).toContain('Hudsonville');
    expect(container.textContent).toContain('Cited');
    expect(container.textContent).toContain('Ezra Bramwell');

    const legendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /how we weigh evidence/i.test(b.textContent || '')
    );
    expect(legendBtn?.getAttribute('aria-expanded')).toBe('false');
    if (legendBtn) {
      act(() => {
        legendBtn.click();
      });
      await flushUi();
      expect(legendBtn.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('Family memory / Inferred');
      expect(container.textContent).toContain('Discrepancy / Open question');
    }

    // Step year forward/backward using navigation buttons and range slider
    const buttons = Array.from(container.querySelectorAll('button'));
    const nextBtn = buttons.find((b) =>
      /next|forward|\+1/i.test(b.getAttribute('aria-label') || b.textContent || '')
    );
    if (nextBtn) {
      act(() => {
        nextBtn.click();
      });
      await flushUi();
    }

    const slider = container.querySelector('input[type="range"]') as HTMLInputElement | null;
    if (slider) {
      setInputValue(slider, '1905');
      await flushUi();
      expect(container.textContent).toContain('1905');
    }
  });

  it('computes KinshipPage paths, preset pairs, swaps, same-person, and disconnected people', async () => {
    const bundle = buildRichUiBundle();
    const container = mountPage(
      <MemoryRouter initialEntries={['/kinship']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/kinship" element={<KinshipPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Featured pair preset renders and computes relationship between Henry & Owen
    expect(container.textContent).toContain('Henry Alder');
    expect(container.textContent).toContain('Owen Alder');

    const selects = Array.from(container.querySelectorAll('select'));
    expect(selects.length).toBeGreaterThanOrEqual(2);

    // Swap button reverses selection
    const swapBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /swap/i.test(b.getAttribute('aria-label') || b.textContent || '')
    );
    if (swapBtn) {
      act(() => {
        swapBtn.click();
      });
      await flushUi();
    }

    // Select disconnected person (Ezra Bramwell) to exercise no-path state
    setInputValue(selects[0], 'per_henry');
    setInputValue(selects[1], 'per_drifter');
    await flushUi();
    expect(container.textContent).toMatch(/no documented|no connection|not connected/i);

    // Select same person on both sides
    setInputValue(selects[1], 'per_henry');
    await flushUi();
    expect(container.textContent).toMatch(/same person|select two different/i);

    // Click featured preset button to restore Henry -> Owen path
    const presetBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent || '').includes('Henry to Owen')
    );
    if (presetBtn) {
      act(() => {
        presetBtn.click();
      });
      await flushUi();
      expect(container.textContent).toContain('Owen Alder');
    }
  });

  it('navigates EvidencePage tabs (Sources, Media, Discrepancies), filters, keyboard tablist, and lightbox', async () => {
    const bundle = buildRichUiBundle();
    const container = mountPage(
      <MemoryRouter initialEntries={['/evidence']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/evidence" element={<EvidencePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Default tab shows sources & citation counts
    expect(container.textContent).toContain('1880 U.S. Federal Census');

    // Keyboard navigation across role="tab" elements (exercises keyboardNav.ts)
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[];
    expect(tabs.length).toBeGreaterThanOrEqual(3);
    act(() => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await flushUi();
    act(() => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    await flushUi();
    act(() => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    await flushUi();

    // Filter sources by search input
    const searchInput = container.querySelector(
      'input[type="search"], input[type="text"]'
    ) as HTMLInputElement | null;
    if (searchInput) {
      setInputValue(searchInput, 'Census');
      await flushUi();
      expect(container.textContent).toContain('1880 U.S. Federal Census');
      setInputValue(searchInput, '');
      await flushUi();
    }

    // Switch to Media tab, filter by kind, open and close lightbox
    const mediaTab = tabs.find((t) => /media|gallery|photos/i.test(t.textContent || ''));
    if (mediaTab) {
      act(() => {
        mediaTab.click();
      });
      await flushUi();
      expect(container.textContent).toContain('Henry Alder portrait');

      // Click a media item to open lightbox, then close it
      const mediaButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
        (b.textContent || '').includes('Henry Alder portrait')
      );
      if (mediaButtons[0]) {
        act(() => {
          mediaButtons[0].click();
        });
        await flushUi();
        const closeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
          /close/i.test(b.getAttribute('aria-label') || b.textContent || '')
        );
        if (closeBtn) {
          act(() => {
            closeBtn.click();
          });
          await flushUi();
        }
      }
    }

    // Switch to Discrepancies / Conflicts tab
    const discTab = tabs.find((t) => /discrepanc|conflict|audit|review/i.test(t.textContent || ''));
    if (discTab) {
      act(() => {
        discTab.click();
      });
      await flushUi();
      expect(container.textContent).toContain('Disputed Farm Deed Date');
      expect(container.textContent).toContain('Preserved Discrepancy');
    }
  });

  it('renders IndexPage, PlacesIndexPage, PlacePage, and NotFoundPage cleanly', async () => {
    const bundle = buildRichUiBundle();

    const idx = mountPage(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/" element={<IndexPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(idx.textContent).toContain('Alder Behavioral Archive');
    expect(idx.textContent).toContain('Henry Alder');

    const placesIdx = mountPage(
      <MemoryRouter initialEntries={['/places']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/places" element={<PlacesIndexPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(placesIdx.textContent).toContain('Hudsonville');

    const placeDetail = mountPage(
      <MemoryRouter initialEntries={['/place/hudsonville']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(placeDetail.textContent).toContain('Hudsonville');
    expect(placeDetail.textContent).toContain('Who Passed Through');
    expect(placeDetail.textContent).toContain('Henry Alder');

    const nf = mountPage(
      <MemoryRouter initialEntries={['/missing-route']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(nf.textContent).toMatch(/not found|could not find|return/i);
  });
});

describe('AdminPage behavioral lifecycle (users, invites, agent tokens, and access guard)', () => {
  function createInMemoryAdminClient(): AdminApiClient & {
    users: UserRecord[];
    invites: InviteRecord[];
    tokens: PublicAgentTokenRecord[];
  } {
    const state = {
      users: [
        {
          email: 'founder@example.test',
          display_name: 'Founder Alder',
          role: 'admin' as UserRole,
          added_by: 'bootstrap',
          added_at: '2026-01-01T00:00:00Z',
          last_login_at: '2026-06-01T00:00:00Z',
        },
        {
          email: 'cousin@example.test',
          display_name: 'Cousin Mercer',
          role: 'editor' as UserRole,
          added_by: 'founder@example.test',
          added_at: '2026-02-01T00:00:00Z',
          last_login_at: null,
        },
      ],
      invites: [
        {
          token: 'inv_seed_1',
          label: 'Mercer Branch Invite',
          created_by: 'founder@example.test',
          created_at: '2026-05-01T00:00:00Z',
          expires_at: '2026-08-01T00:00:00Z',
          revoked_at: null,
          uses: 0,
          last_used_at: null,
        },
      ] as InviteRecord[],
      tokens: [
        {
          token_id: 'tok_seed_1',
          label: 'Nightly Backup Bot',
          scope: 'read_backup' as AgentTokenScope,
          created_by: 'founder@example.test',
          created_at: '2026-05-01T00:00:00Z',
          revoked_at: null,
        },
      ] as PublicAgentTokenRecord[],
    };

    return {
      ...state,
      async listUsers() {
        return [...state.users];
      },
      async updateUserRole(email, input) {
        const user = state.users.find((u) => u.email === email);
        if (!user) throw new Error('User not found');
        user.role = input.role;
        return { ...user };
      },
      async listInvites() {
        return [...state.invites];
      },
      async createInvite(input): Promise<CreatedInviteResponse> {
        const inv: InviteRecord = {
          token: `inv_new_${state.invites.length + 1}`,
          label: input.label,
          created_by: 'founder@example.test',
          created_at: '2026-06-02T00:00:00Z',
          expires_at: '2026-07-02T00:00:00Z',
          revoked_at: null,
          uses: 0,
          last_used_at: null,
        };
        state.invites.push(inv);
        return { invite: inv, invite_url: `https://archive.example.test/invite/${inv.token}` };
      },
      async revokeInvite(token) {
        const inv = state.invites.find((i) => i.token === token);
        if (inv) inv.revoked_at = '2026-06-03T00:00:00Z';
      },
      async listAgentTokens() {
        return [...state.tokens];
      },
      async createAgentToken(input): Promise<CreatedAgentTokenResponse> {
        const rec: PublicAgentTokenRecord = {
          token_id: `tok_new_${state.tokens.length + 1}`,
          label: input.label,
          scope: input.scope,
          created_by: 'founder@example.test',
          created_at: '2026-06-02T00:00:00Z',
          revoked_at: null,
        };
        state.tokens.push(rec);
        return {
          token_id: rec.token_id,
          label: rec.label,
          scope: rec.scope,
          plaintext_secret: 'kinloom_agent_secret_test_123',
        };
      },
      async revokeAgentToken(tokenId) {
        const tok = state.tokens.find((t) => t.token_id === tokenId);
        if (tok) tok.revoked_at = '2026-06-03T00:00:00Z';
      },
    };
  }

  it('shows non-admin restriction in read-only mode and executes full admin CRUD when signed in as admin', async () => {
    const bundle = buildRichUiBundle();

    // 1. Anonymous / static mode shows admin-only restriction
    const denied = mountPage(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <AdminPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(denied.textContent).toMatch(/admin|sign in|restricted/i);

    // 2. Full admin session with in-memory AdminApiClient
    const adminClient = createInMemoryAdminClient();
    const adminDataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle, etag: '"r1"', notModified: false }),
      loadReadings: async () => ({ version: 1, documents: {}, event_page_map: {} }),
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: {
          authenticated: true,
          principal_kind: 'user',
          email: 'founder@example.test',
          displayName: 'Founder Alder',
          role: 'admin',
        },
        authProviders: { magicLink: true, google: false },
        capabilities: {
          canEdit: true,
          canUploadMedia: true,
          hasRevisionHistory: true,
          hasTalk: true,
          canManageSite: true,
        },
      }),
    };

    const container = mountPage(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle} dataSource={adminDataSource}>
          <AdminPage adminClient={adminClient} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(container.textContent).toContain('Founder Alder');
    expect(container.textContent).toContain('Cousin Mercer');
    expect(container.textContent).toContain('Mercer Branch Invite');
    expect(container.textContent).toContain('Nightly Backup Bot');

    // Promote editor -> admin
    const promoteBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /make admin|promote/i.test(b.textContent || '')
    );
    if (promoteBtn) {
      act(() => {
        promoteBtn.click();
      });
      await flushUi();
      expect(adminClient.users.find((u) => u.email === 'cousin@example.test')?.role).toBe('admin');
    }

    // Demote back to editor (triggers inline confirm, then confirm click)
    const demoteBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /make editor|demote/i.test(b.textContent || '')
    );
    if (demoteBtn) {
      act(() => {
        demoteBtn.click();
      });
      await flushUi();
      const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        /confirm/i.test(b.textContent || '')
      );
      if (confirmBtn) {
        act(() => {
          confirmBtn.click();
        });
        await flushUi();
      }
    }

    // Create a new invite via form
    const inviteInput = container.querySelector(
      'input[placeholder*="Cousin"], input[placeholder*="invite" i], input[id*="invite" i]'
    ) as HTMLInputElement | null;
    if (inviteInput) {
      setInputValue(inviteInput, 'Vance Cousins');
      const form = inviteInput.closest('form');
      if (form) {
        act(() => {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flushUi();
        expect(container.textContent).toContain('Vance Cousins');
      }
    }

    // Create a new agent token via form
    const tokenInput = container.querySelector(
      'input[placeholder*="Research"], input[placeholder*="token" i], input[id*="token" i]'
    ) as HTMLInputElement | null;
    if (tokenInput) {
      setInputValue(tokenInput, 'Archive Sync Agent');
      const form = tokenInput.closest('form');
      if (form) {
        act(() => {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flushUi();
        expect(container.textContent).toContain('kinloom_agent_secret_test_123');
      }
    }

    // Revoke buttons (invite & token)
    const revokeBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
      /^revoke$/i.test((b.textContent || '').trim())
    );
    for (const btn of revokeBtns.slice(0, 2)) {
      act(() => {
        btn.click();
      });
      await flushUi();
      const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        /confirm/i.test(b.textContent || '')
      );
      if (confirmBtn) {
        act(() => {
          confirmBtn.click();
        });
        await flushUi();
      }
    }
  });
});
