import React, { useRef } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { useDialogFocusTrap } from '../../lib/useDialogFocusTrap.js';
import type { AuthUrlError } from './authErrorCopy.js';
import { AuthSignInFlow } from './AuthSignInFlow.js';

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
  const { siteConfig } = useArchiveData();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useDialogFocusTrap({
    open,
    onClose,
    initialFocusRef: closeBtnRef,
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
        />
      </div>
    </dialog>
  );
};
