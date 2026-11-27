import {
  type ArchiveAuthProviders,
  type ArchiveCapabilities,
  type ArchiveRepository,
  type ArchiveSessionState,
  type AuthProvider,
  type CallerPrincipal,
  type Clock,
  canAutoEnrollViaInvite,
  canCompleteAdminAuth,
  canCompleteMemberEditorAuth,
  type EmailSender,
  evaluateInviteStatus,
  type InviteRecord,
  isInviteActive,
  type KinloomSiteConfig,
  resolveCapabilities,
  type UserRecord,
} from '@kinloom/core';
import { z } from 'zod';
import { pkceChallengeFromVerifier, randomBase64Url, sha256Hex } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';

const EmailSchema = z.string().trim().email('Please provide a valid email address.');

export interface AuthServiceDeps {
  repository: ArchiveRepository;
  emailSender: EmailSender;
  authProvider?: AuthProvider;
  clock: Clock;
  siteConfig: KinloomSiteConfig;
  bootstrapAdminEmail?: string;
  magicLinkTtlMinutes?: number;
  magicLinkMaxPerWindow?: number;
  magicLinkWindowMs?: number;
}

const STRIPPED_NEXT_PARAMS = [
  'auth_error',
  'auth_provider',
  'code',
  'state',
  'token',
  'email',
  'error',
  'error_description',
] as const;

export function sanitizeNextPath(rawNext: string | null | undefined): string {
  if (!rawNext) {
    return '/';
  }
  const trimmed = rawNext.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return '/';
  }
  try {
    const parsed = new URL(trimmed, 'https://kinloom.local');
    if (parsed.origin !== 'https://kinloom.local') {
      return '/';
    }
    for (const key of STRIPPED_NEXT_PARAMS) {
      parsed.searchParams.delete(key);
    }
    const sanitized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return sanitized.startsWith('/') && !sanitized.startsWith('//') ? sanitized : '/';
  } catch {
    return '/';
  }
}

function defaultDisplayNameForEmail(email: string): string {
  const local = email.split('@')[0]?.trim();
  if (!local) {
    return 'Family Member';
  }
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export class AuthService {
  private readonly repository: ArchiveRepository;
  private readonly emailSender: EmailSender;
  private readonly authProvider?: AuthProvider;
  private readonly clock: Clock;
  private readonly siteConfig: KinloomSiteConfig;
  private readonly bootstrapAdminEmail: string | null;
  private readonly magicLinkTtlMinutes: number;
  private readonly magicLinkMaxPerWindow: number;
  private readonly magicLinkWindowMs: number;

  constructor(deps: AuthServiceDeps) {
    this.repository = deps.repository;
    this.emailSender = deps.emailSender;
    this.authProvider = deps.authProvider;
    this.clock = deps.clock;
    this.siteConfig = deps.siteConfig;
    this.bootstrapAdminEmail = deps.bootstrapAdminEmail
      ? deps.bootstrapAdminEmail.trim().toLowerCase()
      : null;
    this.magicLinkTtlMinutes = deps.magicLinkTtlMinutes ?? 15;
    this.magicLinkMaxPerWindow = deps.magicLinkMaxPerWindow ?? 10;
    this.magicLinkWindowMs = deps.magicLinkWindowMs ?? 60 * 60 * 1000;
  }

  private isGoogleAuthConfigured(): boolean {
    return Boolean(this.authProvider && this.authProvider.configured !== false);
  }

  getSessionInfo(principal: CallerPrincipal): {
    session: ArchiveSessionState;
    capabilities: ArchiveCapabilities;
    authProviders: ArchiveAuthProviders;
  } {
    let session: ArchiveSessionState;
    switch (principal.kind) {
      case 'user':
        session = {
          authenticated: true,
          principal_kind: 'user',
          email: principal.email,
          displayName: principal.display_name,
          role: principal.role,
        };
        break;
      case 'invite_viewer':
        session = {
          authenticated: false,
          principal_kind: 'invite_viewer',
          role: 'viewer',
          inviteLabel: principal.label,
        };
        break;
      case 'anonymous':
      case 'agent':
        session = {
          authenticated: false,
          principal_kind: 'anonymous',
        };
        break;
      default: {
        const _exhaustive: never = principal;
        throw new Error(`Unhandled principal kind: ${String(_exhaustive)}`);
      }
    }

    const capabilities = resolveCapabilities(session, {
      allowTalk: this.siteConfig.wiki?.allowTalk ?? true,
      hasRevisionHistory: true,
    });

    return {
      session,
      capabilities,
      authProviders: {
        google: this.isGoogleAuthConfigured(),
        magicLink: true,
      },
    };
  }

  async redeemInvite(token: string): Promise<{ invite: InviteRecord }> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new KinloomHttpError(404, 'INVITE_INVALID_OR_REVOKED', 'Invite link is invalid or revoked.', {
        invite_status: 'missing',
      });
    }
    const invite = await this.repository.getInvite(trimmed);
    const nowIso = this.clock.nowIso();
    if (!isInviteActive(invite, nowIso) || !invite) {
      throw new KinloomHttpError(
        404,
        'INVITE_INVALID_OR_REVOKED',
        'This invite link is invalid, expired, or has been revoked.',
        { invite_status: evaluateInviteStatus(invite, nowIso) }
      );
    }
    await this.repository.recordInviteUse(invite.token, nowIso);
    return {
      invite: {
        ...invite,
        uses: invite.uses + 1,
        last_used_at: nowIso,
      },
    };
  }

  async startGoogleAuth(params: {
    redirectUri: string;
    inviteToken: string | null;
    nextPath?: string | null;
    selectAccount?: boolean;
  }): Promise<{
    authorizationUrl: string;
    state: string;
    codeVerifier: string;
    inviteToken: string | null;
    nextPath: string;
  }> {
    if (!this.authProvider || !this.isGoogleAuthConfigured()) {
      throw new KinloomHttpError(
        503,
        'AUTH_PROVIDER_UNCONFIGURED',
        'Google OAuth is not configured for this archive.'
      );
    }

    const state = randomBase64Url(24);
    const codeVerifier = randomBase64Url(32);
    const codeChallenge = await pkceChallengeFromVerifier(codeVerifier);
    const nextPath = sanitizeNextPath(params.nextPath);

    const authorizationUrl = this.authProvider.buildAuthorizationUrl({
      state,
      codeChallenge,
      redirectUri: params.redirectUri,
      ...(params.selectAccount ? { prompt: 'select_account' as const } : {}),
    });

    return {
      authorizationUrl,
      state,
      codeVerifier,
      inviteToken: params.inviteToken,
      nextPath,
    };
  }

  async completeGoogleAuth(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    inviteToken: string | null;
  }): Promise<{ user: UserRecord; autoEnrolled: boolean }> {
    if (!this.authProvider || !this.isGoogleAuthConfigured()) {
      throw new KinloomHttpError(
        503,
        'AUTH_PROVIDER_UNCONFIGURED',
        'Google OAuth is not configured for this archive.'
      );
    }

    const profile = await this.authProvider.exchangeCode({
      code: params.code,
      codeVerifier: params.codeVerifier,
      redirectUri: params.redirectUri,
    });

    if (!profile.emailVerified) {
      throw new KinloomHttpError(403, 'INVITE_REQUIRED', 'A verified email address is required to sign in.');
    }

    return this.resolveOrEnrollUser({
      email: profile.email,
      displayName: profile.displayName,
      inviteToken: params.inviteToken,
    });
  }

  async requestMagicLink(params: {
    email: string;
    inviteToken: string | null;
    verifyBaseUrl: string;
    nextPath?: string | null;
  }): Promise<{ sent: true }> {
    const parsedEmail = EmailSchema.parse(params.email).toLowerCase();
    const nowMs = this.clock.now().getTime();
    const magicLinkTtlMs = this.magicLinkTtlMinutes * 60_000;
    const sinceIso = new Date(nowMs - this.magicLinkWindowMs + magicLinkTtlMs).toISOString();
    const recentCount = await this.repository.countRecentMagicLinks(parsedEmail, sinceIso);
    if (recentCount >= this.magicLinkMaxPerWindow) {
      throw new KinloomHttpError(
        429,
        'RATE_LIMITED',
        'Too many sign-in link requests. Please wait before trying again.'
      );
    }

    const nowIso = this.clock.nowIso();
    const expiresAt = new Date(nowMs + magicLinkTtlMs).toISOString();
    const existingUser = await this.repository.getUser(parsedEmail);
    const isBootstrap = this.bootstrapAdminEmail !== null && parsedEmail === this.bootstrapAdminEmail;

    let activeInviteToken: string | null = null;
    if (params.inviteToken) {
      const invite = await this.repository.getInvite(params.inviteToken);
      if (isInviteActive(invite, nowIso) && invite) {
        activeInviteToken = invite.token;
      }
    }

    const rawToken = randomBase64Url(32);
    const tokenHash = await sha256Hex(rawToken);

    // Constant 202 response prevents email enumeration: record a pre-consumed marker row so rate limiting
    // persists identically for unenrolled addresses, without sending mail or issuing a usable token.
    if (!existingUser && !isBootstrap && !activeInviteToken) {
      await this.repository.insertMagicLink({
        token_hash: tokenHash,
        email: parsedEmail,
        invite_token: null,
        expires_at: expiresAt,
        used_at: nowIso,
      });
      return { sent: true };
    }

    await this.repository.insertMagicLink({
      token_hash: tokenHash,
      email: parsedEmail,
      invite_token: activeInviteToken,
      expires_at: expiresAt,
      used_at: null,
    });

    const safeNext = sanitizeNextPath(params.nextPath);
    const verifyUrl = new URL(params.verifyBaseUrl);
    verifyUrl.searchParams.set('token', rawToken);
    if (safeNext !== '/') {
      verifyUrl.searchParams.set('next', safeNext);
    }

    try {
      await this.emailSender.sendMagicLink({
        toEmail: parsedEmail,
        siteTitle: this.siteConfig.site.title,
        magicLinkUrl: verifyUrl.toString(),
        expiresMinutes: this.magicLinkTtlMinutes,
      });
    } catch (error) {
      if (error instanceof KinloomHttpError) {
        throw error;
      }
      throw new KinloomHttpError(
        502,
        'EMAIL_DELIVERY_FAILED',
        'Unable to send sign-in email right now. Please try again later.'
      );
    }

    return { sent: true };
  }

  async verifyMagicLink(params: { rawToken: string }): Promise<{ user: UserRecord; autoEnrolled: boolean }> {
    const trimmed = params.rawToken.trim();
    if (trimmed.length < 8) {
      throw new KinloomHttpError(400, 'TOKEN_INVALID_OR_EXPIRED', 'Sign-in link is invalid.', {
        token_status: 'invalid',
      });
    }

    const tokenHash = await sha256Hex(trimmed);
    const nowIso = this.clock.nowIso();
    const consumed = await this.repository.consumeMagicLink(tokenHash, nowIso);
    if (!consumed) {
      let tokenStatus: 'used' | 'expired' | 'invalid' = 'expired';
      let message = 'Sign-in link has expired or has already been used.';
      if (this.repository.getMagicLink) {
        const existing = await this.repository.getMagicLink(tokenHash);
        if (!existing) {
          tokenStatus = 'invalid';
          message = 'This sign-in link is invalid.';
        } else if (existing.used_at !== null) {
          tokenStatus = 'used';
          message = 'This sign-in link has already been used.';
        } else {
          tokenStatus = 'expired';
          message = 'This sign-in link has expired.';
        }
      }
      throw new KinloomHttpError(400, 'TOKEN_INVALID_OR_EXPIRED', message, {
        token_status: tokenStatus,
      });
    }

    return this.resolveOrEnrollUser({
      email: consumed.email,
      displayName: defaultDisplayNameForEmail(consumed.email),
      inviteToken: consumed.invite_token,
    });
  }

  private async resolveOrEnrollUser(params: {
    email: string;
    displayName: string;
    inviteToken: string | null;
  }): Promise<{ user: UserRecord; autoEnrolled: boolean }> {
    const normalizedEmail = params.email.trim().toLowerCase();
    const nowIso = this.clock.nowIso();
    const existing = await this.repository.getUser(normalizedEmail);

    if (existing) {
      if (canCompleteAdminAuth(true, existing.role) || canCompleteMemberEditorAuth(true, existing.role)) {
        await this.repository.touchUserLogin(existing.email, nowIso);
        return {
          user: { ...existing, last_login_at: nowIso },
          autoEnrolled: false,
        };
      }
    }

    if (this.bootstrapAdminEmail !== null && normalizedEmail === this.bootstrapAdminEmail) {
      const bootstrapped = await this.repository.upsertUser({
        email: normalizedEmail,
        display_name: params.displayName.trim() || defaultDisplayNameForEmail(normalizedEmail),
        role: 'admin',
        added_by: 'bootstrap',
        added_at: nowIso,
        last_login_at: nowIso,
      });
      return { user: bootstrapped, autoEnrolled: false };
    }

    if (params.inviteToken) {
      const invite = await this.repository.getInvite(params.inviteToken);
      const inviteStatus = evaluateInviteStatus(invite, nowIso);
      const active = inviteStatus === 'active';

      // Guard invariant (Machine 2): invited non-members strictly auto-enroll as editor, never admin.
      if (canAutoEnrollViaInvite(false, active) && invite && !canCompleteAdminAuth(false, 'admin')) {
        const enrolled = await this.repository.upsertUser({
          email: normalizedEmail,
          display_name: params.displayName.trim() || defaultDisplayNameForEmail(normalizedEmail),
          role: 'editor',
          added_by: `invite:${invite.token}`,
          added_at: nowIso,
          last_login_at: nowIso,
        });
        return { user: enrolled, autoEnrolled: true };
      }

      throw new KinloomHttpError(403, 'INVITE_REQUIRED', 'This invite link has expired or been revoked.', {
        invite_status: inviteStatus,
      });
    }

    throw new KinloomHttpError(
      403,
      'INVITE_REQUIRED',
      'This email is not enrolled in this family archive. Open a family invite link first.'
    );
  }
}
