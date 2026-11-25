import type { ArchiveCapabilities, ArchiveSessionState } from '../contracts.js';
import type { UserRole } from '../schemas/revisions.js';

export type AuthMemberRole = UserRole;
export type InviteStatus = 'active' | 'revoked' | 'expired' | 'missing';

/**
 * Guard: only an already-enrolled member with role 'admin' may enter authenticated.admin.
 * Prevents non-member invite auto-enrollment from ever escalating to admin.
 */
export function canCompleteAdminAuth(
  isMember: boolean,
  role: AuthMemberRole | null | undefined
): boolean {
  return isMember === true && role === 'admin';
}

/**
 * Guard: existing enrolled editor member completes authentication into authenticated.editor.
 */
export function canCompleteMemberEditorAuth(
  isMember: boolean,
  role: AuthMemberRole | null | undefined
): boolean {
  return isMember === true && role === 'editor';
}

/**
 * Guard: non-member with a currently valid, non-revoked invite auto-enrolls strictly as an editor.
 */
export function canAutoEnrollViaInvite(isMember: boolean, hasValidInvite: boolean): boolean {
  return isMember === false && hasValidInvite === true;
}

/**
 * Classify a read-only invite record against the current ISO timestamp.
 */
export function evaluateInviteStatus(
  invite: { revoked_at: string | null; expires_at: string | null } | null | undefined,
  nowIso: string
): InviteStatus {
  if (!invite) {
    return 'missing';
  }
  if (invite.revoked_at !== null) {
    return 'revoked';
  }
  if (invite.expires_at !== null) {
    const expiresMs = Date.parse(invite.expires_at);
    const nowMs = Date.parse(nowIso);
    if (!Number.isNaN(expiresMs) && !Number.isNaN(nowMs) && expiresMs <= nowMs) {
      return 'expired';
    }
  }
  return 'active';
}

/**
 * Guard: returns true only when an invite exists, is not revoked, and has not expired.
 */
export function isInviteActive(
  invite: { revoked_at: string | null; expires_at: string | null } | null | undefined,
  nowIso: string
): boolean {
  return evaluateInviteStatus(invite, nowIso) === 'active';
}

export interface ResolveCapabilitiesOptions {
  allowTalk?: boolean;
  hasRevisionHistory?: boolean;
}

/**
 * Derive UI and API capabilities strictly from the authenticated session state.
 */
export function resolveCapabilities(
  session: Pick<ArchiveSessionState, 'authenticated' | 'principal_kind' | 'role'> | null | undefined,
  options?: ResolveCapabilitiesOptions
): ArchiveCapabilities {
  const allowTalk = options?.allowTalk ?? true;
  const hasHistory = options?.hasRevisionHistory ?? true;

  if (!session || session.principal_kind === 'anonymous') {
    return {
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: false,
      hasTalk: false,
      canManageSite: false,
    };
  }

  if (session.principal_kind === 'invite_viewer' || session.role === 'viewer') {
    return {
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: hasHistory,
      hasTalk: allowTalk,
      canManageSite: false,
    };
  }

  if (session.authenticated && session.principal_kind === 'user' && session.role === 'admin') {
    return {
      canEdit: true,
      canUploadMedia: true,
      hasRevisionHistory: hasHistory,
      hasTalk: allowTalk,
      canManageSite: true,
    };
  }

  if (session.authenticated && session.principal_kind === 'user' && session.role === 'editor') {
    return {
      canEdit: true,
      canUploadMedia: true,
      hasRevisionHistory: hasHistory,
      hasTalk: allowTalk,
      canManageSite: false,
    };
  }

  return {
    canEdit: false,
    canUploadMedia: false,
    hasRevisionHistory: false,
    hasTalk: false,
    canManageSite: false,
  };
}

export const deriveArchiveCapabilities = resolveCapabilities;
