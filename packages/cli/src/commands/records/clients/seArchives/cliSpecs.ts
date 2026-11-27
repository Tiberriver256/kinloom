import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { RECORD_TYPE_FACETS } from './domain.js';

export const CACHE_AND_JSON_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request and write the fresh response.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
];

export const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'text',
    kind: 'string',
    flags: ['--text'],
    default: '',
    help: 'Free-text query across titles, notes, and metadata.',
  },
  { key: 'name', kind: 'string', flags: ['--name'], default: '', help: 'Person or organization name query.' },
  {
    key: 'place',
    kind: 'string',
    flags: ['--place'],
    default: '',
    help: 'Parish, town, or county name query.',
  },
  {
    key: 'transcribed',
    kind: 'string',
    flags: ['--transcribed'],
    default: '',
    help: 'Search HTR transcripts across digitized volumes.',
  },
  {
    key: 'recordType',
    kind: 'string',
    flags: ['--type'],
    choices: ['all', ...Object.keys(RECORD_TYPE_FACETS).toSorted()],
    default: 'all',
    help: 'Filter by record type (default: all).',
  },
  {
    key: 'facet',
    kind: 'string',
    flags: ['--facet'],
    default: '',
    help: 'Raw Riksarkivet facet string override.',
  },
  {
    key: 'digitized',
    kind: 'boolean',
    flags: ['--digitized'],
    help: 'Limit results to digitized materials.',
  },
  { key: 'yearMin', kind: 'integer', flags: ['--year-min'], metavar: 'YYYY', help: 'Earliest year (YYYY).' },
  { key: 'yearMax', kind: 'integer', flags: ['--year-max'], metavar: 'YYYY', help: 'Latest year (YYYY).' },
  {
    key: 'sort',
    kind: 'string',
    flags: ['--sort'],
    choices: ['relevance', 'alphaAsc', 'alphaDesc', 'timeAsc', 'timeDesc'],
    default: 'relevance',
    help: 'Sort order (default: relevance).',
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
    help: '0-based result offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

export const BIRTHS_OPTIONS: readonly OptionSpec[] = [
  { key: 'first', kind: 'string', flags: ['--first'], default: '', help: "Child's given name." },
  { key: 'father', kind: 'string', flags: ['--father'], default: '', help: "Father's name." },
  { key: 'mother', kind: 'string', flags: ['--mother'], default: '', help: "Mother's name." },
  { key: 'place', kind: 'string', flags: ['--place'], default: '', help: 'Parish or birth place.' },
  { key: 'witness', kind: 'string', flags: ['--witness'], default: '', help: 'Baptismal witness name.' },
  {
    key: 'gender',
    kind: 'string',
    flags: ['--gender'],
    default: '',
    help: 'Gender (Kvinna/female, Man/male, Okänt/unknown).',
  },
  {
    key: 'yearMin',
    kind: 'integer',
    flags: ['--year-min'],
    metavar: 'YYYY',
    help: 'Earliest birth year (YYYY).',
  },
  {
    key: 'yearMax',
    kind: 'integer',
    flags: ['--year-max'],
    metavar: 'YYYY',
    help: 'Latest birth year (YYYY).',
  },
  {
    key: 'sort',
    kind: 'string',
    flags: ['--sort'],
    choices: ['first_name', 'date'],
    default: 'date',
    help: 'Sort order (default: date).',
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
    help: '0-based result offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

export const MARRIAGES_OPTIONS: readonly OptionSpec[] = [
  { key: 'groom', kind: 'string', flags: ['--groom'], default: '', help: "Groom's name." },
  { key: 'bride', kind: 'string', flags: ['--bride'], default: '', help: "Bride's name." },
  { key: 'groomPlace', kind: 'string', flags: ['--groom-place'], default: '', help: "Groom's home place." },
  { key: 'bridePlace', kind: 'string', flags: ['--bride-place'], default: '', help: "Bride's home place." },
  { key: 'parish', kind: 'string', flags: ['--parish'], default: '', help: 'Marriage parish.' },
  { key: 'county', kind: 'string', flags: ['--county'], default: '', help: 'Swedish county (län).' },
  {
    key: 'yearMin',
    kind: 'integer',
    flags: ['--year-min'],
    metavar: 'YYYY',
    help: 'Earliest marriage year (YYYY).',
  },
  {
    key: 'yearMax',
    kind: 'integer',
    flags: ['--year-max'],
    metavar: 'YYYY',
    help: 'Latest marriage year (YYYY).',
  },
  {
    key: 'sort',
    kind: 'string',
    flags: ['--sort'],
    choices: ['grooms_name', 'brides_name', 'date'],
    default: 'date',
    help: 'Sort order (default: date).',
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
    help: '0-based result offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

export const DEEDS_OPTIONS: readonly OptionSpec[] = [
  { key: 'parish', kind: 'string', flags: ['--parish'], default: '', help: 'Parish name.' },
  { key: 'propertyName', kind: 'string', flags: ['--property'], default: '', help: 'Farm or property name.' },
  {
    key: 'taxUnit',
    kind: 'string',
    flags: ['--tax-unit'],
    default: '',
    help: 'Tax assessment unit (mantal).',
  },
  { key: 'court', kind: 'string', flags: ['--court'], default: '', help: 'District court session (ting).' },
  { key: 'adminUnit', kind: 'string', flags: ['--admin-unit'], default: '', help: 'Administrative unit.' },
  { key: 'yearMin', kind: 'integer', flags: ['--year-min'], metavar: 'YYYY', help: 'Earliest year (YYYY).' },
  { key: 'yearMax', kind: 'integer', flags: ['--year-max'], metavar: 'YYYY', help: 'Latest year (YYYY).' },
  {
    key: 'sort',
    kind: 'string',
    flags: ['--sort'],
    choices: ['parish', 'year'],
    default: 'year',
    help: 'Sort order (default: year).',
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
    help: '0-based result offset (default: 0).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

export const MANIFEST_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 30,
    help: 'Canvases to show in text output (default: 30).',
  },
  ...CACHE_AND_JSON_OPTIONS,
];

export const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    help: '1-based page number when target is a volume bildid.',
  },
  {
    key: 'width',
    kind: 'integer',
    flags: ['--width'],
    help: 'Scaled pixel width (64-12000; default: full max).',
  },
  {
    key: 'full',
    kind: 'boolean',
    flags: ['--full'],
    help: 'Download full resolution (full/max/0/default.jpg).',
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['--out'],
    required: true,
    metavar: 'PATH',
    help: 'Output JPEG file path or directory.',
  },
  { key: 'overwrite', kind: 'boolean', flags: ['--overwrite'], help: 'Overwrite an existing output file.' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
];

export const CENSUS_OPTIONS: readonly OptionSpec[] = [
  { key: 'surname', kind: 'string', flags: ['--surname'], default: '', help: 'Surname (Efternamn).' },
  { key: 'given', kind: 'string', flags: ['--given'], default: '', help: 'Given name (Fornamn).' },
  { key: 'birthYear', kind: 'integer', flags: ['--birth-year'], help: 'Birth year (1700-1930).' },
  { key: 'parish', kind: 'string', flags: ['--parish'], default: '', help: 'Home parish (Hemförsamling).' },
  {
    key: 'year',
    kind: 'integer',
    flags: ['--year'],
    help: 'Census year (1860, 1870, 1880, 1890, 1900, 1910, 1930).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
];

export const SEARCH_SPEC: CommandParseSpec = { options: SEARCH_OPTIONS, allowPositionals: false };
export const BIRTHS_SPEC: CommandParseSpec = { options: BIRTHS_OPTIONS, allowPositionals: false };
export const MARRIAGES_SPEC: CommandParseSpec = { options: MARRIAGES_OPTIONS, allowPositionals: false };
export const DEEDS_SPEC: CommandParseSpec = { options: DEEDS_OPTIONS, allowPositionals: false };
export const RECORD_SPEC: CommandParseSpec = {
  options: CACHE_AND_JSON_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'record_id',
};
export const COLLECTION_SPEC: CommandParseSpec = {
  options: CACHE_AND_JSON_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'archive_id',
};
export const MANIFEST_SPEC: CommandParseSpec = {
  options: MANIFEST_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'target',
};
export const DOWNLOAD_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'target',
};
export const CENSUS_SPEC: CommandParseSpec = { options: CENSUS_OPTIONS, allowPositionals: false };

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives <command> [options]',
    summary: 'Search Swedish National Archives (Riksarkivet) open APIs and download IIIF scans.',
    subcommands: [
      { name: 'search', summary: 'Search archives, digitized volumes, registers, and HTR transcribed text.' },
      { name: 'births', summary: 'Search indexed birth records (Födelseregister).' },
      { name: 'marriages', summary: 'Search indexed marriage records (Vigselregister).' },
      { name: 'deeds', summary: 'Search indexed title deeds (Lagfartsregister).' },
      { name: 'record', summary: 'Fetch full JSON detail for a register record ID or URL.' },
      { name: 'collection', summary: 'Browse an archive or series IIIF Collection.' },
      { name: 'manifest', summary: "Inspect a digitized volume's IIIF Presentation v3 Manifest." },
      { name: 'download', summary: 'Download a verified IIIF page scan JPEG from lbiiif.riksarkivet.se.' },
      {
        name: 'census',
        summary: 'Build browser URLs for Swedish National Censuses (Folkräkningar 1860-1930).',
      },
    ],
  });
}

export function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives search [options]',
    summary: 'Search Riksarkivet archives, digitized volumes, registers, and HTR transcribed text.',
    options: SEARCH_OPTIONS,
  });
}

export function renderBirthsHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives births [options]',
    summary: 'Search Riksarkivet indexed birth records (Födelseregister).',
    options: BIRTHS_OPTIONS,
  });
}

export function renderMarriagesHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives marriages [options]',
    summary: 'Search Riksarkivet indexed marriage records (Vigselregister).',
    options: MARRIAGES_OPTIONS,
  });
}

export function renderDeedsHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives deeds [options]',
    summary: 'Search Riksarkivet indexed title deeds (Lagfartsregister).',
    options: DEEDS_OPTIONS,
  });
}

export function renderRecordHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives record <RECORD_ID> [options]',
    summary: 'Fetch full JSON detail for a register record ID or URL.',
    options: CACHE_AND_JSON_OPTIONS,
  });
}

export function renderCollectionHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives collection <ARCHIVE_ID> [options]',
    summary: 'Browse an archive or series IIIF Collection.',
    options: CACHE_AND_JSON_OPTIONS,
  });
}

export function renderManifestHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives manifest <TARGET> [options]',
    summary: "Inspect a digitized volume's IIIF Presentation v3 Manifest.",
    options: MANIFEST_OPTIONS,
  });
}

export function renderDownloadHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives download <TARGET> --out <PATH> [options]',
    summary: 'Download a verified IIIF page scan JPEG from lbiiif.riksarkivet.se.',
    options: DOWNLOAD_OPTIONS,
  });
}

export function renderCensusHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom se-archives census [options]',
    summary:
      'Build browser URLs for Swedish National Censuses (Folkräkningar 1860-1930; CAPTCHA-gated web UI).',
    options: CENSUS_OPTIONS,
  });
}
