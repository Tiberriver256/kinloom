import { CliValidationError } from '../../../errors.js';
import {
  type CommandParseSpec,
  cachedJsonCall,
  emitJsonStdout,
  emitStdout,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpGetJson,
  type OptionSpec,
  parseCacheTtlHours,
  parseCommandArgs,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  resolveCacheDir,
  resolveSubcommandAlias,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const API_BASE = 'https://api.wikitree.com/api.php';
const DEFAULT_APP_ID = 'Kinloom';
const DEFAULT_FIELDS = 'Id,Name,FirstName,LastNameAtBirth,BirthDate,DeathDate,BirthLocation';
const WIKITREE_ALLOWED_HOSTS = ['api.wikitree.com'] as const;

const WIKITREE_URL_RE = /^https?:\/\/(?:www\.)?wikitree\.com\/wiki\/([^/?#]+)(?:[?#].*)?$/i;

const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  get: 'person',
  show: 'person',
  profile: 'person',
};

type WikiTreeRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is WikiTreeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeProfileKey(raw: string): string {
  const cleaned = raw.trim();
  const match = WIKITREE_URL_RE.exec(cleaned);
  return match ? match[1] : cleaned;
}

export function resolveSearchName(
  queryParts: readonly string[],
  fullName: string | undefined,
  firstName: string | undefined,
  lastName: string | undefined
): readonly [string | undefined, string | undefined] {
  const posTokens = queryParts.flatMap((part) => part.trim().split(/\s+/)).filter((tok) => tok.length > 0);
  const nameTokens = (fullName ?? '')
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length > 0);

  if (posTokens.length > 0 && nameTokens.length > 0) {
    throw new CliValidationError('Pass either positional name arguments or --name, not both.');
  }
  const tokens = nameTokens.length > 0 ? nameTokens : posTokens;
  if (tokens.length === 0) {
    return [firstName, lastName];
  }
  if (firstName && lastName) {
    throw new CliValidationError('Pass either positional name / --name or --first/--last, not both.');
  }
  if (firstName && !lastName) {
    return [firstName, tokens.join(' ')];
  }
  if (lastName && !firstName) {
    return [tokens.join(' '), lastName];
  }
  if (tokens.length === 1) {
    return [undefined, tokens[0]];
  }
  return [tokens.slice(0, -1).join(' '), tokens[tokens.length - 1]];
}

function checkStatus(data: readonly unknown[], label: string): WikiTreeRecord {
  if (data.length === 0 || !isPlainRecord(data[0])) {
    throw new RecordRuntimeError(`${label}: empty response from WikiTree API`);
  }
  const first = data[0];
  const status = first.status ?? 0;
  if (status !== 0 && status !== '') {
    throw new RecordRuntimeError(`${label}: ${String(status)}`);
  }
  return first;
}

async function apiCall(
  ctx: RecordCommandContext,
  params: Readonly<Record<string, string | number>>
): Promise<unknown[]> {
  const appId = ctx.env.WIKITREE_APP_ID?.trim() || DEFAULT_APP_ID;
  const search = new URLSearchParams();
  search.set('appId', appId);
  for (const [k, v] of Object.entries(params)) {
    search.set(k, String(v));
  }
  const url = `${API_BASE}?${search.toString()}`;
  const { data } = await httpGetJson<unknown>(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: WIKITREE_ALLOWED_HOSTS },
  });
  if (!Array.isArray(data)) {
    throw new RecordRuntimeError(`Unexpected API response: ${JSON.stringify(data)}`);
  }
  return data;
}

interface WrappedWikiTreeData {
  readonly data: unknown[];
}

function isWrappedWikiTreeData(value: unknown): value is WrappedWikiTreeData {
  return isPlainRecord(value) && Array.isArray(value.data);
}

async function cachedApi(options: {
  readonly ctx: RecordCommandContext;
  readonly kind: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly label: string;
  readonly refresh: boolean;
  readonly ttlHours: number;
  readonly cacheable: (data: readonly unknown[]) => boolean;
}): Promise<{ readonly data: unknown[]; readonly first: WikiTreeRecord; readonly cacheHit: boolean }> {
  const cacheDir = resolveCacheDir({
    env: options.ctx.env,
    envVars: ['KINLOOM_WIKITREE_CACHE_DIR'],
    defaultSubdir: 'kinloom-wikitree',
  });

  const { value: wrapped, cacheHit } = await cachedJsonCall<WrappedWikiTreeData>({
    cacheDir,
    kind: options.kind,
    payload: options.params,
    ttlHours: options.ttlHours,
    refresh: options.refresh,
    fetch: async () => {
      const data = await apiCall(options.ctx, options.params);
      checkStatus(data, options.label);
      return { data };
    },
    cacheable: (r) => options.cacheable(r.data),
    validateCached: isWrappedWikiTreeData,
    nowMs: options.ctx.nowMs,
    sleepFn: options.ctx.sleepFn,
  });

  const first = checkStatus(wrapped.data, options.label);
  return { data: wrapped.data, first, cacheHit };
}

function jsonWithCacheHit(data: readonly unknown[], hit: boolean): unknown[] {
  if (data.length > 0 && isPlainRecord(data[0])) {
    return [{ ...data[0], cache_hit: hit }, ...data.slice(1)];
  }
  return [...data];
}

function formatPersonLine(person: WikiTreeRecord): string {
  const name = String(person.Name ?? person.Id ?? '?');
  const first = String(person.FirstName ?? '');
  const last = String(person.LastNameAtBirth ?? person.LastNameCurrent ?? '');
  const rawBirth = String(person.BirthDate ?? '');
  const rawDeath = String(person.DeathDate ?? '');
  const birth = rawBirth === '' || rawBirth === '0000-00-00' ? '' : rawBirth;
  const death = rawDeath === '' || rawDeath === '0000-00-00' ? '' : rawDeath;
  const place = String(person.BirthLocation ?? '');
  let dates = birth ? `b. ${birth}` : 'b. ?';
  if (death) {
    dates += ` d. ${death}`;
  }
  let line = `${name}: ${first} ${last} (${dates})`;
  if (place) {
    line += `, born ${place}`;
  }
  return line.trim();
}

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_WIKITREE_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'fullName',
    kind: 'string',
    flags: ['--name'],
    metavar: 'NAME',
    help: 'Full name (split into first and last name).',
  },
  {
    key: 'firstName',
    kind: 'string',
    flags: ['--first', '--first-name', '--given', '--given-name'],
    metavar: 'NAME',
    help: 'First name.',
  },
  {
    key: 'lastName',
    kind: 'string',
    flags: ['--last', '--last-name', '--surname'],
    metavar: 'NAME',
    help: 'Last name.',
  },
  {
    key: 'birthDate',
    kind: 'string',
    flags: ['--birth-date', '--birth-year', '--born'],
    metavar: 'DATE',
    help: 'Birth date or year (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'deathDate',
    kind: 'string',
    flags: ['--death-date', '--death-year', '--died'],
    metavar: 'DATE',
    help: 'Death date or year (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'birthLocation',
    kind: 'string',
    flags: ['--birth-location', '--birth-place', '--place'],
    metavar: 'PLACE',
    help: 'Birth location.',
  },
  {
    key: 'deathLocation',
    kind: 'string',
    flags: ['--death-location', '--death-place'],
    metavar: 'PLACE',
    help: 'Death location.',
  },
  {
    key: 'dateInclude',
    kind: 'string',
    flags: ['--date-include'],
    choices: ['both', 'neither'],
    help: "'both' requires dates on matches.",
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit', '--rows'],
    min: 1,
    max: 100,
    default: 10,
    help: 'Results to return (1-100).',
  },
  {
    key: 'start',
    kind: 'integer',
    flags: ['--start', '--offset'],
    min: 0,
    help: '0-based result offset for paging (default: 0).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    min: 1,
    help: '1-based page number (alternative to --start/--offset).',
  },
  {
    key: 'fields',
    kind: 'string',
    flags: ['--fields'],
    default: DEFAULT_FIELDS,
    help: "Comma-separated profile fields, or '*'.",
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print raw JSON.' },
  ...CACHE_OPTIONS,
];

const PERSON_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'fields',
    kind: 'string',
    flags: ['--fields'],
    default: DEFAULT_FIELDS,
    help: "Comma-separated profile fields, or '*'.",
  },
  {
    key: 'bioFormat',
    kind: 'string',
    flags: ['--bio-format'],
    choices: ['wiki', 'html', 'both'],
    help: 'Include Bio in this format.',
  },
  {
    key: 'resolveRedirect',
    kind: 'boolean',
    flags: ['--resolve-redirect'],
    help: 'Follow merged-profile redirects.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print raw JSON.' },
  ...CACHE_OPTIONS,
];

const ANCESTORS_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'depth',
    kind: 'integer',
    flags: ['--depth'],
    min: 1,
    max: 10,
    default: 4,
    help: 'Generations to follow (1-10).',
  },
  {
    key: 'fields',
    kind: 'string',
    flags: ['--fields'],
    default: DEFAULT_FIELDS,
    help: "Comma-separated profile fields, or '*'.",
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print raw JSON.' },
  ...CACHE_OPTIONS,
];

const BIO_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'bioFormat',
    kind: 'string',
    flags: ['--format'],
    choices: ['wiki', 'html', 'both'],
    default: 'wiki',
    help: 'Biography format.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print raw JSON.' },
  ...CACHE_OPTIONS,
];

const SEARCH_SPEC: CommandParseSpec = { options: SEARCH_OPTIONS, allowPositionals: true };
const PERSON_SPEC: CommandParseSpec = {
  options: PERSON_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'key',
};
const ANCESTORS_SPEC: CommandParseSpec = {
  options: ANCESTORS_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'key',
};
const BIO_SPEC: CommandParseSpec = {
  options: BIO_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'key',
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom wikitree <command> [options]',
    summary: 'Read public WikiTree profiles (search, person/get/show/profile, ancestors, bio).',
    subcommands: [
      { name: 'search', summary: 'Search person profiles, e.g. search --first Abraham --last Lincoln.' },
      {
        name: 'person',
        summary: 'Fetch one person by WikiTree ID, numeric Id, or URL (aliases: get, show, profile).',
      },
      { name: 'ancestors', summary: 'Fetch ancestors of KEY, following father and mother.' },
      { name: 'bio', summary: 'Fetch the biography text of KEY (default wiki markup).' },
    ],
  });
}

function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_WIKITREE_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_WIKITREE_CACHE_TTL_HOURS'
  );
}

async function runSearch(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
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

  const matches = Array.isArray(first.matches) ? first.matches.filter(isPlainRecord) : [];
  const total = typeof first.total === 'number' ? first.total : matches.length;
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${total} match(es), showing ${matches.length}:${marker}`];
  for (const match of matches) {
    if ('Name' in match || 'FirstName' in match) {
      lines.push(formatPersonLine(match));
    } else {
      lines.push(
        `Id ${String(match.Id ?? '?')}: sparse match, run \`person ${String(match.Id ?? '?')}\` for details`
      );
    }
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runPerson(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
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

  const profileRaw = first.person ?? first.profile;
  if (!isPlainRecord(profileRaw)) {
    throw new RecordRuntimeError(`getPerson ${key}: no profile returned`);
  }
  const lines: string[] = [`${formatPersonLine(profileRaw)}${cacheHit ? ' [cache]' : ''}`];
  if (bioFormat && typeof profileRaw.Bio === 'string' && profileRaw.Bio.length > 0) {
    lines.push(profileRaw.Bio);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runAncestors(
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

  const people = isPlainRecord(first.people) ? first.people : {};
  const resultByKey = isPlainRecord(first.resultByKey) ? first.resultByKey : {};
  const subject = isPlainRecord(resultByKey[key]) ? resultByKey[key] : {};
  const subjectId = String(subject.Id ?? '');
  const profiles: WikiTreeRecord[] = [];
  for (const [pid, person] of Object.entries(people)) {
    if (pid !== subjectId && isPlainRecord(person)) {
      profiles.push(person);
    }
  }
  profiles.sort((a, b) => {
    const bdA = String(a.BirthDate || '9999');
    const bdB = String(b.BirthDate || '9999');
    if (bdA !== bdB) return bdA.localeCompare(bdB);
    return String(a.Name || '').localeCompare(String(b.Name || ''));
  });

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${profiles.length} ancestor(s) within ${depth} generation(s) of ${key}:${marker}`,
    ...profiles.map(formatPersonLine),
  ];
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runBio(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
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

  const text = typeof first.bio === 'string' ? first.bio : '';
  const out = text ? text : `(no biography text returned)${cacheHit ? ' [cache]' : ''}`;
  const bytesOut = emitStdout(ctx.io, out);
  return { exitCode: 0, bytesOut, cacheHit };
}

export const runWikitreeCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const subcmd = resolveSubcommandAlias(args[0], SUBCOMMAND_ALIASES);
    const rest = args.slice(1);
    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'person':
        return await runPerson(rest, ctx);
      case 'ancestors':
        return await runAncestors(rest, ctx);
      case 'bio':
        return await runBio(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${args[0]}'. Run 'kinloom wikitree --script-help'.`);
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
