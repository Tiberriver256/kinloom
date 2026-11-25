import { z } from 'zod';
import type { AuthProvider } from '@kinloom/core';
import { KinloomHttpError } from '../errors.js';

const GoogleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
});

const GoogleUserInfoSchema = z.object({
  email: z.string().email(),
  email_verified: z.boolean().default(false),
  name: z.string().optional(),
  given_name: z.string().optional(),
});

export interface GoogleOAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  fetchFn?: typeof fetch;
}

/**
 * Cloud-agnostic Google OAuth 2.0 + PKCE AuthProvider using standard fetch().
 * Persists zero Google access/refresh tokens after extracting verified email and display name.
 */
export class GoogleOAuthProvider implements AuthProvider {
  readonly id = 'google';
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly authorizationEndpoint: string;
  private readonly tokenEndpoint: string;
  private readonly userInfoEndpoint: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: GoogleOAuthProviderConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.authorizationEndpoint =
      config.authorizationEndpoint ?? 'https://accounts.google.com/o/oauth2/v2/auth';
    this.tokenEndpoint = config.tokenEndpoint ?? 'https://oauth2.googleapis.com/token';
    this.userInfoEndpoint =
      config.userInfoEndpoint ?? 'https://openidconnect.googleapis.com/v1/userinfo';
    this.fetchFn = config.fetchFn ?? ((input, init) => fetch(input, init));
  }

  buildAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    const url = new URL(this.authorizationEndpoint);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{ email: string; displayName: string; emailVerified: boolean }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const tokenRes = await this.fetchFn(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      throw new KinloomHttpError(
        400,
        'INVALID_OAUTH_STATE',
        `OAuth token exchange failed with status ${tokenRes.status}.`
      );
    }

    const tokenJson: unknown = await tokenRes.json();
    const tokenParsed = GoogleTokenResponseSchema.safeParse(tokenJson);
    if (!tokenParsed.success) {
      throw new KinloomHttpError(
        400,
        'INVALID_OAUTH_STATE',
        'OAuth provider returned an invalid token payload.'
      );
    }

    const userRes = await this.fetchFn(this.userInfoEndpoint, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${tokenParsed.data.access_token}`,
        accept: 'application/json',
      },
    });

    if (!userRes.ok) {
      throw new KinloomHttpError(
        400,
        'INVALID_OAUTH_STATE',
        `OAuth userinfo request failed with status ${userRes.status}.`
      );
    }

    const userJson: unknown = await userRes.json();
    const userParsed = GoogleUserInfoSchema.safeParse(userJson);
    if (!userParsed.success) {
      throw new KinloomHttpError(
        400,
        'INVALID_OAUTH_STATE',
        'OAuth provider returned an invalid user profile.'
      );
    }

    const email = userParsed.data.email.trim().toLowerCase();
    const displayName =
      userParsed.data.name?.trim() ||
      userParsed.data.given_name?.trim() ||
      email.split('@')[0] ||
      'Member';

    return {
      email,
      displayName,
      emailVerified: userParsed.data.email_verified,
    };
  }
}
