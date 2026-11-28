/** @vitest-environment jsdom */
import type { AdminChangelogsResponse } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filterAdminChangelogs,
  mergeAdminChangelogs,
  type UiPluginChangelogSource,
} from '../../lib/adminChangelogsModel.js';
import { KinloomPluginProvider } from '../../plugins/PluginContext.js';
import type { KinloomUiPlugin } from '../../plugins/types.js';
import { ChangelogsSection } from './ChangelogsSection.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SAMPLE_SERVER_CHANGELOGS: AdminChangelogsResponse = {
  generated_at: '2026-11-28T00:00:00.000Z',
  modules: [
    {
      id: '@kinloom/core',
      name: 'Kinloom Core',
      kind: 'module',
      current_version: '0.61.0',
      entries: [
        {
          version: '0.61.0',
          date: '2026-11-28',
          summary: 'Structured changelog schemas',
          changes: [
            { category: 'added', text: 'Typed ChangelogEntry schema.' },
            { category: 'security', text: 'Strict schema validation.' },
          ],
        },
        {
          version: '0.60.0',
          date: '2026-11-27',
          summary: 'Previous release',
          changes: [{ category: 'fixed', text: 'Fixed date formatting.' }],
        },
      ],
    },
  ],
  plugins: [
    {
      id: 'open-finance',
      name: 'Open Finance',
      kind: 'server_plugin',
      current_version: '0.61.0',
      entries: [
        {
          version: '0.61.0',
          date: '2026-11-28',
          summary: 'Server ledger updates',
          changes: [{ category: 'added', text: 'Server ledger API.' }],
        },
      ],
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

describe('adminChangelogsModel pure helpers (#56)', () => {
  it('merges server modules, server plugins, and client UI plugins with SemVer descending order and deduped changes', () => {
    const uiPlugins: UiPluginChangelogSource[] = [
      {
        id: 'open-finance',
        name: 'Open Finance',
        version: '0.61.0',
        changelog: [
          {
            version: '0.61.0',
            date: '2026-11-28',
            summary: 'UI ledger updates',
            changes: [
              { category: 'added', text: 'Server ledger API.' },
              { category: 'changed', text: 'Support page layout.' },
            ],
          },
          {
            version: '0.59.0',
            date: '2026-11-25',
            summary: 'Initial UI release',
            changes: [{ category: 'added', text: 'Initial support card.' }],
          },
        ],
      },
      {
        id: 'narrative-audio',
        name: 'Narrative Audio',
        version: '0.61.0',
        changelog: [
          {
            version: '0.61.0',
            date: '2026-11-28',
            summary: 'Audio dock',
            changes: [{ category: 'added', text: 'Persistent playback dock.' }],
          },
        ],
      },
      {
        id: 'no-changelog-plugin',
        name: 'No Changelog Plugin',
      },
    ];

    const merged = mergeAdminChangelogs({
      serverChangelogs: SAMPLE_SERVER_CHANGELOGS,
      uiPlugins,
    });

    expect(merged.map((m) => m.id)).toEqual(['@kinloom/core', 'narrative-audio', 'open-finance']);
    const openFin = merged.find((m) => m.id === 'open-finance');
    expect(openFin?.entries.map((e) => e.version)).toEqual(['0.61.0', '0.59.0']);
    expect(openFin?.entries[0]?.changes).toHaveLength(2);

    expect(
      filterAdminChangelogs({ items: merged, kindFilter: 'module', selectedId: 'all', categoryFilter: 'all' })
    ).toHaveLength(1);
    expect(
      filterAdminChangelogs({ items: merged, kindFilter: 'plugin', selectedId: 'all', categoryFilter: 'all' })
    ).toHaveLength(2);
    expect(
      filterAdminChangelogs({
        items: merged,
        kindFilter: 'all',
        selectedId: '@kinloom/core',
        categoryFilter: 'security',
      })
    ).toHaveLength(1);
    expect(
      filterAdminChangelogs({
        items: merged,
        kindFilter: 'all',
        selectedId: 'all',
        categoryFilter: 'breaking',
      })
    ).toEqual([]);
  });
});

describe('ChangelogsSection Admin UI panel (#56)', () => {
  const sampleUiPlugin: KinloomUiPlugin = {
    id: 'narrative-audio',
    name: 'Narrative Audio',
    version: '0.61.0',
    changelog: [
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary: 'Kind-aware audio bar',
        changes: [{ category: 'added', text: 'Kind-aware margin bar.' }],
      },
    ],
  };

  it('renders nothing when unsupported and empty, and renders loading/error states cleanly', () => {
    const empty = mountEl(
      <KinloomPluginProvider plugins={[]}>
        <ChangelogsSection
          changelogs={null}
          loading={false}
          error={null}
          supported={false}
          onRefresh={vi.fn()}
        />
      </KinloomPluginProvider>
    );
    expect(empty.querySelector('#admin-changelogs')).toBeNull();

    const loadingEl = mountEl(
      <KinloomPluginProvider plugins={[]}>
        <ChangelogsSection
          changelogs={null}
          loading={true}
          error="Network timeout"
          supported={true}
          onRefresh={vi.fn()}
        />
      </KinloomPluginProvider>
    );
    expect(loadingEl.textContent).toContain('Network timeout');
    expect(loadingEl.textContent).toContain('Loading module and plugin changelogs');
  });

  it('renders merged changelogs and filters by kind, module/plugin, and category with Refresh action', () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const container = mountEl(
      <KinloomPluginProvider plugins={[sampleUiPlugin]}>
        <ChangelogsSection
          changelogs={SAMPLE_SERVER_CHANGELOGS}
          loading={false}
          error={null}
          supported={true}
          onRefresh={onRefresh}
        />
      </KinloomPluginProvider>
    );

    expect(container.querySelector('#admin-changelogs')).not.toBeNull();
    expect(container.textContent).toContain('Kinloom Core');
    expect(container.textContent).toContain('Open Finance');
    expect(container.textContent).toContain('Narrative Audio');

    // Filter to Modules only
    const modulesBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Modules'
    );
    act(() => {
      modulesBtn?.click();
    });
    expect(container.textContent).toContain('Kinloom Core');
    expect(container.textContent).not.toContain('Open Finance');

    // Switch back to All, filter by specific plugin via select
    const allBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'All'
    );
    act(() => {
      allBtn?.click();
    });

    const itemSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by module or plugin"]'
    );
    act(() => {
      if (itemSelect) {
        itemSelect.value = 'narrative-audio';
        itemSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const filteredCards = container.querySelectorAll('article');
    expect(filteredCards).toHaveLength(1);
    expect(filteredCards[0]?.textContent).toContain('Kind-aware margin bar.');
    expect(filteredCards[0]?.textContent).not.toContain('Kinloom Core');

    // Filter by Breaking category -> empty state
    const catSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by change category"]'
    );
    act(() => {
      if (catSelect) {
        catSelect.value = 'breaking';
        catSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(container.textContent).toContain('No changelog entries match the selected filters.');

    // Click Refresh
    const refreshBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Refresh'
    );
    act(() => {
      refreshBtn?.click();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
