import { ApiClientError } from '../../adapters/httpWikiDataSource.js';

export type AuthProviderKind = 'google' | 'magic_link' | 'invite';

export type AuthErrorTone = 'error' | 'warning' | 'info';

export type AuthErrorCode =
  | 'INVITE_REQUIRED'
  | 'GOOGLE_CANCELLED'
  | 'GOOGLE_AUTH_FAILED'
  | 'INVALID_OAUTH_STATE'
  | 'AUTH_PROVIDER_UNCONFIGURED'
  | 'MAGIC_LINK_EXPIRED'
  | 'MAGIC_LINK_USED'
  | 'MAGIC_LINK_INVALID'
  | 'TOKEN_INVALID_OR_EXPIRED'
  | 'INVITE_EXPIRED'
  | 'INVITE_REVOKED'
  | 'INVITE_INVALID'
  | 'INVITE_INVALID_OR_REVOKED'
  | 'RATE_LIMITED'
  | 'EMAIL_SENDER_UNCONFIGURED'
  | 'EMAIL_RECIPIENT_NOT_ALLOWED'
  | 'EMAIL_DELIVERY_FAILED'
  | 'VALIDATION_ERROR'
  | 'CSRF_ORIGIN_MISMATCH'
  | 'NETWORK_ERROR'
  | 'AUTH_ERROR';

export interface AuthUrlError {
  readonly code: string;
  readonly provider: AuthProviderKind | null;
}

export interface AuthFeedback {
  readonly code: AuthErrorCode;
  readonly provider: AuthProviderKind | null;
  readonly tone: AuthErrorTone;
  readonly title: string;
  readonly detail: string;
  readonly hint?: string;
  readonly showSwitchGoogleAccount: boolean;
  readonly showInvitePaste: boolean;
  readonly focusEmailInput: boolean;
}

export type ParsedInviteInput =
  | { readonly ok: true; readonly token: string; readonly path: string }
  | { readonly ok: false; readonly message: string };

const VALID_AUTH_ERROR_CODES: ReadonlySet<AuthErrorCode> = new Set<AuthErrorCode>([
  'INVITE_REQUIRED',
  'GOOGLE_CANCELLED',
  'GOOGLE_AUTH_FAILED',
  'INVALID_OAUTH_STATE',
  'AUTH_PROVIDER_UNCONFIGURED',
  'MAGIC_LINK_EXPIRED',
  'MAGIC_LINK_USED',
  'MAGIC_LINK_INVALID',
  'TOKEN_INVALID_OR_EXPIRED',
  'INVITE_EXPIRED',
  'INVITE_REVOKED',
  'INVITE_INVALID',
  'INVITE_INVALID_OR_REVOKED',
  'RATE_LIMITED',
  'EMAIL_SENDER_UNCONFIGURED',
  'EMAIL_RECIPIENT_NOT_ALLOWED',
  'EMAIL_DELIVERY_FAILED',
  'VALIDATION_ERROR',
  'CSRF_ORIGIN_MISMATCH',
  'NETWORK_ERROR',
  'AUTH_ERROR',
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RAW_INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,256}$/;

export function normalizeAuthProvider(raw: string | null | undefined): AuthProviderKind | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'google' || normalized === 'magic_link' || normalized === 'invite') {
    return normalized;
  }
  return null;
}

export function normalizeAuthErrorCode(raw: string | null | undefined): AuthErrorCode {
  if (!raw) {
    return 'AUTH_ERROR';
  }
  const normalized = raw.trim().toUpperCase();
  if (VALID_AUTH_ERROR_CODES.has(normalized as AuthErrorCode)) {
    return normalized as AuthErrorCode;
  }
  return 'AUTH_ERROR';
}

export function resolveAuthFeedback(params: {
  code: string | null | undefined;
  provider?: AuthProviderKind | null;
  hasGoogleProvider?: boolean;
}): AuthFeedback {
  const code = normalizeAuthErrorCode(params.code);
  const provider = params.provider ?? null;
  const hasGoogle = params.hasGoogleProvider ?? false;

  switch (code) {
    case 'INVITE_REQUIRED':
      if (provider === 'google') {
        return {
          code,
          provider,
          tone: 'warning',
          title: "That Google account isn't on the family list yet",
          detail:
            'You may have a different email address already invited, or you can open a family invite link first and then sign in with Google.',
          hint: 'Once you open a family invite link on this device, signing in with Google enrolls your account automatically.',
          showSwitchGoogleAccount: hasGoogle,
          showInvitePaste: true,
          focusEmailInput: false,
        };
      }
      return {
        code,
        provider,
        tone: 'warning',
        title: "That email isn't on the family list yet",
        detail:
          'Try another family email address, or open a family invite link first before signing in.',
        hint: 'If you do not have a family invite link yet, ask the family archivist to share one with you.',
        showSwitchGoogleAccount: false,
        showInvitePaste: true,
        focusEmailInput: true,
      };

    case 'GOOGLE_CANCELLED':
      return {
        code,
        provider: provider ?? 'google',
        tone: 'info',
        title: 'Google sign-in was canceled',
        detail: 'You can try Google again or request a one-time sign-in link by email below.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    case 'INVALID_OAUTH_STATE':
      return {
        code,
        provider: provider ?? 'google',
        tone: 'warning',
        title: 'Your sign-in session expired',
        detail:
          'Your sign-in check timed out or cookies were blocked. Tap Continue with Google to try again, or use an email sign-in link below.',
        hint: 'Stay in the same browser window and make sure cookies are allowed while signing in.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    case 'GOOGLE_AUTH_FAILED':
      return {
        code,
        provider: provider ?? 'google',
        tone: 'error',
        title: 'Google sign-in could not be completed',
        detail:
          'Google returned a sign-in problem. Try again in a moment, or request a one-time sign-in link by email below.',
        showSwitchGoogleAccount: hasGoogle,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    case 'AUTH_PROVIDER_UNCONFIGURED':
      return {
        code,
        provider: provider ?? 'google',
        tone: 'info',
        title: 'Google sign-in is not turned on for this archive',
        detail: 'Enter your invited email address below to get a one-time sign-in link instead.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: true,
      };

    case 'MAGIC_LINK_EXPIRED':
      return {
        code,
        provider: provider ?? 'magic_link',
        tone: 'warning',
        title: 'That sign-in link has expired',
        detail:
          'Sign-in links work once and last 15 minutes. Enter your email below to get a fresh link.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: true,
      };

    case 'MAGIC_LINK_USED':
      return {
        code,
        provider: provider ?? 'magic_link',
        tone: 'warning',
        title: 'That sign-in link was already used',
        detail:
          'Sign-in links work once and last 15 minutes. Enter your email below to get a fresh link.',
        hint: hasGoogle
          ? 'Some email apps preview links automatically. If this keeps happening, try Continue with Google.'
          : 'Some email apps preview links automatically. Try opening the fresh link directly in your browser.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: true,
      };

    case 'MAGIC_LINK_INVALID':
    case 'TOKEN_INVALID_OR_EXPIRED':
      return {
        code,
        provider: provider ?? 'magic_link',
        tone: 'warning',
        title: 'That sign-in link has expired or was already used',
        detail:
          'Sign-in links work once and last 15 minutes. Enter your email below to get a fresh one.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: true,
      };

    case 'INVITE_EXPIRED':
      return {
        code,
        provider: provider ?? 'invite',
        tone: 'warning',
        title: 'That family invite link has expired',
        detail:
          'Ask the family archivist for a fresh invite link, or sign in below if your email is already enrolled.',
        showSwitchGoogleAccount: false,
        showInvitePaste: true,
        focusEmailInput: false,
      };

    case 'INVITE_REVOKED':
      return {
        code,
        provider: provider ?? 'invite',
        tone: 'warning',
        title: 'That family invite link is no longer active',
        detail:
          'This invite link was turned off by the archive administrator. Ask the family archivist for a fresh invite link, or sign in below if your email is already enrolled.',
        showSwitchGoogleAccount: false,
        showInvitePaste: true,
        focusEmailInput: false,
      };

    case 'INVITE_INVALID':
    case 'INVITE_INVALID_OR_REVOKED':
      return {
        code,
        provider: provider ?? 'invite',
        tone: 'warning',
        title: 'That family invite link was not recognized',
        detail:
          'The link may be incomplete or no longer active. Ask the family archivist for a fresh invite link, or sign in below if your email is already enrolled.',
        showSwitchGoogleAccount: false,
        showInvitePaste: true,
        focusEmailInput: false,
      };

    case 'RATE_LIMITED':
      return {
        code,
        provider: provider ?? 'magic_link',
        tone: 'warning',
        title: 'Too many sign-in links requested',
        detail:
          'Please wait a few minutes before asking for another link, and check your inbox or spam folder for one already sent.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    case 'EMAIL_SENDER_UNCONFIGURED':
      return {
        code,
        provider: provider ?? 'magic_link',
        tone: 'error',
        title: 'Email sign-in is not available right now',
        detail: hasGoogle
          ? 'This archive cannot send sign-in emails yet. Use Continue with Google below, or ask the family archivist for help.'
          : 'This archive cannot send sign-in emails yet. Ask the family archivist for help.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    case 'EMAIL_RECIPIENT_NOT_ALLOWED':
      return {
        code,
        provider: provider ?? 'magic_link',
        tone: 'error',
        title: 'We could not send email to that address',
        detail: hasGoogle
          ? 'This archive cannot deliver sign-in email to that address yet. Try Continue with Google below, or ask the family archivist for help.'
          : 'This archive cannot deliver sign-in email to that address yet. Ask the family archivist for help.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    case 'EMAIL_DELIVERY_FAILED':
      return {
        code,
        provider: provider ?? 'magic_link',
        tone: 'error',
        title: 'We could not send your sign-in email',
        detail: hasGoogle
          ? 'The email service had a temporary problem. Wait a moment and try again, or use Continue with Google below.'
          : 'The email service had a temporary problem. Wait a moment and try again.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    case 'VALIDATION_ERROR':
      return {
        code,
        provider: provider ?? 'magic_link',
        tone: 'error',
        title: 'Check your email address',
        detail: 'Enter a valid email address like relative@example.com and try again.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: true,
      };

    case 'CSRF_ORIGIN_MISMATCH':
      return {
        code,
        provider,
        tone: 'warning',
        title: 'Please reload and try again',
        detail: 'Your browser blocked this request for security. Reload this page and try again.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    case 'NETWORK_ERROR':
      return {
        code,
        provider,
        tone: 'error',
        title: 'Could not reach the family archive',
        detail: 'Check your internet connection and try again.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    case 'AUTH_ERROR':
      return {
        code,
        provider,
        tone: 'error',
        title: 'Sign-in could not be completed',
        detail: 'Please try again, or ask the family archivist for help.',
        showSwitchGoogleAccount: false,
        showInvitePaste: false,
        focusEmailInput: false,
      };

    default: {
      const _exhaustive: never = code;
      throw new Error(`Unhandled auth error code: ${String(_exhaustive)}`);
    }
  }
}

export function resolveClientAuthError(
  error: unknown,
  provider: AuthProviderKind,
  hasGoogleProvider: boolean,
): AuthFeedback {
  if (error instanceof ApiClientError) {
    return resolveAuthFeedback({
      code: error.code,
      provider,
      hasGoogleProvider,
    });
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return resolveAuthFeedback({
      code: 'NETWORK_ERROR',
      provider,
      hasGoogleProvider,
    });
  }

  if (error instanceof TypeError) {
    return resolveAuthFeedback({
      code: 'NETWORK_ERROR',
      provider,
      hasGoogleProvider,
    });
  }

  if (error instanceof Error && /network|failed to fetch|offline|load failed/i.test(error.message)) {
    return resolveAuthFeedback({
      code: 'NETWORK_ERROR',
      provider,
      hasGoogleProvider,
    });
  }

  return resolveAuthFeedback({
    code: 'AUTH_ERROR',
    provider,
    hasGoogleProvider,
  });
}

export function validateEmailInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'Please enter your email address.';
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    return 'Enter an email address in the format relative@example.com.';
  }
  return null;
}

export function parseInviteInput(raw: string): ParsedInviteInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: 'Paste a family invite link or invite code first.',
    };
  }

  const looksLikeUrlOrPath =
    /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.includes('/');

  if (looksLikeUrlOrPath) {
    let parsed: URL;
    try {
      parsed = /^https?:\/\//i.test(trimmed)
        ? new URL(trimmed)
        : trimmed.startsWith('/')
          ? new URL(trimmed, 'https://kinloom.local')
          : new URL(`https://${trimmed}`);
    } catch {
      return {
        ok: false,
        message:
          'That does not look like a valid invite link. Copy the full link from your family message or email.',
      };
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    let rawSegment: string | null = null;
    if (segments.length === 2 && segments[0] === 'invite') {
      rawSegment = segments[1];
    } else if (
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'auth' &&
      segments[2] === 'invite'
    ) {
      rawSegment = segments[3];
    }

    if (!rawSegment) {
      return {
        ok: false,
        message:
          'That link is not a family invite link. Look for a link that includes /invite/ followed by a code.',
      };
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment).trim();
    } catch {
      return {
        ok: false,
        message: 'That invite link appears cut off or damaged. Ask the family archivist to resend it.',
      };
    }

    if (!RAW_INVITE_TOKEN_PATTERN.test(decoded)) {
      return {
        ok: false,
        message: 'That invite code looks incomplete. Check that you copied the full invite link.',
      };
    }

    return {
      ok: true,
      token: decoded,
      path: `/invite/${encodeURIComponent(decoded)}`,
    };
  }

  if (!RAW_INVITE_TOKEN_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message:
        'That does not look like a family invite link or code. Paste the full invite link from your family message or email.',
    };
  }

  return {
    ok: true,
    token: trimmed,
    path: `/invite/${encodeURIComponent(trimmed)}`,
  };
}

export function readAuthErrorFromSearch(search: string): AuthUrlError | null {
  if (!search) {
    return null;
  }
  const params = new URLSearchParams(search);
  const rawCode = params.get('auth_error')?.trim();
  if (!rawCode) {
    return null;
  }
  return {
    code: rawCode,
    provider: normalizeAuthProvider(params.get('auth_provider')),
  };
}

export function stripAuthErrorParams(pathname: string, search: string, hash = ''): string {
  const safePath = pathname.startsWith('/') ? pathname : '/';
  const params = new URLSearchParams(search);
  params.delete('auth_error');
  params.delete('auth_provider');
  const qs = params.toString();
  return `${safePath}${qs ? `?${qs}` : ''}${hash}`;
}

export function consumeAuthErrorFromWindow(): AuthUrlError | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const found = readAuthErrorFromSearch(window.location.search);
  if (!found) {
    return null;
  }
  const cleaned = stripAuthErrorParams(
    window.location.pathname,
    window.location.search,
    window.location.hash,
  );
  try {
    window.history.replaceState(window.history.state, '', cleaned);
  } catch {
    // Ignore history restrictions in sandboxed test environments.
  }
  return found;
}

export function getCleanNextPath(): string {
  if (typeof window === 'undefined') {
    return '/';
  }
  return stripAuthErrorParams(window.location.pathname, window.location.search);
}
