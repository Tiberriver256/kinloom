import type { OptimisticConflictError } from '@kinloom/core';
import { asRevisionId, OptimisticConflictErrorSchema } from '@kinloom/core';

export {
  ApiClientError,
  normalizeAssetBase,
  parseErrorEnvelope,
  stripTrailingSlash,
} from './apiError.js';

export interface HttpWikiDataSourceOptions {
  /** Base origin or path prefix, defaults to '' (same-origin). */
  apiBaseUrl?: string;
  /** Optional static asset base URL for readings.json fallback. */
  assetBaseUrl?: string;
  fetchImpl?: typeof fetch;
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
