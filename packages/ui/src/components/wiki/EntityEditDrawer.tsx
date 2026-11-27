import type { EditorCitationMode, EntityPayload, EntityType } from '@kinloom/core';
import { asRevisionId, isEditSummaryValid } from '@kinloom/core';
import { useMachine } from '@xstate/react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import { useDialogFocusTrap } from '../../lib/useDialogFocusTrap.js';
import { entityEditorMachine } from '../../machines/entityEditorMachine.js';
import cssMod3 from '../../pages/IndexPage.module.css';
import cssMod0 from '../PronunciationBadge.module.css';
import cssMod1 from '../SourceReaderDrawer.module.css';
import { EntityDangerZone, EntityDrawerStatusBanners } from './entityForms/EntityDrawerChrome.js';
import { getEntityEditFormEntry } from './entityForms/editRegistry.js';
import { asString } from './entityForms/fieldTypes.js';
import { PronunciationEditorSection, readDraftPronunciation } from './PronunciationEditorSection.js';
import cssMod2_1 from './WikiAuth.module.css';
import { CitationBadge } from './WikiBadges.js';
import cssMod2_0 from './WikiChrome.module.css';
import cssMod2_3 from './WikiForms.module.css';
import cssMod2_2 from './WikiPanels.module.css';

const uiStyles: Readonly<Record<string, string>> = {
  ...cssMod0,
  ...cssMod1,
  ...cssMod2_0,
  ...cssMod2_1,
  ...cssMod2_2,
  ...cssMod2_3,
  ...cssMod3,
};

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
  const pronunciationFieldsetRef = useRef<HTMLFieldSetElement | null>(null);
  const pronunciationPrimaryFocusRef = useRef<HTMLElement | null>(null);
  const hasScrolledInitialSectionRef = useRef(false);
  const [syncingRevision, setSyncingRevision] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSummary, setDeleteSummary] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: machine send and snapshot.matches are intentionally omitted to avoid re-running load effect
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    if (!dataSource.getEntity) {
      if (snapshot.matches('viewing')) {
        send({ type: 'START_EDIT' });
      }
      return undefined;
    }
    let cancelled = false;
    setSyncingRevision(true);
    void dataSource
      .getEntity(entityType, entityId)
      .then((live) => {
        if (cancelled) {
          return;
        }
        send({
          type: 'ENTITY_CHANGED',
          entityType,
          entityId,
          revisionId: live.current_revision_id,
          snapshot: live.entity,
          hasPrimarySource: live.has_primary_source,
        });
        send({ type: 'START_EDIT' });
      })
      .catch(() => {
        if (!cancelled) {
          send({ type: 'START_EDIT' });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSyncingRevision(false);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [open, entityType, entityId, dataSource]);

  useEffect(() => {
    if (snapshot.context.entityId !== entityId || snapshot.context.entityType !== entityType) {
      send({
        type: 'ENTITY_CHANGED',
        entityType,
        entityId,
        revisionId,
        snapshot: initialData,
        hasPrimarySource,
      });
    }
  }, [
    entityType,
    entityId,
    revisionId,
    initialData,
    hasPrimarySource,
    snapshot.context.entityId,
    snapshot.context.entityType,
    send,
  ]);

  useEffect(() => {
    if (snapshot.matches('saved')) {
      reloadArchive();
      onSaved?.(snapshot.context.baseRevisionId, snapshot.context.baseSnapshot);
    }
  }, [snapshot, reloadArchive, onSaved]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll flag when target entityId changes
  useEffect(() => {
    if (!open) {
      hasScrolledInitialSectionRef.current = false;
    }
  }, [open, entityId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sync drawer state when revision sync completes
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

  const { draft, summary, citationMode, sourceIds, conflict, validationErrors, networkError } =
    snapshot.context;
  const formEntry = getEntityEditFormEntry(entityType);
  const EntityFields = formEntry.Fields;
  const isSaving = snapshot.hasTag('busy');
  const isBusy = isSaving || syncingRevision;
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

  const handleSoftDelete = async (): Promise<void> => {
    if (!dataSource.deleteEntity || !isEditSummaryValid(deleteSummary)) {
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await dataSource.deleteEntity(entityType, entityId, {
        expected_parent_revision_id: asRevisionId(snapshot.context.baseRevisionId),
        summary: deleteSummary.trim(),
      });
      reloadArchive();
      setDeleteConfirmOpen(false);
      onDeleted?.();
      onClose();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  };

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
      className={cx(uiStyles, 'drawer-backdrop wiki-edit-drawer-backdrop')}
      aria-label={`Edit ${title ?? `${entityType} ${entityId}`}`}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(uiStyles, 'lightbox-backdrop-close')}
        aria-label="Close edit drawer"
        onClick={handleCloseAttempt}
      />
      <aside className={cx(uiStyles, 'drawer-panel wiki-edit-drawer-panel')}>
        <div className={cx(uiStyles, 'drawer-top')}>
          <div>
            <h2 className={cx(uiStyles, 'drawer-title')} style={{ marginTop: 0 }}>
              Edit {title ?? `${entityType}/${entityId}`}
            </h2>
            <div className={cx(uiStyles, 'wiki-drawer-subtitle')}>
              Changes are saved to the family history and can always be undone.
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className={cx(uiStyles, 'pill-btn')}
            onClick={handleCloseAttempt}
          >
            Close
          </button>
        </div>

        <form
          className={cx(uiStyles, 'wiki-edit-drawer-form')}
          onSubmit={(e) => {
            e.preventDefault();
            const preparedDraft = formEntry.prepareSubmitDraft?.(draft);
            if (preparedDraft) {
              send({ type: 'EDIT_FIELD', draft: preparedDraft });
            }
            send({ type: 'SUBMIT' });
          }}
        >
          <div className={cx(uiStyles, 'wiki-edit-drawer-body')}>
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
              uiStyles={uiStyles}
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

            <div className={cx(uiStyles, 'wiki-edit-form')}>
              <EntityFields
                draft={draft}
                isBusy={isBusy}
                uiStyles={uiStyles}
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

              <fieldset className={cx(uiStyles, 'wiki-citation-fieldset')}>
                <legend className={cx(uiStyles, 'wiki-field-label')}>Source Verification</legend>
                <div className={cx(uiStyles, 'wiki-citation-options')}>
                  <label className={cx(uiStyles, 'wiki-radio-card')}>
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
                    <span className={cx(uiStyles, 'wiki-radio-desc')}>
                      Backed by a primary record or archive source
                    </span>
                  </label>

                  <label className={cx(uiStyles, 'wiki-radio-card')}>
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
                    <span className={cx(uiStyles, 'wiki-radio-desc')}>
                      Oral recollection or family note (labeled as Family memory until a primary source is
                      cited)
                    </span>
                  </label>
                </div>

                {citationMode === 'cited' && availableSources.length > 0 && (
                  <label className={cx(uiStyles, 'wiki-field')} style={{ marginTop: 8 }}>
                    <span className={cx(uiStyles, 'wiki-field-label')}>Link primary source (optional)</span>
                    <select
                      className={cx(uiStyles, 'wiki-input')}
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

              <label className={cx(uiStyles, 'wiki-field')}>
                <span className={cx(uiStyles, 'wiki-field-label')}>
                  What did you change? <span aria-hidden="true">*</span>
                </span>
                <input
                  type="text"
                  className={cx(uiStyles, 'wiki-input')}
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
                  <span className={cx(uiStyles, 'wiki-field-hint is-error')}>
                    Please write a short note (at least 3 characters).
                  </span>
                )}
              </label>
            </div>

            {dataSource.deleteEntity && (
              <EntityDangerZone
                confirmOpen={deleteConfirmOpen}
                summary={deleteSummary}
                busy={deleteBusy}
                error={deleteError}
                uiStyles={uiStyles}
                onOpenConfirm={() => {
                  setDeleteConfirmOpen(true);
                }}
                onCancelConfirm={() => {
                  setDeleteConfirmOpen(false);
                }}
                onSummaryChange={setDeleteSummary}
                onConfirmDelete={handleSoftDelete}
              />
            )}
          </div>

          <div className={cx(uiStyles, 'wiki-drawer-footer')}>
            {saveDisabledHint && (
              <span className={cx(uiStyles, 'wiki-drawer-footer-hint')}>{saveDisabledHint}</span>
            )}
            <div className={cx(uiStyles, 'wiki-form-actions')}>
              <button
                type="submit"
                className={cx(uiStyles, 'wiki-btn-primary wiki-btn-sm')}
                disabled={isBusy || !snapshot.context.dirty || !summaryValid}
              >
                {isSaving ? 'Saving…' : 'Save Changes'}
              </button>
              {isSaving ? (
                <button
                  type="button"
                  className={cx(uiStyles, 'pill-btn')}
                  onClick={() => {
                    send({ type: 'CANCEL_SAVE' });
                  }}
                >
                  Cancel Save
                </button>
              ) : (
                <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={handleCloseAttempt}>
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
