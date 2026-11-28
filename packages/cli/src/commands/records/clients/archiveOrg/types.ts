import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import type { UrlSecurityPolicy } from '../../runtime/http.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import { RecordRuntimeError } from '../../runtime/types.js';

export const BASE = 'https://archive.org';
export const ADVANCED_SEARCH = `${BASE}/advancedsearch.php`;
export const FULLTEXT_SEARCH = `${BASE}/services/search/beta/page_production/`;
export const USER_AGENT = 'kinloom archive-org skill (research use)';
export const DEFAULT_FIELDS = ['identifier', 'title', 'creator', 'date', 'mediatype'] as const;
export const DEFAULT_TIMEOUT_SECONDS = 25;
export const SEARCH_TIMEOUT_SECONDS = 30;
export const DOWNLOAD_TIMEOUT_SECONDS = 60;
export const DEFAULT_QUERY_TTL_HOURS = 168;
export const MAX_WORKERS = 6;
export const PAGE_BATCH_LIMIT = 25;
export const PAGE_BATCH_WORKERS = 4;
export const RETRYABLE_HTTP_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 522, 524]);
export const MAX_HTTP_RETRIES = 2;
export const MAX_RETRY_AFTER_SECONDS = 5;

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const ARCHIVE_URL_RE =
  /^https?:\/\/(?:www\.)?archive\.org\/(?:details|metadata|download)\/([^/?#]+)(?:\/.*)?(?:[?#].*)?$/i;

export const IMAGE_EXTS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export const IA_URL_POLICY: UrlSecurityPolicy = {
  allowedSchemes: ['https:'],
  allowedHosts: ['.archive.org'],
  blockPrivateIps: true,
};

export const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  metadata: 'get',
  show: 'get',
  pages: 'page',
};

export class ArchiveNotFoundError extends RecordRuntimeError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'ArchiveNotFoundError';
  }
}

export interface PageIndex {
  leaf_count: number;
  access_leaf_count: number;
  scandata_to_bookreader: Record<string, number>;
  bookreader_to_scandata: Record<string, number>;
  scandata_to_printed: Record<string, string>;
  bookreader_to_printed: Record<string, string>;
  printed_to_bookreader: Record<string, number>;
  printed_to_bookreader_ci: Record<string, number>;
  printed_to_scandata: Record<string, number>;
  segment_mode: string;
  djvu_source?: string | undefined;
}

export interface ItemFileEntry {
  readonly name?: string | undefined;
  readonly format?: string;
  readonly size?: string | number;
  readonly [key: string]: unknown;
}

export interface ItemMetadataPayload {
  readonly metadata?: Record<string, unknown>;
  readonly files?: readonly ItemFileEntry[];
  readonly [key: string]: unknown;
}

export interface ItemCacheEntry {
  readonly identifier: string;
  readonly itemDir: string;
  readonly metadataPath: string;
  readonly scandataPath: string;
  readonly pageIndexPath: string;
  readonly djvuPath: string;
  readonly cached: boolean;
}

export interface GrepHit {
  readonly identifier: string;
  readonly leaf: number | null;
  readonly scandata_leaf: number | null;
  readonly printed_page: string | null;
  readonly match: string;
  readonly snippet: string;
  readonly image_url: string | null;
  readonly details_url: string;
  cached?: boolean;
}

export interface PageJob {
  readonly leaf: number;
  readonly scandata_leaf: number | null;
  readonly printed_page: string | null;
  suffix: string;
  url: string;
}

export interface WrittenPageRow {
  readonly leaf: number;
  readonly scandata_leaf: number | null;
  readonly printed_page: string | null;
  readonly url: string;
  readonly path: string;
  readonly cache_path: string;
  readonly bytes: number;
  readonly page_cached: boolean;
}

export function isTruthyNonEmpty(value: unknown): boolean {
  if (!value) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isPlainRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

export function quotePathSegment(str: string): string {
  return encodeURIComponent(str)
    .replace(/%2F/gi, '/')
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeQueryPairs(pairs: readonly (readonly [string, string])[]): string {
  const enc = (value: string): string =>
    encodeURIComponent(value)
      .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%20/g, '+');
  return pairs.map(([key, value]) => `${enc(key)}=${enc(value)}`).join('&');
}

export function validateIdentifier(identifier: string): string {
  let cleaned = identifier.trim();
  const urlMatch = ARCHIVE_URL_RE.exec(cleaned);
  if (urlMatch) {
    cleaned = (urlMatch[1] ?? '').trim();
  }
  if (!cleaned || !SAFE_ID_RE.test(cleaned) || cleaned === '.' || cleaned === '..') {
    throw new RecordRuntimeError(`Invalid Internet Archive identifier: '${identifier}'`, 1);
  }
  return cleaned;
}

export function parseLeafInt(raw: string): number {
  const text = raw.trim();
  if (/^[nN]\d+$/.test(text)) {
    return Number.parseInt(text.slice(1), 10);
  }
  if (/^[+-]?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  throw new CliValidationError(`invalid leaf value: '${raw}' (expected integer like 12 or n12)`);
}

export function validateRelativeItemPath(name: string, filesRoot: string): readonly [string, string] {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')) {
    throw new CliValidationError(`Unsafe file path in item: '${name}'`);
  }
  const parts = name.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes(':')) {
      throw new CliValidationError(`Unsafe file path in item: '${name}'`);
    }
  }
  const rel = path.join(...parts);
  const rootResolved = path.resolve(filesRoot);
  const dest = path.resolve(rootResolved, rel);
  if (dest === rootResolved || !dest.startsWith(`${rootResolved}${path.sep}`)) {
    throw new CliValidationError(`Unsafe file path in item: '${name}'`);
  }
  return [rel, dest];
}

export function looksLikeIdentifierToken(token: string): boolean {
  const cleaned = token.trim();
  if (!cleaned) {
    return false;
  }
  if (ARCHIVE_URL_RE.test(cleaned)) {
    return true;
  }
  return SAFE_ID_RE.test(cleaned) && cleaned !== '.' && cleaned !== '..';
}

export function validatePositiveTimeout(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new CliValidationError(`--timeout must be > 0, got ${timeout}.`);
  }
  return timeout;
}

export function parseRetryAfterMsIa(
  retryAfterHeader: string | null | undefined,
  attempt: number,
  nowMs: number
): number {
  const maxMs = MAX_RETRY_AFTER_SECONDS * 1000;
  const defaultDelayMs = Math.min(maxMs, Math.round(500 * 2 ** attempt));
  if (!retryAfterHeader) {
    return defaultDelayMs;
  }
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) {
    return defaultDelayMs;
  }
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) {
    if (asNum < 0) {
      return defaultDelayMs;
    }
    return Math.min(maxMs, Math.round(asNum * 1000));
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const deltaMs = Math.max(0, parsedDate - nowMs);
    return Math.min(maxMs, Math.round(deltaMs));
  }
  return defaultDelayMs;
}

export function itemUrl(identifier: string): string {
  return `${BASE}/details/${quotePathSegment(identifier)}`;
}

export function pageImageUrl(
  identifier: string,
  leafN: number,
  options: { readonly scale?: number; readonly width?: number } = {}
): string {
  if (options.width !== undefined) {
    return `${BASE}/download/${quotePathSegment(identifier)}/page/n${leafN}_w${options.width}.jpg`;
  }
  const effectiveScale = options.scale !== undefined ? options.scale : 2;
  return `${BASE}/download/${quotePathSegment(identifier)}/page/n${leafN}_s${effectiveScale}.jpg`;
}

export function pageDetailsUrl(identifier: string, leafN: number): string {
  return `${BASE}/details/${quotePathSegment(identifier)}/page/n${leafN}`;
}

export function shortText(value: unknown, limit = 300): string {
  if (!value) {
    return '';
  }
  const cleaned = String(value).trim().replace(/\s+/g, ' ');
  if (cleaned.length <= limit) {
    return cleaned;
  }
  return `${cleaned.slice(0, limit).trimEnd()} ...`;
}

export function jsonWithCacheHit(
  payload: Readonly<Record<string, unknown>>,
  cacheHit: boolean
): Record<string, unknown> {
  return { ...payload, cache_hit: Boolean(cacheHit) };
}
