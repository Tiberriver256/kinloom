import type { RevisionRecord } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { RevisionDiffView } from '../../components/wiki/RevisionDiffView.js';
import { AuthorPill, CitationBadge } from '../../components/wiki/WikiBadges.js';
import wikiFormStyles from '../../components/wiki/WikiForms.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import { cx, joinClasses } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import controlStyles from '../../styles/Controls.module.css';
import type { PendingRevertConfirm, ResolvedEntityLink } from './recentChangesViewModel.js';

export const RevisionEntityRef: React.FC<{
  readonly rev: RevisionRecord;
  readonly entityLinkByKey: ReadonlyMap<string, ResolvedEntityLink>;
}> = ({ rev, entityLinkByKey }) => {
  const resolved = entityLinkByKey.get(`${rev.entity_type}:${rev.entity_id}`);
  if (resolved?.to) {
    return (
      <span className={cx(wikiPanelStyles, 'wiki-entity-ref')}>
        <Link to={resolved.to} className={cx(wikiPanelStyles, 'wiki-entity-link')}>
          {resolved.label}
        </Link>
        <code className={cx(wikiPanelStyles, 'wiki-entity-id')}>
          {rev.entity_type}/{rev.entity_id}
        </code>
      </span>
    );
  }
  return (
    <code className={cx(wikiPanelStyles, 'wiki-entity-id')}>
      {rev.entity_type}/{rev.entity_id}
    </code>
  );
};

export const RevisionFeedItem: React.FC<{
  readonly rev: RevisionRecord;
  readonly standalone: boolean;
  readonly isExpanded: boolean;
  readonly canRevert: boolean;
  readonly busyKey: string | null;
  readonly pendingConfirm: PendingRevertConfirm | null;
  readonly entityLinkByKey: ReadonlyMap<string, ResolvedEntityLink>;
  readonly onToggleExpand: (revisionId: number) => void;
  readonly onRequestRevert: (rev: RevisionRecord) => void;
  readonly onCancelRevert: () => void;
  readonly onConfirmRevert: (rev: RevisionRecord) => Promise<void>;
}> = ({
  rev,
  standalone,
  isExpanded,
  canRevert,
  busyKey,
  pendingConfirm,
  entityLinkByKey,
  onToggleExpand,
  onRequestRevert,
  onCancelRevert,
  onConfirmRevert,
}) => {
  const confirmingRev =
    pendingConfirm?.kind === 'revision' && pendingConfirm.rev.revision_id === rev.revision_id;
  return (
    <article
      className={joinClasses(
        standalone && cx(controlStyles, 'place-map-box'),
        cx(wikiPanelStyles, 'wiki-revision-item')
      )}
    >
      <div className={cx(wikiPanelStyles, 'wiki-revision-row')}>
        <div className={cx(wikiPanelStyles, 'wiki-revision-main')}>
          <div className={cx(wikiPanelStyles, 'wiki-revision-topline')}>
            <code className={cx(wikiPanelStyles, 'wiki-rev-id')}>r{rev.revision_id}</code>
            <span className={cx(wikiPanelStyles, `wiki-action-tag action-${rev.action}`)}>{rev.action}</span>
            <RevisionEntityRef rev={rev} entityLinkByKey={entityLinkByKey} />
            {standalone && <AuthorPill authorType={rev.author_type} authorName={rev.author_name} />}
            <CitationBadge hasPrimarySource={rev.has_primary_source} />
          </div>
          <div className={cx(wikiPanelStyles, 'wiki-revision-summary')}>{rev.summary}</div>
          {standalone && (
            <div className={cx(wikiPanelStyles, 'wiki-revision-time')}>
              <time dateTime={rev.created_at} title={rev.created_at}>
                {formatArchivalTimestamp(rev.created_at)}
              </time>
            </div>
          )}
        </div>
        <div className={cx(wikiPanelStyles, 'wiki-revision-actions')}>
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
      {confirmingRev && (
        <div className={cx(wikiPanelStyles, 'wiki-confirm-inline')} role="alert">
          <p className={cx(wikiPanelStyles, 'wiki-confirm-inline-text')}>
            Revert revision <code>r{rev.revision_id}</code> on{' '}
            <code>
              {rev.entity_type}/{rev.entity_id}
            </code>
            ?
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
            afterLabel={`r${rev.revision_id}`}
          />
        </div>
      )}
    </article>
  );
};
