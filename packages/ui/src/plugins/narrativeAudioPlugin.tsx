import type { Narrative, Person } from '@kinloom/core';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { initialsOf, resolveAssetUrl } from '../components/Atoms.js';
import { formatDurationSeconds } from '../components/MediaPlayer.js';
import type { KinloomUiPlugin, KinloomUiPluginSlotContext } from './types.js';

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

function asPositiveFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Extracts validated `narrative_audio` metadata from `narrative.extensions`.
 * Returns `null` if the narrative has no attached narration audio.
 */
export function readNarrativeAudioMeta(narrative: Narrative | undefined): NarrativeAudioTrackMeta | null {
  if (!narrative?.extensions) {
    return null;
  }
  const raw = narrative.extensions.narrative_audio ?? narrative.extensions.audio;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const file = asNonEmptyString(record.file);
  if (!file) {
    return null;
  }
  const durationSeconds = asPositiveFiniteNumber(record.duration_seconds);
  const notesStart = asPositiveFiniteNumber(record.editor_notes_start_seconds);
  return {
    file,
    duration_seconds: durationSeconds,
    editor_notes_start_seconds:
      notesStart !== undefined && (durationSeconds === undefined || notesStart < durationSeconds)
        ? notesStart
        : undefined,
    story_voice: asNonEmptyString(record.story_voice),
    notes_voice: asNonEmptyString(record.notes_voice),
  };
}

function isLivingPerson(person: Person | undefined): boolean {
  if (!person) {
    return false;
  }
  return person.is_living || person.full_name === 'Living';
}

interface NarrativeAudioContextValue {
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

function useNarrativeAudio(): NarrativeAudioContextValue | null {
  return useContext(NarrativeAudioContext);
}

const NarrativeAudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
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
      {/* Single persistent audio element so playback survives route navigation */}
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- spoken biography mirrors the written narrative on the page */}
      <audio
        ref={audioRef}
        src={activeTrack?.src}
        preload="metadata"
        className="narrative-audio-hidden-el"
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

interface NarrativeAudioMarginBarProps {
  readonly track: ActiveNarrativeAudioTrack;
}

const NarrativeAudioMarginBar: React.FC<NarrativeAudioMarginBarProps> = ({ track }) => {
  const audio = useNarrativeAudio();
  if (!audio) {
    return null;
  }

  const isThisTrack = audio.activeTrack?.narrativeId === track.narrativeId;
  const isPlayingThis = isThisTrack && audio.isPlaying;
  const currentSec = isThisTrack ? audio.currentTime : 0;
  const totalSec = (isThisTrack ? audio.duration : track.duration) ?? 0;
  const notesStart = track.editorNotesStart;
  const inNotes = notesStart !== null && currentSec >= notesStart;

  const pct = totalSec > 0 ? Math.min(100, (currentSec / totalSec) * 100) : 0;
  const splitPct = notesStart !== null && totalSec > 0 ? Math.min(100, (notesStart / totalSec) * 100) : 100;

  const currentLabel = formatDurationSeconds(currentSec) ?? '0:00';
  const totalLabel = totalSec > 0 ? formatDurationSeconds(totalSec) : null;
  const notesStartLabel = notesStart !== null ? formatDurationSeconds(notesStart) : null;

  return (
    <div
      className={`narrative-audio-margin-bar print-hide ${inNotes ? 'is-notes' : 'is-story'}`}
      data-testid="narrative-audio-margin-bar"
      role="region"
      aria-label={`Audio narration for ${track.narrativeTitle}`}
    >
      <button
        type="button"
        className={`narrative-audio-play-btn ${inNotes ? 'is-notes' : 'is-story'}`}
        onClick={() => {
          audio.toggleTrack(track);
        }}
        aria-label={isPlayingThis ? `Pause ${track.narrativeTitle}` : `Listen to ${track.narrativeTitle}`}
        aria-pressed={isPlayingThis}
      >
        <span aria-hidden="true">{isPlayingThis ? '❚❚' : '▶'}</span>
      </button>

      <div className="narrative-audio-bar-main">
        <div className="narrative-audio-bar-top">
          <span className={`narrative-audio-voice-label ${inNotes ? 'is-notes' : 'is-story'}`}>
            {inNotes ? `Editor's Notes · ${track.notesVoice}` : `Listen to Biography · ${track.storyVoice}`}
          </span>
          <span className="narrative-audio-time">
            {totalLabel ? `${currentLabel} / ${totalLabel}` : currentLabel}
          </span>
        </div>

        <div className="narrative-audio-scrub-wrap">
          <div className="narrative-audio-scrub-track" aria-hidden="true">
            <div className="narrative-audio-scrub-bg-story" style={{ width: `${splitPct}%` }} />
            {notesStart !== null && splitPct < 100 && (
              <div
                className="narrative-audio-scrub-bg-notes"
                style={{ left: `${splitPct}%`, width: `${100 - splitPct}%` }}
              />
            )}
            <div
              className="narrative-audio-scrub-fill-story"
              style={{ width: `${Math.min(pct, splitPct)}%` }}
            />
            {notesStart !== null && pct > splitPct && (
              <div
                className="narrative-audio-scrub-fill-notes"
                style={{ left: `${splitPct}%`, width: `${pct - splitPct}%` }}
              />
            )}
            {notesStart !== null && splitPct < 100 && (
              <div className="narrative-audio-scrub-divider" style={{ left: `${splitPct}%` }} />
            )}
          </div>
          <input
            type="range"
            min={0}
            max={totalSec > 0 ? totalSec : 100}
            step={1}
            value={Math.min(currentSec, totalSec > 0 ? totalSec : 100)}
            disabled={totalSec <= 0}
            className="narrative-audio-scrub-input"
            aria-label={`Seek position for ${track.narrativeTitle}`}
            onChange={(event) => {
              audio.seekTrack(track, Number(event.target.value));
            }}
          />
        </div>
      </div>

      <div className="narrative-audio-bar-controls">
        <button
          type="button"
          className="narrative-audio-pill"
          onClick={() => {
            audio.cycleSpeed();
          }}
          aria-label={`Playback speed ${audio.playbackRate}x`}
        >
          {audio.playbackRate}×
        </button>

        {notesStart !== null && notesStartLabel && (
          <button
            type="button"
            className={`narrative-audio-pill narrative-audio-jump-btn ${inNotes ? 'is-return' : 'is-notes'}`}
            onClick={() => {
              audio.seekTrack(track, inNotes ? 0 : notesStart, true);
            }}
          >
            {inNotes ? '↩ Story' : `Editor's notes ${notesStartLabel}`}
          </button>
        )}
      </div>
    </div>
  );
};

const NarrativeAudioDock: React.FC = () => {
  const audio = useNarrativeAudio();
  if (!audio?.activeTrack) {
    return null;
  }

  const { activeTrack, isPlaying, currentTime, duration, playbackRate } = audio;
  const notesStart = activeTrack.editorNotesStart;
  const inNotes = notesStart !== null && currentTime >= notesStart;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const currentLabel = formatDurationSeconds(currentTime) ?? '0:00';
  const totalLabel = duration > 0 ? formatDurationSeconds(duration) : null;

  return (
    <aside
      className="narrative-audio-dock print-hide"
      data-testid="narrative-audio-dock"
      aria-label="Persistent narrative audio player"
    >
      <div className="narrative-audio-dock-progress" aria-hidden="true">
        <div
          className={`narrative-audio-dock-progress-fill ${inNotes ? 'is-notes' : 'is-story'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="narrative-audio-dock-inner">
        <div className="narrative-audio-dock-meta">
          <span
            className={`narrative-audio-dock-badge ${inNotes ? 'is-notes' : 'is-story'}`}
            aria-hidden="true"
          >
            {activeTrack.personInitials}
          </span>
          <div className="narrative-audio-dock-titles">
            <div className="narrative-audio-dock-title">
              {activeTrack.personSlug && activeTrack.personName ? (
                <Link to={`/person/${activeTrack.personSlug}`} className="narrative-audio-dock-link">
                  {activeTrack.personName}
                </Link>
              ) : null}
              {activeTrack.personName ? <span className="narrative-audio-dock-sep"> · </span> : null}
              <span>{activeTrack.narrativeTitle}</span>
            </div>
            <div className="narrative-audio-dock-sub">
              {inNotes
                ? `Editor's Notes (${activeTrack.notesVoice})`
                : `Biography Narration (${activeTrack.storyVoice})`}
              {' · '}
              <span>{totalLabel ? `${currentLabel} / ${totalLabel}` : currentLabel}</span>
            </div>
          </div>
        </div>

        <div className="narrative-audio-dock-controls">
          <button
            type="button"
            className="narrative-audio-dock-btn"
            onClick={() => {
              audio.skip(-15);
            }}
            aria-label="Rewind 15 seconds"
          >
            -15s
          </button>
          <button
            type="button"
            className="narrative-audio-dock-play"
            onClick={() => {
              audio.togglePlayPause();
            }}
            aria-label={isPlaying ? 'Pause narration' : 'Resume narration'}
            aria-pressed={isPlaying}
          >
            <span aria-hidden="true">{isPlaying ? '❚❚' : '▶'}</span>
          </button>
          <button
            type="button"
            className="narrative-audio-dock-btn"
            onClick={() => {
              audio.skip(15);
            }}
            aria-label="Forward 15 seconds"
          >
            +15s
          </button>
          <button
            type="button"
            className="narrative-audio-dock-btn"
            onClick={() => {
              audio.cycleSpeed();
            }}
            aria-label={`Playback speed ${playbackRate}x`}
          >
            {playbackRate}×
          </button>
          {notesStart !== null && (
            <button
              type="button"
              className="narrative-audio-dock-btn"
              onClick={() => {
                audio.seek(inNotes ? 0 : notesStart);
              }}
            >
              {inNotes ? '↩ Story' : 'Notes'}
            </button>
          )}
          <button
            type="button"
            className="narrative-audio-dock-dismiss"
            onClick={() => {
              audio.dismiss();
            }}
            aria-label="Close audio player"
            title="Close audio player"
          >
            ×
          </button>
        </div>
      </div>
    </aside>
  );
};

/**
 * Built-in Kinloom UI plugin for `narrative-audio` biographies.
 *
 * Mounts:
 * 1. An inline Archival Margin Player in `slots.narrativeHeader` whenever a deceased
 *    person's narrative includes `extensions.narrative_audio`.
 * 2. A persistent cross-page listening dock in `slots.appShell` so narration continues
 *    uninterrupted while browsing Map, Tree, Places, or Source scans.
 */
export function createNarrativeAudioPlugin(options: NarrativeAudioPluginOptions = {}): KinloomUiPlugin {
  const id = options.id ?? 'kinloom-narrative-audio';
  const defaultStoryVoice = options.defaultStoryVoice ?? 'Charon';
  const defaultNotesVoice = options.defaultNotesVoice ?? 'Kore';

  const renderNarrativeHeader = (ctx: KinloomUiPluginSlotContext): React.ReactNode => {
    if (!ctx.narrative || isLivingPerson(ctx.person)) {
      return null;
    }
    const meta = readNarrativeAudioMeta(ctx.narrative);
    if (!meta) {
      return null;
    }
    const track: ActiveNarrativeAudioTrack = {
      narrativeId: ctx.narrative.id,
      narrativeTitle: ctx.narrative.title,
      personName: ctx.person?.full_name ?? null,
      personSlug: ctx.person?.slug ?? null,
      personInitials: ctx.person ? initialsOf(ctx.person.full_name) : '♫',
      src: resolveAssetUrl(meta.file, ctx.baseUrl),
      duration: meta.duration_seconds ?? null,
      editorNotesStart: meta.editor_notes_start_seconds ?? null,
      storyVoice: meta.story_voice ?? defaultStoryVoice,
      notesVoice: meta.notes_voice ?? defaultNotesVoice,
    };
    return <NarrativeAudioMarginBar track={track} />;
  };

  return {
    id,
    name: 'Narrative Audio',
    provider: NarrativeAudioProvider,
    slots: {
      narrativeHeader: renderNarrativeHeader,
      appShell: () => <NarrativeAudioDock />,
    },
  };
}
