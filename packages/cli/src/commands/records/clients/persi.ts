import { CliValidationError } from '../../../errors.js';
import {
  cachedJsonCall,
  collapseWhitespace,
  emitJsonStdout,
  emitStdout,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpRequest,
  loadHtml,
  parseCacheTtlHours,
  parseCommandArgs,
  RecordRuntimeError,
  resolveCacheDir,
  type CommandParseSpec,
  type OptionSpec,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const BASE = 'https://www.genealogycenter.info';
const SURNAME_URL = `${BASE}/results_persisurname.php`;
const TITLE_URL = `${BASE}/results_persiarttitle.php`;
const LOCATION_URL = `${BASE}/results_persilocation.php`;
const PERSI_USER_AGENT = 'Mozilla/5.0';
const PERSI_ALLOWED_HOSTS = ['www.genealogycenter.info', 'genealogycenter.info'] as const;
const RETRY_WAIT_MS = 5000;

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY', 'GEN',
]);

export interface PersiArticle {
  readonly title: string;
  readonly periodical: string;
  readonly year: string;
  readonly publisher: string;
  readonly free_link: string | null;
}

export interface PersiCategory {
  readonly category: string;
  readonly articles: number;
}

interface ParsedPersiTableRow {
  readonly cells: readonly string[];
  readonly links: readonly (readonly string[])[];
}

function parsePersiTableRows(html: string): ParsedPersiTableRow[] {
  const $ = loadHtml(html);
  const rows: ParsedPersiTableRow[] = [];
  $('table tr').each((_rowIdx, trEl) => {
    const cells: string[] = [];
    const links: string[][] = [];
    $(trEl)
      .find('td, th')
      .each((_cellIdx, cellEl) => {
        cells.push(collapseWhitespace($(cellEl).text()));
        const cellLinks: string[] = [];
        $(cellEl)
          .find('a[href]')
          .each((_aIdx, aEl) => {
            const href = $(aEl).attr('href');
            if (href) {
              cellLinks.push(href);
            }
          });
        links.push(cellLinks);
      });
    if (cells.length > 0) {
      rows.push({ cells, links });
    }
  });
  return rows;
}

export function parsePersiArticles(page: string): PersiArticle[] {
  const articles: PersiArticle[] = [];
  for (const row of parsePersiTableRows(page)) {
    const { cells, links } = row;
    if (cells.length < 3) {
      continue;
    }
    if (cells[0].toLowerCase().startsWith('article title')) {
      continue;
    }
    const freeLinks = links.flat().filter((link) => link.startsWith('http'));
    articles.push({
      title: cells[0],
      periodical: cells[1] ?? '',
      year: cells[2] ?? '',
      publisher: cells[3] ?? '',
      free_link: freeLinks[0] ?? null,
    });
  }
  return articles;
}

export function parsePersiCategories(page: string): PersiCategory[] {
  const categories: PersiCategory[] = [];
  for (const row of parsePersiTableRows(page)) {
    const { cells } = row;
    if (cells.length === 2 && /^\d+$/.test(cells[1].replace(/,/g, ''))) {
      if (cells[0].toLowerCase().startsWith('category')) {
        continue;
      }
      categories.push({
        category: cells[0],
        articles: Number.parseInt(cells[1].replace(/,/g, ''), 10),
      });
    }
  }
  return categories;
}

async function fetchPersiForm(
  ctx: RecordCommandContext,
  url: string,
  formData: Readonly<Record<string, string>>,
  referer: string
): Promise<string> {
  const body = new URLSearchParams(formData).toString();
  const headers: Record<string, string> = {
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Referer: referer,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await httpRequest(url, {
        method: 'POST',
        headers,
        body,
        userAgent: PERSI_USER_AGENT,
        timeoutMs: 60_000,
        maxAttempts: 1,
        throwOnHttpError: false,
        urlPolicy: { allowedSchemes: ['https:'], allowedHosts: PERSI_ALLOWED_HOSTS },
        fetchImpl: ctx.fetchImpl,
        sleepFn: ctx.sleepFn,
        nowMs: ctx.nowMs,
      });
      if ((res.status === 412 || res.status === 429) && attempt === 1) {
        await ctx.sleepFn(RETRY_WAIT_MS);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new RecordRuntimeError(`HTTP ${res.status} fetching ${url}`);
      }
      return res.bytes.toString('utf8');
    } catch (err: unknown) {
      lastErr = err;
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new RecordRuntimeError(`PERSI request failed: ${message}`);
}

function emitPersiItems(
  ctx: RecordCommandContext,
  items: readonly (PersiArticle | PersiCategory)[],
  asJson: boolean,
  limit: number,
  cacheHit: boolean
): RecordCommandOutcome {
  const sliced = items.slice(0, limit);
  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, sliced),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  if (sliced.length === 0) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(ctx.io, `No results.${marker}`),
      cacheHit,
    };
  }
  const lines: string[] = [];
  for (const item of sliced) {
    if ('articles' in item) {
      lines.push(`${String(item.articles).padStart(6)}  ${item.category}`);
    } else {
      lines.push(`${item.title} | ${item.periodical} | ${item.year} | ${item.publisher}`);
      if (item.free_link) {
        lines.push(`       free online: ${item.free_link}`);
      }
    }
  }
  lines.push(`(${sliced.length} shown)${marker}`);
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit,
  };
}

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_PERSI_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const SURNAME_OPTIONS: readonly OptionSpec[] = [
  { key: 'limit', kind: 'integer', flags: ['--limit'], min: 0, default: 25, help: 'Max results to show.' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

const LOCATION_OPTIONS: readonly OptionSpec[] = [
  { key: 'state', kind: 'string', flags: ['--state'], required: true, metavar: 'ST', help: 'Two-letter state code, e.g. MI. GEN for US general.' },
  { key: 'county', kind: 'string', flags: ['--county'], default: '', metavar: 'COUNTY', help: 'County name (optional; leave blank for statewide).' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  { key: 'surnameOpt', kind: 'string', flags: ['--surname'], metavar: 'SURNAME', help: 'Search by surname (alias for `persi surname`).' },
  { key: 'titleOpt', kind: 'string', flags: ['--title'], metavar: 'KEYWORD', help: 'Search by article-title keyword (alias for `persi title`).' },
  { key: 'state', kind: 'string', flags: ['--state'], metavar: 'ST', help: 'Two-letter state code for location counts (alias for `persi location`).' },
  { key: 'county', kind: 'string', flags: ['--county'], default: '', metavar: 'COUNTY', help: 'County name (used with --state).' },
  { key: 'limit', kind: 'integer', flags: ['--limit'], min: 0, default: 25, help: 'Max results to show.' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
  ...CACHE_OPTIONS,
];

const SURNAME_SPEC: CommandParseSpec = {
  options: SURNAME_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'surname',
};

const TITLE_SPEC: CommandParseSpec = {
  options: SURNAME_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'keyword',
};

const LOCATION_SPEC: CommandParseSpec = {
  options: LOCATION_OPTIONS,
  allowPositionals: false,
};

const SEARCH_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

const URL_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'mode',
};

function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_PERSI_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_PERSI_CACHE_TTL_HOURS'
  );
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_PERSI_CACHE_DIR'],
    defaultSubdir: 'kinloom-persi',
  });
}

function isArticlesPayload(value: unknown): value is { readonly articles: PersiArticle[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { articles?: unknown }).articles);
}

function isCategoriesPayload(value: unknown): value is { readonly categories: PersiCategory[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { categories?: unknown }).categories);
}

async function executeSurname(
  ctx: RecordCommandContext,
  surname: string,
  limit: number,
  asJson: boolean,
  refresh: boolean,
  ttlHours: number
): Promise<RecordCommandOutcome> {
  const { value, cacheHit } = await cachedJsonCall<{ readonly articles: PersiArticle[] }>({
    cacheDir: getCacheDir(ctx),
    kind: 'surname',
    payload: { surname: surname.trim().toLowerCase() },
    ttlHours,
    refresh,
    fetch: async () => {
      const page = await fetchPersiForm(
        ctx,
        SURNAME_URL,
        { surname, sort: 'title', submit: 'Search' },
        `${BASE}/search_persisurname.php`
      );
      return { articles: parsePersiArticles(page) };
    },
    cacheable: (r) => r.articles.length > 0,
    validateCached: isArticlesPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return emitPersiItems(ctx, value.articles, asJson, limit, cacheHit);
}

async function executeTitle(
  ctx: RecordCommandContext,
  keyword: string,
  limit: number,
  asJson: boolean,
  refresh: boolean,
  ttlHours: number
): Promise<RecordCommandOutcome> {
  const { value, cacheHit } = await cachedJsonCall<{ readonly articles: PersiArticle[] }>({
    cacheDir: getCacheDir(ctx),
    kind: 'title',
    payload: { keyword: keyword.trim().toLowerCase() },
    ttlHours,
    refresh,
    fetch: async () => {
      const page = await fetchPersiForm(
        ctx,
        TITLE_URL,
        { keyword, sort: 'title', submit: 'Search' },
        `${BASE}/search_persiarttitle.php`
      );
      return { articles: parsePersiArticles(page) };
    },
    cacheable: (r) => r.articles.length > 0,
    validateCached: isArticlesPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return emitPersiItems(ctx, value.articles, asJson, limit, cacheHit);
}

async function executeLocation(
  ctx: RecordCommandContext,
  rawState: string,
  county: string,
  asJson: boolean,
  refresh: boolean,
  ttlHours: number
): Promise<RecordCommandOutcome> {
  const state = rawState.toUpperCase();
  if (!US_STATES.has(state)) {
    throw new RecordRuntimeError(`Unknown state code: ${state}`);
  }
  const { value, cacheHit } = await cachedJsonCall<{ readonly categories: PersiCategory[] }>({
    cacheDir: getCacheDir(ctx),
    kind: 'location',
    payload: { state, county: county.trim().toLowerCase() },
    ttlHours,
    refresh,
    fetch: async () => {
      const page = await fetchPersiForm(
        ctx,
        LOCATION_URL,
        { subloc: 'USA', cosearch: 'USA', usloc: state, county, submit: 'Search' },
        `${BASE}/search_persilocation.php`
      );
      return { categories: parsePersiCategories(page) };
    },
    cacheable: (r) => r.categories.length > 0,
    validateCached: isCategoriesPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (value.categories.length === 0) {
    const bytesOut = emitStdout(
      ctx.io,
      "No category counts returned. The county value may not match PERSI's list; try a blank county (statewide) or check the website form."
    );
    return { exitCode: 1, bytesOut, cacheHit };
  }
  return emitPersiItems(ctx, value.categories, asJson, value.categories.length, cacheHit);
}

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom persi <command> [options]',
    summary: "Search ACPL's free PERSI (Periodical Source Index).",
    subcommands: [
      { name: 'surname', summary: 'Search PERSI by surname, e.g. persi surname Lincoln.' },
      { name: 'title', summary: 'Search PERSI by article-title keyword, e.g. persi title Lincoln.' },
      { name: 'location', summary: 'List PERSI article counts by category for a state/county.' },
      { name: 'search', summary: 'Convenience router to `surname`, `title`, or `location` search.' },
      { name: 'url', summary: 'Print the PERSI website search page for a mode (surname|title|location).' },
    ],
  });
}

export const runPersiCommand: RecordHandler = async (
  args,
  ctx
): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'surname': {
        const parsed = parseCommandArgs(rest, SURNAME_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom persi surname <SURNAME> [options]',
                summary: 'Search PERSI by surname, e.g. persi surname Lincoln.',
                options: SURNAME_OPTIONS,
              })
            ),
          };
        }
        return await executeSurname(
          ctx,
          parsed.positionals[0],
          getNumberOption(parsed, 'limit') ?? 25,
          getBooleanOption(parsed, 'asJson'),
          getBooleanOption(parsed, 'refresh'),
          resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx)
        );
      }

      case 'title': {
        const parsed = parseCommandArgs(rest, TITLE_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom persi title <KEYWORD> [options]',
                summary: 'Search PERSI by article-title keyword, e.g. persi title Lincoln.',
                options: SURNAME_OPTIONS,
              })
            ),
          };
        }
        return await executeTitle(
          ctx,
          parsed.positionals[0],
          getNumberOption(parsed, 'limit') ?? 25,
          getBooleanOption(parsed, 'asJson'),
          getBooleanOption(parsed, 'refresh'),
          resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx)
        );
      }

      case 'location': {
        const parsed = parseCommandArgs(rest, LOCATION_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom persi location --state <ST> [--county <COUNTY>] [options]',
                summary: 'List PERSI article counts by category for a state/county.',
                options: LOCATION_OPTIONS,
              })
            ),
          };
        }
        return await executeLocation(
          ctx,
          getStringOption(parsed, 'state') ?? '',
          getStringOption(parsed, 'county') ?? '',
          getBooleanOption(parsed, 'asJson'),
          getBooleanOption(parsed, 'refresh'),
          resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx)
        );
      }

      case 'search': {
        const parsed = parseCommandArgs(rest, SEARCH_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom persi search [QUERY] [options]',
                summary: 'Convenience router to `surname`, `title`, or `location` search.',
                options: SEARCH_OPTIONS,
              })
            ),
          };
        }
        const query = parsed.positionals[0];
        const surnameOpt = getStringOption(parsed, 'surnameOpt');
        const titleOpt = getStringOption(parsed, 'titleOpt');
        const state = getStringOption(parsed, 'state');
        const county = getStringOption(parsed, 'county') ?? '';
        const limit = getNumberOption(parsed, 'limit') ?? 25;
        const asJson = getBooleanOption(parsed, 'asJson');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

        if (state && (query || surnameOpt || titleOpt)) {
          throw new CliValidationError(
            "PERSI's surname and title forms do not accept a --state filter. Use `persi surname <SURNAME>`, `persi title <KEYWORD>`, or `persi location --state <ST>` separately."
          );
        }
        if (state) {
          return await executeLocation(ctx, state, county, asJson, refresh, ttlHours);
        }
        if (titleOpt) {
          return await executeTitle(ctx, titleOpt, limit, asJson, refresh, ttlHours);
        }
        const targetSurname = surnameOpt ?? query;
        if (targetSurname) {
          return await executeSurname(ctx, targetSurname, limit, asJson, refresh, ttlHours);
        }
        throw new CliValidationError('Pass a surname, --title <KEYWORD>, or --state <ST>.');
      }

      case 'url': {
        const parsed = parseCommandArgs(rest, URL_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom persi url <surname|title|location>',
                summary: 'Print the PERSI website search page for a mode.',
              })
            ),
          };
        }
        const mode = parsed.positionals[0];
        const pages: Readonly<Record<string, string>> = {
          surname: `${BASE}/search_persisurname.php`,
          title: `${BASE}/search_persiarttitle.php`,
          location: `${BASE}/search_persilocation.php`,
        };
        const page = pages[mode];
        if (!page) {
          throw new CliValidationError(
            `Invalid mode '${mode}'. Choose from: surname, title, location.`
          );
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, page) };
      }

      default:
        throw new CliValidationError(
          `No such command '${subcmd}'. Run 'kinloom persi --script-help'.`
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
