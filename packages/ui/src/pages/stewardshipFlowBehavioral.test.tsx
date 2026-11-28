/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveCapabilities,
  ArchiveDataSource,
  KinloomSiteConfig,
  RevisionRecord,
} from '@kinloom/core';
import {
  asBatchId,
  asRevisionId,
  compileArchive,
  parseKinloomConfig,
  UNVERIFIED_TREE_SOURCE_ID,
} from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpWikiDataSource } from '../adapters/httpWikiDataSource.js';
import { EvidenceLegend } from '../components/EvidenceLegend.js';
import { EpistemicTierBadge, StewardReviewBadge } from '../components/wiki/WikiBadges.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { EvidencePage } from './EvidencePage.js';
import { PersonPage } from './PersonPage.js';
import { RecentChangesPage } from './RecentChangesPage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Barton Stewardship Archive',
    familyName: 'Barton',
    gedcomSourceName: 'BARTON_STEWARD_TEST',
  },
});

const { bundle: STEWARD_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  places: [
    {
      id: 'plc_oxford',
      slug: 'oxford-ma',
      name: 'Oxford',
      full_name: 'Oxford, Worcester County, Massachusetts',
      place_type: 'town',
      parent_id: null,
      lat: 42.11,
      lng: -71.86,
    },
  ],
  sources: [
    {
      id: 'src_census_1880',
      citation: '1880 U.S. Federal Census, Worcester County, MA',
      source_type: 'census',
      has_primary_source: true,
    },
    {
      id: 'src_county_hist',
      citation: 'History of Worcester County (1889)',
      source_type: 'county_history',
      has_primary_source: true,
    },
    {
      id: UNVERIFIED_TREE_SOURCE_ID,
      citation: 'Imported family tree entry',
      source_type: 'unverified_tree_entry',
      has_primary_source: false,
    },
  ],
  people: [
    {
      id: 'per_clara',
      slug: 'clara-barton',
      full_name: 'Clara Barton',
      given_name: 'Clara',
      surname: 'Barton',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1821-12-25',
      death_edtf: '1912-04-12',
      portrait_url: null,
    },
    {
      id: 'per_sparse',
      slug: 'stephen-barton',
      full_name: 'Stephen Barton',
      given_name: 'Stephen',
      surname: 'Barton',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1774',
      death_edtf: '1862',
      portrait_url: null,
    },
    {
      id: 'per_living_redacted',
      slug: 'living-descendant',
      full_name: 'Living',
      given_name: 'Living',
      surname: 'Barton',
      alt_names: [],
      sex: 'U',
      is_living: true,
      lineage_group: 'descendant',
      birth_edtf: '',
      death_edtf: '',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_1880_a',
      title: '1880 U.S. Federal Census',
      category: 'census',
      scope: 'family',
      event_kind: 'residence_anchor',
      edtf_date: '1880-06-01',
      place_id: 'plc_oxford',
      summary: 'Enumerated in Oxford.',
      participants: [{ person_id: 'per_clara', role: 'subject' }],
      sources: [{ source_id: 'src_census_1880', confidence: 'high', citation_detail: 'Sheet 4B' }],
    },
    {
      id: 'evt_1880_b',
      title: '1880 Census Household',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1880-06-15',
      place_id: 'plc_oxford',
      summary: 'Duplicate listing from index.',
      participants: [{ person_id: 'per_clara', role: 'subject' }],
      sources: [{ source_id: 'src_county_hist', confidence: 'high' }],
    },
    {
      id: 'evt_1889_hist',
      title: '1889 Red Cross Relief Report',
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: '1889-06-05',
      place_id: 'plc_oxford',
      summary: 'Led flood relief.',
      participants: [{ person_id: 'per_clara', role: 'subject' }],
      sources: [{ source_id: 'src_county_hist', confidence: 'high' }],
    },
    {
      id: 'evt_sparse_uncited',
      title: 'Uncited Oxford Farm Note',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1840',
      place_id: 'plc_oxford',
      summary: 'Remembered in family oral tradition.',
      participants: [{ person_id: 'per_sparse', role: 'subject' }],
      sources: [{ source_id: UNVERIFIED_TREE_SOURCE_ID, confidence: 'low' }],
    },
  ],
  kinship: [],
  media: [],
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

function makeDataSource(
  capabilities: ArchiveCapabilities,
  overrides: Partial<ArchiveDataSource> = {}
): ArchiveDataSource {
  return {
    loadArchive: async () => ({ bundle: STEWARD_BUNDLE, etag: '"r1"', notModified: false }),
    loadReadings: async () => null,
    loadMediaChecklist: async () => [],
    getSession: async () => ({
      session: {
        authenticated: capabilities.canEdit || capabilities.hasTalk,
        principal_kind: capabilities.canEdit ? 'user' : capabilities.hasTalk ? 'invite_viewer' : 'anonymous',
        displayName: capabilities.canEdit ? 'Archive Steward' : undefined,
        role: capabilities.canEdit ? 'editor' : undefined,
      },
      capabilities,
    }),
    ...overrides,
  };
}

const LocationReadout: React.FC = () => {
  const loc = useLocation();
  return <output data-testid="loc">{`${loc.pathname}${loc.search}`}</output>;
};

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('Issue #69 stewardship flows: EvidenceLegend, uncited CTA, completeness, Field Reports, and Steward Review Stamps', () => {
  it('renders EvidenceLegend, EpistemicTierBadge, and StewardReviewBadge cleanly', async () => {
    const container = mountEl(
      <MemoryRouter>
        <EvidenceLegend showRegistryLink />
        <EpistemicTierBadge tier="cited" />
        <EpistemicTierBadge tier="inferred" />
        <EpistemicTierBadge tier="open_question" label="Discrepancy (2)" />
        <StewardReviewBadge
          review={{
            target_kind: 'revision',
            target_id: '12',
            reviewer_id: 'steward@example.test',
            reviewer_name: 'Archive Steward',
            note: 'Checked census image',
            reviewed_at: '2026-06-01T14:30:00Z',
          }}
        />
        <StewardReviewBadge
          review={{
            target_kind: 'batch',
            target_id: 'batch_1',
            reviewer_id: 'steward@example.test',
            reviewer_name: 'Second Steward',
            note: null,
            reviewed_at: '2026-06-02T14:30:00Z',
          }}
        />
      </MemoryRouter>
    );
    await flushUi();

    expect(container.textContent).toContain('Cited');
    expect(container.textContent).toContain('Family memory');
    expect(container.textContent).toContain('Discrepancy (2)');
    expect(container.textContent).toContain('Reviewed by Archive Steward');

    const toggleBtn = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null;
    expect(toggleBtn?.textContent).toContain('How we weigh evidence');
    act(() => {
      toggleBtn?.click();
    });
    await flushUi();

    expect(toggleBtn?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Family memory / Inferred');
    expect(container.textContent).toContain('Discrepancy / Open question');
    expect(container.textContent).toContain('Inspect full Source Registry →');
  });

  it('activates clickable uncited filter CTA on EvidencePage, syncs URL params, filters entries, and clears back to registry', async () => {
    const ds = makeDataSource({
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: false,
      hasTalk: false,
      canManageSite: false,
    });

    const container = mountEl(
      <MemoryRouter initialEntries={['/evidence']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={ds}>
          <Routes>
            <Route
              path="/evidence"
              element={
                <>
                  <LocationReadout />
                  <EvidencePage />
                </>
              }
            />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const gapBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /1 entry needing citation/i.test(b.textContent || '')
    );
    expect(gapBtn).toBeDefined();
    expect(gapBtn?.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      gapBtn?.click();
    });
    await flushUi();

    expect(container.querySelector('[data-testid="loc"]')?.textContent).toBe(
      '/evidence?tab=citations&filter=uncited'
    );
    expect(gapBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Filtered to 1 entry needing primary citation');
    expect(container.textContent).toContain('Uncited Oxford Farm Note');
    expect(container.textContent).not.toContain('Source Registry (');

    const searchInput = container.querySelector(
      'input[aria-label="Filter uncited entries by person or event"]'
    ) as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    if (searchInput) {
      setInputValue(searchInput, 'NoSuchAncestor');
      await flushUi();
      expect(container.textContent).toContain('No uncited entries match that filter.');
      setInputValue(searchInput, 'Stephen Barton');
      await flushUi();
      expect(container.textContent).toContain('Uncited Oxford Farm Note');
    }

    const showFullBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /show full source registry/i.test(b.textContent || '')
    );
    act(() => {
      showFullBtn?.click();
    });
    await flushUi();
    expect(container.querySelector('[data-testid="loc"]')?.textContent).toBe('/evidence?tab=citations');
    expect(container.textContent).toContain('Source Registry (');

    // Initial load with ?filter=uncited defaults tab to citations, and switching to Discrepancies clears filter
    const deepLinkEl = mountEl(
      <MemoryRouter initialEntries={['/evidence?filter=uncited']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={ds}>
          <Routes>
            <Route
              path="/evidence"
              element={
                <>
                  <LocationReadout />
                  <EvidencePage />
                </>
              }
            />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    expect(deepLinkEl.textContent).toContain('Filtered to 1 entry needing primary citation');
    const conflictsTab = Array.from(deepLinkEl.querySelectorAll('[role="tab"]')).find((t) =>
      /discrepancies/i.test(t.textContent || '')
    ) as HTMLElement | undefined;
    act(() => {
      conflictsTab?.click();
    });
    await flushUi();
    expect(deepLinkEl.querySelector('[data-testid="loc"]')?.textContent).toBe('/evidence?tab=conflicts');
  });

  it('shows subtle completeness chips and role-aware invite strips on PersonPage while hiding them for redacted living placeholders', async () => {
    const editorDs = makeDataSource({
      canEdit: true,
      canUploadMedia: true,
      hasRevisionHistory: true,
      hasTalk: true,
      canManageSite: false,
    });

    const sparseEl = mountEl(
      <MemoryRouter initialEntries={['/person/stephen-barton']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={editorDs}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    expect(sparseEl.textContent).toContain('Archival completeness: Oral Seed');
    expect(sparseEl.textContent).toContain('This profile is an oral seed.');
    expect(sparseEl.textContent).toContain('Edit Profile');
    expect(sparseEl.textContent).toContain('Add Photo');

    const editProfileInviteBtn = Array.from(sparseEl.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === 'Edit Profile'
    );
    act(() => {
      editProfileInviteBtn?.click();
    });
    await flushUi();
    const addPhotoInviteBtn = Array.from(sparseEl.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === 'Add Photo'
    );
    act(() => {
      addPhotoInviteBtn?.click();
    });
    await flushUi();

    const talkOnlyDs = makeDataSource({
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: false,
      hasTalk: true,
      canManageSite: false,
    });
    const talkEl = mountEl(
      <MemoryRouter initialEntries={['/person/stephen-barton']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={talkOnlyDs}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    expect(talkEl.textContent).toContain('Share a Family Note');
    expect(talkEl.textContent).not.toContain('Edit Profile');
    const shareNoteBtn = Array.from(talkEl.querySelectorAll('button')).find((b) =>
      /share a family note/i.test(b.textContent || '')
    );
    act(() => {
      shareNoteBtn?.click();
    });
    await flushUi();

    const readOnlyDs = makeDataSource({
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: false,
      hasTalk: false,
      canManageSite: false,
    });
    const readOnlyEl = mountEl(
      <MemoryRouter initialEntries={['/person/stephen-barton']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={readOnlyDs}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    expect(readOnlyEl.textContent).toContain('Oral Seed');
    expect(readOnlyEl.textContent).not.toContain('This profile is an oral seed.');

    const wellDocEl = mountEl(
      <MemoryRouter initialEntries={['/person/clara-barton']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={editorDs}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    expect(wellDocEl.textContent).toContain('Well-Documented');
    expect(wellDocEl.textContent).not.toContain('This profile is an oral seed.');
    expect(wellDocEl.textContent).toContain('How we weigh evidence');

    const livingEl = mountEl(
      <MemoryRouter initialEntries={['/person/living-descendant']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={editorDs}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    expect(livingEl.textContent).not.toContain('Archival completeness');
  });

  it('renders Research Field Reports, fixed empty copy, duplicate-event warnings, Raw JSON toggle, and Steward Review Stamps on RecentChangesPage', async () => {
    const emptyDs = makeDataSource(
      {
        canEdit: true,
        canUploadMedia: true,
        hasRevisionHistory: true,
        hasTalk: true,
        canManageSite: false,
      },
      {
        listRevisions: async () => ({ items: [], next_cursor: null }),
      }
    );

    const emptyEl = mountEl(
      <MemoryRouter initialEntries={['/changes']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={emptyDs}>
          <RecentChangesPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    expect(emptyEl.textContent).toContain('No archival changes have been recorded yet.');
    expect(emptyEl.textContent).not.toContain('No revisions match the active author filter.');

    const batchRevs: RevisionRecord[] = [
      {
        revision_id: asRevisionId(12),
        batch_id: 'batch_census_dup',
        entity_type: 'event',
        entity_id: 'evt_1880_b',
        parent_revision_id: null,
        action: 'create',
        reverted_revision_id: null,
        author_id: 'tok_bot',
        author_name: 'Census Research Agent',
        author_type: 'agent',
        summary: 'Imported 1880 household listing',
        has_primary_source: true,
        before_json: null,
        after_json: {
          title: '1880 Census Household',
          edtf_date: '1880-06-15',
          scope: 'family',
          participants: [{ person_id: 'per_clara', role: 'subject' }],
          sources: [{ source_id: 'src_county_hist', confidence: 'high' }],
        },
        created_at: '2026-06-01T12:00:00Z',
      },
      {
        revision_id: asRevisionId(11),
        batch_id: null,
        entity_type: 'person',
        entity_id: 'per_clara',
        parent_revision_id: asRevisionId(10),
        action: 'update',
        reverted_revision_id: null,
        author_id: 'steward@example.test',
        author_name: 'Archive Steward',
        author_type: 'human',
        summary: 'Added birth date from vital register',
        has_primary_source: true,
        before_json: { birth_edtf: '1821' },
        after_json: { birth_edtf: '1821-12-25' },
        created_at: '2026-06-01T11:00:00Z',
      },
    ];

    let revReviewed = 0;
    let revCleared = 0;
    let batchReviewed = 0;
    let batchCleared = 0;

    const activeDs = makeDataSource(
      {
        canEdit: true,
        canUploadMedia: true,
        hasRevisionHistory: true,
        hasTalk: true,
        canManageSite: false,
      },
      {
        listRevisions: async () => ({ items: batchRevs, next_cursor: null }),
        markRevisionReviewed: async (revisionId) => {
          revReviewed += 1;
          return {
            review: {
              target_kind: 'revision',
              target_id: String(revisionId),
              reviewer_id: 'steward@example.test',
              reviewer_name: 'Archive Steward',
              note: null,
              reviewed_at: '2026-06-02T10:00:00Z',
            },
          };
        },
        clearRevisionReview: async () => {
          revCleared += 1;
        },
        markBatchReviewed: async (batchId) => {
          batchReviewed += 1;
          return {
            review: {
              target_kind: 'batch',
              target_id: batchId,
              reviewer_id: 'steward@example.test',
              reviewer_name: 'Archive Steward',
              note: null,
              reviewed_at: '2026-06-02T10:05:00Z',
            },
          };
        },
        clearBatchReview: async () => {
          batchCleared += 1;
        },
      }
    );

    const feedEl = mountEl(
      <MemoryRouter initialEntries={['/changes']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={activeDs}>
          <RecentChangesPage initialRevisions={batchRevs} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(feedEl.textContent).toContain('Research Field Report: 1 event added');
    expect(feedEl.textContent).toContain('Updated birth date for Clara Barton');
    expect(feedEl.textContent).toContain('Possible duplicate event detected:');
    expect(feedEl.textContent).toContain('Inspect first record →');
    expect(feedEl.textContent).toContain('Inspect second record →');

    // Expand diff and toggle Raw JSON mode
    const diffBtns = Array.from(feedEl.querySelectorAll('button')).filter((b) =>
      /view diff/i.test(b.textContent || '')
    );
    act(() => {
      diffBtns[1]?.click();
    });
    await flushUi();
    expect(feedEl.textContent).toContain('Birth date');
    expect(feedEl.textContent).toContain('Archive ledger reference: r11 · person/per_clara');

    const rawToggleBtn = Array.from(feedEl.querySelectorAll('button')).find((b) =>
      /raw json/i.test(b.textContent || '')
    );
    act(() => {
      rawToggleBtn?.click();
    });
    await flushUi();
    expect(feedEl.textContent).toContain('birth_edtf');

    // Mark batch and standalone revision as reviewed, verify Needs review (0) empty state, then undo
    const reviewBtns = Array.from(feedEl.querySelectorAll('button')).filter(
      (b) => (b.textContent || '').trim() === 'Mark as Reviewed'
    );
    expect(reviewBtns.length).toBeGreaterThanOrEqual(2);
    act(() => {
      reviewBtns[0]?.click();
    });
    await flushUi();
    expect(batchReviewed).toBe(1);
    expect(feedEl.textContent).toContain('Reviewed by Archive Steward');

    const remainingReviewBtn = Array.from(feedEl.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === 'Mark as Reviewed'
    );
    act(() => {
      remainingReviewBtn?.click();
    });
    await flushUi();
    expect(revReviewed).toBe(1);

    const needsReviewBtn = Array.from(feedEl.querySelectorAll('button')).find((b) =>
      /needs review/i.test(b.textContent || '')
    );
    act(() => {
      needsReviewBtn?.click();
    });
    await flushUi();
    expect(feedEl.textContent).toContain('Every recorded change has been marked reviewed by a steward.');

    act(() => {
      needsReviewBtn?.click();
    });
    await flushUi();

    const undoButtons = Array.from(feedEl.querySelectorAll('button')).filter(
      (b) => (b.textContent || '').trim() === 'Undo'
    );
    for (const undoBtn of undoButtons) {
      act(() => {
        undoBtn.click();
      });
      await flushUi();
    }
    expect(batchCleared).toBe(1);
    expect(revCleared).toBe(1);

    // Large batch (> 5 changes) starts collapsed and toggles open on click, and review API errors surface alert banner
    const largeBatchRevs: RevisionRecord[] = Array.from({ length: 6 }, (_, idx) => ({
      revision_id: asRevisionId(100 + idx),
      batch_id: 'batch_large_import',
      entity_type: 'person',
      entity_id: 'per_clara',
      parent_revision_id: asRevisionId(99 + idx),
      action: 'update',
      reverted_revision_id: null,
      author_id: 'tok_bot',
      author_name: 'Bulk Importer',
      author_type: 'agent',
      summary: `Bulk edit #${idx + 1}`,
      has_primary_source: true,
      before_json: { surname: 'Barton' },
      after_json: { surname: `Barton${idx}` },
      created_at: '2026-06-03T12:00:00Z',
    }));

    const failingDs = makeDataSource(
      {
        canEdit: true,
        canUploadMedia: true,
        hasRevisionHistory: true,
        hasTalk: true,
        canManageSite: false,
      },
      {
        markBatchReviewed: async () => {
          throw new Error('Steward service unavailable');
        },
      }
    );
    const largeEl = mountEl(
      <MemoryRouter initialEntries={['/changes']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={STEWARD_BUNDLE} dataSource={failingDs}>
          <RecentChangesPage initialRevisions={largeBatchRevs} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(largeEl.textContent).toContain('Show 6 individual record changes');
    expect(largeEl.textContent).not.toContain('Bulk edit #1');

    const expandBatchBtn = Array.from(largeEl.querySelectorAll('button')).find((b) =>
      /show 6 individual record changes/i.test(b.textContent || '')
    );
    act(() => {
      expandBatchBtn?.click();
    });
    await flushUi();
    expect(largeEl.textContent).toContain('Bulk edit #1');

    const failReviewBtn = Array.from(largeEl.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === 'Mark as Reviewed'
    );
    act(() => {
      failReviewBtn?.click();
    });
    await flushUi();
    expect(largeEl.textContent).toContain('Steward service unavailable');
  });

  it('routes steward review POST and DELETE calls cleanly through HttpWikiDataSource', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const stamp = {
      target_kind: 'revision',
      target_id: '7',
      reviewer_id: 'steward@example.test',
      reviewer_name: 'Archive Steward',
      note: 'Checked scan',
      reviewed_at: '2026-06-02T12:00:00Z',
    };
    const batchStamp = {
      ...stamp,
      target_kind: 'batch',
      target_id: 'batch_42',
    };

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/api/batches/')) {
        return new Response(JSON.stringify({ review: batchStamp }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ review: stamp }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const ds = new HttpWikiDataSource({ apiBaseUrl: 'https://archive.example.test', fetchImpl });
    const revRes = await ds.markRevisionReviewed(asRevisionId(7), 'Checked scan');
    expect(revRes.review.target_id).toBe('7');
    await ds.clearRevisionReview(asRevisionId(7));

    const batchRes = await ds.markBatchReviewed(asBatchId('batch_42'));
    expect(batchRes.review.target_kind).toBe('batch');
    await ds.clearBatchReview(asBatchId('batch_42'));

    expect(calls).toEqual([
      {
        url: 'https://archive.example.test/api/revisions/7/review',
        method: 'POST',
        body: JSON.stringify({ note: 'Checked scan' }),
      },
      {
        url: 'https://archive.example.test/api/revisions/7/review',
        method: 'DELETE',
        body: undefined,
      },
      {
        url: 'https://archive.example.test/api/batches/batch_42/review',
        method: 'POST',
        body: JSON.stringify({}),
      },
      {
        url: 'https://archive.example.test/api/batches/batch_42/review',
        method: 'DELETE',
        body: undefined,
      },
    ]);

    const errDs = new HttpWikiDataSource({
      apiBaseUrl: 'https://archive.example.test',
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Editor required' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(errDs.clearRevisionReview(asRevisionId(7))).rejects.toThrow(/Editor required/);
    await expect(errDs.clearBatchReview(asBatchId('batch_42'))).rejects.toThrow(/Editor required/);
  });
});
