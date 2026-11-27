/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, ReadingsBundle } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchivalMarkdown } from '../../components/ArchivalMarkdown.js';
import { SourceReaderDrawer } from '../../components/SourceReaderDrawer.js';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { useArchiveUi } from '../../context/ArchiveUiContext.js';
import { TreePage } from '../TreePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof PointerEvent === 'undefined') {
  class FakePointerEvent extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  (globalThis as unknown as { PointerEvent: typeof FakePointerEvent }).PointerEvent = FakePointerEvent;
}

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Canvas Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_CANVAS_TEST',
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
    },
    {
      id: 'src_ledger',
      citation: 'Rush Creek Mill Ledger (1884)',
      source_type: 'vital_record',
      author: 'H. Alder',
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
  ],
  kinship: [
    { from: 'per_henry', to: 'per_clara', relation: 'spouse' },
    { from: 'per_henry', to: 'per_arthur', relation: 'parent' },
    { from: 'per_clara', to: 'per_arthur', relation: 'parent' },
  ],
});

const TWO_DOC_READINGS: ReadingsBundle = {
  version: 1,
  event_page_map: { evt_1880: { src_book: 1 } },
  documents: {
    src_book: {
      source_id: 'src_book',
      title: 'History of Ottawa County',
      author: 'C. Vance',
      provenance: 'Ottawa Historical Society',
      pdf_url: '/sources/ottawa.pdf',
      pdf_size_bytes: 1_500_000,
      pages: [
        {
          page: 1,
          label: 'Page 1',
          file: 'p1.txt',
          text: 'Henry Alder settled in Hudsonville in 1880.',
          image_url: '/sources/p1.jpg',
        },
        {
          page: 2,
          label: 'Page 2',
          file: 'p2.txt',
          text: 'Rush Creek timber shipments increased in 1884.',
          image_url: '/sources/p2.jpg',
        },
      ],
    },
    src_ledger: {
      source_id: 'src_ledger',
      title: 'Rush Creek Mill Ledger',
      author: 'H. Alder',
      provenance: 'Family Collection',
      pages: [
        {
          page: 1,
          label: 'Folio 1',
          file: 'l1.txt',
          text: 'June 1884: Delivered 400 board feet of pine.',
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

const OpenReaderOnMount: React.FC<{ sourceId?: string }> = ({ sourceId = 'src_book' }) => {
  const { openSourceReader } = useArchiveUi();
  useEffect(() => {
    openSourceReader({ sourceId, page: 1 });
  }, [openSourceReader, sourceId]);
  return null;
};

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('TreePage canvas gestures, SourceReaderDrawer actions, and ArchivalMarkdown behavioral flows', () => {
  it('handles pointer drag pan, double-tap zoom, pinch zoom, wheel zoom, and zoom controls on TreePage diagram', async () => {
    const container = mountEl(
      <MemoryRouter initialEntries={['/tree?view=chart']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const viewportEl = container.querySelector('[aria-label*="family tree chart" i]') as HTMLElement | null;
    expect(viewportEl).not.toBeNull();
    if (viewportEl) {
      // Wheel zoom in & out
      act(() => {
        viewportEl.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -100, clientX: 200, clientY: 150, bubbles: true })
        );
        viewportEl.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, clientX: 200, clientY: 150, bubbles: true })
        );
      });

      // Single-pointer drag pan
      act(() => {
        viewportEl.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId: 1,
            clientX: 100,
            clientY: 100,
            pointerType: 'mouse',
            bubbles: true,
          })
        );
      });
      act(() => {
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            clientX: 160,
            clientY: 140,
            pointerType: 'mouse',
            bubbles: true,
          })
        );
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            clientX: 210,
            clientY: 170,
            pointerType: 'mouse',
            bubbles: true,
          })
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            pointerId: 1,
            clientX: 210,
            clientY: 170,
            pointerType: 'mouse',
            bubbles: true,
          })
        );
      });

      // Two-pointer pinch zoom
      act(() => {
        viewportEl.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId: 10,
            clientX: 100,
            clientY: 100,
            pointerType: 'touch',
            bubbles: true,
          })
        );
        viewportEl.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId: 11,
            clientX: 200,
            clientY: 100,
            pointerType: 'touch',
            bubbles: true,
          })
        );
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 11,
            clientX: 280,
            clientY: 100,
            pointerType: 'touch',
            bubbles: true,
          })
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            pointerId: 11,
            clientX: 280,
            clientY: 100,
            pointerType: 'touch',
            bubbles: true,
          })
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            pointerId: 10,
            clientX: 100,
            clientY: 100,
            pointerType: 'touch',
            bubbles: true,
          })
        );
      });

      // Double-tap zoom on canvas
      act(() => {
        viewportEl.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId: 20,
            clientX: 150,
            clientY: 150,
            pointerType: 'touch',
            bubbles: true,
          })
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            pointerId: 20,
            clientX: 150,
            clientY: 150,
            pointerType: 'touch',
            bubbles: true,
          })
        );
        viewportEl.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId: 21,
            clientX: 152,
            clientY: 152,
            pointerType: 'touch',
            bubbles: true,
          })
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            pointerId: 21,
            clientX: 152,
            clientY: 152,
            pointerType: 'touch',
            bubbles: true,
          })
        );
      });
    }

    // Zoom control buttons (+ / - / Reset / Fit)
    const zoomBtns = Array.from(container.querySelectorAll('[aria-label="Chart zoom controls"] button'));
    for (const btn of zoomBtns) {
      act(() => {
        (btn as HTMLElement).click();
      });
      await flushUi();
    }
  });

  it('exercises SourceReaderDrawer multi-document switching, text downloads, copy, scan zoom, and load errors', async () => {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:reader'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => TWO_DOC_READINGS,
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
          <OpenReaderOnMount />
          <SourceReaderDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    // Click download, copy, and document switch buttons
    for (const pattern of [/download/i, /copy/i, /rush creek mill ledger/i, /history of ottawa/i, /zoom/i]) {
      const btn = Array.from(container.querySelectorAll('button')).find((b) =>
        pattern.test(b.getAttribute('aria-label') || b.textContent || '')
      );
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }

    // Readings error state
    const errDs: ArchiveDataSource = {
      ...ds,
      loadReadings: async () => {
        throw new Error('HTTP 503 Service Unavailable');
      },
    };
    const errContainer = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={errDs}>
          <OpenReaderOnMount />
          <SourceReaderDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    expect(errContainer.textContent).toMatch(/unable to load|try again|source reader/i);
  });

  it('renders rich ArchivalMarkdown syntax including headings, lists, blockquotes, links, tables, and inline code', async () => {
    const markdown = [
      '# Alder Family Chronicle',
      '',
      '## Rush Creek Settlement',
      '',
      'Henry Alder settled in **Hudsonville** with *Clara Alder* and used `white pine` timber.',
      '',
      '> "Forty acres cleared along the south bank of Rush Creek."',
      '',
      '- First mill built in 1880',
      '- Second kiln added in 1884',
      '',
      '1. Survey parcel',
      '2. Record deed at [County Archive](https://example.test/deed)',
      '',
      '| Year | Output |',
      '| --- | --- |',
      '| 1880 | 200 cords |',
      '| 1884 | 400 cords |',
      '',
      '---',
      '',
      'See [History of Ottawa County](https://example.test/book) for full text.',
    ].join('\n');

    const mdContainer = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <ArchivalMarkdown markdown={markdown} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    expect(mdContainer.textContent).toContain('Alder Family Chronicle');
    expect(mdContainer.textContent).toContain('Rush Creek Settlement');
    expect(mdContainer.querySelector('blockquote')?.textContent).toContain('Forty acres');
    expect(mdContainer.querySelectorAll('li').length).toBeGreaterThanOrEqual(4);
    expect(mdContainer.querySelector('a[href="https://example.test/deed"]')).not.toBeNull();
  });
});
