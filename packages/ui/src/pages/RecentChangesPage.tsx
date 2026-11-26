import type { AuthorType, RevisionRecord } from '@kinloom/core';
import { asBatchId, asRevisionId } from '@kinloom/core';
import { AuthorPill, CitationBadge } from '../components/wiki/WikiBadges.js';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { RevisionDiffView } from '../components/wiki/RevisionDiffView.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';

type AuthorFilter = 'all' | AuthorType;

interface FeedGroup {
  key: string;
  batchId: string | null;
  revisions: RevisionRecord[];
}

export interface RecentChangesPageProps {
  initialRevisions?: readonly RevisionRecord[];
}

export const RecentChangesPage: React.FC<RecentChangesPageProps> = ({ initialRevisions }) => {
  const { dataSource, capabilities, reloadArchive } = useArchiveData();
  const [authorFilter, setAuthorFilter] = useState<AuthorFilter>('all');
  const [revisions, setRevisions] = useState<readonly RevisionRecord[]>(initialRevisions ?? []);
  const [loading, setLoading] = useState<boolean>(initialRevisions === undefined);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

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

  return (
    <div>
      <ExplorerTopBar />
      <main className="place-page">
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

        <div className="filter-bar" role="tablist" aria-label="Filter recent changes by author type">
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
              type="button"
              role="tab"
              aria-selected={authorFilter === id}
              className={`pill-btn ${authorFilter === id ? 'active' : ''}`}
              onClick={() => {
                setAuthorFilter(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>

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
        {loading && <p className="empty-ring-note">Loading recent changes…</p>}
        {!loading && groupedFeed.length === 0 && (
          <p className="empty-ring-note">No revisions match the active author filter.</p>
        )}

        <div className="wiki-changes-feed">
          {groupedFeed.map((group) => {
            if (group.batchId) {
              const first = group.revisions[0];
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
                      <div className="wiki-revision-time">{first.created_at}</div>
                    </div>
                    {capabilities.canEdit && dataSource.revertBatch && (
                      <button
                        type="button"
                        className="pill-btn wiki-danger-btn"
                        disabled={busyKey !== null}
                        onClick={() => {
                          void handleRevertBatch(group.batchId!);
                        }}
                      >
                        {busyKey === group.key ? 'Reverting Batch…' : 'Revert Entire Batch'}
                      </button>
                    )}
                  </div>

                  <div className="wiki-revision-list">
                    {group.revisions.map((rev) => {
                      const isExpanded = expandedId === rev.revision_id;
                      return (
                        <article key={rev.revision_id} className="wiki-revision-item">
                          <div className="wiki-revision-row">
                            <div className="wiki-revision-main">
                              <div className="wiki-revision-topline">
                                <code className="wiki-rev-id">r{rev.revision_id}</code>
                                <span className={`wiki-action-tag action-${rev.action}`}>
                                  {rev.action}
                                </span>
                                <code>
                                  {rev.entity_type}/{rev.entity_id}
                                </code>
                                <CitationBadge hasPrimarySource={rev.has_primary_source} />
                              </div>
                              <div className="wiki-revision-summary">{rev.summary}</div>
                            </div>
                            <div className="wiki-revision-actions">
                              <button
                                type="button"
                                className="pill-btn"
                                onClick={() => {
                                  setExpandedId(isExpanded ? null : rev.revision_id);
                                }}
                              >
                                {isExpanded ? 'Hide Diff' : 'View Diff'}
                              </button>
                              {capabilities.canEdit && dataSource.revertRevision && (
                                <button
                                  type="button"
                                  className="pill-btn"
                                  disabled={busyKey !== null}
                                  onClick={() => {
                                    void handleRevertRevision(rev);
                                  }}
                                >
                                  {busyKey === `rev:${rev.revision_id}` ? 'Reverting…' : 'Revert'}
                                </button>
                              )}
                            </div>
                          </div>
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
            return (
              <article key={group.key} className="place-map-box wiki-revision-item">
                <div className="wiki-revision-row">
                  <div className="wiki-revision-main">
                    <div className="wiki-revision-topline">
                      <code className="wiki-rev-id">r{rev.revision_id}</code>
                      <span className={`wiki-action-tag action-${rev.action}`}>{rev.action}</span>
                      <code>
                        {rev.entity_type}/{rev.entity_id}
                      </code>
                      <AuthorPill authorType={rev.author_type} authorName={rev.author_name} />
                      <CitationBadge hasPrimarySource={rev.has_primary_source} />
                    </div>
                    <div className="wiki-revision-summary">{rev.summary}</div>
                    <div className="wiki-revision-time">{rev.created_at}</div>
                  </div>
                  <div className="wiki-revision-actions">
                    <button
                      type="button"
                      className="pill-btn"
                      onClick={() => {
                        setExpandedId(isExpanded ? null : rev.revision_id);
                      }}
                    >
                      {isExpanded ? 'Hide Diff' : 'View Diff'}
                    </button>
                    {capabilities.canEdit && dataSource.revertRevision && (
                      <button
                        type="button"
                        className="pill-btn"
                        disabled={busyKey !== null}
                        onClick={() => {
                          void handleRevertRevision(rev);
                        }}
                      >
                        {busyKey === `rev:${rev.revision_id}` ? 'Reverting…' : 'Revert'}
                      </button>
                    )}
                  </div>
                </div>
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
      </main>
      <KinloomFooter />
    </div>
  );
};
