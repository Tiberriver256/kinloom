import {
  OBSERVABILITY_STATS_SERVER_PLUGIN_ID,
  parseAdminObservabilityStats,
  parsePublicPageVisitCount,
  type UiAdminObservabilityStats,
  type UiObservabilityStatsWindow,
  type UiPublicPageVisitCount,
} from '../lib/observabilityStatsModel.js';
import { ApiClientError, parseErrorEnvelope, stripTrailingSlash } from './httpWiki/httpClient.js';

export interface ObservabilityStatsClient {
  getAdminStats(
    window?: UiObservabilityStatsWindow,
    options?: { readonly signal?: AbortSignal }
  ): Promise<UiAdminObservabilityStats | null>;
  setPublicBadgesEnabled(enabled: boolean): Promise<boolean>;
  getPublicPageVisitCount(
    params: { readonly kind: 'person' | 'place' | 'narrative'; readonly slug: string },
    options?: { readonly signal?: AbortSignal }
  ): Promise<UiPublicPageVisitCount | null>;
}

export interface HttpObservabilityStatsClientOptions {
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * HTTP transport adapter for the opt-in Kinloom page visit observability plugin endpoints.
 * Keeps all `/api/admin/observability/*` and `/api/observability/*` HTTP I/O isolated inside adapters/.
 */
export function createHttpObservabilityStatsClient(
  options: HttpObservabilityStatsClientOptions = {}
): ObservabilityStatsClient {
  const apiBase = stripTrailingSlash(options.apiBaseUrl ?? '');
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));

  const apiUrl = (path: string): string => `${apiBase}${path}`;

  return {
    async getAdminStats(
      window: UiObservabilityStatsWindow = '30d',
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<UiAdminObservabilityStats | null> {
      const qs = new URLSearchParams({ window }).toString();
      const res = await fetchImpl(apiUrl(`/api/admin/observability/stats?${qs}`), {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: reqOptions?.signal,
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw await parseErrorEnvelope(res);
      }
      const raw: unknown = await res.json();
      try {
        return parseAdminObservabilityStats(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid observability stats payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    async setPublicBadgesEnabled(enabled: boolean): Promise<boolean> {
      const res = await fetchImpl(
        apiUrl(`/api/admin/plugin-settings/${encodeURIComponent(OBSERVABILITY_STATS_SERVER_PLUGIN_ID)}`),
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            values: { show_public_visit_badges: enabled },
          }),
        }
      );
      if (!res.ok) {
        throw await parseErrorEnvelope(res);
      }
      const raw: unknown = await res.json();
      if (
        typeof raw === 'object' &&
        raw !== null &&
        'plugin' in raw &&
        typeof raw.plugin === 'object' &&
        raw.plugin !== null &&
        'values' in raw.plugin &&
        typeof raw.plugin.values === 'object' &&
        raw.plugin.values !== null &&
        'show_public_visit_badges' in raw.plugin.values &&
        typeof (raw.plugin.values as Record<string, unknown>).show_public_visit_badges === 'boolean'
      ) {
        return (raw.plugin.values as Record<string, boolean>).show_public_visit_badges;
      }
      return enabled;
    },

    async getPublicPageVisitCount(
      params: { readonly kind: 'person' | 'place' | 'narrative'; readonly slug: string },
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<UiPublicPageVisitCount | null> {
      const qs = new URLSearchParams({ kind: params.kind, slug: params.slug }).toString();
      try {
        const res = await fetchImpl(apiUrl(`/api/observability/page-visits?${qs}`), {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: reqOptions?.signal,
        });
        if (!res.ok) {
          return null;
        }
        const raw: unknown = await res.json();
        return parsePublicPageVisitCount(raw);
      } catch {
        return null;
      }
    },
  };
}
