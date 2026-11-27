import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_PERSI_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

export const SURNAME_OPTIONS: readonly OptionSpec[] = [
  { key: 'limit', kind: 'integer', flags: ['--limit'], min: 0, default: 25, help: 'Max results to show.' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

export const LOCATION_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'state',
    kind: 'string',
    flags: ['--state'],
    required: true,
    metavar: 'ST',
    help: 'Two-letter state code, e.g. MI. GEN for US general.',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: '',
    metavar: 'COUNTY',
    help: 'County name (optional; leave blank for statewide).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

export const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'surnameOpt',
    kind: 'string',
    flags: ['--surname'],
    metavar: 'SURNAME',
    help: 'Search by surname (alias for `persi surname`).',
  },
  {
    key: 'titleOpt',
    kind: 'string',
    flags: ['--title'],
    metavar: 'KEYWORD',
    help: 'Search by article-title keyword (alias for `persi title`).',
  },
  {
    key: 'state',
    kind: 'string',
    flags: ['--state'],
    metavar: 'ST',
    help: 'Two-letter state code for location counts (alias for `persi location`).',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: '',
    metavar: 'COUNTY',
    help: 'County name (used with --state).',
  },
  { key: 'limit', kind: 'integer', flags: ['--limit'], min: 0, default: 25, help: 'Max results to show.' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

export const SURNAME_SPEC: CommandParseSpec = {
  options: SURNAME_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'surname',
};

export const TITLE_SPEC: CommandParseSpec = {
  options: SURNAME_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'keyword',
};

export const LOCATION_SPEC: CommandParseSpec = {
  options: LOCATION_OPTIONS,
  allowPositionals: false,
};

export const SEARCH_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

export const URL_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'mode',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom persi <command> [options]',
    summary: "Search ACPL's free PERSI (Periodical Source Index).",
    subcommands: [
      { name: 'surname', summary: 'Search PERSI by surname, e.g. persi surname Lincoln.' },
      { name: 'title', summary: 'Search PERSI by article-title keyword, e.g. persi title Lincoln.' },
      { name: 'location', summary: 'List PERSI article counts by category for a state/county.' },
      { name: 'search', summary: 'Convenience router to `surname`, `title`, or `location` search.' },
      { name: 'url', summary: 'Print the PERSI website search page for a mode (surname|title|location).' },
    ],
  });
}
