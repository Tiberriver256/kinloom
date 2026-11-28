/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveDataSource,
  InviteRecord,
  KinloomSiteConfig,
  RevisionRecord,
  UserRecord,
} from '@kinloom/core';
import { asBatchId, asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import { createHttpWikiDataSource } from '../adapters/httpWikiDataSource.js';
import { SourceCitationTag } from '../components/atoms/SourceCitationTag.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { LocalSurveyMap } from '../components/LocalSurveyMap.js';
import { SourceInspectorDrawer } from '../components/SourceInspectorDrawer.js';
import { SourceReaderDrawer } from '../components/SourceReaderDrawer.js';
import { TreePersonSearch } from '../components/tree/TreePersonSearch.js';
import { CreateEntityModal } from '../components/wiki/CreateEntityModal.js';
import { EntityEditDrawer } from '../components/wiki/EntityEditDrawer.js';
import { MediaUploaderModal } from '../components/wiki/MediaUploaderModal.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { authSessionMachine, deriveSessionFromAuthSnapshot } from '../machines/authSessionMachine.js';
import { createNarrativeAudioPlugin } from '../plugins/narrativeAudioPlugin.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import { type AdminApiClient, AdminPage } from './AdminPage.js';
import { EvidenceMediaLightbox, EvidenceMediaTab } from './evidence/EvidenceMediaTab.js';
import { IndexPage } from './IndexPage.js';
import { PersonPage } from './PersonPage.js';
import { PlacePage } from './PlacePage.js';
import { PlacesIndexPage } from './PlacesIndexPage.js';
import { RecentChangesPage } from './RecentChangesPage.js';
import { TimePage } from './TimePage.js';
import { TreePage } from './TreePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => 'blob:kinloom-gedcom');
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = vi.fn();
}

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Chronicle Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_CHRONICLE',
  },
  branches: [{ id: 'alder', label: 'Alder Line' }],
  lineageSections: [
    {
      id: 'direct',
      title: 'Direct Line Ancestors',
      subtitle: 'Documented direct ancestors',
      lineageGroups: ['ancestor', 'pivot_ancestor'],
      branchId: 'alder',
    },
  ],
  pronunciations: {
    Henry: { phonetic: 'HEN-ree', ipa: '/ˈhɛn.ɹi/' },
    Alder: { phonetic: 'AHL-der', ipa: '/ˈɔːl.dɚ/' },
  },
  anchorYears: [
    { year: 1880, label: '1880' },
    { year: 1900, label: '1900' },
  ],
});

const TEN_MEDIA = Array.from({ length: 10 }, (_, idx) => ({
  id: `med_gal_${idx}`,
  kind: (idx === 0 ? 'portrait' : 'document_scan') as 'portrait' | 'document_scan',
  file: `/media/gal-${idx}.jpg`,
  caption: `Gallery Item ${idx}`,
  date_edtf: `${1880 + idx}`,
  person_ids: ['per_henry'],
  source_id: 'src_1880',
}));

const { bundle: ARCHIVE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  places: [
    {
      id: 'pl_hud',
      slug: 'hudsonville',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.87,
      lng: -85.86,
    },
    {
      id: 'pl_zee',
      slug: 'zeeland',
      name: 'Zeeland',
      full_name: 'Zeeland, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.81,
      lng: -86.01,
    },
  ],
  sources: [
    {
      id: 'src_1880',
      citation: '1880 Federal Census, Ottawa County',
      source_type: 'census',
      has_primary_source: true,
    },
  ],
  people: [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: ['Hendrik Alder'],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
      portrait_url: '/media/gal-0.jpg',
      pronunciation: { phonetic: 'HEN-ree AHL-der', note: 'Custom family note' },
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
      lineage_group: 'collateral',
      branch: 'alder',
      birth_edtf: '1858-07-22',
      death_edtf: '1938-04-09',
      portrait_url: null,
    },
    {
      id: 'per_infant',
      slug: 'thomas-alder-infant',
      full_name: 'Thomas Alder',
      given_name: 'Thomas',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'collateral',
      branch: 'alder',
      birth_edtf: '1883-02-01',
      death_edtf: '1884-06-15',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_1880',
      title: '1880 Homestead Enumeration',
      summary: 'Enumerated together in Hudsonville.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_hud',
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
      ],
      sources: [{ source_id: 'src_1880', confidence: 'high' }],
    },
    {
      id: 'evt_1900',
      title: '1900 Zeeland Household',
      summary: 'Residing in Zeeland.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1900-06-01',
      place_id: 'pl_zee',
      participants: [{ person_id: 'per_henry', role: 'head' }],
      sources: [{ source_id: 'src_1880', confidence: 'high' }],
    },
    {
      id: 'evt_world_1880',
      title: '1880 Michigan Rail Expansion',
      summary: 'Regional rail lines linked West Michigan towns.',
      event_kind: 'point_event',
      scope: 'national',
      edtf_date: '1880-04-01',
      place_id: null,
      participants: [],
      sources: [{ source_id: 'src_1880', confidence: 'high' }],
    },
    {
      id: 'evt_world_1880_b',
      title: '1880 Great Lakes Shipping Boom',
      summary: 'Lumber schooners peaked on Lake Michigan.',
      event_kind: 'point_event',
      scope: 'global',
      edtf_date: '1880-08-15',
      place_id: null,
      participants: [],
      sources: [{ source_id: 'src_1880', confidence: 'high' }],
    },
  ],
  kinship: [
    { from: 'per_henry', to: 'per_clara', relation: 'spouse' },
    { from: 'per_henry', to: 'per_infant', relation: 'parent' },
    { from: 'per_clara', to: 'per_infant', relation: 'parent' },
  ],
  media: TEN_MEDIA,
  narratives: [
    {
      id: 'nar_long',
      slug: 'henry-long-bio',
      kind: 'biography',
      subject_person_id: 'per_henry',
      title: 'Extended Biography of Henry Alder',
      summary: 'Documented life in Ottawa County.',
      body_md: `${'Henry Alder cleared timber and built a barn in Hudsonville [1]. '.repeat(14)}`,
      person_ids: ['per_henry'],
      place_ids: ['pl_hud'],
      event_ids: ['evt_1880'],
      source_ids: ['src_1880'],
    },
    {
      id: 'nar_story',
      slug: 'winter-crossing',
      kind: 'family_story',
      title: 'The Winter Sleigh Crossing',
      summary: 'Crossing the Grand River on ice.',
      body_md: 'Henry and Clara crossed on sleighs in January 1882.',
      person_ids: ['per_henry', 'per_clara'],
      place_ids: ['pl_hud'],
      event_ids: ['evt_1880'],
      source_ids: ['src_1880'],
    },
  ],
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

function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('UI >=90% behavioral completion suite across pages, drawers, and machines', () => {
  it('exercises TimePage milestone sheet, steppers, world ribbon, empty year fallback, IndexPage GEDCOM export, and PlacesIndexPage filters', async () => {
    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: ARCHIVE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => null,
    };

    // 1. TimePage
    const timeContainer = mountEl(
      <MemoryRouter initialEntries={['/time?year=1880']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={ds} initialBundle={ARCHIVE_BUNDLE}>
          <TimePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Expand/collapse Wider world macro ribbon
    const worldBtn = [...timeContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('1880 Michigan Rail Expansion')
    );
    expect(worldBtn).toBeTruthy();
    act(() => {
      worldBtn?.click();
    });
    expect(timeContainer.textContent).toContain('Hide');

    // Open milestone sheet, close via scrim, reopen and select 1900, step prev/next
    const jumpBtn = [...timeContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Jump to year')
    );
    act(() => {
      jumpBtn?.click();
    });
    act(() => {
      timeContainer
        .querySelector<HTMLButtonElement>('button[aria-label="Close milestone year picker"]')
        ?.click();
    });
    act(() => {
      jumpBtn?.click();
    });
    const anchor1900 = [...timeContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.getAttribute('aria-label')?.startsWith('1900:')
    );
    act(() => {
      anchor1900?.click();
    });
    const prevBtn = timeContainer.querySelector<HTMLButtonElement>(
      'button[aria-label^="Previous milestone"]'
    );
    act(() => {
      prevBtn?.click();
    });
    const nextBtn = timeContainer.querySelector<HTMLButtonElement>('button[aria-label^="Next milestone"]');
    act(() => {
      nextBtn?.click();
    });

    // Scrub range slider to 1810 (empty year) and click fallback milestone year button
    const rangeInput = timeContainer.querySelector<HTMLInputElement>('input[type="range"]');
    expect(rangeInput).toBeTruthy();
    if (rangeInput) {
      setFieldValue(rangeInput, '1810');
      const fallbackBtn = [...timeContainer.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === '1880'
      );
      act(() => {
        fallbackBtn?.click();
      });
    }

    // 2. IndexPage with configured lineageSections, search, media filter, clear, and GEDCOM export
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const indexContainer = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          capabilities={{ canEdit: true }}
        >
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(indexContainer.textContent).toContain('1850–1899');
    expect(indexContainer.textContent).not.toContain('Other relatives');

    const searchInput = indexContainer.querySelector<HTMLInputElement>('input[type="search"]');
    if (searchInput) {
      setFieldValue(searchInput, 'Hendrik');
      expect(indexContainer.textContent).toContain('Henry Alder');
    }
    const mediaFilterBtn = [...indexContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('With photos')
    );
    act(() => {
      mediaFilterBtn?.click();
    });
    const exportBtn = [...indexContainer.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) =>
        b.textContent?.toLowerCase().includes('gedcom') || b.textContent?.toLowerCase().includes('export')
    );
    act(() => {
      exportBtn?.click();
    });
    expect(clickSpy).toHaveBeenCalled();

    const clearBtn = [...indexContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Clear')
    );
    act(() => {
      clearBtn?.click();
    });

    // 3. PlacesIndexPage stage filter and search
    const placesContainer = mountEl(
      <MemoryRouter initialEntries={['/places']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={ds} initialBundle={ARCHIVE_BUNDLE}>
          <PlacesIndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const placeSearch = placesContainer.querySelector<HTMLInputElement>('input[type="search"]');
    if (placeSearch) {
      setFieldValue(placeSearch, 'Clara');
      setFieldValue(placeSearch, 'NoSuchTown');
      setFieldValue(placeSearch, '');
    }
    for (const pill of placesContainer.querySelectorAll<HTMLButtonElement>('button')) {
      if (pill.textContent && !pill.getAttribute('aria-label')) {
        act(() => {
          pill.click();
        });
      }
    }
  });

  it('exercises RecentChangesPage author tabs, diffs, single/batch reverts, and AdminPage confirmations & non-admin guard', async () => {
    const sampleRevisions: RevisionRecord[] = [
      {
        revision_id: asRevisionId(12),
        batch_id: asBatchId('bat_research_1'),
        entity_type: 'person',
        entity_id: 'per_henry',
        parent_revision_id: 11,
        action: 'update',
        reverted_revision_id: null,
        author_id: 'agent:cli',
        author_name: 'Kinloom Research CLI',
        author_type: 'agent',
        summary: 'Added 1900 census note',
        has_primary_source: true,
        before_json: { id: 'per_henry', full_name: 'Henry Alder' },
        after_json: { id: 'per_henry', full_name: 'Henry Alder', birth_edtf: '1855-03-14' },
        created_at: '2026-03-01T12:00:00Z',
      },
      {
        revision_id: asRevisionId(11),
        batch_id: null,
        entity_type: 'source',
        entity_id: 'src_1880',
        parent_revision_id: 10,
        action: 'update',
        reverted_revision_id: null,
        author_id: 'clara@example.test',
        author_name: 'Clara Mercer',
        author_type: 'human',
        summary: 'Refined 1880 citation',
        has_primary_source: true,
        before_json: { id: 'src_1880', citation: '1880 Census' },
        after_json: { id: 'src_1880', citation: '1880 Federal Census, Ottawa County' },
        created_at: '2026-02-28T10:00:00Z',
      },
    ];

    const revertRevMock = vi.fn(async () => ({
      revision: { ...sampleRevisions[1]!, revision_id: asRevisionId(13), action: 'revert' as const },
      head_revision_id: asRevisionId(13),
      etag: '"r13"',
    }));
    const revertBatchMock = vi.fn(async () => ({
      batch_id: asBatchId('bat_revert_1'),
      revisions: [{ ...sampleRevisions[0]!, revision_id: asRevisionId(14), action: 'revert' as const }],
      head_revision_id: asRevisionId(14),
      etag: '"r14"',
    }));

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: ARCHIVE_BUNDLE, etag: '"r12"', notModified: false }),
      loadReadings: async () => null,
      listRevisions: async () => ({ items: sampleRevisions, next_cursor: null }),
      revertRevision: revertRevMock,
      revertBatch: revertBatchMock,
    };

    const changesView = mountEl(
      <MemoryRouter initialEntries={['/changes']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          capabilities={{ canEdit: true, hasRevisionHistory: true }}
        >
          <RecentChangesPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Author tab keyboard navigation + click
    const tablist = changesView.querySelector('[role="tablist"]');
    act(() => {
      tablist?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      tablist?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    for (const tab of changesView.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      act(() => {
        tab.click();
      });
      await flushUi();
    }
    // Back to All Authors
    act(() => {
      changesView.querySelector<HTMLButtonElement>('[role="tab"]')?.click();
    });
    await flushUi();

    // View Diff / Hide Diff
    const diffBtn = [...changesView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('View Diff')
    );
    act(() => {
      diffBtn?.click();
    });
    act(() => {
      diffBtn?.click();
    });

    // Batch revert: open -> cancel -> open -> confirm
    const openBatchRevert = () =>
      [...changesView.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === 'Revert Entire Batch'
      );
    act(() => {
      openBatchRevert()?.click();
    });
    act(() => {
      [...changesView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Cancel')
        ?.click();
    });
    act(() => {
      openBatchRevert()?.click();
    });
    await act(async () => {
      [...changesView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Confirm Batch Revert')
        ?.click();
    });
    expect(revertBatchMock).toHaveBeenCalledOnce();

    // Single revision revert: open -> cancel -> open -> confirm
    const openRevRevert = () =>
      [...changesView.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === 'Revert'
      );
    act(() => {
      openRevRevert()?.click();
    });
    act(() => {
      [...changesView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Cancel')
        ?.click();
    });
    act(() => {
      openRevRevert()?.click();
    });
    await act(async () => {
      [...changesView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Confirm Revert')
        ?.click();
    });
    expect(revertRevMock).toHaveBeenCalledOnce();

    // AdminPage non-admin guard
    const nonAdminView = mountEl(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          capabilities={{ canManageSite: false }}
        >
          <AdminPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(nonAdminView.textContent).toContain('Administrator permissions are required');

    // AdminPage full confirm/cancel flows for demote, invite revoke, copy link, and token revoke
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
    const users: UserRecord[] = [
      {
        email: 'founder@example.test',
        display_name: 'Founder Alder',
        role: 'admin',
        added_by: 'system',
        added_at: '2026-01-01T00:00:00Z',
        last_login_at: null,
      },
      {
        email: 'coadmin@example.test',
        display_name: 'CoAdmin Alder',
        role: 'admin',
        added_by: 'founder@example.test',
        added_at: '2026-01-02T00:00:00Z',
        last_login_at: null,
      },
    ];
    const invites: InviteRecord[] = [
      {
        token: 'inv_active_1',
        label: 'Reunion Link',
        created_by: 'founder@example.test',
        created_at: '2026-01-03T00:00:00Z',
        expires_at: null,
        revoked_at: null,
        uses: 1,
        last_used_at: null,
      },
    ];
    const adminClient: AdminApiClient = {
      listUsers: vi.fn(async () => users),
      updateUserRole: vi.fn(async (email, { role }) => ({
        ...users[1]!,
        email,
        role,
      })),
      listInvites: vi.fn(async () => invites),
      createInvite: vi.fn(async ({ label }) => ({
        invite: { ...invites[0]!, token: 'inv_new', label },
        invite_url: 'https://example.test/invite/inv_new',
      })),
      revokeInvite: vi.fn(async () => undefined),
      listAgentTokens: vi.fn(async () => [
        {
          token_id: 'tok_active_1',
          label: 'Backup Key',
          scope: 'read_backup' as const,
          created_by: 'founder@example.test',
          created_at: '2026-01-04T00:00:00Z',
          revoked_at: null,
        },
      ]),
      createAgentToken: vi.fn(async ({ label, scope }) => ({
        token_id: 'tok_new_2',
        label,
        scope,
        created_by: 'founder@example.test',
        created_at: '2026-01-05T00:00:00Z',
        revoked_at: null,
        plaintext_secret: 'klm_secret_xyz',
      })),
      revokeAgentToken: vi.fn(async () => undefined),
    };

    const adminView = mountEl(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          session={{
            authenticated: true,
            principal_kind: 'user',
            email: 'founder@example.test',
            displayName: 'Founder Alder',
            role: 'admin',
          }}
          capabilities={{ canManageSite: true, canEdit: true }}
        >
          <AdminPage adminClient={adminClient} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Demote CoAdmin: open -> Cancel -> open -> Confirm Demote
    const clickByText = (txt: string) => {
      const btn = [...adminView.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => !b.disabled && b.textContent?.trim() === txt
      );
      act(() => {
        btn?.click();
      });
    };
    clickByText('Demote to Editor');
    clickByText('Cancel');
    clickByText('Demote to Editor');
    await act(async () => {
      [...adminView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Confirm Demote')
        ?.click();
    });
    expect(adminClient.updateUserRole).toHaveBeenCalledWith('coadmin@example.test', { role: 'editor' });

    // Copy Link + Revoke invite (open -> Cancel -> open -> Confirm Revoke)
    clickByText('Copy Link');
    const revokeBtns = () =>
      [...adminView.querySelectorAll<HTMLButtonElement>('button')].filter(
        (b) => b.textContent?.trim() === 'Revoke'
      );
    act(() => {
      revokeBtns()[0]?.click();
    });
    clickByText('Cancel');
    act(() => {
      revokeBtns()[0]?.click();
    });
    await act(async () => {
      [...adminView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Confirm Revoke')
        ?.click();
    });
    expect(adminClient.revokeInvite).toHaveBeenCalledWith('inv_active_1');

    // Revoke agent token (open -> Cancel -> open -> Confirm Revoke)
    act(() => {
      revokeBtns()[0]?.click();
    });
    clickByText('Cancel');
    act(() => {
      revokeBtns()[0]?.click();
    });
    await act(async () => {
      [...adminView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Confirm Revoke')
        ?.click();
    });
    expect(adminClient.revokeAgentToken).toHaveBeenCalledWith('tok_active_1');
  });

  it('exercises PersonPage gallery/portrait lightboxes, co-presence pivot, pronunciation shared-token & audio APIs, and TreePage RAF viewport motion', async () => {
    const httpAdapter = createHttpWikiDataSource({
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/pronunciations/') && init?.method === 'PUT') {
          return new Response(
            JSON.stringify({
              term: 'Henry',
              pronunciation: { phonetic: 'HEN-ree', ipa: '/ˈhɛn.ɹi/' },
              pronunciations: {
                Henry: { phonetic: 'HEN-ree', ipa: '/ˈhɛn.ɹi/' },
                Alder: { phonetic: 'AHL-dur', ipa: '/ˈɔːl.dɚ/' },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.includes('/api/pronunciation/generate')) {
          return new Response(JSON.stringify({ audio_url: '/media/audio/henry-alder.mp3' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }),
    });

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: ARCHIVE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => null,
      listRevisions: async () => ({ items: [], next_cursor: null }),
      listTalkComments: async () => [],
      loadPronunciations: (opts) => httpAdapter.loadPronunciations(opts),
      upsertPronunciationTerm: (term, entry, opts) => httpAdapter.upsertPronunciationTerm(term, entry, opts),
      generatePronunciationAudio: (input, opts) => httpAdapter.generatePronunciationAudio(input, opts),
    };

    const personContainer = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          capabilities={{ canEdit: true, canUploadMedia: true, hasRevisionHistory: true, hasTalk: true }}
        >
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Expand long biography & toggle sources; expand family story
    for (const label of ['Read full biography', 'Sources (1)', 'Read story', 'Show All 10']) {
      const btn = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(label)
      );
      act(() => {
        btn?.click();
      });
    }

    // Open media gallery card -> Prev / Next / ArrowRight / ArrowLeft / Close lightbox
    const firstMediaCard = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Gallery Item 0')
    );
    act(() => {
      firstMediaCard?.click();
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    act(() => {
      personContainer.querySelector<HTMLButtonElement>('button[aria-label="Close lightbox"]')?.click();
    });

    // Open pronunciation editor directly from PersonProfileHeader
    const editPronBtn = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.getAttribute('aria-label') ?? b.textContent ?? '').toLowerCase().includes('pronunciation')
    );
    act(() => {
      editPronBtn?.click();
    });
    await flushUi();

    // Clear personal override -> Use shared names
    const clearOverrideBtn = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Use shared names')
    );
    act(() => {
      clearOverrideBtn?.click();
    });

    // Open shared token editor for "Henry", update phonetic, and save to /api/pronunciations/Henry
    const tokenBtn = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes('Henry') && b.textContent?.includes('First')
    );
    act(() => {
      tokenBtn?.click();
    });
    const saveSharedBtn = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Save shared')
    );
    await act(async () => {
      saveSharedBtn?.click();
    });
    await flushUi();

    // Generate pronunciation audio via POST /api/pronunciation/generate
    const expandOverrideBtn = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.toLowerCase().includes('override')
    );
    act(() => {
      expandOverrideBtn?.click();
    });
    const genAudioBtn = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.toLowerCase().includes('generate')
    );
    await act(async () => {
      genAudioBtn?.click();
    });
    await flushUi();

    // Close dirty EntityEditDrawer (triggers dirty reset) then close cleanly
    const closeDrawerBtn = personContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Close edit drawer"]'
    );
    act(() => {
      closeDrawerBtn?.click();
    });
    act(() => {
      closeDrawerBtn?.click();
    });

    // Switch WikiActionBar tabs: History -> Talk -> Read
    for (const tabLabel of ['History', 'Talk', 'Read']) {
      const btn = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === tabLabel
      );
      act(() => {
        btn?.click();
      });
      await flushUi();
    }

    // Pivot to co-presence person Clara Mercer
    const claraPivotBtn = [...personContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Clara Mercer')
    );
    act(() => {
      claraPivotBtn?.click();
    });
    await flushUi();
    expect(personContainer.textContent).toContain('Clara Mercer');

    // TreePage with deterministic RAF stepping to exercise animateToTransform + centerDiagramOnPerson on early-loss chip
    let nowClock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowClock);
    const rafQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const drainRaf = (stepMs = 120) => {
      let guard = 0;
      while (rafQueue.length > 0 && guard < 10) {
        const batch = rafQueue.splice(0, rafQueue.length);
        nowClock += stepMs;
        act(() => {
          for (const cb of batch) {
            cb(nowClock);
          }
        });
        guard += 1;
      }
    };

    const treeContainer = mountEl(
      <MemoryRouter initialEntries={['/tree?person=thomas-alder-infant']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={ds} initialBundle={ARCHIVE_BUNDLE}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    drainRaf(140);

    for (const key of ['+', '-', '1', '0']) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
      drainRaf(120);
    }
    expect(treeContainer.querySelector('svg')).toBeTruthy();
  });

  it('exercises authSessionMachine invite hydration, magic-link cancel/error, URL error reset, and sign-out', async () => {
    let sessionKind: 'invite' | 'editor' = 'invite';
    let failMagicLink = true;
    const authDs = {
      getSession: async () =>
        sessionKind === 'editor'
          ? {
              session: {
                authenticated: true,
                principal_kind: 'user' as const,
                email: 'cousin@example.test',
                displayName: 'Cousin Alder',
                role: 'editor' as const,
              },
              capabilities: {
                canEdit: true,
                canUploadMedia: true,
                hasRevisionHistory: true,
                hasTalk: true,
                canManageSite: false,
              },
            }
          : {
              session: {
                authenticated: false,
                principal_kind: 'invite_viewer' as const,
                role: 'viewer' as const,
                inviteLabel: 'Reunion 2026',
              },
              capabilities: {
                canEdit: false,
                canUploadMedia: false,
                hasRevisionHistory: false,
                hasTalk: false,
                canManageSite: false,
              },
            },
      requestMagicLink: async () => {
        if (failMagicLink) {
          failMagicLink = false;
          throw new Error('This email is not enrolled in this family archive.');
        }
        return { sent: true };
      },
    } as unknown as ArchiveDataSource;

    const actor = createActor(authSessionMachine, {
      input: { initialInviteToken: 'inv_1', dataSource: authDs },
    });
    actor.start();
    await flushUi();

    const inviteDerived = deriveSessionFromAuthSnapshot(actor.getSnapshot());
    expect(inviteDerived.session.principal_kind).toBe('invite_viewer');

    // Magic-link error while holding a pending invite stays on readOnlyInvite with authError
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'cousin@example.test' });
    await flushUi();
    expect(actor.getSnapshot().matches('readOnlyInvite')).toBe(true);
    expect(actor.getSnapshot().context.authError).toContain('not enrolled');

    // Magic link request -> cancel -> request -> SET_URL_ERROR returns to readOnlyInvite -> refresh into editor
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'cousin@example.test' });
    await flushUi();
    expect(actor.getSnapshot().matches('awaitingMagicLinkClick')).toBe(true);
    actor.send({ type: 'CANCEL_MAGIC_LINK' });
    expect(actor.getSnapshot().matches('readOnlyInvite')).toBe(true);
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'cousin@example.test' });
    await flushUi();
    actor.send({ type: 'SET_URL_ERROR', urlError: { code: 'INVITE_REVOKED', provider: 'invite' } });
    expect(actor.getSnapshot().matches('readOnlyInvite')).toBe(true);

    sessionKind = 'editor';
    actor.send({ type: 'REFRESH_SESSION' });
    await flushUi();
    expect(actor.getSnapshot().matches({ authenticated: 'editor' })).toBe(true);
    expect(deriveSessionFromAuthSnapshot(actor.getSnapshot()).capabilities.canEdit).toBe(true);

    actor.send({ type: 'SIGN_OUT' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);
    actor.stop();
  });

  it('exercises EntityEditDrawer conflict/network/saved/leave banners, CreateEntityModal all 4 tabs, SourceCitationTag & SourceReaderDrawer scan zoom, and PersonPage/PlacePage actions', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    let updatePhase: 'conflict' | 'network' | 'ok' = 'conflict';
    const basePlace = {
      id: 'pl_hud',
      slug: 'hudsonville',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Ottawa County, Michigan, USA',
      place_type: 'town' as const,
      parent_id: null,
      lat: 42.87,
      lng: -85.86,
    };

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: ARCHIVE_BUNDLE, etag: '"r5"', notModified: false }),
      loadReadings: async () => ({
        version: 1,
        event_page_map: { evt_1880: { src_1880: 2 } },
        documents: {
          src_1880: {
            source_id: 'src_1880',
            title: '1880 Census Schedule',
            author: 'US Census Bureau',
            provenance: 'NARA',
            pdf_url: '/scans/1880-census.pdf',
            pdf_size_bytes: 204800,
            pages: [
              {
                page: 1,
                label: 'Sheet 1',
                file: 's1.txt',
                text: 'Georgetown household one',
                image_url: '/scans/p1.jpg',
              },
              {
                page: 2,
                label: 'Sheet 2',
                file: 's2.txt',
                text: 'Henry Alder farmstead entry',
                image_url: '/scans/p2.jpg',
              },
            ],
          },
          src_1900: {
            source_id: 'src_1900',
            title: '1900 Zeeland Roll',
            author: 'US Census Bureau',
            provenance: 'NARA',
            pages: [{ page: 1, label: 'Page 1', file: 'z1.txt', text: 'Zeeland township entry' }],
          },
        },
      }),
      updateEntity: async (_type, id, input) => {
        if (updatePhase === 'conflict') {
          return {
            ok: false,
            conflict: {
              kind: 'conflict',
              entity_type: 'place',
              entity_id: id,
              expected_parent_revision_id: asRevisionId(1),
              server_revision_id: asRevisionId(2),
              server_entity: { ...basePlace, name: 'Hudsonville Village' },
              server_deleted_at: null,
              last_author_name: 'Clara Mercer',
              last_updated_at: '2026-03-01T10:00:00Z',
              diff: {
                fields: [
                  { path: 'name', kind: 'changed', before: 'Hudsonville', after: 'Hudsonville Village' },
                ],
                addedCount: 0,
                removedCount: 0,
                changedCount: 1,
                hasChanges: true,
              },
            },
          };
        }
        if (updatePhase === 'network') {
          throw new Error('Transient offline timeout');
        }
        return {
          ok: true,
          entity: input.data,
          revision: {
            revision_id: asRevisionId(3),
            batch_id: null,
            entity_type: 'place',
            entity_id: id,
            parent_revision_id: 2,
            action: 'update',
            reverted_revision_id: null,
            author_id: 'editor@example.test',
            author_name: 'Clara Mercer',
            author_type: 'human',
            summary: input.summary,
            has_primary_source: true,
            before_json: basePlace,
            after_json: input.data,
            created_at: '2026-03-02T10:00:00Z',
          },
          etag: '"r3"',
        };
      },
      createEntity: async (_type, input) => ({
        entity_id: String((input.data as { id?: string }).id ?? 'new_1'),
        entity: input.data,
        revision: {
          revision_id: asRevisionId(4),
          batch_id: null,
          entity_type: 'person',
          entity_id: 'new_1',
          parent_revision_id: 3,
          action: 'create',
          reverted_revision_id: null,
          author_id: 'editor@example.test',
          author_name: 'Clara Mercer',
          author_type: 'human',
          summary: input.summary,
          has_primary_source: true,
          before_json: null,
          after_json: input.data,
          created_at: '2026-03-02T11:00:00Z',
        },
        etag: '"r4"',
      }),
      deleteEntity: async () => ({
        revision: {
          revision_id: asRevisionId(5),
          batch_id: null,
          entity_type: 'place',
          entity_id: 'pl_hud',
          parent_revision_id: 4,
          action: 'delete',
          reverted_revision_id: null,
          author_id: 'editor@example.test',
          author_name: 'Clara Mercer',
          author_type: 'human',
          summary: 'Delete',
          has_primary_source: true,
          before_json: basePlace,
          after_json: null,
          created_at: '2026-03-02T12:00:00Z',
        },
        etag: '"r5"',
      }),
      listRevisions: async () => ({ items: [], next_cursor: null }),
      listTalkComments: async () => [],
    };

    // 1. EntityEditDrawer status banners: conflict409 -> Rebase & Review, Rebase & Save -> network error -> Back to Editor -> Retry Save -> Saved -> Edit Again -> Saved -> Done; citation radios + source select + danger zone cancel
    const onCloseDrawer = vi.fn();
    const drawerView = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          capabilities={{ canEdit: true }}
        >
          <EntityEditDrawer
            open
            entityType="place"
            entityId="pl_hud"
            revisionId={1}
            initialData={basePlace}
            title="Hudsonville"
            onClose={onCloseDrawer}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const clickDrawerBtn = (label: string) => {
      const btn = [...drawerView.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => !b.disabled && b.textContent?.includes(label)
      );
      act(() => {
        btn?.click();
      });
    };

    // Toggle citation radios and source select
    const radios = drawerView.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    act(() => {
      radios[1]?.click();
    });
    act(() => {
      radios[0]?.click();
    });
    const sourceSelect = [...drawerView.querySelectorAll<HTMLSelectElement>('select')].find((s) =>
      s.textContent?.includes('Select archived source')
    );
    if (sourceSelect) {
      setFieldValue(sourceSelect, 'src_1880');
    }

    // Danger zone open -> cancel
    clickDrawerBtn('Remove from Archive');
    const cancelDanger = [...drawerView.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Cancel'
    );
    act(() => {
      cancelDanger?.click();
    });

    // Edit short name + summary -> submit -> conflict409
    const textInputs = drawerView.querySelectorAll<HTMLInputElement>('input[type="text"]');
    if (textInputs[0]) {
      setFieldValue(textInputs[0], 'Hudsonville Depot');
    }
    const summaryInput = [...textInputs].find((inp) => inp.placeholder.includes('Corrected'));
    if (summaryInput) {
      setFieldValue(summaryInput, 'Updated short name from railroad map');
    }
    const form = drawerView.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();

    // Conflict: Rebase & Review in Editor -> submit again -> Conflict -> Rebase & Save Again (with network error)
    clickDrawerBtn('Rebase & Review in Editor');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();

    updatePhase = 'network';
    await act(async () => {
      const btn = [...drawerView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Rebase & Save Again')
      );
      btn?.click();
    });
    await flushUi();

    // Network error: Back to Editor -> submit -> Network error -> Retry Save (now ok -> saved)
    clickDrawerBtn('Back to Editor');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();

    updatePhase = 'ok';
    await act(async () => {
      const btn = [...drawerView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Retry Save')
      );
      btn?.click();
    });
    await flushUi();

    // Saved banner: Edit Again -> edit -> submit -> Saved -> Done
    clickDrawerBtn('Edit Again');
    if (textInputs[0]) {
      setFieldValue(textInputs[0], 'Hudsonville Station');
    }
    if (summaryInput) {
      setFieldValue(summaryInput, 'Second refinement');
    }
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();
    clickDrawerBtn('Done');

    // Also exercise Accept Server Version & Discard Draft on fresh conflict instances
    updatePhase = 'conflict';
    for (const actionLabel of ['Accept Server Version', 'Discard Draft']) {
      const subView = mountEl(
        <MemoryRouter>
          <ArchiveProvider
            siteConfig={SITE_CONFIG}
            dataSource={ds}
            initialBundle={ARCHIVE_BUNDLE}
            capabilities={{ canEdit: true }}
          >
            <EntityEditDrawer
              open
              entityType="place"
              entityId="pl_hud"
              revisionId={1}
              initialData={basePlace}
              onClose={() => {}}
            />
          </ArchiveProvider>
        </MemoryRouter>
      );
      await flushUi();
      const subInputs = subView.querySelectorAll<HTMLInputElement>('input[type="text"]');
      if (subInputs[0]) setFieldValue(subInputs[0], `Variant ${actionLabel}`);
      const subSum = [...subInputs].find((inp) => inp.placeholder.includes('Corrected'));
      if (subSum) setFieldValue(subSum, 'Trigger conflict');
      await act(async () => {
        subView
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushUi();
      act(() => {
        [...subView.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent?.includes(actionLabel))
          ?.click();
      });
    }

    // 2. CreateEntityModal across all 4 tabs (Person, Event, Place, Family Link) exercising every field handler
    const createView = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          capabilities={{ canEdit: true }}
        >
          <CreateEntityModal open onClose={() => {}} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Person tab fields
    const personInputs = createView.querySelectorAll<HTMLInputElement>('input[type="text"]');
    if (personInputs[0]) setFieldValue(personInputs[0], 'Walter');
    if (personInputs[1]) setFieldValue(personInputs[1], 'Alder');
    if (personInputs[2]) setFieldValue(personInputs[2], '1878');
    if (personInputs[3]) setFieldValue(personInputs[3], '1944');
    const personSelects = createView.querySelectorAll<HTMLSelectElement>('select');
    if (personSelects[0]) setFieldValue(personSelects[0], 'M');
    if (personSelects[1]) setFieldValue(personSelects[1], 'collateral');
    const livingCb = createView.querySelector<HTMLInputElement>('input[type="checkbox"]');
    act(() => {
      livingCb?.click();
    });

    // Event tab fields
    const switchCreateTab = (label: string) => {
      const tab = [...createView.querySelectorAll<HTMLButtonElement>('[role="tab"], button')].find(
        (b) => b.textContent?.trim() === label
      );
      act(() => {
        tab?.click();
      });
    };
    switchCreateTab('Event');
    const eventInputs = createView.querySelectorAll<HTMLInputElement>('input[type="text"]');
    if (eventInputs[0]) setFieldValue(eventInputs[0], '1888 Timber Harvest');
    if (eventInputs[1]) setFieldValue(eventInputs[1], '1888-10');
    const eventSelects = createView.querySelectorAll<HTMLSelectElement>('select');
    if (eventSelects[0]) setFieldValue(eventSelects[0], 'per_henry');
    if (eventSelects[1]) setFieldValue(eventSelects[1], 'pl_hud');
    const eventSummary = createView.querySelector<HTMLTextAreaElement>('textarea');
    if (eventSummary) setFieldValue(eventSummary, 'Cleared forty acres.');

    // Place tab fields
    switchCreateTab('Place');
    const placeInputs = createView.querySelectorAll<HTMLInputElement>('input');
    if (placeInputs[0]) setFieldValue(placeInputs[0], 'Blendon');
    if (placeInputs[1]) setFieldValue(placeInputs[1], 'Blendon Township, Ottawa, Michigan, USA');
    if (placeInputs[2]) setFieldValue(placeInputs[2], '42.91');
    if (placeInputs[3]) setFieldValue(placeInputs[3], '-85.94');

    // Family Link tab fields
    switchCreateTab('Family Link');
    const kinSelects = createView.querySelectorAll<HTMLSelectElement>('select');
    if (kinSelects[0]) setFieldValue(kinSelects[0], 'per_henry');
    if (kinSelects[1]) setFieldValue(kinSelects[1], 'spouse');
    if (kinSelects[2]) setFieldValue(kinSelects[2], 'per_clara');

    // 3. SourceCitationTag + SourceReaderDrawer + SourceInspectorDrawer full actions
    const sourcesMap = new Map(
      ARCHIVE_BUNDLE.sources.map((s) => [s.id, { ...s, url: 'https://example.test/nara' }])
    );
    const citView = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          initialReadings={await ds.loadReadings()}
        >
          <SourceCitationTag
            eventId="evt_1880"
            sourcesById={sourcesMap}
            sources={[
              {
                source_id: 'src_1880',
                confidence: 'high',
                citation_detail: 'ED 12, Sheet 4',
                scan_url: '/scans/p1.jpg',
                scan_title: '1880 Schedule Scan',
              },
            ]}
            alternateDates={[{ edtf_date: '1881', source_id: 'src_1880', note: 'County index year' }]}
            alternatePlaces={[{ place_name: 'Georgetown', source_id: 'src_1880', note: 'Township listing' }]}
            factConflicts={[
              { claim: 'Age listed as 26', source_id: 'src_1880', note: 'Enumerator rounding' },
            ]}
          />
          <SourceInspectorDrawer />
          <SourceReaderDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Open top-level scan lightbox & close via Close [Esc]
    const viewScanBtn = [...citView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Scan')
    );
    act(() => {
      viewScanBtn?.click();
    });
    act(() => {
      [...citView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.includes('Close [Esc]'))
        ?.click();
    });

    // Expand SourceCitationTag and click Inspect, Copy, Scan ↗, discrepancy buttons, and Read Text ↗
    act(() => {
      citView.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click();
    });
    for (const label of ['Copy', 'Inspect Source', '1880 Federal Census']) {
      const btn = [...citView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(label)
      );
      act(() => {
        btn?.click();
      });
    }
    const cardScanBtn = [...citView.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Scan ↗'
    );
    act(() => {
      cardScanBtn?.click();
    });
    act(() => {
      citView.querySelector<HTMLButtonElement>('button[aria-label="Close record scan lightbox"]')?.click();
    });

    // Open SourceReaderDrawer via Read Text ↗
    const readTextBtn = [...citView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Read Text')
    );
    act(() => {
      readTextBtn?.click();
    });
    await flushUi();

    // Switch view modes: Side-by-Side -> Zoom Full Page ↗ -> close -> Original Scan -> Text
    for (const modeLabel of ['Side-by-Side', 'Zoom Full Page']) {
      const btn = [...citView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(modeLabel)
      );
      act(() => {
        btn?.click();
      });
    }
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    for (const modeLabel of ['Original Scan', 'Text', 'Download Text', 'Copy All Text']) {
      const btn = [...citView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(modeLabel)
      );
      await act(async () => {
        btn?.click();
      });
    }

    // Pager Prev/Next, page select, search jump, collection tab keyboard
    const pageSelect = citView.querySelector<HTMLSelectElement>(
      'select[aria-label="Select transcription page"]'
    );
    if (pageSelect) {
      setFieldValue(pageSelect, '0');
    }
    act(() => {
      citView.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')?.click();
      citView.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')?.click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    const readerSearch = citView.querySelector<HTMLInputElement>(
      'input[aria-label="Search within primary source transcription"]'
    );
    if (readerSearch) {
      setFieldValue(readerSearch, 'farmstead');
      const matchBtn = [...citView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('p. 2')
      );
      act(() => {
        matchBtn?.click();
      });
    }
    const collectionTabs = citView.querySelector('[aria-label="Source collections"]');
    act(() => {
      collectionTabs?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    // 4. PersonPage portrait click + Export GEDCOM + Upload Media + Add Relative, and PlacePage Edit/History/Talk tabs
    const personExtra = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          capabilities={{ canEdit: true, canUploadMedia: true, hasRevisionHistory: true, hasTalk: true }}
        >
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    for (const label of ['GEDCOM', 'Upload', 'Relative']) {
      const btn = [...personExtra.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        (b.getAttribute('aria-label') ?? b.textContent ?? '').includes(label)
      );
      act(() => {
        btn?.click();
      });
    }

    const placeExtra = mountEl(
      <MemoryRouter initialEntries={['/place/hudsonville']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={ARCHIVE_BUNDLE}
          capabilities={{ canEdit: true, hasRevisionHistory: true, hasTalk: true }}
        >
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    for (const tabLabel of ['History', 'Talk', 'Edit']) {
      const btn = [...placeExtra.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === tabLabel
      );
      act(() => {
        btn?.click();
      });
      await flushUi();
    }
  });

  it('completes >=90% behavioral coverage across authSessionMachine port flows, NarrativeAudioDock, IndexPage, PlacePage, and PersonPage callbacks', async () => {
    // 1. authSessionMachine port-backed flows across editor/admin/invite/error/signOut paths
    let meMode: 'editor' | 'admin' | 'invite' | 'empty' | '500' = 'editor';
    let magicReqOk = false;

    const defaultCaps = {
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: false,
      hasTalk: false,
      canManageSite: false,
    };

    const authDs = {
      getSession: async () => {
        if (meMode === '500') {
          throw new Error('HTTP 500');
        }
        if (meMode === 'empty') {
          return {
            session: { authenticated: false, principal_kind: 'anonymous' as const },
            capabilities: defaultCaps,
          };
        }
        if (meMode === 'invite') {
          return {
            session: {
              authenticated: false,
              principal_kind: 'invite_viewer' as const,
              inviteLabel: 'Alder Reunion',
            },
            capabilities: defaultCaps,
          };
        }
        if (meMode === 'admin') {
          return {
            session: {
              authenticated: true,
              principal_kind: 'user' as const,
              email: 'admin@example.test',
              displayName: 'Henry Alder',
              role: 'admin' as const,
            },
            capabilities: { ...defaultCaps, canEdit: true, canManageSite: true },
          };
        }
        return {
          session: {
            authenticated: true,
            principal_kind: 'user' as const,
            email: 'editor@example.test',
            displayName: 'Clara Mercer',
            role: 'editor' as const,
          },
          capabilities: { ...defaultCaps, canEdit: true },
        };
      },
      requestMagicLink: async () => {
        if (!magicReqOk) {
          throw new Error('HTTP 500');
        }
        return { sent: true };
      },
      logout: async () => {
        meMode = 'empty';
      },
    } as unknown as ArchiveDataSource;

    const actor1 = createActor(authSessionMachine, { input: { dataSource: authDs } });
    actor1.start();
    await flushUi();
    expect(deriveSessionFromAuthSnapshot(actor1.getSnapshot()).session.role).toBe('editor');

    meMode = 'invite';
    actor1.send({ type: 'REFRESH_SESSION' });
    await flushUi();
    expect(deriveSessionFromAuthSnapshot(actor1.getSnapshot()).session.principal_kind).toBe('invite_viewer');

    meMode = 'admin';
    actor1.send({ type: 'REFRESH_SESSION' });
    await flushUi();
    expect(deriveSessionFromAuthSnapshot(actor1.getSnapshot()).session.role).toBe('admin');

    actor1.send({ type: 'SIGN_OUT' });
    await flushUi();
    expect(deriveSessionFromAuthSnapshot(actor1.getSnapshot()).session.principal_kind).toBe('anonymous');

    actor1.send({ type: 'REQUEST_MAGIC_LINK', email: 'editor@example.test' });
    await flushUi();
    magicReqOk = true;
    actor1.send({ type: 'REQUEST_MAGIC_LINK', email: 'editor@example.test' });
    await flushUi();
    actor1.send({ type: 'RESEND_MAGIC_LINK', email: 'editor@example.test' });
    await flushUi();
    actor1.send({ type: 'CANCEL_MAGIC_LINK' });
    expect(actor1.getSnapshot().matches('anonymous')).toBe(true);
    actor1.stop();

    meMode = '500';
    const actor2 = createActor(authSessionMachine, { input: { dataSource: authDs } });
    actor2.start();
    await flushUi();
    expect(actor2.getSnapshot().matches('anonymous')).toBe(true);
    actor2.stop();

    // 2. Enriched bundle for NarrativeAudioDock, PersonPage, PlacePage, and IndexPage callbacks
    const { bundle: audioBundle }: { bundle: ArchiveBundle } = compileArchive({
      siteConfig: SITE_CONFIG,
      mode: 'public',
      people: [
        {
          id: 'per_henry',
          slug: 'henry-alder',
          full_name: 'Henry Alder',
          given_name: 'Henry',
          surname: 'Alder',
          alt_names: ['Hendrik Alder'],
          sex: 'M',
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '1852',
          death_edtf: '1924',
          is_living: false,
          portrait_url: '/media/henry-portrait.jpg',
        },
        {
          id: 'per_clara',
          slug: 'clara-mercer',
          full_name: 'Clara Mercer',
          given_name: 'Clara',
          surname: 'Mercer',
          alt_names: [],
          sex: 'F',
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '1856',
          death_edtf: '1931',
          is_living: false,
          portrait_url: null,
        },
      ],
      places: [
        {
          id: 'pl_ottawa',
          slug: 'ottawa-county',
          name: 'Ottawa County',
          full_name: 'Ottawa County, Michigan, USA',
          place_type: 'county',
          parent_id: null,
          lat: 42.95,
          lng: -86.0,
        },
        {
          id: 'pl_hud',
          slug: 'hudsonville',
          name: 'Hudsonville',
          full_name: 'Hudsonville, Ottawa County, Michigan, USA',
          place_type: 'town',
          parent_id: 'pl_ottawa',
          lat: 42.87,
          lng: -85.86,
          summary: 'Rail depot and market town.',
          photo_url: '/media/hudsonville.jpg',
          photo_caption: 'Depot view',
          historical_names: [{ name: 'Georgetown Station', valid_from: '1872', valid_to: '1880' }],
        },
      ],
      sources: [
        {
          id: 'src_1880',
          citation: '1880 Federal Census, Ottawa County',
          source_type: 'census',
          has_primary_source: true,
        },
      ],
      events: [
        {
          id: 'evt_h1',
          edtf_date: '1880-06',
          place_id: 'pl_hud',
          event_kind: 'residence_anchor',
          scope: 'personal',
          category: 'residence',
          title: 'Settled in Hudsonville',
          summary: 'Henry and Clara farmed in Hudsonville.',
          participants: [
            { person_id: 'per_henry', role: 'head' },
            { person_id: 'per_clara', role: 'spouse' },
          ],
          sources: [{ source_id: 'src_1880', confidence: 'high' }],
        },
        {
          id: 'evt_local_1885',
          edtf_date: '1885',
          place_id: 'pl_hud',
          event_kind: 'point_event',
          scope: 'local',
          category: 'civic',
          title: 'Township Grain Elevator Built',
          summary: 'Local cooperative grain elevator erected near depot.',
          source_url: 'https://example.test/elevator',
          participants: [],
          sources: [{ source_id: 'src_1880', confidence: 'high' }],
        },
      ],
      kinship: [{ from: 'per_henry', to: 'per_clara', relation: 'spouse' }],
      media: [
        {
          id: 'med_1',
          kind: 'portrait',
          file: '/media/henry-portrait.jpg',
          caption: 'Henry Alder portrait',
          person_ids: ['per_henry'],
          source_id: 'src_1880',
        },
        {
          id: 'med_2',
          kind: 'document_scan',
          file: '/media/deed-1880.jpg',
          caption: 'Homestead deed',
          person_ids: ['per_henry'],
          source_id: 'src_1880',
        },
      ],
      narratives: [
        {
          id: 'nar_bio_1',
          slug: 'life-grand-river',
          kind: 'biography',
          subject_person_id: 'per_henry',
          title: 'Life on the Grand River',
          body_md: `${'Henry Alder cultivated orchards and timber along the township road. '.repeat(18)}[1]`,
          person_ids: ['per_henry'],
          place_ids: ['pl_hud'],
          event_ids: ['evt_h1'],
          source_ids: ['src_1880'],
          extensions: {
            narrative_audio: {
              file: '/audio/henry-bio.mp3',
              duration_seconds: 120,
              editor_notes_start_seconds: 60,
              story_voice: 'Charon',
              notes_voice: 'Kore',
            },
          },
        },
        {
          id: 'nar_bio_2',
          slug: 'later-years-ottawa',
          kind: 'biography',
          subject_person_id: 'per_henry',
          title: 'Later Years in Ottawa County',
          body_md: 'Second biographical chapter.',
          person_ids: ['per_henry'],
          place_ids: ['pl_hud'],
          event_ids: ['evt_h1'],
          source_ids: ['src_1880'],
        },
        {
          id: 'nar_bio_3',
          slug: 'civic-service',
          kind: 'biography',
          subject_person_id: 'per_henry',
          title: 'Civic Service',
          body_md: 'Third biographical chapter.',
          person_ids: ['per_henry'],
          place_ids: ['pl_hud'],
          event_ids: ['evt_h1'],
          source_ids: ['src_1880'],
        },
        {
          id: 'nar_story_1',
          slug: 'winter-sleigh-1',
          kind: 'family_story',
          title: 'Winter Sleigh Crossing',
          body_md: 'Family story text [1].',
          person_ids: ['per_henry', 'per_clara'],
          place_ids: ['pl_hud'],
          event_ids: ['evt_h1'],
          source_ids: ['src_1880'],
        },
        {
          id: 'nar_story_2',
          slug: 'harvest-barn-2',
          kind: 'family_story',
          title: 'Harvest Barn Raising',
          body_md: 'Second family story.',
          person_ids: ['per_henry'],
          place_ids: ['pl_hud'],
          event_ids: ['evt_h1'],
          source_ids: ['src_1880'],
        },
        {
          id: 'nar_story_3',
          slug: 'orchard-grafting-3',
          kind: 'family_story',
          title: 'Orchard Grafting',
          body_md: 'Third family story.',
          person_ids: ['per_henry'],
          place_ids: ['pl_hud'],
          event_ids: ['evt_h1'],
          source_ids: ['src_1880'],
        },
      ],
    });

    const audioPlugin = createNarrativeAudioPlugin();
    const audioView = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          initialBundle={audioBundle}
          plugins={[audioPlugin]}
          capabilities={{ canEdit: true, canUploadMedia: true, hasRevisionHistory: true, hasTalk: true }}
        >
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
          <PluginSlot name="appShell" />
          <SourceInspectorDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Start narration -> fire audio events -> range scrub -> cycle speed -> jump notes -> dock skip/pause/notes/dismiss
    act(() => {
      audioView
        .querySelector<HTMLButtonElement>('button[aria-label="Listen to Life on the Grand River"]')
        ?.click();
    });
    const audioEl = audioView.querySelector<HTMLAudioElement>('audio');
    if (audioEl) {
      Object.defineProperty(audioEl, 'duration', { value: 130, configurable: true });
      Object.defineProperty(audioEl, 'currentTime', { value: 75, writable: true, configurable: true });
      act(() => {
        audioEl.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
        audioEl.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      });
    }
    const seekInput = audioView.querySelector<HTMLInputElement>(
      'input[aria-label="Seek position for Life on the Grand River"]'
    );
    if (seekInput) {
      setFieldValue(seekInput, '80');
    }
    for (const label of [
      'Playback speed',
      '↩ Story',
      "Editor's notes",
      'Rewind 15 seconds',
      'Forward 15 seconds',
      'Pause narration',
      'Resume narration',
      'Notes',
    ]) {
      const btn = [...audioView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        (b.getAttribute('aria-label') ?? b.textContent ?? '').includes(label)
      );
      act(() => {
        btn?.click();
      });
    }
    if (audioEl) {
      act(() => {
        audioEl.dispatchEvent(new Event('ended', { bubbles: true }));
      });
    }
    act(() => {
      audioView.querySelector<HTMLButtonElement>('button[aria-label="Close audio player"]')?.click();
    });

    // PersonPage portrait lightbox, show-all narratives/stories, expand body & sources, edit pronunciation, timeline edit, modal closes, and slug change via spouse link
    act(() => {
      audioView.querySelector<HTMLButtonElement>('button[aria-label*="portrait" i]')?.click();
    });
    for (const textFrag of ['Show all', 'Read full', 'Sources', 'pronunciation']) {
      for (const btn of [...audioView.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
        (b.getAttribute('aria-label') ?? b.textContent ?? '').toLowerCase().includes(textFrag.toLowerCase())
      )) {
        act(() => {
          btn.click();
        });
      }
    }
    // Navigate to Clara Mercer via link to exercise slug reset branch in PersonPage
    const claraLink = [...audioView.querySelectorAll<HTMLAnchorElement>('a')].find((a) =>
      a.getAttribute('href')?.includes('/person/clara-mercer')
    );
    act(() => {
      claraLink?.click();
    });
    await flushUi();

    // PlacePage scope buttons, decade filter buttons, Add pronunciation -> close drawer, and error Try again
    const placeView = mountEl(
      <MemoryRouter initialEntries={['/place/hudsonville']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          initialBundle={audioBundle}
          capabilities={{ canEdit: true }}
        >
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    for (const label of [
      'Exact Place',
      'Historical County',
      '15-Mile Radius',
      '1880s',
      'All Decades',
      'pronunciation',
    ]) {
      const btn = [...placeView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        (b.getAttribute('aria-label') ?? b.textContent ?? '').toLowerCase().includes(label.toLowerCase())
      );
      act(() => {
        btn?.click();
      });
    }
    act(() => {
      placeView.querySelector<HTMLButtonElement>('button[aria-label="Close editor"]')?.click();
    });

    // IndexPage search no-match -> Clear filters, media filter -> Clear, + Add Person -> close modal, and error Try again across Index/Place/Person
    const indexView = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          initialBundle={audioBundle}
          capabilities={{ canEdit: true }}
        >
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const idxSearch = indexView.querySelector<HTMLInputElement>('input[type="search"]');
    if (idxSearch) {
      setFieldValue(idxSearch, 'nonexistent-surname-xyz');
    }
    act(() => {
      [...indexView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.includes('Clear filters'))
        ?.click();
    });
    act(() => {
      [...indexView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.includes('With photos'))
        ?.click();
    });
    act(() => {
      [...indexView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Clear')
        ?.click();
    });
    act(() => {
      [...indexView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.includes('Add Person'))
        ?.click();
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // Error state Try again across PersonPage, PlacePage, and IndexPage
    const failingLoader = {
      loadArchive: vi.fn(async () => {
        throw new Error('Offline archive');
      }),
      loadReadings: async () => null,
    };
    const errView = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} loader={failingLoader}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
          <PlacePage />
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    for (const retryBtn of [...errView.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
      b.textContent?.includes('Try again')
    )) {
      act(() => {
        retryBtn.click();
      });
    }
    expect(failingLoader.loadArchive).toHaveBeenCalled();
  });

  it('exercises MediaUploaderModal retry/reset/field handlers, EvidenceMediaTab & Lightbox navigation, and LocalSurveyMap neighbor pins', async () => {
    let uploadFailOnce = true;
    const uploadDs: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: ARCHIVE_BUNDLE, etag: '"r9"', notModified: false }),
      loadReadings: async () => null,
      uploadMedia: async () => {
        if (uploadFailOnce) {
          uploadFailOnce = false;
          throw new Error('Temporary R2 upload glitch');
        }
        return {
          url: '/media/med_up_1.mp3',
          media: {
            id: 'med_up_1',
            kind: 'audio_oral_history',
            file: '/media/med_up_1.mp3',
            caption: 'Uploaded oral history',
          },
          revision: {
            revision_id: asRevisionId(9),
            batch_id: null,
            entity_type: 'media',
            entity_id: 'med_up_1',
            parent_revision_id: 8,
            action: 'create',
            reverted_revision_id: null,
            author_id: 'editor@example.test',
            author_name: 'Clara Mercer',
            author_type: 'human',
            summary: 'Upload',
            has_primary_source: false,
            before_json: null,
            after_json: { id: 'med_up_1' },
            created_at: '2026-03-03T10:00:00Z',
          },
          etag: '"r9"',
        };
      },
    };

    const onCloseUpload = vi.fn();
    const onUploaded = vi.fn();
    const upView = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={uploadDs}
          initialBundle={ARCHIVE_BUNDLE}
          capabilities={{ canEdit: true, canUploadMedia: true }}
        >
          <MediaUploaderModal open onClose={onCloseUpload} onUploaded={onUploaded} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Exercise selects & text inputs on MediaUploaderModal
    const upSelects = upView.querySelectorAll<HTMLSelectElement>('select');
    if (upSelects[0]) setFieldValue(upSelects[0], 'headstone');
    if (upSelects[1]) setFieldValue(upSelects[1], 'per_henry');
    const upTexts = upView.querySelectorAll<HTMLInputElement>('input[type="text"]');
    if (upTexts[0]) setFieldValue(upTexts[0], 'Alder headstone rubbing');
    if (upTexts[1]) setFieldValue(upTexts[1], '1932-11');
    if (upTexts[2]) setFieldValue(upTexts[2], 'Added headstone photo');

    // Select an unsupported MIME file first -> rejectedInvalid -> Choose Another File
    const fileInput = upView.querySelector<HTMLInputElement>('input[type="file"]');
    const fireFileSelect = (file: File) => {
      if (!fileInput) return;
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      act(() => {
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };

    fireFileSelect(new File(['bad'], 'archive.exe', { type: 'application/x-msdownload' }));
    await act(async () => {
      upView.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();
    act(() => {
      [...upView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.includes('Choose Another File'))
        ?.click();
    });

    // Select valid audio file + video file -> submit (fails once -> Retry -> complete -> Upload Another -> Done)
    if (upTexts[0]) setFieldValue(upTexts[0], '');
    fireFileSelect(new File(['vid'], 'homestead_clip.mp4', { type: 'video/mp4' }));
    fireFileSelect(new File(['aud'], 'oral_interview.mp3', { type: 'audio/mpeg' }));
    await act(async () => {
      upView.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();
    await flushUi();

    await act(async () => {
      [...upView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Retry')
        ?.click();
    });
    await flushUi();
    await flushUi();

    act(() => {
      [...upView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.includes('Upload Another'))
        ?.click();
    });
    act(() => {
      upView.querySelector<HTMLButtonElement>('button[aria-label="Close media uploader"]')?.click();
    });

    // 2. EvidenceMediaTab + EvidenceMediaLightbox callbacks
    const mediaA = {
      ...TEN_MEDIA[0],
      person_slug: 'henry-alder',
      person_name: 'Henry Alder',
      provenance: 'Box 1',
    };
    const mediaB = { ...TEN_MEDIA[1], person_slug: 'henry-alder', person_name: 'Henry Alder' };
    const onQuery = vi.fn();
    const onKind = vi.fn();
    const onClear = vi.fn();
    const onMore = vi.fn();
    const onOpenItem = vi.fn();
    const onSetLb = vi.fn();

    const evMediaView = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={ARCHIVE_BUNDLE}>
          <EvidenceMediaTab
            allMedia={[mediaA, mediaB]}
            filteredMedia={[mediaA, mediaB]}
            mediaLimit={1}
            mediaKindFilter="portrait"
            mediaQuery="gal"
            mediaCountsByKind={{ portrait: 1, document_scan: 1 }}
            mediaChecklist={[
              {
                person_id: 'per_henry',
                person_name: 'Henry Alder',
                person_slug: 'henry-alder',
                lifespan: '1855–1932',
                obje_xref: '@M1@',
                title: 'Homestead Tintype',
                file: 'tintype.jpg',
                form: 'jpg',
                media_type: 'photo',
                status: 'missing',
              },
            ]}
            missingChecklistItems={[
              {
                person_id: 'per_henry',
                person_name: 'Henry Alder',
                person_slug: 'henry-alder',
                lifespan: '1855–1932',
                obje_xref: '@M1@',
                title: 'Homestead Tintype',
                file: 'tintype.jpg',
                form: 'jpg',
                media_type: 'photo',
                status: 'missing',
              },
            ]}
            onMediaQueryChange={onQuery}
            onMediaKindFilterChange={onKind}
            onClearMediaFilters={onClear}
            onLoadMoreMedia={onMore}
            onOpenMediaItem={onOpenItem}
          />
          <EvidenceMediaLightbox
            lightboxItem={mediaA}
            navMedia={[mediaA, mediaB]}
            onSetLightboxItem={onSetLb}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    const evSearch = evMediaView.querySelector<HTMLInputElement>('input[type="search"]');
    if (evSearch) setFieldValue(evSearch, 'portrait');
    for (const btn of evMediaView.querySelectorAll<HTMLButtonElement>('button')) {
      act(() => {
        btn.click();
      });
    }
    for (const link of evMediaView.querySelectorAll<HTMLAnchorElement>('a')) {
      act(() => {
        link.click();
      });
    }
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(onSetLb).toHaveBeenCalled();

    // 3. LocalSurveyMap neighbor pin click, Enter keydown, and narrow resize
    const surveyPlaces = [
      ARCHIVE_BUNDLE.places[0],
      ARCHIVE_BUNDLE.places[1],
      {
        ...ARCHIVE_BUNDLE.places[1],
        id: 'pl_zee_2',
        slug: 'zeeland-east',
        name: 'Zeeland East',
        lat: 42.811,
        lng: -86.011,
      },
    ];
    const surveyView = mountEl(
      <MemoryRouter>
        <LocalSurveyMap center={ARCHIVE_BUNDLE.places[0]} allPlaces={surveyPlaces} scopeMode="radius15" />
      </MemoryRouter>
    );
    const pin = surveyView.querySelector<SVGGElement>('g[role="button"]');
    act(() => {
      pin?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      pin?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      window.dispatchEvent(new Event('resize'));
    });
    expect(pin).toBeTruthy();

    // 4. ExplorerTopBar invite-viewer menu, SignInModal close, skip-link, and TreePersonSearch combobox handlers
    const topBarView = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          initialBundle={ARCHIVE_BUNDLE}
          session={{ authenticated: false, principal_kind: 'invite_viewer', inviteLabel: 'Alder Reunion' }}
        >
          <ExplorerTopBar />
          <main id="main-content">Content</main>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    act(() => {
      topBarView.querySelector<HTMLAnchorElement>('a[href="#main-content"]')?.click();
    });
    const openMenu = () => {
      act(() => {
        topBarView.querySelector<HTMLButtonElement>('button[aria-label="Archive menu"]')?.click();
      });
    };
    openMenu();
    act(() => {
      [...topBarView.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((b) => b.textContent?.includes('Sign in to edit'))
        ?.click();
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    for (const itemText of ['Sources', 'Evidence', 'Kinship']) {
      openMenu();
      act(() => {
        [...topBarView.querySelectorAll<HTMLElement>('[role="menuitem"]')]
          .find((el) => el.textContent?.includes(itemText))
          ?.click();
      });
    }
    openMenu();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    openMenu();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    const onTreeQuery = vi.fn();
    const onTreeSelect = vi.fn();
    const onTreeMobile = vi.fn();
    const treeSearchView = mountEl(
      <TreePersonSearch
        query="Henry"
        onQueryChange={onTreeQuery}
        candidates={[
          {
            person: ARCHIVE_BUNDLE.people[0],
            lifespanLabel: '1855–1932',
            genLabel: 'Gen 1',
            branchId: 'alder',
            branchLabel: 'Alder Line',
            isOutsideCurrentBranch: true,
            isCollapsed: false,
            isOutsideCurrentMode: false,
          },
        ]}
        onSelectCandidate={onTreeSelect}
        mobileOpen={false}
        onMobileOpenChange={onTreeMobile}
      />
    );
    const combo = treeSearchView.querySelector<HTMLInputElement>('input[role="combobox"]');
    act(() => {
      combo?.focus();
    });
    act(() => {
      combo?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      combo?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    const optBtn = treeSearchView.querySelector<HTMLButtonElement>('button[role="option"]');
    act(() => {
      optBtn?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      optBtn?.parentElement?.parentElement?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const clearSearchBtn = treeSearchView.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear person search"]'
    );
    act(() => {
      clearSearchBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      clearSearchBtn?.click();
    });
    act(() => {
      combo?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      combo?.blur();
      treeSearchView.querySelector<HTMLButtonElement>('button[aria-label="Find person in tree"]')?.click();
    });
    expect(onTreeQuery).toHaveBeenCalled();
  });
});
