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
  capabilitiesOverride?: Partial<ArchiveCapabilities> | undefined;
  authProviders: ArchiveAuthProviders;
  hasServerAuthProviders: boolean;
  hasExplicitSession: boolean;
  initialSession?: ArchiveSessionState | null | undefined;
  dataSource?: ArchiveDataSource | undefined;
}

export type AuthSessionEvent =
  | { type: 'REQUEST_MAGIC_LINK'; email: string }
  | { type: 'RESEND_MAGIC_LINK'; email: string }
  | { type: 'CANCEL_MAGIC_LINK' }
  | { type: 'SET_URL_ERROR'; urlError: AuthUrlErrorState | null }
  | { type: 'CLEAR_AUTH_ERROR' }
  | { type: 'SYNC_DATA_SOURCE'; dataSource?: ArchiveDataSource | undefined }
  | { type: 'SYNC_CAPABILITIES_OVERRIDE'; capabilities?: Partial<ArchiveCapabilities> | undefined }
  | { type: 'SYNC_EXPLICIT_SESSION'; session: ArchiveSessionState | null }
  | { type: 'SIGN_OUT' }
  | { type: 'REFRESH_SESSION' };

export type HydrateOutcome =
  | {
      kind: 'authenticated';
      email: string;
      displayName: string;
      role: AuthMemberRole;
      capabilities?: ArchiveCapabilities | undefined;
      authProviders?: ArchiveAuthProviders | undefined;
    }
  | {
      kind: 'invite_valid';
      token: string;
      label: string;
      capabilities?: ArchiveCapabilities | undefined;
      authProviders?: ArchiveAuthProviders | undefined;
    }
  | {
      kind: 'anonymous';
      capabilities?: ArchiveCapabilities | undefined;
      authProviders?: ArchiveAuthProviders | undefined;
    };

export interface AuthSessionInput {
  initialInviteToken?: string | null | undefined;
  initialSession?: ArchiveSessionState | null | undefined;
  hasExplicitSession?: boolean | undefined;
  capabilitiesOverride?: Partial<ArchiveCapabilities> | undefined;
  dataSource?: ArchiveDataSource | undefined;
}
