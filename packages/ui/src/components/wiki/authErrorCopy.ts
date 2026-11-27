import { ApiClientError } from '../../adapters/httpWikiDataSource.js';
import {
  type AuthErrorCode,
  type AuthErrorTone,
  type AuthFeedback,
  type AuthProviderKind,
  type AuthUrlError,
  normalizeAuthErrorCode,
  normalizeAuthProvider,
  type ParsedInviteInput,
  resolveAuthFeedback,
} from './authError/feedbackCatalog.js';

export type { AuthErrorCode, AuthErrorTone, AuthFeedback, AuthProviderKind, AuthUrlError, ParsedInviteInput };
export { normalizeAuthErrorCode, normalizeAuthProvider, resolveAuthFeedback };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RAW_INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,256}$/;

export function resolveClientAuthError(
  error: unknown,
  provider: AuthProviderKind,
  hasGoogleProvider: boolean
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
    window.location.hash
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
