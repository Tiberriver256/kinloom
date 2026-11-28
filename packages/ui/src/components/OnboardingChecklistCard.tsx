import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useOptionalOnboarding } from '../context/OnboardingContext.js';
import { cx } from '../lib/cx.js';
import type { ResolvedOnboardingStep } from '../lib/onboardingModel.js';
import styles from './OnboardingChecklistCard.module.css';

export interface OnboardingChecklistCardProps {
  /** Which page surface hosts this checklist so admin steps appear on /admin and viewer/editor steps on /. */
  readonly surface: 'index' | 'admin';
  /** Optional callback triggered when an invite_viewer clicks the retention sign-in link. */
  readonly onRequestSignIn?: () => void;
}

const ROLE_COPY = {
  viewer: {
    shortLabel: 'Reader guide',
    eyebrow: 'Getting Started · Reader Guide',
    heading: 'Explore this family archive',
    summary: 'Follow a few quick steps to trace relatives, read cited stories, and map migrations.',
  },
  editor: {
    shortLabel: 'Contributor guide',
    eyebrow: 'Getting Started · Contributor Guide',
    heading: 'Make your first archival contribution',
    summary: 'Add records, verify primary citations, upload scans, and inspect revision history.',
  },
  admin: {
    shortLabel: 'Admin setup',
    eyebrow: 'Getting Started · Admin Setup',
    heading: 'Verify your Kinloom archive',
    summary: 'Check diagnostics, confirm initial records, create a family invite, and review plugins.',
  },
} as const;

export const OnboardingChecklistCard: React.FC<OnboardingChecklistCardProps> = ({
  surface,
  onRequestSignIn,
}) => {
  const onboarding = useOptionalOnboarding();
  const [showOverflowPlugins, setShowOverflowPlugins] = useState(false);

  if (!onboarding) {
    return null;
  }

  const {
    role,
    state,
    checklist,
    onboardingContext,
    lastAnnouncement,
    completeStep,
    setChecklistVisibility,
    dismissChecklist,
    resetProgress,
    openGuide,
  } = onboarding;

  const matchesSurface = surface === 'admin' ? role === 'admin' : role === 'viewer' || role === 'editor';
  if (!matchesSurface || state.checklist_visibility === 'dismissed' || checklist.totalCount === 0) {
    return null;
  }

  const copy = ROLE_COPY[role];
  const isCollapsed = state.checklist_visibility === 'collapsed';

  const renderStepRow = (item: ResolvedOnboardingStep, index: number): React.ReactNode => {
    const isDone = item.status === 'completed';
    const isSkipped = item.status === 'skipped';
    const action = item.resolvedAction;

    return (
      <li
        key={item.step.id}
        className={cx(
          styles,
          `onboarding-step-item${isDone ? ' is-completed' : ''}${isSkipped ? ' is-skipped' : ''}`
        )}
      >
        <div className={cx(styles, 'onboarding-step-main')}>
          <button
            type="button"
            className={cx(styles, `onboarding-step-check${isDone ? ' is-done' : ''}`)}
            aria-label={isDone ? `${item.step.title} completed` : `Mark "${item.step.title}" as completed`}
            aria-pressed={isDone}
            disabled={isDone}
            onClick={() => {
              completeStep(item.step.id);
            }}
          >
            {isDone ? '✓' : String(index + 1)}
          </button>
          <div className={cx(styles, 'onboarding-step-copy')}>
            <h4 className={cx(styles, 'onboarding-step-title')}>{item.step.title}</h4>
            <p className={cx(styles, 'onboarding-step-description')}>{item.step.description}</p>
          </div>
        </div>

        <div className={cx(styles, 'onboarding-step-actions')}>
          {isDone ? (
            <span className={cx(styles, 'onboarding-status-pill')}>Done</span>
          ) : action?.kind === 'route' ? (
            <Link
              to={action.to}
              className={cx(styles, 'onboarding-action-link')}
              onClick={() => {
                if (action.to.startsWith('/admin#')) {
                  const targetId = action.to.slice('/admin#'.length);
                  const target = document.getElementById(targetId);
                  target?.scrollIntoView?.({ block: 'start' });
                }
              }}
            >
              {action.label}
            </Link>
          ) : action?.kind === 'tutorial' ? (
            <button
              type="button"
              className={cx(styles, 'onboarding-action-link')}
              onClick={() => {
                openGuide(action.chapterId);
              }}
            >
              {action.label}
            </button>
          ) : action?.kind === 'callback' ? (
            <button
              type="button"
              className={cx(styles, 'onboarding-action-link')}
              onClick={() => {
                action.onActivate(onboardingContext);
              }}
            >
              {action.label}
            </button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <section
      id="onboarding-checklist"
      tabIndex={-1}
      aria-labelledby="onboarding-checklist-heading"
      className={cx(styles, `onboarding-card${isCollapsed ? ' is-collapsed' : ''}`)}
      data-testid="onboarding-checklist-card"
    >
      {isCollapsed ? (
        <div className={cx(styles, 'onboarding-collapsed-strip')}>
          <span id="onboarding-checklist-heading" className={cx(styles, 'onboarding-collapsed-label')}>
            <span className={cx(styles, 'onboarding-collapsed-title')}>{copy.shortLabel}</span>
            <span aria-hidden="true" className={cx(styles, 'onboarding-collapsed-sep')}>
              ·
            </span>
            <span className={cx(styles, 'onboarding-collapsed-count')}>
              {checklist.completedCount}/{checklist.totalCount}
            </span>
          </span>

          <div className={cx(styles, 'onboarding-collapsed-actions')}>
            <button
              type="button"
              className={cx(styles, 'onboarding-strip-btn onboarding-strip-open')}
              aria-expanded={false}
              aria-label={`Open ${copy.shortLabel}`}
              onClick={() => {
                setChecklistVisibility('open');
              }}
            >
              Open
            </button>
            <button
              type="button"
              className={cx(styles, 'onboarding-strip-btn')}
              aria-label={`Dismiss ${copy.shortLabel}`}
              onClick={() => {
                dismissChecklist();
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={cx(styles, 'onboarding-header')}>
            <div className={cx(styles, 'onboarding-title-group')}>
              <span className={cx(styles, 'onboarding-eyebrow')}>{copy.eyebrow}</span>
              <h3 id="onboarding-checklist-heading" className={cx(styles, 'onboarding-heading')}>
                {copy.heading}
              </h3>
              <p className={cx(styles, 'onboarding-summary')}>{copy.summary}</p>
            </div>

            <div className={cx(styles, 'onboarding-header-actions')}>
              <button
                type="button"
                className={cx(styles, 'onboarding-ctrl-btn')}
                aria-expanded={true}
                onClick={() => {
                  setChecklistVisibility('collapsed');
                }}
              >
                Collapse
              </button>
              <button
                type="button"
                className={cx(styles, 'onboarding-ctrl-btn')}
                onClick={() => {
                  dismissChecklist();
                }}
              >
                Dismiss checklist
              </button>
            </div>
          </div>

          <div className={cx(styles, 'onboarding-progress-row')}>
            <progress
              className={cx(styles, 'onboarding-progress-bar')}
              max={checklist.totalCount}
              value={checklist.resolvedCount}
              aria-label={`${checklist.completedCount} of ${checklist.totalCount} steps completed`}
            />
            <span className={cx(styles, 'onboarding-progress-label')}>
              {checklist.completedCount} of {checklist.totalCount} steps completed
            </span>
          </div>

          {checklist.allResolved && (
            <div className={cx(styles, 'onboarding-complete-banner')} role="status">
              All getting started steps are complete. You can dismiss this card or reopen it anytime from the
              Guide menu.{' '}
              <button
                type="button"
                className={cx(styles, 'onboarding-ctrl-btn')}
                style={{ marginLeft: 8 }}
                onClick={resetProgress}
              >
                Reset progress
              </button>
            </div>
          )}

          <ol className={cx(styles, 'onboarding-step-list')}>
            {checklist.primaryItems.map((item, idx) => renderStepRow(item, idx))}
          </ol>

          {checklist.overflowPluginItems.length > 0 && (
            <div className={cx(styles, 'onboarding-overflow-wrap')}>
              <button
                type="button"
                className={cx(styles, 'onboarding-ctrl-btn')}
                aria-expanded={showOverflowPlugins}
                onClick={() => {
                  setShowOverflowPlugins((open) => !open);
                }}
              >
                {showOverflowPlugins
                  ? 'Hide extra plugin guides'
                  : `More plugin guides (+${checklist.overflowPluginItems.length})`}
              </button>
              {showOverflowPlugins && (
                <ol className={cx(styles, 'onboarding-step-list')}>
                  {checklist.overflowPluginItems.map((item, idx) =>
                    renderStepRow(item, checklist.primaryItems.length + idx)
                  )}
                </ol>
              )}
            </div>
          )}

          {checklist.showInviteRetentionNote && (
            <div className={cx(styles, 'onboarding-footer-note')}>
              <span>
                Have family photos or corrections to share? Sign in with your invite link to contribute edits.
              </span>
              {onRequestSignIn && (
                <button type="button" className={cx(styles, 'onboarding-ctrl-btn')} onClick={onRequestSignIn}>
                  Sign in to edit
                </button>
              )}
            </div>
          )}
        </>
      )}

      <output className={'visually-hidden'} aria-live="polite">
        {lastAnnouncement}
      </output>
    </section>
  );
};
