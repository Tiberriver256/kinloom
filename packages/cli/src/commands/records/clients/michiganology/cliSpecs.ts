import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { DEFAULT_DOWNLOAD_TIMEOUT_SEC, DEFAULT_TEXT_TIMEOUT_SEC } from './domain.js';

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_MICHIGANOLOGY_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  { key: 'queryOpt', kind: 'string', flags: ['--query', '-q'], help: 'Search query string.' },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '-n'],
    min: 1,
    default: 10,
    help: 'Max results to show (first page only).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TEXT_TIMEOUT_SEC,
    help: 'Total timeout budget in seconds (retries fit within this budget).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

const GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TEXT_TIMEOUT_SEC,
    help: 'Total timeout budget in seconds (retries fit within this budget).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    default: '.',
    help: 'Output directory, or a .jpg/.jpeg/.png/.tif/.tiff/.pdf file path when --filename is omitted.',
  },
  {
    key: 'filename',
    kind: 'string',
    flags: ['--filename'],
    help: 'Override output filename (default: from Content-Disposition).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_DOWNLOAD_TIMEOUT_SEC,
    help: 'Total timeout budget in seconds (retries fit within this budget).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

const COLLECTIONS_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
];

export const SEARCH_SPEC: CommandParseSpec = { options: SEARCH_OPTIONS, allowPositionals: true };

export const GET_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'url_or_id',
};

export const DOWNLOAD_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'url_or_id',
};

export const COLLECTIONS_SPEC: CommandParseSpec = {
  options: COLLECTIONS_OPTIONS,
  allowPositionals: false,
};

export const URL_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'query',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom michiganology <command> [options]',
    summary: 'Search Michiganology (Archives of Michigan digital collections).',
    subcommands: [
      { name: 'search', summary: 'Search all Michiganology collections.' },
      {
        name: 'get',
        summary: 'Inspect a Michiganology item page (aliases: item, show, info).',
      },
      {
        name: 'download',
        summary: 'Download the full-resolution file for an IO_ item (alias: fetch).',
      },
      { name: 'collections', summary: 'List the Michiganology digital collections.' },
      { name: 'url', summary: 'Print the shareable Michiganology search URL for a query.' },
    ],
  });
}

export function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom michiganology search [QUERY]... [options]',
    summary: 'Search all Michiganology collections, e.g. kinloom michiganology search Lincoln.',
    options: SEARCH_OPTIONS,
  });
}

export function renderGetHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom michiganology get <URL_OR_ID> [options]',
    summary: 'Inspect a Michiganology item page (Item Data fields and file download URL).',
    options: GET_OPTIONS,
  });
}

export function renderDownloadHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom michiganology download <URL_OR_ID> [options]',
    summary: 'Download the full-resolution file for a Michiganology IO_ item.',
    options: DOWNLOAD_OPTIONS,
  });
}

export function renderCollectionsHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom michiganology collections [options]',
    summary: 'List the Michiganology digital collections.',
    options: COLLECTIONS_OPTIONS,
  });
}

export function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom michiganology url <QUERY>...',
    summary: 'Print the shareable Michiganology search URL for a query.',
  });
}
