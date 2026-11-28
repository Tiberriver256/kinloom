import type { Pronunciation } from '@kinloom/core';
import { findIpaGlyphsInPhonetic } from '@kinloom/core';
import type React from 'react';
import { cx } from '../../../lib/cx.js';
import { hasPronunciationContent, PronunciationBadge } from '../../PronunciationBadge.js';
import pronunciationBadgeStyles from '../../PronunciationBadge.module.css';
import localStyles from '../PronunciationEditorSection.module.css';
import wikiFormStyles from '../WikiForms.module.css';
import type { PronunciationStringFieldKey } from './pronunciationDraft.js';

export interface PersonalPronunciationOverrideFormProps {
  readonly idPrefix: string;
  readonly overridePanelId: string;
  readonly draftPronunciation: Pronunciation | null;
  readonly previewLabel: string;
  readonly baseUrl?: string | undefined;
  readonly isBusy: boolean;
  readonly hasEditablePersonTokens: boolean;
  readonly primaryFocusRef?: React.RefObject<HTMLElement | null> | undefined;
  readonly audioGenStatus: 'idle' | 'loading' | 'success' | 'error';
  readonly audioGenMessage: string | null;
  readonly onUpdateField: (key: PronunciationStringFieldKey, value: string) => void;
  readonly onGenerateAudio: () => Promise<void>;
}

export const PersonalPronunciationOverrideForm: React.FC<PersonalPronunciationOverrideFormProps> = ({
  idPrefix,
  overridePanelId,
  draftPronunciation,
  previewLabel,
  baseUrl,
  isBusy,
  hasEditablePersonTokens,
  primaryFocusRef,
  audioGenStatus,
  audioGenMessage,
  onUpdateField,
  onGenerateAudio,
}) => {
  const personalPhoneticIpaGlyphs = findIpaGlyphsInPhonetic(draftPronunciation?.phonetic);
  const personalPhoneticHintId = `${idPrefix}-personal-phonetic-hint`;

  return (
    <div id={overridePanelId}>
      <div className={cx(wikiFormStyles, 'wiki-field-grid')}>
        <div className={cx(wikiFormStyles, 'wiki-field')}>
          <label htmlFor={`${idPrefix}-personal-phonetic`} className={cx(wikiFormStyles, 'wiki-field-label')}>
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
            className={cx(wikiFormStyles, 'wiki-input')}
            placeholder="e.g. MER-ser or LAY-den"
            value={draftPronunciation?.phonetic ?? ''}
            aria-describedby={personalPhoneticIpaGlyphs.length > 0 ? personalPhoneticHintId : undefined}
            onChange={(e) => {
              onUpdateField('phonetic', e.target.value);
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

        <div className={cx(wikiFormStyles, 'wiki-field')}>
          <label htmlFor={`${idPrefix}-personal-ipa`} className={cx(wikiFormStyles, 'wiki-field-label')}>
            IPA (optional)
          </label>
          <input
            id={`${idPrefix}-personal-ipa`}
            type="text"
            className={cx(wikiFormStyles, 'wiki-input')}
            placeholder="e.g. /ˈmɜːr.sər/"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={draftPronunciation?.ipa ?? ''}
            onChange={(e) => {
              onUpdateField('ipa', e.target.value);
            }}
            disabled={isBusy}
          />
        </div>

        <div className={cx(wikiFormStyles, 'wiki-field')}>
          <label htmlFor={`${idPrefix}-personal-lang`} className={cx(wikiFormStyles, 'wiki-field-label')}>
            Language / origin
          </label>
          <input
            id={`${idPrefix}-personal-lang`}
            type="text"
            className={cx(wikiFormStyles, 'wiki-input')}
            placeholder="e.g. nl, pl, en-US"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={draftPronunciation?.language ?? ''}
            onChange={(e) => {
              onUpdateField('language', e.target.value);
            }}
            disabled={isBusy}
          />
        </div>

        <div className={cx(wikiFormStyles, 'wiki-field')}>
          <label htmlFor={`${idPrefix}-personal-note`} className={cx(wikiFormStyles, 'wiki-field-label')}>
            Pronunciation note (optional)
          </label>
          <input
            id={`${idPrefix}-personal-note`}
            type="text"
            className={cx(wikiFormStyles, 'wiki-input')}
            placeholder="e.g. Stress on first syllable"
            value={draftPronunciation?.note ?? ''}
            onChange={(e) => {
              onUpdateField('note', e.target.value);
            }}
            disabled={isBusy}
          />
        </div>

        <div className={cx(wikiFormStyles, 'wiki-field')}>
          <label
            htmlFor={`${idPrefix}-personal-source-label`}
            className={cx(wikiFormStyles, 'wiki-field-label')}
          >
            Source label (optional)
          </label>
          <input
            id={`${idPrefix}-personal-source-label`}
            type="text"
            className={cx(wikiFormStyles, 'wiki-input')}
            placeholder="e.g. Wiktionary (Dutch IPA)"
            value={draftPronunciation?.source_label ?? ''}
            onChange={(e) => {
              onUpdateField('source_label', e.target.value);
            }}
            disabled={isBusy}
          />
        </div>

        <div className={cx(wikiFormStyles, 'wiki-field')}>
          <label
            htmlFor={`${idPrefix}-personal-source-url`}
            className={cx(wikiFormStyles, 'wiki-field-label')}
          >
            Source URL (optional)
          </label>
          <input
            id={`${idPrefix}-personal-source-url`}
            type="url"
            className={cx(wikiFormStyles, 'wiki-input')}
            placeholder="e.g. https://en.wiktionary.org/wiki/Leiden"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={draftPronunciation?.source_url ?? ''}
            onChange={(e) => {
              onUpdateField('source_url', e.target.value);
            }}
            disabled={isBusy}
          />
        </div>
      </div>

      <div className={cx(pronunciationBadgeStyles, 'wiki-pronunciation-actions')}>
        <button
          type="button"
          className={'wiki-pronunciation-gen-btn'}
          disabled={isBusy || audioGenStatus === 'loading'}
          onClick={() => {
            void onGenerateAudio();
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
          <div className={cx(pronunciationBadgeStyles, 'wiki-pronunciation-preview')}>
            <PronunciationBadge pronunciation={draftPronunciation} label={previewLabel} baseUrl={baseUrl} />
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
  );
};
