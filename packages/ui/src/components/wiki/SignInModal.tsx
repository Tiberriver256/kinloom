import type React from 'react';
import { useRef } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useDialogFocusTrap } from '../../hooks/useDialogFocusTrap.js';
import { cx } from '../../lib/cx.js';
import controlStyles from '../../styles/Controls.module.css';
import overlayStyles from '../../styles/Overlays.module.css';
import { AuthSignInFlow } from './AuthSignInFlow.js';
import type { AuthUrlError } from './authErrorCopy.js';
import wikiFormStyles from './WikiForms.module.css';

export interface SignInModalProps {
  open: boolean;
  onClose: () => void;
  inviteLabel?: string;
  initialUrlError?: AuthUrlError | null;
  onNavigateToInvite?: (invitePath: string) => void;
}

export const SignInModal: React.FC<SignInModalProps> = ({
  open,
  onClose,
  inviteLabel,
  initialUrlError = null,
  onNavigateToInvite,
}) => {
  const { siteConfig, authProviders } = useArchiveData();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const feedbackRef = useRef<HTMLDivElement | null>(null);
  const preferredFocusRef = initialUrlError
    ? feedbackRef
    : authProviders.magicLink
      ? emailInputRef
      : closeBtnRef;
  const dialogRef = useDialogFocusTrap({
    open,
    onClose,
    initialFocusRef: preferredFocusRef,
  });

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className={cx(overlayStyles, 'lightbox-backdrop')}
      aria-label="Sign in to family archive"
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(overlayStyles, 'lightbox-backdrop-close')}
        aria-label="Close sign-in dialog"
        onClick={onClose}
      />
      <div className={cx(wikiFormStyles, 'wiki-modal-card wiki-signin-card')}>
        <div className={cx(wikiFormStyles, 'wiki-modal-header')}>
          <h2>Sign in to {siteConfig.site.title}</h2>
          <button ref={closeBtnRef} type="button" className={cx(controlStyles, 'pill-btn')} onClick={onClose}>
            Close
          </button>
        </div>

        <AuthSignInFlow
          initialUrlError={initialUrlError}
          inviteLabel={inviteLabel}
          showInviteHelper
          onNavigateToInvite={onNavigateToInvite}
          emailInputRef={emailInputRef}
          feedbackRef={feedbackRef}
        />
      </div>
    </dialog>
  );
};
