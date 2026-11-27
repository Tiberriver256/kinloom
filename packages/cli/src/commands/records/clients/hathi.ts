import { CliValidationError } from '../../../errors.js';
import {
  type CommandParseSpec,
  cachedJsonCall,
  emitJsonStdout,
  emitStdout,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  httpGetJson,
  type OptionSpec,
  parseCacheTtlHours,
  parseCommandArgs,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  resolveCacheDir,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const BIB_API_BASE = 'https://catalog.hathitrust.org/api/volumes';
const CATALOG_SEARCH_BASE = 'https://catalog.hathitrust.org/Search/Home';
const HATHI_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HATHI_ALLOWED_HOSTS = ['catalog.hathitrust.org'] as const;

export const VALID_ID_TYPES = ['oclc', 'lccn', 'issn', 'isbn', 'htid', 'recordnumber'] as const;

export type HathiIdType = (typeof VALID_ID_TYPES)[number];

export const VALID_SEARCH_TYPES = ['all', 'title', 'author', 'subject'] as const;

interface HathiRecord {
  readonly recordURL?: string;
  readonly titles?: readonly string[];
  readonly publishDates?: readonly string[];
  readonly oclcs?: readonly string[];
  readonly lccns?: readonly string[];
  readonly isbns?: readonly string[];
  readonly issns?: readonly string[];
  readonly 'marc-xml'?: string;
  readonly [key: string]: unknown;
}

interface HathiItem {
  readonly htid?: string;
  readonly orig?: string;
  readonly itemURL?: string;
  readonly enumcron?: string;
  readonly rightsCode?: string;
  readonly usRightsString?: string;
  readonly [key: string]: unknown;
}

interface HathiBibPayload {
  readonly records: Record<string, HathiRecord>;
  readonly items: HathiItem[];
  readonly error?: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIdType(value: string): value is HathiIdType {
  return (VALID_ID_TYPES as readonly string[]).includes(value);
}

export function bibUrl(idType: string, value: string, full: boolean): string {
  const brevity = full ? 'full' : 'brief';
  return `${BIB_API_BASE}/${brevity}/${idType}/${encodeURIComponent(value)}.json`;
}

export function parseHathiId(spec: string): readonly [HathiIdType, string] {
  const colonIdx = spec.indexOf(':');
  if (colonIdx === -1) {
    throw new CliValidationError(`Bad identifier '${spec}'. Use type:value, e.g. oclc:424023.`);
  }
  const idType = spec.slice(0, colonIdx).trim().toLowerCase();
  const value = spec.slice(colonIdx + 1).trim();
  if (!isValidIdType(idType) || !value) {
    throw new CliValidationError(
      `Bad identifier '${spec}'. Type must be one of: ${VALID_ID_TYPES.join(', ')}.`
    );
  }
  return [idType, value];
}

function isBibCacheable(data: HathiBibPayload): boolean {
  if (data.error) {
    return false;
  }
  return Object.keys(data.records).length > 0 || data.items.length > 0;
}

function isHathiBibPayload(value: unknown): value is HathiBibPayload {
  if (!isPlainRecord(value)) {
    return false;
  }
  return isPlainRecord(value.records) && Array.isArray(value.items);
}

async function fetchBib(
  ctx: RecordCommandContext,
  idType: HathiIdType,
  value: string,
  full: boolean
): Promise<HathiBibPayload> {
  const url = bibUrl(idType, value, full);
  const { data } = await httpGetJson<unknown>(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: HATHI_USER_AGENT,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: HATHI_ALLOWED_HOSTS },
  });
  if (!isPlainRecord(data)) {
    throw new RecordRuntimeError(`Bib API returned unexpected JSON shape for ${url}`);
  }
  const records = isPlainRecord(data.records) ? (data.records as Record<string, HathiRecord>) : {};
  const items = Array.isArray(data.items) ? (data.items as HathiItem[]) : [];
  return {
    records,
    items,
    ...(data.error !== undefined ? { error: data.error } : {}),
  };
}

export function compactBib(data: HathiBibPayload, full: boolean, cacheHit = false): string {
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [];
  const recordEntries = Object.entries(data.records);
  const items = data.items;
  if (recordEntries.length === 0 && items.length === 0) {
    return `No matching HathiTrust record (empty records and items).${marker}`;
  }
  let first = true;
  for (const [recNo, rec] of recordEntries) {
    const titles = Array.isArray(rec.titles) ? rec.titles : [];
    const suffix = first ? marker : '';
    first = false;
    lines.push(`Record ${recNo}: ${titles[0] ?? '(no title)'}${suffix}`);
    if (titles.length > 1) {
      lines.push(`  alt titles: ${titles.slice(1).join('; ')}`);
    }
    lines.push(`  record URL: ${rec.recordURL ?? ''}`);
    if (Array.isArray(rec.publishDates) && rec.publishDates.length > 0) {
      lines.push(`  published: ${rec.publishDates.join(', ')}`);
    }
    for (const field of ['oclcs', 'lccns', 'isbns', 'issns'] as const) {
      const vals = rec[field];
      if (Array.isArray(vals) && vals.length > 0) {
        lines.push(`  ${field}: ${vals.join(', ')}`);
      }
    }
    if (full && typeof rec['marc-xml'] === 'string' && rec['marc-xml'].length > 0) {
      lines.push('  marc-xml:');
      lines.push(rec['marc-xml']);
    }
  }
  for (const item of items) {
    const suffix = first ? marker : '';
    first = false;
    lines.push(`Item ${item.htid ?? ''} (${item.orig ?? ''}): ${item.usRightsString ?? ''}${suffix}`);
    lines.push(`  item URL: ${item.itemURL ?? ''}`);
    if (item.enumcron) {
      lines.push(`  enumcron: ${item.enumcron}`);
    }
    if (item.rightsCode) {
      lines.push(`  rights code: ${item.rightsCode}`);
    }
  }
  return lines.join('\n');
}

const BIB_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'ids',
    kind: 'string',
    flags: ['--id'],
    multiple: true,
    metavar: 'TYPE:VALUE',
    help: 'Identifier as type:value, e.g. oclc:424023. Repeatable.',
  },
  {
    key: 'full',
    kind: 'boolean',
    flags: ['--full'],
    help: 'Full record with MARC-XML.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Print raw API JSON.',
  },
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
    help: 'Cache TTL in hours (default 168, env KINLOOM_HATHI_CACHE_TTL_HOURS; 0 disables reads).',
  },
];

const BIB_PARSE_SPEC: CommandParseSpec = {
  options: BIB_OPTIONS,
  allowPositionals: true,
  maxPositionals: 2,
};

const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'searchType',
    kind: 'string',
    flags: ['--type'],
    choices: VALID_SEARCH_TYPES,
    default: 'all',
    metavar: 'TYPE',
    help: 'Catalog search field (all, title, author, subject).',
  },
];

const URL_PARSE_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom hathi <command> [options]',
    summary: 'HathiTrust Digital Library lookups (Bibliographic API, no key).',
    subcommands: [
      {
        name: 'bib',
        summary: 'Look up record(s) by identifier (oclc, lccn, issn, isbn, htid, recordnumber).',
      },
      { name: 'url', summary: 'Print a verified catalog search URL for QUERY.' },
    ],
  });
}

function renderBibHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom hathi bib [ID_TYPE] [VALUE] [options]',
    summary: 'Look up record(s) by identifier (oclc, lccn, issn, isbn, htid, recordnumber).',
    options: BIB_OPTIONS,
    notes: [
      'Examples:',
      '  kinloom hathi bib oclc 424023',
      '  kinloom hathi bib recordnumber 000578050',
      '  kinloom hathi bib --id oclc:424023 --id recordnumber:000578050',
    ],
  });
}

function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom hathi url <QUERY> [options]',
    summary: 'Print a verified catalog search URL for QUERY (open in a browser).',
    options: URL_OPTIONS,
  });
}

async function runBib(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, BIB_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderBibHelp()) };
  }

  const ids = getStringListOption(parsed, 'ids');
  const full = getBooleanOption(parsed, 'full');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');

  let specs: (readonly [HathiIdType, string])[] = [];
  if (ids.length > 0) {
    specs = ids.map((spec) => parseHathiId(spec));
  } else if (parsed.positionals.length === 2) {
    const idType = parsed.positionals[0].trim().toLowerCase();
    const value = parsed.positionals[1].trim();
    if (!isValidIdType(idType) || !value) {
      throw new CliValidationError(`Invalid id type '${idType}'. Choose from: ${VALID_ID_TYPES.join(', ')}`);
    }
    specs = [[idType, value]];
  } else {
    throw new CliValidationError(
      'Give an identifier: hathi bib <type> <value> or hathi bib --id type:value [--id type:value ...]'
    );
  }

  const ttlHours = parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_HATHI_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_HATHI_CACHE_TTL_HOURS'
  );
  const cacheDir = resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_HATHI_CACHE_DIR'],
    defaultSubdir: 'kinloom-hathi',
  });

  const mergedRecords: Record<string, HathiRecord> = {};
  const mergedItems: HathiItem[] = [];
  const hits: boolean[] = [];

  for (const [specType, specValue] of specs) {
    const { value: data, cacheHit } = await cachedJsonCall<HathiBibPayload>({
      cacheDir,
      kind: 'bib',
      payload: { id_type: specType, value: specValue, full },
      ttlHours,
      refresh,
      fetch: () => fetchBib(ctx, specType, specValue, full),
      cacheable: isBibCacheable,
      validateCached: isHathiBibPayload,
      nowMs: ctx.nowMs,
      sleepFn: ctx.sleepFn,
    });
    hits.push(cacheHit);
    Object.assign(mergedRecords, data.records);
    mergedItems.push(...data.items);
  }

  const allCached = hits.length > 0 && hits.every(Boolean);
  const merged: HathiBibPayload = { records: mergedRecords, items: mergedItems };

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...merged, cache_hit: allCached });
    return { exitCode: 0, bytesOut, cacheHit: allCached };
  }
  const bytesOut = emitStdout(ctx.io, compactBib(merged, full, allCached));
  return { exitCode: 0, bytesOut, cacheHit: allCached };
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }
  const query = parsed.positionals[0];
  const searchType = getStringOption(parsed, 'searchType') ?? 'all';
  const params = `lookfor=${encodeURIComponent(query)}&type=${encodeURIComponent(searchType)}&inst=`;
  const bytesOut = emitStdout(ctx.io, `${CATALOG_SEARCH_BASE}?${params}`);
  return { exitCode: 0, bytesOut };
}

export const runHathiCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'bib':
        return await runBib(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom hathi --script-help'.`);
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
