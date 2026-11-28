import type { KinloomTutorialStep } from '@kinloom/core';
import type React from 'react';
import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../../browser/motion.js';
import { cx } from '../../lib/cx.js';
import { resolveTutorialMediaMode } from '../../lib/tutorialModel.js';
import styles from './TutorialModal.module.css';

export interface TutorialMediaStageProps {
  readonly step: KinloomTutorialStep;
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly baseUrl: string;
  readonly mediaBaseUrl?: string | undefined;
  readonly reducedMotionOverride?: boolean | undefined;
}

export const TutorialMediaStage: React.FC<TutorialMediaStageProps> = ({
  step,
  stepIndex,
  totalSteps,
  baseUrl,
  mediaBaseUrl,
  reducedMotionOverride,
}) => {
  const [videoFailed, setVideoFailed] = useState(false);

  // Reset video error state whenever the active step changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset media error state per step id
  useEffect(() => {
    setVideoFailed(false);
  }, [step.id]);

  const reducedMotion = reducedMotionOverride ?? prefersReducedMotion();
  const mode = resolveTutorialMediaMode({
    step,
    reducedMotion,
    videoFailed,
    mediaBaseUrl,
    baseUrl,
  });

  if (mode.kind === 'video') {
    return (
      <div className={cx(styles, 'tutorial-media-frame')} data-testid="tutorial-video-stage">
        <video
          key={step.id}
          className={cx(styles, 'tutorial-video')}
          controls
          preload="metadata"
          playsInline
          poster={mode.posterUrl}
          aria-label={mode.posterAlt}
          onError={() => {
            setVideoFailed(true);
          }}
        >
          {mode.webmUrl && <source src={mode.webmUrl} type="video/webm" />}
          {mode.mp4Url && <source src={mode.mp4Url} type="video/mp4" />}
          {mode.captionsVttUrl && (
            <track kind="captions" src={mode.captionsVttUrl} srcLang="en" label="English captions" default />
          )}
        </video>
      </div>
    );
  }

  if (mode.kind === 'static-slide') {
    const reasonNote =
      mode.reason === 'reduced-motion'
        ? 'Showing static visual guide (reduced motion active).'
        : mode.reason === 'video-error'
          ? 'Video preview unavailable — showing static visual guide.'
          : 'Visual reference slide.';
    return (
      <div className={cx(styles, 'tutorial-media-frame')} data-testid="tutorial-slide-stage">
        <figure className={cx(styles, 'tutorial-slide-figure')}>
          <img
            src={mode.posterUrl}
            alt={mode.posterAlt}
            loading="lazy"
            className={cx(styles, 'tutorial-slide-img')}
          />
          <figcaption className={cx(styles, 'tutorial-slide-caption')}>{reasonNote}</figcaption>
        </figure>
      </div>
    );
  }

  return (
    <div className={cx(styles, 'tutorial-media-frame')} data-testid="tutorial-card-stage">
      <div className={cx(styles, 'tutorial-card-stage')}>
        <div className={cx(styles, 'tutorial-card-top')}>
          <span className={cx(styles, 'tutorial-step-badge')}>
            Step {stepIndex + 1} of {totalSteps}
          </span>
          {step.targetRoute && <code className={cx(styles, 'tutorial-route-badge')}>{step.targetRoute}</code>}
        </div>
        <h4 className={cx(styles, 'tutorial-step-title')}>{step.title}</h4>
        <p className={cx(styles, 'tutorial-step-instructions')}>{step.instructions}</p>
        {step.highlights && step.highlights.length > 0 && (
          <ul className={cx(styles, 'tutorial-highlights')}>
            {step.highlights.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
