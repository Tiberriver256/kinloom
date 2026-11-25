import React, { useState } from 'react';
import { HttpWikiDataSource } from '../../adapters/httpWikiDataSource.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { KinloomFooter, KinloomMark } from '../KinloomFooter.js';

/**
 * Full-page archival sign-in gate displayed on private Kinloom archives when
 * the visitor is anonymous and the archive bundle requires authentication.
 */
export const PrivateArchiveGate: React.FC = () => {
  const { dataSource, siteConfig, authProviders } = useArchiveData();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="private-archive-gate">
      <main className="private-archive-gate-main">
        <section
          className="private-archive-gate-card"
          aria-label={`Sign in to ${siteConfig.site.title}`}
        >
          <div className="private-archive-gate-brand">
            <KinloomMark size={26} />
            <span className="private-archive-gate-kicker">Private Family Archive</span>
          </div>

          <h1 className="private-archive-gate-title">{siteConfig.site.title}</h1>

          {siteConfig.site.description && (
            <p className="private-archive-gate-desc">{siteConfig.site.description}</p>
          )}

          <p className="private-archive-gate-note">
            Enter your invited family email address. No password is needed — we will email you a
            one-click sign-in link.
          </p>

          {sentTo ? (
            <output className="wiki-status-banner is-success" aria-live="polite">
              <p>
                Check <strong>{sentTo}</strong> for your one-time sign-in link (valid for 15
                minutes).
              </p>
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
                  <p>{error}</p>
                </div>
              )}
              <label className="wiki-field">
                <span className="wiki-field-label">Email address</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  className="wiki-input wiki-input-lg"
                  placeholder="relative@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                  }}
                  disabled={sending}
                />
              </label>
              <div className="wiki-form-actions">
                <button
                  type="submit"
                  className="wiki-btn-primary wiki-btn-full"
                  disabled={sending || !email.trim()}
                >
                  {sending ? 'Sending link…' : 'Email Magic Link'}
                </button>
              </div>
            </form>
          )}

          {authProviders.google && (
            <>
              <div className="wiki-divider-label" aria-hidden="true">
                <span>or</span>
              </div>

              <div className="wiki-signin-section">
                <a href={googleStartUrl} className="wiki-btn-secondary wiki-btn-full">
                  Continue with Google
                </a>
              </div>
            </>
          )}
        </section>
      </main>
      <KinloomFooter />
    </div>
  );
};
