import type { ArchiveBundle } from '@kinloom/core';
import { expect, it } from 'vitest';
import { createKinloomServer } from '../../http/router.js';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  cookiePairFromSetCookie,
  createSyntheticHistoricalPerson,
  extractSetCookies,
  seedAdminCookie,
  type WithContractHarness,
} from './harness.js';

export function registerAuthAndTokenContractTests(withHarness: WithContractHarness): void {
  it('auto-enrolls invited relatives strictly as editor and enforces single-use magic links', async () => {
    await withHarness(async ({ ports, server, advanceClockMs, getSentMagicLinks, registerOAuthCode }) => {
      const adminCookie = await seedAdminCookie(ports);

      const inviteCreateRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/invites`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({ label: 'Reunion invite', expires_in_days: 7 }),
        })
      );
      expect(inviteCreateRes.status).toBe(201);
      const createdInvite = (await inviteCreateRes.json()) as {
        invite: { token: string };
        invite_url: string;
      };

      const redeemRes = await server.fetch(new Request(createdInvite.invite_url));
      expect(redeemRes.status).toBe(302);
      const viewerCookie = cookiePairFromSetCookie(extractSetCookies(redeemRes)[0] ?? '');
      expect(viewerCookie).toContain('__Host-kinloom_session=');

      const bundleRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, { headers: { cookie: viewerCookie } })
      );
      expect(bundleRes.status).toBe(200);
      const etag = bundleRes.headers.get('etag');
      expect(etag).toMatch(/^"r0(-[a-f0-9]{8})?"$/);

      const notModifiedRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
          headers: { cookie: viewerCookie, 'if-none-match': etag ?? '' },
        })
      );
      expect(notModifiedRes.status).toBe(304);

      const startRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/google/start?next=/people`, {
          headers: { cookie: viewerCookie },
        })
      );
      expect(startRes.status).toBe(302);
      const oauthCookie = cookiePairFromSetCookie(extractSetCookies(startRes)[0] ?? '');
      const authUrl = new URL(startRes.headers.get('location') ?? '');
      const state = authUrl.searchParams.get('state') ?? '';

      registerOAuthCode('code_cousin_sam', {
        email: 'sam.alder@example.test',
        displayName: 'Sam Alder',
        emailVerified: true,
      });

      const cbRes = await server.fetch(
        new Request(
          `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback?code=code_cousin_sam&state=${encodeURIComponent(state)}`,
          { headers: { cookie: oauthCookie } }
        )
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('location')).toBe('/people');
      const samCookie =
        extractSetCookies(cbRes)
          .map(cookiePairFromSetCookie)
          .find((c) => c.startsWith('__Host-kinloom_session=') && c !== '__Host-kinloom_session=') ?? '';

      const meRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me`, { headers: { cookie: samCookie } })
      );
      const me = (await meRes.json()) as {
        session: { role?: string; email?: string };
        capabilities: { canEdit: boolean; canManageSite: boolean };
      };
      expect(me.session.email).toBe('sam.alder@example.test');
      expect(me.session.role).toBe('editor');
      expect(me.capabilities.canEdit).toBe(true);
      expect(me.capabilities.canManageSite).toBe(false);

      const magicReqRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: viewerCookie,
          },
          body: JSON.stringify({ email: 'nora.alder@example.test' }),
        })
      );
      expect(magicReqRes.status).toBe(202);
      const sent = getSentMagicLinks();
      const noraEmail = sent.find((m) => m.toEmail === 'nora.alder@example.test');
      expect(noraEmail).toBeDefined();
      if (!noraEmail) {
        return;
      }

      const verify1Res = await server.fetch(new Request(noraEmail.magicLinkUrl));
      expect(verify1Res.status).toBe(302);
      const noraUser = await ports.repository.getUser('nora.alder@example.test');
      expect(noraUser?.role).toBe('editor');

      const verify2Res = await server.fetch(new Request(noraEmail.magicLinkUrl));
      expect(verify2Res.status).toBe(400);
      const verify2Body = (await verify2Res.json()) as { error: { code: string } };
      expect(verify2Body.error.code).toBe('TOKEN_INVALID_OR_EXPIRED');

      await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: viewerCookie,
          },
          body: JSON.stringify({ email: 'eli.alder@example.test' }),
        })
      );
      const eliEmail = getSentMagicLinks().find((m) => m.toEmail === 'eli.alder@example.test');
      expect(eliEmail).toBeDefined();
      if (!eliEmail) {
        return;
      }
      advanceClockMs(16 * 60 * 1000);
      const expiredRes = await server.fetch(new Request(eliEmail.magicLinkUrl));
      expect(expiredRes.status).toBe(400);
    });
  });

  it('persists magic-link rate limiting in repository across separate server instances', async () => {
    await withHarness(async ({ siteConfig, ports, advanceClockMs }) => {
      const makeFreshServer = () =>
        createKinloomServer({
          siteConfig,
          ports,
          sessionSecret: CONTRACT_SESSION_SECRET,
          bootstrapAdminEmail: 'bootstrap-admin@example.test',
        });

      expect(
        await ports.repository.countRecentMagicLinks(
          'bootstrap-admin@example.test',
          '2026-06-15T11:15:00.000Z'
        )
      ).toBe(0);

      for (let i = 0; i < 10; i += 1) {
        const freshServer = makeFreshServer();
        const res = await freshServer.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: CONTRACT_TEST_ORIGIN,
            },
            body: JSON.stringify({ email: 'Bootstrap-Admin@example.test' }),
          })
        );
        expect(res.status).toBe(202);
      }

      expect(
        await ports.repository.countRecentMagicLinks(
          'BOOTSTRAP-ADMIN@example.test',
          new Date(ports.clock.now().getTime() - 45 * 60_000).toISOString()
        )
      ).toBe(10);

      const blockedRes = await makeFreshServer().fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
          },
          body: JSON.stringify({ email: 'bootstrap-admin@example.test' }),
        })
      );
      expect(blockedRes.status).toBe(429);
      const blockedBody = (await blockedRes.json()) as { error: { code: string } };
      expect(blockedBody.error.code).toBe('RATE_LIMITED');

      const otherRes = await makeFreshServer().fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
          },
          body: JSON.stringify({ email: 'other.relative@example.test' }),
        })
      );
      expect(otherRes.status).toBe(202);

      advanceClockMs(60 * 60 * 1000);
      const resetRes = await makeFreshServer().fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
          },
          body: JSON.stringify({ email: 'bootstrap-admin@example.test' }),
        })
      );
      expect(resetRes.status).toBe(202);
    });
  });

  it('enforces scoped agent tokens (write_batch vs read_backup)', async () => {
    await withHarness(async ({ ports, server }) => {
      const adminCookie = await seedAdminCookie(ports);

      const writeTokRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/agent-tokens`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({ label: 'Research Agent', scope: 'write_batch' }),
        })
      );
      expect(writeTokRes.status).toBe(201);
      const writeTok = (await writeTokRes.json()) as { plaintext_secret: string; token_id: string };

      const backupTokRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/agent-tokens`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({ label: 'GitHub Nightly Backup', scope: 'read_backup' }),
        })
      );
      expect(backupTokRes.status).toBe(201);
      const backupTok = (await backupTokRes.json()) as { plaintext_secret: string; token_id: string };

      const person = createSyntheticHistoricalPerson({ id: 'per_agent_01', slug: 'agent-person' });
      const batchRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${writeTok.plaintext_secret}`,
          },
          body: JSON.stringify({
            batch_id: 'batch_agent_01',
            summary: 'Agent cited insertion',
            has_primary_source: true,
            patches: [{ action: 'create', entity_type: 'person', entity_id: person.id, data: person }],
          }),
        })
      );
      expect(batchRes.status).toBe(201);

      const writeAdminRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/users`, {
          headers: { authorization: `Bearer ${writeTok.plaintext_secret}` },
        })
      );
      expect(writeAdminRes.status).toBe(403);

      const writeExportRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/export/yaml`, {
          headers: { authorization: `Bearer ${writeTok.plaintext_secret}` },
        })
      );
      expect(writeExportRes.status).toBe(403);

      const yamlRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/export/yaml`, {
          headers: { authorization: `Bearer ${backupTok.plaintext_secret}` },
        })
      );
      expect(yamlRes.status).toBe(200);
      expect(yamlRes.headers.get('x-kinloom-head-revision')).toBe('1');
      const yamlBody = (await yamlRes.json()) as { files: Record<string, string> };
      expect(yamlBody.files['people.yaml']).toContain('per_agent_01');

      const backupBundleRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
          headers: { authorization: `Bearer ${backupTok.plaintext_secret}` },
        })
      );
      expect(backupBundleRes.status).toBe(200);
      const bundleJson = (await backupBundleRes.json()) as ArchiveBundle;
      expect(bundleJson.people.map((p) => p.id)).toContain('per_agent_01');

      const backupWriteBatchRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${backupTok.plaintext_secret}`,
          },
          body: JSON.stringify({
            batch_id: 'batch_forbidden',
            summary: 'Backup token must not write',
            has_primary_source: true,
            patches: [{ action: 'create', entity_type: 'person', entity_id: 'per_nope', data: person }],
          }),
        })
      );
      expect(backupWriteBatchRes.status).toBe(403);

      const backupEntityWriteRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${backupTok.plaintext_secret}`,
          },
          body: JSON.stringify({
            data: person,
            summary: 'Backup token must not create entity',
            has_primary_source: true,
          }),
        })
      );
      expect(backupEntityWriteRes.status).toBe(403);
    });
  });
}
