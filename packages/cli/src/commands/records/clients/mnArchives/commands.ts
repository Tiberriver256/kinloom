import { CliValidationError } from '../../../../errors.js';
import {
  type CommandParseSpec,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { cachedJsonCall } from '../../runtime/cache.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  CACHE_AND_JSON_OPTIONS,
  MDL_OPTIONS,
  NEWSPAPERS_DOWNLOAD_OPTIONS,
  NEWSPAPERS_SEARCH_OPTIONS,
  peopleSearchOptions,
  RECORD_OPTIONS,
  renderNewspapersHelp,
} from './cliSpecs.js';
import {
  buildPeopleQuery,
  getCacheDir,
  MDL_DPLA_URL,
  MDL_HOME_URL,
  type NewspaperMetadataResult,
  type NewspaperSearchResult,
  type PeopleRecordDetailResult,
  type PeopleSearchResult,
  RECORD_TYPE_SPECS,
  resolveRecordType,
  resolveTtl,
  UUID_RE,
} from './domain.js';
import {
  isNewspaperMetadataResult,
  isNewspaperSearchResult,
  isPeopleRecordDetailResult,
  isPeopleSearchResult,
  validateNewspaperDocId,
} from './parsers.js';
import {
  downloadNewspaperThumb,
  fetchNewspapersMetadata,
  fetchNewspapersSearch,
  fetchPeopleRecord,
  fetchPeopleSearch,
} from './transport.js';

function formatPeopleText(result: PeopleSearchResult, cacheHit: boolean): string {
  const marker = cacheHit ? ' [cache]' : '';
  const label = RECORD_TYPE_SPECS[result.record_type]?.label ?? result.record_type;
  const lines: string[] = [
    `${label} | total=${result.total} | page ${result.page}/${Math.max(result.page_count, 1)} | showing ${result.results.length}${marker}`,
  ];
  for (const rec of result.results) {
    const parts: string[] = [rec.name || '(unnamed)'];
    if (rec.date) parts.push(rec.date);
    if (rec.county) parts.push(rec.county);
    if (rec.locality) parts.push(rec.locality);
    if (rec.age) parts.push(`age ${rec.age}`);
    if (rec.mothers_maiden_name) parts.push(`mother ${rec.mothers_maiden_name}`);
    if (rec.certificate_id) parts.push(`cert ${rec.certificate_id}`);
    if (rec.id) parts.push(`id ${rec.id}`);
    lines.push(parts.join(' | '));
  }
  return lines.join('\n');
}

export async function runPeopleCommand(
  ctx: RecordCommandContext,
  rest: readonly string[],
  fixedRecordType: string | null,
  subcmdName: string,
  summary: string,
  includeMother: boolean
): Promise<RecordCommandOutcome> {
  const options = peopleSearchOptions(includeMother, fixedRecordType === null);
  const spec: CommandParseSpec = { options, allowPositionals: false };
  const parsed = parseCommandArgs(rest, spec);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: `kinloom mn-archives ${subcmdName} [options]`,
          summary,
          options,
        })
      ),
    };
  }

  const recordType =
    fixedRecordType ?? resolveRecordType(getStringOption(parsed, 'recordType') ?? 'death-records');
  const page = getNumberOption(parsed, 'page') ?? 1;
  const limit = getNumberOption(parsed, 'limit') ?? 25;
  if (page < 1) {
    throw new CliValidationError('--page must be >= 1.');
  }
  if (limit < 1 || limit > 100) {
    throw new CliValidationError('--limit must be between 1 and 100.');
  }

  const queryBody = buildPeopleQuery(recordType, {
    last: getStringOption(parsed, 'last') ?? '',
    first: getStringOption(parsed, 'first') ?? '',
    middle: getStringOption(parsed, 'middle') ?? '',
    motherMaiden: includeMother ? (getStringOption(parsed, 'motherMaiden') ?? '') : '',
    county: getStringOption(parsed, 'county') ?? '',
    match: getStringOption(parsed, 'match') ?? 'equals',
    beginDate: getStringOption(parsed, 'beginYear') ?? '',
    endDate: getStringOption(parsed, 'endYear') ?? '',
    certId: getStringOption(parsed, 'certId') ?? '',
  });

  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const { value: result, cacheHit } = await cachedJsonCall<PeopleSearchResult>({
    cacheDir: getCacheDir(ctx),
    kind: `people:${recordType}`,
    payload: { record_type: recordType, query: queryBody, page, limit },
    ttlHours,
    refresh,
    fetch: () => fetchPeopleSearch(ctx, recordType, queryBody, page, limit),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isPeopleSearchResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatPeopleText(result, cacheHit)),
    cacheHit,
  };
}

export async function runRecordCommand(
  ctx: RecordCommandContext,
  rest: readonly string[]
): Promise<RecordCommandOutcome> {
  const spec: CommandParseSpec = {
    options: RECORD_OPTIONS,
    allowPositionals: true,
    minPositionals: 1,
    maxPositionals: 1,
    positionalLabel: 'uuid',
  };
  const parsed = parseCommandArgs(rest, spec);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom mn-archives record <UUID> --type <TYPE> [options]',
          summary: 'Fetch a single MNHS People Record by UUID and --type.',
          options: RECORD_OPTIONS,
        })
      ),
    };
  }

  const rawUuid = parsed.positionals[0] ?? '';
  const recordType = resolveRecordType(getStringOption(parsed, 'recordType') ?? '');
  const cleanId = rawUuid.trim();
  if (!UUID_RE.test(cleanId)) {
    throw new CliValidationError(`Invalid MNHS record UUID: '${rawUuid}'`);
  }

  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const { value: result, cacheHit } = await cachedJsonCall<PeopleRecordDetailResult>({
    cacheDir: getCacheDir(ctx),
    kind: `record:${recordType}`,
    payload: { record_type: recordType, id: cleanId },
    ttlHours,
    refresh,
    fetch: () => fetchPeopleRecord(ctx, recordType, cleanId),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isPeopleRecordDetailResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const summary = result.summary;
  const label = RECORD_TYPE_SPECS[recordType]?.label ?? recordType;
  const lines: string[] = [`${label}${marker}`, `  Name: ${summary.name || '(unnamed)'}`];
  if (summary.date) lines.push(`  Date: ${summary.date}`);
  if (summary.county) lines.push(`  County: ${summary.county}`);
  if (summary.certificate_id) lines.push(`  Certificate ID: ${summary.certificate_id}`);
  if (summary.mothers_maiden_name) {
    lines.push(`  Mother's maiden name: ${summary.mothers_maiden_name}`);
  }
  if (summary.birth_date) lines.push(`  Birth date: ${summary.birth_date}`);
  if (summary.birth_place) lines.push(`  Birth place: ${summary.birth_place}`);
  lines.push(`  URL: ${result.url}`);
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runNewspapersSearch(
  ctx: RecordCommandContext,
  subRest: readonly string[]
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(subRest, {
    options: NEWSPAPERS_SEARCH_OPTIONS,
    allowPositionals: true,
    minPositionals: 1,
    maxPositionals: 1,
    positionalLabel: 'query',
  });
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom mn-archives newspapers search <QUERY> [options]',
          summary: 'Search digitized Minnesota newspapers.',
          options: NEWSPAPERS_SEARCH_OPTIONS,
        })
      ),
    };
  }
  const query = parsed.positionals[0] ?? '';
  const field = getStringOption(parsed, 'field') ?? 'content';
  const beginYear = getStringOption(parsed, 'beginYear') ?? '';
  const endYear = getStringOption(parsed, 'endYear') ?? '';
  const county = getStringOption(parsed, 'county') ?? '';
  const city = getStringOption(parsed, 'city') ?? '';
  const title = getStringOption(parsed, 'title') ?? '';
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  if (limit < 1 || limit > 100) {
    throw new CliValidationError('--limit must be between 1 and 100.');
  }
  if (offset < 0) {
    throw new CliValidationError('--offset must be >= 0.');
  }
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const { value: result, cacheHit } = await cachedJsonCall<NewspaperSearchResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'newspapers:search',
    payload: {
      query: query.trim(),
      field,
      begin_year: beginYear,
      end_year: endYear,
      county,
      city,
      title,
      limit,
      offset,
    },
    ttlHours,
    refresh,
    fetch: () =>
      fetchNewspapersSearch(ctx, {
        query,
        field,
        beginDate: beginYear,
        endDate: endYear,
        county,
        city,
        title,
        limit,
        offset,
      }),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isNewspaperSearchResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `MNHS Digital Newspaper Hub | total=${result.total} | offset=${result.offset} | showing ${result.results.length}${marker}`,
  ];
  for (const item of result.results) {
    const parts = [
      item.title || '(untitled)',
      item.publication_date || '',
      item.doc_id || '',
      item.viewer_url || '',
    ].filter(Boolean);
    lines.push(parts.join(' | '));
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runNewspapersMetadata(
  ctx: RecordCommandContext,
  subRest: readonly string[]
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(subRest, {
    options: CACHE_AND_JSON_OPTIONS,
    allowPositionals: true,
    minPositionals: 1,
    maxPositionals: 1,
    positionalLabel: 'doc_id',
  });
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom mn-archives newspapers metadata <DOC_ID> [options]',
          summary: 'Fetch structured metadata for a newspaper issue doc_id.',
          options: CACHE_AND_JSON_OPTIONS,
        })
      ),
    };
  }
  const cleanId = validateNewspaperDocId(parsed.positionals[0] ?? '');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const { value: result, cacheHit } = await cachedJsonCall<NewspaperMetadataResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'newspapers:metadata',
    payload: { doc_id: cleanId },
    ttlHours,
    refresh,
    fetch: () => fetchNewspapersMetadata(ctx, cleanId),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isNewspaperMetadataResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`Newspaper Metadata (${cleanId})${marker}`];
  for (const [key, val] of Object.entries(result.fields)) {
    lines.push(`  ${key}: ${val}`);
  }
  lines.push(`  Viewer: ${result.viewer_url}`);
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runNewspapersDownload(
  ctx: RecordCommandContext,
  subRest: readonly string[]
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(subRest, {
    options: NEWSPAPERS_DOWNLOAD_OPTIONS,
    allowPositionals: true,
    minPositionals: 1,
    maxPositionals: 1,
    positionalLabel: 'target',
  });
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom mn-archives newspapers download <TARGET> --out <PATH> [options]',
          summary: 'Download a verified newspaper issue thumbnail image.',
          options: NEWSPAPERS_DOWNLOAD_OPTIONS,
        })
      ),
    };
  }
  const target = parsed.positionals[0] ?? '';
  const out = getStringOption(parsed, 'out') ?? '';
  const overwrite = getBooleanOption(parsed, 'overwrite');
  const asJson = getBooleanOption(parsed, 'asJson');
  const info = await downloadNewspaperThumb(ctx, target, out, overwrite);
  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, info) };
  }
  const verb = info.skipped ? 'Exists (skip)' : 'Downloaded';
  return {
    exitCode: 0,
    bytesOut: emitStdout(
      ctx.io,
      `${verb}: ${info.path} (${info.bytes.toLocaleString('en-US')} bytes, ${info.format})`
    ),
  };
}

export async function runNewspapersCommand(
  ctx: RecordCommandContext,
  rest: readonly string[]
): Promise<RecordCommandOutcome> {
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderNewspapersHelp()) };
  }

  const [sub, ...subRest] = rest;
  switch (sub) {
    case 'search':
      return await runNewspapersSearch(ctx, subRest);
    case 'metadata':
      return await runNewspapersMetadata(ctx, subRest);
    case 'download':
      return await runNewspapersDownload(ctx, subRest);
    default:
      throw new CliValidationError(
        `No such newspapers command '${sub}'. Choose from: search, metadata, download.`
      );
  }
}

export function runMdlCommand(ctx: RecordCommandContext, rest: readonly string[]): RecordCommandOutcome {
  const parsed = parseCommandArgs(rest, {
    options: MDL_OPTIONS,
    allowPositionals: false,
  });
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom mn-archives mdl [options]',
          summary: 'Show browser-only URLs for Minnesota Digital Library.',
          options: MDL_OPTIONS,
        })
      ),
    };
  }
  const payload = {
    name: 'Minnesota Digital Library',
    status: 'browser-only',
    reason: 'Automated HTTP requests to collection.mndigital.org receive HTTP 403 (Cloudflare challenge).',
    home_url: MDL_HOME_URL,
    dpla_url: MDL_DPLA_URL,
  };
  if (getBooleanOption(parsed, 'asJson')) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const text = [
    'Minnesota Digital Library (browser only):',
    `  Home: ${MDL_HOME_URL}`,
    `  DPLA partner search: ${MDL_DPLA_URL}`,
    '  Note: collection.mndigital.org gates automated HTTP requests behind Cloudflare (HTTP 403).',
    '  Use a browser for MDL photographs, county histories, plats, and archival manuscripts.',
  ].join('\n');
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
}
