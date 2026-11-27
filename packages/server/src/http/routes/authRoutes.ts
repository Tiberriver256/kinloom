import type { Clock } from '@kinloom/core';
import { z } from 'zod';
import { KinloomHttpError } from '../../errors.js';
import { type AuthService, sanitizeNextPath } from '../../services/authService.js';
import { enforceCsrfOrigin } from '../authMiddleware.js';
import {
  buildAuthErrorRedirectUrl,
  decodeSegment,
  type HttpRouteHandler,
  isBrowserNavigation,
  jsonResponse,
  mapAuthErrorToBrowserCode,
  readJsonBody,
  redirectResponse,
} from '../httpPrimitives.js';
import {
  getOAuthCookieName,
  getSessionCookieName,
  readOAuthCookieRaw,
  readSessionCookieRaw,
  serializeClearCookie,
  serializeSetCookie,
  signOAuthStateToken,
  signSessionToken,
  verifyOAuthStateToken,
} from '../session.js';

const MagicLinkRequestSchema = z.object({
  email: z.string().trim().email(),
  next: z.string().optional(),
});

export interface AuthRouteHandlerDeps {
  readonly authService: AuthService;
  readonly clock: Clock;
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  readonly oauthCookieTtlSeconds: number;
}

export function createAuthRouteHandler(deps: AuthRouteHandlerDeps): HttpRouteHandler {
  const { authService, clock, sessionSecret, sessionTtlSeconds, oauthCookieTtlSeconds } = deps;

  return async (ctx) => {
    const { request, url, pathname, method, isSecure, segments, auth } = ctx;

    if (method === 'GET' && pathname === '/api/auth/me') {
      return jsonResponse(authService.getSessionInfo(auth.principal), 200);
    }

    if (method === 'GET' && pathname === '/api/auth/google/start') {
      const requestedNext = url.searchParams.get('next');
      const selectAccountParam = url.searchParams.get('select_account')?.trim().toLowerCase();
      const promptParam = url.searchParams.get('prompt')?.trim().toLowerCase();
      const selectAccount =
        selectAccountParam === '1' || selectAccountParam === 'true' || promptParam === 'select_account';
      try {
        const redirectUri = `${url.origin}/api/auth/google/callback`;
        const started = await authService.startGoogleAuth({
          redirectUri,
          inviteToken: auth.inviteToken,
          nextPath: requestedNext,
          selectAccount,
        });
        const oauthToken = await signOAuthStateToken({
          secret: sessionSecret,
          clock,
          ttlSeconds: oauthCookieTtlSeconds,
          state: started.state,
          code_verifier: started.codeVerifier,
          invite_token: started.inviteToken,
          next_path: started.nextPath,
        });
        const oauthCookie = serializeSetCookie({
          name: getOAuthCookieName(isSecure),
          value: oauthToken,
          maxAgeSeconds: oauthCookieTtlSeconds,
          isSecure,
        });
        return redirectResponse(started.authorizationUrl, [oauthCookie]);
      } catch (error) {
        if (isBrowserNavigation(request)) {
          const errorCode = mapAuthErrorToBrowserCode(error, 'google');
          return redirectResponse(buildAuthErrorRedirectUrl(requestedNext, errorCode, 'google'));
        }
        throw error;
      }
    }

    if (method === 'GET' && pathname === '/api/auth/google/callback') {
      const oauthError = url.searchParams.get('error')?.trim() ?? '';
      const code = url.searchParams.get('code')?.trim() ?? '';
      const state = url.searchParams.get('state')?.trim() ?? '';
      const rawOAuthCookie = readOAuthCookieRaw(request, isSecure);
      const oauthState = rawOAuthCookie
        ? await verifyOAuthStateToken(sessionSecret, rawOAuthCookie, clock)
        : null;
      const fallbackNextPath = sanitizeNextPath(oauthState?.next_path);

      try {
        if (oauthError) {
          if (oauthError === 'access_denied') {
            throw new KinloomHttpError(400, 'GOOGLE_CANCELLED', 'Google sign-in was canceled.');
          }
          throw new KinloomHttpError(400, 'GOOGLE_AUTH_FAILED', 'Google sign-in could not be completed.');
        }

        if (!code || !state || !rawOAuthCookie) {
          throw new KinloomHttpError(400, 'INVALID_OAUTH_STATE', 'Missing or expired OAuth state.');
        }

        if (!oauthState || oauthState.state !== state) {
          throw new KinloomHttpError(400, 'INVALID_OAUTH_STATE', 'OAuth state verification failed.');
        }

        const { user } = await authService.completeGoogleAuth({
          code,
          codeVerifier: oauthState.code_verifier,
          redirectUri: `${url.origin}/api/auth/google/callback`,
          inviteToken: oauthState.invite_token,
        });

        const sessionToken = await signSessionToken({
          secret: sessionSecret,
          clock,
          ttlSeconds: sessionTtlSeconds,
          payload: {
            kind: 'user',
            email: user.email,
            display_name: user.display_name,
            role: user.role,
          },
        });

        return redirectResponse(sanitizeNextPath(oauthState.next_path), [
          serializeClearCookie(getOAuthCookieName(isSecure), isSecure),
          serializeSetCookie({
            name: getSessionCookieName(isSecure),
            value: sessionToken,
            maxAgeSeconds: sessionTtlSeconds,
            isSecure,
          }),
        ]);
      } catch (error) {
        if (isBrowserNavigation(request)) {
          const errorCode = mapAuthErrorToBrowserCode(error, 'google');
          const clearCookies = [serializeClearCookie(getOAuthCookieName(isSecure), isSecure)];
          if (auth.principal.kind === 'anonymous' && readSessionCookieRaw(request, isSecure)) {
            clearCookies.push(serializeClearCookie(getSessionCookieName(isSecure), isSecure));
          }
          return redirectResponse(
            buildAuthErrorRedirectUrl(fallbackNextPath, errorCode, 'google'),
            clearCookies
          );
        }
        throw error;
      }
    }

    if (method === 'POST' && pathname === '/api/auth/magic-link/request') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      const body = MagicLinkRequestSchema.parse(await readJsonBody(request));
      const result = await authService.requestMagicLink({
        email: body.email,
        inviteToken: auth.inviteToken,
        verifyBaseUrl: `${url.origin}/api/auth/magic-link/verify`,
        nextPath: body.next,
      });
      return jsonResponse(result, 202);
    }

    if (method === 'GET' && pathname === '/api/auth/magic-link/verify') {
      const rawToken = url.searchParams.get('token') ?? '';
      const nextPath = sanitizeNextPath(url.searchParams.get('next'));
      try {
        const { user } = await authService.verifyMagicLink({ rawToken });
        const sessionToken = await signSessionToken({
          secret: sessionSecret,
          clock,
          ttlSeconds: sessionTtlSeconds,
          payload: {
            kind: 'user',
            email: user.email,
            display_name: user.display_name,
            role: user.role,
          },
        });
        return redirectResponse(nextPath, [
          serializeSetCookie({
            name: getSessionCookieName(isSecure),
            value: sessionToken,
            maxAgeSeconds: sessionTtlSeconds,
            isSecure,
          }),
        ]);
      } catch (error) {
        if (isBrowserNavigation(request)) {
          const errorCode = mapAuthErrorToBrowserCode(error, 'magic_link');
          const clearCookies: string[] = [];
          if (auth.principal.kind === 'anonymous' && readSessionCookieRaw(request, isSecure)) {
            clearCookies.push(serializeClearCookie(getSessionCookieName(isSecure), isSecure));
          }
          return redirectResponse(buildAuthErrorRedirectUrl(nextPath, errorCode, 'magic_link'), clearCookies);
        }
        throw error;
      }
    }

    if (
      method === 'GET' &&
      ((segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'auth' &&
        segments[2] === 'invite') ||
        (segments.length === 2 && segments[0] === 'invite'))
    ) {
      try {
        const inviteToken = decodeSegment(segments[segments.length - 1]);
        const { invite } = await authService.redeemInvite(inviteToken);
        const sessionToken = await signSessionToken({
          secret: sessionSecret,
          clock,
          ttlSeconds: sessionTtlSeconds,
          payload: {
            kind: 'invite_viewer',
            invite_token: invite.token,
            label: invite.label,
          },
        });
        return redirectResponse('/', [
          serializeSetCookie({
            name: getSessionCookieName(isSecure),
            value: sessionToken,
            maxAgeSeconds: sessionTtlSeconds,
            isSecure,
          }),
        ]);
      } catch (error) {
        if (isBrowserNavigation(request)) {
          const errorCode = mapAuthErrorToBrowserCode(error, 'invite');
          const clearCookies: string[] = [];
          if (auth.principal.kind === 'anonymous' && readSessionCookieRaw(request, isSecure)) {
            clearCookies.push(serializeClearCookie(getSessionCookieName(isSecure), isSecure));
          }
          return redirectResponse(buildAuthErrorRedirectUrl('/', errorCode, 'invite'), clearCookies);
        }
        throw error;
      }
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      const headers = new Headers({ 'cache-control': 'no-store' });
      headers.append('set-cookie', serializeClearCookie(getSessionCookieName(isSecure), isSecure));
      return new Response(null, { status: 204, headers });
    }

    return null;
  };
}
