import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { sha256Hex } from '../../runtime/cache.js';
import {
  atomicWriteCompactJson,
  IncompleteDownloadError,
  readJsonRecordIfValid,
} from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import { fetchFollowingRedirects, retryDelayMs } from './catalogTransport.js';
import {
  detectErrorPayload,
  hasParentTraversal,
  resolveSafeChild,
  resolveUserPath,
  validateNaraDownloadUrl,
} from './queryAndRecords.js';
import { type CachedDownloadInfo, DOWNLOAD_ATTEMPTS, TRANSIENT_STATUS_CODES, USER_AGENT } from './types.js';

export function validateDownloadedFile(
  filePath: string,
  options: { readonly url: string; readonly contentType: string; readonly filenameHint?: string }
): number {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Failed reading downloaded file for ${options.url}: ${message}`);
  }
  let size: number;
  let head: Buffer;
  try {
    size = fs.fstatSync(fd).size;
    if (size <= 0) {
      throw new RecordRuntimeError(`Downloaded empty response from ${options.url}`);
    }
    const buf = Buffer.alloc(Math.min(512, size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  let urlPath = '';
  try {
    urlPath = new URL(options.url).pathname;
  } catch {
    urlPath = '';
  }
  const reason = detectErrorPayload(head, options.contentType, options.filenameHint || urlPath);
  if (reason !== null) {
    throw new RecordRuntimeError(`Refusing ${reason} when downloading ${options.url}`);
  }
  return size;
}

export function safeUrlFilename(url: string, contentType = ''): string {
  let rawPath = '';
  try {
    rawPath = new URL(url).pathname;
  } catch {
    rawPath = url;
  }
  const slashIdx = rawPath.lastIndexOf('/');
  const lastSeg = slashIdx === -1 ? rawPath : rawPath.slice(slashIdx + 1);
  let rawName: string;
  try {
    rawName = decodeURIComponent(lastSeg).trim();
  } catch {
    rawName = lastSeg.trim();
  }
  const normalized = rawName.replace(/\\/g, '/');
  const normSlash = normalized.lastIndexOf('/');
  const candidate = (normSlash === -1 ? normalized : normalized.slice(normSlash + 1)).trim();
  let safe = candidate.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!safe || safe === '.' || safe === '..' || safe.includes('..')) {
    const ctLower = (contentType || '').toLowerCase();
    if (ctLower.includes('pdf')) {
      safe = 'download.pdf';
    } else if (ctLower.includes('jpeg') || ctLower.includes('jpg')) {
      safe = 'download.jpg';
    } else if (ctLower.includes('png')) {
      safe = 'download.png';
    } else if (ctLower.includes('tiff') || ctLower.includes('tif')) {
      safe = 'download.tif';
    } else {
      safe = 'download.bin';
    }
  }
  return safe;
}

export function urlDownloadCachePaths(url: string, cacheRoot: string): readonly [string, string, string] {
  const digest = sha256Hex(url);
  const dir = path.join(cacheRoot, 'downloads');
  return [
    resolveSafeChild(dir, `${digest}.bin`),
    resolveSafeChild(dir, `${digest}.json`),
    resolveSafeChild(dir, `${digest}.lock`),
  ];
}

export function readCachedDownloadEntry(
  binPath: string,
  metaPath: string,
  options: {
    readonly url: string;
    readonly ttlHours: number | null;
    readonly filenameHint?: string;
    readonly nowMs: () => number;
  }
): CachedDownloadInfo | null {
  if (options.ttlHours !== null && options.ttlHours <= 0) {
    return null;
  }
  try {
    if (!fs.statSync(binPath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const meta = readJsonRecordIfValid(metaPath);
  if (meta !== null && options.ttlHours !== null) {
    const cachedAt = meta['cached_at'];
    if (
      typeof cachedAt === 'number' &&
      Number.isFinite(cachedAt) &&
      options.nowMs() / 1000 - cachedAt > options.ttlHours * 3600
    ) {
      return null;
    }
  }
  const contentType = typeof meta?.['content_type'] === 'string' ? meta['content_type'] : '';
  let nbytes: number;
  try {
    nbytes = validateDownloadedFile(binPath, {
      url: options.url,
      contentType,
      filenameHint: options.filenameHint ?? '',
    });
  } catch {
    return null;
  }
  if (meta !== null) {
    const expectedBytes = meta['bytes'];
    if (typeof expectedBytes === 'number' && Number.isInteger(expectedBytes) && expectedBytes > 0) {
      if (nbytes !== expectedBytes) {
        return null;
      }
    }
  }
  return { bytes: nbytes, content_type: contentType };
}

export async function downloadObjectToCache(
  objUrl: string,
  cachedObjPath: string,
  options: {
    readonly metaPath?: string;
    readonly filenameHint?: string;
    readonly timeoutSec: number;
  },
  ctx: RecordCommandContext
): Promise<CachedDownloadInfo> {
  const validatedUrl = validateNaraDownloadUrl(objUrl);
  fs.mkdirSync(path.dirname(cachedObjPath), { recursive: true });
  const timeoutMs = Math.max(1000, Math.round(options.timeoutSec * 1000));
  let lastErrorMessage = '';

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const base = path.basename(cachedObjPath);
    const tmpPath = path.join(
      path.dirname(cachedObjPath),
      `.${base}.${process.pid}.${process.hrtime.bigint()}.tmp`
    );
    try {
      const resp = await fetchFollowingRedirects(validatedUrl, {
        headers: { 'User-Agent': USER_AGENT },
        timeoutMs,
        fetchImpl: ctx.fetchImpl,
        validateUrl: validateNaraDownloadUrl,
      });

      if (TRANSIENT_STATUS_CODES.has(resp.status)) {
        if (attempt < DOWNLOAD_ATTEMPTS) {
          await ctx.sleepFn(retryDelayMs(attempt, resp, ctx.nowMs));
          continue;
        }
        throw new RecordRuntimeError(`HTTP ${resp.status} downloading ${validatedUrl}`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new RecordRuntimeError(`HTTP ${resp.status} downloading ${validatedUrl}`);
      }

      const contentType = (resp.headers.get('content-type') ?? '').split(';', 1)[0].trim();
      const contentEncoding = (resp.headers.get('content-encoding') ?? '').trim().toLowerCase();
      const rawLen = (resp.headers.get('content-length') ?? '').trim();
      let expectedLen: number | null = null;
      if (rawLen && (!contentEncoding || contentEncoding === 'identity') && /^\d+$/.test(rawLen)) {
        const parsedLen = Number.parseInt(rawLen, 10);
        if (parsedLen > 0) {
          expectedLen = parsedLen;
        }
      }

      const bytes = Buffer.from(await resp.arrayBuffer());
      if (expectedLen !== null && bytes.length < expectedLen) {
        throw new IncompleteDownloadError(
          `Incomplete download for ${validatedUrl}: received ${bytes.length} of ${expectedLen} bytes`
        );
      }

      fs.writeFileSync(tmpPath, bytes);
      const size = validateDownloadedFile(tmpPath, {
        url: validatedUrl,
        contentType,
        filenameHint: options.filenameHint || path.basename(cachedObjPath),
      });
      fs.renameSync(tmpPath, cachedObjPath);
      const info = {
        url: validatedUrl,
        content_type: contentType,
        bytes: size,
        cached_at: ctx.nowMs() / 1000,
      };
      if (options.metaPath) {
        atomicWriteCompactJson(options.metaPath, info);
      }
      return { bytes: size, content_type: contentType };
    } catch (err: unknown) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure.
      }
      if (err instanceof IncompleteDownloadError) {
        lastErrorMessage = err.message;
        if (attempt >= DOWNLOAD_ATTEMPTS) {
          throw new RecordRuntimeError(
            `Failed downloading ${validatedUrl} after ${DOWNLOAD_ATTEMPTS} attempts: ${err.message}`
          );
        }
        await ctx.sleepFn(retryDelayMs(attempt, null, ctx.nowMs));
        continue;
      }
      if (err instanceof RecordRuntimeError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      lastErrorMessage = message;
      if (attempt >= DOWNLOAD_ATTEMPTS) {
        throw new RecordRuntimeError(
          `Failed downloading ${validatedUrl} after ${DOWNLOAD_ATTEMPTS} attempts: ${message}`
        );
      }
      await ctx.sleepFn(retryDelayMs(attempt, null, ctx.nowMs));
    }
  }

  throw new RecordRuntimeError(`Failed downloading ${validatedUrl}: ${lastErrorMessage}`);
}

export function resolveDirectDownloadDest(
  rawOutPath: string | undefined,
  url: string,
  contentType: string,
  cwd: string
): string {
  const filename = safeUrlFilename(url, contentType);
  if (!rawOutPath) {
    return resolveSafeChild(cwd, filename);
  }
  if (rawOutPath.includes('\0')) {
    throw new CliValidationError(`Invalid --out path: ${rawOutPath}`);
  }
  const resolved = resolveUserPath(rawOutPath, cwd);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return resolveSafeChild(resolved, filename);
    }
  } catch {
    // Does not exist yet.
  }
  if (!path.extname(rawOutPath)) {
    if (hasParentTraversal(rawOutPath)) {
      throw new RecordRuntimeError(`Unsafe output path containing '..': ${rawOutPath}`);
    }
    fs.mkdirSync(resolved, { recursive: true });
    return resolveSafeChild(resolved, filename);
  }
  if (hasParentTraversal(rawOutPath)) {
    throw new RecordRuntimeError(`Unsafe output path containing '..': ${rawOutPath}`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}
