import type { EntityType, InspectedPersonPronunciationToken, Pronunciation } from '@kinloom/core';
import { inspectPersonPronunciationTokens } from '@kinloom/core';
import type React from 'react';
import { useEffect, useId, useState } from 'react';
import { cx } from '../../lib/cx.js';
import { hasPronunciationContent } from '../PronunciationBadge.js';
import cssMod0 from '../PronunciationBadge.module.css';
import localStyles from './PronunciationEditorSection.module.css';
import { PersonalPronunciationOverrideForm } from './pronunciation/PersonalPronunciationOverrideForm.js';
import type { PronunciationStringFieldKey, SharedTokenDraft } from './pronunciation/pronunciationDraft.js';
import {
  cleanPronunciation,
  generatePronunciationAudio,
  PRONUNCIATION_STRING_KEYS,
  readDraftPronunciation,
  saveSharedTokenPronunciation,
} from './pronunciation/pronunciationDraft.js';
import { SharedTokenPronunciationEditor } from './pronunciation/SharedTokenPronunciationEditor.js';
import cssMod2 from './WikiForms.module.css';

export type { PronunciationStringFieldKey };
export { cleanPronunciation, PRONUNCIATION_STRING_KEYS, readDraftPronunciation };

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod2 };

export interface PronunciationEditorSectionProps {
  entityType: Extract<EntityType, 'person' | 'place'>;
  entityId: string;
  fullName: string;
  givenName: string;
  surname: string;
  placeName: string;
  previewLabel: string;
  draftPronunciation: Pronunciation | null;
  pronunciations: Readonly<Record<string, Pronunciation>>;
  baseUrl?: string;
  isBusy: boolean;
  fieldsetRef?: React.RefObject<HTMLFieldSetElement | null>;
  primaryFocusRef?: React.RefObject<HTMLElement | null>;
  onUpdatePronunciation: (next: Pronunciation | null) => void;
  onSetPronunciations: (next: Record<string, Pronunciation>) => void;
}

export const PronunciationEditorSection: React.FC<PronunciationEditorSectionProps> = ({
  entityType,
  entityId,
  fullName,
  givenName,
  surname,
  placeName,
  previewLabel,
  draftPronunciation,
  pronunciations,
  baseUrl,
  isBusy,
  fieldsetRef,
  primaryFocusRef,
  onUpdatePronunciation,
  onSetPronunciations,
}) => {
  const idPrefix = useId();
  const [activeTokenDraft, setActiveTokenDraft] = useState<SharedTokenDraft | null>(null);
  const [sharedSaveStatus, setSharedSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [sharedSaveMessage, setSharedSaveMessage] = useState<string | null>(null);
  const [overrideClearedNotice, setOverrideClearedNotice] = useState<string | null>(null);
  const [audioGenStatus, setAudioGenStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [audioGenMessage, setAudioGenMessage] = useState<string | null>(null);
  const [userExpandedOverride, setUserExpandedOverride] = useState<boolean>(false);

  const inspection =
    entityType === 'person'
      ? inspectPersonPronunciationTokens(
          {
            full_name: fullName,
            given_name: givenName,
            surname,
            is_living: false,
          },
          pronunciations
        )
      : null;

  const hasPersonalOverride = hasPronunciationContent(draftPronunciation);
  const allTokensResolved = Boolean(inspection?.allTokensResolved);
  const hasAnySharedToken = Boolean(inspection?.hasAnySharedToken);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset local sub-editor state only when switching entities
  useEffect(() => {
    setActiveTokenDraft(null);
    setSharedSaveStatus('idle');
    setSharedSaveMessage(null);
    setOverrideClearedNotice(null);
    setAudioGenStatus('idle');
    setAudioGenMessage(null);
    setUserExpandedOverride(false);
  }, [entityId, entityType]);

  const showPersonalOverrideFields =
    entityType !== 'person' || hasPersonalOverride || !allTokensResolved || userExpandedOverride;

  const updatePronunciationField = (key: PronunciationStringFieldKey, value: string): void => {
    setOverrideClearedNotice(null);
    const current = draftPronunciation ?? {};
    const next: Record<string, unknown> = { ...current, [key]: value };
    if (value === '') {
      delete next[key];
    }
    onUpdatePronunciation(cleanPronunciation(next, false));
  };

  const openOrToggleTokenEditor = (token: InspectedPersonPronunciationToken): void => {
    const targetTerm = (token.lexiconKey ?? token.text).trim();
    if (!targetTerm) {
      return;
    }
    if (activeTokenDraft && activeTokenDraft.term.toLowerCase() === targetTerm.toLowerCase()) {
      setActiveTokenDraft(null);
      return;
    }
    const existing = token.entry;
    setActiveTokenDraft({
      term: targetTerm,
      displayText: token.text,
      existingShared: existing,
      phonetic: existing?.phonetic ?? '',
      ipa: existing?.ipa ?? '',
      language: existing?.language ?? '',
      note: existing?.note ?? '',
      source_label: existing?.source_label ?? '',
      source_url: existing?.source_url ?? '',
      region: existing?.region ?? '',
    });
    setSharedSaveStatus('idle');
    setSharedSaveMessage(null);
  };

  const handleSaveSharedToken = async (): Promise<void> => {
    if (!activeTokenDraft || sharedSaveStatus === 'saving' || !activeTokenDraft.term.trim()) {
      return;
    }
    setSharedSaveStatus('saving');
    setSharedSaveMessage(null);
    try {
      const result = await saveSharedTokenPronunciation(activeTokenDraft);
      if (!result.ok) {
        setSharedSaveStatus('error');
        setSharedSaveMessage(result.message);
        return;
      }
      if (result.pronunciations) {
        onSetPronunciations(result.pronunciations);
      }
      setSharedSaveStatus('success');
      setSharedSaveMessage(result.message);
      setActiveTokenDraft(null);
    } catch (err) {
      setSharedSaveStatus('error');
      setSharedSaveMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleClearPersonalOverride = (): void => {
    onUpdatePronunciation(null);
    setUserExpandedOverride(false);
    setOverrideClearedNotice('Personal override cleared. Save changes to inherit from shared names.');
  };

  const handleGeneratePronunciationAudio = async (): Promise<void> => {
    if (audioGenStatus === 'loading') {
      return;
    }
    const text = entityType === 'person' ? fullName.trim() : placeName.trim() || fullName.trim();
    if (!text) {
      setAudioGenStatus('error');
      setAudioGenMessage('Enter a name before generating pronunciation audio.');
      return;
    }
    setAudioGenStatus('loading');
    setAudioGenMessage(null);
    try {
      const result = await generatePronunciationAudio({
        entityType,
        entityId,
        text,
        draftPronunciation,
      });
      if (!result.ok) {
        setAudioGenStatus('error');
        setAudioGenMessage(result.message);
        return;
      }
      updatePronunciationField('audio_url', result.audioUrl);
      setAudioGenStatus('success');
      setAudioGenMessage(result.message);
    } catch (err) {
      setAudioGenStatus('error');
      setAudioGenMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const overridePanelId = `${idPrefix}-override-panel`;
  const hasEditablePersonTokens = Boolean(inspection?.tokens.some((tok) => tok.kind === 'token'));

  return (
    <fieldset
      ref={fieldsetRef}
      className={`${cx(uiStyles, 'wiki-citation-fieldset wiki-pronunciation-fieldset')} ${localStyles['pronunciation-fieldset']}`}
    >
      <legend className={cx(uiStyles, 'wiki-field-label')}>Pronunciation</legend>

      {entityType === 'person' && inspection && inspection.tokens.length > 0 && (
        <SharedTokenPronunciationEditor
          idPrefix={idPrefix}
          tokens={inspection.tokens}
          composed={inspection.composed}
          previewLabel={previewLabel}
          baseUrl={baseUrl}
          isBusy={isBusy}
          primaryFocusRef={primaryFocusRef}
          activeTokenDraft={activeTokenDraft}
          sharedSaveStatus={sharedSaveStatus}
          sharedSaveMessage={sharedSaveMessage}
          uiStyles={uiStyles}
          onToggleToken={openOrToggleTokenEditor}
          onUpdateDraft={setActiveTokenDraft}
          onSaveSharedToken={handleSaveSharedToken}
          onCancelSharedToken={() => {
            setActiveTokenDraft(null);
            if (sharedSaveStatus === 'error') {
              setSharedSaveStatus('idle');
              setSharedSaveMessage(null);
            }
          }}
        />
      )}

      {entityType === 'person' && (
        <div className={localStyles['override-header-row']}>
          <div className={cx(uiStyles, 'wiki-pronunciation-override-heading')}>
            Personal override (optional)
          </div>

          {hasPersonalOverride && hasAnySharedToken && (
            <button
              type="button"
              className={localStyles['clear-override-btn']}
              disabled={isBusy}
              onClick={handleClearPersonalOverride}
            >
              Use shared names (clear personal override)
            </button>
          )}

          {!hasPersonalOverride && allTokensResolved && (
            <button
              type="button"
              className={localStyles['override-toggle-btn']}
              disabled={isBusy}
              aria-expanded={userExpandedOverride}
              aria-controls={overridePanelId}
              onClick={() => {
                setUserExpandedOverride((prev) => !prev);
              }}
            >
              {userExpandedOverride ? 'Hide personal override' : 'Customize for this person only'}
            </button>
          )}
        </div>
      )}

      {overrideClearedNotice && (
        <div className={`${localStyles['status-note']} ${localStyles['is-success']}`} role="status">
          {overrideClearedNotice}
        </div>
      )}

      {showPersonalOverrideFields && (
        <PersonalPronunciationOverrideForm
          idPrefix={idPrefix}
          overridePanelId={overridePanelId}
          draftPronunciation={draftPronunciation}
          previewLabel={previewLabel}
          baseUrl={baseUrl}
          isBusy={isBusy}
          hasEditablePersonTokens={hasEditablePersonTokens}
          primaryFocusRef={primaryFocusRef}
          audioGenStatus={audioGenStatus}
          audioGenMessage={audioGenMessage}
          uiStyles={uiStyles}
          onUpdateField={updatePronunciationField}
          onGenerateAudio={handleGeneratePronunciationAudio}
        />
      )}
    </fieldset>
  );
};
