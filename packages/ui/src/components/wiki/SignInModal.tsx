import type React from 'react';
import { useRef } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useDialogFocusTrap } from '../../lib/useDialogFocusTrap.js';
import { AuthSignInFlow } from './AuthSignInFlow.js';
import type { AuthUrlError } from './authErrorCopy.js';

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
      className="lightbox-backdrop"
      aria-label="Sign in to family archive"
    >
      <button
        type="button"
        tabIndex={-1}
        className="lightbox-backdrop-close"
        aria-label="Close sign-in dialog"
        onClick={onClose}
      />
      <div className="wiki-modal-card wiki-signin-card">
        <div className="wiki-modal-header">
          <h2>Sign in to {siteConfig.site.title}</h2>
          <button ref={closeBtnRef} type="button" className="pill-btn" onClick={onClose}>
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
