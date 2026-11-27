import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { DEFAULT_FIELDS } from './domain.js';

export const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  get: 'person',
  show: 'person',
  profile: 'person',
};

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

export const SEARCH_OPTIONS: readonly OptionSpec[] = [
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

export const PERSON_OPTIONS: readonly OptionSpec[] = [
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

export const ANCESTORS_OPTIONS: readonly OptionSpec[] = [
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

export const BIO_OPTIONS: readonly OptionSpec[] = [
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

export const SEARCH_SPEC: CommandParseSpec = { options: SEARCH_OPTIONS, allowPositionals: true };

export const PERSON_SPEC: CommandParseSpec = {
  options: PERSON_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'key',
};

export const ANCESTORS_SPEC: CommandParseSpec = {
  options: ANCESTORS_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'key',
};

export const BIO_SPEC: CommandParseSpec = {
  options: BIO_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'key',
};

export function renderRootHelp(): string {
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
