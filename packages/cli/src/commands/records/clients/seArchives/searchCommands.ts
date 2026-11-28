import { CliValidationError } from '../../../../errors.js';
import {
  getBooleanOption,
  getNumberOption,
  getStringOption,
  type ParsedCommandArgs,
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
  BIRTHS_SPEC,
  DEEDS_SPEC,
  MARRIAGES_SPEC,
  renderBirthsHelp,
  renderDeedsHelp,
  renderMarriagesHelp,
  renderSearchHelp,
  SEARCH_SPEC,
} from './cliSpecs.js';
import {
  BIRTHS_API_URL,
  DEEDS_API_URL,
  GENDER_ALIASES,
  getCacheDir,
  isSearchEndpointResult,
  MARRIAGES_API_URL,
  RECORD_TYPE_FACETS,
  RECORDS_API_URL,
  resolveTtlHours,
  type SearchEndpointResult,
  validatePaging,
  validateYearRange,
} from './domain.js';
import { formatSearchText } from './parsers.js';
import { fetchRecordsEndpoint } from './transport.js';

async function executeSearchCommand(options: {
  readonly parsed: ParsedCommandArgs;
  readonly ctx: RecordCommandContext;
  readonly cacheKind: string;
  readonly apiUrl: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly textTitle: string;
}): Promise<RecordCommandOutcome> {
  const { parsed, ctx, cacheKind, apiUrl, params, textTitle } = options;
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<SearchEndpointResult>({
    cacheDir: getCacheDir(ctx),
    kind: cacheKind,
    payload: params,
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchRecordsEndpoint(ctx, apiUrl, params),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isSearchEndpointResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatSearchText(textTitle, result, cacheHit)),
    cacheHit,
  };
}

export async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const yearMin = getNumberOption(parsed, 'yearMin');
  const yearMax = getNumberOption(parsed, 'yearMax');
  validatePaging(limit, offset);
  validateYearRange(yearMin, yearMax);

  const params: Record<string, string | number> = {
    limit,
    offset,
    sort: getStringOption(parsed, 'sort') ?? 'relevance',
  };
  const text = (getStringOption(parsed, 'text') ?? '').trim();
  const name = (getStringOption(parsed, 'name') ?? '').trim();
  const place = (getStringOption(parsed, 'place') ?? '').trim();
  const transcribed = (getStringOption(parsed, 'transcribed') ?? '').trim();
  if (text) params['text'] = text;
  if (name) params['name'] = name;
  if (place) params['place'] = place;
  if (transcribed) {
    params['transcribed_text'] = transcribed;
    params['only_digitised_materials'] = 'true';
  }
  if (getBooleanOption(parsed, 'digitized')) {
    params['only_digitised_materials'] = 'true';
  }

  if (!('text' in params || 'name' in params || 'place' in params || 'transcribed_text' in params)) {
    throw new CliValidationError(
      'Provide at least one search term: --text, --name, --place, or --transcribed.'
    );
  }
  if (yearMin !== undefined) params['year_min'] = yearMin;
  if (yearMax !== undefined) params['year_max'] = yearMax;

  const facetOpt = (getStringOption(parsed, 'facet') ?? '').trim();
  const recordType = getStringOption(parsed, 'recordType') ?? 'all';
  if (facetOpt) {
    params['facet'] = facetOpt;
  } else if (recordType !== 'all') {
    const facet = RECORD_TYPE_FACETS[recordType];
    if (!facet) {
      throw new CliValidationError(`Unsupported --type: '${recordType}'`);
    }
    params['facet'] = facet;
  }

  return executeSearchCommand({
    parsed,
    ctx,
    cacheKind: 'records:search',
    apiUrl: RECORDS_API_URL,
    params,
    textTitle: 'Riksarkivet Search',
  });
}

export async function runBirths(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, BIRTHS_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderBirthsHelp()) };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const yearMin = getNumberOption(parsed, 'yearMin');
  const yearMax = getNumberOption(parsed, 'yearMax');
  validatePaging(limit, offset);
  validateYearRange(yearMin, yearMax);

  const params: Record<string, string | number> = {
    limit,
    offset,
    sort: getStringOption(parsed, 'sort') ?? 'date',
  };
  const first = (getStringOption(parsed, 'first') ?? '').trim();
  const father = (getStringOption(parsed, 'father') ?? '').trim();
  const mother = (getStringOption(parsed, 'mother') ?? '').trim();
  const place = (getStringOption(parsed, 'place') ?? '').trim();
  const witness = (getStringOption(parsed, 'witness') ?? '').trim();
  const gender = (getStringOption(parsed, 'gender') ?? '').trim();
  if (first) params['first_name'] = first;
  if (father) params['fathers_name'] = father;
  if (mother) params['mothers_name'] = mother;
  if (place) params['place'] = place;
  if (witness) params['baptismal_witness'] = witness;
  if (gender) {
    const mapped = GENDER_ALIASES[gender.toLowerCase()];
    if (!mapped) {
      throw new CliValidationError(
        `Invalid --gender '${gender}'; use Kvinna/female, Man/male, or Okänt/unknown.`
      );
    }
    params['gender'] = mapped;
  }
  if (yearMin !== undefined) params['year_min'] = yearMin;
  if (yearMax !== undefined) params['year_max'] = yearMax;

  if (
    !(
      'first_name' in params ||
      'fathers_name' in params ||
      'mothers_name' in params ||
      'place' in params ||
      'baptismal_witness' in params ||
      'year_min' in params ||
      'year_max' in params
    )
  ) {
    throw new CliValidationError(
      'Provide at least one filter (--first, --father, --mother, --place, --witness, or --year-min/--year-max).'
    );
  }

  return executeSearchCommand({
    parsed,
    ctx,
    cacheKind: 'records:births',
    apiUrl: BIRTHS_API_URL,
    params,
    textTitle: 'Riksarkivet Birth Records',
  });
}

export async function runMarriages(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, MARRIAGES_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderMarriagesHelp()) };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const yearMin = getNumberOption(parsed, 'yearMin');
  const yearMax = getNumberOption(parsed, 'yearMax');
  validatePaging(limit, offset);
  validateYearRange(yearMin, yearMax);

  const params: Record<string, string | number> = {
    limit,
    offset,
    sort: getStringOption(parsed, 'sort') ?? 'date',
  };
  const groom = (getStringOption(parsed, 'groom') ?? '').trim();
  const bride = (getStringOption(parsed, 'bride') ?? '').trim();
  const groomPlace = (getStringOption(parsed, 'groomPlace') ?? '').trim();
  const bridePlace = (getStringOption(parsed, 'bridePlace') ?? '').trim();
  const parish = (getStringOption(parsed, 'parish') ?? '').trim();
  const county = (getStringOption(parsed, 'county') ?? '').trim();
  if (groom) params['grooms_name'] = groom;
  if (bride) params['brides_name'] = bride;
  if (groomPlace) params['grooms_home_place'] = groomPlace;
  if (bridePlace) params['brides_home_place'] = bridePlace;
  if (parish) params['parish'] = parish;
  if (county) params['county'] = county;
  if (yearMin !== undefined) params['year_min'] = yearMin;
  if (yearMax !== undefined) params['year_max'] = yearMax;

  if (
    !(
      'grooms_name' in params ||
      'brides_name' in params ||
      'grooms_home_place' in params ||
      'brides_home_place' in params ||
      'parish' in params ||
      'county' in params ||
      'year_min' in params ||
      'year_max' in params
    )
  ) {
    throw new CliValidationError(
      'Provide at least one filter (--groom, --bride, --parish, --county, or --year-min/--year-max).'
    );
  }

  return executeSearchCommand({
    parsed,
    ctx,
    cacheKind: 'records:marriages',
    apiUrl: MARRIAGES_API_URL,
    params,
    textTitle: 'Riksarkivet Marriage Records',
  });
}

export async function runDeeds(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DEEDS_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDeedsHelp()) };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const yearMin = getNumberOption(parsed, 'yearMin');
  const yearMax = getNumberOption(parsed, 'yearMax');
  validatePaging(limit, offset);
  validateYearRange(yearMin, yearMax);

  const params: Record<string, string | number> = {
    limit,
    offset,
    sort: getStringOption(parsed, 'sort') ?? 'year',
  };
  const parish = (getStringOption(parsed, 'parish') ?? '').trim();
  const propertyName = (getStringOption(parsed, 'propertyName') ?? '').trim();
  const taxUnit = (getStringOption(parsed, 'taxUnit') ?? '').trim();
  const court = (getStringOption(parsed, 'court') ?? '').trim();
  const adminUnit = (getStringOption(parsed, 'adminUnit') ?? '').trim();
  if (parish) params['parish'] = parish;
  if (propertyName) params['property_name'] = propertyName;
  if (taxUnit) params['tax_unit'] = taxUnit;
  if (court) params['district_court_sessions'] = court;
  if (adminUnit) params['administrative_unit'] = adminUnit;
  if (yearMin !== undefined) params['year_min'] = yearMin;
  if (yearMax !== undefined) params['year_max'] = yearMax;

  if (
    !(
      'parish' in params ||
      'property_name' in params ||
      'tax_unit' in params ||
      'district_court_sessions' in params ||
      'administrative_unit' in params ||
      'year_min' in params ||
      'year_max' in params
    )
  ) {
    throw new CliValidationError(
      'Provide at least one filter (--parish, --property, --court, or --year-min/--year-max).'
    );
  }

  return executeSearchCommand({
    parsed,
    ctx,
    cacheKind: 'records:deeds',
    apiUrl: DEEDS_API_URL,
    params,
    textTitle: 'Riksarkivet Title Deeds Index',
  });
}
