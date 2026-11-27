import { resolveCacheDir } from '../../runtime/cache.js';
import { loadHtml, parseXml, cleanHtmlText as runtimeCleanHtmlText } from '../../runtime/parse.js';
import {
  encodeUrlPathPreservingSlashes,
  isPlainRecord,
  resolveEnvCacheTtlHours,
} from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const CACHE_SCHEMA = 1;

export const CDM_BASE = 'https://www.kyhistory.com';
export const CDM_API = `${CDM_BASE}/digital/api`;
export const LAND_URL = 'https://web.sos.ky.gov/land/ccorders.aspx';
export const PRESERVICA_BASE = 'https://kdla.access.preservica.com';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const LAND_BY: Readonly<Record<string, string>> = {
  grantee: 'GrantHR',
  patent: 'Patent',
  'grant-book': 'GRNTBKPG',
  county: 'County',
  watercourse: 'Water',
  'survey-name': 'SurName',
  'survey-year': 'Sur_Date',
  'grant-year': 'GrantDte',
  warrant: 'Warrant',
};

export const LAND_BY_CHOICES = Object.keys(LAND_BY).toSorted();
export const LAND_LIMIT_CHOICES = ['10', '25', '50', '100'] as const;

export interface CdmTrimmedItem {
  readonly collectionAlias: unknown;
  readonly itemId: unknown;
  readonly title: unknown;
  readonly filetype: unknown;
  readonly itemLink: unknown;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface CdmSearchPayload {
  readonly totalResults: number;
  readonly items: readonly CdmTrimmedItem[];
  readonly verified: boolean;
}

export interface KyLandRecord {
  readonly patent: string;
  readonly grantee: string;
  readonly grant_book_page: string;
  readonly acreage: string;
  readonly county: string;
  readonly watercourse: string;
  readonly survey_name: string;
  readonly survey_date: string;
  readonly grant_date: string;
  readonly grant_note: string;
}

export interface KyLandPayload {
  readonly totalResults: number;
  readonly results: readonly KyLandRecord[];
  readonly verified: boolean;
}

export interface KyPreservicaItem {
  readonly title: string;
  readonly url: string;
}

export interface KyPreservicaPayload {
  readonly search_url: string;
  readonly feed_url: string;
  readonly results: readonly KyPreservicaItem[];
  readonly verified: boolean;
}

export function cleanHtmlText(html: string): string {
  return runtimeCleanHtmlText(html, { stripScriptsAndStyles: true });
}

function extractXmlText(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (isPlainRecord(node) && typeof node['#text'] === 'string') {
    return node['#text'];
  }
  return '';
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value as T];
}

export function getKyCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_KY_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-ky-archives',
  });
}

export function resolveKyTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_KY_ARCHIVES_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export function trimCdmSearchData(data: Record<string, unknown>): CdmSearchPayload {
  const rawTotal = data.totalResults;
  const total = typeof rawTotal === 'number' ? rawTotal : 0;
  const rawItems = Array.isArray(data.items) ? data.items : [];

  const trimmed: CdmTrimmedItem[] = [];
  for (const item of rawItems) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const fields: Record<string, unknown> = {};
    const metaFields = item.metadataFields;
    if (Array.isArray(metaFields)) {
      for (const entry of metaFields) {
        if (isPlainRecord(entry) && typeof entry.field === 'string') {
          fields[entry.field] = entry.value;
        }
      }
    }
    trimmed.push({
      collectionAlias: item.collectionAlias ?? null,
      itemId: item.itemId ?? null,
      title: item.title ?? null,
      filetype: item.filetype ?? null,
      itemLink: item.itemLink ?? null,
      fields,
    });
  }

  const verified = Array.isArray(data.items) && typeof data.totalResults === 'number';
  return { totalResults: total, items: trimmed, verified };
}

export function isCdmSearchPayload(value: unknown): value is CdmSearchPayload {
  return (
    isPlainRecord(value) &&
    typeof value.totalResults === 'number' &&
    Array.isArray(value.items) &&
    typeof value.verified === 'boolean'
  );
}

export function extractAspState(htmlText: string): Record<string, string> {
  const $ = loadHtml(htmlText);
  return {
    __VIEWSTATE: $('input[name="__VIEWSTATE"]').attr('value') ?? '',
    __VIEWSTATEGENERATOR: $('input[name="__VIEWSTATEGENERATOR"]').attr('value') ?? '',
    __EVENTVALIDATION: $('input[name="__EVENTVALIDATION"]').attr('value') ?? '',
  };
}

export function parseLandResults(pageHtml: string): KyLandPayload {
  const text = cleanHtmlText(pageHtml);
  const totalMatch = /(\d+) Results found/.exec(text);
  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : 0;
  const body = totalMatch ? text.slice(totalMatch.index + totalMatch[0].length) : text;
  const entries = body.split(/\d+\) Patent #/);
  const fieldRe =
    /^\s*([\d.]+)\s+Grantee:\s*([\s\S]*?)\s+Grant Book & Pg:\s*([\s\S]*?)\s+Acreage:\s*([\s\S]*?)\s+County:\s*([\s\S]*?)\s+WaterCourse:\s*([\s\S]*?)\s+Survey Name:\s*([\s\S]*?)\s+Survey Date:\s*([\s\S]*?)\s+Grant Date:\s*([\s\S]*?)\s+Grant Note:\s*([\s\S]*?)\s*$/;

  const results: KyLandRecord[] = [];
  for (const chunk of entries.slice(1)) {
    const match = fieldRe.exec(chunk);
    if (!match) {
      continue;
    }
    results.push({
      patent: match[1].trim(),
      grantee: match[2].trim(),
      grant_book_page: match[3].trim(),
      acreage: match[4].trim(),
      county: match[5].trim(),
      watercourse: match[6].trim(),
      survey_name: match[7].trim(),
      survey_date: match[8].trim(),
      grant_date: match[9].trim(),
      grant_note: match[10].trim(),
    });
  }

  const verified = results.length > 0 || totalMatch !== null;
  return { totalResults: total, results, verified };
}

export function isKyLandPayload(value: unknown): value is KyLandPayload {
  return (
    isPlainRecord(value) &&
    typeof value.totalResults === 'number' &&
    Array.isArray(value.results) &&
    typeof value.verified === 'boolean'
  );
}

export function parsePreservicaRss(
  feed: string,
  query: string,
  feedUrl: string,
  limit: number
): KyPreservicaPayload {
  const lower = feed.toLowerCase();
  const isRss = lower.includes('<rss') || lower.includes('<channel>');
  const results: KyPreservicaItem[] = [];
  const seen = new Set<string>();

  try {
    const parsed = parseXml<unknown>(feed, {
      isArray: (tagName) => tagName === 'item',
    });
    if (isPlainRecord(parsed)) {
      const rssNode = isPlainRecord(parsed.rss) ? parsed.rss : parsed;
      const channel = isPlainRecord(rssNode.channel) ? rssNode.channel : undefined;
      const items = channel ? toArray<unknown>(channel.item) : [];
      for (const rawItem of items) {
        if (!isPlainRecord(rawItem)) {
          continue;
        }
        const rawTitle = extractXmlText(rawItem.title);
        const rawLink = extractXmlText(rawItem.link).trim();
        if (!rawTitle || !rawLink || seen.has(rawLink)) {
          continue;
        }
        seen.add(rawLink);
        const title = cleanHtmlText(rawTitle);
        if (title) {
          results.push({ title, url: rawLink });
        }
        if (results.length >= limit) {
          break;
        }
      }
    }
  } catch {
    // Non-XML responses (e.g. HTML block pages) yield empty unverified results.
  }

  return {
    search_url: `${PRESERVICA_BASE}/?s=${encodeUrlPathPreservingSlashes(query)}`,
    feed_url: feedUrl,
    results,
    verified: results.length > 0 || isRss,
  };
}

export function isKyPreservicaPayload(value: unknown): value is KyPreservicaPayload {
  return (
    isPlainRecord(value) &&
    typeof value.search_url === 'string' &&
    typeof value.feed_url === 'string' &&
    Array.isArray(value.results) &&
    typeof value.verified === 'boolean'
  );
}

export function buildCdmWebUrl(query: string): string {
  return `${CDM_BASE}/cdm/search/searchterm/${encodeUrlPathPreservingSlashes(query)}/mode/exact`;
}

export function buildKyUrlsLines(query: string): readonly string[] {
  const encoded = encodeUrlPathPreservingSlashes(query);
  return [
    'KHS Digital Collections (CONTENTdm web search):',
    `  ${CDM_BASE}/cdm/search/searchterm/${encoded}/mode/exact`,
    'KDLA Preservica e-archives (WordPress search):',
    `  ${PRESERVICA_BASE}/?s=${encoded}`,
    'Land Office, County Court Orders patents (form search, no GET URL):',
    `  ${LAND_URL}`,
    'Pass the Word oral histories (browse/search in browser):',
    '  https://passtheword.ky.gov/',
    'KHS research starting page:',
    '  https://history.ky.gov/research-genealogy',
  ];
}
