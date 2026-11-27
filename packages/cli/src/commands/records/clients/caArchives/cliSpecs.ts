import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { ALL_SOURCES, DEFAULT_SEARCH_TIMEOUT_SEC, SEARCHABLE_SOURCES } from './domain.js';

export const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_CA_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

export const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'sources',
    kind: 'string',
    flags: ['--source'],
    multiple: true,
    choices: SEARCHABLE_SOURCES,
    metavar: 'SOURCE',
    help: 'Only search this source (repeatable). Default: all four.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Results per source.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_SEARCH_TIMEOUT_SEC,
    metavar: 'SECONDS',
    help: `Total timeout in seconds for browser-backed sources (default ${DEFAULT_SEARCH_TIMEOUT_SEC}).`,
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of text.',
  },
  ...CACHE_OPTIONS,
];

export const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'sources',
    kind: 'string',
    flags: ['--source'],
    multiple: true,
    choices: ALL_SOURCES,
    metavar: 'SOURCE',
    help: 'Only print URLs for this source (repeatable). Default: all six.',
  },
];

export const GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'portalId',
    kind: 'string',
    flags: ['--portal'],
    metavar: 'ID',
    help: 'Portal item ID (from search results).',
  },
  {
    key: 'exhibitsId',
    kind: 'string',
    flags: ['--exhibits'],
    metavar: 'ID',
    help: 'Exhibits item ID (from search results).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of text.',
  },
  ...CACHE_OPTIONS,
];

export const SEARCH_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'query',
};

export const URL_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'query',
};

export const GET_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: false,
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ca-archives <command> [options]',
    summary: 'Search California archives portals (OAC, Calisphere, State Archives).',
    subcommands: [
      { name: 'search', summary: 'Search the California archives portals for QUERY.' },
      { name: 'url', summary: 'Print verified search URLs for QUERY without running any search.' },
      { name: 'get', summary: 'Fetch one Portal or exhibits item by ID.' },
    ],
  });
}

export function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ca-archives search <QUERY...> [options]',
    summary: 'Search the California archives portals for QUERY.',
    options: SEARCH_OPTIONS,
  });
}

export function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ca-archives url <QUERY...> [options]',
    summary: 'Print verified search URLs for QUERY without running any search.',
    options: URL_OPTIONS,
  });
}

export function renderGetHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ca-archives get (--portal <ID> | --exhibits <ID>) [options]',
    summary: 'Fetch one Portal or exhibits item by ID.',
    options: GET_OPTIONS,
  });
}
