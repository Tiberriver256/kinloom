import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  canonicalJsonStringify,
  emitJsonStdout,
  emitStdout,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpGetBytes,
  parseCacheTtlHours,
  parseCommandArgs,
  RecordRuntimeError,
  resolveCacheDir,
  sha256Hex,
  unzipEntries,
  withAdvisoryLock,
  type CommandParseSpec,
  type OptionSpec,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
} from '../runtime/index.js';

export const S3_BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames';
export const SEARCH_APP = 'https://edits.nationalmap.gov/apps/gaz-domestic/public/search/names';
const GNIS_USER_AGENT = 'kinloom/1.0 (genealogy research)';
const GNIS_ALLOWED_HOSTS = ['prd-tnm.s3.amazonaws.com'] as const;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_QUERY_TTL_HOURS = 720;

export const GNIS_STATE_CODES: ReadonlySet<string> = new Set([
  'AK', 'AL', 'AR', 'AS', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA',
  'GU', 'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME',
  'MI', 'MN', 'MO', 'MP', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM',
  'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'PR', 'RI', 'SC', 'SD', 'TN', 'TX',
  'UT', 'VA', 'VI', 'VT', 'WA', 'WI', 'WV', 'WY',
]);

export type GnisRow = Record<string, string>;

export interface GnisCompactFeature {
  readonly feature_id: string | null;
  readonly feature_name: string | null;
  readonly feature_class: string | null;
  readonly state: string | null;
  readonly county: string | null;
  readonly map_name: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly date_created: string | null;
  readonly date_edited: string | null;
}

export interface GnisSearchPayload {
  readonly source: string;
  readonly matches: number;
  readonly results: GnisCompactFeature[];
}

interface GnisQueryParams {
  readonly name: string;
  readonly state: string | null;
  readonly exact: boolean;
  readonly feature_class: string | null;
  readonly county: string | null;
  readonly historical: boolean;
  readonly limit: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_GNIS_CACHE_DIR', 'GNIS_CACHE_DIR'],
    defaultSubdir: 'kinloom-gnis',
  });
}

function resolveQueryTtlHours(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  if (cliTtl !== undefined) {
    return parseCacheTtlHours(cliTtl, DEFAULT_QUERY_TTL_HOURS, '--cache-ttl-hours');
  }
  const queryEnv = ctx.env.KINLOOM_GNIS_QUERY_TTL_HOURS;
  if (queryEnv !== undefined && queryEnv.trim().length > 0) {
    return parseCacheTtlHours(queryEnv, DEFAULT_QUERY_TTL_HOURS, 'KINLOOM_GNIS_QUERY_TTL_HOURS');
  }
  const cacheEnv = ctx.env.KINLOOM_GNIS_CACHE_TTL_HOURS;
  if (cacheEnv !== undefined && cacheEnv.trim().length > 0) {
    return parseCacheTtlHours(cacheEnv, DEFAULT_QUERY_TTL_HOURS, 'KINLOOM_GNIS_CACHE_TTL_HOURS');
  }
  return DEFAULT_QUERY_TTL_HOURS;
}

export function resolveSafeChild(root: string, filename: string): string {
  if (
    !filename ||
    filename.includes('\0') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes(':') ||
    filename === '.' ||
    filename === '..'
  ) {
    throw new Error(`Unsafe filename: '${filename}'`);
  }
  const rootResolved = path.resolve(root);
  const dest = path.resolve(rootResolved, filename);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
  if (dest === rootResolved || !dest.startsWith(prefix)) {
    throw new Error(`Unsafe path escaping root: '${filename}'`);
  }
  return dest;
}

function queryCachePath(
  canonicalParams: GnisQueryParams,
  cacheDir: string
): { readonly digest: string; readonly filePath: string } {
  const canonical = canonicalJsonStringify(canonicalParams);
  const digest = sha256Hex(canonical);
  const filePath = resolveSafeChild(path.join(cacheDir, '_queries'), `${digest}.json`);
  return { digest, filePath };
}

function readCachedSearch(
  canonicalParams: GnisQueryParams,
  cacheDir: string,
  ttlHours: number,
  nowMs: () => number
): GnisSearchPayload | undefined {
  const ttlSeconds = ttlHours * 3600;
  if (ttlSeconds <= 0) {
    return undefined;
  }
  const { filePath } = queryCachePath(canonicalParams, cacheDir);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    if (!fs.statSync(filePath).isFile()) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isPlainRecord(parsed)) {
      return undefined;
    }
    const cachedAt = parsed.cached_at;
    const data = parsed.data;
    if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || !isPlainRecord(data)) {
      return undefined;
    }
    if (!Array.isArray(data.results)) {
      return undefined;
    }
    if (nowMs() / 1000 - cachedAt <= ttlSeconds) {
      return data as unknown as GnisSearchPayload;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function stateZipUrl(state: string): string {
  return `${S3_BASE}/DomesticNames/DomesticNames_${state}_Text.zip`;
}

export function historicalZipUrl(): string {
  return `${S3_BASE}/Topical/HistoricalFeatures_National_Text.zip`;
}

async function downloadZip(ctx: RecordCommandContext, url: string): Promise<Buffer> {
  const res = await httpGetBytes(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: GNIS_USER_AGENT,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxAttempts: 2,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: GNIS_ALLOWED_HOSTS },
  });
  return res.bytes;
}

export function extractGnisTxt(zipBytes: Uint8Array): { readonly name: string; readonly text: string } {
  const entries = unzipEntries(zipBytes);
  const names = Object.keys(entries);
  const txtName = names.find((name) => name.toLowerCase().endsWith('.txt'));
  if (!txtName) {
    throw new RecordRuntimeError(`No .txt member in downloaded zip (members: ${names.join(', ')})`);
  }
  const raw = Buffer.from(entries[txtName]).toString('utf8');
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  return { name: txtName, text };
}

export function loadGnisRows(filePath: string): GnisRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const content = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0].length === 0)) {
    return [];
  }
  const header = lines[0].split('|').map((col) => col.trim());
  const rows: GnisRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    const fields = line.split('|');
    const row: GnisRow = {};
    for (let c = 0; c < header.length; c += 1) {
      row[header[c]] = fields[c] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

async function ensureStateFile(
  ctx: RecordCommandContext,
  rawState: string,
  refresh: boolean
): Promise<string> {
  const state = rawState.toUpperCase();
  if (!GNIS_STATE_CODES.has(state)) {
    throw new RecordRuntimeError(`Unknown state/territory code: ${state}`);
  }
  const cdir = getCacheDir(ctx);
  fs.mkdirSync(cdir, { recursive: true });
  const filePath = resolveSafeChild(cdir, `${state}.txt`);
  if (fs.existsSync(filePath) && !refresh) {
    return filePath;
  }
  const lockPath = resolveSafeChild(path.join(cdir, '_locks'), `state_${state}.lock`);
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (fs.existsSync(filePath) && !refresh) {
        return filePath;
      }
      ctx.io.stderr(`Downloading GNIS data for ${state} ...`);
      const zipBytes = await downloadZip(ctx, stateZipUrl(state));
      const { text } = extractGnisTxt(zipBytes);
      atomicWriteFileSync(filePath, text);
      const count = Math.max(0, text.split(/\r?\n/).filter((l) => l.length > 0).length - 1);
      ctx.io.stderr(`Cached ${filePath} (${count} features)`);
      return filePath;
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

async function ensureHistoricalFile(
  ctx: RecordCommandContext,
  refresh: boolean
): Promise<string> {
  const cdir = getCacheDir(ctx);
  fs.mkdirSync(cdir, { recursive: true });
  const filePath = resolveSafeChild(cdir, 'HistoricalFeatures.txt');
  if (fs.existsSync(filePath) && !refresh) {
    return filePath;
  }
  const lockPath = resolveSafeChild(path.join(cdir, '_locks'), 'historical.lock');
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (fs.existsSync(filePath) && !refresh) {
        return filePath;
      }
      ctx.io.stderr('Downloading national Historical Features file (large) ...');
      const zipBytes = await downloadZip(ctx, historicalZipUrl());
      const { text } = extractGnisTxt(zipBytes);
      atomicWriteFileSync(filePath, text);
      const count = Math.max(0, text.split(/\r?\n/).filter((l) => l.length > 0).length - 1);
      ctx.io.stderr(`Cached ${filePath} (${count} features)`);
      return filePath;
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

function compactFeature(row: GnisRow): GnisCompactFeature {
  return {
    feature_id: row.feature_id ?? null,
    feature_name: row.feature_name ?? null,
    feature_class: row.feature_class ?? null,
    state: row.state_name ?? null,
    county: row.county_name ?? null,
    map_name: row.map_name ?? null,
    latitude: row.prim_lat_dec ?? null,
    longitude: row.prim_long_dec ?? null,
    date_created: row.date_created ?? null,
    date_edited: row.date_edited ?? null,
  };
}

function matchRows(
  rows: readonly GnisRow[],
  name: string,
  exact: boolean,
  featureClass: string | undefined,
  county: string | undefined
): GnisRow[] {
  const needle = name.toLowerCase();
  const classLower = featureClass?.toLowerCase();
  const countyLower = county?.toLowerCase();
  const out: GnisRow[] = [];
  for (const row of rows) {
    const fname = (row.feature_name ?? '').toLowerCase();
    if (exact) {
      if (fname !== needle) {
        continue;
      }
    } else if (!fname.includes(needle)) {
      continue;
    }
    if (classLower && (row.feature_class ?? '').toLowerCase() !== classLower) {
      continue;
    }
    if (countyLower && !(row.county_name ?? '').toLowerCase().includes(countyLower)) {
      continue;
    }
    out.push(row);
  }
  return out;
}

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'force',
    kind: 'boolean',
    flags: ['--force', '--refresh'],
    help: 'Re-download even if cached.',
  },
];

const DOWNLOAD_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'state',
};

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'state',
    kind: 'string',
    flags: ['--state', '-s'],
    metavar: 'ST',
    help: 'State code to search (downloads and caches the state file if needed).',
  },
  {
    key: 'exact',
    kind: 'boolean',
    flags: ['--exact'],
    help: 'Match the full feature name, not a substring.',
  },
  {
    key: 'featureClass',
    kind: 'string',
    flags: ['--class'],
    metavar: 'CLASS',
    help: "Filter by feature class, e.g. 'Populated Place'.",
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    metavar: 'COUNTY',
    help: 'Filter by county name (substring).',
  },
  {
    key: 'historical',
    kind: 'boolean',
    flags: ['--historical'],
    help: 'Search the national Historical Features file instead of a state file (defunct places, post offices).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit', '-n'],
    min: 0,
    default: 20,
    help: 'Max matches to return (default: 20).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass cached query and state data and re-download fresh GNIS data.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Override query cache TTL in hours (default: 720 or $KINLOOM_GNIS_QUERY_TTL_HOURS).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of compact text.',
  },
];

const SEARCH_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'name',
};

const GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'state',
    kind: 'string',
    flags: ['--state', '-s'],
    metavar: 'ST',
    help: 'State code (downloads and caches if needed).',
  },
  {
    key: 'historical',
    kind: 'boolean',
    flags: ['--historical'],
    help: 'Look in the national Historical Features file.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Re-download the underlying GNIS file before lookup.',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON.',
  },
];

const GET_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'feature_id',
};

const URL_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'name',
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom gnis <command> [options]',
    summary: 'Search USGS GNIS geographic names (cached state downloads).',
    subcommands: [
      { name: 'download', summary: 'Download and cache the GNIS text file for a state (e.g. MI, CA, MO).' },
      { name: 'search', summary: 'Search feature names (substring unless --exact).' },
      { name: 'get', summary: 'Show one feature by its GNIS feature_id.' },
      { name: 'url', summary: 'Print the GNIS Domestic Names Search web app URL (open in a browser).' },
    ],
  });
}

async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom gnis download <STATE> [options]',
          summary: 'Download and cache the GNIS text file for a state (e.g. MI, CA, MO).',
          options: DOWNLOAD_OPTIONS,
        })
      ),
    };
  }
  const state = parsed.positionals[0].toUpperCase();
  const force = getBooleanOption(parsed, 'force');
  if (!GNIS_STATE_CODES.has(state)) {
    throw new RecordRuntimeError(`Unknown state/territory code: ${state}`);
  }
  const cdir = getCacheDir(ctx);
  const existingPath = resolveSafeChild(cdir, `${state}.txt`);
  if (fs.existsSync(existingPath) && !force) {
    const rows = loadGnisRows(existingPath);
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        `Already cached: ${existingPath} (${rows.length} features). Use --force or --refresh to re-download.`
      ),
      cacheHit: true,
    };
  }
  const savedPath = await ensureStateFile(ctx, state, force);
  const rows = loadGnisRows(savedPath);
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, `Cached ${savedPath} (${rows.length} features)`),
    cacheHit: false,
  };
}

async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom gnis search <NAME> [options]',
          summary: 'Search feature names (substring unless --exact).',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }

  const name = parsed.positionals[0];
  const stateArg = getStringOption(parsed, 'state');
  const exact = getBooleanOption(parsed, 'exact');
  const featureClass = getStringOption(parsed, 'featureClass');
  const county = getStringOption(parsed, 'county');
  const historical = getBooleanOption(parsed, 'historical');
  const limit = getNumberOption(parsed, 'limit') ?? 20;
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveQueryTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const asJson = getBooleanOption(parsed, 'asJson');

  let normalizedState: string | null = null;
  if (!historical) {
    if (!stateArg) {
      throw new CliValidationError('Give --state (e.g. --state CA) or --historical.');
    }
    normalizedState = stateArg.toUpperCase();
    if (!GNIS_STATE_CODES.has(normalizedState)) {
      throw new RecordRuntimeError(`Unknown state/territory code: ${normalizedState}`);
    }
  }

  const cdir = getCacheDir(ctx);
  const canonicalParams: GnisQueryParams = {
    name,
    state: historical ? null : normalizedState,
    exact,
    feature_class: featureClass ?? null,
    county: county ?? null,
    historical,
    limit,
  };

  let payload: GnisSearchPayload | undefined;
  let cacheHit = false;
  if (!refresh) {
    payload = readCachedSearch(canonicalParams, cdir, ttlHours, ctx.nowMs);
    cacheHit = payload !== undefined;
  }

  if (payload === undefined) {
    const { digest, filePath: cachePath } = queryCachePath(canonicalParams, cdir);
    const lockPath = resolveSafeChild(path.join(cdir, '_locks'), `query_${digest}.lock`);
    const computed = await withAdvisoryLock(
      lockPath,
      async () => {
        if (!refresh) {
          const hit = readCachedSearch(canonicalParams, cdir, ttlHours, ctx.nowMs);
          if (hit !== undefined) {
            return { payload: hit, cacheHit: true };
          }
        }
        let rows: GnisRow[];
        let source: string;
        if (historical) {
          const histPath = await ensureHistoricalFile(ctx, refresh);
          rows = loadGnisRows(histPath);
          source = 'HistoricalFeatures (national)';
        } else {
          const stateCode = normalizedState ?? '';
          const statePath = await ensureStateFile(ctx, stateCode, refresh);
          rows = loadGnisRows(statePath);
          source = `DomesticNames_${stateCode}`;
        }
        const matches = matchRows(rows, name, exact, featureClass, county).slice(0, limit);
        const freshPayload: GnisSearchPayload = {
          source,
          matches: matches.length,
          results: matches.map(compactFeature),
        };
        atomicWriteFileSync(
          cachePath,
          JSON.stringify({
            cached_at: ctx.nowMs() / 1000,
            params: canonicalParams,
            data: freshPayload,
          })
        );
        return { payload: freshPayload, cacheHit: false };
      },
      { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
    );
    payload = computed.payload;
    cacheHit = computed.cacheHit;
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...payload, cache_hit: cacheHit }),
      cacheHit,
    };
  }

  const lines: string[] = [`source: ${payload.source} | matches shown: ${payload.matches}`];
  for (const c of payload.results) {
    lines.push(
      `- ${c.feature_id ?? ''} | ${c.feature_name ?? ''} (${c.feature_class ?? ''}) | ${c.county ?? ''} County, ${c.state ?? ''} | ${c.latitude ?? ''}, ${c.longitude ?? ''} | map: ${c.map_name ?? ''}`
    );
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit,
  };
}

async function runGet(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom gnis get <FEATURE_ID> [options]',
          summary: 'Show one feature by its GNIS feature_id.',
          options: GET_OPTIONS,
        })
      ),
    };
  }

  const featureId = parsed.positionals[0];
  const stateArg = getStringOption(parsed, 'state');
  const historical = getBooleanOption(parsed, 'historical');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const cdir = getCacheDir(ctx);
  let alreadyCached: boolean;
  let rows: GnisRow[];

  if (historical) {
    const dataPath = resolveSafeChild(cdir, 'HistoricalFeatures.txt');
    alreadyCached = fs.existsSync(dataPath) && fs.statSync(dataPath).isFile() && !refresh;
    rows = loadGnisRows(await ensureHistoricalFile(ctx, refresh));
  } else {
    if (!stateArg) {
      throw new CliValidationError('Give --state or --historical.');
    }
    const state = stateArg.toUpperCase();
    if (!GNIS_STATE_CODES.has(state)) {
      throw new RecordRuntimeError(`Unknown state/territory code: ${state}`);
    }
    const dataPath = resolveSafeChild(cdir, `${state}.txt`);
    alreadyCached = fs.existsSync(dataPath) && fs.statSync(dataPath).isFile() && !refresh;
    rows = loadGnisRows(await ensureStateFile(ctx, state, refresh));
  }

  for (const row of rows) {
    if ((row.feature_id ?? '') === featureId) {
      if (asJson) {
        return {
          exitCode: 0,
          bytesOut: emitJsonStdout(ctx.io, { ...row, cache_hit: alreadyCached }),
          cacheHit: alreadyCached,
        };
      }
      const lines: string[] = [];
      for (const [key, value] of Object.entries(row)) {
        if (value !== '') {
          lines.push(`${key}: ${value}`);
        }
      }
      return {
        exitCode: 0,
        bytesOut: emitStdout(ctx.io, lines.join('\n')),
        cacheHit: alreadyCached,
      };
    }
  }

  ctx.io.stderr(`Feature ${featureId} not found in the searched file.`);
  return { exitCode: 1, bytesOut: 0, cacheHit: alreadyCached };
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom gnis url [NAME]',
          summary: 'Print the GNIS Domestic Names Search web app URL (open in a browser).',
        })
      ),
    };
  }
  const name = parsed.positionals[0];
  const lines = [SEARCH_APP];
  if (name) {
    lines.push(
      `(Enter '${name}' in the Feature Name field; the app has no stable query-string search URL.)`
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

export const runGnisCommand: RecordHandler = async (
  args,
  ctx
): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'download':
        return await runDownload(rest, ctx);
      case 'search':
        return await runSearch(rest, ctx);
      case 'get':
        return await runGet(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(
          `No such command '${subcmd}'. Run 'kinloom gnis --script-help'.`
        );
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof RecordRuntimeError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: err.exitCode, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
