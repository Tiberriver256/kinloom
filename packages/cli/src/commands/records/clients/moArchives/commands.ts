import fs from 'node:fs';
import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { cachedJsonCall } from '../../runtime/cache.js';
import { resolveSafeChildPath, resolveUserPathFromContext } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  DEATH_SPEC,
  DETAIL_SPEC,
  DOWNLOAD_SPEC,
  PRE1910_SPEC,
  renderDeathHelp,
  renderDetailHelp,
  renderDownloadHelp,
  renderMdhHelp,
  renderPre1910Help,
} from './cliSpecs.js';
import {
  ALL_COUNTIES,
  ALL_COUNTIES_PRE1910,
  ARCHIVES_HOME,
  type DeathRecord,
  type DetailRecord,
  getMoCacheDir,
  isDeathSearchCachePayload,
  isDetailRecord,
  isPre1910SearchCachePayload,
  MATCH_METHODS,
  MDH_HOME,
  MDH_SEARCH,
  type Pre1910Record,
  resolveMoTtl,
  type SearchCachePayload,
  safePdfFilename,
} from './domain.js';
import { downloadPdf, fetchDetail, searchDeath, searchPre1910 } from './transport.js';

export async function runDeath(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, DEATH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDeathHelp()) };
  }
  const last = getStringOption(parsed, 'last') ?? '';
  const first = getStringOption(parsed, 'first') ?? '';
  const middle = getStringOption(parsed, 'middle') ?? '';
  const role = getStringOption(parsed, 'role') ?? 'deceased';
  const match = getStringOption(parsed, 'match') ?? 'contains';
  const county = getStringOption(parsed, 'county') ?? '';
  const beginYear = getNumberOption(parsed, 'beginYear') ?? 1910;
  const endYear = getNumberOption(parsed, 'endYear') ?? 1975;
  const beginMonth = getNumberOption(parsed, 'beginMonth') ?? 0;
  const endMonth = getNumberOption(parsed, 'endMonth') ?? 0;
  const limit = getNumberOption(parsed, 'limit') ?? 50;
  const asJson = getBooleanOption(parsed, 'asJson');
  const downloadDirRaw = getStringOption(parsed, 'downloadDir');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveMoTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  if (!(1910 <= beginYear && beginYear <= endYear && endYear <= 1975)) {
    throw new CliValidationError('year range must sit inside 1910-1975.');
  }
  if (beginMonth < 0 || beginMonth > 12 || endMonth < 0 || endMonth > 12) {
    throw new CliValidationError('months must be 0-12 (0 = all).');
  }
  if (limit < 1) {
    throw new CliValidationError('--limit must be at least 1.');
  }

  const method = MATCH_METHODS[match] ?? 'Contains';
  const roleCap = role.charAt(0).toUpperCase() + role.slice(1);
  const formData: Record<string, string> = {
    DeathCertNameSearchType: roleCap,
    LastName: last,
    LNSearchMethod: method,
    FirstName: first,
    FNSearchMethod: method,
    MiddleName: middle,
    MNSearchMethod: method,
    BeginMonth: String(beginMonth),
    BeginYear: String(beginYear),
    EndMonth: String(endMonth),
    EndYear: String(endYear),
    CountyName: county || ALL_COUNTIES,
    Search: 'Search',
  };
  const cachePayload = {
    last,
    first,
    middle,
    role,
    match,
    county,
    begin_year: beginYear,
    end_year: endYear,
    begin_month: beginMonth,
    end_month: endMonth,
    limit,
  };

  const { value: result, cacheHit } = await cachedJsonCall<SearchCachePayload<DeathRecord>>({
    cacheDir: getMoCacheDir(ctx),
    kind: 'death',
    payload: cachePayload,
    ttlHours,
    refresh,
    fetch: () => searchDeath(ctx, formData, limit),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isDeathSearchCachePayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  let bytesOut = 0;
  if (downloadDirRaw) {
    const dlDir = resolveUserPathFromContext(downloadDirRaw, ctx);
    fs.mkdirSync(dlDir, { recursive: true });
    const dlLines: string[] = [];
    for (const rec of result.results) {
      if (!rec.image) continue;
      const fname = safePdfFilename(rec.image);
      const dest = resolveSafeChildPath(dlDir, fname);
      const info = await downloadPdf(ctx, rec.image, dest, false);
      dlLines.push(
        `${info.skipped ? 'Exists (skip)' : 'Downloaded'}: ${info.dest} (${info.size.toLocaleString('en-US')} bytes)`
      );
    }
    if (dlLines.length > 0) {
      bytesOut += emitStdout(ctx.io, dlLines.join('\n'));
    }
  }

  if (asJson) {
    bytesOut += emitJsonStdout(ctx.io, {
      total: result.total,
      results: result.results,
      cache_hit: cacheHit,
    });
    return { exitCode: 0, bytesOut, cacheHit };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`Total: ${result.total} | showing ${result.results.length}${marker}`];
  for (const rec of result.results) {
    const parts: string[] = [rec.name];
    if (rec.age) parts.push(`age ${rec.age}`);
    if (rec.date_of_death) parts.push(rec.date_of_death);
    if (rec.county) parts.push(rec.county);
    if (rec.cert) parts.push(`cert ${rec.cert}`);
    if (rec.image) parts.push(rec.image);
    lines.push(parts.filter(Boolean).join(' | '));
  }
  bytesOut += emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runPre1910(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, PRE1910_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPre1910Help()) };
  }
  const kind = (getStringOption(parsed, 'kind') ?? 'death') as 'birth' | 'death';
  const name = getStringOption(parsed, 'name') ?? '';
  const county = getStringOption(parsed, 'county') ?? '';
  const limit = getNumberOption(parsed, 'limit') ?? 50;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveMoTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  if (limit < 1) {
    throw new CliValidationError('--limit must be at least 1.');
  }

  const formData: Record<string, string> =
    kind === 'death'
      ? {
          DeathCounty: county || ALL_COUNTIES_PRE1910,
          DeathNameSearch: name,
          DeathSubmit: 'Search',
        }
      : {
          BirthCounty: county || ALL_COUNTIES_PRE1910,
          BirthNameSearch: name,
          BirthSubmit: 'Search',
        };

  const { value: result, cacheHit } = await cachedJsonCall<SearchCachePayload<Pre1910Record>>({
    cacheDir: getMoCacheDir(ctx),
    kind: 'pre1910',
    payload: { kind, name, county, limit },
    ttlHours,
    refresh,
    fetch: () => searchPre1910(ctx, kind, formData, limit),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isPre1910SearchCachePayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        total: result.total,
        results: result.results,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`Total: ${result.total} | showing ${result.results.length}${marker}`];
  for (const rec of result.results) {
    if ('date_of_death' in rec) {
      const parts = [
        rec.name,
        rec.age ? `age ${rec.age}` : '',
        rec.sex,
        rec.color,
        rec.date_of_death,
        rec.county,
        rec.detail_id ? `detail ${rec.detail_id}` : '',
      ].filter(Boolean);
      lines.push(parts.join(' | '));
    } else {
      const parts = [
        rec.name,
        rec.place,
        rec.county,
        rec.date_of_birth,
        rec.father ? `father ${rec.father}` : '',
        rec.mother ? `mother ${rec.mother}` : '',
        rec.detail_id ? `detail ${rec.detail_id}` : '',
      ].filter(Boolean);
      lines.push(parts.join(' | '));
    }
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runDetail(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, DETAIL_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDetailHelp()) };
  }
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveMoTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const records: (DetailRecord & { readonly cache_hit: boolean })[] = [];
  for (const rid of parsed.positionals) {
    const clean = rid.replace(/\D+/g, '');
    if (!clean) {
      throw new CliValidationError(`Invalid detail ID: '${rid}'`);
    }
    const { value: rec, cacheHit } = await cachedJsonCall<DetailRecord>({
      cacheDir: getMoCacheDir(ctx),
      kind: 'detail',
      payload: { id: clean },
      ttlHours,
      refresh,
      fetch: () => fetchDetail(ctx, clean),
      cacheable: (r) => Object.keys(r.fields).length > 0,
      validateCached: isDetailRecord,
      nowMs: ctx.nowMs,
      sleepFn: ctx.sleepFn,
    });
    records.push({ ...rec, cache_hit: cacheHit });
  }

  const allCached = records.length > 0 && records.every((r) => r.cache_hit);
  if (asJson) {
    const payload = records.length === 1 ? records[0] : records;
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, payload),
      cacheHit: allCached,
    };
  }
  const blocks: string[] = [];
  for (const rec of records) {
    const marker = rec.cache_hit ? ' [cache]' : '';
    const lines: string[] = [`Detail ${rec.id}: ${rec.url}${marker}`];
    for (const [key, val] of Object.entries(rec.fields)) {
      lines.push(`  ${key}: ${val}`);
    }
    blocks.push(lines.join('\n'));
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, blocks.join('\n\n')),
    cacheHit: allCached,
  };
}

export async function runDownload(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, DOWNLOAD_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDownloadHelp()) };
  }
  const outDirRaw = getStringOption(parsed, 'outDir') ?? 'mo-death-certs';
  const overwrite = getBooleanOption(parsed, 'overwrite');
  const outDir = resolveUserPathFromContext(outDirRaw, ctx);
  fs.mkdirSync(outDir, { recursive: true });
  const lines: string[] = [];
  for (const url of parsed.positionals) {
    const fname = safePdfFilename(url);
    const dest = resolveSafeChildPath(outDir, fname);
    const info = await downloadPdf(ctx, url, dest, overwrite);
    lines.push(
      `${info.skipped ? 'Exists (skip)' : 'Downloaded'}: ${info.dest} (${info.size.toLocaleString('en-US')} bytes)`
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

export function runMdh(rest: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  if (rest.includes('--help') || rest.includes('-h')) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderMdhHelp()) };
  }
  const text = [
    'Missouri Digital Heritage has no verified machine interface.',
    `  Home: ${MDH_HOME}`,
    `  Advanced Search (browser): ${MDH_SEARCH}`,
    `  Missouri State Archives: ${ARCHIVES_HOME}`,
    '  CONTENTdm dmwebservices returns 403 (Cloudflare) to automated requests,',
    '  and no GET search URL for the Advanced Search was verified.',
    '  Use the browser for MDH collections (soldiers, land patents,',
    '  naturalization, newspapers, plat books). The two vital-records',
    '  databases are covered by this CLI: `death` and `pre1910`.',
  ].join('\n');
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
}
