import {
  OBSERVABILITY_STATS_SERVER_PLUGIN_ID,
  parseAdminObservabilityStats,
  parsePublicObservabilityConfig,
  parsePublicPageVisitCount,
  type UiAdminObservabilityStats,
  type UiObservabilityStatsWindow,
  type UiPublicObservabilityConfig,
  type UiPublicPageVisitCount,
} from '../lib/observabilityStatsModel.js';
import { ApiClientError, parseErrorEnvelope, stripTrailingSlash } from './httpWiki/httpClient.js';
import { resolvePluginRequestCredentials } from './pluginApiClient.js';

export interface ObservabilityStatsClient {
  getAdminStats(
    window?: UiObservabilityStatsWindow,
    options?: { readonly signal?: AbortSignal }
  ): Promise<UiAdminObservabilityStats | null>;
  setPublicBadgesEnabled(enabled: boolean): Promise<boolean>;
  getPublicConfig?(options?: {
    readonly signal?: AbortSignal | undefined;
    readonly cache?: RequestCache | undefined;
  }): Promise<UiPublicObservabilityConfig | null>;
  getPublicPageVisitCount(
    params: { readonly kind: 'person' | 'place' | 'narrative'; readonly slug: string },
    options?: { readonly signal?: AbortSignal }
  ): Promise<UiPublicPageVisitCount | null>;
  recordPageVisit?(path: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface HttpObservabilityStatsClientOptions {
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly credentials?: RequestCredentials | undefined;
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
  const credentials = resolvePluginRequestCredentials(apiBase, options.credentials);

  const apiUrl = (path: string): string => `${apiBase}${path}`;

  return {
    async getAdminStats(
      window: UiObservabilityStatsWindow = '30d',
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<UiAdminObservabilityStats | null> {
      const qs = new URLSearchParams({ window }).toString();
      const res = await fetchImpl(apiUrl(`/api/admin/observability/stats?${qs}`), {
        credentials,
        headers: { accept: 'application/json' },
        ...(reqOptions?.signal ? { signal: reqOptions.signal } : {}),
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
          credentials,
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
        typeof (raw.plugin.values as Record<string, unknown>)['show_public_visit_badges'] === 'boolean'
      ) {
        return (raw.plugin.values as Record<string, boolean>)['show_public_visit_badges'] ?? false;
      }
      return enabled;
    },

    async getPublicConfig(reqOptions?: {
      readonly signal?: AbortSignal | undefined;
      readonly cache?: RequestCache | undefined;
    }): Promise<UiPublicObservabilityConfig | null> {
      try {
        const res = await fetchImpl(apiUrl('/api/observability/config'), {
          credentials,
          headers: { accept: 'application/json' },
          ...(reqOptions?.signal ? { signal: reqOptions.signal } : {}),
          ...(reqOptions?.cache ? { cache: reqOptions.cache } : {}),
        });
        if (!res.ok) {
          return null;
        }
        const raw: unknown = await res.json();
        return parsePublicObservabilityConfig(raw);
      } catch {
        return null;
      }
    },

    async getPublicPageVisitCount(
      params: { readonly kind: 'person' | 'place' | 'narrative'; readonly slug: string },
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<UiPublicPageVisitCount | null> {
      const qs = new URLSearchParams({ kind: params.kind, slug: params.slug }).toString();
      try {
        const res = await fetchImpl(apiUrl(`/api/observability/page-visits?${qs}`), {
          credentials,
          headers: { accept: 'application/json' },
          ...(reqOptions?.signal ? { signal: reqOptions.signal } : {}),
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

    async recordPageVisit(path: string, reqOptions?: { readonly signal?: AbortSignal }): Promise<void> {
      const trimmed = path.trim();
      if (!trimmed) {
        return;
      }
      try {
        await fetchImpl(apiUrl('/api/observability/page-visits/beacon'), {
          method: 'POST',
          credentials,
          keepalive: true,
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ path: trimmed }),
          ...(reqOptions?.signal ? { signal: reqOptions.signal } : {}),
        });
      } catch {
        // Best-effort beacon: never disrupt navigation or throw into UI boundaries.
      }
    },
  };
}
