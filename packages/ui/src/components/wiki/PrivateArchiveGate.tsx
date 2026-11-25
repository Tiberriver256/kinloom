import React, { useState } from 'react';
import { HttpWikiDataSource } from '../../adapters/httpWikiDataSource.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { KinloomFooter, KinloomMark } from '../KinloomFooter.js';

/**
 * Full-page archival sign-in gate displayed on private Kinloom archives when
 * the visitor is anonymous and the archive bundle requires authentication.
 */
export const PrivateArchiveGate: React.FC = () => {
  const { dataSource, siteConfig } = useArchiveData();
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
    <div
      className="private-archive-gate"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: 'var(--surface-canvas, #F5EFE2)',
        color: 'var(--text-primary, #23272E)',
      }}
    >
      <main
        style={{
          maxWidth: '30rem',
          width: '100%',
          margin: 'clamp(2rem, 8vh, 5rem) auto',
          padding: '0 1.25rem',
        }}
      >
        <section
          className="wiki-modal-card wiki-signin-card"
          aria-label={`Sign in to ${siteConfig.site.title}`}
          style={{
            margin: 0,
            maxWidth: '100%',
            boxShadow: '0 12px 32px rgba(27, 42, 65, 0.08)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '0.75rem' }}>
            <KinloomMark size={28} />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78rem',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--accent-primary, #7A4612)',
              }}
            >
              Private Family Archive
            </span>
          </div>

          <h1 style={{ margin: '0 0 0.5rem 0', fontSize: '1.65rem', lineHeight: 1.2 }}>
            {siteConfig.site.title}
          </h1>

          {siteConfig.site.description && (
            <p style={{ margin: '0 0 1.25rem 0', color: 'var(--text-secondary, #4E4A42)', lineHeight: 1.55 }}>
              {siteConfig.site.description}
            </p>
          )}

          <p style={{ margin: '0 0 1rem 0', fontSize: '0.94rem', color: 'var(--text-secondary, #4E4A42)' }}>
            Sign in with an invited family email address to view records, historical photos, and primary scans.
          </p>

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
                  autoComplete="email"
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

          <div className="wiki-divider-label" aria-hidden="true" style={{ marginTop: '1.25rem' }}>
            <span>or</span>
          </div>

          <div className="wiki-signin-section">
            <a
              href={googleStartUrl}
              className="pill-btn wiki-google-btn"
              style={{ textDecoration: 'none', textAlign: 'center', width: '100%' }}
            >
              Continue with Google
            </a>
          </div>
        </section>
      </main>
      <KinloomFooter />
    </div>
  );
};
