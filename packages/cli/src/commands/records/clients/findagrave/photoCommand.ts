import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { atomicWriteFileSync, withAdvisoryLock } from '../../runtime/cache.js';
import { atomicCopyFileSync, isPlainRecord, resolveSafeChildPath } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { PHOTO_PARSE_SPEC, renderPhotoHelp } from './cliSpecs.js';
import {
  fmtCemetery,
  getCacheRoot,
  type JsonRecord,
  memorialUrl,
  type PhotoSavedItem,
  photoBytesAccepted,
  primaryName,
  resolveCacheTtlHours,
  safePhotoFilename,
  sanitizePrefix,
  validateEntityId,
  validatePhotoUrl,
} from './domain.js';
import {
  fetchPhotoBytes,
  loadOrFetchMemorialsWithHits,
  photoCacheFresh,
  storePhotoCache,
} from './transport.js';

export async function runPhoto(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
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
    const cachedPath = resolveSafeChildPath(photosCacheDir, cacheFilename);
    const dest = resolveSafeChildPath(outDir, `${stemPrefix}${cacheFilename}`);

    const copyCached = (fromCache: boolean): number => {
      atomicCopyFileSync(cachedPath, dest);
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
      const lockPath = resolveSafeChildPath(
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
    const metaPath = resolveSafeChildPath(outDir, `${stemPrefix}${cleanId}.metadata.json`);
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
