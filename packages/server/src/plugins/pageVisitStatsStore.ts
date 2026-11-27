import type {
  DailyVisitPoint,
  ObservabilityCacheOutcome,
  ObservabilityCacheTotals,
  PageVisitEntityKind,
  PageVisitIncrementInput,
  PageVisitStatsStore,
  PageVisitTopRow,
} from './pageVisitStatsTypes.js';

interface StoredCounterEntry {
  readonly routeKey: string;
  readonly entityKind: PageVisitEntityKind;
  readonly entitySlug: string | null;
  readonly dayUtc: string;
  views: number;
}

interface StoredCacheDayEntry {
  hits: number;
  misses: number;
  notModified: number;
}

/**
 * Hermetic in-memory aggregate counter store for tests and local portable servers.
 * Stores strictly aggregate route/day counts with zero cookies, IPs, or user identifiers.
 */
export class InMemoryPageVisitStatsStore implements PageVisitStatsStore {
  readonly adapterKind = 'in-memory';
  private readonly counters = new Map<string, StoredCounterEntry>();
  private readonly cacheByDay = new Map<string, StoredCacheDayEntry>();

  async incrementVisit(input: PageVisitIncrementInput): Promise<void> {
    const delta = input.delta ?? 1;
    if (!Number.isSafeInteger(delta) || delta <= 0) {
      return;
    }
    const compositeKey = `${input.routeKey}\u0000${input.dayUtc}`;
    const existing = this.counters.get(compositeKey);
    if (existing) {
      existing.views += delta;
      return;
    }
    this.counters.set(compositeKey, {
      routeKey: input.routeKey,
      entityKind: input.entityKind,
      entitySlug: input.entitySlug,
      dayUtc: input.dayUtc,
      views: delta,
    });
  }

  async recordCacheEvent(input: {
    readonly dayUtc: string;
    readonly outcome: ObservabilityCacheOutcome;
  }): Promise<void> {
    let entry = this.cacheByDay.get(input.dayUtc);
    if (!entry) {
      entry = { hits: 0, misses: 0, notModified: 0 };
      this.cacheByDay.set(input.dayUtc, entry);
    }
    if (input.outcome === 'hit') {
      entry.hits += 1;
    } else if (input.outcome === 'miss') {
      entry.misses += 1;
    } else {
      entry.notModified += 1;
    }
  }

  async getDailySeries(params: {
    readonly sinceDayUtc: string;
    readonly untilDayUtc: string;
  }): Promise<readonly DailyVisitPoint[]> {
    const totalsByDay = new Map<string, number>();
    for (const entry of this.counters.values()) {
      if (entry.dayUtc < params.sinceDayUtc || entry.dayUtc > params.untilDayUtc) {
        continue;
      }
      totalsByDay.set(entry.dayUtc, (totalsByDay.get(entry.dayUtc) ?? 0) + entry.views);
    }
    return [...totalsByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day_utc, views]) => ({ day_utc, views }));
  }

  async getTopPages(params: {
    readonly sinceDayUtc?: string;
    readonly entityKinds?: readonly PageVisitEntityKind[];
    readonly limit: number;
  }): Promise<readonly PageVisitTopRow[]> {
    const kindFilter = params.entityKinds ? new Set<PageVisitEntityKind>(params.entityKinds) : null;
    const aggregated = new Map<
      string,
      {
        readonly route_key: string;
        readonly entity_kind: PageVisitEntityKind;
        readonly entity_slug: string | null;
        views: number;
      }
    >();

    for (const entry of this.counters.values()) {
      if (params.sinceDayUtc && entry.dayUtc < params.sinceDayUtc) {
        continue;
      }
      if (kindFilter && !kindFilter.has(entry.entityKind)) {
        continue;
      }
      const existing = aggregated.get(entry.routeKey);
      if (existing) {
        existing.views += entry.views;
      } else {
        aggregated.set(entry.routeKey, {
          route_key: entry.routeKey,
          entity_kind: entry.entityKind,
          entity_slug: entry.entitySlug,
          views: entry.views,
        });
      }
    }

    return [...aggregated.values()]
      .sort((a, b) => b.views - a.views || a.route_key.localeCompare(b.route_key))
      .slice(0, Math.max(0, params.limit));
  }

  async getTotalViews(params?: { readonly sinceDayUtc?: string }): Promise<number> {
    let total = 0;
    for (const entry of this.counters.values()) {
      if (params?.sinceDayUtc && entry.dayUtc < params.sinceDayUtc) {
        continue;
      }
      total += entry.views;
    }
    return total;
  }

  async getPageTotalViews(routeKey: string): Promise<number> {
    let total = 0;
    for (const entry of this.counters.values()) {
      if (entry.routeKey === routeKey) {
        total += entry.views;
      }
    }
    return total;
  }

  async getCacheTotals(params?: { readonly sinceDayUtc?: string }): Promise<ObservabilityCacheTotals> {
    let hits = 0;
    let misses = 0;
    let notModified = 0;
    for (const [dayUtc, entry] of this.cacheByDay.entries()) {
      if (params?.sinceDayUtc && dayUtc < params.sinceDayUtc) {
        continue;
      }
      hits += entry.hits;
      misses += entry.misses;
      notModified += entry.notModified;
    }
    return { hits, misses, not_modified: notModified };
  }

  clear(): void {
    this.counters.clear();
    this.cacheByDay.clear();
  }
}
