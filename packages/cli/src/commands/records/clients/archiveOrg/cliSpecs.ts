import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import {
  DEFAULT_TIMEOUT_SECONDS,
  DOWNLOAD_TIMEOUT_SECONDS,
  PAGE_BATCH_WORKERS,
  SEARCH_TIMEOUT_SECONDS,
} from './types.js';

export const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'queryFlag',
    kind: 'string',
    flags: ['-q', '--query'],
    metavar: 'QUERY',
    help: 'Lucene query string (alternative to positional query).',
  },
  {
    key: 'mediatype',
    kind: 'string',
    flags: ['--mediatype', '--type'],
    metavar: 'TYPE',
    help: 'e.g. texts, movies, audio, software, collection.',
  },
  {
    key: 'collections',
    kind: 'string',
    flags: ['--collection'],
    multiple: true,
    metavar: 'COLLECTION',
    help: 'Filter by collection identifier (repeatable or comma-separated).',
  },
  {
    key: 'rows',
    kind: 'integer',
    flags: ['--rows', '--limit', '-n'],
    default: 10,
    metavar: 'N',
    help: 'Results per page (default: 10).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    default: 1,
    metavar: 'N',
    help: 'Results page (default: 1).',
  },
  {
    key: 'sorts',
    kind: 'string',
    flags: ['--sort'],
    multiple: true,
    metavar: 'SORT',
    help: "Repeatable, e.g. --sort 'downloads desc'.",
  },
  {
    key: 'fields',
    kind: 'string',
    flags: ['--field', '--fields'],
    multiple: true,
    metavar: 'FIELD',
    help: 'Repeatable or comma-separated metadata field(s).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: SEARCH_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${SEARCH_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Query cache TTL in hours (default: 168 or KINLOOM_IA_QUERY_TTL_HOURS).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and fetch fresh results.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Full JSON output.',
  },
];

export const SEARCH_PARSE_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
};

export const GET_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Full JSON output.' },
  { key: 'files', kind: 'boolean', flags: ['--files'], help: "List the item's files." },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local metadata cache and fetch fresh metadata.',
  },
];

export const GET_PARSE_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'identifier',
};

export const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--out-dir', '--output'],
    default: '.',
    metavar: 'DIR',
    help: 'Directory to save files into (default: .).',
  },
  {
    key: 'listOnly',
    kind: 'boolean',
    flags: ['--list'],
    help: 'Only list files, do not download.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DOWNLOAD_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DOWNLOAD_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-download metadata and files.',
  },
];

export const DOWNLOAD_PARSE_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'identifier',
};

export const FULLTEXT_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'queryFlag',
    kind: 'string',
    flags: ['-q', '--query'],
    metavar: 'QUERY',
    help: 'Full-text search query (alternative to positional query).',
  },
  {
    key: 'rows',
    kind: 'integer',
    flags: ['--rows', '--limit', '-n'],
    default: 10,
    metavar: 'N',
    help: 'Hits per page (default: 10).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    default: 1,
    metavar: 'N',
    help: 'Results page, 1-based (default: 1).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: SEARCH_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${SEARCH_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    metavar: 'HOURS',
    help: 'Query cache TTL in hours (default: 168 or KINLOOM_IA_QUERY_TTL_HOURS).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and fetch fresh results.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Full JSON output.' },
];

export const FULLTEXT_PARSE_SPEC: CommandParseSpec = {
  options: FULLTEXT_OPTIONS,
  allowPositionals: true,
};

export const GREP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'itemFlags',
    kind: 'string',
    flags: ['--item', '--id'],
    multiple: true,
    metavar: 'ID',
    help: 'Internet Archive item identifier (repeatable alternative to positional identifier).',
  },
  {
    key: 'patterns',
    kind: 'string',
    flags: ['--pattern', '-e', '-q', '--query', '--regex'],
    multiple: true,
    metavar: 'REGEX',
    help: 'Regular expression pattern (searched line by line; repeatable).',
  },
  {
    key: 'context',
    kind: 'integer',
    flags: ['--context', '-C'],
    default: 240,
    metavar: 'CHARS',
    help: 'Context characters per hit snippet (default: 240).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '-m', '-n', '--max', '--max-count'],
    default: 25,
    metavar: 'N',
    help: 'Maximum hits returned (default: 25).',
  },
  {
    key: 'ignoreCase',
    kind: 'boolean',
    flags: ['-i', '--ignore-case'],
    help: 'Case-insensitive regex matching.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-fetch metadata, scandata, and OCR text.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Structured JSON output.' },
];

export const GREP_PARSE_SPEC: CommandParseSpec = {
  options: GREP_OPTIONS,
  allowPositionals: true,
};

export const PAGE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'printedPage',
    kind: 'string',
    flags: ['--printed-page', '--page', '-p'],
    metavar: 'PAGE',
    help: 'Printed page label resolved via cached page_index.json.',
  },
  {
    key: 'printedPages',
    kind: 'string',
    flags: ['--printed-pages', '--pages'],
    metavar: 'SPEC',
    help: 'Comma-separated printed labels and inclusive integer ranges, e.g. 674,707 or 670-674 (max 25).',
  },
  {
    key: 'leaf',
    kind: 'string',
    flags: ['--leaf'],
    metavar: 'LEAF',
    help: 'BookReader leaf index (e.g. 12 or n12).',
  },
  {
    key: 'leaves',
    kind: 'string',
    flags: ['--leaves'],
    metavar: 'SPEC',
    help: 'Comma-separated BookReader leaves and inclusive ranges, e.g. 120-123,130 (max 25).',
  },
  {
    key: 'scale',
    kind: 'integer',
    flags: ['--scale'],
    metavar: 'N',
    help: 'BookReader scale factor (e.g. 1=full, 2=half, 4=quarter).',
  },
  {
    key: 'width',
    kind: 'integer',
    flags: ['--width'],
    metavar: 'PX',
    help: 'Rendered JPEG width in pixels (default 2400 when --scale is omitted).',
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--out-dir', '--output'],
    default: '.',
    metavar: 'PATH',
    help: 'Output file path (.jpg) or directory (default: .).',
  },
  {
    key: 'concurrency',
    kind: 'integer',
    flags: ['--concurrency', '-j'],
    default: PAGE_BATCH_WORKERS,
    metavar: 'N',
    help: `Max concurrent page downloads for batch ranges (1-8, default: ${PAGE_BATCH_WORKERS}).`,
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-fetch index and page JPEG.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Structured JSON output.' },
];

export const PAGE_PARSE_SPEC: CommandParseSpec = {
  options: PAGE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'identifier',
};

export const TEXT_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'itemFlag',
    kind: 'string',
    flags: ['--item', '--id'],
    metavar: 'ID',
    help: 'Item identifier (alternative to positional identifier).',
  },
  {
    key: 'printedPage',
    kind: 'string',
    flags: ['--printed-page', '--page', '-p'],
    metavar: 'PAGE',
    help: 'Printed page label resolved via cached page_index.json.',
  },
  {
    key: 'leaf',
    kind: 'string',
    flags: ['--leaf'],
    metavar: 'LEAF',
    help: 'BookReader leaf index (e.g. 12 or n12).',
  },
  {
    key: 'leaves',
    kind: 'string',
    flags: ['--leaves'],
    metavar: 'SPEC',
    help: 'Comma-separated BookReader leaves and inclusive ranges, e.g. 12-14 or n12-n14.',
  },
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages', '--printed-pages'],
    metavar: 'SPEC',
    help: 'Printed page range or comma-separated labels, e.g. 12-14 or 12,14.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-fetch metadata, scandata, and OCR text.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Structured JSON output.' },
];

export const TEXT_PARSE_SPEC: CommandParseSpec = {
  options: TEXT_OPTIONS,
  allowPositionals: true,
  maxPositionals: 2,
};

export const LOOKUP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'printedPage',
    kind: 'string',
    flags: ['--printed-page', '--page', '-p'],
    metavar: 'PAGE',
    help: 'Printed page label.',
  },
  {
    key: 'leaf',
    kind: 'string',
    flags: ['--leaf'],
    metavar: 'LEAF',
    help: 'BookReader leaf index (e.g. 12 or n12).',
  },
  {
    key: 'scandataLeaf',
    kind: 'integer',
    flags: ['--scandata-leaf'],
    metavar: 'N',
    help: 'Raw scandata.xml leafNum.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_SECONDS,
    metavar: 'SEC',
    help: `HTTP timeout seconds on cache miss (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local cache and re-fetch metadata and scandata.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Structured JSON output.' },
];

export const LOOKUP_PARSE_SPEC: CommandParseSpec = {
  options: LOOKUP_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'identifier',
};

export const URL_OPTIONS: readonly OptionSpec[] = [
  { key: 'queryFlag', kind: 'string', flags: ['-q', '--query'], metavar: 'QUERY' },
  { key: 'mediatype', kind: 'string', flags: ['--mediatype', '--type'], metavar: 'TYPE' },
  {
    key: 'collections',
    kind: 'string',
    flags: ['--collection'],
    multiple: true,
    metavar: 'COLLECTION',
  },
];

export const URL_PARSE_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: true,
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ia <command> [options]',
    summary: 'Search, inspect, grep cached OCR, and download pages from Internet Archive.',
    subcommands: [
      { name: 'search', summary: 'Search items with a Lucene query.' },
      { name: 'get', summary: "Read an item's metadata and file list (aliases: metadata, show)." },
      { name: 'download', summary: 'Download files of an item, or list them with no FILE given.' },
      { name: 'fulltext', summary: 'Search OCR full text across digitized books and periodicals.' },
      {
        name: 'grep',
        summary: 'Search cached full-text OCR inside one or more items with exact page mapping.',
      },
      {
        name: 'page',
        summary: 'Download one or more rendered page JPEGs by printed page or BookReader leaf.',
      },
      { name: 'text', summary: 'Print cached OCR text for a printed page, leaf, or printed-page range.' },
      { name: 'lookup', summary: 'Resolve printed page <-> BookReader leaf <-> scandata leaf.' },
      { name: 'url', summary: 'Print the website advanced-search URL for a query.' },
    ],
  });
}
