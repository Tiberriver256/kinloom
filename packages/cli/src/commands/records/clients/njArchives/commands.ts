import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { cachedJsonCall } from '../../runtime/cache.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  DATABASES,
  MARRIAGE_DATABASES,
  MONMOUTH_CATEGORIES,
  MONMOUTH_SEARCH,
  MONMOUTH_TOWNS,
  type NjSearchCriteria,
  type NjSearchResult,
  ORDER_ONLY,
  PORTAL_BASE,
  PORTAL_INDEX,
} from './catalog.js';
import {
  DATABASES_SPEC,
  MONMOUTH_SPEC,
  renderDatabasesHelp,
  renderMonmouthHelp,
  renderSearchHelp,
  renderUrlHelp,
  SEARCH_SPEC,
  URL_SPEC,
} from './cliSpecs.js';
import { isNjSearchResult, matchOptionValue, resolveDatabase } from './parsers.js';
import { getCacheDir, listPortalDatabases, resolveTtl, searchMonmouth, searchPortal } from './transport.js';

export function emitNjResult(
  ctx: RecordCommandContext,
  result: NjSearchResult,
  cacheHit: boolean,
  asJson: boolean,
  limit: number | undefined
): RecordCommandOutcome {
  const total = result.rows.length;
  const rows = limit !== undefined ? result.rows.slice(0, limit) : result.rows;
  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, rows, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  const title = result.title ?? result.database;
  if (rows.length === 0) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(ctx.io, `${title}: no records found.`),
      cacheHit,
    };
  }
  const headerLine =
    `${title}: ${rows.length} result(s)` +
    (cacheHit ? ' [cache]' : '') +
    (result.capped_500 && total >= 500 ? ' (search capped at 500 records; narrow the criteria)' : '') +
    (result.pages_read > 1 ? ` (pages read: ${result.pages_read})` : '');
  const lines: string[] = [headerLine];
  const visibleHeaders = result.headers.filter((h) => h !== 'Select');
  rows.forEach((row, idx) => {
    const cells = visibleHeaders
      .map((h) => {
        const val = row[h];
        return typeof val === 'string' ? val : '';
      })
      .filter(Boolean);
    lines.push(`${idx + 1}. ${cells.join(' | ')}`);
    for (const link of row.links) {
      if (link.href.toLowerCase().endsWith('.pdf')) {
        lines.push(`   PDF: ${link.href}`);
      }
    }
  });
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runDatabases(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, DATABASES_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDatabasesHelp()) };
  }
  const live = await listPortalDatabases(ctx);
  if (getBooleanOption(parsed, 'asJson')) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, live) };
  }
  const lines: string[] = [];
  for (const entry of live) {
    const key = entry.key ? ` [${entry.key}]` : '';
    const count = entry.count ? ` -- ${entry.count}` : '';
    lines.push(`${entry.title}${key}${count}`);
  }
  lines.push('', 'Order-form only (no online search; use `nj-archives url <key>`):');
  for (const [key, [title]] of Object.entries(ORDER_ONLY)) {
    lines.push(`  ${title} [${key}]`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

export async function runSearch(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, SEARCH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }
  const database = resolveDatabase(parsed.positionals[0] ?? '');
  if (database === 'monmouth') {
    throw new CliValidationError(
      'Monmouth 1875 census is its own command: `nj-archives monmouth --surname <name>`.'
    );
  }
  const orderEntry = ORDER_ONLY[database];
  if (orderEntry) {
    const [title, page] = orderEntry;
    throw new CliValidationError(
      `${title} has no online search; it is a records-request (order) form. Open it in a browser: ${PORTAL_BASE}${page}`
    );
  }

  const surname = getStringOption(parsed, 'surname') ?? null;
  const given = getStringOption(parsed, 'given') ?? null;
  const spouseSurname = getStringOption(parsed, 'spouseSurname') ?? null;
  const spouseGiven = getStringOption(parsed, 'spouseGiven') ?? null;
  const county = getStringOption(parsed, 'county') ?? null;
  const location = getStringOption(parsed, 'location') ?? null;
  const fromYearNum = getNumberOption(parsed, 'fromYear');
  const toYearNum = getNumberOption(parsed, 'toYear');
  const role = getStringOption(parsed, 'role') ?? null;
  const caseType = getStringOption(parsed, 'caseType') ?? null;
  const caseNumber = getStringOption(parsed, 'caseNumber') ?? null;
  let keyword = getStringOption(parsed, 'keyword') ?? null;
  const limit = getNumberOption(parsed, 'limit');
  const pages = Math.max(1, getNumberOption(parsed, 'pages') ?? 1);
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const asJson = getBooleanOption(parsed, 'asJson');

  if (database === 'natguard-photos') {
    if (!keyword && !surname) {
      throw new CliValidationError('natguard-photos requires --keyword (or --surname as keyword).');
    }
    if (!keyword && surname) {
      keyword = surname;
    }
  } else if (!surname) {
    if (!(MARRIAGE_DATABASES.has(database) && spouseSurname)) {
      throw new CliValidationError(
        `Missing option '--surname'${MARRIAGE_DATABASES.has(database) ? ' (or --spouse-surname for marriage databases).' : '.'}`
      );
    }
  }

  const criteria: NjSearchCriteria = {
    surname,
    given,
    spouse_surname: spouseSurname,
    spouse_given: spouseGiven,
    county,
    location,
    from_year: fromYearNum !== undefined ? String(fromYearNum) : null,
    to_year: toYearNum !== undefined ? String(toYearNum) : null,
    role,
    case_type: caseType,
    case_number: caseNumber,
    keyword,
  };

  const { value: result, cacheHit } = await cachedJsonCall<NjSearchResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'search',
    payload: { database, criteria, pages },
    ttlHours,
    refresh,
    fetch: () => searchPortal(ctx, database, criteria, pages),
    validateCached: isNjSearchResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return emitNjResult(ctx, result, cacheHit, asJson, limit);
}

export async function runMonmouth(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, MONMOUTH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderMonmouthHelp()) };
  }
  const surname = getStringOption(parsed, 'surname') ?? '';
  const town = getStringOption(parsed, 'town') ?? 'ALL';
  const category = getStringOption(parsed, 'category') ?? 'ALL';
  const match = getStringOption(parsed, 'match') ?? 'contains';
  const limit = getNumberOption(parsed, 'limit');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const asJson = getBooleanOption(parsed, 'asJson');

  const townMatch = matchOptionValue(town, ['ALL', ...MONMOUTH_TOWNS]);
  if (townMatch === null) {
    throw new CliValidationError(`--town '${town}' is not valid; valid: ALL, ${MONMOUTH_TOWNS.join(', ')}`);
  }
  const categoryMatch = matchOptionValue(category, ['ALL', ...MONMOUTH_CATEGORIES]);
  if (categoryMatch === null) {
    throw new CliValidationError(
      `--category '${category}' is not valid; valid: ALL, ${MONMOUTH_CATEGORIES.join(', ')}`
    );
  }

  const { value: result, cacheHit } = await cachedJsonCall<NjSearchResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'monmouth',
    payload: { surname, town: townMatch, category: categoryMatch, match },
    ttlHours,
    refresh,
    fetch: () => searchMonmouth(ctx, surname, townMatch, categoryMatch, match),
    validateCached: isNjSearchResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return emitNjResult(ctx, result, cacheHit, asJson, limit);
}

export function runUrl(rest: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(rest, URL_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }
  const rawDb = parsed.positionals[0];
  if (!rawDb) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        `Portal index: ${PORTAL_INDEX}\nMonmouth County OPRS 1875 census: ${MONMOUTH_SEARCH}`
      ),
    };
  }
  const database = resolveDatabase(rawDb);
  if (database === 'monmouth') {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, MONMOUTH_SEARCH) };
  }
  if (database in DATABASES) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(ctx.io, `${PORTAL_BASE}${DATABASES[database]?.page ?? ''}`),
    };
  }
  const orderOnlyEntry = ORDER_ONLY[database];
  if (orderOnlyEntry) {
    const [title, page] = orderOnlyEntry;
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        `${title} (records-request form, no online search):\n${PORTAL_BASE}${page}`
      ),
    };
  }
  throw new CliValidationError(`unknown database '${rawDb}'; run \`nj-archives databases\` for the list`);
}
