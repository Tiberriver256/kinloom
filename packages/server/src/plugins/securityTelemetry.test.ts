import { KinloomSiteConfigSchema } from '@kinloom/core';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryServerPorts, FakeAuthProvider } from '../adapters/inMemory.js';
import type { FixedClock } from '../adapters/systemClock.js';
import { sha256Hex } from '../crypto.js';
import {
  hasSecurityEventPlugins,
  type KinloomServerPlugin,
  SERVER_SECURITY_EVENT_TYPES,
  sanitizeMediaContentType,
} from '../http/pluginLifecycle.js';
import { createKinloomServer } from '../http/router.js';
import { getSessionCookieName, signSessionToken } from '../http/session.js';
import {
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';
import {
  createWorkersObservabilityPlugin,
  type SecurityTelemetryLogRecord,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
  type WorkersObservabilityLogRecord,
} from './workersObservability.js';

const ORIGIN = 'https://alder.example.test';
const SECRET = 'kinloom-security-telemetry-test-secret-2026-xyz';

async function createUserCookie(
  clock: FixedClock,
  user: { email: string; display_name: string; role: 'admin' | 'editor' }
): Promise<string> {
  const token = await signSessionToken({
    secret: SECRET,
    clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email: user.email,
      display_name: user.display_name,
      role: user.role,
    },
  });
  return `${getSessionCookieName(true)}=${token}`;
}

async function createInviteCookie(clock: FixedClock, inviteToken: string, label: string): Promise<string> {
  const token = await signSessionToken({
    secret: SECRET,
    clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'invite_viewer',
      invite_token: inviteToken,
      label,
    },
  });
  return `${getSessionCookieName(true)}=${token}`;
}

describe('Security and abuse telemetry module (Issue #31)', () => {
  it('stays completely off by default with no plugin and with createWorkersObservabilityPlugin() default options', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const clock = ports.clock;
    await ports.repository.upsertUser({
      email: 'archivist@example.test',
      display_name: 'Archive Admin',
      role: 'admin',
      added_at: clock.nowIso(),
      added_by: 'bootstrap',
      last_login_at: null,
    });
    const adminCookie = await createUserCookie(clock, {
      email: 'archivist@example.test',
      display_name: 'Archive Admin',
      role: 'admin',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // 1. Default server with no plugins emits zero logs and zero security telemetry.
      const defaultServer = createKinloomServer({
        siteConfig,
        ports,
        sessionSecret: SECRET,
      });

      const csrfRes = await defaultServer.fetch(
        new Request(`${ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: { cookie: adminCookie, origin: 'https://evil.example.test' },
        })
      );
      expect(csrfRes.status).toBe(403);

      const badTokenRes = await defaultServer.fetch(
        new Request(`${ORIGIN}/api/bundle`, {
          headers: { authorization: 'Bearer kin_invalid_default_off_123456' },
        })
      );
      expect(badTokenRes.status).toBe(401);

      expect(logSpy.mock.calls).toHaveLength(0);
      expect(warnSpy.mock.calls).toHaveLength(0);
      expect(errorSpy.mock.calls).toHaveLength(0);

      // 2. Observability plugin registered WITHOUT securityTelemetry (or explicitly false / disabled).
      const alerts: SecurityTelemetryLogRecord[] = [];
      const httpRecords: WorkersObservabilityLogRecord[] = [];

      const defaultObsPlugin = createWorkersObservabilityPlugin({
        clock,
        sink: (record) => {
          httpRecords.push(record);
        },
      });
      const explicitFalsePlugin = createWorkersObservabilityPlugin({
        clock,
        securityTelemetry: false,
      });
      const disabledObjectPlugin = createWorkersObservabilityPlugin({
        clock,
        securityTelemetry: {
          enabled: false,
          alertSink: (record) => {
            alerts.push(record);
          },
        },
      });
      const topLevelDisabledPlugin = createWorkersObservabilityPlugin({
        enabled: false,
        securityTelemetry: true,
      });

      expect(hasSecurityEventPlugins([defaultObsPlugin])).toBe(false);
      expect(hasSecurityEventPlugins([explicitFalsePlugin])).toBe(false);
      expect(hasSecurityEventPlugins([disabledObjectPlugin])).toBe(false);
      expect(hasSecurityEventPlugins([topLevelDisabledPlugin])).toBe(false);

      const obsOnlyServer = createKinloomServer({
        siteConfig,
        ports: { ...ports, plugins: [defaultObsPlugin] },
        sessionSecret: SECRET,
      });

      const obsCsrfRes = await obsOnlyServer.fetch(
        new Request(`${ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: { cookie: adminCookie, origin: 'https://evil.example.test' },
        })
      );
      expect(obsCsrfRes.status).toBe(403);
      expect(httpRecords).toHaveLength(1);
      expect(httpRecords[0]?.event).toBe('http_request');
      expect(warnSpy.mock.calls).toHaveLength(0);
      expect(errorSpy.mock.calls).toHaveLength(0);
      expect(alerts).toEqual([]);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('emits typed, PII-redacted security_event records for all 8 security denial types and correlates request_id', async () => {
    const baseSiteConfig = createSyntheticSiteConfig();
    const siteConfig = KinloomSiteConfigSchema.parse({
      ...baseSiteConfig,
      wiki: {
        ...baseSiteConfig.wiki,
        allowTalk: true,
        maxUploadBytes: 64,
      },
    });
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const clock = ports.clock;

    const secretEmail = 'clara.private@example.test';
    const editorEmail = 'editor.alder@example.test';
    const adminEmail = 'archivist@example.test';
    const secretAgentBearer = 'kin_secret_revoked_agent_token_999999';
    const readBackupBearer = 'kin_read_backup_agent_token_888888';
    const secretInviteToken = 'inv_secret_revoked_link_777777';
    const activeInviteToken = 'inv_active_viewer_link_666666';
    const secretIp = '203.0.113.42';

    await ports.repository.upsertUser({
      email: adminEmail,
      display_name: 'Archive Admin',
      role: 'admin',
      added_at: clock.nowIso(),
      added_by: 'bootstrap',
      last_login_at: null,
    });
    await ports.repository.upsertUser({
      email: editorEmail,
      display_name: 'Archive Editor',
      role: 'editor',
      added_at: clock.nowIso(),
      added_by: adminEmail,
      last_login_at: null,
    });
    await ports.repository.createInvite({
      token: activeInviteToken,
      label: 'Viewer Link',
      created_by: adminEmail,
      created_at: clock.nowIso(),
      expires_at: '2026-07-15T12:00:00.000Z',
      revoked_at: null,
      uses: 0,
      last_used_at: null,
    });
    await ports.repository.createInvite({
      token: secretInviteToken,
      label: 'Revoked Link',
      created_by: adminEmail,
      created_at: clock.nowIso(),
      expires_at: '2026-07-15T12:00:00.000Z',
      revoked_at: null,
      uses: 0,
      last_used_at: null,
    });
    await ports.repository.revokeInvite(secretInviteToken, clock.nowIso());
    await ports.repository.createAgentToken({
      token_id: 'tok_read_backup_1',
      label: 'Backup Agent',
      scope: 'read_backup',
      token_hash: await sha256Hex(readBackupBearer),
      created_by: adminEmail,
      created_at: clock.nowIso(),
      revoked_at: null,
    });

    const adminCookie = await createUserCookie(clock, {
      email: adminEmail,
      display_name: 'Archive Admin',
      role: 'admin',
    });
    const editorCookie = await createUserCookie(clock, {
      email: editorEmail,
      display_name: 'Archive Editor',
      role: 'editor',
    });
    const viewerInviteCookie = await createInviteCookie(clock, activeInviteToken, 'Viewer Link');
    const revokedInviteCookie = await createInviteCookie(clock, secretInviteToken, 'Revoked Link');

    const httpRecords: WorkersObservabilityLogRecord[] = [];
    const securityRecords: SecurityTelemetryLogRecord[] = [];
    const alertRecords: SecurityTelemetryLogRecord[] = [];

    const authProvider = new FakeAuthProvider();

    const plugin = createWorkersObservabilityPlugin({
      clock,
      sink: (record) => {
        httpRecords.push(record);
      },
      securityTelemetry: {
        enabled: true,
        sink: (record) => {
          securityRecords.push(record);
        },
        alertSink: (record) => {
          alertRecords.push(record);
        },
      },
    });
    expect(hasSecurityEventPlugins([plugin])).toBe(true);

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        authProvider,
        plugins: [plugin],
      },
      sessionSecret: SECRET,
    });

    // 1. auth.magic_link.rate_limited (10 allowed, 11th returns 429)
    for (let i = 0; i < 10; i += 1) {
      const okMagicRes = await server.fetch(
        new Request(`${ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            'cf-connecting-ip': secretIp,
            'x-forwarded-for': secretIp,
          },
          body: JSON.stringify({ email: secretEmail }),
        })
      );
      expect(okMagicRes.status).toBe(202);
    }
    const rateLimitedRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/request`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'cf-ray': 'rate1234567890ab-ORD',
          'cf-connecting-ip': secretIp,
        },
        body: JSON.stringify({ email: secretEmail }),
      })
    );
    expect(rateLimitedRes.status).toBe(429);
    const rateEvent = securityRecords.find((r) => r.event_type === 'auth.magic_link.rate_limited');
    expect(rateEvent).toEqual({
      event: 'security_event',
      event_type: 'auth.magic_link.rate_limited',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'warn',
      request_id: 'rate1234567890ab-ORD',
      method: 'POST',
      route: '/api/auth/magic-link/request',
      status: 429,
      reason: 'rate_limit_exceeded',
    });
    const matchingHttpForRate = httpRecords.find((r) => r.request_id === 'rate1234567890ab-ORD');
    expect(matchingHttpForRate?.status).toBe(429);

    // 2. auth.magic_link.invalid_or_expired (API 400 + browser navigation 302)
    const invalidMagicRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/verify?token=ml_secret_invalid_token_123456`, {
        headers: { 'cf-ray': 'mlinv123456789ab-ORD' },
      })
    );
    expect(invalidMagicRes.status).toBe(400);
    expect(securityRecords.at(-1)).toEqual({
      event: 'security_event',
      event_type: 'auth.magic_link.invalid_or_expired',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'warn',
      request_id: 'mlinv123456789ab-ORD',
      method: 'GET',
      route: '/api/auth/magic-link/verify',
      status: 400,
      reason: 'invalid',
    });

    const browserMagicRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/verify?token=ml_secret_browser_token_123456`, {
        headers: { accept: 'text/html', 'cf-ray': 'mlbrw123456789ab-ORD' },
      })
    );
    expect(browserMagicRes.status).toBe(302);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'auth.magic_link.invalid_or_expired',
      request_id: 'mlbrw123456789ab-ORD',
      status: 302,
      reason: 'invalid',
    });

    // 3. auth.oauth.failed (callback cancelled + invalid state)
    const oauthCancelledRes = await server.fetch(
      new Request(
        `${ORIGIN}/api/auth/google/callback?error=access_denied&state=oauth_state_secret_99&code=oauth_code_secret_88`,
        { headers: { 'cf-ray': 'oauth123456789ab-ORD' } }
      )
    );
    expect(oauthCancelledRes.status).toBe(400);
    expect(securityRecords.at(-1)).toEqual({
      event: 'security_event',
      event_type: 'auth.oauth.failed',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'warn',
      request_id: 'oauth123456789ab-ORD',
      method: 'GET',
      route: '/api/auth/google/callback',
      status: 400,
      reason: 'cancelled',
      provider: 'google',
    });

    const oauthBadStateRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/callback?code=oauth_code_secret_77&state=bad_state_secret`, {
        headers: { 'cf-ray': 'oauth223456789ab-ORD' },
      })
    );
    expect(oauthBadStateRes.status).toBe(400);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'auth.oauth.failed',
      reason: 'invalid_state',
      provider: 'google',
    });

    // 4. auth.invite.invalid (revoked invite link + revoked invite session cookie)
    const inviteRes = await server.fetch(
      new Request(`${ORIGIN}/invite/${secretInviteToken}`, {
        headers: { 'cf-ray': 'inv12345678901ab-ORD' },
      })
    );
    expect(inviteRes.status).toBe(404);
    expect(securityRecords.at(-1)).toEqual({
      event: 'security_event',
      event_type: 'auth.invite.invalid',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'warn',
      request_id: 'inv12345678901ab-ORD',
      method: 'GET',
      route: '/invite/:token',
      status: 404,
      reason: 'revoked',
    });

    const revokedInviteCookieRes = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, {
        headers: { cookie: revokedInviteCookie, 'cf-ray': 'invc1234567890ab-ORD' },
      })
    );
    expect(revokedInviteCookieRes.status).toBe(401);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'auth.invite.invalid',
      request_id: 'invc1234567890ab-ORD',
      status: 401,
      reason: 'revoked',
    });

    // 5. auth.agent_token.rejected (invalid bearer, empty bearer, insufficient scope)
    const invalidAgentRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secretAgentBearer}`,
          origin: ORIGIN,
          'cf-ray': 'agt12345678901ab-ORD',
        },
      })
    );
    expect(invalidAgentRes.status).toBe(401);
    expect(securityRecords.at(-1)).toEqual({
      event: 'security_event',
      event_type: 'auth.agent_token.rejected',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'warn',
      request_id: 'agt12345678901ab-ORD',
      method: 'POST',
      route: '/api/entities/:type',
      status: 401,
      reason: 'invalid_or_revoked',
    });

    const emptyAgentRes = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, {
        headers: {
          authorization: 'Bearer   ',
          'cf-ray': 'agt22345678901ab-ORD',
        },
      })
    );
    expect(emptyAgentRes.status).toBe(401);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'auth.agent_token.rejected',
      status: 401,
      reason: 'empty_token',
    });

    const wrongScopeAgentRes = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${readBackupBearer}`,
          'content-type': 'application/json',
          'cf-ray': 'agt32345678901ab-ORD',
        },
        body: JSON.stringify({}),
      })
    );
    expect(wrongScopeAgentRes.status).toBe(403);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'auth.agent_token.rejected',
      status: 403,
      reason: 'insufficient_scope',
    });

    // 6. auth.write.forbidden (anonymous write, invite_viewer write, editor admin access, non-owner delete)
    const countBeforeAnonRead = securityRecords.length;
    const anonBundleRes = await server.fetch(new Request(`${ORIGIN}/api/bundle`));
    expect(anonBundleRes.status).toBe(401);
    // Unauthenticated read-only viewer 401 does NOT emit auth.write.forbidden.
    expect(securityRecords.length).toBe(countBeforeAnonRead);

    const anonWriteRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'cf-ray': 'wrt12345678901ab-ORD' },
      })
    );
    expect(anonWriteRes.status).toBe(401);
    expect(securityRecords.at(-1)).toEqual({
      event: 'security_event',
      event_type: 'auth.write.forbidden',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'warn',
      request_id: 'wrt12345678901ab-ORD',
      method: 'POST',
      route: '/api/entities/:type',
      status: 401,
      reason: 'unauthenticated',
      required_role: 'editor',
      actor_kind: 'anonymous',
    });

    const inviteWriteRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { cookie: viewerInviteCookie, origin: ORIGIN, 'cf-ray': 'wrt22345678901ab-ORD' },
      })
    );
    expect(inviteWriteRes.status).toBe(403);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'auth.write.forbidden',
      status: 403,
      reason: 'invite_read_only',
      required_role: 'editor',
      actor_kind: 'invite_viewer',
    });

    const editorAdminRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users`, {
        method: 'GET',
        headers: { cookie: editorCookie, 'cf-ray': 'wrt32345678901ab-ORD' },
      })
    );
    expect(editorAdminRes.status).toBe(403);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'auth.write.forbidden',
      status: 403,
      reason: 'insufficient_role',
      required_role: 'admin',
      actor_kind: 'user',
    });

    // Seed an entity and admin Talk comment, then verify non-owner editor delete emits auth.write.forbidden.
    const arthur = createSyntheticHistoricalPerson();
    const createEntityRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: adminCookie,
          origin: ORIGIN,
        },
        body: JSON.stringify({
          entity_id: arthur.id,
          data: arthur,
          summary: 'Create Arthur Alder for talk ownership check',
          has_primary_source: true,
        }),
      })
    );
    expect(createEntityRes.status).toBe(201);

    const postCommentRes = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${arthur.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: adminCookie,
          origin: ORIGIN,
        },
        body: JSON.stringify({ body_md: 'Archivist note' }),
      })
    );
    expect(postCommentRes.status).toBe(201);
    const postedComment = (await postCommentRes.json()) as { comment: { comment_id: number } };

    const deleteOtherCommentRes = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${arthur.id}/${postedComment.comment.comment_id}`, {
        method: 'DELETE',
        headers: {
          cookie: editorCookie,
          origin: ORIGIN,
          'cf-ray': 'wrt42345678901ab-ORD',
        },
      })
    );
    expect(deleteOtherCommentRes.status).toBe(403);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'auth.write.forbidden',
      route: '/api/talk/:type/:id/:commentId',
      status: 403,
      reason: 'not_owner',
      required_role: 'admin',
      actor_kind: 'user',
    });

    // 7. media.upload.rejected (magic-byte mismatch, unsupported media type, size limit)
    const buildUploadRequest = (params: { bytes: Uint8Array; mimeType: string; cfRay: string }): Request => {
      const form = new FormData();
      form.append(
        'file',
        new File([new Uint8Array(params.bytes)], 'clara-private-scan.png', { type: params.mimeType })
      );
      form.append(
        'metadata',
        JSON.stringify({
          title: 'Private Clara Document',
          kind: 'photo',
        })
      );
      form.append('summary', 'Upload test document');
      return new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: ORIGIN,
          'cf-ray': params.cfRay,
        },
        body: form,
      });
    };

    // 7a. Magic-byte mismatch (declares image/png but payload is plain text)
    const magicMismatchRes = await server.fetch(
      buildUploadRequest({
        bytes: new TextEncoder().encode('not-a-real-png-file'),
        mimeType: 'image/png',
        cfRay: 'med12345678901ab-ORD',
      })
    );
    expect(magicMismatchRes.status).toBe(415);
    expect(securityRecords.at(-1)).toEqual({
      event: 'security_event',
      event_type: 'media.upload.rejected',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'warn',
      request_id: 'med12345678901ab-ORD',
      method: 'POST',
      route: '/api/media/upload',
      status: 415,
      reason: 'magic_bytes_mismatch',
      content_type: 'image/png',
      size_bytes: 19,
    });

    // 7b. Unsupported media type
    const unsupportedMimeRes = await server.fetch(
      buildUploadRequest({
        bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
        mimeType: 'application/x-msdownload',
        cfRay: 'med22345678901ab-ORD',
      })
    );
    expect(unsupportedMimeRes.status).toBe(415);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'media.upload.rejected',
      status: 415,
      reason: 'unsupported_media_type',
      content_type: 'application/x-msdownload',
      size_bytes: 4,
    });

    // 7c. Oversized upload (> 64 bytes configured maxUploadBytes)
    const oversizedPng = new Uint8Array(96);
    oversizedPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const oversizedRes = await server.fetch(
      buildUploadRequest({
        bytes: oversizedPng,
        mimeType: 'image/png',
        cfRay: 'med32345678901ab-ORD',
      })
    );
    expect(oversizedRes.status).toBe(413);
    expect(securityRecords.at(-1)).toEqual({
      event: 'security_event',
      event_type: 'media.upload.rejected',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'warn',
      request_id: 'med32345678901ab-ORD',
      method: 'POST',
      route: '/api/media/upload',
      status: 413,
      reason: 'file_too_large',
      content_type: 'image/png',
      size_bytes: 96,
      max_bytes: 64,
    });

    // 8. csrf.rejected (missing origin on cookie auth + mismatched origin)
    const csrfMissingRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'cf-ray': 'csr12345678901ab-ORD',
        },
      })
    );
    expect(csrfMissingRes.status).toBe(403);
    expect(securityRecords.at(-1)).toEqual({
      event: 'security_event',
      event_type: 'csrf.rejected',
      timestamp: '2026-06-15T12:00:00.000Z',
      level: 'warn',
      request_id: 'csr12345678901ab-ORD',
      method: 'POST',
      route: '/api/auth/logout',
      status: 403,
      reason: 'missing_origin',
      auth_method: 'cookie',
    });

    const csrfMismatchRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: 'https://attacker.evil.example.test',
          'cf-ray': 'csr22345678901ab-ORD',
        },
      })
    );
    expect(csrfMismatchRes.status).toBe(403);
    expect(securityRecords.at(-1)).toMatchObject({
      event_type: 'csrf.rejected',
      status: 403,
      reason: 'origin_mismatch',
      auth_method: 'cookie',
    });

    // Verify all 8 closed union event types were observed.
    const observedTypes = new Set(securityRecords.map((r) => r.event_type));
    for (const expectedType of SERVER_SECURITY_EVENT_TYPES) {
      expect(observedTypes.has(expectedType)).toBe(true);
    }
    expect(alertRecords).toHaveLength(securityRecords.length);

    // Strict PII & secret redaction audit across every single emitted security_event and alert record.
    const serializedAll = JSON.stringify({ securityRecords, alertRecords });
    for (const sensitive of [
      secretEmail,
      editorEmail,
      adminEmail,
      secretAgentBearer,
      readBackupBearer,
      secretInviteToken,
      activeInviteToken,
      secretIp,
      'ml_secret_invalid_token_123456',
      'ml_secret_browser_token_123456',
      'oauth_state_secret_99',
      'oauth_code_secret_88',
      'oauth_code_secret_77',
      'bad_state_secret',
      '__Host-kinloom_session',
      'clara-private-scan.png',
      'Private Clara Document',
      'attacker.evil.example.test',
    ]) {
      expect(serializedAll).not.toContain(sensitive);
    }

    // Verify sanitizeMediaContentType strips parameters and rejects injected secrets.
    expect(sanitizeMediaContentType('IMAGE/PNG; charset=utf-8')).toBe('image/png');
    expect(sanitizeMediaContentType('evil@example.test; Bearer kin_secret')).toBe('unknown');
    expect(sanitizeMediaContentType('')).toBe('unknown');
  });

  it('supports default console sink, alertOn allowlist filtering, onAlert alias, and 5xx error level on unconfigured OAuth', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const clock = ports.clock;
    const filteredAlerts: SecurityTelemetryLogRecord[] = [];

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const server = createKinloomServer({
        siteConfig,
        ports: {
          ...(({ authProvider: _ap, ...rest }) => rest)(ports),
          plugins: [
            createWorkersObservabilityPlugin({
              clock,
              securityTelemetry: {
                enabled: true,
                alertOn: ['csrf.rejected'],
                onAlert: (record) => {
                  filteredAlerts.push(record);
                },
              },
            }),
          ],
        },
        sessionSecret: SECRET,
      });

      // 503 OAuth provider unconfigured -> emits level: 'error' through console.error, NOT sent to filtered alertOn.
      const oauth503Res = await server.fetch(new Request(`${ORIGIN}/api/auth/google/start`));
      expect(oauth503Res.status).toBe(503);

      // 403 CSRF rejected -> emits level: 'warn' through console.warn AND triggers filtered onAlert.
      const csrfRes = await server.fetch(
        new Request(`${ORIGIN}/api/auth/logout`, {
          method: 'POST',
          headers: { origin: 'https://cross-site.example.test' },
        })
      );
      expect(csrfRes.status).toBe(403);

      const securityErrorLines = errorSpy.mock.calls
        .map((args) => JSON.parse(String(args[0])) as { event: string; event_type?: string; level?: string })
        .filter((rec) => rec.event === 'security_event');
      const securityWarnLines = warnSpy.mock.calls
        .map((args) => JSON.parse(String(args[0])) as { event: string; event_type?: string; level?: string })
        .filter((rec) => rec.event === 'security_event');

      expect(securityErrorLines).toHaveLength(1);
      expect(securityErrorLines[0]).toMatchObject({
        event: 'security_event',
        event_type: 'auth.oauth.failed',
        level: 'error',
        reason: 'provider_unconfigured',
        status: 503,
      });
      expect(securityWarnLines).toHaveLength(1);
      expect(securityWarnLines[0]).toMatchObject({
        event: 'security_event',
        event_type: 'csrf.rejected',
        level: 'warn',
        status: 403,
      });
      expect(filteredAlerts).toHaveLength(1);
      expect(filteredAlerts[0]?.event_type).toBe('csrf.rejected');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('fault-isolates sync throws and async rejections from onSecurityEvent, sink, and alertSink without delaying responses', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-06-15T12:00:00.000Z' });
    const clock = ports.clock;
    const reportedErrors: Array<{ pluginId: string; message: string }> = [];
    const waitUntilPromises: Promise<unknown>[] = [];
    const deferredAlert: { release?: () => void } = {};
    let slowAlertFinished = false;

    const faultyCustomSecurityPlugin: KinloomServerPlugin = {
      id: 'faulty-custom-security',
      name: 'Faulty Custom Security',
      async onSecurityEvent() {
        throw new Error('custom onSecurityEvent async boom');
      },
    };

    const syncThrowingAlertPlugin = createWorkersObservabilityPlugin({
      clock,
      sink: () => undefined,
      securityTelemetry: {
        enabled: true,
        sink: () => {
          throw new Error('security sink sync boom');
        },
        alertSink: () => {
          throw new Error('alert sink sync boom');
        },
      },
    });

    const serverSync = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [faultyCustomSecurityPlugin, syncThrowingAlertPlugin],
      },
      sessionSecret: SECRET,
      onPluginError: (pluginId, error) => {
        reportedErrors.push({
          pluginId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });

    const deniedRes = await serverSync.fetch(
      new Request(`${ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: { origin: 'https://evil.example.test' },
      })
    );
    expect(deniedRes.status).toBe(403);
    const deniedBody = (await deniedRes.json()) as { error: { code: string } };
    expect(deniedBody.error.code).toBe('CSRF_ORIGIN_MISMATCH');
    expect(reportedErrors).toEqual([
      { pluginId: 'faulty-custom-security', message: 'custom onSecurityEvent async boom' },
      { pluginId: WORKERS_OBSERVABILITY_PLUGIN_ID, message: 'security sink sync boom' },
      { pluginId: WORKERS_OBSERVABILITY_PLUGIN_ID, message: 'alert sink sync boom' },
    ]);

    // Async rejecting alertSink passed to waitUntil does not delay HTTP response and reports error cleanly.
    const asyncReported: Array<{ pluginId: string; message: string }> = [];
    const serverAsync = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [
          createWorkersObservabilityPlugin({
            clock,
            sink: () => undefined,
            securityTelemetry: {
              enabled: true,
              sink: () => undefined,
              alertSink: async () => {
                await new Promise<void>((resolve) => {
                  deferredAlert.release = resolve;
                });
                slowAlertFinished = true;
                throw new Error('async webhook failure');
              },
            },
          }),
        ],
      },
      sessionSecret: SECRET,
      onPluginError: (pluginId, error) => {
        asyncReported.push({
          pluginId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });

    const asyncDeniedRes = await serverAsync.fetch(
      new Request(`${ORIGIN}/api/bundle`, {
        headers: { authorization: 'Bearer kin_bad_token_async_test' },
      }),
      {
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      }
    );
    expect(asyncDeniedRes.status).toBe(401);
    const asyncDeniedBody = (await asyncDeniedRes.json()) as { error: { code: string } };
    expect(asyncDeniedBody.error.code).toBe('UNAUTHORIZED');
    // HTTP response returned BEFORE the slow webhook settled.
    expect(slowAlertFinished).toBe(false);
    expect(waitUntilPromises).toHaveLength(1);

    deferredAlert.release?.();
    await Promise.all(waitUntilPromises);
    expect(slowAlertFinished).toBe(true);
    expect(asyncReported).toEqual([
      { pluginId: WORKERS_OBSERVABILITY_PLUGIN_ID, message: 'async webhook failure' },
    ]);
  });
});
