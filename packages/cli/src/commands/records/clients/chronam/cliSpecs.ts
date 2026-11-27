import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { DEFAULT_CACHE_TTL_HOURS, DEFAULT_TIMEOUT, DOWNLOAD_TIMEOUT } from './domain.js';

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: `Cache TTL in hours (default ${DEFAULT_CACHE_TTL_HOURS}; env KINLOOM_CHRONAM_CACHE_TTL_HOURS).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and re-query loc.gov.',
  },
];

const QUERY_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'termsOpt',
    kind: 'string',
    flags: ['--terms', '--query', '-q'],
    metavar: 'TEXT',
    help: 'Alias for positional QUERY.',
  },
  {
    key: 'dates',
    kind: 'string',
    flags: ['--dates'],
    metavar: 'YYYY/YYYY',
    help: 'Date range YYYY/YYYY (or one year YYYY).',
  },
  {
    key: 'dateFrom',
    kind: 'string',
    flags: ['--date-from', '--from-year', '--date1', '--year1', '--start'],
    metavar: 'YYYY',
    help: 'Start year YYYY (alternative to --dates).',
  },
  {
    key: 'dateTo',
    kind: 'string',
    flags: ['--date-to', '--to-year', '--date2', '--year2', '--end'],
    metavar: 'YYYY',
    help: 'End year YYYY (alternative to --dates).',
  },
  {
    key: 'level',
    kind: 'string',
    flags: ['--level'],
    choices: ['page', 'issue', 'title', 'all'],
    default: 'page',
    metavar: 'LEVEL',
    help: 'Display level (dl=).',
  },
  {
    key: 'state',
    kind: 'string',
    flags: ['--state'],
    metavar: 'STATE',
    help: 'State name or postal code (CA, NJ); sent as fa=location_state:<state>.',
  },
  {
    key: 'lccn',
    kind: 'string',
    flags: ['--lccn'],
    metavar: 'LCCN',
    help: 'Filter by newspaper LCCN via fa=number_lccn:<lccn>.',
  },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  ...QUERY_OPTIONS,
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '--per-page', '--rows', '-n'],
    default: 10,
    min: 1,
    metavar: 'N',
    help: 'Results per page (c=).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page', '-p'],
    default: 1,
    min: 1,
    metavar: 'N',
    help: 'Results page (sp=).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT,
    min: 0,
    metavar: 'SECONDS',
    help: 'Request timeout budget in seconds (loc.gov search takes 20-45 s).',
  },
  ...CACHE_OPTIONS,
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of compact text.',
  },
];

export const SEARCH_PARSE_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
};

const PAGE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'lccn',
    kind: 'string',
    flags: ['--lccn'],
    metavar: 'LCCN',
    help: 'Newspaper LCCN, e.g. sn83045462.',
  },
  {
    key: 'date',
    kind: 'string',
    flags: ['--date'],
    metavar: 'YYYY-MM-DD',
    help: 'Issue date YYYY-MM-DD.',
  },
  {
    key: 'edition',
    kind: 'string',
    flags: ['--edition'],
    default: '1',
    metavar: 'ED',
    help: 'Edition number.',
  },
  {
    key: 'seq',
    kind: 'string',
    flags: ['--seq'],
    default: '1',
    metavar: 'SEQ',
    help: 'Page sequence within the issue (?sp=).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT,
    min: 0,
    metavar: 'SECONDS',
    help: 'Request timeout budget in seconds.',
  },
  ...CACHE_OPTIONS,
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit the item JSON with boolean cache_hit.',
  },
];

export const PAGE_PARSE_SPEC: CommandParseSpec = {
  options: PAGE_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'lccn',
    kind: 'string',
    flags: ['--lccn'],
    metavar: 'LCCN',
    help: 'Newspaper LCCN, e.g. sn83045462.',
  },
  {
    key: 'date',
    kind: 'string',
    flags: ['--date'],
    metavar: 'YYYY-MM-DD',
    help: 'Issue date YYYY-MM-DD.',
  },
  {
    key: 'edition',
    kind: 'string',
    flags: ['--edition'],
    default: '1',
    metavar: 'ED',
    help: 'Edition number.',
  },
  {
    key: 'seq',
    kind: 'string',
    flags: ['--seq'],
    metavar: 'SEQ',
    help: 'Page sequence within the issue (defaults to ?sp= or 1).',
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '--out-dir', '-o'],
    default: '.',
    metavar: 'DIR',
    help: 'Output directory.',
  },
  {
    key: 'pdf',
    kind: 'boolean',
    flags: ['--pdf'],
    negatable: true,
    default: true,
    help: 'Download the page PDF (falls back to IIIF JPEG if no PDF exists).',
  },
  {
    key: 'image',
    kind: 'boolean',
    flags: ['--image'],
    negatable: true,
    default: false,
    help: 'Download the page IIIF JPEG image.',
  },
  {
    key: 'imageWidth',
    kind: 'integer',
    flags: ['--image-width'],
    min: 100,
    max: 10000,
    metavar: 'PX',
    help: 'IIIF JPEG pixel width (100..10000); defaults to pct:50 when resolved from IIIF info.',
  },
  {
    key: 'jp2',
    kind: 'boolean',
    flags: ['--jp2'],
    negatable: true,
    default: false,
    help: 'Download the archival JP2 scan when listed on the page.',
  },
  {
    key: 'text',
    kind: 'boolean',
    flags: ['--text'],
    negatable: true,
    default: false,
    help: 'Download the ALTO XML word-coordinates file (OCR full text).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DOWNLOAD_TIMEOUT,
    min: 0,
    metavar: 'SECONDS',
    help: 'Download timeout in seconds.',
  },
  ...CACHE_OPTIONS,
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit structured JSON including boolean cache_hit.',
  },
];

export const DOWNLOAD_PARSE_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

export const URL_PARSE_SPEC: CommandParseSpec = {
  options: QUERY_OPTIONS,
  allowPositionals: true,
};

// --- usage renderers ---------------------------------------------------------

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom chronam <command> [options]',
    summary: 'Search Chronicling America historic newspapers (Library of Congress).',
    subcommands: [
      { name: 'search', summary: 'Search newspaper pages for QUERY (full-text, e.g. a surname).' },
      { name: 'get', summary: 'Show metadata and download links for one newspaper page.' },
      { name: 'page', summary: 'Alias for `get`: show metadata and download links for one page.' },
      { name: 'download', summary: 'Download a newspaper page (PDF, IIIF image, JP2, OCR) + metadata.' },
      { name: 'url', summary: 'Print the loc.gov website search URL for QUERY (open in a browser).' },
    ],
  });
}

export function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom chronam search [QUERY...] [options]',
    summary: 'Search newspaper pages for QUERY (full-text, e.g. a surname).',
    options: SEARCH_OPTIONS,
    notes: [
      'Multi-word queries need no quotes: `kinloom chronam search Abraham Lincoln`.',
      'Results are cached on disk (~/.cache/kinloom-chronam, 168 h TTL).',
    ],
  });
}

export function renderPageHelp(cmdName: 'get' | 'page'): string {
  return formatCommandUsage({
    usage: `kinloom chronam ${cmdName} [RESOURCE_URL] [options]`,
    summary: 'Show metadata and download links for one newspaper page.',
    options: PAGE_OPTIONS,
    notes: ['Give a loc.gov resource URL, or build one with --lccn --date [--edition --seq].'],
  });
}

export function renderDownloadHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom chronam download [RESOURCE_URL] [options]',
    summary: 'Download a newspaper page (PDF, IIIF image, JP2, OCR) plus metadata.json.',
    options: DOWNLOAD_OPTIONS,
  });
}

export function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom chronam url [QUERY...] [options]',
    summary: 'Print the loc.gov website search URL for QUERY (open in a browser).',
    options: QUERY_OPTIONS,
  });
}
