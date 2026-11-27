import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  CacheHitTracker,
  canonicalJsonStringify,
  sha256Hex,
  withAdvisoryLock,
} from '../../runtime/cache.js';
import { CookieJar, httpRequest } from '../../runtime/http.js';
import { convertTiffToJpeg } from '../../runtime/image.js';
import { atomicCopyFileSync, readJsonRecordIfValid } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  type CachedMeta,
  getCacheRoot,
  isRosettaFilesCache,
  ROSETTA_DELIVERY,
  ROSETTA_HOST,
  ROSETTA_VIEWER,
  type RosettaFilesCache,
  resolveTtlHours,
  USER_AGENT,
  type VaSessionState,
} from './domain.js';
import { parseRosettaDelivery, parseRosettaViewer } from './parsers.js';

export function makeState(
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

export function metaPathFor(cachePath: string): string {
  return `${cachePath}.meta.json`;
}

export function isCacheMetaValid(
  cachePath: string,
  ttlHours: number | null,
  nowMs: () => number
): CachedMeta | undefined {
  const meta = readJsonRecordIfValid(metaPathFor(cachePath));
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

export function buildUrlWithParams(baseUrl: string, params?: Readonly<Record<string, string>>): string {
  if (!params || Object.keys(params).length === 0) {
    return baseUrl;
  }
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
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

export async function cachedFetch(
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

export async function fetchText(
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

export async function fetchFile(
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

export async function saveImage(srcPath: string, outPath: string): Promise<'jpeg' | 'raw'> {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    await convertTiffToJpeg(srcPath, outPath, 90);
    return 'jpeg';
  }
  atomicCopyFileSync(srcPath, outPath);
  return 'raw';
}

export function emitTrackedJson(
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

export async function resolveRosetta(
  state: VaSessionState,
  ie: string
): Promise<RosettaFilesCache & { readonly session: boolean }> {
  const ieCacheDir = path.join(state.cacheRoot, 'rosetta', ie);
  const filesPath = path.join(ieCacheDir, 'files.json');

  if (!state.refresh) {
    const cached = readJsonRecordIfValid(filesPath);
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
    throw new RecordRuntimeError(`No delivered files found for ${ie} (restricted or not a viewable IE).`);
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

export async function warmRosettaSession(state: VaSessionState, ie: string): Promise<void> {
  const warmUrl = buildUrlWithParams(ROSETTA_DELIVERY, { dps_pid: ie });
  await httpRequest(warmUrl, {
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    maxAttempts: 1,
    cookieJar: state.cookieJar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: [ROSETTA_HOST] },
    fetchImpl: state.ctx.fetchImpl,
    sleepFn: state.ctx.sleepFn,
    nowMs: state.ctx.nowMs,
  });
}

export async function downloadRosettaFile(
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
