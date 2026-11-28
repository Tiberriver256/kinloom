import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { cachedJsonCall } from '../../runtime/cache.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  FREEREG_SEARCH_SPEC,
  renderFreeregSearchHelp,
  renderTnaGetHelp,
  renderTnaSearchHelp,
  renderUrlHelp,
  TNA_GET_SPEC,
  TNA_SEARCH_SPEC,
  URL_SPEC,
} from './cliSpecs.js';
import {
  ALLOWED_TNA_HOSTS,
  buildDiscoveryQuery,
  collectionDepartment,
  DISCOVERY_DETAIL,
  DISCOVERY_SEARCH,
  DISCOVERY_WEB,
  type DiscoveryHit,
  FREEREG_BASE,
  FREEREG_RECORD_TYPES,
  type FreeregCachePayload,
  GENUKI_PARISHES,
  getCacheDir,
  isFreeregCachePayload,
  mapDiscoveryDetail,
  mapDiscoveryHit,
  matchesCollection,
  normalizeDateFrom,
  normalizeDateTo,
  resolveChapmanCode,
  resolveTtlHours,
  validateIaid,
} from './domain.js';
import { fetchFreeregSearch, getJson } from './transport.js';

export async function runTnaSearch(
  argv: readonly string[],
  ctx: RecordCommandContext,
  groupName: string
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TNA_SEARCH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderTnaSearchHelp(groupName)) };
  }

  const resolvedQuery = parsed.positionals[0] ?? getStringOption(parsed, 'queryOpt');
  if (!resolvedQuery?.trim()) {
    throw new CliValidationError('Provide QUERY as a positional argument or via --query.');
  }

  const heldBy = getStringOption(parsed, 'heldBy');
  const collection = getStringOption(parsed, 'collection');
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const page = getNumberOption(parsed, 'page');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const q = buildDiscoveryQuery(resolvedQuery, heldBy, collection);
  const df = normalizeDateFrom(getStringOption(parsed, 'dateFrom'));
  const dt = normalizeDateTo(getStringOption(parsed, 'dateTo'));
  if (df && dt && df > dt) {
    throw new CliValidationError('--start-date must not be later than --end-date.');
  }

  const params: Record<string, string | number> = {
    'sps.searchQuery': q,
    rows: Math.min(Math.max(limit, 1), 100),
  };
  const dept = collectionDepartment(collection);
  if (dept) {
    params['sps.departments'] = dept;
  }
  if (df) {
    params['sps.dateFrom'] = df;
  }
  if (dt) {
    params['sps.dateTo'] = dt;
  }
  if (page !== undefined) {
    params['sps.page'] = page;
  }

  const { value: data, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
    cacheDir: getCacheDir(ctx),
    kind: 'discovery_search',
    payload: params,
    ttlHours,
    refresh,
    fetch: () => getJson(ctx, DISCOVERY_SEARCH, params, ALLOWED_TNA_HOSTS, 'Discovery search'),
    cacheable: (r) => Array.isArray(r['records']) && (r['records'].length > 0 || Number(r['count'] ?? 0) > 0),
    validateCached: isPlainRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  const rawRecords = Array.isArray(data['records']) ? data['records'] : [];
  let records: DiscoveryHit[] = rawRecords
    .filter((item): item is Record<string, unknown> => isPlainRecord(item))
    .map(mapDiscoveryHit);

  if (collection) {
    records = records.filter((rec) => matchesCollection(rec, collection));
  }
  records = records.slice(0, limit);
  const total = typeof data['count'] === 'number' ? data['count'] : records.length;

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(
        ctx.io,
        {
          query: q,
          collection: collection ?? null,
          start_date: df,
          end_date: dt,
          total,
          returned: records.length,
          records,
          cache_hit: cacheHit,
        },
        1
      ),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${total} hit(s) for "${q}"; showing ${records.length}:${marker}`];
  for (const rec of records) {
    const places = rec.places.join(', ');
    lines.push(`${rec.id}  ${rec.reference}  ${rec.covering_dates}`);
    lines.push(`  ${rec.title}`);
    if (places) {
      lines.push(`  Places: ${places}`);
    }
    lines.push(`  ${rec.record_url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runTnaGet(
  argv: readonly string[],
  ctx: RecordCommandContext,
  groupName: string
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TNA_GET_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderTnaGetHelp(groupName)) };
  }

  const iaid = validateIaid(parsed.positionals[0]);
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const url = `${DISCOVERY_DETAIL}/${iaid}`;

  const { value: raw, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
    cacheDir: getCacheDir(ctx),
    kind: 'discovery_detail',
    payload: { id: iaid },
    ttlHours,
    refresh,
    fetch: () => getJson(ctx, url, undefined, ALLOWED_TNA_HOSTS, 'Discovery detail'),
    cacheable: (r) => Boolean(r['id'] || r['citableReference'] || r['referencePart']),
    validateCached: isPlainRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  const detail = mapDiscoveryDetail(raw);
  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...detail, cache_hit: cacheHit }, 1),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${detail.id ?? ''}  ${detail.citable_reference ?? ''}  ${detail.covering_dates ?? ''}${marker}`,
  ];
  if (detail.description) {
    lines.push(`  ${detail.description}`);
  }
  if (detail.held_by.length > 0) {
    lines.push(`  Held by: ${detail.held_by.join('; ')}`);
  }
  lines.push(`  Digitised: ${String(detail.digitised)}  Legal status: ${detail.legal_status ?? 'n/a'}`);
  lines.push(`  ${detail.record_url}`);
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runFreeregSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, FREEREG_SEARCH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderFreeregSearchHelp()) };
  }

  const surname = getStringOption(parsed, 'surname') ?? '';
  const given = getStringOption(parsed, 'given');
  const county = getStringOption(parsed, 'county') ?? 'NTT';
  const fromYear = getStringOption(parsed, 'fromYear');
  const toYear = getStringOption(parsed, 'toYear');
  const rawRecordType = (getStringOption(parsed, 'recordType') ?? 'all').toLowerCase();
  if (!(rawRecordType in FREEREG_RECORD_TYPES)) {
    throw new CliValidationError(
      `Invalid value '${rawRecordType}' for '--record-type'. Expected one of: all, baptism, marriage, burial.`
    );
  }
  const placeContains = getStringOption(parsed, 'placeContains');
  const limit = getNumberOption(parsed, 'limit');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const chapman = resolveChapmanCode(county);
  const formData: Record<string, string> = {
    utf8: '✓',
    'search_query[last_name]': surname,
    'search_query[chapman_codes][]': chapman,
    commit: 'Search',
  };
  if (given) {
    formData['search_query[first_name]'] = given;
  }
  if (fromYear) {
    formData['search_query[start_year]'] = fromYear;
  }
  if (toYear) {
    formData['search_query[end_year]'] = toYear;
  }
  const rtCode = FREEREG_RECORD_TYPES[rawRecordType];
  if (rtCode) {
    formData['search_query[record_type]'] = rtCode;
  }

  const queryPayload = {
    surname: surname.trim().toLowerCase(),
    given: (given ?? '').trim().toLowerCase(),
    county: chapman,
    from_year: (fromYear ?? '').trim(),
    to_year: (toYear ?? '').trim(),
    record_type: rawRecordType,
  };

  const { value: cachedData, cacheHit } = await cachedJsonCall<FreeregCachePayload>({
    cacheDir: getCacheDir(ctx),
    kind: 'freereg_search',
    payload: queryPayload,
    ttlHours,
    refresh,
    fetch: () => fetchFreeregSearch(ctx, formData),
    cacheable: (r) => r.records.length > 0,
    validateCached: isFreeregCachePayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  let records = [...cachedData.records];
  if (placeContains) {
    const needle = placeContains.toLowerCase();
    records = records.filter((rec) => rec.register.toLowerCase().includes(needle));
  }
  if (limit !== undefined) {
    records = records.slice(0, limit);
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(
        ctx.io,
        {
          surname,
          county: chapman,
          returned: records.length,
          records,
          cache_hit: cacheHit,
        },
        1
      ),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${records.length} FreeREG hit(s) for ${surname} (${chapman}):${marker}`];
  for (const rec of records) {
    lines.push(`${rec.event_date}  ${rec.record_type}  ${rec.persons}`);
    lines.push(`  ${rec.register}  (${rec.county})`);
    if (rec.transcript_url) {
      lines.push(`  ${rec.transcript_url}`);
    }
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const discoveryQuery = getStringOption(parsed, 'discoveryQuery');
  const freereg = getBooleanOption(parsed, 'freereg');
  const nottsProvided = parsed.provided.has('nottsQuery');
  const nottsQuery = getStringOption(parsed, 'nottsQuery');
  const bhoQuery = getStringOption(parsed, 'bhoQuery');
  const genuki = getStringOption(parsed, 'genuki');

  const lines: string[] = [];
  if (discoveryQuery) {
    lines.push(
      `https://discovery.nationalarchives.gov.uk/results/r?_q=${encodeURIComponent(discoveryQuery)}&_p=100`
    );
  }
  if (freereg) {
    lines.push(`${FREEREG_BASE}/`);
  }
  if (nottsProvided) {
    lines.push('https://nawcat.nottinghamshire.gov.uk/CalmView/');
    lines.push(
      `  (browser-only: HTTPS to nawcat timed out after 45s in automated checks; search in CalmView for: ${nottsQuery || 'Lincoln'})`
    );
  }
  if (bhoQuery) {
    lines.push(
      `https://www.british-history.ac.uk/search?${new URLSearchParams({ query: bhoQuery }).toString()}`
    );
  }
  if (genuki && GENUKI_PARISHES[genuki]) {
    lines.push(GENUKI_PARISHES[genuki]);
  }
  if (lines.length === 0) {
    lines.push(
      DISCOVERY_WEB.replace(/\/$/, ''),
      `${FREEREG_BASE}/`,
      'https://www.british-history.ac.uk/',
      GENUKI_PARISHES['nottinghamshire']
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}
