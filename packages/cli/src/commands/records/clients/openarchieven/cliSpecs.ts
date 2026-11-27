import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { VALID_LANGS } from './domain.js';

export const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  get: 'show',
};

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_OPENARCHIEVEN_CACHE_TTL_HOURS; 0 disables reads).',
  },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'nameOpt',
    kind: 'string',
    flags: ['--name', '--query', '-q'],
    metavar: 'NAME',
    help: "Person name query (may include '&' for two names).",
  },
  {
    key: 'firstName',
    kind: 'string',
    flags: ['--first', '--first-name', '--given', '--given-name'],
    metavar: 'FIRST',
    help: 'Given name (combined with --last/--surname).',
  },
  {
    key: 'lastName',
    kind: 'string',
    flags: ['--last', '--last-name', '--surname'],
    metavar: 'LAST',
    help: 'Surname (combined with --first/--given).',
  },
  {
    key: 'place',
    kind: 'string',
    flags: ['--place'],
    metavar: 'PLACE',
    help: 'Filter by event place (eventplace), e.g. Zundert or Rotterdam.',
  },
  {
    key: 'birthPlace',
    kind: 'string',
    flags: ['--birth-place'],
    metavar: 'PLACE',
    help: 'Filter by person birth place (birthplace).',
  },
  {
    key: 'eventType',
    kind: 'string',
    flags: ['--event-type'],
    metavar: 'TYPE',
    help: "Event type (e.g. Geboorte, Huwelijk, Overlijden) or source type (e.g. 'BS Geboorte', Bevolkingsregister).",
  },
  {
    key: 'sourceType',
    kind: 'string',
    flags: ['--source-type'],
    metavar: 'TYPE',
    help: "Explicit OpenArchieven source type (e.g. 'BS Geboorte', Bevolkingsregister, Passagiersregisters).",
  },
  {
    key: 'year',
    kind: 'string',
    flags: ['--year'],
    metavar: 'YEAR',
    help: 'Year or year range (e.g. 1853 or 1850-1860), appended to the name query.',
  },
  {
    key: 'archive',
    kind: 'string',
    flags: ['--archive'],
    metavar: 'CODE',
    help: 'Archive code filter, e.g. bhi, wba, srt, saa, zal.',
  },
  {
    key: 'relation',
    kind: 'string',
    flags: ['--relation'],
    metavar: 'ROLE',
    help: 'Relation/role filter, e.g. Kind, Vader, Bruid, Geregistreerde.',
  },
  {
    key: 'country',
    kind: 'string',
    flags: ['--country'],
    metavar: 'CODE',
    help: 'Country code filter, e.g. nl, be, fr.',
  },
  {
    key: 'lang',
    kind: 'string',
    flags: ['--lang'],
    choices: VALID_LANGS,
    default: 'nl',
    metavar: 'LANG',
    help: 'Language for returned archive and type labels (default: nl).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '-n', '--rows'],
    default: 10,
    metavar: 'N',
    help: 'Results to return (default: 10, max 100).',
  },
  {
    key: 'start',
    kind: 'integer',
    flags: ['--start', '--offset'],
    default: 0,
    metavar: 'N',
    help: 'Offset for paging (default: 0, max 10000).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    min: 1,
    metavar: 'PAGE',
    help: '1-based page. Sets start to (page - 1) times the limit sent to the API. Do not combine with --start.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit raw API JSON output.',
  },
  ...CACHE_OPTIONS,
];

export const SEARCH_PARSE_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

const SHOW_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'lang',
    kind: 'string',
    flags: ['--lang'],
    choices: VALID_LANGS,
    default: 'nl',
    metavar: 'LANG',
    help: 'Language for returned labels (default: nl).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit raw A2A JSON output.',
  },
  ...CACHE_OPTIONS,
];

export const SHOW_PARSE_SPEC: CommandParseSpec = {
  options: SHOW_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'archive/identifier',
};

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'scanIndex',
    kind: 'integer',
    flags: ['--scan-index'],
    min: 1,
    default: 1,
    metavar: 'N',
    help: '1-based scan to download. Ignored with --all and with --list (default: 1).',
  },
  {
    key: 'downloadAll',
    kind: 'boolean',
    flags: ['--all'],
    help: 'Download every scan into --out-dir.',
  },
  {
    key: 'listOnly',
    kind: 'boolean',
    flags: ['--list'],
    help: 'Print scan index, label, and URL. Do not download.',
  },
  {
    key: 'preview',
    kind: 'boolean',
    flags: ['--preview'],
    help: 'Use uri_preview instead of the full-resolution scan uri.',
  },
  {
    key: 'dest',
    kind: 'string',
    flags: ['--out', '--output', '-o', '--out-dir', '--output-dir'],
    metavar: 'PATH',
    help: 'Output file for one scan, or the output directory when --all is set.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON with cache_hit and files or scans.',
  },
  {
    key: 'lang',
    kind: 'string',
    flags: ['--lang'],
    choices: VALID_LANGS,
    default: 'nl',
    metavar: 'LANG',
    help: 'Language passed to the cached show lookup (default: nl).',
  },
  ...CACHE_OPTIONS,
];

export const DOWNLOAD_PARSE_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'archive/identifier or scan URL',
};

const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'name',
    kind: 'string',
    flags: ['--name'],
    metavar: 'NAME',
    help: 'Person name query.',
  },
  {
    key: 'place',
    kind: 'string',
    flags: ['--place'],
    metavar: 'PLACE',
    help: 'Event place.',
  },
  {
    key: 'year',
    kind: 'string',
    flags: ['--year'],
    metavar: 'YEAR',
    help: 'Year or year range (e.g. 1853 or 1850-1860).',
  },
  {
    key: 'record',
    kind: 'string',
    flags: ['--record'],
    metavar: 'TOKEN',
    help: "Record token 'archive:uuid' to build a direct record URL.",
  },
];

export const URL_PARSE_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: false,
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven <command> [options]',
    summary: 'Search and inspect Dutch and Belgian archive records on OpenArchieven.',
    subcommands: [
      { name: 'search', summary: 'Search OpenArchieven records.' },
      {
        name: 'show',
        summary: 'Fetch full A2A details for one record (alias: get).',
      },
      {
        name: 'download',
        summary: 'Download scan images for one OpenArchieven record or a direct scan URL.',
      },
      { name: 'url', summary: 'Print a shareable OpenArchieven website URL offline.' },
    ],
  });
}

export function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven search [NAME] [options]',
    summary: 'Search OpenArchieven records.',
    options: SEARCH_OPTIONS,
    notes: [
      'Example:',
      '  kinloom openarchieven search --name "Vincent van Gogh" --place Zundert --year 1853',
    ],
  });
}

export function renderShowHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven show <ARCHIVE|ARCHIVE:UUID|URL> [IDENTIFIER] [options]',
    summary: 'Fetch full A2A details for one record by ARCHIVE IDENTIFIER, archive:uuid, or URL.',
    options: SHOW_OPTIONS,
  });
}

export function renderDownloadHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven download <ARCHIVE|ARCHIVE:UUID|URL> [IDENTIFIER|OUT] [options]',
    summary: 'Download scan images for one OpenArchieven record or a direct scan URL.',
    options: DOWNLOAD_OPTIONS,
  });
}

export function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom openarchieven url [options]',
    summary: 'Print a shareable OpenArchieven website URL offline.',
    options: URL_OPTIONS,
  });
}
