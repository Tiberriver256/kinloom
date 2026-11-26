import React, { useState } from 'react';
import { SignInModal } from './SignInModal.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';

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
 * Displays a whisper-thin, dismissible single-line strip for read-only invite viewers.
 * Dismissed state persists in sessionStorage per invite label, while ExplorerTopBar
 * keeps a quiet "Sign in to edit" action accessible at all times.
 */
export const AuthStatusBanner: React.FC = () => {
  const { session } = useArchiveData();
  const [signInOpen, setSignInOpen] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  if (!session || session.principal_kind !== 'invite_viewer') {
    return null;
  }

  const storageKey = getInviteStripDismissKey(session.inviteLabel);
  const isDismissed = dismissedKey === storageKey || readDismissedState(storageKey);

  if (isDismissed && !signInOpen) {
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
        onClose={() => {
          setSignInOpen(false);
        }}
      />
    </>
  );
};
