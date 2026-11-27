import type React from 'react';
import { useEffect, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import { KinloomFooter, KinloomMark } from '../KinloomFooter.js';
import { AuthSignInFlow } from './AuthSignInFlow.js';
import { type AuthUrlError, consumeAuthErrorFromWindow } from './authErrorCopy.js';
import wikiAuthStyles from './WikiAuth.module.css';

export interface PrivateArchiveGateProps {
  onNavigateToInvite?: (invitePath: string) => void;
}

/**
 * Full-page archival sign-in gate displayed on private Kinloom archives when
 * the visitor is anonymous and the archive bundle requires authentication.
 */
export const PrivateArchiveGate: React.FC<PrivateArchiveGateProps> = ({ onNavigateToInvite }) => {
  const { siteConfig, authProviders, dataSource } = useArchiveData();
  const [urlError, setUrlError] = useState<AuthUrlError | null>(null);

  useEffect(() => {
    const consumed = consumeAuthErrorFromWindow();
    if (consumed) {
      setUrlError(consumed);
    }
  }, []);

  const canSignInWithGoogle = Boolean(authProviders.google && dataSource.getGoogleSignInUrl?.('/'));
  const leadCopy =
    canSignInWithGoogle && authProviders.magicLink
      ? 'Sign in with an invited family email link or your Google account. No password is needed.'
      : canSignInWithGoogle
        ? 'Sign in with your invited Google account to open this family archive.'
        : 'Enter your invited family email address. No password is needed, and we will email you a one-click sign-in link.';

  return (
    <div className={cx(wikiAuthStyles, 'private-archive-gate')}>
      <main className={cx(wikiAuthStyles, 'private-archive-gate-main')}>
        <section
          className={cx(wikiAuthStyles, 'private-archive-gate-card')}
          aria-label={`Sign in to ${siteConfig.site.title}`}
        >
          <div className={cx(wikiAuthStyles, 'private-archive-gate-brand')}>
            <KinloomMark size={26} />
            <span className={cx(wikiAuthStyles, 'private-archive-gate-kicker')}>Private Family Archive</span>
          </div>

          <h1 className={cx(wikiAuthStyles, 'private-archive-gate-title')}>{siteConfig.site.title}</h1>

          {siteConfig.site.description && (
            <p className={cx(wikiAuthStyles, 'private-archive-gate-desc')}>{siteConfig.site.description}</p>
          )}

          <p className={cx(wikiAuthStyles, 'private-archive-gate-note')}>{leadCopy}</p>

          <AuthSignInFlow
            initialUrlError={urlError}
            showInviteHelper
            onNavigateToInvite={onNavigateToInvite}
          />
        </section>
      </main>
      <KinloomFooter hideNav />
    </div>
  );
};
