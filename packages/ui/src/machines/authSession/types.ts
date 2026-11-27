import type {
  ArchiveAuthProviders,
  ArchiveCapabilities,
  ArchiveDataSource,
  ArchiveSessionState,
  AuthMemberRole,
} from '@kinloom/core';

export interface AuthUrlErrorState {
  readonly code: string;
  readonly provider: 'google' | 'magic_link' | 'invite' | null;
}

export interface AuthSessionContext {
  pendingInviteToken: string | null;
  inviteLabel: string | null;
  email: string | null;
  displayName: string | null;
  role: AuthMemberRole | null;
  magicLinkResendCount: number;
  authError: string | null;
  authErrorDetail: unknown;
  urlError: AuthUrlErrorState | null;
  serverCapabilities: ArchiveCapabilities | null;
  capabilitiesOverride?: Partial<ArchiveCapabilities>;
  authProviders: ArchiveAuthProviders;
  hasServerAuthProviders: boolean;
  hasExplicitSession: boolean;
  initialSession?: ArchiveSessionState | null;
  dataSource?: ArchiveDataSource;
}

export type AuthSessionEvent =
  | { type: 'REQUEST_MAGIC_LINK'; email: string }
  | { type: 'RESEND_MAGIC_LINK'; email: string }
  | { type: 'CANCEL_MAGIC_LINK' }
  | { type: 'SET_URL_ERROR'; urlError: AuthUrlErrorState | null }
  | { type: 'CLEAR_AUTH_ERROR' }
  | { type: 'SYNC_DATA_SOURCE'; dataSource?: ArchiveDataSource }
  | { type: 'SYNC_CAPABILITIES_OVERRIDE'; capabilities?: Partial<ArchiveCapabilities> }
  | { type: 'SYNC_EXPLICIT_SESSION'; session: ArchiveSessionState | null }
  | { type: 'SIGN_OUT' }
  | { type: 'REFRESH_SESSION' };

export type HydrateOutcome =
  | {
      kind: 'authenticated';
      email: string;
      displayName: string;
      role: AuthMemberRole;
      capabilities?: ArchiveCapabilities;
      authProviders?: ArchiveAuthProviders;
    }
  | {
      kind: 'invite_valid';
      token: string;
      label: string;
      capabilities?: ArchiveCapabilities;
      authProviders?: ArchiveAuthProviders;
    }
  | {
      kind: 'anonymous';
      capabilities?: ArchiveCapabilities;
      authProviders?: ArchiveAuthProviders;
    };

export interface AuthSessionInput {
  initialInviteToken?: string | null;
  initialSession?: ArchiveSessionState | null;
  hasExplicitSession?: boolean;
  capabilitiesOverride?: Partial<ArchiveCapabilities>;
  dataSource?: ArchiveDataSource;
}
