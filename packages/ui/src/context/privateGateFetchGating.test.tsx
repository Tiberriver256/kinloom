/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { createHttpWikiDataSource } from '../adapters/httpWikiDataSource.js';
import { createHttpOpenFinanceClient } from '../adapters/openFinanceClient.js';
import { createHttpRecipesClient } from '../adapters/recipesClient.js';
import { KinloomApp } from '../KinloomApp.js';
import { createOpenFinancePlugin } from '../plugins/openFinancePlugin.js';
import { createRecipesUiPlugin } from '../plugins/recipesPlugin.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEST_SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Family Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_ARCHIVE',
    description: 'Private family archive.',
  },
});

const TEST_BUNDLE: ArchiveBundle = compileArchive({
  siteConfig: TEST_SITE_CONFIG,
  people: [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      birth_edtf: '1855',
      death_edtf: '1932',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder',
      has_primary_source: true,
      portrait_url: null,
      thumb_url: null,
    },
  ],
  places: [],
  events: [],
  sources: [],
  narratives: [],
  media: [],
  kinship: [],
  mode: 'public',
}).bundle;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function flushUi(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe('Private Archive Gate & capability-gated fetches (Issue #106)', () => {
  it('fires zero /api/bundle, /api/open-finance/summary, /api/plugins/recipes, /data/readings.json, or /data/media-checklist.json requests when unauthenticated on a private archive', async () => {
    const requestedUrls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      if (url.endsWith('/api/auth/me')) {
        return jsonRes({
          session: { authenticated: false, principal_kind: 'anonymous' },
          capabilities: {
            canEdit: false,
            canUploadMedia: false,
            hasRevisionHistory: false,
            hasTalk: false,
            canManageSite: false,
            canReadArchive: false,
            hasReadings: false,
            hasMediaChecklist: false,
          },
          authProviders: { google: true, magicLink: true },
        });
      }
      return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    };

    const dataSource = createHttpWikiDataSource({ fetchImpl });
    const openFinancePlugin = createOpenFinancePlugin({
      client: createHttpOpenFinanceClient({ fetchImpl }),
    });
    const recipesPlugin = createRecipesUiPlugin({
      client: createHttpRecipesClient({ fetchImpl }),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <KinloomApp
            siteConfig={TEST_SITE_CONFIG}
            dataSource={dataSource}
            plugins={[openFinancePlugin, recipesPlugin]}
            initialEntries={['/']}
          />
        );
      });

      await flushUi();

      expect(container.textContent).toMatch(/private family archive/i);
      expect(requestedUrls).toEqual(['/api/auth/me']);
      expect(requestedUrls.some((u) => u.includes('/api/bundle'))).toBe(false);
      expect(requestedUrls.some((u) => u.includes('/api/open-finance/summary'))).toBe(false);
      expect(requestedUrls.some((u) => u.includes('/api/plugins/recipes'))).toBe(false);
      expect(requestedUrls.some((u) => u.includes('/data/readings.json'))).toBe(false);
      expect(requestedUrls.some((u) => u.includes('/data/media-checklist.json'))).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('loads /api/bundle when authenticated while skipping /data/readings.json and /data/media-checklist.json when capabilities report false', async () => {
    const requestedUrls: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      if (url.endsWith('/api/auth/me')) {
        return jsonRes({
          session: {
            authenticated: true,
            principal_kind: 'user',
            email: 'member@example.test',
            displayName: 'Member',
            role: 'editor',
          },
          capabilities: {
            canEdit: true,
            canUploadMedia: true,
            hasRevisionHistory: true,
            hasTalk: true,
            canManageSite: false,
            canReadArchive: true,
            hasReadings: false,
            hasMediaChecklist: false,
          },
          authProviders: { google: true, magicLink: true },
        });
      }
      if (url.endsWith('/api/bundle')) {
        return jsonRes(TEST_BUNDLE);
      }
      if (url.endsWith('/api/pronunciations')) {
        return jsonRes({ pronunciations: {} });
      }
      return new Response('Not found', { status: 404 });
    };

    const dataSource = createHttpWikiDataSource({ fetchImpl });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <KinloomApp siteConfig={TEST_SITE_CONFIG} dataSource={dataSource} initialEntries={['/']} />
        );
      });

      await flushUi();

      expect(container.textContent).toContain('Henry Alder');
      expect(requestedUrls).toContain('/api/auth/me');
      expect(requestedUrls).toContain('/api/bundle');
      expect(requestedUrls.some((u) => u.includes('readings.json'))).toBe(false);
      expect(requestedUrls.some((u) => u.includes('media-checklist.json'))).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
