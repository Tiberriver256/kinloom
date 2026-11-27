/** @vitest-environment jsdom */
import type { ArchiveDataSource, KinloomSiteConfig } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClientError, HttpWikiDataSource } from '../../adapters/httpWikiDataSource.js';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { AuthStatusBanner } from './AuthStatusBanner.js';
import {
  type AuthErrorCode,
  parseInviteInput,
  resolveAuthFeedback,
  stripAuthErrorParams,
  validateEmailInput,
} from './authErrorCopy.js';
import { PrivateArchiveGate } from './PrivateArchiveGate.js';
import { SignInModal } from './SignInModal.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Family Archive',
    familyName: 'Alder Family',
    description: 'Stories, photographs, and records preserved for the Alder family.',
    gedcomSourceName: 'ALDER_AUTH_TEST',
  },
});

const { bundle: testBundle } = compileArchive({
  siteConfig,
  mode: 'private',
  people: [],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

function renderIntoDom(element: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeAuthDataSource(options: {
  google?: boolean;
  magicLink?: boolean;
  onRequestMagicLink?: (email: string) => Promise<{ sent: boolean }>;
}): ArchiveDataSource {
  return {
    loadArchive: async () => ({ bundle: testBundle, etag: null, notModified: false }),
    loadReadings: async () => null,
    requestMagicLink: options.onRequestMagicLink ?? (async () => ({ sent: true })),
    getSession: async () => ({
      session: { authenticated: false, principal_kind: 'anonymous' },
      capabilities: {
        canEdit: false,
        canUploadMedia: false,
        hasRevisionHistory: false,
        hasTalk: false,
        canManageSite: false,
      },
      authProviders: {
        google: options.google ?? true,
        magicLink: options.magicLink ?? true,
      },
    }),
  };
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});

describe('authErrorCopy pure helpers', () => {
  it('maps every canonical error code to warm human copy without raw error codes', () => {
    const allCodes: AuthErrorCode[] = [
      'INVITE_REQUIRED',
      'GOOGLE_CANCELLED',
      'GOOGLE_AUTH_FAILED',
      'INVALID_OAUTH_STATE',
      'AUTH_PROVIDER_UNCONFIGURED',
      'MAGIC_LINK_EXPIRED',
      'MAGIC_LINK_USED',
      'MAGIC_LINK_INVALID',
      'TOKEN_INVALID_OR_EXPIRED',
      'INVITE_EXPIRED',
      'INVITE_REVOKED',
      'INVITE_INVALID',
      'INVITE_INVALID_OR_REVOKED',
      'RATE_LIMITED',
      'EMAIL_SENDER_UNCONFIGURED',
      'EMAIL_RECIPIENT_NOT_ALLOWED',
      'EMAIL_DELIVERY_FAILED',
      'VALIDATION_ERROR',
      'CSRF_ORIGIN_MISMATCH',
      'NETWORK_ERROR',
      'AUTH_ERROR',
    ];

    for (const code of allCodes) {
      const fb = resolveAuthFeedback({ code, provider: 'google', hasGoogleProvider: true });
      expect(fb.title.length).toBeGreaterThan(5);
      expect(fb.detail.length).toBeGreaterThan(10);
      expect(fb.title).not.toContain(code);
      expect(fb.detail).not.toContain(code);
      if (fb.hint) {
        expect(fb.hint).not.toContain(code);
      }
    }

    const cancelled = resolveAuthFeedback({
      code: 'GOOGLE_CANCELLED',
      provider: 'google',
      hasGoogleProvider: true,
    });
    expect(cancelled.tone).toBe('info');
    expect(cancelled.title).toBe('Google sign-in was canceled');

    const googleInviteReq = resolveAuthFeedback({
      code: 'INVITE_REQUIRED',
      provider: 'google',
      hasGoogleProvider: true,
    });
    expect(googleInviteReq.title).toBe("That Google account isn't on the family list yet");
    expect(googleInviteReq.showSwitchGoogleAccount).toBe(true);
    expect(googleInviteReq.showInvitePaste).toBe(true);

    const magicInviteReq = resolveAuthFeedback({
      code: 'INVITE_REQUIRED',
      provider: 'magic_link',
      hasGoogleProvider: true,
    });
    expect(magicInviteReq.title).toBe("That email isn't on the family list yet");
    expect(magicInviteReq.showSwitchGoogleAccount).toBe(false);
    expect(magicInviteReq.showInvitePaste).toBe(true);
    expect(magicInviteReq.focusEmailInput).toBe(true);
  });

  it('parses full invite URLs, API invite URLs, relative paths, and raw tokens while rejecting invalid inputs', () => {
    expect(parseInviteInput('https://alder.example.test/invite/inv_abc123XYZ')).toEqual({
      ok: true,
      token: 'inv_abc123XYZ',
      path: '/invite/inv_abc123XYZ',
    });
    expect(parseInviteInput('http://localhost:8787/api/auth/invite/inv_token_99?utm_source=sms#top')).toEqual(
      {
        ok: true,
        token: 'inv_token_99',
        path: '/invite/inv_token_99',
      }
    );
    expect(parseInviteInput('/invite/family_2026_link')).toEqual({
      ok: true,
      token: 'family_2026_link',
      path: '/invite/family_2026_link',
    });
    expect(parseInviteInput('  rawInviteToken_42  ')).toEqual({
      ok: true,
      token: 'rawInviteToken_42',
      path: '/invite/rawInviteToken_42',
    });

    expect(parseInviteInput('   ').ok).toBe(false);
    expect(parseInviteInput('https://example.org/people/arthur').ok).toBe(false);
    expect(parseInviteInput('https://example.org/invite/').ok).toBe(false);
    expect(parseInviteInput('hello world not a token').ok).toBe(false);
    expect(parseInviteInput('abc').ok).toBe(false);
  });

  it('strips only auth_error and auth_provider while preserving other params and hash', () => {
    expect(
      stripAuthErrorParams(
        '/person/arthur',
        '?tab=life&auth_error=INVITE_REQUIRED&auth_provider=google',
        '#notes'
      )
    ).toBe('/person/arthur?tab=life#notes');
    expect(stripAuthErrorParams('/', '?auth_error=GOOGLE_CANCELLED&auth_provider=google')).toBe('/');
  });

  it('validates email format cleanly', () => {
    expect(validateEmailInput('')).toBe('Please enter your email address.');
    expect(validateEmailInput('not-an-email')).toContain('relative@example.com');
    expect(validateEmailInput('cousin@example.test')).toBeNull();
  });

  it('builds Google sign-in URLs with select_account=1 when requested', () => {
    const ds = new HttpWikiDataSource({ apiBaseUrl: '' });
    expect(ds.getGoogleSignInUrl('/tree')).toBe('/api/auth/google/start?next=%2Ftree');
    expect(ds.getGoogleSignInUrl('/tree', { selectAccount: true })).toBe(
      '/api/auth/google/start?next=%2Ftree&select_account=1'
    );
  });
});

describe('PrivateArchiveGate, SignInModal, and AuthStatusBanner unhappy-path recovery flows', () => {
  it('consumes INVITE_REQUIRED from URL, cleans address bar, offers select_account Google switch, and parses pasted invite link', async () => {
    window.history.replaceState(
      null,
      '',
      '/person/arthur?tab=bio&auth_error=INVITE_REQUIRED&auth_provider=google#story'
    );
    const navigatedPaths: string[] = [];

    const { container, unmount } = renderIntoDom(
      <ArchiveProvider
        siteConfig={siteConfig}
        dataSource={makeAuthDataSource({ google: true, magicLink: true })}
        initialBundle={testBundle}
      >
        <PrivateArchiveGate
          onNavigateToInvite={(path) => {
            navigatedPaths.push(path);
          }}
        />
      </ArchiveProvider>
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // URL cleaned while preserving path, tab param, and hash
    expect(window.location.pathname).toBe('/person/arthur');
    expect(window.location.search).toBe('?tab=bio');
    expect(window.location.hash).toBe('#story');

    // Warm copy shown with zero raw error code
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("That Google account isn't on the family list yet");
    expect(alert?.textContent).not.toContain('INVITE_REQUIRED');

    // Direct 1-tap switch account button passes select_account=1 and clean next
    const switchLink = [...container.querySelectorAll<HTMLAnchorElement>('a')].find((a) =>
      a.textContent?.includes('Try a different Google account')
    );
    expect(switchLink?.getAttribute('href')).toBe(
      '/api/auth/google/start?next=%2Fperson%2Farthur%3Ftab%3Dbio&select_account=1'
    );

    // Inline invite paste panel is auto-expanded; invalid input shows inline error, valid URL navigates
    const inviteInput = container.querySelector<HTMLInputElement>('input[name="invite"]');
    expect(inviteInput).not.toBeNull();
    const inviteForm = inviteInput!.closest('form')!;

    act(() => {
      setInputValue(inviteInput!, 'https://example.org/not-an-invite');
    });
    act(() => {
      inviteForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(inviteInput!.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('not a family invite link');
    expect(navigatedPaths).toEqual([]);

    act(() => {
      setInputValue(inviteInput!, 'https://alder.example.test/invite/reunion_2026_abc');
    });
    act(() => {
      inviteForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(navigatedPaths).toEqual(['/invite/reunion_2026_abc']);

    unmount();
  });

  it('renders calm info banner for GOOGLE_CANCELLED and focuses email input for MAGIC_LINK_EXPIRED', async () => {
    window.history.replaceState(null, '', '/?auth_error=GOOGLE_CANCELLED&auth_provider=google');
    const cancelledRender = renderIntoDom(
      <ArchiveProvider
        siteConfig={siteConfig}
        dataSource={makeAuthDataSource({ google: true, magicLink: true })}
        initialBundle={testBundle}
      >
        <PrivateArchiveGate />
      </ArchiveProvider>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(window.location.search).toBe('');
    const statusBanner = cancelledRender.container.querySelector('[role="status"]');
    expect(statusBanner?.className).toContain('is-info');
    expect(statusBanner?.textContent).toContain('Google sign-in was canceled');
    cancelledRender.unmount();

    window.history.replaceState(null, '', '/?auth_error=MAGIC_LINK_EXPIRED&auth_provider=magic_link');
    const expiredRender = renderIntoDom(
      <ArchiveProvider
        siteConfig={siteConfig}
        dataSource={makeAuthDataSource({ google: true, magicLink: true })}
        initialBundle={testBundle}
      >
        <PrivateArchiveGate />
      </ArchiveProvider>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(expiredRender.container.textContent).toContain('That sign-in link has expired');
    const emailInput = expiredRender.container.querySelector<HTMLInputElement>('input[name="email"]');
    expect(document.activeElement).toBe(emailInput);
    expiredRender.unmount();
  });

  it('handles magic-link validation, API INVITE_REQUIRED error, clearing on edit, resend, and Use a different email', async () => {
    const requestedEmails: string[] = [];
    let shouldFailInvite = true;

    const ds = makeAuthDataSource({
      google: true,
      magicLink: true,
      onRequestMagicLink: async (email) => {
        requestedEmails.push(email);
        if (shouldFailInvite) {
          throw new ApiClientError(403, 'INVITE_REQUIRED', 'Not invited');
        }
        return { sent: true };
      },
    });

    const { container, unmount } = renderIntoDom(
      <ArchiveProvider siteConfig={siteConfig} dataSource={ds} initialBundle={testBundle}>
        <PrivateArchiveGate />
      </ArchiveProvider>
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const emailInput = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    const form = emailInput.closest('form')!;

    // Malformed email caught client-side before request
    act(() => {
      setInputValue(emailInput, 'bad-email');
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(emailInput.getAttribute('aria-invalid')).toBe('true');
    expect(requestedEmails).toEqual([]);

    // Valid email -> server returns INVITE_REQUIRED -> shows warm banner + opens invite helper
    act(() => {
      setInputValue(emailInput, 'guest@example.test');
    });
    expect(emailInput.getAttribute('aria-invalid')).toBe('false');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(requestedEmails).toEqual(['guest@example.test']);
    expect(container.textContent).toContain("That email isn't on the family list yet");
    expect(container.querySelector('input[name="invite"]')).not.toBeNull();

    // Editing email clears stale banner and succeeds on retry -> post-send recovery buttons work
    shouldFailInvite = false;
    act(() => {
      setInputValue(emailInput, 'cousin@example.test');
    });
    expect(container.textContent).not.toContain("That email isn't on the family list yet");

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.textContent).toContain('cousin@example.test');

    // Resend button sends another link
    const resendBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Send another link')
    );
    await act(async () => {
      resendBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(requestedEmails).toEqual(['guest@example.test', 'cousin@example.test', 'cousin@example.test']);
    expect(container.textContent).toContain('Fresh sign-in link sent');

    // Use a different email returns to editable input
    const diffEmailBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Use a different email')
    );
    act(() => {
      diffEmailBtn?.click();
    });
    const editableInput = container.querySelector<HTMLInputElement>('input[name="email"]');
    expect(editableInput?.value).toBe('cousin@example.test');

    unmount();
  });

  it('auto-opens SignInModal for invite_viewer returning with auth_error and renders dismissible notice for signed-in user', async () => {
    window.history.replaceState(null, '', '/?auth_error=INVITE_REVOKED&auth_provider=google');

    const inviteViewerRender = renderIntoDom(
      <ArchiveProvider
        siteConfig={siteConfig}
        initialBundle={testBundle}
        session={{
          authenticated: false,
          principal_kind: 'invite_viewer',
          role: 'viewer',
          inviteLabel: 'Reunion Link',
        }}
      >
        <AuthStatusBanner />
      </ArchiveProvider>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(window.location.search).toBe('');
    const dialog = inviteViewerRender.container.querySelector(
      'dialog[aria-label="Sign in to family archive"]'
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('That family invite link is no longer active');
    inviteViewerRender.unmount();

    // Signed-in user clicking an expired invite sees a dismissible notice bar
    window.history.replaceState(null, '', '/?auth_error=INVITE_EXPIRED&auth_provider=invite');
    const userRender = renderIntoDom(
      <ArchiveProvider
        siteConfig={siteConfig}
        initialBundle={testBundle}
        session={{
          authenticated: true,
          principal_kind: 'user',
          role: 'editor',
          displayName: 'Clara Alder',
        }}
      >
        <AuthStatusBanner />
      </ArchiveProvider>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(window.location.search).toBe('');
    expect(userRender.container.textContent).toContain('That family invite link has expired');
    const dismissBtn = userRender.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss sign-in notice"]'
    );
    act(() => {
      dismissBtn?.click();
    });
    expect(userRender.container.querySelector('.wiki-auth-notice-bar')).toBeNull();
    userRender.unmount();
  });

  it('renders SignInModal with initialUrlError and handles network failures cleanly', async () => {
    const ds = makeAuthDataSource({
      google: false,
      magicLink: true,
      onRequestMagicLink: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const { container, unmount } = renderIntoDom(
      <ArchiveProvider siteConfig={siteConfig} dataSource={ds} initialBundle={testBundle}>
        <SignInModal
          open
          onClose={() => {}}
          initialUrlError={{ code: 'INVALID_OAUTH_STATE', provider: 'google' }}
        />
      </ArchiveProvider>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.textContent).toContain('Your sign-in session expired');

    const emailInput = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    act(() => {
      setInputValue(emailInput, 'editor@example.test');
    });
    await act(async () => {
      emailInput.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.textContent).toContain('Could not reach the family archive');
    unmount();
  });
});
