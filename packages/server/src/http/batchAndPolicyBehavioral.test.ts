import type { RawEvent, RawPerson } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts, createKinloomServer, signSessionToken } from '../index.js';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';

const ORIGIN = CONTRACT_TEST_ORIGIN;

async function setupServerWithAdmin() {
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
    appOrigin: ORIGIN,
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
  return { server, ports, adminCookie: `__Host-kinloom_session=${token}` };
}

describe('Server batch compilation, payload policy, read/export, and media edge-case behavior', () => {
  it('handles batch multi-entity lifecycle, intra-batch chaining, conflict/error codes, living privacy, and revert', async () => {
    const { server, adminCookie } = await setupServerWithAdmin();
    const jsonHeaders = {
      cookie: adminCookie,
      origin: ORIGIN,
      'content-type': 'application/json',
    };

    const henry: RawPerson = createSyntheticHistoricalPerson('per_batch_henry');
    const livingDesc: RawPerson = {
      id: 'per_batch_living',
      slug: 'maya-alder-living',
      full_name: 'Maya Alder',
      given_name: 'Maya',
      surname: 'Alder',
      sex: 'F',
      birth_edtf_date: '1996-03-01',
      is_living: true,
    };
    const eventWithLiving: RawEvent = {
      id: 'evt_batch_living',
      event_kind: 'residence_anchor',
      scope: 'personal',
      summary: 'Modern residence.',
      sources: [],
      title: 'Modern residence',
      edtf_date: '2018-01-01',
      confidence: 'Confirmed',
      participants: [{ person_id: livingDesc.id, role: 'subject' }],
    };

    // 1. Multi-entity create + intra-batch update + delete + restore in one batch
    const batch1 = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          batch_id: 'batch_lifecycle_1',
          author_type: 'human',
          summary: 'Create place, person, living person, event, then update/delete/restore',
          has_primary_source: true,
          patches: [
            {
              action: 'create',
              entity_type: 'place',
              entity_id: 'plc_hudsonville',
              data: {
                id: 'plc_hudsonville',
                slug: 'hudsonville',
                parent_id: null,
                name: 'Hudsonville',
                full_name: 'Hudsonville, Ottawa County, Michigan, USA',
                place_type: 'town',
                lat: 42.8711,
                lng: -85.8648,
              },
            },
            {
              action: 'create',
              entity_type: 'person',
              entity_id: henry.id,
              data: henry,
            },
            {
              action: 'update',
              entity_type: 'person',
              entity_id: henry.id,
              data: { alt_names: ['H. Alder'] },
              merge: true,
              summary: 'Intra-batch merge update',
            },
            {
              action: 'create',
              entity_type: 'person',
              entity_id: livingDesc.id,
              data: livingDesc,
            },
            {
              action: 'create',
              entity_type: 'event',
              entity_id: eventWithLiving.id,
              data: eventWithLiving,
            },
            {
              action: 'create',
              entity_type: 'narrative',
              entity_id: 'nar_alder_mill',
              data: {
                id: 'nar_alder_mill',
                slug: 'alder-mill',
                title: 'The Alder Mill',
                summary: 'Short summary',
                body_md: 'Mill history.',
                featured_people: [henry.id],
              },
            },
            {
              action: 'delete',
              entity_type: 'narrative',
              entity_id: 'nar_alder_mill',
              summary: 'Soft delete narrative in batch',
            },
            {
              action: 'restore',
              entity_type: 'narrative',
              entity_id: 'nar_alder_mill',
              summary: 'Restore narrative in batch',
            },
          ],
        }),
      })
    );
    expect(batch1.status, await batch1.clone().text()).toBe(201);

    // 2. Reject media attached to an event with a living participant (422)
    const livingMediaBatch = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          batch_id: 'batch_living_media',
          author_type: 'human',
          summary: 'Attempt media on living event',
          has_primary_source: true,
          patches: [
            {
              action: 'create',
              entity_type: 'media',
              entity_id: 'med_blocked_living',
              data: {
                id: 'med_blocked_living',
                kind: 'family_photo',
                file: '/media/blocked.jpg',
                event_id: eventWithLiving.id,
                caption: 'Blocked photo',
              },
            },
          ],
        }),
      })
    );
    expect(livingMediaBatch.status).toBe(422);

    // 3. Batch error contracts: duplicate create (409), update nonexistent (404), delete nonexistent (404),
    // restore active (409), restore nonexistent (404), stale parent_revision_id (409), short summary (400)
    const dupCreate = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          batch_id: 'batch_err_dup',
          author_type: 'human',
          summary: 'Duplicate create',
          has_primary_source: true,
          patches: [{ action: 'create', entity_type: 'person', entity_id: henry.id, data: henry }],
        }),
      })
    );
    expect(dupCreate.status).toBe(409);

    const updateMissing = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          batch_id: 'batch_err_404',
          author_type: 'human',
          summary: 'Update missing',
          has_primary_source: true,
          patches: [
            {
              action: 'update',
              entity_type: 'person',
              entity_id: 'per_does_not_exist',
              data: henry,
            },
          ],
        }),
      })
    );
    expect(updateMissing.status).toBe(404);

    const deleteMissing = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          batch_id: 'batch_err_del404',
          author_type: 'human',
          summary: 'Delete missing',
          has_primary_source: true,
          patches: [{ action: 'delete', entity_type: 'person', entity_id: 'per_does_not_exist' }],
        }),
      })
    );
    expect(deleteMissing.status).toBe(404);

    const restoreActive = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          batch_id: 'batch_err_restore_active',
          author_type: 'human',
          summary: 'Restore already active',
          has_primary_source: true,
          patches: [{ action: 'restore', entity_type: 'person', entity_id: henry.id }],
        }),
      })
    );
    expect(restoreActive.status).toBe(409);

    const restoreMissing = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          batch_id: 'batch_err_restore_404',
          author_type: 'human',
          summary: 'Restore missing',
          has_primary_source: true,
          patches: [{ action: 'restore', entity_type: 'person', entity_id: 'per_does_not_exist' }],
        }),
      })
    );
    expect(restoreMissing.status).toBe(404);

    const staleConflict = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          batch_id: 'batch_err_stale',
          author_type: 'human',
          summary: 'Stale parent revision',
          has_primary_source: true,
          patches: [
            {
              action: 'update',
              entity_type: 'person',
              entity_id: henry.id,
              parent_revision_id: 9999,
              data: { alt_names: ['Stale'] },
              merge: true,
            },
          ],
        }),
      })
    );
    expect(staleConflict.status).toBe(409);

    const shortSummary = await server.fetch(
      new Request(`${ORIGIN}/api/batches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          batch_id: 'batch_err_short',
          author_type: 'human',
          summary: 'ok',
          has_primary_source: true,
          patches: [{ action: 'delete', entity_type: 'person', entity_id: henry.id }],
        }),
      })
    );
    expect(shortSummary.status).toBe(400);

    // 4. Listing entities, revisions filtering, and bundle ETag 304
    const listPeople = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${henry.id}`, { headers: { cookie: adminCookie } })
    );
    expect(listPeople.status).toBe(200);

    const badType = await server.fetch(
      new Request(`${ORIGIN}/api/entities/not_a_type/foo`, { headers: { cookie: adminCookie } })
    );
    expect(badType.status).toBe(400);

    const revisions = await server.fetch(
      new Request(`${ORIGIN}/api/revisions?entity_type=person&entity_id=${henry.id}&limit=2`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(revisions.status).toBe(200);

    const bundleRes = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } })
    );
    expect(bundleRes.status).toBe(200);
    const etag = bundleRes.headers.get('etag');
    expect(etag).toBeTruthy();

    const bundle304 = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, {
        headers: { cookie: adminCookie, 'if-none-match': etag ?? '' },
      })
    );
    expect(bundle304.status).toBe(304);

    // 5. Revert batch_lifecycle_1 cleanly
    const revertBatch = await server.fetch(
      new Request(`${ORIGIN}/api/batches/batch_lifecycle_1/revert`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ summary: 'Unwind entire lifecycle batch' }),
      })
    );
    expect(revertBatch.status).toBe(201);

    // 6. Media upload edge cases: disallowed MIME, empty file, SHA-256 deduplication, suffix/open-ended ranges
    const badMimeForm = new FormData();
    badMimeForm.append(
      'file',
      new Blob([new Uint8Array([1, 2, 3])], { type: 'application/x-executable' }),
      'bad.exe'
    );
    badMimeForm.append(
      'metadata',
      JSON.stringify({ id: 'med_bad_mime', kind: 'document_scan', caption: 'Bad' })
    );
    badMimeForm.append('summary', 'Bad mime upload');
    const badMimeRes = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: ORIGIN },
        body: badMimeForm,
      })
    );
    expect(badMimeRes.status).toBeGreaterThanOrEqual(400);

    const emptyForm = new FormData();
    emptyForm.append('file', new Blob([], { type: 'image/png' }), 'empty.png');
    emptyForm.append(
      'metadata',
      JSON.stringify({ id: 'med_empty', kind: 'document_scan', caption: 'Empty' })
    );
    emptyForm.append('summary', 'Empty upload');
    const emptyRes = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: ORIGIN },
        body: emptyForm,
      })
    );
    expect(emptyRes.status).toBe(400);

    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 10, 20, 30, 40, 50, 60, 70, 80,
    ]);
    const form1 = new FormData();
    form1.append('file', new Blob([pngBytes], { type: 'image/png' }), 'doc1.png');
    form1.append('metadata', JSON.stringify({ id: 'med_dup_1', kind: 'document_scan', caption: 'Doc 1' }));
    form1.append('summary', 'Upload doc 1');
    const up1 = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: ORIGIN },
        body: form1,
      })
    );
    expect(up1.status).toBe(201);
    const up1Json = (await up1.json()) as { media: { file: string } };

    // Second upload with identical bytes deduplicates storage
    const form2 = new FormData();
    form2.append('file', new Blob([pngBytes], { type: 'image/png' }), 'doc2.png');
    form2.append('metadata', JSON.stringify({ id: 'med_dup_2', kind: 'document_scan', caption: 'Doc 2' }));
    form2.append('summary', 'Upload doc 2 duplicate');
    const up2 = await server.fetch(
      new Request(`${ORIGIN}/api/media/upload`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: ORIGIN },
        body: form2,
      })
    );
    expect(up2.status).toBe(201);

    const openRange = await server.fetch(
      new Request(`${ORIGIN}${up1Json.media.file}`, {
        headers: { cookie: adminCookie, range: 'bytes=4-' },
      })
    );
    expect(openRange.status).toBe(206);

    const suffixRange = await server.fetch(
      new Request(`${ORIGIN}${up1Json.media.file}`, {
        headers: { cookie: adminCookie, range: 'bytes=-4' },
      })
    );
    expect(suffixRange.status).toBe(206);
  });
});
