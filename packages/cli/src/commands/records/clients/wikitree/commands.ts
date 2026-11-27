import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  ANCESTORS_OPTIONS,
  ANCESTORS_SPEC,
  BIO_OPTIONS,
  BIO_SPEC,
  PERSON_OPTIONS,
  PERSON_SPEC,
  SEARCH_OPTIONS,
  SEARCH_SPEC,
} from './cliSpecs.js';
import {
  DEFAULT_FIELDS,
  formatAncestorsText,
  formatBioText,
  formatPersonText,
  formatSearchText,
  jsonWithCacheHit,
  normalizeProfileKey,
  resolveSearchName,
  resolveTtl,
} from './domain.js';
import { cachedApi } from './transport.js';

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
          usage: 'kinloom wikitree search [NAME...] [options]',
          summary: 'Search person profiles, e.g. search --first Abraham --last Lincoln.',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const start = getNumberOption(parsed, 'start');
  const page = getNumberOption(parsed, 'page');
  if (page !== undefined && start !== undefined) {
    throw new CliValidationError('Pass either --page or --start/--offset, not both.');
  }
  const resolvedStart = start !== undefined ? start : page !== undefined ? (page - 1) * limit : 0;

  const [firstName, lastName] = resolveSearchName(
    parsed.positionals,
    getStringOption(parsed, 'fullName'),
    getStringOption(parsed, 'firstName'),
    getStringOption(parsed, 'lastName')
  );
  const birthDate = getStringOption(parsed, 'birthDate');
  const deathDate = getStringOption(parsed, 'deathDate');
  const birthLocation = getStringOption(parsed, 'birthLocation');
  const deathLocation = getStringOption(parsed, 'deathLocation');
  const dateInclude = getStringOption(parsed, 'dateInclude');
  const fields = getStringOption(parsed, 'fields') ?? DEFAULT_FIELDS;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');

  if (!firstName && !lastName && !birthDate && !deathDate && !birthLocation && !deathLocation) {
    throw new CliValidationError(
      'Provide a name or filter: e.g. `search Abraham Lincoln`, `search --first Abraham --last Lincoln`, or --birth-date/--death-date/--birth-location/--death-location.'
    );
  }

  const params: Record<string, string | number> = {
    action: 'searchPerson',
    limit,
    start: resolvedStart,
    fields,
  };
  if (firstName) params.FirstName = firstName;
  if (lastName) params.LastName = lastName;
  if (birthDate) params.BirthDate = birthDate;
  if (deathDate) params.DeathDate = deathDate;
  if (birthLocation) params.BirthLocation = birthLocation;
  if (deathLocation) params.DeathLocation = deathLocation;
  if (dateInclude) params.dateInclude = dateInclude;

  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { data, first, cacheHit } = await cachedApi({
    ctx,
    kind: 'search',
    params,
    label: 'searchPerson',
    refresh,
    ttlHours,
    cacheable: (d) =>
      d.length > 0 && isPlainRecord(d[0]) && (Array.isArray(d[0].matches) || typeof d[0].total === 'number'),
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cacheHit));
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const bytesOut = emitStdout(ctx.io, formatSearchText(first, cacheHit));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runPerson(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PERSON_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom wikitree person <KEY> [options]',
          summary:
            'Fetch one person by WikiTree ID (e.g. <Surname>-<Number>), numeric Id, or URL (aliases: get, show, profile).',
          options: PERSON_OPTIONS,
        })
      ),
    };
  }

  const key = normalizeProfileKey(parsed.positionals[0]);
  let fields = getStringOption(parsed, 'fields') ?? DEFAULT_FIELDS;
  const bioFormat = getStringOption(parsed, 'bioFormat');
  const resolveRedirect = getBooleanOption(parsed, 'resolveRedirect');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');

  const params: Record<string, string | number> = {
    action: 'getPerson',
    key,
    fields,
  };
  if (bioFormat) {
    params.bioFormat = bioFormat;
    if (fields !== '*' && !fields.split(',').includes('Bio')) {
      fields = `${fields},Bio`;
      params.fields = fields;
    }
  }
  if (resolveRedirect) {
    params.resolveRedirect = 1;
  }

  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { data, first, cacheHit } = await cachedApi({
    ctx,
    kind: 'person',
    params,
    label: `getPerson ${key}`,
    refresh,
    ttlHours,
    cacheable: (d) => d.length > 0 && isPlainRecord(d[0]) && Boolean(d[0].person || d[0].profile),
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cacheHit));
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const bytesOut = emitStdout(ctx.io, formatPersonText(first, key, bioFormat, cacheHit));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runAncestors(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, ANCESTORS_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom wikitree ancestors <KEY> [options]',
          summary: 'Fetch ancestors of KEY, following father and mother.',
          options: ANCESTORS_OPTIONS,
        })
      ),
    };
  }

  const key = normalizeProfileKey(parsed.positionals[0]);
  const depth = getNumberOption(parsed, 'depth') ?? 4;
  const fields = getStringOption(parsed, 'fields') ?? DEFAULT_FIELDS;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');

  const params: Record<string, string | number> = {
    action: 'getPeople',
    keys: key,
    ancestors: depth,
    fields,
  };
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { data, first, cacheHit } = await cachedApi({
    ctx,
    kind: 'ancestors',
    params,
    label: `getPeople ${key}`,
    refresh,
    ttlHours,
    cacheable: (d) => d.length > 0 && isPlainRecord(d[0]) && isPlainRecord(d[0].people),
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cacheHit));
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const bytesOut = emitStdout(ctx.io, formatAncestorsText(first, key, depth, cacheHit));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runBio(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, BIO_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom wikitree bio <KEY> [options]',
          summary: 'Fetch the biography text of KEY (default wiki markup).',
          options: BIO_OPTIONS,
        })
      ),
    };
  }

  const key = normalizeProfileKey(parsed.positionals[0]);
  const bioFormat = getStringOption(parsed, 'bioFormat') ?? 'wiki';
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');

  const params: Record<string, string | number> = {
    action: 'getBio',
    key,
    bioFormat,
  };
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { data, first, cacheHit } = await cachedApi({
    ctx,
    kind: 'bio',
    params,
    label: `getBio ${key}`,
    refresh,
    ttlHours,
    cacheable: (d) => d.length > 0 && isPlainRecord(d[0]) && 'bio' in d[0],
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cacheHit));
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const bytesOut = emitStdout(ctx.io, formatBioText(first, cacheHit));
  return { exitCode: 0, bytesOut, cacheHit };
}
