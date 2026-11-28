/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ArchiveBundle,
  KinloomSiteConfig,
  MediaItem,
  ReadingsBundle,
  SourceRecord,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { PersonPage } from '../pages/PersonPage.js';
import { PlacePage } from '../pages/PlacePage.js';
import { ArchivalMarkdown } from './ArchivalMarkdown.js';
import {
  FolioMarginaliaRail,
  FolioMarginaliaToggle,
  MARGINALIA_STORAGE_KEY,
  setMarginaliaPreference,
} from './FolioMarginalia.js';
import { SourceInspectorDrawer } from './SourceInspectorDrawer.js';
import { SourceReaderDrawer } from './SourceReaderDrawer.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(HERE, '..');

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Sangamon Synthetic Archive',
    familyName: 'Alder',
    gedcomSourceName: 'SANGAMON_FOLIO_70',
  },
});

const TEST_SOURCES: SourceRecord[] = [
  {
    id: 'src_census_1880',
    citation: '1880 U.S. Federal Census, Sangamon County, Roll 42, Sheet 9.',
    source_type: 'census',
    repository: 'National Archives (NARA)',
  },
  {
    id: 'src_journal_1884',
    citation: 'Harriet Alder Farm Journal (1884).',
    source_type: 'family_memoir',
    repository: 'Sangamon Historical Society',
  },
  {
    id: 'src_plat_1876',
    citation: 'Sangamon County Plat Book (1876), p. 19.',
    source_type: 'county_history',
    repository: 'Illinois State Archives',
  },
];

function buildFolioBundle(): ArchiveBundle {
  const { bundle } = compileArchive({
    siteConfig: SITE_CONFIG,
    mode: 'public',
    places: [
      {
        id: 'pl_springfield',
        slug: 'springfield',
        name: 'Springfield',
        full_name: 'Springfield, Sangamon County, Illinois',
        place_type: 'town',
        parent_id: null,
        lat: 39.78,
        lng: -89.65,
        summary: 'County seat along the Sangamon River valley.',
        sources: [{ source_id: 'src_plat_1876', citation_detail: 'Township map, p. 19', confidence: 'high' }],
      },
    ],
    sources: TEST_SOURCES,
    people: [
      {
        id: 'per_harriet',
        slug: 'harriet-alder',
        full_name: 'Harriet Alder',
        given_name: 'Harriet',
        surname: 'Alder',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1851-03-14',
        death_edtf: '1926-11-02',
        portrait_url: null,
      },
    ],
    events: [
      {
        id: 'evt_1880_census',
        title: '1880 Household Enumeration',
        summary: 'Recorded managing the orchard east of Springfield.',
        event_kind: 'residence_anchor',
        scope: 'family',
        edtf_date: '1880-06-01',
        place_id: 'pl_springfield',
        participants: [{ person_id: 'per_harriet', role: 'head' }],
        sources: [
          {
            source_id: 'src_census_1880',
            citation_detail: 'ED 201, Sheet 9, Line 4',
            confidence: 'high',
            scan_url: '/media/census-1880.jpg',
            scan_title: '1880 Census Sheet 9',
          },
        ],
        alternate_dates: [
          {
            edtf_date: '1880-06-04',
            source_id: 'src_journal_1884',
            note: 'Farm journal notes the enumerator arrived three days later.',
          },
        ],
      },
      {
        id: 'evt_1876_mill',
        title: 'Sangamon Mill Charter',
        summary: 'Local township charter documented in county records.',
        event_kind: 'point_event',
        scope: 'local',
        edtf_date: '1876-04-12',
        place_id: 'pl_springfield',
        participants: [],
        sources: [
          { source_id: 'src_plat_1876', citation_detail: 'Charter ledger p. 19', confidence: 'high' },
        ],
        fact_conflicts: [
          {
            claim: 'Mill capacity listed as 40 bushels/day',
            source_id: 'src_journal_1884',
            note: 'Journal recalls 30 bushels/day.',
          },
        ],
      },
    ],
    kinship: [],
    media: [],
    narratives: [
      {
        id: 'nar_harriet_bio',
        slug: 'harriet-alder-bio',
        kind: 'biography',
        subject_person_id: 'per_harriet',
        title: 'Harriet Alder: Sangamon Years',
        summary: 'Orchard ledgers and federal census records.',
        date_edtf: '1851/1926',
        person_ids: ['per_harriet'],
        place_ids: ['pl_springfield'],
        event_ids: ['evt_1880_census'],
        source_ids: ['src_census_1880', 'src_journal_1884', 'src_plat_1876'],
        body_md: [
          'Harriet managed the orchard during the 1880 federal enumeration.[^src_census_1880]',
          '',
          'Her 1884 journal preserved rainfall totals and orchard yields.[^src_journal_1884]',
        ].join('\n'),
      },
    ],
  });
  return bundle;
}

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

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  window.localStorage.removeItem(MARGINALIA_STORAGE_KEY);
  setMarginaliaPreference(true);
  vi.restoreAllMocks();
});

describe('Folio Marginalia rail, bidirectional highlight, and Heirloom Print CSS (#70)', () => {
  it('aligns Markdown citations per paragraph row, highlights bidirectionally on hover, and triggers actions', () => {
    const sourcesById = new Map<string, SourceRecord>(TEST_SOURCES.map((s) => [s.id, s]));
    const onInspectSource = vi.fn();
    const onReadSource = vi.fn();

    const container = mountEl(
      <ArchivalMarkdown
        markdown={[
          'First paragraph cites census.[^src_census_1880]',
          '',
          'Second paragraph cites journal.[^src_journal_1884]',
        ].join('\n')}
        sourcesById={sourcesById}
        narrativeSourceIds={['src_census_1880', 'src_journal_1884', 'src_plat_1876']}
        readableSourceIds={new Set(['src_journal_1884'])}
        marginaliaMode="folio"
        onInspectSource={onInspectSource}
        onReadSource={onReadSource}
      />
    );

    const rows = [...container.querySelectorAll('.folio-marginalia-row')];
    expect(rows).toHaveLength(2);

    // Row 0 rail has [1] census; Row 1 rail has [2] journal + trailing uncited plat book
    expect(rows[0]?.querySelector('.folio-marginalia-rail')?.textContent).toContain('[1]');
    expect(rows[0]?.querySelector('.folio-marginalia-rail')?.textContent).toContain(
      '1880 U.S. Federal Census'
    );
    expect(rows[1]?.querySelector('.folio-marginalia-rail')?.textContent).toContain('[2]');
    expect(rows[1]?.querySelector('.folio-marginalia-rail')?.textContent).toContain(
      'Harriet Alder Farm Journal'
    );
    expect(rows[1]?.querySelector('.folio-marginalia-rail')?.textContent).toContain(
      'Sangamon County Plat Book'
    );

    // Hover marginalia item -> highlights matching inline [1] footnote ref
    const firstMarginaliaItem = rows[0]?.querySelector<HTMLElement>(
      '[data-marginalia-source-id="src_census_1880"]'
    );
    const firstFootnoteRef = rows[0]?.querySelector<HTMLButtonElement>(
      '[data-citation-source-id="src_census_1880"]'
    );
    expect(firstMarginaliaItem).not.toBeNull();
    expect(firstFootnoteRef).not.toBeNull();

    act(() => {
      firstMarginaliaItem?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(firstFootnoteRef?.classList.contains('is-marginalia-highlighted')).toBe(true);
    expect(firstMarginaliaItem?.classList.contains('is-highlighted')).toBe(true);

    act(() => {
      firstMarginaliaItem?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(firstFootnoteRef?.classList.contains('is-marginalia-highlighted')).toBe(false);

    // Click Inspect and Read Source actions on row 1
    const row1Buttons = [
      ...(rows[1]?.querySelectorAll<HTMLButtonElement>('.folio-marginalia-action-btn') ?? []),
    ];
    const inspectBtn = row1Buttons.find((b) => b.textContent === 'Inspect');
    const readBtn = row1Buttons.find((b) => b.textContent === 'Read Source →');
    act(() => {
      inspectBtn?.click();
      readBtn?.click();
    });
    expect(onInspectSource).toHaveBeenCalledWith('src_journal_1884');
    expect(onReadSource).toHaveBeenCalledWith('src_journal_1884');
  });

  it('renders PersonPage biography and timeline marginalia with discrepancies and persists Marginalia On/Off toggle', () => {
    const bundle = buildFolioBundle();
    const container = mountEl(
      <MemoryRouter initialEntries={['/person/harriet-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
          <SourceInspectorDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const toggleBtn = container.querySelector<HTMLButtonElement>('.marginalia-toggle-btn');
    expect(toggleBtn?.textContent).toBe('Marginalia: On');
    expect(toggleBtn?.getAttribute('aria-pressed')).toBe('true');

    // Biography renders folio marginalia rows
    const bioSection = container.querySelector('section[aria-label="Biography"]');
    expect(bioSection?.querySelectorAll('.folio-marginalia-row').length).toBe(2);

    // Timeline event renders citation call number + numbered Date Discrepancy gloss in marginalia rail
    const timelineCard = container.querySelector('#evt_1880_census');
    const eventRail = timelineCard?.querySelector('.folio-marginalia-rail');
    expect(eventRail?.textContent).toContain('ED 201, Sheet 9, Line 4');
    expect(eventRail?.textContent).toContain('! 1');
    expect(eventRail?.textContent).toContain('Date Discrepancy');
    expect(eventRail?.textContent).toContain('1880-06-04');

    // Clicking Inspect in the timeline rail opens SourceInspectorDrawer
    const inspectBtn = [...(eventRail?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (b) => b.textContent === 'Inspect'
    );
    act(() => {
      inspectBtn?.click();
    });
    expect(container.querySelector('dialog[aria-label="Source Inspector"]')).not.toBeNull();

    // Toggling Marginalia Off collapses rails across both biography and timeline and persists preference
    act(() => {
      toggleBtn?.click();
    });
    expect(toggleBtn?.textContent).toBe('Marginalia: Off');
    expect(toggleBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(window.localStorage.getItem(MARGINALIA_STORAGE_KEY)).toBe('false');
    expect(container.querySelectorAll('.folio-marginalia-rail')).toHaveLength(0);
  });

  it('renders PlacePage Historical Profile and Local History marginalia with toggle', () => {
    const bundle = buildFolioBundle();
    const container = mountEl(
      <MemoryRouter initialEntries={['/place/springfield']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );

    expect(container.querySelector('.marginalia-toggle-btn')?.textContent).toBe('Marginalia: On');

    const rails = [...container.querySelectorAll('.folio-marginalia-rail')];
    expect(rails).toHaveLength(2);
    expect(rails[0]?.textContent).toContain('Township map, p. 19');
    expect(rails[1]?.textContent).toContain('Charter ledger p. 19');
    expect(rails[1]?.textContent).toContain('! 1');
    expect(rails[1]?.textContent).toContain('Fact Discrepancy');
  });

  it('enforces book-grade @page folio margins, running page counters, 38em/33em measure, hyphenation, and responsive marginalia CSS', () => {
    const printCss = readFileSync(resolve(UI_SRC, 'styles/print.css'), 'utf8');
    expect(printCss).toContain('@page {');
    expect(printCss).toContain('margin: 0.85in 0.75in 0.95in 0.75in;');
    expect(printCss).toContain('content: "Page " counter(page) " of " counter(pages);');
    expect(printCss).toContain('@page :first');
    expect(printCss).toContain('color-scheme: light;');
    expect(printCss).toContain('font-variant-numeric: oldstyle-nums;');
    expect(printCss).toContain('max-width: 38em;');
    expect(printCss).toContain('grid-template-columns: minmax(0, 33em) 1.65in;');
    expect(printCss).toContain('column-gap: 0.25in;');
    expect(printCss).toContain('hyphens: auto;');
    expect(printCss).toContain('break-after: avoid;');
    expect(printCss).toContain('break-inside: avoid;');

    const marginaliaCss = readFileSync(resolve(UI_SRC, 'styles/FolioMarginalia.module.css'), 'utf8');
    expect(marginaliaCss).toContain('grid-template-columns: minmax(0, 56ch) 252px;');
    expect(marginaliaCss).toContain('grid-template-columns: minmax(0, 1fr) 240px;');
    expect(marginaliaCss).toContain('@media (max-width: 1023px)');

    const personCss = readFileSync(resolve(UI_SRC, 'pages/PersonPage.module.css'), 'utf8');
    expect(personCss).toContain('max-width: 1240px;');

    const placeCss = readFileSync(resolve(UI_SRC, 'pages/PlacePage.module.css'), 'utf8');
    expect(placeCss).toContain('max-width: 1200px;');
  });

  it('exercises PlacePage photo+marginalia, historical names, decade filters, and marginalia rail actions across Person and Place', () => {
    const { bundle } = compileArchive({
      siteConfig: SITE_CONFIG,
      mode: 'public',
      places: [
        {
          id: 'pl_springfield',
          slug: 'springfield',
          name: 'Springfield',
          full_name: 'Springfield, Sangamon County, Illinois',
          place_type: 'town',
          parent_id: null,
          lat: 39.78,
          lng: -89.65,
          summary: 'County seat along the Sangamon River valley.',
          photo_url: '/media/springfield.jpg',
          photo_caption: 'Springfield square, circa 1880',
          historical_names: [
            { name: 'Calhoun', valid_from: '1821', valid_to: '1832' },
            { name: 'Sangamon Precinct', valid_from: '1832' },
            { name: 'Springfield Town' },
          ],
          sources: [
            {
              source_id: 'src_plat_1876',
              citation_detail: 'Township map, p. 19',
              confidence: 'high',
              scan_url: '/media/plat-1876.jpg',
              scan_title: 'Plat Map 1876',
            },
          ],
        },
      ],
      sources: TEST_SOURCES,
      people: [
        {
          id: 'per_harriet',
          slug: 'harriet-alder',
          full_name: 'Harriet Alder',
          given_name: 'Harriet',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1851-03-14',
          death_edtf: '1926-11-02',
          portrait_url: null,
        },
      ],
      events: [
        {
          id: 'evt_1880_census',
          title: '1880 Household Enumeration',
          summary: 'Recorded managing the orchard east of Springfield.',
          event_kind: 'residence_anchor',
          scope: 'family',
          edtf_date: '1880-06-01',
          place_id: 'pl_springfield',
          participants: [{ person_id: 'per_harriet', role: 'head' }],
          sources: [
            {
              source_id: 'src_census_1880',
              citation_detail: 'ED 201, Sheet 9, Line 4',
              confidence: 'high',
              scan_url: '/media/census-1880.jpg',
              scan_title: '1880 Census Sheet 9',
            },
          ],
          alternate_dates: [
            {
              edtf_date: '1880-06-04',
              source_id: 'src_journal_1884',
              note: 'Farm journal notes the enumerator arrived three days later.',
            },
          ],
        },
        {
          id: 'evt_1876_mill',
          title: 'Sangamon Mill Charter',
          summary: 'Local township charter documented in county records.',
          event_kind: 'point_event',
          scope: 'local',
          edtf_date: '1876-04-12',
          place_id: 'pl_springfield',
          source_url: 'https://archive.example/charter',
          participants: [],
          sources: [
            {
              source_id: 'src_plat_1876',
              citation_detail: 'Charter ledger p. 19',
              confidence: 'high',
              scan_url: '/media/charter-1876.jpg',
              scan_title: 'Charter Ledger Scan',
            },
          ],
          alternate_dates: [
            {
              edtf_date: '1876-04-15',
              source_id: 'src_journal_1884',
              note: 'Journal records charter signing three days later.',
            },
          ],
          fact_conflicts: [
            {
              claim: 'Mill capacity listed as 40 bushels/day',
              source_id: 'src_journal_1884',
              note: 'Journal recalls 30 bushels/day.',
            },
          ],
        },
      ],
      kinship: [],
      media: [
        {
          id: 'med_springfield',
          kind: 'family_photo',
          file: '/media/springfield.jpg',
          caption: 'Springfield square',
          person_ids: [],
        },
      ],
      narratives: [],
    });

    const readings: ReadingsBundle = {
      version: 1,
      documents: {
        src_plat_1876: {
          source_id: 'src_plat_1876',
          title: 'Sangamon County Plat Book (1876)',
          author: 'County Surveyor',
          provenance: 'Illinois State Archives',
          pages: [{ page: 1, label: 'p. 19', file: 'plat19.txt', text: 'Township plat.' }],
        },
        src_census_1880: {
          source_id: 'src_census_1880',
          title: '1880 Census',
          author: 'U.S. Census Bureau',
          provenance: 'National Archives (NARA)',
          pages: [{ page: 1, label: 'Sheet 9', file: 's9.txt', text: 'Harriet Alder.' }],
        },
      },
      event_page_map: {},
    };

    const placeContainer = mountEl(
      <MemoryRouter initialEntries={['/place/springfield']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle} initialReadings={readings}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
          <SourceInspectorDrawer />
          <SourceReaderDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );

    expect(placeContainer.textContent).toContain('Calhoun (1821–1832)');
    expect(placeContainer.textContent).toContain('Sangamon Precinct (1832–present)');
    expect(placeContainer.textContent).toContain('Springfield Town');
    expect(placeContainer.textContent).toContain('Springfield square, circa 1880');
    expect(placeContainer.querySelector('a[href="https://archive.example/charter"]')).not.toBeNull();

    // Exercise Inspect, Read Source, Scan, and Inspect Source buttons across both PlacePage rails
    const placeRailButtons = [
      ...placeContainer.querySelectorAll<HTMLButtonElement>('.folio-marginalia-action-btn'),
    ];
    for (const btn of placeRailButtons) {
      act(() => {
        btn.click();
      });
    }
    expect(placeContainer.querySelector('dialog')).not.toBeNull();

    // Exercise decade filter buttons in PlaceLocalHistorySection
    const decadeButtons = [...placeContainer.querySelectorAll<HTMLButtonElement>('.place-decade-bar button')];
    const btn1870s = decadeButtons.find((b) => b.textContent === '1870s');
    const btnAll = decadeButtons.find((b) => b.textContent === 'All Decades');
    act(() => {
      btn1870s?.click();
      btnAll?.click();
    });
    expect(btnAll?.getAttribute('aria-pressed')).toBe('true');

    // Exercise PersonPage MilestoneStoryCard Read Source, Scan, and Discrepancy buttons
    const personContainer = mountEl(
      <MemoryRouter initialEntries={['/person/harriet-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle} initialReadings={readings}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
          <SourceInspectorDrawer />
          <SourceReaderDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const timelineButtons = [
      ...personContainer.querySelectorAll<HTMLButtonElement>('#evt_1880_census .folio-marginalia-action-btn'),
    ];
    expect(timelineButtons.map((b) => b.textContent)).toEqual([
      'Inspect',
      'Read Source →',
      'Scan',
      'Inspect Source',
    ]);
    for (const btn of timelineButtons) {
      act(() => {
        btn.click();
      });
    }
    expect(personContainer.querySelector('dialog')).not.toBeNull();
  });

  it('covers FolioMarginaliaRail edge states, storage events, ArchivalMarkdown scan fallback, and empty-citation blocks', () => {
    const emptyRail = mountEl(<FolioMarginaliaRail items={[]} />);
    expect(emptyRail.innerHTML).toBe('');

    const hovered: Array<string | null> = [];
    const inspectedDisc: string[] = [];
    const openedScan: string[] = [];
    const railContainer = mountEl(
      <div>
        <FolioMarginaliaToggle className="custom-toggle" />
        <FolioMarginaliaRail
          highlightedSourceId="src_place"
          onHoverSourceId={(id) => hovered.push(id)}
          onInspectCitation={() => {}}
          onOpenScan={(item) => openedScan.push(item.sourceId)}
          onInspectDiscrepancy={(item) => inspectedDisc.push(`${item.category}:${item.sourceId}`)}
          items={[
            {
              kind: 'citation',
              key: 'c1',
              footnoteNumber: 1,
              sourceId: 'src_census_1880',
              title: '1880 Census',
              callNumberOrDetail: null,
              repository: null,
              tierLabel: 'Primary Record',
              isReadable: false,
              scanUrl: '/media/scan.jpg',
              scanTitle: 'Scan',
            },
            {
              kind: 'discrepancy',
              key: 'd1',
              indexNumber: 1,
              category: 'place',
              claim: 'Chatham Township',
              note: 'Atlas differs.',
              sourceId: 'src_place',
              sourceLabel: 'County Atlas',
            },
          ]}
        />
      </div>
    );

    expect(railContainer.querySelector('.custom-toggle')).not.toBeNull();
    expect(railContainer.textContent).toContain('Place Discrepancy');
    expect(railContainer.querySelector('.is-discrepancy.is-highlighted')).not.toBeNull();

    const inspectBtn = [
      ...railContainer.querySelectorAll<HTMLButtonElement>('.folio-marginalia-action-btn'),
    ].find((b) => b.textContent === 'Inspect');
    const scanBtn = [
      ...railContainer.querySelectorAll<HTMLButtonElement>('.folio-marginalia-action-btn'),
    ].find((b) => b.textContent === 'Scan');
    const discBtn = [
      ...railContainer.querySelectorAll<HTMLButtonElement>('.folio-marginalia-action-btn'),
    ].find((b) => b.textContent === 'Inspect Source');
    act(() => {
      inspectBtn?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      inspectBtn?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      scanBtn?.click();
      discBtn?.click();
    });
    expect(hovered).toEqual(['src_census_1880', null]);
    expect(openedScan).toEqual(['src_census_1880']);
    expect(inspectedDisc).toEqual(['place:src_place']);

    // Cross-tab storage event and storage error fallback
    window.localStorage.setItem(MARGINALIA_STORAGE_KEY, '0');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other-key' }));
      window.dispatchEvent(new StorageEvent('storage', { key: MARGINALIA_STORAGE_KEY }));
    });
    expect(railContainer.querySelector('.custom-toggle')?.textContent).toBe('Marginalia: Off');

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    act(() => {
      setMarginaliaPreference(true);
    });
    expect(railContainer.querySelector('.custom-toggle')?.textContent).toBe('Marginalia: On');

    // ArchivalMarkdown folio mode: uncited block renders empty rail, Scan opens media or falls back to inspect, uncited markdown stays plain
    const sourcesById = new Map<string, SourceRecord>(TEST_SOURCES.map((s) => [s.id, s]));
    const onOpenMedia = vi.fn();
    const onInspectSource = vi.fn();
    const mediaItem: MediaItem = {
      id: 'med_c',
      kind: 'record_scan',
      source_id: 'src_census_1880',
      person_ids: [],
      file: '/media/c.jpg',
      caption: 'Census scan',
    };
    const mdWithScan = mountEl(
      <ArchivalMarkdown
        markdown={'### Uncited Heading\n\nCited census paragraph.[^src_census_1880]'}
        sourcesById={sourcesById}
        mediaItems={[mediaItem]}
        marginaliaMode="folio"
        onOpenMedia={onOpenMedia}
        onInspectSource={onInspectSource}
      />
    );
    expect(mdWithScan.querySelector('.folio-marginalia-rail-empty')).not.toBeNull();
    const mdScanBtn = [
      ...mdWithScan.querySelectorAll<HTMLButtonElement>('.folio-marginalia-action-btn'),
    ].find((b) => b.textContent === 'Scan');
    act(() => {
      mdScanBtn?.click();
    });
    expect(onOpenMedia).toHaveBeenCalledWith(mediaItem);

    const mdUncited = mountEl(
      <ArchivalMarkdown
        markdown={'Plain paragraph without citations.'}
        sourcesById={sourcesById}
        marginaliaMode="folio"
      />
    );
    expect(mdUncited.querySelector('.folio-marginalia-row')).toBeNull();
  });
});
