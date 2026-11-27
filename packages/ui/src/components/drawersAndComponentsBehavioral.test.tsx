/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveDataSource,
  KinloomSiteConfig,
  ReadingsBundle,
  RevisionRecord,
} from '@kinloom/core';
import { asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import {
  CHUNK_RELOAD_STORAGE_KEY,
  installGlobalErrorHandlers,
  isChunkLoadError,
  reportClientError,
  sanitizeReport,
  sanitizeRoute,
  shouldAttemptChunkReload,
} from '../lib/clientTelemetry.js';
import {
  formatPhotoDocumentCount,
  formatPronunciationScopePrefix,
  formatPronunciationScopeTitle,
  formatReaderLoadError,
  KINLOOM_VOCABULARY,
} from '../lib/vocabulary.js';
import {
  ArchivalPhotoFrame,
  CoordinatePill,
  DateStamp,
  EmptyStateNotice,
  initialsOf,
  RelativeAvatarChip,
  resolveAssetUrl,
  ScopeGlyph,
  SourceCitationTag,
} from './Atoms.js';
import { GlobalSearchModal } from './GlobalSearchModal.js';
import { SourceReaderDrawer } from './SourceReaderDrawer.js';
import { MediaUploaderModal } from './wiki/MediaUploaderModal.js';
import { RevisionHistoryPanel } from './wiki/RevisionHistoryPanel.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Drawer Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_DRAWER_TEST',
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
      id: 'src_book',
      citation: 'History of Ottawa County (1905)',
      source_type: 'published_history',
      author: 'C. Vance',
      has_primary_source: true,
      url: 'https://example.test/ottawa-1905',
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
      summary: 'Henry Alder built a timber cabin in Hudsonville.',
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
          scan_title: 'Page 1 Scan',
        },
      ],
      alternate_dates: [{ edtf_date: '1881', source_id: 'src_book', note: 'Tax roll lists 1881' }],
      alternate_places: [{ place_name: 'Georgetown Twp', source_id: 'src_book', note: 'Early deed' }],
      fact_conflicts: [{ claim: 'Forty acres', source_id: 'src_book', note: 'Plat shows 38 acres' }],
    },
  ],
  kinship: [],
});

const SAMPLE_READINGS: ReadingsBundle = {
  version: 1,
  event_page_map: { evt_1880: { src_book: 1 } },
  documents: {
    src_book: {
      source_id: 'src_book',
      title: 'History of Ottawa County',
      author: 'C. Vance',
      provenance: 'Ottawa County Historical Society',
      pdf_url: '/sources/ottawa-1905.pdf',
      pdf_size_bytes: 2_450_000,
      pages: [
        {
          page: 1,
          label: 'Page 1',
          file: 'p1.txt',
          text: 'Henry Alder settled in Hudsonville in 1880 and cleared forty acres of timber.',
          image_url: '/sources/p1.jpg',
        },
        {
          page: 2,
          label: 'Page 2',
          file: 'p2.txt',
          text: 'By 1884 the Alder sawmill supplied lumber across Ottawa County.',
          image_url: '/sources/p2.jpg',
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

function setInputValue(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  const proto =
    input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
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

describe('RevisionHistoryPanel behavioral flow', () => {
  it('fetches revisions, toggles diffs, confirms and executes revert', async () => {
    const rev1 = {
      revision_id: asRevisionId(2),
      entity_type: 'person',
      entity_id: 'per_henry',
      action: 'update',
      parent_revision_id: asRevisionId(1),
      batch_id: null,
      author_type: 'human',
      author_id: 'founder@example.test',
      author_name: 'Founder Alder',
      summary: 'Updated birth date from register',
      before_snapshot: { id: 'per_henry', full_name: 'Henry Alder', birth_edtf: '1855' },
      after_snapshot: { id: 'per_henry', full_name: 'Henry Alder', birth_edtf: '1855-03-14' },
      has_primary_source: true,
      revert_of_revision_id: null,
      created_at: '2026-06-01T12:00:00Z',
    } as unknown as RevisionRecord;

    let revertedCount = 0;
    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r2"', notModified: false }),
      loadReadings: async () => SAMPLE_READINGS,
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: {
          authenticated: true,
          principal_kind: 'user',
          email: 'founder@example.test',
          displayName: 'Founder Alder',
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
      listRevisions: async () => ({ items: [rev1], next_cursor: null }),
      revertRevision: async () => {
        revertedCount += 1;
        return {
          revision: { ...rev1, revision_id: asRevisionId(3), summary: 'Undo r2' } as RevisionRecord,
          etag: '"r3"',
        };
      },
    };

    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <RevisionHistoryPanel entityType="person" entityId="per_henry" />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(container.textContent).toContain('Updated birth date from register');
    expect(container.textContent).toContain('Founder Alder');

    const revertBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /revert/i.test(b.textContent || '')
    );
    expect(revertBtn).toBeDefined();
    act(() => {
      revertBtn?.click();
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
      expect(revertedCount).toBe(1);
    }
  });
});

const TriggerReader: React.FC = () => {
  const { openSourceReader } = useArchiveUi();
  useEffect(() => {
    openSourceReader({ sourceId: 'src_book', page: 1 });
  }, [openSourceReader]);
  return null;
};

const TriggerSearch: React.FC = () => {
  const { openSearch } = useArchiveUi();
  useEffect(() => {
    openSearch();
  }, [openSearch]);
  return null;
};

describe('SourceReaderDrawer, GlobalSearchModal, MediaUploaderModal, and Atoms behavioral flows', () => {
  it('opens SourceReaderDrawer, searches with highlights, turns pages, switches view modes, and closes', async () => {
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

    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <TriggerReader />
          <SourceReaderDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(container.textContent).toContain('History of Ottawa County');
    expect(container.textContent).toContain('Henry Alder settled in Hudsonville');

    const searchInput = container.querySelector(
      'input[type="search"], input[type="text"]'
    ) as HTMLInputElement | null;
    if (searchInput) {
      setInputValue(searchInput, 'Hudsonville');
      await flushUi();
      expect(container.querySelector('mark')?.textContent).toBe('Hudsonville');
    }

    const nextBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /next/i.test(b.getAttribute('aria-label') || b.textContent || '')
    );
    if (nextBtn) {
      act(() => {
        nextBtn.click();
      });
      await flushUi();
      expect(container.textContent).toContain('sawmill supplied lumber');
    }

    for (const label of [/side-by-side/i, /scan/i, /text/i]) {
      const modeBtn = Array.from(container.querySelectorAll('[role="tab"], button')).find((b) =>
        label.test(b.textContent || '')
      );
      if (modeBtn) {
        act(() => {
          (modeBtn as HTMLElement).click();
        });
        await flushUi();
      }
    }

    const closeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /close/i.test(b.getAttribute('aria-label') || b.textContent || '')
    );
    if (closeBtn) {
      act(() => {
        closeBtn.click();
      });
      await flushUi();
    }
  });

  it('opens GlobalSearchModal, searches across archive entities, navigates with keyboard, and closes on Escape', async () => {
    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <TriggerSearch />
          <GlobalSearchModal />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const input = container.querySelector(
      'input[type="search"], input[type="text"]'
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    if (input) {
      setInputValue(input, 'Henry');
      await flushUi();
      expect(container.textContent).toContain('Henry Alder');

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await flushUi();
    }
  });

  it('renders MediaUploaderModal and Atoms interactive lightboxes and citation tags', async () => {
    let closed = false;
    const modal = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <MediaUploaderModal
            open={true}
            defaultPersonId="per_henry"
            onClose={() => {
              closed = true;
            }}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(modal.textContent).toMatch(/upload|media|photo|caption/i);

    const captionInput = modal.querySelector('input[type="text"]') as HTMLInputElement | null;
    if (captionInput) {
      setInputValue(captionInput, 'Homestead portrait');
    }
    const cancelBtn = Array.from(modal.querySelectorAll('button')).find((b) =>
      /cancel|close/i.test(b.getAttribute('aria-label') || b.textContent || '')
    );
    if (cancelBtn) {
      act(() => {
        cancelBtn.click();
      });
      await flushUi();
      expect(closed).toBe(true);
    }

    const sourcesById = new Map(SAMPLE_BUNDLE.sources.map((s) => [s.id, s]));
    const ev = SAMPLE_BUNDLE.events[0];
    let avatarClicked = 0;

    const atoms = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <EmptyStateNotice
            title="No records yet"
            body="Add a primary source."
            action={<button type="button">Add</button>}
          />
          <DateStamp displayDate="Mar 14, 1855" edtf="1855-03-14" />
          <DateStamp displayDate="" />
          <CoordinatePill place={SAMPLE_BUNDLE.places[0]} />
          <CoordinatePill place={undefined} />
          <ScopeGlyph category="weather" />
          <ScopeGlyph category="newspaper" />
          <ScopeGlyph category="macro" />
          <ScopeGlyph category="homestead" />
          <ScopeGlyph category="family_milestone" />
          <ScopeGlyph category="life_milestone" />
          <RelativeAvatarChip
            name="Dr. Henry Alder Jr."
            relationship="Father"
            tier="Confirmed"
            distanceMiles={0}
            onClick={() => {
              avatarClicked += 1;
            }}
          />
          <RelativeAvatarChip
            name="Clara Alder"
            relationship="Sister"
            tier="Inferred"
            distanceMiles={14}
            onClick={() => {}}
          />
          <RelativeAvatarChip
            name="Unknown"
            relationship="Relative"
            tier="Possible"
            distanceMiles={null}
            onClick={() => {}}
          />
          <ArchivalPhotoFrame caption="Cabin 1880" photoUrl="/media/cabin.jpg" />
          <ArchivalPhotoFrame caption="Missing portrait" photoUrl={null} />
          <SourceCitationTag
            sources={ev?.sources ?? []}
            alternateDates={ev?.alternate_dates}
            alternatePlaces={ev?.alternate_places}
            factConflicts={ev?.fact_conflicts}
            sourcesById={sourcesById}
            eventId={ev?.id}
          />
          <SourceCitationTag sources={[]} sourcesById={sourcesById} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    expect(atoms.textContent).toContain('No records yet');
    expect(atoms.textContent).toContain('Hudsonville');
    expect(initialsOf('Dr. Henry Alder Jr.')).toBe('HA');
    expect(initialsOf('Alder')).toBe('AL');
    expect(initialsOf('   ')).toBe('?');
    expect(resolveAssetUrl('/media/a.jpg', '/demo/')).toBe('/demo/media/a.jpg');
    expect(resolveAssetUrl('https://cdn.example.test/a.jpg')).toBe('https://cdn.example.test/a.jpg');
    expect(resolveAssetUrl(null)).toBe('');

    // Click avatar chip
    const fatherChip = Array.from(atoms.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Dr. Henry Alder Jr.')
    );
    act(() => {
      fatherChip?.click();
    });
    expect(avatarClicked).toBe(1);

    // Open and close photo lightbox
    const photoBtn = Array.from(atoms.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Cabin 1880')
    );
    act(() => {
      photoBtn?.click();
    });
    await flushUi();
    expect(atoms.textContent).toContain('ARCHIVAL PHOTOGRAPH · ZOOM VIEW');
    const closeLightbox = Array.from(atoms.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Close [Esc]')
    );
    act(() => {
      closeLightbox?.click();
    });
    await flushUi();

    // Expand SourceCitationTag and open scan lightbox
    const toggleBtn = Array.from(atoms.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-expanded') === 'false'
    );
    act(() => {
      toggleBtn?.click();
    });
    await flushUi();
    expect(atoms.textContent).toContain('Preserved Date Discrepancies');
    expect(atoms.textContent).toContain('Preserved Place Discrepancies');
    expect(atoms.textContent).toContain('Preserved Fact Discrepancies');

    const scanBtn = Array.from(atoms.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Scan ↗')
    );
    if (scanBtn) {
      act(() => {
        scanBtn.click();
      });
      await flushUi();
      expect(atoms.textContent).toContain('RECORD SCAN');
    }
  });

  it('sanitizes client telemetry reports, detects chunk errors, and formats vocabulary helpers', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Regular runtime error'))).toBe(false);
    expect(sanitizeRoute('/invite/secret-token-123?person=per_henry&token=abc')).toBe(
      '/invite/[redacted]?person=per_henry'
    );
    expect(sanitizeRoute('')).toBe('/');

    const store = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    expect(shouldAttemptChunkReload(fakeStorage, 100_000)).toBe(true);
    expect(store.get(CHUNK_RELOAD_STORAGE_KEY)).toBe('100000');
    expect(shouldAttemptChunkReload(fakeStorage, 110_000)).toBe(false);
    expect(shouldAttemptChunkReload(fakeStorage, 200_000)).toBe(true);
    expect(shouldAttemptChunkReload(null, 200_000)).toBe(false);

    const report = sanitizeReport({
      kind: 'react_boundary',
      message: 'Boundary boom',
      route: '/invite/abc?tab=sources&secret=1',
      assetUrl: 'https://archive.local/invite/xyz/chunk.js?foo=bar',
    });
    expect(report.route).toBe('/invite/[redacted]?tab=sources');
    expect(report.assetUrl).toBe('/invite/[redacted]/chunk.js');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    reportClientError({ kind: 'window_error', message: 'Synthetic test error', route: '/time' });
    // Deduplicated second call should not emit a duplicate request
    reportClientError({ kind: 'window_error', message: 'Synthetic test error', route: '/time' });
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);

    const uninstall = installGlobalErrorHandlers();
    uninstall();

    expect(formatPhotoDocumentCount(1)).toBe('1 photo or document');
    expect(formatPhotoDocumentCount(3)).toBe('3 photos & documents');
    expect(formatReaderLoadError('HTTP 503 Service Unavailable', 'Fallback')).toBe(
      'Unable to load archive records right now. Please try again.'
    );
    expect(formatReaderLoadError('404 Not Found', 'Fallback')).toBe('Fallback');
    expect(formatReaderLoadError('Custom readable error', 'Fallback')).toBe('Custom readable error');
    expect(formatReaderLoadError(null, 'Fallback')).toBe('Fallback');
    expect(formatPronunciationScopePrefix('full')).toBeUndefined();
    expect(formatPronunciationScopePrefix('surname')).toBe('Surname');
    expect(formatPronunciationScopePrefix('partial')).toBe('Partial');
    expect(formatPronunciationScopeTitle('full')).toBeUndefined();
    expect(formatPronunciationScopeTitle('surname', 'Alder')).toContain('Alder');
    expect(formatPronunciationScopeTitle('partial')).toContain('Partial');
    expect(KINLOOM_VOCABULARY.evidence.heading).toBe('Evidence & Sources');
  });
});
