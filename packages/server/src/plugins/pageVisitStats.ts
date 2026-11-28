import {
  type ArchiveRepository,
  type Clock,
  type KinloomServerPluginReadonlySettingsContext,
  type PluginSettingScalarValue,
  type PluginSettingsSchema,
  parseEntityPayload,
} from '@kinloom/core';
import { KinloomHttpError } from '../errors.js';
import { jsonResponse } from '../http/httpPrimitives.js';
import type {
  KinloomServerPlugin,
  KinloomServerPorts,
  ServerRequestResponseEvent,
} from '../http/pluginLifecycle.js';
import { KINLOOM_SERVER_VERSION } from '../version.js';
import {
  buildEntityRouteKey,
  computeCacheSummary,
  fillDailySeries,
  formatUtcDayBucket,
  isBotUserAgent,
  isPrefetchRequest,
  parseVisitRouteCandidate,
  shiftUtcDay,
  shouldRecordPageVisit,
  staticRouteLabel,
  trendLengthForWindow,
  windowSinceDayUtc,
} from './pageVisitStatsRules.js';
import { InMemoryPageVisitStatsStore } from './pageVisitStatsStore.js';
import {
  type AdminObservabilityStatsResponse,
  AdminObservabilityStatsResponseSchema,
  type ObservabilityStatsWindow,
  ObservabilityStatsWindowSchema,
  PAGE_VISIT_STATS_ADMIN_ROUTE,
  PAGE_VISIT_STATS_BEACON_ROUTE,
  PAGE_VISIT_STATS_CONFIG_ROUTE,
  PAGE_VISIT_STATS_PLUGIN_ID,
  PAGE_VISIT_STATS_PRIVACY_DISCLOSURE_ID,
  PAGE_VISIT_STATS_PRIVACY_SUMMARY,
  PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE,
  PageVisitBeaconRequestSchema,
  type PageVisitEntityKind,
  type PageVisitStatsStore,
  type PageVisitTopRow,
  type PublicObservabilityConfigResponse,
  PublicObservabilityConfigResponseSchema,
  type PublicPageVisitCountResponse,
  PublicPageVisitCountResponseSchema,
  type TopVisitedPage,
} from './pageVisitStatsTypes.js';

export {
  buildContiguousUtcDays,
  buildEntityRouteKey,
  computeCacheSummary,
  fillDailySeries,
  formatUtcDayBucket,
  isBotUserAgent,
  isPrefetchRequest,
  type ParsedVisitCandidate,
  parseVisitRouteCandidate,
  shiftUtcDay,
  shouldRecordPageVisit,
  staticRouteLabel,
  trendLengthForWindow,
  windowSinceDayUtc,
} from './pageVisitStatsRules.js';
export { InMemoryPageVisitStatsStore } from './pageVisitStatsStore.js';
export {
  type AdminObservabilityStatsResponse,
  AdminObservabilityStatsResponseSchema,
  type DailyVisitPoint,
  DailyVisitPointSchema,
  type ObservabilityCacheOutcome,
  type ObservabilityCacheSummary,
  ObservabilityCacheSummarySchema,
  type ObservabilityCacheTotals,
  type ObservabilityStatsWindow,
  ObservabilityStatsWindowSchema,
  PAGE_VISIT_STATS_ADMIN_ROUTE,
  PAGE_VISIT_STATS_BEACON_ROUTE,
  PAGE_VISIT_STATS_CONFIG_ROUTE,
  PAGE_VISIT_STATS_PLUGIN_ID,
  PAGE_VISIT_STATS_PRIVACY_DISCLOSURE_ID,
  PAGE_VISIT_STATS_PRIVACY_SUMMARY,
  PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE,
  type PageVisitBeaconRequest,
  PageVisitBeaconRequestSchema,
  type PageVisitEntityKind,
  PageVisitEntityKindSchema,
  type PageVisitIncrementInput,
  type PageVisitStatsStore,
  type PageVisitTopRow,
  type PublicObservabilityConfigResponse,
  PublicObservabilityConfigResponseSchema,
  type PublicPageVisitCountResponse,
  PublicPageVisitCountResponseSchema,
  type TopVisitedPage,
  TopVisitedPageSchema,
  type UtcDayBucket,
  UtcDayBucketSchema,
} from './pageVisitStatsTypes.js';

export interface PageVisitStatsPluginOptions {
  /**
   * When false, returns a completely inert plugin with zero lifecycle hooks, zero routes,
   * zero privacy document contributions, and zero storage writes.
   * Defaults to true when the factory is explicitly invoked.
   */
  readonly enabled?: boolean;
  /** Optional explicit stats store. Falls back to ports.pageVisitStatsStore, then an in-memory store. */
  readonly store?: PageVisitStatsStore;
  /** Optional deterministic clock override for UTC day bucketing and response timestamps. */
  readonly clock?: Clock;
  /**
   * Enables the read-only public single-page visit count endpoint and UI badges for deceased people,
   * places, and non-living narratives. Strictly OFF by default.
   */
  readonly publicVisitBadges?: boolean;
  /**
   * Minimum role for read-only observability endpoints (`/api/observability/config`,
   * `/api/observability/page-visits`, `/api/observability/page-visits/beacon`).
   * Defaults to 'archive_read' ('viewer' on private archives, 'public' on public archives).
   */
  readonly publicEndpointMinRole?: 'public' | 'archive_read' | 'viewer';
  /** Default stats window for GET /api/admin/observability/stats. Defaults to '30d'. */
  readonly defaultWindow?: ObservabilityStatsWindow;
  /** Max rows returned in top_pages. Defaults to 15 (clamped 1..50). */
  readonly topPagesLimit?: number;
  /** Max rows returned per category in top_by_kind. Defaults to 10 (clamped 1..25). */
  readonly topByKindLimit?: number;
}

interface SafeEntityInfo {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

interface SafeArchiveEntityCatalog {
  readonly headRevisionId: number;
  readonly deceasedPeopleByKey: ReadonlyMap<string, SafeEntityInfo>;
  readonly placesByKey: ReadonlyMap<string, SafeEntityInfo>;
  readonly publicNarrativesByKey: ReadonlyMap<string, SafeEntityInfo>;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isWindowValue(value: unknown): value is ObservabilityStatsWindow {
  return value === '7d' || value === '30d' || value === 'all';
}

interface ParsedPersonRef {
  readonly id: string;
  readonly slug: string;
  readonly full_name: string;
  readonly is_living: boolean;
}

interface ParsedPlaceRef {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly full_name: string;
}

interface ParsedNarrativeRef {
  readonly id: string;
  readonly slug?: string;
  readonly title: string;
  readonly person_ids?: readonly string[];
}

function isLivingPersonEntity(person: ParsedPersonRef, livingIds: ReadonlySet<string>): boolean {
  return livingIds.has(person.id) || person.is_living === true || person.full_name.trim() === 'Living';
}

async function buildSafeEntityCatalog(repository: ArchiveRepository): Promise<SafeArchiveEntityCatalog> {
  const [snapshot, livingIds] = await Promise.all([
    repository.loadActiveSnapshot(),
    repository.getLivingPersonIds(),
  ]);

  const allLivingIds = new Set<string>(livingIds);
  const parsedPeople: ParsedPersonRef[] = [];
  const parsedPlaces: ParsedPlaceRef[] = [];
  const parsedNarratives: ParsedNarrativeRef[] = [];

  for (const row of snapshot.entities) {
    if (row.deleted_at) {
      continue;
    }
    if (row.entity_type === 'person') {
      const person = parseEntityPayload('person', row.data);
      if (isLivingPersonEntity(person, allLivingIds)) {
        allLivingIds.add(person.id);
      } else {
        parsedPeople.push(person);
      }
    } else if (row.entity_type === 'place') {
      parsedPlaces.push(parseEntityPayload('place', row.data));
    } else if (row.entity_type === 'narrative') {
      parsedNarratives.push(parseEntityPayload('narrative', row.data));
    }
  }

  const deceasedPeopleByKey = new Map<string, SafeEntityInfo>();
  for (const person of parsedPeople) {
    if (isLivingPersonEntity(person, allLivingIds)) {
      continue;
    }
    const info: SafeEntityInfo = {
      id: person.id,
      slug: person.slug,
      title: person.full_name.trim() || person.slug,
    };
    deceasedPeopleByKey.set(person.slug, info);
    deceasedPeopleByKey.set(person.id, info);
  }

  const placesByKey = new Map<string, SafeEntityInfo>();
  for (const place of parsedPlaces) {
    const info: SafeEntityInfo = {
      id: place.id,
      slug: place.slug,
      title: (place.full_name || place.name).trim() || place.slug,
    };
    placesByKey.set(place.slug, info);
    placesByKey.set(place.id, info);
  }

  const publicNarrativesByKey = new Map<string, SafeEntityInfo>();
  for (const narrative of parsedNarratives) {
    const linkedPeople = narrative.person_ids ?? [];
    if (linkedPeople.some((personId) => allLivingIds.has(personId))) {
      continue;
    }
    const slug = narrative.slug || narrative.id;
    const info: SafeEntityInfo = {
      id: narrative.id,
      slug,
      title: narrative.title.trim() || slug,
    };
    publicNarrativesByKey.set(slug, info);
    publicNarrativesByKey.set(narrative.id, info);
  }

  const headRevisionId = Number(snapshot.head_revision_id);
  return {
    headRevisionId: Number.isSafeInteger(headRevisionId) && headRevisionId >= 0 ? headRevisionId : 0,
    deceasedPeopleByKey,
    placesByKey,
    publicNarrativesByKey,
  };
}

async function resolveSafeSingleEntity(
  repository: ArchiveRepository,
  kind: Exclude<PageVisitEntityKind, 'route'>,
  rawSlug: string
): Promise<SafeEntityInfo | null> {
  if (typeof repository.getEntityBySlug === 'function') {
    const [row, livingIds] =
      kind === 'place'
        ? [await repository.getEntityBySlug(kind, rawSlug), null]
        : await Promise.all([repository.getEntityBySlug(kind, rawSlug), repository.getLivingPersonIds()]);

    if (!row || row.deleted_at !== null) {
      return null;
    }

    if (kind === 'person') {
      const person = parseEntityPayload('person', row.data);
      if (isLivingPersonEntity(person, livingIds ?? new Set<string>())) {
        return null;
      }
      return {
        id: person.id,
        slug: person.slug,
        title: person.full_name.trim() || person.slug,
      };
    }

    if (kind === 'place') {
      const place = parseEntityPayload('place', row.data);
      return {
        id: place.id,
        slug: place.slug,
        title: (place.full_name || place.name).trim() || place.slug,
      };
    }

    const narrative = parseEntityPayload('narrative', row.data);
    const linkedPeople = narrative.person_ids ?? [];
    if (livingIds && linkedPeople.some((personId) => livingIds.has(personId))) {
      return null;
    }
    const slug = narrative.slug || narrative.id;
    return {
      id: narrative.id,
      slug,
      title: narrative.title.trim() || slug,
    };
  }

  const catalog = await buildSafeEntityCatalog(repository);
  if (kind === 'person') {
    return catalog.deceasedPeopleByKey.get(rawSlug) ?? null;
  }
  if (kind === 'place') {
    return catalog.placesByKey.get(rawSlug) ?? null;
  }
  return catalog.publicNarrativesByKey.get(rawSlug) ?? null;
}

function observabilityReadCacheControl(mode: 'private' | 'public' | undefined): string {
  return mode === 'public' ? 'no-cache' : 'private, no-cache';
}

function buildSettingsSchema(defaults: {
  readonly publicVisitBadges: boolean;
  readonly defaultWindow: ObservabilityStatsWindow;
}): PluginSettingsSchema {
  return {
    title: 'Page Visit Stats & Privacy-First Observability',
    description:
      'Configure privacy-first, cookie-free aggregate page visit tracking and optional per-page visit badges (strictly excluding living relatives).',
    sections: [
      {
        id: 'tracking_status',
        title: 'Aggregate Counter Status',
        description:
          'Read-only runtime status of the privacy-first counter store and Workers Observability pairing.',
        fields: [
          {
            key: 'tracking_status',
            label: 'Visit Tracking Status',
            type: 'readonly',
            defaultValue: 'active',
          },
          {
            key: 'storage_adapter',
            label: 'Stats Store Adapter',
            type: 'readonly',
            defaultValue: 'in-memory',
          },
          {
            key: 'public_badges_status',
            label: 'Public Page Visit Badges',
            type: 'readonly',
            defaultValue: defaults.publicVisitBadges ? 'enabled' : 'disabled',
          },
        ],
      },
      {
        id: 'display_preferences',
        title: 'Display Preferences',
        description:
          'Control whether subtle aggregate visit counts appear on deceased person, place, and narrative pages.',
        fields: [
          {
            key: 'show_public_visit_badges',
            label: 'Show public visit counts on entity pages',
            type: 'boolean',
            defaultValue: defaults.publicVisitBadges,
            helpText:
              'When enabled, exposes read-only aggregate visit counts for deceased people, places, and non-living narratives. Living relatives are always excluded.',
          },
          {
            key: 'default_window',
            label: 'Default Admin Stats Window',
            type: 'select',
            required: true,
            defaultValue: defaults.defaultWindow,
            helpText: 'Default rolling time window shown in the Admin Settings observability dashboard.',
            options: [
              { value: '7d', label: 'Last 7 days' },
              { value: '30d', label: 'Last 30 days' },
              { value: 'all', label: 'All time' },
            ],
          },
        ],
      },
    ],
  };
}

function resolveStore(
  explicitStore: PageVisitStatsStore | undefined,
  ports: KinloomServerPorts | undefined,
  fallbackStore: InMemoryPageVisitStatsStore
): PageVisitStatsStore {
  return explicitStore ?? ports?.pageVisitStatsStore ?? fallbackStore;
}

function resolveTopRowToSafeEntry(
  row: PageVisitTopRow,
  catalog: SafeArchiveEntityCatalog
): TopVisitedPage | null {
  if (row.entity_kind === 'route') {
    return {
      route_key: row.route_key,
      entity_kind: 'route',
      entity_slug: null,
      title: staticRouteLabel(row.route_key),
      views: row.views,
    };
  }
  const slugKey = row.entity_slug ?? row.route_key.split('/').filter(Boolean)[1] ?? '';
  if (!slugKey) {
    return null;
  }
  if (row.entity_kind === 'person') {
    const info = catalog.deceasedPeopleByKey.get(slugKey);
    if (!info) {
      return null;
    }
    return {
      route_key: buildEntityRouteKey('person', info.slug),
      entity_kind: 'person',
      entity_slug: info.slug,
      title: info.title,
      views: row.views,
    };
  }
  if (row.entity_kind === 'place') {
    const info = catalog.placesByKey.get(slugKey);
    if (!info) {
      return null;
    }
    return {
      route_key: buildEntityRouteKey('place', info.slug),
      entity_kind: 'place',
      entity_slug: info.slug,
      title: info.title,
      views: row.views,
    };
  }
  const info = catalog.publicNarrativesByKey.get(slugKey);
  if (!info) {
    return null;
  }
  return {
    route_key: buildEntityRouteKey('narrative', info.slug),
    entity_kind: 'narrative',
    entity_slug: info.slug,
    title: info.title,
    views: row.views,
  };
}

function resolvePublicCountQuery(
  url: URL
): { readonly kind: Exclude<PageVisitEntityKind, 'route'>; readonly rawSlug: string } | null {
  const kindParam = url.searchParams.get('kind')?.trim().toLowerCase();
  const slugParam = url.searchParams.get('slug')?.trim();
  if (
    (kindParam === 'person' || kindParam === 'place' || kindParam === 'narrative') &&
    slugParam &&
    slugParam.length > 0
  ) {
    return { kind: kindParam, rawSlug: slugParam };
  }

  const pathParam = url.searchParams.get('path')?.trim();
  if (pathParam) {
    const parsed = parseVisitRouteCandidate(pathParam);
    if (parsed && parsed.kind !== 'route') {
      return { kind: parsed.kind, rawSlug: parsed.rawSlug };
    }
  }

  return null;
}

function hasActiveWorkersObservability(ports: KinloomServerPorts | undefined): boolean {
  return Boolean(ports?.plugins?.some((plugin) => plugin.observabilityFlags?.enabled === true));
}

/**
 * Optional, off-by-default privacy-first server plugin that records cookie-free aggregate page
 * visits per normalized route/entity slug and UTC day, serves admin observability stats, and
 * optionally exposes read-only single-page visit counts for deceased people, places, and narratives.
 */
export function createPageVisitStatsPlugin(options: PageVisitStatsPluginOptions = {}): KinloomServerPlugin {
  if (options.enabled === false) {
    return {
      id: PAGE_VISIT_STATS_PLUGIN_ID,
      name: 'Page Visit Stats (disabled)',
      version: KINLOOM_SERVER_VERSION,
      changelog: [
        {
          version: '0.61.0',
          date: '2026-11-28',
          summary: 'Privacy-first page visit stats, SPA visit beacon, and public badge toggle.',
          changes: [
            {
              category: 'added',
              text: 'Privacy-first page visit stats, SPA visit beacon, and public badge toggle.',
            },
          ],
        },
      ],
      status: 'disabled',
      getStatus: () => ({ status: 'disabled', detail: 'Disabled via plugin options' }),
    };
  }

  const fallbackStore = new InMemoryPageVisitStatsStore();
  let publicVisitBadges = options.publicVisitBadges ?? false;
  let defaultWindow: ObservabilityStatsWindow = options.defaultWindow ?? '30d';
  const topPagesLimit = clampInt(options.topPagesLimit, 15, 1, 50);
  const topByKindLimit = clampInt(options.topByKindLimit, 10, 1, 25);
  const publicEndpointMinRole = options.publicEndpointMinRole ?? 'archive_read';

  const settingsSchema = buildSettingsSchema({
    publicVisitBadges,
    defaultWindow,
  });

  async function resolvePersistedPreferences(ports: KinloomServerPorts): Promise<{
    readonly showPublicBadges: boolean;
    readonly preferredWindow: ObservabilityStatsWindow;
  }> {
    let showPublicBadges = publicVisitBadges;
    let preferredWindow = defaultWindow;
    if (ports.pluginSettingsStore) {
      try {
        const stored = await ports.pluginSettingsStore.getSettings(PAGE_VISIT_STATS_PLUGIN_ID);
        if (stored) {
          if (typeof stored.values.show_public_visit_badges === 'boolean') {
            showPublicBadges = stored.values.show_public_visit_badges;
            publicVisitBadges = showPublicBadges;
          }
          if (isWindowValue(stored.values.default_window)) {
            preferredWindow = stored.values.default_window;
            defaultWindow = preferredWindow;
          }
        }
      } catch {
        // Fall back to in-memory options if plugin settings table is unavailable.
      }
    }
    return { showPublicBadges, preferredWindow };
  }

  function resolveClock(ports: KinloomServerPorts | undefined): Clock | undefined {
    return options.clock ?? ports?.clock;
  }

  function readNowIso(ports: KinloomServerPorts | undefined): string {
    const clock = resolveClock(ports);
    return clock ? clock.nowIso() : new Date().toISOString();
  }

  return {
    id: PAGE_VISIT_STATS_PLUGIN_ID,
    name: 'Page Visit Stats',
    version: KINLOOM_SERVER_VERSION,
    status: 'active',
    changelog: [
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary: 'Privacy-first page visit stats, SPA visit beacon, and public badge toggle.',
        changes: [
          {
            category: 'added',
            text: 'Privacy-first page visit stats, SPA visit beacon, and public badge toggle.',
          },
        ],
      },
    ],
    settingsSchema,
    documentContributions: {
      privacyDisclosures: [
        {
          id: PAGE_VISIT_STATS_PRIVACY_DISCLOSURE_ID,
          summary: PAGE_VISIT_STATS_PRIVACY_SUMMARY,
          replacesZeroAnalyticsClaim: false,
        },
      ],
    },
    getStatus: () => ({
      status: 'active',
      detail: publicVisitBadges ? 'aggregate-counts, public-badges' : 'aggregate-counts',
    }),
    getReadonlySettings: (
      ctx: KinloomServerPluginReadonlySettingsContext
    ): Readonly<Record<string, PluginSettingScalarValue>> => {
      const serverPorts = ctx.ports as KinloomServerPorts;
      const store = resolveStore(options.store, serverPorts, fallbackStore);
      const badgesOn =
        typeof ctx.values.show_public_visit_badges === 'boolean'
          ? ctx.values.show_public_visit_badges
          : publicVisitBadges;
      return {
        tracking_status: 'active',
        storage_adapter: store.adapterKind ?? 'custom',
        public_badges_status: badgesOn ? 'enabled' : 'disabled',
      };
    },
    onSettingsUpdated: (event) => {
      if (typeof event.values.show_public_visit_badges === 'boolean') {
        publicVisitBadges = event.values.show_public_visit_badges;
      }
      if (isWindowValue(event.values.default_window)) {
        defaultWindow = event.values.default_window;
      }
    },

    routes: [
      {
        method: 'GET',
        pathPrefix: PAGE_VISIT_STATS_ADMIN_ROUTE,
        minRole: 'admin',
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== PAGE_VISIT_STATS_ADMIN_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
          }

          const serverPorts = ctx.ports as KinloomServerPorts;
          const store = resolveStore(options.store, serverPorts, fallbackStore);
          const prefs = await resolvePersistedPreferences(serverPorts);

          const rawWindow = ctx.url.searchParams.get('window');
          let activeWindow: ObservabilityStatsWindow = prefs.preferredWindow;
          if (rawWindow !== null && rawWindow.trim().length > 0) {
            const parsedWindow = ObservabilityStatsWindowSchema.safeParse(rawWindow.trim());
            if (!parsedWindow.success) {
              throw new KinloomHttpError(
                400,
                'VALIDATION_ERROR',
                `Invalid window '${rawWindow}'. Expected one of: 7d, 30d, all.`
              );
            }
            activeWindow = parsedWindow.data;
          }

          const nowIso = readNowIso(serverPorts);
          const todayUtc = formatUtcDayBucket(nowIso);
          const since7d = shiftUtcDay(todayUtc, -6);
          const since30d = shiftUtcDay(todayUtc, -29);
          const windowSince = windowSinceDayUtc(todayUtc, activeWindow);
          const trendDays = trendLengthForWindow(activeWindow);
          const trendSince = shiftUtcDay(todayUtc, -(trendDays - 1));
          const fetchOverprovision = 20;

          const [
            catalog,
            views7d,
            views30d,
            viewsAllTime,
            sparseDaily,
            rawTopAll,
            rawTopPeople,
            rawTopPlaces,
            rawTopNarratives,
            cacheTotals,
          ] = await Promise.all([
            buildSafeEntityCatalog(serverPorts.repository),
            store.getTotalViews({ sinceDayUtc: since7d }),
            store.getTotalViews({ sinceDayUtc: since30d }),
            store.getTotalViews(),
            store.getDailySeries({ sinceDayUtc: trendSince, untilDayUtc: todayUtc }),
            store.getTopPages({ sinceDayUtc: windowSince, limit: topPagesLimit + fetchOverprovision }),
            store.getTopPages({
              sinceDayUtc: windowSince,
              entityKinds: ['person'],
              limit: topByKindLimit + fetchOverprovision,
            }),
            store.getTopPages({
              sinceDayUtc: windowSince,
              entityKinds: ['place'],
              limit: topByKindLimit + fetchOverprovision,
            }),
            store.getTopPages({
              sinceDayUtc: windowSince,
              entityKinds: ['narrative'],
              limit: topByKindLimit + fetchOverprovision,
            }),
            store.getCacheTotals
              ? store.getCacheTotals({ sinceDayUtc: windowSince })
              : Promise.resolve({ hits: 0, misses: 0, not_modified: 0 }),
          ]);

          const mapSafeList = (rows: readonly PageVisitTopRow[], maxItems: number): TopVisitedPage[] => {
            const out: TopVisitedPage[] = [];
            for (const row of rows) {
              const safe = resolveTopRowToSafeEntry(row, catalog);
              if (safe) {
                out.push(safe);
                if (out.length >= maxItems) {
                  break;
                }
              }
            }
            return out;
          };

          const payload: AdminObservabilityStatsResponse = AdminObservabilityStatsResponseSchema.parse({
            generated_at: nowIso,
            window: activeWindow,
            privacy_mode: 'aggregate-cookie-free',
            public_badges_enabled: prefs.showPublicBadges,
            bundle_revision: catalog.headRevisionId,
            workers_observability_paired: hasActiveWorkersObservability(serverPorts),
            totals: {
              views_7d: views7d,
              views_30d: views30d,
              views_all_time: viewsAllTime,
            },
            cache: computeCacheSummary(cacheTotals),
            daily_trend: fillDailySeries(todayUtc, trendDays, sparseDaily),
            top_pages: mapSafeList(rawTopAll, topPagesLimit),
            top_by_kind: {
              people: mapSafeList(rawTopPeople, topByKindLimit),
              places: mapSafeList(rawTopPlaces, topByKindLimit),
              narratives: mapSafeList(rawTopNarratives, topByKindLimit),
            },
          });

          return jsonResponse(payload, 200, { 'cache-control': 'no-store' });
        },
      },
      {
        method: 'GET',
        pathPrefix: PAGE_VISIT_STATS_CONFIG_ROUTE,
        minRole: publicEndpointMinRole,
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== PAGE_VISIT_STATS_CONFIG_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
          }
          const serverPorts = ctx.ports as KinloomServerPorts;
          const prefs = await resolvePersistedPreferences(serverPorts);
          const payload: PublicObservabilityConfigResponse = PublicObservabilityConfigResponseSchema.parse({
            enabled: true,
            public_badges_enabled: prefs.showPublicBadges,
            record_spa_beacons: true,
          });
          return jsonResponse(payload, 200, {
            'cache-control': observabilityReadCacheControl(ctx.mode),
          });
        },
      },
      {
        method: 'POST',
        pathPrefix: PAGE_VISIT_STATS_BEACON_ROUTE,
        minRole: publicEndpointMinRole,
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== PAGE_VISIT_STATS_BEACON_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route POST ${ctx.url.pathname} was not found.`);
          }
          if (isPrefetchRequest(ctx.request) || isBotUserAgent(ctx.request.headers.get('user-agent'))) {
            return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
          }

          let rawBody: unknown;
          try {
            rawBody = await ctx.request.json();
          } catch {
            throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Expected JSON body with a path string.');
          }
          const parsedBody = PageVisitBeaconRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            throw new KinloomHttpError(
              400,
              'VALIDATION_ERROR',
              parsedBody.error.issues[0]?.message ?? 'Invalid page visit beacon payload.'
            );
          }

          const candidate = parseVisitRouteCandidate(parsedBody.data.path);
          if (!candidate) {
            return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
          }

          const serverPorts = ctx.ports as KinloomServerPorts;
          const store = resolveStore(options.store, serverPorts, fallbackStore);
          const dayUtc = formatUtcDayBucket(readNowIso(serverPorts));

          if (candidate.kind === 'route') {
            await store.incrementVisit({
              routeKey: candidate.routeKey,
              entityKind: 'route',
              entitySlug: null,
              dayUtc,
            });
            return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
          }

          const safeEntity = await resolveSafeSingleEntity(
            serverPorts.repository,
            candidate.kind,
            candidate.rawSlug
          );
          if (safeEntity) {
            await store.incrementVisit({
              routeKey: buildEntityRouteKey(candidate.kind, safeEntity.slug),
              entityKind: candidate.kind,
              entitySlug: safeEntity.slug,
              dayUtc,
            });
          }

          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        },
      },
      {
        method: 'GET',
        pathPrefix: PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE,
        minRole: publicEndpointMinRole,
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
          }

          const serverPorts = ctx.ports as KinloomServerPorts;
          const prefs = await resolvePersistedPreferences(serverPorts);
          if (!prefs.showPublicBadges) {
            throw new KinloomHttpError(404, 'NOT_FOUND', 'Public page visit counts are disabled.');
          }

          const query = resolvePublicCountQuery(ctx.url);
          if (!query) {
            throw new KinloomHttpError(
              400,
              'VALIDATION_ERROR',
              'Expected query parameters kind (person|place|narrative) and slug, or a valid entity path.'
            );
          }

          const resolved = await resolveSafeSingleEntity(serverPorts.repository, query.kind, query.rawSlug);

          // Living people, living-linked narratives, and unknown slugs all return 404 identically.
          if (!resolved) {
            throw new KinloomHttpError(
              404,
              'NOT_FOUND',
              'Page visit stats are not available for this entity.'
            );
          }

          const routeKey = buildEntityRouteKey(query.kind, resolved.slug);
          const store = resolveStore(options.store, serverPorts, fallbackStore);
          const totalViews = await store.getPageTotalViews(routeKey);

          const body: PublicPageVisitCountResponse = PublicPageVisitCountResponseSchema.parse({
            route_key: routeKey,
            entity_kind: query.kind,
            entity_slug: resolved.slug,
            total_views: totalViews,
          });

          return jsonResponse(body, 200, {
            'cache-control': observabilityReadCacheControl(ctx.mode),
          });
        },
      },
    ],

    async onResponse(event: ServerRequestResponseEvent): Promise<void> {
      const serverPorts = event.ports;
      const store = resolveStore(options.store, serverPorts, fallbackStore);
      const dayUtc = formatUtcDayBucket(readNowIso(serverPorts));

      const cacheStatus = event.telemetry.cacheStatus;
      const cacheOutcome =
        typeof store.recordCacheEvent === 'function' &&
        (cacheStatus === 'hit' || cacheStatus === 'miss' || cacheStatus === 'not_modified')
          ? cacheStatus
          : null;

      const skipPrivateAnonymous =
        event.mode === 'private' && (!event.principal || event.principal.kind === 'anonymous');

      const recordPage =
        !skipPrivateAnonymous &&
        shouldRecordPageVisit({
          request: event.telemetry.request,
          status: event.status,
          contentType: event.response.headers.get('content-type'),
        });

      const candidate = recordPage
        ? parseVisitRouteCandidate(new URL(event.telemetry.request.url).pathname)
        : null;

      if (!cacheOutcome && !candidate) {
        return;
      }

      const task = (async () => {
        if (cacheOutcome && store.recordCacheEvent) {
          await store.recordCacheEvent({ dayUtc, outcome: cacheOutcome });
        }

        if (!candidate) {
          return;
        }

        if (candidate.kind === 'route') {
          await store.incrementVisit({
            routeKey: candidate.routeKey,
            entityKind: 'route',
            entitySlug: null,
            dayUtc,
          });
          return;
        }

        if (!serverPorts?.repository) {
          return;
        }

        const safeEntity = await resolveSafeSingleEntity(
          serverPorts.repository,
          candidate.kind,
          candidate.rawSlug
        );

        if (!safeEntity) {
          return;
        }

        await store.incrementVisit({
          routeKey: buildEntityRouteKey(candidate.kind, safeEntity.slug),
          entityKind: candidate.kind,
          entitySlug: safeEntity.slug,
          dayUtc,
        });
      })().catch((error: unknown) => {
        try {
          event.reportPluginError?.(PAGE_VISIT_STATS_PLUGIN_ID, error);
        } catch {
          // Isolate reporter failures so visit tracking never affects HTTP responses.
        }
      });

      if (event.waitUntil) {
        event.waitUntil(task);
        return;
      }

      await task;
    },
  };
}
