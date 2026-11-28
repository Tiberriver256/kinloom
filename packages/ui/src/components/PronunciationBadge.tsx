import type {
  Pronunciation,
  PronunciationCoverage,
  PronunciationVariant,
  ResolvedPersonPronunciation,
} from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  playSingleAudioUrl,
  playSpeechSynthesisFallback,
  playTokenAudioUrls,
  stopActivePronunciation,
  stopPronunciationIfOwner,
} from '../browser/pronunciationPlayback.js';
import { cx } from '../lib/cx.js';
import {
  formatPronunciationScopePrefix,
  formatPronunciationScopeTitle,
  KINLOOM_VOCABULARY,
} from '../lib/vocabulary.js';
import { resolveAssetUrl } from './Atoms.js';
import pronunciationBadgeStyles from './PronunciationBadge.module.css';

export type PronunciationBadgeData = Pronunciation | ResolvedPersonPronunciation;

export interface PronunciationBadgeProps {
  pronunciation?: PronunciationBadgeData | null | undefined;
  label: string;
  /** Optional prefix when the guide applies to a specific name part (e.g. "Surname"). */
  prefix?: string | undefined;
  /** Coverage metadata from `resolvePersonPronunciation`. Omit or `'full'` for clean full-name display. */
  coverage?: PronunciationCoverage | undefined;
  /** Specific name part matched when coverage is not `'full'` (e.g. surname). */
  matchedPart?: string | undefined;
  baseUrl?: string | undefined;
  compact?: boolean | undefined;
  /** Render only the speaker play button (hides inline phonetic/IPA/language text for quiet prose reading). */
  iconOnly?: boolean | undefined;
  className?: string | undefined;
}

const SAFE_EXTERNAL_URL_RE = /^https?:\/\//i;

export function isEnglishPronunciationLanguage(language?: string | null): boolean {
  const trimmed = language?.trim();
  if (!trimmed) {
    return true;
  }
  return /^en(?:[-_]|$)/i.test(trimmed);
}

function hasSingleEntryContent(
  entry?: Pick<Pronunciation, 'phonetic' | 'ipa' | 'audio_url' | 'note'> | null
): boolean {
  if (!entry) {
    return false;
  }
  return Boolean(
    entry.phonetic?.trim() || entry.ipa?.trim() || entry.audio_url?.trim() || entry.note?.trim()
  );
}

function extractTokenAudioUrls(pronunciation?: PronunciationBadgeData | null): readonly string[] {
  if (!pronunciation || !('token_audio_urls' in pronunciation)) {
    return [];
  }
  return pronunciation.token_audio_urls ?? [];
}

export function hasPronunciationContent(pronunciation?: PronunciationBadgeData | null): boolean {
  if (!pronunciation) {
    return false;
  }
  if (hasSingleEntryContent(pronunciation) || extractTokenAudioUrls(pronunciation).length > 0) {
    return true;
  }
  return Boolean(pronunciation.variants?.some((variant) => hasSingleEntryContent(variant)));
}

function sanitizeSourceUrl(raw?: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || !SAFE_EXTERNAL_URL_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export const PronunciationBadge: React.FC<PronunciationBadgeProps> = ({
  pronunciation,
  label,
  prefix,
  coverage,
  matchedPart,
  baseUrl,
  compact = false,
  iconOnly = false,
  className,
}) => {
  const [playing, setPlaying] = useState(false);
  const [selectedVariantIdx, setSelectedVariantIdx] = useState<number | null>(null);
  const stopSelfRef = useRef<(() => void) | null>(null);

  const variants: readonly PronunciationVariant[] =
    !compact && !iconOnly && pronunciation?.variants
      ? pronunciation.variants.filter((v) => hasSingleEntryContent(v))
      : [];

  const effectiveVariantIdx =
    selectedVariantIdx !== null && selectedVariantIdx < variants.length ? selectedVariantIdx : null;
  const activeEntry: Pronunciation | PronunciationVariant | null | undefined =
    effectiveVariantIdx !== null ? variants[effectiveVariantIdx] : pronunciation;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset audio playback when pronunciation entry changes
  useEffect(() => {
    setSelectedVariantIdx(null);
  }, [pronunciation]);

  useEffect(() => {
    return (): void => {
      stopPronunciationIfOwner(stopSelfRef.current);
    };
  }, []);

  const handleTogglePlay = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();

      if (playing) {
        stopActivePronunciation();
        return;
      }

      stopActivePronunciation();

      const onStopped = (): void => {
        setPlaying(false);
        if (stopSelfRef.current === onStopped) {
          stopSelfRef.current = null;
        }
      };

      const audioUrl = activeEntry?.audio_url?.trim();
      if (audioUrl) {
        const resolved = resolveAssetUrl(audioUrl, baseUrl);
        if (!resolved) {
          return;
        }
        stopSelfRef.current = onStopped;
        setPlaying(true);
        if (playSingleAudioUrl(resolved, onStopped)) {
          return;
        }
        onStopped();
      }

      if (effectiveVariantIdx === null) {
        const resolvedTokenUrls = extractTokenAudioUrls(pronunciation)
          .map((raw) => resolveAssetUrl(raw.trim(), baseUrl))
          .filter((url): url is string => Boolean(url));
        if (resolvedTokenUrls.length > 0) {
          stopSelfRef.current = onStopped;
          setPlaying(true);
          if (playTokenAudioUrls(resolvedTokenUrls, onStopped)) {
            return;
          }
          onStopped();
        }
      }

      // Pass natural orthography (`label`) rather than ALL-CAPS hyphenated respellings so
      // browser TTS speaks words instead of spelling stressed syllables letter by letter.
      stopSelfRef.current = onStopped;
      setPlaying(true);
      if (!playSpeechSynthesisFallback(label, activeEntry?.language, onStopped)) {
        onStopped();
      }
    },
    [playing, activeEntry, effectiveVariantIdx, pronunciation, baseUrl, label]
  );

  if (!pronunciation || !hasPronunciationContent(pronunciation) || !activeEntry) {
    return null;
  }

  const phonetic = activeEntry.phonetic?.trim() || '';
  const ipa = activeEntry.ipa?.trim() || '';
  const language = activeEntry.language?.trim() || '';
  const note = activeEntry.note?.trim() || '';
  const sourceLabel = activeEntry.source_label?.trim() || '';
  const safeSourceUrl = sanitizeSourceUrl(activeEntry.source_url);
  const primaryGuide = phonetic || ipa;
  const secondaryIpa = phonetic && ipa ? ipa : '';
  const primaryVariantLabel =
    pronunciation.region?.trim() ||
    (pronunciation.language?.trim() ? `Primary (${pronunciation.language.trim()})` : 'Primary');

  const effectivePrefix =
    coverage === 'full' ? undefined : (prefix ?? formatPronunciationScopePrefix(coverage));
  const prefixTitle = formatPronunciationScopeTitle(coverage, matchedPart);

  const rootClassName = [
    'pronunciation-badge',
    compact ? 'is-compact' : '',
    playing ? 'is-playing' : '',
    coverage && coverage !== 'full' ? `is-coverage-${coverage}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cx(pronunciationBadgeStyles, rootClassName)} data-coverage={coverage ?? undefined}>
      <button
        type="button"
        className={cx(
          pronunciationBadgeStyles,
          `pronunciation-play-btn print-hide${playing ? ' is-playing' : ''}`
        )}
        aria-label={`Listen to pronunciation of ${label}`}
        aria-pressed={playing}
        title={playing ? `Stop pronunciation of ${label}` : `Listen to pronunciation of ${label}`}
        onClick={handleTogglePlay}
      >
        <svg
          width={compact ? 12 : 14}
          height={compact ? 12 : 14}
          viewBox={compact ? '-0.5 0 20 24' : '0 0 24 24'}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ display: 'block' }}
          aria-hidden="true"
        >
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          {!compact && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
        </svg>
      </button>
      {!iconOnly && effectivePrefix && (
        <span className={cx(pronunciationBadgeStyles, 'pronunciation-prefix')} title={prefixTitle}>
          {effectivePrefix}:
        </span>
      )}
      {!iconOnly && primaryGuide && (
        <span
          className={cx(pronunciationBadgeStyles, 'pronunciation-guide')}
          title={secondaryIpa ? `IPA: ${secondaryIpa}` : undefined}
        >
          {primaryGuide}
        </span>
      )}
      {!iconOnly && !compact && secondaryIpa && (
        <span className={cx(pronunciationBadgeStyles, 'pronunciation-ipa')} title={`IPA ${secondaryIpa}`}>
          {secondaryIpa}
        </span>
      )}
      {!iconOnly && language && (
        <span className={cx(pronunciationBadgeStyles, 'pronunciation-lang')} title={`Language: ${language}`}>
          {language}
        </span>
      )}
      {!iconOnly && !compact && note && (
        <span className={cx(pronunciationBadgeStyles, 'pronunciation-note')}>{note}</span>
      )}
      {!iconOnly && !compact && (sourceLabel || safeSourceUrl) && (
        <span className={cx(pronunciationBadgeStyles, 'pronunciation-source')}>
          {safeSourceUrl ? (
            <a
              href={safeSourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(pronunciationBadgeStyles, 'pronunciation-source-link')}
            >
              {sourceLabel || KINLOOM_VOCABULARY.pronunciation.defaultSourceLabel}
            </a>
          ) : (
            sourceLabel
          )}
        </span>
      )}
      {!iconOnly && !compact && variants.length > 0 && (
        <span
          className={cx(pronunciationBadgeStyles, 'pronunciation-variants print-hide')}
          role="group"
          aria-label={KINLOOM_VOCABULARY.pronunciation.variantsAria}
        >
          <button
            type="button"
            className={cx(
              pronunciationBadgeStyles,
              `pronunciation-variant-btn${effectiveVariantIdx === null ? ' is-active' : ''}`
            )}
            aria-pressed={effectiveVariantIdx === null}
            onClick={(e) => {
              e.stopPropagation();
              stopActivePronunciation();
              setSelectedVariantIdx(null);
            }}
          >
            {primaryVariantLabel}
          </button>
          {variants.map((variant, idx) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: variant labels may repeat across locales
              key={`${variant.label}-${idx}`}
              type="button"
              className={cx(
                pronunciationBadgeStyles,
                `pronunciation-variant-btn${effectiveVariantIdx === idx ? ' is-active' : ''}`
              )}
              aria-pressed={effectiveVariantIdx === idx}
              onClick={(e) => {
                e.stopPropagation();
                stopActivePronunciation();
                setSelectedVariantIdx(idx);
              }}
            >
              {variant.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
};
