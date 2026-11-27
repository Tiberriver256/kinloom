import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { HttpWikiDataSource } from '../../adapters/httpWikiDataSource.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import { scrollBehaviorForMotion } from '../../lib/keyboardNav.js';
import {
  type AuthFeedback,
  type AuthUrlError,
  getCleanNextPath,
  parseInviteInput,
  resolveAuthFeedback,
  resolveClientAuthError,
  validateEmailInput,
} from './authErrorCopy.js';
import cssMod0 from './WikiSurfaces.module.css';

const uiStyles = cssMod0;

export interface AuthSignInFlowProps {
  initialUrlError?: AuthUrlError | null;
  inviteLabel?: string;
  showInviteHelper?: boolean;
  onNavigateToInvite?: (invitePath: string) => void;
  emailInputRef?: React.RefObject<HTMLInputElement | null>;
  feedbackRef?: React.RefObject<HTMLDivElement | null>;
}

function buildGoogleUrl(dataSource: unknown, nextPath: string, selectAccount: boolean): string {
  if (dataSource instanceof HttpWikiDataSource) {
    return dataSource.getGoogleSignInUrl(nextPath, { selectAccount });
  }
  const params = new URLSearchParams();
  if (nextPath) {
    params.set('next', nextPath);
  }
  if (selectAccount) {
    params.set('select_account', '1');
  }
  const qs = params.toString();
  return `/api/auth/google/start${qs ? `?${qs}` : ''}`;
}

function defaultNavigateToInvite(path: string): void {
  if (typeof window !== 'undefined') {
    window.location.assign(path);
  }
}

export const AuthSignInFlow: React.FC<AuthSignInFlowProps> = ({
  initialUrlError = null,
  inviteLabel,
  showInviteHelper = true,
  onNavigateToInvite = defaultNavigateToInvite,
  emailInputRef: externalEmailInputRef,
  feedbackRef: externalFeedbackRef,
}) => {
  const { dataSource, authProviders } = useArchiveData();
  const baseId = useId();
  const internalEmailInputRef = useRef<HTMLInputElement | null>(null);
  const internalFeedbackRef = useRef<HTMLDivElement | null>(null);
  const emailInputRef = externalEmailInputRef ?? internalEmailInputRef;
  const feedbackRef = externalFeedbackRef ?? internalFeedbackRef;
  const inviteInputRef = useRef<HTMLInputElement | null>(null);
  const inviteFormRef = useRef<HTMLFormElement | null>(null);
  const sentTitleRef = useRef<HTMLParagraphElement | null>(null);
  const inviteOpenedByUserRef = useRef(false);

  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendCount, setResendCount] = useState(0);

  const [urlError, setUrlError] = useState<AuthUrlError | null>(initialUrlError);
  const [submitFeedback, setSubmitFeedback] = useState<AuthFeedback | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteValue, setInviteValue] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    setUrlError(initialUrlError);
    if (initialUrlError) {
      setSubmitFeedback(null);
      setSentTo(null);
    }
  }, [initialUrlError]);

  const activeFeedback: AuthFeedback | null =
    submitFeedback ??
    (urlError
      ? resolveAuthFeedback({
          code: urlError.code,
          provider: urlError.provider,
          hasGoogleProvider: authProviders.google,
        })
      : null);

  useEffect(() => {
    if (activeFeedback?.showInvitePaste && showInviteHelper) {
      inviteOpenedByUserRef.current = false;
      setInviteOpen(true);
    }
  }, [activeFeedback?.showInvitePaste, showInviteHelper]);

  useEffect(() => {
    if (!inviteOpen) {
      return;
    }
    if (inviteOpenedByUserRef.current) {
      inviteInputRef.current?.focus();
    } else if (typeof inviteFormRef.current?.scrollIntoView === 'function') {
      inviteFormRef.current.scrollIntoView({
        block: 'nearest',
        behavior: scrollBehaviorForMotion(),
      });
    }
  }, [inviteOpen]);

  useEffect(() => {
    if (sentTo !== null) {
      sentTitleRef.current?.focus();
    }
  }, [sentTo]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus feedback banner when feedback code changes
  useEffect(() => {
    if (activeFeedback?.focusEmailInput && !sentTo && authProviders.magicLink) {
      emailInputRef.current?.focus();
    }
  }, [activeFeedback?.focusEmailInput, activeFeedback?.code, sentTo, authProviders.magicLink, emailInputRef]);

  const nextPath = getCleanNextPath();
  const googleStartUrl = buildGoogleUrl(dataSource, nextPath, false);
  const googleSwitchAccountUrl = buildGoogleUrl(dataSource, nextPath, true);

  const emailInputId = `${baseId}-email`;
  const emailErrorId = `${baseId}-email-error`;
  const invitePanelId = `${baseId}-invite-panel`;
  const inviteInputId = `${baseId}-invite`;
  const inviteHintId = `${baseId}-invite-hint`;
  const inviteErrorId = `${baseId}-invite-error`;

  const clearFeedback = (): void => {
    setSubmitFeedback(null);
    setUrlError(null);
  };

  const sendMagicLink = async (targetEmail: string, isResend: boolean): Promise<void> => {
    if (!dataSource.requestMagicLink) {
      setSubmitFeedback(
        resolveAuthFeedback({
          code: 'EMAIL_SENDER_UNCONFIGURED',
          provider: 'magic_link',
          hasGoogleProvider: authProviders.google,
        })
      );
      return;
    }

    setSending(true);
    clearFeedback();
    try {
      await dataSource.requestMagicLink(targetEmail);
      setSentTo(targetEmail);
      setResendCount((count) => (isResend ? count + 1 : 0));
    } catch (err) {
      setSubmitFeedback(resolveClientAuthError(err, 'magic_link', authProviders.google));
      if (isResend) {
        setSentTo(null);
      }
    } finally {
      setSending(false);
    }
  };

  const handleMagicLinkSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = email.trim();
    const validationError = validateEmailInput(trimmed);
    if (validationError) {
      setEmailTouched(true);
      setEmailError(validationError);
      emailInputRef.current?.focus();
      return;
    }
    setEmailError(null);
    await sendMagicLink(trimmed, false);
  };

  const handleInviteSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const parsed = parseInviteInput(inviteValue);
    if (!parsed.ok) {
      setInviteError(parsed.message);
      inviteInputRef.current?.focus();
      return;
    }
    setInviteError(null);
    onNavigateToInvite(parsed.path);
  };

  const handleUseDifferentEmail = (): void => {
    setSentTo(null);
    setResendCount(0);
    clearFeedback();
    setEmailError(null);
    window.setTimeout(() => {
      emailInputRef.current?.focus();
    }, 0);
  };

  const canShowInviteHelper = showInviteHelper && (!inviteLabel || Boolean(activeFeedback?.showInvitePaste));

  return (
    <div className={cx(uiStyles, 'wiki-auth-flow')}>
      {inviteLabel && !activeFeedback && !sentTo && (
        <div className={cx(uiStyles, 'wiki-status-banner is-info')}>
          <p>
            Invited via <strong>{inviteLabel}</strong>.{' '}
            {authProviders.google
              ? 'Sign in with your email or Google to add stories, photos, and updates.'
              : 'Enter your email below to receive a one-click sign-in link and add stories, photos, and updates.'}
          </p>
        </div>
      )}

      {activeFeedback && (
        <div
          ref={feedbackRef}
          tabIndex={-1}
          className={cx(uiStyles, `wiki-status-banner is-${activeFeedback.tone} wiki-auth-feedback`)}
          role={activeFeedback.tone === 'info' ? 'status' : 'alert'}
          aria-live={activeFeedback.tone === 'info' ? 'polite' : 'assertive'}
        >
          <p className={cx(uiStyles, 'wiki-auth-feedback-title')}>
            <strong>{activeFeedback.title}</strong>
          </p>
          <p>{activeFeedback.detail}</p>
          {activeFeedback.hint && (
            <p className={cx(uiStyles, 'wiki-auth-feedback-hint')}>{activeFeedback.hint}</p>
          )}
          {activeFeedback.showSwitchGoogleAccount && (
            <div className={cx(uiStyles, 'wiki-auth-feedback-actions')}>
              <a
                href={googleSwitchAccountUrl}
                className={cx(uiStyles, 'wiki-btn-secondary wiki-btn-full')}
                onClick={clearFeedback}
              >
                Try a different Google account
              </a>
            </div>
          )}
        </div>
      )}

      {authProviders.magicLink &&
        (sentTo ? (
          <output className={cx(uiStyles, 'wiki-status-banner is-success wiki-auth-sent')} aria-live="polite">
            <p ref={sentTitleRef} tabIndex={-1} className={cx(uiStyles, 'wiki-auth-feedback-title')}>
              <strong>
                {resendCount > 0 ? 'Fresh sign-in link sent' : 'Check your email for a sign-in link'}
              </strong>
            </p>
            <p>
              If <strong>{sentTo}</strong> is enrolled in this archive, a one-time sign-in link is on its way
              (valid for 15 minutes).
            </p>
            <p className={cx(uiStyles, 'wiki-auth-feedback-hint')}>
              Do not see it yet? Check your spam folder, try another family email, or open a family invite
              link first.
            </p>
            <div className={cx(uiStyles, 'wiki-auth-sent-actions')}>
              <button
                type="button"
                className={cx(uiStyles, 'wiki-btn-secondary')}
                disabled={sending}
                onClick={() => {
                  void sendMagicLink(sentTo, true);
                }}
              >
                {sending ? 'Sending link…' : 'Send another link'}
              </button>
              <button
                type="button"
                className={cx(uiStyles, 'wiki-btn-link')}
                disabled={sending}
                onClick={handleUseDifferentEmail}
              >
                Use a different email
              </button>
            </div>
          </output>
        ) : (
          <form
            className={cx(uiStyles, 'wiki-edit-form')}
            noValidate
            onSubmit={(e) => {
              void handleMagicLinkSubmit(e);
            }}
          >
            <div className={cx(uiStyles, 'wiki-field')}>
              <label htmlFor={emailInputId} className={cx(uiStyles, 'wiki-field-label')}>
                Email address
              </label>
              <input
                ref={emailInputRef}
                id={emailInputId}
                name="email"
                type="email"
                inputMode="email"
                required
                autoComplete="email"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="send"
                className={cx(uiStyles, 'wiki-input wiki-input-lg')}
                placeholder="relative@example.com"
                value={email}
                aria-invalid={emailError ? 'true' : 'false'}
                aria-describedby={emailError ? emailErrorId : undefined}
                onChange={(e) => {
                  const nextVal = e.target.value;
                  setEmail(nextVal);
                  setEmailTouched(true);
                  if (emailError) {
                    setEmailError(null);
                  }
                  if (submitFeedback || urlError) {
                    clearFeedback();
                  }
                }}
                onBlur={() => {
                  if (emailTouched && email.trim().length > 0) {
                    setEmailError(validateEmailInput(email));
                  }
                }}
                disabled={sending}
              />
              {emailError && (
                <p id={emailErrorId} className={cx(uiStyles, 'wiki-field-error')} role="alert">
                  {emailError}
                </p>
              )}
            </div>
            <div className={cx(uiStyles, 'wiki-form-actions')}>
              <button
                type="submit"
                className={cx(uiStyles, 'wiki-btn-primary wiki-btn-full')}
                disabled={sending}
              >
                {sending ? 'Sending link…' : 'Email Magic Link'}
              </button>
            </div>
          </form>
        ))}

      {authProviders.google && (
        <>
          {authProviders.magicLink && (
            <div className={cx(uiStyles, 'wiki-divider-label')} aria-hidden="true">
              <span>or</span>
            </div>
          )}

          <div className={cx(uiStyles, 'wiki-signin-section')}>
            <a href={googleStartUrl} className={cx(uiStyles, 'wiki-btn-secondary wiki-btn-full')}>
              Continue with Google
            </a>
          </div>
        </>
      )}

      {canShowInviteHelper && (
        <div className={cx(uiStyles, 'wiki-invite-helper')}>
          <button
            type="button"
            className={cx(uiStyles, 'wiki-invite-toggle')}
            aria-expanded={inviteOpen}
            aria-controls={invitePanelId}
            onClick={() => {
              inviteOpenedByUserRef.current = !inviteOpen;
              setInviteOpen((prev) => !prev);
              setInviteError(null);
            }}
          >
            {inviteOpen ? 'Hide family invite link' : 'Have a family invite link?'}
          </button>

          {inviteOpen && (
            <form
              ref={inviteFormRef}
              id={invitePanelId}
              className={cx(uiStyles, 'wiki-invite-form')}
              noValidate
              onSubmit={handleInviteSubmit}
            >
              <div className={cx(uiStyles, 'wiki-field')}>
                <label htmlFor={inviteInputId} className={cx(uiStyles, 'wiki-field-label')}>
                  Family invite link or code
                </label>
                <span id={inviteHintId} className={cx(uiStyles, 'wiki-field-hint')}>
                  Paste the full link from your family message or just the invite code.
                </span>
                <input
                  ref={inviteInputRef}
                  id={inviteInputId}
                  name="invite"
                  type="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="go"
                  className={cx(uiStyles, 'wiki-input wiki-input-lg')}
                  placeholder="https://.../invite/abc123 or abc123"
                  value={inviteValue}
                  aria-invalid={inviteError ? 'true' : 'false'}
                  aria-describedby={inviteError ? `${inviteHintId} ${inviteErrorId}` : inviteHintId}
                  onChange={(e) => {
                    setInviteValue(e.target.value);
                    if (inviteError) {
                      setInviteError(null);
                    }
                  }}
                />
                {inviteError && (
                  <p id={inviteErrorId} className={cx(uiStyles, 'wiki-field-error')} role="alert">
                    {inviteError}
                  </p>
                )}
              </div>
              <button type="submit" className={cx(uiStyles, 'wiki-btn-secondary wiki-btn-full')}>
                Open Invite Link
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};
