import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { GENUKI_PARISHES } from './domain.js';

export const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_UK_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

export const TNA_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'queryOpt',
    kind: 'string',
    flags: ['--query', '-q'],
    metavar: 'QUERY',
    help: 'Search query text (alias for positional QUERY).',
  },
  {
    key: 'heldBy',
    kind: 'string',
    flags: ['--held-by'],
    metavar: 'TEXT',
    help: 'Extra place or repository text added to the query (e.g. Norfolk).',
  },
  {
    key: 'dateFrom',
    kind: 'string',
    flags: ['--start-date', '--date-from', '--from-year'],
    metavar: 'DATE',
    help: 'Covering start date (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'dateTo',
    kind: 'string',
    flags: ['--end-date', '--date-to', '--to-year'],
    metavar: 'DATE',
    help: 'Covering end date (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'collection',
    kind: 'string',
    flags: ['--collection'],
    metavar: 'REF',
    help: 'Series or department reference filter (e.g. "PROB 11"). Appended to query and post-filtered.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 1,
    default: 10,
    help: 'Maximum records to return (default: 10).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    min: 1,
    help: '1-based page number sent as sps.page.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON with boolean cache_hit.',
  },
  ...CACHE_OPTIONS,
];

export const TNA_SEARCH_SPEC: CommandParseSpec = {
  options: TNA_SEARCH_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'query',
};

export const TNA_GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON with boolean cache_hit.',
  },
  ...CACHE_OPTIONS,
];

export const TNA_GET_SPEC: CommandParseSpec = {
  options: TNA_GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'iaid',
};

export const FREEREG_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'surname',
    kind: 'string',
    flags: ['--surname'],
    required: true,
    metavar: 'SURNAME',
    help: 'Last name (required).',
  },
  {
    key: 'given',
    kind: 'string',
    flags: ['--given'],
    metavar: 'GIVEN',
    help: 'First name.',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: 'NTT',
    metavar: 'COUNTY',
    help: 'Chapman county code or name (e.g. NTT / nottinghamshire; default: NTT).',
  },
  {
    key: 'fromYear',
    kind: 'string',
    flags: ['--from-year', '--date-from'],
    metavar: 'YYYY',
    help: 'Start year (YYYY).',
  },
  {
    key: 'toYear',
    kind: 'string',
    flags: ['--to-year', '--date-to'],
    metavar: 'YYYY',
    help: 'End year (YYYY).',
  },
  {
    key: 'recordType',
    kind: 'string',
    flags: ['--record-type'],
    default: 'all',
    metavar: 'TYPE',
    help: 'Record type: all, baptism, marriage, burial (default: all).',
  },
  {
    key: 'placeContains',
    kind: 'string',
    flags: ['--place-contains'],
    metavar: 'TEXT',
    help: 'Keep only hits whose register column contains this text.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 1,
    help: 'Maximum rows after --place-contains. Does not change the cache key.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON.',
  },
  ...CACHE_OPTIONS,
];

export const FREEREG_SEARCH_SPEC: CommandParseSpec = {
  options: FREEREG_SEARCH_OPTIONS,
  allowPositionals: false,
};

export const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'discoveryQuery',
    kind: 'string',
    flags: ['--discovery'],
    metavar: 'QUERY',
    help: 'Discovery web search URL for a query.',
  },
  {
    key: 'freereg',
    kind: 'boolean',
    flags: ['--freereg'],
    help: 'FreeREG search form home.',
  },
  {
    key: 'nottsQuery',
    kind: 'string',
    flags: ['--notts'],
    metavar: 'QUERY',
    help: 'Nottinghamshire Archives CalmView search hint (browser).',
  },
  {
    key: 'bhoQuery',
    kind: 'string',
    flags: ['--bho'],
    metavar: 'QUERY',
    help: 'British History Online search query.',
  },
  {
    key: 'genuki',
    kind: 'string',
    flags: ['--genuki'],
    choices: Object.keys(GENUKI_PARISHES),
    metavar: 'PLACE',
    help: 'GENUKI county/parish page for England research.',
  },
];

export const URL_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: false,
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom uk-archives <group|command> [options]',
    summary: 'Search UK archives: TNA Discovery and FreeREG parish registers.',
    subcommands: [
      { name: 'tna', summary: 'The National Archives (UK) Discovery API (search, get|detail|inspect).' },
      { name: 'discovery', summary: 'The National Archives Discovery catalogue (alias for `tna`).' },
      { name: 'freereg', summary: 'FreeREG parish register transcriptions (search).' },
      { name: 'url', summary: 'Print verified portal URLs (no search is run).' },
    ],
  });
}

export function renderTnaHelp(groupName: string): string {
  return formatCommandUsage({
    usage: `kinloom uk-archives ${groupName} <command> [options]`,
    summary: 'The National Archives (UK) Discovery API (PROB 11 wills, Tudor/Stuart records).',
    subcommands: [
      { name: 'search', summary: 'Search UK National Archives Discovery catalogue.' },
      { name: 'get', summary: 'Fetch one TNA Discovery record by IAID (aliases: detail, inspect).' },
    ],
  });
}

export function renderFreeregHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom uk-archives freereg <command> [options]',
    summary: 'FreeREG parish register transcriptions (Rails form POST, no API key).',
    subcommands: [{ name: 'search', summary: 'Search FreeREG parish register transcriptions.' }],
  });
}

export function renderTnaSearchHelp(groupName: string): string {
  return formatCommandUsage({
    usage: `kinloom uk-archives ${groupName} search [QUERY] [options]`,
    summary: 'Search UK National Archives Discovery catalogue (including PROB 11 PCC wills).',
    options: TNA_SEARCH_OPTIONS,
  });
}

export function renderTnaGetHelp(groupName: string): string {
  return formatCommandUsage({
    usage: `kinloom uk-archives ${groupName} get <IAID> [options]`,
    summary: 'Fetch one TNA Discovery record by IAID (e.g. D980036).',
    options: TNA_GET_OPTIONS,
  });
}

export function renderFreeregSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom uk-archives freereg search --surname <SURNAME> [options]',
    summary: 'Search FreeREG parish register transcriptions.',
    options: FREEREG_SEARCH_OPTIONS,
  });
}

export function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom uk-archives url [options]',
    summary: 'Print verified portal URLs (no search is run).',
    options: URL_OPTIONS,
  });
}
