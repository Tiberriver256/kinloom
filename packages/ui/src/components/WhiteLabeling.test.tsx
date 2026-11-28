/** @vitest-environment jsdom */

import assert from 'node:assert/strict';
import type { ArchiveBundle, KinloomSiteConfig, ReadingsBundle } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { test } from 'vitest';
import { KinloomApp } from '../KinloomApp.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const customSiteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Barton & Adams Family Archive',
    familyName: 'Barton & Adams Family',
    gedcomSourceName: 'BARTON_ADAMS_TEST',
    description: 'Synthetic historical test archive.',
    footerCredit: 'Built with Kinloom',
  },
  theme: {
    accent: '#2F5245',
  },
  branches: [
    {
      id: 'barton',
      label: 'Barton Line',
      surnames: ['Barton'],
      lineageGroups: ['ancestor', 'pivot_ancestor'],
      supportsDirectMode: true,
    },
  ],
  lineageSections: [
    {
      id: 'main',
      title: 'Massachusetts Founders',
      lineageGroups: ['pivot_ancestor'],
    },
  ],
  featuredDocumentId: 'src_diary_1850',
});

const { bundle: testBundle }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: customSiteConfig,
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
  places: [
    {
      id: 'pl_oxford_ma',
      slug: 'oxford-massachusetts',
      name: 'Oxford',
      full_name: 'Oxford, Worcester County, Massachusetts, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.12,
      lng: -71.86,
    },
  ],
  events: [
    {
      id: 'evt_1821_birth',
      title: 'Birth of Clara Barton',
      scope: 'personal',
      event_kind: 'residence_anchor',
      edtf_date: '1821-12-25',
      place_id: 'pl_oxford_ma',
      summary: 'Born in Oxford, Massachusetts.',
      participants: [{ person_id: 'p_clara', role: 'principal' }],
      sources: [{ source_id: 'src_diary_1850', confidence: 'high' }],
    },
  ],
  sources: [
    {
      id: 'src_diary_1850',
      citation: 'Oxford Town Vital Register (1821)',
      source_type: 'vital_record',
    },
  ],
  kinship: [],
});

const testReadings: ReadingsBundle = {
  version: 1,
  documents: {
    src_diary_1850: {
      source_id: 'src_diary_1850',
      title: 'Oxford Town Vital Register (1821)',
      author: 'Town Clerk of Oxford',
      provenance: 'Public-domain test register',
      pages: [
        {
          page: 1,
          label: 'Page 1',
          file: 'oxford-p1.txt',
          text: 'Clarissa Harlowe Barton, born December 25, 1821.',
        },
      ],
    },
  },
  event_page_map: {
    evt_1821_birth: { src_diary_1850: 1 },
  },
};

test('KinloomApp applies white-label title, theme accent, custom loader, and quiet footer credit', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <KinloomApp
        siteConfig={customSiteConfig}
        initialEntries={['/']}
        loader={{
          loadArchive: async () => testBundle,
          loadReadings: async () => testReadings,
        }}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  // Top bar leads with family title, never "Kinloom"
  const brandLink = container.querySelector('.brand-link');
  assert.equal(brandLink?.textContent, 'Barton & Adams Family Archive');
  assert.equal(document.title, 'Barton & Adams Family Archive');

  // Theme accent override is scoped to --site-accent-light so dark mode retains AAA warm brass
  const appEl = container.querySelector<HTMLElement>('.kinloom-app');
  assert.equal(appEl?.style.getPropertyValue('--site-accent-light'), '#2F5245');
  assert.equal(appEl?.style.getPropertyValue('--accent-primary'), '');
  assert.equal(appEl?.style.getPropertyValue('--radar-copresence'), '');

  // By Era section and person card rendered (while customSiteConfig.lineageSections stays backwards-compatible)
  assert.match(container.textContent ?? '', /1800–1849/);
  assert.match(container.textContent ?? '', /Clara Barton/);

  // Quiet footer displays "Built with Kinloom" + SVG mark
  const footer = container.querySelector('footer.kinloom-footer');
  assert.ok(footer);
  assert.match(footer?.textContent ?? '', /Built with Kinloom/);
  assert.ok(footer?.querySelector('svg[aria-label="Kinloom mark"]'));

  act(() => {
    root.unmount();
  });
  container.remove();
});

test('KinloomApp scopes optional theme.accentDark to --site-accent-dark without clobbering --accent-primary', async () => {
  const darkAccentConfig: KinloomSiteConfig = parseKinloomConfig({
    ...customSiteConfig,
    theme: {
      accent: '#2F5245',
      accentDark: '#7CC2A6',
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <KinloomApp
        siteConfig={darkAccentConfig}
        initialEntries={['/']}
        loader={{
          loadArchive: async () => testBundle,
          loadReadings: async () => testReadings,
        }}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  const appEl = container.querySelector<HTMLElement>('.kinloom-app');
  assert.equal(appEl?.style.getPropertyValue('--site-accent-light'), '#2F5245');
  assert.equal(appEl?.style.getPropertyValue('--site-accent-dark'), '#7CC2A6');
  assert.equal(appEl?.style.getPropertyValue('--accent-primary'), '');

  act(() => {
    root.unmount();
  });
  container.remove();
});

test('KinloomApp handles accentDark-only config and omitted theme config cleanly', async () => {
  const accentDarkOnlyConfig: KinloomSiteConfig = parseKinloomConfig({
    site: {
      title: 'Alder Dark Accent Only',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_DARK_ONLY',
    },
    theme: {
      accentDark: '#7CC2A6',
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <KinloomApp
        siteConfig={accentDarkOnlyConfig}
        initialEntries={['/']}
        initialBundle={testBundle}
        initialReadings={testReadings}
      />
    );
  });

  const appEl = container.querySelector<HTMLElement>('.kinloom-app');
  assert.equal(appEl?.style.getPropertyValue('--site-accent-light'), '');
  assert.equal(appEl?.style.getPropertyValue('--site-accent-dark'), '#7CC2A6');

  const noThemeConfig: KinloomSiteConfig = parseKinloomConfig({
    site: {
      title: 'Alder Default Theme',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_NO_THEME',
    },
  });

  await act(async () => {
    root.render(
      <KinloomApp
        siteConfig={noThemeConfig}
        initialEntries={['/']}
        initialBundle={testBundle}
        initialReadings={testReadings}
      />
    );
  });

  const appElDefault = container.querySelector<HTMLElement>('.kinloom-app');
  assert.equal(appElDefault?.style.getPropertyValue('--site-accent-light'), '');
  assert.equal(appElDefault?.style.getPropertyValue('--site-accent-dark'), '');

  act(() => {
    root.unmount();
  });
  container.remove();
});

test('KinloomApp renders archival NotFoundPage on unknown routes with links back to People and Family Tree', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <KinloomApp
        siteConfig={customSiteConfig}
        initialEntries={['/does-not-exist']}
        loader={{
          loadArchive: async () => testBundle,
          loadReadings: async () => testReadings,
        }}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  const heading = container.querySelector('h1');
  assert.equal(heading?.textContent, 'Page Not Found');
  assert.match(container.textContent ?? '', /\/does-not-exist/);

  const homeLink = container.querySelector<HTMLAnchorElement>('a[href="/"].not-found-link');
  const treeLink = container.querySelector<HTMLAnchorElement>('a[href="/tree"].not-found-link');
  assert.ok(homeLink, 'Expected link back to Archive home (/)');
  assert.ok(treeLink, 'Expected link to Family Tree (/tree)');

  act(() => {
    root.unmount();
  });
  container.remove();
});
