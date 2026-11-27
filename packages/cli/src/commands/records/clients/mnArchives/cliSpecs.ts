import { formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { MATCH_CHOICES, NEWSPAPER_FIELD_CHOICES } from './domain.js';

export const CACHE_AND_JSON_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request and refresh the cached entry.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
];

export function peopleSearchOptions(includeMother: boolean, includeType: boolean): OptionSpec[] {
  const opts: OptionSpec[] = [];
  if (includeType) {
    opts.push({
      key: 'recordType',
      kind: 'string',
      flags: ['--type'],
      default: 'death-records',
      metavar: 'TYPE',
      help: 'Record collection (death, birth, census, vets-graves, gold-star, wwi-bonuses, wwi-service, wwi-soldiers-photos).',
    });
  }
  opts.push(
    { key: 'last', kind: 'string', flags: ['--last'], default: '', help: 'Family (last) name.' },
    { key: 'first', kind: 'string', flags: ['--first'], default: '', help: 'Given (first) name.' },
    { key: 'middle', kind: 'string', flags: ['--middle'], default: '', help: 'Middle name.' }
  );
  if (includeMother) {
    opts.push({
      key: 'motherMaiden',
      kind: 'string',
      flags: ['--mother-maiden'],
      default: '',
      help: "Mother's maiden surname (birth 1900-1934; death 1955-2001).",
    });
  }
  opts.push(
    {
      key: 'county',
      kind: 'string',
      flags: ['--county'],
      default: '',
      help: 'Minnesota county name (e.g. Hennepin, Ramsey).',
    },
    {
      key: 'match',
      kind: 'string',
      flags: ['--match'],
      choices: MATCH_CHOICES,
      default: 'equals',
      help: 'Name match operator (default: equals).',
    },
    {
      key: 'beginYear',
      kind: 'string',
      flags: ['--begin-year'],
      default: '',
      help: 'Earliest year or date (YYYY or YYYY-MM-DD).',
    },
    {
      key: 'endYear',
      kind: 'string',
      flags: ['--end-year'],
      default: '',
      help: 'Latest year or date (YYYY or YYYY-MM-DD).',
    },
    {
      key: 'certId',
      kind: 'string',
      flags: ['--cert-id'],
      default: '',
      help: 'Exact MNHS certificate ID.',
    },
    {
      key: 'page',
      kind: 'integer',
      flags: ['--page'],
      default: 1,
      help: '1-based results page (default: 1).',
    },
    {
      key: 'limit',
      kind: 'integer',
      flags: ['--limit'],
      default: 25,
      help: 'Results per page, 1-100 (default: 25).',
    },
    ...CACHE_AND_JSON_OPTIONS
  );
  return opts;
}

export const RECORD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'recordType',
    kind: 'string',
    flags: ['--type'],
    required: true,
    metavar: 'TYPE',
    help: 'Record collection (death, birth, census, vets-graves, gold-star, wwi-bonuses, wwi-service, wwi-soldiers-photos).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

export const NEWSPAPERS_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'field',
    kind: 'string',
    flags: ['--field'],
    choices: NEWSPAPER_FIELD_CHOICES,
    default: 'content',
    help: 'Field to search (default: content).',
  },
  {
    key: 'beginYear',
    kind: 'string',
    flags: ['--begin-year'],
    default: '',
    help: 'Earliest publication date (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'endYear',
    kind: 'string',
    flags: ['--end-year'],
    default: '',
    help: 'Latest publication date (YYYY or YYYY-MM-DD).',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: '',
    help: 'Filter by Minnesota county.',
  },
  { key: 'city', kind: 'string', flags: ['--city'], default: '', help: 'Filter by city.' },
  {
    key: 'title',
    kind: 'string',
    flags: ['--title'],
    default: '',
    help: 'Filter by newspaper title.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 20,
    help: 'Results per page, 1-100 (default: 20).',
  },
  {
    key: 'offset',
    kind: 'integer',
    flags: ['--offset'],
    default: 0,
    help: '0-based start offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

export const NEWSPAPERS_DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out'],
    required: true,
    metavar: 'PATH',
    help: 'Output file path or directory.',
  },
  {
    key: 'overwrite',
    kind: 'boolean',
    flags: ['--overwrite'],
    help: 'Overwrite an existing output file.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
];

export const MDL_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
];

export function renderNewspapersHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom mn-archives newspapers <command> [options]',
    summary: 'Search and inspect MNHS Digital Newspaper Hub issues.',
    subcommands: [
      { name: 'search', summary: 'Search digitized Minnesota newspapers.' },
      { name: 'metadata', summary: 'Fetch structured metadata for a newspaper issue doc_id.' },
      { name: 'download', summary: 'Download a verified newspaper issue thumbnail image.' },
    ],
  });
}

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom mn-archives <command> [options]',
    summary:
      'Search Minnesota Historical Society People Records and Digital Newspaper Hub (no key, no login).',
    subcommands: [
      { name: 'death', summary: 'Search MNHS Death Records Index (1904-2001).' },
      { name: 'birth', summary: 'Search MNHS Birth Records Index (1900-1934).' },
      { name: 'census', summary: 'Search MNHS Minnesota State Censuses (1849-1905).' },
      { name: 'vets', summary: 'Search MNHS Veterans Graves Registration (1857-1975).' },
      {
        name: 'people',
        summary:
          'Search any MNHS People Records collection (--type death|birth|census|vets-graves|gold-star|wwi-*).',
      },
      { name: 'record', summary: 'Fetch a single MNHS People Record by UUID and --type.' },
      { name: 'newspapers', summary: 'Search and inspect MNHS Digital Newspaper Hub issues.' },
      { name: 'mdl', summary: 'Show browser-only URLs for Minnesota Digital Library.' },
    ],
  });
}
