import type { ArchiveCapabilities, ArchiveSessionState } from '@kinloom/core';
import { resolveCapabilities } from '@kinloom/core';
import type { AuthSessionContext, HydrateOutcome, VerifyOutcome } from './types.js';

export function buildVerifiedAuthPatch(
  output: VerifyOutcome,
  role: 'admin' | 'editor',
  autoEnrolledViaInvite: boolean
): Partial<AuthSessionContext> {
  if (output.kind !== 'verified') {
    return {};
  }
  return {
    pendingInviteToken: null,
    inviteLabel: null,
    email: output.email,
    displayName: output.displayName,
    role,
    autoEnrolledViaInvite,
    magicLinkResendCount: 0,
    authError: null,
    authErrorDetail: null,
  };
}

export function buildHydratedPatch(outcome: HydrateOutcome): Partial<AuthSessionContext> {
  if (outcome.kind === 'authenticated') {
    return {
      initialSession: undefined,
      pendingInviteToken: null,
      inviteLabel: null,
      email: outcome.email,
      displayName: outcome.displayName,
      role: outcome.role,
      autoEnrolledViaInvite: false,
      magicLinkResendCount: 0,
      authError: null,
      authErrorDetail: null,
    };
  }
  if (outcome.kind === 'invite_valid') {
    return {
      initialSession: undefined,
      pendingInviteToken: outcome.token,
      inviteLabel: outcome.label,
      role: null,
      autoEnrolledViaInvite: false,
      magicLinkResendCount: 0,
      authError: null,
      authErrorDetail: null,
    };
  }
  return {
    initialSession: undefined,
    pendingInviteToken: null,
    inviteLabel: null,
    email: null,
    displayName: null,
    role: null,
    autoEnrolledViaInvite: false,
    magicLinkResendCount: 0,
    authError: null,
    authErrorDetail: null,
  };
}

export function formatAuthErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

export interface AuthSessionSnapshotLike {
  readonly context: AuthSessionContext;
  matches(stateValue: 'readOnlyInvite' | { authenticated: 'admin' | 'editor' }): boolean;
}

/**
 * Derive ArchiveSessionState and ArchiveCapabilities from an authSessionMachine snapshot.
 */
export function deriveSessionFromAuthSnapshot(
  snapshot: AuthSessionSnapshotLike,
  options?: { allowTalk?: boolean; hasRevisionHistory?: boolean }
): { session: ArchiveSessionState; capabilities: ArchiveCapabilities } {
  let session: ArchiveSessionState;
  if (snapshot.matches({ authenticated: 'admin' })) {
    session = {
      authenticated: true,
      principal_kind: 'user',
      email: snapshot.context.email ?? undefined,
      displayName: snapshot.context.displayName ?? undefined,
      role: 'admin',
    };
  } else if (snapshot.matches({ authenticated: 'editor' })) {
    session = {
      authenticated: true,
      principal_kind: 'user',
      email: snapshot.context.email ?? undefined,
      displayName: snapshot.context.displayName ?? undefined,
      role: 'editor',
    };
  } else if (snapshot.matches('readOnlyInvite')) {
    session = {
      authenticated: false,
      principal_kind: 'invite_viewer',
      role: 'viewer',
      inviteLabel: snapshot.context.inviteLabel ?? undefined,
    };
  } else {
    session = {
      authenticated: false,
      principal_kind: 'anonymous',
    };
  }

  return {
    session,
    capabilities: resolveCapabilities(session, options),
  };
}
