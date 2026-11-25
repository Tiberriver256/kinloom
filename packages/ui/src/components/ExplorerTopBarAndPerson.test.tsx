/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, Narrative } from '@kinloom/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { ExplorerTopBar } from './ExplorerTopBar.js';
import { PersonPage } from '../pages/PersonPage.js';
import { SourceReaderDrawer } from './SourceReaderDrawer.js';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Barton Historical Archive',
    familyName: 'Barton Family',
    gedcomSourceName: 'BARTON_UI_TEST',
  },
});

function buildTestBundle(narratives: Narrative[]): ArchiveBundle {
  const { bundle } = compileArchive({
    siteConfig,
    mode: 'public',
    people: [
      {
        id: 'p_clara',
        slug: 'clara-barton',
        full_name: 'Clara Barton',
        given_name: 'Clara',
        surname: 'Barton',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1821-12-25',
        death_edtf: '1912-04-12',
        portrait_url: null,
      },
    ],
    places: [],
    events: [],
    sources: [
      {
        id: 'src_1821',
        citation: 'Oxford Vital Register (1821)',
        source_type: 'vital_record',
      },
    ],
    kinship: [],
    narratives,
  });
  return bundle;
}

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

describe('ExplorerTopBar mobile & account menu behavior', () => {
  it('renders compact account pill with initials and Primary Sources item inside menu when signed in', () => {
    const bundle = buildTestBundle([]);
    const dataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle, etag: null, notModified: false }),
      loadReadings: async () => ({
        version: 1,
        documents: {
          src_1821: {
            source_id: 'src_1821',
            title: 'Oxford Vital Register',
            author: 'Town Clerk',
            provenance: 'Public Town Archive',
            pages: [{ page: 1, label: 'Page 1', file: 'p1.txt', text: 'Clara Barton born Dec 25, 1821.' }],
          },
        },
        event_page_map: {},
      }),
      logout: async () => {},
    };

    const { container, unmount } = renderIntoDom(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={bundle}
          dataSource={dataSource}
          session={{
            authenticated: true,
            principal_kind: 'user',
            role: 'admin',
            displayName: 'Morgan Reid',
          }}
        >
          <ExplorerTopBar />
          <SourceReaderDrawer />
        </ArchiveProvider>
      </MemoryRouter>,
    );

    const accountBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Account menu for Morgan Reid"]',
    );
    expect(accountBtn).not.toBeNull();
    expect(accountBtn?.querySelector('.topbar-account-avatar')?.textContent).toBe('MR');
    // Old cluttered mobile "Find" button is removed in favor of compact icon search button
    const buttonTexts = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttonTexts).not.toContain('Find');
    expect(container.querySelector('button[aria-label="Search full archive"]')).not.toBeNull();

    act(() => {
      accountBtn?.click();
    });

    const menu = container.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Morgan Reid');
    expect(menu?.textContent).toContain('Primary Sources');
    expect(menu?.textContent).toContain('Recent Changes');
    expect(menu?.textContent).toContain('Site Settings');
    expect(menu?.textContent).toContain('Sign Out');

    const sourcesItem = [...(menu?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Primary Sources'),
    );
    act(() => {
      sourcesItem?.click();
    });
    expect(container.querySelector('[aria-label="Primary source transcription and scan reader"]')).not.toBeNull();

    unmount();
  });

  it('renders mobile Archive menu with Primary Sources when signed out', () => {
    const bundle = buildTestBundle([]);
    const { container, unmount } = renderIntoDom(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>,
    );

    expect(container.querySelector('button[aria-label^="Account menu for"]')).toBeNull();
    const menuBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Archive menu"]');
    expect(menuBtn).not.toBeNull();

    act(() => {
      menuBtn?.click();
    });

    const menu = container.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Primary Sources');
    expect(menu?.textContent).not.toContain('Sign Out');

    unmount();
  });
});

describe('PersonPage biography narratives and plain-English copy', () => {
  it('renders linked narratives safely without XSS, supports expand/collapse, and avoids build jargon', () => {
    const longBody = [
      '## Early Years in Oxford',
      '',
      'Born in **Oxford, Massachusetts**, Clara learned nursing at home and read *widely*.',
      '',
      `${'She kept detailed family letters across decades of service in New England and Washington. '.repeat(8)}`,
      '',
      '- Founded school in Bordentown',
      '- Avoided unsafe [clicked link](javascript:alert(1)) while keeping [Red Cross](https://example.org/history)',
    ].join('\n');

    const secondNarrative: Narrative = {
      id: 'nar_later_years',
      slug: 'later-years',
      title: 'Later Relief Work',
      summary: 'Organizing relief across the United States.',
      date_edtf: '1881/1912',
      person_ids: ['p_clara'],
      place_ids: [],
      event_ids: [],
      source_ids: [],
      body_md: 'Led disaster relief missions across states for more than two decades.',
    };

    const bundle = buildTestBundle([
      {
        id: 'nar_early',
        slug: 'early-years',
        title: 'Oxford Childhood & Teaching',
        summary: 'Formative years in Worcester County.',
        date_edtf: '1821/1854',
        person_ids: ['p_clara'],
        place_ids: [],
        event_ids: [],
        source_ids: ['src_1821'],
        body_md: longBody,
      },
      secondNarrative,
    ]);

    const { container, unmount } = renderIntoDom(
      <MemoryRouter initialEntries={['/person/clara-barton']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );

    const bioSection = container.querySelector('section[aria-label="Biography"]');
    expect(bioSection).not.toBeNull();
    expect(bioSection?.textContent).toContain('Oxford Childhood & Teaching');
    expect(bioSection?.textContent).toContain('1821–1854');
    expect(bioSection?.querySelector('strong')?.textContent).toBe('Oxford, Massachusetts');
    expect(bioSection?.querySelector('em')?.textContent).toBe('widely');
    expect(bioSection?.querySelector('h4')?.textContent).toBe('Early Years in Oxford');
    expect(bioSection?.querySelectorAll('.archival-md-list li').length).toBe(2);
    expect(bioSection?.querySelectorAll('.person-biography-source-list li').length).toBe(1);

    // Unsafe javascript: URL must NOT produce an <a> tag, while https:// link renders safely
    const links = [...(bioSection?.querySelectorAll('a') ?? [])];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.org/history']);
    expect(bioSection?.textContent).toContain('clicked link');

    // Long narrative starts collapsed and expands on click
    const collapsedBody = bioSection?.querySelector('.person-biography-body.is-collapsed');
    expect(collapsedBody).not.toBeNull();
    const expandBtn = [...(bioSection?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === 'Read full biography',
    );
    expect(expandBtn).not.toBeNull();
    act(() => {
      expandBtn?.click();
    });
    expect(bioSection?.querySelector('.person-biography-body.is-collapsed')).toBeNull();

    // Second narrative expands via "Read 1 more story"
    expect(bioSection?.textContent).not.toContain('Later Relief Work');
    const moreStoriesBtn = [...(bioSection?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === 'Read 1 more story',
    );
    expect(moreStoriesBtn).not.toBeNull();
    act(() => {
      moreStoriesBtn?.click();
    });
    expect(bioSection?.textContent).toContain('Later Relief Work');

    // Plain-English empty state with zero technical jargon
    expect(container.textContent).toContain('No dated events recorded yet for Clara Barton.');
    expect(container.textContent).not.toContain('in this build');

    unmount();
  });
});
