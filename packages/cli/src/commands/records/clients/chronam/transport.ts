import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, sha256Hex, withAdvisoryLock } from '../../runtime/cache.js';
import { IncompleteDownloadError, isPlainRecord } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  CACHE_SCHEMA,
  type CachedFileResult,
  type ChronamAssetKind,
  DOWNLOAD_HEADERS,
  detectInvalidDownload,
  MAX_ATTEMPTS,
  RETRYABLE_STATUS_CODES,
  resolveChronamCacheDir,
  resolveSafeChild,
  validateLocUrl,
} from './domain.js';
import { fetchFollowingLocRedirects, isTimeoutError, retryDelaySeconds } from './httpFetch.js';

export { cachedGetJson, getJson } from './httpFetch.js';

// --- file validation & disk cache helpers ------------------------------------

function validateDownloadFile(
  filePath: string,
  options: { readonly url: string; readonly contentType: string; readonly kind: ChronamAssetKind }
): number {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Failed reading downloaded file for ${options.url}: ${message}`);
  }
  let nbytes: number;
  let head: Buffer;
  try {
    nbytes = fs.fstatSync(fd).size;
    if (nbytes <= 0) {
      throw new RecordRuntimeError(`Download was empty: ${options.url}`);
    }
    head = Buffer.alloc(Math.min(512, nbytes));
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const reason = detectInvalidDownload(head, options.contentType, options.kind);
  if (reason !== null) {
    throw new RecordRuntimeError(`Refusing ${reason} when downloading ${options.url}`);
  }
  return nbytes;
}

function fileCachePaths(
  cacheDir: string,
  url: string
): readonly [binPath: string, metaPath: string, lockPath: string] {
  const key = sha256Hex(url);
  const root = path.join(cacheDir, 'files');
  return [
    resolveSafeChild(root, `${key}.bin`),
    resolveSafeChild(root, `${key}.json`),
    resolveSafeChild(root, `${key}.lock`),
  ];
}

function readCachedFileMeta(
  binPath: string,
  metaPath: string,
  ttlHours: number,
  options: { readonly kind: ChronamAssetKind; readonly url: string; readonly nowMs: () => number }
): { readonly nbytes: number; readonly contentType: string } | null {
  if (ttlHours <= 0) {
    return null;
  }
  try {
    if (!fs.statSync(binPath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainRecord(raw) || raw.schema !== CACHE_SCHEMA) {
    return null;
  }
  const fetchedAt = raw.fetched_at;
  const nbytes = raw.nbytes;
  if (
    typeof fetchedAt !== 'number' ||
    !Number.isFinite(fetchedAt) ||
    typeof nbytes !== 'number' ||
    !Number.isInteger(nbytes) ||
    nbytes <= 0
  ) {
    return null;
  }
  const nowSec = options.nowMs() / 1000;
  if (nowSec - fetchedAt > ttlHours * 3600) {
    return null;
  }
  const contentType = typeof raw.content_type === 'string' ? raw.content_type : '';
  const fallbackUrl = typeof raw.url === 'string' ? raw.url : '';
  try {
    const actual = validateDownloadFile(binPath, {
      url: options.url || fallbackUrl,
      contentType,
      kind: options.kind,
    });
    if (actual !== nbytes) {
      return null;
    }
    return { nbytes: actual, contentType };
  } catch {
    return null;
  }
}

// --- file download helpers ---------------------------------------------------

function unlinkQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

async function writeResponseToFile(resp: Response, tmpPath: string): Promise<number> {
  const fd = fs.openSync(tmpPath, 'w');
  let written = 0;
  try {
    if (resp.body) {
      const reader = resp.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value && value.byteLength > 0) {
            fs.writeSync(fd, value);
            written += value.byteLength;
          }
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const arr = Buffer.from(await resp.arrayBuffer());
      if (arr.byteLength > 0) {
        fs.writeSync(fd, arr);
        written += arr.byteLength;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return written;
}

export async function streamDownloadToPath(
  ctx: RecordCommandContext,
  url: string,
  destPath: string,
  options: {
    readonly timeout: number;
    readonly kind?: ChronamAssetKind;
  }
): Promise<{ readonly nbytes: number; readonly contentType: string }> {
  const validatedUrl = validateLocUrl(url);
  const kind: ChronamAssetKind = options.kind ?? 'bin';
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const deadlineMs = ctx.nowMs() + Math.max(1.0, options.timeout) * 1000;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const remainingSec = (deadlineMs - ctx.nowMs()) / 1000;
    if (remainingSec <= 0.25) {
      break;
    }
    const base = path.basename(destPath);
    const tmpPath = path.join(
      path.dirname(destPath),
      `.${base}.${process.pid}.${process.hrtime.bigint()}.tmp`
    );

    const controller = new AbortController();
    let abortedByTimer = false;
    const timer = setTimeout(
      () => {
        abortedByTimer = true;
        controller.abort(new DOMException('Download timed out', 'TimeoutError'));
      },
      Math.max(1, Math.round(remainingSec * 1000))
    );

    try {
      const { response: resp } = await fetchFollowingLocRedirects(
        ctx,
        validatedUrl,
        DOWNLOAD_HEADERS,
        controller.signal
      );

      if (RETRYABLE_STATUS_CODES.has(resp.status)) {
        lastError = new Error(`HTTP ${resp.status}`);
        const waitSec = retryDelaySeconds(attempt, resp, ctx.nowMs);
        unlinkQuietly(tmpPath);
        const remAfter = (deadlineMs - ctx.nowMs()) / 1000;
        if (attempt + 1 < MAX_ATTEMPTS && remAfter >= waitSec + 1.0) {
          await ctx.sleepFn(Math.round(waitSec * 1000));
          continue;
        }
        const kindErr = resp.status === 429 ? 'rate limited' : 'transient service error';
        throw new RecordRuntimeError(`Failed downloading ${validatedUrl}: HTTP ${resp.status} (${kindErr}).`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        unlinkQuietly(tmpPath);
        throw new RecordRuntimeError(`Failed downloading ${validatedUrl}: HTTP ${resp.status}`);
      }

      const rawContentType = resp.headers.get('content-type') ?? '';
      const contentType = rawContentType.split(';', 1)[0]?.trim() ?? '';
      const contentEncoding = (resp.headers.get('content-encoding') ?? '').trim().toLowerCase();
      const rawLen = (resp.headers.get('content-length') ?? '').trim();
      let expectedLen: number | undefined;
      if (rawLen && (!contentEncoding || contentEncoding === 'identity') && /^\d+$/.test(rawLen)) {
        const parsedLen = Number.parseInt(rawLen, 10);
        if (Number.isSafeInteger(parsedLen) && parsedLen > 0) {
          expectedLen = parsedLen;
        }
      }

      const written = await writeResponseToFile(resp, tmpPath);

      if (expectedLen !== undefined && written < expectedLen) {
        throw new IncompleteDownloadError(`Incomplete download (${written} of ${expectedLen} bytes)`);
      }

      const nbytes = validateDownloadFile(tmpPath, {
        url: validatedUrl,
        contentType,
        kind,
      });
      fs.renameSync(tmpPath, destPath);
      return { nbytes, contentType };
    } catch (err: unknown) {
      unlinkQuietly(tmpPath);
      if (err instanceof RecordRuntimeError && !(err instanceof IncompleteDownloadError)) {
        throw err;
      }
      lastError = err;
      const waitSec = retryDelaySeconds(attempt, null, ctx.nowMs);
      const remAfter = (deadlineMs - ctx.nowMs()) / 1000;
      const retryable =
        err instanceof IncompleteDownloadError || isTimeoutError(err, abortedByTimer) || err instanceof Error;
      if (retryable && attempt + 1 < MAX_ATTEMPTS && remAfter >= waitSec + 1.0) {
        await ctx.sleepFn(Math.round(waitSec * 1000));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(`Failed downloading ${validatedUrl}: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const lastMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new RecordRuntimeError(
    `Failed downloading ${validatedUrl} after ${options.timeout.toFixed(1)}s: ${lastMessage}`
  );
}

export async function cachedDownloadFile(
  ctx: RecordCommandContext,
  url: string,
  options: {
    readonly timeout: number;
    readonly refresh: boolean;
    readonly ttlHours: number;
    readonly kind?: ChronamAssetKind;
  }
): Promise<CachedFileResult> {
  const validatedUrl = validateLocUrl(url);
  const kind: ChronamAssetKind = options.kind ?? 'bin';
  const cacheDir = resolveChronamCacheDir(ctx.env);
  const [binPath, metaPath, lockPath] = fileCachePaths(cacheDir, validatedUrl);

  if (!options.refresh) {
    const hit = readCachedFileMeta(binPath, metaPath, options.ttlHours, {
      kind,
      url: validatedUrl,
      nowMs: ctx.nowMs,
    });
    if (hit !== null) {
      return {
        cachePath: binPath,
        nbytes: hit.nbytes,
        contentType: hit.contentType,
        cacheHit: true,
      };
    }
  }

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const hit = readCachedFileMeta(binPath, metaPath, options.ttlHours, {
          kind,
          url: validatedUrl,
          nowMs: ctx.nowMs,
        });
        if (hit !== null) {
          return {
            cachePath: binPath,
            nbytes: hit.nbytes,
            contentType: hit.contentType,
            cacheHit: true,
          };
        }
      }

      const info = await streamDownloadToPath(ctx, validatedUrl, binPath, {
        timeout: options.timeout,
        kind,
      });

      atomicWriteFileSync(
        metaPath,
        JSON.stringify({
          schema: CACHE_SCHEMA,
          fetched_at: ctx.nowMs() / 1000,
          url: validatedUrl,
          nbytes: info.nbytes,
          content_type: info.contentType,
        })
      );

      return {
        cachePath: binPath,
        nbytes: info.nbytes,
        contentType: info.contentType,
        cacheHit: false,
      };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function cachedDownloadBytes(
  ctx: RecordCommandContext,
  url: string,
  options: {
    readonly timeout: number;
    readonly refresh: boolean;
    readonly ttlHours: number;
    readonly kind?: ChronamAssetKind;
  }
): Promise<{ readonly data: Buffer; readonly cacheHit: boolean }> {
  const { cachePath, cacheHit } = await cachedDownloadFile(ctx, url, options);
  return { data: fs.readFileSync(cachePath), cacheHit };
}
