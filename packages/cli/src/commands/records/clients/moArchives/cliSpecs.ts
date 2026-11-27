import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { MATCH_CHOICES, PRE1910_TYPE_CHOICES, ROLE_CHOICES } from './domain.js';

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_MO_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const DEATH_OPTIONS: readonly OptionSpec[] = [
  { key: 'last', kind: 'string', flags: ['--last'], required: true, help: 'Last name (surname).' },
  { key: 'first', kind: 'string', flags: ['--first'], default: '', help: 'First name.' },
  { key: 'middle', kind: 'string', flags: ['--middle'], default: '', help: 'Middle name.' },
  {
    key: 'role',
    kind: 'string',
    flags: ['--role'],
    choices: ROLE_CHOICES,
    default: 'deceased',
    help: 'Whose name to search. Spouse/father/mother only for 1953-1975.',
  },
  {
    key: 'match',
    kind: 'string',
    flags: ['--match'],
    choices: MATCH_CHOICES,
    default: 'contains',
    help: 'Name match type, applied to every name field given.',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: '',
    help: 'County as spelled on the site; default all counties.',
  },
  { key: 'beginYear', kind: 'integer', flags: ['--begin-year'], default: 1910 },
  { key: 'endYear', kind: 'integer', flags: ['--end-year'], default: 1975 },
  {
    key: 'beginMonth',
    kind: 'integer',
    flags: ['--begin-month'],
    default: 0,
    help: '1-12, 0 = all months.',
  },
  {
    key: 'endMonth',
    kind: 'integer',
    flags: ['--end-month'],
    default: 0,
    help: '1-12, 0 = all months.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 50,
    help: 'Max records (50 per page).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  {
    key: 'downloadDir',
    kind: 'string',
    flags: ['--download'],
    metavar: 'DIR',
    help: "Download each result's certificate PDF into DIR.",
  },
  ...CACHE_OPTIONS,
];

const PRE1910_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'kind',
    kind: 'string',
    flags: ['--type'],
    choices: PRE1910_TYPE_CHOICES,
    default: 'death',
    help: 'Record type in the pre-1910 database.',
  },
  {
    key: 'name',
    kind: 'string',
    flags: ['--name'],
    required: true,
    help: 'All or part of a name; the site recommends last name only.',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: '',
    help: 'County as spelled on the site; default all counties.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 50,
    help: 'Max records (50 per page).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...CACHE_OPTIONS,
];

const DETAIL_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...CACHE_OPTIONS,
];

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outDir',
    kind: 'string',
    flags: ['--out'],
    default: 'mo-death-certs',
    help: 'Output directory.',
  },
  {
    key: 'overwrite',
    kind: 'boolean',
    flags: ['--overwrite'],
    help: 'Re-download files that already exist.',
  },
];

export const DEATH_SPEC: CommandParseSpec = { options: DEATH_OPTIONS, allowPositionals: false };
export const PRE1910_SPEC: CommandParseSpec = { options: PRE1910_OPTIONS, allowPositionals: false };
export const DETAIL_SPEC: CommandParseSpec = {
  options: DETAIL_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'id',
};
export const DOWNLOAD_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'url',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom mo-archives <command> [options]',
    summary: 'Search Missouri State Archives vital records (no key, no login).',
    subcommands: [
      { name: 'death', summary: 'Search Missouri Death Certificates, 1910-1975 (with images).' },
      {
        name: 'pre1910',
        summary: 'Search the pre-1910 Birth and Death Records Database (abstracts).',
      },
      { name: 'detail', summary: 'Fetch full abstracts for pre-1910 record IDs (from `pre1910`).' },
      { name: 'download', summary: 'Download death-certificate PDFs by image URL (from `death`).' },
      {
        name: 'mdh',
        summary: 'Show the Missouri Digital Heritage browser path (no machine interface).',
      },
    ],
  });
}

export function renderDeathHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom mo-archives death --last <SURNAME> [options]',
    summary: 'Search Missouri Death Certificates, 1910-1975 (with images).',
    options: DEATH_OPTIONS,
  });
}

export function renderPre1910Help(): string {
  return formatCommandUsage({
    usage: 'kinloom mo-archives pre1910 --name <NAME> [options]',
    summary: 'Search the pre-1910 Birth and Death Records Database (abstracts).',
    options: PRE1910_OPTIONS,
  });
}

export function renderDetailHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom mo-archives detail <ID>... [options]',
    summary: 'Fetch full abstracts for pre-1910 record IDs (from `pre1910`).',
    options: DETAIL_OPTIONS,
  });
}

export function renderDownloadHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom mo-archives download <URL>... [options]',
    summary: 'Download death-certificate PDFs by image URL (from `death`).',
    options: DOWNLOAD_OPTIONS,
  });
}

export function renderMdhHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom mo-archives mdh',
    summary: 'Show the Missouri Digital Heritage browser path (no machine interface).',
  });
}
