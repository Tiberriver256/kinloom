import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../lib/cx.js';
import audioPluginStyles from '../narrativeAudioPlugin.module.css';

export interface NarrativeAudioTrackMeta {
  readonly file: string;
  readonly duration_seconds?: number;
  readonly editor_notes_start_seconds?: number;
  readonly story_voice?: string;
  readonly notes_voice?: string;
}

export interface ActiveNarrativeAudioTrack {
  readonly narrativeId: string;
  readonly narrativeTitle: string;
  readonly personName: string | null;
  readonly personSlug: string | null;
  readonly personInitials: string;
  readonly src: string;
  readonly duration: number | null;
  readonly editorNotesStart: number | null;
  readonly storyVoice: string;
  readonly notesVoice: string;
}

export interface NarrativeAudioPluginOptions {
  /** Plugin id override. Defaults to `'kinloom-narrative-audio'`. */
  readonly id?: string;
  /** Default story voice label when not specified on the narrative extension. Defaults to `'Charon'`. */
  readonly defaultStoryVoice?: string;
  /** Default editor's notes voice label when not specified on the narrative extension. Defaults to `'Kore'`. */
  readonly defaultNotesVoice?: string;
}

const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 0.85] as const;

export interface NarrativeAudioContextValue {
  readonly activeTrack: ActiveNarrativeAudioTrack | null;
  readonly isPlaying: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly playbackRate: number;
  readonly toggleTrack: (track: ActiveNarrativeAudioTrack) => void;
  readonly togglePlayPause: () => void;
  readonly seek: (seconds: number) => void;
  readonly seekTrack: (track: ActiveNarrativeAudioTrack, seconds: number, autoPlay?: boolean) => void;
  readonly skip: (deltaSeconds: number) => void;
  readonly cycleSpeed: () => void;
  readonly dismiss: () => void;
}

const NarrativeAudioContext = createContext<NarrativeAudioContextValue | null>(null);

export function useNarrativeAudio(): NarrativeAudioContextValue | null {
  return useContext(NarrativeAudioContext);
}

export const NarrativeAudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeTrack, setActiveTrack] = useState<ActiveNarrativeAudioTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [measuredDuration, setMeasuredDuration] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const pendingSeekRef = useRef<number | null>(null);

  const duration = measuredDuration ?? activeTrack?.duration ?? 0;

  const safePlay = useCallback((el: HTMLAudioElement) => {
    try {
      const result = el.play();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          // Ignore autoplay/jsdom rejections while preserving UI intent.
        });
      }
    } catch {
      // jsdom does not implement HTMLMediaElement.prototype.play
    }
  }, []);

  const safePause = useCallback((el: HTMLAudioElement) => {
    try {
      el.pause();
    } catch {
      // jsdom does not implement HTMLMediaElement.prototype.pause
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-apply playbackRate when activeTrack mounts or changes
  useEffect(() => {
    const el = audioRef.current;
    if (!el) {
      return;
    }
    el.playbackRate = playbackRate;
  }, [playbackRate, activeTrack]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !activeTrack) {
      return;
    }
    if (pendingSeekRef.current !== null) {
      const target = pendingSeekRef.current;
      pendingSeekRef.current = null;
      el.currentTime = target;
      setCurrentTime(target);
    }
    if (isPlaying) {
      safePlay(el);
    } else {
      safePause(el);
    }
  }, [activeTrack, isPlaying, safePlay, safePause]);

  const toggleTrack = useCallback(
    (track: ActiveNarrativeAudioTrack) => {
      if (activeTrack?.narrativeId === track.narrativeId) {
        setIsPlaying((prev) => !prev);
        return;
      }
      setActiveTrack(track);
      setMeasuredDuration(track.duration);
      setCurrentTime(0);
      pendingSeekRef.current = 0;
      setIsPlaying(true);
    },
    [activeTrack]
  );

  const togglePlayPause = useCallback(() => {
    if (!activeTrack) {
      return;
    }
    setIsPlaying((prev) => !prev);
  }, [activeTrack]);

  const seek = useCallback(
    (seconds: number) => {
      const max = duration > 0 ? duration : Number.POSITIVE_INFINITY;
      const clamped = Math.max(0, Math.min(seconds, max));
      setCurrentTime(clamped);
      if (audioRef.current) {
        audioRef.current.currentTime = clamped;
      }
    },
    [duration]
  );

  const seekTrack = useCallback(
    (track: ActiveNarrativeAudioTrack, seconds: number, autoPlay = false) => {
      const max = track.duration && track.duration > 0 ? track.duration : Number.POSITIVE_INFINITY;
      const clamped = Math.max(0, Math.min(seconds, max));
      if (activeTrack?.narrativeId === track.narrativeId) {
        seek(clamped);
        if (autoPlay) {
          setIsPlaying(true);
        }
        return;
      }
      setActiveTrack(track);
      setMeasuredDuration(track.duration);
      setCurrentTime(clamped);
      pendingSeekRef.current = clamped;
      if (autoPlay) {
        setIsPlaying(true);
      }
    },
    [activeTrack, seek]
  );

  const skip = useCallback(
    (deltaSeconds: number) => {
      seek(currentTime + deltaSeconds);
    },
    [currentTime, seek]
  );

  const cycleSpeed = useCallback(() => {
    setPlaybackRate((prev) => {
      const idx = PLAYBACK_SPEEDS.indexOf(prev as (typeof PLAYBACK_SPEEDS)[number]);
      return PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length];
    });
  }, []);

  const dismiss = useCallback(() => {
    if (audioRef.current) {
      safePause(audioRef.current);
      audioRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setActiveTrack(null);
    setCurrentTime(0);
    setMeasuredDuration(null);
  }, [safePause]);

  const ctxValue = useMemo<NarrativeAudioContextValue>(
    () => ({
      activeTrack,
      isPlaying,
      currentTime,
      duration,
      playbackRate,
      toggleTrack,
      togglePlayPause,
      seek,
      seekTrack,
      skip,
      cycleSpeed,
      dismiss,
    }),
    [
      activeTrack,
      isPlaying,
      currentTime,
      duration,
      playbackRate,
      toggleTrack,
      togglePlayPause,
      seek,
      seekTrack,
      skip,
      cycleSpeed,
      dismiss,
    ]
  );

  return (
    <NarrativeAudioContext.Provider value={ctxValue}>
      {children}
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: persistent hidden audio element controlled by custom player buttons */}
      <audio
        ref={audioRef}
        src={activeTrack?.src}
        preload="metadata"
        className={cx(audioPluginStyles, 'narrative-audio-hidden-el')}
        aria-hidden="true"
        onTimeUpdate={(event) => {
          setCurrentTime(event.currentTarget.currentTime);
        }}
        onLoadedMetadata={(event) => {
          const d = event.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) {
            setMeasuredDuration(d);
          }
        }}
        onEnded={() => {
          setIsPlaying(false);
        }}
      />
    </NarrativeAudioContext.Provider>
  );
};
