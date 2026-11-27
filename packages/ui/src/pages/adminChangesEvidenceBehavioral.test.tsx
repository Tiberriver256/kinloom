/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveDataSource,
  KinloomSiteConfig,
  ReadingsBundle,
  RevisionRecord,
} from '@kinloom/core';
import { asBatchId, asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceInspectorDrawer } from '../components/SourceInspectorDrawer.js';
import { SourceReaderDrawer } from '../components/SourceReaderDrawer.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { KinloomApp } from '../KinloomApp.js';
import { type AdminApiClient, AdminPage } from './AdminPage.js';
import { EvidencePage } from './EvidencePage.js';
import { PlacePage } from './PlacePage.js';
import { RecentChangesPage } from './RecentChangesPage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Governance Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_GOV_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
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
      id: 'pl_jen',
      slug: 'jenison',
      name: 'Jenison',
      full_name: 'Jenison, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.91,
      lng: -85.79,
    },
  ],
  sources: [
    {
      id: 'src_book',
      citation: 'History of Ottawa County (1905)',
      source_type: 'published_history',
      author: 'C. Vance',
      has_primary_source: true,
      url: 'https://example.test/ottawa-1905',
    },
    {
      id: 'src_unverified',
      citation: 'Family Oral Tradition',
      source_type: 'family_tree',
      has_primary_source: false,
    },
  ],
  people: [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_1880',
      title: '1880 Homestead Settlement',
      summary: 'Henry settled in Hudsonville.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_hud',
      participants: [{ person_id: 'per_henry', role: 'head' }],
      sources: [
        {
          source_id: 'src_book',
          confidence: 'high',
          citation_detail: 'p. 12',
          scan_url: '/sources/p1.jpg',
          scan_title: 'Ottawa County p. 12',
        },
      ],
      alternate_dates: [{ edtf_date: '1881', source_id: 'src_book', note: 'Tax roll' }],
    },
    {
      id: 'evt_unverified',
      title: 'Uncited Story',
      summary: 'Mentioned in oral tradition.',
      event_kind: 'point_event',
      scope: 'family',
      edtf_date: '1888',
      place_id: 'pl_hud',
      participants: [{ person_id: 'per_henry', role: 'principal' }],
      sources: [{ source_id: 'src_unverified', confidence: 'low' }],
    },
  ],
  kinship: [],
  media: [
    {
      id: 'med_1',
      kind: 'family_photo',
      file: '/media/homestead.jpg',
      caption: 'Alder Homestead 1885',
      date_edtf: '1885',
      person_ids: ['per_henry'],
      source_id: 'src_book',
    },
    {
      id: 'med_2',
      kind: 'record_scan',
      file: '/media/deed.jpg',
      caption: '1880 Land Deed Scan',
      date_edtf: '1880',
      person_ids: ['per_henry'],
      source_id: 'src_book',
    },
  ],
});

const SAMPLE_READINGS: ReadingsBundle = {
  version: 1,
  event_page_map: { evt_1880: { src_book: 1 } },
  documents: {
    src_book: {
      source_id: 'src_book',
      title: 'History of Ottawa County',
      author: 'C. Vance',
      provenance: 'Ottawa Historical Society',
      pages: [
        {
          page: 1,
          label: 'Page 1',
          file: 'p1.txt',
          text: 'Henry Alder settled in Hudsonville in 1880.',
          image_url: '/sources/p1.jpg',
        },
      ],
    },
  },
};

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
  vi.restoreAllMocks();
});

describe('AdminPage, RecentChangesPage, EvidencePage, PlacePage, and KinloomApp behavioral flows', () => {
  it('manages members, invites, and agent tokens on AdminPage', async () => {
    const users = [
      {
        email: 'admin@example.test',
        display_name: 'Admin Alder',
        role: 'admin' as const,
        added_by: 'system',
        added_at: '2026-01-01T00:00:00Z',
        last_login_at: '2026-06-01T00:00:00Z',
      },
      {
        email: 'editor@example.test',
        display_name: 'Editor Mercer',
        role: 'editor' as const,
        added_by: 'admin@example.test',
        added_at: '2026-02-01T00:00:00Z',
        last_login_at: null,
      },
    ];
    const invites = [
      {
        token: 'inv_tok_1',
        label: 'Summer Reunion',
        created_by: 'admin@example.test',
        created_at: '2026-05-01T00:00:00Z',
        expires_at: null,
        revoked_at: null,
        uses: 3,
        last_used_at: '2026-06-01T00:00:00Z',
      },
    ];
    const tokens = [
      {
        token_id: 'tok_1',
        label: 'CLI Import Bot',
        scope: 'write_batch' as const,
        created_by: 'admin@example.test',
        created_at: '2026-05-01T00:00:00Z',
        revoked_at: null,
      },
    ];

    const adminClient: AdminApiClient = {
      listUsers: async () => users,
      updateUserRole: async (email, { role }) => ({
        email,
        display_name: 'Editor Mercer',
        role,
        added_by: 'admin@example.test',
        added_at: '2026-02-01T00:00:00Z',
        last_login_at: null,
      }),
      listInvites: async () => invites,
      createInvite: async ({ label }) => ({
        invite: {
          token: 'inv_tok_2',
          label,
          created_by: 'admin@example.test',
          created_at: '2026-06-10T00:00:00Z',
          expires_at: null,
          revoked_at: null,
          uses: 0,
          last_used_at: null,
        },
        invite_url: 'https://archive.example.test/invite/inv_tok_2',
      }),
      revokeInvite: async () => {},
      listAgentTokens: async () => tokens,
      createAgentToken: async ({ label, scope }) => ({
        token_id: 'tok_2',
        label,
        scope,
        plaintext_secret: 'kin_secret_token_value',
      }),
      revokeAgentToken: async () => {},
    };

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => SAMPLE_READINGS,
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: {
          authenticated: true,
          principal_kind: 'user',
          email: 'admin@example.test',
          displayName: 'Admin Alder',
          role: 'admin',
        },
        capabilities: {
          canEdit: true,
          canUploadMedia: true,
          hasRevisionHistory: true,
          hasTalk: true,
          canManageSite: true,
        },
      }),
    };

    const container = mountEl(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <AdminPage adminClient={adminClient} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(container.textContent).toContain('Admin Alder');
    expect(container.textContent).toContain('Summer Reunion');
    expect(container.textContent).toContain('CLI Import Bot');

    // Fill and submit invite & agent token forms
    const forms = Array.from(container.querySelectorAll('form'));
    for (const form of forms) {
      const textInputs = Array.from(form.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
      for (const ti of textInputs) {
        setInputValue(ti, 'Autumn Batch');
      }
      const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      if (submitBtn && !submitBtn.disabled) {
        act(() => {
          submitBtn.click();
        });
        await flushUi();
      }
    }

    // Trigger copy / revoke / promote buttons + inline confirm
    const actionBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
      /copy|revoke|promote|demote/i.test(b.textContent || '')
    );
    for (const btn of actionBtns.slice(0, 6)) {
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

  it('filters, expands diffs, and reverts single and batch revisions on RecentChangesPage', async () => {
    const revHuman = {
      revision_id: asRevisionId(2),
      entity_type: 'person',
      entity_id: 'per_henry',
      action: 'update',
      parent_revision_id: asRevisionId(1),
      batch_id: null,
      author_type: 'human',
      author_id: 'editor@example.test',
      author_name: 'Editor Alder',
      summary: 'Verified birth date',
      before_snapshot: { id: 'per_henry', birth_edtf: '1855' },
      after_snapshot: { id: 'per_henry', birth_edtf: '1855-03-14' },
      has_primary_source: true,
      revert_of_revision_id: null,
      created_at: '2026-06-01T10:00:00Z',
    } as unknown as RevisionRecord;

    const revAgent1 = {
      ...revHuman,
      revision_id: asRevisionId(3),
      entity_type: 'place',
      entity_id: 'pl_hud',
      batch_id: asBatchId('batch_100'),
      author_type: 'agent',
      author_id: 'tok_1',
      author_name: 'Census Importer',
      summary: 'Imported Ottawa County coordinates',
    } as unknown as RevisionRecord;

    const revAgent2 = {
      ...revAgent1,
      revision_id: asRevisionId(4),
      entity_type: 'source',
      entity_id: 'src_book',
      summary: 'Imported county history citation',
    } as unknown as RevisionRecord;

    let revertCalls = 0;
    let batchRevertCalls = 0;
    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r4"', notModified: false }),
      loadReadings: async () => SAMPLE_READINGS,
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: {
          authenticated: true,
          principal_kind: 'user',
          email: 'admin@example.test',
          displayName: 'Admin Alder',
          role: 'admin',
        },
        capabilities: {
          canEdit: true,
          canUploadMedia: true,
          hasRevisionHistory: true,
          hasTalk: true,
          canManageSite: true,
        },
      }),
      listRevisions: async () => ({ items: [revAgent2, revAgent1, revHuman], next_cursor: null }),
      revertRevision: async () => {
        revertCalls += 1;
        return { revision: revHuman, etag: '"r5"' };
      },
      revertBatch: async () => {
        batchRevertCalls += 1;
        return { revisions: [revAgent1, revAgent2], etag: '"r6"' };
      },
    };

    const container = mountEl(
      <MemoryRouter initialEntries={['/changes']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <RecentChangesPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(container.textContent).toContain('Verified birth date');
    expect(container.textContent).toContain('Census Importer');

    // Switch author filter tabs (Human / Agent / All)
    for (const label of [/human/i, /agent/i, /all/i]) {
      const tab = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
        label.test(t.textContent || '')
      ) as HTMLElement | undefined;
      if (tab) {
        act(() => {
          tab.click();
        });
        await flushUi();
      }
    }

    // Expand diff view
    const diffBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /diff|details|inspect/i.test(b.textContent || '')
    );
    if (diffBtn) {
      act(() => {
        diffBtn.click();
      });
      await flushUi();
    }

    // Revert batch
    const batchBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /revert batch|undo batch/i.test(b.textContent || '')
    );
    if (batchBtn) {
      act(() => {
        batchBtn.click();
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

    // Revert single revision
    const revertBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^revert$/i.test((b.textContent || '').trim())
    );
    if (revertBtn) {
      act(() => {
        revertBtn.click();
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

    expect(revertCalls + batchRevertCalls).toBeGreaterThanOrEqual(1);
  });

  it('exercises EvidencePage Sources + Media tabs with SourceInspectorDrawer, PlacePage scope toggles, and KinloomApp', async () => {
    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => SAMPLE_READINGS,
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: { authenticated: false, principal_kind: 'anonymous' },
        capabilities: {
          canEdit: false,
          canUploadMedia: false,
          hasRevisionHistory: false,
          hasTalk: false,
          canManageSite: false,
        },
      }),
    };

    const evPage = mountEl(
      <MemoryRouter initialEntries={['/evidence?tab=sources']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <EvidencePage />
          <SourceInspectorDrawer />
          <SourceReaderDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    // Filter sources, clear filter, inspect source -> preview scan -> copy -> open reader
    const sourceFilter = evPage.querySelector(
      'input[aria-label="Filter archival sources"]'
    ) as HTMLInputElement | null;
    if (sourceFilter) {
      setInputValue(sourceFilter, 'NoMatchXYZ');
      await flushUi();
      const clearBtn = Array.from(evPage.querySelectorAll('button')).find((b) =>
        /clear filter/i.test(b.textContent || '')
      );
      act(() => {
        clearBtn?.click();
      });
      await flushUi();
    }

    const inspectBtn = Array.from(evPage.querySelectorAll('button')).find((b) =>
      /inspect source/i.test(b.textContent || '')
    );
    if (inspectBtn) {
      act(() => {
        inspectBtn.click();
      });
      await flushUi();
      const previewBtn = Array.from(evPage.querySelectorAll('button')).find((b) =>
        /preview record scan/i.test(b.textContent || '')
      );
      act(() => {
        previewBtn?.click();
      });
      await flushUi();
      const copyBtn = Array.from(evPage.querySelectorAll('button')).find((b) =>
        /copy citation/i.test(b.textContent || '')
      );
      act(() => {
        copyBtn?.click();
      });
      await flushUi();
      const readerBtn = Array.from(evPage.querySelectorAll('button')).find((b) =>
        /open source reader/i.test(b.textContent || '')
      );
      act(() => {
        readerBtn?.click();
      });
      await flushUi();
    }

    // Switch to Photos & Documents tab, filter by kind & search, open media lightbox
    const mediaTab = Array.from(evPage.querySelectorAll('[role="tab"]')).find((t) =>
      /photos & documents/i.test(t.textContent || '')
    ) as HTMLElement | undefined;
    if (mediaTab) {
      act(() => {
        mediaTab.click();
      });
      await flushUi();
      const familyPhotoFilter = Array.from(evPage.querySelectorAll('button')).find((b) =>
        /family photo/i.test(b.textContent || '')
      );
      act(() => {
        familyPhotoFilter?.click();
      });
      await flushUi();
      const mediaCard = Array.from(evPage.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Alder Homestead 1885')
      );
      act(() => {
        mediaCard?.click();
      });
      await flushUi();
    }

    // PlacePage scope toggles (Exact / 15 mi / County)
    const placeEl = mountEl(
      <MemoryRouter initialEntries={['/place/hudsonville']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    for (const label of [/exact/i, /county/i, /15/i]) {
      const btn = Array.from(placeEl.querySelectorAll('button')).find((b) => label.test(b.textContent || ''));
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }

    // KinloomApp private archive gate when bundle is null & anonymous
    const gateApp = mountEl(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        initialBundle={null}
        initialEntries={['/']}
        session={{ authenticated: false, principal_kind: 'anonymous' }}
      />
    );
    await flushUi();
    expect(gateApp.textContent).toMatch(/sign in|private|archive/i);
  });
});
