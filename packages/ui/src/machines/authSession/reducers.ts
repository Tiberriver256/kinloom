import type { ArchiveAuthProviders, ArchiveCapabilities, ArchiveSessionState } from '@kinloom/core';
import { resolveCapabilities } from '@kinloom/core';
import type { AuthSessionContext, HydrateOutcome } from './types.js';

export function buildHydratedPatch(
  outcome: HydrateOutcome,
  currentAuthProviders: ArchiveAuthProviders,
  hasServerAuthProviders: boolean
): Partial<AuthSessionContext> {
  const nextProviders = outcome.authProviders ?? currentAuthProviders;
  const nextHasServerProviders = outcome.authProviders !== undefined || hasServerAuthProviders;
  const nextServerCapabilities = outcome.capabilities ?? null;

  if (outcome.kind === 'authenticated') {
    return {
      initialSession: undefined,
      pendingInviteToken: null,
      inviteLabel: null,
      email: outcome.email,
      displayName: outcome.displayName,
      role: outcome.role,
      magicLinkResendCount: 0,
      authError: null,
      authErrorDetail: null,
      serverCapabilities: nextServerCapabilities,
      authProviders: nextProviders,
      hasServerAuthProviders: nextHasServerProviders,
    };
  }
  if (outcome.kind === 'invite_valid') {
    return {
      initialSession: undefined,
      pendingInviteToken: outcome.token,
      inviteLabel: outcome.label,
      role: null,
      magicLinkResendCount: 0,
      authError: null,
      authErrorDetail: null,
      serverCapabilities: nextServerCapabilities,
      authProviders: nextProviders,
      hasServerAuthProviders: nextHasServerProviders,
    };
  }
  return {
    initialSession: undefined,
    pendingInviteToken: null,
    inviteLabel: null,
    email: null,
    displayName: null,
    role: null,
    magicLinkResendCount: 0,
    authError: null,
    authErrorDetail: null,
    serverCapabilities: nextServerCapabilities,
    authProviders: nextProviders,
    hasServerAuthProviders: nextHasServerProviders,
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
  matches(
    stateValue:
      | 'readOnlyInvite'
      | 'requestingMagicLink'
      | 'awaitingMagicLinkClick'
      | 'signingOut'
      | { authenticated: 'admin' | 'editor' }
  ): boolean;
}

function normalizeCapabilitiesOverride(override: Partial<ArchiveCapabilities>): ArchiveCapabilities {
  return {
    canEdit: override.canEdit ?? false,
    canUploadMedia: override.canUploadMedia ?? false,
    hasRevisionHistory: override.hasRevisionHistory ?? false,
    hasTalk: override.hasTalk ?? false,
    canManageSite: override.canManageSite ?? false,
  };
}

/**
 * Derive ArchiveSessionState, ArchiveCapabilities, and ArchiveAuthProviders
 * from an authSessionMachine snapshot.
 */
export function deriveSessionFromAuthSnapshot(
  snapshot: AuthSessionSnapshotLike,
  options?: { allowTalk?: boolean; hasRevisionHistory?: boolean }
): {
  session: ArchiveSessionState;
  capabilities: ArchiveCapabilities;
  authProviders: ArchiveAuthProviders;
} {
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
  } else if (snapshot.matches('signingOut') && snapshot.context.role !== null) {
    session = {
      authenticated: true,
      principal_kind: 'user',
      email: snapshot.context.email ?? undefined,
      displayName: snapshot.context.displayName ?? undefined,
      role: snapshot.context.role,
    };
  } else if (
    snapshot.matches('readOnlyInvite') ||
    ((snapshot.matches('requestingMagicLink') || snapshot.matches('awaitingMagicLinkClick')) &&
      snapshot.context.pendingInviteToken !== null)
  ) {
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

  let capabilities: ArchiveCapabilities;
  if (options) {
    capabilities = resolveCapabilities(session, options);
  } else if (snapshot.context.capabilitiesOverride) {
    capabilities = normalizeCapabilitiesOverride(snapshot.context.capabilitiesOverride);
  } else if (snapshot.context.serverCapabilities) {
    capabilities = snapshot.context.serverCapabilities;
  } else {
    capabilities = resolveCapabilities(session);
  }

  return {
    session,
    capabilities,
    authProviders: snapshot.context.authProviders,
  };
}
