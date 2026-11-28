import type React from 'react';
import { useRef } from 'react';
import { useOptionalOnboarding } from '../context/OnboardingContext.js';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap.js';
import { cx } from '../lib/cx.js';
import styles from './GuideOverlays.module.css';
import { TutorialModal } from './tutorials/TutorialModal.js';

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

/**
 * Legacy export kept for backwards compatibility with #54 callers; always renders the
 * full interactive TutorialModal rather than static placeholder cards.
 */
export const QuickArchiveGuideDialog: React.FC = () => <TutorialModal />;
