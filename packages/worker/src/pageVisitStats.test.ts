import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixedClock, getSessionCookieName, signSessionToken } from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from '@kinloom/server/testing';
import { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import { probeD1SchemaMigrationLevel } from './adapters/d1/schemaProbe.js';
import { D1PageVisitStatsStore } from './adapters/d1PageVisitStatsStore.js';
import {
  AdminObservabilityStatsResponseSchema,
  createCloudflareWorker,
  createPageVisitStatsPlugin,
  createWorkersObservabilityPlugin,
  type D1Database,
  type ExecutionContext,
  type Fetcher,
  type KinloomWorkerEnv,
  PAGE_VISIT_STATS_ADMIN_ROUTE,
  PAGE_VISIT_STATS_PLUGIN_ID,
  PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE,
  PublicPageVisitCountResponseSchema,
  type R2Bucket,
} from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATION_0001 = readFileSync(resolve(THIS_DIR, '../migrations/0001_initial.sql'), 'utf8');
const MIGRATION_0002 = readFileSync(resolve(THIS_DIR, '../migrations/0002_pronunciations.sql'), 'utf8');
const MIGRATION_0003 = readFileSync(
  resolve(THIS_DIR, '../migrations/0003_pronunciation_provenance.sql'),
  'utf8'
);
const MIGRATION_0004 = readFileSync(resolve(THIS_DIR, '../migrations/0004_plugin_settings.sql'), 'utf8');
const MIGRATION_0005 = readFileSync(resolve(THIS_DIR, '../migrations/0005_page_visit_stats.sql'), 'utf8');

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

describe('Cloudflare Worker D1PageVisitStatsStore & opt-in page visit stats (Miniflare D1)', () => {
  it('degrades gracefully before 0005, applies idempotent 0005 migration, stays off by default, and tracks D1 aggregates when opted in', async () => {
    mf = new Miniflare({
      modules: true,
      compatibilityDate: '2026-08-06',
      script: 'export default { fetch() { return new Response("ok"); } };',
      d1Databases: {
        DB_STATS: 'page-visit-stats-db',
      },
      r2Buckets: {
        MEDIA_BUCKET: 'page-visit-stats-bucket',
      },
    });

    const db = (await mf.getD1Database('DB_STATS')) as unknown as D1Database;
    const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;

    await applySqlScript(db, MIGRATION_0001);
    await applySqlScript(db, MIGRATION_0002);
    await applySqlScript(db, MIGRATION_0003);
    await applySqlScript(db, MIGRATION_0004);

    // Before 0005 is applied, D1PageVisitStatsStore degrades cleanly on both reads and writes.
    const store = new D1PageVisitStatsStore(db);
    await store.incrementVisit({
      routeKey: '/',
      entityKind: 'route',
      entitySlug: null,
      dayUtc: '2026-11-27',
    });
    await store.recordCacheEvent({ dayUtc: '2026-11-27', outcome: 'hit' });
    expect(await store.getTotalViews()).toBe(0);
    expect(await store.getPageTotalViews('/')).toBe(0);
    expect(await store.getDailySeries({ sinceDayUtc: '2026-11-21', untilDayUtc: '2026-11-27' })).toEqual([]);
    expect(await store.getTopPages({ limit: 10 })).toEqual([]);
    expect(await store.getTopPages({ limit: 0 })).toEqual([]);
    expect(await store.getCacheTotals()).toEqual({ hits: 0, misses: 0, not_modified: 0 });

    // Apply 0005 twice to verify SQL idempotency and schemaProbe detection.
    await applySqlScript(db, MIGRATION_0005);
    await applySqlScript(db, MIGRATION_0005);
    expect(await probeD1SchemaMigrationLevel(db)).toBe('0005_page_visit_stats.sql');

    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-27T12:00:00.000Z');
    const adminEmail = 'stats.steward@archive.example';
    await db
      .prepare(
        'INSERT INTO users (email, display_name, role, added_by, added_at, last_login_at) VALUES (?, ?, ?, ?, ?, NULL)'
      )
      .bind(adminEmail, 'Stats Steward', 'admin', 'bootstrap', clock.nowIso())
      .run();

    const adminToken = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: adminEmail,
        display_name: 'Stats Steward',
        role: 'admin',
      },
    });
    const adminCookie = `${getSessionCookieName(true)}=${adminToken}`;

    const spaHtml = '<!doctype html><html><body><main id="app"></main></body></html>';
    const fakeAssets: Fetcher = {
      async fetch(): Promise<Response> {
        return new Response(spaHtml, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    };

    const env: KinloomWorkerEnv = {
      DB: db,
      MEDIA_BUCKET: bucket,
      ASSETS: fakeAssets,
      SESSION_SECRET: CONTRACT_SESSION_SECRET,
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      ARCHIVE_MODE: 'private',
    };

    // 1. Default Worker (no observability stats plugin): zero DB writes, 404 endpoints.
    const defaultWorker = createCloudflareWorker({ siteConfig, clock });
    const defaultHome = await defaultWorker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/`), env);
    expect(defaultHome.status).toBe(200);
    expect(await store.getTotalViews()).toBe(0);
    expect(
      (
        await defaultWorker.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}`, {
            headers: { cookie: adminCookie },
          }),
          env
        )
      ).status
    ).toBe(404);

    // 2. Opt-in Worker with createPageVisitStatsPlugin + createWorkersObservabilityPlugin:
    const waitUntilTasks: Promise<unknown>[] = [];
    const fakeCtx: ExecutionContext = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilTasks.push(promise);
      },
      passThroughOnException() {},
    };

    const worker = createCloudflareWorker({
      siteConfig,
      clock,
      plugins: [
        createWorkersObservabilityPlugin({ clock, sink: () => undefined }),
        createPageVisitStatsPlugin({ clock }),
      ],
    });

    // Trigger one cold /api/bundle miss before seeding entities (writes warm R2 cache automatically):
    expect(
      (
        await worker.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } }),
          env,
          fakeCtx
        )
      ).status
    ).toBe(200);

    // Seed one deceased person and one living person via real Worker API:
    const arthur = createSyntheticHistoricalPerson({
      id: 'per_arthur_worker',
      slug: 'arthur-worker',
      full_name: 'Arthur Worker',
    });
    const living = createSyntheticLivingPerson({
      id: 'per_living_worker',
      slug: 'living-worker-person',
      full_name: 'Living Worker Person',
    });

    for (const person of [arthur, living]) {
      const createRes = await worker.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie: adminCookie,
          },
          body: JSON.stringify({
            entity_id: person.id,
            data: person,
            summary: `Seed ${person.slug}`,
            has_primary_source: true,
          }),
        }),
        env,
        fakeCtx
      );
      expect(createRes.status).toBe(201);
    }

    // Record real HTML visits (deceased counted, living & bot skipped) via ctx.waitUntil:
    await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/`), env, fakeCtx);
    await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/person/arthur-worker`), env, fakeCtx);
    await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/person/arthur-worker`), env, fakeCtx);
    await worker.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/person/living-worker-person`), env, fakeCtx);
    await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/person/arthur-worker`, {
        headers: { 'user-agent': 'Googlebot/2.1' },
      }),
      env,
      fakeCtx
    );

    // Trigger warm /api/bundle hit and conditional 304 not_modified to populate observability_cache_daily:
    const warmBundleRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } }),
      env,
      fakeCtx
    );
    expect(warmBundleRes.status).toBe(200);
    const warmEtag = warmBundleRes.headers.get('etag') ?? '';
    expect(
      (
        await worker.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
            headers: { cookie: adminCookie, 'if-none-match': warmEtag },
          }),
          env,
          fakeCtx
        )
      ).status
    ).toBe(304);

    await Promise.all(waitUntilTasks);

    // Query GET /api/admin/observability/stats from D1:
    const statsRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}?window=30d`, {
        headers: { cookie: adminCookie },
      }),
      env
    );
    expect(statsRes.status).toBe(200);
    const statsText = await statsRes.text();
    expect(statsText).not.toContain('living-worker-person');
    expect(statsText).not.toContain('Living Worker Person');

    const stats = AdminObservabilityStatsResponseSchema.parse(JSON.parse(statsText));
    expect(stats.totals).toEqual({ views_7d: 3, views_30d: 3, views_all_time: 3 });
    expect(stats.bundle_revision).toBe(2);
    expect(stats.workers_observability_paired).toBe(true);
    expect(stats.cache).toEqual({
      hits: 1,
      misses: 1,
      not_modified: 1,
      total_requests: 3,
      hit_ratio: 0.667,
    });
    expect(stats.top_by_kind.people).toEqual([
      {
        route_key: '/person/arthur-worker',
        entity_kind: 'person',
        entity_slug: 'arthur-worker',
        title: 'Arthur Worker',
        views: 2,
      },
    ]);

    // Toggle show_public_visit_badges via D1-persisted #44 plugin settings and verify stateless persistence:
    const putPref = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/admin/plugin-settings/${PAGE_VISIT_STATS_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: CONTRACT_TEST_ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({ values: { show_public_visit_badges: true } }),
      }),
      env
    );
    expect(putPref.status).toBe(200);

    // Fresh Worker instance reads persisted D1 setting cleanly:
    const freshWorker = createCloudflareWorker({
      siteConfig,
      clock,
      plugins: [createPageVisitStatsPlugin({ clock })],
    });
    const publicCount = PublicPageVisitCountResponseSchema.parse(
      await (
        await freshWorker.fetch(
          new Request(
            `${CONTRACT_TEST_ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=person&slug=arthur-worker`
          ),
          env
        )
      ).json()
    );
    expect(publicCount.total_views).toBe(2);

    // Living person always returns 404 on public count endpoint:
    expect(
      (
        await freshWorker.fetch(
          new Request(
            `${CONTRACT_TEST_ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=person&slug=living-worker-person`
          ),
          env
        )
      ).status
    ).toBe(404);

    // Non-missing-table D1 error propagates from adapter and is fault-isolated by Worker:
    const throwingDb = {
      prepare() {
        throw new Error('D1 connection lost');
      },
    } as unknown as D1Database;
    const throwingStore = new D1PageVisitStatsStore(throwingDb);
    await expect(
      throwingStore.incrementVisit({
        routeKey: '/',
        entityKind: 'route',
        entitySlug: null,
        dayUtc: '2026-11-27',
      })
    ).rejects.toThrow('D1 connection lost');
    await expect(throwingStore.recordCacheEvent({ dayUtc: '2026-11-27', outcome: 'hit' })).rejects.toThrow(
      'D1 connection lost'
    );
    await expect(throwingStore.getTotalViews()).rejects.toThrow('D1 connection lost');
    await expect(throwingStore.getPageTotalViews('/')).rejects.toThrow('D1 connection lost');
    await expect(
      throwingStore.getDailySeries({ sinceDayUtc: '2026-11-21', untilDayUtc: '2026-11-27' })
    ).rejects.toThrow('D1 connection lost');
    await expect(throwingStore.getTopPages({ limit: 5 })).rejects.toThrow('D1 connection lost');
    await expect(throwingStore.getCacheTotals()).rejects.toThrow('D1 connection lost');
    await throwingStore.incrementVisit({
      routeKey: '/',
      entityKind: 'route',
      entitySlug: null,
      dayUtc: '2026-11-27',
      delta: 0,
    });
  });
});
