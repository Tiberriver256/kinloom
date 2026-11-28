import type React from 'react';
import { Link } from 'react-router-dom';
import { formatDurationSeconds } from '../../components/MediaPlayer.js';
import { cx } from '../../lib/cx.js';
import { buildNarrativeAudioDownload } from '../../lib/narrativeAudioDownload.js';
import audioPluginStyles from '../narrativeAudioPlugin.module.css';
import {
  type ActiveNarrativeAudioTrack,
  resolveNarrativeAudioLabels,
  useNarrativeAudio,
} from './audioContext.js';

const DownloadIcon: React.FC = () => (
  <svg
    className={cx(audioPluginStyles, 'narrative-audio-download-icon')}
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M8 2.5v7.5" />
    <path d="M4.75 7.25 8 10.5l3.25-3.25" />
    <path d="M2.75 13h10.5" />
  </svg>
);

export const NarrativeAudioMarginBar: React.FC<{ readonly track: ActiveNarrativeAudioTrack }> = ({
  track,
}) => {
  const audio = useNarrativeAudio();
  if (!audio) {
    return null;
  }

  const isThisTrack = audio.activeTrack?.narrativeId === track.narrativeId;
  const isPlayingThis = isThisTrack && audio.isPlaying;
  const trackError = isThisTrack ? audio.playbackError : null;
  const labels = resolveNarrativeAudioLabels(track);
  const currentSec = isThisTrack ? audio.currentTime : 0;
  const totalSec = (isThisTrack ? audio.duration : track.duration) ?? 0;
  const notesStart = track.editorNotesStart;
  const inNotes = notesStart !== null && currentSec >= notesStart;

  const pct = totalSec > 0 ? Math.min(100, (currentSec / totalSec) * 100) : 0;
  const splitPct = notesStart !== null && totalSec > 0 ? Math.min(100, (notesStart / totalSec) * 100) : 100;

  const currentLabel = formatDurationSeconds(currentSec) ?? '0:00';
  const totalLabel = totalSec > 0 ? formatDurationSeconds(totalSec) : null;
  const notesStartLabel = notesStart !== null ? formatDurationSeconds(notesStart) : null;
  const download = buildNarrativeAudioDownload(track);

  return (
    <div
      className={cx(
        audioPluginStyles,
        `narrative-audio-margin-bar print-hide ${inNotes ? 'is-notes' : 'is-story'}`
      )}
      data-testid="narrative-audio-margin-bar"
      role="region"
      aria-label={`Audio narration for ${track.narrativeTitle}`}
    >
      <button
        type="button"
        className={cx(audioPluginStyles, `narrative-audio-play-btn ${inNotes ? 'is-notes' : 'is-story'}`)}
        onClick={() => {
          audio.toggleTrack(track);
        }}
        aria-label={isPlayingThis ? `Pause ${track.narrativeTitle}` : `Listen to ${track.narrativeTitle}`}
        aria-pressed={isPlayingThis}
      >
        <span aria-hidden="true">{isPlayingThis ? '❚❚' : '▶'}</span>
      </button>

      <div className={cx(audioPluginStyles, 'narrative-audio-bar-main')}>
        <div className={cx(audioPluginStyles, 'narrative-audio-bar-top')}>
          <span
            className={cx(
              audioPluginStyles,
              `narrative-audio-voice-label ${inNotes ? 'is-notes' : 'is-story'}`
            )}
          >
            {inNotes ? `Editor's Notes · ${track.notesVoice}` : `${labels.marginLabel} · ${track.storyVoice}`}
          </span>
          <span className={cx(audioPluginStyles, 'narrative-audio-time')}>
            {totalLabel ? `${currentLabel} / ${totalLabel}` : currentLabel}
          </span>
        </div>

        <div className={cx(audioPluginStyles, 'narrative-audio-scrub-wrap')}>
          <div className={cx(audioPluginStyles, 'narrative-audio-scrub-track')} aria-hidden="true">
            <div
              className={cx(audioPluginStyles, 'narrative-audio-scrub-bg-story')}
              style={{ width: `${splitPct}%` }}
            />
            {notesStart !== null && splitPct < 100 && (
              <div
                className={cx(audioPluginStyles, 'narrative-audio-scrub-bg-notes')}
                style={{ left: `${splitPct}%`, width: `${100 - splitPct}%` }}
              />
            )}
            <div
              className={cx(audioPluginStyles, 'narrative-audio-scrub-fill-story')}
              style={{ width: `${Math.min(pct, splitPct)}%` }}
            />
            {notesStart !== null && pct > splitPct && (
              <div
                className={cx(audioPluginStyles, 'narrative-audio-scrub-fill-notes')}
                style={{ left: `${splitPct}%`, width: `${pct - splitPct}%` }}
              />
            )}
            {notesStart !== null && splitPct < 100 && (
              <div
                className={cx(audioPluginStyles, 'narrative-audio-scrub-divider')}
                style={{ left: `${splitPct}%` }}
              />
            )}
          </div>
          <input
            type="range"
            min={0}
            max={totalSec > 0 ? totalSec : 100}
            step={1}
            value={Math.min(currentSec, totalSec > 0 ? totalSec : 100)}
            disabled={totalSec <= 0}
            className={cx(audioPluginStyles, 'narrative-audio-scrub-input')}
            aria-label={`Seek position for ${track.narrativeTitle}`}
            onChange={(event) => {
              audio.seekTrack(track, Number(event.target.value));
            }}
          />
        </div>
      </div>

      <div className={cx(audioPluginStyles, 'narrative-audio-bar-controls')}>
        <button
          type="button"
          className={cx(audioPluginStyles, 'narrative-audio-pill')}
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
            className={cx(
              audioPluginStyles,
              `narrative-audio-pill narrative-audio-jump-btn ${inNotes ? 'is-return' : 'is-notes'}`
            )}
            onClick={() => {
              audio.seekTrack(track, inNotes ? 0 : notesStart, true);
            }}
          >
            {inNotes ? labels.returnLabel : `↪ Editor's notes ${notesStartLabel}`}
          </button>
        )}

        {download.href && (
          <a
            href={download.href}
            download={download.filename}
            className={cx(audioPluginStyles, 'narrative-audio-pill narrative-audio-download-btn')}
            data-testid="narrative-audio-download-link"
            aria-label={`Download ${download.formatLabel} for ${track.narrativeTitle}`}
          >
            <DownloadIcon />
            <span>Download {download.formatLabel}</span>
          </a>
        )}
      </div>
      {trackError && (
        <div
          className={cx(audioPluginStyles, 'narrative-audio-error')}
          role="alert"
          data-testid="narrative-audio-error"
        >
          {trackError}
        </div>
      )}
    </div>
  );
};

export const NarrativeAudioDock: React.FC = () => {
  const audio = useNarrativeAudio();
  if (!audio?.activeTrack) {
    return null;
  }

  const { activeTrack, isPlaying, playbackError, currentTime, duration, playbackRate } = audio;
  const labels = resolveNarrativeAudioLabels(activeTrack);
  const notesStart = activeTrack.editorNotesStart;
  const inNotes = notesStart !== null && currentTime >= notesStart;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const currentLabel = formatDurationSeconds(currentTime) ?? '0:00';
  const totalLabel = duration > 0 ? formatDurationSeconds(duration) : null;
  const download = buildNarrativeAudioDownload(activeTrack);

  return (
    <aside
      className={cx(audioPluginStyles, 'narrative-audio-dock print-hide')}
      data-testid="narrative-audio-dock"
      aria-label="Persistent narrative audio player"
    >
      <div className={cx(audioPluginStyles, 'narrative-audio-dock-progress')} aria-hidden="true">
        <div
          className={cx(
            audioPluginStyles,
            `narrative-audio-dock-progress-fill ${inNotes ? 'is-notes' : 'is-story'}`
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className={cx(audioPluginStyles, 'narrative-audio-dock-inner')}>
        <div className={cx(audioPluginStyles, 'narrative-audio-dock-meta')}>
          <span
            className={cx(
              audioPluginStyles,
              `narrative-audio-dock-badge ${inNotes ? 'is-notes' : 'is-story'}`
            )}
            aria-hidden="true"
          >
            {activeTrack.personInitials}
          </span>
          <div className={cx(audioPluginStyles, 'narrative-audio-dock-titles')}>
            <div className={cx(audioPluginStyles, 'narrative-audio-dock-title')}>
              {activeTrack.personSlug && activeTrack.personName ? (
                <Link
                  to={`/person/${activeTrack.personSlug}`}
                  className={cx(audioPluginStyles, 'narrative-audio-dock-link')}
                >
                  {activeTrack.personName}
                </Link>
              ) : null}
              {activeTrack.personName ? (
                <span className={cx(audioPluginStyles, 'narrative-audio-dock-sep')}> · </span>
              ) : null}
              <span>{activeTrack.narrativeTitle}</span>
            </div>
            <div className={cx(audioPluginStyles, 'narrative-audio-dock-sub')}>
              {inNotes
                ? `Editor's Notes (${activeTrack.notesVoice})`
                : `${labels.dockLabel} (${activeTrack.storyVoice})`}
              {' · '}
              <span>{totalLabel ? `${currentLabel} / ${totalLabel}` : currentLabel}</span>
            </div>
            {playbackError && (
              <div
                className={cx(audioPluginStyles, 'narrative-audio-dock-error')}
                role="alert"
                data-testid="narrative-audio-dock-error"
              >
                {playbackError}
              </div>
            )}
          </div>
        </div>

        <div className={cx(audioPluginStyles, 'narrative-audio-dock-controls')}>
          <button
            type="button"
            className={cx(audioPluginStyles, 'narrative-audio-dock-btn')}
            onClick={() => {
              audio.skip(-15);
            }}
            aria-label="Rewind 15 seconds"
          >
            -15s
          </button>
          <button
            type="button"
            className={cx(audioPluginStyles, 'narrative-audio-dock-play')}
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
            className={cx(audioPluginStyles, 'narrative-audio-dock-btn')}
            onClick={() => {
              audio.skip(15);
            }}
            aria-label="Forward 15 seconds"
          >
            +15s
          </button>
          <button
            type="button"
            className={cx(audioPluginStyles, 'narrative-audio-dock-btn')}
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
              className={cx(audioPluginStyles, 'narrative-audio-dock-btn')}
              onClick={() => {
                audio.seek(inNotes ? 0 : notesStart);
              }}
            >
              {inNotes ? labels.returnLabel : 'Notes'}
            </button>
          )}
          {download.href && (
            <a
              href={download.href}
              download={download.filename}
              className={cx(audioPluginStyles, 'narrative-audio-dock-btn narrative-audio-dock-download')}
              data-testid="narrative-audio-dock-download-link"
              aria-label={`Download ${download.formatLabel} for ${activeTrack.narrativeTitle}`}
              title={`Download ${download.formatLabel}`}
            >
              <DownloadIcon />
            </a>
          )}
          <button
            type="button"
            className={cx(audioPluginStyles, 'narrative-audio-dock-dismiss')}
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
