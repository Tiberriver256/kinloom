import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  assertSafeUrl,
  atomicWriteFileSync,
  type CommandParseSpec,
  canonicalJsonStringify,
  emitJsonStdout,
  emitStdout,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  type OptionSpec,
  parseCacheTtlHours,
  parseCommandArgs,
  parseRetryAfterMs,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  resolveCacheDir,
  resolveSubcommandAlias,
  sha256Hex,
  withAdvisoryLock,
} from '../runtime/index.js';

export const GRAPHQL_URL = 'https://www.findagrave.com/orc/graphql';
export const WEBSITE_BASE = 'https://www.findagrave.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const MIN_INTERVAL_MS = 300;
const DEFAULT_CACHE_TTL_HOURS = 168;
const GQL_ATTEMPTS = 3;
const PHOTO_ATTEMPTS = 3;
const GQL_TIMEOUT_MS = 30_000;
const PHOTO_TIMEOUT_MS = 60_000;
const RETRY_AFTER_CAP_MS = 10_000;
const MAX_REDIRECTS = 10;

const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 522, 524]);
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const VALID_YEAR_FILTERS: ReadonlySet<string> = new Set(['before', 'after', 'exact', 'unknown']);
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_EXT_RE = /^\.[A-Za-z0-9]{1,8}$/;
const MEMORIAL_URL_RE = /^https:\/\/(?:www\.)?findagrave\.com\/memorial\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i;
const CEMETERY_URL_RE = /^https:\/\/(?:www\.)?findagrave\.com\/cemetery\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i;
const PHOTO_ALLOWED_SUFFIXES = ['findagrave.com', 'ancestrycdn.com', 'cloudfront.net'] as const;
const GQL_ALLOWED_HOSTS = ['.findagrave.com'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export const SEARCH_QUERY = `
query($s: MemorialSearchInput) {
  memorialSearch(search: $s) {
    total
    memorials {
      id
      name { first last maiden }
      birth { date { year month day circa } place { names { name } } }
      death { date { year month day circa } place { names { name } } }
      cemetery { id names { name } memorialCount coordinates { lat lon } }
      plot
      hasGravePhoto
      isVeteran
    }
  }
}
`;

export const GET_QUERY = `
query($ids: [ID!]!) {
  memorialsById(ids: $ids) {
    id
    name { first last maiden }
    birth { date { year month day circa } place { names { name } } }
    death { date { year month day circa } place { names { name } } }
    coordinates { lat lon }
    cemetery {
      id
      names { name }
      memorialCount
      coordinates { lat lon }
      physicalAddress { full { value } }
    }
    plot
    inscription { value }
    bio { value }
    isVeteran
    hasGravePhoto
    hasPersonPhoto
    dateCreated
    dateModified
    relationships { type yearMarried memorial { id name { first last } } }
    photos(size: 50) { total photos { id path caption type } }
  }
}
`;

export const CEMETERY_QUERY = `
query($s: CemeterySearchInput) {
  cemeteries(search: $s) {
    total
    cemeteries {
      id
      names { name }
      memorialCount
      coordinates { lat lon }
      physicalAddress { full { value } }
    }
  }
}
`;

export const CEMETERY_BY_ID_QUERY = `
query($ids: [ID!]) {
  cemeteries(ids: $ids) {
    total
    cemeteries {
      id
      names { name }
      memorialCount
      coordinates { lat lon }
      physicalAddress { full { value } }
    }
  }
}
`;

export const PLACE_QUERY = `
query($s: LocationSearchInput) {
  locationsByTypeahead(search: $s) {
    total
    locations {
      __typename
      ... on Location { id names { name } type }
      ... on Cemetery { id names { name } memorialCount }
    }
  }
}
`;

type JsonRecord = Record<string, unknown>;

interface PhotoSavedItem {
  readonly id: unknown;
  readonly type: unknown;
  readonly caption: unknown;
  readonly url: string;
  readonly file: string;
  readonly bytes: number;
  readonly cache_hit: boolean;
}

class IncompletePhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompletePhotoError';
  }
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 32) {
      return true;
    }
  }
  return false;
}

export function getCacheRoot(env: NodeJS.ProcessEnv): string {
  return resolveCacheDir({
    env,
    envVars: ['KINLOOM_FINDAGRAVE_CACHE_DIR'],
    defaultSubdir: 'kinloom-findagrave',
  });
}

export function resolveCacheTtlHours(cliTtl: number | undefined, env: NodeJS.ProcessEnv): number {
  if (cliTtl !== undefined) {
    return parseCacheTtlHours(cliTtl, DEFAULT_CACHE_TTL_HOURS, '--cache-ttl-hours');
  }
  const rawEnv = env.KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS;
  const trimmed = rawEnv !== undefined ? rawEnv.trim() : '';
  if (trimmed.length > 0) {
    return parseCacheTtlHours(trimmed, DEFAULT_CACHE_TTL_HOURS, 'KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS');
  }
  return DEFAULT_CACHE_TTL_HOURS;
}

export function validateEntityId(rawId: string, label = 'id'): string {
  const cleaned = String(rawId).trim();
  if (!cleaned || cleaned.includes('\0')) {
    throw new CliValidationError(`Invalid ${label}: '${rawId}'`);
  }
  if (cleaned.toLowerCase().startsWith('https://')) {
    const labelLower = label.toLowerCase();
    let match: RegExpExecArray | null;
    if (labelLower.includes('cemetery')) {
      match = CEMETERY_URL_RE.exec(cleaned);
    } else if (labelLower.includes('memorial')) {
      match = MEMORIAL_URL_RE.exec(cleaned);
    } else {
      match = MEMORIAL_URL_RE.exec(cleaned) ?? CEMETERY_URL_RE.exec(cleaned);
    }
    if (match?.[1]) {
      return match[1];
    }
    throw new CliValidationError(`Invalid ${label}: '${rawId}'`);
  }
  if (!SAFE_ID_RE.test(cleaned) || cleaned === '.' || cleaned === '..') {
    throw new CliValidationError(`Invalid ${label}: '${rawId}'`);
  }
  return cleaned;
}

export function validatePhotoUrl(rawUrl: string): string {
  const text = String(rawUrl || '').trim();
  if (!text || text.includes('\0') || hasControlChar(text)) {
    throw new RecordRuntimeError(`Invalid photo URL: '${rawUrl}'`);
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new RecordRuntimeError(`Invalid photo URL: '${rawUrl}'`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    !host ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new RecordRuntimeError(`Refusing non-HTTPS or disallowed photo URL: ${text}`);
  }
  const allowed = PHOTO_ALLOWED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed) {
    throw new RecordRuntimeError(`Refusing photo download from disallowed host '${host}': ${text}`);
  }
  return text;
}

export function sanitizePrefix(prefix: string | undefined): string {
  if (!prefix) {
    return '';
  }
  const cleaned = prefix.trim().replace(/^_+|_+$/g, '');
  if (
    !cleaned ||
    cleaned.includes('\0') ||
    cleaned.includes('/') ||
    cleaned.includes('\\') ||
    cleaned.includes('..') ||
    cleaned.includes(':')
  ) {
    throw new CliValidationError(`Invalid --prefix value: '${prefix}'`);
  }
  const safe = cleaned.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!safe) {
    throw new CliValidationError(`Invalid --prefix value: '${prefix}'`);
  }
  return `${safe}_`;
}

export function safePhotoFilename(photoId: unknown, url: string): string {
  const rawId = String(photoId ?? '').trim();
  const safeId = !rawId || !SAFE_ID_RE.test(rawId) ? sha256Hex(url || rawId).slice(0, 16) : rawId;
  const withoutQuery = url.split('?', 1)[0] ?? '';
  const rawSuffix = path.extname(withoutQuery).toLowerCase();
  const suffix = SAFE_EXT_RE.test(rawSuffix) ? rawSuffix : '.jpg';
  return `${safeId}${suffix}`;
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
    throw new RecordRuntimeError(`Unsafe filename: '${filename}'`);
  }
  const rootResolved = path.resolve(root);
  const dest = path.resolve(rootResolved, filename);
  const rel = path.relative(rootResolved, dest);
  if (dest === rootResolved || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new RecordRuntimeError(`Unsafe path escaping root: '${filename}'`);
  }
  return dest;
}

function readJsonIfValid(filePath: string): JsonRecord | undefined {
  try {
    if (!fs.statSync(filePath).isFile()) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function atomicWriteCompactJson(dest: string, payload: unknown): void {
  atomicWriteFileSync(dest, JSON.stringify(payload));
}

function atomicCopyFile(src: string, dest: string): void {
  const data = fs.readFileSync(src);
  atomicWriteFileSync(dest, data);
}

function readFreshEnvelope(filePath: string, ttlHours: number, nowMs: () => number): JsonRecord | undefined {
  const ttlSeconds = ttlHours * 3600;
  if (ttlSeconds <= 0) {
    return undefined;
  }
  const envelope = readJsonIfValid(filePath);
  if (!envelope) {
    return undefined;
  }
  const cachedAt = envelope.cached_at;
  const data = envelope.data;
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || !isPlainRecord(data)) {
    return undefined;
  }
  if (nowMs() / 1000 - cachedAt <= ttlSeconds) {
    return data;
  }
  return undefined;
}

function retryDelayMs(attempt: number, response: Response | undefined, nowMs: () => number): number {
  if (response) {
    const parsed = parseRetryAfterMs(response.headers.get('retry-after'), nowMs(), RETRY_AFTER_CAP_MS);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return Math.min(RETRY_AFTER_CAP_MS, 500 * 2 ** (attempt - 1));
}

function looksLikeHtmlBytes(content: Uint8Array): boolean {
  const sample = Buffer.from(content.subarray(0, 128)).toString('utf8').trimStart().toLowerCase();
  return (
    sample.startsWith('<html') ||
    sample.startsWith('<!doctype') ||
    sample.startsWith('<head') ||
    sample.startsWith('<body')
  );
}

function imageContentType(contentType: string | null): string | undefined {
  if (!contentType) {
    return undefined;
  }
  const base = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return IMAGE_CONTENT_TYPES.has(base) ? base : undefined;
}

function hasImageMagic(content: Uint8Array): boolean {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return true;
  }
  if (
    content.length >= 8 &&
    content[0] === 0x89 &&
    content[1] === 0x50 &&
    content[2] === 0x4e &&
    content[3] === 0x47 &&
    content[4] === 0x0d &&
    content[5] === 0x0a &&
    content[6] === 0x1a &&
    content[7] === 0x0a
  ) {
    return true;
  }
  if (content.length >= 6) {
    const head6 = Buffer.from(content.subarray(0, 6)).toString('ascii');
    if (head6 === 'GIF87a' || head6 === 'GIF89a') {
      return true;
    }
  }
  if (content.length >= 12) {
    const riff = Buffer.from(content.subarray(0, 4)).toString('ascii');
    const webp = Buffer.from(content.subarray(8, 12)).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') {
      return true;
    }
  }
  return false;
}

function photoBytesAccepted(content: Uint8Array, contentType: string | null): boolean {
  if (content.length === 0 || looksLikeHtmlBytes(content)) {
    return false;
  }
  if (hasImageMagic(content)) {
    return true;
  }
  return imageContentType(contentType) !== undefined;
}

function photoTypeNotePath(filePath: string): string {
  return `${filePath}.type`;
}

function cachedPhotoBytesOk(filePath: string, content: Uint8Array): boolean {
  if (content.length === 0 || looksLikeHtmlBytes(content)) {
    return false;
  }
  if (hasImageMagic(content)) {
    return true;
  }
  const notePath = photoTypeNotePath(filePath);
  try {
    if (!fs.statSync(notePath).isFile()) {
      return false;
    }
    const stored = fs.readFileSync(notePath, 'utf8');
    return imageContentType(stored) !== undefined;
  } catch {
    return false;
  }
}

function photoCacheFresh(filePath: string, ttlHours: number, nowMs: () => number): boolean {
  const ttlSeconds = ttlHours * 3600;
  if (ttlSeconds <= 0) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if ((nowMs() - stat.mtimeMs) / 1000 > ttlSeconds) {
      return false;
    }
    const content = fs.readFileSync(filePath);
    return cachedPhotoBytesOk(filePath, content);
  } catch {
    return false;
  }
}

function storePhotoCache(filePath: string, content: Uint8Array, contentType: string | null): void {
  atomicWriteFileSync(filePath, content);
  const notePath = photoTypeNotePath(filePath);
  const imgType = imageContentType(contentType);
  if (imgType && !hasImageMagic(content)) {
    atomicWriteFileSync(notePath, `${imgType}\n`);
  } else {
    try {
      if (fs.statSync(notePath).isFile()) {
        fs.unlinkSync(notePath);
      }
    } catch {
      // Ignore missing .type sidecar.
    }
  }
}

async function fetchWithTimeout(
  ctx: RecordCommandContext,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await ctx.fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function runGraphqlQuery(
  ctx: RecordCommandContext,
  query: string,
  variables: JsonRecord
): Promise<JsonRecord> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
  const bodyString = JSON.stringify({ query, variables });

  await ctx.sleepFn(MIN_INTERVAL_MS);

  for (let attempt = 1; attempt <= GQL_ATTEMPTS; attempt += 1) {
    let resp: Response | undefined;
    try {
      let currentUrl = GRAPHQL_URL;
      let currentMethod: 'POST' | 'GET' = 'POST';
      let currentBody: string | undefined = bodyString;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        assertSafeUrl(currentUrl, {
          allowedSchemes: ['https:'],
          allowedHosts: GQL_ALLOWED_HOSTS,
        });
        const init: RequestInit = {
          method: currentMethod,
          headers,
          ...(currentBody !== undefined && currentMethod === 'POST' ? { body: currentBody } : {}),
        };
        resp = await fetchWithTimeout(ctx, currentUrl, init, GQL_TIMEOUT_MS);
        if (REDIRECT_STATUSES.has(resp.status)) {
          const location = resp.headers.get('location');
          if (!location) {
            break;
          }
          if (hop === MAX_REDIRECTS) {
            throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${GRAPHQL_URL}`);
          }
          const nextUrl = new URL(location, currentUrl).toString();
          assertSafeUrl(nextUrl, {
            allowedSchemes: ['https:'],
            allowedHosts: GQL_ALLOWED_HOSTS,
          });
          currentUrl = nextUrl;
          if (resp.status === 303 || resp.status === 301 || resp.status === 302) {
            currentMethod = 'GET';
            currentBody = undefined;
          }
          continue;
        }
        break;
      }
    } catch (err: unknown) {
      if (err instanceof RecordRuntimeError) {
        throw err;
      }
      if (attempt < GQL_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, undefined, ctx.nowMs));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(`Request failed after ${GQL_ATTEMPTS} attempts: ${message}`);
    }

    if (!resp) {
      throw new RecordRuntimeError(`Request failed for ${GRAPHQL_URL}`);
    }

    if (resp.status === 403) {
      throw new RecordRuntimeError(
        'Find a Grave returned 403 (Cloudflare challenge). Wait a few minutes and retry, or use the website in a browser.'
      );
    }

    if (TRANSIENT_STATUS_CODES.has(resp.status)) {
      if (attempt < GQL_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
        continue;
      }
      throw new RecordRuntimeError(`HTTP ${resp.status} from ${GRAPHQL_URL} after ${GQL_ATTEMPTS} attempts`);
    }

    if (resp.status !== 200) {
      throw new RecordRuntimeError(`HTTP ${resp.status} from ${GRAPHQL_URL}`);
    }

    const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();
    const rawBytes = Buffer.from(await resp.arrayBuffer());

    if (contentType.includes('html') || looksLikeHtmlBytes(rawBytes)) {
      if (attempt < GQL_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
        continue;
      }
      throw new RecordRuntimeError(
        `Find a Grave returned an HTML error page instead of JSON from ${GRAPHQL_URL}`
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBytes.toString('utf8'));
    } catch (err: unknown) {
      if (attempt < GQL_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(`Invalid JSON from ${GRAPHQL_URL}: ${message}`);
    }

    if (!isPlainRecord(parsedBody)) {
      throw new RecordRuntimeError(`Unexpected GraphQL payload from ${GRAPHQL_URL}`);
    }

    if (Array.isArray(parsedBody.errors) && parsedBody.errors.length > 0) {
      const messages = parsedBody.errors.map((item) => {
        const msg = isPlainRecord(item) ? String(item.message ?? '') : String(item);
        return `GraphQL error: ${msg}`;
      });
      throw new RecordRuntimeError(messages.join('\n'));
    }

    return isPlainRecord(parsedBody.data) ? parsedBody.data : {};
  }

  throw new RecordRuntimeError(`Request failed for ${GRAPHQL_URL}`);
}

async function fetchPhotoBytes(
  ctx: RecordCommandContext,
  url: string
): Promise<{ readonly content: Buffer; readonly contentType: string | null }> {
  const validatedUrl = validatePhotoUrl(url);

  for (let attempt = 1; attempt <= PHOTO_ATTEMPTS; attempt += 1) {
    try {
      let currentUrl = validatedUrl;
      let resp: Response | undefined;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        validatePhotoUrl(currentUrl);
        resp = await fetchWithTimeout(
          ctx,
          currentUrl,
          {
            method: 'GET',
            headers: { 'User-Agent': USER_AGENT },
          },
          PHOTO_TIMEOUT_MS
        );
        if (resp.url) {
          validatePhotoUrl(resp.url);
        }
        if (REDIRECT_STATUSES.has(resp.status)) {
          const location = resp.headers.get('location');
          if (!location) {
            break;
          }
          if (hop === MAX_REDIRECTS) {
            throw new RecordRuntimeError(`Too many redirects (${MAX_REDIRECTS}) for ${validatedUrl}`);
          }
          currentUrl = validatePhotoUrl(new URL(location, currentUrl).toString());
          continue;
        }
        break;
      }

      if (!resp) {
        throw new RecordRuntimeError(`Failed downloading ${validatedUrl}`);
      }

      if (TRANSIENT_STATUS_CODES.has(resp.status)) {
        if (attempt < PHOTO_ATTEMPTS) {
          await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
          continue;
        }
        throw new RecordRuntimeError(`HTTP ${resp.status} downloading ${validatedUrl}`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new RecordRuntimeError(`HTTP ${resp.status} downloading ${validatedUrl}`);
      }

      const contentType = resp.headers.get('content-type');
      const contentEncoding = (resp.headers.get('content-encoding') ?? '').trim().toLowerCase();
      const rawLen = (resp.headers.get('content-length') ?? '').trim();
      let expectedLen: number | undefined;
      if (rawLen && (!contentEncoding || contentEncoding === 'identity') && /^\d+$/.test(rawLen)) {
        const parsedLen = Number.parseInt(rawLen, 10);
        if (parsedLen > 0) {
          expectedLen = parsedLen;
        }
      }

      const content = Buffer.from(await resp.arrayBuffer());
      if (expectedLen !== undefined && content.length < expectedLen) {
        throw new IncompletePhotoError(
          `Incomplete photo download for ${validatedUrl}: received ${content.length} of ${expectedLen} bytes`
        );
      }

      return { content, contentType };
    } catch (err: unknown) {
      if (err instanceof RecordRuntimeError) {
        throw err;
      }
      if (attempt < PHOTO_ATTEMPTS) {
        await ctx.sleepFn(retryDelayMs(attempt, undefined, ctx.nowMs));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(
        `Failed downloading ${validatedUrl} after ${PHOTO_ATTEMPTS} attempts: ${message}`
      );
    }
  }

  throw new RecordRuntimeError(`Failed downloading ${validatedUrl}`);
}

function coordsPair(obj: unknown): readonly [number | null, number | null] {
  if (!isPlainRecord(obj)) {
    return [null, null];
  }
  const lat = obj.lat;
  const lon = obj.lon !== undefined && obj.lon !== null ? obj.lon : obj.lng;
  if (typeof lat === 'number' && Number.isFinite(lat) && typeof lon === 'number' && Number.isFinite(lon)) {
    return [lat, lon];
  }
  return [null, null];
}

export function enrichCemetery(cemetery: unknown): unknown {
  if (!isPlainRecord(cemetery)) {
    return cemetery;
  }
  const [lat, lon] = coordsPair(cemetery.coordinates);
  if (lat !== null && lon !== null) {
    return { ...cemetery, lat, lng: lon };
  }
  return { ...cemetery };
}

export function enrichMemorial(memorial: JsonRecord): JsonRecord {
  const cem = memorial.cemetery;
  if (isPlainRecord(cem)) {
    const enrichedCem = enrichCemetery(cem) as JsonRecord;
    const [cemLat, cemLon] = coordsPair(enrichedCem.coordinates);
    return {
      ...memorial,
      cemetery: enrichedCem,
      cemetery_lat: cemLat,
      cemetery_lng: cemLon,
    };
  }
  return {
    ...memorial,
    cemetery_lat: null,
    cemetery_lng: null,
  };
}

function memorialUrl(memorialId: string): string {
  return `${WEBSITE_BASE}/memorial/${memorialId}`;
}

function cemeteryUrl(cemeteryId: string): string {
  return `${WEBSITE_BASE}/cemetery/${cemeteryId}`;
}

function primaryName(memorial: JsonRecord): string {
  const names = Array.isArray(memorial.name) ? memorial.name : [];
  if (names.length === 0) {
    return '';
  }
  const firstEntry = isPlainRecord(names[0]) ? names[0] : {};
  const parts = [firstEntry.first, firstEntry.last].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  );
  let text = parts.join(' ');
  const maiden = firstEntry.maiden;
  if (typeof maiden === 'string' && maiden.length > 0) {
    text += ` (nee ${maiden})`;
  }
  return text;
}

function firstPlaceName(place: unknown): string {
  if (!isPlainRecord(place)) {
    return '';
  }
  const names = Array.isArray(place.names) ? place.names : [];
  if (names.length === 0 || !isPlainRecord(names[0])) {
    return '';
  }
  return typeof names[0].name === 'string' ? names[0].name : '';
}

function fmtDate(date: unknown): string {
  if (!isPlainRecord(date)) {
    return '';
  }
  const year = date.year;
  if (year === null || year === undefined) {
    return '';
  }
  let text = String(year);
  const month = typeof date.month === 'number' ? date.month : undefined;
  const day = typeof date.day === 'number' ? date.day : undefined;
  if (month) {
    text = month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${text}` : text;
    if (day) {
      text = `${day} ${text}`;
    }
  }
  if (date.circa) {
    text = `c. ${text}`;
  }
  return text;
}

function fmtEvent(event: unknown): string {
  if (!isPlainRecord(event)) {
    return '';
  }
  const dateStr = fmtDate(event.date);
  const placeStr = firstPlaceName(event.place);
  return [dateStr, placeStr].filter((p) => p.length > 0).join(', ');
}

function fmtCemetery(cemetery: unknown): string {
  if (!isPlainRecord(cemetery)) {
    return '';
  }
  const names = Array.isArray(cemetery.names) ? cemetery.names : [];
  if (names.length === 0 || !isPlainRecord(names[0])) {
    return '';
  }
  return typeof names[0].name === 'string' ? names[0].name : '';
}

async function cachedGqlQuery(
  ctx: RecordCommandContext,
  kind: string,
  canonicalParams: JsonRecord,
  query: string,
  variables: JsonRecord,
  options: {
    readonly cacheRoot: string;
    readonly ttlHours: number;
    readonly refresh: boolean;
  }
): Promise<{ readonly data: JsonRecord; readonly cacheHit: boolean }> {
  const canonical = canonicalJsonStringify(canonicalParams);
  const digest = sha256Hex(canonical);
  const cachePath = resolveSafeChild(path.join(options.cacheRoot, '_queries', kind), `${digest}.json`);

  if (!options.refresh) {
    const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
    if (cached !== undefined) {
      return { data: cached, cacheHit: true };
    }
  }

  const lockPath = resolveSafeChild(path.join(options.cacheRoot, '_locks'), `query_${kind}_${digest}.lock`);

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
        if (cached !== undefined) {
          return { data: cached, cacheHit: true };
        }
      }
      const data = await runGraphqlQuery(ctx, query, variables);
      atomicWriteCompactJson(cachePath, {
        cached_at: ctx.nowMs() / 1000,
        params: canonicalParams,
        data,
      });
      return { data, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

async function loadOrFetchMemorialsWithHits(
  ctx: RecordCommandContext,
  memorialIds: readonly string[],
  options: {
    readonly cacheRoot: string;
    readonly ttlHours: number;
    readonly refresh: boolean;
  }
): Promise<{
  readonly memorials: JsonRecord[];
  readonly hits: boolean[];
  readonly allHit: boolean;
}> {
  const cleanIds = memorialIds.map((mid) => validateEntityId(mid, 'memorial id'));
  const byId = new Map<string, JsonRecord>();
  const hitById = new Map<string, boolean>();
  const missingIds: string[] = [];

  for (const mid of cleanIds) {
    if (byId.has(mid) || missingIds.includes(mid)) {
      continue;
    }
    const cachePath = resolveSafeChild(path.join(options.cacheRoot, 'memorials'), `${mid}.json`);
    if (!options.refresh) {
      const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
      if (cached !== undefined) {
        byId.set(mid, enrichMemorial(cached));
        hitById.set(mid, true);
        continue;
      }
    }
    missingIds.push(mid);
  }

  let fetched = false;
  if (missingIds.length > 0) {
    fetched = true;
    const data = await runGraphqlQuery(ctx, GET_QUERY, { ids: missingIds });
    const rawList = Array.isArray(data.memorialsById) ? data.memorialsById : [];
    for (const rawMem of rawList) {
      if (!isPlainRecord(rawMem)) {
        continue;
      }
      const mem = enrichMemorial(rawMem);
      const fetchedId = String(mem.id ?? '').trim();
      if (!fetchedId || !SAFE_ID_RE.test(fetchedId)) {
        continue;
      }
      byId.set(fetchedId, mem);
      hitById.set(fetchedId, false);
      const cachePath = resolveSafeChild(path.join(options.cacheRoot, 'memorials'), `${fetchedId}.json`);
      const lockPath = resolveSafeChild(path.join(options.cacheRoot, '_locks'), `memorial_${fetchedId}.lock`);
      await withAdvisoryLock(
        lockPath,
        async () => {
          atomicWriteCompactJson(cachePath, {
            cached_at: ctx.nowMs() / 1000,
            data: mem,
          });
        },
        { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
      );
    }
  }

  const ordered: JsonRecord[] = [];
  const orderedHits: boolean[] = [];
  for (const mid of cleanIds) {
    const found = byId.get(mid);
    if (found) {
      ordered.push(found);
      orderedHits.push(Boolean(hitById.get(mid)));
    }
  }

  return { memorials: ordered, hits: orderedHits, allHit: !fetched };
}

async function loadOrFetchCemeteryById(
  ctx: RecordCommandContext,
  cemeteryId: string,
  options: {
    readonly cacheRoot: string;
    readonly ttlHours: number;
    readonly refresh: boolean;
  }
): Promise<{ readonly result: JsonRecord; readonly cacheHit: boolean }> {
  const cleanId = validateEntityId(cemeteryId, 'cemetery id');
  const cachePath = resolveSafeChild(path.join(options.cacheRoot, 'cemeteries'), `${cleanId}.json`);

  if (!options.refresh) {
    const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
    if (cached !== undefined) {
      const cem = enrichCemetery(cached);
      return { result: { total: 1, cemeteries: [cem] }, cacheHit: true };
    }
  }

  const lockPath = resolveSafeChild(path.join(options.cacheRoot, '_locks'), `cemetery_${cleanId}.lock`);

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const cached = readFreshEnvelope(cachePath, options.ttlHours, ctx.nowMs);
        if (cached !== undefined) {
          const cem = enrichCemetery(cached);
          return { result: { total: 1, cemeteries: [cem] }, cacheHit: true };
        }
      }
      const data = await runGraphqlQuery(ctx, CEMETERY_BY_ID_QUERY, { ids: [cleanId] });
      const rawResult = isPlainRecord(data.cemeteries) ? data.cemeteries : {};
      const rawCems = Array.isArray(rawResult.cemeteries) ? rawResult.cemeteries : [];
      const cemeteriesList = rawCems.map((c) => enrichCemetery(c));
      const result: JsonRecord = { ...rawResult, cemeteries: cemeteriesList };
      if (cemeteriesList.length > 0) {
        atomicWriteCompactJson(cachePath, {
          cached_at: ctx.nowMs() / 1000,
          data: cemeteriesList[0],
        });
      }
      return { result, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

function normalizeYearFilter(raw: string | undefined, flag: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const cleaned = raw.trim().toLowerCase();
  if (!VALID_YEAR_FILTERS.has(cleaned)) {
    const choices = Array.from(VALID_YEAR_FILTERS).toSorted().join(', ');
    throw new CliValidationError(`Invalid ${flag} value '${raw}'. Choose from: ${choices}.`);
  }
  return cleaned;
}

function resolvePositionalName(
  queryParts: readonly string[],
  firstName: string | undefined,
  lastName: string | undefined,
  fullName: string | undefined
): readonly [string | undefined, string | undefined] {
  const posTokens = queryParts.flatMap((part) => part.trim().split(/\s+/)).filter((tok) => tok.length > 0);
  const nameTokens = (fullName ?? '')
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length > 0);

  if (posTokens.length > 0 && nameTokens.length > 0) {
    throw new CliValidationError('Pass either positional name arguments or --name, not both.');
  }
  const tokens = nameTokens.length > 0 ? nameTokens : posTokens;
  if (tokens.length === 0) {
    return [firstName, lastName];
  }
  if (firstName && lastName) {
    throw new CliValidationError('Pass either positional name / --name or --first/--last, not both.');
  }
  if (firstName && !lastName) {
    return [firstName, tokens.join(' ')];
  }
  if (lastName && !firstName) {
    return [tokens.join(' '), lastName];
  }
  if (tokens.length === 1) {
    return [undefined, tokens[0]];
  }
  return [tokens.slice(0, -1).join(' '), tokens[tokens.length - 1]];
}

const SEARCH_OPTIONS: readonly OptionSpec[] = [
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

const SEARCH_PARSE_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
};

const GET_OPTIONS: readonly OptionSpec[] = [
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

const GET_PARSE_SPEC: CommandParseSpec = {
  options: GET_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'memorial id',
};

const CEMETERY_OPTIONS: readonly OptionSpec[] = [
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

const CEMETERY_PARSE_SPEC: CommandParseSpec = {
  options: CEMETERY_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
};

const PLACE_OPTIONS: readonly OptionSpec[] = [
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

const PLACE_PARSE_SPEC: CommandParseSpec = {
  options: PLACE_OPTIONS,
  allowPositionals: true,
};

const PHOTO_OPTIONS: readonly OptionSpec[] = [
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

const PHOTO_PARSE_SPEC: CommandParseSpec = {
  options: PHOTO_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'memorial id',
};

const URL_OPTIONS: readonly OptionSpec[] = [
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

const URL_PARSE_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: false,
};

function renderRootHelp(): string {
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

function renderSearchHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave search [NAME...] [options]',
    summary: 'Search memorials. Example: search --first Abraham --last Lincoln.',
    options: SEARCH_OPTIONS,
  });
}

function renderGetHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave get <MEMORIAL_ID>... [options]',
    summary: 'Read one or more memorials in full by memorial id or URL (aliases: memorial, show).',
    options: GET_OPTIONS,
  });
}

function renderCemeteryHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave cemetery [CEMETERY_ID] [options]',
    summary: 'Search cemeteries by name, or read one by id.',
    options: CEMETERY_OPTIONS,
  });
}

function renderPlaceHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave place [PLACE...] [options]',
    summary: 'Resolve a place name to Find a Grave place ids.',
    options: PLACE_OPTIONS,
  });
}

function renderPhotoHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave photo <MEMORIAL_ID> [options]',
    summary: "Download a memorial's photos (grave, portrait, family, other; alias: photos).",
    options: PHOTO_OPTIONS,
  });
}

function renderUrlHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom findagrave url [options]',
    summary: 'Print the website search URL for a name (open it in a browser).',
    options: URL_OPTIONS,
  });
}

async function runSearch(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const page = getNumberOption(parsed, 'page');
  const offset = getNumberOption(parsed, 'offset');
  if (page !== undefined && offset !== undefined) {
    throw new CliValidationError('Pass either --page or --offset, not both.');
  }

  const [firstName, lastName] = resolvePositionalName(
    parsed.positionals,
    getStringOption(parsed, 'firstName'),
    getStringOption(parsed, 'lastName'),
    getStringOption(parsed, 'fullName')
  );
  const birthYear = getNumberOption(parsed, 'birthYear');
  const deathYear = getNumberOption(parsed, 'deathYear');
  const yearRange = getNumberOption(parsed, 'yearRange');
  const normBirthFilter = normalizeYearFilter(
    getStringOption(parsed, 'birthYearFilter'),
    '--birth-year-filter'
  );
  const normDeathFilter = normalizeYearFilter(
    getStringOption(parsed, 'deathYearFilter'),
    '--death-year-filter'
  );
  const cemeteryIds = getStringListOption(parsed, 'cemeteryId');
  const locationId = getStringOption(parsed, 'locationId');
  const bio = getStringOption(parsed, 'bio');
  const text = getStringOption(parsed, 'text');
  const relative = getStringOption(parsed, 'relative');
  const exact = getBooleanOption(parsed, 'exact');
  const includeMaiden = getBooleanOption(parsed, 'includeMaiden');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const pageSize = Math.min(limit, 50);
  const resolvedOffset = offset !== undefined ? offset : page !== undefined ? (page - 1) * pageSize : 0;

  const searchInput: JsonRecord = {};
  if (firstName) {
    searchInput.firstName = firstName;
  }
  if (lastName) {
    searchInput.lastName = lastName;
  }
  if (birthYear !== undefined) {
    searchInput.birthYear = birthYear;
  }
  if (deathYear !== undefined) {
    searchInput.deathYear = deathYear;
  }
  if (yearRange !== undefined) {
    if (birthYear !== undefined) {
      searchInput.birthYearRange = yearRange;
    }
    if (deathYear !== undefined) {
      searchInput.deathYearRange = yearRange;
    }
  }
  if (normBirthFilter) {
    searchInput.birthYearFilter = normBirthFilter;
  }
  if (normDeathFilter) {
    searchInput.deathYearFilter = normDeathFilter;
  }
  if (cemeteryIds.length > 0) {
    searchInput.cemeteryIds = cemeteryIds.map((cid) => validateEntityId(cid, 'cemetery id'));
  }
  if (locationId) {
    searchInput.locationId = locationId;
  }
  if (bio) {
    searchInput.bio = bio;
  }
  if (text) {
    searchInput.fullText = text;
  }
  if (relative) {
    searchInput.linkedToName = relative;
  }
  if (exact) {
    searchInput.exactName = true;
  }
  searchInput.includeMaidenName = includeMaiden;
  searchInput.from = resolvedOffset;
  searchInput.size = pageSize;

  const { data, cacheHit } = await cachedGqlQuery(
    ctx,
    'search',
    searchInput,
    SEARCH_QUERY,
    { s: searchInput },
    { cacheRoot, ttlHours, refresh }
  );

  const rawResult = isPlainRecord(data.memorialSearch) ? data.memorialSearch : {};
  const rawMemorials = Array.isArray(rawResult.memorials) ? rawResult.memorials : [];
  const memorials = rawMemorials
    .filter((m): m is JsonRecord => isPlainRecord(m))
    .map((m) => enrichMemorial(m));
  const result: JsonRecord = { ...rawResult, memorials };

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const lines: string[] = [`${String(result.total ?? '')} memorials`];
  for (const mem of memorials) {
    const born = fmtEvent(mem.birth);
    const died = fmtEvent(mem.death);
    const cem = fmtCemetery(mem.cemetery);
    const photo = mem.hasGravePhoto ? 'yes' : 'no';
    const vet = mem.isVeteran ? ' veteran' : '';
    const plot = typeof mem.plot === 'string' ? mem.plot : '';
    const id = String(mem.id ?? '');
    lines.push(
      `${id} | ${primaryName(mem)} | b. ${born} | d. ${died} | ${cem} | plot: ${plot} | grave photo: ${photo}${vet} | ${memorialUrl(id)}`
    );
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runGet(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderGetHelp()) };
  }

  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const full = getBooleanOption(parsed, 'full');
  const photos = getBooleanOption(parsed, 'photos');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const { memorials, hits, allHit } = await loadOrFetchMemorialsWithHits(ctx, parsed.positionals, {
    cacheRoot,
    ttlHours,
    refresh,
  });

  if (asJson) {
    const emitted = memorials.map((mem, idx) => ({
      ...mem,
      cache_hit: Boolean(hits[idx]),
    }));
    const bytesOut = emitJsonStdout(ctx.io, emitted);
    return { exitCode: 0, bytesOut, cacheHit: allHit };
  }

  const lines: string[] = [];
  for (const mem of memorials) {
    const mid = String(mem.id ?? '');
    lines.push(`Memorial ${mid}: ${primaryName(mem)}`);
    lines.push(`  URL: ${memorialUrl(mid)}`);
    const born = fmtEvent(mem.birth);
    const died = fmtEvent(mem.death);
    if (born) {
      lines.push(`  Born: ${born}`);
    }
    if (died) {
      lines.push(`  Died: ${died}`);
    }
    const cem = isPlainRecord(mem.cemetery) ? mem.cemetery : {};
    const cemName = fmtCemetery(cem);
    if (cemName) {
      lines.push(`  Cemetery: ${cemName} (${String(cem.id ?? '')})`);
    }
    const [cemLat, cemLon] = coordsPair(cem.coordinates);
    if (cemLat !== null && cemLon !== null) {
      lines.push(`  Cemetery GPS: ${cemLat}, ${cemLon}`);
    }
    const [graveLat, graveLon] = coordsPair(mem.coordinates);
    if (graveLat !== null && graveLon !== null) {
      lines.push(`  Grave GPS: ${graveLat}, ${graveLon}`);
    }
    if (typeof mem.plot === 'string' && mem.plot.length > 0) {
      lines.push(`  Plot: ${mem.plot}`);
    }
    const photosObj = isPlainRecord(mem.photos) ? mem.photos : {};
    lines.push(
      `  Veteran: ${mem.isVeteran ? 'yes' : 'no'} | Grave photo: ${mem.hasGravePhoto ? 'yes' : 'no'} | Photos: ${String(photosObj.total ?? '')}`
    );
    const inscriptionObj = isPlainRecord(mem.inscription) ? mem.inscription : {};
    const bioObj = isPlainRecord(mem.bio) ? mem.bio : {};
    const inscription = typeof inscriptionObj.value === 'string' ? inscriptionObj.value : '';
    const bio = typeof bioObj.value === 'string' ? bioObj.value : '';
    if (inscription) {
      lines.push(`  Inscription: ${full ? inscription : inscription.slice(0, 500)}`);
    }
    if (bio) {
      lines.push(`  Bio: ${full ? bio : bio.slice(0, 500)}`);
    }
    const relations = Array.isArray(mem.relationships) ? mem.relationships : [];
    if (relations.length > 0) {
      lines.push('  Relationships:');
      for (const rel of relations) {
        if (!isPlainRecord(rel)) {
          continue;
        }
        const target = isPlainRecord(rel.memorial) ? rel.memorial : {};
        lines.push(`    ${String(rel.type ?? '')}: ${primaryName(target)} (${String(target.id ?? '')})`);
      }
    }
    if (photos) {
      const photoList = Array.isArray(photosObj.photos) ? photosObj.photos : [];
      if (photoList.length > 0) {
        lines.push('  Photos:');
        for (const photoItem of photoList) {
          if (!isPlainRecord(photoItem)) {
            continue;
          }
          lines.push(
            `    ${String(photoItem.id ?? '')} | ${String(photoItem.type ?? '')} | ${String(photoItem.path ?? '')}`
          );
        }
      }
    }
    if (typeof mem.dateCreated === 'string' && mem.dateCreated.length > 0) {
      lines.push(`  Created: ${mem.dateCreated} | Modified: ${String(mem.dateModified ?? '')}`);
    }
  }

  const bytesOut = lines.length > 0 ? emitStdout(ctx.io, lines.join('\n')) : 0;
  return { exitCode: 0, bytesOut, cacheHit: allHit };
}

async function runCemetery(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CEMETERY_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCemeteryHelp()) };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const name = getStringOption(parsed, 'name');
  const cemeteryIdOpt = getStringOption(parsed, 'cemeteryId');
  const place = getStringOption(parsed, 'place');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const resolvedId = cemeteryIdOpt ?? parsed.positionals[0];
  let result: JsonRecord;
  let cacheHit: boolean;
  let cemeteriesList: JsonRecord[];

  if (resolvedId) {
    const loaded = await loadOrFetchCemeteryById(ctx, resolvedId, {
      cacheRoot,
      ttlHours,
      refresh,
    });
    result = loaded.result;
    cacheHit = loaded.cacheHit;
    cemeteriesList = (Array.isArray(result.cemeteries) ? result.cemeteries : []).filter(
      (c): c is JsonRecord => isPlainRecord(c)
    );
  } else {
    if (!name) {
      throw new CliValidationError('Pass a cemetery id, --id, or --name.');
    }
    const searchInput: JsonRecord = { name };
    if (place) {
      searchInput.containingLocationName = place;
    }
    searchInput.from = offset;
    searchInput.size = Math.min(limit, 100);
    const queried = await cachedGqlQuery(
      ctx,
      'cemetery_search',
      searchInput,
      CEMETERY_QUERY,
      { s: searchInput },
      { cacheRoot, ttlHours, refresh }
    );
    cacheHit = queried.cacheHit;
    const rawResult = isPlainRecord(queried.data.cemeteries) ? queried.data.cemeteries : {};
    const rawCems = Array.isArray(rawResult.cemeteries) ? rawResult.cemeteries : [];
    cemeteriesList = rawCems.map((c) => enrichCemetery(c)).filter((c): c is JsonRecord => isPlainRecord(c));
    result = { ...rawResult, cemeteries: cemeteriesList };
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const lines: string[] = [`${String(result.total ?? '')} cemeteries`];
  for (const cem of cemeteriesList) {
    const names = Array.isArray(cem.names) ? cem.names : [];
    const shown =
      names.length > 0 && isPlainRecord(names[0]) && typeof names[0].name === 'string' ? names[0].name : '';
    let extra = '';
    if (names.length > 1) {
      const altNames = names
        .slice(1)
        .map((n) => (isPlainRecord(n) && typeof n.name === 'string' ? n.name : ''))
        .filter((s) => s.length > 0);
      if (altNames.length > 0) {
        extra = ` (also: ${altNames.join(', ')})`;
      }
    }
    const [lat, lon] = coordsPair(cem.coordinates);
    const gps = lat !== null && lon !== null ? ` | GPS: ${lat}, ${lon}` : '';
    const id = String(cem.id ?? '');
    lines.push(
      `${id} | ${shown}${extra} | ${String(cem.memorialCount ?? '')} memorials${gps} | ${cemeteryUrl(id)}`
    );
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runPlace(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PLACE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPlaceHelp()) };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const nameOpt = getStringOption(parsed, 'name');
  const posName = parsed.positionals
    .filter((p) => p.length > 0)
    .join(' ')
    .trim();
  if (posName && nameOpt) {
    throw new CliValidationError('Pass either a positional place name or --name, not both.');
  }
  const resolvedName = (nameOpt ?? posName).trim();
  if (!resolvedName) {
    throw new CliValidationError('Pass a place name positionally or with --name.');
  }

  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const searchInput: JsonRecord = { name: resolvedName, size: Math.min(limit, 50) };
  const { data, cacheHit } = await cachedGqlQuery(
    ctx,
    'place',
    searchInput,
    PLACE_QUERY,
    { s: searchInput },
    { cacheRoot, ttlHours, refresh }
  );
  const result = isPlainRecord(data.locationsByTypeahead) ? data.locationsByTypeahead : {};

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const lines: string[] = [`${String(result.total ?? '')} places`];
  const locations = Array.isArray(result.locations) ? result.locations : [];
  for (const loc of locations) {
    if (!isPlainRecord(loc)) {
      continue;
    }
    const names = Array.isArray(loc.names) ? loc.names : [];
    const shown =
      names.length > 0 && isPlainRecord(names[0]) && typeof names[0].name === 'string' ? names[0].name : '';
    const kind = String(loc.__typename ?? '');
    const count = loc.memorialCount;
    const suffix = count !== null && count !== undefined ? ` | ${String(count)} memorials` : '';
    lines.push(`${String(loc.id ?? '')} | ${kind} | ${shown}${suffix}`);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runPhoto(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PHOTO_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPhotoHelp()) };
  }

  const rawOut = getStringOption(parsed, 'out') ?? '.';
  if (rawOut.includes('\0')) {
    throw new CliValidationError(`Invalid --out path: '${rawOut}'`);
  }
  if (!path.isAbsolute(rawOut) && rawOut.split(/[\\/]/).includes('..')) {
    throw new RecordRuntimeError(`Unsafe output directory containing '..': ${rawOut}`);
  }
  const outDir = path.isAbsolute(rawOut) ? rawOut : path.resolve(ctx.cwd, rawOut);

  const cleanId = validateEntityId(parsed.positionals[0], 'memorial id');
  const stemPrefix = sanitizePrefix(getStringOption(parsed, 'prefix'));
  const photoType = getStringOption(parsed, 'photoType');
  const allTypes = getBooleanOption(parsed, 'allTypes');
  const saveMetadata = getBooleanOption(parsed, 'saveMetadata');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const { memorials, allHit: memorialCacheHit } = await loadOrFetchMemorialsWithHits(ctx, [cleanId], {
    cacheRoot,
    ttlHours,
    refresh,
  });

  if (memorials.length === 0) {
    ctx.io.stderr(`No memorial found with id ${cleanId}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  const memorial = memorials[0];
  const photosObj = isPlainRecord(memorial.photos) ? memorial.photos : {};
  let photoList = (Array.isArray(photosObj.photos) ? photosObj.photos : []).filter((p): p is JsonRecord =>
    isPlainRecord(p)
  );
  if (photoType && !allTypes) {
    photoList = photoList.filter((p) => p.type === photoType);
  }

  if (photoList.length === 0) {
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, {
        memorial_id: cleanId,
        files: [],
        cache_hit: memorialCacheHit,
      });
      return { exitCode: 0, bytesOut, cacheHit: memorialCacheHit };
    }
    const bytesOut = emitStdout(ctx.io, 'No photos found.');
    return { exitCode: 0, bytesOut, cacheHit: memorialCacheHit };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const photosCacheDir = path.join(cacheRoot, 'photos', cleanId);
  const savedItems: PhotoSavedItem[] = [];
  const fileHits: boolean[] = [];
  let rejected = false;
  let bytesOut = 0;

  for (const item of photoList) {
    const url = validatePhotoUrl(typeof item.path === 'string' ? item.path : '');
    const cacheFilename = safePhotoFilename(item.id, url);
    const cachedPath = resolveSafeChild(photosCacheDir, cacheFilename);
    const dest = resolveSafeChild(outDir, `${stemPrefix}${cacheFilename}`);

    const copyCached = (fromCache: boolean): number => {
      atomicCopyFile(cachedPath, dest);
      const size = fs.statSync(dest).size;
      if (!asJson) {
        const suffixNote = fromCache ? ', cached' : '';
        bytesOut += emitStdout(ctx.io, `${dest} (${size} bytes${suffixNote})`);
      }
      return size;
    };

    let fromCache = false;
    let size = 0;

    if (!refresh && photoCacheFresh(cachedPath, ttlHours, ctx.nowMs)) {
      fromCache = true;
      size = copyCached(true);
    } else {
      const lockPath = resolveSafeChild(
        path.join(cacheRoot, '_locks'),
        `photo_${cleanId}_${cacheFilename}.lock`
      );
      let itemRejected = false;
      await withAdvisoryLock(
        lockPath,
        async () => {
          if (!refresh && photoCacheFresh(cachedPath, ttlHours, ctx.nowMs)) {
            fromCache = true;
            return;
          }
          const { content, contentType } = await fetchPhotoBytes(ctx, url);
          if (!photoBytesAccepted(content, contentType)) {
            rejected = true;
            itemRejected = true;
            const photoLabel = item.id !== null && item.id !== undefined ? String(item.id) : url;
            ctx.io.stderr(`Rejected non-image body for photo ${photoLabel}`);
            return;
          }
          storePhotoCache(cachedPath, content, contentType);
        },
        { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
      );
      if (itemRejected || !fs.existsSync(cachedPath)) {
        continue;
      }
      size = copyCached(fromCache);
    }

    fileHits.push(fromCache);
    savedItems.push({
      id: item.id ?? null,
      type: item.type ?? null,
      caption: item.caption ?? null,
      url,
      file: path.basename(dest),
      bytes: size,
      cache_hit: fromCache,
    });
  }

  let metadataPath: string | undefined;
  if (saveMetadata) {
    const metaPath = resolveSafeChild(outDir, `${stemPrefix}${cleanId}.metadata.json`);
    const metaPayload = {
      memorial_id: String(memorial.id ?? ''),
      name: primaryName(memorial),
      url: memorialUrl(String(memorial.id ?? '')),
      cemetery: fmtCemetery(memorial.cemetery),
      plot: memorial.plot ?? null,
      photos: savedItems.map((item) => ({
        id: item.id,
        type: item.type,
        caption: item.caption,
        url: item.url,
        file: item.file,
      })),
    };
    atomicWriteFileSync(metaPath, `${JSON.stringify(metaPayload, null, 2)}\n`);
    metadataPath = metaPath;
    if (!asJson) {
      bytesOut += emitStdout(ctx.io, `${metaPath} (metadata)`);
    }
  }

  const cacheHit =
    memorialCacheHit && !rejected && fileHits.every(Boolean) && fileHits.length === photoList.length;

  if (asJson) {
    const payload: JsonRecord = {
      memorial_id: cleanId,
      files: savedItems,
      cache_hit: cacheHit,
    };
    if (metadataPath !== undefined) {
      payload.metadata_file = metadataPath;
    }
    bytesOut += emitJsonStdout(ctx.io, payload);
  }

  if (rejected) {
    return { exitCode: 1, bytesOut, cacheHit };
  }
  return { exitCode: 0, bytesOut, cacheHit };
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const firstName = getStringOption(parsed, 'firstName');
  const lastName = getStringOption(parsed, 'lastName');
  const birthYear = getNumberOption(parsed, 'birthYear');
  const deathYear = getNumberOption(parsed, 'deathYear');

  const params = new URLSearchParams();
  if (firstName) {
    params.append('firstname', firstName);
  }
  if (lastName) {
    params.append('lastname', lastName);
  }
  if (birthYear !== undefined) {
    params.append('birthyear', String(birthYear));
  }
  if (deathYear !== undefined) {
    params.append('deathyear', String(deathYear));
  }

  const base = `${WEBSITE_BASE}/memorial/search`;
  const qs = params.toString();
  const output = qs.length > 0 ? `${base}?${qs}` : base;
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, output) };
}

const SUBCOMMAND_ALIASES: Readonly<Record<string, string>> = {
  memorial: 'get',
  show: 'get',
  photos: 'photo',
};

export const runFindagraveCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }

    const [rawSubcmd, ...rest] = args;
    const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);

    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'get':
        return await runGet(rest, ctx);
      case 'cemetery':
        return await runCemetery(rest, ctx);
      case 'place':
        return await runPlace(rest, ctx);
      case 'photo':
        return await runPhoto(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${rawSubcmd}'. Run 'kinloom findagrave --help'.`);
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
