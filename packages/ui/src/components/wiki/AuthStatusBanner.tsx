import type React from 'react';
import { useEffect, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { type AuthUrlError, consumeAuthErrorFromWindow, resolveAuthFeedback } from './authErrorCopy.js';
import { SignInModal } from './SignInModal.js';

export function getInviteStripDismissKey(inviteLabel?: string): string {
  const normalized = inviteLabel?.trim() || 'default';
  return `kinloom:invite-strip-dismissed:${normalized}`;
}

function readDismissedState(storageKey: string): boolean {
  try {
    return typeof window !== 'undefined' && window.sessionStorage.getItem(storageKey) === '1';
  } catch {
    return false;
  }
}

function writeDismissedState(storageKey: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(storageKey, '1');
    }
  } catch {
    // Ignore restricted sessionStorage environments; local component state still dismisses.
  }
}

/**
 * Displays a whisper-thin, dismissible single-line strip for read-only invite viewers,
 * and surfaces friendly auth/invite redirect notices when returning from an OAuth,
 * magic-link, or invite failure while already inside the archive.
 */
export const AuthStatusBanner: React.FC = () => {
  const { session, authProviders } = useArchiveData();
  const [signInOpen, setSignInOpen] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [urlAuthError, setUrlAuthError] = useState<AuthUrlError | null>(null);

  useEffect(() => {
    const consumed = consumeAuthErrorFromWindow();
    if (consumed) {
      setUrlAuthError(consumed);
    }
  }, []);

  useEffect(() => {
    if (session?.principal_kind === 'invite_viewer' && urlAuthError !== null) {
      setSignInOpen(true);
    }
  }, [session?.principal_kind, urlAuthError]);

  if (!session) {
    return null;
  }

  if (session.principal_kind === 'invite_viewer') {
    const storageKey = getInviteStripDismissKey(session.inviteLabel);
    const isDismissed = dismissedKey === storageKey || readDismissedState(storageKey);

    if (isDismissed && !signInOpen && urlAuthError === null) {
      return null;
    }

    const handleDismiss = (): void => {
      writeDismissedState(storageKey);
      setDismissedKey(storageKey);
    };

    return (
      <>
        {!isDismissed && (
          <div
            className="wiki-auth-banner is-invite print-hide"
            role="region"
            aria-label="Invite access notice"
          >
            <div className="wiki-auth-banner-copy">
              <span className="wiki-auth-banner-label">
                Family invite{session.inviteLabel ? ` (${session.inviteLabel})` : ''}
              </span>
              <span className="wiki-auth-banner-sep" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                className="wiki-auth-banner-link"
                onClick={() => {
                  setSignInOpen(true);
                }}
              >
                Sign in to edit
              </button>
            </div>
            <button
              type="button"
              className="wiki-auth-banner-dismiss"
              aria-label="Dismiss family invite notice"
              title="Dismiss notice"
              onClick={handleDismiss}
            >
              ×
            </button>
          </div>
        )}
        <SignInModal
          open={signInOpen}
          inviteLabel={session.inviteLabel}
          initialUrlError={urlAuthError}
          onClose={() => {
            setSignInOpen(false);
            setUrlAuthError(null);
          }}
        />
      </>
    );
  }

  if (!urlAuthError) {
    return null;
  }

  const feedback = resolveAuthFeedback({
    code: urlAuthError.code,
    provider: urlAuthError.provider,
    hasGoogleProvider: authProviders.google,
  });

  return (
    <div
      className={`wiki-auth-notice-bar is-${feedback.tone} print-hide`}
      role={feedback.tone === 'info' ? 'status' : 'alert'}
      aria-live={feedback.tone === 'info' ? 'polite' : 'assertive'}
    >
      <div className="wiki-auth-notice-copy">
        <strong>{feedback.title}.</strong> {feedback.detail}
      </div>
      <button
        type="button"
        className="wiki-auth-banner-dismiss"
        aria-label="Dismiss sign-in notice"
        title="Dismiss notice"
        onClick={() => {
          setUrlAuthError(null);
        }}
      >
        ×
      </button>
    </div>
  );
};
