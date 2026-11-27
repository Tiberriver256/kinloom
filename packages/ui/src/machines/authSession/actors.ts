import type {
  ArchiveAuthProviders,
  ArchiveCapabilities,
  ArchiveDataSource,
  ArchiveSessionState,
  AuthMemberRole,
} from '@kinloom/core';
import { fromPromise } from 'xstate';
import type { HydrateOutcome } from './types.js';

export function hydrateOutcomeFromSession(
  session: ArchiveSessionState,
  extra?: { capabilities?: ArchiveCapabilities; authProviders?: ArchiveAuthProviders }
): HydrateOutcome {
  if (session.authenticated && session.principal_kind === 'user') {
    const role: AuthMemberRole = session.role === 'admin' ? 'admin' : 'editor';
    return {
      kind: 'authenticated',
      email: session.email ?? '',
      displayName: session.displayName ?? session.email ?? 'Member',
      role,
      capabilities: extra?.capabilities,
      authProviders: extra?.authProviders,
    };
  }
  if (session.principal_kind === 'invite_viewer') {
    return {
      kind: 'invite_valid',
      token: 'cookie-invite',
      label: session.inviteLabel ?? 'Family invite',
      capabilities: extra?.capabilities,
      authProviders: extra?.authProviders,
    };
  }
  return {
    kind: 'anonymous',
    capabilities: extra?.capabilities,
    authProviders: extra?.authProviders,
  };
}

export function readHydrateOutput(event: unknown): HydrateOutcome | null {
  if (typeof event !== 'object' || event === null || !('output' in event)) {
    return null;
  }
  const output = (event as { output: unknown }).output;
  if (typeof output !== 'object' || output === null || !('kind' in output)) {
    return null;
  }
  const kind = (output as { kind: unknown }).kind;
  if (kind === 'authenticated' || kind === 'invite_valid' || kind === 'anonymous') {
    return output as HydrateOutcome;
  }
  return null;
}

export const authSessionActors = {
  hydrateSession: fromPromise<HydrateOutcome, { inviteToken: string | null; dataSource?: ArchiveDataSource }>(
    async ({ input }) => {
      if (!input.dataSource?.getSession) {
        return { kind: 'anonymous' };
      }
      const res = await input.dataSource.getSession();
      return hydrateOutcomeFromSession(res.session, {
        capabilities: res.capabilities,
        authProviders: res.authProviders,
      });
    }
  ),
  requestMagicLink: fromPromise<
    void,
    { email: string; inviteToken: string | null; dataSource?: ArchiveDataSource }
  >(async ({ input }) => {
    if (!input.dataSource?.requestMagicLink) {
      throw {
        status: 503,
        code: 'EMAIL_SENDER_UNCONFIGURED',
        message: 'Email sign-in is not configured for this archive.',
      };
    }
    await input.dataSource.requestMagicLink(input.email);
  }),
  signOutSession: fromPromise<void, { dataSource?: ArchiveDataSource }>(async ({ input }) => {
    if (input.dataSource?.logout) {
      await input.dataSource.logout();
    }
  }),
};
