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
    async ({ input, signal }) => {
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
    }
  ),
  signInWithGoogle: fromPromise<VerifyOutcome, { inviteToken: string | null }>(async ({ input, signal }) => {
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
  }),
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
  verifyMagicLink: fromPromise<VerifyOutcome, { token: string; inviteToken: string | null }>(
    async ({ input, signal }) => {
      const res = await fetch(`/api/auth/magic-link/verify?token=${encodeURIComponent(input.token)}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal,
      });
      if (res.status === 403) {
        return { kind: 'invalid', message: 'This email is not enrolled in this family archive.' };
      }
      if (!res.ok) {
        return { kind: 'invalid', message: 'Magic link is invalid or expired.' };
      }
      return (await res.json()) as VerifyOutcome;
    }
  ),
};
