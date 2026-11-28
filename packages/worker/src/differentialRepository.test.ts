import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asBatchId,
  type BatchSubmission,
  type EntityPayload,
  type Place,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
} from '@kinloom/core';
import {
  BundleReadService,
  createInMemoryServerPorts,
  readStreamToBytes,
  WikiWriteService,
} from '@kinloom/server';
import { createSyntheticSiteConfig } from '@kinloom/server/testing';
import fc from 'fast-check';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  D1ArchiveRepository,
  type D1Database,
  type R2Bucket,
  R2IncrementalPatchBundleCache,
} from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const INITIAL_MIGRATION_SQL = readFileSync(resolve(THIS_DIR, '../migrations/0001_initial.sql'), 'utf8');
const STEWARD_REVIEWS_MIGRATION_SQL = readFileSync(
  resolve(THIS_DIR, '../migrations/0007_steward_reviews.sql'),
  'utf8'
);
const REPO_DIFF_SEED = 20261128;

async function applySqlScript(db: D1Database, sqlScript: string): Promise<void> {
  const withoutComments = sqlScript
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');
  const statements = withoutComments
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
  if (statements.length > 0) {
    await db.batch(statements.map((stmt) => db.prepare(stmt)));
  }
}

type OpSpec =
  | { kind: 'upsert_person'; slot: number; birthYear: number; isLiving: boolean }
  | { kind: 'upsert_place'; slot: number }
  | { kind: 'upsert_source'; slot: number }
  | { kind: 'upsert_event'; slot: number; year: number }
  | { kind: 'delete_and_restore_person'; slot: number }
  | { kind: 'conflict_update_person'; slot: number }
  | { kind: 'revert_last_batch' };

const opSpecArb: fc.Arbitrary<OpSpec> = fc.oneof(
  fc.record({
    kind: fc.constant('upsert_person' as const),
    slot: fc.integer({ min: 1, max: 3 }),
    birthYear: fc.integer({ min: 1845, max: 1995 }),
    isLiving: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('upsert_place' as const),
    slot: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({
    kind: fc.constant('upsert_source' as const),
    slot: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({
    kind: fc.constant('upsert_event' as const),
    slot: fc.integer({ min: 1, max: 2 }),
    year: fc.integer({ min: 1875, max: 1935 }),
  }),
  fc.record({
    kind: fc.constant('delete_and_restore_person' as const),
    slot: fc.integer({ min: 1, max: 3 }),
  }),
  fc.record({
    kind: fc.constant('conflict_update_person' as const),
    slot: fc.integer({ min: 1, max: 3 }),
  }),
  fc.record({
    kind: fc.constant('revert_last_batch' as const),
  })
);

function makePerson(slot: number, birthYear: number, isLiving: boolean, revLabel: string): RawPerson {
  const living = isLiving || birthYear > 1925;
  return {
    id: `per_diff_${slot}`,
    slug: `diff-person-${slot}`,
    full_name: `Alder${slot} ${revLabel}`,
    given_name: `Alder${slot}`,
    surname: revLabel,
    alt_names: [],
    sex: slot % 2 === 0 ? 'F' : 'M',
    is_living: living,
    lineage_group: 'ancestor',
    branch: 'alder_main',
    birth_edtf: `${birthYear}-04-10`,
    death_edtf: living ? '' : `${Math.min(birthYear + 62, 1988)}`,
    portrait_url: null,
  };
}

function makePlace(slot: number): Place {
  return {
    id: `plc_diff_${slot}`,
    slug: `diff-place-${slot}`,
    name: `Cedarville${slot}`,
    full_name: `Cedarville${slot}, Ohio, USA`,
    place_type: 'town',
    parent_id: null,
    lat: 40.1 + slot * 0.1,
    lng: -83.1 - slot * 0.1,
  };
}

function makeSource(slot: number): SourceRecord {
  return {
    id: `src_diff_${slot}`,
    citation: `Cedar County Register Vol ${slot}`,
    source_type: 'vital_record',
  };
}

function makeEvent(slot: number, year: number, placeId: string | null, sourceId: string | null): RawEvent {
  return {
    id: `evt_diff_${slot}`,
    title: `Census Record ${slot} (${year})`,
    scope: 'family',
    event_kind: 'residence_anchor',
    edtf_date: `${year}-06-01`,
    place_id: placeId,
    summary: `Recorded in Cedarville in ${year}.`,
    participants: [{ person_id: 'per_diff_1', role: 'head' }],
    sources: sourceId ? [{ source_id: sourceId, confidence: 'high' }] : [],
  };
}

describe('Differential: InMemoryArchiveRepository vs Cloudflare D1 + R2 (Miniflare)', () => {
  it('maintains identical snapshot, revision history, conflict rollbacks, reverts, and compiled bundles across seeded operation sequences', async () => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      d1Databases: { DB: 'kinloom-diff-db' },
      r2Buckets: { MEDIA_BUCKET: 'kinloom-diff-bucket' },
    });

    try {
      const db = (await mf.getD1Database('DB')) as unknown as D1Database;
      const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;
      await applySqlScript(db, INITIAL_MIGRATION_SQL);
      await applySqlScript(db, STEWARD_REVIEWS_MIGRATION_SQL);

      const siteConfig = createSyntheticSiteConfig();

      const sequences = fc.sample(fc.array(opSpecArb, { minLength: 6, maxLength: 8 }), {
        seed: REPO_DIFF_SEED,
        numRuns: 4,
      });

      let runCounter = 0;
      for (const ops of sequences) {
        runCounter += 1;
        await db.batch([
          db.prepare('DELETE FROM steward_reviews'),
          db.prepare('DELETE FROM revisions'),
          db.prepare('DELETE FROM entities'),
          db.prepare('DELETE FROM kinship_edges'),
          db.prepare('DELETE FROM sqlite_sequence'),
        ]);

        const memPorts = createInMemoryServerPorts(siteConfig);
        const clock = memPorts.clock;
        const d1Repo = new D1ArchiveRepository(db);
        const r2Cache = new R2IncrementalPatchBundleCache({
          bucket,
          siteConfig,
          clock,
          key: `diff-run-${runCounter}/archive-bundle.json`,
        });

        const memWriter = new WikiWriteService({
          repository: memPorts.repository,
          bundleCache: memPorts.bundleCache,
          clock,
          siteConfig,
        });
        const d1Writer = new WikiWriteService({
          repository: d1Repo,
          bundleCache: r2Cache,
          clock,
          siteConfig,
        });

        const memReader = new BundleReadService({
          repository: memPorts.repository,
          bundleCache: memPorts.bundleCache,
          siteConfig,
          clock,
        });
        const d1Reader = new BundleReadService({
          repository: d1Repo,
          bundleCache: r2Cache,
          siteConfig,
          clock,
        });

        const author = {
          author_id: 'usr_diff',
          author_name: 'Differential Tester',
          author_type: 'human' as const,
        };

        const seedPerson = makePerson(1, 1860, false, 'Baseline');
        const seedSubmission: BatchSubmission = {
          batch_id: `seed_${runCounter}`,
          author_type: 'human',
          summary: 'Seed baseline person',
          has_primary_source: true,
          patches: [
            {
              action: 'create',
              entity_type: 'person',
              entity_id: seedPerson.id,
              data: seedPerson as unknown as EntityPayload,
              summary: 'Create baseline person',
            },
          ],
        };
        await memWriter.submitBatch({ submission: seedSubmission, author });
        await d1Writer.submitBatch({ submission: seedSubmission, author });

        // Warm both bundle caches
        await memReader.getBundle({ ifNoneMatch: null });
        await d1Reader.getBundle({ ifNoneMatch: null });

        const committedBatchIds: string[] = [];

        for (const [stepIdx, op] of ops.entries()) {
          const batchId = `run${runCounter}_step${stepIdx}`;
          const revLabel = `R${stepIdx}`;

          if (op.kind === 'upsert_person') {
            const personId = `per_diff_${op.slot}`;
            const curMem = await memPorts.repository.getEntity('person', personId);
            const curD1 = await d1Repo.getEntity('person', personId);
            expect(curD1?.current_revision_id ?? null).toBe(curMem?.current_revision_id ?? null);

            const payload = makePerson(op.slot, op.birthYear, op.isLiving, revLabel);
            const submission: BatchSubmission = {
              batch_id: batchId,
              author_type: 'human',
              summary: `Upsert ${personId}`,
              has_primary_source: true,
              patches: [
                curMem && !curMem.deleted_at
                  ? {
                      action: 'update',
                      entity_type: 'person',
                      entity_id: personId,
                      parent_revision_id: Number(curMem.current_revision_id),
                      data: payload as unknown as EntityPayload,
                      merge: false,
                      summary: `Update ${personId}`,
                    }
                  : {
                      action: 'create',
                      entity_type: 'person',
                      entity_id: personId,
                      data: payload as unknown as EntityPayload,
                      summary: `Create ${personId}`,
                    },
              ],
            };
            const rMem = await memWriter.submitBatch({ submission, author });
            const rD1 = await d1Writer.submitBatch({ submission, author });
            expect(rD1.revisions.length).toBe(rMem.revisions.length);
            committedBatchIds.push(batchId);
          } else if (op.kind === 'upsert_place') {
            const placeId = `plc_diff_${op.slot}`;
            const curMem = await memPorts.repository.getEntity('place', placeId);
            const payload = makePlace(op.slot);
            const submission: BatchSubmission = {
              batch_id: batchId,
              author_type: 'human',
              summary: `Upsert ${placeId}`,
              has_primary_source: true,
              patches: [
                curMem && !curMem.deleted_at
                  ? {
                      action: 'update',
                      entity_type: 'place',
                      entity_id: placeId,
                      parent_revision_id: Number(curMem.current_revision_id),
                      data: payload as unknown as EntityPayload,
                      merge: false,
                      summary: `Update ${placeId}`,
                    }
                  : {
                      action: 'create',
                      entity_type: 'place',
                      entity_id: placeId,
                      data: payload as unknown as EntityPayload,
                      summary: `Create ${placeId}`,
                    },
              ],
            };
            await memWriter.submitBatch({ submission, author });
            await d1Writer.submitBatch({ submission, author });
            committedBatchIds.push(batchId);
          } else if (op.kind === 'upsert_source') {
            const sourceId = `src_diff_${op.slot}`;
            const curMem = await memPorts.repository.getEntity('source', sourceId);
            const payload = makeSource(op.slot);
            const submission: BatchSubmission = {
              batch_id: batchId,
              author_type: 'human',
              summary: `Upsert ${sourceId}`,
              has_primary_source: true,
              patches: [
                curMem && !curMem.deleted_at
                  ? {
                      action: 'update',
                      entity_type: 'source',
                      entity_id: sourceId,
                      parent_revision_id: Number(curMem.current_revision_id),
                      data: payload as unknown as EntityPayload,
                      merge: false,
                      summary: `Update ${sourceId}`,
                    }
                  : {
                      action: 'create',
                      entity_type: 'source',
                      entity_id: sourceId,
                      data: payload as unknown as EntityPayload,
                      summary: `Create ${sourceId}`,
                    },
              ],
            };
            await memWriter.submitBatch({ submission, author });
            await d1Writer.submitBatch({ submission, author });
            committedBatchIds.push(batchId);
          } else if (op.kind === 'upsert_event') {
            const eventId = `evt_diff_${op.slot}`;
            const curMem = await memPorts.repository.getEntity('event', eventId);
            const placeRow = await memPorts.repository.getEntity('place', 'plc_diff_1');
            const sourceRow = await memPorts.repository.getEntity('source', 'src_diff_1');
            const payload = makeEvent(
              op.slot,
              op.year,
              placeRow && !placeRow.deleted_at ? 'plc_diff_1' : null,
              sourceRow && !sourceRow.deleted_at ? 'src_diff_1' : null
            );
            const submission: BatchSubmission = {
              batch_id: batchId,
              author_type: 'human',
              summary: `Upsert ${eventId}`,
              has_primary_source: true,
              patches: [
                curMem && !curMem.deleted_at
                  ? {
                      action: 'update',
                      entity_type: 'event',
                      entity_id: eventId,
                      parent_revision_id: Number(curMem.current_revision_id),
                      data: payload as unknown as EntityPayload,
                      merge: false,
                      summary: `Update ${eventId}`,
                    }
                  : {
                      action: 'create',
                      entity_type: 'event',
                      entity_id: eventId,
                      data: payload as unknown as EntityPayload,
                      summary: `Create ${eventId}`,
                    },
              ],
            };
            await memWriter.submitBatch({ submission, author });
            await d1Writer.submitBatch({ submission, author });
            committedBatchIds.push(batchId);
          } else if (op.kind === 'delete_and_restore_person') {
            const personId = `per_diff_${op.slot}`;
            const curMem = await memPorts.repository.getEntity('person', personId);
            if (curMem && !curMem.deleted_at && personId !== 'per_diff_1') {
              const delSub: BatchSubmission = {
                batch_id: `${batchId}_del`,
                author_type: 'human',
                summary: `Delete ${personId}`,
                has_primary_source: true,
                patches: [
                  {
                    action: 'delete',
                    entity_type: 'person',
                    entity_id: personId,
                    parent_revision_id: Number(curMem.current_revision_id),
                    summary: `Soft delete ${personId}`,
                  },
                ],
              };
              const dMem = await memWriter.submitBatch({ submission: delSub, author });
              const dD1 = await d1Writer.submitBatch({ submission: delSub, author });
              expect(dD1.revisions.length).toBe(dMem.revisions.length);

              const restoreSub: BatchSubmission = {
                batch_id: `${batchId}_res`,
                author_type: 'human',
                summary: `Restore ${personId}`,
                has_primary_source: true,
                patches: [
                  {
                    action: 'restore',
                    entity_type: 'person',
                    entity_id: personId,
                    parent_revision_id: Number(dMem.revisions[0]!.revision_id),
                    data: 'data' in curMem ? curMem.data : undefined,
                    summary: `Restore ${personId}`,
                  },
                ],
              };
              await memWriter.submitBatch({ submission: restoreSub, author });
              await d1Writer.submitBatch({ submission: restoreSub, author });
            }
          } else if (op.kind === 'conflict_update_person') {
            const personId = `per_diff_${op.slot}`;
            const curMem = await memPorts.repository.getEntity('person', personId);
            if (curMem && !curMem.deleted_at && Number(curMem.current_revision_id) > 1) {
              const staleParent = Number(curMem.current_revision_id) - 1;
              const badSub: BatchSubmission = {
                batch_id: `${batchId}_conflict`,
                author_type: 'human',
                summary: 'Stale parent conflict check',
                has_primary_source: true,
                patches: [
                  {
                    action: 'update',
                    entity_type: 'person',
                    entity_id: personId,
                    parent_revision_id: staleParent,
                    data: makePerson(op.slot, 1870, false, 'Conflict') as unknown as EntityPayload,
                    merge: false,
                    summary: 'Should conflict',
                  },
                ],
              };
              await expect(memWriter.submitBatch({ submission: badSub, author })).rejects.toThrow();
              await expect(d1Writer.submitBatch({ submission: badSub, author })).rejects.toThrow();
            }
          } else if (op.kind === 'revert_last_batch') {
            const lastId = committedBatchIds.pop();
            if (lastId) {
              let memOk = true;
              let d1Ok = true;
              try {
                await memWriter.revertBatch({
                  batchId: asBatchId(lastId),
                  summary: 'Differential revert',
                  author,
                });
              } catch {
                memOk = false;
              }
              try {
                await d1Writer.revertBatch({
                  batchId: asBatchId(lastId),
                  summary: 'Differential revert',
                  author,
                });
              } catch {
                d1Ok = false;
              }
              expect(d1Ok).toBe(memOk);
            }
          }
        }

        // Compare full active snapshots, revision counts, and compiled bundles from both backends
        const memSnap = await memPorts.repository.loadActiveSnapshot();
        const d1Snap = await d1Repo.loadActiveSnapshot();
        expect(d1Snap.head_revision_id).toBe(memSnap.head_revision_id);
        expect(d1Snap.entities.length).toBe(memSnap.entities.length);
        expect(d1Snap.kinship.length).toBe(memSnap.kinship.length);

        // Verify identical Steward Review Stamp resolution (batch inheritance + direct override) on both backends
        const seedBatchId = `seed_${runCounter}`;
        await memPorts.repository.upsertStewardReview({
          target_kind: 'batch',
          target_id: seedBatchId,
          reviewer_id: 'steward@example.test',
          reviewer_name: 'Archive Steward',
          note: 'Differential review stamp',
          reviewed_at: clock.nowIso(),
        });
        await d1Repo.upsertStewardReview({
          target_kind: 'batch',
          target_id: seedBatchId,
          reviewer_id: 'steward@example.test',
          reviewer_name: 'Archive Steward',
          note: 'Differential review stamp',
          reviewed_at: clock.nowIso(),
        });

        const memRevs = await memPorts.repository.listRevisions({ limit: 100 });
        const d1Revs = await d1Repo.listRevisions({ limit: 100 });
        expect(d1Revs.items.length).toBe(memRevs.items.length);
        expect(d1Revs.items.map((r) => r.review ?? null)).toEqual(memRevs.items.map((r) => r.review ?? null));

        const memRes = await memReader.getBundle({ ifNoneMatch: null });
        const d1Res = await d1Reader.getBundle({ ifNoneMatch: null });
        expect(memRes.status).toBe('hit');
        expect(d1Res.status).toBe('hit');
        if (memRes.status === 'hit' && d1Res.status === 'hit') {
          const memText =
            typeof memRes.object.body === 'string'
              ? memRes.object.body
              : new TextDecoder().decode(await readStreamToBytes(memRes.object.body));
          const d1Text =
            typeof d1Res.object.body === 'string'
              ? d1Res.object.body
              : new TextDecoder().decode(await readStreamToBytes(d1Res.object.body));
          expect(JSON.parse(d1Text)).toEqual(JSON.parse(memText));
        }
      }
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
