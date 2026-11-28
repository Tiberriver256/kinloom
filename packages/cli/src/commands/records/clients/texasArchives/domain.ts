import { CliValidationError } from '../../../../errors.js';
import { cleanHtmlText, parseXml } from '../../runtime/parse.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import { RecordRuntimeError } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const CACHE_SCHEMA = 1;

export const PORTAL_BASE = 'https://texashistory.unt.edu';
export const PORTAL_OPENSEARCH = `${PORTAL_BASE}/search/opensearch/`;
export const PORTAL_OAI = `${PORTAL_BASE}/oai/`;
export const TDA_BASE = 'https://tsl.access.preservica.com';
export const GLO_LAND = 'https://s3.glo.texas.gov/lookup/index.php';
export const TSLAC_HOME = 'https://www.tsl.texas.gov/';
export const TSLAC_RANGERS = 'https://www.tsl.texas.gov/agency/items/texas-rangers';

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface TexasOpenSearchEntry {
  readonly ark: string;
  readonly title: string;
  readonly creator: string;
  readonly date: string;
  readonly description: string;
  readonly type: string;
  readonly url: string;
  readonly thumbnail: string;
}

export interface TexasOpenSearchPage {
  readonly total: number;
  readonly page: number;
  readonly entries: readonly TexasOpenSearchEntry[];
}

export interface TexasOaiRecord {
  readonly oai_identifier: string;
  readonly ark: string;
  readonly titles: readonly string[];
  readonly creators: readonly string[];
  readonly subjects: readonly string[];
  readonly dates: readonly string[];
  readonly types: readonly string[];
  readonly descriptions: readonly string[];
  readonly set_specs: readonly string[];
  readonly url: string;
  readonly browser_note?: string;
}

export interface TexasTdaItem {
  readonly title: string;
  readonly url: string;
}

export interface TexasTdaCachePayload {
  readonly results: readonly TexasTdaItem[];
}

export function extractArkId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('ark:/')) {
    const match = /metap?th\d+|metadc\d+/.exec(trimmed);
    if (match) {
      return match[0];
    }
    const parts = trimmed.replace(/\/+$/, '').split('/');
    return parts.at(-1) || trimmed;
  }
  return trimmed;
}

export function normalizeArk(arkToken: string): string {
  return `ark:/67531/${extractArkId(arkToken)}`;
}

export function parseIsoDate(raw: string, flagName: string): string {
  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new CliValidationError(`Invalid ${flagName} '${raw}': expected YYYY-MM-DD.`);
  }
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  const day = Number.parseInt(match[3] ?? '', 10);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new CliValidationError(`Invalid ${flagName} '${raw}': not a real calendar date.`);
  }
  return trimmed;
}

export function parseItemDate(value: string | undefined): readonly [string | null, string | null] {
  if (!value) {
    return [null, null];
  }
  const trimmed = value.trim();
  const fullMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (fullMatch) {
    const iso = `${fullMatch[1]}-${fullMatch[2]}-${fullMatch[3]}`;
    return [iso, iso];
  }
  const rangeMatch = /^(\d{4})\/(\d{4})$/.exec(trimmed);
  if (rangeMatch) {
    return [`${rangeMatch[1]}-01-01`, `${rangeMatch[2]}-12-31`];
  }
  const yearMatch = /^(\d{4})$/.exec(trimmed);
  if (yearMatch) {
    return [`${yearMatch[1]}-01-01`, `${yearMatch[1]}-12-31`];
  }
  return [null, null];
}

export function entryMatchesFilters(
  entry: TexasOpenSearchEntry & { readonly subjects?: readonly string[] },
  county: string | undefined,
  typeFilter: string | undefined,
  dateFrom: string | undefined,
  dateTo: string | undefined
): boolean {
  if (typeFilter) {
    if ((entry.type || '').toLowerCase() !== typeFilter.toLowerCase()) {
      return false;
    }
  }
  if (county) {
    const blob = [entry.title, entry.description, ...(entry.subjects ?? [])]
      .filter((part): part is string => Boolean(part))
      .join(' ')
      .toLowerCase();
    if (!blob.includes(county.toLowerCase())) {
      return false;
    }
  }
  if (dateFrom || dateTo) {
    const [start, end] = parseItemDate(entry.date);
    if (start === null && end === null) {
      return false;
    }
    const lo = start ?? end;
    const hi = end ?? start;
    if (lo === null || hi === null) {
      return false;
    }
    if (dateFrom && hi < dateFrom) {
      return false;
    }
    if (dateTo && lo > dateTo) {
      return false;
    }
  }
  return true;
}

export function buildPortalQuery(query: string, county: string | undefined): string {
  const parts = [query.trim()];
  if (county?.trim()) {
    parts.push(county.trim());
  }
  return parts.filter(Boolean).join(' ');
}

export function mapOpenSearchEntry(raw: unknown): TexasOpenSearchEntry {
  const obj = isPlainRecord(raw) ? raw : {};
  const str = (key: string): string => (typeof obj[key] === 'string' ? obj[key] : '');
  return {
    ark: str('id'),
    title: str('title'),
    creator: str('dc:creator'),
    date: str('dc:date'),
    description: str('dc:description'),
    type: str('dc:type'),
    url: str('link'),
    thumbnail: str('thumbnail'),
  };
}

export function isTexasOpenSearchPage(value: unknown): value is TexasOpenSearchPage {
  return (
    isPlainRecord(value) &&
    typeof value['total'] === 'number' &&
    typeof value['page'] === 'number' &&
    Array.isArray(value['entries'])
  );
}

export function isTexasOaiRecord(value: unknown): value is TexasOaiRecord {
  return (
    isPlainRecord(value) &&
    typeof value['ark'] === 'string' &&
    Array.isArray(value['titles']) &&
    typeof value['url'] === 'string'
  );
}

export function isTexasTdaCachePayload(value: unknown): value is TexasTdaCachePayload {
  return isPlainRecord(value) && Array.isArray(value['results']);
}

function extractXmlNodeText(node: unknown): string {
  if (typeof node === 'string') {
    return node.trim();
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    return String(node).trim();
  }
  if (isPlainRecord(node) && typeof node['#text'] === 'string') {
    return node['#text'].trim();
  }
  return '';
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value as T];
}

function findChildByLocalName(parent: Record<string, unknown>, localName: string): unknown {
  if (localName in parent) {
    return parent[localName];
  }
  for (const [key, val] of Object.entries(parent)) {
    const colon = key.indexOf(':');
    if (colon !== -1 && key.slice(colon + 1) === localName) {
      return val;
    }
  }
  return undefined;
}

function collectDcValues(node: unknown, dcKey: string, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectDcValues(item, dcKey, out);
    }
    return;
  }
  if (!isPlainRecord(node)) {
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text') {
      continue;
    }
    if (key === dcKey) {
      for (const item of toArray<unknown>(val)) {
        const text = extractXmlNodeText(item);
        if (text) {
          out.push(text);
        }
      }
    } else {
      collectDcValues(val, dcKey, out);
    }
  }
}

export function parseOaiRecord(xmlText: string): TexasOaiRecord {
  let parsed: unknown;
  try {
    parsed = parseXml(xmlText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`OAI response was not valid XML: ${message}`);
  }
  if (!isPlainRecord(parsed)) {
    throw new RecordRuntimeError('OAI response was not valid XML');
  }
  const rootRaw = findChildByLocalName(parsed, 'OAI-PMH');
  if (!isPlainRecord(rootRaw)) {
    throw new RecordRuntimeError('OAI response was not valid XML: missing OAI-PMH root');
  }

  const errRaw = findChildByLocalName(rootRaw, 'error');
  if (errRaw !== undefined) {
    const firstErr = toArray<unknown>(errRaw)[0];
    const code =
      isPlainRecord(firstErr) && typeof firstErr['@_code'] === 'string' ? firstErr['@_code'] : 'error';
    const msg = extractXmlNodeText(firstErr);
    throw new RecordRuntimeError(`OAI error ${code}: ${msg}`);
  }

  const getRecord = findChildByLocalName(rootRaw, 'GetRecord');
  const recRaw = isPlainRecord(getRecord)
    ? findChildByLocalName(getRecord, 'record')
    : findChildByLocalName(rootRaw, 'record');
  const rec = toArray<unknown>(recRaw).find(isPlainRecord);
  if (!rec) {
    throw new RecordRuntimeError('OAI response had no record');
  }

  const headerRaw = findChildByLocalName(rec, 'header');
  let identifier = '';
  const setSpecs: string[] = [];
  if (isPlainRecord(headerRaw)) {
    identifier = extractXmlNodeText(findChildByLocalName(headerRaw, 'identifier'));
    for (const s of toArray<unknown>(findChildByLocalName(headerRaw, 'setSpec'))) {
      const val = extractXmlNodeText(s);
      if (val) {
        setSpecs.push(val);
      }
    }
  }

  const titles: string[] = [];
  const creators: string[] = [];
  const subjects: string[] = [];
  const dates: string[] = [];
  const types: string[] = [];
  const descriptions: string[] = [];
  collectDcValues(rec, 'dc:title', titles);
  collectDcValues(rec, 'dc:creator', creators);
  collectDcValues(rec, 'dc:subject', subjects);
  collectDcValues(rec, 'dc:date', dates);
  collectDcValues(rec, 'dc:type', types);
  collectDcValues(rec, 'dc:description', descriptions);

  const arkMatch = /metap?th\d+|metadc\d+/.exec(identifier);
  const ark = arkMatch ? `ark:/67531/${arkMatch[0]}` : '';

  return {
    oai_identifier: identifier,
    ark,
    titles,
    creators,
    subjects,
    dates,
    types,
    descriptions,
    set_specs: setSpecs,
    url: ark ? `${PORTAL_BASE}/${ark}/` : '',
  };
}

export function parseTdaRss(feed: string, limit?: number): TexasTdaItem[] {
  if (feed.slice(0, 500).includes('403 Forbidden') && !feed.includes('<rss')) {
    throw new RecordRuntimeError('TDA RSS returned a 403 page to curl');
  }
  const results: TexasTdaItem[] = [];
  const seen = new Set<string>();
  try {
    const parsed = parseXml(feed, {
      isArray: (tagName) => tagName === 'item',
    });
    if (isPlainRecord(parsed)) {
      const rssNode = isPlainRecord(parsed['rss']) ? parsed['rss'] : parsed;
      const channel = isPlainRecord(rssNode['channel']) ? rssNode['channel'] : undefined;
      const items = channel ? toArray<unknown>(channel['item']) : [];
      for (const rawItem of items) {
        if (!isPlainRecord(rawItem)) {
          continue;
        }
        const rawTitle = extractXmlNodeText(rawItem['title']);
        const link = extractXmlNodeText(rawItem['link']);
        if (!rawTitle || !link || seen.has(link)) {
          continue;
        }
        seen.add(link);
        const title = cleanHtmlText(rawTitle);
        if (title.toLowerCase().startsWith('search results for')) {
          continue;
        }
        if (title) {
          results.push({ title, url: link });
        }
        if (limit !== undefined && results.length >= limit) {
          break;
        }
      }
    }
  } catch {
    // Non-XML response produces empty list so caller won't cache it.
  }
  return results;
}
