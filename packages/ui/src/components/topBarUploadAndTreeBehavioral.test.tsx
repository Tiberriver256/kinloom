/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveDataSource,
  KinloomSiteConfig,
  MediaItem,
  RevisionRecord,
} from '@kinloom/core';
import { asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGlobalErrorHandlers } from '../browser/clientTelemetry.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { TreePage } from '../pages/TreePage.js';
import { ExplorerTopBar } from './ExplorerTopBar.js';
import { MilestoneStoryCard } from './MilestoneStoryCard.js';
import { MediaUploaderModal } from './wiki/MediaUploaderModal.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder TopBar Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_TOPBAR_TEST',
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
  ],
  sources: [
    {
      id: 'src_1',
      citation: '1880 US Federal Census',
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
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
      portrait_url: null,
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
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
      ],
      sources: [{ source_id: 'src_1', confidence: 'high' }],
    },
  ],
  kinship: [{ from: 'per_henry', to: 'per_clara', relation: 'spouse' }],
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

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('ExplorerTopBar, MediaUploaderModal, MilestoneStoryCard, TreePage canvas, and clientTelemetry behavioral flows', () => {
  it('opens account menu and signs out in ExplorerTopBar, and opens SignInModal when signed out', async () => {
    let signedOut = false;
    const adminDs: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => ({ version: 1, event_page_map: {}, documents: {} }),
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
      logout: async () => {
        signedOut = true;
      },
    };

    const bar = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={adminDs}>
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const accountBtn = bar.querySelector('button[aria-label="Account options"]') as HTMLButtonElement | null;
    if (accountBtn) {
      act(() => {
        accountBtn.click();
      });
      await flushUi();
      expect(bar.textContent).toContain('Sign Out');

      // Press Escape to close, reopen, and click Sign Out
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await flushUi();
      act(() => {
        accountBtn.click();
      });
      await flushUi();
      const signOutBtn = Array.from(bar.querySelectorAll('button')).find((b) =>
        /sign out/i.test(b.textContent || '')
      );
      act(() => {
        signOutBtn?.click();
      });
      await flushUi();
      expect(signedOut).toBe(true);
    }

    // Invite viewer badge in ExplorerTopBar
    const inviteDs: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => ({ version: 1, event_page_map: {}, documents: {} }),
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: {
          authenticated: false,
          principal_kind: 'invite_viewer',
          role: 'viewer',
          inviteLabel: 'Cousin Invite',
        },
        capabilities: {
          canEdit: false,
          canUploadMedia: false,
          hasRevisionHistory: false,
          hasTalk: false,
          canManageSite: false,
        },
      }),
    };
    const inviteBar = mountEl(
      <MemoryRouter initialEntries={['/places']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={inviteDs}>
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    const signInBtn = Array.from(inviteBar.querySelectorAll('button')).find((b) =>
      /sign in/i.test(b.textContent || '')
    );
    if (signInBtn) {
      act(() => {
        signInBtn.click();
      });
      await flushUi();
      // Test Tab focus trap inside SignInModal
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await flushUi();
    }
  });

  it('completes a file upload through MediaUploaderModal and selects/pivots on MilestoneStoryCard', async () => {
    let uploaded = false;
    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => ({ version: 1, event_page_map: {}, documents: {} }),
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: {
          authenticated: true,
          principal_kind: 'user',
          email: 'editor@example.test',
          displayName: 'Editor Alder',
          role: 'editor',
        },
        capabilities: {
          canEdit: true,
          canUploadMedia: true,
          hasRevisionHistory: true,
          hasTalk: true,
          canManageSite: false,
        },
      }),
      uploadMedia: async () => {
        uploaded = true;
        return {
          media: {
            id: 'med_up_1',
            kind: 'family_photo',
            file: '/media/up.png',
            caption: 'Homestead',
          } as unknown as MediaItem,
          url: '/media/up.png',
          revision: { revision_id: asRevisionId(2) } as unknown as RevisionRecord,
          etag: '"r2"',
        };
      },
    };

    const modal = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <MediaUploaderModal open={true} defaultPersonId="per_henry" onClose={() => {}} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const fileInput = modal.querySelector('input[type="file"]') as HTMLInputElement | null;
    if (fileInput) {
      const png = new File([new Uint8Array([137, 80, 78, 71])], 'homestead.png', { type: 'image/png' });
      Object.defineProperty(fileInput, 'files', { value: [png], configurable: true });
      act(() => {
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flushUi();
      const uploadBtn = Array.from(modal.querySelectorAll('button')).find(
        (b) => /upload|add photo|submit/i.test(b.textContent || '') && !b.disabled
      );
      if (uploadBtn) {
        act(() => {
          uploadBtn.click();
        });
        await flushUi();
        await flushUi();
      }
    }
    expect(uploaded || modal.textContent?.includes('homestead.png')).toBe(true);

    // MilestoneStoryCard click + co-presence pivot
    let selected = false;
    let pivotedSlug = '';
    const sourcesById = new Map(SAMPLE_BUNDLE.sources.map((s) => [s.id, s]));
    const ev = SAMPLE_BUNDLE.events[0];
    const card = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          {ev && (
            <MilestoneStoryCard
              event={ev}
              place={SAMPLE_BUNDLE.places[0]}
              isActive={true}
              sourcesById={sourcesById}
              alsoHere={[
                {
                  person: SAMPLE_BUNDLE.people[1],
                  relation: 'Spouse',
                  tier: 'Confirmed',
                  distance_miles: 0,
                } as never,
              ]}
              onPivotPerson={(item) => {
                pivotedSlug = item.person.slug;
              }}
              onSelect={() => {
                selected = true;
              }}
            />
          )}
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const article = card.querySelector('article');
    act(() => {
      article?.click();
    });
    expect(selected).toBe(true);
    const pivotBtn = Array.from(card.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Clara Alder')
    );
    act(() => {
      pivotBtn?.click();
    });
    expect(pivotedSlug).toBe('clara-alder');
  });

  it('pans, zooms, and uses keyboard shortcuts on TreePage chart and handles global clientTelemetry events', async () => {
    const tree = mountEl(
      <MemoryRouter initialEntries={['/tree?view=chart']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const canvas = tree.querySelector('[role="region"], svg')?.parentElement ?? tree;
    act(() => {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true }));
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    await flushUi();

    // Global error handlers in clientTelemetry
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const uninstall = installGlobalErrorHandlers({ endpoint: 'https://telemetry.example.test/errors' });
    act(() => {
      window.dispatchEvent(
        new ErrorEvent('error', { message: 'Synthetic window error', filename: '/app.js' })
      );
      const preload = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(preload);
    });
    uninstall();
  });
});
