import {
  parseUiBookCompileResponse,
  parseUiBookEstimateResponse,
  parseUiBookStatusResponse,
  parseUiBookSubmitJobResponse,
  type UiBookCompileInput,
  type UiBookCompileResponse,
  type UiBookEstimateInput,
  type UiBookEstimateResponse,
  type UiBookPrintJob,
  type UiBookStatusResponse,
  type UiBookSubmitJobInput,
  type UiBookSubmitJobResponse,
} from '../lib/bookPublishingModel.js';
import { ApiClientError, parseErrorEnvelope, stripTrailingSlash } from './httpWiki/httpClient.js';
import { resolvePluginRequestCredentials } from './pluginApiClient.js';

export interface BookPublishingClient {
  getStatus(options?: { readonly signal?: AbortSignal }): Promise<UiBookStatusResponse | null>;
  compileBook(input: UiBookCompileInput): Promise<UiBookCompileResponse>;
  estimateCost(input: UiBookEstimateInput): Promise<UiBookEstimateResponse>;
  submitPrintJob(input: UiBookSubmitJobInput): Promise<UiBookSubmitJobResponse>;
  getJobStatus(jobId: string): Promise<UiBookPrintJob>;
}

export interface HttpBookPublishingClientOptions {
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly credentials?: RequestCredentials;
}

/**
 * HTTP transport adapter for the opt-in Kinloom book-publishing server plugin endpoints.
 * Isolates all `/api/plugins/book-publishing/*` fetches inside packages/ui/src/adapters/.
 */
export function createHttpBookPublishingClient(
  options: HttpBookPublishingClientOptions = {}
): BookPublishingClient {
  const apiBase = stripTrailingSlash(options.apiBaseUrl ?? '');
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const credentials = resolvePluginRequestCredentials(apiBase, options.credentials);

  const apiUrl = (path: string): string => `${apiBase}${path}`;

  return {
    async getStatus(reqOptions?: { readonly signal?: AbortSignal }): Promise<UiBookStatusResponse | null> {
      const res = await fetchImpl(apiUrl('/api/plugins/book-publishing/status'), {
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
        return parseUiBookStatusResponse(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid book publishing status payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    async compileBook(input: UiBookCompileInput): Promise<UiBookCompileResponse> {
      const res = await fetchImpl(apiUrl('/api/plugins/book-publishing/compile'), {
        method: 'POST',
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
        return parseUiBookCompileResponse(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid book compile payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    async estimateCost(input: UiBookEstimateInput): Promise<UiBookEstimateResponse> {
      const res = await fetchImpl(apiUrl('/api/plugins/book-publishing/estimate'), {
        method: 'POST',
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
        return parseUiBookEstimateResponse(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid book estimate payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    async submitPrintJob(input: UiBookSubmitJobInput): Promise<UiBookSubmitJobResponse> {
      const res = await fetchImpl(apiUrl('/api/plugins/book-publishing/jobs'), {
        method: 'POST',
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
        return parseUiBookSubmitJobResponse(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid print job payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    async getJobStatus(jobId: string): Promise<UiBookPrintJob> {
      const res = await fetchImpl(apiUrl(`/api/plugins/book-publishing/jobs/${encodeURIComponent(jobId)}`), {
        credentials,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        throw await parseErrorEnvelope(res);
      }
      const raw: unknown = await res.json();
      try {
        return parseUiBookSubmitJobResponse(raw).job;
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid print job status payload: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}
