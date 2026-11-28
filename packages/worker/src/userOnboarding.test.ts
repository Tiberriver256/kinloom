import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OnboardingSessionResponseSchema, type UpdateOnboardingStateRequest } from '@kinloom/core';
import {
  FixedClock,
  getSessionCookieName,
  InMemoryUserOnboardingStore,
  signSessionToken,
} from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticSiteConfig,
} from '@kinloom/server/testing';
import { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createCloudflareWorker,
  type D1Database,
  D1UserOnboardingStore,
  type KinloomWorkerEnv,
  type R2Bucket,
} from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATION_0001 = readFileSync(resolve(THIS_DIR, '../migrations/0001_initial.sql'), 'utf8');
const MIGRATION_0008 = readFileSync(resolve(THIS_DIR, '../migrations/0008_user_onboarding.sql'), 'utf8');

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

let mf: Miniflare | null = null;

afterAll(async () => {
  if (mf) {
    await mf.dispose();
    mf = null;
  }
});

describe('D1UserOnboardingStore parity with InMemoryUserOnboardingStore and Worker HTTP round-trip', () => {
  it('matches InMemoryUserOnboardingStore identically across all operations and degrades cleanly if migration 0008 is absent', async () => {
    mf = new Miniflare({
      modules: true,
      compatibilityDate: '2026-08-06',
      script: 'export default { fetch() { return new Response("ok"); } };',
      d1Databases: {
        DB_ONBOARDING: 'onboarding-parity-db',
        DB_UNMIGRATED: 'onboarding-unmigrated-db',
      },
      r2Buckets: {
        MEDIA_BUCKET: 'onboarding-media-bucket',
      },
    });

    const db = (await mf.getD1Database('DB_ONBOARDING')) as unknown as D1Database;
    const unmigratedDb = (await mf.getD1Database('DB_UNMIGRATED')) as unknown as D1Database;
    const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;

    // 1. Missing-table graceful degradation before migration 0008 is applied
    const unmigratedStore = new D1UserOnboardingStore(unmigratedDb);
    expect(await unmigratedStore.get('nobody@archive.example')).toBeNull();
    const fallbackFirst = await unmigratedStore.markFirstLoginIfUnset(
      'nobody@archive.example',
      '2026-11-27T08:00:00.000Z'
    );
    expect(fallbackFirst.first_login_pending).toBe(true);
    const fallbackPatched = await unmigratedStore.patch(
      'nobody@archive.example',
      { complete_step_ids: ['core:viewer:open-tree'] },
      '2026-11-27T08:01:00.000Z'
    );
    expect(fallbackPatched.state.completed_step_ids).toEqual(['core:viewer:open-tree']);

    // Non-missing-table D1 errors must propagate rather than being swallowed
    const brokenDb = {
      prepare() {
        throw new Error('D1 connection timeout');
      },
    } as unknown as D1Database;
    const brokenStore = new D1UserOnboardingStore(brokenDb);
    await expect(brokenStore.get('a@archive.example')).rejects.toThrow('D1 connection timeout');
    await expect(
      brokenStore.markFirstLoginIfUnset('a@archive.example', '2026-11-27T08:00:00.000Z')
    ).rejects.toThrow('D1 connection timeout');
    await expect(
      brokenStore.patch(
        'a@archive.example',
        { checklist_visibility: 'collapsed' },
        '2026-11-27T08:00:00.000Z'
      )
    ).rejects.toThrow('D1 connection timeout');

    // 2. Full parity between D1UserOnboardingStore and InMemoryUserOnboardingStore
    await applySqlScript(db, MIGRATION_0001);
    await applySqlScript(db, MIGRATION_0008);

    const d1Store = new D1UserOnboardingStore(db);
    const memStore = new InMemoryUserOnboardingStore();
    const email = 'Steward.User@Archive.Example';

    expect(await d1Store.get(email)).toEqual(await memStore.get(email));

    const firstD1 = await d1Store.markFirstLoginIfUnset(email, '2026-11-27T09:00:00.000Z');
    const firstMem = await memStore.markFirstLoginIfUnset(email, '2026-11-27T09:00:00.000Z');
    expect(firstD1).toEqual(firstMem);

    // Calling markFirstLoginIfUnset again is idempotent
    const secondMarkD1 = await d1Store.markFirstLoginIfUnset(email, '2026-11-27T09:05:00.000Z');
    const secondMarkMem = await memStore.markFirstLoginIfUnset(email, '2026-11-27T09:05:00.000Z');
    expect(secondMarkD1).toEqual(secondMarkMem);

    const mutations: readonly [UpdateOnboardingStateRequest, string][] = [
      [
        { complete_step_ids: ['core:admin:verify-diagnostics'], last_seen_version: '0.64.0' },
        '2026-11-27T09:10:00.000Z',
      ],
      [
        { skip_step_ids: ['core:admin:create-invite'], checklist_visibility: 'collapsed' },
        '2026-11-27T09:11:00.000Z',
      ],
      [
        { complete_chapter_ids: ['core-admin-settings'], dismiss_tutorial_modal: true },
        '2026-11-27T09:12:00.000Z',
      ],
      [{ dismiss_checklist: true }, '2026-11-27T09:13:00.000Z'],
      [{ reset_progress: true }, '2026-11-27T09:14:00.000Z'],
    ];

    for (const [mutation, ts] of mutations) {
      const resD1 = await d1Store.patch(email, mutation, ts);
      const resMem = await memStore.patch(email, mutation, ts);
      expect(resD1).toEqual(resMem);
    }

    expect(await d1Store.get(email)).toEqual(await memStore.get(email));

    // 3. Cloudflare Worker HTTP round-trip on /api/auth/me/onboarding
    const clock = new FixedClock('2026-11-27T10:00:00.000Z');
    await db
      .prepare(
        `INSERT INTO users (email, display_name, role, added_by, added_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        'steward.user@archive.example',
        'Steward User',
        'admin',
        'bootstrap',
        '2026-11-27T09:00:00.000Z',
        '2026-11-27T09:00:00.000Z'
      )
      .run();
    const worker = createCloudflareWorker({
      siteConfig: createSyntheticSiteConfig(),
      clock,
    });
    const env: KinloomWorkerEnv = {
      DB: db,
      MEDIA_BUCKET: bucket,
      SESSION_SECRET: CONTRACT_SESSION_SECRET,
      ARCHIVE_MODE: 'public',
    };
    const token = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: 'steward.user@archive.example',
        display_name: 'Steward User',
        role: 'admin',
      },
    });
    const cookie = `${getSessionCookieName(true)}=${token}`;

    const putRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me/onboarding`, {
        method: 'PUT',
        headers: {
          origin: CONTRACT_TEST_ORIGIN,
          cookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ complete_step_ids: ['core:admin:create-invite'] }),
      }),
      env
    );
    expect(putRes.status).toBe(200);
    const putPayload = OnboardingSessionResponseSchema.parse(await putRes.json());
    expect(putPayload.state.completed_step_ids).toEqual(['core:admin:create-invite']);

    const getRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me/onboarding`, {
        method: 'GET',
        headers: { cookie },
      }),
      env
    );
    expect(getRes.status).toBe(200);
    const getPayload = OnboardingSessionResponseSchema.parse(await getRes.json());
    expect(getPayload.state.completed_step_ids).toEqual(['core:admin:create-invite']);
  });
});
