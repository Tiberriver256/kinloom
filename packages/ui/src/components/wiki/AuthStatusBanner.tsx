import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { SignInModal } from './SignInModal.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';

/**
 * Displays a read-only invite upgrade banner (one-click Google / magic-link enrollment)
 * or a quiet signed-in editor bar with links to Recent Changes and Admin.
 * Renders nothing on static read-only demos with no session.
 */
export const AuthStatusBanner: React.FC = () => {
  const { session, capabilities, dataSource, refreshSession } = useArchiveData();
  const [signInOpen, setSignInOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (!session) {
    return null;
  }

  const handleLogout = async (): Promise<void> => {
    if (!dataSource.logout) {
      return;
    }
    setSigningOut(true);
    try {
      await dataSource.logout();
      await refreshSession();
    } finally {
      setSigningOut(false);
    }
  };

  if (session.principal_kind === 'invite_viewer') {
    return (
      <>
        <div className="wiki-auth-banner is-invite print-hide" role="region" aria-label="Invite access notice">
          <div className="wiki-auth-banner-copy">
            <strong>Read-only family invite</strong>
            {session.inviteLabel ? ` (${session.inviteLabel})` : ''}. Sign in once to add stories,
            fix dates, or upload historical scans.
          </div>
          <div className="wiki-auth-banner-actions">
            <button
              type="button"
              className="pill-btn active"
              onClick={() => {
                setSignInOpen(true);
              }}
            >
              Sign in to edit
            </button>
          </div>
        </div>
        <SignInModal
          open={signInOpen}
          inviteLabel={session.inviteLabel}
          onClose={() => {
            setSignInOpen(false);
          }}
        />
      </>
    );
  }

  if (session.authenticated && session.principal_kind === 'user') {
    return (
      <div className="wiki-auth-banner is-member print-hide" role="region" aria-label="Signed-in editor bar">
        <div className="wiki-auth-banner-copy">
          Signed in as <strong>{session.displayName || session.email || 'Member'}</strong>{' '}
          <span className="wiki-role-chip">{session.role === 'admin' ? 'Admin' : 'Editor'}</span>
        </div>
        <div className="wiki-auth-banner-actions">
          {capabilities.hasRevisionHistory && (
            <Link to="/changes" className="pill-btn" style={{ textDecoration: 'none' }}>
              Recent Changes
            </Link>
          )}
          {capabilities.canManageSite && (
            <Link to="/admin" className="pill-btn" style={{ textDecoration: 'none' }}>
              Admin
            </Link>
          )}
          {dataSource.logout && (
            <button
              type="button"
              className="pill-btn"
              disabled={signingOut}
              onClick={() => {
                void handleLogout();
              }}
            >
              {signingOut ? 'Signing out…' : 'Sign Out'}
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
};
