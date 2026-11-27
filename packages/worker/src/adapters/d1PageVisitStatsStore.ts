import {
  type DailyVisitPoint,
  type ObservabilityCacheOutcome,
  type ObservabilityCacheTotals,
  type PageVisitEntityKind,
  PageVisitEntityKindSchema,
  type PageVisitIncrementInput,
  type PageVisitStatsStore,
  type PageVisitTopRow,
} from '@kinloom/server';
import type { D1Database } from '../types.js';

function collectErrorMessages(error: unknown): string[] {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    if ('cause' in error && error.cause !== undefined) {
      parts.push(error.cause instanceof Error ? error.cause.message : String(error.cause));
    }
  } else {
    parts.push(String(error));
  }
  return parts;
}

function isMissingTableError(error: unknown): boolean {
  return collectErrorMessages(error).some((text) => text.toLowerCase().includes('no such table'));
}

function toNonNegativeInt(value: unknown): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }
  return Math.floor(num);
}

/**
 * Cloudflare D1 implementation of PageVisitStatsStore backed by `page_visit_daily`
 * and `observability_cache_daily` (migration 0005_page_visit_stats.sql).
 * Stores strictly aggregate route/day counts with zero cookies, IPs, or user identifiers.
 * Degrades cleanly if the migration has not been applied yet.
 */
export class D1PageVisitStatsStore implements PageVisitStatsStore {
  readonly adapterKind = 'd1';
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async incrementVisit(input: PageVisitIncrementInput): Promise<void> {
    const delta = input.delta ?? 1;
    if (!Number.isSafeInteger(delta) || delta <= 0) {
      return;
    }
    try {
      await this.db
        .prepare(
          `INSERT INTO page_visit_daily (route_key, entity_kind, entity_slug, day_utc, views)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(route_key, day_utc) DO UPDATE SET
             views = views + excluded.views`
        )
        .bind(input.routeKey, input.entityKind, input.entitySlug, input.dayUtc, delta)
        .run();
    } catch (error) {
      if (isMissingTableError(error)) {
        return;
      }
      throw error;
    }
  }

  async recordCacheEvent(input: {
    readonly dayUtc: string;
    readonly outcome: ObservabilityCacheOutcome;
  }): Promise<void> {
    const hitDelta = input.outcome === 'hit' ? 1 : 0;
    const missDelta = input.outcome === 'miss' ? 1 : 0;
    const notModifiedDelta = input.outcome === 'not_modified' ? 1 : 0;
    try {
      await this.db
        .prepare(
          `INSERT INTO observability_cache_daily (day_utc, hits, misses, not_modified)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(day_utc) DO UPDATE SET
             hits = hits + excluded.hits,
             misses = misses + excluded.misses,
             not_modified = not_modified + excluded.not_modified`
        )
        .bind(input.dayUtc, hitDelta, missDelta, notModifiedDelta)
        .run();
    } catch (error) {
      if (isMissingTableError(error)) {
        return;
      }
      throw error;
    }
  }

  async getDailySeries(params: {
    readonly sinceDayUtc: string;
    readonly untilDayUtc: string;
  }): Promise<readonly DailyVisitPoint[]> {
    try {
      const res = await this.db
        .prepare(
          `SELECT day_utc, SUM(views) AS total_views
           FROM page_visit_daily
           WHERE day_utc >= ? AND day_utc <= ?
           GROUP BY day_utc
           ORDER BY day_utc ASC`
        )
        .bind(params.sinceDayUtc, params.untilDayUtc)
        .all<{ day_utc?: unknown; total_views?: unknown }>();

      const out: DailyVisitPoint[] = [];
      for (const row of res.results) {
        if (typeof row.day_utc === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day_utc)) {
          out.push({
            day_utc: row.day_utc,
            views: toNonNegativeInt(row.total_views),
          });
        }
      }
      return out;
    } catch (error) {
      if (isMissingTableError(error)) {
        return [];
      }
      throw error;
    }
  }

  async getTopPages(params: {
    readonly sinceDayUtc?: string;
    readonly entityKinds?: readonly PageVisitEntityKind[];
    readonly limit: number;
  }): Promise<readonly PageVisitTopRow[]> {
    const limit = Math.max(0, Math.floor(params.limit));
    if (limit === 0) {
      return [];
    }

    const whereClauses: string[] = [];
    const bindings: unknown[] = [];

    if (params.sinceDayUtc) {
      whereClauses.push('day_utc >= ?');
      bindings.push(params.sinceDayUtc);
    }
    if (params.entityKinds && params.entityKinds.length > 0) {
      const placeholders = params.entityKinds.map(() => '?').join(', ');
      whereClauses.push(`entity_kind IN (${placeholders})`);
      bindings.push(...params.entityKinds);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    bindings.push(limit);

    try {
      const res = await this.db
        .prepare(
          `SELECT route_key, entity_kind, entity_slug, SUM(views) AS total_views
           FROM page_visit_daily
           ${whereSql}
           GROUP BY route_key, entity_kind, entity_slug
           ORDER BY total_views DESC, route_key ASC
           LIMIT ?`
        )
        .bind(...bindings)
        .all<{
          route_key?: unknown;
          entity_kind?: unknown;
          entity_slug?: unknown;
          total_views?: unknown;
        }>();

      const out: PageVisitTopRow[] = [];
      for (const row of res.results) {
        const parsedKind = PageVisitEntityKindSchema.safeParse(row.entity_kind);
        if (typeof row.route_key === 'string' && row.route_key.length > 0 && parsedKind.success) {
          out.push({
            route_key: row.route_key,
            entity_kind: parsedKind.data,
            entity_slug:
              typeof row.entity_slug === 'string' && row.entity_slug.length > 0 ? row.entity_slug : null,
            views: toNonNegativeInt(row.total_views),
          });
        }
      }
      return out;
    } catch (error) {
      if (isMissingTableError(error)) {
        return [];
      }
      throw error;
    }
  }

  async getTotalViews(params?: { readonly sinceDayUtc?: string }): Promise<number> {
    try {
      const stmt = params?.sinceDayUtc
        ? this.db
            .prepare('SELECT COALESCE(SUM(views), 0) AS total_views FROM page_visit_daily WHERE day_utc >= ?')
            .bind(params.sinceDayUtc)
        : this.db.prepare('SELECT COALESCE(SUM(views), 0) AS total_views FROM page_visit_daily');
      const row = await stmt.first<{ total_views?: unknown }>();
      return toNonNegativeInt(row?.total_views);
    } catch (error) {
      if (isMissingTableError(error)) {
        return 0;
      }
      throw error;
    }
  }

  async getPageTotalViews(routeKey: string): Promise<number> {
    try {
      const row = await this.db
        .prepare('SELECT COALESCE(SUM(views), 0) AS total_views FROM page_visit_daily WHERE route_key = ?')
        .bind(routeKey)
        .first<{ total_views?: unknown }>();
      return toNonNegativeInt(row?.total_views);
    } catch (error) {
      if (isMissingTableError(error)) {
        return 0;
      }
      throw error;
    }
  }

  async getCacheTotals(params?: { readonly sinceDayUtc?: string }): Promise<ObservabilityCacheTotals> {
    try {
      const stmt = params?.sinceDayUtc
        ? this.db
            .prepare(
              `SELECT
                 COALESCE(SUM(hits), 0) AS total_hits,
                 COALESCE(SUM(misses), 0) AS total_misses,
                 COALESCE(SUM(not_modified), 0) AS total_not_modified
               FROM observability_cache_daily
               WHERE day_utc >= ?`
            )
            .bind(params.sinceDayUtc)
        : this.db.prepare(
            `SELECT
               COALESCE(SUM(hits), 0) AS total_hits,
               COALESCE(SUM(misses), 0) AS total_misses,
               COALESCE(SUM(not_modified), 0) AS total_not_modified
             FROM observability_cache_daily`
          );
      const row = await stmt.first<{
        total_hits?: unknown;
        total_misses?: unknown;
        total_not_modified?: unknown;
      }>();
      return {
        hits: toNonNegativeInt(row?.total_hits),
        misses: toNonNegativeInt(row?.total_misses),
        not_modified: toNonNegativeInt(row?.total_not_modified),
      };
    } catch (error) {
      if (isMissingTableError(error)) {
        return { hits: 0, misses: 0, not_modified: 0 };
      }
      throw error;
    }
  }
}
