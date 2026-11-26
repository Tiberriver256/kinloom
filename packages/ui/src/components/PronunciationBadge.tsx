import type { Pronunciation } from '@kinloom/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { resolveAssetUrl } from './Atoms.js';

export interface PronunciationBadgeProps {
  pronunciation?: Pronunciation | null;
  label: string;
  baseUrl?: string;
  compact?: boolean;
  className?: string;
}

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

export function hasPronunciationContent(pronunciation?: Pronunciation | null): boolean {
  if (!pronunciation) {
    return false;
  }
  return Boolean(
    pronunciation.phonetic?.trim() ||
      pronunciation.ipa?.trim() ||
      pronunciation.audio_url?.trim() ||
      pronunciation.note?.trim(),
  );
}

export const PronunciationBadge: React.FC<PronunciationBadgeProps> = ({
  pronunciation,
  label,
  baseUrl,
  compact = false,
  className,
}) => {
  const [playing, setPlaying] = useState(false);
  const stopSelfRef = useRef<(() => void) | null>(null);

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

      const audioUrl = pronunciation?.audio_url?.trim();
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
        const spokenText = pronunciation?.phonetic?.trim() || label;
        const utterance = new SpeechSynthesisUtterance(spokenText);
        if (pronunciation?.language?.trim()) {
          utterance.lang = pronunciation.language.trim();
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
    [playing, pronunciation, baseUrl, label],
  );

  if (!pronunciation || !hasPronunciationContent(pronunciation)) {
    return null;
  }

  const phonetic = pronunciation.phonetic?.trim() || '';
  const ipa = pronunciation.ipa?.trim() || '';
  const language = pronunciation.language?.trim() || '';
  const note = pronunciation.note?.trim() || '';
  const primaryGuide = phonetic || ipa;
  const secondaryIpa = phonetic && ipa ? ipa : '';

  const rootClassName = [
    'pronunciation-badge',
    compact ? 'is-compact' : '',
    playing ? 'is-playing' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={rootClassName}>
      {primaryGuide && (
        <span
          className="pronunciation-guide"
          title={secondaryIpa ? `IPA: ${secondaryIpa}` : undefined}
        >
          {primaryGuide}
        </span>
      )}
      {!compact && secondaryIpa && (
        <span className="pronunciation-ipa" aria-label={`IPA ${secondaryIpa}`}>
          {secondaryIpa}
        </span>
      )}
      {language && (
        <span className="pronunciation-lang" title={`Language: ${language}`}>
          {language}
        </span>
      )}
      <button
        type="button"
        className={`pronunciation-play-btn print-hide${playing ? ' is-playing' : ''}`}
        aria-label={`Listen to pronunciation of ${label}`}
        aria-pressed={playing}
        title={playing ? `Stop pronunciation of ${label}` : `Listen to pronunciation of ${label}`}
        onClick={handleTogglePlay}
      >
        <span aria-hidden="true">🔊</span>
      </button>
      {!compact && note && <span className="pronunciation-note">{note}</span>}
    </span>
  );
};
