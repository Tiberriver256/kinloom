import type { Narrative, Place } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import type { FixedClock } from '../adapters/systemClock.js';
import { hasRequestLifecyclePlugins } from '../http/pluginLifecycle.js';
import { createKinloomServer } from '../http/router.js';
import { getSessionCookieName, signSessionToken } from '../http/session.js';
import {
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';
import {
  AdminObservabilityStatsResponseSchema,
  buildContiguousUtcDays,
  createPageVisitStatsPlugin,
  formatUtcDayBucket,
  InMemoryPageVisitStatsStore,
  isBotUserAgent,
  PAGE_VISIT_STATS_ADMIN_ROUTE,
  PAGE_VISIT_STATS_BEACON_ROUTE,
  PAGE_VISIT_STATS_CONFIG_ROUTE,
  PAGE_VISIT_STATS_PLUGIN_ID,
  PAGE_VISIT_STATS_PRIVACY_SUMMARY,
  PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE,
  type PageVisitStatsStore,
  PublicObservabilityConfigResponseSchema,
  PublicPageVisitCountResponseSchema,
  parseVisitRouteCandidate,
  staticRouteLabel,
} from './pageVisitStats.js';
import { createWorkersObservabilityPlugin } from './workersObservability.js';

const ORIGIN = 'https://alder.example.test';
const SECRET = 'kinloom-page-visit-stats-test-secret-0123456789';

async function createUserCookie(clock: FixedClock, role: 'admin' | 'editor', email: string): Promise<string> {
  const token = await signSessionToken({
    secret: SECRET,
    clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email,
      display_name: role === 'admin' ? 'Archive Steward' : 'Archive Editor',
      role,
    },
  });
  return `${getSessionCookieName(true)}=${token}`;
}

function createHtmlAssetHandler() {
  const html = '<!doctype html><html><body><main id="app"></main></body></html>';
  return {
    async fetch(req: Request): Promise<Response> {
      const pathname = new URL(req.url).pathname;
      if (pathname === '/assets/app.js') {
        return new Response('export const ok = true;', {
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        });
      }
      if (pathname === '/missing-page') {
        return new Response('Not Found', {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(req.method === 'HEAD' ? null : html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  };
}

function createSyntheticPlace(): Place {
  return {
    id: 'plc_oakridge_1850',
    slug: 'oakridge-ohio',
    name: 'Oakridge',
    full_name: 'Oakridge, Ohio, USA',
    place_type: 'town',
    lat: 40.1,
    lng: -82.9,
    parent_id: null,
  };
}

function createSyntheticNarrative(overrides: Partial<Narrative> = {}): Narrative {
  return {
    id: 'nar_mill_chronicle',
    slug: 'oakridge-mill-chronicle',
    title: 'The Oakridge Mill Chronicle',
    kind: 'family_story',
    body_md: 'Synthetic archival story text.',
    person_ids: ['per_arthur_alder'],
    place_ids: ['plc_oakridge_1850'],
    event_ids: [],
    source_ids: [],
    ...overrides,
  };
}

describe('Privacy-first Page Visit Stats plugin (Issue #39)', () => {
  it('stays completely off by default and inert when { enabled: false }: zero writes, 404 endpoints, unchanged /privacy', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const store = new InMemoryPageVisitStatsStore();
    await ports.repository.upsertUser({
      email: 'admin@archive.example',
      display_name: 'Archive Steward',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: ports.clock.nowIso(),
      last_login_at: null,
    });
    const adminCookie = await createUserCookie(ports.clock, 'admin', 'admin@archive.example');

    const disabledPlugin = createPageVisitStatsPlugin({ enabled: false, store });
    expect(disabledPlugin.id).toBe(PAGE_VISIT_STATS_PLUGIN_ID);
    expect(disabledPlugin.status).toBe('disabled');
    expect(disabledPlugin.routes).toBeUndefined();
    expect(hasRequestLifecyclePlugins([disabledPlugin])).toBe(false);
    expect(await disabledPlugin.getStatus?.()).toMatchObject({ status: 'disabled' });

    for (const plugins of [[], [disabledPlugin]]) {
      const server = createKinloomServer({
        siteConfig,
        ports: {
          ...ports,
          assetHandler: createHtmlAssetHandler(),
          pageVisitStatsStore: store,
          plugins,
        },
        sessionSecret: SECRET,
      });

      const homeRes = await server.fetch(new Request(`${ORIGIN}/`));
      expect(homeRes.status).toBe(200);
      expect(await store.getTotalViews()).toBe(0);

      // Admin stats endpoint returns 404 for both unauthenticated and admin callers when disabled.
      const unauthStats = await server.fetch(new Request(`${ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}`));
      expect(unauthStats.status).toBe(404);

      const adminStats = await server.fetch(
        new Request(`${ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}`, { headers: { cookie: adminCookie } })
      );
      expect(adminStats.status).toBe(404);

      const publicCount = await server.fetch(
        new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=person&slug=arthur-alder`)
      );
      expect(publicCount.status).toBe(404);

      const privacyHtml = await (await server.fetch(new Request(`${ORIGIN}/privacy`))).text();
      expect(privacyHtml).not.toContain(PAGE_VISIT_STATS_PRIVACY_SUMMARY);
    }
  });

  it('records aggregate visits per UTC day, excludes bots/prefetch/non-GET/living people, enforces admin RBAC, and integrates with #30 and #44', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-20T12:00:00.000Z' });
    const clock = ports.clock;

    await ports.repository.upsertUser({
      email: 'admin@archive.example',
      display_name: 'Archive Steward',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: clock.nowIso(),
      last_login_at: null,
    });
    await ports.repository.upsertUser({
      email: 'editor@archive.example',
      display_name: 'Archive Editor',
      role: 'editor',
      added_by: 'admin@archive.example',
      added_at: clock.nowIso(),
      last_login_at: null,
    });

    const deceased = createSyntheticHistoricalPerson({
      id: 'per_arthur_alder',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
    });
    const living = createSyntheticLivingPerson({
      id: 'per_clara_living',
      slug: 'clara-living-alder',
      full_name: 'Clara Living Alder',
    });
    const place = createSyntheticPlace();
    const publicNarrative = createSyntheticNarrative();
    const livingNarrative = createSyntheticNarrative({
      id: 'nar_living_memoir',
      slug: 'clara-private-memoir',
      title: 'Private Living Memoir',
      person_ids: ['per_clara_living'],
    });

    await ports.repository.commitAtomicMutations({
      batch_id: null,
      author: { author_id: 'system:seed', author_name: 'Seed', author_type: 'system_seed' },
      nowIso: clock.nowIso(),
      operations: [
        {
          entity_type: 'person',
          entity_id: deceased.id,
          slug: deceased.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed deceased person',
          has_primary_source: true,
          before_json: null,
          after_json: { ...deceased },
        },
        {
          entity_type: 'person',
          entity_id: living.id,
          slug: living.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed living person',
          has_primary_source: true,
          before_json: null,
          after_json: { ...living },
        },
        {
          entity_type: 'place',
          entity_id: place.id,
          slug: place.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed place',
          has_primary_source: true,
          before_json: null,
          after_json: { ...place },
        },
        {
          entity_type: 'narrative',
          entity_id: publicNarrative.id,
          slug: publicNarrative.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed public narrative',
          has_primary_source: true,
          before_json: null,
          after_json: { ...publicNarrative },
        },
        {
          entity_type: 'narrative',
          entity_id: livingNarrative.id,
          slug: livingNarrative.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed living-linked narrative',
          has_primary_source: true,
          before_json: null,
          after_json: { ...livingNarrative },
        },
      ],
    });

    const store = new InMemoryPageVisitStatsStore();
    const visitPlugin = createPageVisitStatsPlugin({ store, clock });
    const obsPlugin = createWorkersObservabilityPlugin({ clock, sink: () => undefined });

    const server = createKinloomServer({
      siteConfig,
      mode: 'public',
      ports: {
        ...ports,
        assetHandler: createHtmlAssetHandler(),
        plugins: [obsPlugin, visitPlugin],
      },
      sessionSecret: SECRET,
    });

    // Day 1 (2026-11-20, outside 7d window when today is 2026-11-27, inside 30d window):
    await server.fetch(new Request(`${ORIGIN}/person/arthur-alder`));
    await server.fetch(new Request(`${ORIGIN}/people/arthur-alder`));

    // Advance 7 days to 2026-11-27 before issuing fresh session tokens:
    clock.advanceMs(7 * 24 * 60 * 60 * 1000);
    const adminCookie = await createUserCookie(clock, 'admin', 'admin@archive.example');
    const editorCookie = await createUserCookie(clock, 'editor', 'editor@archive.example');

    // Valid visits on 2026-11-27:
    await server.fetch(new Request(`${ORIGIN}/`));
    await server.fetch(new Request(`${ORIGIN}/people`)); // normalizes to '/'
    await server.fetch(new Request(`${ORIGIN}/person/arthur-alder`));
    await server.fetch(new Request(`${ORIGIN}/place/oakridge-ohio`));
    await server.fetch(new Request(`${ORIGIN}/narrative/oakridge-mill-chronicle`));

    // Excluded visits (must record ZERO rows):
    await server.fetch(new Request(`${ORIGIN}/person/clara-living-alder`));
    await server.fetch(new Request(`${ORIGIN}/narrative/clara-private-memoir`));
    await server.fetch(new Request(`${ORIGIN}/person/does-not-exist-slug`));
    await server.fetch(new Request(`${ORIGIN}/place/unknown-place`));
    await server.fetch(new Request(`${ORIGIN}/narrative/unknown-narrative`));
    await server.fetch(
      new Request(`${ORIGIN}/person/arthur-alder`, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
      })
    );
    await server.fetch(
      new Request(`${ORIGIN}/person/arthur-alder`, {
        headers: { 'user-agent': 'curl/8.7.1' },
      })
    );
    await server.fetch(
      new Request(`${ORIGIN}/person/arthur-alder`, {
        headers: { purpose: 'prefetch' },
      })
    );
    await server.fetch(
      new Request(`${ORIGIN}/person/arthur-alder`, {
        headers: { 'sec-purpose': 'prefetch' },
      })
    );
    await server.fetch(new Request(`${ORIGIN}/person/arthur-alder`, { method: 'HEAD' }));
    await server.fetch(new Request(`${ORIGIN}/assets/app.js`));
    await server.fetch(new Request(`${ORIGIN}/missing-page`));
    await server.fetch(new Request(`${ORIGIN}/admin`));

    // Trigger bundle cache telemetry (miss -> hit -> not_modified) while paired with #30:
    const bundle1 = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } })
    );
    expect(bundle1.status).toBe(200);
    const etag = bundle1.headers.get('etag') ?? '';
    const bundle2 = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: adminCookie } })
    );
    expect(bundle2.status).toBe(200);
    const bundle3 = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: adminCookie, 'if-none-match': etag } })
    );
    expect(bundle3.status).toBe(304);

    // RBAC checks on GET /api/admin/observability/stats:
    const unauthRes = await server.fetch(new Request(`${ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}`));
    expect(unauthRes.status).toBe(401);

    const editorRes = await server.fetch(
      new Request(`${ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}`, { headers: { cookie: editorCookie } })
    );
    expect(editorRes.status).toBe(403);
    expect(((await editorRes.json()) as { error: { code: string } }).error.code).toBe('ADMIN_REQUIRED');

    const badWindowRes = await server.fetch(
      new Request(`${ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}?window=999d`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(badWindowRes.status).toBe(400);

    const badSubpathRes = await server.fetch(
      new Request(`${ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}/extra`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(badSubpathRes.status).toBe(404);

    // Manually poison the store with a living-person row to verify defense-in-depth read filtering!
    await store.incrementVisit({
      routeKey: '/person/clara-living-alder',
      entityKind: 'person',
      entitySlug: 'clara-living-alder',
      dayUtc: '2026-11-27',
      delta: 99,
    });

    const statsRes = await server.fetch(
      new Request(`${ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}?window=30d`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(statsRes.status).toBe(200);
    expect(statsRes.headers.get('cache-control')).toBe('no-store');
    const rawStatsText = await statsRes.text();
    expect(rawStatsText).not.toContain('clara-living-alder');
    expect(rawStatsText).not.toContain('Clara Living Alder');
    expect(rawStatsText).not.toContain('clara-private-memoir');

    const stats = AdminObservabilityStatsResponseSchema.parse(JSON.parse(rawStatsText));
    expect(stats.window).toBe('30d');
    expect(stats.privacy_mode).toBe('aggregate-cookie-free');
    expect(stats.public_badges_enabled).toBe(false);
    expect(stats.bundle_revision).toBe(5);
    expect(stats.workers_observability_paired).toBe(true);
    expect(stats.cache).toEqual({
      hits: 1,
      misses: 1,
      not_modified: 1,
      total_requests: 3,
      hit_ratio: 0.667,
    });
    expect(stats.daily_trend).toHaveLength(30);
    expect(stats.top_by_kind.people).toEqual([
      {
        route_key: '/person/arthur-alder',
        entity_kind: 'person',
        entity_slug: 'arthur-alder',
        title: 'Arthur Alder',
        views: 3,
      },
    ]);
    expect(stats.top_by_kind.places).toEqual([
      {
        route_key: '/place/oakridge-ohio',
        entity_kind: 'place',
        entity_slug: 'oakridge-ohio',
        title: 'Oakridge, Ohio, USA',
        views: 1,
      },
    ]);
    expect(stats.top_by_kind.narratives).toEqual([
      {
        route_key: '/narrative/oakridge-mill-chronicle',
        entity_kind: 'narrative',
        entity_slug: 'oakridge-mill-chronicle',
        title: 'The Oakridge Mill Chronicle',
        views: 1,
      },
    ]);

    // 7d window excludes the 2 views from 2026-11-20 (7 days earlier):
    const stats7d = AdminObservabilityStatsResponseSchema.parse(
      await (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_ADMIN_ROUTE}?window=7d`, {
            headers: { cookie: adminCookie },
          })
        )
      ).json()
    );
    expect(stats7d.daily_trend).toHaveLength(7);
    expect(stats7d.top_by_kind.people[0]?.views).toBe(1);

    // Public single-page count endpoint is 404 while badges are disabled:
    const disabledBadgeRes = await server.fetch(
      new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=person&slug=arthur-alder`)
    );
    expect(disabledBadgeRes.status).toBe(404);

    // Toggle public badges ON via #44 plugin settings endpoint:
    const enableRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PAGE_VISIT_STATS_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          cookie: adminCookie,
        },
        body: JSON.stringify({
          values: {
            show_public_visit_badges: true,
            default_window: '7d',
          },
        }),
      })
    );
    expect(enableRes.status).toBe(200);
    expect(await visitPlugin.getStatus?.()).toMatchObject({
      status: 'active',
      detail: 'aggregate-counts, public-badges',
    });

    // Public single-page count now works for deceased person, place, and public narrative (via kind+slug or path):
    const personBadge = PublicPageVisitCountResponseSchema.parse(
      await (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=person&slug=arthur-alder`)
        )
      ).json()
    );
    expect(personBadge).toEqual({
      route_key: '/person/arthur-alder',
      entity_kind: 'person',
      entity_slug: 'arthur-alder',
      total_views: 3,
    });

    const placeBadge = PublicPageVisitCountResponseSchema.parse(
      await (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?path=/place/oakridge-ohio`)
        )
      ).json()
    );
    expect(placeBadge.total_views).toBe(1);

    const narrativeBadge = PublicPageVisitCountResponseSchema.parse(
      await (
        await server.fetch(
          new Request(
            `${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=narrative&slug=oakridge-mill-chronicle`
          )
        )
      ).json()
    );
    expect(narrativeBadge.total_views).toBe(1);

    // Living person, living-linked narrative, unknown slug, bad query, and extra path still return 404/400:
    expect(
      (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=person&slug=clara-living-alder`)
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request(
            `${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=narrative&slug=clara-private-memoir`
          )
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=person&slug=missing-slug`)
        )
      ).status
    ).toBe(404);
    expect((await server.fetch(new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}`))).status).toBe(
      400
    );
    expect(
      (await server.fetch(new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}/extra`))).status
    ).toBe(404);

    // /privacy includes truthful disclosure while keeping zero-ads bullet:
    const privacyHtml = await (await server.fetch(new Request(`${ORIGIN}/privacy`))).text();
    expect(privacyHtml).toContain(PAGE_VISIT_STATS_PRIVACY_SUMMARY);
    expect(privacyHtml).toContain('This archive serves zero advertisements.');
  });

  it('uses waitUntil without blocking responses and fault-isolates storage and reporter failures', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const reported: Array<{ pluginId: string; message: string }> = [];

    const brokenStore: PageVisitStatsStore = {
      adapterKind: 'broken-test',
      async incrementVisit() {
        throw new Error('D1 write timeout');
      },
      async getDailySeries() {
        return [];
      },
      async getTopPages() {
        return [];
      },
      async getTotalViews() {
        return 0;
      },
      async getPageTotalViews() {
        return 0;
      },
    };

    const server = createKinloomServer({
      siteConfig,
      mode: 'public',
      ports: {
        ...ports,
        assetHandler: createHtmlAssetHandler(),
        plugins: [createPageVisitStatsPlugin({ store: brokenStore, clock: ports.clock })],
      },
      sessionSecret: SECRET,
      onPluginError: (pluginId, error) => {
        reported.push({ pluginId, message: error instanceof Error ? error.message : String(error) });
      },
    });

    const waitUntilTasks: Promise<unknown>[] = [];
    const res = await server.fetch(new Request(`${ORIGIN}/`), {
      waitUntil: (promise) => {
        waitUntilTasks.push(promise);
      },
    });
    expect(res.status).toBe(200);
    expect(waitUntilTasks).toHaveLength(1);
    await Promise.all(waitUntilTasks);
    expect(reported).toEqual([{ pluginId: PAGE_VISIT_STATS_PLUGIN_ID, message: 'D1 write timeout' }]);

    // Even when onPluginError itself throws, response stays 200.
    const throwingReporterServer = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        assetHandler: createHtmlAssetHandler(),
        plugins: [createPageVisitStatsPlugin({ store: brokenStore })],
      },
      sessionSecret: SECRET,
      onPluginError: () => {
        throw new Error('reporter exploded');
      },
    });
    const safeRes = await throwingReporterServer.fetch(new Request(`${ORIGIN}/`));
    expect(safeRes.status).toBe(200);
  });

  it('covers pure rule helpers and InMemoryPageVisitStatsStore edge cases', async () => {
    expect(formatUtcDayBucket('2026-11-27T08:15:00Z')).toBe('2026-11-27');
    expect(formatUtcDayBucket('Nov 27, 2026 UTC')).toBe('2026-11-27');
    expect(formatUtcDayBucket('not-a-date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(buildContiguousUtcDays('2026-11-27', 3)).toEqual(['2026-11-25', '2026-11-26', '2026-11-27']);
    expect(isBotUserAgent(null)).toBe(false);
    expect(isBotUserAgent('   ')).toBe(false);
    expect(isBotUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe(false);
    expect(isBotUserAgent('GPTBot/1.2')).toBe(true);
    expect(parseVisitRouteCandidate('/timeline')).toEqual({
      kind: 'route',
      routeKey: '/time',
      label: 'Historical Timeline',
    });
    expect(parseVisitRouteCandidate('/person/%E0%A4%A')).toBeNull();
    expect(parseVisitRouteCandidate('/person/bad slug!')).toBeNull();
    expect(parseVisitRouteCandidate('/a/b/c')).toBeNull();
    expect(parseVisitRouteCandidate('/unknown/slug')).toBeNull();
    expect(staticRouteLabel('/tree')).toBe('Family Tree');
    expect(staticRouteLabel('/custom')).toBe('/custom');

    const mem = new InMemoryPageVisitStatsStore();
    await mem.incrementVisit({
      routeKey: '/',
      entityKind: 'route',
      entitySlug: null,
      dayUtc: '2026-11-27',
      delta: 0,
    });
    expect(await mem.getTotalViews()).toBe(0);
    await mem.incrementVisit({
      routeKey: '/',
      entityKind: 'route',
      entitySlug: null,
      dayUtc: '2026-11-27',
      delta: 2,
    });
    await mem.recordCacheEvent({ dayUtc: '2026-11-27', outcome: 'hit' });
    await mem.recordCacheEvent({ dayUtc: '2026-11-20', outcome: 'miss' });
    expect(await mem.getCacheTotals({ sinceDayUtc: '2026-11-25' })).toEqual({
      hits: 1,
      misses: 0,
      not_modified: 0,
    });
    mem.clear();
    expect(await mem.getTotalViews()).toBe(0);
  });

  it('enforces archive_read, private-mode unauthenticated suppression, config endpoint, SPA beacon, and read_backup media access', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-27T12:00:00.000Z' });
    const clock = ports.clock;

    await ports.repository.upsertUser({
      email: 'admin@archive.example',
      display_name: 'Archive Admin',
      role: 'admin',
      added_by: 'system:bootstrap',
      added_at: '2026-01-01T00:00:00.000Z',
      last_login_at: null,
    });
    const rawBackupToken = 'kinloom_read_backup_media_probe_token';
    const { sha256Hex } = await import('../crypto.js');
    await ports.repository.createAgentToken({
      token_id: 'tok_probe_read',
      label: 'Read Backup Probe',
      scope: 'read_backup',
      token_hash: await sha256Hex(rawBackupToken),
      created_by: 'admin@archive.example',
      created_at: '2026-01-01T00:00:00.000Z',
      revoked_at: null,
    });

    const deceased = createSyntheticHistoricalPerson({
      id: 'per_ada',
      slug: 'ada-alder',
      full_name: 'Ada Alder',
    });
    const living = createSyntheticLivingPerson({
      id: 'per_living_priv',
      slug: 'living-private',
      full_name: 'Living Private',
    });
    const place: Place = {
      ...createSyntheticPlace(),
      id: 'plc_harbor',
      slug: 'harbor-town',
      name: 'Harbor Town',
      full_name: 'Harbor Town, Maine',
    };
    await ports.repository.commitAtomicMutations({
      batch_id: null,
      author: { author_id: 'admin@archive.example', author_name: 'Archive Admin', author_type: 'human' },
      nowIso: '2026-11-27T11:00:00.000Z',
      operations: [
        {
          entity_type: 'person',
          entity_id: deceased.id,
          slug: deceased.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed deceased',
          has_primary_source: true,
          before_json: null,
          after_json: { ...deceased },
        },
        {
          entity_type: 'person',
          entity_id: living.id,
          slug: living.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed living',
          has_primary_source: true,
          before_json: null,
          after_json: { ...living },
        },
        {
          entity_type: 'place',
          entity_id: place.id,
          slug: place.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed place',
          has_primary_source: true,
          before_json: null,
          after_json: { ...place },
        },
      ],
    });

    // Seed one media object to verify read_backup agent scope on GET /media/*
    const mediaBytes = new Uint8Array([1, 2, 3, 4]);
    await ports.mediaStore.put({
      key: 'media/sample.bin',
      body: mediaBytes.buffer,
      contentType: 'application/octet-stream',
      sha256: await sha256Hex('sample'),
    });

    let snapshotLoads = 0;
    const origLoadSnapshot = ports.repository.loadActiveSnapshot.bind(ports.repository);
    ports.repository.loadActiveSnapshot = async () => {
      snapshotLoads += 1;
      return origLoadSnapshot();
    };

    const store = new InMemoryPageVisitStatsStore();
    const visitPlugin = createPageVisitStatsPlugin({ store, clock, publicVisitBadges: true });
    const server = createKinloomServer({
      siteConfig,
      mode: 'private',
      ports: {
        ...ports,
        assetHandler: createHtmlAssetHandler(),
        plugins: [visitPlugin],
      },
      sessionSecret: SECRET,
    });

    // Unauthenticated HTML GET on private archive must NOT inflate visit counts (P1-5)
    expect((await server.fetch(new Request(`${ORIGIN}/person/ada-alder`))).status).toBe(200);
    expect(await store.getTotalViews()).toBe(0);

    // Unauthenticated observability endpoints return 401 on private archive (P1-4)
    expect((await server.fetch(new Request(`${ORIGIN}${PAGE_VISIT_STATS_CONFIG_ROUTE}`))).status).toBe(401);
    expect(
      (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=person&slug=ada-alder`)
        )
      ).status
    ).toBe(401);
    expect(
      (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_BEACON_ROUTE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body: JSON.stringify({ path: '/person/ada-alder' }),
          })
        )
      ).status
    ).toBe(401);

    // read_backup agent token can access GET /media/* and GET /api/observability/config
    const mediaRes = await server.fetch(
      new Request(`${ORIGIN}/media/sample.bin`, {
        headers: { authorization: `Bearer ${rawBackupToken}` },
      })
    );
    expect(mediaRes.status).toBe(200);

    const cfgRes = await server.fetch(
      new Request(`${ORIGIN}${PAGE_VISIT_STATS_CONFIG_ROUTE}`, {
        headers: { authorization: `Bearer ${rawBackupToken}` },
      })
    );
    expect(cfgRes.status).toBe(200);
    expect(cfgRes.headers.get('cache-control')).toBe('private, no-cache');
    expect(PublicObservabilityConfigResponseSchema.parse(await cfgRes.json())).toEqual({
      enabled: true,
      public_badges_enabled: true,
      record_spa_beacons: true,
    });

    // Authenticated HTML GET on private archive records 1 visit
    const adminCookie = await createUserCookie(clock, 'admin', 'admin@archive.example');
    expect(
      (await server.fetch(new Request(`${ORIGIN}/person/ada-alder`, { headers: { cookie: adminCookie } })))
        .status
    ).toBe(200);
    expect(await store.getPageTotalViews('/person/ada-alder')).toBe(1);

    // SPA beacon records deceased person, place, and static route, while skipping living, /admin, bots, prefetch
    const sendBeacon = (path: string, extraHeaders?: Record<string, string>) =>
      server.fetch(
        new Request(`${ORIGIN}${PAGE_VISIT_STATS_BEACON_ROUTE}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            cookie: adminCookie,
            ...extraHeaders,
          },
          body: JSON.stringify({ path }),
        })
      );

    expect((await sendBeacon('/person/ada-alder')).status).toBe(204);
    expect((await sendBeacon('/place/harbor-town')).status).toBe(204);
    expect((await sendBeacon('/tree')).status).toBe(204);
    expect((await sendBeacon('/person/living-private')).status).toBe(204);
    expect((await sendBeacon('/admin')).status).toBe(204);
    expect((await sendBeacon('/person/ada-alder', { 'user-agent': 'Googlebot/2.1' })).status).toBe(204);
    expect((await sendBeacon('/person/ada-alder', { 'sec-purpose': 'prefetch' })).status).toBe(204);

    // Invalid beacon body returns 400; cross-origin cookie beacon returns 403 CSRF
    expect(
      (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_BEACON_ROUTE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
            body: 'not-json',
          })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_BEACON_ROUTE}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'https://evil.example',
              cookie: adminCookie,
            },
            body: JSON.stringify({ path: '/tree' }),
          })
        )
      ).status
    ).toBe(403);

    expect(await store.getPageTotalViews('/person/ada-alder')).toBe(2);
    expect(await store.getPageTotalViews('/place/harbor-town')).toBe(1);
    expect(await store.getPageTotalViews('/tree')).toBe(1);
    expect(await store.getPageTotalViews('/person/living-private')).toBe(0);

    // Badge read returns private, no-cache and exact count without full snapshot scan!
    const badgeRes = await server.fetch(
      new Request(`${ORIGIN}${PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE}?kind=person&slug=ada-alder`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(badgeRes.status).toBe(200);
    expect(badgeRes.headers.get('cache-control')).toBe('private, no-cache');
    expect(PublicPageVisitCountResponseSchema.parse(await badgeRes.json()).total_views).toBe(2);
    expect(snapshotLoads).toBe(0);

    // Extra subpaths return 404; schema-invalid beacon body returns 400
    expect(
      (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_CONFIG_ROUTE}/extra`, {
            headers: { cookie: adminCookie },
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_BEACON_ROUTE}/extra`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
            body: JSON.stringify({ path: '/tree' }),
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await server.fetch(
          new Request(`${ORIGIN}${PAGE_VISIT_STATS_BEACON_ROUTE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
            body: JSON.stringify({ path: '' }),
          })
        )
      ).status
    ).toBe(400);

    // Public narrative and living-linked narrative via beacon + public mode Cache-Control + catalog fallback
    const publicNarrative = createSyntheticNarrative({
      id: 'nar_public_beacon',
      slug: 'public-beacon-story',
      title: 'Public Beacon Story',
      person_ids: [deceased.id],
    });
    const livingNarrative = createSyntheticNarrative({
      id: 'nar_living_beacon',
      slug: 'living-beacon-story',
      title: 'Living Beacon Story',
      person_ids: [living.id],
    });
    await ports.repository.commitAtomicMutations({
      batch_id: null,
      author: { author_id: 'admin@archive.example', author_name: 'Archive Admin', author_type: 'human' },
      nowIso: '2026-11-27T11:30:00.000Z',
      operations: [
        {
          entity_type: 'narrative',
          entity_id: publicNarrative.id,
          slug: publicNarrative.slug ?? publicNarrative.id,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed public narrative',
          has_primary_source: true,
          before_json: null,
          after_json: { ...publicNarrative },
        },
        {
          entity_type: 'narrative',
          entity_id: livingNarrative.id,
          slug: livingNarrative.slug ?? livingNarrative.id,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed living narrative',
          has_primary_source: true,
          before_json: null,
          after_json: { ...livingNarrative },
        },
      ],
    });

    expect((await sendBeacon('/narrative/public-beacon-story')).status).toBe(204);
    expect((await sendBeacon('/narrative/living-beacon-story')).status).toBe(204);
    expect(await store.getPageTotalViews('/narrative/public-beacon-story')).toBe(1);
    expect(await store.getPageTotalViews('/narrative/living-beacon-story')).toBe(0);

    // Public mode serves GET /api/observability/config with Cache-Control: no-cache and handles repositories without getEntityBySlug
    const fallbackRepo = {
      ...ports.repository,
    };
    const publicStore = new InMemoryPageVisitStatsStore();
    const publicServer = createKinloomServer({
      siteConfig,
      mode: 'public',
      ports: {
        ...ports,
        repository: fallbackRepo,
        assetHandler: createHtmlAssetHandler(),
        plugins: [
          createPageVisitStatsPlugin({
            store: publicStore,
            publicVisitBadges: true,
          }),
        ],
      },
      sessionSecret: SECRET,
    });

    const publicCfgRes = await publicServer.fetch(new Request(`${ORIGIN}${PAGE_VISIT_STATS_CONFIG_ROUTE}`));
    expect(publicCfgRes.status).toBe(200);
    expect(publicCfgRes.headers.get('cache-control')).toBe('no-cache');

    for (const fallbackPath of [
      '/person/ada-alder',
      '/place/harbor-town',
      '/narrative/public-beacon-story',
      '/person/missing-person',
    ]) {
      const r = await publicServer.fetch(
        new Request(`${ORIGIN}${PAGE_VISIT_STATS_BEACON_ROUTE}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ path: fallbackPath }),
        })
      );
      expect(r.status).toBe(204);
    }
    expect(await publicStore.getPageTotalViews('/person/ada-alder')).toBe(1);
    expect(await publicStore.getPageTotalViews('/place/harbor-town')).toBe(1);
    expect(await publicStore.getPageTotalViews('/narrative/public-beacon-story')).toBe(1);
  });
});
