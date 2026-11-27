import type { RawPerson } from '@kinloom/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import {
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';
import { createKinloomServer } from './router.js';
import { signSessionToken } from './session.js';

const ORIGIN = 'https://alder.example.test';
const SECRET = 'kinloom-prop-http-server-secret-2026-abcdef123456';
const FIXED_SEED = 20261127;

type ServerAction =
  | { readonly kind: 'create'; readonly slot: number; readonly birthYear: number }
  | { readonly kind: 'update_valid'; readonly slot: number; readonly suffix: string }
  | { readonly kind: 'update_stale'; readonly slot: number }
  | { readonly kind: 'unauth_write'; readonly slot: number };

const actionArb: fc.Arbitrary<ServerAction> = fc.oneof(
  fc.record({
    kind: fc.constant('create' as const),
    slot: fc.integer({ min: 0, max: 5 }),
    birthYear: fc.integer({ min: 1790, max: 1905 }),
  }),
  fc.record({
    kind: fc.constant('update_valid' as const),
    slot: fc.integer({ min: 0, max: 5 }),
    suffix: fc.constantFrom('Sr.', 'Jr.', 'II', 'III'),
  }),
  fc.record({
    kind: fc.constant('update_stale' as const),
    slot: fc.integer({ min: 0, max: 5 }),
  }),
  fc.record({
    kind: fc.constant('unauth_write' as const),
    slot: fc.integer({ min: 0, max: 5 }),
  })
);

describe('Server HTTP transport property & differential parity invariants', () => {
  it('preserves exact parity between HTTP export/entity routes and repository state while rejecting stale or unauthenticated writes without drift', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 3, maxLength: 14 }), async (actions) => {
        const siteConfig = createSyntheticSiteConfig();
        const ports = createInMemoryServerPorts(siteConfig);
        const server = createKinloomServer({
          siteConfig,
          ports,
          sessionSecret: SECRET,
        });

        await ports.repository.upsertUser({
          email: 'admin@example.test',
          display_name: 'Archive Admin',
          role: 'admin',
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
            email: 'admin@example.test',
            display_name: 'Archive Admin',
            role: 'admin',
          },
        });
        const adminCookie = `__Host-kinloom_session=${token}`;

        const tokRes = await server.fetch(
          new Request(`${ORIGIN}/api/admin/agent-tokens`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
            body: JSON.stringify({ label: 'Differential Backup', scope: 'read_backup' }),
          })
        );
        expect(tokRes.status).toBe(201);
        const { plaintext_secret: backupSecret } = (await tokRes.json()) as {
          plaintext_secret: string;
        };

        const expectedById = new Map<string, { person: RawPerson; rev: number }>();
        let expectedHeadRev = 0;

        for (const act of actions) {
          const id = `per_slot_${act.slot}`;
          const current = expectedById.get(id);

          if (act.kind === 'unauth_write') {
            const candidate = createSyntheticHistoricalPerson({
              id,
              slug: `alder-slot-${act.slot}`,
              full_name: `Thomas Alder ${act.slot}`,
            });
            const unauthRes = await server.fetch(
              new Request(`${ORIGIN}/api/entities/person`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN },
                body: JSON.stringify({
                  entity_id: id,
                  data: candidate,
                  summary: 'Unauthenticated write attempt',
                  has_primary_source: true,
                }),
              })
            );
            expect(unauthRes.status).toBe(401);
            continue;
          }

          if (act.kind === 'create') {
            const candidate = createSyntheticHistoricalPerson({
              id,
              slug: `alder-slot-${act.slot}`,
              full_name: `Arthur Alder ${act.slot}`,
              birth_edtf: String(act.birthYear),
              death_edtf: String(act.birthYear + 65),
            });
            const createRes = await server.fetch(
              new Request(`${ORIGIN}/api/entities/person`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
                body: JSON.stringify({
                  entity_id: id,
                  data: candidate,
                  summary: `Create ${id}`,
                  has_primary_source: true,
                }),
              })
            );
            if (current) {
              expect(createRes.status).toBe(409);
            } else {
              expect(createRes.status).toBe(201);
              expectedHeadRev += 1;
              expectedById.set(id, { person: candidate, rev: expectedHeadRev });
            }
            continue;
          }

          if (act.kind === 'update_valid' && current) {
            const updated: RawPerson = {
              ...current.person,
              full_name: `Arthur Alder ${act.slot} ${act.suffix}`,
            };
            const putRes = await server.fetch(
              new Request(`${ORIGIN}/api/entities/person/${id}`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
                body: JSON.stringify({
                  expected_parent_revision_id: current.rev,
                  data: updated,
                  summary: `Update ${id}`,
                  has_primary_source: true,
                }),
              })
            );
            expect(putRes.status).toBe(200);
            expectedHeadRev += 1;
            expectedById.set(id, { person: updated, rev: expectedHeadRev });
            continue;
          }

          if (act.kind === 'update_stale' && current && current.rev > 1) {
            const staleRes = await server.fetch(
              new Request(`${ORIGIN}/api/entities/person/${id}`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
                body: JSON.stringify({
                  expected_parent_revision_id: current.rev - 1,
                  data: { ...current.person, full_name: 'Stale Overwrite Attempt' },
                  summary: 'Stale write',
                  has_primary_source: true,
                }),
              })
            );
            expect(staleRes.status).toBe(409);
            const conflictPayload = (await staleRes.json()) as {
              error: { code: string; details: { server_revision_id: number } };
            };
            expect(conflictPayload.error.code).toBe('OPTIMISTIC_CONFLICT');
            expect(conflictPayload.error.details.server_revision_id).toBe(current.rev);
          }
        }

        // Differential check: HTTP /api/export/snapshot vs direct repository.exportSnapshot() + model
        const exportRes = await server.fetch(
          new Request(`${ORIGIN}/api/export/snapshot`, {
            headers: { authorization: `Bearer ${backupSecret}` },
          })
        );
        expect(exportRes.status).toBe(200);
        const etag = exportRes.headers.get('etag') ?? '';
        expect(etag).toBe(`"r${expectedHeadRev}"`);

        const httpExport = (await exportRes.json()) as {
          head_revision_id: number;
          snapshot: {
            entities: Array<{ entity_id: string; current_revision_id: number; data: RawPerson }>;
          };
        };
        const directRepoState = await ports.repository.loadActiveSnapshot();

        expect(httpExport.head_revision_id).toBe(expectedHeadRev);
        expect(directRepoState.head_revision_id).toBe(expectedHeadRev);
        expect(httpExport.snapshot.entities.map((e) => e.entity_id).toSorted()).toEqual(
          [...expectedById.keys()].toSorted()
        );

        // Also verify live HTTP GET /api/bundle matches incrementally compiled archive state
        const liveCompiledRes = await server.fetch(
          new Request(`${ORIGIN}/api/bundle`, {
            headers: { authorization: `Bearer ${backupSecret}` },
          })
        );
        expect(liveCompiledRes.status).toBe(200);
        const liveCompiled = (await liveCompiledRes.json()) as {
          people: Array<{ id: string; full_name: string }>;
        };
        expect(liveCompiled.people.map((p) => p.id).toSorted()).toEqual([...expectedById.keys()].toSorted());

        for (const [id, expected] of expectedById.entries()) {
          const getEntityRes = await server.fetch(
            new Request(`${ORIGIN}/api/entities/person/${id}`, {
              headers: { cookie: adminCookie },
            })
          );
          expect(getEntityRes.status).toBe(200);
          const got = (await getEntityRes.json()) as {
            entity: RawPerson;
            current_revision_id: number;
          };
          expect(got.current_revision_id).toBe(expected.rev);
          expect(got.entity.full_name).toBe(expected.person.full_name);
        }

        // Conditional GET with matching ETag returns 304 Not Modified
        const cachedRes = await server.fetch(
          new Request(`${ORIGIN}/api/export/snapshot`, {
            headers: {
              authorization: `Bearer ${backupSecret}`,
              'if-none-match': etag,
            },
          })
        );
        expect(cachedRes.status).toBe(304);
      }),
      { seed: FIXED_SEED, numRuns: 25 }
    );
  });
});
