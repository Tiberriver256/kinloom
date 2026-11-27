/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveDataSource,
  EntityPayload,
  KinloomSiteConfig,
  ReadingsBundle,
} from '@kinloom/core';
import { asRevisionId, asSha256Hex, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../adapters/httpWikiDataSource.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { ArchivalMarkdown } from './ArchivalMarkdown.js';
import {
  ArchivalPhotoFrame,
  CoordinatePill,
  DateStamp,
  EmptyStateNotice,
  RelativeAvatarChip,
  ScopeGlyph,
  SourceCitationTag,
} from './Atoms.js';
import { InlineEntityMention } from './InlineEntityMention.js';
import { SourceInspectorDrawer } from './SourceInspectorDrawer.js';
import { SourceReaderDrawer } from './SourceReaderDrawer.js';
import { CreateEntityModal } from './wiki/CreateEntityModal.js';
import { EntityEditDrawer } from './wiki/EntityEditDrawer.js';
import { MediaUploaderModal } from './wiki/MediaUploaderModal.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Citation Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_CITATIONS',
  },
  featuredDocumentId: 'src_ledger',
  pronunciations: {
    alder: {
      phonetic: 'AWL-der',
      ipa: '/ˈɔːldər/',
      audio_file: '/media/alder.mp3',
    },
    zeeland: {
      phonetic: 'ZEE-lund',
      ipa: '/ˈziːlənd/',
    },
  },
});

const { bundle: TEST_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'private',
  places: [
    {
      id: 'pl_zee',
      slug: 'zeeland',
      name: 'Zeeland',
      full_name: 'Zeeland, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: -33.86,
      lng: 151.21,
    },
  ],
  sources: [
    {
      id: 'src_ledger',
      citation: '1880 Ottawa County Township Ledger',
      source_type: 'vital_record',
      author: 'County Clerk',
      repository: 'Michigan State Archives',
      publisher: 'Ottawa County Press',
      has_primary_source: true,
      url: 'https://example.test/ledger-1880',
    },
    {
      id: 'src_diary',
      citation: 'Clara Bramwell Homestead Diary (1885)',
      source_type: 'family_record',
      author: 'Clara Bramwell',
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
      alt_names: ['Hank Alder'],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1852-04-10',
      death_edtf: '1929-11-04',
      portrait_url: '/media/henry.jpg',
    },
    {
      id: 'per_clara',
      slug: 'clara-bramwell',
      full_name: 'Clara Bramwell',
      given_name: 'Clara',
      surname: 'Bramwell',
      alt_names: ['Clara Alder'],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1856',
      death_edtf: '1934',
      portrait_url: null,
    },
    {
      id: 'per_living',
      slug: 'jordan-alder',
      full_name: 'Jordan Alder',
      given_name: 'Jordan',
      surname: 'Alder',
      alt_names: [],
      sex: 'U',
      is_living: true,
      lineage_group: 'descendant',
      birth_edtf: '1994',
      death_edtf: '',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_deed',
      title: 'Homestead Deed Recorded',
      summary: 'Recorded section parcel in Zeeland.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-05-12',
      place_id: 'pl_zee',
      participants: [{ person_id: 'per_henry', role: 'head' }],
      sources: [
        {
          source_id: 'src_ledger',
          confidence: 'high',
          citation_detail: 'Liber 14, Folio 88',
          scan_url: '/sources/deed-88.jpg',
          scan_title: 'Deed Folio 88',
        },
      ],
    },
  ],
  kinship: [{ from: 'per_henry', to: 'per_clara', relation: 'spouse' }],
  media: [
    {
      id: 'med_deed',
      kind: 'document_scan',
      file: '/media/deed-88.jpg',
      caption: 'Homestead Deed Scan',
      date_edtf: '1880',
      person_ids: ['per_henry'],
      source_id: 'src_ledger',
    },
  ],
  narratives: [
    {
      id: 'nar_1',
      slug: 'homestead-years',
      title: 'The Homestead Years',
      summary: 'Settling Zeeland.',
      body_md: 'Henry Alder settled in Zeeland.',
      person_ids: ['per_henry'],
      place_ids: ['pl_zee'],
      event_ids: ['evt_deed'],
      source_ids: ['src_ledger'],
    },
  ],
});

const READINGS: ReadingsBundle = {
  version: 1,
  event_page_map: { evt_deed: { src_ledger: 2 } },
  documents: {
    src_ledger: {
      source_id: 'src_ledger',
      title: '1880 Township Ledger',
      author: 'County Clerk',
      provenance: 'County Vault',
      pdf_url: '/sources/ledger.pdf',
      pdf_size_bytes: 204800,
      pages: [
        {
          page: 1,
          label: 'Folio 87',
          file: 'f87.txt',
          text: 'Boundary survey notes for section four.',
          image_url: '/sources/f87.jpg',
        },
        {
          page: 2,
          label: 'Folio 88',
          file: 'f88.txt',
          text: 'Henry Alder homestead parcel conveyed in May 1880.',
          image_url: '/sources/f88.jpg',
        },
      ],
    },
    src_diary: {
      source_id: 'src_diary',
      title: 'Clara Bramwell Diary',
      author: 'Clara Bramwell',
      provenance: 'Family Trunk',
      pages: [
        {
          page: 1,
          label: 'Entry 1',
          file: 'e1.txt',
          text: 'Planted orchard trees near the creek.',
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

describe('Citations, Source Reader/Inspector, Markdown Popovers, and Wiki Modals behavioral suite', () => {
  it('exercises SourceCitationTag discrepancies, SourceInspectorDrawer, SourceReaderDrawer, and Atoms primitives', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:https://example.test/txt');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: TEST_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => READINGS,
    };

    const sourcesMap = new Map(TEST_BUNDLE.sources.map((s) => [s.id, s]));
    const zeePlace = TEST_BUNDLE.places[0];

    const container = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={TEST_BUNDLE}
          initialReadings={READINGS}
        >
          <div>
            <EmptyStateNotice
              title="Empty Box"
              body="Nothing cataloged"
              action={<button type="button">Add</button>}
            />
            <DateStamp displayDate="" edtf="1880-05" />
            <CoordinatePill place={zeePlace} />
            <CoordinatePill place={undefined} />
            <ScopeGlyph category="weather" />
            <ScopeGlyph category="newspaper" />
            <ScopeGlyph category="macro" />
            <ScopeGlyph category="homestead" />
            <ScopeGlyph category="family_milestone" />
            <ScopeGlyph />
            <RelativeAvatarChip
              name="Clara Bramwell"
              relationship="Spouse"
              tier="Confirmed"
              distanceMiles={0}
              onClick={() => {}}
            />
            <RelativeAvatarChip
              name="Henry Alder"
              relationship="Brother"
              tier="Inferred"
              distanceMiles={12}
              onClick={() => {}}
            />
            <ArchivalPhotoFrame caption="Homestead Barn" photoUrl="/media/barn.jpg" />
            <ArchivalPhotoFrame caption="Missing Portrait" photoUrl={null} />
            <SourceCitationTag
              eventId="evt_deed"
              sourcesById={sourcesMap}
              sources={[
                {
                  source_id: 'src_ledger',
                  confidence: 'high',
                  citation_detail: 'Liber 14, Folio 88',
                  scan_url: '/sources/deed-88.jpg',
                  scan_title: 'Deed Folio 88',
                },
                {
                  source_id: 'src_diary',
                  confidence: 'medium',
                },
              ]}
              alternateDates={[{ edtf_date: '1880-05-14', source_id: 'src_diary', note: 'Diary entry date' }]}
              alternatePlaces={[{ place_name: 'Holland', source_id: 'src_diary', note: 'Recorded nearby' }]}
              factConflicts={[
                { claim: '80 acres vs 40 acres', source_id: 'src_diary', note: 'Acreage split' },
              ]}
            />
            <SourceInspectorDrawer />
            <SourceReaderDrawer />
          </div>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Open & close ArchivalPhotoFrame lightboxes (both real photo and placeholder)
    const photoButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.includes('Homestead Barn') || b.textContent?.includes('Missing Portrait')
    );
    for (const btn of photoButtons) {
      act(() => {
        btn.click();
      });
      const closeBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent === 'Close [Esc]'
      );
      expect(closeBtn).toBeTruthy();
      act(() => {
        closeBtn?.click();
      });
    }

    // View Record Scan lightbox directly from collapsed SourceCitationTag
    const viewScanBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('View Record Scan')
    );
    expect(viewScanBtn).toBeTruthy();
    act(() => {
      viewScanBtn?.click();
    });
    expect(container.textContent).toContain('RECORD SCAN · Deed Folio 88');
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Close [Esc]')
        ?.click();
    });

    // Expand SourceCitationTag and exercise actions + conflict buttons
    const toggleBtn = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    act(() => {
      toggleBtn?.click();
    });
    expect(container.textContent).toContain('Preserved Date Discrepancies');
    expect(container.textContent).toContain('Preserved Place Discrepancies');
    expect(container.textContent).toContain('Preserved Fact Discrepancies');

    // Copy bibliographic string
    const copyCitationBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Copy'
    );
    await act(async () => {
      copyCitationBtn?.click();
    });
    expect(writeText).toHaveBeenCalled();

    // Open Scan from expanded citation item
    const itemScanBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Scan ↗')
    );
    act(() => {
      itemScanBtn?.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close record scan lightbox"]')?.click();
    });

    // Click discrepancy inline source buttons -> opens SourceInspectorDrawer
    for (const inlineBtn of container.querySelectorAll<HTMLButtonElement>('button')) {
      if (inlineBtn.textContent?.includes('Clara Bramwell Homestead Diary')) {
        act(() => {
          inlineBtn.click();
        });
      }
    }

    // Click Inspect Source -> on src_ledger
    const inspectBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Inspect Source')
    );
    act(() => {
      inspectBtn?.click();
    });
    await flushUi();
    expect(container.textContent).toContain('Cited Claim');

    // Copy inside SourceInspectorDrawer + toggle Preview Scan
    const inspectorCopy = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Copy Citation')
    );
    await act(async () => {
      inspectorCopy?.click();
    });
    const previewScan = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Preview Record Scan')
    );
    act(() => {
      previewScan?.click();
    });
    expect(container.querySelector('figure img')).toBeTruthy();

    // Open SourceReaderDrawer directly from SourceInspectorDrawer
    const openReaderFromInspector = [...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent?.includes('Open Source Reader')
    );
    act(() => {
      openReaderFromInspector?.click();
    });
    await flushUi();

    // Exercise SourceReaderDrawer: view modes, pagination, keyboard nav, search, copy & downloads
    const splitBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Side-by-Side'
    );
    const scanModeBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Original Scan'
    );
    const textModeBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Text'
    );
    act(() => {
      splitBtn?.click();
    });
    act(() => {
      scanModeBtn?.click();
    });
    // Zoom scan image if zoom button rendered
    const zoomScanBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.getAttribute('aria-label')?.toLowerCase().includes('zoom')
    );
    if (zoomScanBtn) {
      act(() => {
        zoomScanBtn.click();
      });
      const closeZoom = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.getAttribute('aria-label')?.toLowerCase().includes('close zoomed')
      );
      act(() => {
        closeZoom?.click();
      });
    }
    act(() => {
      textModeBtn?.click();
    });

    // Previous / Next page & ArrowLeft / ArrowRight
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')?.click();
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    const pageSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Select transcription page"]'
    );
    if (pageSelect) {
      setFieldValue(pageSelect, '1');
    }

    // Search within document
    const searchInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search within primary source transcription"]'
    );
    if (searchInput) {
      setFieldValue(searchInput, 'survey');
      expect(container.textContent).toContain('matching page');
    }

    // Copy Full Text (both resolved and rejected) & Download buttons
    const copyFullBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes('Copy All') || b.textContent?.includes('Copy Text')
    );
    if (copyFullBtn) {
      await act(async () => {
        copyFullBtn.click();
      });
      writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
      await act(async () => {
        copyFullBtn.click();
      });
    }
    for (const dlBtn of [...container.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
      b.textContent?.includes('Download')
    )) {
      act(() => {
        dlBtn.click();
      });
    }

    // Tablist keyboard navigation across source collections
    const tablist = container.querySelector<HTMLElement>('[role="tablist"][aria-label="Source collections"]');
    if (tablist) {
      act(() => {
        tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });
    }

    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
  });

  it('exercises ArchivalMarkdown blocks, CitationPopover hover/focus/pin/Escape, and InlineEntityMention outside router', async () => {
    vi.useFakeTimers();
    const onInspectSource = vi.fn();
    const onOpenMedia = vi.fn();
    const sourcesById = new Map(TEST_BUNDLE.sources.map((s) => [s.id, s]));
    const peopleById = new Map(TEST_BUNDLE.people.map((p) => [p.id, p]));
    const placesById = new Map(TEST_BUNDLE.places.map((p) => [p.id, p]));

    const markdown = [
      '## Pioneer Settlement',
      '### Section Four Survey',
      '> Quoted ledger note for **Henry Alder** and __Clara Bramwell__ with `folio-88`',
      '- Unordered item with *italic* and _emphasis_ and [Archive Link](https://example.test/doc)',
      '- Unsafe link [Ignored](javascript:void(0)) and living [[person:per_living]]',
      '1. Ordered item citing [[person:per_henry|Henry]] in [[place:pl_zee]] [^src_ledger|med_deed]',
      '',
      'Clara Bramwell also visited Zeeland [^src_diary] and unknown [^src_missing].',
    ].join('\n');

    const container = mountEl(
      <MemoryRouter>
        <ArchivalMarkdown
          markdown={markdown}
          sourcesById={sourcesById}
          mediaItems={TEST_BUNDLE.media}
          events={TEST_BUNDLE.events}
          subjectPersonId="per_henry"
          peopleById={peopleById}
          placesById={placesById}
          pronunciations={SITE_CONFIG.pronunciations}
          linkedPersonIds={['per_henry', 'per_clara', 'per_living']}
          linkedPlaceIds={['pl_zee']}
          onInspectSource={onInspectSource}
          onOpenMedia={onOpenMedia}
        />
      </MemoryRouter>
    );

    expect(container.querySelector('h4')?.textContent).toContain('Pioneer Settlement');
    expect(container.querySelector('h5')?.textContent).toContain('Section Four Survey');
    expect(container.querySelector('blockquote')).toBeTruthy();
    expect(container.querySelector('ul')).toBeTruthy();
    expect(container.querySelector('ol')).toBeTruthy();
    expect(container.textContent).not.toContain('Jordan Alder');

    const footnoteButtons = container.querySelectorAll<HTMLButtonElement>('sup button');
    expect(footnoteButtons.length).toBeGreaterThanOrEqual(2);
    const firstFootnote = footnoteButtons[0];

    // Hover open -> leave delayed close
    act(() => {
      firstFootnote.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
    act(() => {
      firstFootnote.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      vi.advanceTimersByTime(200);
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    // Focus open -> blur outside closes
    act(() => {
      firstFootnote.focus();
      firstFootnote.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
    act(() => {
      firstFootnote.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })
      );
    });

    // Click to pin -> Escape inside popover restores focus & closes; outside mousedown closes
    act(() => {
      firstFootnote.click();
    });
    const popDialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(popDialog).toBeTruthy();
    const popButtons = popDialog?.querySelectorAll<HTMLButtonElement>('button') ?? [];
    if (popButtons[0]) {
      act(() => {
        popButtons[0].focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    }
    act(() => {
      firstFootnote.click();
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // InlineEntityMention rendered outside Router context (uses plain <a> fallback) + hover/focus/Escape
    const standalone = mountEl(
      <div>
        <InlineEntityMention
          kind="person"
          person={TEST_BUNDLE.people[0]}
          displayText="Henry Alder"
          pronunciations={SITE_CONFIG.pronunciations}
        />
        <InlineEntityMention
          kind="place"
          place={TEST_BUNDLE.places[0]}
          displayText="Zeeland"
          pronunciations={SITE_CONFIG.pronunciations}
        />
        <InlineEntityMention kind="person" person={TEST_BUNDLE.people[2]} displayText="Secret Living" />
      </div>
    );
    expect(standalone.textContent).not.toContain('Secret Living');
    const anchors = standalone.querySelectorAll<HTMLAnchorElement>('a');
    expect(anchors.length).toBe(2);
    act(() => {
      anchors[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('Henry Alder');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    act(() => {
      anchors[1].focus();
      anchors[1].dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('Town');
    act(() => {
      anchors[1].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      vi.advanceTimersByTime(200);
    });
  });

  it('exercises EntityEditDrawer across all entity types, CreateEntityModal link/partial error, and MediaUploaderModal', async () => {
    let deleteShouldFail = true;
    let edgeCreateShouldFail = true;
    let uploadAttempt = 0;

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: TEST_BUNDLE, etag: '"r2"', notModified: false }),
      loadReadings: async () => READINGS,
      getEntity: async (_type, id) => ({
        entity_type: 'person',
        entity_id: id,
        current_revision_id: asRevisionId(3),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-05-01T00:00:00Z',
        entity: TEST_BUNDLE.people[0] as unknown as EntityPayload,
      }),
      updateEntity: async (_type, _id, input) => ({
        ok: true as const,
        entity: input.data,
        revision: {
          revision_id: asRevisionId(4),
          batch_id: null,
          entity_type: 'person',
          entity_id: 'per_henry',
          parent_revision_id: asRevisionId(3),
          action: 'update',
          reverted_revision_id: null,
          author_id: 'admin@example.test',
          author_name: 'Admin',
          author_type: 'human',
          summary: input.summary,
          has_primary_source: true,
          before_json: null,
          after_json: input.data,
          created_at: '2026-05-01T00:00:00Z',
        },
        etag: '"r4"',
      }),
      deleteEntity: async () => {
        if (deleteShouldFail) {
          deleteShouldFail = false;
          throw new Error('Delete temporarily locked');
        }
        return {
          revision: {
            revision_id: asRevisionId(5),
            batch_id: null,
            entity_type: 'person',
            entity_id: 'per_henry',
            parent_revision_id: asRevisionId(4),
            action: 'delete',
            reverted_revision_id: null,
            author_id: 'admin@example.test',
            author_name: 'Admin',
            author_type: 'human',
            summary: 'Removed duplicate',
            has_primary_source: true,
            before_json: null,
            after_json: null,
            created_at: '2026-05-01T00:00:00Z',
          },
          etag: '"r5"',
        };
      },
      createEntity: async (type, input) => {
        if (type === 'kinship_edge' && edgeCreateShouldFail) {
          edgeCreateShouldFail = false;
          throw new Error('Kinship edge conflict');
        }
        return {
          entity: input.data,
          revision: {
            revision_id: asRevisionId(6),
            batch_id: null,
            entity_type: type,
            entity_id: input.entity_id ?? 'new_id',
            parent_revision_id: null,
            action: 'create',
            reverted_revision_id: null,
            author_id: 'admin@example.test',
            author_name: 'Admin',
            author_type: 'human',
            summary: input.summary,
            has_primary_source: true,
            before_json: null,
            after_json: input.data,
            created_at: '2026-05-01T00:00:00Z',
          },
          etag: '"r6"',
        };
      },
      uploadMedia: async () => {
        uploadAttempt += 1;
        if (uploadAttempt === 1) {
          throw new Error('Transient R2 timeout');
        }
        if (uploadAttempt === 2) {
          throw new ApiClientError(422, 'LIVING_MEDIA_FORBIDDEN', 'Living media forbidden');
        }
        return {
          deduplicated: false,
          url: '/media/uploaded.jpg',
          media: {
            id: 'med_new',
            kind: 'family_photo',
            file: '/media/uploaded.jpg',
            caption: 'Uploaded Photo',
            sha256: asSha256Hex('a'.repeat(64)),
          },
          revision: {
            revision_id: asRevisionId(7),
            batch_id: null,
            entity_type: 'media',
            entity_id: 'med_new',
            parent_revision_id: null,
            action: 'create',
            reverted_revision_id: null,
            author_id: 'admin@example.test',
            author_name: 'Admin',
            author_type: 'human',
            summary: 'Uploaded photo',
            has_primary_source: true,
            before_json: null,
            after_json: null,
            created_at: '2026-05-01T00:00:00Z',
          },
          etag: '"r7"',
        };
      },
    };

    const onCloseEdit = vi.fn();
    const onDeleted = vi.fn();
    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={ds} initialBundle={TEST_BUNDLE}>
          <div>
            <EntityEditDrawer
              open
              initialSection="pronunciation"
              entityType="person"
              entityId="per_henry"
              revisionId={2}
              initialData={TEST_BUNDLE.people[0] as unknown as EntityPayload}
              title="Henry Alder"
              onClose={onCloseEdit}
              onDeleted={onDeleted}
            />
            <EntityEditDrawer
              open
              entityType="place"
              entityId="pl_zee"
              revisionId={1}
              initialData={TEST_BUNDLE.places[0] as unknown as EntityPayload}
              onClose={() => {}}
            />
            <EntityEditDrawer
              open
              entityType="event"
              entityId="evt_deed"
              revisionId={1}
              initialData={TEST_BUNDLE.events[0] as unknown as EntityPayload}
              onClose={() => {}}
            />
            <EntityEditDrawer
              open
              entityType="narrative"
              entityId="nar_1"
              revisionId={1}
              initialData={(TEST_BUNDLE.narratives ?? [])[0] as unknown as EntityPayload}
              onClose={() => {}}
            />
            <EntityEditDrawer
              open
              entityType="source"
              entityId="src_ledger"
              revisionId={1}
              initialData={TEST_BUNDLE.sources[0] as unknown as EntityPayload}
              onClose={() => {}}
            />
          </div>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await new Promise((r) => setTimeout(r, 35));

    // Exercise fields across person, place, event, narrative, and JSON fallback (source)
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="number"]');
    for (const inp of inputs) {
      if (!inp.disabled) {
        setFieldValue(inp, inp.type === 'number' ? '42.88' : 'Updated Value');
      }
    }
    const textareas = container.querySelectorAll<HTMLTextAreaElement>('textarea');
    for (const ta of textareas) {
      if (!ta.disabled) {
        if (ta.value.trim().startsWith('{')) {
          setFieldValue(ta, '{ invalid json');
          setFieldValue(ta, JSON.stringify({ ...TEST_BUNDLE.sources[0], publisher: 'Updated Press' }));
        } else {
          setFieldValue(ta, 'Updated narrative text');
        }
      }
    }

    // Citation radio mode toggle + source select + soft delete error then success on first drawer
    const firstDialog = container.querySelectorAll('dialog')[0];
    const radios = firstDialog.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    if (radios[1]) {
      act(() => {
        radios[1].click();
      });
    }
    if (radios[0]) {
      act(() => {
        radios[0].click();
      });
    }
    const srcSelect = firstDialog.querySelector<HTMLSelectElement>('fieldset select');
    if (srcSelect) {
      setFieldValue(srcSelect, 'src_ledger');
    }

    // Soft delete flow (error then success)
    const openDeleteBtn = [...firstDialog.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) =>
        b.textContent?.toLowerCase().includes('delete') || b.textContent?.toLowerCase().includes('remove')
    );
    if (openDeleteBtn) {
      act(() => {
        openDeleteBtn.click();
      });
      const delInputs = firstDialog.querySelectorAll<HTMLInputElement>('input[type="text"]');
      const delSummaryInput = delInputs[delInputs.length - 1];
      if (delSummaryInput) {
        setFieldValue(delSummaryInput, 'Duplicate person record');
      }
      const confirmDelBtn = [...firstDialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.toLowerCase().includes('confirm')
      );
      await act(async () => {
        confirmDelBtn?.click();
      });
      await flushUi();
      await act(async () => {
        confirmDelBtn?.click();
      });
      await flushUi();
    }

    // CreateEntityModal in relativeContext: partial save failure on create_new, then link_existing success
    const modalContainer = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={ds} initialBundle={TEST_BUNDLE}>
          <div>
            <CreateEntityModal
              open
              relativeContext={{
                anchorPersonId: 'per_henry',
                anchorPersonName: 'Henry Alder',
                relation: 'spouse',
              }}
              onClose={() => {}}
            />
            <MediaUploaderModal open defaultPersonId="per_living" onClose={() => {}} />
          </div>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const createDialog = modalContainer.querySelectorAll('dialog')[0];
    const nameInputs = createDialog.querySelectorAll<HTMLInputElement>('input[type="text"]');
    if (nameInputs[0]) {
      setFieldValue(nameInputs[0], 'Martha Vance');
    }
    const summaryInput = nameInputs[nameInputs.length - 1];
    if (summaryInput) {
      setFieldValue(summaryInput, 'Added spouse from marriage register');
    }
    const createForm = createDialog.querySelector('form');
    await act(async () => {
      createForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();
    expect(createDialog.textContent).toContain('Person record saved, but linking failed');

    // Switch to Link existing person tab via keyboard + select Clara Bramwell
    const relTablist = createDialog.querySelector<HTMLElement>('[role="tablist"]');
    act(() => {
      relTablist?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const linkSelect = createDialog.querySelector<HTMLSelectElement>('select');
    if (linkSelect) {
      setFieldValue(linkSelect, 'per_clara');
    }
    await act(async () => {
      createForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();

    // MediaUploaderModal: living warning shown; switch to deceased person, select video/audio/jpeg, retry & complete
    const uploadDialog = modalContainer.querySelectorAll('dialog')[1];
    expect(uploadDialog.textContent).toContain('cannot be attached to living people');
    const selects = uploadDialog.querySelectorAll<HTMLSelectElement>('select');
    if (selects[1]) {
      setFieldValue(selects[1], 'per_henry');
    }
    const fileInput = uploadDialog.querySelector<HTMLInputElement>('input[type="file"]');
    const videoFile = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], 'homestead-tour.mp4', {
      type: 'video/mp4',
    });
    if (fileInput) {
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [videoFile] });
      act(() => {
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    const uploadForm = uploadDialog.querySelector('form');
    await act(async () => {
      uploadForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();
    await new Promise((r) => setTimeout(r, 30));
    await flushUi();

    // Retry #1 -> hits LIVING_MEDIA_FORBIDDEN (rejectedInvalid), then Choose Another File, then succeed
    const retryBtn = [...uploadDialog.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Retry'
    );
    if (retryBtn) {
      await act(async () => {
        retryBtn.click();
      });
      await flushUi();
      await new Promise((r) => setTimeout(r, 30));
      await flushUi();
    }
    const chooseAnother = [...uploadDialog.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Choose Another File'
    );
    if (chooseAnother) {
      act(() => {
        chooseAnother.click();
      });
    }
    const audioFile = new File([new Uint8Array([0x49, 0x44, 0x33, 0x04])], 'oral-history.mp3', {
      type: 'audio/mpeg',
    });
    if (fileInput) {
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [audioFile] });
      act(() => {
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    await act(async () => {
      uploadForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();
    await new Promise((r) => setTimeout(r, 30));
    await flushUi();
  });
});
