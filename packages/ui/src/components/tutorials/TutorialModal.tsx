import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { prefersReducedMotion } from '../../browser/motion.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useOptionalOnboarding } from '../../context/OnboardingContext.js';
import { useDialogFocusTrap } from '../../hooks/useDialogFocusTrap.js';
import { cx } from '../../lib/cx.js';
import {
  formatTutorialDuration,
  resolveInitialTutorialChapterId,
  resolveTutorialMediaMode,
} from '../../lib/tutorialModel.js';
import type { CompiledKinloomTutorialChapter } from '../../plugins/validatePlugins.js';
import { TutorialMediaStage } from './TutorialMediaStage.js';
import styles from './TutorialModal.module.css';

export interface TutorialModalProps {
  readonly reducedMotionOverride?: boolean;
}

export const TutorialModal: React.FC<TutorialModalProps> = ({ reducedMotionOverride }) => {
  const onboarding = useOptionalOnboarding();
  const { siteConfig, baseUrl } = useArchiveData();
  const navigate = useNavigate();

  const open = Boolean(onboarding?.tutorialModalOpen);
  const catalog = onboarding?.tutorialCatalog;
  const completedSet = useMemo(
    () => new Set<string>(onboarding?.state.completed_chapter_ids ?? []),
    [onboarding?.state.completed_chapter_ids]
  );

  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [suppressAutoOpenChecked, setSuppressAutoOpenChecked] = useState(true);

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const railButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const currentCatalog = catalogRef.current;
    if (!open || !currentCatalog) {
      return;
    }
    const initial = resolveInitialTutorialChapterId(currentCatalog, onboarding?.activeTutorialChapterId);
    setSelectedChapterId(initial);
    setStepIndex(0);
    setMobileRailOpen(false);
    setSuppressAutoOpenChecked(true);
  }, [open, onboarding?.activeTutorialChapterId]);

  const handleClose = useCallback((): void => {
    if (!onboarding) {
      return;
    }
    onboarding.closeTutorial({
      suppressAutoOpen:
        suppressAutoOpenChecked || onboarding.tutorialAutoOpened || onboarding.shouldAutoOpenTutorialModal,
    });
  }, [onboarding, suppressAutoOpenChecked]);

  const dialogRef = useDialogFocusTrap<HTMLDialogElement>({
    open,
    onClose: handleClose,
    initialFocusRef: closeBtnRef,
  });

  if (!open || !onboarding || !catalog || catalog.chapters.length === 0) {
    return null;
  }

  const activeChapter: CompiledKinloomTutorialChapter =
    catalog.chapters.find((chapter) => chapter.id === selectedChapterId) ?? catalog.chapters[0];
  const clampedStepIndex = Math.min(stepIndex, activeChapter.steps.length - 1);
  const activeStep = activeChapter.steps[clampedStepIndex];
  const isChapterComplete = completedSet.has(activeChapter.id);
  const isLastStep = clampedStepIndex >= activeChapter.steps.length - 1;
  const mediaBaseUrl = siteConfig.tutorials?.mediaBaseUrl;

  const reducedMotion = reducedMotionOverride ?? prefersReducedMotion();
  const initialMediaMode = resolveTutorialMediaMode({
    step: activeStep,
    reducedMotion,
    videoFailed: false,
    mediaBaseUrl,
    baseUrl,
  });

  const selectChapter = (chapterId: string): void => {
    setSelectedChapterId(chapterId);
    setStepIndex(0);
    setMobileRailOpen(false);
  };

  const handleRailKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, flatIndex: number): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const total = catalog.chapters.length;
    if (total === 0) {
      return;
    }
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIdx = (flatIndex + delta + total) % total;
    const nextChapter = catalog.chapters[nextIdx];
    if (nextChapter) {
      selectChapter(nextChapter.id);
      railButtonsRef.current[nextIdx]?.focus();
    }
  };

  const handleTryItNow = (): void => {
    if (!activeStep.targetRoute) {
      return;
    }
    onboarding.closeTutorial({ suppressAutoOpen: true });
    navigate(activeStep.targetRoute);
  };

  const handleCompleteChapter = (): void => {
    onboarding.completeChapter(activeChapter.id);
    const currentIdx = catalog.chapters.findIndex((c) => c.id === activeChapter.id);
    const nextIncomplete = catalog.chapters.find(
      (c, idx) => idx > currentIdx && c.id !== activeChapter.id && !completedSet.has(c.id)
    );
    if (nextIncomplete) {
      setSelectedChapterId(nextIncomplete.id);
      setStepIndex(0);
    }
  };

  const handleSkipToChecklist = (): void => {
    onboarding.dismissTutorialModal();
    onboarding.reopenChecklist();
    onboarding.closeTutorial({ suppressAutoOpen: true });
    const targetPath = onboarding.role === 'admin' ? '/admin' : '/';
    navigate(targetPath);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        document.getElementById('onboarding-checklist')?.focus({ preventScroll: false });
      }, 0);
    }
  };

  const showFirstLoginControls =
    onboarding.tutorialAutoOpened ||
    onboarding.shouldAutoOpenTutorialModal ||
    onboarding.state.tutorial_modal_dismissed_at === null;

  const renderChapterButton = (
    chapter: CompiledKinloomTutorialChapter,
    flatIndex: number
  ): React.ReactNode => {
    const isActive = chapter.id === activeChapter.id;
    const isDone = completedSet.has(chapter.id);
    const duration = formatTutorialDuration(chapter.estimatedSeconds);
    return (
      <li key={chapter.id}>
        <button
          ref={(el) => {
            railButtonsRef.current[flatIndex] = el;
          }}
          type="button"
          className={cx(styles, `tutorial-rail-btn${isActive ? ' is-active' : ''}`)}
          aria-current={isActive ? 'true' : undefined}
          onClick={() => {
            selectChapter(chapter.id);
          }}
          onKeyDown={(event) => {
            handleRailKeyDown(event, flatIndex);
          }}
        >
          <span className={cx(styles, 'tutorial-rail-btn-top')}>
            <span className={cx(styles, 'tutorial-rail-btn-title')}>{chapter.title}</span>
            {isDone && <span className={cx(styles, 'tutorial-done-badge')}>✓ Done</span>}
          </span>
          <span className={cx(styles, 'tutorial-rail-btn-meta')}>
            <span>
              {chapter.steps.length} {chapter.steps.length === 1 ? 'step' : 'steps'}
            </span>
            {duration && <span>{duration}</span>}
          </span>
        </button>
      </li>
    );
  };

  const showTranscriptOpenByDefault =
    initialMediaMode.kind === 'static-slide' && initialMediaMode.reason === 'reduced-motion';

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className={cx(styles, 'tutorial-backdrop')}
      data-testid="tutorial-modal"
    >
      <div className={cx(styles, 'tutorial-shell')}>
        <header className={cx(styles, 'tutorial-header')}>
          <div className={cx(styles, 'tutorial-header-top')}>
            <div className={cx(styles, 'tutorial-header-meta')}>
              <span className={cx(styles, 'tutorial-eyebrow')}>
                Interactive Tutorials · {catalog.completedCount} of {catalog.totalCount} complete
              </span>
              <h2 id={titleId} className={cx(styles, 'tutorial-title')}>
                Kinloom Archive Guide
              </h2>
            </div>
            <button
              ref={closeBtnRef}
              type="button"
              className={cx(styles, 'tutorial-close-btn')}
              onClick={handleClose}
            >
              Close
            </button>
          </div>
          <p id={descId} className={cx(styles, 'tutorial-desc')}>
            Step-by-step orientation tailored to your {onboarding.role} permissions. Reopen anytime from
            Guide.
          </p>
        </header>

        <div className={cx(styles, 'tutorial-mobile-picker-bar')}>
          <button
            type="button"
            className={cx(styles, 'tutorial-mobile-picker-btn')}
            aria-expanded={mobileRailOpen}
            onClick={() => {
              setMobileRailOpen((prev) => !prev);
            }}
          >
            <span className={cx(styles, 'tutorial-mobile-picker-current')}>{activeChapter.title}</span>
            <span>
              {mobileRailOpen
                ? 'Hide chapters ▴'
                : `Chapters (${catalog.completedCount}/${catalog.totalCount}) ▾`}
            </span>
          </button>
        </div>

        <div className={cx(styles, 'tutorial-body')}>
          <nav
            aria-label="Tutorial chapters"
            className={cx(styles, `tutorial-rail${mobileRailOpen ? ' is-mobile-open' : ''}`)}
          >
            <div>
              <p className={cx(styles, 'tutorial-rail-group-label')}>Core Archive Guide</p>
              <ul className={cx(styles, 'tutorial-rail-list')}>
                {catalog.coreChapters.map((chapter, idx) => renderChapterButton(chapter, idx))}
              </ul>
            </div>

            {catalog.pluginChapters.length > 0 && (
              <div>
                <p className={cx(styles, 'tutorial-rail-group-label')}>Installed Plugins</p>
                <ul className={cx(styles, 'tutorial-rail-list')}>
                  {catalog.pluginChapters.map((chapter, idx) =>
                    renderChapterButton(chapter, catalog.coreChapters.length + idx)
                  )}
                </ul>
              </div>
            )}
          </nav>

          <section className={cx(styles, 'tutorial-stage')} aria-label={activeChapter.title}>
            <div className={cx(styles, 'tutorial-stage-header')}>
              <div className={cx(styles, 'tutorial-stage-kicker-row')}>
                <span className={cx(styles, 'tutorial-source-pill')}>
                  {activeChapter.source === 'core' ? 'Core' : (activeChapter.pluginName ?? 'Plugin')}
                </span>
                <span className={cx(styles, 'tutorial-step-counter')}>
                  Step {clampedStepIndex + 1} of {activeChapter.steps.length}
                </span>
                {isChapterComplete && <span className={cx(styles, 'tutorial-done-badge')}>✓ Completed</span>}
              </div>
              <h3 className={cx(styles, 'tutorial-chapter-heading')}>{activeChapter.title}</h3>
              <p className={cx(styles, 'tutorial-chapter-summary')}>{activeChapter.summary}</p>
            </div>

            <TutorialMediaStage
              step={activeStep}
              stepIndex={clampedStepIndex}
              totalSteps={activeChapter.steps.length}
              baseUrl={baseUrl}
              mediaBaseUrl={mediaBaseUrl}
              reducedMotionOverride={reducedMotionOverride}
            />

            {initialMediaMode.kind !== 'card-only' && (
              <>
                <h4 className={cx(styles, 'tutorial-step-title')}>{activeStep.title}</h4>
                <p className={cx(styles, 'tutorial-step-instructions')}>{activeStep.instructions}</p>
                {activeStep.highlights && activeStep.highlights.length > 0 && (
                  <ul className={cx(styles, 'tutorial-highlights')}>
                    {activeStep.highlights.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </>
            )}

            <details
              key={`${activeChapter.id}:${activeStep.id}:${showTranscriptOpenByDefault ? 'open' : 'closed'}`}
              open={showTranscriptOpenByDefault}
              className={cx(styles, 'tutorial-transcript')}
            >
              <summary className={cx(styles, 'tutorial-transcript-summary')}>Read full transcript</summary>
              <p className={cx(styles, 'tutorial-transcript-body')}>{activeStep.transcript}</p>
            </details>
          </section>
        </div>

        <footer className={cx(styles, 'tutorial-footer')}>
          <div className={cx(styles, 'tutorial-footer-actions')}>
            <div className={cx(styles, 'tutorial-footer-group')}>
              <button
                type="button"
                className={cx(styles, 'tutorial-btn')}
                disabled={clampedStepIndex === 0}
                onClick={() => {
                  setStepIndex((prev) => Math.max(0, prev - 1));
                }}
              >
                Previous step
              </button>
              {activeStep.targetRoute && (
                <button
                  type="button"
                  className={cx(styles, 'tutorial-btn tutorial-btn-try')}
                  onClick={handleTryItNow}
                >
                  Try it now: {activeStep.targetRouteLabel ?? activeStep.targetRoute}
                </button>
              )}
            </div>

            <div className={cx(styles, 'tutorial-footer-group')}>
              {!isLastStep ? (
                <button
                  type="button"
                  className={cx(styles, 'tutorial-btn tutorial-btn-primary')}
                  onClick={() => {
                    setStepIndex((prev) => Math.min(activeChapter.steps.length - 1, prev + 1));
                  }}
                >
                  Next step
                </button>
              ) : (
                <button
                  type="button"
                  className={cx(styles, 'tutorial-btn tutorial-btn-primary')}
                  onClick={handleCompleteChapter}
                >
                  {isChapterComplete ? 'Chapter completed' : 'Mark chapter complete'}
                </button>
              )}
            </div>
          </div>

          {showFirstLoginControls && (
            <div className={cx(styles, 'tutorial-first-login-bar')}>
              <label className={cx(styles, 'tutorial-suppress-label')}>
                <input
                  type="checkbox"
                  checked={suppressAutoOpenChecked}
                  onChange={(event) => {
                    setSuppressAutoOpenChecked(event.target.checked);
                  }}
                />
                <span>Don&apos;t show automatically on sign-in</span>
              </label>
              <button
                type="button"
                className={cx(styles, 'tutorial-skip-link-btn')}
                onClick={handleSkipToChecklist}
              >
                Skip to my setup checklist
              </button>
            </div>
          )}
        </footer>
      </div>
    </dialog>
  );
};
