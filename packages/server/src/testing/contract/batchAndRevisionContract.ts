import {
  asBatchId,
  asRevisionId,
  deriveKinshipEdgeId,
  type EntityLookupKey,
  entityLookupCompositeKey,
  type RevisionRecord,
  toEntityPayload,
} from '@kinloom/core';
import { expect, it } from 'vitest';
import {
  CONTRACT_TEST_ORIGIN,
  createSyntheticEvent,
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  seedAdminCookie,
  type WithContractHarness,
} from './harness.js';

export function registerBatchAndRevisionContractTests(withHarness: WithContractHarness): void {
  it('enforces optimistic 409 Conflict with zero partial writes on multi-op atomic rollback', async () => {
    await withHarness(async ({ ports, server }) => {
      const cookie = await seedAdminCookie(ports);
      const p1 = createSyntheticHistoricalPerson({ id: 'per_one', slug: 'person-one' });
      const p2 = createSyntheticHistoricalPerson({
        id: 'per_two',
        slug: 'person-two',
        full_name: 'Martha Alder',
        given_name: 'Martha',
      });

      await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            entity_id: p1.id,
            data: p1,
            summary: 'Create person one',
            has_primary_source: true,
          }),
        })
      );
      await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            entity_id: p2.id,
            data: p2,
            summary: 'Create person two',
            has_primary_source: true,
          }),
        })
      );

      await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person/${p2.id}`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            expected_parent_revision_id: 2,
            data: { ...p2, full_name: 'Martha Ellen Alder' },
            summary: 'Update Martha middle name',
            has_primary_source: true,
          }),
        })
      );

      const conflictResult = await ports.repository.commitAtomicMutations({
        batch_id: asBatchId('batch_rollback_test'),
        author: { author_id: 'admin@example.test', author_name: 'Admin', author_type: 'human' },
        nowIso: ports.clock.nowIso(),
        operations: [
          {
            entity_type: 'person',
            entity_id: p1.id,
            action: 'update',
            expected_parent_revision_id: asRevisionId(1),
            summary: 'Update p1 in doomed batch',
            has_primary_source: true,
            before_json: toEntityPayload(p1),
            after_json: toEntityPayload({ ...p1, full_name: 'Should Rollback' }),
          },
          {
            entity_type: 'person',
            entity_id: p2.id,
            action: 'update',
            expected_parent_revision_id: asRevisionId(2),
            summary: 'Stale p2 update triggers rollback',
            has_primary_source: true,
            before_json: toEntityPayload(p2),
            after_json: toEntityPayload({ ...p2, full_name: 'Stale Write' }),
          },
        ],
      });

      expect(conflictResult.kind).toBe('conflict');
      if (conflictResult.kind === 'conflict') {
        expect(conflictResult.entity_id).toBe(p2.id);
        expect(conflictResult.server_revision_id).toBe(3);
        expect(conflictResult.diff.hasChanges).toBe(true);
      }

      expect(await ports.repository.getHeadRevisionId()).toBe(3);
      const storedP1 = await ports.repository.getEntity('person', p1.id);
      expect(storedP1?.current_revision_id).toBe(1);
      expect(storedP1 && !('edge' in storedP1) ? storedP1.data.full_name : null).toBe('Arthur Alder');
    });
  });

  it('submits multi-step batches and unwinds batch revert strictly in reverse revision order', async () => {
    await withHarness(async ({ ports, server }) => {
      const cookie = await seedAdminCookie(ports);
      const person = createSyntheticHistoricalPerson({ id: 'per_batch_01', slug: 'batch-person' });

      const submitRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            batch_id: 'batch_census_1900',
            summary: 'Import 1900 census findings',
            has_primary_source: true,
            patches: [
              {
                action: 'create',
                entity_type: 'person',
                entity_id: person.id,
                data: person,
                summary: 'Create Arthur from index',
              },
              {
                action: 'update',
                entity_type: 'person',
                entity_id: person.id,
                data: { full_name: 'Arthur J. Alder' },
                merge: true,
                summary: 'Add middle initial from sheet 4B',
              },
            ],
          }),
        })
      );
      expect(submitRes.status).toBe(201);
      const submitted = (await submitRes.json()) as {
        batch_id: string;
        revisions: RevisionRecord[];
        head_revision_id: number;
      };
      expect(submitted.revisions.map((r) => r.revision_id)).toEqual([1, 2]);
      expect(submitted.head_revision_id).toBe(2);

      // Unwind r2 then r1 so the person converges to soft-deleted rather than resurrected.
      const revertRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches/batch_census_1900/revert`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({ summary: 'Undo unverified census batch' }),
        })
      );
      expect(revertRes.status).toBe(201);
      const reverted = (await revertRes.json()) as {
        revisions: RevisionRecord[];
        head_revision_id: number;
      };
      expect(reverted.revisions.map((r) => r.reverted_revision_id)).toEqual([2, 1]);
      expect(reverted.head_revision_id).toBe(4);

      const rowAfterRevert = await ports.repository.getEntity('person', person.id);
      expect(rowAfterRevert?.deleted_at).not.toBeNull();
      expect(rowAfterRevert?.current_revision_id).toBe(4);
    });
  });

  it('batch-reads >100 entities across multiple types with missing IDs and avoids N+1 getEntity calls in submitBatch and revertBatch', async () => {
    await withHarness(async ({ ports, server }) => {
      const cookie = await seedAdminCookie(ports);
      const getEntitiesBatch = ports.repository.getEntitiesBatch?.bind(ports.repository);
      expect(typeof getEntitiesBatch).toBe('function');
      if (!getEntitiesBatch) {
        return;
      }
      const emptyMap = await getEntitiesBatch([]);
      expect(emptyMap.size).toBe(0);

      const patches: Array<Record<string, unknown>> = [];
      const lookupKeys: EntityLookupKey[] = [];

      for (let i = 0; i < 95; i += 1) {
        const id = `per_bulk_${String(i).padStart(3, '0')}`;
        const person = createSyntheticHistoricalPerson({
          id,
          slug: `bulk-person-${i}`,
          full_name: `Historical Person ${i}`,
        });
        patches.push({
          action: 'create',
          entity_type: 'person',
          entity_id: id,
          data: person,
          summary: `Create ${id}`,
        });
        lookupKeys.push({ entityType: 'person', entityId: id });
      }

      for (let i = 0; i < 20; i += 1) {
        const id = `evt_bulk_${String(i).padStart(2, '0')}`;
        const event = createSyntheticEvent({
          id,
          summary: `Historical Event ${i}`,
          participants: [{ person_id: 'per_bulk_000', role: 'principal' }],
        });
        patches.push({
          action: 'create',
          entity_type: 'event',
          entity_id: id,
          data: event,
          summary: `Create ${id}`,
        });
        lookupKeys.push({ entityType: 'event', entityId: id });
      }

      for (let i = 1; i <= 10; i += 1) {
        const edge = {
          from: 'per_bulk_000',
          to: `per_bulk_${String(i).padStart(3, '0')}`,
          relation: 'parent' as const,
        };
        const edgeId = deriveKinshipEdgeId(edge);
        patches.push({
          action: 'create',
          entity_type: 'kinship_edge',
          entity_id: edgeId,
          data: edge,
          summary: `Create kinship ${edgeId}`,
        });
        lookupKeys.push({ entityType: 'kinship_edge', entityId: edgeId });
      }

      let singleGetCalls = 0;
      const originalGetEntity = ports.repository.getEntity.bind(ports.repository);
      ports.repository.getEntity = async (entityType, entityId) => {
        singleGetCalls += 1;
        return originalGetEntity(entityType, entityId);
      };

      const bulkRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            batch_id: 'batch_bulk_125',
            summary: 'Seed 125 synthetic entities',
            has_primary_source: true,
            patches,
          }),
        })
      );
      expect(bulkRes.status).toBe(201);
      expect(singleGetCalls).toBe(0);

      const missingKeys: EntityLookupKey[] = [
        { entityType: 'person', entityId: 'per_does_not_exist' },
        { entityType: 'event', entityId: 'evt_does_not_exist' },
        { entityType: 'kinship_edge', entityId: 'kinship_missing_edge' },
      ];
      const fetched = await getEntitiesBatch([...lookupKeys, lookupKeys[0], ...missingKeys]);
      expect(fetched.size).toBe(128);

      const firstPerson = fetched.get(entityLookupCompositeKey('person', 'per_bulk_000'));
      expect(firstPerson && !('edge' in firstPerson) ? firstPerson.data.full_name : null).toBe(
        'Historical Person 0'
      );
      const lastPerson = fetched.get(entityLookupCompositeKey('person', 'per_bulk_094'));
      expect(lastPerson && !('edge' in lastPerson) ? lastPerson.data.full_name : null).toBe(
        'Historical Person 94'
      );
      const lastEvent = fetched.get(entityLookupCompositeKey('event', 'evt_bulk_19'));
      expect(lastEvent && !('edge' in lastEvent) ? lastEvent.data.summary : null).toBe('Historical Event 19');
      const firstEdge = fetched.get(entityLookupCompositeKey('kinship_edge', lookupKeys[115].entityId));
      expect(firstEdge && 'edge' in firstEdge ? firstEdge.edge.relation : null).toBe('parent');

      for (const missing of missingKeys) {
        const k = entityLookupCompositeKey(missing.entityType, missing.entityId);
        expect(fetched.has(k)).toBe(true);
        expect(fetched.get(k)).toBeNull();
      }

      const living = createSyntheticLivingPerson({ id: 'per_living_batch_01' });
      const livingEvent = createSyntheticEvent({
        id: 'evt_living_batch_01',
        edtf_date: '2016-04-02',
        participants: [{ person_id: living.id, role: 'principal' }],
      });
      const seedLivingRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            batch_id: 'batch_living_seed',
            summary: 'Seed living person and event',
            has_primary_source: false,
            patches: [
              { action: 'create', entity_type: 'person', entity_id: living.id, data: living },
              { action: 'create', entity_type: 'event', entity_id: livingEvent.id, data: livingEvent },
            ],
          }),
        })
      );
      expect(seedLivingRes.status).toBe(201);
      expect(singleGetCalls).toBe(0);

      const forbiddenMediaRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            batch_id: 'batch_living_media_reject',
            summary: 'Attempt media linked to living event',
            has_primary_source: false,
            patches: [
              {
                action: 'create',
                entity_type: 'media',
                entity_id: 'med_living_event_photo',
                data: {
                  id: 'med_living_event_photo',
                  kind: 'document_scan',
                  event_id: livingEvent.id,
                  file: 'media/synthetic/living-event-document.jpg',
                  caption: 'Event document',
                },
              },
            ],
          }),
        })
      );
      expect(forbiddenMediaRes.status).toBe(422);
      const forbiddenBody = (await forbiddenMediaRes.json()) as { error: { code: string } };
      expect(forbiddenBody.error.code).toBe('LIVING_MEDIA_FORBIDDEN');
      expect(singleGetCalls).toBe(0);

      const conflictRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            batch_id: 'batch_stale_conflict',
            summary: 'Attempt stale batch update',
            has_primary_source: true,
            patches: [
              {
                action: 'update',
                entity_type: 'person',
                entity_id: 'per_bulk_000',
                parent_revision_id: 999999,
                merge: true,
                data: { full_name: 'Stale Name' },
              },
            ],
          }),
        })
      );
      expect(conflictRes.status).toBe(409);
      expect(singleGetCalls).toBe(0);

      const revertBulkRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/batches/batch_bulk_125/revert`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({ summary: 'Revert 125-entity synthetic batch' }),
        })
      );
      expect(revertBulkRes.status).toBe(201);
      expect(singleGetCalls).toBe(0);

      ports.repository.getEntity = originalGetEntity;
      const revertedFirst = await ports.repository.getEntity('person', 'per_bulk_000');
      expect(revertedFirst?.deleted_at).not.toBeNull();
    });
  });
}
