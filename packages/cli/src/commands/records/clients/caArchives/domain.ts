import { BrowserTimeoutError, type ChromiumLauncher } from '../../runtime/browser.js';
import { resolveCacheDir } from '../../runtime/cache.js';
import { collapseWhitespace, loadHtml } from '../../runtime/parse.js';
import {
  encodeUrlPathPreservingSlashes,
  isPlainRecord,
  resolveEnvCacheTtlHours,
} from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const DEFAULT_SEARCH_TIMEOUT_SEC = 45;
export const CACHE_SCHEMA = 1;

export const OAC_BASE = 'https://oac.cdlib.org';
export const CALISPHERE_BASE = 'https://calisphere.org';
export const PORTAL_BASE = 'https://archives.sos.ca.gov';
export const EXHIBITS_BASE = 'https://exhibits.sos.ca.gov';
export const CDNC_BASE = 'https://cdnc.ucr.edu/cgi-bin/cdnc';
export const MINERVA_URL =
  'https://gencat.sos.ca.gov/webcat/request/DoMenuRequest' +
  '?SystemName=California+State+Archives&UserName=csa+public&Password=' +
  '&TemplateProcessID=6000_3355&bCachable=1&MenuName=Minerva+Online+Catalog';

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const SEARCHABLE_SOURCES = ['oac', 'calisphere', 'portal', 'exhibits'] as const;
export type CaSearchableSource = (typeof SEARCHABLE_SOURCES)[number];

export const ALL_SOURCES = ['oac', 'calisphere', 'portal', 'exhibits', 'cdnc', 'minerva'] as const;
export type CaSource = (typeof ALL_SOURCES)[number];

export interface CaSearchResultItem {
  readonly id?: string | undefined;
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
  readonly closeTimeoutMs?: number | undefined;
  readonly killGraceMs?: number | undefined;
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

export interface RawBrowserLink {
  readonly href?: string;
  readonly text?: string;
}

export function isTimeoutFailure(err: unknown): boolean {
  if (err instanceof BrowserTimeoutError) {
    return true;
  }
  if (err instanceof Error) {
    return err.name === 'TimeoutError' || /timed?\s*out/i.test(err.message);
  }
  return false;
}

export function isNavigationContextDestroyed(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /execution context was destroyed|most likely because of a navigation/i.test(message);
}

export function oacUrl(query: string): string {
  return `${OAC_BASE}/search?q=${encodeUrlPathPreservingSlashes(query)}`;
}

export function calisphereUrl(query: string): string {
  return `${CALISPHERE_BASE}/search/?q=${encodeUrlPathPreservingSlashes(query)}`;
}

export function portalUrl(query: string): string {
  return `${PORTAL_BASE}/Items?SearchText=${encodeUrlPathPreservingSlashes(query)}`;
}

export function exhibitsUrl(query: string, limit = 10): string {
  return `${EXHIBITS_BASE}/api/items?search=${encodeUrlPathPreservingSlashes(query)}&per_page=${encodeUrlPathPreservingSlashes(String(limit))}`;
}

export function cdncUrl(query: string): string {
  return `${CDNC_BASE}?a=q&r=1&results=1&txq=${encodeUrlPathPreservingSlashes(query)}&e=-------en--20--1--txt-txIN-------`;
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
  const total = totalMatch ? Number.parseInt(totalMatch[1] ?? '', 10) : null;

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
    if (!title || itemId === undefined || seenIds.has(itemId)) {
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

export function parsePortalItemHtml(html: string, portalId: string, url: string): CaPortalItem {
  const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
  const rawTitle = titleMatch ? (titleMatch[1] ?? '').trim() : '(no title)';
  const title = rawTitle.replace(' | California Archives Search', '');
  return {
    source: 'portal',
    id: portalId,
    title,
    url,
  };
}

export function extractOmekaTitle(item: Record<string, unknown>): string {
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

export function extractOmekaTypes(item: Record<string, unknown>): string {
  const raw = item['@type'];
  if (!Array.isArray(raw)) {
    return '';
  }
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry !== 'o:Item').join(', ');
}

export function parseExhibitsSearchPayload(
  rawJson: string,
  url: string,
  totalHeader: string | null
): CaSourceEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Invalid JSON from ${url}: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new RecordRuntimeError(`Unexpected JSON response from ${url}`);
  }
  const parsedHdr = totalHeader ? Number.parseInt(totalHeader, 10) : Number.NaN;
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

export function parseExhibitsItemPayload(rawJson: string, exhibitsId: string, url: string): CaExhibitsItem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
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

export function makeTimedOutEntry(source: CaSearchableSource, url: string, message: string): CaSourceEntry {
  return {
    source,
    url,
    total: null,
    results: [],
    timed_out: true,
    error: message,
  };
}

export function isSourceCacheable(entry: CaSourceEntry): boolean {
  return !entry.timed_out && !entry.error && (entry.results.length > 0 || entry.total !== null);
}

export function isCaSourceEntry(value: unknown): value is CaSourceEntry {
  return (
    isPlainRecord(value) &&
    typeof value['source'] === 'string' &&
    typeof value['url'] === 'string' &&
    Array.isArray(value['results'])
  );
}

export function isCaPortalItem(value: unknown): value is CaPortalItem {
  return (
    isPlainRecord(value) &&
    value['source'] === 'portal' &&
    typeof value['id'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['url'] === 'string'
  );
}

export function isCaExhibitsItem(value: unknown): value is CaExhibitsItem {
  return (
    isPlainRecord(value) &&
    value['source'] === 'exhibits' &&
    typeof value['id'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['url'] === 'string'
  );
}

export function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_CA_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-ca-archives',
  });
}

export function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_CA_ARCHIVES_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export function formatSourceText(entry: CaSourceOutput): string[] {
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
