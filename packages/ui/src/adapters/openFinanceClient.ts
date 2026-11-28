import {
  parseUiOpenFinanceAdminConfig,
  parseUiOpenFinanceSummary,
  type UiOpenFinanceAdminConfigPayload,
  type UiOpenFinanceConfigInput,
  type UiOpenFinancePublicSummary,
} from '../lib/openFinanceModel.js';
import { ApiClientError, parseErrorEnvelope, stripTrailingSlash } from './httpWiki/httpClient.js';
import { resolvePluginRequestCredentials } from './pluginApiClient.js';

export interface OpenFinanceClient {
  getPublicSummary(options?: {
    readonly signal?: AbortSignal;
    readonly cache?: RequestCache;
  }): Promise<UiOpenFinancePublicSummary | null>;
  getAdminConfig(options?: {
    readonly signal?: AbortSignal;
  }): Promise<UiOpenFinanceAdminConfigPayload | null>;
  saveAdminConfig(input: UiOpenFinanceConfigInput): Promise<UiOpenFinanceAdminConfigPayload>;
}

export interface HttpOpenFinanceClientOptions {
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly credentials?: RequestCredentials;
}

/**
 * HTTP transport adapter for the opt-in Kinloom open-finance plugin endpoints.
 * Keeps all `/api/open-finance/*` and `/api/admin/open-finance/*` HTTP I/O isolated inside adapters/.
 */
export function createHttpOpenFinanceClient(options: HttpOpenFinanceClientOptions = {}): OpenFinanceClient {
  const apiBase = stripTrailingSlash(options.apiBaseUrl ?? '');
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const credentials = resolvePluginRequestCredentials(apiBase, options.credentials);

  const apiUrl = (path: string): string => `${apiBase}${path}`;

  return {
    async getPublicSummary(reqOptions?: {
      readonly signal?: AbortSignal;
      readonly cache?: RequestCache;
    }): Promise<UiOpenFinancePublicSummary | null> {
      const res = await fetchImpl(apiUrl('/api/open-finance/summary'), {
        credentials,
        headers: { accept: 'application/json' },
        signal: reqOptions?.signal,
        ...(reqOptions?.cache ? { cache: reqOptions.cache } : {}),
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw await parseErrorEnvelope(res);
      }
      const raw: unknown = await res.json();
      try {
        return parseUiOpenFinanceSummary(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid open-finance summary payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    async getAdminConfig(reqOptions?: {
      readonly signal?: AbortSignal;
    }): Promise<UiOpenFinanceAdminConfigPayload | null> {
      const res = await fetchImpl(apiUrl('/api/admin/open-finance/config'), {
        credentials,
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
        return parseUiOpenFinanceAdminConfig(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid admin open-finance payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    async saveAdminConfig(input: UiOpenFinanceConfigInput): Promise<UiOpenFinanceAdminConfigPayload> {
      const res = await fetchImpl(apiUrl('/api/admin/open-finance/config'), {
        method: 'PUT',
        credentials,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw await parseErrorEnvelope(res);
      }
      const raw: unknown = await res.json();
      try {
        return parseUiOpenFinanceAdminConfig(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid saved open-finance payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}
