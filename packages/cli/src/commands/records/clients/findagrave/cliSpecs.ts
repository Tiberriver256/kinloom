import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';

export const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'fullName',
    kind: 'string',
    flags: ['--name'],
    metavar: 'NAME',
    help: 'Full name (split into first and last name).',
  },
  {
    key: 'firstName',
    kind: 'string',
    flags: ['--first', '--first-name', '--given', '--given-name'],
    metavar: 'TEXT',
    help: 'First name.',
  },
  {
    key: 'lastName',
    kind: 'string',
    flags: ['--last', '--last-name', '--surname'],
    metavar: 'TEXT',
    help: 'Last name.',
  },
  {
    key: 'birthYear',
    kind: 'integer',
    flags: ['--birth-year', '--birth', '--born'],
    metavar: 'YEAR',
    help: 'Birth year.',
  },
  {
    key: 'deathYear',
    kind: 'integer',
    flags: ['--death-year', '--death', '--died'],
    metavar: 'YEAR',
    help: 'Death year.',
  },
  {
    key: 'yearRange',
    kind: 'integer',
    flags: [
      '--year-range',
      '--birth-range',
      '--death-range',
      '--birth-year-range',
      '--death-year-range',
      '--date-spread',
    ],
    metavar: 'YEARS',
    help: 'Plus/minus years around a birth/death year.',
  },
  {
    key: 'birthYearFilter',
    kind: 'string',
    flags: ['--birth-year-filter'],
    metavar: 'FILTER',
    help: 'before, after, exact, or unknown.',
  },
  {
    key: 'deathYearFilter',
    kind: 'string',
    flags: ['--death-year-filter'],
    metavar: 'FILTER',
    help: 'before, after, exact, or unknown.',
  },
  {
    key: 'cemeteryId',
    kind: 'string',
    flags: ['--cemetery-id', '--cemetery'],
    multiple: true,
    metavar: 'ID_OR_URL',
    help: 'Repeatable cemetery id or URL.',
  },
  {
    key: 'locationId',
    kind: 'string',
    flags: ['--location-id', '--location'],
    metavar: 'LOCATION_ID',
    help: 'Place id, e.g. city_<id> (see the place command).',
  },
  {
    key: 'bio',
    kind: 'string',
    flags: ['--bio'],
    metavar: 'TEXT',
    help: 'Words in the biography.',
  },
  {
    key: 'text',
    kind: 'string',
    flags: ['--text', '--full-text'],
    metavar: 'TEXT',
    help: 'Words anywhere on the memorial.',
  },
  {
    key: 'relative',
    kind: 'string',
    flags: ['--relative'],
    metavar: 'NAME',
    help: 'Name of a linked relative.',
  },
  {
    key: 'exact',
    kind: 'boolean',
    flags: ['--exact'],
    negatable: true,
    default: false,
    help: 'Exact name match (default: site matching).',
  },
  {
    key: 'includeMaiden',
    kind: 'boolean',
    flags: ['--include-maiden'],
    negatable: true,
    default: true,
    help: 'Also match married women under maiden names.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit', '--rows', '--size'],
    default: 10,
    min: 1,
    metavar: 'N',
    help: 'Rows per call (max 50).',
  },
  {
    key: 'page',
    kind: 'integer',
    flags: ['--page'],
    min: 1,
    metavar: 'PAGE',
    help: '1-based result page (alternative to --offset).',
  },
  {
    key: 'offset',
    kind: 'integer',
    flags: ['--offset'],
    min: 0,
    metavar: 'OFFSET',
    help: '0-based result offset (default: 0).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local disk cache and query Find a Grave fresh.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Override cache TTL in hours (default: 168 or $KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS).',
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
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local disk cache and fetch fresh memorial data.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Override cache TTL in hours (default: 168 or $KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Full JSON output.',
  },
  {
    key: 'full',
    kind: 'boolean',
    flags: ['--full'],
    help: 'Print full bio and inscription instead of truncated.',
  },
  {
    key: 'photos',
    kind: 'boolean',
    flags: ['--photos'],
    help: 'List photo ids, types, and image URLs.',
  },
];

export const GET_PARSE_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'memorial id',
};

export const CEMETERY_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'name',
    kind: 'string',
    flags: ['--name'],
    metavar: 'NAME',
    help: 'Cemetery name to search.',
  },
  {
    key: 'cemeteryId',
    kind: 'string',
    flags: ['--id'],
    metavar: 'ID_OR_URL',
    help: 'Read one cemetery by id or URL (or pass id as a positional argument).',
  },
  {
    key: 'place',
    kind: 'string',
    flags: ['--place'],
    metavar: 'PLACE',
    help: "Containing place name, e.g. 'Sangamon County, Illinois'.",
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit'],
    default: 10,
    min: 1,
    metavar: 'N',
    help: 'Rows per call (default: 10, max: 100).',
  },
  {
    key: 'offset',
    kind: 'integer',
    flags: ['--offset'],
    default: 0,
    min: 0,
    metavar: 'OFFSET',
    help: '0-based result offset (default: 0).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local disk cache and fetch fresh cemetery data.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Override cache TTL in hours (default: 168 or $KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Full JSON output.',
  },
];

export const CEMETERY_PARSE_SPEC: CommandParseSpec = {
  options: CEMETERY_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

export const PLACE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'name',
    kind: 'string',
    flags: ['--name'],
    metavar: 'NAME',
    help: 'Place name, e.g. Springfield.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit'],
    default: 10,
    min: 1,
    metavar: 'N',
    help: 'Rows per call (default: 10, max: 50).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local disk cache and fetch fresh places.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Override cache TTL in hours (default: 168 or $KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Full JSON output.',
  },
];

export const PLACE_PARSE_SPEC: CommandParseSpec = {
  options: PLACE_OPTIONS,
  allowPositionals: true,
};

export const PHOTO_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['-o', '--out', '--out-dir', '--output'],
    default: '.',
    metavar: 'DIR',
    help: 'Directory to save photos into.',
  },
  {
    key: 'photoType',
    kind: 'string',
    flags: ['--type'],
    metavar: 'TYPE',
    help: 'Only download this photo type, e.g. Grave.',
  },
  {
    key: 'prefix',
    kind: 'string',
    flags: ['--prefix'],
    metavar: 'PREFIX',
    help: "Optional filename prefix, e.g. 'lincoln-abraham' -> '<prefix>_<photo-id>.jpg'.",
  },
  {
    key: 'allTypes',
    kind: 'boolean',
    flags: ['--all'],
    help: 'Download every photo type. This is the default when --type is omitted.',
  },
  {
    key: 'saveMetadata',
    kind: 'boolean',
    flags: ['--metadata'],
    help: 'Also write a sidecar JSON file with memorial and photo provenance.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass local memorial and photo caches and re-download fresh files.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Override cache TTL in hours for memorial JSON and photo files (default: 168 or $KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Print memorial_id, files, and cache_hit instead of text lines.',
  },
];

export const PHOTO_PARSE_SPEC: CommandParseSpec = {
  options: PHOTO_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'memorial id',
};

export const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'firstName',
    kind: 'string',
    flags: ['--first', '--first-name', '--given', '--given-name'],
    metavar: 'TEXT',
    help: 'First name.',
  },
  {
    key: 'lastName',
    kind: 'string',
    flags: ['--last', '--last-name', '--surname'],
    metavar: 'TEXT',
    help: 'Last name.',
  },
  {
    key: 'birthYear',
    kind: 'integer',
    flags: ['--birth-year', '--birth', '--born'],
    metavar: 'YEAR',
    help: 'Birth year.',
  },
  {
    key: 'deathYear',
    kind: 'integer',
    flags: ['--death-year', '--death', '--died'],
    metavar: 'YEAR',
    help: 'Death year.',
  },
];

export const URL_PARSE_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: false,
};

export const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  memorial: 'get',
  show: 'get',
  photos: 'photo',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave <command> [options]',
    summary: 'Search and read Find a Grave memorials, cemeteries, and places.',
    subcommands: [
      { name: 'search', summary: 'Search memorials by name, dates, cemetery, or place.' },
      { name: 'get', summary: 'Read one or more memorials in full (aliases: memorial, show).' },
      { name: 'cemetery', summary: 'Search cemeteries by name, or read one by id or URL.' },
      { name: 'place', summary: 'Resolve a place name to Find a Grave place ids.' },
      { name: 'photo', summary: "Download a memorial's photos (alias: photos)." },
      { name: 'url', summary: 'Print the website search URL for a name.' },
    ],
  });
}

export function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave search [NAME...] [options]',
    summary: 'Search memorials. Example: search --first Abraham --last Lincoln.',
    options: SEARCH_OPTIONS,
  });
}

export function renderGetHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave get <MEMORIAL_ID>... [options]',
    summary: 'Read one or more memorials in full by memorial id or URL (aliases: memorial, show).',
    options: GET_OPTIONS,
  });
}

export function renderCemeteryHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave cemetery [CEMETERY_ID] [options]',
    summary: 'Search cemeteries by name, or read one by id.',
    options: CEMETERY_OPTIONS,
  });
}

export function renderPlaceHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave place [PLACE...] [options]',
    summary: 'Resolve a place name to Find a Grave place ids.',
    options: PLACE_OPTIONS,
  });
}

export function renderPhotoHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave photo <MEMORIAL_ID> [options]',
    summary: "Download a memorial's photos (grave, portrait, family, other; alias: photos).",
    options: PHOTO_OPTIONS,
  });
}

export function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave url [options]',
    summary: 'Print the website search URL for a name (open it in a browser).',
    options: URL_OPTIONS,
  });
}
