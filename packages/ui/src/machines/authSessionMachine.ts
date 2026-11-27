import { createActorContext } from '@xstate/react';
import type { SnapshotFrom } from 'xstate';
import { assign, setup } from 'xstate';
import { authSessionActors, hydrateOutcomeFromSession, readHydrateOutput } from './authSession/actors.js';
import {
  buildHydratedPatch,
  deriveSessionFromAuthSnapshot,
  formatAuthErrorMessage,
} from './authSession/reducers.js';
import type {
  AuthSessionContext,
  AuthSessionEvent,
  AuthSessionInput,
  AuthUrlErrorState,
  HydrateOutcome,
} from './authSession/types.js';

export type { AuthSessionContext, AuthSessionEvent, AuthSessionInput, AuthUrlErrorState, HydrateOutcome };
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
    hasLogoutPort: ({ context }) => Boolean(context.dataSource?.logout),
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
      (context.initialSession != null &&
        hydrateOutcomeFromSession(context.initialSession).kind === 'anonymous') ||
      (context.hasExplicitSession && context.initialSession == null),
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
  },
  actions: {
    clearToAnonymous: assign(() => ({
      initialSession: undefined,
      pendingInviteToken: null,
      inviteLabel: null,
      email: null,
      displayName: null,
      role: null,
      magicLinkResendCount: 0,
      authError: null,
      authErrorDetail: null,
      serverCapabilities: null,
    })),
    clearAuthError: assign(() => ({
      authError: null,
      authErrorDetail: null,
      urlError: null,
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
    magicLinkResendCount: 0,
    authError: null,
    authErrorDetail: null,
    urlError: null,
    serverCapabilities: null,
    capabilitiesOverride: input?.capabilitiesOverride,
    authProviders: {
      google: false,
      magicLink: Boolean(input?.dataSource?.requestMagicLink),
    },
    hasServerAuthProviders: false,
    hasExplicitSession: Boolean(input?.hasExplicitSession),
    initialSession: input?.initialSession,
    dataSource: input?.dataSource,
  }),
  on: {
    CLEAR_AUTH_ERROR: { actions: [{ type: 'clearAuthError' }] },
    SET_URL_ERROR: {
      actions: assign(({ event }) =>
        event.urlError !== null
          ? {
              urlError: event.urlError,
              authError: null,
              authErrorDetail: null,
            }
          : { urlError: null }
      ),
    },
    SYNC_DATA_SOURCE: {
      actions: assign(({ context, event }) => ({
        dataSource: event.dataSource,
        authProviders: context.hasServerAuthProviders
          ? context.authProviders
          : {
              ...context.authProviders,
              magicLink: Boolean(event.dataSource?.requestMagicLink),
            },
      })),
    },
    SYNC_CAPABILITIES_OVERRIDE: {
      actions: assign(({ event }) => ({
        capabilitiesOverride: event.capabilities,
      })),
    },
    SYNC_EXPLICIT_SESSION: {
      target: '.hydrating',
      actions: assign(({ event }) => ({
        hasExplicitSession: true,
        initialSession: event.session,
        serverCapabilities: null,
      })),
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
              ? buildHydratedPatch(
                  hydrateOutcomeFromSession(context.initialSession),
                  context.authProviders,
                  context.hasServerAuthProviders
                )
              : {}
          ),
        },
        {
          guard: 'isInitialEditorSession',
          target: 'authenticated.editor',
          actions: assign(({ context }) =>
            context.initialSession
              ? buildHydratedPatch(
                  hydrateOutcomeFromSession(context.initialSession),
                  context.authProviders,
                  context.hasServerAuthProviders
                )
              : {}
          ),
        },
        {
          guard: 'isInitialInviteSession',
          target: 'readOnlyInvite',
          actions: assign(({ context }) =>
            context.initialSession
              ? buildHydratedPatch(
                  hydrateOutcomeFromSession(context.initialSession),
                  context.authProviders,
                  context.hasServerAuthProviders
                )
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
            actions: assign(({ context, event }) =>
              buildHydratedPatch(event.output, context.authProviders, context.hasServerAuthProviders)
            ),
          },
          {
            guard: 'isEditorHydration',
            target: 'authenticated.editor',
            actions: assign(({ context, event }) =>
              buildHydratedPatch(event.output, context.authProviders, context.hasServerAuthProviders)
            ),
          },
          {
            guard: 'isValidInviteHydration',
            target: 'readOnlyInvite',
            actions: assign(({ context, event }) =>
              buildHydratedPatch(event.output, context.authProviders, context.hasServerAuthProviders)
            ),
          },
          {
            target: 'anonymous',
            actions: assign(({ context, event }) =>
              buildHydratedPatch(event.output, context.authProviders, context.hasServerAuthProviders)
            ),
          },
        ],
        onError: { target: 'anonymous', actions: [{ type: 'clearToAnonymous' }] },
      },
    },
    anonymous: {
      tags: ['signedOut'],
      on: {
        REQUEST_MAGIC_LINK: {
          target: 'requestingMagicLink',
          actions: assign(({ event }) => ({
            email: event.email,
            magicLinkResendCount: 0,
            authError: null,
            authErrorDetail: null,
            urlError: null,
          })),
        },
        REFRESH_SESSION: {
          target: 'hydrating',
          actions: assign(() => ({ hasExplicitSession: false, initialSession: undefined })),
        },
      },
    },
    readOnlyInvite: {
      tags: ['readOnly', 'invited'],
      on: {
        REQUEST_MAGIC_LINK: {
          target: 'requestingMagicLink',
          actions: assign(({ event }) => ({
            email: event.email,
            magicLinkResendCount: 0,
            authError: null,
            authErrorDetail: null,
            urlError: null,
          })),
        },
        REFRESH_SESSION: {
          target: 'hydrating',
          actions: assign(() => ({ hasExplicitSession: false, initialSession: undefined })),
        },
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
        RESEND_MAGIC_LINK: {
          target: 'requestingMagicLink',
          actions: assign(({ context, event }) => ({
            email: event.email,
            magicLinkResendCount: context.magicLinkResendCount + 1,
            authError: null,
            authErrorDetail: null,
            urlError: null,
          })),
        },
        CANCEL_MAGIC_LINK: [
          {
            guard: 'hasValidPendingInvite',
            target: 'readOnlyInvite',
            actions: assign(() => ({
              magicLinkResendCount: 0,
              authError: null,
              authErrorDetail: null,
            })),
          },
          {
            target: 'anonymous',
            actions: assign(() => ({
              magicLinkResendCount: 0,
              authError: null,
              authErrorDetail: null,
            })),
          },
        ],
        SET_URL_ERROR: [
          {
            guard: ({ context, event }) => event.urlError !== null && context.pendingInviteToken !== null,
            target: 'readOnlyInvite',
            actions: assign(({ event }) => ({
              magicLinkResendCount: 0,
              authError: null,
              authErrorDetail: null,
              urlError: event.urlError,
            })),
          },
          {
            guard: ({ event }) => event.urlError !== null,
            target: 'anonymous',
            actions: assign(({ event }) => ({
              magicLinkResendCount: 0,
              authError: null,
              authErrorDetail: null,
              urlError: event.urlError,
            })),
          },
          {
            actions: assign(() => ({ urlError: null })),
          },
        ],
        REFRESH_SESSION: {
          target: 'hydrating',
          actions: assign(() => ({ hasExplicitSession: false, initialSession: undefined })),
        },
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
        SIGN_OUT: [
          {
            guard: 'hasLogoutPort',
            target: '#authSession.signingOut',
          },
          {
            target: '#authSession.anonymous',
            actions: [{ type: 'clearToAnonymous' }],
          },
        ],
        REFRESH_SESSION: {
          target: '#authSession.hydrating',
          actions: assign(() => ({ hasExplicitSession: false, initialSession: undefined })),
        },
      },
    },
    signingOut: {
      tags: ['loading'],
      invoke: {
        src: 'signOutSession',
        input: ({ context }) => ({ dataSource: context.dataSource }),
        onDone: {
          target: 'anonymous',
          actions: [{ type: 'clearToAnonymous' }],
        },
        onError: {
          target: 'hydrating',
          actions: assign(() => ({ hasExplicitSession: false, initialSession: undefined })),
        },
      },
    },
  },
});

export const AuthSessionActorContext = createActorContext(authSessionMachine);

export type AuthSessionSnapshot = SnapshotFrom<typeof authSessionMachine>;
