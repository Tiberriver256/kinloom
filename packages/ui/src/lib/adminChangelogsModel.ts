import type {
  AdminChangelogsResponse,
  ChangelogCategory,
  ChangelogEntry,
  ModuleChangelog,
} from '@kinloom/core';
import { fastLocaleCompare } from '@kinloom/core';

export type ChangelogKindFilter = 'all' | 'module' | 'plugin';
export type ChangelogCategoryFilter = 'all' | ChangelogCategory;

export interface UiPluginChangelogSource {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly changelog?: readonly ChangelogEntry[];
}

export const CHANGELOG_CATEGORY_LABELS: Readonly<Record<ChangelogCategory, string>> = {
  added: 'Added',
  changed: 'Changed',
  fixed: 'Fixed',
  security: 'Security',
  breaking: 'Breaking',
};

function compareSemverDesc(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (partsB[i] ?? 0) - (partsA[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function mergeEntriesByVersion(
  primary: readonly ChangelogEntry[],
  secondary: readonly ChangelogEntry[]
): ChangelogEntry[] {
  const byVersion = new Map<string, ChangelogEntry>();
  for (const entry of primary) {
    byVersion.set(entry.version, {
      ...entry,
      changes: [...entry.changes],
    });
  }
  for (const entry of secondary) {
    const existing = byVersion.get(entry.version);
    if (!existing) {
      byVersion.set(entry.version, {
        ...entry,
        changes: [...entry.changes],
      });
    } else {
      const seenTexts = new Set(existing.changes.map((c) => `${c.category}:${c.text}`));
      const extraChanges = entry.changes.filter((c) => !seenTexts.has(`${c.category}:${c.text}`));
      byVersion.set(entry.version, {
        ...existing,
        changes: [...existing.changes, ...extraChanges],
      });
    }
  }
  return [...byVersion.values()].toSorted((a, b) => compareSemverDesc(a.version, b.version));
}

export function mergeAdminChangelogs(params: {
  readonly serverChangelogs: AdminChangelogsResponse | null;
  readonly uiPlugins: readonly UiPluginChangelogSource[];
}): ModuleChangelog[] {
  const { serverChangelogs, uiPlugins } = params;
  const modules: ModuleChangelog[] = serverChangelogs ? [...serverChangelogs.modules] : [];
  const pluginMap = new Map<string, ModuleChangelog>();

  for (const srvPlugin of serverChangelogs?.plugins ?? []) {
    pluginMap.set(srvPlugin.id, {
      ...srvPlugin,
      entries: [...srvPlugin.entries].toSorted((a, b) => compareSemverDesc(a.version, b.version)),
    });
  }

  for (const uiPlugin of uiPlugins) {
    const uiEntries = uiPlugin.changelog ?? [];
    const existing = pluginMap.get(uiPlugin.id);
    if (existing) {
      pluginMap.set(uiPlugin.id, {
        ...existing,
        entries: mergeEntriesByVersion(existing.entries, uiEntries),
      });
    } else if (uiEntries.length > 0) {
      pluginMap.set(uiPlugin.id, {
        id: uiPlugin.id,
        name: uiPlugin.name,
        kind: 'ui_plugin',
        current_version: uiPlugin.version ?? uiEntries[0]?.version ?? '0.0.0',
        entries: [...uiEntries].toSorted((a, b) => compareSemverDesc(a.version, b.version)),
      });
    }
  }

  const plugins = [...pluginMap.values()].toSorted((a, b) => fastLocaleCompare(a.name, b.name));
  return [...modules, ...plugins];
}

export function filterAdminChangelogs(params: {
  readonly items: readonly ModuleChangelog[];
  readonly kindFilter: ChangelogKindFilter;
  readonly selectedId: string;
  readonly categoryFilter: ChangelogCategoryFilter;
}): ModuleChangelog[] {
  const { items, kindFilter, selectedId, categoryFilter } = params;
  const filtered: ModuleChangelog[] = [];

  for (const item of items) {
    if (kindFilter === 'module' && item.kind !== 'module') {
      continue;
    }
    if (kindFilter === 'plugin' && item.kind === 'module') {
      continue;
    }
    if (selectedId !== 'all' && item.id !== selectedId) {
      continue;
    }

    const matchingEntries =
      categoryFilter === 'all'
        ? item.entries
        : item.entries
            .map((entry) => ({
              ...entry,
              changes: entry.changes.filter((c) => c.category === categoryFilter),
            }))
            .filter((entry) => entry.changes.length > 0);

    if (matchingEntries.length > 0) {
      filtered.push({
        ...item,
        entries: matchingEntries,
      });
    }
  }

  return filtered;
}
