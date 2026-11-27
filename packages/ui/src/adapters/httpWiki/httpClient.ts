import type { OptimisticConflictError } from '@kinloom/core';
import { ApiErrorEnvelopeSchema, asRevisionId, OptimisticConflictErrorSchema } from '@kinloom/core';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface HttpWikiDataSourceOptions {
  /** Base origin or path prefix, defaults to '' (same-origin). */
  apiBaseUrl?: string;
  /** Optional static asset base URL for readings.json fallback. */
  assetBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function normalizeAssetBase(raw?: string): string {
  const fallback = raw || '/';
  return fallback.endsWith('/') ? fallback : `${fallback}/`;
}

export async function parseErrorEnvelope(res: Response): Promise<ApiClientError> {
  try {
    const body: unknown = await res.json();
    const parsed = ApiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) {
      return new ApiClientError(
        res.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details
      );
    }
  } catch {
    // Response was not JSON; fall through to generic HTTP error.
  }
  return new ApiClientError(res.status, `HTTP_${res.status}`, `HTTP ${res.status} ${res.statusText}`);
}

export function normalizeConflict(details: unknown): OptimisticConflictError {
  const parsed = OptimisticConflictErrorSchema.parse(details);
  return {
    ...parsed,
    expected_parent_revision_id:
      parsed.expected_parent_revision_id === null ? null : asRevisionId(parsed.expected_parent_revision_id),
    server_revision_id: asRevisionId(parsed.server_revision_id),
  };
}
