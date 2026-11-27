import type { EntityPayload } from '@kinloom/core';
import type React from 'react';
import { cx } from '../../lib/cx.js';
import type { EntityEditorConflict } from '../../machines/entityEditorMachine.js';
import cssMod1 from '../../pages/IndexPage.module.css';
import { RevisionDiffView } from './RevisionDiffView.js';
import { ConflictBadge } from './WikiBadges.js';
import cssMod0 from './WikiPanels.module.css';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod1 };

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
  <section className={cx(uiStyles, 'wiki-conflict-box')} role="alert" aria-label="Edit conflict resolution">
    <div className={cx(uiStyles, 'wiki-conflict-header')}>
      <ConflictBadge label={`Edit Conflict · Server at r${conflict.latestRevisionId}`} />
      <span className={cx(uiStyles, 'wiki-conflict-meta')}>
        {conflict.lastAuthorName ? `Updated by ${conflict.lastAuthorName}` : 'Updated by another editor'}
        {conflict.lastUpdatedAt ? ` · ${conflict.lastUpdatedAt}` : ''}
      </span>
    </div>

    <p className={cx(uiStyles, 'wiki-conflict-copy')}>
      Another editor saved a newer revision while your draft was open. Your unsaved edits are still preserved
      below. Review the field differences and choose how to proceed.
    </p>

    <RevisionDiffView
      before={conflict.latestSnapshot}
      after={localDraft}
      beforeLabel={`Server (r${conflict.latestRevisionId})`}
      afterLabel="Your draft"
      compact
    />

    <div className={cx(uiStyles, 'wiki-conflict-actions')}>
      <button type="button" className={cx(uiStyles, 'pill-btn active')} onClick={onRebaseAndRetry}>
        Rebase &amp; Save Again
      </button>
      <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={onRebaseToEdit}>
        Rebase &amp; Review in Editor
      </button>
      <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={onAcceptServer}>
        Accept Server Version
      </button>
      <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={onDiscardDraft}>
        Discard Draft
      </button>
    </div>
  </section>
);
