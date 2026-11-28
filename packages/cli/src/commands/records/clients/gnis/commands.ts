import fs from 'node:fs';
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
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  DOWNLOAD_OPTIONS,
  DOWNLOAD_SPEC,
  GET_OPTIONS,
  GET_SPEC,
  SEARCH_OPTIONS,
  SEARCH_SPEC,
  URL_SPEC,
} from './cliSpecs.js';
import {
  formatFeatureDetailText,
  formatSearchResultsText,
  GNIS_STATE_CODES,
  type GnisQueryParams,
  type GnisRow,
  getCacheDir,
  loadGnisRows,
  resolveQueryTtlHours,
  resolveSafeChild,
  SEARCH_APP,
} from './domain.js';
import { ensureHistoricalFile, ensureStateFile, executeCachedSearch } from './transport.js';

export async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom gnis download <STATE> [options]',
          summary: 'Download and cache the GNIS text file for a state (e.g. MI, CA, MO).',
          options: DOWNLOAD_OPTIONS,
        })
      ),
    };
  }
  const state = parsed.positionals[0].toUpperCase();
  const force = getBooleanOption(parsed, 'force');
  if (!GNIS_STATE_CODES.has(state)) {
    throw new RecordRuntimeError(`Unknown state/territory code: ${state}`);
  }
  const cdir = getCacheDir(ctx);
  const existingPath = resolveSafeChild(cdir, `${state}.txt`);
  if (fs.existsSync(existingPath) && !force) {
    const rows = loadGnisRows(existingPath);
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        `Already cached: ${existingPath} (${rows.length} features). Use --force or --refresh to re-download.`
      ),
      cacheHit: true,
    };
  }
  const savedPath = await ensureStateFile(ctx, state, force);
  const rows = loadGnisRows(savedPath);
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, `Cached ${savedPath} (${rows.length} features)`),
    cacheHit: false,
  };
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
          usage: 'kinloom gnis search <NAME> [options]',
          summary: 'Search feature names (substring unless --exact).',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }

  const name = parsed.positionals[0];
  const stateArg = getStringOption(parsed, 'state');
  const exact = getBooleanOption(parsed, 'exact');
  const featureClass = getStringOption(parsed, 'featureClass');
  const county = getStringOption(parsed, 'county');
  const historical = getBooleanOption(parsed, 'historical');
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveQueryTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const asJson = getBooleanOption(parsed, 'asJson');

  let normalizedState: string | null = null;
  if (!historical) {
    if (!stateArg) {
      throw new CliValidationError('Give --state (e.g. --state CA) or --historical.');
    }
    normalizedState = stateArg.toUpperCase();
    if (!GNIS_STATE_CODES.has(normalizedState)) {
      throw new RecordRuntimeError(`Unknown state/territory code: ${normalizedState}`);
    }
  }

  const canonicalParams: GnisQueryParams = {
    name,
    state: historical ? null : normalizedState,
    exact,
    feature_class: featureClass ?? null,
    county: county ?? null,
    historical,
    limit,
  };

  const { payload, cacheHit } = await executeCachedSearch({
    ctx,
    canonicalParams,
    featureClass,
    county,
    refresh,
    ttlHours,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...payload, cache_hit: cacheHit }),
      cacheHit,
    };
  }

  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatSearchResultsText(payload)),
    cacheHit,
  };
}

export async function runGet(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom gnis get <FEATURE_ID> [options]',
          summary: 'Show one feature by its GNIS feature_id.',
          options: GET_OPTIONS,
        })
      ),
    };
  }

  const featureId = parsed.positionals[0];
  const stateArg = getStringOption(parsed, 'state');
  const historical = getBooleanOption(parsed, 'historical');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const cdir = getCacheDir(ctx);
  let alreadyCached: boolean;
  let rows: GnisRow[];

  if (historical) {
    const dataPath = resolveSafeChild(cdir, 'HistoricalFeatures.txt');
    alreadyCached = fs.existsSync(dataPath) && fs.statSync(dataPath).isFile() && !refresh;
    rows = loadGnisRows(await ensureHistoricalFile(ctx, refresh));
  } else {
    if (!stateArg) {
      throw new CliValidationError('Give --state or --historical.');
    }
    const state = stateArg.toUpperCase();
    if (!GNIS_STATE_CODES.has(state)) {
      throw new RecordRuntimeError(`Unknown state/territory code: ${state}`);
    }
    const dataPath = resolveSafeChild(cdir, `${state}.txt`);
    alreadyCached = fs.existsSync(dataPath) && fs.statSync(dataPath).isFile() && !refresh;
    rows = loadGnisRows(await ensureStateFile(ctx, state, refresh));
  }

  for (const row of rows) {
    if ((row['feature_id'] ?? '') === featureId) {
      if (asJson) {
        return {
          exitCode: 0,
          bytesOut: emitJsonStdout(ctx.io, { ...row, cache_hit: alreadyCached }),
          cacheHit: alreadyCached,
        };
      }
      return {
        exitCode: 0,
        bytesOut: emitStdout(ctx.io, formatFeatureDetailText(row)),
        cacheHit: alreadyCached,
      };
    }
  }

  ctx.io.stderr(`Feature ${featureId} not found in the searched file.`);
  return { exitCode: 1, bytesOut: 0, cacheHit: alreadyCached };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom gnis url [NAME]',
          summary: 'Print the GNIS Domestic Names Search web app URL (open in a browser).',
        })
      ),
    };
  }
  const name = parsed.positionals[0];
  const lines = [SEARCH_APP];
  if (name) {
    lines.push(`(Enter '${name}' in the Feature Name field; the app has no stable query-string search URL.)`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}
