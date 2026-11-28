import type { InspectedPersonPronunciationToken, Pronunciation } from '@kinloom/core';
import { findIpaGlyphsInPhonetic } from '@kinloom/core';
import type React from 'react';
import { cx } from '../../../lib/cx.js';
import controlStyles from '../../../styles/Controls.module.css';
import { hasPronunciationContent, PronunciationBadge } from '../../PronunciationBadge.js';
import pronunciationBadgeStyles from '../../PronunciationBadge.module.css';
import localStyles from '../PronunciationEditorSection.module.css';
import wikiFormStyles from '../WikiForms.module.css';
import type { SharedTokenDraft } from './pronunciationDraft.js';
import { PRONUNCIATION_ROLE_LABELS, SAFE_EXTERNAL_URL_RE } from './pronunciationDraft.js';

export interface SharedTokenPronunciationEditorProps {
  readonly idPrefix: string;
  readonly tokens: readonly InspectedPersonPronunciationToken[];
  readonly composed: Pronunciation | null;
  readonly previewLabel: string;
  readonly baseUrl?: string | undefined;
  readonly isBusy: boolean;
  readonly primaryFocusRef?: React.RefObject<HTMLElement | null> | undefined;
  readonly activeTokenDraft: SharedTokenDraft | null;
  readonly sharedSaveStatus: 'idle' | 'saving' | 'success' | 'error';
  readonly sharedSaveMessage: string | null;
  readonly onToggleToken: (token: InspectedPersonPronunciationToken) => void;
  readonly onUpdateDraft: React.Dispatch<React.SetStateAction<SharedTokenDraft | null>>;
  readonly onSaveSharedToken: () => Promise<void>;
  readonly onCancelSharedToken: () => void;
}

export const SharedTokenPronunciationEditor: React.FC<SharedTokenPronunciationEditorProps> = ({
  idPrefix,
  tokens,
  composed,
  previewLabel,
  baseUrl,
  isBusy,
  primaryFocusRef,
  activeTokenDraft,
  sharedSaveStatus,
  sharedSaveMessage,
  onToggleToken,
  onUpdateDraft,
  onSaveSharedToken,
  onCancelSharedToken,
}) => {
  const sharedPhoneticIpaGlyphs = activeTokenDraft ? findIpaGlyphsInPhonetic(activeTokenDraft.phonetic) : [];
  const sharedEditorId = `${idPrefix}-shared-editor`;
  const sharedPhoneticHintId = `${idPrefix}-shared-phonetic-hint`;
  let firstEditableTokenAssigned = false;

  return (
    <div
      className={`${cx(pronunciationBadgeStyles, 'wiki-pronunciation-breakdown')} ${localStyles['token-section']}`}
    >
      <p className={localStyles['pronunciation-intro']}>
        Tap any name token to edit its shared Respelling and IPA across all matching records.
      </p>

      <div
        className={`${cx(pronunciationBadgeStyles, 'wiki-pronunciation-breakdown-parts')} ${localStyles['token-chip-list']}`}
        data-testid="pronunciation-token-chips"
      >
        {tokens.map((token, idx) => {
          const roleLabel = PRONUNCIATION_ROLE_LABELS[token.role];
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
          const sharedSecondaryIpa = token.entry?.phonetic && token.entry?.ipa ? ` ${token.entry.ipa}` : '';
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
              className={`${cx(pronunciationBadgeStyles, 'wiki-pronunciation-part')} ${localStyles['token-chip-item']}`}
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
                  onToggleToken(token);
                }}
              >
                <span
                  className={`${cx(pronunciationBadgeStyles, 'wiki-pronunciation-part-label')} ${localStyles['token-role']}`}
                >
                  {roleLabel}
                </span>
                <strong className={localStyles['token-name']}>{token.text}</strong>
                {hasShared && sharedGuideText ? (
                  <span
                    className={`${cx(pronunciationBadgeStyles, 'wiki-pronunciation-part-shared')} ${localStyles['token-guide']}`}
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
                  className={`${cx(pronunciationBadgeStyles, 'pronunciation-source')} ${localStyles['token-source-meta']}`}
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

      {composed && (
        <div className={localStyles['composed-preview']} data-testid="pronunciation-composed-preview">
          <span className={localStyles['composed-label']}>Composed from shared names:</span>
          <PronunciationBadge pronunciation={composed} label={previewLabel} baseUrl={baseUrl} />
        </div>
      )}

      {activeTokenDraft && (
        <div
          id={sharedEditorId}
          className={`${cx(pronunciationBadgeStyles, 'wiki-pronunciation-shared-editor')} ${localStyles['shared-editor']}`}
        >
          <div className={localStyles['shared-editor-header']}>
            <strong>Shared pronunciation for &ldquo;{activeTokenDraft.displayText}&rdquo;</strong>
            <span className={localStyles['shared-editor-hint']}>
              Updates every archive record sharing this name and automatically generates audio.
            </span>
          </div>

          <div className={cx(wikiFormStyles, 'wiki-field-grid')}>
            <div className={cx(wikiFormStyles, 'wiki-field')}>
              <label
                htmlFor={`${idPrefix}-shared-phonetic`}
                className={cx(wikiFormStyles, 'wiki-field-label')}
              >
                Respelling
              </label>
              <input
                id={`${idPrefix}-shared-phonetic`}
                type="text"
                className={cx(wikiFormStyles, 'wiki-input')}
                placeholder="e.g. DAN-yuhl or MER-ser"
                value={activeTokenDraft.phonetic}
                aria-describedby={sharedPhoneticIpaGlyphs.length > 0 ? sharedPhoneticHintId : undefined}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  onUpdateDraft((prev) => (prev ? { ...prev, phonetic: nextValue } : prev));
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

            <div className={cx(wikiFormStyles, 'wiki-field')}>
              <label htmlFor={`${idPrefix}-shared-ipa`} className={cx(wikiFormStyles, 'wiki-field-label')}>
                IPA (optional)
              </label>
              <input
                id={`${idPrefix}-shared-ipa`}
                type="text"
                className={cx(wikiFormStyles, 'wiki-input')}
                placeholder="e.g. /ˈdæn.jəl/"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={activeTokenDraft.ipa}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  onUpdateDraft((prev) => (prev ? { ...prev, ipa: nextValue } : prev));
                }}
                disabled={sharedSaveStatus === 'saving'}
              />
            </div>

            <div className={cx(wikiFormStyles, 'wiki-field')}>
              <label htmlFor={`${idPrefix}-shared-lang`} className={cx(wikiFormStyles, 'wiki-field-label')}>
                Language
              </label>
              <input
                id={`${idPrefix}-shared-lang`}
                type="text"
                className={cx(wikiFormStyles, 'wiki-input')}
                placeholder="e.g. en-US, nl, pl"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={activeTokenDraft.language}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  onUpdateDraft((prev) => (prev ? { ...prev, language: nextValue } : prev));
                }}
                disabled={sharedSaveStatus === 'saving'}
              />
            </div>

            <div className={cx(wikiFormStyles, 'wiki-field')}>
              <label htmlFor={`${idPrefix}-shared-note`} className={cx(wikiFormStyles, 'wiki-field-label')}>
                Note
              </label>
              <input
                id={`${idPrefix}-shared-note`}
                type="text"
                className={cx(wikiFormStyles, 'wiki-input')}
                placeholder="e.g. Stress on first syllable"
                value={activeTokenDraft.note}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  onUpdateDraft((prev) => (prev ? { ...prev, note: nextValue } : prev));
                }}
                disabled={sharedSaveStatus === 'saving'}
              />
            </div>

            <div className={cx(wikiFormStyles, 'wiki-field')}>
              <label
                htmlFor={`${idPrefix}-shared-source-label`}
                className={cx(wikiFormStyles, 'wiki-field-label')}
              >
                Source label (optional)
              </label>
              <input
                id={`${idPrefix}-shared-source-label`}
                type="text"
                className={cx(wikiFormStyles, 'wiki-input')}
                placeholder="e.g. Wiktionary (Dutch IPA) or Family oral tradition"
                value={activeTokenDraft.source_label}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  onUpdateDraft((prev) => (prev ? { ...prev, source_label: nextValue } : prev));
                }}
                disabled={sharedSaveStatus === 'saving'}
              />
            </div>

            <div className={cx(wikiFormStyles, 'wiki-field')}>
              <label
                htmlFor={`${idPrefix}-shared-source-url`}
                className={cx(wikiFormStyles, 'wiki-field-label')}
              >
                Source URL (optional)
              </label>
              <input
                id={`${idPrefix}-shared-source-url`}
                type="url"
                className={cx(wikiFormStyles, 'wiki-input')}
                placeholder="e.g. https://en.wiktionary.org/wiki/..."
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={activeTokenDraft.source_url}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  onUpdateDraft((prev) => (prev ? { ...prev, source_url: nextValue } : prev));
                }}
                disabled={sharedSaveStatus === 'saving'}
              />
            </div>
          </div>

          <div className={localStyles['shared-editor-actions']}>
            <button
              type="button"
              className={'wiki-pronunciation-shared-save-btn'}
              disabled={sharedSaveStatus === 'saving'}
              onClick={() => {
                void onSaveSharedToken();
              }}
            >
              {sharedSaveStatus === 'saving'
                ? 'Saving…'
                : `Save for all ${activeTokenDraft.displayText} records`}
            </button>
            <button
              type="button"
              className={cx(controlStyles, 'pill-btn')}
              disabled={sharedSaveStatus === 'saving'}
              onClick={onCancelSharedToken}
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
  );
};
