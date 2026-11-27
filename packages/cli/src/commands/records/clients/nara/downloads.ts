import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { atomicWriteFileSync, sha256Hex, withAdvisoryLock } from '../../runtime/cache.js';
import {
  atomicCopyFileSync,
  atomicWriteCompactJson,
  IncompleteDownloadError,
  readJsonRecordIfValid,
  runWithConcurrency,
} from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { fetchFollowingRedirects, retryDelayMs } from './catalogTransport.js';
import {
  detectErrorPayload,
  hasParentTraversal,
  resolveSafeChild,
  resolveUserPath,
  safeObjectFilename,
  validateNaraDownloadUrl,
} from './queryAndRecords.js';
import {
  CATALOG_WEB_BASE,
  type CachedDownloadInfo,
  DOWNLOAD_ATTEMPTS,
  DOWNLOAD_MAX_WORKERS,
  type NaraDigitalObjectSummary,
  type NaraRecordSummary,
  TRANSIENT_STATUS_CODES,
  USER_AGENT,
} from './types.js';

function validateDownloadedFile(
  filePath: string,
  options: { readonly url: string; readonly contentType: string; readonly filenameHint?: string }
): number {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Failed reading downloaded file for ${options.url}: ${message}`);
  }
  if (size <= 0) {
    throw new RecordRuntimeError(`Downloaded empty response from ${options.url}`);
  }
  const fd = fs.openSync(filePath, 'r');
  let head: Buffer;
  try {
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

function safeUrlFilename(url: string, contentType = ''): string {
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

function urlDownloadCachePaths(url: string, cacheRoot: string): readonly [string, string, string] {
  const digest = sha256Hex(url);
  const dir = path.join(cacheRoot, 'downloads');
  return [
    resolveSafeChild(dir, `${digest}.bin`),
    resolveSafeChild(dir, `${digest}.json`),
    resolveSafeChild(dir, `${digest}.lock`),
  ];
}

function readCachedDownloadEntry(
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
    const cachedAt = meta.cached_at;
    if (
      typeof cachedAt === 'number' &&
      Number.isFinite(cachedAt) &&
      options.nowMs() / 1000 - cachedAt > options.ttlHours * 3600
    ) {
      return null;
    }
  }
  const contentType = typeof meta?.content_type === 'string' ? meta.content_type : '';
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
    const expectedBytes = meta.bytes;
    if (typeof expectedBytes === 'number' && Number.isInteger(expectedBytes) && expectedBytes > 0) {
      if (nbytes !== expectedBytes) {
        return null;
      }
    }
  }
  return { bytes: nbytes, content_type: contentType };
}

async function downloadObjectToCache(
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

function resolveDirectDownloadDest(
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

export async function downloadDirectUrl(
  url: string,
  options: {
    readonly outPath: string | undefined;
    readonly overwrite: boolean;
    readonly refresh: boolean;
    readonly timeoutSec: number;
    readonly ttlHours: number;
    readonly asJson: boolean;
    readonly cacheRoot: string;
  },
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const validatedUrl = validateNaraDownloadUrl(url);
  const [binPath, metaPath, lockPath] = urlDownloadCachePaths(validatedUrl, options.cacheRoot);
  const filenameHint = safeUrlFilename(validatedUrl);

  let cacheHit = false;
  let finalEntry: CachedDownloadInfo | null = null;
  if (!options.refresh) {
    finalEntry = readCachedDownloadEntry(binPath, metaPath, {
      url: validatedUrl,
      ttlHours: options.ttlHours,
      filenameHint,
      nowMs: ctx.nowMs,
    });
    if (finalEntry !== null) {
      cacheHit = true;
    }
  }

  if (finalEntry === null) {
    const locked = await withAdvisoryLock(
      lockPath,
      async (): Promise<{ readonly entry: CachedDownloadInfo; readonly hit: boolean }> => {
        if (!options.refresh) {
          const cached = readCachedDownloadEntry(binPath, metaPath, {
            url: validatedUrl,
            ttlHours: options.ttlHours,
            filenameHint,
            nowMs: ctx.nowMs,
          });
          if (cached !== null) {
            return { entry: cached, hit: true };
          }
        }
        const downloaded = await downloadObjectToCache(
          validatedUrl,
          binPath,
          { metaPath, filenameHint, timeoutSec: options.timeoutSec },
          ctx
        );
        return { entry: downloaded, hit: false };
      },
      { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
    );
    finalEntry = locked.entry;
    cacheHit = locked.hit;
  }

  const contentType = finalEntry.content_type;
  const nbytes = finalEntry.bytes;
  const dest = resolveDirectDownloadDest(options.outPath, validatedUrl, contentType, ctx.cwd);

  let bytesOut = 0;
  if (fs.existsSync(dest) && !options.overwrite && !options.refresh) {
    if (!options.asJson) {
      bytesOut += emitStdout(ctx.io, `Exists (skip): ${dest}`);
    }
  } else {
    atomicCopyFileSync(binPath, dest);
    if (!options.asJson) {
      const verb = cacheHit ? 'Cached' : 'Downloaded';
      bytesOut += emitStdout(ctx.io, `${verb}: ${dest} (${nbytes.toLocaleString('en-US')} bytes)`);
    }
  }

  if (options.asJson) {
    bytesOut += emitJsonStdout(ctx.io, {
      cache_hit: cacheHit,
      bytes: nbytes,
      path: dest,
      url: validatedUrl,
      content_type: contentType,
    });
  }

  return { exitCode: 0, bytesOut, cacheHit };
}

interface PreparedObject {
  readonly pageNum: number;
  readonly objUrl: string;
  readonly cacheFilename: string;
  readonly cachedObjPath: string;
  readonly metaSidecar: string;
  readonly dest: string;
}

interface DownloadSlotResult {
  readonly page: number;
  readonly file: string;
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
  readonly content_type: string;
  readonly cache_hit: boolean;
  readonly cachedPath: string;
  readonly dest: string;
}

export async function downloadRecordObjects(
  cleanId: string,
  rec: NaraRecordSummary,
  selectedObjs: readonly NaraDigitalObjectSummary[],
  options: {
    readonly targetDir: string;
    readonly cacheRoot: string;
    readonly totalCount: number;
    readonly metaCacheHit: boolean;
    readonly metadata: boolean;
    readonly overwrite: boolean;
    readonly refresh: boolean;
    readonly timeoutSec: number;
    readonly ttlOverride: number | null;
    readonly asJson: boolean;
  },
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  fs.mkdirSync(options.targetDir, { recursive: true });
  const objCacheDir = path.join(options.cacheRoot, 'objects', cleanId);

  const prepared: PreparedObject[] = [];
  for (const obj of selectedObjs) {
    if (!obj.url) {
      ctx.io.stderr(`Skipping page ${obj.page}: missing url`);
      continue;
    }
    validateNaraDownloadUrl(obj.url);
    const cacheFilename = safeObjectFilename(obj.page, obj.filename);
    prepared.push({
      pageNum: obj.page,
      objUrl: obj.url,
      cacheFilename,
      cachedObjPath: resolveSafeChild(objCacheDir, cacheFilename),
      metaSidecar: resolveSafeChild(objCacheDir, `${cacheFilename}.meta.json`),
      dest: resolveSafeChild(options.targetDir, cacheFilename),
    });
  }

  const results: (DownloadSlotResult | null)[] = Array.from({ length: prepared.length }, () => null);
  const uncachedIndices: number[] = [];

  for (let idx = 0; idx < prepared.length; idx += 1) {
    const item = prepared[idx];
    if (!options.refresh) {
      const cachedEntry = readCachedDownloadEntry(item.cachedObjPath, item.metaSidecar, {
        url: item.objUrl,
        ttlHours: options.ttlOverride,
        filenameHint: item.cacheFilename,
        nowMs: ctx.nowMs,
      });
      if (cachedEntry !== null) {
        results[idx] = {
          page: item.pageNum,
          file: path.basename(item.dest),
          path: item.dest,
          url: item.objUrl,
          bytes: cachedEntry.bytes,
          content_type: cachedEntry.content_type,
          cache_hit: true,
          cachedPath: item.cachedObjPath,
          dest: item.dest,
        };
        continue;
      }
    }
    uncachedIndices.push(idx);
  }

  if (uncachedIndices.length > 0) {
    const fetched = await runWithConcurrency(uncachedIndices, DOWNLOAD_MAX_WORKERS, async (slotIdx) => {
      const item = prepared[slotIdx];
      const lockPath = resolveSafeChild(
        path.join(options.cacheRoot, '_locks'),
        `object_${cleanId}_${item.cacheFilename}.lock`
      );
      const locked = await withAdvisoryLock(
        lockPath,
        async (): Promise<{ readonly entry: CachedDownloadInfo; readonly hit: boolean }> => {
          if (!options.refresh) {
            const cached = readCachedDownloadEntry(item.cachedObjPath, item.metaSidecar, {
              url: item.objUrl,
              ttlHours: options.ttlOverride,
              filenameHint: item.cacheFilename,
              nowMs: ctx.nowMs,
            });
            if (cached !== null) {
              return { entry: cached, hit: true };
            }
          }
          const downloaded = await downloadObjectToCache(
            item.objUrl,
            item.cachedObjPath,
            { metaPath: item.metaSidecar, filenameHint: item.cacheFilename, timeoutSec: options.timeoutSec },
            ctx
          );
          return { entry: downloaded, hit: false };
        },
        { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
      );
      return {
        slotIdx,
        record: {
          page: item.pageNum,
          file: path.basename(item.dest),
          path: item.dest,
          url: item.objUrl,
          bytes: locked.entry.bytes,
          content_type: locked.entry.content_type,
          cache_hit: locked.hit,
          cachedPath: item.cachedObjPath,
          dest: item.dest,
        } satisfies DownloadSlotResult,
      };
    });

    for (const { slotIdx, record } of fetched) {
      results[slotIdx] = record;
    }
  }

  const downloadedManifest: { readonly page: number; readonly file: string; readonly url: string }[] = [];
  const jsonFiles: {
    readonly page: number;
    readonly file: string;
    readonly path: string;
    readonly url: string;
    readonly bytes: number;
    readonly content_type: string;
    readonly cache_hit: boolean;
  }[] = [];
  let totalBytes = 0;
  let bytesOut = 0;

  for (const item of results) {
    if (!item) {
      continue;
    }
    if (fs.existsSync(item.dest) && !options.overwrite && !options.refresh) {
      if (!options.asJson) {
        bytesOut += emitStdout(ctx.io, `Exists (skip): ${item.dest}`);
      }
    } else {
      atomicCopyFileSync(item.cachedPath, item.dest);
      if (!options.asJson) {
        const verb = item.cache_hit ? 'Cached' : 'Downloaded';
        const actualSize = fs.statSync(item.dest).size;
        bytesOut += emitStdout(
          ctx.io,
          `${verb} [${item.page}/${options.totalCount}]: ${item.dest} (${actualSize.toLocaleString('en-US')} bytes)`
        );
      }
    }
    totalBytes += item.bytes;
    downloadedManifest.push({ page: item.page, file: item.file, url: item.url });
    jsonFiles.push({
      page: item.page,
      file: item.file,
      path: item.path,
      url: item.url,
      bytes: item.bytes,
      content_type: item.content_type,
      cache_hit: item.cache_hit,
    });
  }

  let metaPathOut: string | null = null;
  if (options.metadata) {
    const { objects: _omitted, ...compactMeta } = rec;
    metaPathOut = path.join(options.targetDir, 'metadata.json');
    atomicWriteFileSync(
      metaPathOut,
      `${JSON.stringify({ ...compactMeta, downloaded: downloadedManifest }, null, 2)}\n`
    );
    if (!options.asJson) {
      bytesOut += emitStdout(ctx.io, `Saved metadata: ${metaPathOut}`);
    }
  }

  const allCacheHit = options.metaCacheHit && jsonFiles.length > 0 && jsonFiles.every((f) => f.cache_hit);

  if (options.asJson) {
    const primaryCt = jsonFiles[0]?.content_type ?? '';
    bytesOut += emitJsonStdout(ctx.io, {
      naId: cleanId,
      url: rec.url || `${CATALOG_WEB_BASE}/id/${cleanId}`,
      path: options.targetDir,
      bytes: totalBytes,
      count: jsonFiles.length,
      content_type: primaryCt,
      cache_hit: allCacheHit,
      metadata_cache_hit: options.metaCacheHit,
      metadata_path: metaPathOut,
      files: jsonFiles,
    });
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  }

  bytesOut += emitStdout(ctx.io, `Done: ${downloadedManifest.length} file(s) in ${options.targetDir}`);
  return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
}
