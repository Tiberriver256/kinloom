import type { ArchiveDataSource } from '@kinloom/core';
import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { scrollBehaviorForMotion } from '../../hooks/keyboardNav.js';
import { cx, joinClasses } from '../../lib/cx.js';
import { AuthSessionActorContext } from '../../machines/authSessionMachine.js';
import {
  type AuthFeedback,
  type AuthUrlError,
  getCleanNextPath,
  parseInviteInput,
  resolveAuthFeedback,
  resolveClientAuthError,
  validateEmailInput,
} from './authErrorCopy.js';
import wikiAuthStyles from './WikiAuth.module.css';
import wikiChromeStyles from './WikiChrome.module.css';
import wikiFormStyles from './WikiForms.module.css';
import wikiPanelStyles from './WikiPanels.module.css';

export interface AuthSignInFlowProps {
  initialUrlError?: AuthUrlError | null | undefined;
  inviteLabel?: string | undefined;
  showInviteHelper?: boolean | undefined;
  onNavigateToInvite?: ((invitePath: string) => void) | undefined;
  emailInputRef?: React.RefObject<HTMLInputElement | null> | undefined;
  feedbackRef?: React.RefObject<HTMLDivElement | null> | undefined;
}

function buildGoogleUrl(
  dataSource: ArchiveDataSource,
  nextPath: string,
  selectAccount: boolean
): string | null {
  return dataSource.getGoogleSignInUrl?.(nextPath, { selectAccount }) ?? null;
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
  const authActorRef = AuthSessionActorContext.useActorRef();
  const authSnapshot = AuthSessionActorContext.useSelector((state) => state);
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

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteValue, setInviteValue] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    authActorRef.send({ type: 'SET_URL_ERROR', urlError: initialUrlError });
  }, [authActorRef, initialUrlError]);

  const sending = authSnapshot.matches('requestingMagicLink');
  const resendCount = authSnapshot.context.magicLinkResendCount;
  const urlError = authSnapshot.context.urlError;
  const sentTo =
    authSnapshot.matches('awaitingMagicLinkClick') ||
    (authSnapshot.matches('requestingMagicLink') && resendCount > 0)
      ? authSnapshot.context.email
      : null;

  const submitFeedback: AuthFeedback | null =
    authSnapshot.context.authErrorDetail !== null && authSnapshot.context.authErrorDetail !== undefined
      ? resolveClientAuthError(authSnapshot.context.authErrorDetail, 'magic_link', authProviders.google)
      : authSnapshot.context.authError
        ? resolveClientAuthError(
            new Error(authSnapshot.context.authError),
            'magic_link',
            authProviders.google
          )
        : null;

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
  const canSignInWithGoogle = Boolean(authProviders.google && googleStartUrl);

  const emailInputId = `${baseId}-email`;
  const emailErrorId = `${baseId}-email-error`;
  const invitePanelId = `${baseId}-invite-panel`;
  const inviteInputId = `${baseId}-invite`;
  const inviteHintId = `${baseId}-invite-hint`;
  const inviteErrorId = `${baseId}-invite-error`;

  const clearFeedback = (): void => {
    authActorRef.send({ type: 'CLEAR_AUTH_ERROR' });
  };

  const handleMagicLinkSubmit = (e: React.FormEvent): void => {
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
    authActorRef.send({ type: 'REQUEST_MAGIC_LINK', email: trimmed });
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
    authActorRef.send({ type: 'CANCEL_MAGIC_LINK' });
    clearFeedback();
    setEmailError(null);
    window.setTimeout(() => {
      emailInputRef.current?.focus();
    }, 0);
  };

  const canShowInviteHelper = showInviteHelper && (!inviteLabel || Boolean(activeFeedback?.showInvitePaste));

  return (
    <div className={cx(wikiAuthStyles, 'wiki-auth-flow')}>
      {inviteLabel && !activeFeedback && !sentTo && (
        <div className={cx(wikiPanelStyles, 'wiki-status-banner is-info')}>
          <p>
            Invited via <strong>{inviteLabel}</strong>.{' '}
            {canSignInWithGoogle
              ? 'Sign in with your email or Google to add stories, photos, and updates.'
              : 'Enter your email below to receive a one-click sign-in link and add stories, photos, and updates.'}
          </p>
        </div>
      )}

      {activeFeedback && (
        <div
          ref={feedbackRef}
          tabIndex={-1}
          className={joinClasses(
            cx(wikiPanelStyles, `wiki-status-banner is-${activeFeedback.tone}`),
            cx(wikiAuthStyles, 'wiki-auth-feedback')
          )}
          role={activeFeedback.tone === 'info' ? 'status' : 'alert'}
          aria-live={activeFeedback.tone === 'info' ? 'polite' : 'assertive'}
        >
          <p className={cx(wikiAuthStyles, 'wiki-auth-feedback-title')}>
            <strong>{activeFeedback.title}</strong>
          </p>
          <p>{activeFeedback.detail}</p>
          {activeFeedback.hint && (
            <p className={cx(wikiAuthStyles, 'wiki-auth-feedback-hint')}>{activeFeedback.hint}</p>
          )}
          {activeFeedback.showSwitchGoogleAccount && googleSwitchAccountUrl && (
            <div className={cx(wikiAuthStyles, 'wiki-auth-feedback-actions')}>
              <a
                href={googleSwitchAccountUrl}
                className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-full')}
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
          <output
            className={joinClasses(
              cx(wikiPanelStyles, 'wiki-status-banner is-success'),
              cx(wikiAuthStyles, 'wiki-auth-sent')
            )}
            aria-live="polite"
          >
            <p ref={sentTitleRef} tabIndex={-1} className={cx(wikiAuthStyles, 'wiki-auth-feedback-title')}>
              <strong>
                {resendCount > 0 ? 'Fresh sign-in link sent' : 'Check your email for a sign-in link'}
              </strong>
            </p>
            <p>
              If <strong>{sentTo}</strong> is enrolled in this archive, a one-time sign-in link is on its way
              (valid for 15 minutes).
            </p>
            <p className={cx(wikiAuthStyles, 'wiki-auth-feedback-hint')}>
              Do not see it yet? Check your spam folder, try another family email, or open a family invite
              link first.
            </p>
            <div className={cx(wikiAuthStyles, 'wiki-auth-sent-actions')}>
              <button
                type="button"
                className={cx(wikiChromeStyles, 'wiki-btn-secondary')}
                disabled={sending}
                onClick={() => {
                  authActorRef.send({ type: 'RESEND_MAGIC_LINK', email: sentTo });
                }}
              >
                {sending ? 'Sending link…' : 'Send another link'}
              </button>
              <button
                type="button"
                className={cx(wikiChromeStyles, 'wiki-btn-link')}
                disabled={sending}
                onClick={handleUseDifferentEmail}
              >
                Use a different email
              </button>
            </div>
          </output>
        ) : (
          <form className={cx(wikiFormStyles, 'wiki-edit-form')} noValidate onSubmit={handleMagicLinkSubmit}>
            <div className={cx(wikiFormStyles, 'wiki-field')}>
              <label htmlFor={emailInputId} className={cx(wikiAuthStyles, 'wiki-auth-label')}>
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
                className={cx(wikiFormStyles, 'wiki-input wiki-input-lg')}
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
                <p id={emailErrorId} className={cx(wikiAuthStyles, 'wiki-field-error')} role="alert">
                  {emailError}
                </p>
              )}
            </div>
            <div className={cx(wikiPanelStyles, 'wiki-form-actions')}>
              <button
                type="submit"
                className={cx(wikiChromeStyles, 'wiki-btn-primary wiki-btn-full')}
                disabled={sending}
              >
                {sending ? 'Sending link…' : 'Email Magic Link'}
              </button>
            </div>
          </form>
        ))}

      {canSignInWithGoogle && googleStartUrl && (
        <>
          {authProviders.magicLink && (
            <div className={cx(wikiAuthStyles, 'wiki-divider-label')} aria-hidden="true">
              <span>or</span>
            </div>
          )}

          <div className={'wiki-signin-section'}>
            <a href={googleStartUrl} className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-full')}>
              Continue with Google
            </a>
          </div>
        </>
      )}

      {canShowInviteHelper && (
        <div className={cx(wikiAuthStyles, 'wiki-invite-helper')}>
          <button
            type="button"
            className={cx(wikiAuthStyles, 'wiki-invite-toggle')}
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
              className={cx(wikiAuthStyles, 'wiki-invite-form')}
              noValidate
              onSubmit={handleInviteSubmit}
            >
              <div className={cx(wikiFormStyles, 'wiki-field')}>
                <label htmlFor={inviteInputId} className={cx(wikiAuthStyles, 'wiki-auth-label')}>
                  Family invite link or code
                </label>
                <span id={inviteHintId} className={cx(wikiAuthStyles, 'wiki-field-hint')}>
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
                  className={cx(wikiFormStyles, 'wiki-input wiki-input-lg')}
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
                  <p id={inviteErrorId} className={cx(wikiAuthStyles, 'wiki-field-error')} role="alert">
                    {inviteError}
                  </p>
                )}
              </div>
              <button type="submit" className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-full')}>
                Open Invite Link
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};
