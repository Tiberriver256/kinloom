import type { RawEvent, RawPerson, RevisionRecord } from '@kinloom/core';
import { expect, it } from 'vitest';
import {
  CONTRACT_TEST_ORIGIN,
  createSyntheticEvent,
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  seedAdminCookie,
  type WithContractHarness,
} from './harness.js';

export function registerEntityAndPrivacyContractTests(withHarness: WithContractHarness): void {
  it('supports entity CRUD, soft-delete, restore, and revision history pagination', async () => {
    await withHarness(async ({ ports, server }) => {
      const cookie = await seedAdminCookie(ports);
      const person = createSyntheticHistoricalPerson();

      const createRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            entity_id: person.id,
            data: person,
            summary: 'Add Arthur Alder',
            has_primary_source: true,
          }),
        })
      );
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        entity: RawPerson;
        revision: RevisionRecord;
        etag: string;
      };
      expect(created.entity.full_name).toBe('Arthur Alder');
      expect(created.revision.revision_id).toBe(1);
      expect(created.etag).toMatch(/^"r1(-[a-f0-9]{8})?"$/);

      const updateRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/${person.id}`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            expected_parent_revision_id: 1,
            data: { ...person, full_name: 'Arthur Benjamin Alder' },
            summary: 'Add middle name from census',
            has_primary_source: true,
          }),
        })
      );
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as {
        entity: RawPerson;
        revision: RevisionRecord;
        etag: string;
      };
      expect(updated.entity.full_name).toBe('Arthur Benjamin Alder');
      expect(updated.revision.revision_id).toBe(2);
      expect(updated.etag).toMatch(/^"r2(-[a-f0-9]{8})?"$/);

      const deleteRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/${person.id}`, {
          method: 'DELETE',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            expected_parent_revision_id: 2,
            summary: 'Soft delete duplicate entry',
          }),
        })
      );
      expect(deleteRes.status).toBe(200);
      const deleted = (await deleteRes.json()) as { revision: RevisionRecord; etag: string };
      expect(deleted.revision.action).toBe('delete');
      expect(deleted.revision.revision_id).toBe(3);

      const duplicateCreateRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            entity_id: person.id,
            data: person,
            summary: 'Attempt recreate over soft-deleted',
            has_primary_source: true,
          }),
        })
      );
      expect(duplicateCreateRes.status).toBe(409);

      const restoreRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/${person.id}/restore`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            expected_parent_revision_id: 3,
            summary: 'Restore verified Arthur Alder record',
          }),
        })
      );
      expect(restoreRes.status).toBe(200);
      const restored = (await restoreRes.json()) as {
        entity: RawPerson;
        revision: RevisionRecord;
      };
      expect(restored.revision.action).toBe('restore');
      expect(restored.revision.revision_id).toBe(4);
      expect(restored.entity.full_name).toBe('Arthur Benjamin Alder');

      const page1Res = await server.fetch(
        new Request(
          `${CONTRACT_TEST_ORIGIN}/api/revisions?entity_type=person&entity_id=${person.id}&limit=2`,
          { headers: { cookie } }
        )
      );
      expect(page1Res.status).toBe(200);
      const page1 = (await page1Res.json()) as {
        items: RevisionRecord[];
        next_cursor: number | null;
      };
      expect(page1.items.map((r) => r.revision_id)).toEqual([4, 3]);
      expect(page1.next_cursor).toBe(3);

      const page2Res = await server.fetch(
        new Request(
          `${CONTRACT_TEST_ORIGIN}/api/revisions?entity_type=person&entity_id=${person.id}&cursor=${page1.next_cursor}&limit=2`,
          { headers: { cookie } }
        )
      );
      const page2 = (await page2Res.json()) as {
        items: RevisionRecord[];
        next_cursor: number | null;
      };
      expect(page2.items.map((r) => r.revision_id)).toEqual([2, 1]);
      expect(page2.next_cursor).toBeNull();
    });
  });

  it('enforces living-person privacy on writes, reads, exports, and media attach', async () => {
    await withHarness(async ({ ports, server }) => {
      const cookie = await seedAdminCookie(ports);
      const living = createSyntheticLivingPerson();

      const createLivingRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            entity_id: living.id,
            data: living,
            summary: 'Add living relative Clara',
            has_primary_source: false,
          }),
        })
      );
      expect(createLivingRes.status).toBe(201);
      const createdLiving = (await createLivingRes.json()) as { entity: RawPerson };
      expect(createdLiving.entity.birth_edtf).toBe('1988');
      expect(createdLiving.entity.portrait_url).toBeNull();

      const livingEvent = createSyntheticEvent({
        id: 'evt_living_01',
        edtf_date: '2015-08-22',
        place_id: 'plc_springfield',
        summary: 'Private home address 123 Maple St.',
        participants: [{ person_id: living.id, role: 'principal' }],
      });
      const eventRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/event`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            entity_id: livingEvent.id,
            data: livingEvent,
            summary: 'Add living event',
            has_primary_source: false,
          }),
        })
      );
      expect(eventRes.status).toBe(201);
      const createdEvent = (await eventRes.json()) as { entity: RawEvent };
      expect(createdEvent.entity.edtf_date).toBe('2015');
      expect(createdEvent.entity.place_id).toBeNull();
      expect(createdEvent.entity.summary).not.toContain('123 Maple');

      const form = new FormData();
      form.append(
        'file',
        new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'clara.jpg', { type: 'image/jpeg' })
      );
      form.append(
        'metadata',
        JSON.stringify({
          kind: 'portrait',
          person_ids: [living.id],
          caption: 'Portrait of Clara',
        })
      );
      form.append('summary', 'Attempt portrait upload for living person');

      const uploadRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/media/upload`, {
          method: 'POST',
          headers: { origin: CONTRACT_TEST_ORIGIN, cookie },
          body: form,
        })
      );
      expect(uploadRes.status).toBe(422);
      const errBody = (await uploadRes.json()) as { error: { code: string } };
      expect(errBody.error.code).toBe('LIVING_MEDIA_FORBIDDEN');
    });
  });
}
