import type React from 'react';
import { useRef } from 'react';
import { useOptionalOnboarding } from '../context/OnboardingContext.js';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap.js';
import { cx } from '../lib/cx.js';
import styles from './GuideOverlays.module.css';

interface ShortcutEntry {
  readonly keys: readonly string[];
  readonly label: string;
}

const KEYBOARD_SHORTCUTS: readonly ShortcutEntry[] = [
  { keys: ['/', 'Ctrl/Cmd + K'], label: 'Open global archive search' },
  { keys: ['Esc'], label: 'Close the topmost dialog, drawer, or menu' },
  { keys: ['Arrow Left', 'Arrow Right'], label: 'Move across Evidence tabs and media lightbox items' },
  { keys: ['Tab', 'Shift + Tab'], label: 'Move keyboard focus through interactive controls' },
];

interface GuideChapterSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

const QUICK_GUIDE_CHAPTERS: readonly GuideChapterSummary[] = [
  {
    id: 'core-getting-started',
    title: 'Welcome to Kinloom',
    summary:
      'Browse relatives by era or surname on People, trace direct lines on Tree, follow migrations on Map, and inspect primary records on Evidence.',
  },
  {
    id: 'core-tree-pedigree',
    title: 'Family Tree & Pedigree Views',
    summary:
      'Switch between Diagram and printable Roll views, filter by branch, or set a custom anchor person to trace direct ancestors.',
  },
  {
    id: 'core-person-dossier',
    title: 'Person Dossiers & Pronunciations',
    summary:
      'Every deceased ancestor profile combines cited milestones, primary source scans, spoken biographies, and name pronunciations.',
  },
  {
    id: 'core-map-timeline',
    title: 'Migration Map & Time Snapshots',
    summary:
      'Step through geocoded migration stops on the Map or scrub any historical year on Time to see where relatives lived side by side.',
  },
  {
    id: 'core-editing-records',
    title: 'Cited Collaboration & Revision History',
    summary:
      'Editors can add people, attach primary citations, upload scans, and review or revert any revision from Recent Changes.',
  },
  {
    id: 'core-admin-settings',
    title: 'Site Administration & Diagnostics',
    summary:
      'Admins verify storage health probes, issue revocable read-only family invite links, configure plugins, and create scoped backup tokens.',
  },
];

export const KeyboardShortcutsDialog: React.FC = () => {
  const onboarding = useOptionalOnboarding();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const open = Boolean(onboarding?.shortcutsDialogOpen);

  const dialogRef = useDialogFocusTrap<HTMLDialogElement>({
    open,
    onClose: () => {
      onboarding?.closeShortcutsDialog();
    },
    initialFocusRef: closeBtnRef,
  });

  if (!open || !onboarding) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      aria-labelledby="kinloom-shortcuts-title"
      aria-describedby="kinloom-shortcuts-desc"
      className={cx(styles, 'guide-dialog-backdrop')}
    >
      <div className={cx(styles, 'guide-dialog-card')}>
        <div className={cx(styles, 'guide-dialog-header')}>
          <div>
            <h2 id="kinloom-shortcuts-title" className={cx(styles, 'guide-dialog-title')}>
              Keyboard Shortcuts
            </h2>
            <p id="kinloom-shortcuts-desc" className={cx(styles, 'guide-dialog-desc')}>
              Navigate the archive quickly without leaving your keyboard.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className={cx(styles, 'guide-dialog-close')}
            onClick={onboarding.closeShortcutsDialog}
          >
            Close
          </button>
        </div>

        <ul className={cx(styles, 'guide-shortcut-list')}>
          {KEYBOARD_SHORTCUTS.map((entry) => (
            <li key={entry.label} className={cx(styles, 'guide-shortcut-row')}>
              <span>{entry.label}</span>
              <span className={cx(styles, 'guide-kbd-group')}>
                {entry.keys.map((key) => (
                  <kbd key={key} className="kl-kbd">
                    {key}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
};

export const QuickArchiveGuideDialog: React.FC = () => {
  const onboarding = useOptionalOnboarding();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const activeChapter = onboarding?.guideDialogChapter ?? null;
  const open = activeChapter !== null;

  const dialogRef = useDialogFocusTrap<HTMLDialogElement>({
    open,
    onClose: () => {
      onboarding?.closeGuideDialog();
    },
    initialFocusRef: closeBtnRef,
  });

  if (!open || !onboarding) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      aria-labelledby="kinloom-quick-guide-title"
      aria-describedby="kinloom-quick-guide-desc"
      className={cx(styles, 'guide-dialog-backdrop')}
    >
      <div className={cx(styles, 'guide-dialog-card')}>
        <div className={cx(styles, 'guide-dialog-header')}>
          <div>
            <h2 id="kinloom-quick-guide-title" className={cx(styles, 'guide-dialog-title')}>
              Quick Archive Guide
            </h2>
            <p id="kinloom-quick-guide-desc" className={cx(styles, 'guide-dialog-desc')}>
              Orientation chapters for exploring, citing, and stewarding your Kinloom archive.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className={cx(styles, 'guide-dialog-close')}
            onClick={onboarding.closeGuideDialog}
          >
            Close
          </button>
        </div>

        <ul className={cx(styles, 'guide-chapters-list')}>
          {QUICK_GUIDE_CHAPTERS.map((chapter) => (
            <li
              key={chapter.id}
              className={cx(styles, `guide-chapter-item${activeChapter === chapter.id ? ' is-active' : ''}`)}
            >
              <h3 className={cx(styles, 'guide-chapter-heading')}>{chapter.title}</h3>
              <p className={cx(styles, 'guide-chapter-body')}>{chapter.summary}</p>
            </li>
          ))}
        </ul>

        <div className={cx(styles, 'guide-dialog-footer')}>
          <button
            type="button"
            className={cx(styles, 'guide-dialog-close')}
            onClick={() => {
              onboarding.completeChapter(activeChapter);
              onboarding.dismissTutorialModal();
              onboarding.closeGuideDialog();
            }}
          >
            Mark chapter read
          </button>
        </div>
      </div>
    </dialog>
  );
};
