/** @vitest-environment jsdom */
import { type AdminDocsResponse, getBuiltinAdminDocs, validatePluginDocumentation } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterAdminDocs, getAdminDocKindLabel, mergeAdminDocs } from '../../lib/adminDocsModel.js';
import { createBookPublishingPlugin } from '../../plugins/bookPublishingPlugin.js';
import { createNarrativeAudioPlugin } from '../../plugins/narrativeAudioPlugin.js';
import { createObservabilityStatsPlugin } from '../../plugins/observabilityStatsPlugin.js';
import { createOpenFinancePlugin } from '../../plugins/openFinancePlugin.js';
import { KinloomPluginProvider } from '../../plugins/PluginContext.js';
import { createRecipesUiPlugin } from '../../plugins/recipesPlugin.js';
import type { KinloomUiPlugin } from '../../plugins/types.js';
import { validateAndCompileUiPlugins } from '../../plugins/validatePlugins.js';
import { AdminDocsSection } from './AdminDocsSection.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SAMPLE_SERVER_DOCS: AdminDocsResponse = {
  generated_at: '2026-11-28T04:20:00.000Z',
  core_docs: [...getBuiltinAdminDocs()],
  plugin_docs: [
    {
      id: 'docs-page-visit-stats',
      title: 'Page Visit Stats',
      summary: 'Privacy-preserving aggregate view counts.',
      kind: 'server_plugin',
      source_id: 'page-visit-stats',
      source_name: 'Page Visit Stats',
      sections: [
        {
          id: 'privacy',
          heading: 'Zero-Cookie Aggregate Counting',
          markdown:
            'Counts aggregate views safely. Raw HTML like <script>window.__xss=1</script> is never executed.',
        },
      ],
      external_url: 'https://example.test/docs/page-visit-stats',
    },
  ],
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

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe('AdminDocsModel & built-in UI plugin documentation contract (#55)', () => {
  it('merges server core docs, server plugin docs, and UI plugin docs without duplicates', () => {
    const uiPlugins: KinloomUiPlugin[] = [
      {
        id: 'narrative-audio',
        name: 'Narrative Audio',
        documentation: {
          id: 'docs-narrative-audio-ui',
          title: 'Narrative Audio Player',
          summary: 'Persistent audio playback for family narratives.',
          sections: [{ id: 'play', heading: 'Playback', markdown: 'Click Listen on any narrative.' }],
          externalUrl: 'https://example.test/docs/narrative-audio',
        },
      },
      {
        id: 'duplicate-doc-plugin',
        name: 'Duplicate Doc Plugin',
        documentation: {
          id: 'docs-page-visit-stats',
          title: 'Duplicate Page Visit Stats',
          summary: 'Should be deduplicated by id.',
          sections: [{ id: 'dup', heading: 'Dup', markdown: 'Dup.' }],
        },
      },
      {
        id: 'minimal-ui-plugin',
        name: 'Minimal UI Plugin',
      },
    ];

    const merged = mergeAdminDocs({ serverDocs: SAMPLE_SERVER_DOCS, uiPlugins });
    expect(merged.filter((d) => d.kind === 'core')).toHaveLength(5);
    expect(merged.filter((d) => d.kind === 'server_plugin')).toHaveLength(1);
    expect(merged.filter((d) => d.kind === 'ui_plugin')).toHaveLength(1);

    expect(filterAdminDocs({ docs: merged, kindFilter: 'core', query: '' })).toHaveLength(5);
    expect(filterAdminDocs({ docs: merged, kindFilter: 'plugin', query: '' })).toHaveLength(2);
    expect(filterAdminDocs({ docs: merged, kindFilter: 'all', query: 'SHA-256' })).toHaveLength(1);
    expect(filterAdminDocs({ docs: merged, kindFilter: 'all', query: 'narrative-audio' })).toHaveLength(1);
    expect(getAdminDocKindLabel('core')).toBe('Core Guide');
    expect(getAdminDocKindLabel('server_plugin')).toBe('Server Plugin');
    expect(getAdminDocKindLabel('ui_plugin')).toBe('UI Plugin');
  });

  it('verifies every built-in UI plugin ships valid structured documentation and rejects malformed plugin docs', () => {
    const builtinUiPlugins = [
      createNarrativeAudioPlugin(),
      createOpenFinancePlugin({ enabled: false }),
      createOpenFinancePlugin({ enabled: true }),
      createBookPublishingPlugin({ enabled: false }),
      createBookPublishingPlugin({ enabled: true }),
      createObservabilityStatsPlugin({ enabled: false }),
      createObservabilityStatsPlugin({ enabled: true }),
      createRecipesUiPlugin({ enabled: false }),
      createRecipesUiPlugin({ enabled: true }),
    ];

    for (const plugin of builtinUiPlugins) {
      expect(
        plugin.documentation,
        `Built-in UI plugin '${plugin.name}' must ship documentation`
      ).toBeDefined();
      const validated = validatePluginDocumentation(plugin.documentation, plugin.name);
      expect(validated.sections.length).toBeGreaterThan(0);
    }

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'broken-ui-docs',
          name: 'Broken UI Plugin',
          documentation: {
            id: 'broken',
            title: 'Broken',
            summary: 'Empty sections',
            sections: [],
          },
        },
      ])
    ).toThrow(RangeError);
  });
});

describe('AdminDocsSection interactive hub (#55)', () => {
  it('renders core and plugin docs, supports search and topic navigation, and sanitizes Markdown without executing scripts', () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const uiPlugin = createNarrativeAudioPlugin();

    const container = mountEl(
      <KinloomPluginProvider plugins={[uiPlugin]}>
        <AdminDocsSection
          docs={SAMPLE_SERVER_DOCS}
          loading={false}
          error={null}
          supported={true}
          onRefresh={onRefresh}
        />
      </KinloomPluginProvider>
    );

    expect(container.querySelector('#admin-docs-heading')?.textContent).toContain('Admin Documentation');
    const navButtons = Array.from(container.querySelectorAll('nav button'));
    expect(navButtons.length).toBe(7);

    // Navigate to Page Visit Stats plugin guide and verify XSS safety + external link
    const statsBtn = navButtons.find((b) => b.textContent?.includes('Page Visit Stats'));
    expect(statsBtn).toBeDefined();
    act(() => {
      statsBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('article h3')?.textContent).toBe('Page Visit Stats');
    expect(container.querySelectorAll('script')).toHaveLength(0);
    const externalLink = container.querySelector('a[href="https://example.test/docs/page-visit-stats"]');
    expect(externalLink).not.toBeNull();

    // Filter to Plugins only
    const pluginsBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Plugins'
    );
    act(() => {
      pluginsBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelectorAll('nav button')).toHaveLength(2);

    // Search for a non-existent term -> empty state
    const searchInput = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(searchInput).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(searchInput, 'zzz-no-match-xyz');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('No documentation guides match your search or filter.');

    // Trigger refresh button
    const refreshBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Refresh'
    );
    act(() => {
      refreshBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders loading and error states and hides when unsupported with no plugin docs', () => {
    const emptyContainer = mountEl(
      <KinloomPluginProvider plugins={[]}>
        <AdminDocsSection
          docs={null}
          loading={false}
          error={null}
          supported={false}
          onRefresh={async () => {}}
        />
      </KinloomPluginProvider>
    );
    expect(emptyContainer.innerHTML).toBe('');

    const loadingContainer = mountEl(
      <KinloomPluginProvider plugins={[]}>
        <AdminDocsSection
          docs={null}
          loading={true}
          error="Failed to load docs"
          supported={true}
          onRefresh={async () => {}}
        />
      </KinloomPluginProvider>
    );
    expect(loadingContainer.querySelector('[role="alert"]')?.textContent).toBe('Failed to load docs');
    expect(loadingContainer.textContent).toContain('Loading administration documentation');
  });
});
