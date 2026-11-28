import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  LOCATION_OPTIONS,
  LOCATION_SPEC,
  SEARCH_OPTIONS,
  SEARCH_SPEC,
  SURNAME_OPTIONS,
  SURNAME_SPEC,
  TITLE_SPEC,
  URL_SPEC,
} from './cliSpecs.js';
import {
  formatPersiItemsText,
  PERSI_MODE_PAGES,
  type PersiArticle,
  type PersiCategory,
  resolveTtl,
} from './domain.js';
import { fetchCachedLocation, fetchCachedSurname, fetchCachedTitle } from './transport.js';

function emitPersiItems(
  ctx: RecordCommandContext,
  items: readonly (PersiArticle | PersiCategory)[],
  asJson: boolean,
  limit: number,
  cacheHit: boolean
): RecordCommandOutcome {
  const sliced = items.slice(0, limit);
  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, sliced),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatPersiItemsText(sliced, cacheHit)),
    cacheHit,
  };
}

async function executeSurname(
  ctx: RecordCommandContext,
  surname: string,
  limit: number,
  asJson: boolean,
  refresh: boolean,
  ttlHours: number
): Promise<RecordCommandOutcome> {
  const { value, cacheHit } = await fetchCachedSurname(ctx, surname, refresh, ttlHours);
  return emitPersiItems(ctx, value.articles, asJson, limit, cacheHit);
}

async function executeTitle(
  ctx: RecordCommandContext,
  keyword: string,
  limit: number,
  asJson: boolean,
  refresh: boolean,
  ttlHours: number
): Promise<RecordCommandOutcome> {
  const { value, cacheHit } = await fetchCachedTitle(ctx, keyword, refresh, ttlHours);
  return emitPersiItems(ctx, value.articles, asJson, limit, cacheHit);
}

async function executeLocation(
  ctx: RecordCommandContext,
  rawState: string,
  county: string,
  asJson: boolean,
  refresh: boolean,
  ttlHours: number
): Promise<RecordCommandOutcome> {
  const { value, cacheHit } = await fetchCachedLocation(ctx, rawState, county, refresh, ttlHours);
  if (value.categories.length === 0) {
    const bytesOut = emitStdout(
      ctx.io,
      "No category counts returned. The county value may not match PERSI's list; try a blank county (statewide) or check the website form."
    );
    return { exitCode: 1, bytesOut, cacheHit };
  }
  return emitPersiItems(ctx, value.categories, asJson, value.categories.length, cacheHit);
}

export async function runSurname(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SURNAME_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom persi surname <SURNAME> [options]',
          summary: 'Search PERSI by surname, e.g. persi surname Lincoln.',
          options: SURNAME_OPTIONS,
        })
      ),
    };
  }
  return executeSurname(
    ctx,
    parsed.positionals[0] ?? '',
    getNumberOption(parsed, 'limit') ?? 25,
    getBooleanOption(parsed, 'asJson'),
    getBooleanOption(parsed, 'refresh'),
    resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx)
  );
}

export async function runTitle(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TITLE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom persi title <KEYWORD> [options]',
          summary: 'Search PERSI by article-title keyword, e.g. persi title Lincoln.',
          options: SURNAME_OPTIONS,
        })
      ),
    };
  }
  return executeTitle(
    ctx,
    parsed.positionals[0] ?? '',
    getNumberOption(parsed, 'limit') ?? 25,
    getBooleanOption(parsed, 'asJson'),
    getBooleanOption(parsed, 'refresh'),
    resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx)
  );
}

export async function runLocation(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, LOCATION_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom persi location --state <ST> [--county <COUNTY>] [options]',
          summary: 'List PERSI article counts by category for a state/county.',
          options: LOCATION_OPTIONS,
        })
      ),
    };
  }
  return executeLocation(
    ctx,
    getStringOption(parsed, 'state') ?? '',
    getStringOption(parsed, 'county') ?? '',
    getBooleanOption(parsed, 'asJson'),
    getBooleanOption(parsed, 'refresh'),
    resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx)
  );
}

export async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom persi search [QUERY] [options]',
          summary: 'Convenience router to `surname`, `title`, or `location` search.',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }
  const query = parsed.positionals[0];
  const surnameOpt = getStringOption(parsed, 'surnameOpt');
  const titleOpt = getStringOption(parsed, 'titleOpt');
  const state = getStringOption(parsed, 'state');
  const county = getStringOption(parsed, 'county') ?? '';
  const limit = getNumberOption(parsed, 'limit') ?? 25;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  if (state && (query || surnameOpt || titleOpt)) {
    throw new CliValidationError(
      "PERSI's surname and title forms do not accept a --state filter. Use `persi surname <SURNAME>`, `persi title <KEYWORD>`, or `persi location --state <ST>` separately."
    );
  }
  if (state) {
    return executeLocation(ctx, state, county, asJson, refresh, ttlHours);
  }
  if (titleOpt) {
    return executeTitle(ctx, titleOpt, limit, asJson, refresh, ttlHours);
  }
  const targetSurname = surnameOpt ?? query;
  if (targetSurname) {
    return executeSurname(ctx, targetSurname, limit, asJson, refresh, ttlHours);
  }
  throw new CliValidationError('Pass a surname, --title <KEYWORD>, or --state <ST>.');
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom persi url <surname|title|location>',
          summary: 'Print the PERSI website search page for a mode.',
        })
      ),
    };
  }
  const mode = parsed.positionals[0] ?? '';
  const page = PERSI_MODE_PAGES[mode];
  if (!page) {
    throw new CliValidationError(`Invalid mode '${mode}'. Choose from: surname, title, location.`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, page) };
}
