import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { resolveCacheDir, sha256Hex } from '../../runtime/cache.js';
import {
  hasControlChar,
  hasMagicPrefix,
  isPlainRecord,
  JPEG_MAGIC,
  looksLikeHtmlBuffer,
  PNG_MAGIC,
  resolveEnvCacheTtlHours,
  resolveSafeChildPath,
} from '../../runtime/primitives.js';
import { RecordRuntimeError } from '../../runtime/types.js';

export const GRAPHQL_URL = 'https://www.findagrave.com/orc/graphql';
export const WEBSITE_BASE = 'https://www.findagrave.com';
export const DEFAULT_CACHE_TTL_HOURS = 168;

export const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_EXT_RE = /^\.[A-Za-z0-9]{1,8}$/;
const MEMORIAL_URL_RE = /^https:\/\/(?:www\.)?findagrave\.com\/memorial\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i;
const CEMETERY_URL_RE = /^https:\/\/(?:www\.)?findagrave\.com\/cemetery\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i;
const VALID_YEAR_FILTERS: ReadonlySet<string> = new Set(['before', 'after', 'exact', 'unknown']);
const PHOTO_ALLOWED_SUFFIXES = ['findagrave.com', 'ancestrycdn.com', 'cloudfront.net'] as const;
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

export type JsonRecord = Record<string, unknown>;

export interface CacheOptions {
  readonly cacheRoot: string;
  readonly ttlHours: number;
  readonly refresh: boolean;
}

export interface PhotoSavedItem {
  readonly id: unknown;
  readonly type: unknown;
  readonly caption: unknown;
  readonly url: string;
  readonly file: string;
  readonly bytes: number;
  readonly cache_hit: boolean;
}

export { resolveSafeChildPath as resolveSafeChild };

export function getCacheRoot(env: NodeJS.ProcessEnv): string {
  return resolveCacheDir({
    env,
    envVars: ['KINLOOM_FINDAGRAVE_CACHE_DIR'],
    defaultSubdir: 'kinloom-findagrave',
  });
}

export function resolveCacheTtlHours(cliTtl: number | undefined, env: NodeJS.ProcessEnv): number {
  return resolveEnvCacheTtlHours(cliTtl, env, 'KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS', DEFAULT_CACHE_TTL_HOURS);
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

export function normalizeYearFilter(raw: string | undefined, flag: string): string | undefined {
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

export function resolvePositionalName(
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

export function imageContentType(contentType: string | null): string | undefined {
  if (!contentType) {
    return undefined;
  }
  const base = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return IMAGE_CONTENT_TYPES.has(base) ? base : undefined;
}

export function hasImageMagic(content: Uint8Array): boolean {
  if (hasMagicPrefix(content, JPEG_MAGIC) || hasMagicPrefix(content, PNG_MAGIC)) {
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

export function photoBytesAccepted(content: Uint8Array, contentType: string | null): boolean {
  if (content.length === 0 || looksLikeHtmlBuffer(content, 128)) {
    return false;
  }
  if (hasImageMagic(content)) {
    return true;
  }
  return imageContentType(contentType) !== undefined;
}

export function coordsPair(obj: unknown): readonly [number | null, number | null] {
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

export function memorialUrl(memorialId: string): string {
  return `${WEBSITE_BASE}/memorial/${memorialId}`;
}

export function cemeteryUrl(cemeteryId: string): string {
  return `${WEBSITE_BASE}/cemetery/${cemeteryId}`;
}

export function primaryName(memorial: JsonRecord): string {
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

export function firstPlaceName(place: unknown): string {
  if (!isPlainRecord(place)) {
    return '';
  }
  const names = Array.isArray(place.names) ? place.names : [];
  if (names.length === 0 || !isPlainRecord(names[0])) {
    return '';
  }
  return typeof names[0].name === 'string' ? names[0].name : '';
}

export function fmtDate(date: unknown): string {
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

export function fmtEvent(event: unknown): string {
  if (!isPlainRecord(event)) {
    return '';
  }
  const dateStr = fmtDate(event.date);
  const placeStr = firstPlaceName(event.place);
  return [dateStr, placeStr].filter((p) => p.length > 0).join(', ');
}

export function fmtCemetery(cemetery: unknown): string {
  if (!isPlainRecord(cemetery)) {
    return '';
  }
  const names = Array.isArray(cemetery.names) ? cemetery.names : [];
  if (names.length === 0 || !isPlainRecord(names[0])) {
    return '';
  }
  return typeof names[0].name === 'string' ? names[0].name : '';
}

export function formatSearchText(total: unknown, memorials: readonly JsonRecord[]): string {
  const lines: string[] = [`${String(total ?? '')} memorials`];
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
  return lines.join('\n');
}

export function formatMemorialsLines(
  memorials: readonly JsonRecord[],
  options: { readonly full: boolean; readonly photos: boolean }
): string[] {
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
      lines.push(`  Inscription: ${options.full ? inscription : inscription.slice(0, 500)}`);
    }
    if (bio) {
      lines.push(`  Bio: ${options.full ? bio : bio.slice(0, 500)}`);
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
    if (options.photos) {
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
  return lines;
}

export function formatCemeteriesText(total: unknown, cemeteries: readonly JsonRecord[]): string {
  const lines: string[] = [`${String(total ?? '')} cemeteries`];
  for (const cem of cemeteries) {
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
  return lines.join('\n');
}

export function formatPlacesText(result: JsonRecord): string {
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
  return lines.join('\n');
}
