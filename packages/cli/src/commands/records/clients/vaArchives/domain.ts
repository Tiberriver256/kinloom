import { CliValidationError } from '../../../../errors.js';
import { type CacheHitTracker, resolveCacheDir } from '../../runtime/cache.js';
import type { CookieJar } from '../../runtime/http.js';
import { isPlainRecord, resolveEnvCacheTtlHours } from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';

export const CHANCERY_BASE = 'https://old.lva.virginia.gov/chancery';
export const CHANCERY_SEARCH = `${CHANCERY_BASE}/default.asp`;
export const CHANCERY_DETAIL = `${CHANCERY_BASE}/case_detail.asp`;
export const CHANCERY_IMAGES = `${CHANCERY_BASE}/case_images.asp`;
export const CHANCERY_ZIP = `${CHANCERY_BASE}/zip/download.php`;
export const CHANCERY_AVAILABLE = `${CHANCERY_BASE}/available.asp`;

export const PRIMO_BASE = 'https://lva.primo.exlibrisgroup.com';
export const PRIMO_PNXS = `${PRIMO_BASE}/primaws/rest/pub/pnxs`;
export const PRIMO_VID = '01LVA_INST:01LVA';

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const LVA_IMAGE_HOST = 'image.lva.virginia.gov';
export const LVA_IMAGE_BASE = `https://${LVA_IMAGE_HOST}`;
export const DUNMORE_CGI = `${LVA_IMAGE_BASE}/cgi-bin/GetDW.pl`;
export const ROSETTA_HOST = 'rosetta.virginiamemory.com';
export const ROSETTA_BASE = `https://${ROSETTA_HOST}`;
export const ROSETTA_DELIVERY = `${ROSETTA_BASE}/delivery/DeliveryManagerServlet`;
export const ROSETTA_VIEWER = `${ROSETTA_BASE}/view/action/ieViewer.do`;

export const CACHE_ENV = 'KINLOOM_VA_ARCHIVES_CACHE_DIR';
export const TTL_ENV = 'KINLOOM_VA_ARCHIVES_TTL_HOURS';
export const TTL_ENV_ALIAS = 'KINLOOM_VA_ARCHIVES_CACHE_TTL_HOURS';
export const DEFAULT_TTL_HOURS = 168;

const IMAGE_SUFFIXES = ['.tif', '.tiff', '.jpg', '.jpeg', '.png', '.gif'] as const;
export const CATALOG_FIELDS = ['any', 'title', 'creator'] as const;
const SAFE_PATH_RE = /^\/[A-Za-z0-9._~+\-/]+$/;

const CT_EXT: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/jp2': '.jp2',
  'image/tiff': '.tif',
  'image/png': '.png',
  'image/gif': '.gif',
  'text/plain': '.txt',
  'application/zip': '.zip',
};

export interface CachedMeta {
  readonly url: string;
  readonly content_type: string;
  readonly cached_at: number;
  readonly size: number;
}

export interface ChancerySearchRecord {
  readonly index_number: string;
  readonly cfn: string;
  readonly locality: string;
  readonly plaintiffs: readonly string[];
  readonly defendants: readonly string[];
  readonly case_url: string;
}

export interface ChancerySearchPage {
  readonly total: number;
  readonly first: number;
  readonly last: number;
  readonly records: readonly ChancerySearchRecord[];
}

export interface ChanceryImagesInfo {
  readonly total_pages: number;
  readonly page_pdfs: readonly string[];
  readonly zip_url: string;
}

export interface ChanceryCaseDetail {
  readonly locality: string;
  readonly index_number: string;
  readonly original_case_number: string;
  readonly plaintiffs: readonly string[];
  readonly defendants: readonly string[];
  readonly surnames: readonly string[];
  readonly wills: string;
  readonly plat: string;
  readonly format: string;
  cfn?: string;
  case_url?: string;
  images?: ChanceryImagesInfo;
}

export interface ChanceryLocalityRow {
  readonly locality: string;
  readonly region: string;
  readonly time_frame: string;
  readonly viewing_status: string;
  readonly notes: string;
}

export interface DunmoreImage {
  readonly page: number | null;
  readonly url: string;
  readonly current: boolean;
}

export interface DunmoreDrawerResult {
  readonly current_page: number | null;
  readonly images: readonly DunmoreImage[];
}

export interface RosettaDeliveryInfo {
  readonly viewer_url: string | null;
  readonly dps_dvs: string | null;
}

export interface RosettaFileEntry {
  readonly fl: string;
  readonly title: string;
}

export interface RosettaViewerInfo {
  readonly files: readonly RosettaFileEntry[];
  readonly initial: string | null;
}

export interface RosettaFilesCache {
  readonly ie: string;
  readonly delivery_url: string;
  readonly files: readonly RosettaFileEntry[];
  readonly initial: string | null;
  readonly cached_at: number;
}

export interface PrimoCatalogRecord {
  readonly recordid: string;
  readonly title: string;
  readonly creator: string;
  readonly date: string;
  readonly type: string;
  readonly source: string;
  readonly record_url: string;
}

export interface VaSessionState {
  readonly ctx: RecordCommandContext;
  readonly cacheRoot: string;
  readonly ttlHours: number;
  readonly refresh: boolean;
  readonly tracker: CacheHitTracker;
  readonly cookieJar: CookieJar;
}

export function extForContentType(contentType: string): string {
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return CT_EXT[mime] ?? '.bin';
}

export function getCacheRoot(env: NodeJS.ProcessEnv): string {
  return resolveCacheDir({
    env,
    envVars: [CACHE_ENV],
    defaultSubdir: 'kinloom-va-archives',
    useXdgCacheHome: true,
  });
}

export function resolveTtlHours(env: NodeJS.ProcessEnv, cliTtl?: number): number {
  if (cliTtl !== undefined) {
    return resolveEnvCacheTtlHours(cliTtl, env, TTL_ENV, DEFAULT_TTL_HOURS);
  }
  const primary = env[TTL_ENV];
  if (primary !== undefined && primary.trim().length > 0) {
    return resolveEnvCacheTtlHours(undefined, env, TTL_ENV, DEFAULT_TTL_HOURS);
  }
  return resolveEnvCacheTtlHours(undefined, env, TTL_ENV_ALIAS, DEFAULT_TTL_HOURS);
}

export function normalizeLvaImageUrl(raw: string): string {
  const text = raw.trim();
  if (!text || text.includes('\0') || /[\\\r\n\t ]/.test(text)) {
    throw new Error(`Invalid LVA image path: ${JSON.stringify(raw)}`);
  }
  if (text.includes('?') || text.includes('#')) {
    throw new Error(`Query strings/fragments are not allowed: ${JSON.stringify(raw)}`);
  }
  if (text.startsWith('//')) {
    throw new Error(`Scheme-relative URLs are not allowed: ${JSON.stringify(raw)}`);
  }

  let rawPath: string;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) {
    const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/.*)?$/.exec(text);
    if (!schemeMatch) {
      const scheme = text.split(':', 1)[0];
      throw new Error(`Only https URLs are allowed (got '${scheme}'): ${JSON.stringify(raw)}`);
    }
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'https') {
      throw new Error(`Only https URLs are allowed (got '${scheme}'): ${JSON.stringify(raw)}`);
    }
    const authority = schemeMatch[2];
    if (authority.includes('@')) {
      throw new Error(`Credentials/ports are not allowed: ${JSON.stringify(raw)}`);
    }
    let host = authority;
    const colonIdx = authority.lastIndexOf(':');
    if (colonIdx !== -1) {
      host = authority.slice(0, colonIdx);
      const port = authority.slice(colonIdx + 1);
      if (port !== '443') {
        throw new Error(`Credentials/ports are not allowed: ${JSON.stringify(raw)}`);
      }
    }
    if (host.toLowerCase() !== LVA_IMAGE_HOST) {
      throw new Error(`Only ${LVA_IMAGE_HOST} is allowed: ${JSON.stringify(raw)}`);
    }
    rawPath = schemeMatch[3] ?? '';
  } else {
    rawPath = text.startsWith('/') ? text : `/${text}`;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new Error(`Double/odd percent-encoding is not allowed: ${JSON.stringify(raw)}`);
  }
  let doubleDecoded: string;
  try {
    doubleDecoded = decodeURIComponent(decoded);
  } catch {
    throw new Error(`Double/odd percent-encoding is not allowed: ${JSON.stringify(raw)}`);
  }
  if (decoded.includes('%') || decoded !== doubleDecoded) {
    throw new Error(`Double/odd percent-encoding is not allowed: ${JSON.stringify(raw)}`);
  }
  if (!SAFE_PATH_RE.test(decoded)) {
    throw new Error(`Unsafe characters in LVA image path: ${JSON.stringify(raw)}`);
  }
  const segments = decoded.split('/').slice(1);
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`Empty, '.' or '..' path segments are not allowed: ${JSON.stringify(raw)}`);
  }
  const lowerDecoded = decoded.toLowerCase();
  if (!IMAGE_SUFFIXES.some((ext) => lowerDecoded.endsWith(ext))) {
    throw new Error(`Not an image path (expected ${IMAGE_SUFFIXES.join(', ')}): ${JSON.stringify(raw)}`);
  }
  return `${LVA_IMAGE_BASE}${decoded}`;
}

export function validateIeId(raw: string): string {
  const text = raw.trim();
  if (!/^IE\d{1,12}$/.test(text)) {
    throw new CliValidationError(`Invalid Rosetta IE id (expected IE<digits>): ${JSON.stringify(raw)}`);
  }
  return text;
}

export function validateFlId(raw: string): string {
  const text = raw.trim();
  if (!/^FL\d{1,12}$/.test(text)) {
    throw new CliValidationError(`Invalid Rosetta file id (expected FL<digits>): ${JSON.stringify(raw)}`);
  }
  return text;
}

export function parsePageSpec(spec: string, total: number): number[] {
  if (spec.trim().toLowerCase() === 'all') {
    return Array.from({ length: total }, (_v, idx) => idx + 1);
  }
  const nums = new Set<number>();
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    if (part.includes('-')) {
      const [rawA, rawB] = part.split('-', 2);
      const a = Number.parseInt(rawA.trim(), 10);
      const b = Number.parseInt(rawB.trim(), 10);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new CliValidationError(`Invalid page range '${part}' in --pages.`);
      }
      for (let n = a; n <= b; n += 1) {
        if (n >= 1 && n <= total) {
          nums.add(n);
        }
      }
    } else {
      const n = Number.parseInt(part, 10);
      if (!Number.isInteger(n)) {
        throw new CliValidationError(`Invalid page number '${part}' in --pages.`);
      }
      if (n >= 1 && n <= total) {
        nums.add(n);
      }
    }
  }
  return [...nums].toSorted((a, b) => a - b);
}

export function isRosettaFilesCache(value: unknown): value is RosettaFilesCache {
  return (
    isPlainRecord(value) &&
    typeof value.ie === 'string' &&
    typeof value.delivery_url === 'string' &&
    Array.isArray(value.files) &&
    value.files.length > 0
  );
}

export function formatChanceryRecordText(rec: ChancerySearchRecord): string {
  const lines = [`${rec.cfn}  ${rec.locality}  index ${rec.index_number}`];
  if (rec.plaintiffs.length > 0) {
    lines.push(`  P: ${rec.plaintiffs.join('; ')}`);
  }
  if (rec.defendants.length > 0) {
    lines.push(`  D: ${rec.defendants.join('; ')}`);
  }
  lines.push(`  ${rec.case_url}`);
  return lines.join('\n');
}
