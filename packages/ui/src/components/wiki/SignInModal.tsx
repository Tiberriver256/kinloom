import React, { useState } from 'react';
import { HttpWikiDataSource } from '../../adapters/httpWikiDataSource.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';

export interface SignInModalProps {
  open: boolean;
  onClose: () => void;
  inviteLabel?: string;
}

export const SignInModal: React.FC<SignInModalProps> = ({ open, onClose, inviteLabel }) => {
  const { dataSource, siteConfig } = useArchiveData();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return null;
  }

  const nextPath =
    typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : '/';
  const googleStartUrl =
    dataSource instanceof HttpWikiDataSource
      ? dataSource.getGoogleSignInUrl(nextPath)
      : `/api/auth/google/start?next=${encodeURIComponent(nextPath)}`;

  const handleMagicLinkSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !dataSource.requestMagicLink) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await dataSource.requestMagicLink(trimmed);
      setSentTo(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <dialog open className="lightbox-backdrop" aria-label="Sign in to family archive">
      <button
        type="button"
        className="lightbox-backdrop-close"
        aria-label="Close sign-in dialog"
        onClick={onClose}
      />
      <div className="wiki-modal-card wiki-signin-card">
        <div className="wiki-modal-header">
          <h2>Sign in to {siteConfig.site.title}</h2>
          <button type="button" className="pill-btn" onClick={onClose}>
            Close
          </button>
        </div>

        {inviteLabel && (
          <div className="wiki-status-banner is-info">
            Invited via <strong>{inviteLabel}</strong>. Sign in with Google or an email magic link
            to unlock editing automatically as a family editor.
          </div>
        )}

        <div className="wiki-signin-section">
          <a href={googleStartUrl} className="pill-btn active wiki-google-btn" style={{ textDecoration: 'none' }}>
            Continue with Google
          </a>
        </div>

        <div className="wiki-divider-label" aria-hidden="true">
          <span>or email a one-time link</span>
        </div>

        {sentTo ? (
          <output className="wiki-status-banner is-success" aria-live="polite">
            Check <strong>{sentTo}</strong> for your one-time sign-in link (valid for 15 minutes).
          </output>
        ) : (
          <form
            className="wiki-edit-form"
            onSubmit={(e) => {
              void handleMagicLinkSubmit(e);
            }}
          >
            {error && (
              <div className="wiki-status-banner is-error" role="alert">
                {error}
              </div>
            )}
            <label className="wiki-field">
              <span className="wiki-field-label">Email address</span>
              <input
                type="email"
                required
                className="wiki-input"
                placeholder="relative@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                disabled={sending}
              />
            </label>
            <div className="wiki-form-actions">
              <button type="submit" className="pill-btn active" disabled={sending || !email.trim()}>
                {sending ? 'Sending link…' : 'Email Magic Link'}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
};
