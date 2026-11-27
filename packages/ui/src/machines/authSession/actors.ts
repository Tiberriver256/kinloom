import type { ArchiveDataSource, ArchiveSessionState, AuthMemberRole } from '@kinloom/core';
import { fromPromise } from 'xstate';
import type { HydrateOutcome, VerifyOutcome } from './types.js';

export function hydrateOutcomeFromSession(session: ArchiveSessionState): HydrateOutcome {
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

export function readHydrateOutput(event: unknown): HydrateOutcome | null {
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

export function readVerifyOutput(event: unknown): VerifyOutcome | null {
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

export const authSessionActors = {
  hydrateSession: fromPromise<HydrateOutcome, { inviteToken: string | null; dataSource?: ArchiveDataSource }>(
    async ({ input }) => {
      if (!input.dataSource?.getSession) {
        return { kind: 'anonymous' };
      }
      const res = await input.dataSource.getSession();
      return hydrateOutcomeFromSession(res.session);
    }
  ),
  signInWithGoogle: fromPromise<VerifyOutcome, { inviteToken: string | null }>(async () => ({
    kind: 'invalid',
    message: 'Google sign-in requires browser redirect or an injected auth actor.',
  })),
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
  verifyMagicLink: fromPromise<VerifyOutcome, { token: string; inviteToken: string | null }>(async () => ({
    kind: 'invalid',
    message: 'Magic link verification requires browser navigation or an injected auth actor.',
  })),
};
