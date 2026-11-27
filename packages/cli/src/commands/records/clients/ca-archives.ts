import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  BrowserTimeoutError,
  type ChromiumLauncher,
  type CommandParseSpec,
  cachedJsonCall,
  cacheKeyFor,
  collapseWhitespace,
  DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS,
  emitJsonStdout,
  emitStdout,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  httpGetText,
  httpRequest,
  launchOptionalChromium,
  loadHtml,
  type OptionSpec,
  parseCacheTtlHours,
  parseCommandArgs,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  readSchemaCacheEntry,
  resolveCacheDir,
  runWithBrowserSession,
  type SchemaCacheEntry,
  withAdvisoryLock,
} from '../runtime/index.js';

export type { ChromiumLauncher };

const DEFAULT_CACHE_TTL_HOURS = 168;
const DEFAULT_SEARCH_TIMEOUT_SEC = 45;
const CACHE_SCHEMA = 1;

export const OAC_BASE = 'https://oac.cdlib.org';
export const CALISPHERE_BASE = 'https://calisphere.org';
export const PORTAL_BASE = 'https://archives.sos.ca.gov';
export const EXHIBITS_BASE = 'https://exhibits.sos.ca.gov';
export const CDNC_BASE = 'https://cdnc.ucr.edu/cgi-bin/cdnc';
export const MINERVA_URL =
  'https://gencat.sos.ca.gov/webcat/request/DoMenuRequest' +
  '?SystemName=California+State+Archives&UserName=csa+public&Password=' +
  '&TemplateProcessID=6000_3355&bCachable=1&MenuName=Minerva+Online+Catalog';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const SEARCHABLE_SOURCES = ['oac', 'calisphere', 'portal', 'exhibits'] as const;
export type CaSearchableSource = (typeof SEARCHABLE_SOURCES)[number];

export const ALL_SOURCES = ['oac', 'calisphere', 'portal', 'exhibits', 'cdnc', 'minerva'] as const;
export type CaSource = (typeof ALL_SOURCES)[number];

export interface CaSearchResultItem {
  readonly id?: string;
  readonly title: string;
  readonly url: string;
  readonly kind?: string;
  readonly type?: string;
}

export interface CaSourceEntry {
  readonly source: CaSearchableSource;
  readonly url: string;
  readonly total: number | null;
  readonly results: readonly CaSearchResultItem[];
  readonly timed_out?: boolean;
  readonly error?: string;
}

export interface CaArchivesOverrides {
  readonly launcher?: ChromiumLauncher;
  readonly closeTimeoutMs?: number;
  readonly killGraceMs?: number;
}

export interface CaSourceOutput extends CaSourceEntry {
  readonly cache_hit: boolean;
}

export interface CaPortalItem {
  readonly source: 'portal';
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

export interface CaExhibitsItem {
  readonly source: 'exhibits';
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly description: string;
  readonly url: string;
}

interface RawBrowserLink {
  readonly href?: string;
  readonly text?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeoutFailure(err: unknown): boolean {
  if (err instanceof BrowserTimeoutError) {
    return true;
  }
  if (err instanceof Error) {
    return err.name === 'TimeoutError' || /timed?\s*out/i.test(err.message);
  }
  return false;
}

function isNavigationContextDestroyed(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /execution context was destroyed|most likely because of a navigation/i.test(message);
}

function pyQuote(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

export function oacUrl(query: string): string {
  return `${OAC_BASE}/search?q=${pyQuote(query)}`;
}

export function calisphereUrl(query: string): string {
  return `${CALISPHERE_BASE}/search/?q=${pyQuote(query)}`;
}

export function portalUrl(query: string): string {
  return `${PORTAL_BASE}/Items?SearchText=${pyQuote(query)}`;
}

export function exhibitsUrl(query: string, limit = 10): string {
  return `${EXHIBITS_BASE}/api/items?search=${pyQuote(query)}&per_page=${pyQuote(String(limit))}`;
}

export function cdncUrl(query: string): string {
  return `${CDNC_BASE}?a=q&r=1&results=1&txq=${pyQuote(query)}&e=-------en--20--1--txt-txIN-------`;
}

export function buildUrl(source: CaSource, query: string, limit = 10): string {
  switch (source) {
    case 'oac':
      return oacUrl(query);
    case 'calisphere':
      return calisphereUrl(query);
    case 'portal':
      return portalUrl(query);
    case 'exhibits':
      return exhibitsUrl(query, limit);
    case 'cdnc':
      return cdncUrl(query);
    case 'minerva':
      return MINERVA_URL;
  }
}

export function parsePortalSearchHtml(html: string, url: string, limit = 10): CaSourceEntry {
  const totalMatch = /Search Results \d+ to \d+ of (\d+)/.exec(html);
  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : null;

  const $ = loadHtml(html);
  const seenIds = new Set<string>();
  const results: CaSearchResultItem[] = [];

  $('a[href]').each((_idx, el) => {
    const href = $(el).attr('href') ?? '';
    const match = /^\/Items\/Details\/(\d+)$/.exec(href);
    if (!match) {
      return;
    }
    const itemId = match[1];
    const title = collapseWhitespace($(el).text());
    if (!title || seenIds.has(itemId)) {
      return;
    }
    seenIds.add(itemId);
    results.push({
      id: itemId,
      title,
      url: `${PORTAL_BASE}${href}`,
    });
  });

  return {
    source: 'portal',
    url,
    total,
    results: results.slice(0, limit),
  };
}

function extractOmekaTitle(item: Record<string, unknown>): string {
  if (typeof item['o:title'] === 'string' && item['o:title'].length > 0) {
    return item['o:title'];
  }
  const vals = item['dcterms:title'];
  if (Array.isArray(vals) && vals.length > 0 && isPlainRecord(vals[0])) {
    const val = vals[0]['@value'];
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }
  return '(untitled)';
}

function extractOmekaTypes(item: Record<string, unknown>): string {
  const raw = item['@type'];
  if (!Array.isArray(raw)) {
    return '';
  }
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry !== 'o:Item').join(', ');
}

export async function searchPortal(
  ctx: RecordCommandContext,
  query: string,
  limit = 10,
  timeoutMs = 30_000
): Promise<CaSourceEntry> {
  const url = portalUrl(query);
  const { text } = await httpGetText(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: USER_AGENT,
    timeoutMs: Math.max(1_000, Math.min(30_000, Math.floor(timeoutMs))),
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['archives.sos.ca.gov'] },
  });
  return parsePortalSearchHtml(text, url, limit);
}

export async function searchExhibits(
  ctx: RecordCommandContext,
  query: string,
  limit = 10,
  timeoutMs = 30_000
): Promise<CaSourceEntry> {
  const url = exhibitsUrl(query, limit);
  const response = await httpRequest(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: USER_AGENT,
    headers: { Accept: 'application/ld+json' },
    timeoutMs: Math.max(1_000, Math.min(30_000, Math.floor(timeoutMs))),
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['exhibits.sos.ca.gov'] },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bytes.toString('utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Invalid JSON from ${url}: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new RecordRuntimeError(`Unexpected JSON response from ${url}`);
  }
  const hdr = response.headers.get('Omeka-S-Total-Results');
  const parsedHdr = hdr ? Number.parseInt(hdr, 10) : Number.NaN;
  const total = Number.isInteger(parsedHdr) ? parsedHdr : parsed.length;

  const results: CaSearchResultItem[] = [];
  for (const rawItem of parsed) {
    if (!isPlainRecord(rawItem)) {
      continue;
    }
    const itemId = String(rawItem['o:id'] ?? '');
    results.push({
      id: itemId,
      title: extractOmekaTitle(rawItem),
      type: extractOmekaTypes(rawItem),
      url: `${EXHIBITS_BASE}/s/exhibits/item/${itemId}`,
    });
  }
  return {
    source: 'exhibits',
    url,
    total,
    results,
  };
}

const OAC_LINKS_JS =
  "() => Array.from(document.querySelectorAll('a[href*=\"/findaid/\"]')).map(a => ({href: a.getAttribute('href'), text: a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160)}))";
const CAL_LINKS_JS =
  "() => Array.from(document.querySelectorAll('a[href*=\"/item/\"]')).map(a => ({href: a.getAttribute('href'), text: a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160)}))";

export function dedupeOacLinks(
  links: readonly RawBrowserLink[],
  base: string,
  limit: number
): CaSearchResultItem[] {
  const seen = new Set<string>();
  const results: CaSearchResultItem[] = [];
  for (const link of links) {
    const href = typeof link.href === 'string' ? link.href : '';
    const text = typeof link.text === 'string' ? link.text.trim() : '';
    if (!href || !text || seen.has(href)) {
      continue;
    }
    seen.add(href);
    const kind = href.includes('_aspace_') ? 'component' : 'collection';
    results.push({ title: text, url: `${base}${href}`, kind });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

export function dedupeCalisphereLinks(
  links: readonly RawBrowserLink[],
  base: string,
  limit: number
): CaSearchResultItem[] {
  const seen = new Set<string>();
  const results: CaSearchResultItem[] = [];
  for (const link of links) {
    const href = typeof link.href === 'string' ? link.href : '';
    const title = typeof link.text === 'string' ? link.text.trim() : '';
    if (!href.startsWith('/item/') || !title) {
      continue;
    }
    const fullUrl = `${base}${href}`;
    if (seen.has(fullUrl)) {
      continue;
    }
    seen.add(fullUrl);
    results.push({ title, url: fullUrl });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function makeTimedOutEntry(source: CaSearchableSource, url: string, message: string): CaSourceEntry {
  return {
    source,
    url,
    total: null,
    results: [],
    timed_out: true,
    error: message,
  };
}

export async function browserSearch(
  ctx: RecordCommandContext,
  sources: readonly ('oac' | 'calisphere')[],
  query: string,
  limit = 10,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT_SEC * 1000,
  launcher: ChromiumLauncher = launchOptionalChromium,
  sessionOptions?: { readonly closeTimeoutMs?: number; readonly killGraceMs?: number }
): Promise<Partial<Record<'oac' | 'calisphere', CaSourceEntry>>> {
  const out: Partial<Record<'oac' | 'calisphere', CaSourceEntry>> = {};
  const totalTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const launchTimeoutMs = Math.min(DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS, totalTimeoutMs);

  try {
    await runWithBrowserSession(
      {
        env: ctx.env,
        overrideEnvVar: 'CA_ARCHIVES_BROWSER',
        userAgent: USER_AGENT,
        totalTimeoutMs,
        launchTimeoutMs,
        closeTimeoutMs: sessionOptions?.closeTimeoutMs,
        killGraceMs: sessionOptions?.killGraceMs,
        nowMs: ctx.nowMs,
        launcher,
      },
      async (session) => {
        const { page } = session;

        for (let idx = 0; idx < sources.length; idx += 1) {
          const src = sources[idx];
          const url = src === 'oac' ? oacUrl(query) : calisphereUrl(query);
          const remainingCount = sources.length - idx;
          const remainingTotal = session.remainingMs();
          if (remainingTotal <= 0) {
            out[src] = makeTimedOutEntry(
              src,
              url,
              `Browser search budget (${totalTimeoutMs}ms) exhausted before ${src}.`
            );
            continue;
          }

          const sourceBudgetMs = Math.max(1, Math.floor(remainingTotal / remainingCount));
          const sourceDeadline = ctx.nowMs() + sourceBudgetMs;
          const sourceRemaining = (): number =>
            Math.min(session.remainingMs(), Math.max(0, sourceDeadline - ctx.nowMs()));

          try {
            await session.runStep(
              `${src}:goto`,
              (stepMs) => page.goto(url, { waitUntil: 'domcontentloaded', timeout: stepMs }),
              sourceRemaining()
            );

            if (typeof page.waitForFunction === 'function') {
              const waitExpr =
                src === 'oac'
                  ? '() => /of \\d+ entries|No results/i.test(document.body.innerText)'
                  : '() => /\\d+ items? found|No results/i.test(document.body.innerText)';
              for (let navAttempt = 0; navAttempt < 3; navAttempt += 1) {
                const waitBudget = Math.min(15_000, Math.floor(sourceRemaining() * 0.6));
                if (waitBudget <= 0) {
                  break;
                }
                try {
                  await session.runStep(
                    `${src}:waitForFunction`,
                    (stepMs) => page.waitForFunction!(waitExpr, undefined, { timeout: stepMs }),
                    waitBudget
                  );
                  break;
                } catch (waitErr: unknown) {
                  if (session.remainingMs() <= 0) {
                    throw waitErr;
                  }
                  if (isNavigationContextDestroyed(waitErr) && navAttempt < 2 && sourceRemaining() > 300) {
                    const retryWaitMs = Math.min(400, Math.floor(sourceRemaining() * 0.2));
                    await session.runStep(
                      `${src}:nav-retry`,
                      () =>
                        typeof page.waitForTimeout === 'function'
                          ? page.waitForTimeout(retryWaitMs)
                          : ctx.sleepFn(retryWaitMs),
                      sourceRemaining()
                    );
                    continue;
                  }
                  // Proceed to inspect current DOM if the page text heuristic timed out.
                  break;
                }
              }

              const settleMs = Math.min(500, Math.floor(sourceRemaining() * 0.2));
              if (settleMs > 0) {
                await session.runStep(
                  `${src}:settle`,
                  () =>
                    typeof page.waitForTimeout === 'function'
                      ? page.waitForTimeout(settleMs)
                      : ctx.sleepFn(settleMs),
                  sourceRemaining()
                );
              }
            }

            const evaluateWithNavRetry = async <T>(phase: string, expr: string): Promise<T> => {
              for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                  return await session.runStep(phase, () => page.evaluate<T>(expr), sourceRemaining());
                } catch (evalErr: unknown) {
                  if (isNavigationContextDestroyed(evalErr) && attempt < 2 && sourceRemaining() > 300) {
                    const retryWaitMs = Math.min(400, Math.floor(sourceRemaining() * 0.2));
                    await session.runStep(
                      `${phase}:nav-retry`,
                      () =>
                        typeof page.waitForTimeout === 'function'
                          ? page.waitForTimeout(retryWaitMs)
                          : ctx.sleepFn(retryWaitMs),
                      sourceRemaining()
                    );
                    continue;
                  }
                  throw evalErr;
                }
              }
              return session.runStep(phase, () => page.evaluate<T>(expr), sourceRemaining());
            };

            const text = await evaluateWithNavRetry<string>(
              `${src}:evaluate-text`,
              'document.body.innerText'
            );
            const links = await evaluateWithNavRetry<RawBrowserLink[]>(
              `${src}:evaluate-links`,
              src === 'oac' ? OAC_LINKS_JS : CAL_LINKS_JS
            );

            if (src === 'oac') {
              const totalMatch = /of (\d+) entries/.exec(typeof text === 'string' ? text : '');
              const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : null;
              out.oac = {
                source: 'oac',
                url,
                total,
                results: dedupeOacLinks(Array.isArray(links) ? links : [], OAC_BASE, limit),
              };
            } else {
              const totalMatch = /(\d+) items? found/.exec(typeof text === 'string' ? text : '');
              const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : null;
              out.calisphere = {
                source: 'calisphere',
                url,
                total,
                results: dedupeCalisphereLinks(Array.isArray(links) ? links : [], CALISPHERE_BASE, limit),
              };
            }
          } catch (err: unknown) {
            if (isTimeoutFailure(err)) {
              const message = err instanceof Error ? err.message : String(err);
              out[src] = makeTimedOutEntry(src, url, message);
              continue;
            }
            throw err;
          }
        }
      }
    );
  } catch (err: unknown) {
    if (isTimeoutFailure(err)) {
      const message = err instanceof Error ? err.message : String(err);
      for (const src of sources) {
        if (!out[src]) {
          out[src] = makeTimedOutEntry(src, buildUrl(src, query, limit), message);
        }
      }
      return out;
    }
    throw err;
  }

  return out;
}

async function fetchPortalItem(ctx: RecordCommandContext, portalId: string): Promise<CaPortalItem> {
  const url = `${PORTAL_BASE}/Items/Details/${portalId}`;
  const { text } = await httpGetText(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['archives.sos.ca.gov'] },
  });
  const titleMatch = /<title>([^<]+)<\/title>/i.exec(text);
  const rawTitle = titleMatch ? titleMatch[1].trim() : '(no title)';
  const title = rawTitle.replace(' | California Archives Search', '');
  return {
    source: 'portal',
    id: portalId,
    title,
    url,
  };
}

async function fetchExhibitsItem(ctx: RecordCommandContext, exhibitsId: string): Promise<CaExhibitsItem> {
  const url = `${EXHIBITS_BASE}/api/items/${exhibitsId}`;
  const response = await httpRequest(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: USER_AGENT,
    headers: { Accept: 'application/ld+json' },
    timeoutMs: 30_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['exhibits.sos.ca.gov'] },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bytes.toString('utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Invalid JSON from ${url}: ${message}`);
  }
  if (!isPlainRecord(parsed)) {
    throw new RecordRuntimeError(`Unexpected JSON response from ${url}`);
  }
  let desc = '';
  const descVals = parsed['dcterms:description'];
  if (Array.isArray(descVals)) {
    for (const val of descVals) {
      if (isPlainRecord(val) && typeof val['@value'] === 'string' && val['@value'].length > 0) {
        desc = val['@value'];
        break;
      }
    }
  }
  return {
    source: 'exhibits',
    id: exhibitsId,
    title: extractOmekaTitle(parsed),
    type: extractOmekaTypes(parsed),
    description: desc.slice(0, 500),
    url: `${EXHIBITS_BASE}/s/exhibits/item/${exhibitsId}`,
  };
}

function isSourceCacheable(entry: CaSourceEntry): boolean {
  return !entry.timed_out && !entry.error && (entry.results.length > 0 || entry.total !== null);
}

function isCaSourceEntry(value: unknown): value is CaSourceEntry {
  return (
    isPlainRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.url === 'string' &&
    Array.isArray(value.results)
  );
}

function isCaPortalItem(value: unknown): value is CaPortalItem {
  return (
    isPlainRecord(value) &&
    value.source === 'portal' &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.url === 'string'
  );
}

function isCaExhibitsItem(value: unknown): value is CaExhibitsItem {
  return (
    isPlainRecord(value) &&
    value.source === 'exhibits' &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.url === 'string'
  );
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_CA_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-ca-archives',
  });
}

function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_CA_ARCHIVES_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_CA_ARCHIVES_CACHE_TTL_HOURS'
  );
}

async function writeSchemaCacheEntry<T>(
  ctx: RecordCommandContext,
  cacheDir: string,
  kind: string,
  payload: unknown,
  result: T
): Promise<void> {
  const key = cacheKeyFor(kind, payload);
  const entryPath = path.join(cacheDir, `${key}.json`);
  const lockPath = path.join(cacheDir, `${key}.lock`);
  await withAdvisoryLock(
    lockPath,
    async () => {
      const envelope: SchemaCacheEntry<T> = {
        schema: CACHE_SCHEMA,
        fetched_at: ctx.nowMs() / 1000,
        kind,
        query: payload,
        result,
      };
      atomicWriteFileSync(entryPath, JSON.stringify(envelope));
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

function formatSourceText(entry: CaSourceOutput): string[] {
  const lines: string[] = [];
  const total = entry.total;
  const shown = entry.results.length;
  let header: string = entry.source;
  if (total !== null) {
    header += ` (${total} total`;
    if (shown !== total) {
      header += `, showing ${shown})`;
    } else {
      header += ')';
    }
  } else {
    header += ` (showing ${shown})`;
  }
  if (entry.cache_hit) {
    header += ' [cache]';
  }
  lines.push(header);
  lines.push(`  ${entry.url}`);
  if (entry.error) {
    lines.push(entry.timed_out ? `  Timed out: ${entry.error}` : `  Error: ${entry.error}`);
    return lines;
  }
  if (entry.results.length === 0) {
    lines.push('  No results.');
  }
  entry.results.forEach((result, idx) => {
    let line = `  ${idx + 1}. ${result.title}`;
    if (result.kind) {
      line += ` [${result.kind}]`;
    }
    if (result.type) {
      line += ` (${result.type})`;
    }
    lines.push(line);
    lines.push(`     ${result.url}`);
  });
  return lines;
}

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_CA_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'sources',
    kind: 'string',
    flags: ['--source'],
    multiple: true,
    choices: SEARCHABLE_SOURCES,
    metavar: 'SOURCE',
    help: 'Only search this source (repeatable). Default: all four.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    min: 0,
    default: 10,
    help: 'Results per source.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_SEARCH_TIMEOUT_SEC,
    metavar: 'SECONDS',
    help: `Total timeout in seconds for browser-backed sources (default ${DEFAULT_SEARCH_TIMEOUT_SEC}).`,
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of text.',
  },
  ...CACHE_OPTIONS,
];

const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'sources',
    kind: 'string',
    flags: ['--source'],
    multiple: true,
    choices: ALL_SOURCES,
    metavar: 'SOURCE',
    help: 'Only print URLs for this source (repeatable). Default: all six.',
  },
];

const GET_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'portalId',
    kind: 'string',
    flags: ['--portal'],
    metavar: 'ID',
    help: 'Portal item ID (from search results).',
  },
  {
    key: 'exhibitsId',
    kind: 'string',
    flags: ['--exhibits'],
    metavar: 'ID',
    help: 'Exhibits item ID (from search results).',
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit JSON instead of text.',
  },
  ...CACHE_OPTIONS,
];

const SEARCH_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'query',
};

const URL_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'query',
};

const GET_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: false,
};

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom ca-archives <command> [options]',
    summary: 'Search California archives portals (OAC, Calisphere, State Archives).',
    subcommands: [
      { name: 'search', summary: 'Search the California archives portals for QUERY.' },
      { name: 'url', summary: 'Print verified search URLs for QUERY without running any search.' },
      { name: 'get', summary: 'Fetch one Portal or exhibits item by ID.' },
    ],
  });
}

async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext,
  overrides: CaArchivesOverrides = {}
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ca-archives search <QUERY...> [options]',
          summary: 'Search the California archives portals for QUERY.',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }

  const q = parsed.positionals.join(' ');
  const selectedSources = getStringListOption(parsed, 'sources') as readonly CaSearchableSource[];
  const wanted: readonly CaSearchableSource[] =
    selectedSources.length > 0 ? selectedSources : SEARCHABLE_SOURCES;
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? DEFAULT_SEARCH_TIMEOUT_SEC;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(timeoutSec)} (must be > 0).`);
  }
  const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getCacheDir(ctx);
  const payload = { query: q, limit };

  const out: Partial<Record<CaSearchableSource, CaSourceOutput>> = {};
  const browserSources = wanted.filter(
    (src): src is 'oac' | 'calisphere' => src === 'oac' || src === 'calisphere'
  );
  const uncachedBrowser: ('oac' | 'calisphere')[] = [];

  for (const src of browserSources) {
    if (!refresh) {
      const key = cacheKeyFor(`search:${src}`, payload);
      const entryPath = path.join(cacheDir, `${key}.json`);
      const hit = readSchemaCacheEntry<CaSourceEntry>(
        entryPath,
        ttlHours,
        CACHE_SCHEMA,
        ctx.nowMs,
        isCaSourceEntry
      );
      if (hit !== undefined) {
        out[src] = { ...hit, cache_hit: true };
        continue;
      }
    }
    uncachedBrowser.push(src);
  }

  if (uncachedBrowser.length > 0) {
    const fetched = await browserSearch(
      ctx,
      uncachedBrowser,
      q,
      limit,
      timeoutMs,
      overrides.launcher ?? launchOptionalChromium,
      {
        closeTimeoutMs: overrides.closeTimeoutMs,
        killGraceMs: overrides.killGraceMs,
      }
    );
    for (const src of uncachedBrowser) {
      const entry = fetched[src];
      if (!entry) {
        continue;
      }
      if (isSourceCacheable(entry)) {
        await writeSchemaCacheEntry(ctx, cacheDir, `search:${src}`, payload, entry);
      }
      out[src] = { ...entry, cache_hit: false };
    }
  }

  if (wanted.includes('portal')) {
    try {
      const { value, cacheHit } = await cachedJsonCall<CaSourceEntry>({
        cacheDir,
        kind: 'search:portal',
        payload,
        ttlHours,
        refresh,
        schema: CACHE_SCHEMA,
        fetch: () => searchPortal(ctx, q, limit, timeoutMs),
        cacheable: isSourceCacheable,
        validateCached: isCaSourceEntry,
        nowMs: ctx.nowMs,
        sleepFn: ctx.sleepFn,
      });
      out.portal = { ...value, cache_hit: cacheHit };
    } catch (err: unknown) {
      if (isTimeoutFailure(err) && wanted.length > 1) {
        const message = err instanceof Error ? err.message : String(err);
        out.portal = { ...makeTimedOutEntry('portal', portalUrl(q), message), cache_hit: false };
      } else {
        throw err;
      }
    }
  }

  if (wanted.includes('exhibits')) {
    try {
      const { value, cacheHit } = await cachedJsonCall<CaSourceEntry>({
        cacheDir,
        kind: 'search:exhibits',
        payload,
        ttlHours,
        refresh,
        schema: CACHE_SCHEMA,
        fetch: () => searchExhibits(ctx, q, limit, timeoutMs),
        cacheable: isSourceCacheable,
        validateCached: isCaSourceEntry,
        nowMs: ctx.nowMs,
        sleepFn: ctx.sleepFn,
      });
      out.exhibits = { ...value, cache_hit: cacheHit };
    } catch (err: unknown) {
      if (isTimeoutFailure(err) && wanted.length > 1) {
        const message = err instanceof Error ? err.message : String(err);
        out.exhibits = { ...makeTimedOutEntry('exhibits', exhibitsUrl(q, limit), message), cache_hit: false };
      } else {
        throw err;
      }
    }
  }

  const ordered: CaSourceOutput[] = [];
  for (const src of wanted) {
    const entry = out[src];
    if (entry) {
      ordered.push(entry);
    }
  }
  const timedOutSources = ordered.filter((entry) => entry.timed_out === true).map((entry) => entry.source);
  for (const entry of ordered) {
    if (entry.timed_out && entry.error) {
      ctx.io.stderr(`Warning: ${entry.source} timed out: ${entry.error}`);
    }
  }
  const allTimedOut = ordered.length > 0 && timedOutSources.length === ordered.length;
  const allCached = ordered.length > 0 && ordered.every((entry) => entry.cache_hit);
  const exitCode = allTimedOut ? 1 : 0;

  if (asJson) {
    const jsonPayload =
      timedOutSources.length > 0
        ? { query: q, cache_hit: allCached, timed_out_sources: timedOutSources, sources: ordered }
        : { query: q, cache_hit: allCached, sources: ordered };
    return {
      exitCode,
      bytesOut: emitJsonStdout(ctx.io, jsonPayload),
      cacheHit: allCached,
    };
  }

  const lines: string[] = [];
  for (const entry of ordered) {
    lines.push(...formatSourceText(entry), '');
  }
  return {
    exitCode,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: allCached,
  };
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ca-archives url <QUERY...> [options]',
          summary: 'Print verified search URLs for QUERY without running any search.',
          options: URL_OPTIONS,
        })
      ),
    };
  }

  const q = parsed.positionals.join(' ');
  const selected = getStringListOption(parsed, 'sources') as readonly CaSource[];
  const wanted: readonly CaSource[] = selected.length > 0 ? selected : ALL_SOURCES;

  const lines = wanted.map((src) => `${src}: ${buildUrl(src, q)}`);
  if (wanted.includes('cdnc')) {
    lines.push('note: CDNC is behind a Cloudflare challenge; open the URL in a browser.');
  }
  if (wanted.includes('minerva')) {
    lines.push('note: Minerva is a catalog you search in the browser; this is its launch URL.');
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
  };
}

async function runGet(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ca-archives get (--portal <ID> | --exhibits <ID>) [options]',
          summary: 'Fetch one Portal or exhibits item by ID.',
          options: GET_OPTIONS,
        })
      ),
    };
  }

  const portalId = getStringOption(parsed, 'portalId');
  const exhibitsId = getStringOption(parsed, 'exhibitsId');
  if (Boolean(portalId) === Boolean(exhibitsId)) {
    throw new CliValidationError('Pass exactly one of --portal ID or --exhibits ID.');
  }

  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getCacheDir(ctx);

  let data: CaPortalItem | CaExhibitsItem;
  let cacheHit: boolean;

  if (portalId) {
    const res = await cachedJsonCall<CaPortalItem>({
      cacheDir,
      kind: 'get:portal',
      payload: { id: portalId },
      ttlHours,
      refresh,
      schema: CACHE_SCHEMA,
      fetch: () => fetchPortalItem(ctx, portalId),
      cacheable: (r) => Boolean(r.title && r.title !== '(no title)'),
      validateCached: isCaPortalItem,
      nowMs: ctx.nowMs,
      sleepFn: ctx.sleepFn,
    });
    data = res.value;
    cacheHit = res.cacheHit;
  } else {
    const targetId = exhibitsId as string;
    const res = await cachedJsonCall<CaExhibitsItem>({
      cacheDir,
      kind: 'get:exhibits',
      payload: { id: targetId },
      ttlHours,
      refresh,
      schema: CACHE_SCHEMA,
      fetch: () => fetchExhibitsItem(ctx, targetId),
      cacheable: (r) => Boolean(r.id),
      validateCached: isCaExhibitsItem,
      nowMs: ctx.nowMs,
      sleepFn: ctx.sleepFn,
    });
    data = res.value;
    cacheHit = res.cacheHit;
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...data, cache_hit: cacheHit }),
      cacheHit,
    };
  }

  const lines: string[] = [];
  let first = true;
  for (const [key, val] of Object.entries(data)) {
    if (val) {
      const suffix = first && cacheHit ? ' [cache]' : '';
      lines.push(`${key}: ${String(val)}${suffix}`);
      first = false;
    }
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit,
  };
}

export function createCaArchivesCommand(overrides: CaArchivesOverrides = {}): RecordHandler {
  return async (args, ctx): Promise<RecordCommandOutcome> => {
    try {
      if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
      }
      const [subcmd, ...rest] = args;
      switch (subcmd) {
        case 'search':
          return await runSearch(rest, ctx, overrides);
        case 'url':
          return runUrl(rest, ctx);
        case 'get':
          return await runGet(rest, ctx);
        default:
          throw new CliValidationError(
            `No such command '${subcmd}'. Run 'kinloom ca-archives --script-help'.`
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
}

export const runCaArchivesCommand: RecordHandler = createCaArchivesCommand();
