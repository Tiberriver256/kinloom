/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveBundle, ArchiveEvent, KinloomSiteConfig, SourceRecord } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { formatArchivalEdtfDate } from '../lib/edtfArchivalFormat.js';
import { computeLifespanOverlapSparkline, partitionKinshipTopology } from '../lib/kinshipPresentation.js';
import {
  buildRidgelineGeometry,
  cleanTimeActivityNote,
  computeArchiveYearDensity,
  ensureTerminalPunctuation,
  truncateAtWordBoundary,
} from '../lib/timeFormatting.js';
import { EvidencePage } from './EvidencePage.js';
import { KinshipPage } from './KinshipPage.js';
import { TimePage } from './TimePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(HERE, '..');

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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
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
  document.documentElement.style.scrollPaddingTop = '';
});

describe('TimePage mobile scrubber non-occlusion, density ridgeline, blurbs, and year/count spacing (#63)', () => {
  it('fixes double periods, truncates cleanly at word boundaries, and builds ridgeline geometry', () => {
    expect(ensureTerminalPunctuation('Washington, D.C..')).toBe('Washington, D.C.');
    expect(ensureTerminalPunctuation('Resided in Springfield')).toBe('Resided in Springfield.');
    expect(ensureTerminalPunctuation('Arrived on time!')).toBe('Arrived on time!');
    expect(ensureTerminalPunctuation('   ')).toBe('');

    const longSentence =
      'Enumerated in the federal census with spouse and four children on Monday morning, owning a modest timber homestead near the river landing in Sangamon County.';
    const clipped = truncateAtWordBoundary(longSentence, 100);
    expect(clipped.length).toBeLessThanOrEqual(100);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toMatch(/[,;:\s]…$/);
    expect(clipped).not.toContain('Monda…');

    expect(cleanTimeActivityNote('Last recorded in 1861: Inaugurated in Washington, D.C..')).toBe(
      'Last recorded in 1861: Inaugurated in Washington, D.C.'
    );
    expect(cleanTimeActivityNote('Enumerated on Monday, …')).toBe('Enumerated on Monday…');

    const fakeEvent = {
      id: 'evt_long',
      summary: longSentence,
    } as ArchiveEvent;
    const rawCoreMidWord = `${longSentence.slice(0, 127).trimEnd()}…`;
    const fixedFromEvent = cleanTimeActivityNote(rawCoreMidWord, fakeEvent, 130);
    expect(fixedFromEvent.endsWith('…')).toBe(true);
    expect(fixedFromEvent).not.toContain('landing in S…');
  });

  it('renders sticky mobile scrubber CSS without bottom fixed occlusion, ridgeline SVG, and separated 1880 · N anchors', () => {
    const scrubberCss = readFileSync(resolve(UI_SRC, 'pages/time/TimeScrubber.module.css'), 'utf8');
    const timeCss = readFileSync(resolve(UI_SRC, 'pages/TimePage.module.css'), 'utf8');
    const mobileBlock = scrubberCss.slice(scrubberCss.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('position: sticky;');
    expect(mobileBlock).toContain('top: var(--topbar-height);');
    expect(mobileBlock).not.toContain('bottom: 0;');
    expect(timeCss).not.toContain('padding-bottom: calc(122px');

    const siteConfig: KinloomSiteConfig = parseKinloomConfig({
      site: { title: 'Alder Synthetic Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_TIME_TEST' },
      anchorYears: [
        { year: 1860, label: '1860' },
        { year: 1880, label: '1880' },
      ],
    });
    const { bundle }: { bundle: ArchiveBundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [
        {
          id: 'pl_dc',
          slug: 'washington-dc',
          name: 'Washington, D.C.',
          full_name: 'Washington, D.C.',
          place_type: 'town',
          parent_id: null,
          lat: 38.9,
          lng: -77.03,
        },
      ],
      sources: [{ id: 'src_1', citation: '1880 Census', source_type: 'census', has_primary_source: true }],
      people: [
        {
          id: 'per_a',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1840',
          death_edtf: '1905',
          portrait_url: null,
        },
      ],
      events: [
        {
          id: 'evt_1878',
          title: 'Resided in Washington, D.C.',
          summary: 'Clerk at the patent office.',
          event_kind: 'residence_anchor',
          scope: 'family',
          edtf_date: '1878',
          place_id: 'pl_dc',
          participants: [{ person_id: 'per_a', role: 'head' }],
          sources: [{ source_id: 'src_1', confidence: 'high' }],
        },
      ],
      kinship: [],
    });

    const density = computeArchiveYearDensity(bundle, 1840, 1910);
    expect(density.find((d) => d.year === 1878)).toEqual({ year: 1878, aliveCount: 1, eventCount: 1 });
    const geom = buildRidgelineGeometry(density, 1880, 400, 28);
    expect(geom.hasData).toBe(true);
    expect(geom.areaPath.startsWith('M0,')).toBe(true);
    expect(geom.activeX).toBeGreaterThan(0);

    const container = mountEl(
      <MemoryRouter initialEntries={['/time?year=1880']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <TimePage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    // Ridgeline SVG rendered inside slider track
    const ridgelineSvg = container.querySelector('svg[class*="time-density-ridgeline"]');
    expect(ridgelineSvg).not.toBeNull();

    // Year and count separated cleanly with middle dot instead of 18801
    const anchorBtn = [...container.querySelectorAll('button[class*="time-anchor-btn"]')].find((b) =>
      b.textContent?.includes('1880')
    );
    expect(anchorBtn).toBeTruthy();
    expect(anchorBtn?.textContent).toBe('1880·1');

    // No double period after Washington, D.C.
    expect(container.textContent).toContain('Washington, D.C.');
    expect(container.textContent).not.toContain('D.C..');

    // Focus Not Obscured scroll padding set on root element
    expect(document.documentElement.style.scrollPaddingTop).toBe('calc(var(--topbar-height) + 64px)');

    // Concise H1 avoids repeating the archive family name already shown in the topbar
    const h1 = container.querySelector('h1');
    expect(h1?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Historical Snapshot 1880');
  });

  it('caps desktop milestone chips to 6 and discloses additional anchor years behind More years popover (#101)', () => {
    const manyAnchors = [1760, 1780, 1800, 1820, 1840, 1850, 1860, 1870, 1880, 1890].map((year) => ({
      year,
      label: String(year),
    }));
    const siteConfig = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_TIME_MANY' },
      anchorYears: manyAnchors,
    });
    const { bundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [
        {
          id: 'pl_a',
          slug: 'albany',
          name: 'Albany',
          full_name: 'Albany, New York',
          place_type: 'town',
          parent_id: null,
          lat: 42.65,
          lng: -73.75,
        },
      ],
      sources: [{ id: 'src_1', citation: 'Town Register', source_type: 'census', has_primary_source: true }],
      people: [
        {
          id: 'per_a',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1755',
          death_edtf: '1895',
          portrait_url: null,
        },
      ],
      events: manyAnchors.map((a) => ({
        id: `evt_${a.year}`,
        title: `Resided in Albany (${a.year})`,
        summary: 'Town residence record.',
        event_kind: 'residence_anchor' as const,
        scope: 'family' as const,
        edtf_date: String(a.year),
        place_id: 'pl_a',
        participants: [{ person_id: 'per_a', role: 'head' }],
        sources: [{ source_id: 'src_1', confidence: 'high' as const }],
      })),
      kinship: [],
    });

    const container = mountEl(
      <MemoryRouter initialEntries={['/time?year=1880']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <TimePage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const flatBtns = container.querySelectorAll('button[class*="time-anchor-btn"]');
    expect(flatBtns).toHaveLength(7);

    const moreYearsBtn = container.querySelector<HTMLButtonElement>('button[class*="time-more-years-btn"]');
    expect(moreYearsBtn).not.toBeNull();
    expect(moreYearsBtn?.textContent).toContain('More years (3)');
    expect(moreYearsBtn?.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      moreYearsBtn?.click();
    });
    expect(moreYearsBtn?.getAttribute('aria-expanded')).toBe('true');
    const popoverItems = container.querySelectorAll<HTMLButtonElement>(
      'button[class*="time-more-year-item"]'
    );
    expect(popoverItems).toHaveLength(3);

    // Escape closes popover; reopen and pick an overflow year (1760)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(moreYearsBtn?.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      moreYearsBtn?.click();
    });
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(moreYearsBtn?.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      moreYearsBtn?.click();
    });
    const year1760Btn = [
      ...container.querySelectorAll<HTMLButtonElement>('button[class*="time-more-year-item"]'),
    ].find((b) => b.textContent?.includes('1760'));
    expect(year1760Btn).toBeTruthy();
    act(() => {
      year1760Btn?.click();
    });
    expect(container.querySelector('[class*="handwritten-year-hero"]')?.textContent).toBe('1760');
    expect(container.querySelectorAll('button[class*="time-anchor-btn"]')).toHaveLength(7);
  });
});

describe('KinshipPage V-topology <ol>, vertical mobile connectors, overlap sparkline, and Tree link (#63)', () => {
  it('partitions blood cousin paths into V-topology with MRCA apex and direct/marriage paths into linear', () => {
    const v = partitionKinshipTopology(
      ['per_a', 'per_p1', 'per_gp', 'per_p2', 'per_b'],
      [
        { fromId: 'per_a', toId: 'per_p1', relation: 'child' },
        { fromId: 'per_p1', toId: 'per_gp', relation: 'child' },
        { fromId: 'per_gp', toId: 'per_p2', relation: 'parent' },
        { fromId: 'per_p2', toId: 'per_b', relation: 'parent' },
      ]
    );
    expect(v.topology).toBe('v');
    if (v.topology === 'v') {
      expect(v.ascending.map((n) => n.personId)).toEqual(['per_a', 'per_p1']);
      expect(v.apex.personId).toBe('per_gp');
      expect(v.apex.role).toBe('apex');
      expect(v.descending.map((n) => n.personId)).toEqual(['per_p2', 'per_b']);
    }

    const linear = partitionKinshipTopology(
      ['per_gp', 'per_p1', 'per_a'],
      [
        { fromId: 'per_gp', toId: 'per_p1', relation: 'parent' },
        { fromId: 'per_p1', toId: 'per_a', relation: 'parent' },
      ]
    );
    expect(linear.topology).toBe('linear');
    expect(linear.apex).toBeNull();
  });

  it('computes dual-bar lifespan overlap sparkline coordinates and handles null dates', () => {
    const spark = computeLifespanOverlapSparkline(
      { birth_year: 1840, death_year: 1910, is_living: false },
      { birth_year: 1865, death_year: 1940, is_living: false },
      { start: 1865, end: 1910, durationYears: 45 },
      2026
    );
    expect(spark).not.toBeNull();
    expect(spark?.minYear).toBe(1840);
    expect(spark?.maxYear).toBe(1940);
    expect(spark?.overlap?.leftPct).toBe(25);
    expect(spark?.overlap?.widthPct).toBe(45);

    expect(
      computeLifespanOverlapSparkline(
        { birth_year: null, death_year: 1910, is_living: false },
        { birth_year: 1865, death_year: 1940, is_living: false },
        null
      )
    ).toBeNull();
  });

  it('renders semantic <ol> V-topology with MRCA badge, mobile downward arrows, /time?year= sparkline link, and Highlight Path in Tree link', () => {
    const kinshipCss = readFileSync(resolve(UI_SRC, 'pages/KinshipPage.module.css'), 'utf8');
    const mobileCss = kinshipCss.slice(kinshipCss.indexOf('@media (max-width: 768px)'));
    expect(mobileCss).toContain('.kinship-arrow-desktop');
    expect(mobileCss).toContain('.kinship-arrow-mobile');
    expect(mobileCss).toContain('width: 100%;');

    const siteConfig = parseKinloomConfig({
      site: { title: 'Alder Synthetic Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_KIN_TEST' },
    });
    const { bundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [],
      sources: [],
      people: [
        {
          id: 'per_gp',
          slug: 'thomas-alder',
          full_name: 'Thomas Alder',
          given_name: 'Thomas',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1810',
          death_edtf: '1885',
          portrait_url: null,
        },
        {
          id: 'per_c1',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1838',
          death_edtf: '1908',
          portrait_url: null,
        },
        {
          id: 'per_c2',
          slug: 'henry-alder',
          full_name: 'Henry Alder',
          given_name: 'Henry',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1842',
          death_edtf: '1918',
          portrait_url: null,
        },
      ],
      events: [],
      kinship: [
        { from: 'per_gp', to: 'per_c1', relation: 'parent' },
        { from: 'per_c1', to: 'per_gp', relation: 'child' },
        { from: 'per_gp', to: 'per_c2', relation: 'parent' },
        { from: 'per_c2', to: 'per_gp', relation: 'child' },
      ],
    });

    const container = mountEl(
      <MemoryRouter initialEntries={['/kinship?from=clara-alder&to=henry-alder']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <KinshipPage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const ol = container.querySelector('ol[aria-label="Kinship lineage path"]');
    expect(ol).not.toBeNull();
    expect(ol?.className).toContain('kinship-chain--v');
    expect(ol?.querySelectorAll('li')).toHaveLength(3);
    expect(container.textContent).toContain('Most Recent Common Ancestor');

    // Mobile vertical downward connectors exist on every step
    const mobileArrows = [...container.querySelectorAll('[class*="kinship-arrow-mobile"]')];
    expect(mobileArrows).toHaveLength(2);
    expect(mobileArrows.every((el) => el.textContent === '↓')).toBe(true);

    // Overlap sparkline linked to /time?year=1842
    const overlapLink = container.querySelector<HTMLAnchorElement>('a[href="/time?year=1842"]');
    expect(overlapLink).not.toBeNull();
    expect(overlapLink?.querySelector('svg[class*="kinship-overlap-sparkline"]')).not.toBeNull();

    // Highlight Path in Tree action links with focus + path query params
    const treeLink = [...container.querySelectorAll<HTMLAnchorElement>('a')].find((a) =>
      a.textContent?.includes('Highlight Path in Tree')
    );
    expect(treeLink?.getAttribute('href')).toBe(
      '/tree?mode=full&focus=clara-alder&path=clara-alder%2Cthomas-alder%2Chenry-alder'
    );
  });
});

describe('MilestoneStoryCard 56ch figcaption cap and EvidencePage editorial serif, EDTF, and pagination (#63)', () => {
  it('caps MilestoneStoryCard figcaption at 56ch and guards hover for fine pointers', () => {
    const cardCss = readFileSync(resolve(UI_SRC, 'components/MilestoneStoryCard.module.css'), 'utf8');
    expect(cardCss).toContain('.story-card figcaption');
    expect(cardCss).toContain('max-width: 56ch;');
    expect(cardCss).toContain('@media (hover: hover) and (pointer: fine)');
  });

  it('formats raw ISO and EDTF dates into day-first human-readable archival strings', () => {
    expect(formatArchivalEdtfDate('1778-01-05')).toBe('5 Jan 1778');
    expect(formatArchivalEdtfDate('1781~')).toBe('c. 1781');
    expect(formatArchivalEdtfDate('1781?')).toBe('est. 1781');
    expect(formatArchivalEdtfDate('1778-01')).toBe('Jan 1778');
    expect(formatArchivalEdtfDate('/1820')).toBe('Bef. 1820');
    expect(formatArchivalEdtfDate('1840/')).toBe('Aft. 1840');
    expect(formatArchivalEdtfDate('1840/1845')).toBe('1840–1845');
    expect(formatArchivalEdtfDate('1778-01-05/1780-06-12')).toBe('5 Jan 1778 – 12 Jun 1780');
    expect(formatArchivalEdtfDate('192X')).toBe('1920s');
    expect(formatArchivalEdtfDate(null)).toBe('Undated');
  });

  it('renders serif prose discrepancy claims, human EDTF dates, and batched pagination on /evidence', () => {
    const siteConfig = parseKinloomConfig({
      site: { title: 'Alder Synthetic Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_EV_TEST' },
    });

    const sources: SourceRecord[] = Array.from({ length: 30 }, (_, i) => ({
      id: `src_${i}`,
      citation: `Archival Register Vol. ${i + 1}`,
      source_type: 'census',
      repository: 'County Courthouse',
      has_primary_source: true,
    }));

    const events = Array.from({ length: 28 }, (_, i) => ({
      id: `evt_conf_${i}`,
      title: `Discrepancy Event ${i + 1}`,
      summary: 'Two records disagree.',
      event_kind: 'point_event' as const,
      scope: 'personal' as const,
      edtf_date: '1778-01-05',
      place_id: null,
      participants: [{ person_id: 'per_a', role: 'principal' }],
      sources: [{ source_id: 'src_0', confidence: 'high' as const }],
      alternate_dates:
        i === 0
          ? [
              { edtf_date: '1778-01-05', source_id: 'src_0', note: 'Parish baptism ledger' },
              { edtf_date: '1781~', source_id: 'src_1', note: 'Headstone estimate' },
            ]
          : [{ edtf_date: '1780~', source_id: 'src_0', note: 'Alternate year' }],
      alternate_places:
        i === 0 ? [{ place_name: 'Old Mill Parish', source_id: 'src_1', note: 'Tax roll listing' }] : [],
      fact_conflicts:
        i === 0
          ? [
              {
                claim: 'Recorded as master cooper in county roll',
                source_id: 'src_2',
                note: 'Occupation differs',
              },
            ]
          : [],
    }));

    const { bundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [],
      sources,
      people: [
        {
          id: 'per_a',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1778-01-05',
          death_edtf: '1845-06-12',
          portrait_url: null,
        },
      ],
      events,
      kinship: [],
    });

    const container = mountEl(
      <MemoryRouter initialEntries={['/evidence']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <EvidencePage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    // Human-readable archival dates and serif prose (no <code> tag on claims)
    expect(container.textContent).toContain('5 Jan 1778');
    expect(container.textContent).toContain('c. 1781');
    expect(container.textContent).not.toContain('1781~');
    expect(container.querySelector('li code')).toBeNull();
    const serifClaims = [...container.querySelectorAll('strong[class*="evidence-claim-prose"]')];
    expect(serifClaims.some((el) => el.textContent === 'Old Mill Parish')).toBe(true);
    expect(serifClaims.some((el) => el.textContent === 'Recorded as master cooper in county roll')).toBe(
      true
    );

    // Initial batch capped at 24 discrepancy cards
    expect(container.querySelectorAll('article')).toHaveLength(24);
    expect(container.textContent).toContain('Showing 24 of 28');
    const showMoreDiscrepancies = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Show more (4 remaining)')
    );
    expect(showMoreDiscrepancies).not.toBeNull();
    act(() => {
      showMoreDiscrepancies?.click();
    });
    expect(container.querySelectorAll('article')).toHaveLength(28);

    // Switch to Sources tab -> batched at 24 of 30, loads more, resets on query
    const sourcesTab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) =>
      b.textContent?.includes('(30)')
    );
    act(() => {
      sourcesTab?.click();
    });
    expect(container.querySelectorAll('[class*="evidence-source-row"]')).toHaveLength(24);
    expect(container.textContent).toContain('Showing 24 of 30');
    const showMoreSources = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Show more (6 remaining)')
    );
    act(() => {
      showMoreSources?.click();
    });
    expect(container.querySelectorAll('[class*="evidence-source-row"]')).toHaveLength(30);

    const searchInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter archival sources"]'
    );
    expect(searchInput).not.toBeNull();
    if (searchInput) {
      setInputValue(searchInput, 'Archival Register');
      expect(container.querySelectorAll('[class*="evidence-source-row"]')).toHaveLength(24);
    }
  });
});
