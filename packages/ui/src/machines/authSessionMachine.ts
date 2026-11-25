import type {
  ArchiveCapabilities,
  ArchiveDataSource,
  ArchiveSessionState,
  AuthMemberRole,
} from '@kinloom/core';
import {
  canAutoEnrollViaInvite,
  canCompleteAdminAuth,
  canCompleteMemberEditorAuth,
  resolveCapabilities,
} from '@kinloom/core';
import { assign, fromPromise, setup } from 'xstate';
import type { SnapshotFrom } from 'xstate';
import { createActorContext } from '@xstate/react';

export interface AuthSessionContext {
  pendingInviteToken: string | null;
  inviteLabel: string | null;
  email: string | null;
  displayName: string | null;
  role: AuthMemberRole | null;
  autoEnrolledViaInvite: boolean;
  authError: string | null;
  dataSource?: ArchiveDataSource;
}

export type AuthSessionEvent =
  | { type: 'OPEN_INVITE'; token: string; label: string; revoked: boolean }
  | { type: 'SIGN_IN_GOOGLE' }
  | { type: 'REQUEST_MAGIC_LINK'; email: string }
  | { type: 'OPEN_MAGIC_LINK'; token: string }
  | { type: 'RESEND_MAGIC_LINK'; email: string }
  | { type: 'CANCEL_MAGIC_LINK' }
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
  dataSource?: ArchiveDataSource;
}

function hydrateOutcomeFromSession(session: ArchiveSessionState): HydrateOutcome {
  if (session.authenticated && session.principal_kind === 'user') {
    const role: AuthMemberRole = session.role === 'admin' ? 'admin' : 'editor';
    return {
      kind: 'authenticated',
      email: session.email ?? '',
      displayName: session.displayName ?? session.email ?? 'Member',
      role,
    };
  }
  if (session.principal_kind === 'invite_viewer') {
    return {
      kind: 'invite_valid',
      token: 'cookie-invite',
      label: session.inviteLabel ?? 'Family invite',
    };
  }
  return { kind: 'anonymous' };
}

function readHydrateOutput(event: unknown): HydrateOutcome | null {
  if (typeof event !== 'object' || event === null || !('output' in event)) {
    return null;
  }
  const output = (event as { output: unknown }).output;
  if (typeof output !== 'object' || output === null || !('kind' in output)) {
    return null;
  }
  const kind = (output as { kind: unknown }).kind;
  if (
    kind === 'authenticated' ||
    kind === 'invite_valid' ||
    kind === 'invite_revoked' ||
    kind === 'anonymous'
  ) {
    return output as HydrateOutcome;
  }
  return null;
}

function readVerifyOutput(event: unknown): VerifyOutcome | null {
  if (typeof event !== 'object' || event === null || !('output' in event)) {
    return null;
  }
  const output = (event as { output: unknown }).output;
  if (typeof output !== 'object' || output === null || !('kind' in output)) {
    return null;
  }
  const kind = (output as { kind: unknown }).kind;
  if (kind === 'verified' || kind === 'invite_revoked' || kind === 'invalid') {
    return output as VerifyOutcome;
  }
  return null;
}

export const authSessionMachine = setup({
  types: {
    context: {} as AuthSessionContext,
    events: {} as AuthSessionEvent,
    input: {} as AuthSessionInput,
  },
  actors: {
    hydrateSession: fromPromise<
      HydrateOutcome,
      { inviteToken: string | null; dataSource?: ArchiveDataSource }
    >(async ({ input, signal }) => {
      if (input.dataSource?.getSession) {
        const res = await input.dataSource.getSession();
        return hydrateOutcomeFromSession(res.session);
      }
      const res = await fetch('/api/auth/me', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal,
      });
      if (!res.ok) {
        return { kind: 'anonymous' };
      }
      const data = (await res.json()) as { session?: ArchiveSessionState };
      if (!data.session) {
        return { kind: 'anonymous' };
      }
      return hydrateOutcomeFromSession(data.session);
    }),
    signInWithGoogle: fromPromise<VerifyOutcome, { inviteToken: string | null }>(
      async ({ input, signal }) => {
        const res = await fetch('/api/auth/google/verify', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ invite_token: input.inviteToken }),
          signal,
        });
        if (res.status === 403) {
          return { kind: 'invalid', message: 'This email is not enrolled in this family archive.' };
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} verifying Google sign-in`);
        }
        return (await res.json()) as VerifyOutcome;
      },
    ),
    requestMagicLink: fromPromise<
      void,
      { email: string; inviteToken: string | null; dataSource?: ArchiveDataSource }
    >(async ({ input, signal }) => {
      if (input.dataSource?.requestMagicLink) {
        await input.dataSource.requestMagicLink(input.email);
        return;
      }
      const res = await fetch('/api/auth/magic-link/request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: input.email, invite_token: input.inviteToken }),
        signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} requesting magic link`);
      }
    }),
    verifyMagicLink: fromPromise<
      VerifyOutcome,
      { token: string; inviteToken: string | null }
    >(async ({ input, signal }) => {
      const res = await fetch(
        `/api/auth/magic-link/verify?token=${encodeURIComponent(input.token)}`,
        {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal,
        },
      );
      if (res.status === 403) {
        return { kind: 'invalid', message: 'This email is not enrolled in this family archive.' };
      }
      if (!res.ok) {
        return { kind: 'invalid', message: 'Magic link is invalid or expired.' };
      }
      return (await res.json()) as VerifyOutcome;
    }),
  },
  guards: {
    hasValidPendingInvite: ({ context }) => context.pendingInviteToken !== null,
    isAdminHydration: ({ event }) => {
      const output = readHydrateOutput(event);
      return output !== null && output.kind === 'authenticated' && output.role === 'admin';
    },
    isEditorHydration: ({ event }) => {
      const output = readHydrateOutput(event);
      return output !== null && output.kind === 'authenticated' && output.role === 'editor';
    },
    isValidInviteHydration: ({ event }) => {
      const output = readHydrateOutput(event);
      return output !== null && output.kind === 'invite_valid';
    },
    isRevokedInviteHydration: ({ event }) => {
      const output = readHydrateOutput(event);
      return output !== null && output.kind === 'invite_revoked';
    },
    isAdminAuthSuccess: ({ event }) => {
      const output = readVerifyOutput(event);
      return (
        output !== null &&
        output.kind === 'verified' &&
        canCompleteAdminAuth(output.isMember, output.role)
      );
    },
    isMemberEditorAuthSuccess: ({ event }) => {
      const output = readVerifyOutput(event);
      return (
        output !== null &&
        output.kind === 'verified' &&
        canCompleteMemberEditorAuth(output.isMember, output.role)
      );
    },
    isInviteAutoEnrollSuccess: ({ context, event }) => {
      const output = readVerifyOutput(event);
      return (
        output !== null &&
        output.kind === 'verified' &&
        canAutoEnrollViaInvite(output.isMember, context.pendingInviteToken !== null)
      );
    },
    isVerifyInviteRevoked: ({ context, event }) => {
      const output = readVerifyOutput(event);
      return (
        context.pendingInviteToken !== null &&
        output !== null &&
        output.kind === 'invite_revoked'
      );
    },
  },
  actions: {
    clearToAnonymous: assign(() => ({
      pendingInviteToken: null,
      inviteLabel: null,
      email: null,
      displayName: null,
      role: null,
      autoEnrolledViaInvite: false,
      authError: null,
    })),
    markInviteRevoked: assign(() => ({
      pendingInviteToken: null,
      inviteLabel: null,
      email: null,
      displayName: null,
      role: null,
      autoEnrolledViaInvite: false,
      authError: 'This invite link has expired or been revoked.',
    })),
  },
}).createMachine({
  id: 'authSession',
  initial: 'hydrating',
  context: ({ input }) => ({
    pendingInviteToken: input?.initialInviteToken ?? null,
    inviteLabel: null,
    email: null,
    displayName: null,
    role: null,
    autoEnrolledViaInvite: false,
    authError: null,
    dataSource: input?.dataSource,
  }),
  states: {
    hydrating: {
      tags: ['loading'],
      invoke: {
        src: 'hydrateSession',
        input: ({ context }) => ({
          inviteToken: context.pendingInviteToken,
          dataSource: context.dataSource,
        }),
        onDone: [
          {
            guard: 'isAdminHydration',
            target: 'authenticated.admin',
            actions: assign(({ event }) =>
              event.output.kind === 'authenticated'
                ? {
                    pendingInviteToken: null,
                    inviteLabel: null,
                    email: event.output.email,
                    displayName: event.output.displayName,
                    role: 'admin' as const,
                    autoEnrolledViaInvite: false,
                    authError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isEditorHydration',
            target: 'authenticated.editor',
            actions: assign(({ event }) =>
              event.output.kind === 'authenticated'
                ? {
                    pendingInviteToken: null,
                    inviteLabel: null,
                    email: event.output.email,
                    displayName: event.output.displayName,
                    role: 'editor' as const,
                    autoEnrolledViaInvite: false,
                    authError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isValidInviteHydration',
            target: 'readOnlyInvite',
            actions: assign(({ event }) =>
              event.output.kind === 'invite_valid'
                ? {
                    pendingInviteToken: event.output.token,
                    inviteLabel: event.output.label,
                    role: null,
                    autoEnrolledViaInvite: false,
                    authError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isRevokedInviteHydration',
            target: 'inviteRevoked',
            actions: [{ type: 'markInviteRevoked' }],
          },
          { target: 'anonymous', actions: [{ type: 'clearToAnonymous' }] },
        ],
        onError: { target: 'anonymous', actions: [{ type: 'clearToAnonymous' }] },
      },
    },
    anonymous: {
      tags: ['signedOut'],
      on: {
        SIGN_IN_GOOGLE: { target: 'signingInGoogle' },
        REQUEST_MAGIC_LINK: {
          target: 'requestingMagicLink',
          actions: assign(({ event }) => ({ email: event.email, authError: null })),
        },
        REFRESH_SESSION: { target: 'hydrating' },
        OPEN_INVITE: [
          {
            guard: ({ event }) => event.revoked,
            target: 'inviteRevoked',
            actions: [{ type: 'markInviteRevoked' }],
          },
          {
            target: 'readOnlyInvite',
            actions: assign(({ event }) => ({
              pendingInviteToken: event.token,
              inviteLabel: event.label,
              authError: null,
            })),
          },
        ],
      },
    },
    readOnlyInvite: {
      tags: ['readOnly', 'invited'],
      on: {
        SIGN_IN_GOOGLE: { target: 'signingInGoogle' },
        REQUEST_MAGIC_LINK: {
          target: 'requestingMagicLink',
          actions: assign(({ event }) => ({ email: event.email, authError: null })),
        },
        INVITE_REVOKED_SERVER: {
          target: 'inviteRevoked',
          actions: [{ type: 'markInviteRevoked' }],
        },
        LEAVE_INVITE: { target: 'anonymous', actions: [{ type: 'clearToAnonymous' }] },
        REFRESH_SESSION: { target: 'hydrating' },
      },
    },
    signingInGoogle: {
      tags: ['loading'],
      invoke: {
        src: 'signInWithGoogle',
        input: ({ context }) => ({ inviteToken: context.pendingInviteToken }),
        onDone: [
          {
            guard: 'isAdminAuthSuccess',
            target: 'authenticated.admin',
            actions: assign(({ event }) =>
              event.output.kind === 'verified'
                ? {
                    pendingInviteToken: null,
                    inviteLabel: null,
                    email: event.output.email,
                    displayName: event.output.displayName,
                    role: 'admin' as const,
                    autoEnrolledViaInvite: false,
                    authError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isMemberEditorAuthSuccess',
            target: 'authenticated.editor',
            actions: assign(({ event }) =>
              event.output.kind === 'verified'
                ? {
                    pendingInviteToken: null,
                    inviteLabel: null,
                    email: event.output.email,
                    displayName: event.output.displayName,
                    role: 'editor' as const,
                    autoEnrolledViaInvite: false,
                    authError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isInviteAutoEnrollSuccess',
            target: 'authenticated.editor',
            actions: assign(({ event }) =>
              event.output.kind === 'verified'
                ? {
                    pendingInviteToken: null,
                    inviteLabel: null,
                    email: event.output.email,
                    displayName: event.output.displayName,
                    role: 'editor' as const,
                    autoEnrolledViaInvite: true,
                    authError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isVerifyInviteRevoked',
            target: 'inviteRevoked',
            actions: [{ type: 'markInviteRevoked' }],
          },
          {
            guard: 'hasValidPendingInvite',
            target: 'readOnlyInvite',
            actions: assign(({ event }) => ({
              authError:
                event.output.kind === 'invalid' ? event.output.message : 'Google sign-in failed.',
            })),
          },
          {
            target: 'anonymous',
            actions: assign(({ event }) => ({
              pendingInviteToken: null,
              authError:
                event.output.kind === 'invalid'
                  ? event.output.message
                  : 'This email is not enrolled in this family archive.',
            })),
          },
        ],
        onError: [
          {
            guard: 'hasValidPendingInvite',
            target: 'readOnlyInvite',
            actions: assign(({ event }) => ({
              authError: event.error instanceof Error ? event.error.message : String(event.error),
            })),
          },
          {
            target: 'anonymous',
            actions: assign(({ event }) => ({
              authError: event.error instanceof Error ? event.error.message : String(event.error),
            })),
          },
        ],
      },
    },
    requestingMagicLink: {
      tags: ['loading'],
      invoke: {
        src: 'requestMagicLink',
        input: ({ context }) => ({
          email: context.email ?? '',
          inviteToken: context.pendingInviteToken,
          dataSource: context.dataSource,
        }),
        onDone: { target: 'awaitingMagicLinkClick' },
        onError: [
          {
            guard: 'hasValidPendingInvite',
            target: 'readOnlyInvite',
            actions: assign(({ event }) => ({
              authError: event.error instanceof Error ? event.error.message : String(event.error),
            })),
          },
          {
            target: 'anonymous',
            actions: assign(({ event }) => ({
              authError: event.error instanceof Error ? event.error.message : String(event.error),
            })),
          },
        ],
      },
    },
    awaitingMagicLinkClick: {
      tags: ['awaitingEmail'],
      on: {
        OPEN_MAGIC_LINK: { target: 'verifyingMagicLink' },
        RESEND_MAGIC_LINK: {
          target: 'requestingMagicLink',
          actions: assign(({ event }) => ({ email: event.email, authError: null })),
        },
        CANCEL_MAGIC_LINK: [
          { guard: 'hasValidPendingInvite', target: 'readOnlyInvite' },
          { target: 'anonymous' },
        ],
      },
    },
    verifyingMagicLink: {
      tags: ['loading'],
      invoke: {
        src: 'verifyMagicLink',
        input: ({ context, event }) => ({
          token: event.type === 'OPEN_MAGIC_LINK' ? event.token : '',
          inviteToken: context.pendingInviteToken,
        }),
        onDone: [
          {
            guard: 'isAdminAuthSuccess',
            target: 'authenticated.admin',
            actions: assign(({ event }) =>
              event.output.kind === 'verified'
                ? {
                    pendingInviteToken: null,
                    inviteLabel: null,
                    email: event.output.email,
                    displayName: event.output.displayName,
                    role: 'admin' as const,
                    autoEnrolledViaInvite: false,
                    authError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isMemberEditorAuthSuccess',
            target: 'authenticated.editor',
            actions: assign(({ event }) =>
              event.output.kind === 'verified'
                ? {
                    pendingInviteToken: null,
                    inviteLabel: null,
                    email: event.output.email,
                    displayName: event.output.displayName,
                    role: 'editor' as const,
                    autoEnrolledViaInvite: false,
                    authError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isInviteAutoEnrollSuccess',
            target: 'authenticated.editor',
            actions: assign(({ event }) =>
              event.output.kind === 'verified'
                ? {
                    pendingInviteToken: null,
                    inviteLabel: null,
                    email: event.output.email,
                    displayName: event.output.displayName,
                    role: 'editor' as const,
                    autoEnrolledViaInvite: true,
                    authError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isVerifyInviteRevoked',
            target: 'inviteRevoked',
            actions: [{ type: 'markInviteRevoked' }],
          },
          {
            guard: 'hasValidPendingInvite',
            target: 'readOnlyInvite',
            actions: assign(({ event }) => ({
              authError:
                event.output.kind === 'invalid'
                  ? event.output.message
                  : 'Magic link verification failed.',
            })),
          },
          {
            target: 'anonymous',
            actions: assign(({ event }) => ({
              pendingInviteToken: null,
              authError:
                event.output.kind === 'invalid'
                  ? event.output.message
                  : 'This email is not enrolled in this family archive.',
            })),
          },
        ],
        onError: [
          {
            guard: 'hasValidPendingInvite',
            target: 'readOnlyInvite',
            actions: assign(({ event }) => ({
              authError: event.error instanceof Error ? event.error.message : String(event.error),
            })),
          },
          {
            target: 'anonymous',
            actions: assign(({ event }) => ({
              authError: event.error instanceof Error ? event.error.message : String(event.error),
            })),
          },
        ],
      },
    },
    authenticated: {
      initial: 'editor',
      tags: ['authenticated', 'canWrite'],
      states: {
        editor: { tags: ['editor'] },
        admin: { tags: ['admin'] },
      },
      on: {
        SESSION_EXPIRED: {
          target: '#authSession.sessionExpired',
          actions: assign(() => ({
            role: null,
            pendingInviteToken: null,
            authError: 'Your session expired. Sign in again to keep editing.',
          })),
        },
        SIGN_OUT: {
          target: '#authSession.anonymous',
          actions: [{ type: 'clearToAnonymous' }],
        },
        REFRESH_SESSION: { target: '#authSession.hydrating' },
      },
    },
    sessionExpired: {
      tags: ['expired'],
      on: {
        SIGN_IN_GOOGLE: { target: 'signingInGoogle' },
        REQUEST_MAGIC_LINK: {
          target: 'requestingMagicLink',
          actions: assign(({ event }) => ({ email: event.email, authError: null })),
        },
        SIGN_OUT: { target: 'anonymous', actions: [{ type: 'clearToAnonymous' }] },
      },
    },
    inviteRevoked: {
      tags: ['revoked'],
      on: {
        DISMISS_INVITE: { target: 'anonymous', actions: [{ type: 'clearToAnonymous' }] },
      },
    },
  },
});

export const AuthSessionActorContext = createActorContext(authSessionMachine);

export type AuthSessionSnapshot = SnapshotFrom<typeof authSessionMachine>;

/**
 * Derive ArchiveSessionState and ArchiveCapabilities from an authSessionMachine snapshot.
 */
export function deriveSessionFromAuthSnapshot(
  snapshot: AuthSessionSnapshot,
  options?: { allowTalk?: boolean; hasRevisionHistory?: boolean },
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
