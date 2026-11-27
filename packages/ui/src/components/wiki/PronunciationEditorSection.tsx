import type {
  EntityType,
  InspectedPersonPronunciationToken,
  PersonPronunciationTokenRole,
  Pronunciation,
} from '@kinloom/core';
import { findIpaGlyphsInPhonetic, inspectPersonPronunciationTokens } from '@kinloom/core';
import type React from 'react';
import { useEffect, useId, useState } from 'react';
import { cx } from '../../lib/cx.js';
import { hasPronunciationContent, PronunciationBadge } from '../PronunciationBadge.js';
import cssMod0 from '../PronunciationBadge.module.css';
import localStyles from './PronunciationEditorSection.module.css';
import cssMod2 from './WikiSurfaces.module.css';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod2 };

export type PronunciationStringFieldKey =
  | 'phonetic'
  | 'ipa'
  | 'language'
  | 'audio_url'
  | 'note'
  | 'source_label'
  | 'source_url'
  | 'region';

export const PRONUNCIATION_STRING_KEYS: readonly PronunciationStringFieldKey[] = [
  'phonetic',
  'ipa',
  'language',
  'audio_url',
  'note',
  'source_label',
  'source_url',
  'region',
];

export function readDraftPronunciation(value: unknown): Pronunciation | null {
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
  if (typeof raw.match_full_name_contains === 'string' || Array.isArray(raw.match_full_name_contains)) {
    out.match_full_name_contains = raw.match_full_name_contains as Pronunciation['match_full_name_contains'];
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function cleanPronunciation(value: unknown, trimValues: boolean): Pronunciation | null {
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
  if (typeof raw.match_full_name_contains === 'string' || Array.isArray(raw.match_full_name_contains)) {
    out.match_full_name_contains = raw.match_full_name_contains as Pronunciation['match_full_name_contains'];
  }
  return hasAnyNonWhitespace ? out : null;
}

const ROLE_LABELS: Readonly<Record<PersonPronunciationTokenRole, string>> = {
  given: 'First',
  middle: 'Middle',
  surname: 'Surname',
  suffix: 'Suffix',
};

const SAFE_EXTERNAL_URL_RE = /^https?:\/\//i;

interface SharedTokenDraft {
  readonly term: string;
  readonly displayText: string;
  readonly existingShared?: Pronunciation | null;
  phonetic: string;
  ipa: string;
  language: string;
  note: string;
  source_label: string;
  source_url: string;
  region: string;
}

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
  const [userExpandedOverride, setUserExpandedOverride] = useState<boolean>(false);

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
    if (!activeTokenDraft || sharedSaveStatus === 'saving') {
      return;
    }
    const trimmedTerm = activeTokenDraft.term.trim();
    if (!trimmedTerm) {
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
          phonetic: activeTokenDraft.phonetic.trim() || undefined,
          ipa: activeTokenDraft.ipa.trim() || undefined,
          language: activeTokenDraft.language.trim() || undefined,
          note: activeTokenDraft.note.trim() || undefined,
          source_label: activeTokenDraft.source_label.trim() || undefined,
          source_url: activeTokenDraft.source_url.trim() || undefined,
          region: activeTokenDraft.region.trim() || undefined,
          ...(activeTokenDraft.existingShared?.variants && activeTokenDraft.existingShared.variants.length > 0
            ? { variants: activeTokenDraft.existingShared.variants }
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
          // Keep HTTP status fallback for non-JSON error responses.
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
        onSetPronunciations(data.pronunciations);
      }
      setSharedSaveStatus('success');
      setSharedSaveMessage(
        `Saved shared pronunciation for "${trimmedTerm}". Updates every record sharing this name and generates audio.`
      );
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
          // Keep HTTP status fallback for non-JSON error responses.
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

  const sharedPhoneticIpaGlyphs = activeTokenDraft ? findIpaGlyphsInPhonetic(activeTokenDraft.phonetic) : [];
  const personalPhoneticIpaGlyphs = findIpaGlyphsInPhonetic(draftPronunciation?.phonetic);
  const sharedEditorId = `${idPrefix}-shared-editor`;
  const sharedPhoneticHintId = `${idPrefix}-shared-phonetic-hint`;
  const personalPhoneticHintId = `${idPrefix}-personal-phonetic-hint`;
  const overridePanelId = `${idPrefix}-override-panel`;

  const hasEditablePersonTokens = Boolean(inspection?.tokens.some((tok) => tok.kind === 'token'));
  let firstEditableTokenAssigned = false;

  return (
    <fieldset
      ref={fieldsetRef}
      className={`${cx(uiStyles, 'wiki-citation-fieldset wiki-pronunciation-fieldset')} ${localStyles['pronunciation-fieldset']}`}
    >
      <legend className={cx(uiStyles, 'wiki-field-label')}>Pronunciation</legend>

      {entityType === 'person' && inspection && inspection.tokens.length > 0 && (
        <div className={`${cx(uiStyles, 'wiki-pronunciation-breakdown')} ${localStyles['token-section']}`}>
          <p className={localStyles['pronunciation-intro']}>
            Tap any name token to edit its shared Respelling and IPA across all matching records.
          </p>

          <div
            className={`${cx(uiStyles, 'wiki-pronunciation-breakdown-parts')} ${localStyles['token-chip-list']}`}
            data-testid="pronunciation-token-chips"
          >
            {inspection.tokens.map((token, idx) => {
              const roleLabel = ROLE_LABELS[token.role];
              if (token.kind !== 'token') {
                return (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: identical middle initials may repeat in one name
                    key={`${token.kind}-${token.text}-${idx}`}
                    className={localStyles['token-chip-static']}
                  >
                    <span className={localStyles['token-role']}>{roleLabel}</span>
                    <strong className={localStyles['token-name']}>{token.text}</strong>
                  </span>
                );
              }

              const termKey = (token.lexiconKey ?? token.text).trim();
              const isSelected = Boolean(
                activeTokenDraft && activeTokenDraft.term.toLowerCase() === termKey.toLowerCase()
              );
              const hasShared = hasPronunciationContent(token.entry);
              const sharedGuideText = token.entry?.phonetic || token.entry?.ipa || '';
              const sharedSecondaryIpa =
                token.entry?.phonetic && token.entry?.ipa ? ` ${token.entry.ipa}` : '';
              const sourceUrl = token.entry?.source_url?.trim() ?? '';
              const sourceLabel = token.entry?.source_label?.trim() ?? '';
              const hasSafeSourceUrl = Boolean(sourceUrl && SAFE_EXTERNAL_URL_RE.test(sourceUrl));
              const assignFocusRef = !firstEditableTokenAssigned;
              if (assignFocusRef) {
                firstEditableTokenAssigned = true;
              }

              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: a person can repeat a given/middle/surname token
                  key={`${token.role}-${token.text}-${idx}`}
                  className={`${cx(uiStyles, 'wiki-pronunciation-part')} ${localStyles['token-chip-item']}`}
                >
                  <button
                    ref={
                      assignFocusRef
                        ? (el) => {
                            if (primaryFocusRef) {
                              primaryFocusRef.current = el;
                            }
                          }
                        : undefined
                    }
                    type="button"
                    data-pronunciation-token={token.text}
                    data-token-role={token.role}
                    className={`${localStyles['token-chip-btn']}${isSelected ? ` ${localStyles['is-active']}` : ''}${!hasShared ? ` ${localStyles['is-missing']}` : ''}`}
                    disabled={isBusy}
                    aria-expanded={isSelected}
                    aria-controls={isSelected ? sharedEditorId : undefined}
                    onClick={() => {
                      openOrToggleTokenEditor(token);
                    }}
                  >
                    <span
                      className={`${cx(uiStyles, 'wiki-pronunciation-part-label')} ${localStyles['token-role']}`}
                    >
                      {roleLabel}
                    </span>
                    <strong className={localStyles['token-name']}>{token.text}</strong>
                    {hasShared && sharedGuideText ? (
                      <span
                        className={`${cx(uiStyles, 'wiki-pronunciation-part-shared')} ${localStyles['token-guide']}`}
                      >
                        {sharedGuideText}
                        {sharedSecondaryIpa}
                      </span>
                    ) : (
                      <span className={localStyles['token-missing-label']}>Not set</span>
                    )}
                  </button>

                  {(sourceLabel || hasSafeSourceUrl) && (
                    <span
                      className={`${cx(uiStyles, 'pronunciation-source')} ${localStyles['token-source-meta']}`}
                    >
                      {hasSafeSourceUrl ? (
                        <a
                          href={sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={localStyles['token-source-link']}
                        >
                          {sourceLabel || 'Source'}
                        </a>
                      ) : (
                        sourceLabel
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {inspection.composed && (
            <div className={localStyles['composed-preview']} data-testid="pronunciation-composed-preview">
              <span className={localStyles['composed-label']}>Composed from shared names:</span>
              <PronunciationBadge
                pronunciation={inspection.composed}
                label={previewLabel}
                baseUrl={baseUrl}
              />
            </div>
          )}

          {activeTokenDraft && (
            <div
              id={sharedEditorId}
              className={`${cx(uiStyles, 'wiki-pronunciation-shared-editor')} ${localStyles['shared-editor']}`}
            >
              <div className={localStyles['shared-editor-header']}>
                <strong>Shared pronunciation for &ldquo;{activeTokenDraft.displayText}&rdquo;</strong>
                <span className={localStyles['shared-editor-hint']}>
                  Updates every archive record sharing this name and automatically generates audio.
                </span>
              </div>

              <div className={cx(uiStyles, 'wiki-field-grid')}>
                <div className={cx(uiStyles, 'wiki-field')}>
                  <label htmlFor={`${idPrefix}-shared-phonetic`} className={cx(uiStyles, 'wiki-field-label')}>
                    Respelling
                  </label>
                  <input
                    id={`${idPrefix}-shared-phonetic`}
                    type="text"
                    className={cx(uiStyles, 'wiki-input')}
                    placeholder="e.g. DAN-yuhl or MER-ser"
                    value={activeTokenDraft.phonetic}
                    aria-describedby={sharedPhoneticIpaGlyphs.length > 0 ? sharedPhoneticHintId : undefined}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setActiveTokenDraft((prev) => (prev ? { ...prev, phonetic: nextValue } : prev));
                    }}
                    disabled={sharedSaveStatus === 'saving'}
                  />
                  {sharedPhoneticIpaGlyphs.length > 0 && (
                    <span id={sharedPhoneticHintId} className={localStyles['ipa-hint']}>
                      Found IPA symbol ({sharedPhoneticIpaGlyphs.join(', ')}). Use plain English syllables in
                      Respelling (e.g. DAN-yuhl) and put IPA symbols in IPA (optional).
                    </span>
                  )}
                </div>

                <div className={cx(uiStyles, 'wiki-field')}>
                  <label htmlFor={`${idPrefix}-shared-ipa`} className={cx(uiStyles, 'wiki-field-label')}>
                    IPA (optional)
                  </label>
                  <input
                    id={`${idPrefix}-shared-ipa`}
                    type="text"
                    className={cx(uiStyles, 'wiki-input')}
                    placeholder="e.g. /ˈdæn.jəl/"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={activeTokenDraft.ipa}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setActiveTokenDraft((prev) => (prev ? { ...prev, ipa: nextValue } : prev));
                    }}
                    disabled={sharedSaveStatus === 'saving'}
                  />
                </div>

                <div className={cx(uiStyles, 'wiki-field')}>
                  <label htmlFor={`${idPrefix}-shared-lang`} className={cx(uiStyles, 'wiki-field-label')}>
                    Language
                  </label>
                  <input
                    id={`${idPrefix}-shared-lang`}
                    type="text"
                    className={cx(uiStyles, 'wiki-input')}
                    placeholder="e.g. en-US, nl, pl"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={activeTokenDraft.language}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setActiveTokenDraft((prev) => (prev ? { ...prev, language: nextValue } : prev));
                    }}
                    disabled={sharedSaveStatus === 'saving'}
                  />
                </div>

                <div className={cx(uiStyles, 'wiki-field')}>
                  <label htmlFor={`${idPrefix}-shared-note`} className={cx(uiStyles, 'wiki-field-label')}>
                    Note
                  </label>
                  <input
                    id={`${idPrefix}-shared-note`}
                    type="text"
                    className={cx(uiStyles, 'wiki-input')}
                    placeholder="e.g. Stress on first syllable"
                    value={activeTokenDraft.note}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setActiveTokenDraft((prev) => (prev ? { ...prev, note: nextValue } : prev));
                    }}
                    disabled={sharedSaveStatus === 'saving'}
                  />
                </div>

                <div className={cx(uiStyles, 'wiki-field')}>
                  <label
                    htmlFor={`${idPrefix}-shared-source-label`}
                    className={cx(uiStyles, 'wiki-field-label')}
                  >
                    Source label (optional)
                  </label>
                  <input
                    id={`${idPrefix}-shared-source-label`}
                    type="text"
                    className={cx(uiStyles, 'wiki-input')}
                    placeholder="e.g. Wiktionary (Dutch IPA) or Family oral tradition"
                    value={activeTokenDraft.source_label}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setActiveTokenDraft((prev) => (prev ? { ...prev, source_label: nextValue } : prev));
                    }}
                    disabled={sharedSaveStatus === 'saving'}
                  />
                </div>

                <div className={cx(uiStyles, 'wiki-field')}>
                  <label
                    htmlFor={`${idPrefix}-shared-source-url`}
                    className={cx(uiStyles, 'wiki-field-label')}
                  >
                    Source URL (optional)
                  </label>
                  <input
                    id={`${idPrefix}-shared-source-url`}
                    type="url"
                    className={cx(uiStyles, 'wiki-input')}
                    placeholder="e.g. https://en.wiktionary.org/wiki/..."
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={activeTokenDraft.source_url}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setActiveTokenDraft((prev) => (prev ? { ...prev, source_url: nextValue } : prev));
                    }}
                    disabled={sharedSaveStatus === 'saving'}
                  />
                </div>
              </div>

              <div className={localStyles['shared-editor-actions']}>
                <button
                  type="button"
                  className={cx(uiStyles, 'wiki-pronunciation-shared-save-btn')}
                  disabled={sharedSaveStatus === 'saving'}
                  onClick={() => {
                    void handleSaveSharedToken();
                  }}
                >
                  {sharedSaveStatus === 'saving'
                    ? 'Saving…'
                    : `Save for all ${activeTokenDraft.displayText} records`}
                </button>
                <button
                  type="button"
                  className={cx(uiStyles, 'pill-btn')}
                  disabled={sharedSaveStatus === 'saving'}
                  onClick={() => {
                    setActiveTokenDraft(null);
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
              className={`${localStyles['status-note']} ${sharedSaveStatus === 'error' ? localStyles['is-error'] : localStyles['is-success']}`}
              role={sharedSaveStatus === 'error' ? 'alert' : 'status'}
            >
              {sharedSaveMessage}
            </div>
          )}
        </div>
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
        <div id={overridePanelId}>
          <div className={cx(uiStyles, 'wiki-field-grid')}>
            <div className={cx(uiStyles, 'wiki-field')}>
              <label htmlFor={`${idPrefix}-personal-phonetic`} className={cx(uiStyles, 'wiki-field-label')}>
                Respelling
              </label>
              <input
                ref={
                  !hasEditablePersonTokens
                    ? (el) => {
                        if (primaryFocusRef) {
                          primaryFocusRef.current = el;
                        }
                      }
                    : undefined
                }
                id={`${idPrefix}-personal-phonetic`}
                type="text"
                className={cx(uiStyles, 'wiki-input')}
                placeholder="e.g. MER-ser or LAY-den"
                value={draftPronunciation?.phonetic ?? ''}
                aria-describedby={personalPhoneticIpaGlyphs.length > 0 ? personalPhoneticHintId : undefined}
                onChange={(e) => {
                  updatePronunciationField('phonetic', e.target.value);
                }}
                disabled={isBusy}
              />
              {personalPhoneticIpaGlyphs.length > 0 && (
                <span id={personalPhoneticHintId} className={localStyles['ipa-hint']}>
                  Found IPA symbol ({personalPhoneticIpaGlyphs.join(', ')}). Use plain English syllables in
                  Respelling (e.g. DAN-yuhl) and put IPA symbols in IPA (optional).
                </span>
              )}
            </div>

            <div className={cx(uiStyles, 'wiki-field')}>
              <label htmlFor={`${idPrefix}-personal-ipa`} className={cx(uiStyles, 'wiki-field-label')}>
                IPA (optional)
              </label>
              <input
                id={`${idPrefix}-personal-ipa`}
                type="text"
                className={cx(uiStyles, 'wiki-input')}
                placeholder="e.g. /ˈmɜːr.sər/"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={draftPronunciation?.ipa ?? ''}
                onChange={(e) => {
                  updatePronunciationField('ipa', e.target.value);
                }}
                disabled={isBusy}
              />
            </div>

            <div className={cx(uiStyles, 'wiki-field')}>
              <label htmlFor={`${idPrefix}-personal-lang`} className={cx(uiStyles, 'wiki-field-label')}>
                Language / origin
              </label>
              <input
                id={`${idPrefix}-personal-lang`}
                type="text"
                className={cx(uiStyles, 'wiki-input')}
                placeholder="e.g. nl, pl, en-US"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={draftPronunciation?.language ?? ''}
                onChange={(e) => {
                  updatePronunciationField('language', e.target.value);
                }}
                disabled={isBusy}
              />
            </div>

            <div className={cx(uiStyles, 'wiki-field')}>
              <label htmlFor={`${idPrefix}-personal-note`} className={cx(uiStyles, 'wiki-field-label')}>
                Pronunciation note (optional)
              </label>
              <input
                id={`${idPrefix}-personal-note`}
                type="text"
                className={cx(uiStyles, 'wiki-input')}
                placeholder="e.g. Stress on first syllable"
                value={draftPronunciation?.note ?? ''}
                onChange={(e) => {
                  updatePronunciationField('note', e.target.value);
                }}
                disabled={isBusy}
              />
            </div>

            <div className={cx(uiStyles, 'wiki-field')}>
              <label
                htmlFor={`${idPrefix}-personal-source-label`}
                className={cx(uiStyles, 'wiki-field-label')}
              >
                Source label (optional)
              </label>
              <input
                id={`${idPrefix}-personal-source-label`}
                type="text"
                className={cx(uiStyles, 'wiki-input')}
                placeholder="e.g. Wiktionary (Dutch IPA)"
                value={draftPronunciation?.source_label ?? ''}
                onChange={(e) => {
                  updatePronunciationField('source_label', e.target.value);
                }}
                disabled={isBusy}
              />
            </div>

            <div className={cx(uiStyles, 'wiki-field')}>
              <label htmlFor={`${idPrefix}-personal-source-url`} className={cx(uiStyles, 'wiki-field-label')}>
                Source URL (optional)
              </label>
              <input
                id={`${idPrefix}-personal-source-url`}
                type="url"
                className={cx(uiStyles, 'wiki-input')}
                placeholder="e.g. https://en.wiktionary.org/wiki/Leiden"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={draftPronunciation?.source_url ?? ''}
                onChange={(e) => {
                  updatePronunciationField('source_url', e.target.value);
                }}
                disabled={isBusy}
              />
            </div>
          </div>

          <div className={cx(uiStyles, 'wiki-pronunciation-actions')}>
            <button
              type="button"
              className={cx(uiStyles, 'wiki-pronunciation-gen-btn')}
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
              <div className={cx(uiStyles, 'wiki-pronunciation-preview')}>
                <PronunciationBadge
                  pronunciation={draftPronunciation}
                  label={previewLabel}
                  baseUrl={baseUrl}
                />
              </div>
            )}
          </div>

          {audioGenMessage && (
            <div
              className={`${localStyles['status-note']} ${audioGenStatus === 'error' ? localStyles['is-error'] : localStyles['is-success']}`}
              role={audioGenStatus === 'error' ? 'alert' : 'status'}
            >
              {audioGenMessage}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
};
