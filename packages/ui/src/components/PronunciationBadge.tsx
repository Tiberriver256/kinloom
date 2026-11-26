import type { Pronunciation, PronunciationCoverage, PronunciationVariant } from '@kinloom/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KINLOOM_VOCABULARY,
  formatPronunciationScopePrefix,
  formatPronunciationScopeTitle,
} from '../lib/vocabulary.js';
import { resolveAssetUrl } from './Atoms.js';

export interface PronunciationBadgeProps {
  pronunciation?: Pronunciation | null;
  label: string;
  /** Optional prefix when the guide applies to a specific name part (e.g. "Surname"). */
  prefix?: string;
  /** Coverage metadata from `resolvePersonPronunciation`. Omit or `'full'` for clean full-name display. */
  coverage?: PronunciationCoverage;
  /** Specific name part matched when coverage is not `'full'` (e.g. surname). */
  matchedPart?: string;
  baseUrl?: string;
  compact?: boolean;
  /** Render only the speaker play button (hides inline phonetic/IPA/language text for quiet prose reading). */
  iconOnly?: boolean;
  className?: string;
}

const SAFE_EXTERNAL_URL_RE = /^https?:\/\//i;

let activeAudioElement: HTMLAudioElement | null = null;
let activeStopCallback: (() => void) | null = null;

function stopActivePronunciation(): void {
  if (activeAudioElement) {
    activeAudioElement.pause();
    try {
      activeAudioElement.currentTime = 0;
    } catch {
      // Ignore if media element is not seekable yet.
    }
    activeAudioElement = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore speechSynthesis cancellation errors in headless environments.
    }
  }
  if (activeStopCallback) {
    const cb = activeStopCallback;
    activeStopCallback = null;
    cb();
  }
}

export function isEnglishPronunciationLanguage(language?: string | null): boolean {
  const trimmed = language?.trim();
  if (!trimmed) {
    return true;
  }
  return /^en(?:[-_]|$)/i.test(trimmed);
}

function hasSingleEntryContent(
  entry?: Pick<Pronunciation, 'phonetic' | 'ipa' | 'audio_url' | 'note'> | null,
): boolean {
  if (!entry) {
    return false;
  }
  return Boolean(
    entry.phonetic?.trim() ||
      entry.ipa?.trim() ||
      entry.audio_url?.trim() ||
      entry.note?.trim(),
  );
}

export function hasPronunciationContent(pronunciation?: Pronunciation | null): boolean {
  if (!pronunciation) {
    return false;
  }
  if (hasSingleEntryContent(pronunciation)) {
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

  useEffect(() => {
    setSelectedVariantIdx(null);
  }, [pronunciation]);

  useEffect(() => {
    return (): void => {
      if (stopSelfRef.current && activeStopCallback === stopSelfRef.current) {
        stopActivePronunciation();
      }
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
      if (audioUrl && typeof Audio !== 'undefined') {
        const resolved = resolveAssetUrl(audioUrl, baseUrl);
        if (!resolved) {
          return;
        }
        const audio = new Audio(resolved);
        activeAudioElement = audio;
        activeStopCallback = onStopped;
        stopSelfRef.current = onStopped;
        setPlaying(true);

        const cleanup = (): void => {
          if (activeAudioElement === audio) {
            activeAudioElement = null;
          }
          if (activeStopCallback === onStopped) {
            activeStopCallback = null;
          }
          onStopped();
        };

        audio.addEventListener('ended', cleanup, { once: true });
        audio.addEventListener('error', cleanup, { once: true });

        try {
          const playPromise = audio.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            void playPromise.catch(() => {
              cleanup();
            });
          }
        } catch {
          cleanup();
        }
        return;
      }

      if (
        typeof window !== 'undefined' &&
        'speechSynthesis' in window &&
        window.speechSynthesis &&
        typeof SpeechSynthesisUtterance !== 'undefined'
      ) {
        // Send English respellings only to English voices; non-English voices pronounce
        // the native orthography (`label`) cleanly in their own language.
        const spokenText = isEnglishPronunciationLanguage(activeEntry?.language)
          ? activeEntry?.phonetic?.trim() || label
          : label;
        const utterance = new SpeechSynthesisUtterance(spokenText);
        if (activeEntry?.language?.trim()) {
          utterance.lang = activeEntry.language.trim();
        }
        activeStopCallback = onStopped;
        stopSelfRef.current = onStopped;
        setPlaying(true);

        const cleanup = (): void => {
          if (activeStopCallback === onStopped) {
            activeStopCallback = null;
          }
          onStopped();
        };

        utterance.onend = cleanup;
        utterance.onerror = cleanup;
        try {
          window.speechSynthesis.speak(utterance);
        } catch {
          cleanup();
        }
      }
    },
    [playing, activeEntry, baseUrl, label],
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
    <span className={rootClassName} data-coverage={coverage ?? undefined}>
      <button
        type="button"
        className={`pronunciation-play-btn print-hide${playing ? ' is-playing' : ''}`}
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
        <span className="pronunciation-prefix" title={prefixTitle}>
          {effectivePrefix}:
        </span>
      )}
      {!iconOnly && primaryGuide && (
        <span
          className="pronunciation-guide"
          title={secondaryIpa ? `IPA: ${secondaryIpa}` : undefined}
        >
          {primaryGuide}
        </span>
      )}
      {!iconOnly && !compact && secondaryIpa && (
        <span className="pronunciation-ipa" aria-label={`IPA ${secondaryIpa}`}>
          {secondaryIpa}
        </span>
      )}
      {!iconOnly && language && (
        <span className="pronunciation-lang" title={`Language: ${language}`}>
          {language}
        </span>
      )}
      {!iconOnly && !compact && note && <span className="pronunciation-note">{note}</span>}
      {!iconOnly && !compact && (sourceLabel || safeSourceUrl) && (
        <span className="pronunciation-source">
          {safeSourceUrl ? (
            <a
              href={safeSourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pronunciation-source-link"
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
          className="pronunciation-variants print-hide"
          role="group"
          aria-label={KINLOOM_VOCABULARY.pronunciation.variantsAria}
        >
          <button
            type="button"
            className={`pronunciation-variant-btn${effectiveVariantIdx === null ? ' is-active' : ''}`}
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
              key={`${variant.label}-${idx}`}
              type="button"
              className={`pronunciation-variant-btn${effectiveVariantIdx === idx ? ' is-active' : ''}`}
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
