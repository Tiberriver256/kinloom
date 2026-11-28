import {
  type AccessControlStore,
  type AgentTokenScope,
  type CallerPrincipal,
  type Clock,
  evaluateInviteStatus,
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
  bearerRejected?: boolean | undefined;
}

type SecurityEventQueueTarget = Pick<ServerRequestTelemetryTracker, 'queueSecurityEvent'>;

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function resolveCallerPrincipal(params: {
  request: Request;
  url: URL;
  sessionSecret: string;
  repository: Pick<AccessControlStore, 'findActiveAgentTokenByHash' | 'getUser' | 'getInvite'>;
  clock: Clock;
  telemetry?: (Pick<ServerRequestTelemetryTracker, 'now' | 'recordSpan'> & Partial<SecurityEventQueueTarget>) | undefined;
}): Promise<ResolvedAuthContext> {
  const authHeader = params.request.headers.get('authorization');
  const trimmedAuth = authHeader?.trim() ?? '';
  const lowerAuth = trimmedAuth.toLowerCase();
  if (lowerAuth === 'bearer' || lowerAuth.startsWith('bearer ')) {
    const rawBearer = trimmedAuth.slice(6).trim();
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
    params.telemetry?.queueSecurityEvent?.({
      type: 'auth.agent_token.rejected',
      status: 401,
      reason: rawBearer.length === 0 ? 'empty_token' : 'invalid_or_revoked',
    });
    return {
      principal: { kind: 'anonymous' },
      authMethod: 'none',
      inviteToken: null,
      bearerRejected: true,
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
  const nowIso = params.clock.nowIso();
  if (!liveInvite || !isInviteActive(liveInvite, nowIso)) {
    const inviteStatus = evaluateInviteStatus(liveInvite, nowIso);
    params.telemetry?.queueSecurityEvent?.({
      type: 'auth.invite.invalid',
      status: 401,
      reason: inviteStatus === 'active' ? 'not_found' : inviteStatus,
    });
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

export function enforceCsrfOrigin(
  request: Request,
  url: URL,
  authMethod: AuthMethod,
  telemetry?: Partial<SecurityEventQueueTarget>
): void {
  const method = request.method.toUpperCase();
  if (!MUTATION_METHODS.has(method)) {
    return;
  }

  const origin = request.headers.get('origin');
  if (authMethod === 'cookie') {
    if (!origin || origin !== url.origin) {
      telemetry?.queueSecurityEvent?.({
        type: 'csrf.rejected',
        status: 403,
        reason: origin ? 'origin_mismatch' : 'missing_origin',
        authMethod: 'cookie',
      });
      throw new KinloomHttpError(
        403,
        'CSRF_ORIGIN_MISMATCH',
        'Cross-origin state-changing request rejected.'
      );
    }
    return;
  }

  if (authMethod === 'none' && origin && origin !== url.origin) {
    telemetry?.queueSecurityEvent?.({
      type: 'csrf.rejected',
      status: 403,
      reason: 'origin_mismatch',
      authMethod: 'none',
    });
    throw new KinloomHttpError(403, 'CSRF_ORIGIN_MISMATCH', 'Cross-origin state-changing request rejected.');
  }
}

export function requireMinRole(
  principal: CallerPrincipal,
  minRole: PluginRouteMinRole,
  options?: {
    mode?: 'private' | 'public' | undefined;
    allowAgentScopes?: readonly AgentTokenScope[] | undefined;
    adminForbiddenCode?: 'ADMIN_REQUIRED' | 'FORBIDDEN' | undefined;
    telemetry?: Partial<SecurityEventQueueTarget> | undefined;
    bearerRejected?: boolean | undefined;
  }
): void {
  const effectiveMinRole: Exclude<PluginRouteMinRole, 'archive_read'> =
    minRole === 'archive_read' ? (options?.mode === 'public' ? 'public' : 'viewer') : minRole;

  if (effectiveMinRole === 'public') {
    return;
  }

  if (principal.kind === 'anonymous') {
    if ((effectiveMinRole === 'editor' || effectiveMinRole === 'admin') && !options?.bearerRejected) {
      options?.telemetry?.queueSecurityEvent?.({
        type: 'auth.write.forbidden',
        status: 401,
        reason: 'unauthenticated',
        requiredRole: effectiveMinRole,
        actorKind: 'anonymous',
      });
    }
    throw new KinloomHttpError(401, 'UNAUTHORIZED', 'Authentication is required.');
  }

  if (principal.kind === 'agent') {
    const allowedScopes = options?.allowAgentScopes ?? [];
    if (allowedScopes.includes(principal.scope)) {
      return;
    }
    options?.telemetry?.queueSecurityEvent?.({
      type: 'auth.agent_token.rejected',
      status: 403,
      reason: 'insufficient_scope',
    });
    const code =
      effectiveMinRole === 'admin' && options?.adminForbiddenCode === 'ADMIN_REQUIRED'
        ? 'ADMIN_REQUIRED'
        : 'FORBIDDEN';
    throw new KinloomHttpError(
      403,
      code,
      `Agent token with scope '${principal.scope}' is not permitted for this route.`
    );
  }

  if (effectiveMinRole === 'viewer') {
    return;
  }

  if (principal.kind === 'invite_viewer') {
    options?.telemetry?.queueSecurityEvent?.({
      type: 'auth.write.forbidden',
      status: 403,
      reason: 'invite_read_only',
      requiredRole: effectiveMinRole,
      actorKind: 'invite_viewer',
    });
    const code =
      effectiveMinRole === 'admin' && options?.adminForbiddenCode === 'ADMIN_REQUIRED'
        ? 'ADMIN_REQUIRED'
        : 'FORBIDDEN';
    throw new KinloomHttpError(
      403,
      code,
      'Read-only invite sessions cannot perform this action. Sign in to edit.'
    );
  }

  if (effectiveMinRole === 'editor') {
    return;
  }

  // effectiveMinRole === 'admin'
  if (principal.role !== 'admin') {
    options?.telemetry?.queueSecurityEvent?.({
      type: 'auth.write.forbidden',
      status: 403,
      reason: 'insufficient_role',
      requiredRole: 'admin',
      actorKind: 'user',
    });
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
