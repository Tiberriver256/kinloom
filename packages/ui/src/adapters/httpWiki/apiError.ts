import type { ArchiveApiErrorShape } from '@kinloom/core';

export class ApiClientError extends Error implements ArchiveApiErrorShape {
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
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null
    ) {
      const errObj = body.error as Record<string, unknown>;
      if (
        typeof errObj['code'] === 'string' &&
        errObj['code'].length > 0 &&
        typeof errObj['message'] === 'string' &&
        errObj['message'].length > 0
      ) {
        return new ApiClientError(res.status, errObj['code'], errObj['message'], errObj['details']);
      }
    }
  } catch {
    // Response was not JSON; fall through to generic HTTP error.
  }
  return new ApiClientError(res.status, `HTTP_${res.status}`, `HTTP ${res.status} ${res.statusText}`);
}
