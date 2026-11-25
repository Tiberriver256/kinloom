import { describe, expect, it } from 'vitest';
import {
  asBatchId,
  asRevisionId,
  KinloomSiteConfigSchema,
  type ArchiveBundle,
  type KinloomServerPorts,
  type KinloomSiteConfig,
  type RawEvent,
  type RawPerson,
  type RevisionRecord,
} from '@kinloom/core';
import {
  FakeAuthProvider,
  InMemoryEmailSender,
  type FakeOAuthProfile,
  type SentMagicLinkEmail,
} from '../adapters/inMemory.js';
import { FixedClock } from '../adapters/systemClock.js';
import { createKinloomServer } from '../http/router.js';
import { signSessionToken } from '../http/session.js';

export const CONTRACT_TEST_ORIGIN = 'https://archive.example.test';
export const CONTRACT_SESSION_SECRET = 'kinloom-contract-suite-secret-key-2026-0123456789';

export function createSyntheticSiteConfig(): KinloomSiteConfig {
  return KinloomSiteConfigSchema.parse({
    schemaVersion: 1,
    site: {
      title: 'Alder Synthetic Family Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_SYNTHETIC',
      footerCredit: 'Built with Kinloom',
    },
    branches: [
      {
        id: 'alder',
        label: 'Alder Line',
        surnames: ['Alder'],
        lineageGroups: ['alder_core'],
      },
    ],
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
      privateModeShowsBirthYear: true,
      stripLivingPortraits: true,
      stripLivingResidenceSpans: true,
    },
    wiki: {
      allowTalk: true,
      allowWatchlists: false,
      maxUploadBytes: 15 * 1024 * 1024,
    },
  });
}

export function createSyntheticHistoricalPerson(overrides: Partial<RawPerson> = {}): RawPerson {
  return {
    id: 'per_arthur_alder',
    slug: 'arthur-alder',
    full_name: 'Arthur Alder',
    given_name: 'Arthur',
    surname: 'Alder',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'alder_core',
    birth_edtf: '1872-04-14',
    death_edtf: '1948-11-02',
    portrait_url: null,
    ...overrides,
  };
}

export function createSyntheticLivingPerson(overrides: Partial<RawPerson> = {}): RawPerson {
  return {
    id: 'per_clara_alder',
    slug: 'clara-alder',
    full_name: 'Clara Alder',
    given_name: 'Clara',
    surname: 'Alder',
    alt_names: [],
    sex: 'F',
    is_living: true,
    lineage_group: 'alder_core',
    birth_edtf: '1988-09-19',
    death_edtf: '',
    portrait_url: '/media/should-be-stripped.jpg',
    ...overrides,
  };
}

export function createSyntheticEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'evt_homestead_1898',
    title: 'Homestead deed filed',
    scope: 'family',
    event_kind: 'point_event',
    edtf_date: '1898-06-12',
    place_id: null,
    summary: 'Arthur Alder recorded a homestead claim.',
    participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
    sources: [],
    ...overrides,
  };
}

export interface BackendAdapterContractHarness {
  siteConfig?: KinloomSiteConfig;
  ports: KinloomServerPorts;
  advanceClockMs?: (deltaMs: number) => void;
  getSentMagicLinks?: () => readonly SentMagicLinkEmail[];
  registerOAuthCode?: (code: string, profile: FakeOAuthProfile) => void;
  dispose?: () => Promise<void> | void;
}

export type BackendAdapterContractFactory = (
  siteConfig: KinloomSiteConfig
) => Promise<BackendAdapterContractHarness> | BackendAdapterContractHarness;

function extractSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const combined = response.headers.get('set-cookie');
  return combined ? [combined] : [];
}

function cookiePairFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0]?.trim() ?? '';
}

async function seedAdminCookie(
  ports: KinloomServerPorts,
  email = 'admin@example.test',
  displayName = 'Archive Admin'
): Promise<string> {
  await ports.repository.upsertUser({
    email,
    display_name: displayName,
    role: 'admin',
    added_by: 'bootstrap',
    added_at: ports.clock.nowIso(),
    last_login_at: ports.clock.nowIso(),
  });
  const token = await signSessionToken({
    secret: CONTRACT_SESSION_SECRET,
    clock: ports.clock,
    ttlSeconds: 3600,
    payload: { kind: 'user', email, display_name: displayName, role: 'admin' },
  });
  return `__Host-kinloom_session=${token}`;
}

/**
 * Reusable Vitest backend adapter contract suite.
 * Run identically against InMemory adapters (@kinloom/server) and Cloudflare D1 + R2 Miniflare adapters (@kinloom/worker).
 */
export function runBackendAdapterContractTests(
  adapterName: string,
  createHarness: BackendAdapterContractFactory
): void {
  describe(`Backend Adapter Contract Suite: ${adapterName}`, () => {
    const withHarness = async (
      fn: (ctx: {
        siteConfig: KinloomSiteConfig;
        ports: KinloomServerPorts;
        server: ReturnType<typeof createKinloomServer>;
        advanceClockMs: (ms: number) => void;
        getSentMagicLinks: () => readonly SentMagicLinkEmail[];
        registerOAuthCode: (code: string, profile: FakeOAuthProfile) => void;
      }) => Promise<void>
    ): Promise<void> => {
      const defaultConfig = createSyntheticSiteConfig();
      const harness = await createHarness(defaultConfig);
      const siteConfig = harness.siteConfig ?? defaultConfig;
      const server = createKinloomServer({
        siteConfig,
        ports: harness.ports,
        sessionSecret: CONTRACT_SESSION_SECRET,
        bootstrapAdminEmail: 'bootstrap-admin@example.test',
      });

      const advanceClockMs =
        harness.advanceClockMs ??
        ((deltaMs: number) => {
          if (harness.ports.clock instanceof FixedClock) {
            harness.ports.clock.advanceMs(deltaMs);
          }
        });

      const getSentMagicLinks =
        harness.getSentMagicLinks ??
        (() => {
          if (harness.ports.emailSender instanceof InMemoryEmailSender) {
            return harness.ports.emailSender.sentMessages;
          }
          return [];
        });

      const registerOAuthCode =
        harness.registerOAuthCode ??
        ((code: string, profile: FakeOAuthProfile) => {
          if (harness.ports.authProvider instanceof FakeAuthProvider) {
            harness.ports.authProvider.registerCode(code, profile);
          }
        });

      try {
        await fn({
          siteConfig,
          ports: harness.ports,
          server,
          advanceClockMs,
          getSentMagicLinks,
          registerOAuthCode,
        });
      } finally {
        if (harness.dispose) {
          await harness.dispose();
        }
      }
    };

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
        expect(created.etag).toBe('"r1"');

        // Update entity
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
        expect(updated.etag).toBe('"r2"');

        // Soft delete
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

        // Creating over a soft-deleted entity must fail with 409
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

        // Restore soft-deleted entity
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

        // Revision pagination
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

        // Advance p2 to rev 3
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

        // Direct atomic commit with op1 valid (p1 at rev 1) and op2 stale (p2 expecting rev 2 when server is rev 3)
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
              before_json: p1 as unknown as Record<string, unknown>,
              after_json: { ...p1, full_name: 'Should Rollback' } as unknown as Record<string, unknown>,
            },
            {
              entity_type: 'person',
              entity_id: p2.id,
              action: 'update',
              expected_parent_revision_id: asRevisionId(2),
              summary: 'Stale p2 update triggers rollback',
              has_primary_source: true,
              before_json: p2 as unknown as Record<string, unknown>,
              after_json: { ...p2, full_name: 'Stale Write' } as unknown as Record<string, unknown>,
            },
          ],
        });

        expect(conflictResult.kind).toBe('conflict');
        if (conflictResult.kind === 'conflict') {
          expect(conflictResult.entity_id).toBe(p2.id);
          expect(conflictResult.server_revision_id).toBe(3);
          expect(conflictResult.diff.hasChanges).toBe(true);
        }

        // Verify ZERO partial writes: p1 stayed at rev 1 and head revision stayed at 3
        expect(await ports.repository.getHeadRevisionId()).toBe(3);
        const storedP1 = await ports.repository.getEntity('person', p1.id);
        expect(storedP1?.current_revision_id).toBe(1);
        expect(storedP1 && !('edge' in storedP1) ? storedP1.data.full_name : null).toBe(
          'Arthur Alder'
        );
      });
    });

    it('submits multi-step batches and unwinds batch revert strictly in reverse revision order', async () => {
      await withHarness(async ({ ports, server }) => {
        const cookie = await seedAdminCookie(ports);
        const person = createSyntheticHistoricalPerson({ id: 'per_batch_01', slug: 'batch-person' });

        // Batch performs CREATE followed by UPDATE on the SAME person
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

        // Revert entire batch: must unwind r2 then r1 so person converges to softDeleted (not resurrected!)
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
        // Exact birthdate stripped to year only, portrait stripped to null
        expect(createdLiving.entity.birth_edtf).toBe('1988');
        expect(createdLiving.entity.portrait_url).toBeNull();

        // Living-participant event redacts exact date, place_id, and summary
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

        // Uploading a portrait linked to living Clara must return 422 LIVING_MEDIA_FORBIDDEN
        const form = new FormData();
        form.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'clara.jpg', { type: 'image/jpeg' }));
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

    it('deduplicates media by SHA-256 and streams HTTP 206 Partial Content byte ranges', async () => {
      await withHarness(async ({ ports, server }) => {
        const cookie = await seedAdminCookie(ports);
        const person = createSyntheticHistoricalPerson();
        await server.fetch(
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
              summary: 'Add Arthur for media test',
              has_primary_source: true,
            }),
          })
        );

        const videoBytes = new TextEncoder().encode('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');

        const uploadOnce = async (id: string): Promise<{ url: string }> => {
          const form = new FormData();
          form.append('file', new File([videoBytes], 'story.mp4', { type: 'video/mp4' }));
          form.append(
            'metadata',
            JSON.stringify({
              id,
              kind: 'video_story',
              person_ids: [person.id],
              caption: 'Arthur oral history clip',
              duration_seconds: 42,
            })
          );
          form.append('summary', 'Upload video story clip');
          const res = await server.fetch(
            new Request(`${CONTRACT_TEST_ORIGIN}/api/media/upload`, {
              method: 'POST',
              headers: { origin: CONTRACT_TEST_ORIGIN, cookie },
              body: form,
            })
          );
          expect(res.status).toBe(201);
          return (await res.json()) as { url: string };
        };

        const first = await uploadOnce('med_clip_1');
        const second = await uploadOnce('med_clip_2');
        expect(first.url).toBe(second.url);

        // Full GET 200
        const fullRes = await server.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, { headers: { cookie } })
        );
        expect(fullRes.status).toBe(200);
        expect(fullRes.headers.get('accept-ranges')).toBe('bytes');
        expect(fullRes.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(await fullRes.text()).toBe('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');

        // Range GET 206 Partial Content (explicit start-end, open-ended, and suffix ranges)
        const rangeRes = await server.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, {
            headers: { cookie, range: 'bytes=10-19' },
          })
        );
        expect(rangeRes.status).toBe(206);
        expect(rangeRes.headers.get('content-range')).toBe(`bytes 10-19/${videoBytes.byteLength}`);
        expect(rangeRes.headers.get('content-length')).toBe('10');
        expect(await rangeRes.text()).toBe('ABCDEFGHIJ');

        const openEndedRes = await server.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, {
            headers: { cookie, range: 'bytes=30-' },
          })
        );
        expect(openEndedRes.status).toBe(206);
        expect(openEndedRes.headers.get('content-range')).toBe(`bytes 30-35/${videoBytes.byteLength}`);
        expect(await openEndedRes.text()).toBe('UVWXYZ');

        const suffixRes = await server.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, {
            headers: { cookie, range: 'bytes=-6' },
          })
        );
        expect(suffixRes.status).toBe(206);
        expect(suffixRes.headers.get('content-range')).toBe(`bytes 30-35/${videoBytes.byteLength}`);
        expect(await suffixRes.text()).toBe('UVWXYZ');

        // Unsatisfiable range -> 416
        const badRangeRes = await server.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, {
            headers: { cookie, range: 'bytes=999-1005' },
          })
        );
        expect(badRangeRes.status).toBe(416);
      });
    });

    it('auto-enrolls invited relatives strictly as editor and enforces single-use magic links', async () => {
      await withHarness(async ({ ports, server, advanceClockMs, getSentMagicLinks, registerOAuthCode }) => {
        const adminCookie = await seedAdminCookie(ports);

        // Admin creates an invite link
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

        // Relative redeems invite -> gets viewer cookie
        const redeemRes = await server.fetch(new Request(createdInvite.invite_url));
        expect(redeemRes.status).toBe(302);
        const viewerCookie = cookiePairFromSetCookie(extractSetCookies(redeemRes)[0] ?? '');
        expect(viewerCookie).toContain('__Host-kinloom_session=');

        // Viewer can read bundle, cannot edit
        const bundleRes = await server.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, { headers: { cookie: viewerCookie } })
        );
        expect(bundleRes.status).toBe(200);
        const etag = bundleRes.headers.get('etag');
        expect(etag).toBe('"r0"');

        // Repeat GET /api/bundle with If-None-Match -> 304 Not Modified
        const notModifiedRes = await server.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
            headers: { cookie: viewerCookie, 'if-none-match': etag ?? '' },
          })
        );
        expect(notModifiedRes.status).toBe(304);

        // Upgrade via Google OAuth PKCE while carrying viewer invite cookie
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
            .find((c) => c.startsWith('__Host-kinloom_session=') && c !== '__Host-kinloom_session=') ??
          '';

        // Verify Sam enrolled strictly as editor (never admin!)
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

        // Magic-link request with invite cookie -> single-use verify -> second use rejected
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

        const verify1Res = await server.fetch(new Request(noraEmail!.magicLinkUrl));
        expect(verify1Res.status).toBe(302);
        const noraUser = await ports.repository.getUser('nora.alder@example.test');
        expect(noraUser?.role).toBe('editor');

        // Second use of the exact same magic link must fail with 400 TOKEN_INVALID_OR_EXPIRED
        const verify2Res = await server.fetch(new Request(noraEmail!.magicLinkUrl));
        expect(verify2Res.status).toBe(400);
        const verify2Body = (await verify2Res.json()) as { error: { code: string } };
        expect(verify2Body.error.code).toBe('TOKEN_INVALID_OR_EXPIRED');

        // Expired magic link fails when clock advances past TTL
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
        advanceClockMs(16 * 60 * 1000);
        const expiredRes = await server.fetch(new Request(eliEmail!.magicLinkUrl));
        expect(expiredRes.status).toBe(400);
      });
    });

    it('enforces scoped agent tokens (write_batch vs read_backup)', async () => {
      await withHarness(async ({ ports, server }) => {
        const adminCookie = await seedAdminCookie(ports);

        // Create write_batch and read_backup tokens
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

        // write_batch submits batch cleanly
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
              patches: [
                { action: 'create', entity_type: 'person', entity_id: person.id, data: person },
              ],
            }),
          })
        );
        expect(batchRes.status).toBe(201);

        // write_batch is blocked from /api/admin/* and /api/export/yaml
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

        // read_backup can export YAML and snapshot and read bundle, but gets 403 on ALL write routes
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
              patches: [
                { action: 'create', entity_type: 'person', entity_id: 'per_nope', data: person },
              ],
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
  });
}
