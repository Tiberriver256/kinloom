import type { RevisionRecord } from '@kinloom/core';
import { asBatchId, asRevisionId } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import atomStyles from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { AuthorPill, StewardReviewBadge } from '../components/wiki/WikiBadges.js';
import wikiFormStyles from '../components/wiki/WikiForms.module.css';
import wikiPanelStyles from '../components/wiki/WikiPanels.module.css';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { handleTablistKeyDown } from '../hooks/keyboardNav.js';
import { cx, joinClasses } from '../lib/cx.js';
import { formatArchivalTimestamp } from '../lib/formatTimestamp.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import {
  detectDuplicateEventWarnings,
  formatBatchReportSummary,
} from './recentChanges/fieldReportFormatter.js';
import { DuplicateEventWarningList, RevisionFeedItem } from './recentChanges/RevisionFeedItem.js';
import {
  type AuthorFilter,
  buildEntityLinkMap,
  getEmptyRevisionFeedMessage,
  groupRevisionsByBatch,
  isFeedGroupReviewed,
  type PendingRevertConfirm,
} from './recentChanges/recentChangesViewModel.js';

export interface RecentChangesPageProps {
  initialRevisions?: readonly RevisionRecord[];
}

export const RecentChangesPage: React.FC<RecentChangesPageProps> = ({ initialRevisions }) => {
  const { bundle, peopleById, sourcesById, dataSource, capabilities, reloadArchive } = useArchiveData();
  const tabBaseId = useId();
  const [authorFilter, setAuthorFilter] = useState<AuthorFilter>('all');
  const [onlyUnreviewed, setOnlyUnreviewed] = useState<boolean>(false);
  const [revisions, setRevisions] = useState<readonly RevisionRecord[]>(initialRevisions ?? []);
  const [loading, setLoading] = useState<boolean>(initialRevisions === undefined);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [batchExpansionOverrides, setBatchExpansionOverrides] = useState<Readonly<Record<string, boolean>>>(
    {}
  );
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

  const allGroupedFeed = useMemo(() => groupRevisionsByBatch(filteredRevisions), [filteredRevisions]);

  const unreviewedGroupCount = useMemo(
    () => allGroupedFeed.filter((group) => !isFeedGroupReviewed(group)).length,
    [allGroupedFeed]
  );

  const groupedFeed = useMemo(
    () => (onlyUnreviewed ? allGroupedFeed.filter((group) => !isFeedGroupReviewed(group)) : allGroupedFeed),
    [allGroupedFeed, onlyUnreviewed]
  );

  const duplicateWarningsByGroup = useMemo(
    () => detectDuplicateEventWarnings(allGroupedFeed, bundle),
    [allGroupedFeed, bundle]
  );

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

  const handleMarkRevisionReviewed = async (rev: RevisionRecord): Promise<void> => {
    if (!dataSource.markRevisionReviewed) {
      return;
    }
    setBusyKey(`review:rev:${rev.revision_id}`);
    setError(null);
    setStatusMessage(null);
    try {
      const { review } = await dataSource.markRevisionReviewed(asRevisionId(rev.revision_id));
      setRevisions((prev) =>
        prev.map((item) => (item.revision_id === rev.revision_id ? { ...item, review } : item))
      );
      setStatusMessage(`Marked revision r${rev.revision_id} as reviewed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearRevisionReview = async (rev: RevisionRecord): Promise<void> => {
    if (!dataSource.clearRevisionReview) {
      return;
    }
    setBusyKey(`review:rev:${rev.revision_id}`);
    setError(null);
    setStatusMessage(null);
    try {
      await dataSource.clearRevisionReview(asRevisionId(rev.revision_id));
      setRevisions((prev) =>
        prev.map((item) => {
          if (item.revision_id !== rev.revision_id) {
            return item;
          }
          const { review: _removed, ...rest } = item;
          return rest;
        })
      );
      setStatusMessage(`Cleared steward review stamp on r${rev.revision_id}.`);
      if (initialRevisions === undefined) {
        await loadFeed();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleMarkBatchReviewed = async (batchId: string): Promise<void> => {
    if (!dataSource.markBatchReviewed) {
      return;
    }
    setBusyKey(`review:batch:${batchId}`);
    setError(null);
    setStatusMessage(null);
    try {
      const { review } = await dataSource.markBatchReviewed(asBatchId(batchId));
      setRevisions((prev) =>
        prev.map((item) =>
          item.batch_id === batchId && item.review?.target_kind !== 'revision' ? { ...item, review } : item
        )
      );
      setStatusMessage(`Marked research batch as reviewed by ${review.reviewer_name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearBatchReview = async (batchId: string): Promise<void> => {
    if (!dataSource.clearBatchReview) {
      return;
    }
    setBusyKey(`review:batch:${batchId}`);
    setError(null);
    setStatusMessage(null);
    try {
      await dataSource.clearBatchReview(asBatchId(batchId));
      setRevisions((prev) =>
        prev.map((item) => {
          if (item.batch_id !== batchId || item.review?.target_kind === 'revision') {
            return item;
          }
          const { review: _removed, ...rest } = item;
          return rest;
        })
      );
      setStatusMessage('Cleared steward review stamp on research batch.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const tabpanelId = `${tabBaseId}-panel`;
  const activeTabId = `${tabBaseId}-tab-${authorFilter}`;
  const canRevertRevision = Boolean(capabilities.canEdit && dataSource.revertRevision);
  const canReviewRevision = Boolean(capabilities.canEdit && dataSource.markRevisionReviewed);
  const canReviewBatch = Boolean(capabilities.canEdit && dataSource.markBatchReviewed);

  return (
    <div className={cx(layoutStyles, 'page-shell')}>
      <ExplorerTopBar />
      <main id="main-content" className={cx(layoutStyles, 'place-page')}>
        <section className={cx(layoutStyles, 'wire-banner')} style={{ marginBottom: 18 }}>
          <div>
            <h1>{KINLOOM_VOCABULARY.stewardship.fieldReportsHeading}</h1>
            <p>
              Plain-English ledger of family edits, research batches, and initial archive imports. Stewards
              can inspect field changes, verify reports with a review stamp, or revert any entry without
              losing history.
            </p>
          </div>
          <div className={cx(atomStyles, 'folio-metrics')}>
            <div>
              <strong>{filteredRevisions.length}</strong>{' '}
              {filteredRevisions.length === 1 ? 'change' : 'changes'} shown
            </div>
            <div>
              <strong>{allGroupedFeed.filter((g) => g.batchId !== null).length}</strong> research{' '}
              {allGroupedFeed.filter((g) => g.batchId !== null).length === 1 ? 'batch' : 'batches'} ·{' '}
              <strong>{unreviewedGroupCount}</strong> awaiting review
            </div>
          </div>
        </section>

        <div className={cx(wikiPanelStyles, 'wiki-changes-toolbar')}>
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

          <button
            type="button"
            aria-pressed={onlyUnreviewed}
            className={cx(controlStyles, `pill-btn ${onlyUnreviewed ? 'active' : ''}`)}
            onClick={() => {
              setOnlyUnreviewed((prev) => !prev);
            }}
          >
            {KINLOOM_VOCABULARY.stewardship.needsReviewLabel} ({unreviewedGroupCount})
          </button>
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
          {loading && <p className={cx(controlStyles, 'empty-ring-note')}>Loading research field reports…</p>}
          {!loading && groupedFeed.length === 0 && (
            <p className={cx(controlStyles, 'empty-ring-note')}>
              {getEmptyRevisionFeedMessage(authorFilter, onlyUnreviewed)}
            </p>
          )}

          <div className={cx(wikiPanelStyles, 'wiki-changes-feed')}>
            {groupedFeed.map((group) => {
              const groupBatchId = group.batchId;
              const groupWarnings = duplicateWarningsByGroup.get(group.key) ?? [];

              if (groupBatchId) {
                const first = group.revisions[0];
                const report = formatBatchReportSummary(group.revisions, entityLinkByKey);
                const confirmingBatch =
                  pendingConfirm?.kind === 'batch' && pendingConfirm.batchId === groupBatchId;
                const defaultBatchOpen = group.revisions.length <= 5;
                const batchExpanded = batchExpansionOverrides[groupBatchId] ?? defaultBatchOpen;
                const extraTouchedCount = Math.max(
                  0,
                  report.totalTouchedCount - report.touchedRecords.length
                );

                return (
                  <section key={group.key} className={cx(layoutStyles, 'place-map-box wiki-batch-group')}>
                    <div className={cx(wikiPanelStyles, 'wiki-batch-header')}>
                      <div className={cx(wikiPanelStyles, 'wiki-batch-main')}>
                        <h2 className={cx(wikiPanelStyles, 'wiki-batch-headline')}>{report.headline}</h2>
                        <div className={cx(wikiPanelStyles, 'wiki-revision-topline')}>
                          <AuthorPill authorType={first.author_type} authorName={first.author_name} />
                          <span className={cx(wikiPanelStyles, 'wiki-panel-meta')}>
                            <time dateTime={first.created_at} title={first.created_at}>
                              {formatArchivalTimestamp(first.created_at)}
                            </time>
                          </span>
                          {report.batchReview && <StewardReviewBadge review={report.batchReview} />}
                          {canReviewBatch &&
                            report.batchReview?.target_kind === 'batch' &&
                            dataSource.clearBatchReview && (
                              <button
                                type="button"
                                className={cx(wikiPanelStyles, 'wiki-review-undo-btn')}
                                aria-label={`${KINLOOM_VOCABULARY.stewardship.clearReviewAria} for batch ${groupBatchId}`}
                                disabled={busyKey !== null}
                                onClick={() => {
                                  void handleClearBatchReview(groupBatchId);
                                }}
                              >
                                {KINLOOM_VOCABULARY.stewardship.clearReview}
                              </button>
                            )}
                        </div>
                        {report.touchedRecords.length > 0 && (
                          <div className={cx(wikiPanelStyles, 'wiki-touched-strip')}>
                            <span className={cx(wikiPanelStyles, 'wiki-touched-label')}>
                              Records touched:
                            </span>
                            {report.touchedRecords.map((rec) =>
                              rec.to ? (
                                <Link
                                  key={rec.key}
                                  to={rec.to}
                                  className={cx(wikiPanelStyles, 'wiki-entity-link')}
                                >
                                  {rec.label}
                                </Link>
                              ) : (
                                <span key={rec.key} className={cx(wikiPanelStyles, 'wiki-panel-meta')}>
                                  {rec.label}
                                </span>
                              )
                            )}
                            {extraTouchedCount > 0 && (
                              <span className={cx(wikiPanelStyles, 'wiki-panel-meta')}>
                                +{extraTouchedCount} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className={cx(wikiPanelStyles, 'wiki-revision-actions')}>
                        {canReviewBatch && !report.batchReview && (
                          <button
                            type="button"
                            className={cx(wikiPanelStyles, 'wiki-review-btn')}
                            disabled={busyKey !== null}
                            onClick={() => {
                              void handleMarkBatchReviewed(groupBatchId);
                            }}
                          >
                            {busyKey === `review:batch:${groupBatchId}`
                              ? KINLOOM_VOCABULARY.stewardship.markingReviewed
                              : KINLOOM_VOCABULARY.stewardship.markReviewed}
                          </button>
                        )}
                        <button
                          type="button"
                          className={cx(controlStyles, 'pill-btn')}
                          aria-expanded={batchExpanded}
                          onClick={() => {
                            setBatchExpansionOverrides((prev) => ({
                              ...prev,
                              [groupBatchId]: !batchExpanded,
                            }));
                          }}
                        >
                          {batchExpanded
                            ? `Hide ${group.revisions.length} individual record ${group.revisions.length === 1 ? 'change' : 'changes'}`
                            : `Show ${group.revisions.length} individual record ${group.revisions.length === 1 ? 'change' : 'changes'}`}
                        </button>
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
                    </div>

                    <DuplicateEventWarningList warnings={groupWarnings} />

                    {confirmingBatch && (
                      <div className={cx(wikiPanelStyles, 'wiki-confirm-inline')} role="alert">
                        <p className={cx(wikiPanelStyles, 'wiki-confirm-inline-text')}>
                          Revert all <strong>{group.revisions.length}</strong> change
                          {group.revisions.length === 1 ? '' : 's'} in this research batch? This appends new
                          revert revisions without deleting history.
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

                    {batchExpanded && (
                      <>
                        <div className={cx(wikiPanelStyles, 'wiki-revision-list')}>
                          {group.revisions.map((rev) => (
                            <RevisionFeedItem
                              key={rev.revision_id}
                              rev={rev}
                              standalone={false}
                              isExpanded={expandedId === rev.revision_id}
                              canRevert={canRevertRevision}
                              canReview={canReviewRevision}
                              busyKey={busyKey}
                              pendingConfirm={pendingConfirm}
                              entityLinkByKey={entityLinkByKey}
                              peopleById={peopleById}
                              sourcesById={sourcesById}
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
                              onMarkReviewed={handleMarkRevisionReviewed}
                              onClearReview={handleClearRevisionReview}
                            />
                          ))}
                        </div>
                        <div className={cx(wikiPanelStyles, 'wiki-ledger-ref')}>
                          Batch ledger reference: <code>{groupBatchId}</code>
                        </div>
                      </>
                    )}
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
                  canReview={canReviewRevision}
                  busyKey={busyKey}
                  pendingConfirm={pendingConfirm}
                  entityLinkByKey={entityLinkByKey}
                  peopleById={peopleById}
                  sourcesById={sourcesById}
                  duplicateWarnings={groupWarnings}
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
                  onMarkReviewed={handleMarkRevisionReviewed}
                  onClearReview={handleClearRevisionReview}
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
