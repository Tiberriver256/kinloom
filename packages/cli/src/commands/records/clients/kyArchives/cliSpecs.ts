import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { LAND_BY_CHOICES, LAND_LIMIT_CHOICES } from './domain.js';

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_KY_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const CDM_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'alias',
    kind: 'string',
    flags: ['--collection'],
    default: 'all',
    metavar: 'ALIAS',
    help: 'CONTENTdm collection alias (default: all). See `collections`.',
  },
  {
    key: 'field',
    kind: 'string',
    flags: ['--field'],
    default: 'all',
    metavar: 'FIELD',
    help: 'Search field: all, title, descri, date, subjec, publis, source (default: all).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Maximum records to return.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print raw trimmed JSON.' },
  ...CACHE_OPTIONS,
];

const JSON_CACHE_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print raw JSON.' },
  ...CACHE_OPTIONS,
];

const LAND_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'by',
    kind: 'string',
    flags: ['--by'],
    choices: LAND_BY_CHOICES,
    default: 'grantee',
    help: 'Advanced-search field.',
  },
  {
    key: 'limit',
    kind: 'string',
    flags: ['--limit'],
    choices: LAND_LIMIT_CHOICES,
    default: '10',
    help: 'Results per page.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print JSON.' },
  ...CACHE_OPTIONS,
];

const LAND_PATENT_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'book',
    kind: 'string',
    flags: ['--book'],
    metavar: 'BOOK',
    help: 'Grant book number (quick search).',
  },
  {
    key: 'page',
    kind: 'string',
    flags: ['--page'],
    metavar: 'PAGE',
    help: 'Grant book page (quick search).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print JSON.' },
  ...CACHE_OPTIONS,
];

const PRESERVICA_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Maximum items to return.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Print JSON.' },
  ...CACHE_OPTIONS,
];

export const CDM_SPEC: CommandParseSpec = {
  options: CDM_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

export const CDM_ITEM_SPEC: CommandParseSpec = {
  options: JSON_CACHE_OPTIONS,
  allowPositionals: true,
  minPositionals: 2,
  maxPositionals: 2,
  positionalLabel: 'alias item_id',
};

export const COLLECTIONS_SPEC: CommandParseSpec = {
  options: JSON_CACHE_OPTIONS,
  allowPositionals: false,
};

export const SINGLE_QUERY_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

export const LAND_SPEC: CommandParseSpec = {
  options: LAND_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'term',
};

export const LAND_PATENT_SPEC: CommandParseSpec = {
  options: LAND_PATENT_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'number',
};

export const PRESERVICA_SPEC: CommandParseSpec = {
  options: PRESERVICA_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives <command> [options]',
    summary: 'Search Kentucky archives: KHS, KDLA Preservica, Land Office.',
    subcommands: [
      { name: 'cdm', summary: 'Search KHS Digital Collections (CONTENTdm API).' },
      { name: 'cdm-item', summary: 'Show full metadata for one CONTENTdm item: ALIAS ITEM_ID.' },
      { name: 'collections', summary: 'List the KHS Digital Collections (CONTENTdm aliases).' },
      { name: 'cdm-url', summary: 'Print the verified KHS catalog web search URL for QUERY.' },
      { name: 'land', summary: 'Advanced search of County Court Orders patents (1835-2000).' },
      { name: 'land-patent', summary: 'Quick search of County Court Orders patents by patent number.' },
      { name: 'preservica', summary: 'Search the KDLA Preservica e-archives (WordPress search RSS feed).' },
      { name: 'urls', summary: 'Print every verified Kentucky search URL for QUERY (no requests).' },
    ],
  });
}

export function renderCdmHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives cdm <QUERY> [options]',
    summary: 'Search KHS Digital Collections (CONTENTdm API).',
    options: CDM_OPTIONS,
  });
}

export function renderCdmItemHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives cdm-item <ALIAS> <ITEM_ID> [options]',
    summary: 'Show full metadata for one CONTENTdm item: ALIAS ITEM_ID.',
    options: JSON_CACHE_OPTIONS,
  });
}

export function renderCollectionsHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives collections [options]',
    summary: 'List the KHS Digital Collections (CONTENTdm aliases).',
    options: JSON_CACHE_OPTIONS,
  });
}

export function renderCdmUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives cdm-url <QUERY>',
    summary: 'Print the verified KHS catalog web search URL for QUERY.',
  });
}

export function renderLandHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives land <TERM> [options]',
    summary: 'Advanced search of County Court Orders patents (1835-2000).',
    options: LAND_OPTIONS,
  });
}

export function renderLandPatentHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives land-patent <NUMBER> [options]',
    summary: 'Quick search of County Court Orders patents by patent number.',
    options: LAND_PATENT_OPTIONS,
  });
}

export function renderPreservicaHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives preservica <QUERY> [options]',
    summary: 'Search the KDLA Preservica e-archives (WordPress search RSS feed).',
    options: PRESERVICA_OPTIONS,
  });
}

export function renderUrlsHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ky-archives urls <QUERY>',
    summary: 'Print every verified Kentucky search URL for QUERY (no requests).',
  });
}
