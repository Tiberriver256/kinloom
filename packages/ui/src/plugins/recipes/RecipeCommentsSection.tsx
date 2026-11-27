import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArchivalMarkdown } from '../../components/ArchivalMarkdown.js';
import { ArchivalModal, ArchivalToast } from '../../components/ArchivalPrimitives.js';
import { cx } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import {
  countActiveRecipeComments,
  formatDeletedCommentTombstone,
  groupRecipeCommentThreads,
  RECIPE_COMMENT_MAX_LENGTH,
  type UiRecipeComment,
  validateRecipeCommentBody,
} from '../../lib/recipesModel.js';
import { useKinloomPluginContext } from '../PluginContext.js';
import recipeStyles from './Recipes.module.css';
import { useRecipesPlugin } from './RecipesContext.js';

export interface RecipeCommentsSectionProps {
  readonly recipeSlug: string;
  readonly initialCommentCount: number;
  readonly canComment: boolean;
  readonly onCommentCountChange?: (nextCount: number) => void;
}

type CommentInteractionState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'replying';
      readonly parentId: string;
      readonly parentAuthorName: string;
      readonly body: string;
      readonly error: string | null;
    }
  | {
      readonly kind: 'editing';
      readonly commentId: string;
      readonly body: string;
      readonly error: string | null;
    }
  | {
      readonly kind: 'confirm_delete';
      readonly comment: UiRecipeComment;
      readonly hasActiveReplies: boolean;
    };

interface CommentFeedbackBanner {
  readonly tone: 'success' | 'error';
  readonly message: string;
}

function pruneDeletedCommentLocally(
  comments: readonly UiRecipeComment[],
  deletedComment: UiRecipeComment
): readonly UiRecipeComment[] {
  const hasActiveChild =
    deletedComment.depth === 0 &&
    comments.some((c) => c.parent_comment_id === deletedComment.id && !c.deleted);

  const next = comments
    .map((item) => {
      if (item.id !== deletedComment.id) {
        return item;
      }
      if (!hasActiveChild) {
        return null;
      }
      return {
        ...item,
        deleted: true,
        deleted_by_role: item.can_edit ? ('author' as const) : ('admin' as const),
        author_name: null,
        author_key: null,
        body_md: '',
        edited_at: null,
        can_edit: false,
        can_delete: false,
      };
    })
    .filter((item): item is UiRecipeComment => item !== null);

  if (deletedComment.depth === 1 && deletedComment.parent_comment_id) {
    const parentId = deletedComment.parent_comment_id;
    const parentStillHasActiveReplies = next.some((c) => c.parent_comment_id === parentId && !c.deleted);
    if (!parentStillHasActiveReplies) {
      return next.filter((c) => !(c.id === parentId && c.deleted));
    }
  }
  return next;
}

export const RecipeCommentsSection: React.FC<RecipeCommentsSectionProps> = ({
  recipeSlug,
  initialCommentCount,
  canComment: canCommentProp,
  onCommentCountChange,
}) => {
  const { client } = useRecipesPlugin();
  const { session } = useKinloomPluginContext();

  const headingId = useId();
  const composerId = useId();
  const composerHintId = useId();
  const composerErrorId = useId();
  const replyInputId = useId();
  const replyErrorId = useId();
  const editInputId = useId();
  const editErrorId = useId();

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const replyInputRef = useRef<HTMLTextAreaElement | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const onCommentCountChangeRef = useRef(onCommentCountChange);
  onCommentCountChangeRef.current = onCommentCountChange;
  const initialCountRef = useRef(initialCommentCount);
  initialCountRef.current = initialCommentCount;

  const [comments, setComments] = useState<readonly UiRecipeComment[]>([]);
  const [commentCount, setCommentCount] = useState<number>(initialCommentCount);
  const [serverCanComment, setServerCanComment] = useState<boolean>(canCommentProp);
  const [loading, setLoading] = useState<boolean>(Boolean(client.listRecipeComments));
  const [loadError, setLoadError] = useState<string | null>(null);

  const [composerBody, setComposerBody] = useState<string>('');
  const [composerError, setComposerError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<boolean>(false);
  const [interaction, setInteraction] = useState<CommentInteractionState>({ kind: 'idle' });
  const [feedback, setFeedback] = useState<CommentFeedbackBanner | null>(null);

  useEffect(() => {
    setServerCanComment(canCommentProp);
  }, [canCommentProp]);

  const syncCount = useCallback((nextCount: number) => {
    setCommentCount(nextCount);
    onCommentCountChangeRef.current?.(nextCount);
  }, []);

  useEffect(() => {
    if (!client.listRecipeComments) {
      setComments([]);
      setCommentCount(initialCountRef.current);
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setInteraction({ kind: 'idle' });
    setFeedback(null);
    setComposerError(null);

    void client
      .listRecipeComments(recipeSlug, { signal: controller.signal })
      .then((res) => {
        if (cancelled) {
          return;
        }
        if (res === null) {
          setComments([]);
          syncCount(0);
        } else {
          setComments(res.comments);
          const nextCount = res.comment_count ?? countActiveRecipeComments(res.comments);
          syncCount(nextCount);
          if (res.permissions) {
            setServerCanComment(res.permissions.can_comment);
          }
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setLoadError(err instanceof Error ? err.message : 'Unable to load recipe discussion right now.');
        setLoading(false);
      });

    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [client, recipeSlug, syncCount]);

  const threads = useMemo(() => groupRecipeCommentThreads(comments), [comments]);
  const canPostComment = Boolean(serverCanComment && client.createRecipeComment);

  const handleSubmitTopLevel = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canPostComment || !client.createRecipeComment || busyAction) {
      return;
    }
    const validated = validateRecipeCommentBody(composerBody);
    if (!validated.ok) {
      setComposerError(validated.error);
      composerRef.current?.focus();
      return;
    }

    setBusyAction(true);
    setComposerError(null);
    setFeedback(null);
    try {
      const created = await client.createRecipeComment(recipeSlug, {
        body_md: validated.body_md,
        parent_comment_id: null,
      });
      setComments((prev) => [...prev, created.comment]);
      syncCount(created.comment_count);
      setComposerBody('');
      setFeedback({ tone: 'success', message: 'Comment posted.' });
    } catch (err: unknown) {
      setFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to post comment.',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleSubmitReply = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canPostComment || !client.createRecipeComment || busyAction || interaction.kind !== 'replying') {
      return;
    }
    const validated = validateRecipeCommentBody(interaction.body);
    if (!validated.ok) {
      setInteraction({ ...interaction, error: validated.error });
      replyInputRef.current?.focus();
      return;
    }

    setBusyAction(true);
    setFeedback(null);
    try {
      const created = await client.createRecipeComment(recipeSlug, {
        body_md: validated.body_md,
        parent_comment_id: interaction.parentId,
      });
      setComments((prev) => [...prev, created.comment]);
      syncCount(created.comment_count);
      setInteraction({ kind: 'idle' });
      setFeedback({ tone: 'success', message: 'Reply posted.' });
    } catch (err: unknown) {
      setFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to post reply.',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleSubmitEdit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!client.updateRecipeComment || busyAction || interaction.kind !== 'editing') {
      return;
    }
    const validated = validateRecipeCommentBody(interaction.body);
    if (!validated.ok) {
      setInteraction({ ...interaction, error: validated.error });
      editInputRef.current?.focus();
      return;
    }

    setBusyAction(true);
    setFeedback(null);
    try {
      const updated = await client.updateRecipeComment(recipeSlug, interaction.commentId, {
        body_md: validated.body_md,
      });
      setComments((prev) => prev.map((c) => (c.id === updated.comment.id ? updated.comment : c)));
      setInteraction({ kind: 'idle' });
      setFeedback({ tone: 'success', message: 'Comment updated.' });
    } catch (err: unknown) {
      setFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to update comment.',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleConfirmDelete = async (): Promise<void> => {
    if (!client.deleteRecipeComment || busyAction || interaction.kind !== 'confirm_delete') {
      return;
    }
    const target = interaction.comment;
    setBusyAction(true);
    setFeedback(null);
    try {
      await client.deleteRecipeComment(recipeSlug, target.id);
      if (client.listRecipeComments) {
        const refreshed = await client.listRecipeComments(recipeSlug);
        if (refreshed !== null) {
          setComments(refreshed.comments);
          syncCount(refreshed.comment_count ?? countActiveRecipeComments(refreshed.comments));
        } else {
          const pruned = pruneDeletedCommentLocally(comments, target);
          setComments(pruned);
          syncCount(countActiveRecipeComments(pruned));
        }
      } else {
        const pruned = pruneDeletedCommentLocally(comments, target);
        setComments(pruned);
        syncCount(countActiveRecipeComments(pruned));
      }
      setInteraction({ kind: 'idle' });
      setFeedback({ tone: 'success', message: 'Comment removed.' });
    } catch (err: unknown) {
      setInteraction({ kind: 'idle' });
      setFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to delete comment.',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const renderCommentCard = (
    comment: UiRecipeComment,
    options: { readonly isReply: boolean; readonly hasActiveReplies: boolean }
  ): React.ReactNode => {
    const authorLabel = comment.author_name?.trim() || 'Archive member';
    const isEditing = interaction.kind === 'editing' && interaction.commentId === comment.id;

    if (comment.deleted) {
      return (
        <article
          className={cx(
            recipeStyles,
            options.isReply
              ? 'recipe-comment-card recipe-comment-card-reply recipe-comment-tombstone'
              : 'recipe-comment-card recipe-comment-tombstone'
          )}
        >
          <header className={cx(recipeStyles, 'recipe-comment-meta')}>
            <span className={cx(recipeStyles, 'recipe-comment-tombstone-label')}>
              {formatDeletedCommentTombstone(comment.deleted_by_role)}
            </span>
            <time
              dateTime={comment.created_at}
              title={comment.created_at}
              className={cx(recipeStyles, 'recipe-comment-time')}
            >
              {formatArchivalTimestamp(comment.created_at)}
            </time>
          </header>
        </article>
      );
    }

    return (
      <article
        className={cx(
          recipeStyles,
          options.isReply ? 'recipe-comment-card recipe-comment-card-reply' : 'recipe-comment-card'
        )}
      >
        <header className={cx(recipeStyles, 'recipe-comment-meta')}>
          <div className={cx(recipeStyles, 'recipe-comment-byline')}>
            <strong className={cx(recipeStyles, 'recipe-comment-author')}>{authorLabel}</strong>
            <time
              dateTime={comment.created_at}
              title={comment.created_at}
              className={cx(recipeStyles, 'recipe-comment-time')}
            >
              {formatArchivalTimestamp(comment.created_at)}
            </time>
            {comment.edited_at !== null && (
              <span
                className={cx(recipeStyles, 'recipe-comment-edited')}
                title={`Edited ${comment.edited_at}`}
              >
                (edited)
              </span>
            )}
          </div>

          <div className={cx(recipeStyles, 'recipe-comment-actions')}>
            {!options.isReply && canPostComment && (
              <button
                type="button"
                disabled={busyAction}
                aria-label={`Reply to ${authorLabel}`}
                className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                onClick={() => {
                  setFeedback(null);
                  setInteraction({
                    kind: 'replying',
                    parentId: comment.id,
                    parentAuthorName: authorLabel,
                    body: '',
                    error: null,
                  });
                }}
              >
                Reply
              </button>
            )}
            {comment.can_edit && client.updateRecipeComment && (
              <button
                type="button"
                disabled={busyAction}
                aria-label={`Edit comment by ${authorLabel}`}
                className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                onClick={() => {
                  setFeedback(null);
                  setInteraction({
                    kind: 'editing',
                    commentId: comment.id,
                    body: comment.body_md,
                    error: null,
                  });
                }}
              >
                Edit
              </button>
            )}
            {comment.can_delete && client.deleteRecipeComment && (
              <button
                type="button"
                disabled={busyAction}
                aria-label={`Delete comment by ${authorLabel}`}
                className={cx(recipeStyles, 'recipe-photo-mini-btn recipe-photo-mini-btn-danger')}
                onClick={() => {
                  setFeedback(null);
                  setInteraction({
                    kind: 'confirm_delete',
                    comment,
                    hasActiveReplies: options.hasActiveReplies,
                  });
                }}
              >
                Delete
              </button>
            )}
          </div>
        </header>

        {isEditing ? (
          <form
            noValidate
            className={cx(recipeStyles, 'recipe-comment-inline-form')}
            onSubmit={(e) => {
              void handleSubmitEdit(e);
            }}
          >
            <label htmlFor={editInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
              Edit comment
            </label>
            <textarea
              ref={editInputRef}
              id={editInputId}
              rows={3}
              maxLength={RECIPE_COMMENT_MAX_LENGTH}
              value={interaction.body}
              disabled={busyAction}
              aria-invalid={interaction.error ? 'true' : 'false'}
              aria-describedby={interaction.error ? editErrorId : undefined}
              className={cx(recipeStyles, 'recipe-editor-textarea')}
              onChange={(e) => {
                setInteraction({
                  kind: 'editing',
                  commentId: comment.id,
                  body: e.target.value,
                  error: null,
                });
              }}
            />
            {interaction.error && (
              <p id={editErrorId} role="alert" className={cx(recipeStyles, 'recipe-field-error')}>
                {interaction.error}
              </p>
            )}
            <div className={cx(recipeStyles, 'recipe-comment-form-actions')}>
              <button type="submit" disabled={busyAction} className={cx(recipeStyles, 'recipe-primary-btn')}>
                {busyAction ? 'Saving…' : 'Save Changes'}
              </button>
              <button
                type="button"
                disabled={busyAction}
                className={cx(recipeStyles, 'recipe-clear-btn')}
                onClick={() => {
                  setInteraction({ kind: 'idle' });
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className={cx(recipeStyles, 'recipe-comment-body')}>
            <ArchivalMarkdown markdown={comment.body_md} />
          </div>
        )}
      </article>
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      className={cx(recipeStyles, 'recipe-comments-section recipe-print-hide')}
    >
      <div className={cx(recipeStyles, 'recipe-comments-header')}>
        <h2 id={headingId} className={cx(recipeStyles, 'recipe-section-heading')}>
          Family Discussion
        </h2>
        <span className={cx(recipeStyles, 'recipe-comments-count')}>
          {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
        </span>
      </div>

      {feedback && (
        <ArchivalToast
          tone={feedback.tone}
          message={feedback.message}
          onDismiss={() => {
            setFeedback(null);
          }}
        />
      )}

      {loadError && (
        <ArchivalToast
          tone="error"
          message={loadError}
          onDismiss={() => {
            setLoadError(null);
          }}
        />
      )}

      {loading && (
        <output aria-live="polite" className={cx(recipeStyles, 'recipe-banner-meta')}>
          Loading family discussion…
        </output>
      )}

      {!loading && threads.length === 0 && (
        <p className={cx(recipeStyles, 'recipe-comments-empty')}>
          Share a memory or cooking note about this recipe.
        </p>
      )}

      {!loading && threads.length > 0 && (
        <ol className={cx(recipeStyles, 'recipe-comment-list')}>
          {threads.map((thread) => {
            const hasActiveReplies = thread.replies.some((r) => !r.deleted);
            const isReplyingHere = interaction.kind === 'replying' && interaction.parentId === thread.root.id;

            return (
              <li key={thread.root.id} className={cx(recipeStyles, 'recipe-comment-thread')}>
                {renderCommentCard(thread.root, { isReply: false, hasActiveReplies })}

                {isReplyingHere && (
                  <form
                    noValidate
                    className={cx(recipeStyles, 'recipe-comment-inline-form recipe-comment-reply-form')}
                    onSubmit={(e) => {
                      void handleSubmitReply(e);
                    }}
                  >
                    <label htmlFor={replyInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                      Reply to {interaction.parentAuthorName}
                    </label>
                    <textarea
                      ref={replyInputRef}
                      id={replyInputId}
                      rows={3}
                      maxLength={RECIPE_COMMENT_MAX_LENGTH}
                      value={interaction.body}
                      disabled={busyAction}
                      placeholder="Write a reply…"
                      aria-invalid={interaction.error ? 'true' : 'false'}
                      aria-describedby={interaction.error ? replyErrorId : undefined}
                      className={cx(recipeStyles, 'recipe-editor-textarea')}
                      onChange={(e) => {
                        setInteraction({
                          ...interaction,
                          body: e.target.value,
                          error: null,
                        });
                      }}
                    />
                    {interaction.error && (
                      <p id={replyErrorId} role="alert" className={cx(recipeStyles, 'recipe-field-error')}>
                        {interaction.error}
                      </p>
                    )}
                    <div className={cx(recipeStyles, 'recipe-comment-form-actions')}>
                      <button
                        type="submit"
                        disabled={busyAction}
                        className={cx(recipeStyles, 'recipe-primary-btn')}
                      >
                        {busyAction ? 'Posting…' : 'Post Reply'}
                      </button>
                      <button
                        type="button"
                        disabled={busyAction}
                        className={cx(recipeStyles, 'recipe-clear-btn')}
                        onClick={() => {
                          setInteraction({ kind: 'idle' });
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {thread.replies.length > 0 && (
                  <ol
                    aria-label={`Replies to ${thread.root.author_name ?? 'removed comment'}`}
                    className={cx(recipeStyles, 'recipe-comment-replies')}
                  >
                    {thread.replies.map((reply) => (
                      <li key={reply.id}>
                        {renderCommentCard(reply, { isReply: true, hasActiveReplies: false })}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {canPostComment ? (
        <form
          noValidate
          className={cx(recipeStyles, 'recipe-comment-composer')}
          onSubmit={(e) => {
            void handleSubmitTopLevel(e);
          }}
        >
          <label htmlFor={composerId} className={cx(recipeStyles, 'recipe-filter-label')}>
            Add a cooking note or family memory
          </label>
          <textarea
            ref={composerRef}
            id={composerId}
            rows={4}
            maxLength={RECIPE_COMMENT_MAX_LENGTH}
            value={composerBody}
            disabled={busyAction}
            placeholder="Share a memory, variation, or kitchen tip…"
            aria-invalid={composerError ? 'true' : 'false'}
            aria-describedby={composerError ? `${composerErrorId} ${composerHintId}` : composerHintId}
            className={cx(recipeStyles, 'recipe-editor-textarea')}
            onChange={(e) => {
              setComposerBody(e.target.value);
              if (composerError) {
                setComposerError(null);
              }
            }}
          />
          {composerError && (
            <p id={composerErrorId} role="alert" className={cx(recipeStyles, 'recipe-field-error')}>
              {composerError}
            </p>
          )}
          <div className={cx(recipeStyles, 'recipe-comment-composer-footer')}>
            <p id={composerHintId} className={cx(recipeStyles, 'recipe-editor-hint')}>
              {composerBody.trim().length}/{RECIPE_COMMENT_MAX_LENGTH} characters · Supports **bold**,
              *italic*, and lists.
            </p>
            <button type="submit" disabled={busyAction} className={cx(recipeStyles, 'recipe-primary-btn')}>
              {busyAction ? 'Posting…' : 'Post Comment'}
            </button>
          </div>
        </form>
      ) : (
        <p className={cx(recipeStyles, 'recipe-comments-readonly-note')}>
          {session?.authenticated
            ? 'Comments are currently restricted on this archive.'
            : 'Sign in as a family archive member to join the discussion.'}
        </p>
      )}

      <ArchivalModal
        open={interaction.kind === 'confirm_delete'}
        title="Delete this comment?"
        onClose={() => {
          if (!busyAction) {
            setInteraction({ kind: 'idle' });
          }
        }}
      >
        <p className={cx(recipeStyles, 'recipe-detail-summary')}>
          {interaction.kind === 'confirm_delete' && interaction.hasActiveReplies
            ? 'This comment has active replies, so removing it will leave a [Comment removed] placeholder to keep the thread intact.'
            : 'Remove this comment from the recipe discussion?'}
        </p>
        <div className={cx(recipeStyles, 'recipe-conflict-actions')}>
          <button
            type="button"
            disabled={busyAction}
            className={cx(recipeStyles, 'recipe-photo-mini-btn recipe-photo-mini-btn-danger')}
            onClick={() => {
              void handleConfirmDelete();
            }}
          >
            {busyAction ? 'Deleting…' : 'Confirm Delete'}
          </button>
          <button
            type="button"
            disabled={busyAction}
            className={cx(recipeStyles, 'recipe-clear-btn')}
            onClick={() => {
              setInteraction({ kind: 'idle' });
            }}
          >
            Cancel
          </button>
        </div>
      </ArchivalModal>
    </section>
  );
};
