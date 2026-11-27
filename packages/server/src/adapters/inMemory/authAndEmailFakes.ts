import type { AuthProvider, EmailSender } from '@kinloom/core';
import { KinloomHttpError } from '../../errors.js';

export interface SentMagicLinkEmail {
  toEmail: string;
  siteTitle: string;
  magicLinkUrl: string;
  expiresMinutes: number;
}

export class InMemoryEmailSender implements EmailSender {
  readonly sentMessages: SentMagicLinkEmail[] = [];

  async sendMagicLink(params: SentMagicLinkEmail): Promise<void> {
    this.sentMessages.push({ ...params });
  }
}

export interface FakeOAuthProfile {
  email: string;
  displayName: string;
  emailVerified: boolean;
}

export class FakeAuthProvider implements AuthProvider {
  readonly id = 'fake-google';
  private readonly profilesByCode = new Map<string, FakeOAuthProfile>();
  public lastAuthorizationParams: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    prompt?: 'select_account' | 'consent';
  } | null = null;
  public lastExchangeParams: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  } | null = null;

  registerCode(code: string, profile: FakeOAuthProfile): void {
    this.profilesByCode.set(code, profile);
  }

  buildAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    prompt?: 'select_account' | 'consent';
  }): string {
    this.lastAuthorizationParams = { ...params };
    const url = new URL('https://accounts.example.test/oauth/authorize');
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('redirect_uri', params.redirectUri);
    if (params.prompt) {
      url.searchParams.set('prompt', params.prompt);
    }
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<FakeOAuthProfile> {
    this.lastExchangeParams = { ...params };
    const profile = this.profilesByCode.get(params.code);
    if (!profile) {
      throw new KinloomHttpError(400, 'INVALID_OAUTH_STATE', `Unknown OAuth code: ${params.code}`);
    }
    return { ...profile };
  }
}
