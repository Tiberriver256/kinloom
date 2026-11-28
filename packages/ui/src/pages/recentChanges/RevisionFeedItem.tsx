import type { Person, RevisionRecord, SourceRecord } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { RevisionDiffView } from '../../components/wiki/RevisionDiffView.js';
import { AuthorPill, CitationBadge, StewardReviewBadge } from '../../components/wiki/WikiBadges.js';
import wikiFormStyles from '../../components/wiki/WikiForms.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import { cx, joinClasses } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import { type DuplicateEventWarning, formatRevisionHeadline } from './fieldReportFormatter.js';
import type { PendingRevertConfirm, ResolvedEntityLink } from './recentChangesViewModel.js';

export const DuplicateEventWarningList: React.FC<{
  readonly warnings: readonly DuplicateEventWarning[];
}> = ({ warnings }) => {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div className={cx(wikiPanelStyles, 'wiki-duplicate-warnings')}>
      {warnings.map((w) => (
        <div key={w.key} className={cx(wikiPanelStyles, 'wiki-status-banner is-warning')} role="status">
          <p>
            <strong>Possible duplicate event detected:</strong> Two <strong>{w.year}</strong> records share{' '}
            <strong>{w.personName}</strong> (<em>&ldquo;{w.firstTitle}&rdquo;</em> and{' '}
            <em>&ldquo;{w.secondTitle}&rdquo;</em>).
          </p>
          {w.personSlug && (
            <div className={cx(wikiPanelStyles, 'wiki-inline-actions')}>
              <Link
                to={`/person/${w.personSlug}?event=${w.firstEventId}`}
                className={cx(wikiPanelStyles, 'wiki-entity-link')}
              >
                Inspect first record →
              </Link>
              <Link
                to={`/person/${w.personSlug}?event=${w.secondEventId}`}
                className={cx(wikiPanelStyles, 'wiki-entity-link')}
              >
                Inspect second record →
              </Link>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export const RevisionFeedItem: React.FC<{
  readonly rev: RevisionRecord;
  readonly standalone: boolean;
  readonly isExpanded: boolean;
  readonly canRevert: boolean;
  readonly canReview: boolean;
  readonly busyKey: string | null;
  readonly pendingConfirm: PendingRevertConfirm | null;
  readonly entityLinkByKey: ReadonlyMap<string, ResolvedEntityLink>;
  readonly peopleById?: ReadonlyMap<string, Person>;
  readonly sourcesById?: ReadonlyMap<string, SourceRecord>;
  readonly duplicateWarnings?: readonly DuplicateEventWarning[];
  readonly onToggleExpand: (revisionId: number) => void;
  readonly onRequestRevert: (rev: RevisionRecord) => void;
  readonly onCancelRevert: () => void;
  readonly onConfirmRevert: (rev: RevisionRecord) => Promise<void>;
  readonly onMarkReviewed?: (rev: RevisionRecord) => Promise<void>;
  readonly onClearReview?: (rev: RevisionRecord) => Promise<void>;
}> = ({
  rev,
  standalone,
  isExpanded,
  canRevert,
  canReview,
  busyKey,
  pendingConfirm,
  entityLinkByKey,
  peopleById,
  sourcesById,
  duplicateWarnings = [],
  onToggleExpand,
  onRequestRevert,
  onCancelRevert,
  onConfirmRevert,
  onMarkReviewed,
  onClearReview,
}) => {
  const confirmingRev =
    pendingConfirm?.kind === 'revision' && pendingConfirm.rev.revision_id === rev.revision_id;
  const resolvedLink = entityLinkByKey.get(`${rev.entity_type}:${rev.entity_id}`);
  const headline = formatRevisionHeadline(rev, entityLinkByKey);
  const hasDirectReview = rev.review?.target_kind === 'revision';
  const showReviewStamp = Boolean(rev.review && (standalone || hasDirectReview));
  const canClearDirectReview = Boolean(canReview && hasDirectReview && onClearReview);

  return (
    <article
      data-revision-action={rev.action}
      data-entity-ref={`${rev.entity_type}/${rev.entity_id}`}
      className={joinClasses(
        standalone && cx(layoutStyles, 'place-map-box'),
        cx(wikiPanelStyles, 'wiki-revision-item')
      )}
    >
      <div className={cx(wikiPanelStyles, 'wiki-revision-row')}>
        <div className={cx(wikiPanelStyles, 'wiki-revision-main')}>
          <div className={cx(wikiPanelStyles, 'wiki-report-headline-row')}>
            <h3 className={cx(wikiPanelStyles, 'wiki-report-headline')}>
              {resolvedLink?.to ? (
                <Link to={resolvedLink.to} className={cx(wikiPanelStyles, 'wiki-entity-link')}>
                  {headline}
                </Link>
              ) : (
                headline
              )}
            </h3>
          </div>
          <div className={cx(wikiPanelStyles, 'wiki-revision-summary')}>{rev.summary}</div>
          <div className={cx(wikiPanelStyles, 'wiki-revision-topline')}>
            {standalone && <AuthorPill authorType={rev.author_type} authorName={rev.author_name} />}
            <CitationBadge hasPrimarySource={rev.has_primary_source} />
            {showReviewStamp && rev.review && <StewardReviewBadge review={rev.review} />}
            {canClearDirectReview && (
              <button
                type="button"
                className={cx(wikiPanelStyles, 'wiki-review-undo-btn')}
                aria-label={`${KINLOOM_VOCABULARY.stewardship.clearReviewAria} for revision ${rev.revision_id}`}
                disabled={busyKey !== null}
                onClick={() => {
                  void onClearReview?.(rev);
                }}
              >
                {KINLOOM_VOCABULARY.stewardship.clearReview}
              </button>
            )}
          </div>
          {standalone && (
            <div className={cx(wikiPanelStyles, 'wiki-revision-time')}>
              <time dateTime={rev.created_at} title={rev.created_at}>
                {formatArchivalTimestamp(rev.created_at)}
              </time>
            </div>
          )}
        </div>
        <div className={cx(wikiPanelStyles, 'wiki-revision-actions')}>
          {canReview && !rev.review && onMarkReviewed && (
            <button
              type="button"
              className={cx(wikiPanelStyles, 'wiki-review-btn')}
              disabled={busyKey !== null}
              onClick={() => {
                void onMarkReviewed(rev);
              }}
            >
              {busyKey === `review:rev:${rev.revision_id}`
                ? KINLOOM_VOCABULARY.stewardship.markingReviewed
                : KINLOOM_VOCABULARY.stewardship.markReviewed}
            </button>
          )}
          <button
            type="button"
            className={cx(controlStyles, 'pill-btn')}
            aria-expanded={isExpanded}
            onClick={() => {
              onToggleExpand(rev.revision_id);
            }}
          >
            {isExpanded ? 'Hide Diff' : 'View Diff'}
          </button>
          {canRevert && !confirmingRev && (
            <button
              type="button"
              className={joinClasses(cx(controlStyles, 'pill-btn'), cx(wikiFormStyles, 'wiki-danger-btn'))}
              disabled={busyKey !== null}
              onClick={() => {
                onRequestRevert(rev);
              }}
            >
              {busyKey === `rev:${rev.revision_id}` ? 'Reverting…' : 'Revert'}
            </button>
          )}
        </div>
      </div>

      {standalone && duplicateWarnings.length > 0 && (
        <DuplicateEventWarningList warnings={duplicateWarnings} />
      )}

      {confirmingRev && (
        <div className={cx(wikiPanelStyles, 'wiki-confirm-inline')} role="alert">
          <p className={cx(wikiPanelStyles, 'wiki-confirm-inline-text')}>
            Revert this change ({headline})? This appends a new revert revision without deleting history.
          </p>
          <div className={cx(wikiPanelStyles, 'wiki-inline-actions')}>
            <button
              type="button"
              className={joinClasses(cx(controlStyles, 'pill-btn'), cx(wikiFormStyles, 'wiki-danger-btn'))}
              disabled={busyKey !== null}
              onClick={() => {
                void onConfirmRevert(rev);
              }}
            >
              Confirm Revert
            </button>
            <button
              type="button"
              className={cx(controlStyles, 'pill-btn')}
              disabled={busyKey !== null}
              onClick={onCancelRevert}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isExpanded && (
        <div className={cx(wikiPanelStyles, 'wiki-revision-diff-body')}>
          <RevisionDiffView
            before={rev.before_json}
            after={rev.after_json}
            beforeLabel="Before"
            afterLabel="After"
            peopleById={peopleById}
            sourcesById={sourcesById}
          />
          <div className={cx(wikiPanelStyles, 'wiki-ledger-ref')}>
            Archive ledger reference: <code>r{rev.revision_id}</code> ·{' '}
            <code>
              {rev.entity_type}/{rev.entity_id}
            </code>
          </div>
        </div>
      )}
    </article>
  );
};
