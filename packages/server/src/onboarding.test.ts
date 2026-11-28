import { OnboardingSessionResponseSchema } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import {
  AuthService,
  createInMemoryServerPorts,
  createKinloomServer,
  getSessionCookieName,
  normalizeServerRouteTemplate,
  signSessionToken,
} from './index.js';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticSiteConfig,
} from './testing/adapterContractSuite.js';

describe('@kinloom/server onboarding endpoints and first-login capture (#54)', () => {
  it('captures priorLastLoginAt === null before touchUserLogin on pre-enrolled user magic-link login', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T08:00:00.000Z' });
    const email = 'new.editor@archive.example';

    await ports.repository.upsertUser({
      email,
      display_name: 'New Editor',
      role: 'editor',
      added_by: 'admin@archive.example',
      added_at: '2026-11-26T12:00:00.000Z',
      last_login_at: null,
    });

    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: CONTRACT_SESSION_SECRET,
      mode: 'public',
    });

    // Request magic link
    const reqRes = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
        method: 'POST',
        headers: {
          origin: CONTRACT_TEST_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email }),
      })
    );
    expect(reqRes.status).toBe(202);
    expect(ports.emailSender.sentMessages).toHaveLength(1);
    const verifyUrl = ports.emailSender.sentMessages[0].magicLinkUrl;

    // Complete magic-link verify (touches last_login_at AND records first_login_pending = true)
    const verifyRes = await server.fetch(new Request(verifyUrl, { method: 'GET' }));
    expect(verifyRes.status).toBe(302);
    const setCookie = verifyRes.headers.get('set-cookie') ?? '';
    const sessionCookie = setCookie.split(';')[0];
    expect(sessionCookie).toContain(getSessionCookieName(true));

    // User now has last_login_at populated, yet GET /api/auth/me/onboarding reports first login accurately
    const updatedUser = await ports.repository.getUser(email);
    expect(updatedUser?.last_login_at).toBe('2026-11-27T08:00:00.000Z');

    const getRes = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me/onboarding`, {
        method: 'GET',
        headers: { cookie: sessionCookie },
      })
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('cache-control')).toBe('no-store');
    const firstPayload = OnboardingSessionResponseSchema.parse(await getRes.json());
    expect(firstPayload.is_first_login).toBe(true);
    expect(firstPayload.should_auto_open_tutorial_modal).toBe(true);

    // Dismiss tutorial modal and complete a step
    ports.clock.advanceMs(60_000);
    const putRes = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me/onboarding`, {
        method: 'PUT',
        headers: {
          origin: CONTRACT_TEST_ORIGIN,
          cookie: sessionCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          dismiss_tutorial_modal: true,
          complete_step_ids: ['core:editor:review-changes'],
        }),
      })
    );
    expect(putRes.status).toBe(200);
    const afterPut = OnboardingSessionResponseSchema.parse(await putRes.json());
    expect(afterPut.is_first_login).toBe(false);
    expect(afterPut.should_auto_open_tutorial_modal).toBe(false);
    expect(afterPut.state.completed_step_ids).toEqual(['core:editor:review-changes']);
    expect(afterPut.state.tutorial_modal_dismissed_at).toBe('2026-11-27T08:01:00.000Z');

    // Second login does NOT re-enable first-login modal
    ports.clock.advanceMs(60_000);
    const req2 = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
        method: 'POST',
        headers: { origin: CONTRACT_TEST_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    );
    expect(req2.status).toBe(202);
    const verify2 = await server.fetch(new Request(ports.emailSender.sentMessages[1].magicLinkUrl));
    expect(verify2.status).toBe(302);
    const cookie2 = (verify2.headers.get('set-cookie') ?? '').split(';')[0];

    const get2 = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me/onboarding`, {
        headers: { cookie: cookie2 },
      })
    );
    const secondPayload = OnboardingSessionResponseSchema.parse(await get2.json());
    expect(secondPayload.is_first_login).toBe(false);
    expect(secondPayload.should_auto_open_tutorial_modal).toBe(false);
    expect(secondPayload.state.completed_step_ids).toEqual(['core:editor:review-changes']);
  });

  it('captures first login for bootstrap admin and invite-enrolled editors via Google OAuth', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T09:00:00.000Z' });
    const adminEmail = 'founder.admin@archive.example';
    const inviteeEmail = 'cousin.editor@archive.example';

    await ports.repository.createInvite({
      token: 'inv-onboarding-test',
      label: 'Reunion invite',
      created_by: adminEmail,
      created_at: '2026-11-27T08:00:00.000Z',
      expires_at: null,
      revoked_at: null,
      uses: 0,
      last_used_at: null,
    });

    ports.authProvider.registerCode('code-admin', {
      email: adminEmail,
      displayName: 'Founder Admin',
      emailVerified: true,
    });
    ports.authProvider.registerCode('code-invitee', {
      email: inviteeEmail,
      displayName: 'Cousin Editor',
      emailVerified: true,
    });

    const authService = new AuthService({
      repository: ports.repository,
      emailSender: ports.emailSender,
      authProvider: ports.authProvider,
      clock: ports.clock,
      siteConfig,
      bootstrapAdminEmail: adminEmail,
      userOnboardingStore: ports.userOnboardingStore,
    });

    await authService.completeGoogleAuth({
      code: 'code-admin',
      codeVerifier: 'verifier-admin',
      redirectUri: `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback`,
      inviteToken: null,
    });
    const adminOnboarding = await authService.getOnboardingSession({
      kind: 'user',
      email: adminEmail,
      display_name: 'Founder Admin',
      role: 'admin',
    });
    expect(adminOnboarding.is_first_login).toBe(true);
    expect(adminOnboarding.should_auto_open_tutorial_modal).toBe(true);

    await authService.completeGoogleAuth({
      code: 'code-invitee',
      codeVerifier: 'verifier-invitee',
      redirectUri: `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback`,
      inviteToken: 'inv-onboarding-test',
    });
    const inviteeOnboarding = await authService.getOnboardingSession({
      kind: 'user',
      email: inviteeEmail,
      display_name: 'Cousin Editor',
      role: 'editor',
    });
    expect(inviteeOnboarding.is_first_login).toBe(true);
    expect(inviteeOnboarding.should_auto_open_tutorial_modal).toBe(true);
  });

  it('serves default state to anonymous/invite callers, rejects anonymous writes with 401, and enforces CSRF', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: CONTRACT_SESSION_SECRET,
      mode: 'public',
    });

    // Anonymous GET returns 200 default state without 401 console noise
    const anonGet = await server.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me/onboarding`));
    expect(anonGet.status).toBe(200);
    const anonBody = OnboardingSessionResponseSchema.parse(await anonGet.json());
    expect(anonBody.is_first_login).toBe(false);
    expect(anonBody.should_auto_open_tutorial_modal).toBe(false);

    // Anonymous PUT returns 401
    const anonPut = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me/onboarding`, {
        method: 'PUT',
        headers: {
          origin: CONTRACT_TEST_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ complete_step_ids: ['core:viewer:open-tree'] }),
      })
    );
    expect(anonPut.status).toBe(401);

    // Signed-in user PUT with cross-origin header fails CSRF (403)
    await ports.repository.upsertUser({
      email: 'member@archive.example',
      display_name: 'Member',
      role: 'editor',
      added_by: 'admin@archive.example',
      added_at: '2026-11-27T00:00:00.000Z',
      last_login_at: '2026-11-27T00:00:00.000Z',
    });
    const token = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock: ports.clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: 'member@archive.example',
        display_name: 'Member',
        role: 'editor',
      },
    });
    const cookieHeader = `${getSessionCookieName(true)}=${token}`;

    const csrfFail = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me/onboarding`, {
        method: 'PUT',
        headers: {
          origin: 'https://evil.example',
          cookie: cookieHeader,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ checklist_visibility: 'collapsed' }),
      })
    );
    expect(csrfFail.status).toBe(403);

    // Invalid payload returns 400
    const badBody = await server.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me/onboarding`, {
        method: 'PUT',
        headers: {
          origin: CONTRACT_TEST_ORIGIN,
          cookie: cookieHeader,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ unknown_field: true }),
      })
    );
    expect(badBody.status).toBe(400);

    // Route template normalization keeps exact bounded route with zero PII
    expect(normalizeServerRouteTemplate('/api/auth/me/onboarding')).toBe('/api/auth/me/onboarding');

    // AuthService without userOnboardingStore degrades cleanly
    const statelessAuth = new AuthService({
      repository: ports.repository,
      emailSender: ports.emailSender,
      clock: ports.clock,
      siteConfig,
    });
    const principal = {
      kind: 'user' as const,
      email: 'member@archive.example',
      display_name: 'Member',
      role: 'editor' as const,
    };
    const defaultResp = await statelessAuth.getOnboardingSession(principal);
    expect(defaultResp.is_first_login).toBe(false);
    const patchedResp = await statelessAuth.updateOnboardingSession(principal, {
      complete_step_ids: ['core:editor:cite-source'],
    });
    expect(patchedResp.state.completed_step_ids).toEqual(['core:editor:cite-source']);
  });
});
