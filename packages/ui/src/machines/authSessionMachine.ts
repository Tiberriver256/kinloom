import type { ArchiveCapabilities, ArchiveSessionState } from '@kinloom/core';
import {
  canAutoEnrollViaInvite,
  canCompleteAdminAuth,
  canCompleteMemberEditorAuth,
  resolveCapabilities,
} from '@kinloom/core';
import { createActorContext } from '@xstate/react';
import type { SnapshotFrom } from 'xstate';
import { assign, setup } from 'xstate';
import { authSessionActors, readHydrateOutput, readVerifyOutput } from './authSession/actors.js';
import type {
  AuthSessionContext,
  AuthSessionEvent,
  AuthSessionInput,
  HydrateOutcome,
  VerifyOutcome,
} from './authSession/types.js';

export type { AuthSessionContext, AuthSessionEvent, AuthSessionInput, HydrateOutcome, VerifyOutcome };

function buildVerifiedAuthPatch(
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
    authError: null,
  };
}

export const authSessionMachine = setup({
  types: {
    context: {} as AuthSessionContext,
    events: {} as AuthSessionEvent,
    input: {} as AuthSessionInput,
  },
  actors: authSessionActors,
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
        output !== null && output.kind === 'verified' && canCompleteAdminAuth(output.isMember, output.role)
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
      return context.pendingInviteToken !== null && output !== null && output.kind === 'invite_revoked';
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
                : {}
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
                : {}
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
                : {}
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
            actions: assign(({ event }) => buildVerifiedAuthPatch(event.output, 'admin', false)),
          },
          {
            guard: 'isMemberEditorAuthSuccess',
            target: 'authenticated.editor',
            actions: assign(({ event }) => buildVerifiedAuthPatch(event.output, 'editor', false)),
          },
          {
            guard: 'isInviteAutoEnrollSuccess',
            target: 'authenticated.editor',
            actions: assign(({ event }) => buildVerifiedAuthPatch(event.output, 'editor', true)),
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
              authError: event.output.kind === 'invalid' ? event.output.message : 'Google sign-in failed.',
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
            actions: assign(({ event }) => buildVerifiedAuthPatch(event.output, 'admin', false)),
          },
          {
            guard: 'isMemberEditorAuthSuccess',
            target: 'authenticated.editor',
            actions: assign(({ event }) => buildVerifiedAuthPatch(event.output, 'editor', false)),
          },
          {
            guard: 'isInviteAutoEnrollSuccess',
            target: 'authenticated.editor',
            actions: assign(({ event }) => buildVerifiedAuthPatch(event.output, 'editor', true)),
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
                event.output.kind === 'invalid' ? event.output.message : 'Magic link verification failed.',
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
        SIGN_OUT: { target: '#authSession.anonymous', actions: [{ type: 'clearToAnonymous' }] },
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
