import path from 'node:path';
import * as cheerio from 'cheerio';
import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  type OptionSpec,
  parseCommandArgs,
} from '../../runtime/args.js';
import { cachedJsonCall } from '../../runtime/cache.js';
import { DEFAULT_RETRY_STATUSES, httpRequest, SsrfBlockedError } from '../../runtime/http.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { getCacheRoot } from './catalogCache.js';
import { resolveQueryTtlHours } from './queryAndRecords.js';
import { API_ATTEMPTS, API_READ_TIMEOUT_MS, USER_AGENT } from './types.js';

export const AAD_ORIGIN = 'https://aad.archives.gov';
export const AAD_SEARCH_BASE = `${AAD_ORIGIN}/aad/free-text-search-results.jsp`;
export const AAD_RECORD_BASE = `${AAD_ORIGIN}/aad/record-detail.jsp`;
export const ALLOWED_AAD_HOSTS = ['aad.archives.gov'] as const;

export const AAD_DATABASE_PRESETS: Readonly<
  Record<string, { readonly code: string; readonly label: string }>
> = {
  'wwii-enlistment': {
    code: 'WR26',
    label: 'World War II Army Enlistment Records, 1938-1946',
  },
  'wwii-pow': {
    code: 'WR25',
    label: 'World War II Prisoners of War Data File, 12/7/1941 - 11/19/1946',
  },
  'korean-casualties': {
    code: 'WR28',
    label: 'Korean Conflict Casualty File',
  },
  'vietnam-casualties': {
    code: 'WR29',
    label: 'Vietnam Conflict Extract Data File',
  },
};

export const AAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'query',
    kind: 'string',
    flags: ['--query', '-q'],
    metavar: 'QUERY',
    help: 'Free-text search query (or pass positional query terms).',
  },
  {
    key: 'database',
    kind: 'string',
    flags: ['--db', '--database', '--cat'],
    metavar: 'DB',
    help: 'AAD database preset (wwii-enlistment, wwii-pow, korean-casualties, vietnam-casualties) or category/table code.',
  },
  {
    key: 'record',
    kind: 'string',
    flags: ['--record', '--rid'],
    metavar: 'ID_OR_URL',
    help: 'Fetch a single AAD record detail by record ID (with --db) or full aad.archives.gov URL.',
  },
  {
    key: 'fields',
    kind: 'string',
    flags: ['--field'],
    multiple: true,
    metavar: 'KEY=VAL',
    help: 'Additional query parameter filter in key=value form (repeatable).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    min: 1,
    default: 1,
    metavar: 'N',
    help: '1-based result page number (default: 1).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit', '--rows'],
    min: 1,
    max: 100,
    default: 25,
    metavar: 'N',
    help: 'Maximum rows to return (1..100, default: 25).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit deterministic structured JSON with boolean cache_hit.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the local disk cache and fetch fresh AAD results.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_NARA_QUERY_TTL_HOURS; 0 disables reads).',
  },
];

export const AAD_PARSE_SPEC = {
  options: AAD_OPTIONS,
  allowPositionals: true,
} as const;

export interface AadSearchRecord {
  readonly record_id: string | null;
  readonly detail_url: string | null;
  readonly fields: Readonly<Record<string, string>>;
}

export interface AadSearchPayload {
  readonly query: string;
  readonly database: string | null;
  readonly url: string;
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly records: readonly AadSearchRecord[];
}

export interface AadRecordDetailPayload {
  readonly record_id: string;
  readonly database: string | null;
  readonly url: string;
  readonly title: string;
  readonly fields: Readonly<Record<string, string>>;
}

export function resolveAadDatabase(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const preset = AAD_DATABASE_PRESETS[trimmed.toLowerCase()];
  if (preset) {
    return preset.code;
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(trimmed)) {
    throw new CliValidationError(`Invalid AAD database code '${raw}'.`);
  }
  return trimmed;
}

export function validateAadUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CliValidationError(`Invalid AAD URL: '${rawUrl}'`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'aad.archives.gov') {
    throw new CliValidationError(`Refusing non-AAD URL '${rawUrl}'; expected https://aad.archives.gov/...`);
  }
  if (parsed.username || parsed.password) {
    throw new CliValidationError('Refusing URL containing embedded credentials.');
  }
  return parsed.toString();
}

export function buildAadSearchUrl(options: {
  readonly query: string;
  readonly database: string | null;
  readonly page: number;
  readonly limit: number;
  readonly extraFields: Readonly<Record<string, string>>;
}): string {
  const params = new URLSearchParams();
  params.set('q', options.query);
  if (options.database) {
    params.set('cat', options.database);
  }
  params.set('pg', String(options.page));
  params.set('rpp', String(options.limit));
  for (const key of Object.keys(options.extraFields).toSorted()) {
    const val = options.extraFields[key];
    if (val !== undefined) {
      params.set(key, val);
    }
  }
  return `${AAD_SEARCH_BASE}?${params.toString()}`;
}

export function buildAadRecordUrl(
  rawRecord: string,
  database: string | null
): {
  readonly recordId: string;
  readonly url: string;
} {
  const trimmed = rawRecord.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const validated = validateAadUrl(trimmed);
    const parsed = new URL(validated);
    const rid = parsed.searchParams.get('rid') ?? parsed.searchParams.get('id') ?? trimmed;
    return { recordId: rid, url: validated };
  }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(trimmed)) {
    throw new CliValidationError(`Invalid AAD record identifier '${rawRecord}'.`);
  }
  const params = new URLSearchParams();
  if (database) {
    params.set('dt', database);
  }
  params.set('rid', trimmed);
  return { recordId: trimmed, url: `${AAD_RECORD_BASE}?${params.toString()}` };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function resolveDetailLink(href: string | undefined): {
  readonly detailUrl: string | null;
  readonly recordId: string | null;
} {
  if (!href) {
    return { detailUrl: null, recordId: null };
  }
  try {
    const resolved = new URL(href, AAD_ORIGIN);
    if (resolved.hostname.toLowerCase() !== 'aad.archives.gov') {
      return { detailUrl: null, recordId: null };
    }
    const rid = resolved.searchParams.get('rid') ?? resolved.searchParams.get('id');
    return { detailUrl: resolved.toString(), recordId: rid };
  } catch {
    return { detailUrl: null, recordId: null };
  }
}

export function parseAadSearchHtml(
  html: string,
  meta: {
    readonly query: string;
    readonly database: string | null;
    readonly url: string;
    readonly page: number;
    readonly limit: number;
  }
): AadSearchPayload {
  const $ = cheerio.load(html);
  const bodyText = normalizeWhitespace($('body').text());
  const totalMatch = /(?:total\s+records|of|found)\s*[:\s]*([\d,]+)/i.exec(bodyText);
  const parsedTotal = totalMatch?.[1] ? Number.parseInt(totalMatch[1].replaceAll(',', ''), 10) : 0;

  const records: AadSearchRecord[] = [];
  const tables = $('table').toArray();
  for (const table of tables) {
    const rows = $(table).find('tr').toArray();
    if (rows.length < 2) {
      continue;
    }
    const headerCells = $(rows[0])
      .find('th, td')
      .toArray()
      .map((cell) => normalizeWhitespace($(cell).text()));
    if (headerCells.filter((h) => h.length > 0).length < 2) {
      continue;
    }

    for (let i = 1; i < rows.length && records.length < meta.limit; i += 1) {
      const cells = $(rows[i]).find('td').toArray();
      if (cells.length === 0) {
        continue;
      }
      const fields: Record<string, string> = {};
      let detailUrl: string | null = null;
      let recordId: string | null = null;

      for (let c = 0; c < cells.length; c += 1) {
        const cell = cells[c];
        if (!cell) continue;
        const key = headerCells[c] || `col_${c + 1}`;
        const text = normalizeWhitespace($(cell).text());
        if (text) {
          fields[key] = text;
        }
        if (!detailUrl) {
          const href = $(cell).find('a[href]').first().attr('href');
          const link = resolveDetailLink(href);
          if (link.detailUrl) {
            detailUrl = link.detailUrl;
            recordId = link.recordId;
          }
        }
      }
      if (Object.keys(fields).length > 0) {
        records.push({ record_id: recordId, detail_url: detailUrl, fields });
      }
    }
    if (records.length > 0) {
      break;
    }
  }

  return {
    query: meta.query,
    database: meta.database,
    url: meta.url,
    page: meta.page,
    limit: meta.limit,
    total: parsedTotal > 0 ? parsedTotal : records.length,
    records,
  };
}

export function parseAadRecordHtml(
  html: string,
  meta: { readonly recordId: string; readonly database: string | null; readonly url: string }
): AadRecordDetailPayload {
  const $ = cheerio.load(html);
  const title = normalizeWhitespace($('h1, h2, title').first().text()) || `AAD Record ${meta.recordId}`;
  const fields: Record<string, string> = {};

  for (const row of $('table tr').toArray()) {
    const cells = $(row).find('th, td').toArray();
    if (cells.length >= 2) {
      const key = normalizeWhitespace($(cells[0]).text()).replace(/:$/, '');
      const val = normalizeWhitespace($(cells[1]).text());
      if (key && val) {
        fields[key] = val;
      }
    }
  }

  return {
    record_id: meta.recordId,
    database: meta.database,
    url: meta.url,
    title,
    fields,
  };
}

function parseAadSearchJson(
  raw: unknown,
  meta: {
    readonly query: string;
    readonly database: string | null;
    readonly url: string;
    readonly page: number;
    readonly limit: number;
  }
): AadSearchPayload {
  if (!isPlainRecord(raw)) {
    throw new RecordRuntimeError('Unexpected non-object JSON payload from NARA AAD.');
  }
  const rawRecords = Array.isArray(raw['records'])
    ? raw['records']
    : Array.isArray(raw['results'])
      ? raw['results']
      : [];
  const records: AadSearchRecord[] = [];
  for (const entry of rawRecords.slice(0, meta.limit)) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const fields: Record<string, string> = {};
    const rawFields = isPlainRecord(entry['fields']) ? entry['fields'] : entry;
    for (const [k, v] of Object.entries(rawFields)) {
      if (k === 'record_id' || k === 'detail_url') continue;
      if (v !== null && v !== undefined && String(v).trim().length > 0) {
        fields[k] = String(v).trim();
      }
    }
    const rid =
      typeof entry['record_id'] === 'string'
        ? entry['record_id']
        : typeof entry['rid'] === 'string'
          ? entry['rid']
          : null;
    const detailUrl = typeof entry['detail_url'] === 'string' ? entry['detail_url'] : null;
    records.push({ record_id: rid, detail_url: detailUrl, fields });
  }
  const total =
    typeof raw['total'] === 'number' && Number.isFinite(raw['total']) ? raw['total'] : records.length;
  return {
    query: meta.query,
    database: meta.database,
    url: meta.url,
    page: meta.page,
    limit: meta.limit,
    total,
    records,
  };
}

function isAadSearchPayload(value: unknown): value is AadSearchPayload {
  return isPlainRecord(value) && Array.isArray(value['records']) && typeof value['url'] === 'string';
}

function isAadRecordDetailPayload(value: unknown): value is AadRecordDetailPayload {
  return isPlainRecord(value) && isPlainRecord(value['fields']) && typeof value['url'] === 'string';
}

async function fetchAadPage(
  ctx: RecordCommandContext,
  url: string,
  label: string
): Promise<{ readonly contentType: string; readonly text: string }> {
  validateAadUrl(url);
  try {
    const res = await httpRequest(url, {
      method: 'GET',
      headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.1' },
      userAgent: USER_AGENT,
      timeoutMs: API_READ_TIMEOUT_MS,
      maxAttempts: API_ATTEMPTS,
      baseBackoffMs: 500,
      retryStatuses: DEFAULT_RETRY_STATUSES,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_AAD_HOSTS, blockPrivateIps: true },
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
      throwOnHttpError: false,
    });
    validateAadUrl(res.url);
    if (res.status >= 400) {
      throw new RecordRuntimeError(`${label} returned HTTP ${res.status} from ${res.url}`);
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const text = res.bytes.toString('utf8');
    if (/service unavailable|access denied|temporarily unavailable/i.test(text) && !text.includes('<table')) {
      throw new RecordRuntimeError(`${label} returned an error page from ${res.url}`);
    }
    return { contentType, text };
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      throw new CliValidationError(err.message);
    }
    if (err instanceof CliValidationError || err instanceof RecordRuntimeError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`${label} request failed: ${message}`);
  }
}

export function parseExtraFields(rawFields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of rawFields) {
    const eqIdx = item.indexOf('=');
    if (eqIdx <= 0) {
      throw new CliValidationError(`Invalid --field '${item}'; expected KEY=VALUE.`);
    }
    const key = item.slice(0, eqIdx).trim();
    const value = item.slice(eqIdx + 1).trim();
    if (!key) {
      throw new CliValidationError(`Invalid --field '${item}'; key must not be empty.`);
    }
    out[key] = value;
  }
  return out;
}

export function renderAadHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom nara aad [QUERY...] [options]',
    summary: 'Search or fetch records from NARA Access to Archival Databases (aad.archives.gov).',
    options: AAD_OPTIONS,
    notes: [
      'Database presets (--db): wwii-enlistment (WR26), wwii-pow (WR25), korean-casualties (WR28), vietnam-casualties (WR29).',
      'Examples:',
      '  kinloom nara aad "Stout" --db wwii-enlistment --json',
      '  kinloom nara aad --db wwii-pow --query "Lincoln" --limit 10',
      '  kinloom nara aad --record 123456 --db WR26 --json',
    ],
  });
}

export async function runAad(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, AAD_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderAadHelp()) };
  }

  const database = resolveAadDatabase(getStringOption(parsed, 'database'));
  const recordOpt = getStringOption(parsed, 'record');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveQueryTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheDir = path.join(getCacheRoot(ctx), 'aad');

  if (recordOpt) {
    const { recordId, url } = buildAadRecordUrl(recordOpt, database);
    const { value, cacheHit } = await cachedJsonCall<AadRecordDetailPayload>({
      cacheDir,
      kind: 'nara_aad_record',
      payload: { record_id: recordId, database, url },
      ttlHours,
      refresh,
      fetch: async () => {
        const { contentType, text } = await fetchAadPage(ctx, url, 'NARA AAD record');
        if (contentType.includes('application/json')) {
          const parsedJson: unknown = JSON.parse(text);
          if (!isPlainRecord(parsedJson)) {
            throw new RecordRuntimeError('Unexpected non-object JSON payload from NARA AAD record.');
          }
          const rawFields = isPlainRecord(parsedJson['fields']) ? parsedJson['fields'] : parsedJson;
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawFields)) {
            if (v !== null && v !== undefined && String(v).trim().length > 0) {
              fields[k] = String(v).trim();
            }
          }
          return {
            record_id: recordId,
            database,
            url,
            title: typeof parsedJson['title'] === 'string' ? parsedJson['title'] : `AAD Record ${recordId}`,
            fields,
          };
        }
        return parseAadRecordHtml(text, { recordId, database, url });
      },
      cacheable: (r) => Object.keys(r.fields).length > 0,
      validateCached: isAadRecordDetailPayload,
      nowMs: ctx.nowMs,
      sleepFn: ctx.sleepFn,
    });

    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, {
        mode: 'record',
        ...value,
        cache_hit: cacheHit,
      });
      return { exitCode: 0, bytesOut, cacheHit };
    }
    const marker = cacheHit ? ' [cache]' : '';
    const lines = [`${value.title} (${value.record_id})${marker}`, `URL: ${value.url}`];
    for (const [k, v] of Object.entries(value.fields)) {
      lines.push(`  ${k}: ${v}`);
    }
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
  }

  const flagQuery = getStringOption(parsed, 'query')?.trim() ?? '';
  const posQuery = parsed.positionals
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(' ');
  const query = flagQuery || posQuery;
  if (!query) {
    throw new CliValidationError('Provide a search query (positional or --query) or --record <id|url>.');
  }

  const page = getNumberOption(parsed, 'page') ?? 1;
  const limit = getNumberOption(parsed, 'limit') ?? 25;
  const extraFields = parseExtraFields(getStringListOption(parsed, 'fields'));
  const url = buildAadSearchUrl({ query, database, page, limit, extraFields });

  const { value, cacheHit } = await cachedJsonCall<AadSearchPayload>({
    cacheDir,
    kind: 'nara_aad_search',
    payload: { query, database, page, limit, extraFields },
    ttlHours,
    refresh,
    fetch: async () => {
      const { contentType, text } = await fetchAadPage(ctx, url, 'NARA AAD search');
      const meta = { query, database, url, page, limit };
      if (contentType.includes('application/json')) {
        return parseAadSearchJson(JSON.parse(text), meta);
      }
      return parseAadSearchHtml(text, meta);
    },
    cacheable: (r) => Array.isArray(r.records),
    validateCached: isAadSearchPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      mode: 'search',
      ...value,
      returned: value.records.length,
      cache_hit: cacheHit,
    });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const dbLabel = value.database ? ` [${value.database}]` : '';
  const lines = [
    `NARA AAD${dbLabel}: ${value.total} record(s) for "${value.query}" (showing ${value.records.length}, page ${value.page})${marker}`,
    `URL: ${value.url}`,
  ];
  for (const rec of value.records) {
    const summary = Object.entries(rec.fields)
      .slice(0, 5)
      .map(([k, v]) => `${k}=${v}`)
      .join(' | ');
    lines.push(`- ${rec.record_id ? `[${rec.record_id}] ` : ''}${summary}`);
    if (rec.detail_url) {
      lines.push(`  ${rec.detail_url}`);
    }
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}
