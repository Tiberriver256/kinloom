import type React from 'react';
import { AbsoluteFill, Audio, Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TutorialCallout } from '../schema.ts';
import type { TimedCaptionCue } from '../vtt.ts';
import type { ArchivalVideoPalette } from './tokens.ts';

export interface TutorialStepCompositionProps {
  readonly chapterId: string;
  readonly chapterTitle: string;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly stepNumber: number;
  readonly totalSteps: number;
  readonly frameUrls: readonly string[];
  readonly audioUrl?: string;
  readonly callout?: TutorialCallout;
  readonly cues: readonly TimedCaptionCue[];
  readonly durationInFrames: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly palette: ArchivalVideoPalette;
}

export const TutorialChapterComposition: React.FC<TutorialStepCompositionProps> = ({
  chapterTitle,
  stepTitle,
  stepNumber,
  totalSteps,
  frameUrls,
  audioUrl,
  callout,
  cues,
  palette,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const currentSec = frame / fps;
  const progressPct = Math.min(100, Math.max(0, (frame / Math.max(1, durationInFrames - 1)) * 100));

  const frameIdx =
    frameUrls.length > 1
      ? Math.min(frameUrls.length - 1, Math.floor((frame / Math.max(1, durationInFrames)) * frameUrls.length))
      : 0;
  const activeFrameUrl = frameUrls[frameIdx];

  const activeCue = cues.find((cue) => currentSec >= cue.startSeconds && currentSec <= cue.endSeconds);
  const calloutPulse = interpolate(frame % Math.max(1, fps), [0, fps / 2, fps], [0.75, 1, 0.75], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.surfaceCanvas,
        color: palette.textPrimary,
        fontFamily: palette.fontSerif,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {audioUrl ? <Audio src={audioUrl} /> : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 28px',
          backgroundColor: palette.surfaceHeader,
          color: palette.textInverse,
          borderBottom: `2px solid ${palette.accentPrimary}`,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontFamily: palette.fontMono,
              fontSize: 14,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              opacity: 0.88,
            }}
          >
            Kinloom Guide · Step {stepNumber} of {totalSteps}
          </span>
          <span style={{ fontSize: 24, fontWeight: 700 }}>
            {chapterTitle} — {stepTitle}
          </span>
        </div>
      </div>

      <div
        style={{
          position: 'relative',
          flex: 1,
          margin: '18px 28px',
          borderRadius: 6,
          overflow: 'hidden',
          border: `1px solid ${palette.borderControl}`,
          backgroundColor: palette.surfaceCard,
        }}
      >
        {activeFrameUrl ? (
          <Img
            src={activeFrameUrl}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 40,
              fontSize: 28,
              color: palette.surfaceHeader,
            }}
          >
            {stepTitle}
          </div>
        )}

        {callout ? (
          <div
            style={{
              position: 'absolute',
              left: callout.x,
              top: callout.y,
              width: callout.width,
              height: callout.height,
              border: `3px solid ${palette.accentPrimary}`,
              borderRadius: 6,
              opacity: calloutPulse,
              boxSizing: 'border-box',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: -30,
                left: 0,
                backgroundColor: palette.accentPrimary,
                color: palette.textInverse,
                fontFamily: palette.fontMono,
                fontSize: 13,
                fontWeight: 700,
                padding: '3px 8px',
                borderRadius: 4,
                whiteSpace: 'nowrap',
              }}
            >
              {callout.label}
            </span>
          </div>
        ) : null}

        {activeCue ? (
          <div
            style={{
              position: 'absolute',
              left: 36,
              right: 36,
              bottom: 18,
              backgroundColor: 'rgba(27, 42, 65, 0.92)',
              color: '#FCF9F2',
              padding: '10px 18px',
              borderRadius: 6,
              fontSize: 20,
              lineHeight: 1.4,
              textAlign: 'center',
            }}
          >
            {activeCue.text}
          </div>
        ) : null}
      </div>

      <div
        style={{
          height: 8,
          width: '100%',
          backgroundColor: palette.surfaceLinen,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${progressPct}%`,
            backgroundColor: palette.accentPrimary,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
