import type { AdminDocsResponse } from '@kinloom/core';
import type React from 'react';
import { useMemo, useState } from 'react';
import { ArchivalMarkdown } from '../../components/ArchivalMarkdown.js';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import {
  type AdminDocsKindFilter,
  filterAdminDocs,
  getAdminDocKindLabel,
  mergeAdminDocs,
} from '../../lib/adminDocsModel.js';
import { cx } from '../../lib/cx.js';
import { useKinloomPlugins } from '../../plugins/PluginContext.js';
import controlStyles from '../../styles/Controls.module.css';
import docsStyles from './AdminDocsSection.module.css';

export interface AdminDocsSectionProps {
  readonly docs: AdminDocsResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly supported: boolean;
  readonly onRefresh: () => Promise<void>;
}

export const AdminDocsSection: React.FC<AdminDocsSectionProps> = ({
  docs,
  loading,
  error,
  supported,
  onRefresh,
}) => {
  const { plugins: uiPlugins } = useKinloomPlugins();
  const [kindFilter, setKindFilter] = useState<AdminDocsKindFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mergedDocs = useMemo(
    () =>
      mergeAdminDocs({
        serverDocs: docs,
        uiPlugins,
      }),
    [docs, uiPlugins]
  );

  const filteredDocs = useMemo(
    () =>
      filterAdminDocs({
        docs: mergedDocs,
        kindFilter,
        query,
      }),
    [mergedDocs, kindFilter, query]
  );

  const activeDoc = useMemo(() => {
    if (filteredDocs.length === 0) {
      return null;
    }
    if (selectedId) {
      const match = filteredDocs.find((item) => item.id === selectedId);
      if (match) {
        return match;
      }
    }
    return filteredDocs[0] ?? null;
  }, [filteredDocs, selectedId]);

  if (!supported && mergedDocs.length === 0) {
    return null;
  }

  return (
    <section
      id="admin-docs"
      className={cx(wikiPanelStyles, 'wiki-admin-section')}
      aria-labelledby="admin-docs-heading"
    >
      <div className={cx(docsStyles, 'docs-header')}>
        <div>
          <h2 id="admin-docs-heading">Admin Documentation</h2>
          <p className={cx(docsStyles, 'docs-lead')}>
            Built-in server administration guides and documentation contributed by installed plugins.
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

      {loading && mergedDocs.length === 0 ? (
        <p className={cx(controlStyles, 'empty-ring-note')}>Loading administration documentation…</p>
      ) : (
        <>
          <div className={cx(docsStyles, 'docs-controls')}>
            <div
              role="group"
              aria-label="Filter documentation by source"
              className={cx(docsStyles, 'docs-segmented')}
            >
              {(['all', 'core', 'plugin'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={cx(docsStyles, kindFilter === kind ? 'docs-seg-btn is-active' : 'docs-seg-btn')}
                  aria-pressed={kindFilter === kind}
                  onClick={() => {
                    setKindFilter(kind);
                  }}
                >
                  {kind === 'all' ? 'All' : kind === 'core' ? 'Core Guides' : 'Plugins'}
                </button>
              ))}
            </div>

            <input
              type="search"
              aria-label="Search administration documentation"
              placeholder="Search guides, settings, or plugins…"
              className={cx(docsStyles, 'docs-search-input')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
            />
          </div>

          {filteredDocs.length === 0 || !activeDoc ? (
            <p className={cx(controlStyles, 'empty-ring-note')}>
              No documentation guides match your search or filter.
            </p>
          ) : (
            <div className={cx(docsStyles, 'docs-layout')}>
              <nav aria-label="Documentation topics" className={cx(docsStyles, 'docs-nav')}>
                {filteredDocs.map((item) => {
                  const isActive = item.id === activeDoc.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cx(docsStyles, isActive ? 'docs-nav-item is-active' : 'docs-nav-item')}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => {
                        setSelectedId(item.id);
                      }}
                    >
                      <span className={cx(docsStyles, 'docs-nav-title')}>{item.title}</span>
                      <span className={cx(docsStyles, 'docs-kind-badge')}>
                        {getAdminDocKindLabel(item.kind)}
                      </span>
                    </button>
                  );
                })}
              </nav>

              <article className={cx(docsStyles, 'docs-article')}>
                <header className={cx(docsStyles, 'docs-article-header')}>
                  <h3 className={cx(docsStyles, 'docs-article-title')}>{activeDoc.title}</h3>
                  <div className={cx(docsStyles, 'docs-article-meta')}>
                    <span className={cx(docsStyles, 'docs-kind-badge')}>
                      {getAdminDocKindLabel(activeDoc.kind)}
                    </span>
                    <span className={cx(docsStyles, 'docs-source-id')}>{activeDoc.source_id}</span>
                  </div>
                </header>

                <p className={cx(docsStyles, 'docs-article-summary')}>{activeDoc.summary}</p>

                {activeDoc.external_url && (
                  <a
                    href={activeDoc.external_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cx(docsStyles, 'docs-external-link')}
                  >
                    External reference documentation ↗
                  </a>
                )}

                <div className={cx(docsStyles, 'docs-sections')}>
                  {activeDoc.sections.map((section) => (
                    <div key={section.id} className={cx(docsStyles, 'docs-section-block')}>
                      <h4 className={cx(docsStyles, 'docs-section-heading')}>{section.heading}</h4>
                      <ArchivalMarkdown markdown={section.markdown} />
                    </div>
                  ))}
                </div>
              </article>
            </div>
          )}
        </>
      )}
    </section>
  );
};
