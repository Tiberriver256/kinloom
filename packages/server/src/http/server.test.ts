import { describe, expect, it } from 'vitest';
import type {
  ArchiveBundle,
  KinloomServerPlugin,
  MediaStore,
  RawPerson,
  RevisionRecord,
  TalkComment,
  UserRecord,
} from '@kinloom/core';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import { createKinloomServer } from './router.js';
import { signSessionToken } from './session.js';
import {
  createSyntheticEvent,
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';

const ORIGIN = 'https://alder.example.test';
const SECRET = 'kinloom-e2e-http-server-secret-2026-abcdef123456';

function getSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

function extractCookiePair(res: Response, namePrefix: string): string {
  const match = getSetCookies(res)
    .map((c) => c.split(';')[0]?.trim() ?? '')
    .find((pair) => pair.startsWith(`${namePrefix}=`) && pair !== `${namePrefix}=`);
  return match ?? '';
}

async function createSessionCookie(
  ports: ReturnType<typeof createInMemoryServerPorts>,
  user: { email: string; display_name: string; role: 'admin' | 'editor' },
  cookieName = '__Host-kinloom_session'
): Promise<string> {
  await ports.repository.upsertUser({
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    added_by: 'seed',
    added_at: ports.clock.nowIso(),
    last_login_at: ports.clock.nowIso(),
  });
  const token = await signSessionToken({
    secret: SECRET,
    clock: ports.clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email: user.email,
      display_name: user.display_name,
      role: user.role,
    },
  });
  return `${cookieName}=${token}`;
}

describe('createKinloomServer end-to-end HTTP transport', () => {
  it('covers auth lifecycle, bootstrap admin, invite revocation, anti-enumeration, logout, and CSRF protection', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: SECRET,
      bootstrapAdminEmail: 'founder@example.test',
    });

    // 1. GET /api/auth/me anonymous
    const anonMeRes = await server.fetch(new Request(`${ORIGIN}/api/auth/me`));
    expect(anonMeRes.status).toBe(200);
    const anonMe = (await anonMeRes.json()) as {
      session: { authenticated: boolean; principal_kind: string };
      capabilities: { canEdit: boolean; canManageSite: boolean };
    };
    expect(anonMe.session.authenticated).toBe(false);
    expect(anonMe.session.principal_kind).toBe('anonymous');
    expect(anonMe.capabilities.canEdit).toBe(false);

    // 2. Bootstrap admin sign-in via Google OAuth PKCE
    const startRes = await server.fetch(new Request(`${ORIGIN}/api/auth/google/start?next=/admin`));
    expect(startRes.status).toBe(302);
    const oauthCookie = extractCookiePair(startRes, '__Host-kinloom_oauth');
    const state = new URL(startRes.headers.get('location') ?? '').searchParams.get('state') ?? '';

    ports.authProvider.registerCode('code_founder', {
      email: 'founder@example.test',
      displayName: 'Archive Founder',
      emailVerified: true,
    });

    const cbRes = await server.fetch(
      new Request(
        `${ORIGIN}/api/auth/google/callback?code=code_founder&state=${encodeURIComponent(state)}`,
        { headers: { cookie: oauthCookie } }
      )
    );
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get('location')).toBe('/admin');
    const adminCookie = extractCookiePair(cbRes, '__Host-kinloom_session');
    expect(adminCookie).toContain('__Host-kinloom_session=');

    const founderMeRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie: adminCookie } })
    );
    const founderMe = (await founderMeRes.json()) as {
      session: { role?: string };
      capabilities: { canManageSite: boolean };
    };
    expect(founderMe.session.role).toBe('admin');
    expect(founderMe.capabilities.canManageSite).toBe(true);

    // 3. Anti-enumeration: unknown email without invite returns 202 { sent: true } without sending email
    const unknownMagicRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'stranger@example.test' }),
      })
    );
    expect(unknownMagicRes.status).toBe(202);
    expect(await unknownMagicRes.json()).toEqual({ sent: true });
    expect(ports.emailSender.sentMessages).toHaveLength(0);

    // 4. Mid-flight invite revocation: start OAuth with invite, revoke invite before callback -> 403 INVITE_REQUIRED
    const invCreateRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ label: 'Short-lived invite' }),
      })
    );
    const createdInvite = (await invCreateRes.json()) as {
      invite: { token: string };
      invite_url: string;
    };
    const redeemRes = await server.fetch(new Request(createdInvite.invite_url));
    const viewerCookie = extractCookiePair(redeemRes, '__Host-kinloom_session');

    const invStartRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/start`, { headers: { cookie: viewerCookie } })
    );
    const invOAuthCookie = extractCookiePair(invStartRes, '__Host-kinloom_oauth');
    const invState =
      new URL(invStartRes.headers.get('location') ?? '').searchParams.get('state') ?? '';

    // Admin lists invites and revokes invite while OAuth is in flight
    const listInvitesRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/invites`, { headers: { cookie: adminCookie } })
    );
    expect(listInvitesRes.status).toBe(200);
    expect(((await listInvitesRes.json()) as { invites: unknown[] }).invites).toHaveLength(1);

    const revokeRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/invites/${createdInvite.invite.token}`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: adminCookie },
      })
    );
    expect(revokeRes.status).toBe(204);

    ports.authProvider.registerCode('code_revoked_user', {
      email: 'late.guest@example.test',
      displayName: 'Late Guest',
      emailVerified: true,
    });
    const invCbRes = await server.fetch(
      new Request(
        `${ORIGIN}/api/auth/google/callback?code=code_revoked_user&state=${encodeURIComponent(invState)}`,
        { headers: { cookie: invOAuthCookie } }
      )
    );
    expect(invCbRes.status).toBe(403);
    const invCbErr = (await invCbRes.json()) as { error: { code: string } };
    expect(invCbErr.error.code).toBe('INVITE_REQUIRED');

    // 5. CSRF Origin mismatch rejected with 403 on cookie-authenticated POST /api/auth/logout and writes
    const badCsrfLogout = await server.fetch(
      new Request(`${ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: { origin: 'https://evil.example.test', cookie: adminCookie },
      })
    );
    expect(badCsrfLogout.status).toBe(403);
    expect(((await badCsrfLogout.json()) as { error: { code: string } }).error.code).toBe(
      'CSRF_ORIGIN_MISMATCH'
    );

    const goodLogout = await server.fetch(
      new Request(`${ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: adminCookie },
      })
    );
    expect(goodLogout.status).toBe(204);
    expect(getSetCookies(goodLogout)[0]).toContain('Max-Age=0');

    // 6. Local HTTP dev fallback uses non-__Host kinloom_session cookie
    const localRedeemInv = await server.fetch(
      new Request(`${ORIGIN}/api/admin/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ label: 'Local dev invite' }),
      })
    );
    const localInv = (await localRedeemInv.json()) as { invite: { token: string } };
    const localRes = await server.fetch(
      new Request(`http://localhost:8787/api/auth/invite/${localInv.invite.token}`)
    );
    expect(localRes.status).toBe(302);
    expect(getSetCookies(localRes)[0]).toContain('kinloom_session=');
    expect(getSetCookies(localRes)[0]).not.toContain('__Host-');
  });

  it('returns 409 Conflict with OptimisticConflictError diff, supports single-revision revert, Talk CRUD, and Admin user last-admin protection', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: SECRET,
    });

    const adminCookie = await createSessionCookie(ports, {
      email: 'admin@example.test',
      display_name: 'Archive Admin',
      role: 'admin',
    });
    const editorCookie = await createSessionCookie(ports, {
      email: 'editor@example.test',
      display_name: 'Family Editor',
      role: 'editor',
    });
    const otherEditorCookie = await createSessionCookie(ports, {
      email: 'cousin@example.test',
      display_name: 'Cousin Editor',
      role: 'editor',
    });

    // Create person
    const person = createSyntheticHistoricalPerson();
    const createRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_id: person.id,
          data: person,
          summary: 'Create Arthur Alder',
          has_primary_source: true,
        }),
      })
    );
    expect(createRes.status).toBe(201);

    // GET /api/entities/:type/:id
    const getRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${person.id}`, {
        headers: { cookie: editorCookie },
      })
    );
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as {
      entity: RawPerson;
      current_revision_id: number;
    };
    expect(fetched.current_revision_id).toBe(1);
    expect(fetched.entity.full_name).toBe('Arthur Alder');

    // Editor 1 updates to rev 2
    const update1Res = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${person.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          expected_parent_revision_id: 1,
          data: { ...person, full_name: 'Arthur J. Alder' },
          summary: 'Add initial J',
          has_primary_source: true,
        }),
      })
    );
    expect(update1Res.status).toBe(200);

    // Editor 2 attempts stale update with expected_parent_revision_id = 1 -> 409 Conflict with diff
    const conflictRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${person.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: otherEditorCookie },
        body: JSON.stringify({
          expected_parent_revision_id: 1,
          data: { ...person, full_name: 'Arthur James Alder' },
          summary: 'Add full middle name',
          has_primary_source: true,
        }),
      })
    );
    expect(conflictRes.status).toBe(409);
    const conflictBody = (await conflictRes.json()) as {
      error: {
        code: string;
        details: {
          server_revision_id: number;
          last_author_name: string;
          diff: { hasChanges: boolean; fields: Array<{ path: string }> };
        };
      };
    };
    expect(conflictBody.error.code).toBe('OPTIMISTIC_CONFLICT');
    expect(conflictBody.error.details.server_revision_id).toBe(2);
    expect(conflictBody.error.details.last_author_name).toBe('Family Editor');
    expect(conflictBody.error.details.diff.hasChanges).toBe(true);
    expect(conflictBody.error.details.diff.fields.some((f) => f.path === 'full_name')).toBe(true);

    // Single revision revert: POST /api/revisions/2/revert restores 'Arthur Alder'
    const revertRes = await server.fetch(
      new Request(`${ORIGIN}/api/revisions/2/revert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({ summary: 'Revert middle initial pending citation' }),
      })
    );
    expect(revertRes.status).toBe(201);
    const reverted = (await revertRes.json()) as { revision: RevisionRecord; etag: string };
    expect(reverted.revision.action).toBe('revert');
    expect(reverted.revision.reverted_revision_id).toBe(2);
    expect(reverted.etag).toBe('"r3"');

    // Talk comments: post, list, forbid other editor delete, allow author/admin delete
    const talkPostRes = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${person.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({ body_md: 'Check 1880 census page 14 for middle name.' }),
      })
    );
    expect(talkPostRes.status).toBe(201);
    const postedTalk = (await talkPostRes.json()) as { comment: TalkComment };
    expect(postedTalk.comment.comment_id).toBe(1);

    const talkListRes = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${person.id}`, { headers: { cookie: editorCookie } })
    );
    expect(talkListRes.status).toBe(200);
    expect(((await talkListRes.json()) as { comments: TalkComment[] }).comments).toHaveLength(1);

    // Another non-admin editor cannot delete someone else's comment
    const forbiddenDelTalk = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${person.id}/1`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: otherEditorCookie },
      })
    );
    expect(forbiddenDelTalk.status).toBe(403);

    // Author deletes own comment
    const okDelTalk = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${person.id}/1`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: editorCookie },
      })
    );
    expect(okDelTalk.status).toBe(204);

    // Admin Users CRUD + LAST_ADMIN_PROTECTED
    const listUsersRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users`, { headers: { cookie: adminCookie } })
    );
    expect(listUsersRes.status).toBe(200);
    expect(((await listUsersRes.json()) as { users: UserRecord[] }).users).toHaveLength(3);

    // Cannot demote or delete the last remaining admin
    const demoteLastAdmin = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users/admin%40example.test`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ role: 'editor' }),
      })
    );
    expect(demoteLastAdmin.status).toBe(409);
    expect(((await demoteLastAdmin.json()) as { error: { code: string } }).error.code).toBe(
      'LAST_ADMIN_PROTECTED'
    );

    const deleteLastAdmin = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users/admin%40example.test`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: adminCookie },
      })
    );
    expect(deleteLastAdmin.status).toBe(409);
    expect(((await deleteLastAdmin.json()) as { error: { code: string } }).error.code).toBe(
      'LAST_ADMIN_PROTECTED'
    );

    // Admin adds a second user, updates role, and deletes them
    const createUserRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          email: 'helper@example.test',
          display_name: 'Archive Helper',
          role: 'editor',
        }),
      })
    );
    expect(createUserRes.status).toBe(201);

    const promoteRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users/helper%40example.test`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ role: 'admin', display_name: 'Co-Admin Helper' }),
      })
    );
    expect(promoteRes.status).toBe(200);
    expect(((await promoteRes.json()) as { user: UserRecord }).user.role).toBe('admin');

    const delUserRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users/helper%40example.test`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: adminCookie },
      })
    );
    expect(delUserRes.status).toBe(204);

    // Admin agent token list & revoke
    const createTokRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/agent-tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ label: 'Nightly Export', scope: 'read_backup' }),
      })
    );
    const createdTok = (await createTokRes.json()) as { token_id: string; plaintext_secret: string };

    const listTokRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/agent-tokens`, { headers: { cookie: adminCookie } })
    );
    expect(listTokRes.status).toBe(200);
    const listedTokens = (await listTokRes.json()) as {
      tokens: Array<Record<string, unknown>>;
    };
    expect(listedTokens.tokens).toHaveLength(1);
    expect('token_hash' in listedTokens.tokens[0]).toBe(false);

    // Export snapshot + 304 Not Modified with read_backup token
    const snapRes = await server.fetch(
      new Request(`${ORIGIN}/api/export/snapshot`, {
        headers: { authorization: `Bearer ${createdTok.plaintext_secret}` },
      })
    );
    expect(snapRes.status).toBe(200);
    const snapEtag = snapRes.headers.get('etag') ?? '';
    expect(snapEtag).toBe('"r3"');

    const snap304Res = await server.fetch(
      new Request(`${ORIGIN}/api/export/snapshot`, {
        headers: {
          authorization: `Bearer ${createdTok.plaintext_secret}`,
          'if-none-match': snapEtag,
        },
      })
    );
    expect(snap304Res.status).toBe(304);

    // Revoke agent token -> Bearer auth immediately stops working (401)
    const revTokRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/agent-tokens/${createdTok.token_id}`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: adminCookie },
      })
    );
    expect(revTokRes.status).toBe(204);

    const revokedSnapRes = await server.fetch(
      new Request(`${ORIGIN}/api/export/snapshot`, {
        headers: { authorization: `Bearer ${createdTok.plaintext_secret}` },
      })
    );
    expect(revokedSnapRes.status).toBe(401);
  });

  it('catches mid-upload living-person status change at attach time with 422 LIVING_MEDIA_FORBIDDEN', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const basePorts = createInMemoryServerPorts(siteConfig);

    // Wrap MediaStore.put so another editor marks target person living while blob upload is in flight!
    const targetPerson = createSyntheticHistoricalPerson({
      id: 'per_race_target',
      slug: 'race-target',
      is_living: false,
      birth_edtf: '1920',
      death_edtf: '1999',
    });

    let flippedMidUpload = false;
    const racingMediaStore: MediaStore = {
      head: (key) => basePorts.mediaStore.head(key),
      get: (key, opts) => basePorts.mediaStore.get(key, opts),
      async put(params) {
        await basePorts.mediaStore.put(params);
        if (!flippedMidUpload) {
          flippedMidUpload = true;
          const current = await basePorts.repository.getEntity('person', targetPerson.id);
          if (current && !('edge' in current)) {
            await basePorts.repository.commitAtomicMutations({
              batch_id: null,
              author: { author_id: 'other@example.test', author_name: 'Other Editor', author_type: 'human' },
              nowIso: basePorts.clock.nowIso(),
              operations: [
                {
                  entity_type: 'person',
                  entity_id: targetPerson.id,
                  action: 'update',
                  expected_parent_revision_id: current.current_revision_id,
                  summary: 'Correct status to living',
                  has_primary_source: true,
                  before_json: current.data,
                  after_json: { ...current.data, is_living: true, death_edtf: '' },
                },
              ],
            });
          }
        }
      },
    };

    const server = createKinloomServer({
      siteConfig,
      ports: { ...basePorts, mediaStore: racingMediaStore },
      sessionSecret: SECRET,
    });

    const editorCookie = await createSessionCookie(basePorts, {
      email: 'editor@example.test',
      display_name: 'Editor',
      role: 'editor',
    });

    await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_id: targetPerson.id,
          data: targetPerson,
          summary: 'Create person initially deceased',
          has_primary_source: true,
        }),
      })
    );

    const form = new FormData();
    form.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'portrait.png', { type: 'image/png' }));
    form.append(
      'metadata',
      JSON.stringify({
        id: 'med_race_portrait',
        kind: 'portrait',
        person_ids: [targetPerson.id],
        caption: 'Portrait caught by mid-upload race check',
      })
    );
    form.append('summary', 'Upload portrait during living flip race');

    const uploadRes = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: editorCookie },
        body: form,
      })
    );

    expect(flippedMidUpload).toBe(true);
    expect(uploadRes.status).toBe(422);
    expect(((await uploadRes.json()) as { error: { code: string } }).error.code).toBe(
      'LIVING_MEDIA_FORBIDDEN'
    );
    expect(await basePorts.repository.getEntity('media', 'med_race_portrait')).toBeNull();
  });

  it('mounts KinloomServerPlugin routes behind auth/CSRF, isolates failing onRevisionCommitted hooks, and delegates unmatched GET to assetHandler', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const committedEvents: Array<{ head: number; count: number }> = [];
    const pluginErrors: string[] = [];

    const healthyPlugin: KinloomServerPlugin = {
      id: 'synthetic-video-stories',
      name: 'Synthetic Video Stories',
      routes: [
        {
          method: 'GET',
          pathPrefix: '/api/plugins/stories',
          minRole: 'viewer',
          async handle(ctx) {
            return new Response(
              JSON.stringify({
                family: ctx.siteConfig.site.familyName,
                principal: ctx.principal.kind,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          },
        },
        {
          method: 'POST',
          pathPrefix: '/api/plugins/stories/bookmark',
          minRole: 'editor',
          async handle() {
            return new Response(JSON.stringify({ bookmarked: true }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          },
        },
      ],
      async onRevisionCommitted(event) {
        committedEvents.push({ head: event.headRevisionId, count: event.revisions.length });
      },
    };

    const failingPlugin: KinloomServerPlugin = {
      id: 'flaky-webhook',
      name: 'Flaky Webhook',
      async onRevisionCommitted() {
        throw new Error('Simulated webhook timeout');
      },
    };

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [failingPlugin, healthyPlugin],
        assetHandler: {
          async fetch(req) {
            return new Response(`SPA:${new URL(req.url).pathname}`, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          },
        },
      },
      sessionSecret: SECRET,
      onPluginError(pluginId) {
        pluginErrors.push(pluginId);
      },
    });

    // Unauthenticated plugin route blocked with 401
    const unauthPluginRes = await server.fetch(new Request(`${ORIGIN}/api/plugins/stories`));
    expect(unauthPluginRes.status).toBe(401);

    const editorCookie = await createSessionCookie(ports, {
      email: 'editor@example.test',
      display_name: 'Editor',
      role: 'editor',
    });

    // Authenticated viewer/editor plugin GET succeeds
    const okPluginRes = await server.fetch(
      new Request(`${ORIGIN}/api/plugins/stories`, { headers: { cookie: editorCookie } })
    );
    expect(okPluginRes.status).toBe(200);
    expect(await okPluginRes.json()).toEqual({ family: 'Alder', principal: 'user' });

    // Plugin POST enforces CSRF Origin check
    const badCsrfPlugin = await server.fetch(
      new Request(`${ORIGIN}/api/plugins/stories/bookmark`, {
        method: 'POST',
        headers: { origin: 'https://evil.example.test', cookie: editorCookie },
      })
    );
    expect(badCsrfPlugin.status).toBe(403);

    // Committing an entity runs BOTH hooks; failingPlugin error is isolated and healthyPlugin still receives event
    const person = createSyntheticHistoricalPerson();
    const createRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_id: person.id,
          data: person,
          summary: 'Create person triggering plugin hooks',
          has_primary_source: true,
        }),
      })
    );
    expect(createRes.status).toBe(201);
    expect(pluginErrors).toEqual(['flaky-webhook']);
    expect(committedEvents).toEqual([{ head: 1, count: 1 }]);

    // Unmatched non-API GET delegates to assetHandler; unmatched /api/ GET returns JSON 404
    const spaRes = await server.fetch(new Request(`${ORIGIN}/people/arthur-alder`));
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toBe('SPA:/people/arthur-alder');

    const missingApiRes = await server.fetch(new Request(`${ORIGIN}/api/does-not-exist`));
    expect(missingApiRes.status).toBe(404);
  });

  it('rejects unsupported MIME types (415), oversized uploads (413), and redacts living data in bundle and YAML export', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: SECRET,
    });

    const adminCookie = await createSessionCookie(ports, {
      email: 'admin@example.test',
      display_name: 'Admin',
      role: 'admin',
    });

    // 415 Unsupported Media Type
    const badMimeForm = new FormData();
    badMimeForm.append('file', new File(['<svg></svg>'], 'bad.svg', { type: 'image/svg+xml' }));
    badMimeForm.append('metadata', JSON.stringify({ kind: 'portrait', caption: 'Bad SVG' }));
    badMimeForm.append('summary', 'Upload disallowed SVG');
    const badMimeRes = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: adminCookie },
        body: badMimeForm,
      })
    );
    expect(badMimeRes.status).toBe(415);

    // 413 Payload Too Large (> 15 MiB image)
    const oversizedBytes = new Uint8Array(15 * 1024 * 1024 + 10);
    const bigForm = new FormData();
    bigForm.append('file', new File([oversizedBytes], 'huge.jpg', { type: 'image/jpeg' }));
    bigForm.append('metadata', JSON.stringify({ kind: 'family_photo', caption: 'Huge scan' }));
    bigForm.append('summary', 'Upload oversized scan');
    const bigRes = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: adminCookie },
        body: bigForm,
      })
    );
    expect(bigRes.status).toBe(413);

    // Living person + living event stay redacted in GET /api/bundle and GET /api/export/yaml
    const living = createSyntheticLivingPerson();
    await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_id: living.id,
          data: living,
          summary: 'Add living person',
          has_primary_source: false,
        }),
      })
    );
    const livingEv = createSyntheticEvent({
      id: 'evt_living_home',
      participants: [{ person_id: living.id, role: 'principal' }],
      edtf_date: '2019-07-04',
      summary: 'Exact address 742 Evergreen Terrace',
    });
    await server.fetch(
      new Request(`${ORIGIN}/api/entities/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_id: livingEv.id,
          data: livingEv,
          summary: 'Add living event',
          has_primary_source: false,
        }),
      })
    );

    const bundleRes = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } })
    );
    expect(bundleRes.status).toBe(200);
    const bundle = (await bundleRes.json()) as ArchiveBundle;
    const bundleClara = bundle.people.find((p) => p.id === living.id);
    expect(bundleClara?.birth_edtf).toBe('1988');
    expect(bundleClara?.portrait_url).toBeNull();

    const yamlRes = await server.fetch(
      new Request(`${ORIGIN}/api/export/yaml`, { headers: { cookie: adminCookie } })
    );
    expect(yamlRes.status).toBe(200);
    const yamlEtag = yamlRes.headers.get('etag') ?? '';
    expect(yamlEtag).toBe('"r2"');
    const yamlExport = (await yamlRes.json()) as { files: Record<string, string> };
    expect(yamlExport.files['people.yaml']).not.toContain('1988-09-19');
    expect(yamlExport.files['people.yaml']).not.toContain('should-be-stripped.jpg');
    expect(yamlExport.files['events.yaml']).not.toContain('742 Evergreen');

    const yaml304Res = await server.fetch(
      new Request(`${ORIGIN}/api/export/yaml`, {
        headers: { cookie: adminCookie, 'if-none-match': yamlEtag },
      })
    );
    expect(yaml304Res.status).toBe(304);
  });

  it('redirects browser navigations cleanly on all auth/invite unhappy paths while preserving JSON errors for API callers', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: SECRET,
      bootstrapAdminEmail: 'founder@example.test',
    });

    const browserHtmlHeaders = { accept: 'text/html,application/xhtml+xml' };
    const browserNavHeaders = { 'sec-fetch-mode': 'navigate' };

    const adminCookie = await createSessionCookie(ports, {
      email: 'founder@example.test',
      display_name: 'Archive Founder',
      role: 'admin',
    });

    // 1. select_account=1 and prompt=select_account pass prompt=select_account to Google authorization URL
    const selectRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/start?select_account=1&next=%2Fpeople%3Fauth_error%3DOLD`)
    );
    expect(selectRes.status).toBe(302);
    const selectLocation = new URL(selectRes.headers.get('location') ?? '');
    expect(selectLocation.searchParams.get('prompt')).toBe('select_account');
    expect(ports.authProvider.lastAuthorizationParams?.prompt).toBe('select_account');

    const promptRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/start?prompt=select_account&next=//evil.example.test`)
    );
    expect(promptRes.status).toBe(302);
    expect(ports.authProvider.lastAuthorizationParams?.prompt).toBe('select_account');

    // 2. Unconfigured Google OAuth -> browser 302 redirect, API 503 JSON
    const unconfiguredServer = createKinloomServer({
      siteConfig,
      ports: { ...ports, authProvider: undefined },
      sessionSecret: SECRET,
    });
    const unconfBrowserRes = await unconfiguredServer.fetch(
      new Request(`${ORIGIN}/api/auth/google/start?next=%2Fplaces`, { headers: browserHtmlHeaders })
    );
    expect(unconfBrowserRes.status).toBe(302);
    expect(unconfBrowserRes.headers.get('location')).toBe(
      '/places?auth_error=AUTH_PROVIDER_UNCONFIGURED&auth_provider=google'
    );
    const unconfApiRes = await unconfiguredServer.fetch(
      new Request(`${ORIGIN}/api/auth/google/start?next=%2Fplaces`)
    );
    expect(unconfApiRes.status).toBe(503);
    expect(((await unconfApiRes.json()) as { error: { code: string } }).error.code).toBe(
      'AUTH_PROVIDER_UNCONFIGURED'
    );

    // 3. Google callback INVITE_REQUIRED (unenrolled Gmail) -> 302 redirect for browser, OAuth cookie cleared, zero email leakage
    const startForUnenrolled = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/start?next=%2Fperson%2Farthur%3Ftab%3Dlife%26auth_error%3DSTALE`)
    );
    const unenrolledOAuthCookie = extractCookiePair(startForUnenrolled, '__Host-kinloom_oauth');
    const unenrolledState =
      new URL(startForUnenrolled.headers.get('location') ?? '').searchParams.get('state') ?? '';
    ports.authProvider.registerCode('code_stranger_gmail', {
      email: 'stranger.person@example.test',
      displayName: 'Stranger Person',
      emailVerified: true,
    });

    const inviteReqBrowserRes = await server.fetch(
      new Request(
        `${ORIGIN}/api/auth/google/callback?code=code_stranger_gmail&state=${encodeURIComponent(unenrolledState)}`,
        { headers: { ...browserHtmlHeaders, cookie: unenrolledOAuthCookie } }
      )
    );
    expect(inviteReqBrowserRes.status).toBe(302);
    const inviteReqLocation = inviteReqBrowserRes.headers.get('location') ?? '';
    expect(inviteReqLocation).toBe(
      '/person/arthur?tab=life&auth_error=INVITE_REQUIRED&auth_provider=google'
    );
    expect(inviteReqLocation).not.toContain('stranger.person');
    expect(inviteReqLocation).not.toContain('STALE');
    expect(getSetCookies(inviteReqBrowserRes).some((c) => c.includes('__Host-kinloom_oauth=;') && c.includes('Max-Age=0'))).toBe(true);

    // Same INVITE_REQUIRED via API caller returns 403 JSON
    const inviteReqApiRes = await server.fetch(
      new Request(
        `${ORIGIN}/api/auth/google/callback?code=code_stranger_gmail&state=${encodeURIComponent(unenrolledState)}`,
        { headers: { cookie: unenrolledOAuthCookie } }
      )
    );
    expect(inviteReqApiRes.status).toBe(403);
    expect(((await inviteReqApiRes.json()) as { error: { code: string } }).error.code).toBe(
      'INVITE_REQUIRED'
    );

    // 4. Google callback error=access_denied (checked BEFORE !code) -> GOOGLE_CANCELLED + clears OAuth cookie + preserves next
    const cancelStart = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/start?next=%2Ftree`)
    );
    const cancelOAuthCookie = extractCookiePair(cancelStart, '__Host-kinloom_oauth');
    const cancelBrowserRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/callback?error=access_denied`, {
        headers: { ...browserNavHeaders, cookie: cancelOAuthCookie },
      })
    );
    expect(cancelBrowserRes.status).toBe(302);
    expect(cancelBrowserRes.headers.get('location')).toBe(
      '/tree?auth_error=GOOGLE_CANCELLED&auth_provider=google'
    );
    expect(getSetCookies(cancelBrowserRes).some((c) => c.includes('__Host-kinloom_oauth=;') && c.includes('Max-Age=0'))).toBe(true);

    const cancelApiRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/callback?error=access_denied`, {
        headers: { cookie: cancelOAuthCookie },
      })
    );
    expect(cancelApiRes.status).toBe(400);
    expect(((await cancelApiRes.json()) as { error: { code: string } }).error.code).toBe(
      'GOOGLE_CANCELLED'
    );

    // 5. Google callback other error=server_error -> GOOGLE_AUTH_FAILED
    const otherErrBrowserRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/callback?error=server_error`, {
        headers: { ...browserHtmlHeaders, cookie: cancelOAuthCookie },
      })
    );
    expect(otherErrBrowserRes.status).toBe(302);
    expect(otherErrBrowserRes.headers.get('location')).toBe(
      '/tree?auth_error=GOOGLE_AUTH_FAILED&auth_provider=google'
    );

    // 6. Missing / mismatched OAuth state -> INVALID_OAUTH_STATE + clears OAuth cookie
    const badStateBrowserRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/callback?code=abc&state=wrong_state`, {
        headers: { ...browserHtmlHeaders, cookie: cancelOAuthCookie },
      })
    );
    expect(badStateBrowserRes.status).toBe(302);
    expect(badStateBrowserRes.headers.get('location')).toBe(
      '/tree?auth_error=INVALID_OAUTH_STATE&auth_provider=google'
    );
    expect(getSetCookies(badStateBrowserRes).some((c) => c.includes('__Host-kinloom_oauth=;') && c.includes('Max-Age=0'))).toBe(true);

    // 7. Invite unhappy paths (expired, revoked, invalid) on both /invite/:token and /api/auth/invite/:token
    const expiredInvRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ label: 'Expiring invite', expires_in_days: 1 }),
      })
    );
    const expiredInvite = (await expiredInvRes.json()) as { invite: { token: string } };

    const revocableInvRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ label: 'Revoked invite' }),
      })
    );
    const revocableInvite = (await revocableInvRes.json()) as { invite: { token: string } };

    // Redeem revocable invite to get a viewer cookie, start Google OAuth, then revoke invite
    const redeemRevocable = await server.fetch(
      new Request(`${ORIGIN}/invite/${revocableInvite.invite.token}`)
    );
    const staleViewerCookie = extractCookiePair(redeemRevocable, '__Host-kinloom_session');
    const midFlightStart = await server.fetch(
      new Request(`${ORIGIN}/api/auth/google/start`, { headers: { cookie: staleViewerCookie } })
    );
    const midFlightOAuthCookie = extractCookiePair(midFlightStart, '__Host-kinloom_oauth');
    const midFlightState =
      new URL(midFlightStart.headers.get('location') ?? '').searchParams.get('state') ?? '';

    await server.fetch(
      new Request(`${ORIGIN}/api/admin/invites/${revocableInvite.invite.token}`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: adminCookie },
      })
    );

    // Mid-flight revoked invite during Google browser callback redirects with INVITE_REVOKED and clears stale cookies
    ports.authProvider.registerCode('code_midflight', {
      email: 'midflight@example.test',
      displayName: 'Mid Flight',
      emailVerified: true,
    });
    const midFlightCbRes = await server.fetch(
      new Request(
        `${ORIGIN}/api/auth/google/callback?code=code_midflight&state=${encodeURIComponent(midFlightState)}`,
        { headers: { ...browserHtmlHeaders, cookie: `${midFlightOAuthCookie}; ${staleViewerCookie}` } }
      )
    );
    expect(midFlightCbRes.status).toBe(302);
    expect(midFlightCbRes.headers.get('location')).toBe(
      '/?auth_error=INVITE_REVOKED&auth_provider=google'
    );
    const midFlightClearCookies = getSetCookies(midFlightCbRes);
    expect(midFlightClearCookies.some((c) => c.includes('__Host-kinloom_oauth=;') && c.includes('Max-Age=0'))).toBe(true);
    expect(midFlightClearCookies.some((c) => c.includes('__Host-kinloom_session=;') && c.includes('Max-Age=0'))).toBe(true);

    // Revoked invite on /invite/:token -> browser 302 INVITE_REVOKED, clears stale session cookie
    const revokedInviteBrowserRes = await server.fetch(
      new Request(`${ORIGIN}/invite/${revocableInvite.invite.token}`, {
        headers: { ...browserHtmlHeaders, cookie: staleViewerCookie },
      })
    );
    expect(revokedInviteBrowserRes.status).toBe(302);
    expect(revokedInviteBrowserRes.headers.get('location')).toBe(
      '/?auth_error=INVITE_REVOKED&auth_provider=invite'
    );
    expect(revokedInviteBrowserRes.headers.get('location')).not.toContain(revocableInvite.invite.token);
    expect(getSetCookies(revokedInviteBrowserRes).some((c) => c.includes('__Host-kinloom_session=;') && c.includes('Max-Age=0'))).toBe(true);

    // Unknown invite on /api/auth/invite/:token -> browser 302 INVITE_INVALID, API 404 JSON
    const unknownInviteBrowserRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/invite/does_not_exist_token`, { headers: browserNavHeaders })
    );
    expect(unknownInviteBrowserRes.status).toBe(302);
    expect(unknownInviteBrowserRes.headers.get('location')).toBe(
      '/?auth_error=INVITE_INVALID&auth_provider=invite'
    );
    const unknownInviteApiRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/invite/does_not_exist_token`)
    );
    expect(unknownInviteApiRes.status).toBe(404);
    expect(((await unknownInviteApiRes.json()) as { error: { code: string } }).error.code).toBe(
      'INVITE_INVALID_OR_REVOKED'
    );

    // Advance clock past 1 day -> expired invite on /invite/:token -> browser 302 INVITE_EXPIRED
    ports.clock.advanceMs(25 * 60 * 60 * 1000);
    const expiredInviteBrowserRes = await server.fetch(
      new Request(`${ORIGIN}/invite/${expiredInvite.invite.token}`, { headers: browserHtmlHeaders })
    );
    expect(expiredInviteBrowserRes.status).toBe(302);
    expect(expiredInviteBrowserRes.headers.get('location')).toBe(
      '/?auth_error=INVITE_EXPIRED&auth_provider=invite'
    );

    // 8. Magic-link verify unhappy paths: invalid, already-used, expired (browser 302 vs API 400 JSON)
    const freshMagicRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'founder@example.test', next: '/changes' }),
      })
    );
    expect(freshMagicRes.status).toBe(202);
    const usedLinkUrl = ports.emailSender.sentMessages[ports.emailSender.sentMessages.length - 1]!.magicLinkUrl;
    const firstVerify = await server.fetch(new Request(usedLinkUrl, { headers: browserHtmlHeaders }));
    expect(firstVerify.status).toBe(302);
    expect(firstVerify.headers.get('location')).toBe('/changes');

    // Second click in browser -> MAGIC_LINK_USED, zero token leaked
    const usedBrowserRes = await server.fetch(new Request(usedLinkUrl, { headers: browserHtmlHeaders }));
    expect(usedBrowserRes.status).toBe(302);
    const usedLocation = usedBrowserRes.headers.get('location') ?? '';
    expect(usedLocation).toBe('/changes?auth_error=MAGIC_LINK_USED&auth_provider=magic_link');
    expect(usedLocation).not.toContain('token=');

    // Second click as API caller -> 400 TOKEN_INVALID_OR_EXPIRED with details.token_status: 'used'
    const usedApiRes = await server.fetch(new Request(usedLinkUrl));
    expect(usedApiRes.status).toBe(400);
    expect(await usedApiRes.json()).toMatchObject({
      error: { code: 'TOKEN_INVALID_OR_EXPIRED', details: { token_status: 'used' } },
    });

    // Expired magic link -> MAGIC_LINK_EXPIRED for browser, 400 with token_status: 'expired' for API
    await server.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'founder@example.test', next: '/places' }),
      })
    );
    const expLinkUrl = ports.emailSender.sentMessages[ports.emailSender.sentMessages.length - 1]!.magicLinkUrl;
    ports.clock.advanceMs(16 * 60 * 1000);
    const expiredMagicBrowserRes = await server.fetch(
      new Request(expLinkUrl, { headers: browserNavHeaders })
    );
    expect(expiredMagicBrowserRes.status).toBe(302);
    expect(expiredMagicBrowserRes.headers.get('location')).toBe(
      '/places?auth_error=MAGIC_LINK_EXPIRED&auth_provider=magic_link'
    );
    const expiredMagicApiRes = await server.fetch(new Request(expLinkUrl));
    expect(expiredMagicApiRes.status).toBe(400);
    expect(await expiredMagicApiRes.json()).toMatchObject({
      error: { code: 'TOKEN_INVALID_OR_EXPIRED', details: { token_status: 'expired' } },
    });

    // Unknown / short magic link -> MAGIC_LINK_INVALID for browser, 400 with token_status: 'invalid' for API
    const invalidMagicBrowserRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/verify?token=unknown_token_12345678&next=//evil.test`, {
        headers: browserHtmlHeaders,
      })
    );
    expect(invalidMagicBrowserRes.status).toBe(302);
    expect(invalidMagicBrowserRes.headers.get('location')).toBe(
      '/?auth_error=MAGIC_LINK_INVALID&auth_provider=magic_link'
    );

    // 9. POST /api/auth/magic-link/request unhappy paths: validation error, rate limit, mail delivery error
    const badEmailRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'not-an-email' }),
      })
    );
    expect(badEmailRes.status).toBe(400);
    expect(((await badEmailRes.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR'
    );

    const failingMailServer = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        emailSender: {
          async sendMagicLink() {
            throw new Error('SMTP connection refused');
          },
        },
      },
      sessionSecret: SECRET,
      bootstrapAdminEmail: 'founder@example.test',
    });
    const mailFailRes = await failingMailServer.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'founder@example.test' }),
      })
    );
    expect(mailFailRes.status).toBe(502);
    expect(((await mailFailRes.json()) as { error: { code: string } }).error.code).toBe(
      'EMAIL_DELIVERY_FAILED'
    );

    // Exhaust rate limit window (10 attempts per hour)
    for (let i = 0; i < 10; i += 1) {
      await server.fetch(
        new Request(`${ORIGIN}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ email: 'ratelimit.guest@example.test' }),
        })
      );
    }
    const rateLimitedRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/magic-link/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'ratelimit.guest@example.test' }),
      })
    );
    expect(rateLimitedRes.status).toBe(429);
    expect(((await rateLimitedRes.json()) as { error: { code: string } }).error.code).toBe(
      'RATE_LIMITED'
    );
  });

  it('emits edge security headers, rejects non-__Host- cookies on HTTPS, and validates media magic bytes', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: SECRET,
      bootstrapAdminEmail: 'founder@example.test',
    });

    await ports.repository.upsertUser({
      email: 'admin@example.test',
      display_name: 'Admin',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: ports.clock.nowIso(),
      last_login_at: ports.clock.nowIso(),
    });
    const token = await signSessionToken({
      secret: SECRET,
      clock: ports.clock,
      ttlSeconds: 3600,
      payload: { kind: 'user', email: 'admin@example.test', display_name: 'Admin', role: 'admin' },
    });

    // 1. HTTPS request with dev cookie name (kinloom_session) MUST be ignored (no fallback)
    const httpsDevCookieRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/me`, {
        headers: { cookie: `kinloom_session=${token}` },
      })
    );
    expect(httpsDevCookieRes.status).toBe(200);
    const httpsDevMe = (await httpsDevCookieRes.json()) as {
      session: { authenticated: boolean; principal_kind: string };
    };
    expect(httpsDevMe.session.authenticated).toBe(false);
    expect(httpsDevMe.session.principal_kind).toBe('anonymous');

    // Security headers on HTTPS API response
    expect(httpsDevCookieRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(httpsDevCookieRes.headers.get('x-frame-options')).toBe('DENY');
    expect(httpsDevCookieRes.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(httpsDevCookieRes.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains'
    );
    expect(httpsDevCookieRes.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(httpsDevCookieRes.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    // HTTP localhost still accepts dev cookie and omits HSTS
    const httpDevCookieRes = await server.fetch(
      new Request('http://localhost:8787/api/auth/me', {
        headers: { cookie: `kinloom_session=${token}` },
      })
    );
    expect(httpDevCookieRes.status).toBe(200);
    expect(httpDevCookieRes.headers.get('strict-transport-security')).toBeNull();
    const httpDevMe = (await httpDevCookieRes.json()) as {
      session: { authenticated: boolean; email?: string };
    };
    expect(httpDevMe.session.authenticated).toBe(true);
    expect(httpDevMe.session.email).toBe('admin@example.test');

    // 2. Spoofed Content-Type uploads (HTML disguised as image/jpeg or PDF) rejected with 415 before writing to MediaStore
    const adminCookie = `__Host-kinloom_session=${token}`;
    const spoofedForm = new FormData();
    spoofedForm.append(
      'file',
      new File(['<html><script>alert(1)</script></html>'], 'evil.jpg', { type: 'image/jpeg' })
    );
    spoofedForm.append('metadata', JSON.stringify({ kind: 'document_scan', caption: 'Spoofed' }));
    spoofedForm.append('summary', 'Attempt spoofed JPEG upload');

    const spoofedRes = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: adminCookie },
        body: spoofedForm,
      })
    );
    expect(spoofedRes.status).toBe(415);
    expect(ports.mediaStore.putCount).toBe(0);

    // Valid JPEG upload succeeds and /media/:key serves sandboxed CSP + Content-Disposition: inline
    const validJpegForm = new FormData();
    validJpegForm.append(
      'file',
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], 'scan.jpg', {
        type: 'image/jpeg',
      })
    );
    validJpegForm.append('metadata', JSON.stringify({ kind: 'document_scan', caption: 'Real scan' }));
    validJpegForm.append('summary', 'Upload valid JPEG scan');

    const validUploadRes = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: adminCookie },
        body: validJpegForm,
      })
    );
    expect(validUploadRes.status).toBe(201);
    const { url: mediaUrl } = (await validUploadRes.json()) as { url: string };

    const mediaRes = await server.fetch(
      new Request(`${ORIGIN}${mediaUrl}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(mediaRes.headers.get('content-disposition')).toBe('inline');
    expect(mediaRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mediaRes.headers.get('x-frame-options')).toBe('DENY');
    expect(mediaRes.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains'
    );
  });
});
