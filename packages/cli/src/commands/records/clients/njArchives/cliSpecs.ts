import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { MONMOUTH_CATEGORIES, MONMOUTH_TOWNS } from './catalog.js';

const DATABASES_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'surname',
    kind: 'string',
    flags: ['--surname', '--last', '--last-name'],
    help: 'Surname to search. Marriage databases accept --spouse-surname alone; natguard-photos uses --keyword.',
  },
  {
    key: 'given',
    kind: 'string',
    flags: ['--given', '--first', '--first-name'],
    help: 'Given name.',
  },
  {
    key: 'spouseSurname',
    kind: 'string',
    flags: ['--spouse-surname', '--spouse', '--bride-surname'],
    help: 'Spouse surname (marriage databases).',
  },
  {
    key: 'spouseGiven',
    kind: 'string',
    flags: ['--spouse-given', '--bride-given'],
    help: 'Spouse given name (marriage databases).',
  },
  { key: 'county', kind: 'string', flags: ['--county'], help: 'County filter.' },
  { key: 'location', kind: 'string', flags: ['--location'], help: 'Location filter.' },
  {
    key: 'fromYear',
    kind: 'integer',
    flags: ['--from-year', '--start-year'],
    help: 'Earliest year.',
  },
  {
    key: 'toYear',
    kind: 'integer',
    flags: ['--to-year', '--end-year'],
    help: 'Latest year.',
  },
  {
    key: 'role',
    kind: 'string',
    flags: ['--role'],
    help: 'Role, e.g. Grantee (land) or Defendant (supreme-court).',
  },
  {
    key: 'caseType',
    kind: 'string',
    flags: ['--case-type'],
    help: 'Case type (supreme-court).',
  },
  {
    key: 'caseNumber',
    kind: 'string',
    flags: ['--case-number'],
    help: 'Case number (supreme-court).',
  },
  { key: 'keyword', kind: 'string', flags: ['--keyword'], help: 'Keyword (natguard-photos).' },
  { key: 'limit', kind: 'integer', flags: ['--limit'], min: 0, help: 'Max rows to show.' },
  {
    key: 'pages',
    kind: 'integer',
    flags: ['--pages'],
    default: 1,
    help: 'Result pages to read (stops cleanly if fewer pages exist).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and re-query the portal.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_NJ_ARCHIVES_CACHE_TTL_HOURS).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
];

const MONMOUTH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'surname',
    kind: 'string',
    flags: ['--surname', '--last', '--name'],
    required: true,
    help: 'Person name to search.',
  },
  {
    key: 'town',
    kind: 'string',
    flags: ['--town'],
    default: 'ALL',
    help: `Town, or ALL. Choices: ${MONMOUTH_TOWNS.join(', ')}`,
  },
  {
    key: 'category',
    kind: 'string',
    flags: ['--category'],
    default: 'ALL',
    help: `Category, or ALL. Choices: ${MONMOUTH_CATEGORIES.join(', ')}`,
  },
  {
    key: 'match',
    kind: 'string',
    flags: ['--match'],
    choices: ['starts', 'contains'],
    default: 'contains',
  },
  { key: 'limit', kind: 'integer', flags: ['--limit'], min: 0, help: 'Max rows to show.' },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and re-query Monmouth OPRS.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
];

export const DATABASES_SPEC: CommandParseSpec = {
  options: DATABASES_OPTIONS,
  allowPositionals: false,
};

export const SEARCH_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'database',
};

export const MONMOUTH_SPEC: CommandParseSpec = {
  options: MONMOUTH_OPTIONS,
  allowPositionals: false,
};

export const URL_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'database',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom nj-archives <command> [options]',
    summary: 'Search New Jersey State Archives databases and the Monmouth County OPRS 1875 census.',
    subcommands: [
      { name: 'databases', summary: 'List the searchable databases on the NJ State Archives portal.' },
      {
        name: 'search',
        summary: 'Search one portal database, e.g. nj-archives search land --surname Lincoln.',
      },
      { name: 'monmouth', summary: 'Search the Monmouth County OPRS 1875 census by person name.' },
      { name: 'url', summary: 'Print the browser URL for the portal, a database, or Monmouth OPRS.' },
    ],
  });
}

export function renderDatabasesHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom nj-archives databases [options]',
    summary: 'List the searchable databases on the NJ State Archives portal.',
    options: DATABASES_OPTIONS,
  });
}

export function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom nj-archives search <DATABASE> [options]',
    summary: 'Search one portal database, e.g. kinloom nj-archives search land --surname Lincoln.',
    options: SEARCH_OPTIONS,
  });
}

export function renderMonmouthHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom nj-archives monmouth --surname <NAME> [options]',
    summary: 'Search the Monmouth County OPRS 1875 census by person name.',
    options: MONMOUTH_OPTIONS,
  });
}

export function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom nj-archives url [DATABASE]',
    summary: 'Print the browser URL for the portal, a database, or Monmouth OPRS.',
  });
}
