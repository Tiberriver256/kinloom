import type { EntityPayload } from '@kinloom/core';
import { isEditSummaryValid } from '@kinloom/core';
import type React from 'react';
import { cx, joinClasses } from '../../../lib/cx.js';
import type { EntityEditorConflict } from '../../../machines/entityEditorMachine.js';
import controlStyles from '../../../styles/Controls.module.css';
import { ConflictMergeDialog } from '../ConflictMergeDialog.js';
import wikiFormStyles from '../WikiForms.module.css';
import wikiPanelStyles from '../WikiPanels.module.css';

export interface EntityDrawerStatusBannersProps {
  readonly syncingRevision: boolean;
  readonly isSaving: boolean;
  readonly isConfirmingLeave: boolean;
  readonly isSaved: boolean;
  readonly baseRevisionId: number;
  readonly isConflict: boolean;
  readonly conflict: EntityEditorConflict | null;
  readonly draft: EntityPayload;
  readonly isNetworkError: boolean;
  readonly networkError: string | null;
  readonly validationErrors: readonly string[];
  readonly onStayEditing: () => void;
  readonly onConfirmLeave: () => void;
  readonly onEditAgain: () => void;
  readonly onDismissSaved: () => void;
  readonly onAcceptServer: () => void;
  readonly onRebaseAndRetry: () => void;
  readonly onRebaseToEdit: () => void;
  readonly onDiscardDraft: () => void;
  readonly onRetrySave: () => void;
  readonly onReturnToEdit: () => void;
}

export const EntityDrawerStatusBanners: React.FC<EntityDrawerStatusBannersProps> = ({
  syncingRevision,
  isSaving,
  isConfirmingLeave,
  isSaved,
  baseRevisionId,
  isConflict,
  conflict,
  draft,
  isNetworkError,
  networkError,
  validationErrors,
  onStayEditing,
  onConfirmLeave,
  onEditAgain,
  onDismissSaved,
  onAcceptServer,
  onRebaseAndRetry,
  onRebaseToEdit,
  onDiscardDraft,
  onRetrySave,
  onReturnToEdit,
}) => (
  <>
    {syncingRevision && !isSaving && (
      <div className={cx(wikiPanelStyles, 'wiki-status-banner is-info')} role="status" aria-live="polite">
        Loading latest revision…
      </div>
    )}

    {isConfirmingLeave && (
      <div className={cx(wikiPanelStyles, 'wiki-status-banner is-warning')} role="alert">
        <div>
          <strong>Unsaved changes.</strong> Leaving will discard your local edits.
        </div>
        <div className={cx(wikiPanelStyles, 'wiki-inline-actions')}>
          <button type="button" className={cx(controlStyles, 'pill-btn active')} onClick={onStayEditing}>
            Keep Editing
          </button>
          <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onConfirmLeave}>
            Discard &amp; Close
          </button>
        </div>
      </div>
    )}

    {isSaved && (
      <output className={cx(wikiPanelStyles, 'wiki-status-banner is-success')} aria-live="polite">
        <div>
          Saved revision <code>r{baseRevisionId}</code>.
        </div>
        <div className={cx(wikiPanelStyles, 'wiki-inline-actions')}>
          <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onEditAgain}>
            Edit Again
          </button>
          <button type="button" className={cx(controlStyles, 'pill-btn active')} onClick={onDismissSaved}>
            Done
          </button>
        </div>
      </output>
    )}

    {isConflict && conflict && (
      <ConflictMergeDialog
        conflict={conflict}
        localDraft={draft}
        onAcceptServer={onAcceptServer}
        onRebaseAndRetry={onRebaseAndRetry}
        onRebaseToEdit={onRebaseToEdit}
        onDiscardDraft={onDiscardDraft}
      />
    )}

    {isNetworkError && networkError && (
      <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
        <div>
          <strong>Save failed:</strong> {networkError}
        </div>
        <div className={cx(wikiPanelStyles, 'wiki-inline-actions')}>
          <button type="button" className={cx(controlStyles, 'pill-btn active')} onClick={onRetrySave}>
            Retry Save
          </button>
          <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onReturnToEdit}>
            Back to Editor
          </button>
        </div>
      </div>
    )}

    {validationErrors.length > 0 && (
      <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
        <strong>Fix before saving:</strong>
        <ul className={cx(wikiFormStyles, 'wiki-error-list')}>
          {validationErrors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      </div>
    )}
  </>
);

export interface EntityDangerZoneProps {
  readonly confirmOpen: boolean;
  readonly summary: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onOpenConfirm: () => void;
  readonly onCancelConfirm: () => void;
  readonly onSummaryChange: (value: string) => void;
  readonly onConfirmDelete: () => void;
}

export const EntityDangerZone: React.FC<EntityDangerZoneProps> = ({
  confirmOpen,
  summary,
  busy,
  error,
  onOpenConfirm,
  onCancelConfirm,
  onSummaryChange,
  onConfirmDelete,
}) => (
  <div className={cx(wikiFormStyles, 'wiki-danger-zone')}>
    {!confirmOpen ? (
      <button
        type="button"
        className={joinClasses(cx(controlStyles, 'pill-btn'), cx(wikiFormStyles, 'wiki-danger-btn'))}
        onClick={onOpenConfirm}
      >
        Remove from Archive
      </button>
    ) : (
      <div className={'wiki-danger-confirm'}>
        <p>
          Removing hides this page from the archive while keeping its full history so it can be restored
          anytime.
        </p>
        {error && (
          <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
            <p>{error}</p>
          </div>
        )}
        <input
          type="text"
          className={cx(wikiFormStyles, 'wiki-input')}
          placeholder="Why are you removing this? (at least 3 characters)"
          value={summary}
          onChange={(e) => {
            onSummaryChange(e.target.value);
          }}
          disabled={busy}
        />
        <div className={cx(wikiPanelStyles, 'wiki-inline-actions')} style={{ marginTop: 8 }}>
          <button
            type="button"
            className={joinClasses(cx(controlStyles, 'pill-btn'), cx(wikiFormStyles, 'wiki-danger-btn'))}
            disabled={busy || !isEditSummaryValid(summary)}
            onClick={() => {
              void onConfirmDelete();
            }}
          >
            {busy ? 'Removing…' : 'Confirm Removal'}
          </button>
          <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onCancelConfirm}>
            Cancel
          </button>
        </div>
      </div>
    )}
  </div>
);
