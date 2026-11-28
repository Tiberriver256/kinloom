/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, MediaItem, SourceRecord } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { PersonPage } from '../pages/PersonPage.js';
import { ArchivalMarkdown, formatNarrativeDateSpan } from './ArchivalMarkdown.js';
import { computeCitationPopoverPosition } from './CitationPopover.js';
import { SourceInspectorDrawer } from './SourceInspectorDrawer.js';

function must<T>(val: T | undefined, label = 'value'): T {
  if (val === undefined) throw new Error(`Expected ${label}`);
  return val;
}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEST_SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Riverdale Synthetic Archive',
    familyName: 'Aldridge Family',
    gedcomSourceName: 'RIVERDALE_TEST',
  },
});

const TEST_SOURCES: SourceRecord[] = [
  {
    id: 'src_demo_census_1880',
    citation: '1880 U.S. Federal Census, Riverdale Township, Roll 42, Sheet 9.',
    source_type: 'census',
    repository: 'National Archives (NARA)',
    url: 'https://catalog.archives.gov/id/100001',
  },
  {
    id: 'src_demo_marriage_1872',
    citation: 'Cedar County Marriage Register, Vol. 3, p. 14 (1872).',
    source_type: 'vital_record',
    repository: 'Cedar County Courthouse',
  },
  {
    id: 'src_demo_diary_1891',
    citation: 'Harriet Aldridge Farm Journal (1891).',
    source_type: 'family_memoir',
    repository: 'Family Archive',
  },
];

const TEST_MEDIA: MediaItem[] = [
  {
    id: 'med_demo_census_scan',
    kind: 'record_scan',
    source_id: 'src_demo_census_1880',
    person_ids: ['p_harriet'],
    file: '/media/demo-census-1880.jpg',
    caption: '1880 Federal Census page showing the Aldridge household',
  },
  {
    id: 'med_demo_diary_override',
    kind: 'document_scan',
    source_id: 'src_demo_diary_1891',
    person_ids: ['p_thomas'],
    file: '/media/demo-diary-1891.jpg',
    caption: 'Handwritten 1891 journal entry on Cedar Creek harvest',
  },
];

function renderIntoDom(element: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function buildPersonBundle(): ArchiveBundle {
  const { bundle } = compileArchive({
    siteConfig: TEST_SITE_CONFIG,
    mode: 'public',
    people: [
      {
        id: 'p_harriet',
        slug: 'harriet-aldridge',
        full_name: 'Harriet Aldridge',
        given_name: 'Harriet',
        surname: 'Aldridge',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1851-03-14',
        death_edtf: '1926-11-02',
        portrait_url: null,
      },
      {
        id: 'p_thomas',
        slug: 'thomas-aldridge',
        full_name: 'Thomas Aldridge',
        given_name: 'Thomas',
        surname: 'Aldridge',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1848-06-10',
        death_edtf: '1918-09-20',
        portrait_url: null,
      },
    ],
    places: [],
    events: [],
    sources: TEST_SOURCES,
    kinship: [],
    media: TEST_MEDIA,
    narratives: [
      {
        id: 'nar_harriet_bio',
        slug: 'harriet-aldridge-bio',
        kind: 'biography',
        subject_person_id: 'p_harriet',
        title: 'Harriet Aldridge: Riverdale Years',
        summary: 'Farm records and federal census entries.',
        date_edtf: '1851/1926',
        person_ids: ['p_harriet', 'p_thomas'],
        place_ids: [],
        event_ids: [],
        source_ids: ['src_demo_marriage_1872', 'src_demo_census_1880', 'src_demo_diary_1891'],
        body_md: [
          'Harriet recorded the 1891 harvest in her farm journal.[^src_demo_diary_1891|med_demo_diary_override]',
          'Earlier census schedules list her household in Riverdale[^src_demo_census_1880] and confirm the same farm location.[^src_demo_census_1880]',
        ].join(' '),
      },
    ],
  });
  return bundle;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('ArchivalMarkdown inline footnote citations and CitationPopover', () => {
  it('auto-numbers by first appearance, reuses repeated IDs, renders adjacent footnotes, and strips unknown IDs', () => {
    const sourcesById = new Map(TEST_SOURCES.map((s) => [s.id, s]));
    const markdown = [
      'Born before the 1872 marriage[^src_demo_marriage_1872] and missing token[^src_unknown_ghost].',
      'Later enumerated in the census[^src_demo_census_1880][^src_demo_diary_1891] and cited again.[^src_demo_marriage_1872]',
      'Code syntax `[^src_demo_census_1880]` stays literal.',
    ].join(' ');

    const { container, unmount } = renderIntoDom(
      <ArchivalMarkdown
        markdown={markdown}
        sourcesById={sourcesById}
        mediaItems={TEST_MEDIA}
        subjectPersonId="p_harriet"
      />
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.archival-footnote-ref')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['[1]', '[2]', '[3]', '[1]']);
    expect(container.textContent).not.toContain('[^src_unknown_ghost]');
    expect(container.querySelector('code')?.textContent).toBe('[^src_demo_census_1880]');

    unmount();
  });

  it('opens hover popover with citation + scan thumbnail, survives grace delay onto card, and fires callbacks', () => {
    vi.useFakeTimers();
    const sourcesById = new Map(TEST_SOURCES.map((s) => [s.id, s]));
    const onInspectSource = vi.fn();
    const onOpenMedia = vi.fn();

    const { container, unmount } = renderIntoDom(
      <ArchivalMarkdown
        markdown="Enumerated in 1880[^src_demo_census_1880] with explicit journal page.[^src_demo_census_1880|med_demo_diary_override]"
        sourcesById={sourcesById}
        mediaItems={TEST_MEDIA}
        subjectPersonId="p_harriet"
        onInspectSource={onInspectSource}
        onOpenMedia={onOpenMedia}
        resolveMediaUrl={(m) => `https://archive.example${m.file}`}
      />
    );

    const [firstBtn, overrideBtn] = [
      ...container.querySelectorAll<HTMLButtonElement>('.archival-footnote-ref'),
    ];
    expect(must(firstBtn).textContent?.trim()).toBe('[1]');
    expect(must(overrideBtn).textContent?.trim()).toBe('[1]');

    // Hover first footnote -> popover renders citation + resolved census scan
    act(() => {
      must(firstBtn).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const popover = document.body.querySelector<HTMLDivElement>('.citation-popover');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain('[1]');
    expect(popover?.textContent).toContain('Primary Record');
    expect(popover?.textContent).toContain('1880 U.S. Federal Census, Riverdale Township');
    expect(popover?.textContent).toContain('National Archives (NARA)');
    expect(popover?.querySelector<HTMLAnchorElement>('.citation-popover-ext-link')?.href).toBe(
      'https://catalog.archives.gov/id/100001'
    );
    const thumb = popover?.querySelector<HTMLImageElement>('.citation-popover-media-img');
    expect(thumb?.getAttribute('src')).toBe('https://archive.example/media/demo-census-1880.jpg');

    // Leaving trigger and entering popover within 150ms keeps popover open
    act(() => {
      must(firstBtn).dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      vi.advanceTimersByTime(80);
      popover?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(200);
    });
    expect(document.body.querySelector('.citation-popover')).not.toBeNull();

    // Clicking thumbnail calls onOpenMedia with resolved census scan and closes popover
    const mediaBtn = popover?.querySelector<HTMLButtonElement>('.citation-popover-media-btn');
    act(() => {
      mediaBtn?.click();
    });
    expect(onOpenMedia).toHaveBeenCalledTimes(1);
    expect(onOpenMedia.mock.calls[0]?.[0]?.id).toBe('med_demo_census_scan');
    expect(document.body.querySelector('.citation-popover')).toBeNull();

    // Hover explicit override token -> shows overridden journal media
    act(() => {
      must(overrideBtn).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const overridePopover = document.body.querySelector<HTMLDivElement>('.citation-popover');
    expect(
      overridePopover?.querySelector<HTMLImageElement>('.citation-popover-media-img')?.getAttribute('src')
    ).toBe('https://archive.example/media/demo-diary-1891.jpg');

    // Clicking "Inspect full source" fires callback with sourceId
    const inspectBtn = overridePopover?.querySelector<HTMLButtonElement>('.citation-popover-inspect-btn');
    act(() => {
      inspectBtn?.click();
    });
    expect(onInspectSource).toHaveBeenCalledWith('src_demo_census_1880');
    expect(document.body.querySelector('.citation-popover')).toBeNull();

    unmount();
  });

  it('renders cleanly without an image when a source has no photo and supports click toggle plus Escape dismissal', () => {
    const sourcesById = new Map(TEST_SOURCES.map((s) => [s.id, s]));
    const { container, unmount } = renderIntoDom(
      <ArchivalMarkdown
        markdown="Married in Cedar County.[^src_demo_marriage_1872]"
        sourcesById={sourcesById}
        mediaItems={TEST_MEDIA}
        subjectPersonId="p_harriet"
      />
    );

    const btn = container.querySelector<HTMLButtonElement>('.archival-footnote-ref');
    act(() => {
      btn?.click();
    });

    const popover = document.body.querySelector<HTMLDivElement>('.citation-popover');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain('Cedar County Marriage Register');
    expect(popover?.querySelector('img')).toBeNull();

    // Escape dismisses pinned popover
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.body.querySelector('.citation-popover')).toBeNull();

    unmount();
  });

  it('clamps popover coordinates inside 390px mobile viewports and flips above when near bottom', () => {
    const mobileRightEdge = computeCitationPopoverPosition({
      anchorRect: { top: 120, bottom: 138, left: 360, right: 382, width: 22 },
      popoverSize: { width: 340, height: 220 },
      viewport: { width: 390, height: 700 },
    });
    expect(mobileRightEdge.left).toBeGreaterThanOrEqual(12);
    expect(mobileRightEdge.left + mobileRightEdge.maxWidth).toBeLessThanOrEqual(390 - 12);
    expect(mobileRightEdge.placement).toBe('below');

    const nearBottom = computeCitationPopoverPosition({
      anchorRect: { top: 610, bottom: 628, left: 200, right: 222, width: 22 },
      popoverSize: { width: 320, height: 220 },
      viewport: { width: 1024, height: 680 },
    });
    expect(nearBottom.placement).toBe('above');
    expect(nearBottom.top).toBeLessThan(610);
    expect(nearBottom.top).toBeGreaterThanOrEqual(12);
  });

  it('clamps popover below sticky header, anchors in desktop marginalia lane, omits broken scans, and formats human-readable narrative date spans (#109)', () => {
    // 1. Clamp below sticky header (headerBottom = 56 -> top >= 68)
    const clampedBelowHeader = computeCitationPopoverPosition({
      anchorRect: { top: 64, bottom: 80, left: 220, right: 244, width: 24 },
      popoverSize: { width: 320, height: 220 },
      viewport: { width: 900, height: 260 },
      headerBottom: 56,
    });
    expect(clampedBelowHeader.top).toBeGreaterThanOrEqual(56 + 12);

    // 2. Anchor in right marginalia lane on desktop (>= 1024px)
    const desktopMarginalia = computeCitationPopoverPosition({
      anchorRect: { top: 240, bottom: 256, left: 320, right: 344, width: 24 },
      popoverSize: { width: 320, height: 220 },
      viewport: { width: 1440, height: 900 },
      headerBottom: 56,
      marginaliaLane: { left: 960, right: 1240, width: 280 },
      preferRightLane: true,
    });
    expect(desktopMarginalia.placement).toBe('marginalia');
    expect(desktopMarginalia.left).toBe(960);
    expect(desktopMarginalia.top).toBeGreaterThanOrEqual(56 + 12);

    // 3. Broken scan image is cleanly omitted on error (no empty grey box)
    const sourcesById = new Map(TEST_SOURCES.map((s) => [s.id, s]));
    const { container, unmount } = renderIntoDom(
      <ArchivalMarkdown
        markdown="Enumerated in 1880.[^src_demo_census_1880]"
        sourcesById={sourcesById}
        mediaItems={TEST_MEDIA}
        subjectPersonId="p_harriet"
        resolveMediaUrl={(m) => `https://archive.example${m.file}`}
      />
    );
    const btn = container.querySelector<HTMLButtonElement>('.archival-footnote-ref');
    act(() => {
      btn?.click();
    });
    const popover = document.body.querySelector<HTMLDivElement>('.citation-popover');
    const img = popover?.querySelector<HTMLImageElement>('.citation-popover-media-img');
    expect(img).not.toBeNull();
    expect(popover?.querySelector('[data-image-status="loading"]')).not.toBeNull();
    act(() => {
      img?.dispatchEvent(new Event('error'));
    });
    expect(popover?.querySelector('.citation-popover-media-wrap')).toBeNull();
    unmount();

    // 4. Human-readable biography date spans (no colliding YYYY-MM-DD–YYYY-MM-DD)
    expect(formatNarrativeDateSpan('1851-03-14/1926-11-02')).toBe('Mar 14, 1851 — Nov 2, 1926');
    expect(formatNarrativeDateSpan('1851/1926')).toBe('1851–1926');
    expect(formatNarrativeDateSpan('~1851/1926')).toBe('c. 1851 — 1926');
    expect(formatNarrativeDateSpan('1851-03')).toBe('Mar 1851');
  });
});

describe('PersonPage synced footnote Sources (N), lightbox, and SourceInspectorDrawer integration', () => {
  it('syncs Sources (N) order to inline footnotes, opens lightbox for both person and bundle media, and opens SourceInspectorDrawer', () => {
    const bundle = buildPersonBundle();
    const { container, unmount } = renderIntoDom(
      <MemoryRouter initialEntries={['/person/harriet-aldridge']}>
        <ArchiveProvider siteConfig={TEST_SITE_CONFIG} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
          <SourceInspectorDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const bioSection = container.querySelector('section[aria-label="Biography"]');
    expect(bioSection).not.toBeNull();

    const footnoteBtns = [
      ...(bioSection?.querySelectorAll<HTMLButtonElement>('.archival-footnote-ref') ?? []),
    ];
    expect(footnoteBtns.map((b) => b.textContent?.trim())).toEqual(['[1]', '[2]', '[2]']);

    // Expand Sources (3) and verify [1] diary, [2] census, then uncited marriage register
    const sourcesToggle = [...(bioSection?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Sources (3)')
    );
    act(() => {
      sourcesToggle?.click();
    });

    const sourceItems = [...(bioSection?.querySelectorAll('.person-biography-source-list li') ?? [])];
    expect(sourceItems.length).toBe(3);
    expect(sourceItems[0]?.querySelector('.person-biography-source-num')?.textContent).toBe('[1]');
    expect(sourceItems[0]?.textContent).toContain('Harriet Aldridge Farm Journal (1891).');
    expect(sourceItems[1]?.querySelector('.person-biography-source-num')?.textContent).toBe('[2]');
    expect(sourceItems[1]?.textContent).toContain('1880 U.S. Federal Census, Riverdale Township');
    expect(sourceItems[2]?.querySelector('.person-biography-source-num')).toBeNull();
    expect(sourceItems[2]?.textContent).toContain('Cedar County Marriage Register');

    // Footnote [1] pins med_demo_diary_override (linked to p_thomas, NOT in Harriet's personMedia):
    // clicking its thumbnail still opens the archival lightbox cleanly!
    act(() => {
      footnoteBtns[0]?.click();
    });
    const mediaThumbBtn = document.body.querySelector<HTMLButtonElement>('.citation-popover-media-btn');
    expect(mediaThumbBtn).not.toBeNull();
    act(() => {
      mediaThumbBtn?.click();
    });
    const lightbox = container.querySelector('dialog[aria-label="Photo and document lightbox"]');
    expect(lightbox).not.toBeNull();
    expect(lightbox?.textContent).toContain('Handwritten 1891 journal entry on Cedar Creek harvest');

    // Close lightbox and inspect full source from footnote [2]
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('dialog[aria-label="Photo and document lightbox"]')).toBeNull();

    act(() => {
      footnoteBtns[1]?.click();
    });
    const inspectBtn = document.body.querySelector<HTMLButtonElement>('.citation-popover-inspect-btn');
    act(() => {
      inspectBtn?.click();
    });
    const inspector = container.querySelector('dialog[aria-label="Source Inspector"]');
    expect(inspector).not.toBeNull();
    expect(inspector?.textContent).toContain('1880 U.S. Federal Census, Riverdale Township');

    unmount();
  });
});
