import type { EntityPayload } from '@kinloom/core';
import type { EntityEditorConflict } from '../../machines/entityEditorMachine.js';
import { ConflictBadge } from './WikiBadges.js';
import React from 'react';
import { RevisionDiffView } from './RevisionDiffView.js';

export interface ConflictMergeDialogProps {
  conflict: EntityEditorConflict;
  localDraft: EntityPayload;
  onAcceptServer: () => void;
  onRebaseAndRetry: () => void;
  onRebaseToEdit: () => void;
  onDiscardDraft: () => void;
}

/**
 * HTTP 409 Conflict resolution panel showing server vs local field differences
 * with Accept Server, Rebase & Retry, Rebase & Edit, and Discard actions.
 */
export const ConflictMergeDialog: React.FC<ConflictMergeDialogProps> = ({
  conflict,
  localDraft,
  onAcceptServer,
  onRebaseAndRetry,
  onRebaseToEdit,
  onDiscardDraft,
}) => (
  <section
    className="wiki-conflict-box"
    role="alert"
    aria-label="Edit conflict resolution"
  >
    <div className="wiki-conflict-header">
      <ConflictBadge label={`Edit Conflict · Server at r${conflict.latestRevisionId}`} />
      <span className="wiki-conflict-meta">
        {conflict.lastAuthorName ? `Updated by ${conflict.lastAuthorName}` : 'Updated by another editor'}
        {conflict.lastUpdatedAt ? ` · ${conflict.lastUpdatedAt}` : ''}
      </span>
    </div>

    <p className="wiki-conflict-copy">
      Another editor saved a newer revision while your draft was open. Your unsaved edits are still
      preserved below. Review the field differences and choose how to proceed.
    </p>

    <RevisionDiffView
      before={conflict.latestSnapshot}
      after={localDraft}
      beforeLabel={`Server (r${conflict.latestRevisionId})`}
      afterLabel="Your draft"
      compact
    />

    <div className="wiki-conflict-actions">
      <button type="button" className="pill-btn active" onClick={onRebaseAndRetry}>
        Rebase &amp; Save Again
      </button>
      <button type="button" className="pill-btn" onClick={onRebaseToEdit}>
        Rebase &amp; Review in Editor
      </button>
      <button type="button" className="pill-btn" onClick={onAcceptServer}>
        Accept Server Version
      </button>
      <button type="button" className="pill-btn" onClick={onDiscardDraft}>
        Discard Draft
      </button>
    </div>
  </section>
);
