import type { AuthorType, RevisionRecord } from '@kinloom/core';
import { asBatchId, asRevisionId } from '@kinloom/core';
import { AuthorPill, CitationBadge } from '../components/wiki/WikiBadges.js';
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatArchivalTimestamp } from '../lib/formatTimestamp.js';
import { handleTablistKeyDown } from '../lib/keyboardNav.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { RevisionDiffView } from '../components/wiki/RevisionDiffView.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';

type AuthorFilter = 'all' | AuthorType;

type PendingConfirm =
  | { readonly kind: 'revision'; readonly rev: RevisionRecord }
  | { readonly kind: 'batch'; readonly batchId: string; readonly count: number };

interface FeedGroup {
  key: string;
  batchId: string | null;
  revisions: RevisionRecord[];
}

export interface RecentChangesPageProps {
  initialRevisions?: readonly RevisionRecord[];
}

export const RecentChangesPage: React.FC<RecentChangesPageProps> = ({ initialRevisions }) => {
  const { bundle, dataSource, capabilities, reloadArchive } = useArchiveData();
  const tabBaseId = useId();
  const [authorFilter, setAuthorFilter] = useState<AuthorFilter>('all');
  const [revisions, setRevisions] = useState<readonly RevisionRecord[]>(initialRevisions ?? []);
  const [loading, setLoading] = useState<boolean>(initialRevisions === undefined);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

  const entityLinkByKey = useMemo(() => {
    const map = new Map<string, { label: string; to: string | null }>();
    if (!bundle) {
      return map;
    }
    for (const p of bundle.people) {
      map.set(`person:${p.id}`, { label: p.full_name, to: `/person/${p.slug}` });
    }
    for (const pl of bundle.places) {
      map.set(`place:${pl.id}`, { label: pl.full_name || pl.name, to: `/place/${pl.slug}` });
    }
    for (const src of bundle.sources) {
      map.set(`source:${src.id}`, {
        label: src.citation,
        to: `/evidence?tab=citations&source=${encodeURIComponent(src.id)}`,
      });
    }
    return map;
  }, [bundle]);

  const renderEntityRef = (rev: RevisionRecord): React.ReactNode => {
    const resolved = entityLinkByKey.get(`${rev.entity_type}:${rev.entity_id}`);
    if (resolved?.to) {
      return (
        <span className="wiki-entity-ref">
          <Link to={resolved.to} className="wiki-entity-link">
            {resolved.label}
          </Link>
          <code className="wiki-entity-id">
            {rev.entity_type}/{rev.entity_id}
          </code>
        </span>
      );
    }
    return (
      <code className="wiki-entity-id">
        {rev.entity_type}/{rev.entity_id}
      </code>
    );
  };

  const loadFeed = useCallback(async (): Promise<void> => {
    if (!dataSource.listRevisions) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await dataSource.listRevisions({
        author_type: authorFilter === 'all' ? undefined : authorFilter,
        limit: 100,
      });
      setRevisions(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [dataSource, authorFilter]);

  useEffect(() => {
    if (initialRevisions !== undefined) {
      return;
    }
    void loadFeed();
  }, [initialRevisions, loadFeed]);

  const filteredRevisions = useMemo(() => {
    if (authorFilter === 'all') {
      return revisions;
    }
    return revisions.filter((r) => r.author_type === authorFilter);
  }, [revisions, authorFilter]);

  const groupedFeed = useMemo<FeedGroup[]>(() => {
    const groups: FeedGroup[] = [];
    const batchMap = new Map<string, FeedGroup>();

    for (const rev of filteredRevisions) {
      if (rev.batch_id) {
        const existing = batchMap.get(rev.batch_id);
        if (existing) {
          existing.revisions.push(rev);
        } else {
          const group: FeedGroup = {
            key: `batch:${rev.batch_id}`,
            batchId: rev.batch_id,
            revisions: [rev],
          };
          batchMap.set(rev.batch_id, group);
          groups.push(group);
        }
      } else {
        groups.push({
          key: `rev:${rev.revision_id}`,
          batchId: null,
          revisions: [rev],
        });
      }
    }
    return groups;
  }, [filteredRevisions]);

  const handleRevertRevision = async (rev: RevisionRecord): Promise<void> => {
    if (!dataSource.revertRevision) {
      return;
    }
    setBusyKey(`rev:${rev.revision_id}`);
    setPendingConfirm(null);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await dataSource.revertRevision(
        asRevisionId(rev.revision_id),
        `Revert r${rev.revision_id}`,
      );
      setStatusMessage(`Reverted r${rev.revision_id} in r${res.revision.revision_id}.`);
      reloadArchive();
      if (initialRevisions === undefined) {
        await loadFeed();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleRevertBatch = async (batchId: string): Promise<void> => {
    if (!dataSource.revertBatch) {
      return;
    }
    setBusyKey(`batch:${batchId}`);
    setPendingConfirm(null);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await dataSource.revertBatch(asBatchId(batchId), `Batch revert ${batchId}`);
      setStatusMessage(
        `Reverted batch ${batchId} across ${res.revisions.length} revision${res.revisions.length === 1 ? '' : 's'}.`,
      );
      reloadArchive();
      if (initialRevisions === undefined) {
        await loadFeed();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const tabpanelId = `${tabBaseId}-panel`;
  const activeTabId = `${tabBaseId}-tab-${authorFilter}`;

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className="place-page">
        <section className="wire-banner" style={{ marginBottom: 18 }}>
          <div>
            <h1>Revision History</h1>
            <p>
              Complete append-only revision history of family edits, research batches, and initial
              archive imports. Every revision or research batch can be reverted cleanly without
              losing history.
            </p>
          </div>
          <div className="folio-metrics">
            <div>
              <strong>{filteredRevisions.length}</strong> revisions shown
            </div>
            <div>
              <strong>{groupedFeed.filter((g) => g.batchId !== null).length}</strong> grouped
              research batches
            </div>
          </div>
        </section>

        <div
          className="filter-bar"
          role="tablist"
          aria-label="Filter revision history by author type"
          onKeyDown={(event) => {
            handleTablistKeyDown(
              event,
              ['all', 'human', 'agent', 'system_seed'] as const,
              authorFilter,
              (next) => {
                setAuthorFilter(next);
              },
            );
          }}
        >
          {(
            [
              ['all', 'All Authors'],
              ['human', 'Family Editors'],
              ['agent', 'Research Agents'],
              ['system_seed', 'Initial Seed'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              id={`${tabBaseId}-tab-${id}`}
              type="button"
              role="tab"
              tabIndex={authorFilter === id ? 0 : -1}
              aria-selected={authorFilter === id}
              aria-controls={tabpanelId}
              className={`pill-btn ${authorFilter === id ? 'active' : ''}`}
              onClick={() => {
                setAuthorFilter(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div id={tabpanelId} role="tabpanel" aria-labelledby={activeTabId}>
          {statusMessage && (
            <output className="wiki-status-banner is-success" aria-live="polite">
              {statusMessage}
            </output>
          )}
          {error && (
            <div className="wiki-status-banner is-error" role="alert">
              {error}
            </div>
          )}
          {loading && <p className="empty-ring-note">Loading revision history…</p>}
          {!loading && groupedFeed.length === 0 && (
            <p className="empty-ring-note">No revisions match the active author filter.</p>
          )}

          <div className="wiki-changes-feed">
            {groupedFeed.map((group) => {
              if (group.batchId) {
                const first = group.revisions[0];
                const confirmingBatch =
                  pendingConfirm?.kind === 'batch' && pendingConfirm.batchId === group.batchId;
                return (
                  <section key={group.key} className="place-map-box wiki-batch-group">
                    <div className="wiki-batch-header">
                      <div>
                        <div className="wiki-revision-topline">
                          <code className="wiki-batch-chip">Batch {group.batchId}</code>
                          <AuthorPill authorType={first.author_type} authorName={first.author_name} />
                          <span className="wiki-panel-meta">
                            {group.revisions.length} change{group.revisions.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="wiki-revision-time">
                          <time dateTime={first.created_at} title={first.created_at}>
                            {formatArchivalTimestamp(first.created_at)}
                          </time>
                        </div>
                      </div>
                      {capabilities.canEdit && dataSource.revertBatch && !confirmingBatch && (
                        <button
                          type="button"
                          className="pill-btn wiki-danger-btn"
                          disabled={busyKey !== null}
                          onClick={() => {
                            setPendingConfirm({
                              kind: 'batch',
                              batchId: group.batchId!,
                              count: group.revisions.length,
                            });
                          }}
                        >
                          {busyKey === group.key ? 'Reverting Batch…' : 'Revert Entire Batch'}
                        </button>
                      )}
                    </div>

                    {confirmingBatch && (
                      <div className="wiki-confirm-inline" role="alert">
                        <p className="wiki-confirm-inline-text">
                          Revert all <strong>{group.revisions.length}</strong> change
                          {group.revisions.length === 1 ? '' : 's'} in batch{' '}
                          <code>{group.batchId}</code>? This appends new revert revisions without
                          deleting history.
                        </p>
                        <div className="wiki-inline-actions">
                          <button
                            type="button"
                            className="pill-btn wiki-danger-btn"
                            disabled={busyKey !== null}
                            onClick={() => {
                              void handleRevertBatch(group.batchId!);
                            }}
                          >
                            Confirm Batch Revert
                          </button>
                          <button
                            type="button"
                            className="pill-btn"
                            disabled={busyKey !== null}
                            onClick={() => {
                              setPendingConfirm(null);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="wiki-revision-list">
                      {group.revisions.map((rev) => {
                        const isExpanded = expandedId === rev.revision_id;
                        const confirmingRev =
                          pendingConfirm?.kind === 'revision' &&
                          pendingConfirm.rev.revision_id === rev.revision_id;
                        return (
                          <article key={rev.revision_id} className="wiki-revision-item">
                            <div className="wiki-revision-row">
                              <div className="wiki-revision-main">
                                <div className="wiki-revision-topline">
                                  <code className="wiki-rev-id">r{rev.revision_id}</code>
                                  <span className={`wiki-action-tag action-${rev.action}`}>
                                    {rev.action}
                                  </span>
                                  {renderEntityRef(rev)}
                                  <CitationBadge hasPrimarySource={rev.has_primary_source} />
                                </div>
                                <div className="wiki-revision-summary">{rev.summary}</div>
                              </div>
                              <div className="wiki-revision-actions">
                                <button
                                  type="button"
                                  className="pill-btn"
                                  aria-expanded={isExpanded}
                                  onClick={() => {
                                    setExpandedId(isExpanded ? null : rev.revision_id);
                                  }}
                                >
                                  {isExpanded ? 'Hide Diff' : 'View Diff'}
                                </button>
                                {capabilities.canEdit && dataSource.revertRevision && !confirmingRev && (
                                  <button
                                    type="button"
                                    className="pill-btn wiki-danger-btn"
                                    disabled={busyKey !== null}
                                    onClick={() => {
                                      setPendingConfirm({ kind: 'revision', rev });
                                    }}
                                  >
                                    {busyKey === `rev:${rev.revision_id}` ? 'Reverting…' : 'Revert'}
                                  </button>
                                )}
                              </div>
                            </div>
                            {confirmingRev && (
                              <div className="wiki-confirm-inline" role="alert">
                                <p className="wiki-confirm-inline-text">
                                  Revert revision <code>r{rev.revision_id}</code> on{' '}
                                  <code>
                                    {rev.entity_type}/{rev.entity_id}
                                  </code>
                                  ?
                                </p>
                                <div className="wiki-inline-actions">
                                  <button
                                    type="button"
                                    className="pill-btn wiki-danger-btn"
                                    disabled={busyKey !== null}
                                    onClick={() => {
                                      void handleRevertRevision(rev);
                                    }}
                                  >
                                    Confirm Revert
                                  </button>
                                  <button
                                    type="button"
                                    className="pill-btn"
                                    disabled={busyKey !== null}
                                    onClick={() => {
                                      setPendingConfirm(null);
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                            {isExpanded && (
                              <div className="wiki-revision-diff-body">
                                <RevisionDiffView
                                  before={rev.before_json}
                                  after={rev.after_json}
                                  beforeLabel="Before"
                                  afterLabel={`r${rev.revision_id}`}
                                />
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                );
              }

              const [rev] = group.revisions;
              const isExpanded = expandedId === rev.revision_id;
              const confirmingRev =
                pendingConfirm?.kind === 'revision' &&
                pendingConfirm.rev.revision_id === rev.revision_id;
              return (
                <article key={group.key} className="place-map-box wiki-revision-item">
                  <div className="wiki-revision-row">
                    <div className="wiki-revision-main">
                      <div className="wiki-revision-topline">
                        <code className="wiki-rev-id">r{rev.revision_id}</code>
                        <span className={`wiki-action-tag action-${rev.action}`}>{rev.action}</span>
                        {renderEntityRef(rev)}
                        <AuthorPill authorType={rev.author_type} authorName={rev.author_name} />
                        <CitationBadge hasPrimarySource={rev.has_primary_source} />
                      </div>
                      <div className="wiki-revision-summary">{rev.summary}</div>
                      <div className="wiki-revision-time">
                        <time dateTime={rev.created_at} title={rev.created_at}>
                          {formatArchivalTimestamp(rev.created_at)}
                        </time>
                      </div>
                    </div>
                    <div className="wiki-revision-actions">
                      <button
                        type="button"
                        className="pill-btn"
                        aria-expanded={isExpanded}
                        onClick={() => {
                          setExpandedId(isExpanded ? null : rev.revision_id);
                        }}
                      >
                        {isExpanded ? 'Hide Diff' : 'View Diff'}
                      </button>
                      {capabilities.canEdit && dataSource.revertRevision && !confirmingRev && (
                        <button
                          type="button"
                          className="pill-btn wiki-danger-btn"
                          disabled={busyKey !== null}
                          onClick={() => {
                            setPendingConfirm({ kind: 'revision', rev });
                          }}
                        >
                          {busyKey === `rev:${rev.revision_id}` ? 'Reverting…' : 'Revert'}
                        </button>
                      )}
                    </div>
                  </div>
                  {confirmingRev && (
                    <div className="wiki-confirm-inline" role="alert">
                      <p className="wiki-confirm-inline-text">
                        Revert revision <code>r{rev.revision_id}</code> on{' '}
                        <code>
                          {rev.entity_type}/{rev.entity_id}
                        </code>
                        ?
                      </p>
                      <div className="wiki-inline-actions">
                        <button
                          type="button"
                          className="pill-btn wiki-danger-btn"
                          disabled={busyKey !== null}
                          onClick={() => {
                            void handleRevertRevision(rev);
                          }}
                        >
                          Confirm Revert
                        </button>
                        <button
                          type="button"
                          className="pill-btn"
                          disabled={busyKey !== null}
                          onClick={() => {
                            setPendingConfirm(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {isExpanded && (
                    <div className="wiki-revision-diff-body">
                      <RevisionDiffView
                        before={rev.before_json}
                        after={rev.after_json}
                        beforeLabel="Before"
                        afterLabel={`r${rev.revision_id}`}
                      />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </main>
      <KinloomFooter />
    </div>
  );
};
