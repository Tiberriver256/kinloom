import type { EntityType, TalkComment } from '@kinloom/core';
import React, { useCallback, useEffect, useState } from 'react';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';

export interface TalkPanelProps {
  entityType: EntityType;
  entityId: string;
  entityTitle?: string;
  initialComments?: readonly TalkComment[];
}

export const TalkPanel: React.FC<TalkPanelProps> = ({
  entityType,
  entityId,
  entityTitle,
  initialComments,
}) => {
  const { dataSource, capabilities, session } = useArchiveData();
  const [comments, setComments] = useState<readonly TalkComment[]>(initialComments ?? []);
  const [loading, setLoading] = useState<boolean>(initialComments === undefined);
  const [bodyMd, setBodyMd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadComments = useCallback(async (): Promise<void> => {
    if (!dataSource.listTalkComments) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await dataSource.listTalkComments(entityType, entityId);
      setComments(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [dataSource, entityType, entityId]);

  useEffect(() => {
    if (initialComments !== undefined) {
      return;
    }
    void loadComments();
  }, [initialComments, loadComments]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = bodyMd.trim();
    if (!trimmed || !dataSource.postTalkComment) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await dataSource.postTalkComment(entityType, entityId, trimmed);
      setComments((prev) => [...prev, created]);
      setBodyMd('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (commentId: number): Promise<void> => {
    if (!dataSource.deleteTalkComment) {
      return;
    }
    setDeletingId(commentId);
    setError(null);
    try {
      await dataSource.deleteTalkComment(entityType, entityId, commentId);
      setComments((prev) => prev.filter((c) => c.comment_id !== commentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="wiki-panel" aria-label={KINLOOM_VOCABULARY.wiki.familyNotes}>
      <div className="wiki-panel-header">
        <h2>Family Notes{entityTitle ? ` · ${entityTitle}` : ''}</h2>
        <span className="wiki-panel-meta">
          {comments.length} note{comments.length === 1 ? '' : 's'}
        </span>
      </div>

      {error && (
        <div className="wiki-status-banner is-error" role="alert">
          {error}
        </div>
      )}

      {loading && <p className="empty-ring-note">Loading discussion notes…</p>}
      {!loading && comments.length === 0 && (
        <p className="empty-ring-note">
          No research notes or family discussion posted on this record yet.
        </p>
      )}

      <div className="wiki-talk-list">
        {comments.map((comment) => {
          const canDeleteComment =
            Boolean(dataSource.deleteTalkComment) &&
            capabilities.canEdit &&
            (session?.role === 'admin' ||
              (Boolean(session?.email) && session?.email === comment.author_id));
          return (
            <article key={comment.comment_id} className="wiki-talk-item">
              <div className="wiki-talk-meta">
                <div>
                  <strong>{comment.author_name}</strong>{' '}
                  <span>{comment.created_at}</span>
                </div>
                {canDeleteComment && (
                  <button
                    type="button"
                    className="pill-btn wiki-danger-btn"
                    disabled={deletingId !== null}
                    onClick={() => {
                      void handleDelete(comment.comment_id);
                    }}
                  >
                    {deletingId === comment.comment_id ? 'Deleting…' : 'Delete'}
                  </button>
                )}
              </div>
              <div className="wiki-talk-body">{comment.body_md}</div>
            </article>
          );
        })}
      </div>

      {capabilities.canEdit && dataSource.postTalkComment ? (
        <form
          className="wiki-talk-form"
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          <label htmlFor={`talk-input-${entityId}`} className="wiki-field-label">
            Add a family note or question
          </label>
          <textarea
            id={`talk-input-${entityId}`}
            className="wiki-textarea"
            rows={3}
            placeholder="Share a memory, ask a question about a date, or add family context…"
            value={bodyMd}
            onChange={(e) => {
              setBodyMd(e.target.value);
            }}
            disabled={submitting}
          />
          <div className="wiki-form-actions">
            <button
              type="submit"
              className="wiki-btn-primary wiki-btn-sm"
              disabled={submitting || bodyMd.trim().length === 0}
            >
              {submitting ? 'Posting…' : 'Post Note'}
            </button>
          </div>
        </form>
      ) : (
        <p className="wiki-hint-text">Sign in as a family editor to add family notes.</p>
      )}
    </section>
  );
};
