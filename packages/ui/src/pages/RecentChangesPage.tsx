import type { RevisionRecord } from '@kinloom/core';
import { asBatchId, asRevisionId } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import atomStyles from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { AuthorPill } from '../components/wiki/WikiBadges.js';
import wikiFormStyles from '../components/wiki/WikiForms.module.css';
import wikiPanelStyles from '../components/wiki/WikiPanels.module.css';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { handleTablistKeyDown } from '../hooks/keyboardNav.js';
import { cx, joinClasses } from '../lib/cx.js';
import { formatArchivalTimestamp } from '../lib/formatTimestamp.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import { RevisionFeedItem } from './recentChanges/RevisionFeedItem.js';
import {
  type AuthorFilter,
  buildEntityLinkMap,
  groupRevisionsByBatch,
  type PendingRevertConfirm,
} from './recentChanges/recentChangesViewModel.js';

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
  const [pendingConfirm, setPendingConfirm] = useState<PendingRevertConfirm | null>(null);

  const entityLinkByKey = useMemo(() => buildEntityLinkMap(bundle), [bundle]);

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

  const groupedFeed = useMemo(() => groupRevisionsByBatch(filteredRevisions), [filteredRevisions]);

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
        `Revert r${rev.revision_id}`
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
        `Reverted batch ${batchId} across ${res.revisions.length} revision${res.revisions.length === 1 ? '' : 's'}.`
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
  const canRevertRevision = Boolean(capabilities.canEdit && dataSource.revertRevision);

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(layoutStyles, 'place-page')}>
        <section className={cx(layoutStyles, 'wire-banner')} style={{ marginBottom: 18 }}>
          <div>
            <h1>Revision History</h1>
            <p>
              Complete append-only revision history of family edits, research batches, and initial archive
              imports. Every revision or research batch can be reverted cleanly without losing history.
            </p>
          </div>
          <div className={cx(atomStyles, 'folio-metrics')}>
            <div>
              <strong>{filteredRevisions.length}</strong> revisions shown
            </div>
            <div>
              <strong>{groupedFeed.filter((g) => g.batchId !== null).length}</strong> grouped research batches
            </div>
          </div>
        </section>

        <div
          className={cx(controlStyles, 'filter-bar')}
          role="tablist"
          aria-label="Filter revision history by author type"
          onKeyDown={(event) => {
            handleTablistKeyDown(
              event,
              ['all', 'human', 'agent', 'system_seed'] as const,
              authorFilter,
              (next) => {
                setAuthorFilter(next);
              }
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
              className={cx(controlStyles, `pill-btn ${authorFilter === id ? 'active' : ''}`)}
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
            <output className={cx(wikiPanelStyles, 'wiki-status-banner is-success')} aria-live="polite">
              {statusMessage}
            </output>
          )}
          {error && (
            <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
              {error}
            </div>
          )}
          {loading && <p className={cx(controlStyles, 'empty-ring-note')}>Loading revision history…</p>}
          {!loading && groupedFeed.length === 0 && (
            <p className={cx(controlStyles, 'empty-ring-note')}>
              No revisions match the active author filter.
            </p>
          )}

          <div className={cx(wikiPanelStyles, 'wiki-changes-feed')}>
            {groupedFeed.map((group) => {
              const groupBatchId = group.batchId;
              if (groupBatchId) {
                const first = group.revisions[0];
                const confirmingBatch =
                  pendingConfirm?.kind === 'batch' && pendingConfirm.batchId === groupBatchId;
                return (
                  <section key={group.key} className={cx(layoutStyles, 'place-map-box wiki-batch-group')}>
                    <div className={cx(wikiPanelStyles, 'wiki-batch-header')}>
                      <div>
                        <div className={cx(wikiPanelStyles, 'wiki-revision-topline')}>
                          <code className={cx(wikiPanelStyles, 'wiki-batch-chip')}>Batch {groupBatchId}</code>
                          <AuthorPill authorType={first.author_type} authorName={first.author_name} />
                          <span className={cx(wikiPanelStyles, 'wiki-panel-meta')}>
                            {group.revisions.length} change{group.revisions.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className={cx(wikiPanelStyles, 'wiki-revision-time')}>
                          <time dateTime={first.created_at} title={first.created_at}>
                            {formatArchivalTimestamp(first.created_at)}
                          </time>
                        </div>
                      </div>
                      {capabilities.canEdit && dataSource.revertBatch && !confirmingBatch && (
                        <button
                          type="button"
                          className={joinClasses(
                            cx(controlStyles, 'pill-btn'),
                            cx(wikiFormStyles, 'wiki-danger-btn')
                          )}
                          disabled={busyKey !== null}
                          onClick={() => {
                            setPendingConfirm({
                              kind: 'batch',
                              batchId: groupBatchId,
                              count: group.revisions.length,
                            });
                          }}
                        >
                          {busyKey === group.key ? 'Reverting Batch…' : 'Revert Entire Batch'}
                        </button>
                      )}
                    </div>

                    {confirmingBatch && (
                      <div className={cx(wikiPanelStyles, 'wiki-confirm-inline')} role="alert">
                        <p className={cx(wikiPanelStyles, 'wiki-confirm-inline-text')}>
                          Revert all <strong>{group.revisions.length}</strong> change
                          {group.revisions.length === 1 ? '' : 's'} in batch <code>{groupBatchId}</code>? This
                          appends new revert revisions without deleting history.
                        </p>
                        <div className={cx(wikiPanelStyles, 'wiki-inline-actions')}>
                          <button
                            type="button"
                            className={joinClasses(
                              cx(controlStyles, 'pill-btn'),
                              cx(wikiFormStyles, 'wiki-danger-btn')
                            )}
                            disabled={busyKey !== null}
                            onClick={() => {
                              void handleRevertBatch(groupBatchId);
                            }}
                          >
                            Confirm Batch Revert
                          </button>
                          <button
                            type="button"
                            className={cx(controlStyles, 'pill-btn')}
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

                    <div className={cx(wikiPanelStyles, 'wiki-revision-list')}>
                      {group.revisions.map((rev) => (
                        <RevisionFeedItem
                          key={rev.revision_id}
                          rev={rev}
                          standalone={false}
                          isExpanded={expandedId === rev.revision_id}
                          canRevert={canRevertRevision}
                          busyKey={busyKey}
                          pendingConfirm={pendingConfirm}
                          entityLinkByKey={entityLinkByKey}
                          onToggleExpand={(id) => {
                            setExpandedId(expandedId === id ? null : id);
                          }}
                          onRequestRevert={(target) => {
                            setPendingConfirm({ kind: 'revision', rev: target });
                          }}
                          onCancelRevert={() => {
                            setPendingConfirm(null);
                          }}
                          onConfirmRevert={handleRevertRevision}
                        />
                      ))}
                    </div>
                  </section>
                );
              }

              const [rev] = group.revisions;
              return (
                <RevisionFeedItem
                  key={group.key}
                  rev={rev}
                  standalone
                  isExpanded={expandedId === rev.revision_id}
                  canRevert={canRevertRevision}
                  busyKey={busyKey}
                  pendingConfirm={pendingConfirm}
                  entityLinkByKey={entityLinkByKey}
                  onToggleExpand={(id) => {
                    setExpandedId(expandedId === id ? null : id);
                  }}
                  onRequestRevert={(target) => {
                    setPendingConfirm({ kind: 'revision', rev: target });
                  }}
                  onCancelRevert={() => {
                    setPendingConfirm(null);
                  }}
                  onConfirmRevert={handleRevertRevision}
                />
              );
            })}
          </div>
        </div>
      </main>
      <KinloomFooter />
    </div>
  );
};
