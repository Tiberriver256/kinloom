import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  cachedJsonCall,
  collapseWhitespace,
  CookieJar,
  emitJsonStdout,
  emitStdout,
  expandHomePath,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpGetBytes,
  httpRequest,
  loadHtml,
  parseCacheTtlHours,
  parseCommandArgs,
  resolveCacheDir,
  type CommandParseSpec,
  type OptionSpec,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const BASE = 'https://s1.sos.mo.gov';
const DEATH_PAGE = `${BASE}/records/Archives/ArchivesMvc/DeathCertificates/`;
const DEATH_POST = `${BASE}/Records/Archives/ArchivesMvc/`;
const DEATH_RESULTS = `${BASE}/Records/Archives/ArchivesMvc/DeathCertificates/Results`;
const PRE1910_PAGE = `${BASE}/records/archives/ArchivesMVC/birthdeath/`;
const PRE1910_POST = `${BASE}/Records/Archives/ArchivesMvc/BirthDeath`;
const PRE1910_RESULTS = `${BASE}/Records/Archives/ArchivesMvc/birthdeath/Results`;
const PRE1910_DETAIL = `${BASE}/records/archives/ArchivesMVC/birthdeath/Detail`;
const MDH_HOME = 'https://www.sos.mo.gov/mdh';
const MDH_SEARCH = 'https://mdh.deepwebaccess.com/mdh/';
const ARCHIVES_HOME = 'https://www.sos.mo.gov/archives';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ALLOWED_HOSTS = ['s1.sos.mo.gov', 'www.sos.mo.gov'] as const;

const ALL_COUNTIES = '-- Search All --';
const ALL_COUNTIES_PRE1910 = '-- All Counties --';
const MATCH_METHODS: Readonly<Record<string, string>> = {
  contains: 'Contains',
  'starts-with': 'StartsWith',
  'ends-with': 'EndsWith',
};

const ROLE_CHOICES = ['deceased', 'spouse', 'father', 'mother'] as const;
const MATCH_CHOICES = ['contains', 'starts-with', 'ends-with'] as const;
const PRE1910_TYPE_CHOICES = ['birth', 'death'] as const;

interface ParsedCell {
  readonly text: string;
  readonly hrefs: readonly string[];
}

export interface DeathRecord {
  readonly name: string;
  readonly deceased?: string;
  readonly spouse?: string;
  readonly father?: string;
  readonly mother?: string;
  readonly age: string;
  readonly date_of_death: string;
  readonly county: string;
  readonly cert: string;
  readonly ssn4: string;
  readonly image: string;
}

export interface Pre1910DeathRecord {
  readonly name: string;
  readonly age: string;
  readonly sex: string;
  readonly color: string;
  readonly date_of_death: string;
  readonly county: string;
  readonly detail_id: string;
  readonly detail_url: string;
}

export interface Pre1910BirthRecord {
  readonly name: string;
  readonly place: string;
  readonly county: string;
  readonly date_of_birth: string;
  readonly father: string;
  readonly mother: string;
  readonly attendant: string;
  readonly detail_id: string;
  readonly detail_url: string;
}

type Pre1910Record = Pre1910DeathRecord | Pre1910BirthRecord;

interface SearchCachePayload<T> {
  readonly total: number;
  readonly results: readonly T[];
  readonly verified: boolean;
}

interface DetailRecord {
  readonly id: string;
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_MO_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-mo-archives',
  });
}

function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_MO_ARCHIVES_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_MO_ARCHIVES_CACHE_TTL_HOURS'
  );
}

function parseTables(html: string): ParsedCell[][][] {
  const $ = loadHtml(html);
  const tables: ParsedCell[][][] = [];
  $('table').each((_tIdx, tableEl) => {
    const rows: ParsedCell[][] = [];
    $(tableEl)
      .find('tr')
      .each((_rIdx, trEl) => {
        const row: ParsedCell[] = [];
        $(trEl)
          .find('td, th')
          .each((_cIdx, cellEl) => {
            const cell = $(cellEl);
            const hrefs: string[] = [];
            cell.find('a[href]').each((_aIdx, aEl) => {
              const href = $(aEl).attr('href');
              if (href) {
                hrefs.push(href);
              }
            });
            const clone = cell.clone();
            clone.find('br, li, p, div').before(' ');
            row.push({ text: collapseWhitespace(clone.text()), hrefs });
          });
        if (row.length > 0) {
          rows.push(row);
        }
      });
    tables.push(rows);
  });
  return tables;
}

function findResultsTable(
  html: string,
  headerMarkers: readonly string[]
): readonly [readonly string[] | null, readonly (readonly ParsedCell[])[]] {
  for (const table of parseTables(html)) {
    if (table.length === 0) {
      continue;
    }
    const header = table[0].map((c) => c.text);
    const joined = header.join(' ');
    if (headerMarkers.some((m) => joined.includes(m))) {
      return [header, table.slice(1)];
    }
  }
  return [null, []];
}

function totalResults(html: string): number | null {
  const match = /Showing records \d+ to \d+ of (\d+)/.exec(html);
  return match ? Number.parseInt(match[1], 10) : null;
}

function extractFormToken(html: string): string | null {
  const $ = loadHtml(html);
  const inputVal = $('input[name="__ncforminfo"]').attr('value');
  if (inputVal) {
    return inputVal;
  }
  const match = /name="__ncforminfo"\s+value="([^"]+)"/.exec(html);
  return match ? match[1] : null;
}

async function postSearch(
  ctx: RecordCommandContext,
  jar: CookieJar,
  pageUrl: string,
  postUrl: string,
  data: Readonly<Record<string, string>>
): Promise<string> {
  const pageRes = await httpRequest(pageUrl, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    cookieJar: jar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  const pageHtml = pageRes.bytes.toString('utf8');
  const token = extractFormToken(pageHtml);
  const payload: Record<string, string> = { ...data };
  if (token) {
    payload.__ncforminfo = token;
  }
  const postRes = await httpRequest(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    cookieJar: jar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  return postRes.bytes.toString('utf8');
}

export function parseDeathName(text: string): {
  name: string;
  deceased?: string;
  spouse?: string;
  father?: string;
  mother?: string;
} {
  const cleaned = collapseWhitespace(text);
  const parts = cleaned.split(/\s+-\s+(Deceased|Spouse|Father|Mother)\s*/);
  const roles: Partial<Record<'deceased' | 'spouse' | 'father' | 'mother', string>> = {};
  for (let i = 1; i < parts.length; i += 2) {
    const person = collapseWhitespace(parts[i - 1] ?? '');
    const role = (parts[i] ?? '').toLowerCase();
    if (
      person &&
      (role === 'deceased' || role === 'spouse' || role === 'father' || role === 'mother')
    ) {
      roles[role] = person;
    }
  }
  const name = roles.deceased ?? collapseWhitespace(parts[0] ?? '');
  return { ...roles, name };
}

export function parseDeathRows(html: string): DeathRecord[] {
  const [, rows] = findResultsTable(html, ['Date of Death']);
  const out: DeathRecord[] = [];
  for (const row of rows) {
    const cells = row.map((c) => c.text);
    if (cells.length < 5 || !cells[0]) {
      continue;
    }
    const nameInfo = parseDeathName(cells[0]);
    const imgHref = row.length > 6 && row[6].hrefs.length > 0 ? row[6].hrefs[0] : '';
    out.push({
      ...nameInfo,
      age: cells[1] ?? '',
      date_of_death: cells[2] ?? '',
      county: cells[3] ?? '',
      cert: cells[4] ?? '',
      ssn4: cells[5] ?? '',
      image: imgHref ? new URL(imgHref, BASE).toString() : '',
    });
  }
  return out;
}

export function parsePre1910Rows(html: string, kind: 'birth' | 'death'): Pre1910Record[] {
  const [, rows] = findResultsTable(
    html,
    kind === 'death' ? ['Date Of Death'] : ['Date Of Birth']
  );
  const out: Pre1910Record[] = [];
  for (const row of rows) {
    const cells = row.map((c) => c.text);
    if (cells.length === 0 || !cells[0]) {
      continue;
    }
    const lastCell = row.at(-1);
    const detailHref = lastCell && lastCell.hrefs.length > 0 ? lastCell.hrefs[0] : '';
    const idMatch = /id=(\d+)/.exec(detailHref);
    const detailId = idMatch ? idMatch[1] : '';
    const detailUrl = detailHref ? new URL(detailHref, PRE1910_PAGE).toString() : '';

    if (kind === 'death') {
      out.push({
        name: cells[0],
        age: cells[1] ?? '',
        sex: cells[2] ?? '',
        color: cells[3] ?? '',
        date_of_death: cells[4] ?? '',
        county: cells[5] ?? '',
        detail_id: detailId,
        detail_url: detailUrl,
      });
    } else {
      out.push({
        name: cells[0],
        place: cells[1] ?? '',
        county: cells[2] ?? '',
        date_of_birth: cells[3] ?? '',
        father: cells[4] ?? '',
        mother: cells[5] ?? '',
        attendant: cells[6] ?? '',
        detail_id: detailId,
        detail_url: detailUrl,
      });
    }
  }
  return out;
}

async function fetchPages<T>(
  ctx: RecordCommandContext,
  jar: CookieJar,
  firstHtml: string,
  resultsUrl: string,
  parse: (html: string) => T[],
  limit: number
): Promise<SearchCachePayload<T>> {
  const rawTotal = totalResults(firstHtml);
  const records = parse(firstHtml);
  const total = rawTotal !== null ? rawTotal : records.length;
  let page = 2;
  while (records.length < Math.min(limit, total)) {
    const pagedUrl = `${resultsUrl}?PageNumber=${page}&recordsPerPage=50`;
    const res = await httpRequest(pagedUrl, {
      method: 'GET',
      userAgent: USER_AGENT,
      timeoutMs: 60_000,
      maxAttempts: 1,
      cookieJar: jar,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
    });
    const more = parse(res.bytes.toString('utf8'));
    if (more.length === 0) {
      break;
    }
    records.push(...more);
    page += 1;
  }
  const verified = records.length > 0 || rawTotal !== null;
  return { total, results: records.slice(0, limit), verified };
}

export function parseDetailFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const notes: string[] = [];
  for (const table of parseTables(html)) {
    const rows = table.map((r) => r.map((c) => c.text));
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      if (row.length === 1) {
        if (row[0] && row[0] !== 'NOTE') {
          notes.push(row[0]);
        }
        i += 1;
        continue;
      }
      if (i + 1 < rows.length && rows[i + 1].length === row.length) {
        for (let col = 0; col < row.length; col += 1) {
          const key = row[col];
          if (key) {
            fields[key] = rows[i + 1][col] ?? '';
          }
        }
        i += 2;
      } else {
        i += 1;
      }
    }
  }
  if (notes.length > 0) {
    fields.notes = notes.join('; ');
  }
  return fields;
}

function safePdfFilename(rawUrl: string): string {
  try {
    const pathname = new URL(rawUrl).pathname;
    const base = path.posix.basename(pathname);
    const sanitized = base.replace(/[^A-Za-z0-9._-]+/g, '_');
    return sanitized || 'certificate.pdf';
  } catch {
    return 'certificate.pdf';
  }
}

async function downloadPdf(
  ctx: RecordCommandContext,
  url: string,
  dest: string,
  overwrite: boolean
): Promise<{ readonly dest: string; readonly skipped: boolean; readonly size: number }> {
  if (fs.existsSync(dest) && !overwrite) {
    return { dest, skipped: true, size: fs.statSync(dest).size };
  }
  const res = await httpGetBytes(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    rejectHtml: true,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  atomicWriteFileSync(dest, res.bytes);
  return { dest, skipped: false, size: res.bytes.length };
}

async function searchDeath(
  ctx: RecordCommandContext,
  data: Readonly<Record<string, string>>,
  limit: number
): Promise<SearchCachePayload<DeathRecord>> {
  const jar = new CookieJar();
  const firstHtml = await postSearch(ctx, jar, DEATH_PAGE, DEATH_POST, data);
  return fetchPages(ctx, jar, firstHtml, DEATH_RESULTS, parseDeathRows, limit);
}

async function searchPre1910(
  ctx: RecordCommandContext,
  kind: 'birth' | 'death',
  data: Readonly<Record<string, string>>,
  limit: number
): Promise<SearchCachePayload<Pre1910Record>> {
  const jar = new CookieJar();
  const firstHtml = await postSearch(ctx, jar, PRE1910_PAGE, PRE1910_POST, data);
  return fetchPages(ctx, jar, firstHtml, PRE1910_RESULTS, (h) => parsePre1910Rows(h, kind), limit);
}

async function fetchDetail(ctx: RecordCommandContext, cleanId: string): Promise<DetailRecord> {
  const url = `${PRE1910_DETAIL}?id=${cleanId}`;
  const res = await httpRequest(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  return {
    id: cleanId,
    url,
    fields: parseDetailFields(res.bytes.toString('utf8')),
  };
}

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_MO_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const DEATH_OPTIONS: readonly OptionSpec[] = [
  { key: 'last', kind: 'string', flags: ['--last'], required: true, help: 'Last name (surname).' },
  { key: 'first', kind: 'string', flags: ['--first'], default: '', help: 'First name.' },
  { key: 'middle', kind: 'string', flags: ['--middle'], default: '', help: 'Middle name.' },
  {
    key: 'role',
    kind: 'string',
    flags: ['--role'],
    choices: ROLE_CHOICES,
    default: 'deceased',
    help: 'Whose name to search. Spouse/father/mother only for 1953-1975.',
  },
  {
    key: 'match',
    kind: 'string',
    flags: ['--match'],
    choices: MATCH_CHOICES,
    default: 'contains',
    help: 'Name match type, applied to every name field given.',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: '',
    help: 'County as spelled on the site; default all counties.',
  },
  { key: 'beginYear', kind: 'integer', flags: ['--begin-year'], default: 1910 },
  { key: 'endYear', kind: 'integer', flags: ['--end-year'], default: 1975 },
  {
    key: 'beginMonth',
    kind: 'integer',
    flags: ['--begin-month'],
    default: 0,
    help: '1-12, 0 = all months.',
  },
  {
    key: 'endMonth',
    kind: 'integer',
    flags: ['--end-month'],
    default: 0,
    help: '1-12, 0 = all months.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 50,
    help: 'Max records (50 per page).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  {
    key: 'downloadDir',
    kind: 'string',
    flags: ['--download'],
    metavar: 'DIR',
    help: "Download each result's certificate PDF into DIR.",
  },
  ...CACHE_OPTIONS,
];

const PRE1910_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'kind',
    kind: 'string',
    flags: ['--type'],
    choices: PRE1910_TYPE_CHOICES,
    default: 'death',
    help: 'Record type in the pre-1910 database.',
  },
  {
    key: 'name',
    kind: 'string',
    flags: ['--name'],
    required: true,
    help: 'All or part of a name; the site recommends last name only.',
  },
  {
    key: 'county',
    kind: 'string',
    flags: ['--county'],
    default: '',
    help: 'County as spelled on the site; default all counties.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 50,
    help: 'Max records (50 per page).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...CACHE_OPTIONS,
];

const DETAIL_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...CACHE_OPTIONS,
];

const DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'outDir',
    kind: 'string',
    flags: ['--out'],
    default: 'mo-death-certs',
    help: 'Output directory.',
  },
  {
    key: 'overwrite',
    kind: 'boolean',
    flags: ['--overwrite'],
    help: 'Re-download files that already exist.',
  },
];

const DEATH_SPEC: CommandParseSpec = { options: DEATH_OPTIONS, allowPositionals: false };
const PRE1910_SPEC: CommandParseSpec = { options: PRE1910_OPTIONS, allowPositionals: false };
const DETAIL_SPEC: CommandParseSpec = {
  options: DETAIL_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'id',
};
const DOWNLOAD_SPEC: CommandParseSpec = {
  options: DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'url',
};

function isSearchCachePayload<T>(value: unknown): value is SearchCachePayload<T> {
  return (
    isPlainRecord(value) &&
    typeof value.total === 'number' &&
    Array.isArray(value.results)
  );
}

function isDetailRecord(value: unknown): value is DetailRecord {
  return (
    isPlainRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.url === 'string' &&
    isPlainRecord(value.fields)
  );
}

function resolveDirPath(raw: string, ctx: RecordCommandContext): string {
  const expanded = expandHomePath(raw, ctx.env);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(ctx.cwd, expanded);
}

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom mo-archives <command> [options]',
    summary: 'Search Missouri State Archives vital records (no key, no login).',
    subcommands: [
      { name: 'death', summary: 'Search Missouri Death Certificates, 1910-1975 (with images).' },
      {
        name: 'pre1910',
        summary: 'Search the pre-1910 Birth and Death Records Database (abstracts).',
      },
      { name: 'detail', summary: 'Fetch full abstracts for pre-1910 record IDs (from `pre1910`).' },
      { name: 'download', summary: 'Download death-certificate PDFs by image URL (from `death`).' },
      {
        name: 'mdh',
        summary: 'Show the Missouri Digital Heritage browser path (no machine interface).',
      },
    ],
  });
}

export const runMoArchivesCommand: RecordHandler = async (
  args,
  ctx
): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;

    switch (subcmd) {
      case 'death': {
        const parsed = parseCommandArgs(rest, DEATH_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom mo-archives death --last <SURNAME> [options]',
                summary: 'Search Missouri Death Certificates, 1910-1975 (with images).',
                options: DEATH_OPTIONS,
              })
            ),
          };
        }
        const last = getStringOption(parsed, 'last') ?? '';
        const first = getStringOption(parsed, 'first') ?? '';
        const middle = getStringOption(parsed, 'middle') ?? '';
        const role = getStringOption(parsed, 'role') ?? 'deceased';
        const match = getStringOption(parsed, 'match') ?? 'contains';
        const county = getStringOption(parsed, 'county') ?? '';
        const beginYear = getNumberOption(parsed, 'beginYear') ?? 1910;
        const endYear = getNumberOption(parsed, 'endYear') ?? 1975;
        const beginMonth = getNumberOption(parsed, 'beginMonth') ?? 0;
        const endMonth = getNumberOption(parsed, 'endMonth') ?? 0;
        const limit = getNumberOption(parsed, 'limit') ?? 50;
        const asJson = getBooleanOption(parsed, 'asJson');
        const downloadDirRaw = getStringOption(parsed, 'downloadDir');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        if (!(1910 <= beginYear && beginYear <= endYear && endYear <= 1975)) {
          throw new CliValidationError('year range must sit inside 1910-1975.');
        }
        if (beginMonth < 0 || beginMonth > 12 || endMonth < 0 || endMonth > 12) {
          throw new CliValidationError('months must be 0-12 (0 = all).');
        }
        if (limit < 1) {
          throw new CliValidationError('--limit must be at least 1.');
        }

        const method = MATCH_METHODS[match] ?? 'Contains';
        const roleCap = role.charAt(0).toUpperCase() + role.slice(1);
        const formData: Record<string, string> = {
          DeathCertNameSearchType: roleCap,
          LastName: last,
          LNSearchMethod: method,
          FirstName: first,
          FNSearchMethod: method,
          MiddleName: middle,
          MNSearchMethod: method,
          BeginMonth: String(beginMonth),
          BeginYear: String(beginYear),
          EndMonth: String(endMonth),
          EndYear: String(endYear),
          CountyName: county || ALL_COUNTIES,
          Search: 'Search',
        };
        const cachePayload = {
          last,
          first,
          middle,
          role,
          match,
          county,
          begin_year: beginYear,
          end_year: endYear,
          begin_month: beginMonth,
          end_month: endMonth,
          limit,
        };

        const { value: result, cacheHit } = await cachedJsonCall<SearchCachePayload<DeathRecord>>({
          cacheDir: getCacheDir(ctx),
          kind: 'death',
          payload: cachePayload,
          ttlHours,
          refresh,
          fetch: () => searchDeath(ctx, formData, limit),
          cacheable: (r) => Boolean(r.verified),
          validateCached: isSearchCachePayload<DeathRecord>,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });

        let bytesOut = 0;
        if (downloadDirRaw) {
          const dlDir = resolveDirPath(downloadDirRaw, ctx);
          fs.mkdirSync(dlDir, { recursive: true });
          const dlLines: string[] = [];
          for (const rec of result.results) {
            if (!rec.image) continue;
            const fname = safePdfFilename(rec.image);
            const info = await downloadPdf(ctx, rec.image, path.join(dlDir, fname), false);
            dlLines.push(
              `${info.skipped ? 'Exists (skip)' : 'Downloaded'}: ${info.dest} (${info.size.toLocaleString('en-US')} bytes)`
            );
          }
          if (dlLines.length > 0) {
            bytesOut += emitStdout(ctx.io, dlLines.join('\n'));
          }
        }

        if (asJson) {
          bytesOut += emitJsonStdout(ctx.io, {
            total: result.total,
            results: result.results,
            cache_hit: cacheHit,
          });
          return { exitCode: 0, bytesOut, cacheHit };
        }
        const marker = cacheHit ? ' [cache]' : '';
        const lines: string[] = [
          `Total: ${result.total} | showing ${result.results.length}${marker}`,
        ];
        for (const rec of result.results) {
          const parts: string[] = [rec.name];
          if (rec.age) parts.push(`age ${rec.age}`);
          if (rec.date_of_death) parts.push(rec.date_of_death);
          if (rec.county) parts.push(rec.county);
          if (rec.cert) parts.push(`cert ${rec.cert}`);
          if (rec.image) parts.push(rec.image);
          lines.push(parts.filter(Boolean).join(' | '));
        }
        bytesOut += emitStdout(ctx.io, lines.join('\n'));
        return { exitCode: 0, bytesOut, cacheHit };
      }

      case 'pre1910': {
        const parsed = parseCommandArgs(rest, PRE1910_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom mo-archives pre1910 --name <NAME> [options]',
                summary: 'Search the pre-1910 Birth and Death Records Database (abstracts).',
                options: PRE1910_OPTIONS,
              })
            ),
          };
        }
        const kind = (getStringOption(parsed, 'kind') ?? 'death') as 'birth' | 'death';
        const name = getStringOption(parsed, 'name') ?? '';
        const county = getStringOption(parsed, 'county') ?? '';
        const limit = getNumberOption(parsed, 'limit') ?? 50;
        const asJson = getBooleanOption(parsed, 'asJson');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        if (limit < 1) {
          throw new CliValidationError('--limit must be at least 1.');
        }

        const formData: Record<string, string> =
          kind === 'death'
            ? {
                DeathCounty: county || ALL_COUNTIES_PRE1910,
                DeathNameSearch: name,
                DeathSubmit: 'Search',
              }
            : {
                BirthCounty: county || ALL_COUNTIES_PRE1910,
                BirthNameSearch: name,
                BirthSubmit: 'Search',
              };

        const { value: result, cacheHit } = await cachedJsonCall<
          SearchCachePayload<Pre1910Record>
        >({
          cacheDir: getCacheDir(ctx),
          kind: 'pre1910',
          payload: { kind, name, county, limit },
          ttlHours,
          refresh,
          fetch: () => searchPre1910(ctx, kind, formData, limit),
          cacheable: (r) => Boolean(r.verified),
          validateCached: isSearchCachePayload<Pre1910Record>,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });

        if (asJson) {
          return {
            exitCode: 0,
            bytesOut: emitJsonStdout(ctx.io, {
              total: result.total,
              results: result.results,
              cache_hit: cacheHit,
            }),
            cacheHit,
          };
        }
        const marker = cacheHit ? ' [cache]' : '';
        const lines: string[] = [
          `Total: ${result.total} | showing ${result.results.length}${marker}`,
        ];
        for (const rec of result.results) {
          if ('date_of_death' in rec) {
            const parts = [
              rec.name,
              rec.age ? `age ${rec.age}` : '',
              rec.sex,
              rec.color,
              rec.date_of_death,
              rec.county,
              rec.detail_id ? `detail ${rec.detail_id}` : '',
            ].filter(Boolean);
            lines.push(parts.join(' | '));
          } else {
            const parts = [
              rec.name,
              rec.place,
              rec.county,
              rec.date_of_birth,
              rec.father ? `father ${rec.father}` : '',
              rec.mother ? `mother ${rec.mother}` : '',
              rec.detail_id ? `detail ${rec.detail_id}` : '',
            ].filter(Boolean);
            lines.push(parts.join(' | '));
          }
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
      }

      case 'detail': {
        const parsed = parseCommandArgs(rest, DETAIL_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom mo-archives detail <ID>... [options]',
                summary: 'Fetch full abstracts for pre-1910 record IDs (from `pre1910`).',
                options: DETAIL_OPTIONS,
              })
            ),
          };
        }
        const asJson = getBooleanOption(parsed, 'asJson');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        const records: (DetailRecord & { readonly cache_hit: boolean })[] = [];
        for (const rid of parsed.positionals) {
          const clean = rid.replace(/\D+/g, '');
          if (!clean) {
            throw new CliValidationError(`Invalid detail ID: '${rid}'`);
          }
          const { value: rec, cacheHit } = await cachedJsonCall<DetailRecord>({
            cacheDir: getCacheDir(ctx),
            kind: 'detail',
            payload: { id: clean },
            ttlHours,
            refresh,
            fetch: () => fetchDetail(ctx, clean),
            cacheable: (r) => Object.keys(r.fields).length > 0,
            validateCached: isDetailRecord,
            nowMs: ctx.nowMs,
            sleepFn: ctx.sleepFn,
          });
          records.push({ ...rec, cache_hit: cacheHit });
        }

        const allCached = records.length > 0 && records.every((r) => r.cache_hit);
        if (asJson) {
          const payload = records.length === 1 ? records[0] : records;
          return {
            exitCode: 0,
            bytesOut: emitJsonStdout(ctx.io, payload),
            cacheHit: allCached,
          };
        }
        const blocks: string[] = [];
        for (const rec of records) {
          const marker = rec.cache_hit ? ' [cache]' : '';
          const lines: string[] = [`Detail ${rec.id}: ${rec.url}${marker}`];
          for (const [key, val] of Object.entries(rec.fields)) {
            lines.push(`  ${key}: ${val}`);
          }
          blocks.push(lines.join('\n'));
        }
        return {
          exitCode: 0,
          bytesOut: emitStdout(ctx.io, blocks.join('\n\n')),
          cacheHit: allCached,
        };
      }

      case 'download': {
        const parsed = parseCommandArgs(rest, DOWNLOAD_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom mo-archives download <URL>... [options]',
                summary: 'Download death-certificate PDFs by image URL (from `death`).',
                options: DOWNLOAD_OPTIONS,
              })
            ),
          };
        }
        const outDirRaw = getStringOption(parsed, 'outDir') ?? 'mo-death-certs';
        const overwrite = getBooleanOption(parsed, 'overwrite');
        const outDir = resolveDirPath(outDirRaw, ctx);
        fs.mkdirSync(outDir, { recursive: true });
        const lines: string[] = [];
        for (const url of parsed.positionals) {
          const fname = safePdfFilename(url);
          const info = await downloadPdf(ctx, url, path.join(outDir, fname), overwrite);
          lines.push(
            `${info.skipped ? 'Exists (skip)' : 'Downloaded'}: ${info.dest} (${info.size.toLocaleString('en-US')} bytes)`
          );
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
      }

      case 'mdh': {
        if (rest.includes('--help') || rest.includes('-h')) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom mo-archives mdh',
                summary:
                  'Show the Missouri Digital Heritage browser path (no machine interface).',
              })
            ),
          };
        }
        const text = [
          'Missouri Digital Heritage has no verified machine interface.',
          `  Home: ${MDH_HOME}`,
          `  Advanced Search (browser): ${MDH_SEARCH}`,
          `  Missouri State Archives: ${ARCHIVES_HOME}`,
          '  CONTENTdm dmwebservices returns 403 (Cloudflare) to automated requests,',
          '  and no GET search URL for the Advanced Search was verified.',
          '  Use the browser for MDH collections (soldiers, land patents,',
          '  naturalization, newspapers, plat books). The two vital-records',
          '  databases are covered by this CLI: `death` and `pre1910`.',
        ].join('\n');
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
      }

      default:
        throw new CliValidationError(
          `No such command '${subcmd}'. Run 'kinloom mo-archives --script-help'.`
        );
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
