import type React from 'react';
import { useRef } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import { useDialogFocusTrap } from '../../lib/useDialogFocusTrap.js';
import cssMod2 from '../../pages/IndexPage.module.css';
import cssMod0 from '../SourceReaderDrawer.module.css';
import { AuthSignInFlow } from './AuthSignInFlow.js';
import type { AuthUrlError } from './authErrorCopy.js';
import cssMod1 from './WikiForms.module.css';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod1, ...cssMod2 };

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
      className={cx(uiStyles, 'lightbox-backdrop')}
      aria-label="Sign in to family archive"
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(uiStyles, 'lightbox-backdrop-close')}
        aria-label="Close sign-in dialog"
        onClick={onClose}
      />
      <div className={cx(uiStyles, 'wiki-modal-card wiki-signin-card')}>
        <div className={cx(uiStyles, 'wiki-modal-header')}>
          <h2>Sign in to {siteConfig.site.title}</h2>
          <button ref={closeBtnRef} type="button" className={cx(uiStyles, 'pill-btn')} onClick={onClose}>
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
