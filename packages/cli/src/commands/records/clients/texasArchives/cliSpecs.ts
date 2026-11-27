import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_TEXAS_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const PORTAL_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    metavar: 'COUNTY',
    help: 'Add a county term to the query and filter hits that mention it.',
  },
  {
    key: 'dateFrom',
    kind: 'string',
    flags: ['--date-from'],
    metavar: 'YYYY-MM-DD',
    help: 'Keep hits on or after this date (YYYY-MM-DD).',
  },
  {
    key: 'dateTo',
    kind: 'string',
    flags: ['--date-to'],
    metavar: 'YYYY-MM-DD',
    help: 'Keep hits on or before this date (YYYY-MM-DD).',
  },
  {
    key: 'typeFilter',
    kind: 'string',
    flags: ['--type'],
    metavar: 'TYPE',
    help: 'Keep hits whose dc:type matches, e.g. text_newspaper.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Maximum hits to print after filters.',
  },
  {
    key: 'pages',
    kind: 'integer',
    flags: ['--pages'],
    min: 1,
    default: 3,
    help: 'OpenSearch pages to scan (100 hits each).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...CACHE_OPTIONS,
];

const PORTAL_ITEM_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...CACHE_OPTIONS,
];

const TDA_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Maximum items to return.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...CACHE_OPTIONS,
];

const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'portal',
    kind: 'boolean',
    flags: ['--portal'],
    help: 'Portal to Texas History full-text search URL.',
  },
  { key: 'tda', kind: 'boolean', flags: ['--tda'], help: 'Texas Digital Archive search URL.' },
  { key: 'glo', kind: 'boolean', flags: ['--glo'], help: 'Texas GLO land grant lookup (browser-only).' },
  { key: 'rangers', kind: 'boolean', flags: ['--rangers'], help: 'TSLAC Texas Rangers collection pointer.' },
  {
    key: 'tslac',
    kind: 'boolean',
    flags: ['--tslac'],
    help: 'Texas State Library and Archives Commission home.',
  },
];

export const PORTAL_SEARCH_SPEC: CommandParseSpec = {
  options: PORTAL_SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'query',
};

export const PORTAL_ITEM_SPEC: CommandParseSpec = {
  options: PORTAL_ITEM_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'ark_id',
};

export const TDA_SPEC: CommandParseSpec = {
  options: TDA_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

export const URL_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'query',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom texas-archives <command> [options]',
    summary: 'Search Texas archives: Portal to Texas History, Texas Digital Archive, URL builders.',
    subcommands: [
      { name: 'portal', summary: 'The Portal to Texas History (University of North Texas): search, item.' },
      { name: 'tda', summary: 'Search the Texas Digital Archive (TSLAC Preservica RSS feed).' },
      { name: 'url', summary: 'Print verified portal URLs (no search is run).' },
    ],
  });
}

export function renderPortalHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom texas-archives portal <command> [options]',
    summary: 'The Portal to Texas History (University of North Texas).',
    subcommands: [
      { name: 'search', summary: 'Search the Portal via its public OpenSearch JSON API.' },
      { name: 'item', summary: 'Fetch Dublin Core metadata for one Portal item (OAI-PMH GetRecord).' },
    ],
  });
}

export function renderPortalSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom texas-archives portal search <QUERY...> [options]',
    summary: 'Search the Portal via its public OpenSearch JSON API.',
    options: PORTAL_SEARCH_OPTIONS,
  });
}

export function renderPortalItemHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom texas-archives portal item <ARK_ID> [options]',
    summary: 'Fetch Dublin Core metadata for one Portal item (OAI-PMH GetRecord).',
    options: PORTAL_ITEM_OPTIONS,
  });
}

export function renderTdaHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom texas-archives tda <QUERY> [options]',
    summary: 'Search the Texas Digital Archive (TSLAC Preservica RSS feed).',
    options: TDA_OPTIONS,
  });
}

export function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom texas-archives url [QUERY] [options]',
    summary: 'Print verified portal URLs (no search is run).',
    options: URL_OPTIONS,
  });
}
