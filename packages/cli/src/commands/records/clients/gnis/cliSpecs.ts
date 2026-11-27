import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';

export const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'force',
    kind: 'boolean',
    flags: ['--force', '--refresh'],
    help: 'Re-download even if cached.',
  },
];

export const DOWNLOAD_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'state',
};

export const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'state',
    kind: 'string',
    flags: ['--state', '-s'],
    metavar: 'ST',
    help: 'State code to search (downloads and caches the state file if needed).',
  },
  {
    key: 'exact',
    kind: 'boolean',
    flags: ['--exact'],
    help: 'Match the full feature name, not a substring.',
  },
  {
    key: 'featureClass',
    kind: 'string',
    flags: ['--class'],
    metavar: 'CLASS',
    help: "Filter by feature class, e.g. 'Populated Place'.",
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    metavar: 'COUNTY',
    help: 'Filter by county name (substring).',
  },
  {
    key: 'historical',
    kind: 'boolean',
    flags: ['--historical'],
    help: 'Search the national Historical Features file instead of a state file (defunct places, post offices).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '-n'],
    min: 0,
    default: 20,
    help: 'Max matches to return (default: 20).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass cached query and state data and re-download fresh GNIS data.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Override query cache TTL in hours (default: 720 or $KINLOOM_GNIS_QUERY_TTL_HOURS).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of compact text.',
  },
];

export const SEARCH_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'name',
};

export const GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'state',
    kind: 'string',
    flags: ['--state', '-s'],
    metavar: 'ST',
    help: 'State code (downloads and caches if needed).',
  },
  {
    key: 'historical',
    kind: 'boolean',
    flags: ['--historical'],
    help: 'Look in the national Historical Features file.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Re-download the underlying GNIS file before lookup.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON.',
  },
];

export const GET_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'feature_id',
};

export const URL_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'name',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom gnis <command> [options]',
    summary: 'Search USGS GNIS geographic names (cached state downloads).',
    subcommands: [
      { name: 'download', summary: 'Download and cache the GNIS text file for a state (e.g. MI, CA, MO).' },
      { name: 'search', summary: 'Search feature names (substring unless --exact).' },
      { name: 'get', summary: 'Show one feature by its GNIS feature_id.' },
      { name: 'url', summary: 'Print the GNIS Domestic Names Search web app URL (open in a browser).' },
    ],
  });
}
