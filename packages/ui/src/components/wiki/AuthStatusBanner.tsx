import React, { useState } from 'react';
import { SignInModal } from './SignInModal.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';

/**
 * Displays a calm, slim read-only invite banner with a one-click sign-in CTA.
 * Signed-in members use the quiet Account menu inside ExplorerTopBar so pages
 * never suffer from stacked double headers.
 */
export const AuthStatusBanner: React.FC = () => {
  const { session } = useArchiveData();
  const [signInOpen, setSignInOpen] = useState(false);

  if (!session || session.principal_kind !== 'invite_viewer') {
    return null;
  }

  return (
    <>
      <div
        className="wiki-auth-banner is-invite print-hide"
        role="region"
        aria-label="Invite access notice"
      >
        <div className="wiki-auth-banner-copy">
          <strong>Read-only family invite</strong>
          {session.inviteLabel ? ` (${session.inviteLabel})` : ''}. Sign in once to add stories,
          photos, or updates.
        </div>
        <div className="wiki-auth-banner-actions">
          <button
            type="button"
            className="wiki-btn-primary wiki-btn-sm"
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
};
