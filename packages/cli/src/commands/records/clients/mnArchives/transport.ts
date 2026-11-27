import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { atomicWriteFileSync } from '../../runtime/cache.js';
import { httpRequest } from '../../runtime/http.js';
import { isPlainRecord, resolveSafeChildPath, resolveUserPathFromContext } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  ALLOWED_DOWNLOAD_HOSTS,
  ALLOWED_HOSTS,
  type DownloadResult,
  dateToUtcMillis,
  MAX_HTTP_ATTEMPTS,
  MNHS_PEOPLE_API,
  MNHS_PEOPLE_RECORD_URL,
  NEWSPAPER_FIELD_MAP,
  NEWSPAPERS_METADATA_URL,
  NEWSPAPERS_SEARCH_URL,
  NEWSPAPERS_THUMB_URL,
  NEWSPAPERS_VIEWER_URL,
  type NewspaperMetadataResult,
  type NewspaperSearchResult,
  type PeopleQueryBody,
  type PeopleRecordDetailResult,
  type PeopleSearchResult,
  RECORD_TYPE_SPECS,
  RETRY_BASE_MS,
  TRANSIENT_STATUS_CODES,
  USER_AGENT,
  UUID_RE,
  validateMnUrl,
} from './domain.js';
import {
  detectImageFormat,
  looksLikeHtml,
  normalizePeopleHit,
  parseNewspapersMetadataHtml,
  parseNewspapersSearchHtml,
  validateNewspaperDocId,
} from './parsers.js';

export async function fetchPeopleSearch(
  ctx: RecordCommandContext,
  recordType: string,
  queryBody: PeopleQueryBody,
  page: number,
  limit: number
): Promise<PeopleSearchResult> {
  const spec = RECORD_TYPE_SPECS[recordType];
  const url = `${MNHS_PEOPLE_API}${spec.searchPath}?pageNum=${page}&pageSize=${limit}`;
  validateMnUrl(url, ALLOWED_HOSTS);
  const response = await httpRequest(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(queryBody),
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  let body: unknown;
  try {
    body = JSON.parse(response.bytes.toString('utf8')) as unknown;
  } catch {
    throw new RecordRuntimeError(`MNHS People API returned non-JSON response from ${url}`);
  }
  if (!isPlainRecord(body) || !(body.success === true || body.status === 200)) {
    throw new RecordRuntimeError(`MNHS People API returned unsuccessful status from ${url}`);
  }
  const data = body.data;
  if (!isPlainRecord(data)) {
    throw new RecordRuntimeError(`MNHS People API missing 'data' object from ${url}`);
  }
  const rawHits = data.hits;
  if (!Array.isArray(rawHits)) {
    throw new RecordRuntimeError(`MNHS People API missing 'hits' list from ${url}`);
  }
  const records = rawHits
    .filter((item): item is Record<string, unknown> => isPlainRecord(item))
    .map((item) => normalizePeopleHit(recordType, item));

  const total = Number(data.totalHitCount ?? 0) || 0;
  return {
    record_type: recordType,
    total,
    page: Number(data.pageNum ?? page) || page,
    page_size: Number(data.pageSize ?? limit) || limit,
    page_count: Number(data.pageCount ?? 0) || 0,
    results: records,
    verified: true,
  };
}

export async function fetchPeopleRecord(
  ctx: RecordCommandContext,
  recordType: string,
  recordId: string
): Promise<PeopleRecordDetailResult> {
  const cleanId = recordId.trim();
  if (!UUID_RE.test(cleanId)) {
    throw new CliValidationError(`Invalid MNHS record UUID: '${recordId}'`);
  }
  const spec = RECORD_TYPE_SPECS[recordType];
  const url = `${MNHS_PEOPLE_API}${spec.detailPath}?id=${encodeURIComponent(cleanId)}`;
  validateMnUrl(url, ALLOWED_HOSTS);
  const response = await httpRequest(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  let body: unknown;
  try {
    body = JSON.parse(response.bytes.toString('utf8')) as unknown;
  } catch {
    throw new RecordRuntimeError(`MNHS People API returned non-JSON detail response from ${url}`);
  }
  if (!isPlainRecord(body) || !(body.success === true || body.status === 200)) {
    throw new RecordRuntimeError(`MNHS People API detail lookup failed for ${cleanId}`);
  }
  const data = body.data;
  if (!isPlainRecord(data) || !data.id) {
    throw new RecordRuntimeError(`MNHS record not found: ${cleanId} (${recordType})`);
  }
  return {
    record_type: recordType,
    id: cleanId,
    summary: normalizePeopleHit(recordType, data),
    record: data,
    url: `${MNHS_PEOPLE_RECORD_URL}?uuid=${encodeURIComponent(cleanId)}&recordType=${encodeURIComponent(recordType)}`,
    verified: true,
  };
}

export async function fetchNewspapersSearch(
  ctx: RecordCommandContext,
  opts: {
    readonly query: string;
    readonly field: string;
    readonly beginDate: string;
    readonly endDate: string;
    readonly county: string;
    readonly city: string;
    readonly title: string;
    readonly limit: number;
    readonly offset: number;
  }
): Promise<NewspaperSearchResult> {
  const cleanQuery = opts.query.trim();
  if (cleanQuery.replace(/[*?]/g, '').length < 2) {
    throw new CliValidationError('Newspaper query must contain at least 2 non-wildcard characters.');
  }
  if (cleanQuery.includes(':') || cleanQuery.includes(';')) {
    throw new CliValidationError("Newspaper query cannot contain ':' or ';' characters.");
  }

  const params = new URLSearchParams();
  params.set('query1', cleanQuery);
  params.set('query1_field', NEWSPAPER_FIELD_MAP[opts.field] ?? 'CONTENT');
  params.set('query1_modifier', 'AND');
  params.set('result_items', String(opts.limit));
  params.set('start_index', String(opts.offset));

  let clause = 2;
  if (opts.beginDate.trim() || opts.endDate.trim()) {
    const minMs = dateToUtcMillis(opts.beginDate || '1849-01-01', false);
    const maxMs = dateToUtcMillis(opts.endDate || '2026-12-31', true);
    if (minMs > maxMs) {
      throw new CliValidationError('Begin date must not be after end date.');
    }
    params.set(`query${clause}_field`, 'DATE_PUBLISHED_MILLIS');
    params.set(`query${clause}_modifier`, 'AND');
    params.set(`query${clause}_min`, String(minMs));
    params.set(`query${clause}_max`, String(maxMs));
    clause += 1;
  }
  if (opts.county.trim()) {
    params.set(`query${clause}`, opts.county.trim().replace(/\s+County$/i, ''));
    params.set(`query${clause}_field`, 'SUBJECT_COUNTY');
    params.set(`query${clause}_modifier`, 'AND');
    clause += 1;
  }
  if (opts.city.trim()) {
    params.set(`query${clause}`, opts.city.trim());
    params.set(`query${clause}_field`, 'SUBJECT_CITY');
    params.set(`query${clause}_modifier`, 'AND');
    clause += 1;
  }
  if (opts.title.trim()) {
    params.set(`query${clause}`, opts.title.trim());
    params.set(`query${clause}_field`, 'TITLE');
    params.set(`query${clause}_modifier`, 'AND');
  }

  const url = `${NEWSPAPERS_SEARCH_URL}?${params.toString()}`;
  validateMnUrl(url, ALLOWED_HOSTS);
  const response = await httpRequest(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  const [rawTotal, items] = parseNewspapersSearchHtml(response.bytes.toString('utf8'));
  const verified = rawTotal !== null || items.length > 0;
  return {
    query: cleanQuery,
    field: opts.field,
    total: rawTotal !== null ? rawTotal : items.length,
    offset: opts.offset,
    limit: opts.limit,
    results: items.slice(0, opts.limit),
    verified,
  };
}

export async function fetchNewspapersMetadata(
  ctx: RecordCommandContext,
  docId: string
): Promise<NewspaperMetadataResult> {
  const cleanId = validateNewspaperDocId(docId);
  const quoted = encodeURIComponent(cleanId);
  const url = `${NEWSPAPERS_METADATA_URL}?doc_id=${quoted}`;
  validateMnUrl(url, ALLOWED_HOSTS);
  const response = await httpRequest(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  const fields = parseNewspapersMetadataHtml(response.bytes.toString('utf8'));
  if (Object.keys(fields).length === 0) {
    throw new RecordRuntimeError(`No metadata found for newspaper doc_id '${cleanId}'.`);
  }
  return {
    doc_id: cleanId,
    url,
    viewer_url: `${NEWSPAPERS_VIEWER_URL}?doc_id=${quoted}`,
    thumb_url: `${NEWSPAPERS_THUMB_URL}?tnName=${quoted}`,
    fields,
    verified: true,
  };
}

function resolveSafeOutputPath(out: string, defaultName: string, ctx: RecordCommandContext): string {
  const raw = out.trim();
  if (!raw || raw.includes('\0')) {
    throw new CliValidationError('Invalid output path.');
  }
  const normalizedSegments = raw.split(/[\\/]+/);
  if (normalizedSegments.includes('..')) {
    throw new CliValidationError(`Refusing output path with parent traversal segment ('..'): '${raw}'`);
  }
  const resolved = path.resolve(resolveUserPathFromContext(raw, ctx));

  const isExistingDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  if (raw.endsWith('/') || raw.endsWith('\\') || isExistingDir) {
    const safeLeaf =
      defaultName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'image.jpg';
    return resolveSafeChildPath(resolved, safeLeaf, {
      errorFactory: (msg) => new CliValidationError(msg),
      escapeRootLabel: 'target directory',
    });
  }
  return resolved;
}

export async function downloadNewspaperThumb(
  ctx: RecordCommandContext,
  docIdOrUrl: string,
  out: string,
  overwrite: boolean
): Promise<DownloadResult> {
  const raw = docIdOrUrl.trim();
  let url: string;
  let stem: string;
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    url = validateMnUrl(raw, ALLOWED_DOWNLOAD_HOSTS);
    const parsed = new URL(url);
    const tn = parsed.searchParams.get('tnName') ?? parsed.searchParams.get('doc_id') ?? '';
    stem = tn ? tn.replace(/[^A-Za-z0-9._-]+/g, '_') : 'newspaper_thumb';
  } else {
    const docId = validateNewspaperDocId(raw);
    url = `${NEWSPAPERS_THUMB_URL}?tnName=${encodeURIComponent(docId)}`;
    stem = docId.replace(/[^A-Za-z0-9._-]+/g, '_');
  }

  const dest = resolveSafeOutputPath(out, `${stem}.jpg`, ctx);
  if (fs.existsSync(dest) && !overwrite) {
    const data = fs.readFileSync(dest);
    const fmt = detectImageFormat(data);
    if (!fmt) {
      throw new RecordRuntimeError(
        `Existing file at ${dest} is not a valid image; pass --overwrite to replace.`
      );
    }
    return {
      url,
      path: dest,
      bytes: data.length,
      format: fmt,
      skipped: true,
    };
  }

  const response = await httpRequest(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    baseBackoffMs: RETRY_BASE_MS,
    retryStatuses: TRANSIENT_STATUS_CODES,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [...ALLOWED_DOWNLOAD_HOSTS] },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = response.bytes;
  if (payload.length === 0) {
    throw new RecordRuntimeError(`Refusing empty response body from ${url}`);
  }
  if (looksLikeHtml(payload, contentType)) {
    throw new RecordRuntimeError(
      `Refusing to save HTML response (Content-Type: ${contentType || 'unknown'}) as an image from ${url}`
    );
  }
  const fmt = detectImageFormat(payload);
  if (!fmt) {
    throw new RecordRuntimeError(
      `Refusing non-image payload (Content-Type: ${contentType || 'unknown'}) from ${url}`
    );
  }
  atomicWriteFileSync(dest, payload);
  return {
    url,
    path: dest,
    bytes: payload.length,
    format: fmt,
    skipped: false,
  };
}
