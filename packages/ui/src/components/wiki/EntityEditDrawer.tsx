import type { EditorCitationMode, EntityPayload, EntityType } from '@kinloom/core';
import { isEditSummaryValid } from '@kinloom/core';
import { useMachine } from '@xstate/react';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useDialogFocusTrap } from '../../hooks/useDialogFocusTrap.js';
import { cx, joinClasses } from '../../lib/cx.js';
import { entityEditorMachine } from '../../machines/entityEditorMachine.js';
import { useKinloomPlugins } from '../../plugins/PluginContext.js';
import controlStyles from '../../styles/Controls.module.css';
import overlayStyles from '../../styles/Overlays.module.css';
import { EntityDangerZone, EntityDrawerStatusBanners } from './entityForms/EntityDrawerChrome.js';
import { getEntityEditFormEntry } from './entityForms/editRegistry.js';
import { asString } from './entityForms/fieldTypes.js';
import { PronunciationEditorSection, readDraftPronunciation } from './PronunciationEditorSection.js';
import wikiAuthStyles from './WikiAuth.module.css';
import { CitationBadge } from './WikiBadges.js';
import wikiChromeStyles from './WikiChrome.module.css';
import wikiFormStyles from './WikiForms.module.css';
import wikiPanelStyles from './WikiPanels.module.css';

export type EntityEditDrawerSection = 'pronunciation';

export interface EntityEditDrawerProps {
  open: boolean;
  initialSection?: EntityEditDrawerSection;
  entityType: EntityType;
  entityId: string;
  revisionId: number;
  initialData: EntityPayload;
  hasPrimarySource?: boolean;
  title?: string;
  onClose: () => void;
  onSaved?: (revisionId: number, snapshot: EntityPayload) => void;
  onDeleted?: () => void;
}

export const EntityEditDrawer: React.FC<EntityEditDrawerProps> = ({
  open,
  initialSection,
  entityType,
  entityId,
  revisionId,
  initialData,
  hasPrimarySource = true,
  title,
  onClose,
  onSaved,
  onDeleted,
}) => {
  const { dataSource, bundle, baseUrl, reloadArchive, pronunciations, setPronunciations } = useArchiveData();
  const { entityEditForms } = useKinloomPlugins();
  const pronunciationFieldsetRef = useRef<HTMLFieldSetElement | null>(null);
  const pronunciationPrimaryFocusRef = useRef<HTMLElement | null>(null);
  const hasScrolledInitialSectionRef = useRef(false);

  const [snapshot, send] = useMachine(entityEditorMachine, {
    input: {
      entityType,
      entityId,
      revisionId,
      snapshot: initialData,
      hasPrimarySource,
      dataSource,
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger OPEN_EDIT when drawer opens or entity changes
  useEffect(() => {
    if (!open) {
      return;
    }
    send({
      type: 'OPEN_EDIT',
      entityType,
      entityId,
      revisionId,
      snapshot: initialData,
      hasPrimarySource,
    });
  }, [open, entityType, entityId, dataSource]);

  useEffect(() => {
    if (snapshot.matches('saved')) {
      reloadArchive();
      onSaved?.(snapshot.context.baseRevisionId, snapshot.context.baseSnapshot);
    }
  }, [snapshot, reloadArchive, onSaved]);

  useEffect(() => {
    if (snapshot.matches('deleted')) {
      reloadArchive();
      send({ type: 'DISMISS_DELETED' });
      onDeleted?.();
      onClose();
    }
  }, [snapshot, reloadArchive, send, onDeleted, onClose]);

  const syncingRevision = snapshot.hasTag('syncing');

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll flag when target entityId changes
  useEffect(() => {
    if (!open) {
      hasScrolledInitialSectionRef.current = false;
    }
  }, [open, entityId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus pronunciation section once revision sync finishes
  useEffect(() => {
    if (!open || initialSection !== 'pronunciation') {
      return undefined;
    }
    const scrollAndFocus = (): void => {
      const fieldset = pronunciationFieldsetRef.current;
      if (fieldset && !hasScrolledInitialSectionRef.current) {
        hasScrolledInitialSectionRef.current = true;
        if (typeof fieldset.scrollIntoView === 'function') {
          fieldset.scrollIntoView({ block: 'start', behavior: 'auto' });
        }
      }
      const focusTarget = pronunciationPrimaryFocusRef.current;
      if (focusTarget && !focusTarget.hasAttribute('disabled')) {
        focusTarget.focus({ preventScroll: true });
      }
    };
    const timer = window.setTimeout(scrollAndFocus, 20);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [open, initialSection, syncingRevision]);

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const closeHandlerRef = useRef<() => void>(onClose);
  const dialogRef = useDialogFocusTrap({
    open,
    onClose: () => {
      closeHandlerRef.current();
    },
    initialFocusRef: closeBtnRef,
  });

  if (!open) {
    return null;
  }

  const {
    draft,
    summary,
    citationMode,
    sourceIds,
    conflict,
    validationErrors,
    networkError,
    deleteSummary,
    deleteError,
  } = snapshot.context;
  const formEntry = getEntityEditFormEntry(entityType, entityEditForms);
  const EntityFields = formEntry.Fields;
  const isSaving = snapshot.matches('saving');
  const isDeleting = snapshot.matches('deleting');
  const deleteConfirmOpen = snapshot.matches('confirmingDelete') || isDeleting;
  const isBusy = snapshot.hasTag('busy');
  const isConflict = snapshot.matches('conflict409');
  const isSaved = snapshot.matches('saved');
  const isConfirmingLeave = snapshot.matches('confirmingLeave');
  const isNetworkError = snapshot.matches('networkErrorRetryable');
  const summaryValid = isEditSummaryValid(summary);
  const saveDisabledHint = syncingRevision
    ? 'Loading latest revision…'
    : !isSaving && !snapshot.context.dirty
      ? 'Change any field to save.'
      : !isSaving && !summaryValid
        ? 'Add a short edit summary (3+ characters) to save.'
        : null;

  const updateField = (key: string, value: unknown): void => {
    send({
      type: 'EDIT_FIELD',
      draft: {
        ...draft,
        [key]: value,
      },
    });
  };

  const replaceDraft = (nextDraft: EntityPayload): void => {
    send({ type: 'EDIT_FIELD', draft: nextDraft });
  };

  const draftPronunciation = readDraftPronunciation(draft?.pronunciation);
  const pronunciationEntityType = formEntry.pronunciationEntityType;
  const canEditPronunciation = Boolean(pronunciationEntityType && formEntry.supportsPronunciation?.(draft));
  const pronunciationPreviewLabel =
    formEntry.getPronunciationPreviewLabel?.(draft, title, entityId) ?? title ?? entityId;

  const handleCloseAttempt = (): void => {
    if (snapshot.hasTag('dirty')) {
      send({
        type: 'ENTITY_CHANGED',
        entityType,
        entityId,
        revisionId: snapshot.context.baseRevisionId,
        snapshot: snapshot.context.baseSnapshot,
        hasPrimarySource,
      });
      return;
    }
    if (isSaved) {
      send({ type: 'DISMISS_SAVED' });
    } else {
      send({ type: 'CANCEL_EDIT' });
    }
    onClose();
  };
  closeHandlerRef.current = handleCloseAttempt;

  const availableSources = bundle?.sources ?? [];

  const handleCitationModeChange = (mode: EditorCitationMode): void => {
    send({
      type: 'SET_CITATION',
      mode,
      sourceIds: mode === 'cited' ? sourceIds : [],
    });
  };

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className={cx(overlayStyles, 'drawer-backdrop wiki-edit-drawer-backdrop')}
      aria-label={`Edit ${title ?? `${entityType} ${entityId}`}`}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(overlayStyles, 'lightbox-backdrop-close')}
        aria-label="Close edit drawer"
        onClick={handleCloseAttempt}
      />
      <aside
        className={joinClasses(
          cx(overlayStyles, 'drawer-panel'),
          cx(wikiFormStyles, 'wiki-edit-drawer-panel')
        )}
      >
        <div className={cx(overlayStyles, 'drawer-top')}>
          <div>
            <h2 className={'drawer-title'} style={{ marginTop: 0 }}>
              Edit {title ?? `${entityType}/${entityId}`}
            </h2>
            <div className={cx(wikiFormStyles, 'wiki-drawer-subtitle')}>
              Changes are saved to the family history and can always be undone.
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className={cx(controlStyles, 'pill-btn')}
            onClick={handleCloseAttempt}
          >
            Close
          </button>
        </div>

        <form
          className={cx(wikiFormStyles, 'wiki-edit-drawer-form')}
          onSubmit={(e) => {
            e.preventDefault();
            const preparedDraft = formEntry.prepareSubmitDraft?.(draft);
            if (preparedDraft) {
              send({ type: 'EDIT_FIELD', draft: preparedDraft });
            }
            send({ type: 'SUBMIT' });
          }}
        >
          <div className={cx(wikiFormStyles, 'wiki-edit-drawer-body')}>
            <EntityDrawerStatusBanners
              syncingRevision={syncingRevision}
              isSaving={isSaving}
              isConfirmingLeave={isConfirmingLeave}
              isSaved={isSaved}
              baseRevisionId={snapshot.context.baseRevisionId}
              isConflict={isConflict}
              conflict={conflict}
              draft={draft}
              isNetworkError={isNetworkError}
              networkError={networkError}
              validationErrors={validationErrors}
              onStayEditing={() => {
                send({ type: 'STAY_EDITING' });
              }}
              onConfirmLeave={() => {
                send({ type: 'CONFIRM_LEAVE' });
                onClose();
              }}
              onEditAgain={() => {
                send({ type: 'START_EDIT' });
              }}
              onDismissSaved={() => {
                send({ type: 'DISMISS_SAVED' });
                onClose();
              }}
              onAcceptServer={() => {
                send({ type: 'ACCEPT_SERVER' });
                reloadArchive();
                onClose();
              }}
              onRebaseAndRetry={() => {
                send({ type: 'REBASE_AND_RETRY' });
              }}
              onRebaseToEdit={() => {
                send({ type: 'REBASE_TO_EDIT' });
              }}
              onDiscardDraft={() => {
                send({ type: 'DISCARD_DRAFT' });
                onClose();
              }}
              onRetrySave={() => {
                send({ type: 'RETRY_SAVE' });
              }}
              onReturnToEdit={() => {
                send({ type: 'RETURN_TO_EDIT' });
              }}
            />

            <div className={cx(wikiFormStyles, 'wiki-edit-form')}>
              <EntityFields
                draft={draft}
                isBusy={isBusy}
                updateField={updateField}
                replaceDraft={replaceDraft}
              />

              {canEditPronunciation && pronunciationEntityType && (
                <PronunciationEditorSection
                  entityType={pronunciationEntityType}
                  entityId={entityId}
                  fullName={asString(draft.full_name)}
                  givenName={asString(draft.given_name)}
                  surname={asString(draft.surname)}
                  placeName={asString(draft.name)}
                  previewLabel={pronunciationPreviewLabel}
                  draftPronunciation={draftPronunciation}
                  pronunciations={pronunciations}
                  dataSource={dataSource}
                  baseUrl={baseUrl}
                  isBusy={isBusy}
                  fieldsetRef={pronunciationFieldsetRef}
                  primaryFocusRef={pronunciationPrimaryFocusRef}
                  onUpdatePronunciation={(next) => {
                    updateField('pronunciation', next);
                  }}
                  onSetPronunciations={setPronunciations}
                />
              )}

              <fieldset className={cx(wikiFormStyles, 'wiki-citation-fieldset')}>
                <legend className={cx(wikiFormStyles, 'wiki-field-label')}>Source Verification</legend>
                <div className={cx(wikiFormStyles, 'wiki-citation-options')}>
                  <label className={cx(wikiFormStyles, 'wiki-radio-card')}>
                    <input
                      type="radio"
                      name={`citation-mode-${entityId}`}
                      checked={citationMode === 'cited'}
                      onChange={() => {
                        handleCitationModeChange('cited');
                      }}
                      disabled={isBusy}
                    />
                    <CitationBadge hasPrimarySource />
                    <span className={cx(wikiFormStyles, 'wiki-radio-desc')}>
                      Backed by a primary record or archive source
                    </span>
                  </label>

                  <label className={cx(wikiFormStyles, 'wiki-radio-card')}>
                    <input
                      type="radio"
                      name={`citation-mode-${entityId}`}
                      checked={citationMode === 'familyMemory'}
                      onChange={() => {
                        handleCitationModeChange('familyMemory');
                      }}
                      disabled={isBusy}
                    />
                    <CitationBadge hasPrimarySource={false} />
                    <span className={cx(wikiFormStyles, 'wiki-radio-desc')}>
                      Oral recollection or family note (labeled as Family memory until a primary source is
                      cited)
                    </span>
                  </label>
                </div>

                {citationMode === 'cited' && availableSources.length > 0 && (
                  <label className={cx(wikiFormStyles, 'wiki-field')} style={{ marginTop: 8 }}>
                    <span className={cx(wikiFormStyles, 'wiki-field-label')}>
                      Link primary source (optional)
                    </span>
                    <select
                      className={cx(wikiFormStyles, 'wiki-input')}
                      value={sourceIds[0] ?? ''}
                      onChange={(e) => {
                        const nextId = e.target.value;
                        send({
                          type: 'SET_CITATION',
                          mode: 'cited',
                          sourceIds: nextId ? [nextId] : [],
                        });
                      }}
                      disabled={isBusy}
                    >
                      <option value="">Select archived source…</option>
                      {availableSources.map((src) => (
                        <option key={src.id} value={src.id}>
                          {src.citation}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </fieldset>

              <label className={cx(wikiFormStyles, 'wiki-field')}>
                <span className={cx(wikiFormStyles, 'wiki-field-label')}>
                  What did you change? <span aria-hidden="true">*</span>
                </span>
                <input
                  type="text"
                  className={cx(wikiFormStyles, 'wiki-input')}
                  required
                  minLength={3}
                  placeholder="e.g. Corrected birth year from 1880 census or family Bible"
                  value={summary}
                  onChange={(e) => {
                    send({ type: 'SET_SUMMARY', summary: e.target.value });
                  }}
                  disabled={isBusy}
                />
                {summary.length > 0 && !summaryValid && (
                  <span className={cx(wikiAuthStyles, 'wiki-field-hint is-error')}>
                    Please write a short note (at least 3 characters).
                  </span>
                )}
              </label>
            </div>

            {dataSource.deleteEntity && (
              <EntityDangerZone
                confirmOpen={deleteConfirmOpen}
                summary={deleteSummary}
                busy={isDeleting}
                error={deleteError}
                onOpenConfirm={() => {
                  send({ type: 'REQUEST_DELETE' });
                }}
                onCancelConfirm={() => {
                  send({ type: 'CANCEL_DELETE' });
                }}
                onSummaryChange={(nextSummary) => {
                  send({ type: 'SET_DELETE_SUMMARY', summary: nextSummary });
                }}
                onConfirmDelete={() => {
                  send({ type: 'CONFIRM_DELETE' });
                }}
              />
            )}
          </div>

          <div className={cx(wikiFormStyles, 'wiki-drawer-footer')}>
            {saveDisabledHint && (
              <span className={cx(wikiFormStyles, 'wiki-drawer-footer-hint')}>{saveDisabledHint}</span>
            )}
            <div className={cx(wikiPanelStyles, 'wiki-form-actions')}>
              <button
                type="submit"
                className={cx(wikiChromeStyles, 'wiki-btn-primary wiki-btn-sm')}
                disabled={isBusy || !snapshot.context.dirty || !summaryValid}
              >
                {isSaving ? 'Saving…' : 'Save Changes'}
              </button>
              {isSaving ? (
                <button
                  type="button"
                  className={cx(controlStyles, 'pill-btn')}
                  onClick={() => {
                    send({ type: 'CANCEL_SAVE' });
                  }}
                >
                  Cancel Save
                </button>
              ) : (
                <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={handleCloseAttempt}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        </form>
      </aside>
    </dialog>
  );
};
