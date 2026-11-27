import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, withAdvisoryLock } from '../../runtime/cache.js';
import { atomicCopyFileSync, runWithConcurrency } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  downloadObjectToCache,
  readCachedDownloadEntry,
  resolveDirectDownloadDest,
  safeUrlFilename,
  urlDownloadCachePaths,
} from './downloadCore.js';
import { resolveSafeChild, safeObjectFilename, validateNaraDownloadUrl } from './queryAndRecords.js';
import {
  CATALOG_WEB_BASE,
  type CachedDownloadInfo,
  DOWNLOAD_MAX_WORKERS,
  type NaraDigitalObjectSummary,
  type NaraRecordSummary,
} from './types.js';

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
