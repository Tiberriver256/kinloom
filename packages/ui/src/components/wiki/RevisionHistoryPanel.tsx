import type { EntityType, RevisionRecord } from '@kinloom/core';
import { asRevisionId } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import cssMod1 from '../../pages/IndexPage.module.css';
import cssMod2 from '../../pages/PersonPage.module.css';
import { RevisionDiffView } from './RevisionDiffView.js';
import { AuthorPill, CitationBadge } from './WikiBadges.js';
import cssMod0 from './WikiSurfaces.module.css';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod1, ...cssMod2 };

export interface RevisionHistoryPanelProps {
  entityType: EntityType;
  entityId: string;
  initialRevisions?: readonly RevisionRecord[];
  onReverted?: () => void;
}

export const RevisionHistoryPanel: React.FC<RevisionHistoryPanelProps> = ({
  entityType,
  entityId,
  initialRevisions,
  onReverted,
}) => {
  const { dataSource, capabilities, reloadArchive } = useArchiveData();
  const [revisions, setRevisions] = useState<readonly RevisionRecord[]>(initialRevisions ?? []);
  const [loading, setLoading] = useState<boolean>(initialRevisions === undefined);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(
    initialRevisions && initialRevisions.length > 0 ? initialRevisions[0].revision_id : null
  );
  const [revertingId, setRevertingId] = useState<number | null>(null);
  const [confirmingRevertId, setConfirmingRevertId] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const loadRevisions = useCallback(async (): Promise<void> => {
    if (!dataSource.listRevisions) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await dataSource.listRevisions({
        entity_type: entityType,
        entity_id: entityId,
        limit: 50,
      });
      setRevisions(res.items);
      if (res.items.length > 0 && expandedId === null) {
        setExpandedId(res.items[0].revision_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [dataSource, entityType, entityId, expandedId]);

  useEffect(() => {
    if (initialRevisions !== undefined) {
      return;
    }
    void loadRevisions();
  }, [initialRevisions, loadRevisions]);

  const handleRevert = async (rev: RevisionRecord): Promise<void> => {
    if (!dataSource.revertRevision) {
      return;
    }
    setRevertingId(rev.revision_id);
    setConfirmingRevertId(null);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await dataSource.revertRevision(
        asRevisionId(rev.revision_id),
        `Undo r${rev.revision_id}: ${rev.summary}`
      );
      setStatusMessage(`Reverted r${rev.revision_id} in new revision r${res.revision.revision_id}.`);
      reloadArchive();
      onReverted?.();
      await loadRevisions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevertingId(null);
    }
  };

  return (
    <section className={cx(uiStyles, 'wiki-panel')} aria-label="Revision history">
      <div className={cx(uiStyles, 'wiki-panel-header')}>
        <h2>Revision History</h2>
        <span className={cx(uiStyles, 'wiki-panel-meta')}>
          {revisions.length} revision{revisions.length === 1 ? '' : 's'}
        </span>
      </div>

      {statusMessage && (
        <output className={cx(uiStyles, 'wiki-status-banner is-success')} aria-live="polite">
          {statusMessage}
        </output>
      )}
      {error && (
        <div className={cx(uiStyles, 'wiki-status-banner is-error')} role="alert">
          {error}
        </div>
      )}
      {loading && <p className={cx(uiStyles, 'empty-ring-note')}>Loading revision history…</p>}
      {!loading && revisions.length === 0 && (
        <p className={cx(uiStyles, 'empty-ring-note')}>
          No revisions have been recorded for this record yet.
        </p>
      )}

      <div className={cx(uiStyles, 'wiki-revision-list')}>
        {revisions.map((rev) => {
          const isExpanded = expandedId === rev.revision_id;
          return (
            <article key={rev.revision_id} className={cx(uiStyles, 'wiki-revision-item')}>
              <div className={cx(uiStyles, 'wiki-revision-row')}>
                <div className={cx(uiStyles, 'wiki-revision-main')}>
                  <div className={cx(uiStyles, 'wiki-revision-topline')}>
                    <code className={cx(uiStyles, 'wiki-rev-id')}>r{rev.revision_id}</code>
                    <span className={cx(uiStyles, `wiki-action-tag action-${rev.action}`)}>{rev.action}</span>
                    <AuthorPill authorType={rev.author_type} authorName={rev.author_name} />
                    <CitationBadge hasPrimarySource={rev.has_primary_source} />
                    {rev.batch_id && (
                      <code className={cx(uiStyles, 'wiki-batch-chip')}>batch:{rev.batch_id}</code>
                    )}
                  </div>
                  <div className={cx(uiStyles, 'wiki-revision-summary')}>{rev.summary}</div>
                  <div className={cx(uiStyles, 'wiki-revision-time')}>
                    <time dateTime={rev.created_at} title={rev.created_at}>
                      {formatArchivalTimestamp(rev.created_at)}
                    </time>
                  </div>
                </div>

                <div className={cx(uiStyles, 'wiki-revision-actions')}>
                  <button
                    type="button"
                    className={cx(uiStyles, 'pill-btn')}
                    aria-expanded={isExpanded}
                    onClick={() => {
                      setExpandedId(isExpanded ? null : rev.revision_id);
                    }}
                  >
                    {isExpanded ? 'Hide Diff' : 'View Diff'}
                  </button>
                  {capabilities.canEdit &&
                    dataSource.revertRevision &&
                    confirmingRevertId !== rev.revision_id && (
                      <button
                        type="button"
                        className={cx(uiStyles, 'pill-btn wiki-danger-btn')}
                        disabled={revertingId !== null}
                        onClick={() => {
                          setConfirmingRevertId(rev.revision_id);
                        }}
                      >
                        {revertingId === rev.revision_id ? 'Reverting…' : 'Undo / Revert'}
                      </button>
                    )}
                </div>
              </div>

              {confirmingRevertId === rev.revision_id && (
                <div className={cx(uiStyles, 'wiki-confirm-inline')} role="alert">
                  <p className={cx(uiStyles, 'wiki-confirm-inline-text')}>
                    Revert revision <code>r{rev.revision_id}</code>? This appends a new revision restoring the
                    prior version.
                  </p>
                  <div className={cx(uiStyles, 'wiki-inline-actions')}>
                    <button
                      type="button"
                      className={cx(uiStyles, 'pill-btn wiki-danger-btn')}
                      disabled={revertingId !== null}
                      onClick={() => {
                        void handleRevert(rev);
                      }}
                    >
                      Confirm Revert
                    </button>
                    <button
                      type="button"
                      className={cx(uiStyles, 'pill-btn')}
                      disabled={revertingId !== null}
                      onClick={() => {
                        setConfirmingRevertId(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {isExpanded && (
                <div className={cx(uiStyles, 'wiki-revision-diff-body')}>
                  <RevisionDiffView
                    before={rev.before_json}
                    after={rev.after_json}
                    beforeLabel={rev.parent_revision_id ? `r${rev.parent_revision_id}` : 'Before'}
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
};
