import {
  type AccessControlStore,
  type AgentTokenScope,
  type CallerPrincipal,
  type Clock,
  isInviteActive,
  type PluginRouteMinRole,
  type RevisionAuthor,
} from '@kinloom/core';
import { sha256Hex } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';
import { type ServerRequestTelemetryTracker, timeSpan } from './pluginLifecycle.js';
import { isSecureRequestUrl, readSessionCookieRaw, verifySessionToken } from './session.js';

export type AuthMethod = 'none' | 'cookie' | 'bearer';

export interface ResolvedAuthContext {
  principal: CallerPrincipal;
  authMethod: AuthMethod;
  inviteToken: string | null;
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function resolveCallerPrincipal(params: {
  request: Request;
  url: URL;
  sessionSecret: string;
  repository: Pick<AccessControlStore, 'findActiveAgentTokenByHash' | 'getUser' | 'getInvite'>;
  clock: Clock;
  telemetry?: Pick<ServerRequestTelemetryTracker, 'now' | 'recordSpan'>;
}): Promise<ResolvedAuthContext> {
  const authHeader = params.request.headers.get('authorization');
  if (authHeader?.trim().toLowerCase().startsWith('bearer ')) {
    const rawBearer = authHeader.trim().slice(7).trim();
    if (rawBearer.length > 0) {
      const tokenHash = await sha256Hex(rawBearer);
      const tokenRecord = await timeSpan(params.telemetry, 'd1', () =>
        params.repository.findActiveAgentTokenByHash(tokenHash)
      );
      if (tokenRecord && tokenRecord.revoked_at === null) {
        return {
          principal: {
            kind: 'agent',
            token_id: tokenRecord.token_id,
            label: tokenRecord.label,
            scope: tokenRecord.scope,
          },
          authMethod: 'bearer',
          inviteToken: null,
        };
      }
    }
    return {
      principal: { kind: 'anonymous' },
      authMethod: 'none',
      inviteToken: null,
    };
  }

  const isSecure = isSecureRequestUrl(params.url);
  const rawCookie = readSessionCookieRaw(params.request, isSecure);
  if (!rawCookie) {
    return {
      principal: { kind: 'anonymous' },
      authMethod: 'none',
      inviteToken: null,
    };
  }

  const payload = await verifySessionToken(params.sessionSecret, rawCookie, params.clock);
  if (!payload) {
    return {
      principal: { kind: 'anonymous' },
      authMethod: 'none',
      inviteToken: null,
    };
  }

  if (payload.kind === 'user') {
    const liveUser = await timeSpan(params.telemetry, 'd1', () => params.repository.getUser(payload.email));
    if (!liveUser) {
      return {
        principal: { kind: 'anonymous' },
        authMethod: 'none',
        inviteToken: null,
      };
    }
    return {
      principal: {
        kind: 'user',
        email: liveUser.email,
        display_name: liveUser.display_name,
        role: liveUser.role,
      },
      authMethod: 'cookie',
      inviteToken: null,
    };
  }

  // Re-check invite status on every request so revoked/expired invites immediately lose read access.
  const liveInvite = await timeSpan(params.telemetry, 'd1', () =>
    params.repository.getInvite(payload.invite_token)
  );
  if (!liveInvite || !isInviteActive(liveInvite, params.clock.nowIso())) {
    return {
      principal: { kind: 'anonymous' },
      authMethod: 'none',
      inviteToken: null,
    };
  }

  return {
    principal: {
      kind: 'invite_viewer',
      invite_token: liveInvite.token,
      label: liveInvite.label,
    },
    authMethod: 'cookie',
    inviteToken: liveInvite.token,
  };
}

export function enforceCsrfOrigin(request: Request, url: URL, authMethod: AuthMethod): void {
  const method = request.method.toUpperCase();
  if (!MUTATION_METHODS.has(method)) {
    return;
  }

  const origin = request.headers.get('origin');
  if (authMethod === 'cookie') {
    if (!origin || origin !== url.origin) {
      throw new KinloomHttpError(
        403,
        'CSRF_ORIGIN_MISMATCH',
        'Cross-origin state-changing request rejected.'
      );
    }
    return;
  }

  if (authMethod === 'none' && origin && origin !== url.origin) {
    throw new KinloomHttpError(403, 'CSRF_ORIGIN_MISMATCH', 'Cross-origin state-changing request rejected.');
  }
}

export function requireMinRole(
  principal: CallerPrincipal,
  minRole: PluginRouteMinRole,
  options?: {
    allowAgentScopes?: readonly AgentTokenScope[];
    adminForbiddenCode?: 'ADMIN_REQUIRED' | 'FORBIDDEN';
  }
): void {
  if (minRole === 'public') {
    return;
  }

  if (principal.kind === 'anonymous') {
    throw new KinloomHttpError(401, 'UNAUTHORIZED', 'Authentication is required.');
  }

  if (principal.kind === 'agent') {
    const allowedScopes = options?.allowAgentScopes ?? [];
    if (allowedScopes.includes(principal.scope)) {
      return;
    }
    const code =
      minRole === 'admin' && options?.adminForbiddenCode === 'ADMIN_REQUIRED'
        ? 'ADMIN_REQUIRED'
        : 'FORBIDDEN';
    throw new KinloomHttpError(
      403,
      code,
      `Agent token with scope '${principal.scope}' is not permitted for this route.`
    );
  }

  if (minRole === 'viewer') {
    return;
  }

  if (principal.kind === 'invite_viewer') {
    const code =
      minRole === 'admin' && options?.adminForbiddenCode === 'ADMIN_REQUIRED'
        ? 'ADMIN_REQUIRED'
        : 'FORBIDDEN';
    throw new KinloomHttpError(
      403,
      code,
      'Read-only invite sessions cannot perform this action. Sign in to edit.'
    );
  }

  if (minRole === 'editor') {
    return;
  }

  // minRole === 'admin'
  if (principal.role !== 'admin') {
    throw new KinloomHttpError(
      403,
      options?.adminForbiddenCode ?? 'ADMIN_REQUIRED',
      'Administrator privileges are required.'
    );
  }
}

export function principalToRevisionAuthor(
  principal: CallerPrincipal,
  requestedAuthorType?: 'human' | 'agent' | 'system_seed'
): RevisionAuthor {
  if (principal.kind === 'user') {
    return {
      author_id: principal.email,
      author_name: principal.display_name,
      author_type: requestedAuthorType === 'system_seed' ? 'system_seed' : 'human',
    };
  }
  if (principal.kind === 'agent') {
    return {
      author_id: principal.token_id,
      author_name: principal.label,
      author_type: requestedAuthorType === 'system_seed' ? 'system_seed' : 'agent',
    };
  }
  throw new KinloomHttpError(403, 'FORBIDDEN', 'Write permissions are required.');
}
