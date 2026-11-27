/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, ReadingsBundle } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchivalMarkdown } from '../components/ArchivalMarkdown.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { SourceReaderDrawer } from '../components/SourceReaderDrawer.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { type AdminApiClient, AdminPage } from './AdminPage.js';
import { PersonPage } from './PersonPage.js';
import { PlacePage } from './PlacePage.js';
import { TreePage } from './TreePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Complete Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_COMPLETE_TEST',
  },
});

const { bundle: RICH_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
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
  ],
  sources: [
    {
      id: 'src_book',
      citation: 'History of Ottawa County (1905)',
      source_type: 'published_history',
      author: 'C. Vance',
      has_primary_source: true,
      url: 'https://example.test/ottawa',
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
      portrait_url: '/media/henry.jpg',
    },
    {
      id: 'per_clara',
      slug: 'clara-alder',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1858-07-22',
      death_edtf: '1938-04-09',
      portrait_url: null,
    },
    {
      id: 'per_arthur',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'descendant',
      birth_edtf: '1882-05-10',
      death_edtf: '1961-01-20',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_1880',
      title: '1880 Homestead',
      summary: 'Settled in Hudsonville.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_hud',
      participants: [{ person_id: 'per_henry', role: 'head' }],
      sources: [{ source_id: 'src_book', confidence: 'high' }],
    },
    {
      id: 'evt_local_1882',
      title: '1882 Sawdust Fire',
      summary: 'Mill yard fire extinguished by neighbors.',
      event_kind: 'point_event',
      scope: 'local',
      edtf_date: '1882-08-10',
      place_id: 'pl_hud',
      source_url: 'https://example.test/gazette-1882',
      participants: [],
      sources: [{ source_id: 'src_book', confidence: 'high' }],
    },
  ],
  kinship: [
    { from: 'per_henry', to: 'per_clara', relation: 'spouse' },
    { from: 'per_henry', to: 'per_arthur', relation: 'parent' },
    { from: 'per_clara', to: 'per_arthur', relation: 'parent' },
  ],
  media: Array.from({ length: 10 }, (_, i) => ({
    id: `med_${i}`,
    kind: 'family_photo' as const,
    file: `/media/p${i}.jpg`,
    caption: `Alder Family Photo ${i}`,
    date_edtf: `${1880 + i}`,
    person_ids: ['per_henry'],
    source_id: 'src_book',
  })),
  narratives: Array.from({ length: 5 }, (_, i) => ({
    id: `nar_${i}`,
    slug: `story-${i}`,
    title: `Family Story ${i}`,
    summary: `Summary of family story ${i}.`,
    body_md: `Henry Alder and Clara Alder lived in Hudsonville during 188${i} [1].`,
    date_edtf: `188${i}`,
    person_ids: ['per_henry', 'per_clara'],
    place_ids: ['pl_hud'],
    event_ids: ['evt_1880'],
    source_ids: ['src_book'],
  })),
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
          text: 'Henry Alder settled in 1880.',
          image_url: '/sources/p1.jpg',
        },
      ],
    },
  },
};

const EDITOR_DS: ArchiveDataSource = {
  loadArchive: async () => ({ bundle: RICH_BUNDLE, etag: '"r1"', notModified: false }),
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
  listRevisions: async () => ({ items: [], next_cursor: null }),
  listTalkComments: async () => [],
  logout: async () => {},
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

const PushTwoPivots: React.FC = () => {
  const { pushPivot } = useArchiveUi();
  useEffect(() => {
    pushPivot({ slug: 'henry-alder', name: 'Henry Alder', year: 1880 });
    pushPivot({ slug: 'clara-alder', name: 'Clara Alder', year: 1882 });
  }, [pushPivot]);
  return null;
};

const OpenReaderScan: React.FC = () => {
  const { openSourceReader } = useArchiveUi();
  useEffect(() => {
    openSourceReader({ sourceId: 'src_book', page: 1 });
  }, [openSourceReader]);
  return null;
};

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('Final behavioral coverage pass across TopBar, Tree search, AdminPage, PersonPage, PlacePage, Reader, and Markdown', () => {
  it('renders pivot trail and exercises account dropdown links in ExplorerTopBar and mobile/desktop search in TreePage', async () => {
    const bar = mountEl(
      <MemoryRouter initialEntries={['/person/clara-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE} dataSource={EDITOR_DS}>
          <PushTwoPivots />
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(bar.textContent).toContain('Trail:');
    expect(bar.textContent).toContain('Henry Alder');

    const accountBtn = bar.querySelector('button[aria-label="Account options"]') as HTMLButtonElement | null;
    if (accountBtn) {
      act(() => {
        accountBtn.click();
      });
      await flushUi();
      const menuLinks = Array.from(bar.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
      for (const item of menuLinks.slice(0, 4)) {
        act(() => {
          item.click();
        });
        await flushUi();
        act(() => {
          accountBtn.click();
        });
        await flushUi();
      }
      // Click outside to close
      act(() => {
        document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
      await flushUi();
    }

    // TreePage desktop + mobile search + Clear + Done + Add Person
    const tree = mountEl(
      <MemoryRouter initialEntries={['/tree?view=chart']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE} dataSource={EDITOR_DS}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const desktopInput = tree.querySelector('input[placeholder="Find person…"]') as HTMLInputElement | null;
    if (desktopInput) {
      act(() => {
        desktopInput.focus();
      });
      setInputValue(desktopInput, 'NoSuchPersonXYZ');
      await flushUi();
      const clearBtn = tree.querySelector(
        'button[aria-label="Clear person search"]'
      ) as HTMLButtonElement | null;
      act(() => {
        clearBtn?.click();
      });
      await flushUi();
      act(() => {
        desktopInput.blur();
      });
      await flushUi();
    }

    const mobileToggle = tree.querySelector(
      'button[aria-label="Find person in tree"]'
    ) as HTMLButtonElement | null;
    if (mobileToggle) {
      act(() => {
        mobileToggle.click();
      });
      await flushUi();
      const mobileInput = tree.querySelector(
        'input[placeholder*="by name or year" i]'
      ) as HTMLInputElement | null;
      if (mobileInput) {
        setInputValue(mobileInput, 'Arthur');
        await flushUi();
      }
      const doneBtn = tree.querySelector(
        'button[aria-label="Close person search"]'
      ) as HTMLButtonElement | null;
      act(() => {
        doneBtn?.click();
      });
      await flushUi();
    }

    const addPersonBtn = Array.from(tree.querySelectorAll('button')).find((b) =>
      /\+\s*add person/i.test(b.textContent || '')
    );
    if (addPersonBtn) {
      act(() => {
        addPersonBtn.click();
      });
      await flushUi();
    }
  });

  it('exercises AdminPage token scope/secret copy/dismiss/cancel/error and PersonPage + PlacePage edit/pronunciation/story/media toggles', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });

    const adminClient: AdminApiClient = {
      listUsers: async () => [
        {
          email: 'admin@example.test',
          display_name: 'Admin Alder',
          role: 'admin',
          added_by: 'system',
          added_at: '2026-01-01T00:00:00Z',
          last_login_at: '2026-06-01T00:00:00Z',
        },
        {
          email: 'admin2@example.test',
          display_name: 'Second Admin',
          role: 'admin',
          added_by: 'admin@example.test',
          added_at: '2026-02-01T00:00:00Z',
          last_login_at: null,
        },
      ],
      updateUserRole: async (email, { role }) => ({
        email,
        display_name: 'Second Admin',
        role,
        added_by: 'admin@example.test',
        added_at: '2026-02-01T00:00:00Z',
        last_login_at: null,
      }),
      listInvites: async () => [],
      createInvite: async ({ label }) => ({
        invite: {
          token: 'inv_new',
          label,
          created_by: 'admin@example.test',
          created_at: '2026-06-10T00:00:00Z',
          expires_at: null,
          revoked_at: null,
          uses: 0,
          last_used_at: null,
        },
        invite_url: 'https://archive.example.test/invite/inv_new',
      }),
      revokeInvite: async () => {},
      listAgentTokens: async () => [
        {
          token_id: 'tok_active',
          label: 'Backup Bot',
          scope: 'read_backup',
          created_by: 'admin@example.test',
          created_at: '2026-05-01T00:00:00Z',
          revoked_at: null,
        },
        {
          token_id: 'tok_old',
          label: 'Old Bot',
          scope: 'write_batch',
          created_by: 'admin@example.test',
          created_at: '2026-04-01T00:00:00Z',
          revoked_at: '2026-05-01T00:00:00Z',
        },
      ],
      createAgentToken: async ({ label, scope }) => ({
        token_id: 'tok_created',
        label,
        scope,
        plaintext_secret: 'kin_live_secret_123',
      }),
      revokeAgentToken: async () => {},
    };

    const adminEl = mountEl(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE} dataSource={EDITOR_DS}>
          <AdminPage adminClient={adminClient} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const scopeSelect = adminEl.querySelector(
      'select[aria-label="Agent token scope"]'
    ) as HTMLSelectElement | null;
    if (scopeSelect) {
      setInputValue(scopeSelect, 'read_backup');
    }
    const tokenInput = adminEl.querySelector(
      'input[placeholder*="Research CLI" i]'
    ) as HTMLInputElement | null;
    if (tokenInput) {
      setInputValue(tokenInput, 'Nightly Sync');
    }
    await flushUi();
    const createTokBtn = Array.from(adminEl.querySelectorAll('button')).find((b) =>
      /create token/i.test(b.textContent || '')
    );
    act(() => {
      createTokBtn?.click();
    });
    await flushUi();
    await flushUi();

    const copySecretBtn = Array.from(adminEl.querySelectorAll('button')).find((b) =>
      /copy secret/i.test(b.textContent || '')
    );
    act(() => {
      copySecretBtn?.click();
    });
    await flushUi();
    const dismissBtn = Array.from(adminEl.querySelectorAll('button')).find((b) =>
      /^dismiss$/i.test((b.textContent || '').trim())
    );
    act(() => {
      dismissBtn?.click();
    });
    await flushUi();

    // Click Revoke then Cancel on token row
    const revokeBtn = Array.from(adminEl.querySelectorAll('button')).find((b) =>
      /^revoke$/i.test((b.textContent || '').trim())
    );
    act(() => {
      revokeBtn?.click();
    });
    await flushUi();
    const cancelBtn = Array.from(adminEl.querySelectorAll('button')).find((b) =>
      /^cancel$/i.test((b.textContent || '').trim())
    );
    act(() => {
      cancelBtn?.click();
    });
    await flushUi();

    // PersonPage: show all media, read story, add photo, edit page, add pronunciation
    const personEl = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE} dataSource={EDITOR_DS}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    for (const pattern of [/show all/i, /read story/i, /hide story/i, /add pronunciation/i, /add photo/i]) {
      const btn = Array.from(personEl.querySelectorAll('button')).find((b) =>
        pattern.test(b.textContent || '')
      );
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }

    // PlacePage: decade buttons + Edit Page + close drawer
    const placeEl = mountEl(
      <MemoryRouter initialEntries={['/place/hudsonville']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE} dataSource={EDITOR_DS}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    for (const pattern of [/1880s/i, /all decades/i, /edit page/i]) {
      const btn = Array.from(placeEl.querySelectorAll('button')).find((b) =>
        pattern.test(b.textContent || '')
      );
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }

    // SourceReaderDrawer scan zoom + ArchivalMarkdown citation popover
    const readerAndMd = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={RICH_BUNDLE} dataSource={EDITOR_DS}>
          <OpenReaderScan />
          <SourceReaderDrawer />
          <ArchivalMarkdown
            markdown="Henry Alder settled in Hudsonville [1]."
            sourcesById={new Map(RICH_BUNDLE.sources.map((s) => [s.id, s]))}
            mediaItems={RICH_BUNDLE.media}
            peopleById={new Map(RICH_BUNDLE.people.map((p) => [p.id, p]))}
            placesById={new Map(RICH_BUNDLE.places.map((pl) => [pl.id, pl]))}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    const scanTab = Array.from(readerAndMd.querySelectorAll('[role="tab"], button')).find((b) =>
      /original scan/i.test(b.textContent || '')
    ) as HTMLElement | undefined;
    if (scanTab) {
      act(() => {
        scanTab.click();
      });
      await flushUi();
    }
    const citBtn = Array.from(readerAndMd.querySelectorAll('button')).find((b) =>
      /\[?1\]?/.test(b.textContent || '')
    );
    if (citBtn) {
      act(() => {
        citBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        citBtn.click();
      });
      await flushUi();
    }
  });
});
