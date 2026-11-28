import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import { type AuthUrlError, consumeAuthErrorFromWindow, resolveAuthFeedback } from './authErrorCopy.js';
import { SignInModal } from './SignInModal.js';
import wikiAuthStyles from './WikiAuth.module.css';

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
  const bannerRef = useRef<HTMLDivElement | null>(null);

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

  const isInviteViewer = session?.principal_kind === 'invite_viewer';
  const inviteStorageKey = isInviteViewer ? getInviteStripDismissKey(session.inviteLabel) : null;
  const isInviteDismissed =
    inviteStorageKey !== null && (dismissedKey === inviteStorageKey || readDismissedState(inviteStorageKey));
  const hasVisibleBanner = Boolean(
    session && ((isInviteViewer && !isInviteDismissed) || (!isInviteViewer && urlAuthError !== null))
  );

  // Sync rendered banner height into --auth-banner-height so --shell-chrome-offset
  // dynamically accounts for the invite/notice strip on full-viewport /map and /tree routes.
  useLayoutEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }
    const root = document.documentElement;
    if (!hasVisibleBanner) {
      root.style.setProperty('--auth-banner-height', '0px');
      return undefined;
    }
    const el = bannerRef.current;
    if (!el) {
      root.style.setProperty('--auth-banner-height', '0px');
      return undefined;
    }
    const syncHeight = (): void => {
      const rectHeight = el.getBoundingClientRect().height;
      const measured = Math.ceil(rectHeight > 0 ? rectHeight : el.offsetHeight);
      root.style.setProperty('--auth-banner-height', `${measured}px`);
    };
    syncHeight();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(syncHeight);
      observer.observe(el);
    }
    window.addEventListener('resize', syncHeight);
    return (): void => {
      observer?.disconnect();
      window.removeEventListener('resize', syncHeight);
      root.style.setProperty('--auth-banner-height', '0px');
    };
  }, [hasVisibleBanner]);

  if (!session) {
    return null;
  }

  if (isInviteViewer && inviteStorageKey !== null) {
    if (isInviteDismissed && !signInOpen && urlAuthError === null) {
      return null;
    }

    const handleDismiss = (): void => {
      writeDismissedState(inviteStorageKey);
      setDismissedKey(inviteStorageKey);
    };

    return (
      <>
        {!isInviteDismissed && (
          <div
            ref={bannerRef}
            className={cx(wikiAuthStyles, 'wiki-auth-banner is-invite print-hide')}
            role="region"
            aria-label="Invite access notice"
          >
            <div className={cx(wikiAuthStyles, 'wiki-auth-banner-copy')}>
              <span className={cx(wikiAuthStyles, 'wiki-auth-banner-label')}>
                Family invite{session.inviteLabel ? ` (${session.inviteLabel})` : ''}
              </span>
              <span className={cx(wikiAuthStyles, 'wiki-auth-banner-sep')} aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                className={cx(wikiAuthStyles, 'wiki-auth-banner-link')}
                onClick={() => {
                  setSignInOpen(true);
                }}
              >
                Sign in to edit
              </button>
            </div>
            <button
              type="button"
              className={cx(wikiAuthStyles, 'wiki-auth-banner-dismiss')}
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
      ref={bannerRef}
      className={cx(wikiAuthStyles, `wiki-auth-notice-bar is-${feedback.tone} print-hide`)}
      role={feedback.tone === 'info' ? 'status' : 'alert'}
      aria-live={feedback.tone === 'info' ? 'polite' : 'assertive'}
    >
      <div className={cx(wikiAuthStyles, 'wiki-auth-notice-copy')}>
        <strong>{feedback.title}.</strong> {feedback.detail}
      </div>
      <button
        type="button"
        className={cx(wikiAuthStyles, 'wiki-auth-banner-dismiss')}
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
