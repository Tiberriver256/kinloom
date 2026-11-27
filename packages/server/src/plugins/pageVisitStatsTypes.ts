import { z } from 'zod';

export const PAGE_VISIT_STATS_PLUGIN_ID = 'kinloom-page-visit-stats';
export const PAGE_VISIT_STATS_ADMIN_ROUTE = '/api/admin/observability/stats';
export const PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE = '/api/observability/page-visits';
export const PAGE_VISIT_STATS_PRIVACY_DISCLOSURE_ID = 'kinloom-page-visit-stats';
export const PAGE_VISIT_STATS_PRIVACY_SUMMARY =
  'This archive records optional, cookie-free aggregate page visit counts per route and UTC day on its server instance, with zero cookies, zero user fingerprinting, zero raw IP storage, and strict exclusion of living relatives.';

export const PageVisitEntityKindSchema = z.enum(['route', 'person', 'place', 'narrative']);
export type PageVisitEntityKind = z.infer<typeof PageVisitEntityKindSchema>;

export const ObservabilityStatsWindowSchema = z.enum(['7d', '30d', 'all']);
export type ObservabilityStatsWindow = z.infer<typeof ObservabilityStatsWindowSchema>;

export const UtcDayBucketSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected UTC day YYYY-MM-DD');
export type UtcDayBucket = z.infer<typeof UtcDayBucketSchema>;

export const DailyVisitPointSchema = z.object({
  day_utc: UtcDayBucketSchema,
  views: z.number().int().nonnegative(),
});
export type DailyVisitPoint = z.infer<typeof DailyVisitPointSchema>;

export const TopVisitedPageSchema = z.object({
  route_key: z.string().min(1),
  entity_kind: PageVisitEntityKindSchema,
  entity_slug: z.string().min(1).nullable(),
  title: z.string().min(1),
  views: z.number().int().nonnegative(),
});
export type TopVisitedPage = z.infer<typeof TopVisitedPageSchema>;

export const ObservabilityCacheSummarySchema = z.object({
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  not_modified: z.number().int().nonnegative(),
  total_requests: z.number().int().nonnegative(),
  hit_ratio: z.number().min(0).max(1).nullable(),
});
export type ObservabilityCacheSummary = z.infer<typeof ObservabilityCacheSummarySchema>;

export const AdminObservabilityStatsResponseSchema = z.object({
  generated_at: z.string().min(1),
  window: ObservabilityStatsWindowSchema,
  privacy_mode: z.literal('aggregate-cookie-free'),
  public_badges_enabled: z.boolean(),
  bundle_revision: z.number().int().nonnegative(),
  workers_observability_paired: z.boolean(),
  totals: z.object({
    views_7d: z.number().int().nonnegative(),
    views_30d: z.number().int().nonnegative(),
    views_all_time: z.number().int().nonnegative(),
  }),
  cache: ObservabilityCacheSummarySchema,
  daily_trend: z.array(DailyVisitPointSchema),
  top_pages: z.array(TopVisitedPageSchema),
  top_by_kind: z.object({
    people: z.array(TopVisitedPageSchema),
    places: z.array(TopVisitedPageSchema),
    narratives: z.array(TopVisitedPageSchema),
  }),
});
export type AdminObservabilityStatsResponse = z.infer<typeof AdminObservabilityStatsResponseSchema>;

export const PublicPageVisitCountResponseSchema = z.object({
  route_key: z.string().min(1),
  entity_kind: z.enum(['person', 'place', 'narrative']),
  entity_slug: z.string().min(1),
  total_views: z.number().int().nonnegative(),
});
export type PublicPageVisitCountResponse = z.infer<typeof PublicPageVisitCountResponseSchema>;

export interface PageVisitIncrementInput {
  readonly routeKey: string;
  readonly entityKind: PageVisitEntityKind;
  readonly entitySlug: string | null;
  readonly dayUtc: string;
  readonly delta?: number;
}

export interface PageVisitTopRow {
  readonly route_key: string;
  readonly entity_kind: PageVisitEntityKind;
  readonly entity_slug: string | null;
  readonly views: number;
}

export type ObservabilityCacheOutcome = 'hit' | 'miss' | 'not_modified';

export interface ObservabilityCacheTotals {
  readonly hits: number;
  readonly misses: number;
  readonly not_modified: number;
}

export interface PageVisitStatsStore {
  readonly adapterKind?: string;
  incrementVisit(input: PageVisitIncrementInput): Promise<void>;
  recordCacheEvent?(input: {
    readonly dayUtc: string;
    readonly outcome: ObservabilityCacheOutcome;
  }): Promise<void>;
  getDailySeries(params: {
    readonly sinceDayUtc: string;
    readonly untilDayUtc: string;
  }): Promise<readonly DailyVisitPoint[]>;
  getTopPages(params: {
    readonly sinceDayUtc?: string;
    readonly entityKinds?: readonly PageVisitEntityKind[];
    readonly limit: number;
  }): Promise<readonly PageVisitTopRow[]>;
  getTotalViews(params?: { readonly sinceDayUtc?: string }): Promise<number>;
  getPageTotalViews(routeKey: string): Promise<number>;
  getCacheTotals?(params?: { readonly sinceDayUtc?: string }): Promise<ObservabilityCacheTotals>;
}
