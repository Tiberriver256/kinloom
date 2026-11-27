import type { MediaItem } from '@kinloom/core';
import type React from 'react';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import cssMod3 from '../pages/IndexPage.module.css';
import cssMod4 from '../pages/PersonPage.module.css';
import { useKinloomPlugins } from '../plugins/PluginContext.js';
import { resolveAssetUrl } from './Atoms.js';
import cssMod0 from './Atoms.module.css';
import cssMod1 from './SourceReaderDrawer.module.css';
import cssMod2 from './wiki/WikiSurfaces.module.css';

const uiStyles: Readonly<Record<string, string>> = {
  ...cssMod0,
  ...cssMod1,
  ...cssMod2,
  ...cssMod3,
  ...cssMod4,
};

export interface MediaPlayerProps {
  media: MediaItem;
  baseUrl?: string;
  /** Render compact card preview (poster/thumbnail) vs full interactive player. */
  variant?: 'preview' | 'full';
  className?: string;
}

export function isVideoMedia(media: MediaItem): boolean {
  if (media.kind === 'video_story') {
    return true;
  }
  const mime = media.mime_type?.toLowerCase() ?? '';
  if (mime.startsWith('video/')) {
    return true;
  }
  return /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(media.file);
}

export function isAudioMedia(media: MediaItem): boolean {
  if (media.kind === 'audio_oral_history') {
    return true;
  }
  const mime = media.mime_type?.toLowerCase() ?? '';
  if (mime.startsWith('audio/')) {
    return true;
  }
  return /\.(mp3|m4a|ogg|wav|flac)(\?.*)?$/i.test(media.file);
}

export function isPdfMedia(media: MediaItem): boolean {
  const mime = media.mime_type?.toLowerCase() ?? '';
  if (mime === 'application/pdf') {
    return true;
  }
  return /\.pdf(\?.*)?$/i.test(media.file);
}

export function formatDurationSeconds(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export const MediaPlayer: React.FC<MediaPlayerProps> = ({ media, baseUrl, variant = 'full', className }) => {
  const { mediaRenderers } = useKinloomPlugins();
  const { baseUrl: contextBaseUrl } = useArchiveData();
  const effectiveBase = baseUrl ?? contextBaseUrl;
  const src = resolveAssetUrl(media.file, effectiveBase);
  const posterSrc = media.poster_url ? resolveAssetUrl(media.poster_url, effectiveBase) : undefined;
  const transcriptSrc = media.transcript_url
    ? resolveAssetUrl(media.transcript_url, effectiveBase)
    : undefined;
  const durationLabel = formatDurationSeconds(media.duration_seconds);

  // 1. Check plugin mediaRenderers first so private family sites can mount custom players.
  for (const renderer of mediaRenderers) {
    if (renderer.match(media)) {
      return (
        <div className={cx(uiStyles, className ?? 'media-player-plugin-wrap')}>
          {renderer.render({ media, src })}
        </div>
      );
    }
  }

  // 2. Native HTML5 video for video_story / video/* MIME types.
  if (isVideoMedia(media)) {
    if (variant === 'preview' && posterSrc) {
      return (
        <div className={cx(uiStyles, className ?? 'media-player-preview media-player-video-preview')}>
          <img
            src={posterSrc}
            alt={media.caption}
            className={cx(uiStyles, 'person-media-thumb')}
            loading="lazy"
          />
          <span className={cx(uiStyles, 'media-play-badge')} aria-hidden="true">
            ▶ {durationLabel ?? 'Video'}
          </span>
        </div>
      );
    }
    return (
      <div className={cx(uiStyles, className ?? 'media-player-shell media-player-video')}>
        <video
          controls
          playsInline
          preload="metadata"
          poster={posterSrc}
          className={cx(uiStyles, 'media-player-video-el')}
          aria-label={media.caption}
        >
          <source src={src} type={media.mime_type ?? undefined} />
          {transcriptSrc && <track kind="captions" src={transcriptSrc} label="Transcript captions" default />}
        </video>
        {durationLabel && <div className={cx(uiStyles, 'media-player-meta')}>Duration: {durationLabel}</div>}
      </div>
    );
  }

  // 3. Native HTML5 audio for audio_oral_history / audio/* MIME types.
  if (isAudioMedia(media)) {
    if (variant === 'preview') {
      return (
        <div className={cx(uiStyles, className ?? 'media-player-preview media-player-audio-preview')}>
          <span className={cx(uiStyles, 'media-audio-glyph')} aria-hidden="true">
            ♫
          </span>
          <span className={cx(uiStyles, 'media-audio-label')}>
            Oral History{durationLabel ? ` · ${durationLabel}` : ''}
          </span>
        </div>
      );
    }
    return (
      <div className={cx(uiStyles, className ?? 'media-player-shell media-player-audio')}>
        <audio
          controls
          preload="metadata"
          className={cx(uiStyles, 'media-player-audio-el')}
          aria-label={media.caption}
        >
          <source src={src} type={media.mime_type ?? undefined} />
        </audio>
        <div className={cx(uiStyles, 'media-player-meta')}>
          {durationLabel && <span>Duration: {durationLabel}</span>}
          {transcriptSrc && (
            <a href={transcriptSrc} target="_blank" rel="noreferrer" className={cx(uiStyles, 'ink-link-btn')}>
              Read transcript ↗
            </a>
          )}
        </div>
      </div>
    );
  }

  // 4. PDF archival document fallback.
  if (isPdfMedia(media)) {
    if (variant === 'preview') {
      return (
        <div className={cx(uiStyles, className ?? 'media-player-preview media-player-pdf-preview')}>
          <span className={cx(uiStyles, 'media-audio-glyph')} aria-hidden="true">
            PDF
          </span>
          <span className={cx(uiStyles, 'media-audio-label')}>Archival Document</span>
        </div>
      );
    }
    return (
      <div className={cx(uiStyles, className ?? 'media-player-shell media-player-pdf')}>
        <iframe title={media.caption} src={src} className={cx(uiStyles, 'media-player-pdf-frame')} />
        <div className={cx(uiStyles, 'media-player-meta')}>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className={cx(uiStyles, 'pill-btn')}
            style={{ textDecoration: 'none' }}
          >
            Open PDF in new tab ↗
          </a>
        </div>
      </div>
    );
  }

  // 5. Standard archival image.
  const imgSrc =
    variant === 'preview' && media.thumb_file ? resolveAssetUrl(media.thumb_file, effectiveBase) : src;
  return (
    <img
      src={imgSrc}
      alt={media.caption}
      loading="lazy"
      className={cx(
        uiStyles,
        className ?? (variant === 'preview' ? 'person-media-thumb' : 'scan-page-img-full')
      )}
    />
  );
};
