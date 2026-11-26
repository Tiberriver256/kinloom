import type {
  EditorCitationMode,
  EntityPayload,
  EntityType,
  Pronunciation,
} from '@kinloom/core';
import { asRevisionId, isEditSummaryValid } from '@kinloom/core';
import React, { useEffect, useState } from 'react';
import { CitationBadge } from './WikiBadges.js';
import { ConflictMergeDialog } from './ConflictMergeDialog.js';
import { PronunciationBadge, hasPronunciationContent } from '../PronunciationBadge.js';
import { entityEditorMachine } from '../../machines/entityEditorMachine.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useMachine } from '@xstate/react';

export interface EntityEditDrawerProps {
  open: boolean;
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

function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

type PronunciationFieldKey = keyof Pronunciation;
const PRONUNCIATION_KEYS: readonly PronunciationFieldKey[] = [
  'phonetic',
  'ipa',
  'language',
  'audio_url',
  'note',
];

function readDraftPronunciation(value: unknown): Pronunciation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const out: Pronunciation = {};
  for (const key of PRONUNCIATION_KEYS) {
    const val = raw[key];
    if (typeof val === 'string' && val.length > 0) {
      out[key] = val;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function cleanPronunciation(
  value: unknown,
  trimValues: boolean,
): Pronunciation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const out: Pronunciation = {};
  for (const key of PRONUNCIATION_KEYS) {
    const val = raw[key];
    if (typeof val !== 'string') {
      continue;
    }
    const normalized = trimValues ? val.trim() : val;
    if (normalized.length > 0) {
      out[key] = normalized;
    }
  }
  const hasAnyNonWhitespace = Object.values(out).some((v) => Boolean(v && v.trim().length > 0));
  return hasAnyNonWhitespace ? out : null;
}

export const EntityEditDrawer: React.FC<EntityEditDrawerProps> = ({
  open,
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
  const { dataSource, bundle, baseUrl, reloadArchive } = useArchiveData();
  const [syncingRevision, setSyncingRevision] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSummary, setDeleteSummary] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [audioGenStatus, setAudioGenStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  );
  const [audioGenMessage, setAudioGenMessage] = useState<string | null>(null);

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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- synchronize live entity revision once each time the drawer opens
  }, [open, entityType, entityId, dataSource]);

  useEffect(() => {
    if (
      snapshot.context.entityId !== entityId ||
      snapshot.context.entityType !== entityType
    ) {
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
  } = snapshot.context;
  const isBusy = snapshot.hasTag('busy') || syncingRevision;
  const isConflict = snapshot.matches('conflict409');
  const isSaved = snapshot.matches('saved');
  const isConfirmingLeave = snapshot.matches('confirmingLeave');
  const isNetworkError = snapshot.matches('networkErrorRetryable');
  const summaryValid = isEditSummaryValid(summary);

  const updateField = (key: string, value: unknown): void => {
    send({
      type: 'EDIT_FIELD',
      draft: {
        ...draft,
        [key]: value,
      },
    });
  };

  const draftPronunciation = readDraftPronunciation(draft?.pronunciation);
  const canEditPronunciation =
    entityType === 'place' ||
    (entityType === 'person' && !draft?.is_living && asString(draft?.full_name) !== 'Living');
  const pronunciationPreviewLabel =
    entityType === 'person'
      ? asString(draft.full_name) || title || entityId
      : asString(draft.name) || asString(draft.full_name) || title || entityId;

  const updatePronunciationField = (key: PronunciationFieldKey, value: string): void => {
    const current = readDraftPronunciation(draft.pronunciation) ?? {};
    const next: Record<string, string | undefined> = { ...current, [key]: value };
    if (value === '') {
      delete next[key];
    }
    const cleaned = cleanPronunciation(next, false);
    updateField('pronunciation', cleaned);
  };

  const handleGeneratePronunciationAudio = async (): Promise<void> => {
    if (!canEditPronunciation || audioGenStatus === 'loading') {
      return;
    }
    const text =
      entityType === 'person'
        ? asString(draft.full_name).trim()
        : (asString(draft.name).trim() || asString(draft.full_name).trim());
    if (!text) {
      setAudioGenStatus('error');
      setAudioGenMessage('Enter a name before generating pronunciation audio.');
      return;
    }
    setAudioGenStatus('loading');
    setAudioGenMessage(null);
    try {
      const response = await fetch('/api/pronunciation/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId,
          text,
          phonetic: draftPronunciation?.phonetic?.trim() || undefined,
          ipa: draftPronunciation?.ipa?.trim() || undefined,
          language: draftPronunciation?.language?.trim() || undefined,
        }),
      });
      if (!response.ok) {
        let errorMessage = `Audio generation failed (HTTP ${response.status}).`;
        try {
          const errBody = (await response.json()) as {
            error?: { message?: string };
            message?: string;
          };
          errorMessage = errBody.error?.message || errBody.message || errorMessage;
        } catch {
          // Non-JSON error response; keep HTTP status fallback.
        }
        setAudioGenStatus('error');
        setAudioGenMessage(errorMessage);
        return;
      }
      const data = (await response.json()) as { audio_url?: string };
      if (!data.audio_url || typeof data.audio_url !== 'string') {
        setAudioGenStatus('error');
        setAudioGenMessage('Server response did not include an audio_url.');
        return;
      }
      updatePronunciationField('audio_url', data.audio_url);
      setAudioGenStatus('success');
      setAudioGenMessage('Pronunciation audio generated. Save changes to publish.');
    } catch (err) {
      setAudioGenStatus('error');
      setAudioGenMessage(err instanceof Error ? err.message : String(err));
    }
  };

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
      open
      className="drawer-backdrop wiki-edit-drawer-backdrop"
      aria-label={`Edit ${title ?? `${entityType} ${entityId}`}`}
    >
      <button
        type="button"
        className="lightbox-backdrop-close"
        aria-label="Close edit drawer"
        onClick={handleCloseAttempt}
      />
      <aside className="drawer-panel wiki-edit-drawer-panel">
        <div className="drawer-top">
          <div>
            <h2 className="drawer-title" style={{ marginTop: 0 }}>
              Edit {title ?? `${entityType}/${entityId}`}
            </h2>
            <div className="wiki-drawer-subtitle">
              Changes are saved to the family history and can always be undone.
            </div>
          </div>
          <button type="button" className="pill-btn" onClick={handleCloseAttempt}>
            Close
          </button>
        </div>

        {isConfirmingLeave && (
          <div className="wiki-status-banner is-warning" role="alert">
            <div>
              <strong>Unsaved changes.</strong> Leaving will discard your local edits.
            </div>
            <div className="wiki-inline-actions">
              <button
                type="button"
                className="pill-btn active"
                onClick={() => {
                  send({ type: 'STAY_EDITING' });
                }}
              >
                Keep Editing
              </button>
              <button
                type="button"
                className="pill-btn"
                onClick={() => {
                  send({ type: 'CONFIRM_LEAVE' });
                  onClose();
                }}
              >
                Discard &amp; Close
              </button>
            </div>
          </div>
        )}

        {isSaved && (
          <output className="wiki-status-banner is-success" aria-live="polite">
            <div>
              Saved revision <code>r{snapshot.context.baseRevisionId}</code>.
            </div>
            <div className="wiki-inline-actions">
              <button
                type="button"
                className="pill-btn"
                onClick={() => {
                  send({ type: 'START_EDIT' });
                }}
              >
                Edit Again
              </button>
              <button
                type="button"
                className="pill-btn active"
                onClick={() => {
                  send({ type: 'DISMISS_SAVED' });
                  onClose();
                }}
              >
                Done
              </button>
            </div>
          </output>
        )}

        {isConflict && conflict && (
          <ConflictMergeDialog
            conflict={conflict}
            localDraft={draft}
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
          />
        )}

        {isNetworkError && networkError && (
          <div className="wiki-status-banner is-error" role="alert">
            <div>
              <strong>Save failed:</strong> {networkError}
            </div>
            <div className="wiki-inline-actions">
              <button
                type="button"
                className="pill-btn active"
                onClick={() => {
                  send({ type: 'RETRY_SAVE' });
                }}
              >
                Retry Save
              </button>
              <button
                type="button"
                className="pill-btn"
                onClick={() => {
                  send({ type: 'RETURN_TO_EDIT' });
                }}
              >
                Back to Editor
              </button>
            </div>
          </div>
        )}

        {validationErrors.length > 0 && (
          <div className="wiki-status-banner is-error" role="alert">
            <strong>Fix before saving:</strong>
            <ul className="wiki-error-list">
              {validationErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <form
          className="wiki-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (entityType === 'person' || entityType === 'place') {
              const cleanedPronunciation =
                entityType === 'person' && Boolean(draft.is_living)
                  ? null
                  : cleanPronunciation(draft.pronunciation, true);
              if (JSON.stringify(cleanedPronunciation) !== JSON.stringify(draft.pronunciation ?? null)) {
                send({
                  type: 'EDIT_FIELD',
                  draft: {
                    ...draft,
                    pronunciation: cleanedPronunciation,
                  },
                });
              }
            }
            send({ type: 'SUBMIT' });
          }}
        >
          {entityType === 'person' && (
            <>
              <div className="wiki-field-grid">
                <label className="wiki-field">
                  <span className="wiki-field-label">Full name</span>
                  <input
                    type="text"
                    className="wiki-input"
                    value={asString(draft.full_name)}
                    onChange={(e) => {
                      updateField('full_name', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="wiki-field">
                  <span className="wiki-field-label">Given name</span>
                  <input
                    type="text"
                    className="wiki-input"
                    value={asString(draft.given_name)}
                    onChange={(e) => {
                      updateField('given_name', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="wiki-field">
                  <span className="wiki-field-label">Surname</span>
                  <input
                    type="text"
                    className="wiki-input"
                    value={asString(draft.surname)}
                    onChange={(e) => {
                      updateField('surname', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="wiki-field">
                  <span className="wiki-field-label">Birth date</span>
                  <input
                    type="text"
                    className="wiki-input"
                    placeholder="e.g. 1850-04-12 or 1850"
                    value={asString(draft.birth_edtf)}
                    onChange={(e) => {
                      updateField('birth_edtf', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="wiki-field">
                  <span className="wiki-field-label">Death date</span>
                  <input
                    type="text"
                    className="wiki-input"
                    placeholder="Leave blank if living or unknown"
                    value={asString(draft.death_edtf)}
                    onChange={(e) => {
                      updateField('death_edtf', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="wiki-field">
                  <span className="wiki-field-label">Nicknames or maiden names</span>
                  <input
                    type="text"
                    className="wiki-input"
                    placeholder="Separate multiple names with commas"
                    value={asStringArray(draft.alt_names).join(', ')}
                    onChange={(e) => {
                      const list = e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                      updateField('alt_names', list);
                    }}
                    disabled={isBusy}
                  />
                </label>
              </div>
              <label className="wiki-checkbox-row">
                <input
                  type="checkbox"
                  checked={Boolean(draft.is_living)}
                  onChange={(e) => {
                    updateField('is_living', e.target.checked);
                  }}
                  disabled={isBusy}
                />
                <span>
                  Living relative (strictly hides portraits, street addresses, and exact birth dates)
                </span>
              </label>
            </>
          )}

          {entityType === 'place' && (
            <div className="wiki-field-grid">
              <label className="wiki-field">
                <span className="wiki-field-label">Short name</span>
                <input
                  type="text"
                  className="wiki-input"
                  value={asString(draft.name)}
                  onChange={(e) => {
                    updateField('name', e.target.value);
                  }}
                  disabled={isBusy}
                />
              </label>
              <label className="wiki-field">
                <span className="wiki-field-label">Full hierarchical name</span>
                <input
                  type="text"
                  className="wiki-input"
                  value={asString(draft.full_name)}
                  onChange={(e) => {
                    updateField('full_name', e.target.value);
                  }}
                  disabled={isBusy}
                />
              </label>
              <label className="wiki-field">
                <span className="wiki-field-label">Latitude</span>
                <input
                  type="number"
                  step="any"
                  className="wiki-input"
                  value={typeof draft.lat === 'number' ? draft.lat : 0}
                  onChange={(e) => {
                    updateField('lat', Number(e.target.value));
                  }}
                  disabled={isBusy}
                />
              </label>
              <label className="wiki-field">
                <span className="wiki-field-label">Longitude</span>
                <input
                  type="number"
                  step="any"
                  className="wiki-input"
                  value={typeof draft.lng === 'number' ? draft.lng : 0}
                  onChange={(e) => {
                    updateField('lng', Number(e.target.value));
                  }}
                  disabled={isBusy}
                />
              </label>
              <label className="wiki-field wiki-field-full">
                <span className="wiki-field-label">Historical profile</span>
                <textarea
                  className="wiki-textarea"
                  rows={5}
                  value={asString(draft.summary)}
                  onChange={(e) => {
                    updateField('summary', e.target.value);
                  }}
                  disabled={isBusy}
                />
              </label>
            </div>
          )}

          {canEditPronunciation && (
            <fieldset className="wiki-citation-fieldset wiki-pronunciation-fieldset">
              <legend className="wiki-field-label">Pronunciation</legend>
              <div className="wiki-field-grid">
                <label className="wiki-field">
                  <span className="wiki-field-label">Phonetic guide</span>
                  <input
                    type="text"
                    className="wiki-input"
                    placeholder="e.g. MER-ser or LAY-den"
                    value={draftPronunciation?.phonetic ?? ''}
                    onChange={(e) => {
                      updatePronunciationField('phonetic', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="wiki-field">
                  <span className="wiki-field-label">IPA (optional)</span>
                  <input
                    type="text"
                    className="wiki-input"
                    placeholder="e.g. /ˈmɜːr.sər/"
                    value={draftPronunciation?.ipa ?? ''}
                    onChange={(e) => {
                      updatePronunciationField('ipa', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="wiki-field">
                  <span className="wiki-field-label">Language / origin</span>
                  <input
                    type="text"
                    className="wiki-input"
                    placeholder="e.g. nl, pl, en-US"
                    value={draftPronunciation?.language ?? ''}
                    onChange={(e) => {
                      updatePronunciationField('language', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="wiki-field">
                  <span className="wiki-field-label">Pronunciation note (optional)</span>
                  <input
                    type="text"
                    className="wiki-input"
                    placeholder="e.g. Stress on first syllable"
                    value={draftPronunciation?.note ?? ''}
                    onChange={(e) => {
                      updatePronunciationField('note', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
              </div>

              <div className="wiki-pronunciation-actions">
                <button
                  type="button"
                  className="pill-btn"
                  disabled={isBusy || audioGenStatus === 'loading'}
                  onClick={() => {
                    void handleGeneratePronunciationAudio();
                  }}
                >
                  {audioGenStatus === 'loading'
                    ? 'Generating…'
                    : draftPronunciation?.audio_url
                      ? 'Regenerate Audio'
                      : 'Generate Audio'}
                </button>
                {hasPronunciationContent(draftPronunciation) && (
                  <div className="wiki-pronunciation-preview">
                    <PronunciationBadge
                      pronunciation={draftPronunciation}
                      label={pronunciationPreviewLabel}
                      baseUrl={baseUrl}
                    />
                  </div>
                )}
              </div>

              {audioGenMessage && (
                <div
                  className={`wiki-pronunciation-status ${audioGenStatus === 'error' ? 'is-error' : 'is-success'}`}
                  role={audioGenStatus === 'error' ? 'alert' : 'status'}
                >
                  {audioGenMessage}
                </div>
              )}
            </fieldset>
          )}

          {entityType === 'event' && (
            <div className="wiki-field-grid">
              <label className="wiki-field wiki-field-full">
                <span className="wiki-field-label">Event title</span>
                <input
                  type="text"
                  className="wiki-input"
                  value={asString(draft.title)}
                  onChange={(e) => {
                    updateField('title', e.target.value);
                  }}
                  disabled={isBusy}
                />
              </label>
              <label className="wiki-field">
                <span className="wiki-field-label">Date</span>
                <input
                  type="text"
                  className="wiki-input"
                  value={asString(draft.edtf_date)}
                  onChange={(e) => {
                    updateField('edtf_date', e.target.value);
                  }}
                  disabled={isBusy}
                />
              </label>
              <label className="wiki-field wiki-field-full">
                <span className="wiki-field-label">Narrative summary</span>
                <textarea
                  className="wiki-textarea"
                  rows={5}
                  value={asString(draft.summary)}
                  onChange={(e) => {
                    updateField('summary', e.target.value);
                  }}
                  disabled={isBusy}
                />
              </label>
            </div>
          )}

          {entityType === 'narrative' && (
            <div className="wiki-field-grid">
              <label className="wiki-field wiki-field-full">
                <span className="wiki-field-label">Narrative title</span>
                <input
                  type="text"
                  className="wiki-input"
                  value={asString(draft.title)}
                  onChange={(e) => {
                    updateField('title', e.target.value);
                  }}
                  disabled={isBusy}
                />
              </label>
              <label className="wiki-field wiki-field-full">
                <span className="wiki-field-label">Story text</span>
                <textarea
                  className="wiki-textarea"
                  rows={8}
                  value={asString(draft.body_md)}
                  onChange={(e) => {
                    updateField('body_md', e.target.value);
                  }}
                  disabled={isBusy}
                />
              </label>
            </div>
          )}

          {entityType !== 'person' &&
            entityType !== 'place' &&
            entityType !== 'event' &&
            entityType !== 'narrative' && (
              <label className="wiki-field wiki-field-full">
                <span className="wiki-field-label">Record details</span>
                <textarea
                  className="wiki-textarea wiki-mono"
                  rows={8}
                  value={JSON.stringify(draft, null, 2)}
                  onChange={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value) as EntityPayload;
                      send({ type: 'EDIT_FIELD', draft: parsed });
                    } catch {
                      // Ignore incomplete JSON while typing.
                    }
                  }}
                  disabled={isBusy}
                />
              </label>
            )}

          {/* Citation picker */}
          <fieldset className="wiki-citation-fieldset">
            <legend className="wiki-field-label">Source Verification</legend>
            <div className="wiki-citation-options">
              <label className="wiki-radio-card">
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
                <span className="wiki-radio-desc">Backed by a primary record or archive source</span>
              </label>

              <label className="wiki-radio-card">
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
                <span className="wiki-radio-desc">
                  Oral recollection or family note (labeled as uncited until verified)
                </span>
              </label>
            </div>

            {citationMode === 'cited' && availableSources.length > 0 && (
              <label className="wiki-field" style={{ marginTop: 8 }}>
                <span className="wiki-field-label">Link primary source (optional)</span>
                <select
                  className="wiki-input"
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

          {/* Required edit summary */}
          <label className="wiki-field">
            <span className="wiki-field-label">
              What did you change? <span aria-hidden="true">*</span>
            </span>
            <input
              type="text"
              className="wiki-input"
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
              <span className="wiki-field-hint is-error">
                Please write a short note (at least 3 characters).
              </span>
            )}
          </label>

          <div className="wiki-form-actions">
            <button
              type="submit"
              className="wiki-btn-primary wiki-btn-sm"
              disabled={isBusy || !snapshot.context.dirty || !summaryValid}
            >
              {isBusy ? 'Saving…' : 'Save Changes'}
            </button>
            {isBusy ? (
              <button
                type="button"
                className="pill-btn"
                onClick={() => {
                  send({ type: 'CANCEL_SAVE' });
                }}
              >
                Cancel Save
              </button>
            ) : (
              <button type="button" className="pill-btn" onClick={handleCloseAttempt}>
                Cancel
              </button>
            )}
          </div>
        </form>

        {dataSource.deleteEntity && (
          <div className="wiki-danger-zone">
            {!deleteConfirmOpen ? (
              <button
                type="button"
                className="pill-btn wiki-danger-btn"
                onClick={() => {
                  setDeleteConfirmOpen(true);
                }}
              >
                Remove from Archive
              </button>
            ) : (
              <div className="wiki-danger-confirm">
                <p>
                  Removing hides this page from the archive while keeping its full history so it
                  can be restored anytime.
                </p>
                {deleteError && (
                  <div className="wiki-status-banner is-error" role="alert">
                    <p>{deleteError}</p>
                  </div>
                )}
                <input
                  type="text"
                  className="wiki-input"
                  placeholder="Why are you removing this? (at least 3 characters)"
                  value={deleteSummary}
                  onChange={(e) => {
                    setDeleteSummary(e.target.value);
                  }}
                  disabled={deleteBusy}
                />
                <div className="wiki-inline-actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="pill-btn wiki-danger-btn"
                    disabled={deleteBusy || !isEditSummaryValid(deleteSummary)}
                    onClick={() => {
                      void handleSoftDelete();
                    }}
                  >
                    {deleteBusy ? 'Removing…' : 'Confirm Removal'}
                  </button>
                  <button
                    type="button"
                    className="pill-btn"
                    onClick={() => {
                      setDeleteConfirmOpen(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </aside>
    </dialog>
  );
};
