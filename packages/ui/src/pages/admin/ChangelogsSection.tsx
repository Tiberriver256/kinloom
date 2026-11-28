import type { AdminChangelogsResponse, ChangelogCategory } from '@kinloom/core';
import type React from 'react';
import { useMemo, useState } from 'react';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import {
  CHANGELOG_CATEGORY_LABELS,
  type ChangelogCategoryFilter,
  type ChangelogKindFilter,
  filterAdminChangelogs,
  mergeAdminChangelogs,
} from '../../lib/adminChangelogsModel.js';
import { cx } from '../../lib/cx.js';
import { useKinloomPlugins } from '../../plugins/PluginContext.js';
import controlStyles from '../../styles/Controls.module.css';
import changelogStyles from './ChangelogsSection.module.css';

export interface ChangelogsSectionProps {
  readonly changelogs: AdminChangelogsResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly supported: boolean;
  readonly onRefresh: () => Promise<void>;
}

const CATEGORIES: readonly ChangelogCategory[] = ['added', 'changed', 'fixed', 'security', 'breaking'];

export const ChangelogsSection: React.FC<ChangelogsSectionProps> = ({
  changelogs,
  loading,
  error,
  supported,
  onRefresh,
}) => {
  const { plugins: uiPlugins } = useKinloomPlugins();
  const [kindFilter, setKindFilter] = useState<ChangelogKindFilter>('all');
  const [selectedId, setSelectedId] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<ChangelogCategoryFilter>('all');

  const merged = useMemo(
    () =>
      mergeAdminChangelogs({
        serverChangelogs: changelogs,
        uiPlugins,
      }),
    [changelogs, uiPlugins]
  );

  const visibleItems = useMemo(
    () =>
      filterAdminChangelogs({
        items: merged,
        kindFilter,
        selectedId,
        categoryFilter,
      }),
    [merged, kindFilter, selectedId, categoryFilter]
  );

  if (!supported && merged.length === 0) {
    return null;
  }

  return (
    <section
      id="admin-changelogs"
      className={cx(wikiPanelStyles, 'wiki-admin-section')}
      aria-labelledby="admin-changelogs-heading"
    >
      <div className={cx(changelogStyles, 'changelog-header')}>
        <div>
          <h2 id="admin-changelogs-heading">Changelogs &amp; What&apos;s New</h2>
          <p className={cx(changelogStyles, 'changelog-lead')}>
            Versioned release notes for installed Kinloom modules, server plugins, and UI extensions.
          </p>
        </div>
        {supported && (
          <button
            type="button"
            className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
            disabled={loading}
            onClick={() => {
              void onRefresh();
            }}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {error && (
        <p className={cx(controlStyles, 'empty-ring-note')} role="alert">
          {error}
        </p>
      )}

      {loading && merged.length === 0 ? (
        <p className={cx(controlStyles, 'empty-ring-note')}>Loading module and plugin changelogs…</p>
      ) : (
        <>
          <div className={cx(changelogStyles, 'changelog-filters')}>
            <div
              role="group"
              aria-label="Filter changelogs by component type"
              className={cx(changelogStyles, 'changelog-segmented')}
            >
              {(['all', 'module', 'plugin'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={cx(
                    changelogStyles,
                    kindFilter === kind ? 'changelog-seg-btn is-active' : 'changelog-seg-btn'
                  )}
                  aria-pressed={kindFilter === kind}
                  onClick={() => {
                    setKindFilter(kind);
                    setSelectedId('all');
                  }}
                >
                  {kind === 'all' ? 'All' : kind === 'module' ? 'Modules' : 'Plugins'}
                </button>
              ))}
            </div>

            <select
              aria-label="Filter by module or plugin"
              className={cx(changelogStyles, 'changelog-select')}
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
              }}
            >
              <option value="all">All modules &amp; plugins ({merged.length})</option>
              {merged
                .filter((item) =>
                  kindFilter === 'all'
                    ? true
                    : kindFilter === 'module'
                      ? item.kind === 'module'
                      : item.kind !== 'module'
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} (v{item.current_version})
                  </option>
                ))}
            </select>

            <select
              aria-label="Filter by change category"
              className={cx(changelogStyles, 'changelog-select')}
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value as ChangelogCategoryFilter);
              }}
            >
              <option value="all">All categories</option>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {CHANGELOG_CATEGORY_LABELS[cat]}
                </option>
              ))}
            </select>
          </div>

          {visibleItems.length === 0 ? (
            <p className={cx(controlStyles, 'empty-ring-note')}>
              No changelog entries match the selected filters.
            </p>
          ) : (
            <div className={cx(changelogStyles, 'changelog-list')}>
              {visibleItems.map((item) => (
                <article key={item.id} className={cx(changelogStyles, 'changelog-module-card')}>
                  <header className={cx(changelogStyles, 'changelog-module-header')}>
                    <div className={cx(changelogStyles, 'changelog-module-title-row')}>
                      <h3 className={cx(changelogStyles, 'changelog-module-name')}>{item.name}</h3>
                      <span className={cx(changelogStyles, 'changelog-module-id')}>{item.id}</span>
                    </div>
                    <div className={cx(changelogStyles, 'changelog-module-badges')}>
                      <span className={cx(changelogStyles, 'changelog-kind-badge')}>
                        {item.kind === 'module'
                          ? 'Core Module'
                          : item.kind === 'server_plugin'
                            ? 'Server Plugin'
                            : 'UI Plugin'}
                      </span>
                      <span className={cx(changelogStyles, 'changelog-version-badge')}>
                        v{item.current_version}
                      </span>
                    </div>
                  </header>

                  <div className={cx(changelogStyles, 'changelog-entries')}>
                    {item.entries.map((entry) => (
                      <div
                        key={`${item.id}-${entry.version}`}
                        className={cx(changelogStyles, 'changelog-entry')}
                      >
                        <div className={cx(changelogStyles, 'changelog-entry-meta')}>
                          <span className={cx(changelogStyles, 'changelog-entry-version')}>
                            v{entry.version}
                          </span>
                          <time className={cx(changelogStyles, 'changelog-entry-date')}>{entry.date}</time>
                          <span className={cx(changelogStyles, 'changelog-entry-summary')}>
                            {entry.summary}
                          </span>
                        </div>
                        <ul className={cx(changelogStyles, 'changelog-changes-list')}>
                          {entry.changes.map((change) => (
                            <li
                              key={`${entry.version}-${change.category}-${change.text}`}
                              className={cx(changelogStyles, 'changelog-change-item')}
                            >
                              <span
                                className={cx(changelogStyles, `changelog-cat-tag cat-${change.category}`)}
                              >
                                {CHANGELOG_CATEGORY_LABELS[change.category]}
                              </span>
                              <span>{change.text}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
};
