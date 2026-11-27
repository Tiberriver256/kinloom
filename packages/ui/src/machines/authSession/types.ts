import type { ArchiveDataSource, ArchiveSessionState, AuthMemberRole } from '@kinloom/core';

export interface AuthSessionContext {
  pendingInviteToken: string | null;
  inviteLabel: string | null;
  email: string | null;
  displayName: string | null;
  role: AuthMemberRole | null;
  autoEnrolledViaInvite: boolean;
  magicLinkResendCount: number;
  authError: string | null;
  authErrorDetail: unknown;
  initialSession?: ArchiveSessionState | null;
  dataSource?: ArchiveDataSource;
}

export type AuthSessionEvent =
  | { type: 'OPEN_INVITE'; token: string; label: string; revoked: boolean }
  | { type: 'SIGN_IN_GOOGLE' }
  | { type: 'REQUEST_MAGIC_LINK'; email: string }
  | { type: 'OPEN_MAGIC_LINK'; token: string }
  | { type: 'RESEND_MAGIC_LINK'; email: string }
  | { type: 'CANCEL_MAGIC_LINK' }
  | { type: 'CLEAR_AUTH_ERROR' }
  | { type: 'SYNC_DATA_SOURCE'; dataSource?: ArchiveDataSource }
  | { type: 'INVITE_REVOKED_SERVER' }
  | { type: 'LEAVE_INVITE' }
  | { type: 'DISMISS_INVITE' }
  | { type: 'SESSION_EXPIRED' }
  | { type: 'SIGN_OUT' }
  | { type: 'REFRESH_SESSION' };

export type HydrateOutcome =
  | { kind: 'authenticated'; email: string; displayName: string; role: AuthMemberRole }
  | { kind: 'invite_valid'; token: string; label: string }
  | { kind: 'invite_revoked' }
  | { kind: 'anonymous' };

export type VerifyOutcome =
  | {
      kind: 'verified';
      isMember: boolean;
      role: AuthMemberRole;
      email: string;
      displayName: string;
    }
  | { kind: 'invite_revoked' }
  | { kind: 'invalid'; message: string };

export interface AuthSessionInput {
  initialInviteToken?: string | null;
  initialSession?: ArchiveSessionState | null;
  dataSource?: ArchiveDataSource;
}
