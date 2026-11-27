import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { CATALOG_FIELDS } from './domain.js';

export const REFRESH_CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this command and refetch.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_VA_ARCHIVES_TTL_HOURS / KINLOOM_VA_ARCHIVES_CACHE_TTL_HOURS).',
  },
];

export const CHANCERY_SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'locality',
    kind: 'string',
    flags: ['--locality'],
    default: 'All',
    help: "County/city, e.g. 'ALBEMARLE CO'. Default All.",
  },
  {
    key: 'match',
    kind: 'string',
    flags: ['--match'],
    default: 'Starts',
    help: 'How the surname match works (Exact/Starts/Includes).',
  },
  {
    key: 'surname2',
    kind: 'string',
    flags: ['--surname2'],
    help: 'Second surname (ANDed by the index form).',
  },
  { key: 'plaintiffLast', kind: 'string', flags: ['--plaintiff-last'], help: 'Plaintiff last name.' },
  { key: 'plaintiffFirst', kind: 'string', flags: ['--plaintiff-first'], help: 'Plaintiff first name.' },
  { key: 'defendantLast', kind: 'string', flags: ['--defendant-last'], help: 'Defendant last name.' },
  { key: 'defendantFirst', kind: 'string', flags: ['--defendant-first'], help: 'Defendant first name.' },
  { key: 'yearFrom', kind: 'string', flags: ['--year-from'], help: 'First year of case (strDate1).' },
  { key: 'yearTo', kind: 'string', flags: ['--year-to'], help: 'Last year of case (strDate2).' },
  {
    key: 'indexNumber',
    kind: 'string',
    flags: ['--index-number'],
    help: 'Index number, e.g. YYYY-NNN (txtIndexNum).',
  },
  {
    key: 'localCaseNumber',
    kind: 'string',
    flags: ['--local-case-number'],
    help: 'Local case file number (txtLclCFN).',
  },
  {
    key: 'enslaved',
    kind: 'boolean',
    flags: ['--enslaved'],
    help: 'Only cases referencing enslaved persons.',
  },
  { key: 'free', kind: 'boolean', flags: ['--free'], help: 'Only cases referencing free persons.' },
  { key: 'plats', kind: 'boolean', flags: ['--plats'], help: 'Only cases with plats available.' },
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages'],
    default: '1',
    help: "Result pages to fetch: '1', '1-3', '1,3', or 'all'.",
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

export const CHANCERY_CASE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'images',
    kind: 'boolean',
    flags: ['--images'],
    help: 'Also list the scanned page PDFs and ZIP URL.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

export const CHANCERY_DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outDir',
    kind: 'string',
    flags: ['--out'],
    metavar: 'DIR',
    help: 'Output directory (default: ./va-chancery-<cfn>).',
  },
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages'],
    default: 'all',
    help: "1-based page selection, e.g. '1-5' or 'all'.",
  },
  {
    key: 'asZip',
    kind: 'boolean',
    flags: ['--zip'],
    help: 'Download the whole-case ZIP instead of page PDFs.',
  },
  { key: 'overwrite', kind: 'boolean', flags: ['--overwrite'], help: 'Overwrite existing files.' },
  ...REFRESH_CACHE_OPTIONS,
];

export const CHANCERY_LOCALITIES_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'status',
    kind: 'string',
    flags: ['--status'],
    help: 'Filter by viewing status substring, e.g. Scanned.',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output a JSON list of locality rows.' },
  ...REFRESH_CACHE_OPTIONS,
];

export const CATALOG_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'field',
    kind: 'string',
    flags: ['--field'],
    choices: CATALOG_FIELDS,
    default: 'any',
    help: 'PNXS search field (any, title, creator).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 1,
    default: 10,
    help: 'Results per page (PNXS limit).',
  },
  {
    key: 'offset',
    kind: 'integer',
    flags: ['--offset'],
    min: 0,
    default: 0,
    help: 'Result offset (PNXS offset).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

export const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'chanceryCase',
    kind: 'string',
    flags: ['--chancery-case'],
    metavar: 'CFN',
    help: 'CFN (locality-year-number).',
  },
  {
    key: 'catalogQuery',
    kind: 'string',
    flags: ['--catalog'],
    metavar: 'QUERY',
    help: 'Catalog search term (Primo search URL).',
  },
  {
    key: 'chronicle',
    kind: 'boolean',
    flags: ['--chronicle'],
    help: 'Virginia Chronicle home page (browser-only).',
  },
  {
    key: 'land',
    kind: 'boolean',
    flags: ['--land'],
    help: 'Land Office patents/grants: libguide + LONN volume index.',
  },
  {
    key: 'arvas',
    kind: 'boolean',
    flags: ['--arvas'],
    help: 'ARVAS finding-aid search home (browser-only).',
  },
  { key: 'chancery', kind: 'boolean', flags: ['--chancery'], help: 'Chancery Records Index home page.' },
];

export const GRANT_TIF_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out'],
    metavar: 'FILE',
    help: 'Output file (.jpg/.jpeg converts; else raw).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

export const DUNMORE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'pageNo',
    kind: 'integer',
    flags: ['--page'],
    min: 1,
    help: "Page number to save (default: the card's own page).",
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['--out'],
    metavar: 'FILE',
    help: 'Save the selected page image (.jpg converts; else raw TIFF).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

export const ROSETTA_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'fileIndex',
    kind: 'integer',
    flags: ['--file'],
    min: 1,
    help: "1-based file number from --list (default: viewer's initial file).",
  },
  {
    key: 'flId',
    kind: 'string',
    flags: ['--fl'],
    metavar: 'FL_ID',
    help: 'Explicit Rosetta file pid (FL<digits>) belonging to this IE.',
  },
  { key: 'listOnly', kind: 'boolean', flags: ['--list'], help: "Only list the IE's delivered files." },
  {
    key: 'out',
    kind: 'string',
    flags: ['--out'],
    metavar: 'FILE',
    help: 'Output file (default ./<IE>_<FL>.<ext>).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

export const CHANCERY_SEARCH_SPEC: CommandParseSpec = {
  options: CHANCERY_SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'surname',
};

export const CHANCERY_CASE_SPEC: CommandParseSpec = {
  options: CHANCERY_CASE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'cfn',
};

export const CHANCERY_DOWNLOAD_SPEC: CommandParseSpec = {
  options: CHANCERY_DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'cfn',
};

export const CHANCERY_LOCALITIES_SPEC: CommandParseSpec = {
  options: CHANCERY_LOCALITIES_OPTIONS,
  allowPositionals: false,
};

export const CATALOG_SPEC: CommandParseSpec = {
  options: CATALOG_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

export const URL_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: false,
};

export const GRANT_TIF_SPEC: CommandParseSpec = {
  options: GRANT_TIF_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'path_or_url',
};

export const DUNMORE_SPEC: CommandParseSpec = {
  options: DUNMORE_OPTIONS,
  allowPositionals: true,
  minPositionals: 2,
  maxPositionals: 2,
  positionalLabel: 'drawer card',
};

export const ROSETTA_SPEC: CommandParseSpec = {
  options: ROSETTA_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'ie_id',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives [--refresh] <command> [options]',
    summary: 'Search the Library of Virginia: Chancery Records Index, Primo catalog, image server, Rosetta.',
    subcommands: [
      { name: 'chancery', summary: 'Chancery Records Index (search, case, download, localities).' },
      { name: 'catalog', summary: 'Search the Library of Virginia catalog via Primo PNXS API.' },
      { name: 'grant-tif', summary: 'Fetch (and cache) one Library of Virginia image-server scan.' },
      { name: 'lva-tif', summary: 'Alias of grant-tif.' },
      { name: 'dunmore', summary: "Resolve a Dunmore's War (1774) index card to its page TIFFs." },
      { name: 'download-rosetta', summary: 'Download a delivered file (PDF/image) for a Rosetta IE id.' },
      { name: 'url', summary: 'Print verified portal URLs (no search is run).' },
    ],
  });
}

export function renderChanceryHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives chancery <command> [options]',
    summary: 'Chancery Records Index (old.lva.virginia.gov/chancery).',
    subcommands: [
      { name: 'search', summary: 'Search the Chancery Records Index by surname (more surnames = OR).' },
      { name: 'case', summary: 'Show one chancery cause by CFN (locality-year-number).' },
      { name: 'download', summary: 'Download scanned pages (or whole-case ZIP) for one chancery cause.' },
      { name: 'localities', summary: 'List per-locality chancery coverage from available.asp.' },
    ],
  });
}

export function renderChancerySearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives chancery search <SURNAMES...> [options]',
    summary: 'Search the Chancery Records Index by surname (more surnames = OR).',
    options: CHANCERY_SEARCH_OPTIONS,
  });
}

export function renderChanceryCaseHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives chancery case <CFN> [options]',
    summary: 'Show one chancery cause by CFN (locality-year-number).',
    options: CHANCERY_CASE_OPTIONS,
  });
}

export function renderChanceryDownloadHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives chancery download <CFN> [options]',
    summary: 'Download the scanned pages (or whole-case ZIP) for one chancery cause.',
    options: CHANCERY_DOWNLOAD_OPTIONS,
  });
}

export function renderChanceryLocalitiesHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives chancery localities [options]',
    summary: 'List per-locality chancery coverage from available.asp.',
    options: CHANCERY_LOCALITIES_OPTIONS,
  });
}

export function renderCatalogHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives catalog <QUERY> [options]',
    summary: 'Search the Library of Virginia catalog via the public Primo PNXS API.',
    options: CATALOG_OPTIONS,
  });
}

export function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives url [options]',
    summary: 'Print verified portal URLs (no search is run).',
    options: URL_OPTIONS,
  });
}

export function renderGrantTifHelp(commandName: 'grant-tif' | 'lva-tif'): string {
  return formatCommandUsage({
    usage: `kinloom va-archives ${commandName} <PATH_OR_URL> [options]`,
    summary:
      'Fetch (and cache) one Library of Virginia image-server scan (e.g. /LONN/LO-3/372/372_0195.tif). --out x.jpg converts TIFF to JPEG.',
    options: GRANT_TIF_OPTIONS,
  });
}

export function renderDunmoreHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives dunmore <DRAWER> <CARD> [options]',
    summary: "Resolve a Dunmore's War (1774) index card to its page TIFFs on image.lva.virginia.gov.",
    options: DUNMORE_OPTIONS,
  });
}

export function renderRosettaHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives download-rosetta <IE_ID> [options]',
    summary: 'Download a delivered file (PDF/image) for a Library of Virginia Rosetta IE id.',
    options: ROSETTA_OPTIONS,
  });
}
