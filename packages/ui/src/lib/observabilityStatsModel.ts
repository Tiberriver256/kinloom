import type { Narrative, Person } from '@kinloom/core';

export const OBSERVABILITY_STATS_SERVER_PLUGIN_ID = 'kinloom-page-visit-stats';

export type UiObservabilityStatsWindow = '7d' | '30d' | 'all';
export type UiPageVisitEntityKind = 'route' | 'person' | 'place' | 'narrative';

export interface UiDailyVisitPoint {
  readonly day_utc: string;
  readonly views: number;
}

export interface UiTopVisitedPage {
  readonly route_key: string;
  readonly entity_kind: UiPageVisitEntityKind;
  readonly entity_slug: string | null;
  readonly title: string;
  readonly views: number;
}

export interface UiObservabilityCacheSummary {
  readonly hits: number;
  readonly misses: number;
  readonly not_modified: number;
  readonly total_requests: number;
  readonly hit_ratio: number | null;
}

export interface UiAdminObservabilityStats {
  readonly generated_at: string;
  readonly window: UiObservabilityStatsWindow;
  readonly privacy_mode: 'aggregate-cookie-free';
  readonly public_badges_enabled: boolean;
  readonly bundle_revision: number;
  readonly workers_observability_paired: boolean;
  readonly totals: {
    readonly views_7d: number;
    readonly views_30d: number;
    readonly views_all_time: number;
  };
  readonly cache: UiObservabilityCacheSummary;
  readonly daily_trend: readonly UiDailyVisitPoint[];
  readonly top_pages: readonly UiTopVisitedPage[];
  readonly top_by_kind: {
    readonly people: readonly UiTopVisitedPage[];
    readonly places: readonly UiTopVisitedPage[];
    readonly narratives: readonly UiTopVisitedPage[];
  };
}

export interface UiPublicPageVisitCount {
  readonly route_key: string;
  readonly entity_kind: 'person' | 'place' | 'narrative';
  readonly entity_slug: string;
  readonly total_views: number;
}

export interface UiPublicObservabilityConfig {
  readonly enabled: boolean;
  readonly public_badges_enabled: boolean;
  readonly record_spa_beacons: boolean;
}

export type TopPagesCategoryFilter = 'all' | 'people' | 'places' | 'narratives';

export interface DailyTrendBarGeometry {
  readonly dayUtc: string;
  readonly shortLabel: string;
  readonly views: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly showAxisLabel: boolean;
}

export interface DailyTrendChartGeometry {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly chartTop: number;
  readonly chartBottom: number;
  readonly peakViews: number;
  readonly totalViews: number;
  readonly bars: readonly DailyTrendBarGeometry[];
}

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string for ${field}`);
  }
  return value;
}

function expectNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Expected non-negative integer for ${field}`);
  }
  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean for ${field}`);
  }
  return value;
}

function parseEntityKind(value: unknown, field: string): UiPageVisitEntityKind {
  if (value === 'route' || value === 'person' || value === 'place' || value === 'narrative') {
    return value;
  }
  throw new Error(`Invalid entity_kind for ${field}`);
}

function parseTopVisitedPage(raw: unknown, field: string): UiTopVisitedPage {
  if (!isRecord(raw)) {
    throw new Error(`Expected object for ${field}`);
  }
  const slug = raw.entity_slug;
  if (slug !== null && (typeof slug !== 'string' || slug.length === 0)) {
    throw new Error(`Invalid entity_slug for ${field}`);
  }
  return {
    route_key: expectNonEmptyString(raw.route_key, `${field}.route_key`),
    entity_kind: parseEntityKind(raw.entity_kind, `${field}.entity_kind`),
    entity_slug: slug,
    title: expectNonEmptyString(raw.title, `${field}.title`),
    views: expectNonNegativeInt(raw.views, `${field}.views`),
  };
}

function parseTopVisitedPageList(raw: unknown, field: string): readonly UiTopVisitedPage[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Expected array for ${field}`);
  }
  return raw.map((item, idx) => parseTopVisitedPage(item, `${field}[${idx}]`));
}

function parseDailyTrend(raw: unknown): readonly UiDailyVisitPoint[] {
  if (!Array.isArray(raw)) {
    throw new Error('Expected array for daily_trend');
  }
  return raw.map((item, idx) => {
    if (!isRecord(item)) {
      throw new Error(`Expected object for daily_trend[${idx}]`);
    }
    const dayUtc = expectNonEmptyString(item.day_utc, `daily_trend[${idx}].day_utc`);
    if (!UTC_DAY_PATTERN.test(dayUtc)) {
      throw new Error(`Expected YYYY-MM-DD for daily_trend[${idx}].day_utc`);
    }
    return {
      day_utc: dayUtc,
      views: expectNonNegativeInt(item.views, `daily_trend[${idx}].views`),
    };
  });
}

export function parseAdminObservabilityStats(raw: unknown): UiAdminObservabilityStats {
  if (!isRecord(raw)) {
    throw new Error('Expected JSON object for admin observability stats');
  }
  const win = raw.window;
  if (win !== '7d' && win !== '30d' && win !== 'all') {
    throw new Error('Invalid stats window');
  }
  if (raw.privacy_mode !== 'aggregate-cookie-free') {
    throw new Error('Invalid privacy_mode');
  }
  if (!isRecord(raw.totals)) {
    throw new Error('Expected totals object');
  }
  if (!isRecord(raw.cache)) {
    throw new Error('Expected cache object');
  }
  if (!isRecord(raw.top_by_kind)) {
    throw new Error('Expected top_by_kind object');
  }

  const rawRatio = raw.cache.hit_ratio;
  if (
    rawRatio !== null &&
    (typeof rawRatio !== 'number' || !Number.isFinite(rawRatio) || rawRatio < 0 || rawRatio > 1)
  ) {
    throw new Error('Invalid cache.hit_ratio');
  }

  return {
    generated_at: expectNonEmptyString(raw.generated_at, 'generated_at'),
    window: win,
    privacy_mode: 'aggregate-cookie-free',
    public_badges_enabled: expectBoolean(raw.public_badges_enabled, 'public_badges_enabled'),
    bundle_revision: expectNonNegativeInt(raw.bundle_revision, 'bundle_revision'),
    workers_observability_paired: expectBoolean(
      raw.workers_observability_paired,
      'workers_observability_paired'
    ),
    totals: {
      views_7d: expectNonNegativeInt(raw.totals.views_7d, 'totals.views_7d'),
      views_30d: expectNonNegativeInt(raw.totals.views_30d, 'totals.views_30d'),
      views_all_time: expectNonNegativeInt(raw.totals.views_all_time, 'totals.views_all_time'),
    },
    cache: {
      hits: expectNonNegativeInt(raw.cache.hits, 'cache.hits'),
      misses: expectNonNegativeInt(raw.cache.misses, 'cache.misses'),
      not_modified: expectNonNegativeInt(raw.cache.not_modified, 'cache.not_modified'),
      total_requests: expectNonNegativeInt(raw.cache.total_requests, 'cache.total_requests'),
      hit_ratio: rawRatio,
    },
    daily_trend: parseDailyTrend(raw.daily_trend),
    top_pages: parseTopVisitedPageList(raw.top_pages, 'top_pages'),
    top_by_kind: {
      people: parseTopVisitedPageList(raw.top_by_kind.people, 'top_by_kind.people'),
      places: parseTopVisitedPageList(raw.top_by_kind.places, 'top_by_kind.places'),
      narratives: parseTopVisitedPageList(raw.top_by_kind.narratives, 'top_by_kind.narratives'),
    },
  };
}

export function parsePublicPageVisitCount(raw: unknown): UiPublicPageVisitCount | null {
  if (!isRecord(raw)) {
    return null;
  }
  const kind = raw.entity_kind;
  if (kind !== 'person' && kind !== 'place' && kind !== 'narrative') {
    return null;
  }
  if (
    typeof raw.route_key !== 'string' ||
    raw.route_key.length === 0 ||
    typeof raw.entity_slug !== 'string' ||
    raw.entity_slug.length === 0 ||
    typeof raw.total_views !== 'number' ||
    !Number.isInteger(raw.total_views) ||
    raw.total_views < 0
  ) {
    return null;
  }
  return {
    route_key: raw.route_key,
    entity_kind: kind,
    entity_slug: raw.entity_slug,
    total_views: raw.total_views,
  };
}

export function parsePublicObservabilityConfig(raw: unknown): UiPublicObservabilityConfig | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.public_badges_enabled !== 'boolean') {
    return null;
  }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    public_badges_enabled: raw.public_badges_enabled,
    record_spa_beacons: typeof raw.record_spa_beacons === 'boolean' ? raw.record_spa_beacons : true,
  };
}

export function formatShortUtcDay(dayUtc: string): string {
  const parts = dayUtc.split('-');
  if (parts.length !== 3) {
    return dayUtc;
  }
  return `${parts[1]}/${parts[2]}`;
}

export function formatVisitCount(views: number): string {
  const safe = Number.isFinite(views) && views > 0 ? Math.floor(views) : 0;
  return safe.toLocaleString('en-US');
}

export function formatVisitBadgeLabel(views: number): string {
  const safe = Number.isFinite(views) && views > 0 ? Math.floor(views) : 0;
  return `${safe.toLocaleString('en-US')} ${safe === 1 ? 'visit' : 'visits'}`;
}

export function formatCacheHitRatio(
  cache: UiObservabilityCacheSummary,
  workersObservabilityPaired: boolean
): string {
  if (cache.hit_ratio === null || cache.total_requests === 0) {
    return workersObservabilityPaired ? 'No bundle traffic yet' : 'Pair with #30 plugin';
  }
  const pct = Math.round(cache.hit_ratio * 1000) / 10;
  return `${pct}% (${cache.hits + cache.not_modified}/${cache.total_requests})`;
}

export function formatEntityKindLabel(kind: UiPageVisitEntityKind): string {
  switch (kind) {
    case 'person':
      return 'Ancestor';
    case 'place':
      return 'Place';
    case 'narrative':
      return 'Narrative';
    case 'route':
      return 'Archive Page';
  }
}

export function selectTopPagesByCategory(
  stats: UiAdminObservabilityStats,
  category: TopPagesCategoryFilter
): readonly UiTopVisitedPage[] {
  switch (category) {
    case 'people':
      return stats.top_by_kind.people;
    case 'places':
      return stats.top_by_kind.places;
    case 'narratives':
      return stats.top_by_kind.narratives;
    case 'all':
      return stats.top_pages;
  }
}

/**
 * Computes pure SVG coordinates for the daily visit trend bar chart.
 */
export function buildDailyTrendChartGeometry(
  dailyTrend: readonly UiDailyVisitPoint[]
): DailyTrendChartGeometry {
  const viewBoxWidth = 640;
  const viewBoxHeight = 180;
  const chartLeft = 12;
  const chartRight = viewBoxWidth - 12;
  const chartTop = 18;
  const chartBottom = 148;
  const plotWidth = chartRight - chartLeft;
  const plotHeight = chartBottom - chartTop;

  let peakViews = 0;
  let totalViews = 0;
  for (const point of dailyTrend) {
    totalViews += point.views;
    if (point.views > peakViews) {
      peakViews = point.views;
    }
  }

  const count = dailyTrend.length;
  if (count === 0) {
    return {
      viewBoxWidth,
      viewBoxHeight,
      chartTop,
      chartBottom,
      peakViews: 0,
      totalViews: 0,
      bars: [],
    };
  }

  const slotWidth = plotWidth / count;
  const barGap = count > 14 ? 3 : 8;
  const barWidth = Math.max(4, slotWidth - barGap);
  const labelStep = count <= 7 ? 1 : count <= 15 ? 3 : 6;
  const scaleMax = peakViews > 0 ? peakViews : 1;

  const bars: DailyTrendBarGeometry[] = dailyTrend.map((point, index) => {
    const rawHeight = point.views > 0 ? Math.max(4, Math.round((point.views / scaleMax) * plotHeight)) : 2;
    const x = Math.round((chartLeft + index * slotWidth + (slotWidth - barWidth) / 2) * 100) / 100;
    const y = chartBottom - rawHeight;
    const showAxisLabel = index === 0 || index === count - 1 || index % labelStep === 0;
    return {
      dayUtc: point.day_utc,
      shortLabel: formatShortUtcDay(point.day_utc),
      views: point.views,
      x,
      y,
      width: Math.round(barWidth * 100) / 100,
      height: rawHeight,
      showAxisLabel,
    };
  });

  return {
    viewBoxWidth,
    viewBoxHeight,
    chartTop,
    chartBottom,
    peakViews,
    totalViews,
    bars,
  };
}

export function isDeceasedPersonForBadge(person: Person | undefined): boolean {
  if (!person) {
    return false;
  }
  return !person.is_living && person.full_name.trim() !== 'Living' && person.slug.trim().length > 0;
}

export function isPublicNarrativeForBadge(
  narrative: Narrative | undefined,
  subjectPerson: Person | undefined,
  people: readonly Person[] | undefined
): boolean {
  if (!narrative) {
    return false;
  }
  if (subjectPerson && !isDeceasedPersonForBadge(subjectPerson)) {
    return false;
  }
  const linkedIds = narrative.person_ids ?? [];
  if (linkedIds.length > 0 && people) {
    const peopleById = new Map(people.map((p) => [p.id, p]));
    for (const id of linkedIds) {
      const linked = peopleById.get(id);
      if (linked && !isDeceasedPersonForBadge(linked)) {
        return false;
      }
    }
  }
  return Boolean((narrative.slug || narrative.id).trim());
}
