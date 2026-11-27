import { CliValidationError } from '../../../../errors.js';
import { DEFAULT_USER_AGENT, httpRequest, SsrfBlockedError } from '../../runtime/http.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  ALLOWED_API_HOSTS,
  ALLOWED_DOWNLOAD_HOSTS,
  BILDVISNING_BASE,
  IIIF_BASE,
  IIIF_COLLECTION_BASE,
  type IiifCollectionResult,
  type IiifManifestResult,
  MAX_HTTP_ATTEMPTS,
  REGISTER_BASE_URL,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_MS,
  type RegisterDetailResult,
  type SearchEndpointResult,
  TRANSIENT_STATUS_CODES,
  validateSeUrl,
} from './domain.js';
import { normalizeSearchItem, parseIiifCollectionBody, parseIiifManifestBody } from './parsers.js';

export interface SeHttpResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Headers;
  readonly bytes: Buffer;
}

export async function requestWithRetry(
  ctx: RecordCommandContext,
  options: {
    readonly url: string;
    readonly allowedHosts?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
  }
): Promise<SeHttpResponse> {
  const allowedHosts = options.allowedHosts ?? ALLOWED_API_HOSTS;
  validateSeUrl(options.url, allowedHosts);
  try {
    const res = await httpRequest(options.url, {
      method: 'GET',
      headers: options.headers,
      userAgent: DEFAULT_USER_AGENT,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxAttempts: MAX_HTTP_ATTEMPTS,
      baseBackoffMs: RETRY_BASE_MS,
      retryStatuses: TRANSIENT_STATUS_CODES,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts },
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
      throwOnHttpError: false,
    });
    validateSeUrl(res.url, allowedHosts);
    if (res.status >= 400) {
      throw new RecordRuntimeError(`HTTP ${res.status} from ${res.url}`);
    }
    return res;
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      let host = '';
      try {
        host = new URL(err.url).hostname.toLowerCase();
      } catch {
        host = err.url;
      }
      throw new CliValidationError(
        `Refusing host '${host}'; allowed hosts: ${[...allowedHosts].toSorted().join(', ')}.`
      );
    }
    if (err instanceof CliValidationError || err instanceof RecordRuntimeError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Riksarkivet request failed: ${message}`);
  }
}

export async function fetchRecordsEndpoint(
  ctx: RecordCommandContext,
  baseUrl: string,
  params: Readonly<Record<string, string | number>>
): Promise<SearchEndpointResult> {
  const target = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    target.searchParams.set(k, String(v));
  }
  const res = await requestWithRetry(ctx, {
    url: target.toString(),
    headers: { Accept: 'application/json' },
  });
  let body: unknown;
  try {
    body = JSON.parse(res.bytes.toString('utf8'));
  } catch {
    throw new RecordRuntimeError(`Riksarkivet API returned non-JSON response from ${baseUrl}`);
  }
  if (!isPlainRecord(body) || !Array.isArray(body.items)) {
    throw new RecordRuntimeError(`Unexpected Riksarkivet API payload from ${baseUrl}`);
  }
  const items = body.items
    .filter((it): it is Record<string, unknown> => isPlainRecord(it))
    .map(normalizeSearchItem);
  return {
    total: Number(body.totalHits ?? 0),
    hits: Number(body.hits ?? items.length),
    offset: Number(body.offset ?? params.offset ?? 0),
    results: items,
    verified: true,
  };
}

export async function fetchRegisterDetail(
  ctx: RecordCommandContext,
  cleanId: string
): Promise<RegisterDetailResult> {
  const url = `${REGISTER_BASE_URL}/${encodeURIComponent(cleanId)}`;
  const res = await requestWithRetry(ctx, {
    url,
    headers: { Accept: 'application/json' },
  });
  let body: unknown;
  try {
    body = JSON.parse(res.bytes.toString('utf8'));
  } catch {
    throw new RecordRuntimeError(`Riksarkivet register endpoint returned non-JSON for ${cleanId}`);
  }
  if (!isPlainRecord(body)) {
    throw new RecordRuntimeError(`Unexpected register detail payload for ${cleanId}`);
  }
  return {
    id: cleanId,
    url,
    record: body,
    verified: true,
  };
}

export async function fetchIiifCollection(
  ctx: RecordCommandContext,
  cleanId: string
): Promise<IiifCollectionResult> {
  const url = `${IIIF_COLLECTION_BASE}/${encodeURIComponent(cleanId)}`;
  const res = await requestWithRetry(ctx, {
    url,
    headers: { Accept: 'application/json' },
  });
  let body: unknown;
  try {
    body = JSON.parse(res.bytes.toString('utf8'));
  } catch {
    throw new RecordRuntimeError(`Riksarkivet IIIF collection returned non-JSON for ${cleanId}`);
  }
  return parseIiifCollectionBody(body, cleanId, url);
}

export async function fetchIiifManifest(
  ctx: RecordCommandContext,
  volumeId: string
): Promise<IiifManifestResult> {
  const url = `${IIIF_BASE}/arkis!${encodeURIComponent(volumeId)}/manifest`;
  let res: SeHttpResponse;
  try {
    res = await requestWithRetry(ctx, {
      url,
      allowedHosts: ALLOWED_DOWNLOAD_HOSTS,
      headers: { Accept: 'application/json' },
    });
  } catch (err: unknown) {
    if (err instanceof RecordRuntimeError && err.message.includes('HTTP 403')) {
      throw new RecordRuntimeError(
        `HTTP 403 from ${url}: this volume is restricted on the public IIIF endpoint (check ${BILDVISNING_BASE}/${volumeId} in a browser).`
      );
    }
    throw err;
  }

  let body: unknown;
  try {
    body = JSON.parse(res.bytes.toString('utf8'));
  } catch {
    throw new RecordRuntimeError(`Riksarkivet IIIF manifest returned non-JSON from ${url}`);
  }
  return parseIiifManifestBody(body, volumeId, url);
}
