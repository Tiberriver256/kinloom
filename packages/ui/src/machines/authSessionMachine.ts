import { canAutoEnrollViaInvite, canCompleteAdminAuth, canCompleteMemberEditorAuth } from '@kinloom/core';
import { createActorContext } from '@xstate/react';
import type { SnapshotFrom } from 'xstate';
import { assign, setup } from 'xstate';
import {
  authSessionActors,
  hydrateOutcomeFromSession,
  readHydrateOutput,
  readVerifyOutput,
} from './authSession/actors.js';
import {
  buildHydratedPatch,
  buildVerifiedAuthPatch,
  deriveSessionFromAuthSnapshot,
  formatAuthErrorMessage,
} from './authSession/reducers.js';
import type {
  AuthSessionContext,
  AuthSessionEvent,
  AuthSessionInput,
  HydrateOutcome,
  VerifyOutcome,
} from './authSession/types.js';

export type { AuthSessionContext, AuthSessionEvent, AuthSessionInput, HydrateOutcome, VerifyOutcome };
export { deriveSessionFromAuthSnapshot };

export const authSessionMachine = setup({
  types: {
    context: {} as AuthSessionContext,
    events: {} as AuthSessionEvent,
    input: {} as AuthSessionInput,
  },
  actors: authSessionActors,
  guards: {
    hasValidPendingInvite: ({ context }) => context.pendingInviteToken !== null,
    isInitialAdminSession: ({ context }) =>
      context.initialSession != null &&
      hydrateOutcomeFromSession(context.initialSession).kind === 'authenticated' &&
      context.initialSession.role === 'admin',
    isInitialEditorSession: ({ context }) =>
      context.initialSession != null &&
      hydrateOutcomeFromSession(context.initialSession).kind === 'authenticated' &&
      context.initialSession.role !== 'admin',
    isInitialInviteSession: ({ context }) =>
      context.initialSession != null &&
      hydrateOutcomeFromSession(context.initialSession).kind === 'invite_valid',
    isInitialAnonymousSession: ({ context }) =>
      context.initialSession != null &&
      hydrateOutcomeFromSession(context.initialSession).kind === 'anonymous',
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
    })),
    clearAuthError: assign(() => ({
      authError: null,
      authErrorDetail: null,
    })),
    markInviteRevoked: assign(() => ({
      initialSession: undefined,
      pendingInviteToken: null,
      inviteLabel: null,
      email: null,
      displayName: null,
      role: null,
      autoEnrolledViaInvite: false,
      magicLinkResendCount: 0,
      authError: 'This invite link has expired or been revoked.',
      authErrorDetail: null,
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
    magicLinkResendCount: 0,
    authError: null,
    authErrorDetail: null,
    initialSession: input?.initialSession,
    dataSource: input?.dataSource,
  }),
  on: {
    CLEAR_AUTH_ERROR: { actions: [{ type: 'clearAuthError' }] },
    SYNC_DATA_SOURCE: {
      actions: assign(({ event }) => ({ dataSource: event.dataSource })),
    },
  },
  states: {
    hydrating: {
      tags: ['loading'],
      always: [
        {
          guard: 'isInitialAdminSession',
          target: 'authenticated.admin',
          actions: assign(({ context }) =>
            context.initialSession
              ? buildHydratedPatch(hydrateOutcomeFromSession(context.initialSession))
              : {}
          ),
        },
        {
          guard: 'isInitialEditorSession',
          target: 'authenticated.editor',
          actions: assign(({ context }) =>
            context.initialSession
              ? buildHydratedPatch(hydrateOutcomeFromSession(context.initialSession))
              : {}
          ),
        },
        {
          guard: 'isInitialInviteSession',
          target: 'readOnlyInvite',
          actions: assign(({ context }) =>
            context.initialSession
              ? buildHydratedPatch(hydrateOutcomeFromSession(context.initialSession))
              : {}
          ),
        },
        {
          guard: 'isInitialAnonymousSession',
          target: 'anonymous',
          actions: [{ type: 'clearToAnonymous' }],
        },
      ],
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
            actions: assign(({ event }) => buildHydratedPatch(event.output)),
          },
          {
            guard: 'isEditorHydration',
            target: 'authenticated.editor',
            actions: assign(({ event }) => buildHydratedPatch(event.output)),
          },
          {
            guard: 'isValidInviteHydration',
            target: 'readOnlyInvite',
            actions: assign(({ event }) => buildHydratedPatch(event.output)),
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
          actions: assign(({ event }) => ({
            email: event.email,
            magicLinkResendCount: 0,
            authError: null,
            authErrorDetail: null,
          })),
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
              authErrorDetail: null,
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
          actions: assign(({ event }) => ({
            email: event.email,
            magicLinkResendCount: 0,
            authError: null,
            authErrorDetail: null,
          })),
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
              authErrorDetail: null,
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
              authErrorDetail: null,
            })),
          },
        ],
        onError: [
          {
            guard: 'hasValidPendingInvite',
            target: 'readOnlyInvite',
            actions: assign(({ event }) => ({
              authError: formatAuthErrorMessage(event.error),
              authErrorDetail: event.error,
            })),
          },
          {
            target: 'anonymous',
            actions: assign(({ event }) => ({
              authError: formatAuthErrorMessage(event.error),
              authErrorDetail: event.error,
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
              magicLinkResendCount: 0,
              authError: formatAuthErrorMessage(event.error),
              authErrorDetail: event.error,
            })),
          },
          {
            target: 'anonymous',
            actions: assign(({ event }) => ({
              magicLinkResendCount: 0,
              authError: formatAuthErrorMessage(event.error),
              authErrorDetail: event.error,
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
          actions: assign(({ context, event }) => ({
            email: event.email,
            magicLinkResendCount: context.magicLinkResendCount + 1,
            authError: null,
            authErrorDetail: null,
          })),
        },
        CANCEL_MAGIC_LINK: [
          {
            guard: 'hasValidPendingInvite',
            target: 'readOnlyInvite',
            actions: assign(() => ({ magicLinkResendCount: 0, authError: null, authErrorDetail: null })),
          },
          {
            target: 'anonymous',
            actions: assign(() => ({ magicLinkResendCount: 0, authError: null, authErrorDetail: null })),
          },
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
              authErrorDetail: null,
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
              authErrorDetail: null,
            })),
          },
        ],
        onError: [
          {
            guard: 'hasValidPendingInvite',
            target: 'readOnlyInvite',
            actions: assign(({ event }) => ({
              authError: formatAuthErrorMessage(event.error),
              authErrorDetail: event.error,
            })),
          },
          {
            target: 'anonymous',
            actions: assign(({ event }) => ({
              authError: formatAuthErrorMessage(event.error),
              authErrorDetail: event.error,
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
            authErrorDetail: null,
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
          actions: assign(({ event }) => ({
            email: event.email,
            magicLinkResendCount: 0,
            authError: null,
            authErrorDetail: null,
          })),
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
