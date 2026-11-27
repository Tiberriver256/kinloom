import { z } from 'zod';
import { UserRoleSchema, type Clock, type UserRole } from '@kinloom/core';
import {
  base64UrlDecodeString,
  base64UrlEncodeString,
  hmacSignBase64Url,
  hmacVerifyBase64Url,
} from '../crypto.js';

export const PROD_SESSION_COOKIE_NAME = '__Host-kinloom_session';
export const DEV_SESSION_COOKIE_NAME = 'kinloom_session';
export const PROD_OAUTH_COOKIE_NAME = '__Host-kinloom_oauth';
export const DEV_OAUTH_COOKIE_NAME = 'kinloom_oauth';

const SessionUserPayloadSchema = z.object({
  kind: z.literal('user'),
  email: z.string().min(1),
  display_name: z.string().min(1),
  role: UserRoleSchema,
  exp: z.number().int().positive(),
});

const SessionInvitePayloadSchema = z.object({
  kind: z.literal('invite_viewer'),
  invite_token: z.string().min(1),
  label: z.string().min(1),
  exp: z.number().int().positive(),
});

const SessionCookiePayloadSchema = z.discriminatedUnion('kind', [
  SessionUserPayloadSchema,
  SessionInvitePayloadSchema,
]);

const OAuthStateCookiePayloadSchema = z.object({
  state: z.string().min(1),
  code_verifier: z.string().min(1),
  invite_token: z.string().nullable(),
  next_path: z.string().min(1),
  exp: z.number().int().positive(),
});

export type SessionCookiePayload = z.infer<typeof SessionCookiePayloadSchema>;
export type OAuthStateCookiePayload = z.infer<typeof OAuthStateCookiePayloadSchema>;

export function isSecureRequestUrl(url: URL): boolean {
  return url.protocol === 'https:';
}

export function getSessionCookieName(isSecure: boolean): string {
  return isSecure ? PROD_SESSION_COOKIE_NAME : DEV_SESSION_COOKIE_NAME;
}

export function getOAuthCookieName(isSecure: boolean): string {
  return isSecure ? PROD_OAUTH_COOKIE_NAME : DEV_OAUTH_COOKIE_NAME;
}

export function parseCookies(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }
  for (const segment of cookieHeader.split(';')) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx <= 0) {
      continue;
    }
    const name = segment.slice(0, eqIdx).trim();
    const value = segment.slice(eqIdx + 1).trim();
    if (name && !cookies.has(name)) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

export function readSessionCookieRaw(request: Request, isSecure: boolean): string | null {
  const cookies = parseCookies(request.headers.get('cookie'));
  if (isSecure) {
    return cookies.get(PROD_SESSION_COOKIE_NAME) ?? null;
  }
  return cookies.get(DEV_SESSION_COOKIE_NAME) ?? cookies.get(PROD_SESSION_COOKIE_NAME) ?? null;
}

export function readOAuthCookieRaw(request: Request, isSecure: boolean): string | null {
  const cookies = parseCookies(request.headers.get('cookie'));
  if (isSecure) {
    return cookies.get(PROD_OAUTH_COOKIE_NAME) ?? null;
  }
  return cookies.get(DEV_OAUTH_COOKIE_NAME) ?? cookies.get(PROD_OAUTH_COOKIE_NAME) ?? null;
}

async function signPayload(secret: string, payload: unknown): Promise<string> {
  const encoded = base64UrlEncodeString(JSON.stringify(payload));
  const sig = await hmacSignBase64Url(secret, encoded);
  return `${encoded}.${sig}`;
}

async function verifySignedPayload<TSchema extends z.ZodTypeAny>(
  secret: string,
  token: string,
  schema: TSchema,
  clock: Clock
): Promise<z.infer<TSchema> | null> {
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0 || dotIdx !== token.lastIndexOf('.')) {
    return null;
  }
  const encoded = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!encoded || !sig) {
    return null;
  }

  const validSig = await hmacVerifyBase64Url(secret, encoded, sig);
  if (!validSig) {
    return null;
  }

  const decoded = base64UrlDecodeString(encoded);
  if (!decoded) {
    return null;
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(decoded);
  } catch {
    return null;
  }

  const parsed = schema.safeParse(rawJson);
  if (!parsed.success) {
    return null;
  }

  const data = parsed.data as { exp: number };
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  if (data.exp <= nowSeconds) {
    return null;
  }

  return parsed.data;
}

export async function signSessionToken(params: {
  secret: string;
  clock: Clock;
  ttlSeconds: number;
  payload:
    | { kind: 'user'; email: string; display_name: string; role: UserRole }
    | { kind: 'invite_viewer'; invite_token: string; label: string };
}): Promise<string> {
  const exp = Math.floor(params.clock.now().getTime() / 1000) + params.ttlSeconds;
  const fullPayload: SessionCookiePayload =
    params.payload.kind === 'user'
      ? {
          kind: 'user',
          email: params.payload.email,
          display_name: params.payload.display_name,
          role: params.payload.role,
          exp,
        }
      : {
          kind: 'invite_viewer',
          invite_token: params.payload.invite_token,
          label: params.payload.label,
          exp,
        };
  return signPayload(params.secret, fullPayload);
}

export async function verifySessionToken(
  secret: string,
  token: string,
  clock: Clock
): Promise<SessionCookiePayload | null> {
  return verifySignedPayload(secret, token, SessionCookiePayloadSchema, clock);
}

export async function signOAuthStateToken(params: {
  secret: string;
  clock: Clock;
  ttlSeconds: number;
  state: string;
  code_verifier: string;
  invite_token: string | null;
  next_path: string;
}): Promise<string> {
  const exp = Math.floor(params.clock.now().getTime() / 1000) + params.ttlSeconds;
  const fullPayload: OAuthStateCookiePayload = {
    state: params.state,
    code_verifier: params.code_verifier,
    invite_token: params.invite_token,
    next_path: params.next_path,
    exp,
  };
  return signPayload(params.secret, fullPayload);
}

export async function verifyOAuthStateToken(
  secret: string,
  token: string,
  clock: Clock
): Promise<OAuthStateCookiePayload | null> {
  return verifySignedPayload(secret, token, OAuthStateCookiePayloadSchema, clock);
}

export function serializeSetCookie(params: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  isSecure: boolean;
}): string {
  const parts = [
    `${params.name}=${params.value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(params.maxAgeSeconds))}`,
  ];
  if (params.isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function serializeClearCookie(name: string, isSecure: boolean): string {
  return serializeSetCookie({
    name,
    value: '',
    maxAgeSeconds: 0,
    isSecure,
  });
}
