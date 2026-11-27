import type { RawPerson } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { GoogleOAuthProvider } from '../adapters/googleOAuthProvider.js';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';
import { createKinloomServer } from './router.js';
import { signSessionToken } from './session.js';

const ORIGIN = CONTRACT_TEST_ORIGIN;

describe('Server GoogleOAuthProvider error handling, entity payload policy, and revision/export behavioral suite', () => {
  it('handles GoogleOAuthProvider authorization URLs, network failures, HTTP errors, and verified profiles', async () => {
    const provider = new GoogleOAuthProvider({
      clientId: 'cid-123',
      clientSecret: 'csec-456',
      fetchFn: async () => {
        throw new Error('network down');
      },
    });
    const authUrl = provider.buildAuthorizationUrl({
      state: 'st_1',
      codeChallenge: 'cc_1',
      redirectUri: `${ORIGIN}/api/auth/google/callback`,
    });
    expect(authUrl).toContain('client_id=cid-123');
    expect(authUrl).toContain('code_challenge=cc_1');

    await expect(
      provider.exchangeCode({ code: 'abc', codeVerifier: 'ver', redirectUri: `${ORIGIN}/cb` })
    ).rejects.toMatchObject({ status: 502, code: 'GOOGLE_AUTH_FAILED' });

    const provider400 = new GoogleOAuthProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: async () => new Response('bad code', { status: 400 }),
    });
    await expect(
      provider400.exchangeCode({ code: 'bad', codeVerifier: 'ver', redirectUri: `${ORIGIN}/cb` })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_OAUTH_STATE' });

    const provider500 = new GoogleOAuthProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: async () => new Response('upstream error', { status: 503 }),
    });
    await expect(
      provider500.exchangeCode({ code: 'bad', codeVerifier: 'ver', redirectUri: `${ORIGIN}/cb` })
    ).rejects.toMatchObject({ status: 502, code: 'GOOGLE_AUTH_FAILED' });

    let callCount = 0;
    const providerUserInfoErr = new GoogleOAuthProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({ access_token: 'tok_1' }), { status: 200 });
        }
        return new Response('userinfo fail', { status: 500 });
      },
    });
    await expect(
      providerUserInfoErr.exchangeCode({ code: 'ok', codeVerifier: 'ver', redirectUri: `${ORIGIN}/cb` })
    ).rejects.toMatchObject({ status: 502 });

    let okCount = 0;
    const providerOk = new GoogleOAuthProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: async () => {
        okCount += 1;
        if (okCount === 1) {
          return new Response(JSON.stringify({ access_token: 'tok_ok' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            email: 'editor@example.test',
            email_verified: true,
            name: 'Editor Alder',
          }),
          { status: 200 }
        );
      },
    });
    const profile = await providerOk.exchangeCode({
      code: 'ok',
      codeVerifier: 'ver',
      redirectUri: `${ORIGIN}/cb`,
    });
    expect(profile.email).toBe('editor@example.test');
    expect(profile.emailVerified).toBe(true);
  });

  it('exercises auto-generated IDs, source/media/event creation, ID mismatch 400, public bundle, revision lookup, and single revert', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    await ports.repository.upsertUser({
      email: 'admin@example.test',
      display_name: 'Admin Alder',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: ports.clock.nowIso(),
      last_login_at: ports.clock.nowIso(),
    });
    const server = createKinloomServer({
      siteConfig,
      sessionSecret: CONTRACT_SESSION_SECRET,
      ports,
    });
    const token = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock: ports.clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: 'admin@example.test',
        display_name: 'Admin Alder',
        role: 'admin',
      },
    });
    const cookie = `__Host-kinloom_session=${token}`;
    const headers = { cookie, origin: ORIGIN, 'content-type': 'application/json' };

    // 1. Create person without explicit entity_id -> auto-generated ID
    const personData: RawPerson = {
      ...createSyntheticHistoricalPerson({ id: 'per_auto_placeholder' }),
      id: '',
    };
    const createAuto = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          data: { ...personData, id: 'per_auto_1' },
          has_primary_source: true,
          summary: 'Create historical person',
        }),
      })
    );
    expect(createAuto.status).toBe(201);
    const createdAuto = (await createAuto.json()) as {
      entity: { entity_id: string; current_revision_id: number };
      revision: { revision_id: number; entity_id: string };
    };

    // 2. Create source entity
    const createSource = await server.fetch(
      new Request(`${ORIGIN}/api/entities/source`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          entity_id: 'src_tax_1890',
          data: {
            id: 'src_tax_1890',
            title: '1890 Ottawa County Tax Roll',
            citation: 'Ottawa County Tax Roll, 1890.',
            source_type: 'other',
          },
          has_primary_source: true,
          summary: 'Add tax roll source',
        }),
      })
    );
    expect(createSource.status).toBe(201);

    // 3. Reject mismatched entity_id in PUT update (400)
    const mismatchPut = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${createdAuto.revision.entity_id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          expected_parent_revision_id: createdAuto.revision.revision_id,
          data: { ...personData, id: 'per_wrong_id' },
          has_primary_source: true,
          summary: 'Mismatched ID update',
        }),
      })
    );
    expect(mismatchPut.status).toBe(400);

    // 4. Update person then revert the revision
    const updateOk = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${createdAuto.revision.entity_id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          expected_parent_revision_id: createdAuto.revision.revision_id,
          data: { ...personData, id: createdAuto.revision.entity_id, full_name: 'Henry Alder Sr.' },
          has_primary_source: true,
          summary: 'Add Sr. suffix',
        }),
      })
    );
    expect(updateOk.status, await updateOk.clone().text()).toBe(200);
    const updated = (await updateOk.json()) as { revision: { revision_id: number } };

    const listRevs = await server.fetch(
      new Request(`${ORIGIN}/api/revisions?entity_type=person&entity_id=${createdAuto.revision.entity_id}`, {
        headers: { cookie },
      })
    );
    expect(listRevs.status).toBe(200);

    const revertRev = await server.fetch(
      new Request(`${ORIGIN}/api/revisions/${updated.revision.revision_id}/revert`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ summary: 'Revert suffix update' }),
      })
    );
    expect(revertRev.status).toBe(201);

    // 5. Public anonymous bundle fetch + 304 ETag check
    const anonBundle = await server.fetch(new Request(`${ORIGIN}/api/bundle`));
    expect(anonBundle.status).toBe(401);
    const authBundle = await server.fetch(new Request(`${ORIGIN}/api/bundle`, { headers: { cookie } }));
    expect(authBundle.status).toBe(200);
    const pubEtag = authBundle.headers.get('etag');
    const pub304 = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie, 'if-none-match': pubEtag ?? '' } })
    );
    expect(pub304.status).toBe(304);

    // 6. Admin safety invariants (cannot delete/demote sole admin) + auth/me + logout
    const lastAdminDelete = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users/${encodeURIComponent('admin@example.test')}`, {
        method: 'DELETE',
        headers: { cookie, origin: ORIGIN },
      })
    );
    expect(lastAdminDelete.status).toBe(409);

    const lastAdminDemote = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users/${encodeURIComponent('admin@example.test')}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ role: 'editor' }),
      })
    );
    expect(lastAdminDemote.status).toBe(409);

    const missingUserPatch = await server.fetch(
      new Request(`${ORIGIN}/api/admin/users/${encodeURIComponent('nobody@example.test')}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ role: 'editor' }),
      })
    );
    expect(missingUserPatch.status).toBe(404);

    // 7. Media upload blocked for living person (422)
    const livingPerson = {
      ...createSyntheticHistoricalPerson({ id: 'per_living_upload' }),
      id: 'per_living_upload',
      slug: 'living-upload-alder',
      full_name: 'Jordan Alder',
      birth_edtf: '1998',
      death_edtf: undefined,
      is_living: true,
    };
    const createLiving = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          entity_id: livingPerson.id,
          data: livingPerson,
          has_primary_source: true,
          summary: 'Create living person for upload privacy check',
        }),
      })
    );
    expect(createLiving.status).toBe(201);

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const livingForm = new FormData();
    livingForm.append('file', new Blob([pngBytes], { type: 'image/png' }), 'living.png');
    livingForm.append(
      'metadata',
      JSON.stringify({
        id: 'med_living_block',
        kind: 'portrait',
        person_id: livingPerson.id,
        caption: 'Blocked',
      })
    );
    livingForm.append('summary', 'Attempt living portrait upload');
    const livingUpload = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN },
        body: livingForm,
      })
    );
    expect(livingUpload.status).toBe(422);

    // 8. Export YAML + Snapshot + auth/me + logout
    const yamlRes = await server.fetch(new Request(`${ORIGIN}/api/export/yaml`, { headers: { cookie } }));
    expect(yamlRes.status).toBe(200);
    const snapRes = await server.fetch(new Request(`${ORIGIN}/api/export/snapshot`, { headers: { cookie } }));
    expect(snapRes.status).toBe(200);
    const meRes = await server.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie } }));
    expect(meRes.status).toBe(200);
    const logoutRes = await server.fetch(
      new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: { cookie, origin: ORIGIN } })
    );
    expect(logoutRes.status).toBe(204);

    // 9. Magic-link error contracts, talk 404s, kinship_edge entity CRUD, and invalid auth headers
    const badVerify = await server.fetch(new Request(`${ORIGIN}/api/auth/verify?token=invalid-token-xyz`));
    expect(badVerify.status).toBeGreaterThanOrEqual(400);

    const badBearer = await server.fetch(
      new Request(`${ORIGIN}/api/revisions`, { headers: { authorization: 'Bearer invalid-agent-token' } })
    );
    expect(badBearer.status).toBe(401);

    const badCookieMe = await server.fetch(
      new Request(`${ORIGIN}/api/auth/me`, {
        headers: { cookie: '__Host-kinloom_session=not-a-valid-token' },
      })
    );
    expect(badCookieMe.status).toBe(200);

    const talkMissingEntity = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/per_nonexistent_999`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body_md: 'Orphan comment' }),
      })
    );
    expect(talkMissingEntity.status).toBe(201);

    const delMissingTalk = await server.fetch(
      new Request(`${ORIGIN}/api/talk/person/${createdAuto.revision.entity_id}/999999`, {
        method: 'DELETE',
        headers: { cookie, origin: ORIGIN },
      })
    );
    expect(delMissingTalk.status).toBe(404);

    const edgeCreate = await server.fetch(
      new Request(`${ORIGIN}/api/entities/kinship_edge`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          data: { from: createdAuto.revision.entity_id, to: livingPerson.id, relation: 'parent' },
          has_primary_source: true,
          summary: 'Link parent to living descendant',
        }),
      })
    );
    expect(edgeCreate.status).toBe(201);
    const edgeJson = (await edgeCreate.json()) as { revision: { entity_id: string; revision_id: number } };

    const edgeGet = await server.fetch(
      new Request(`${ORIGIN}/api/entities/kinship_edge/${encodeURIComponent(edgeJson.revision.entity_id)}`, {
        headers: { cookie },
      })
    );
    expect(edgeGet.status).toBe(200);

    const edgeDel = await server.fetch(
      new Request(`${ORIGIN}/api/entities/kinship_edge/${encodeURIComponent(edgeJson.revision.entity_id)}`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({
          expected_parent_revision_id: edgeJson.revision.revision_id,
          summary: 'Remove kinship edge',
        }),
      })
    );
    expect(edgeDel.status).toBe(200);

    const badOriginPost = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { cookie, origin: 'https://evil.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(badOriginPost.status).toBe(403);

    const badJsonPost = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers,
        body: '{not-valid-json',
      })
    );
    expect(badJsonPost.status).toBe(400);
  });
});

describe('HTTP payload policy, media privacy, and byte-range edge behavior', () => {
  it('enforces entity ID matching, living-event media privacy, and 404/416 media byte-range responses', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    await ports.repository.upsertUser({
      email: 'admin@example.test',
      display_name: 'Admin Alder',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: ports.clock.nowIso(),
      last_login_at: ports.clock.nowIso(),
    });
    const server = createKinloomServer({
      siteConfig,
      sessionSecret: CONTRACT_SESSION_SECRET,
      ports,
    });
    const token = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock: ports.clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: 'admin@example.test',
        display_name: 'Admin Alder',
        role: 'admin',
      },
    });
    const cookie = `__Host-kinloom_session=${token}`;

    // 1. Seed a living person and an event involving that living person
    const livingRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: `${ORIGIN}` },
        body: JSON.stringify({
          has_primary_source: true,
          summary: 'Create living person',
          data: {
            ...createSyntheticHistoricalPerson({ id: 'per_living_priv' }),
            full_name: 'Sam Alder',
            living: true,
            birth_edtf: '1995-03-10',
            death_edtf: undefined,
          },
        }),
      })
    );
    expect(livingRes.status).toBe(201);
    const livingRev = (await livingRes.json()) as { revision: { entity_id: string; revision_id: number } };

    const evRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: `${ORIGIN}` },
        body: JSON.stringify({
          has_primary_source: true,
          summary: 'Create event with living participant',
          data: {
            id: 'ev_living_priv',
            title: 'Family Reunion',
            summary: 'Annual Alder gathering',
            event_kind: 'point_event',
            scope: 'family',
            edtf_date: '2020-07-04',
            participants: [{ person_id: livingRev.revision.entity_id, role: 'subject' }],
            sources: [],
          },
        }),
      })
    );
    expect(evRes.status, await evRes.clone().text()).toBe(201);
    const evJson = (await evRes.json()) as { revision: { entity_id: string } };

    // 3. Kinship edge ID mismatch on PUT -> 400 VALIDATION_ERROR
    const edgeCreate = await server.fetch(
      new Request(`${ORIGIN}/api/entities/kinship_edge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: `${ORIGIN}` },
        body: JSON.stringify({
          has_primary_source: true,
          summary: 'Create edge',
          data: { from: 'per_a', to: 'per_b', relation: 'parent' },
        }),
      })
    );
    expect(edgeCreate.status).toBe(201);
    const edgeJson = (await edgeCreate.json()) as { revision: { entity_id: string; revision_id: number } };

    const edgeMismatch = await server.fetch(
      new Request(`${ORIGIN}/api/entities/kinship_edge/${encodeURIComponent(edgeJson.revision.entity_id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie, origin: `${ORIGIN}` },
        body: JSON.stringify({
          expected_parent_revision_id: edgeJson.revision.revision_id,
          has_primary_source: true,
          summary: 'Wrong derived edge ID',
          data: { from: 'per_c', to: 'per_d', relation: 'spouse' },
        }),
      })
    );
    expect(edgeMismatch.status).toBe(400);

    // 4. Media referencing an event with a living participant -> 422 PRIVACY_VIOLATION (both entity API and upload API)
    const mediaEntityPriv = await server.fetch(
      new Request(`${ORIGIN}/api/entities/media`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: `${ORIGIN}` },
        body: JSON.stringify({
          has_primary_source: true,
          summary: 'Blocked living event media',
          data: {
            id: 'med_blocked_ev',
            caption: 'Reunion Photo',
            kind: 'portrait',
            file: '/media/reunion.jpg',
            mime_type: 'image/jpeg',
            event_id: evJson.revision.entity_id,
          },
        }),
      })
    );
    expect(mediaEntityPriv.status).toBe(422);

    const formBlocked = new FormData();
    formBlocked.append(
      'file',
      new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], { type: 'image/jpeg' }),
      'reunion.jpg'
    );
    formBlocked.append(
      'metadata',
      JSON.stringify({ caption: 'Reunion Upload', kind: 'portrait', event_id: evJson.revision.entity_id })
    );
    formBlocked.append('summary', 'Blocked living event upload');
    const uploadBlocked = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { cookie, origin: `${ORIGIN}` },
        body: formBlocked,
      })
    );
    expect(uploadBlocked.status).toBe(422);

    // 5. Upload a valid non-living image and exercise 404, 416 Range Not Satisfiable, and /sources 404
    const formOk = new FormData();
    formOk.append(
      'file',
      new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6])], { type: 'image/jpeg' }),
      'homestead.jpg'
    );
    formOk.append('metadata', JSON.stringify({ caption: 'Homestead Photo', kind: 'portrait' }));
    formOk.append('summary', 'Upload homestead photo');
    const uploadOk = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { cookie, origin: `${ORIGIN}` },
        body: formOk,
      })
    );
    expect(uploadOk.status, await uploadOk.clone().text()).toBe(201);
    const uploaded = (await uploadOk.json()) as { url: string };

    const missingRange = await server.fetch(
      new Request(`${ORIGIN}/media/does-not-exist.jpg`, {
        headers: { cookie, range: 'bytes=0-4' },
      })
    );
    expect(missingRange.status).toBe(404);

    const badRange = await server.fetch(
      new Request(`${ORIGIN}${uploaded.url}`, {
        headers: { cookie, range: 'bytes=9999-10000' },
      })
    );
    expect(badRange.status).toBe(416);

    const missingSource = await server.fetch(
      new Request(`${ORIGIN}/sources/does-not-exist.pdf`, {
        headers: { cookie },
      })
    );
    expect(missingSource.status).toBe(404);

    // 6. Export snapshot with living person, event, media, and kinship edge + 304 ETag + event entity read redaction
    const evRead = await server.fetch(
      new Request(`${ORIGIN}/api/entities/event/${evJson.revision.entity_id}`, {
        headers: { cookie },
      })
    );
    expect(evRead.status).toBe(200);

    const snap200 = await server.fetch(
      new Request(`${ORIGIN}/api/export/snapshot`, {
        headers: { cookie },
      })
    );
    expect(snap200.status).toBe(200);
    const snapEtag = snap200.headers.get('etag');
    expect(snapEtag).toBeTruthy();

    const snap304 = await server.fetch(
      new Request(`${ORIGIN}/api/export/snapshot`, {
        headers: { cookie, 'if-none-match': snapEtag ?? '' },
      })
    );
    expect(snap304.status).toBe(304);
  });
});
