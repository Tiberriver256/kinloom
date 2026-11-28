import { ApiClientError, parseErrorEnvelope, stripTrailingSlash } from './httpWiki/apiError.js';

export interface PluginApiClient {
  requestJson<T>(
    path: string,
    parse: (raw: unknown) => T,
    init?: Omit<RequestInit, 'credentials'>
  ): Promise<T>;
  uploadMultipart<T>(
    path: string,
    formData: FormData,
    parse: (raw: unknown) => T,
    options?: { readonly signal?: AbortSignal }
  ): Promise<T>;
  deleteNoContent(path: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  resolveUrl(path: string): string;
}

export interface HttpPluginApiClientOptions {
  /** Base origin or path prefix; defaults to '' (same-origin). */
  readonly apiBaseUrl?: string | undefined;
  /** Optional custom fetch implementation for hermetic tests or custom runtimes. */
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * Optional fetch credentials mode. Defaults to 'same-origin' for relative/same-origin URLs,
   * and 'include' when `apiBaseUrl` is a cross-origin absolute URL in a browser context.
   */
  readonly credentials?: RequestCredentials | undefined;
}

/**
 * Resolves the effective fetch credentials mode for plugin HTTP clients.
 * Uses explicit override when supplied; otherwise defaults to 'include' for cross-origin
 * absolute `apiBaseUrl` in a browser context and 'same-origin' otherwise.
 */
export function resolvePluginRequestCredentials(
  apiBaseUrl?: string,
  explicit?: RequestCredentials
): RequestCredentials {
  if (explicit !== undefined) {
    return explicit;
  }
  const trimmed = apiBaseUrl?.trim() ?? '';
  if (/^https?:\/\//i.test(trimmed)) {
    const currentOrigin = typeof window !== 'undefined' ? window.location?.origin : undefined;
    if (currentOrigin && currentOrigin !== 'null') {
      try {
        if (new URL(trimmed).origin !== currentOrigin) {
          return 'include';
        }
      } catch {
        return 'same-origin';
      }
    }
  }
  return 'same-origin';
}

/**
 * Generic, CSRF-safe HTTP transport adapter for Kinloom UI plugins.
 * Isolates all `/api/plugins/*` fetch traffic inside `packages/ui/src/adapters/`
 * to uphold the `no-raw-ui-api-fetch` architecture invariant.
 */
export function createHttpPluginApiClient(options: HttpPluginApiClientOptions = {}): PluginApiClient {
  const apiBase = stripTrailingSlash(options.apiBaseUrl ?? '');
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const credentials = resolvePluginRequestCredentials(apiBase, options.credentials);

  const resolveUrl = (path: string): string => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${apiBase}${normalizedPath}`;
  };

  return {
    resolveUrl,

    async requestJson<T>(
      path: string,
      parse: (raw: unknown) => T,
      init?: Omit<RequestInit, 'credentials'>
    ): Promise<T> {
      const headers = new Headers(init?.headers);
      if (!headers.has('accept')) {
        headers.set('accept', 'application/json');
      }
      const res = await fetchImpl(resolveUrl(path), {
        ...init,
        credentials,
        headers,
      });
      if (!res.ok) {
        throw await parseErrorEnvelope(res);
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid JSON response from ${path}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        return parse(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Response validation failed for ${path}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    async uploadMultipart<T>(
      path: string,
      formData: FormData,
      parse: (raw: unknown) => T,
      reqOptions?: { readonly signal?: AbortSignal }
    ): Promise<T> {
      const res = await fetchImpl(resolveUrl(path), {
        method: 'POST',
        credentials,
        headers: { accept: 'application/json' },
        body: formData,
        ...(reqOptions?.signal ? { signal: reqOptions.signal } : {}),
      });
      if (!res.ok) {
        throw await parseErrorEnvelope(res);
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Invalid multipart JSON response from ${path}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        return parse(raw);
      } catch (err) {
        throw new ApiClientError(
          res.status,
          'INVALID_API_RESPONSE',
          `Multipart response validation failed for ${path}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },

    async deleteNoContent(path: string, reqOptions?: { readonly signal?: AbortSignal }): Promise<void> {
      const res = await fetchImpl(resolveUrl(path), {
        method: 'DELETE',
        credentials,
        headers: { accept: 'application/json' },
        ...(reqOptions?.signal ? { signal: reqOptions.signal } : {}),
      });
      if (!res.ok) {
        throw await parseErrorEnvelope(res);
      }
    },
  };
}
