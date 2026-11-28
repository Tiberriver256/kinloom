/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveBundle, KinloomSiteConfig, SourceRecord } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { SourceCitationTag } from './atoms/SourceCitationTag.js';
import { ExplorerTopBar } from './ExplorerTopBar.js';
import { SourceInspectorDrawer } from './SourceInspectorDrawer.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(HERE, '..');

const LONG_HANDLE_CITATION =
  'Regional Civil Register, hdl 21.12113/2376FEBC188D4479B8E3CEC8CE129447: Archival census entry https://archive.example.test/ark:/61903/1:1:Q234-5678-LONG-UNBROKEN';

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Synthetic Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_MOBILE_LAYOUT_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  places: [],
  sources: [
    {
      id: 'src_handle',
      citation: LONG_HANDLE_CITATION,
      source_type: 'vital_record',
      has_primary_source: true,
    },
  ],
  people: [
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
  events: [],
  kinship: [],
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

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  document.documentElement.style.removeProperty('--topbar-height');
  vi.restoreAllMocks();
});

function readCssBlock(css: string, selector: string): string {
  const idx = css.indexOf(selector);
  if (idx === -1) {
    return '';
  }
  const openBrace = css.indexOf('{', idx);
  if (openBrace === -1) {
    return '';
  }
  const closeBrace = css.indexOf('}', openBrace);
  return closeBrace === -1 ? '' : css.slice(openBrace + 1, closeBrace);
}

describe('Mobile discrepancy citation wrapping and sticky header seam', () => {
  it('renders long unbroken archival handles inside all three discrepancy boxes and opens SourceInspectorDrawer', () => {
    const sourcesById = new Map<string, SourceRecord>(SAMPLE_BUNDLE.sources.map((s) => [s.id, s]));

    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <SourceCitationTag
            eventId="evt_1858_birth"
            sources={[{ source_id: 'src_handle', confidence: 'high' }]}
            alternateDates={[
              {
                edtf_date: '1858-07-23',
                source_id: 'src_handle',
                note: 'Parish roll reference hdl:21.12113/2376FEBC188D4479B8E3CEC8CE129447',
              },
            ]}
            alternatePlaces={[
              {
                place_name: 'District/Subdivision-2376FEBC188D4479B8E3CEC8CE129447',
                source_id: 'src_handle',
                note: 'Boundary ledger uses alternate parish name',
              },
            ]}
            factConflicts={[
              {
                claim: 'Witness register ref 21.12113/2376FEBC188D4479B8E3CEC8CE129447',
                source_id: 'src_handle',
                note: 'Duplicate entry swaps witness order',
              },
            ]}
            sourcesById={sourcesById}
          />
          <SourceInspectorDrawer />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const toggleBtn = container.querySelector<HTMLButtonElement>('.source-toggle');
    expect(toggleBtn).not.toBeNull();
    act(() => {
      toggleBtn?.click();
    });

    const conflictBoxes = [...container.querySelectorAll('.citation-conflicts-box')];
    expect(conflictBoxes).toHaveLength(3);
    expect(conflictBoxes.map((box) => box.querySelector('strong')?.textContent)).toEqual([
      'Preserved Date Discrepancies',
      'Preserved Place Discrepancies',
      'Preserved Fact Discrepancies',
    ]);

    for (const box of conflictBoxes) {
      const inlineBtn = box.querySelector<HTMLButtonElement>('.source-read-inline');
      expect(inlineBtn).not.toBeNull();
      expect(inlineBtn?.textContent).toContain('21.12113/2376FEBC188D4479B8E3CEC8CE129447');
    }

    const placeInlineBtn = conflictBoxes[1]?.querySelector<HTMLButtonElement>('.source-read-inline');
    act(() => {
      placeInlineBtn?.click();
    });
    expect(container.querySelector('dialog[aria-label="Source Inspector"]')).not.toBeNull();
  });

  it('enforces mobile wrapping rules on discrepancy boxes, inline citation buttons, and source details CSS', () => {
    const citationsCss = readFileSync(resolve(UI_SRC, 'styles/Citations.module.css'), 'utf8');
    const controlsCss = readFileSync(resolve(UI_SRC, 'styles/Controls.module.css'), 'utf8');
    const atomsCss = readFileSync(resolve(UI_SRC, 'components/Atoms.module.css'), 'utf8');

    const conflictBoxRule = readCssBlock(citationsCss, '.citation-conflicts-box {');
    expect(conflictBoxRule).toContain('min-width: 0;');
    expect(conflictBoxRule).toContain('max-width: 100%;');
    expect(conflictBoxRule).toContain('box-sizing: border-box;');
    expect(conflictBoxRule).toContain('overflow-wrap: anywhere;');
    expect(conflictBoxRule).toContain('word-break: break-word;');

    const conflictInlineBtnRule = readCssBlock(
      citationsCss,
      '.citation-conflicts-box :global(.source-read-inline) {'
    );
    expect(conflictInlineBtnRule).toContain('min-width: 0;');
    expect(conflictInlineBtnRule).toContain('max-width: 100%;');
    expect(conflictInlineBtnRule).toContain('white-space: normal;');
    expect(conflictInlineBtnRule).toContain('overflow-wrap: anywhere;');
    expect(conflictInlineBtnRule).toContain('word-break: break-word;');

    const controlsInlineRule = readCssBlock(controlsCss, '.source-read-inline {');
    expect(controlsInlineRule).toContain('min-width: 0;');
    expect(controlsInlineRule).toContain('max-width: 100%;');
    expect(controlsInlineRule).toContain('overflow-wrap: anywhere;');
    expect(controlsInlineRule).toContain('word-break: break-word;');

    const sourceDetailsRule = readCssBlock(atomsCss, '.source-details {');
    expect(sourceDetailsRule).toContain('min-width: 0;');
    expect(sourceDetailsRule).toContain('overflow-wrap: anywhere;');
    expect(sourceDetailsRule).toContain('word-break: break-word;');
  });

  it('floors fractional ExplorerTopBar height into --topbar-height and seals the PersonPage sticky decade bar seam', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'HEADER') {
        return {
          x: 0,
          y: 0,
          width: 390,
          height: 97.6,
          top: 0,
          right: 390,
          bottom: 97.6,
          left: 0,
          toJSON: () => ({}),
        };
      }
      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      };
    });

    mountEl(
      <MemoryRouter initialEntries={['/person/clara-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );

    expect(document.documentElement.style.getPropertyValue('--topbar-height')).toBe('97px');

    const personCss = readFileSync(resolve(UI_SRC, 'pages/PersonPage.module.css'), 'utf8');
    const mobileIdx = personCss.indexOf('@media (max-width: 768px)');
    expect(mobileIdx).toBeGreaterThan(-1);
    const mobileSpineRule = readCssBlock(personCss.slice(mobileIdx), '.timeline-spine {');
    expect(mobileSpineRule).toContain('top: calc(var(--topbar-height) - 2px);');
    expect(mobileSpineRule).toContain('z-index: 30;');
    expect(mobileSpineRule).toContain('background: var(--surface-canvas);');
    expect(mobileSpineRule).toContain('box-shadow: 0 -4px 0 var(--surface-canvas);');
  });
});

describe('WCAG 2.2 AA mobile touch targets, WCAG 1.4.12 text-spacing, and horizontal edge fades (#110)', () => {
  it('scrolls active ExplorerTopBar nav link into view with inline: center and wires non-stuck edge-fade CSS', () => {
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    mountEl(
      <MemoryRouter initialEntries={['/time']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );

    expect(scrollIntoViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'nearest', inline: 'center' })
    );

    const topBarCss = readFileSync(resolve(UI_SRC, 'components/ExplorerTopBar.module.css'), 'utf8');
    expect(topBarCss).toContain('@property --nav-fade-start');
    expect(topBarCss).toContain('@property --nav-fade-end');
    expect(topBarCss).toContain('.nav-links:not([data-overflowing="false"])');
    expect(topBarCss).toContain('animation-duration: auto, auto;');

    const controlsCss = readFileSync(resolve(UI_SRC, 'styles/Controls.module.css'), 'utf8');
    expect(controlsCss).toContain('@property --tabs-fade-start');
    expect(controlsCss).toContain('@property --tabs-fade-end');
    expect(controlsCss).toContain(':global(.evidence-tabs):not([data-overflowing="false"])');
  });

  it('allows .person-card-hook to grow under WCAG 1.4.12 text-spacing and enforces >=44px mobile touch targets', () => {
    const indexCss = readFileSync(resolve(UI_SRC, 'pages/IndexPage.module.css'), 'utf8');
    const hookRule = readCssBlock(indexCss, '.person-card-hook {');
    expect(hookRule).not.toContain('-webkit-line-clamp');
    expect(hookRule).not.toContain('line-clamp');
    expect(hookRule).not.toContain('overflow: hidden');
    const indexMobile640 = indexCss.slice(indexCss.indexOf('@media (max-width: 640px)'));
    expect(readCssBlock(indexMobile640, '.index-about-toggle {')).toContain(
      'min-height: var(--control-height-touch);'
    );
    const indexMobile768 = indexCss.slice(indexCss.lastIndexOf('@media (max-width: 768px)'));
    expect(readCssBlock(indexMobile768, '.index-era-snapshot-link {')).toContain(
      'min-height: var(--control-height-touch);'
    );

    const wikiPanelsCss = readFileSync(resolve(UI_SRC, 'components/wiki/WikiPanels.module.css'), 'utf8');
    const wikiMobile = wikiPanelsCss.slice(wikiPanelsCss.lastIndexOf('@media (max-width: 768px)'));
    expect(readCssBlock(wikiMobile, '.wiki-entity-link {')).toContain(
      'min-height: var(--control-height-touch);'
    );

    const onboardingCss = readFileSync(
      resolve(UI_SRC, 'components/OnboardingChecklistCard.module.css'),
      'utf8'
    );
    expect(onboardingCss).toContain('min-block-size: var(--control-height-touch);');
    expect(onboardingCss).not.toContain('min-block-size: 42px;');

    const evidenceCss = readFileSync(resolve(UI_SRC, 'pages/EvidencePage.module.css'), 'utf8');
    const evidenceMobile = evidenceCss.slice(evidenceCss.lastIndexOf('@media (max-width: 768px)'));
    expect(readCssBlock(evidenceMobile, '.evidence-gap-cta {')).toContain(
      'min-height: var(--control-height-touch);'
    );

    const placeCss = readFileSync(resolve(UI_SRC, 'pages/PlacePage.module.css'), 'utf8');
    const placeMobile = placeCss.slice(placeCss.lastIndexOf('@media (max-width: 768px)'));
    expect(readCssBlock(placeMobile, '.place-breadcrumb a {')).toContain(
      'min-height: var(--control-height-touch);'
    );
    expect(readCssBlock(placeMobile, '.place-scope-bar {')).toContain('flex-wrap: nowrap;');

    const timeCss = readFileSync(resolve(UI_SRC, 'pages/TimePage.module.css'), 'utf8');
    const timeMobile = timeCss.slice(timeCss.lastIndexOf('@media (max-width: 768px)'));
    expect(readCssBlock(timeMobile, '.time-lane-place a {')).toContain(
      'min-height: var(--control-height-touch);'
    );

    const markdownCss = readFileSync(resolve(UI_SRC, 'components/ArchivalMarkdown.module.css'), 'utf8');
    const mdMobile = markdownCss.slice(markdownCss.lastIndexOf('@media (pointer: coarse)'));
    const footnoteRule = readCssBlock(mdMobile, '.archival-footnote-ref {');
    expect(footnoteRule).toContain('min-width: var(--control-height-touch);');
    expect(footnoteRule).toContain('min-height: var(--control-height-touch);');

    const pronCss = readFileSync(resolve(UI_SRC, 'components/PronunciationBadge.module.css'), 'utf8');
    expect(pronCss).toContain('.pronunciation-badge:global(.is-compact) .pronunciation-play-btn');
  });
});
