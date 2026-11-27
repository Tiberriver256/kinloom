import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  CacheHitTracker,
  canonicalJsonStringify,
  convertTiffToJpeg,
  CookieJar,
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
  sha256Hex,
  withAdvisoryLock,
  type CommandParseSpec,
  type OptionSpec,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
} from '../runtime/index.js';

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
const DEFAULT_TTL_HOURS = 168;

const IMAGE_SUFFIXES = ['.tif', '.tiff', '.jpg', '.jpeg', '.png', '.gif'] as const;
const CATALOG_FIELDS = ['any', 'title', 'creator'] as const;
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

interface CachedMeta {
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

interface RosettaFilesCache {
  readonly ie: string;
  readonly delivery_url: string;
  readonly files: readonly RosettaFileEntry[];
  readonly initial: string | null;
  readonly cached_at: number;
}

interface VaSessionState {
  readonly ctx: RecordCommandContext;
  readonly cacheRoot: string;
  readonly ttlHours: number;
  readonly refresh: boolean;
  readonly tracker: CacheHitTracker;
  readonly cookieJar: CookieJar;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pyQuote(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

function decodeHtmlEntities(text: string): string {
  const $ = loadHtml(`<body>${text.replace(/</g, '&lt;')}</body>`);
  return $('body').text();
}

function cleanPreservingLines(htmlText: string): string {
  const withBreaks = htmlText
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(withBreaks.replace(/[ \t]+/g, ' ')).trim();
}

function parseNamesCell(cellHtml: string): string[] {
  return cleanPreservingLines(cellHtml)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function extForContentType(contentType: string): string {
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
    return parseCacheTtlHours(cliTtl, DEFAULT_TTL_HOURS, '--cache-ttl-hours');
  }
  const primary = env[TTL_ENV];
  if (primary !== undefined && primary.trim().length > 0) {
    return parseCacheTtlHours(primary, DEFAULT_TTL_HOURS, TTL_ENV);
  }
  const alias = env[TTL_ENV_ALIAS];
  if (alias !== undefined && alias.trim().length > 0) {
    return parseCacheTtlHours(alias, DEFAULT_TTL_HOURS, TTL_ENV_ALIAS);
  }
  return DEFAULT_TTL_HOURS;
}

function metaPathFor(cachePath: string): string {
  return `${cachePath}.meta.json`;
}

function readJsonIfValid(filePath: string): Record<string, unknown> | undefined {
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

function isCacheMetaValid(
  cachePath: string,
  ttlHours: number | null,
  nowMs: () => number
): CachedMeta | undefined {
  const meta = readJsonIfValid(metaPathFor(cachePath));
  if (!meta) {
    return undefined;
  }
  try {
    if (!fs.statSync(cachePath).isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const cachedAt = meta.cached_at;
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt)) {
    return undefined;
  }
  if (ttlHours !== null) {
    const nowSec = nowMs() / 1000;
    if (ttlHours <= 0 || nowSec - cachedAt > ttlHours * 3600) {
      return undefined;
    }
  }
  return {
    url: typeof meta.url === 'string' ? meta.url : '',
    content_type: typeof meta.content_type === 'string' ? meta.content_type : '',
    cached_at: cachedAt,
    size: typeof meta.size === 'number' ? meta.size : 0,
  };
}

function buildUrlWithParams(
  baseUrl: string,
  params?: Readonly<Record<string, string>>
): string {
  if (!params || Object.keys(params).length === 0) {
    return baseUrl;
  }
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function cachedFetch(
  state: VaSessionState,
  url: string,
  cachePath: string,
  options: {
    readonly method?: 'GET' | 'POST';
    readonly params?: Readonly<Record<string, string>>;
    readonly data?: Readonly<Record<string, string>>;
    readonly ttlHours: number | null;
    readonly allowedHosts?: readonly string[];
  }
): Promise<{ readonly path: string; readonly meta: CachedMeta; readonly cacheHit: boolean }> {
  if (!state.refresh) {
    const valid = isCacheMetaValid(cachePath, options.ttlHours, state.ctx.nowMs);
    if (valid) {
      state.tracker.note(true);
      return { path: cachePath, meta: valid, cacheHit: true };
    }
  }

  const lockPath = path.join(path.dirname(cachePath), `.${path.basename(cachePath)}.lock`);
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!state.refresh) {
        const valid = isCacheMetaValid(cachePath, options.ttlHours, state.ctx.nowMs);
        if (valid) {
          state.tracker.note(true);
          return { path: cachePath, meta: valid, cacheHit: true };
        }
      }

      const method = options.method ?? 'GET';
      const requestUrl = buildUrlWithParams(url, options.params);
      const headers: Record<string, string> = {};
      let body: string | undefined;
      if (method === 'POST' && options.data) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(options.data).toString();
      }

      const response = await httpRequest(requestUrl, {
        method,
        headers,
        body,
        userAgent: USER_AGENT,
        timeoutMs: 60_000,
        maxAttempts: 1,
        cookieJar: state.cookieJar,
        urlPolicy: {
          allowedSchemes: ['https:'],
          ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
        },
        fetchImpl: state.ctx.fetchImpl,
        sleepFn: state.ctx.sleepFn,
        nowMs: state.ctx.nowMs,
      });

      atomicWriteFileSync(cachePath, response.bytes);
      const meta: CachedMeta = {
        url: response.url,
        content_type: response.headers.get('content-type') ?? '',
        cached_at: state.ctx.nowMs() / 1000,
        size: response.bytes.length,
      };
      atomicWriteJsonSync(metaPathFor(cachePath), meta);
      state.tracker.note(false);
      return { path: cachePath, meta, cacheHit: false };
    },
    { nowMs: state.ctx.nowMs, sleepFn: state.ctx.sleepFn }
  );
}

function requestKey(
  method: string,
  url: string,
  params?: Readonly<Record<string, string>>,
  data?: Readonly<Record<string, string>>
): string {
  return sha256Hex(
    canonicalJsonStringify({
      m: method.toUpperCase(),
      u: url,
      p: params ?? {},
      d: data ?? {},
    })
  );
}

async function fetchText(
  state: VaSessionState,
  url: string,
  options: {
    readonly method?: 'GET' | 'POST';
    readonly params?: Readonly<Record<string, string>>;
    readonly data?: Readonly<Record<string, string>>;
    readonly allowedHosts?: readonly string[];
  } = {}
): Promise<string> {
  const method = options.method ?? 'GET';
  const key = requestKey(method, url, options.params, options.data);
  const cachePath = path.join(state.cacheRoot, 'http', `${key}.body`);
  const { path: savedPath } = await cachedFetch(state, url, cachePath, {
    method,
    params: options.params,
    data: options.data,
    ttlHours: state.ttlHours,
    allowedHosts: options.allowedHosts,
  });
  return fs.readFileSync(savedPath, 'utf8');
}

async function fetchFile(
  state: VaSessionState,
  url: string,
  allowedHosts?: readonly string[]
): Promise<string> {
  const key = sha256Hex(url);
  const parsedUrl = new URL(url);
  const rawExt = path.extname(parsedUrl.pathname).toLowerCase();
  const suffix = /^\.[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : '.bin';
  const cachePath = path.join(state.cacheRoot, 'files', `${key}${suffix}`);
  const { path: savedPath } = await cachedFetch(state, url, cachePath, {
    ttlHours: null,
    allowedHosts,
  });
  return savedPath;
}

function copyAtomic(srcPath: string, destPath: string): void {
  atomicWriteFileSync(destPath, fs.readFileSync(srcPath));
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
    throw new Error(
      `Not an image path (expected ${IMAGE_SUFFIXES.join(', ')}): ${JSON.stringify(raw)}`
    );
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

async function saveImage(srcPath: string, outPath: string): Promise<'jpeg' | 'raw'> {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    await convertTiffToJpeg(srcPath, outPath, 90);
    return 'jpeg';
  }
  copyAtomic(srcPath, outPath);
  return 'raw';
}

export function parseDunmoreDrawer(page: string): DunmoreDrawerResult {
  const titleMatch = /Dunmore's War\s*-\s*Page\s*(\d+)/i.exec(page);
  const current = titleMatch ? Number.parseInt(titleMatch[1], 10) : null;
  const images: DunmoreImage[] = [];
  const linkRe = /<a href="(\/Microfilm\/[^"]+)"\s*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(page)) !== null) {
    let url: string;
    try {
      url = normalizeLvaImageUrl(decodeHtmlEntities(match[1]));
    } catch {
      continue;
    }
    const labelText = cleanPreservingLines(match[2]);
    const labelMatch = /Page\s*(\d+)/.exec(labelText);
    const isCurrent = labelMatch === null;
    const num = labelMatch ? Number.parseInt(labelMatch[1], 10) : current;
    images.push({ page: num, url, current: isCurrent });
  }
  return { current_page: current, images };
}

export function parseRosettaDelivery(page: string): RosettaDeliveryInfo {
  const viewerMatch = /src="([^"]*ieViewer\.do[^"]*)"/i.exec(page);
  const viewerUrl = viewerMatch ? decodeHtmlEntities(viewerMatch[1]) : null;
  const dvsMatch = /dps_dvs=([0-9]+~[0-9]+)/.exec(page);
  return {
    viewer_url: viewerUrl,
    dps_dvs: dvsMatch ? dvsMatch[1] : null,
  };
}

export function parseRosettaViewer(page: string): RosettaViewerInfo {
  const files: RosettaFileEntry[] = [];
  const seen = new Set<string>();
  const itemRe = /<item id='(FL\d+)' title='([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(page)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      files.push({ fl: match[1], title: decodeHtmlEntities(match[2]) });
    }
  }
  const jsonRe = /JSONObject\s*=\s*'(\{[^']*\})'/g;
  while ((match = jsonRe.exec(page)) !== null) {
    try {
      const obj: unknown = JSON.parse(match[1]);
      if (!isPlainRecord(obj)) {
        continue;
      }
      for (const val of Object.values(obj)) {
        const flMatches = String(val).match(/FL\d+/g) ?? [];
        for (const fl of flMatches) {
          if (!seen.has(fl)) {
            seen.add(fl);
            files.push({ fl, title: '' });
          }
        }
      }
    } catch {
      // Ignore malformed inline JSONObject snippets.
    }
  }
  const initMatch = /initialSelect\s*=\s*"(FL\d+)"/.exec(page);
  const initial = initMatch ? initMatch[1] : (files[0]?.fl ?? null);
  return { files, initial };
}

export function parseSearchPage(page: string): ChancerySearchPage {
  const totalMatch =
    /Your search returned (\d+) record\(s\)\. You are now viewing records (\d+) through (\d+)/.exec(
      page
    );
  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : 0;
  const first = totalMatch ? Number.parseInt(totalMatch[2], 10) : 0;
  const last = totalMatch ? Number.parseInt(totalMatch[3], 10) : 0;

  const pat =
    /<strong>Index Number:<\/strong>\s*([^<]+?)\s*<\/span>\s*<a href="case_detail\.asp\?CFN=([0-9-]+)"[^>]*>[\s\S]*?<strong>Locality:<\/strong>\s*([^<]+?)\s*<\/td>[\s\S]*?<td valign="top">\s*([\s\S]*?)\s*<\/td>\s*<td valign="top">\s*([\s\S]*?)\s*<\/td>/gi;

  const records: ChancerySearchRecord[] = [];
  let match: RegExpExecArray | null;
  while ((match = pat.exec(page)) !== null) {
    records.push({
      index_number: decodeHtmlEntities(match[1].trim()),
      cfn: match[2],
      locality: decodeHtmlEntities(match[3].trim()),
      plaintiffs: parseNamesCell(match[4]),
      defendants: parseNamesCell(match[5]),
      case_url: `${CHANCERY_DETAIL}?CFN=${match[2]}`,
    });
  }
  return { total, first, last, records };
}

export function parseCasePage(page: string): ChanceryCaseDetail {
  const section = (label: string): string => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `<strong>${escaped}<\\/strong><\\/td><\\/tr>\\s*<tr>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`,
      'i'
    );
    const m = re.exec(page);
    return m ? cleanPreservingLines(m[1]) : '';
  };

  const head =
    /<strong>Locality<\/strong><\/td><td[^>]*><strong>Index Number<\/strong><\/td><td[^>]*><strong>Original Case Number<\/strong><\/td><\/tr>\s*<tr>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/i.exec(
      page
    );
  const parties =
    /<strong>Plaintiff\(s\)<\/strong><\/td><td[^>]*><strong>Defendant\(s\)<\/strong><\/td><\/tr>\s*<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(
      page
    );
  const surnames =
    /<strong>Surname\(s\)<\/strong><\/td><\/tr>\s*<tr><td[^>]*>([\s\S]*?)<\/td>/i.exec(page);
  const plat =
    /<strong>Plat\?<\/strong><\/td><\/tr>\s*<tr><td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/i.exec(
      page
    );
  const willsMatch =
    /<strong>Wills<\/strong><\/td><td[^>]*>[\s\S]*?Plat\?[\s\S]*?<\/tr>\s*<tr><td[^>]*>([\s\S]*?)<\/td>/i.exec(
      page
    );

  return {
    locality: head ? decodeHtmlEntities(head[1].trim()) : '',
    index_number: head ? decodeHtmlEntities(head[2].trim()) : '',
    original_case_number: head ? decodeHtmlEntities(head[3].trim()) : '',
    plaintiffs: parties ? parseNamesCell(parties[1]) : [],
    defendants: parties ? parseNamesCell(parties[2]) : [],
    surnames: surnames ? parseNamesCell(surnames[1]) : [],
    wills: willsMatch ? cleanPreservingLines(willsMatch[1]) : '',
    plat: plat ? decodeHtmlEntities(plat[2].trim()) : '',
    format: section('Format'),
  };
}

export function parseImagesPage(page: string): ChanceryImagesInfo {
  const urls: string[] = [];
  const imgRe = /myImages\[\d+\]\s*=\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(page)) !== null) {
    if (match[1]) {
      urls.push(match[1]);
    }
  }
  const totalMatch = /of\s+(\d+)\s+prev/.exec(cleanPreservingLines(page));
  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : urls.length;
  const zipMatch = /href="([^"]*download\.php\?cfn=[^"]*)"/i.exec(page);
  const origin = 'https://old.lva.virginia.gov';
  return {
    total_pages: total,
    page_pdfs: urls.map((u) => (u.startsWith('/') ? `${origin}${u}` : u)),
    zip_url: zipMatch ? `${origin}${decodeHtmlEntities(zipMatch[1])}` : `${CHANCERY_ZIP}?cfn=`,
  };
}

export function parseLocalitiesPage(page: string): ChanceryLocalityRow[] {
  const rows: ChanceryLocalityRow[] = [];
  const rowRe =
    /<TR><TD>([^<]*)<\/td><TD>([^<]*)<\/td><TD>([^<]*)<\/td><TD>([^<]*)<\/td><TD>([\s\S]*?)<\/td><\/TR>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(page)) !== null) {
    rows.push({
      locality: decodeHtmlEntities(match[1].replace(/&nbsp;/gi, ' ').trim()),
      region: decodeHtmlEntities(match[2].replace(/&nbsp;/gi, ' ').trim()),
      time_frame: decodeHtmlEntities(match[3].replace(/&nbsp;/gi, ' ').trim()),
      viewing_status: decodeHtmlEntities(match[4].replace(/&nbsp;/gi, ' ').trim()),
      notes: cleanPreservingLines(match[5]),
    });
  }
  return rows;
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

interface PrimoCatalogRecord {
  readonly recordid: string;
  readonly title: string;
  readonly creator: string;
  readonly date: string;
  readonly type: string;
  readonly source: string;
  readonly record_url: string;
}

function mapPnxsRecord(doc: unknown): PrimoCatalogRecord {
  const docObj = isPlainRecord(doc) ? doc : {};
  const pnx = isPlainRecord(docObj.pnx) ? docObj.pnx : {};
  const disp = isPlainRecord(pnx.display) ? pnx.display : {};
  const control = isPlainRecord(pnx.control) ? pnx.control : {};
  const recordIds = Array.isArray(control.recordid) ? control.recordid : [];
  const recordid = typeof recordIds[0] === 'string' ? recordIds[0] : '';

  const first = (key: string): string => {
    const vals = disp[key];
    return Array.isArray(vals) && typeof vals[0] === 'string' ? vals[0].trim() : '';
  };

  return {
    recordid,
    title: first('title'),
    creator: first('creator'),
    date: first('creationdate'),
    type: first('type'),
    source: first('source'),
    record_url: recordid
      ? `${PRIMO_BASE}/discovery/fulldisplay?docid=${recordid}&context=L&vid=${encodeURIComponent(PRIMO_VID)}&lang=en&search_scope=MyInstitution`
      : '',
  };
}

function formatChanceryRecordText(rec: ChancerySearchRecord): string {
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

function emitTrackedJson(
  state: VaSessionState,
  payload: Record<string, unknown>
): RecordCommandOutcome {
  const cacheHit = state.tracker.allHits() ?? false;
  return {
    exitCode: 0,
    bytesOut: emitJsonStdout(state.ctx.io, { ...payload, cache_hit: cacheHit }, 1),
    cacheHit,
  };
}

function isRosettaFilesCache(value: unknown): value is RosettaFilesCache {
  return (
    isPlainRecord(value) &&
    typeof value.ie === 'string' &&
    typeof value.delivery_url === 'string' &&
    Array.isArray(value.files) &&
    value.files.length > 0
  );
}

async function resolveRosetta(
  state: VaSessionState,
  ie: string
): Promise<RosettaFilesCache & { readonly session: boolean }> {
  const ieCacheDir = path.join(state.cacheRoot, 'rosetta', ie);
  const filesPath = path.join(ieCacheDir, 'files.json');

  if (!state.refresh) {
    const cached = readJsonIfValid(filesPath);
    if (isRosettaFilesCache(cached)) {
      state.tracker.note(true);
      return { ...cached, session: false };
    }
  }

  const deliveryUrl = buildUrlWithParams(ROSETTA_DELIVERY, { dps_pid: ie });
  const deliveryRes = await httpRequest(deliveryUrl, {
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    cookieJar: state.cookieJar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [ROSETTA_HOST] },
    fetchImpl: state.ctx.fetchImpl,
    sleepFn: state.ctx.sleepFn,
    nowMs: state.ctx.nowMs,
  });

  const info = parseRosettaDelivery(deliveryRes.bytes.toString('utf8'));
  let viewerUrl = info.viewer_url;
  if (viewerUrl) {
    try {
      const vu = new URL(viewerUrl);
      if (
        vu.protocol !== 'https:' ||
        vu.hostname.toLowerCase() !== ROSETTA_HOST ||
        !vu.pathname.endsWith('/ieViewer.do') ||
        vu.searchParams.get('dps_pid') !== ie
      ) {
        viewerUrl = null;
      }
    } catch {
      viewerUrl = null;
    }
  }
  if (!viewerUrl) {
    const params: Record<string, string> = { search: 'hide', dps_pid: ie };
    if (info.dps_dvs) {
      params.dps_dvs = info.dps_dvs;
    }
    viewerUrl = buildUrlWithParams(ROSETTA_VIEWER, params);
  }

  const viewerRes = await httpRequest(viewerUrl, {
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    cookieJar: state.cookieJar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [ROSETTA_HOST] },
    fetchImpl: state.ctx.fetchImpl,
    sleepFn: state.ctx.sleepFn,
    nowMs: state.ctx.nowMs,
  });

  const listing = parseRosettaViewer(viewerRes.bytes.toString('utf8'));
  if (listing.files.length === 0) {
    throw new RecordRuntimeError(
      `No delivered files found for ${ie} (restricted or not a viewable IE).`
    );
  }

  const result: RosettaFilesCache = {
    ie,
    delivery_url: `${ROSETTA_DELIVERY}?dps_pid=${ie}`,
    files: listing.files,
    initial: listing.initial,
    cached_at: state.ctx.nowMs() / 1000,
  };
  atomicWriteJsonSync(filesPath, result);
  state.tracker.note(false);
  return { ...result, session: true };
}

async function downloadRosettaFile(
  state: VaSessionState,
  ie: string,
  fl: string
): Promise<{ readonly path: string; readonly meta: CachedMeta }> {
  const binPath = path.join(state.cacheRoot, 'rosetta', ie, `${fl}.bin`);
  const { path: savedPath, meta } = await cachedFetch(state, ROSETTA_DELIVERY, binPath, {
    params: { dps_pid: fl, dps_func: 'stream' },
    ttlHours: null,
    allowedHosts: [ROSETTA_HOST],
  });
  if (meta.content_type.toLowerCase().startsWith('text/html')) {
    try {
      fs.unlinkSync(savedPath);
    } catch {
      // Ignore cleanup errors.
    }
    try {
      fs.unlinkSync(metaPathFor(savedPath));
    } catch {
      // Ignore cleanup errors.
    }
    throw new RecordRuntimeError(
      `Rosetta returned HTML instead of a file for ${ie}/${fl} (access restricted?).`
    );
  }
  return { path: savedPath, meta };
}

const REFRESH_CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this command and refetch.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_VA_ARCHIVES_TTL_HOURS / KINLOOM_VA_ARCHIVES_CACHE_TTL_HOURS).',
  },
];

const CHANCERY_SEARCH_OPTIONS: readonly OptionSpec[] = [
  { key: 'locality', kind: 'string', flags: ['--locality'], default: 'All', help: "County/city, e.g. 'ALBEMARLE CO'. Default All." },
  { key: 'match', kind: 'string', flags: ['--match'], default: 'Starts', help: 'How the surname match works (Exact/Starts/Includes).' },
  { key: 'surname2', kind: 'string', flags: ['--surname2'], help: 'Second surname (ANDed by the index form).' },
  { key: 'plaintiffLast', kind: 'string', flags: ['--plaintiff-last'], help: 'Plaintiff last name.' },
  { key: 'plaintiffFirst', kind: 'string', flags: ['--plaintiff-first'], help: 'Plaintiff first name.' },
  { key: 'defendantLast', kind: 'string', flags: ['--defendant-last'], help: 'Defendant last name.' },
  { key: 'defendantFirst', kind: 'string', flags: ['--defendant-first'], help: 'Defendant first name.' },
  { key: 'yearFrom', kind: 'string', flags: ['--year-from'], help: 'First year of case (strDate1).' },
  { key: 'yearTo', kind: 'string', flags: ['--year-to'], help: 'Last year of case (strDate2).' },
  { key: 'indexNumber', kind: 'string', flags: ['--index-number'], help: 'Index number, e.g. YYYY-NNN (txtIndexNum).' },
  { key: 'localCaseNumber', kind: 'string', flags: ['--local-case-number'], help: 'Local case file number (txtLclCFN).' },
  { key: 'enslaved', kind: 'boolean', flags: ['--enslaved'], help: 'Only cases referencing enslaved persons.' },
  { key: 'free', kind: 'boolean', flags: ['--free'], help: 'Only cases referencing free persons.' },
  { key: 'plats', kind: 'boolean', flags: ['--plats'], help: 'Only cases with plats available.' },
  { key: 'pages', kind: 'string', flags: ['--pages'], default: '1', help: "Result pages to fetch: '1', '1-3', '1,3', or 'all'." },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

const CHANCERY_CASE_OPTIONS: readonly OptionSpec[] = [
  { key: 'images', kind: 'boolean', flags: ['--images'], help: 'Also list the scanned page PDFs and ZIP URL.' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

const CHANCERY_DOWNLOAD_OPTIONS: readonly OptionSpec[] = [
  { key: 'outDir', kind: 'string', flags: ['--out'], metavar: 'DIR', help: 'Output directory (default: ./va-chancery-<cfn>).' },
  { key: 'pages', kind: 'string', flags: ['--pages'], default: 'all', help: "1-based page selection, e.g. '1-5' or 'all'." },
  { key: 'asZip', kind: 'boolean', flags: ['--zip'], help: 'Download the whole-case ZIP instead of page PDFs.' },
  { key: 'overwrite', kind: 'boolean', flags: ['--overwrite'], help: 'Overwrite existing files.' },
  ...REFRESH_CACHE_OPTIONS,
];

const CHANCERY_LOCALITIES_OPTIONS: readonly OptionSpec[] = [
  { key: 'status', kind: 'string', flags: ['--status'], help: 'Filter by viewing status substring, e.g. Scanned.' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output a JSON list of locality rows.' },
  ...REFRESH_CACHE_OPTIONS,
];

const CATALOG_OPTIONS: readonly OptionSpec[] = [
  { key: 'field', kind: 'string', flags: ['--field'], choices: CATALOG_FIELDS, default: 'any', help: 'PNXS search field (any, title, creator).' },
  { key: 'limit', kind: 'integer', flags: ['--limit'], min: 1, default: 10, help: 'Results per page (PNXS limit).' },
  { key: 'offset', kind: 'integer', flags: ['--offset'], min: 0, default: 0, help: 'Result offset (PNXS offset).' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output compact structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

const URL_OPTIONS: readonly OptionSpec[] = [
  { key: 'chanceryCase', kind: 'string', flags: ['--chancery-case'], metavar: 'CFN', help: 'CFN (locality-year-number).' },
  { key: 'catalogQuery', kind: 'string', flags: ['--catalog'], metavar: 'QUERY', help: 'Catalog search term (Primo search URL).' },
  { key: 'chronicle', kind: 'boolean', flags: ['--chronicle'], help: 'Virginia Chronicle home page (browser-only).' },
  { key: 'land', kind: 'boolean', flags: ['--land'], help: 'Land Office patents/grants: libguide + LONN volume index.' },
  { key: 'arvas', kind: 'boolean', flags: ['--arvas'], help: 'ARVAS finding-aid search home (browser-only).' },
  { key: 'chancery', kind: 'boolean', flags: ['--chancery'], help: 'Chancery Records Index home page.' },
];

const GRANT_TIF_OPTIONS: readonly OptionSpec[] = [
  { key: 'out', kind: 'string', flags: ['--out'], metavar: 'FILE', help: 'Output file (.jpg/.jpeg converts; else raw).' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

const DUNMORE_OPTIONS: readonly OptionSpec[] = [
  { key: 'pageNo', kind: 'integer', flags: ['--page'], min: 1, help: "Page number to save (default: the card's own page)." },
  { key: 'out', kind: 'string', flags: ['--out'], metavar: 'FILE', help: 'Save the selected page image (.jpg converts; else raw TIFF).' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

const ROSETTA_OPTIONS: readonly OptionSpec[] = [
  { key: 'fileIndex', kind: 'integer', flags: ['--file'], min: 1, help: "1-based file number from --list (default: viewer's initial file)." },
  { key: 'flId', kind: 'string', flags: ['--fl'], metavar: 'FL_ID', help: 'Explicit Rosetta file pid (FL<digits>) belonging to this IE.' },
  { key: 'listOnly', kind: 'boolean', flags: ['--list'], help: "Only list the IE's delivered files." },
  { key: 'out', kind: 'string', flags: ['--out'], metavar: 'FILE', help: 'Output file (default ./<IE>_<FL>.<ext>).' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Output structured JSON.' },
  ...REFRESH_CACHE_OPTIONS,
];

const CHANCERY_SEARCH_SPEC: CommandParseSpec = {
  options: CHANCERY_SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'surname',
};

const CHANCERY_CASE_SPEC: CommandParseSpec = {
  options: CHANCERY_CASE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'cfn',
};

const CHANCERY_DOWNLOAD_SPEC: CommandParseSpec = {
  options: CHANCERY_DOWNLOAD_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'cfn',
};

const CHANCERY_LOCALITIES_SPEC: CommandParseSpec = {
  options: CHANCERY_LOCALITIES_OPTIONS,
  allowPositionals: false,
};

const CATALOG_SPEC: CommandParseSpec = {
  options: CATALOG_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'query',
};

const URL_SPEC: CommandParseSpec = {
  options: URL_OPTIONS,
  allowPositionals: false,
};

const GRANT_TIF_SPEC: CommandParseSpec = {
  options: GRANT_TIF_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'path_or_url',
};

const DUNMORE_SPEC: CommandParseSpec = {
  options: DUNMORE_OPTIONS,
  allowPositionals: true,
  minPositionals: 2,
  maxPositionals: 2,
  positionalLabel: 'drawer card',
};

const ROSETTA_SPEC: CommandParseSpec = {
  options: ROSETTA_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'ie_id',
};

function makeState(
  ctx: RecordCommandContext,
  globalRefresh: boolean,
  cmdRefresh: boolean,
  cliTtl?: number
): VaSessionState {
  return {
    ctx,
    cacheRoot: getCacheRoot(ctx.env),
    ttlHours: resolveTtlHours(ctx.env, cliTtl),
    refresh: globalRefresh || cmdRefresh,
    tracker: new CacheHitTracker(),
    cookieJar: new CookieJar(),
  };
}

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives [--refresh] <command> [options]',
    summary:
      'Search the Library of Virginia: Chancery Records Index, Primo catalog, image server, Rosetta.',
    subcommands: [
      { name: 'chancery', summary: 'Chancery Records Index (search, case, download, localities).' },
      { name: 'catalog', summary: 'Search the Library of Virginia catalog via Primo PNXS API.' },
      { name: 'grant-tif', summary: 'Fetch (and cache) one Library of Virginia image-server scan.' },
      { name: 'lva-tif', summary: 'Alias of grant-tif.' },
      { name: 'dunmore', summary: "Resolve a Dunmore's War (1774) index card to its page TIFFs." },
      { name: 'download-rosetta', summary: 'Download a delivered file (PDF/image) for a Rosetta IE id.' },
      { name: 'url', summary: 'Print verified portal URLs (no search is run).' },
    ],
  });
}

function renderChanceryHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom va-archives chancery <command> [options]',
    summary: 'Chancery Records Index (old.lva.virginia.gov/chancery).',
    subcommands: [
      { name: 'search', summary: 'Search the Chancery Records Index by surname (more surnames = OR).' },
      { name: 'case', summary: 'Show one chancery cause by CFN (locality-year-number).' },
      { name: 'download', summary: 'Download scanned pages (or whole-case ZIP) for one chancery cause.' },
      { name: 'localities', summary: 'List per-locality chancery coverage from available.asp.' },
    ],
  });
}

async function runChancerySearch(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CHANCERY_SEARCH_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom va-archives chancery search <SURNAMES...> [options]',
          summary: 'Search the Chancery Records Index by surname (more surnames = OR).',
          options: CHANCERY_SEARCH_OPTIONS,
        })
      ),
    };
  }

  const rawMatch = (getStringOption(parsed, 'match') ?? 'Starts').trim().toLowerCase();
  const matchMap: Readonly<Record<string, string>> = {
    exact: 'Exact',
    starts: 'Starts',
    includes: 'Includes',
  };
  const matchMode = matchMap[rawMatch];
  if (!matchMode) {
    throw new CliValidationError(
      `Invalid value '${rawMatch}' for '--match'. Expected one of: Exact, Starts, Includes.`
    );
  }

  const locality = getStringOption(parsed, 'locality') ?? 'All';
  const surname2 = getStringOption(parsed, 'surname2');
  const plaintiffLast = getStringOption(parsed, 'plaintiffLast') ?? '';
  const plaintiffFirst = getStringOption(parsed, 'plaintiffFirst') ?? '';
  const defendantLast = getStringOption(parsed, 'defendantLast') ?? '';
  const defendantFirst = getStringOption(parsed, 'defendantFirst') ?? '';
  const yearFrom = getStringOption(parsed, 'yearFrom') ?? '';
  const yearTo = getStringOption(parsed, 'yearTo') ?? '';
  const indexNumber = getStringOption(parsed, 'indexNumber') ?? '';
  const localCaseNumber = getStringOption(parsed, 'localCaseNumber') ?? '';
  const enslaved = getBooleanOption(parsed, 'enslaved');
  const free = getBooleanOption(parsed, 'free');
  const plats = getBooleanOption(parsed, 'plats');
  const pagesSpec = getStringOption(parsed, 'pages') ?? '1';
  const asJson = getBooleanOption(parsed, 'asJson');

  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const allRecords: ChancerySearchRecord[] = [];
  let total = 0;

  for (const surname of parsed.positionals) {
    const form: Record<string, string> = {
      surname1: surname,
      sn1select: matchMode,
      plnlstName: plaintiffLast,
      plselect: matchMode,
      plnfrstName: plaintiffFirst,
      pfselect: matchMode,
      deflstName: defendantLast,
      dlselect: matchMode,
      deffrstName: defendantFirst,
      dfselect: matchMode,
      strDate1: yearFrom,
      strDate2: yearTo,
      txtIndexNum: indexNumber,
      txtLclCFN: localCaseNumber,
      Submit: 'Search',
      LOC: locality,
    };
    if (surname2) {
      form.surname2 = surname2;
      form.sn2select = matchMode;
    }
    if (enslaved) {
      form.chkEnslaved = 'on';
    }
    if (free) {
      form.chkFree = 'on';
    }
    if (plats) {
      form.chkPlat = 'on';
    }

    const firstHtml = await fetchText(state, CHANCERY_SEARCH, {
      method: 'POST',
      data: form,
      allowedHosts: ['old.lva.virginia.gov'],
    });
    const parsedPage = parseSearchPage(firstHtml);
    total += parsedPage.total;

    const totalPages = Math.max(Math.ceil(total / 20), 1);
    const wanted =
      pagesSpec.trim().toLowerCase() === 'all'
        ? Array.from({ length: totalPages }, (_v, idx) => idx + 1)
        : parsePageSpec(pagesSpec, totalPages);

    for (const pn of wanted) {
      if (pn === 1) {
        allRecords.push(...parsedPage.records);
        continue;
      }
      const nextHtml = await fetchText(state, CHANCERY_SEARCH, {
        method: 'POST',
        data: { ...form, intPage: String(pn) },
        allowedHosts: ['old.lva.virginia.gov'],
      });
      allRecords.push(...parseSearchPage(nextHtml).records);
    }
  }

  if (asJson) {
    return emitTrackedJson(state, {
      total,
      returned: allRecords.length,
      records: allRecords,
    });
  }

  const lines: string[] = [`${total} record(s); showing ${allRecords.length}:`];
  for (const rec of allRecords) {
    lines.push(formatChanceryRecordText(rec), '');
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

async function runChanceryCase(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CHANCERY_CASE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom va-archives chancery case <CFN> [options]',
          summary: 'Show one chancery cause by CFN (locality-year-number).',
          options: CHANCERY_CASE_OPTIONS,
        })
      ),
    };
  }

  const cfn = parsed.positionals[0];
  const includeImages = getBooleanOption(parsed, 'images');
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const detailHtml = await fetchText(state, CHANCERY_DETAIL, {
    params: { CFN: cfn },
    allowedHosts: ['old.lva.virginia.gov'],
  });
  const detail: ChanceryCaseDetail = {
    ...parseCasePage(detailHtml),
    cfn,
    case_url: `${CHANCERY_DETAIL}?CFN=${cfn}`,
  };
  if (includeImages) {
    const imgsHtml = await fetchText(state, CHANCERY_IMAGES, {
      params: { CFN: cfn },
      allowedHosts: ['old.lva.virginia.gov'],
    });
    detail.images = parseImagesPage(imgsHtml);
  }

  if (asJson) {
    return emitTrackedJson(state, { ...detail });
  }

  const lines: string[] = [
    `${cfn}  ${detail.locality}  index ${detail.index_number} (original case no. ${detail.original_case_number || 'n/a'})`,
    `Plaintiff(s): ${detail.plaintiffs.join('; ') || 'n/a'}`,
    `Defendant(s): ${detail.defendants.join('; ') || 'n/a'}`,
    `Surname(s): ${detail.surnames.join(', ') || 'n/a'}`,
    `Wills: ${detail.wills || 'n/a'}  Plat: ${detail.plat || 'n/a'}  Format: ${detail.format || 'n/a'}`,
    detail.case_url ?? '',
  ];
  if (detail.images) {
    lines.push(`Images: ${detail.images.total_pages} page(s)`);
    for (const u of detail.images.page_pdfs) {
      lines.push(`  ${u}`);
    }
    lines.push(`ZIP: ${detail.images.zip_url}`);
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

async function runChanceryDownload(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CHANCERY_DOWNLOAD_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom va-archives chancery download <CFN> [options]',
          summary: 'Download the scanned pages (or whole-case ZIP) for one chancery cause.',
          options: CHANCERY_DOWNLOAD_OPTIONS,
        })
      ),
    };
  }

  const cfn = parsed.positionals[0];
  if (!/^[0-9]+(?:-[0-9]+)*$/.test(cfn)) {
    throw new CliValidationError(
      `Invalid CFN (expected locality-year-number digits): ${JSON.stringify(cfn)}`
    );
  }

  const outDirOpt = getStringOption(parsed, 'outDir');
  const outDir = path.resolve(ctx.cwd, outDirOpt ?? `va-chancery-${cfn}`);
  const pagesSpec = getStringOption(parsed, 'pages') ?? 'all';
  const asZip = getBooleanOption(parsed, 'asZip');
  const overwrite = getBooleanOption(parsed, 'overwrite');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  fs.mkdirSync(outDir, { recursive: true });
  const detailHtml = await fetchText(state, CHANCERY_DETAIL, {
    params: { CFN: cfn },
    allowedHosts: ['old.lva.virginia.gov'],
  });
  const detail: ChanceryCaseDetail = {
    ...parseCasePage(detailHtml),
    cfn,
    case_url: `${CHANCERY_DETAIL}?CFN=${cfn}`,
  };

  let imgs: ChanceryImagesInfo | undefined;
  if (!asZip) {
    const imgsHtml = await fetchText(state, CHANCERY_IMAGES, {
      params: { CFN: cfn },
      allowedHosts: ['old.lva.virginia.gov'],
    });
    imgs = parseImagesPage(imgsHtml);
    detail.images = imgs;
  }

  const metaDest = path.join(outDir, 'metadata.json');
  atomicWriteFileSync(metaDest, JSON.stringify(detail, null, 1));

  const lines: string[] = [];
  if (asZip) {
    const zipUrl = imgs?.zip_url || `${CHANCERY_ZIP}?cfn=${cfn}`;
    const dest = path.join(outDir, `${cfn}.zip`);
    if (fs.existsSync(dest) && !overwrite) {
      lines.push(`exists, skipping: ${dest}`);
    } else {
      const cached = await fetchFile(state, zipUrl, ['old.lva.virginia.gov']);
      copyAtomic(cached, dest);
      lines.push(`saved ${dest} (${fs.statSync(dest).size} bytes)`);
    }
    return {
      exitCode: 0,
      bytesOut: emitStdout(ctx.io, lines.join('\n')),
      cacheHit: state.tracker.allHits(),
    };
  }

  const totalPages = imgs?.total_pages ?? 0;
  const pagePdfs = imgs?.page_pdfs ?? [];
  const wanted = parsePageSpec(pagesSpec, totalPages);
  for (const n of wanted) {
    const pageUrl = pagePdfs[n - 1];
    if (!pageUrl) {
      continue;
    }
    const rawName = path.basename(new URL(pageUrl).pathname);
    const sanitized = rawName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
    const fileName = sanitized || `${String(n).padStart(4, '0')}.pdf`;
    const dest = path.join(outDir, fileName);
    if (fs.existsSync(dest) && !overwrite) {
      lines.push(`exists, skipping: ${fileName}`);
      continue;
    }
    const cached = await fetchFile(state, pageUrl, ['old.lva.virginia.gov']);
    copyAtomic(cached, dest);
    lines.push(`saved ${dest} (${fs.statSync(dest).size} bytes)`);
  }
  lines.push(`metadata: ${metaDest}`);
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

async function runChanceryLocalities(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CHANCERY_LOCALITIES_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom va-archives chancery localities [options]',
          summary: 'List per-locality chancery coverage from available.asp.',
          options: CHANCERY_LOCALITIES_OPTIONS,
        })
      ),
    };
  }

  const statusFilter = getStringOption(parsed, 'status');
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const html = await fetchText(state, CHANCERY_AVAILABLE, {
    allowedHosts: ['old.lva.virginia.gov'],
  });
  let rows = parseLocalitiesPage(html);
  if (statusFilter) {
    const needle = statusFilter.toLowerCase();
    rows = rows.filter((r) => r.viewing_status.toLowerCase().includes(needle));
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, rows, 1),
      cacheHit: state.tracker.allHits(),
    };
  }

  const lines = rows.map(
    (r) =>
      `${r.locality.padEnd(20)} ${r.region.padEnd(22)} ${r.time_frame.padEnd(14)} ${r.viewing_status}`
  );
  lines.push(`${rows.length} localities`);
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

async function runCatalog(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CATALOG_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom va-archives catalog <QUERY> [options]',
          summary: 'Search the Library of Virginia catalog via the public Primo PNXS API.',
          options: CATALOG_OPTIONS,
        })
      ),
    };
  }

  const query = parsed.positionals[0];
  const field = getStringOption(parsed, 'field') ?? 'any';
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const rawText = await fetchText(state, PRIMO_PNXS, {
    params: {
      q: `${field},contains,${query}`,
      vid: PRIMO_VID,
      scope: 'MyInstitution',
      lang: 'en',
      limit: String(limit),
      offset: String(offset),
    },
    allowedHosts: ['lva.primo.exlibrisgroup.com'],
  });
  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Invalid Primo PNXS JSON: ${message}`);
  }
  const obj = isPlainRecord(data) ? data : {};
  const info = isPlainRecord(obj.info) ? obj.info : {};
  const docs = Array.isArray(obj.docs) ? obj.docs : [];
  const records = docs.map((d) => mapPnxsRecord(d));

  if (asJson) {
    return emitTrackedJson(state, {
      total: info.total ?? null,
      first: info.first ?? null,
      last: info.last ?? null,
      records,
    });
  }

  const lines: string[] = [
    `${String(info.total ?? 0)} result(s); showing ${String(info.first ?? 0)}-${String(info.last ?? 0)}:`,
  ];
  for (const rec of records) {
    lines.push(rec.title || '(no title)');
    lines.push(`  ${rec.creator} ${rec.date} [${rec.type}]`.trimEnd());
    lines.push(`  ${rec.record_url}`);
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
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
          usage: 'kinloom va-archives url [options]',
          summary: 'Print verified portal URLs (no search is run).',
          options: URL_OPTIONS,
        })
      ),
    };
  }

  const chanceryCase = getStringOption(parsed, 'chanceryCase');
  const catalogQuery = getStringOption(parsed, 'catalogQuery');
  const chronicle = getBooleanOption(parsed, 'chronicle');
  const land = getBooleanOption(parsed, 'land');
  const arvas = getBooleanOption(parsed, 'arvas');
  const chancery = getBooleanOption(parsed, 'chancery');

  const lines: string[] = [];
  if (chanceryCase) {
    lines.push(`${CHANCERY_DETAIL}?CFN=${chanceryCase}`);
  }
  if (catalogQuery) {
    lines.push(
      `${PRIMO_BASE}/discovery/search?vid=${encodeURIComponent(PRIMO_VID)}&query=any,contains,${pyQuote(catalogQuery)}&lang=en`
    );
  }
  if (chancery) {
    lines.push('https://www.lva.virginia.gov/collections/chancery', `${CHANCERY_BASE}/`);
  }
  if (chronicle) {
    lines.push(
      'https://www.virginiachronicle.com/  (free; search in the browser -- Cloudflare blocks curl/headless Chromium, verified 2026-11-24)'
    );
  }
  if (land) {
    lines.push(
      'https://lva-virginia.libguides.com/land-grants',
      'https://image.lva.virginia.gov/LONN/LO.html  (Virginia Land Office Patents and Grants Index, browse by volume)'
    );
  }
  if (arvas) {
    lines.push(
      'https://arvasarchive.org/  (browser-only; plain HTTP returns an empty 202, verified 2026-11-24)'
    );
  }
  if (lines.length === 0) {
    lines.push(
      'https://www.lva.virginia.gov/collections',
      'https://www.lva.virginia.gov/collections/digital-collections'
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

async function runGrantTif(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean,
  commandName: 'grant-tif' | 'lva-tif'
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GRANT_TIF_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: `kinloom va-archives ${commandName} <PATH_OR_URL> [options]`,
          summary:
            "Fetch (and cache) one Library of Virginia image-server scan (e.g. /LONN/LO-3/372/372_0195.tif). --out x.jpg converts TIFF to JPEG.",
          options: GRANT_TIF_OPTIONS,
        })
      ),
    };
  }

  let url: string;
  try {
    url = normalizeLvaImageUrl(parsed.positionals[0]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(message);
  }

  const outOpt = getStringOption(parsed, 'out');
  const outPath = outOpt ? path.resolve(ctx.cwd, outOpt) : undefined;
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const cachedPath = await fetchFile(state, url, [LVA_IMAGE_HOST]);
  const result: Record<string, unknown> = {
    url,
    cache_path: cachedPath,
    bytes: fs.statSync(cachedPath).size,
  };

  if (outPath) {
    const mode = await saveImage(cachedPath, outPath);
    result.out = outPath;
    result.mode = mode;
  }

  if (asJson) {
    return emitTrackedJson(state, result);
  }

  const text = outPath
    ? `saved ${String(result.out)} (${String(result.mode)}) from ${url}`
    : `cached ${url} -> ${cachedPath} (${String(result.bytes)} bytes); pass --out FILE to save it`;
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, text),
    cacheHit: state.tracker.allHits(),
  };
}

async function runDunmore(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DUNMORE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom va-archives dunmore <DRAWER> <CARD> [options]',
          summary:
            "Resolve a Dunmore's War (1774) index card to its page TIFFs on image.lva.virginia.gov.",
          options: DUNMORE_OPTIONS,
        })
      ),
    };
  }

  const [drawer, card] = parsed.positionals;
  if (!/^\d{1,5}\/W\d{1,6}$/.test(drawer)) {
    throw new CliValidationError(
      `Invalid drawer (expected e.g. 0001/W0001): ${JSON.stringify(drawer)}`
    );
  }
  if (!/^\d{1,6}$/.test(card)) {
    throw new CliValidationError(`Invalid card number: ${JSON.stringify(card)}`);
  }

  const pageNo = getNumberOption(parsed, 'pageNo');
  const outOpt = getStringOption(parsed, 'out');
  const outPath = outOpt ? path.resolve(ctx.cwd, outOpt) : undefined;
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const html = await fetchText(state, DUNMORE_CGI, {
    params: { dir: drawer, card },
    allowedHosts: [LVA_IMAGE_HOST],
  });
  const drawerParsed = parseDunmoreDrawer(html);
  if (drawerParsed.images.length === 0) {
    throw new RecordRuntimeError("No page images found on the Dunmore's War drawer page.");
  }

  let chosen: DunmoreImage | undefined;
  if (pageNo !== undefined) {
    chosen = drawerParsed.images.find((im) => im.page === pageNo);
    if (!chosen) {
      throw new RecordRuntimeError(`Page ${pageNo} is not listed for this card.`);
    }
  } else {
    chosen = drawerParsed.images.find((im) => im.current) ?? drawerParsed.images[0];
  }

  const result: Record<string, unknown> = {
    ...drawerParsed,
    drawer,
    card,
    source_url: `${DUNMORE_CGI}?dir=${drawer}&card=${card}`,
    selected: chosen,
  };

  if (outPath) {
    const cachedPath = await fetchFile(state, chosen.url, [LVA_IMAGE_HOST]);
    const mode = await saveImage(cachedPath, outPath);
    result.out = outPath;
    result.mode = mode;
  }

  if (asJson) {
    return emitTrackedJson(state, result);
  }

  const lines: string[] = [
    `Dunmore's War drawer ${drawer} card ${card}: page ${String(drawerParsed.current_page ?? 'unknown')}`,
  ];
  for (const im of drawerParsed.images) {
    const mark = im === chosen ? '*' : ' ';
    lines.push(` ${mark} page ${String(im.page ?? '?')}: ${im.url}`);
  }
  if (outPath) {
    lines.push(`saved ${String(result.out)} (${String(result.mode)})`);
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

async function runDownloadRosetta(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, ROSETTA_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom va-archives download-rosetta <IE_ID> [options]',
          summary:
            'Download a delivered file (PDF/image) for a Library of Virginia Rosetta IE id.',
          options: ROSETTA_OPTIONS,
        })
      ),
    };
  }

  const ie = validateIeId(parsed.positionals[0]);
  const rawFl = getStringOption(parsed, 'flId');
  const flId = rawFl !== undefined ? validateFlId(rawFl) : undefined;
  const fileIndex = getNumberOption(parsed, 'fileIndex');
  const listOnly = getBooleanOption(parsed, 'listOnly');
  const outOpt = getStringOption(parsed, 'out');
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const info = await resolveRosetta(state, ie);
  const files = info.files;

  if (listOnly) {
    if (asJson) {
      const { session: _session, ...withoutSession } = info;
      return emitTrackedJson(state, withoutSession);
    }
    const lines = files.map((f, idx) => {
      const star = f.fl === info.initial ? '*' : ' ';
      return ` ${star} ${idx + 1}. ${f.fl}  ${f.title}`;
    });
    return {
      exitCode: 0,
      bytesOut: emitStdout(ctx.io, lines.join('\n')),
      cacheHit: state.tracker.allHits(),
    };
  }

  let fl: string;
  if (flId !== undefined) {
    if (!files.some((f) => f.fl === flId)) {
      throw new RecordRuntimeError(`${flId} is not a file of ${ie}; see --list.`);
    }
    fl = flId;
  } else if (fileIndex !== undefined) {
    if (fileIndex < 1 || fileIndex > files.length) {
      throw new CliValidationError(`--file must be 1..${files.length}`);
    }
    fl = files[fileIndex - 1].fl;
  } else {
    fl = info.initial ?? files[0].fl;
  }

  const expectedBinPath = path.join(state.cacheRoot, 'rosetta', ie, `${fl}.bin`);
  const binAlreadyCached =
    !state.refresh && isCacheMetaValid(expectedBinPath, null, ctx.nowMs) !== undefined;
  if (!info.session && !binAlreadyCached) {
    const warmUrl = buildUrlWithParams(ROSETTA_DELIVERY, { dps_pid: ie });
    await httpRequest(warmUrl, {
      userAgent: USER_AGENT,
      timeoutMs: 60_000,
      maxAttempts: 1,
      cookieJar: state.cookieJar,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [ROSETTA_HOST] },
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
    });
  }

  const { path: cachedPath, meta } = await downloadRosettaFile(state, ie, fl);
  const destPath = outOpt
    ? path.resolve(ctx.cwd, outOpt)
    : path.resolve(ctx.cwd, `${ie}_${fl}${extForContentType(meta.content_type)}`);
  copyAtomic(cachedPath, destPath);
  const bytes = fs.statSync(destPath).size;

  const result: Record<string, unknown> = {
    ie,
    fl,
    content_type: meta.content_type,
    out: destPath,
    bytes,
    cache_path: cachedPath,
  };

  if (asJson) {
    return emitTrackedJson(state, result);
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(
      ctx.io,
      `saved ${destPath} (${bytes} bytes, ${meta.content_type}) from ${ie}/${fl}`
    ),
    cacheHit: state.tracker.allHits(),
  };
}

export const runVaArchivesCommand: RecordHandler = async (
  args,
  ctx
): Promise<RecordCommandOutcome> => {
  try {
    let globalRefresh = false;
    let remaining = [...args];
    while (remaining[0] === '--refresh') {
      globalRefresh = true;
      remaining = remaining.slice(1);
    }

    if (remaining.length === 0 || remaining[0] === '--help' || remaining[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }

    const [subcmd, ...rest] = remaining;
    switch (subcmd) {
      case 'chancery': {
        if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
          return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderChanceryHelp()) };
        }
        const [chancerySub, ...chanceryRest] = rest;
        switch (chancerySub) {
          case 'search':
            return await runChancerySearch(chanceryRest, ctx, globalRefresh);
          case 'case':
            return await runChanceryCase(chanceryRest, ctx, globalRefresh);
          case 'download':
            return await runChanceryDownload(chanceryRest, ctx, globalRefresh);
          case 'localities':
            return await runChanceryLocalities(chanceryRest, ctx, globalRefresh);
          default:
            throw new CliValidationError(
              `No such chancery command '${chancerySub}'. Run 'kinloom va-archives chancery --help'.`
            );
        }
      }
      case 'catalog':
        return await runCatalog(rest, ctx, globalRefresh);
      case 'url':
        return runUrl(rest, ctx);
      case 'grant-tif':
        return await runGrantTif(rest, ctx, globalRefresh, 'grant-tif');
      case 'lva-tif':
        return await runGrantTif(rest, ctx, globalRefresh, 'lva-tif');
      case 'dunmore':
        return await runDunmore(rest, ctx, globalRefresh);
      case 'download-rosetta':
        return await runDownloadRosetta(rest, ctx, globalRefresh);
      default:
        throw new CliValidationError(
          `No such command '${subcmd}'. Run 'kinloom va-archives --script-help'.`
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
