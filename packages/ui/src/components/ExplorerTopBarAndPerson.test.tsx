/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, Narrative } from '@kinloom/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { AuthStatusBanner, getInviteStripDismissKey } from './wiki/AuthStatusBanner.js';
import { ExplorerTopBar } from './ExplorerTopBar.js';
import { PersonPage } from '../pages/PersonPage.js';
import { SourceReaderDrawer } from './SourceReaderDrawer.js';
import { TreePage } from '../pages/TreePage.js';
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
      {
        id: 'p_stephen',
        slug: 'stephen-barton',
        full_name: 'Stephen Barton',
        given_name: 'Stephen',
        surname: 'Barton',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1774-08-18',
        death_edtf: '1862-03-21',
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
      {
        id: 'src_1850',
        citation: '1850 U.S. Federal Census, Worcester County, Massachusetts, Roll 344, Page 192.',
        source_type: 'census',
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

  it('keeps Sign in to edit accessible in ExplorerTopBar and Archive menu after invite strip is dismissed', () => {
    window.sessionStorage.clear();
    const bundle = buildTestBundle([]);
    const { container, unmount } = renderIntoDom(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={bundle}
          session={{
            authenticated: false,
            principal_kind: 'invite_viewer',
            role: 'viewer',
            inviteLabel: 'Summer Reunion',
          }}
        >
          <AuthStatusBanner />
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>,
    );

    const dismissBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss family invite notice"]',
    );
    act(() => {
      dismissBtn?.click();
    });
    expect(container.querySelector('.wiki-auth-banner')).toBeNull();
    expect(window.sessionStorage.getItem(getInviteStripDismissKey('Summer Reunion'))).toBe('1');

    // Mobile/archive menu still provides Sign in to edit and opens SignInModal
    const menuBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Archive menu"]');
    act(() => {
      menuBtn?.click();
    });
    const menuSignInBtn = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (b) => b.textContent?.trim() === 'Sign in to edit',
    );
    expect(menuSignInBtn).not.toBeNull();
    act(() => {
      menuSignInBtn?.click();
    });
    expect(container.querySelector('dialog[aria-label="Sign in to family archive"]')).not.toBeNull();

    unmount();
    window.sessionStorage.clear();
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

    // Sources are collapsed by default behind a Sources (N) toggle and expand on click
    expect(bioSection?.querySelectorAll('.person-biography-source-list li').length).toBe(0);
    const sourcesToggleBtn = [...(bioSection?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Sources (1)'),
    );
    expect(sourcesToggleBtn?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      sourcesToggleBtn?.click();
    });
    expect(sourcesToggleBtn?.getAttribute('aria-expanded')).toBe('true');
    expect(bioSection?.querySelectorAll('.person-biography-source-list li').length).toBe(1);
    expect(bioSection?.querySelector('.person-biography-source-text')?.textContent).toContain(
      'Oxford Vital Register (1821)',
    );

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

  it('scopes biography narratives strictly to subject_person_id and renders shared essays under collapsed Family Stories', () => {
    const bundle = buildTestBundle([
      {
        id: 'nar_clara_life',
        slug: 'clara-full-life',
        kind: 'biography',
        subject_person_id: 'p_clara',
        title: 'Clara Barton: Full Life',
        summary: 'Biography centered on Clara Barton.',
        date_edtf: '1821/1912',
        person_ids: ['p_clara', 'p_stephen'],
        place_ids: [],
        event_ids: [],
        source_ids: ['src_1821', 'src_1850'],
        body_md: 'Clara Barton grew up in Oxford with her father Stephen Barton.',
      },
      {
        id: 'nar_oxford_homestead',
        slug: 'oxford-homestead-essay',
        kind: 'family_story',
        title: 'The Oxford Homestead Lineage',
        summary: 'Shared family essay spanning two generations.',
        date_edtf: '1774/1912',
        person_ids: ['p_clara', 'p_stephen'],
        place_ids: [],
        event_ids: [],
        source_ids: ['src_1850'],
        body_md: 'Multi-generation account of the Barton family farm in Oxford.',
      },
    ]);

    // On subject's page (Clara): Biography shows Clara's bio with collapsed Sources (2), Family Stories shows essay collapsed
    const claraView = renderIntoDom(
      <MemoryRouter initialEntries={['/person/clara-barton']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );

    const claraBio = claraView.container.querySelector('section[aria-label="Biography"]');
    expect(claraBio?.textContent).toContain('Clara Barton: Full Life');
    expect(claraBio?.textContent).not.toContain('The Oxford Homestead Lineage');
    expect(claraBio?.querySelectorAll('.person-biography-source-list li').length).toBe(0);

    const claraSourcesBtn = [...(claraBio?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Sources (2)'),
    );
    expect(claraSourcesBtn?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      claraSourcesBtn?.click();
    });
    expect(claraSourcesBtn?.getAttribute('aria-expanded')).toBe('true');
    expect(claraBio?.querySelectorAll('.person-biography-source-list li').length).toBe(2);

    const claraStories = claraView.container.querySelector('section[aria-label="Family Stories"]');
    expect(claraStories?.textContent).toContain('The Oxford Homestead Lineage');
    expect(claraStories?.textContent).toContain('Shared family essay spanning two generations.');
    expect(claraStories?.textContent).not.toContain('Multi-generation account of the Barton family farm');

    const readStoryBtn = [...(claraStories?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === 'Read story',
    );
    expect(readStoryBtn?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      readStoryBtn?.click();
    });
    expect(readStoryBtn?.getAttribute('aria-expanded')).toBe('true');
    expect(claraStories?.textContent).toContain('Multi-generation account of the Barton family farm');
    claraView.unmount();

    // On co-mentioned relative's page (Stephen): Clara's biography MUST NOT appear anywhere
    const stephenView = renderIntoDom(
      <MemoryRouter initialEntries={['/person/stephen-barton']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );

    expect(stephenView.container.querySelector('section[aria-label="Biography"]')).toBeNull();
    expect(stephenView.container.textContent).not.toContain('Clara Barton: Full Life');

    const stephenStories = stephenView.container.querySelector('section[aria-label="Family Stories"]');
    expect(stephenStories?.textContent).toContain('The Oxford Homestead Lineage');
    stephenView.unmount();
  });

  it('shows + Add parent / + Add spouse / + Add child on PersonPage for editors even with 0 relatives and hides them for viewers', () => {
    const bundle = buildTestBundle([]);

    // Read-only viewer on a root ancestor with 0 kinship edges sees no empty strip or add buttons
    const viewerRender = renderIntoDom(
      <MemoryRouter initialEntries={['/person/stephen-barton']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );
    expect(viewerRender.container.querySelector('.person-family-strip')).toBeNull();
    expect(viewerRender.container.textContent).not.toContain('+ Add parent');
    viewerRender.unmount();

    // Signed-in editor sees Parents, Spouse, Children rows with contextual add buttons
    const editorRender = renderIntoDom(
      <MemoryRouter initialEntries={['/person/stephen-barton']}>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={bundle}
          session={{
            authenticated: true,
            principal_kind: 'user',
            role: 'editor',
            displayName: 'Morgan Reid',
          }}
        >
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>,
    );

    const familyStrip = editorRender.container.querySelector('[aria-label="Immediate family connections"]');
    expect(familyStrip).not.toBeNull();
    const addButtons = [...(familyStrip?.querySelectorAll('button') ?? [])].map((b) =>
      b.textContent?.trim(),
    );
    expect(addButtons).toEqual(['+ Add parent', '+ Add spouse', '+ Add child']);

    const addParentBtn = [...(familyStrip?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === '+ Add parent',
    );
    act(() => {
      addParentBtn?.click();
    });

    const dialog = editorRender.container.querySelector('dialog[aria-label="Add parent of Stephen Barton"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Create new person');
    expect(dialog?.textContent).toContain('Link existing person');

    editorRender.unmount();
  });

  it('shows + Add Person button on TreePage for editors and hides it for read-only viewers', () => {
    const bundle = buildTestBundle([]);

    const viewerTree = renderIntoDom(
      <MemoryRouter initialEntries={['/tree']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>,
    );
    expect(viewerTree.container.textContent).not.toContain('+ Add Person');
    viewerTree.unmount();

    const editorTree = renderIntoDom(
      <MemoryRouter initialEntries={['/tree']}>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={bundle}
          session={{
            authenticated: true,
            principal_kind: 'user',
            role: 'editor',
            displayName: 'Morgan Reid',
          }}
        >
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>,
    );
    const addPersonBtn = [...editorTree.container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '+ Add Person',
    );
    expect(addPersonBtn).not.toBeNull();

    act(() => {
      addPersonBtn?.click();
    });
    expect(
      editorTree.container.querySelector('dialog[aria-label="Add to the Family Archive"]'),
    ).not.toBeNull();

    editorTree.unmount();
  });
});
