import {
  type CommandParseSpec,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  type OptionSpec,
  type parseCommandArgs,
} from '../../runtime/args.js';
import {
  CENSUS1950_DEFAULT_LIMIT,
  CENSUS1950_IMAGE_MAX_WIDTH,
  CENSUS1950_IMAGE_TIMEOUT,
  DEFAULT_BROWSER_TIMEOUT_S,
  DEFAULT_DOWNLOAD_TIMEOUT,
  type SearchFilterOptions,
} from './types.js';

export const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  show: 'get',
};

const COMMON_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'levels',
    kind: 'string',
    flags: ['--level'],
    multiple: true,
    metavar: 'LEVEL',
    help: 'Level(s): recordGroup, collection, series, fileUnit, item.',
  },
  {
    key: 'recordGroups',
    kind: 'string',
    flags: ['--rg'],
    multiple: true,
    metavar: 'RG',
    help: 'Record Group number(s), e.g. 109 or 29,109.',
  },
  {
    key: 'online',
    kind: 'boolean',
    flags: ['--online'],
    help: 'Limit to records with viewable digital objects.',
  },
  {
    key: 'materialType',
    kind: 'string',
    flags: ['--type'],
    metavar: 'TYPE',
    help: "Type of material, e.g. 'Textual Records'.",
  },
  {
    key: 'person',
    kind: 'string',
    flags: ['--person'],
    metavar: 'NAME',
    help: 'Person or Organization authority heading.',
  },
  {
    key: 'title',
    kind: 'string',
    flags: ['--title'],
    metavar: 'TITLE',
    help: 'Title search filter.',
  },
  {
    key: 'geo',
    kind: 'string',
    flags: ['--geo'],
    metavar: 'PLACE',
    help: 'Geographic reference filter.',
  },
  {
    key: 'control',
    kind: 'string',
    flags: ['--control'],
    metavar: 'ID',
    help: 'Control number or microform identifier.',
  },
  {
    key: 'series',
    kind: 'string',
    flags: ['--series'],
    metavar: 'SERIES',
    help: 'Series filter: 4-digit year (e.g. 1940), microform ID (e.g. M593), series NAID, or series title.',
  },
  {
    key: 'startDate',
    kind: 'string',
    flags: ['--start-date'],
    metavar: 'DATE',
    help: 'Beginning date (YYYY, YYYY-MM, or YYYY-MM-DD).',
  },
  {
    key: 'endDate',
    kind: 'string',
    flags: ['--end-date'],
    metavar: 'DATE',
    help: 'Ending date (YYYY, YYYY-MM, or YYYY-MM-DD).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    default: 1,
    metavar: 'N',
    help: 'Result page number.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit'],
    default: 20,
    metavar: 'N',
    help: 'Results per page.',
  },
];

export const URL_OPTIONS: readonly OptionSpec[] = [
  ...COMMON_SEARCH_OPTIONS,
  {
    key: 'forApi',
    kind: 'boolean',
    flags: ['--api'],
    help: 'Output the v2 API endpoint URL instead of the website URL.',
  },
];

export const URL_PARSE_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'query',
};

export const SEARCH_OPTIONS: readonly OptionSpec[] = [
  ...COMMON_SEARCH_OPTIONS,
  {
    key: 'apiKey',
    kind: 'string',
    flags: ['--api-key'],
    metavar: 'KEY',
    help: 'NARA Catalog v2 API key (defaults to $NARA_API_KEY).',
  },
  {
    key: 'forceBrowser',
    kind: 'boolean',
    flags: ['--browser'],
    help: 'Force headless Chromium website mode.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the local disk cache and fetch fresh search results.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Override search query cache TTL in hours (default: 168 or $KINLOOM_NARA_QUERY_TTL_HOURS).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_BROWSER_TIMEOUT_S,
    metavar: 'SECONDS',
    help: `Total timeout in seconds for browser-backed searches (default ${DEFAULT_BROWSER_TIMEOUT_S}).`,
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON.',
  },
];

export const SEARCH_PARSE_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
};

export const GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'apiKey',
    kind: 'string',
    flags: ['--api-key'],
    metavar: 'KEY',
    help: 'NARA Catalog v2 API key (defaults to $NARA_API_KEY).',
  },
  {
    key: 'forceBrowser',
    kind: 'boolean',
    flags: ['--browser'],
    help: 'Force headless Chromium website mode.',
  },
  {
    key: 'objects',
    kind: 'boolean',
    flags: ['--objects'],
    help: 'Include compact digital object URLs (omitted by default).',
  },
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages'],
    default: 'all',
    metavar: 'SPEC',
    help: "1-based page slice when using --objects or --text, e.g. '1-10'.",
  },
  {
    key: 'text',
    kind: 'boolean',
    flags: ['--text'],
    help: 'Include extracted OCR text and transcriptions if present.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the local disk cache and fetch fresh record metadata.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_BROWSER_TIMEOUT_S,
    metavar: 'SECONDS',
    help: `Total timeout in seconds for browser-backed record lookups (default ${DEFAULT_BROWSER_TIMEOUT_S}).`,
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output compact structured JSON.',
  },
];

export const GET_PARSE_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'NAID',
};

export const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outDir',
    kind: 'string',
    flags: ['-o', '--out', '--out-dir'],
    metavar: 'PATH',
    help: 'Output directory for NAID records (default: ./nara-<naid>) or file/directory for a direct NARA/S3 URL.',
  },
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages'],
    default: 'all',
    metavar: 'SPEC',
    help: "1-based page selection, e.g. '1-5,10' or 'all'.",
  },
  {
    key: 'metadata',
    kind: 'boolean',
    flags: ['--metadata'],
    negatable: true,
    default: true,
    help: 'Save compact provenance metadata.json.',
  },
  {
    key: 'overwrite',
    kind: 'boolean',
    flags: ['--overwrite'],
    help: 'Overwrite existing downloaded files.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local metadata and object caches and re-download from NARA.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_DOWNLOAD_TIMEOUT,
    metavar: 'SECONDS',
    help: 'Per-file download read timeout in seconds.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Cache TTL in hours for direct URL downloads (default 168; 0 disables cache reads).',
  },
  {
    key: 'apiKey',
    kind: 'string',
    flags: ['--api-key'],
    metavar: 'KEY',
    help: 'NARA Catalog v2 API key (defaults to $NARA_API_KEY).',
  },
  {
    key: 'forceBrowser',
    kind: 'boolean',
    flags: ['--browser'],
    help: 'Force headless Chromium website mode.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Output structured JSON including boolean cache_hit.',
  },
];

export const DOWNLOAD_PARSE_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'NAID or URL',
};

export const CENSUS1950_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'state',
    kind: 'string',
    flags: ['--state'],
    metavar: 'STATE',
    help: 'State or territory code (IL) or name (Illinois).',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    metavar: 'COUNTY',
    help: 'County name, as the 1950 Census site spells it.',
  },
  {
    key: 'name',
    kind: 'string',
    flags: ['--name', '--surname'],
    metavar: 'NAME',
    help: 'Person name. Sent as the site name= parameter.',
  },
  {
    key: 'ed',
    kind: 'string',
    flags: ['--ed', '--district'],
    metavar: 'ED',
    help: 'Enumeration district, for example 49-16.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit', '--rows'],
    default: CENSUS1950_DEFAULT_LIMIT,
    metavar: 'N',
    help: 'Results per page (API size=, 1..100).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    default: 1,
    metavar: 'N',
    help: 'Result page number (1-based).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of text.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and query the 1950 Census API.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_NARA_QUERY_TTL_HOURS).',
  },
];

export const CENSUS1950_PARSE_SPEC: CommandParseSpec = {
  options: CENSUS1950_OPTIONS,
  allowPositionals: true,
};

export const CENSUS1950_IMAGE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outPath',
    kind: 'string',
    flags: ['-o', '--out', '--out-dir', '--output'],
    default: '.',
    metavar: 'PATH',
    help: 'Directory for one or more images, or a .jpg/.jpeg file when you pass one image.',
  },
  {
    key: 'width',
    kind: 'integer',
    flags: ['--width', '--max-width'],
    min: 1,
    max: CENSUS1950_IMAGE_MAX_WIDTH,
    metavar: 'PX',
    help: `IIIF pixel width (1..${CENSUS1950_IMAGE_MAX_WIDTH}). Omit for full resolution.`,
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: CENSUS1950_IMAGE_TIMEOUT,
    metavar: 'SECONDS',
    help: 'Per-image HTTP read timeout in seconds.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of text.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and download the JPEG again.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_NARA_QUERY_TTL_HOURS).',
  },
];

export const CENSUS1950_IMAGE_PARSE_SPEC: CommandParseSpec = {
  options: CENSUS1950_IMAGE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'IMAGE_OR_URL',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom nara <command> [options]',
    summary: 'Search, inspect, and download National Archives Catalog (NARA) records.',
    subcommands: [
      { name: 'url', summary: 'Build and print a verified NARA Catalog search URL.' },
      { name: 'search', summary: 'Search the NARA Catalog (parallel via API or shared browser).' },
      { name: 'get', summary: 'Inspect one or more NARA records by NAID (alias: show).' },
      { name: 'download', summary: 'Download digitized files for a NARA record or direct NARA/S3 URL.' },
      { name: 'census1950', summary: 'Search 1950 Census population schedules on 1950census.archives.gov.' },
      { name: 'census1950-image', summary: 'Download one or more 1950 Census schedule JPEGs via IIIF.' },
    ],
  });
}

export function extractCommonSearchOptions(parsed: ReturnType<typeof parseCommandArgs>): SearchFilterOptions {
  return {
    levels: getStringListOption(parsed, 'levels'),
    recordGroups: getStringListOption(parsed, 'recordGroups'),
    online: getBooleanOption(parsed, 'online'),
    materialType: getStringOption(parsed, 'materialType'),
    person: getStringOption(parsed, 'person'),
    title: getStringOption(parsed, 'title'),
    geo: getStringOption(parsed, 'geo'),
    control: getStringOption(parsed, 'control'),
    series: getStringOption(parsed, 'series'),
    startDate: getStringOption(parsed, 'startDate'),
    endDate: getStringOption(parsed, 'endDate'),
    page: getNumberOption(parsed, 'page') ?? 1,
    limit: getNumberOption(parsed, 'limit') ?? 20,
  };
}
