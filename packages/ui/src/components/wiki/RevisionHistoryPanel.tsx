import type { EntityType, RevisionRecord } from '@kinloom/core';
import { asRevisionId } from '@kinloom/core';
import { AuthorPill, CitationBadge } from './WikiBadges.js';
import React, { useCallback, useEffect, useState } from 'react';
import { RevisionDiffView } from './RevisionDiffView.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';

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
    initialRevisions && initialRevisions.length > 0 ? initialRevisions[0].revision_id : null,
  );
  const [revertingId, setRevertingId] = useState<number | null>(null);
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
    setError(null);
    setStatusMessage(null);
    try {
      const res = await dataSource.revertRevision(
        asRevisionId(rev.revision_id),
        `Undo r${rev.revision_id}: ${rev.summary}`,
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
    <section className="wiki-panel" aria-label="Revision history">
      <div className="wiki-panel-header">
        <h2>Revision History</h2>
        <span className="wiki-panel-meta">
          {revisions.length} revision{revisions.length === 1 ? '' : 's'}
        </span>
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
      {loading && <p className="empty-ring-note">Loading revision history…</p>}
      {!loading && revisions.length === 0 && (
        <p className="empty-ring-note">No revisions have been recorded for this record yet.</p>
      )}

      <div className="wiki-revision-list">
        {revisions.map((rev) => {
          const isExpanded = expandedId === rev.revision_id;
          return (
            <article key={rev.revision_id} className="wiki-revision-item">
              <div className="wiki-revision-row">
                <div className="wiki-revision-main">
                  <div className="wiki-revision-topline">
                    <code className="wiki-rev-id">r{rev.revision_id}</code>
                    <span className={`wiki-action-tag action-${rev.action}`}>{rev.action}</span>
                    <AuthorPill authorType={rev.author_type} authorName={rev.author_name} />
                    <CitationBadge hasPrimarySource={rev.has_primary_source} />
                    {rev.batch_id && <code className="wiki-batch-chip">batch:{rev.batch_id}</code>}
                  </div>
                  <div className="wiki-revision-summary">{rev.summary}</div>
                  <div className="wiki-revision-time">{rev.created_at}</div>
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
                  {capabilities.canEdit && dataSource.revertRevision && (
                    <button
                      type="button"
                      className="pill-btn"
                      disabled={revertingId !== null}
                      onClick={() => {
                        void handleRevert(rev);
                      }}
                    >
                      {revertingId === rev.revision_id ? 'Reverting…' : 'Undo / Revert'}
                    </button>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="wiki-revision-diff-body">
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
