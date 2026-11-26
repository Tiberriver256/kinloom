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

type PronunciationStringFieldKey =
  | 'phonetic'
  | 'ipa'
  | 'language'
  | 'audio_url'
  | 'note'
  | 'source_label'
  | 'source_url'
  | 'region';
const PRONUNCIATION_STRING_KEYS: readonly PronunciationStringFieldKey[] = [
  'phonetic',
  'ipa',
  'language',
  'audio_url',
  'note',
  'source_label',
  'source_url',
  'region',
];

function readDraftPronunciation(value: unknown): Pronunciation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const out: Pronunciation = {};
  for (const key of PRONUNCIATION_STRING_KEYS) {
    const val = raw[key];
    if (typeof val === 'string' && val.length > 0) {
      out[key] = val;
    }
  }
  if (Array.isArray(raw.variants) && raw.variants.length > 0) {
    out.variants = raw.variants as Pronunciation['variants'];
  }
  if (
    typeof raw.match_full_name_contains === 'string' ||
    Array.isArray(raw.match_full_name_contains)
  ) {
    out.match_full_name_contains =
      raw.match_full_name_contains as Pronunciation['match_full_name_contains'];
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
  let hasAnyNonWhitespace = false;
  for (const key of PRONUNCIATION_STRING_KEYS) {
    const val = raw[key];
    if (typeof val !== 'string') {
      continue;
    }
    const normalized = trimValues ? val.trim() : val;
    if (normalized.length > 0) {
      out[key] = normalized;
      if (normalized.trim().length > 0) {
        hasAnyNonWhitespace = true;
      }
    }
  }
  if (Array.isArray(raw.variants) && raw.variants.length > 0) {
    out.variants = raw.variants as Pronunciation['variants'];
    hasAnyNonWhitespace = true;
  }
  if (
    typeof raw.match_full_name_contains === 'string' ||
    Array.isArray(raw.match_full_name_contains)
  ) {
    out.match_full_name_contains =
      raw.match_full_name_contains as Pronunciation['match_full_name_contains'];
  }
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
  const { dataSource, bundle, baseUrl, reloadArchive, pronunciations, setPronunciations } =
    useArchiveData();
  const [syncingRevision, setSyncingRevision] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSummary, setDeleteSummary] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [audioGenStatus, setAudioGenStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  );
  const [audioGenMessage, setAudioGenMessage] = useState<string | null>(null);
  const [sharedEditorOpen, setSharedEditorOpen] = useState(false);
  const [sharedPhonetic, setSharedPhonetic] = useState('');
  const [sharedIpa, setSharedIpa] = useState('');
  const [sharedLanguage, setSharedLanguage] = useState('');
  const [sharedNote, setSharedNote] = useState('');
  const [sharedSourceLabel, setSharedSourceLabel] = useState('');
  const [sharedSourceUrl, setSharedSourceUrl] = useState('');
  const [sharedRegion, setSharedRegion] = useState('');
  const [sharedSaveStatus, setSharedSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>(
    'idle',
  );
  const [sharedSaveMessage, setSharedSaveMessage] = useState<string | null>(null);

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

  useEffect(() => {
    if (!open) {
      setSharedEditorOpen(false);
      setSharedSaveStatus('idle');
      setSharedSaveMessage(null);
    }
  }, [open, entityId]);

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

  const updatePronunciationField = (key: PronunciationStringFieldKey, value: string): void => {
    const current = readDraftPronunciation(draft.pronunciation) ?? {};
    const next: Record<string, unknown> = { ...current, [key]: value };
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

  const handleSaveSharedSurname = async (
    term: string,
    existingShared?: Pronunciation,
  ): Promise<void> => {
    const trimmedTerm = term.trim();
    if (!trimmedTerm || sharedSaveStatus === 'saving') {
      return;
    }
    setSharedSaveStatus('saving');
    setSharedSaveMessage(null);
    try {
      const response = await fetch(`/api/pronunciations/${encodeURIComponent(trimmedTerm)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phonetic: sharedPhonetic.trim() || undefined,
          ipa: sharedIpa.trim() || undefined,
          language: sharedLanguage.trim() || undefined,
          note: sharedNote.trim() || undefined,
          source_label: sharedSourceLabel.trim() || undefined,
          source_url: sharedSourceUrl.trim() || undefined,
          region: sharedRegion.trim() || undefined,
          ...(existingShared?.variants && existingShared.variants.length > 0
            ? { variants: existingShared.variants }
            : {}),
        }),
      });
      if (!response.ok) {
        let errorMessage = `Failed to save shared pronunciation (HTTP ${response.status}).`;
        try {
          const errBody = (await response.json()) as {
            error?: { message?: string };
            message?: string;
          };
          errorMessage = errBody.error?.message || errBody.message || errorMessage;
        } catch {
          // Non-JSON error response; keep HTTP status fallback.
        }
        setSharedSaveStatus('error');
        setSharedSaveMessage(errorMessage);
        return;
      }
      const data = (await response.json()) as {
        term?: string;
        pronunciation?: Pronunciation | null;
        pronunciations?: Record<string, Pronunciation>;
      };
      if (data.pronunciations && typeof data.pronunciations === 'object') {
        setPronunciations(data.pronunciations);
      }
      setSharedSaveStatus('success');
      setSharedSaveMessage(
        `Saved shared pronunciation for "${trimmedTerm}". Applies to all ${trimmedTerm} records and auto-generates audio.`,
      );
      setSharedEditorOpen(false);
    } catch (err) {
      setSharedSaveStatus('error');
      setSharedSaveMessage(err instanceof Error ? err.message : String(err));
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
              {entityType === 'person' && (() => {
                const givenTokens = asString(draft.given_name).trim().split(/\s+/).filter(Boolean);
                const firstName = givenTokens[0] ?? '';
                const middleNames = givenTokens.slice(1).join(' ');
                const surname = asString(draft.surname).trim();
                const sharedSurname = surname
                  ? (pronunciations[surname] ??
                    Object.entries(pronunciations).find(
                      ([k]) => k.toLowerCase() === surname.toLowerCase(),
                    )?.[1])
                  : undefined;
                const hasSharedSurname = hasPronunciationContent(sharedSurname);
                return (
                  <div className="wiki-pronunciation-breakdown">
                    <div className="wiki-pronunciation-breakdown-parts">
                      {firstName && (
                        <span className="wiki-pronunciation-part">
                          <span className="wiki-pronunciation-part-label">First</span>
                          <strong>{firstName}</strong>
                        </span>
                      )}
                      {middleNames && (
                        <span className="wiki-pronunciation-part">
                          <span className="wiki-pronunciation-part-label">Middle</span>
                          <strong>{middleNames}</strong>
                        </span>
                      )}
                      {surname && (
                        <span className="wiki-pronunciation-part">
                          <span className="wiki-pronunciation-part-label">Surname</span>
                          <strong>{surname}</strong>
                          {(sharedSurname?.phonetic || sharedSurname?.ipa) && (
                            <span className="wiki-pronunciation-part-shared">
                              → {sharedSurname.phonetic ?? sharedSurname.ipa}
                              {sharedSurname.phonetic && sharedSurname.ipa
                                ? ` ${sharedSurname.ipa}`
                                : ''}{' '}
                              (shared)
                            </span>
                          )}
                          {(sharedSurname?.source_label || sharedSurname?.source_url) && (
                            <span className="pronunciation-source">
                              {sharedSurname.source_url &&
                              /^https?:\/\//i.test(sharedSurname.source_url.trim()) ? (
                                <a
                                  href={sharedSurname.source_url.trim()}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="pronunciation-source-link"
                                >
                                  {sharedSurname.source_label || 'Source'}
                                </a>
                              ) : (
                                sharedSurname.source_label
                              )}
                            </span>
                          )}
                          <button
                            type="button"
                            className="wiki-pronunciation-shared-toggle"
                            disabled={isBusy}
                            aria-expanded={sharedEditorOpen}
                            onClick={() => {
                              if (sharedEditorOpen) {
                                setSharedEditorOpen(false);
                              } else {
                                setSharedPhonetic(sharedSurname?.phonetic ?? '');
                                setSharedIpa(sharedSurname?.ipa ?? '');
                                setSharedLanguage(sharedSurname?.language ?? '');
                                setSharedNote(sharedSurname?.note ?? '');
                                setSharedSourceLabel(sharedSurname?.source_label ?? '');
                                setSharedSourceUrl(sharedSurname?.source_url ?? '');
                                setSharedRegion(sharedSurname?.region ?? '');
                                setSharedSaveStatus('idle');
                                setSharedSaveMessage(null);
                                setSharedEditorOpen(true);
                              }
                            }}
                          >
                            {hasSharedSurname
                              ? `Edit shared "${surname}"`
                              : `+ Set shared "${surname}"`}
                          </button>
                        </span>
                      )}
                    </div>

                    {surname && sharedEditorOpen && (
                      <div className="wiki-pronunciation-shared-editor">
                        <div className="wiki-pronunciation-shared-header">
                          <strong>Shared pronunciation for &ldquo;{surname}&rdquo;</strong>
                          <span className="wiki-pronunciation-shared-hint">
                            Applies to every record with this surname and automatically generates audio.
                          </span>
                        </div>
                        <div className="wiki-field-grid">
                          <label className="wiki-field">
                            <span className="wiki-field-label">Phonetic guide</span>
                            <input
                              type="text"
                              className="wiki-input"
                              placeholder="e.g. MER-ser"
                              value={sharedPhonetic}
                              onChange={(e) => {
                                setSharedPhonetic(e.target.value);
                              }}
                              disabled={sharedSaveStatus === 'saving'}
                            />
                          </label>
                          <label className="wiki-field">
                            <span className="wiki-field-label">IPA (optional)</span>
                            <input
                              type="text"
                              className="wiki-input"
                              placeholder="e.g. /ˈmɜːr.sər/"
                              value={sharedIpa}
                              onChange={(e) => {
                                setSharedIpa(e.target.value);
                              }}
                              disabled={sharedSaveStatus === 'saving'}
                            />
                          </label>
                          <label className="wiki-field">
                            <span className="wiki-field-label">Language</span>
                            <input
                              type="text"
                              className="wiki-input"
                              placeholder="e.g. en-US, nl, pl"
                              value={sharedLanguage}
                              onChange={(e) => {
                                setSharedLanguage(e.target.value);
                              }}
                              disabled={sharedSaveStatus === 'saving'}
                            />
                          </label>
                          <label className="wiki-field">
                            <span className="wiki-field-label">Note</span>
                            <input
                              type="text"
                              className="wiki-input"
                              placeholder="e.g. Stress on first syllable"
                              value={sharedNote}
                              onChange={(e) => {
                                setSharedNote(e.target.value);
                              }}
                              disabled={sharedSaveStatus === 'saving'}
                            />
                          </label>
                          <label className="wiki-field">
                            <span className="wiki-field-label">Source label (optional)</span>
                            <input
                              type="text"
                              className="wiki-input"
                              placeholder="e.g. Wiktionary (Dutch IPA) or Family oral tradition"
                              value={sharedSourceLabel}
                              onChange={(e) => {
                                setSharedSourceLabel(e.target.value);
                              }}
                              disabled={sharedSaveStatus === 'saving'}
                            />
                          </label>
                          <label className="wiki-field">
                            <span className="wiki-field-label">Source URL (optional)</span>
                            <input
                              type="url"
                              className="wiki-input"
                              placeholder="e.g. https://en.wiktionary.org/wiki/..."
                              value={sharedSourceUrl}
                              onChange={(e) => {
                                setSharedSourceUrl(e.target.value);
                              }}
                              disabled={sharedSaveStatus === 'saving'}
                            />
                          </label>
                        </div>
                        <div className="wiki-pronunciation-shared-actions">
                          <button
                            type="button"
                            className="wiki-pronunciation-shared-save-btn"
                            disabled={sharedSaveStatus === 'saving'}
                            onClick={() => {
                              void handleSaveSharedSurname(surname, sharedSurname);
                            }}
                          >
                            {sharedSaveStatus === 'saving'
                              ? 'Saving…'
                              : `Save for all ${surname} records`}
                          </button>
                          <button
                            type="button"
                            className="pill-btn"
                            disabled={sharedSaveStatus === 'saving'}
                            onClick={() => {
                              setSharedEditorOpen(false);
                              if (sharedSaveStatus === 'error') {
                                setSharedSaveStatus('idle');
                                setSharedSaveMessage(null);
                              }
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {sharedSaveMessage && (
                      <div
                        className={`wiki-pronunciation-status ${sharedSaveStatus === 'error' ? 'is-error' : 'is-success'}`}
                        role={sharedSaveStatus === 'error' ? 'alert' : 'status'}
                      >
                        {sharedSaveMessage}
                      </div>
                    )}
                  </div>
                );
              })()}
              {entityType === 'person' && (
                <div className="wiki-pronunciation-override-heading">
                  Personal override (first / middle / full name)
                </div>
              )}
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
                <label className="wiki-field">
                  <span className="wiki-field-label">Source label (optional)</span>
                  <input
                    type="text"
                    className="wiki-input"
                    placeholder="e.g. Wiktionary (Dutch IPA)"
                    value={draftPronunciation?.source_label ?? ''}
                    onChange={(e) => {
                      updatePronunciationField('source_label', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
                <label className="wiki-field">
                  <span className="wiki-field-label">Source URL (optional)</span>
                  <input
                    type="url"
                    className="wiki-input"
                    placeholder="e.g. https://en.wiktionary.org/wiki/Leiden"
                    value={draftPronunciation?.source_url ?? ''}
                    onChange={(e) => {
                      updatePronunciationField('source_url', e.target.value);
                    }}
                    disabled={isBusy}
                  />
                </label>
              </div>

              <div className="wiki-pronunciation-actions">
                <button
                  type="button"
                  className="wiki-pronunciation-gen-btn"
                  disabled={isBusy || audioGenStatus === 'loading'}
                  onClick={() => {
                    void handleGeneratePronunciationAudio();
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
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
