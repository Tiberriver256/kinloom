import type { Narrative, Person } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createHttpObservabilityStatsClient } from '../adapters/observabilityStatsClient.js';
import {
  buildDailyTrendChartGeometry,
  formatCacheHitRatio,
  formatEntityKindLabel,
  formatShortUtcDay,
  formatVisitBadgeLabel,
  formatVisitCount,
  isDeceasedPersonForBadge,
  isPublicNarrativeForBadge,
  parseAdminObservabilityStats,
  parsePublicPageVisitCount,
  selectTopPagesByCategory,
  type UiAdminObservabilityStats,
} from './observabilityStatsModel.js';

function makeValidStats(): UiAdminObservabilityStats {
  return {
    generated_at: '2026-11-27T12:00:00.000Z',
    window: '7d',
    privacy_mode: 'aggregate-cookie-free',
    public_badges_enabled: true,
    bundle_revision: 12,
    workers_observability_paired: true,
    totals: {
      views_7d: 42,
      views_30d: 128,
      views_all_time: 512,
    },
    cache: {
      hits: 8,
      misses: 2,
      not_modified: 0,
      total_requests: 10,
      hit_ratio: 0.8,
    },
    daily_trend: [
      { day_utc: '2026-11-21', views: 0 },
      { day_utc: '2026-11-22', views: 5 },
      { day_utc: '2026-11-23', views: 12 },
      { day_utc: '2026-11-24', views: 3 },
      { day_utc: '2026-11-25', views: 8 },
      { day_utc: '2026-11-26', views: 6 },
      { day_utc: '2026-11-27', views: 8 },
    ],
    top_pages: [
      { route_key: '/', entity_kind: 'route', entity_slug: null, title: 'Archive Home', views: 20 },
      {
        route_key: '/person/arthur-alder',
        entity_kind: 'person',
        entity_slug: 'arthur-alder',
        title: 'Arthur Alder',
        views: 15,
      },
    ],
    top_by_kind: {
      people: [
        {
          route_key: '/person/arthur-alder',
          entity_kind: 'person',
          entity_slug: 'arthur-alder',
          title: 'Arthur Alder',
          views: 15,
        },
      ],
      places: [
        {
          route_key: '/place/oakridge-ohio',
          entity_kind: 'place',
          entity_slug: 'oakridge-ohio',
          title: 'Oakridge, Ohio',
          views: 4,
        },
      ],
      narratives: [
        {
          route_key: '/narrative/mill-story',
          entity_kind: 'narrative',
          entity_slug: 'mill-story',
          title: 'Mill Story',
          views: 3,
        },
      ],
    },
  };
}

describe('observabilityStatsModel pure helpers and HTTP adapter', () => {
  it('parses valid payloads and rejects malformed admin/public payloads cleanly', () => {
    const valid = makeValidStats();
    expect(parseAdminObservabilityStats(valid)).toEqual(valid);
    expect(() => parseAdminObservabilityStats(null)).toThrow(/JSON object/);
    expect(() => parseAdminObservabilityStats({ ...valid, window: '1y' })).toThrow(/window/);
    expect(() => parseAdminObservabilityStats({ ...valid, privacy_mode: 'cookies' })).toThrow(/privacy_mode/);
    expect(() => parseAdminObservabilityStats({ ...valid, totals: null })).toThrow(/totals/);
    expect(() => parseAdminObservabilityStats({ ...valid, cache: null })).toThrow(/cache/);
    expect(() => parseAdminObservabilityStats({ ...valid, top_by_kind: null })).toThrow(/top_by_kind/);
    expect(() => parseAdminObservabilityStats({ ...valid, cache: { ...valid.cache, hit_ratio: 2 } })).toThrow(
      /hit_ratio/
    );
    expect(() => parseAdminObservabilityStats({ ...valid, daily_trend: 'bad' })).toThrow(/daily_trend/);
    expect(() =>
      parseAdminObservabilityStats({ ...valid, daily_trend: [{ day_utc: 'bad', views: 1 }] })
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      parseAdminObservabilityStats({
        ...valid,
        top_pages: [{ route_key: '/', entity_kind: 'bad', entity_slug: null, title: 'x', views: 1 }],
      })
    ).toThrow(/entity_kind/);

    expect(
      parsePublicPageVisitCount({
        route_key: '/person/arthur-alder',
        entity_kind: 'person',
        entity_slug: 'arthur-alder',
        total_views: 5,
      })
    ).toEqual({
      route_key: '/person/arthur-alder',
      entity_kind: 'person',
      entity_slug: 'arthur-alder',
      total_views: 5,
    });
    expect(parsePublicPageVisitCount(null)).toBeNull();
    expect(parsePublicPageVisitCount({ entity_kind: 'route' })).toBeNull();
    expect(
      parsePublicPageVisitCount({ entity_kind: 'person', route_key: '', entity_slug: 'a', total_views: 1 })
    ).toBeNull();
  });

  it('computes SVG chart geometry, labels, category slices, and living-person badge guards', () => {
    const stats = makeValidStats();
    const geom = buildDailyTrendChartGeometry(stats.daily_trend);
    expect(geom.peakViews).toBe(12);
    expect(geom.totalViews).toBe(42);
    expect(geom.bars).toHaveLength(7);
    expect(geom.bars[0]?.height).toBe(2);
    expect(geom.bars[2]?.y).toBe(geom.chartTop);

    const emptyGeom = buildDailyTrendChartGeometry([]);
    expect(emptyGeom.bars).toEqual([]);
    expect(emptyGeom.peakViews).toBe(0);

    const zeroGeom = buildDailyTrendChartGeometry([{ day_utc: '2026-11-27', views: 0 }]);
    expect(zeroGeom.bars[0]?.height).toBe(2);

    expect(formatShortUtcDay('2026-11-27')).toBe('11/27');
    expect(formatShortUtcDay('invalid')).toBe('invalid');
    expect(formatVisitCount(1234)).toBe('1,234');
    expect(formatVisitCount(-5)).toBe('0');
    expect(formatVisitBadgeLabel(1)).toBe('1 visit');
    expect(formatVisitBadgeLabel(4)).toBe('4 visits');
    expect(formatCacheHitRatio(stats.cache, true)).toBe('80% (8/10)');
    expect(
      formatCacheHitRatio({ hits: 0, misses: 0, not_modified: 0, total_requests: 0, hit_ratio: null }, true)
    ).toBe('No bundle traffic yet');
    expect(
      formatCacheHitRatio({ hits: 0, misses: 0, not_modified: 0, total_requests: 0, hit_ratio: null }, false)
    ).toBe('Pair with #30 plugin');

    expect(formatEntityKindLabel('person')).toBe('Ancestor');
    expect(formatEntityKindLabel('place')).toBe('Place');
    expect(formatEntityKindLabel('narrative')).toBe('Narrative');
    expect(formatEntityKindLabel('route')).toBe('Archive Page');

    expect(selectTopPagesByCategory(stats, 'all')).toEqual(stats.top_pages);
    expect(selectTopPagesByCategory(stats, 'people')).toEqual(stats.top_by_kind.people);
    expect(selectTopPagesByCategory(stats, 'places')).toEqual(stats.top_by_kind.places);
    expect(selectTopPagesByCategory(stats, 'narratives')).toEqual(stats.top_by_kind.narratives);

    const deceased = {
      id: 'p1',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      is_living: false,
    } as Person;
    const living = { id: 'p2', slug: 'clara-living', full_name: 'Clara Living', is_living: true } as Person;
    const redacted = { id: 'p3', slug: 'redacted', full_name: 'Living', is_living: false } as Person;

    expect(isDeceasedPersonForBadge(undefined)).toBe(false);
    expect(isDeceasedPersonForBadge(deceased)).toBe(true);
    expect(isDeceasedPersonForBadge(living)).toBe(false);
    expect(isDeceasedPersonForBadge(redacted)).toBe(false);

    const publicNar = { id: 'n1', slug: 'mill-story', title: 'Mill', person_ids: ['p1'] } as Narrative;
    const livingNar = { id: 'n2', slug: 'living-story', title: 'Priv', person_ids: ['p2'] } as Narrative;
    expect(isPublicNarrativeForBadge(undefined, deceased, [deceased, living])).toBe(false);
    expect(isPublicNarrativeForBadge(publicNar, deceased, [deceased, living])).toBe(true);
    expect(isPublicNarrativeForBadge(publicNar, living, [deceased, living])).toBe(false);
    expect(isPublicNarrativeForBadge(livingNar, deceased, [deceased, living])).toBe(false);
  });

  it('routes HTTP client requests cleanly for 200, 404, 403, invalid JSON, and toggle saves', async () => {
    const validStats = makeValidStats();
    const calls: string[] = [];

    const client = createHttpObservabilityStatsClient({
      apiBaseUrl: 'https://alder.example.test/',
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.includes('/api/admin/observability/stats?window=7d')) {
          return new Response(JSON.stringify(validStats), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/admin/observability/stats?window=30d')) {
          return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Disabled' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/admin/observability/stats?window=all')) {
          return new Response(JSON.stringify({ broken: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/admin/plugin-settings/kinloom-page-visit-stats')) {
          return new Response(JSON.stringify({ plugin: { values: { show_public_visit_badges: true } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('slug=arthur-alder')) {
          return new Response(
            JSON.stringify({
              route_key: '/person/arthur-alder',
              entity_kind: 'person',
              entity_slug: 'arthur-alder',
              total_views: 15,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.includes('slug=network-fail')) {
          throw new Error('network down');
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    expect(await client.getAdminStats('7d')).toEqual(validStats);
    expect(await client.getAdminStats('30d')).toBeNull();
    await expect(client.getAdminStats('all')).rejects.toThrow(/Invalid observability stats payload/);
    expect(await client.setPublicBadgesEnabled(true)).toBe(true);
    expect(await client.getPublicPageVisitCount({ kind: 'person', slug: 'arthur-alder' })).toEqual({
      route_key: '/person/arthur-alder',
      entity_kind: 'person',
      entity_slug: 'arthur-alder',
      total_views: 15,
    });
    expect(await client.getPublicPageVisitCount({ kind: 'person', slug: 'missing' })).toBeNull();
    expect(await client.getPublicPageVisitCount({ kind: 'person', slug: 'network-fail' })).toBeNull();
    expect(calls[0]).toBe('GET https://alder.example.test/api/admin/observability/stats?window=7d');
  });
});
