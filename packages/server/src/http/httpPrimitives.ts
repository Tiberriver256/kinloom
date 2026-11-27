import { type EntityType, EntityTypeSchema } from '@kinloom/core';
import { KinloomHttpError } from '../errors.js';
import { sanitizeNextPath } from '../services/authService.js';
import type { ResolvedAuthContext } from './authMiddleware.js';
import type { ServerRequestTelemetryTracker } from './pluginLifecycle.js';

export interface HttpRequestContext {
  readonly request: Request;
  readonly url: URL;
  readonly pathname: string;
  readonly method: string;
  readonly isSecure: boolean;
  readonly segments: readonly string[];
  readonly auth: ResolvedAuthContext;
  readonly telemetry?: ServerRequestTelemetryTracker;
}

export type HttpRouteHandler = (ctx: HttpRequestContext) => Promise<Response | null>;

export type AuthBrowserProvider = 'google' | 'magic_link' | 'invite';

const CANONICAL_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

export function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function redirectResponse(location: string, setCookies: readonly string[] = []): Response {
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
  });
  for (const cookie of setCookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON.');
  }
}

export function parseEntityTypeParam(raw: string): EntityType {
  const parsed = EntityTypeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new KinloomHttpError(400, 'INVALID_ENTITY_TYPE', `Invalid entity type '${raw}'.`);
  }
  return parsed.data;
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Malformed URL path encoding.');
  }
}

export function parsePositiveInt(raw: string, fieldName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Invalid ${fieldName}: '${raw}'.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Invalid ${fieldName}: '${raw}'.`);
  }
  return value;
}

export function isBrowserNavigation(request: Request): boolean {
  const secFetchMode = request.headers.get('sec-fetch-mode')?.trim().toLowerCase();
  if (secFetchMode === 'navigate') {
    return true;
  }
  const accept = request.headers.get('accept')?.toLowerCase() ?? '';
  return accept.includes('text/html');
}

function readDetailString(details: unknown, key: string): string | null {
  if (typeof details !== 'object' || details === null || !(key in details)) {
    return null;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export function mapAuthErrorToBrowserCode(error: unknown, provider: AuthBrowserProvider): string {
  if (error instanceof KinloomHttpError) {
    if (error.code === 'INVITE_INVALID_OR_REVOKED') {
      const inviteStatus = readDetailString(error.details, 'invite_status');
      if (inviteStatus === 'expired') {
        return 'INVITE_EXPIRED';
      }
      if (inviteStatus === 'revoked') {
        return 'INVITE_REVOKED';
      }
      return 'INVITE_INVALID';
    }

    if (error.code === 'INVITE_REQUIRED') {
      const inviteStatus = readDetailString(error.details, 'invite_status');
      if (inviteStatus === 'expired') {
        return 'INVITE_EXPIRED';
      }
      if (inviteStatus === 'revoked') {
        return 'INVITE_REVOKED';
      }
      return 'INVITE_REQUIRED';
    }

    if (error.code === 'TOKEN_INVALID_OR_EXPIRED') {
      const tokenStatus = readDetailString(error.details, 'token_status');
      if (tokenStatus === 'used') {
        return 'MAGIC_LINK_USED';
      }
      if (tokenStatus === 'invalid') {
        return 'MAGIC_LINK_INVALID';
      }
      return 'MAGIC_LINK_EXPIRED';
    }

    if (CANONICAL_ERROR_CODE_PATTERN.test(error.code)) {
      return error.code;
    }
  }

  switch (provider) {
    case 'google':
      return 'GOOGLE_AUTH_FAILED';
    case 'magic_link':
      return 'MAGIC_LINK_INVALID';
    case 'invite':
      return 'INVITE_INVALID';
    default: {
      const _exhaustive: never = provider;
      return String(_exhaustive);
    }
  }
}

export function buildAuthErrorRedirectUrl(
  nextPath: string | null | undefined,
  errorCode: string,
  provider: AuthBrowserProvider
): string {
  const safePath = sanitizeNextPath(nextPath);
  const parsed = new URL(safePath, 'https://kinloom.local');
  const safeCode = CANONICAL_ERROR_CODE_PATTERN.test(errorCode) ? errorCode : 'AUTH_ERROR';
  parsed.searchParams.set('auth_error', safeCode);
  parsed.searchParams.set('auth_provider', provider);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
