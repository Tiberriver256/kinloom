import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  atomicWriteFileSync,
  canonicalJsonStringify,
  sha256Hex,
  withAdvisoryLock,
} from '../../runtime/cache.js';
import { HttpStatusError } from '../../runtime/http.js';
import { fetchWithTimeout, IncompleteDownloadError, JPEG_MAGIC } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import { census1950RetryDelayMs } from './census1950Search.js';
import {
  hasParentTraversal,
  quotePythonStyle,
  resolveSafeChild,
  resolveUserPath,
} from './queryAndRecords.js';
import {
  CENSUS1950_IIIF_ORIGIN,
  CENSUS1950_IMAGE_ATTEMPTS,
  CENSUS1950_IMAGE_PATH_RE,
  CENSUS1950_IMAGE_TIMEOUT,
  CENSUS1950_JPEG_SUFFIXES,
  CENSUS1950_TRANSIENT_STATUS,
  type Census1950ImageRecord,
} from './types.js';

export {
  canonicalCensus1950Query,
  census1950CachePaths,
  census1950FetchJson,
  census1950SearchUrl,
  normalizeCensus1950State,
  readCachedCensus1950,
} from './census1950Search.js';

class TransientNonJpegError extends RecordRuntimeError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'TransientNonJpegError';
  }
}

export function validateCensus1950ImagePath(raw: string): string {
  const text = raw.trim();
  if (!text || text.includes('\0') || text.includes('\\') || !CENSUS1950_IMAGE_PATH_RE.test(text)) {
    throw new CliValidationError(`Invalid 1950 Census image path: '${raw}'`);
  }
  const parts = text.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new CliValidationError(`Invalid 1950 Census image path: '${raw}'`);
  }
  return text;
}

export function parseCensus1950ImageSource(raw: string): string {
  let text = raw.trim();
  if (!text || text.includes('\0')) {
    throw new CliValidationError(`Invalid 1950 Census image: '${raw}'`);
  }
  if (text.startsWith('/1950census/')) {
    text = text.replace(/^\/+/, '');
  }
  if (text.startsWith('1950census/')) {
    return validateCensus1950ImagePath(text);
  }
  if (text.toLowerCase().startsWith('1950census%2f')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      throw new CliValidationError(`Invalid 1950 Census image path: '${raw}'`);
    }
    return validateCensus1950ImagePath(decoded);
  }
  if (!text.toLowerCase().startsWith('https://')) {
    throw new CliValidationError(
      'Pass a 1950census/...jpg path or an https://1950census.archives.gov/iiif/2/ URL.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new CliValidationError('1950 Census image URLs must be https://1950census.archives.gov/iiif/2/...');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    host !== '1950census.archives.gov' ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new CliValidationError('1950 Census image URLs must be https://1950census.archives.gov/iiif/2/...');
  }
  const prefix = '/iiif/2/';
  if (!parsed.pathname.startsWith(prefix)) {
    throw new CliValidationError('1950 Census image URLs must be https://1950census.archives.gov/iiif/2/...');
  }
  const rest = parsed.pathname.slice(prefix.length).replace(/\/+$/, '');
  if (!rest) {
    throw new CliValidationError('1950 Census image URLs must be https://1950census.archives.gov/iiif/2/...');
  }

  let encoded: string;
  if (rest.endsWith('/info.json')) {
    encoded = rest.slice(0, -'/info.json'.length);
  } else if (rest.endsWith('/default.jpg')) {
    const fullIdx = rest.indexOf('/full/');
    if (fullIdx !== -1) {
      encoded = rest.slice(0, fullIdx);
    } else {
      const parts = rest.split('/');
      if (parts.length >= 5) {
        encoded = parts.slice(0, parts.length - 4).join('/');
      } else {
        throw new CliValidationError(
          'Pass an IIIF info.json URL, base URL, or default.jpg URL from 1950census.archives.gov.'
        );
      }
    }
  } else if (rest.toLowerCase().endsWith('.jpg')) {
    encoded = rest;
  } else {
    throw new CliValidationError(
      'Pass an IIIF info.json URL, base URL, or default.jpg URL from 1950census.archives.gov.'
    );
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new CliValidationError(`Invalid 1950 Census image path: '${raw}'`);
  }
  return validateCensus1950ImagePath(decoded);
}

export function census1950ImageJpegUrl(imagePath: string, width: number | null): string {
  const size = width === null ? 'full' : `${width},`;
  const encoded = quotePythonStyle(imagePath, false);
  return `${CENSUS1950_IIIF_ORIGIN}/iiif/2/${encoded}/full/${size}/0/default.jpg`;
}

export function census1950ImageCachePaths(
  imagePath: string,
  width: number | null,
  cacheRoot: string
): readonly [string, string] {
  const key = canonicalJsonStringify({ image: imagePath, width });
  const digest = sha256Hex(key);
  const dir = path.join(cacheRoot, 'census1950-images');
  return [resolveSafeChild(dir, `${digest}.jpg`), resolveSafeChild(dir, `${digest}.lock`)];
}

export function isExistingDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export function resolveCensus1950ImageOutput(rawOutPath: string, imagePath: string, cwd: string): string {
  if (rawOutPath.includes('\0')) {
    throw new CliValidationError(`Invalid output path: ${rawOutPath}`);
  }
  if (hasParentTraversal(rawOutPath) && !path.isAbsolute(rawOutPath)) {
    throw new RecordRuntimeError(`Unsafe output path containing '..': ${rawOutPath}`);
  }
  const resolvedOut = resolveUserPath(rawOutPath, cwd);
  const slashIdx = imagePath.lastIndexOf('/');
  const filename = slashIdx === -1 ? imagePath : imagePath.slice(slashIdx + 1);
  const ext = path.extname(rawOutPath).toLowerCase();
  const looksLikeFile = CENSUS1950_JPEG_SUFFIXES.has(ext) && !isExistingDirectory(resolvedOut);
  const dest = looksLikeFile ? resolvedOut : path.join(resolvedOut, filename);
  if (dest.includes('\0')) {
    throw new CliValidationError(`Invalid output path: ${rawOutPath}`);
  }
  return dest;
}

export function requireJpegBytes(data: Buffer): Buffer {
  if (!data.subarray(0, 3).equals(JPEG_MAGIC)) {
    throw new RecordRuntimeError('1950 Census image response is not a JPEG.');
  }
  return data;
}

function readCachedCensus1950Image(filePath: string, ttlHours: number, nowMs: () => number): Buffer | null {
  if (ttlHours <= 0) {
    return null;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const ageSeconds = (nowMs() - stat.mtimeMs) / 1000;
  if (ageSeconds > ttlHours * 3600) {
    return null;
  }
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (!data.subarray(0, 3).equals(JPEG_MAGIC)) {
    return null;
  }
  return data;
}

export async function census1950FetchJpeg(
  url: string,
  ctx: Pick<RecordCommandContext, 'fetchImpl' | 'sleepFn' | 'nowMs'>,
  timeoutSec = CENSUS1950_IMAGE_TIMEOUT
): Promise<Buffer> {
  const headers: Record<string, string> = {
    Accept: 'image/jpeg',
    'User-Agent': 'kinloom/1.0 (genealogy research)',
  };
  const timeoutMs = Math.max(1000, Math.round(timeoutSec * 1000));

  for (let attempt = 1; attempt <= CENSUS1950_IMAGE_ATTEMPTS; attempt += 1) {
    try {
      const resp = await fetchWithTimeout(
        url,
        { method: 'GET', headers, redirect: 'manual' },
        timeoutMs,
        ctx.fetchImpl
      );
      if (resp.status < 200 || resp.status >= 300) {
        if (CENSUS1950_TRANSIENT_STATUS.has(resp.status) && attempt < CENSUS1950_IMAGE_ATTEMPTS) {
          await ctx.sleepFn(census1950RetryDelayMs(attempt, resp, ctx.nowMs));
          continue;
        }
        const snippet = (await resp.text().catch(() => '')).slice(0, 200).trim();
        throw new HttpStatusError(resp.status, url, snippet);
      }

      const contentType = resp.headers.get('content-type') ?? '';
      if (contentType.toLowerCase().includes('html')) {
        throw new TransientNonJpegError('1950 Census image response was HTML, not a JPEG.');
      }

      const contentEncoding = (resp.headers.get('content-encoding') ?? '').trim().toLowerCase();
      const rawLen = (resp.headers.get('content-length') ?? '').trim();
      let expectedLen: number | null = null;
      if (rawLen && (!contentEncoding || contentEncoding === 'identity') && /^\d+$/.test(rawLen)) {
        const parsedLen = Number.parseInt(rawLen, 10);
        if (parsedLen > 0) {
          expectedLen = parsedLen;
        }
      }

      const body = Buffer.from(await resp.arrayBuffer());
      if (expectedLen !== null && body.length < expectedLen) {
        throw new IncompleteDownloadError(
          `Incomplete 1950 Census JPEG download: received ${body.length} of ${expectedLen} bytes`
        );
      }
      if (!body.subarray(0, 3).equals(JPEG_MAGIC)) {
        throw new TransientNonJpegError('1950 Census image response is not a JPEG.');
      }
      return body;
    } catch (err: unknown) {
      if (err instanceof HttpStatusError) {
        throw err;
      }
      if (err instanceof TransientNonJpegError) {
        if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
          throw new RecordRuntimeError(err.message);
        }
        await ctx.sleepFn(census1950RetryDelayMs(attempt, null, ctx.nowMs));
        continue;
      }
      if (err instanceof IncompleteDownloadError) {
        if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
          throw err;
        }
        await ctx.sleepFn(census1950RetryDelayMs(attempt, null, ctx.nowMs));
        continue;
      }
      if (attempt >= CENSUS1950_IMAGE_ATTEMPTS) {
        const message = err instanceof Error ? err.message : String(err);
        throw new IncompleteDownloadError(message);
      }
      await ctx.sleepFn(census1950RetryDelayMs(attempt, null, ctx.nowMs));
    }
  }

  throw new RecordRuntimeError('census1950-image retries ended without a JPEG or an error.');
}

async function loadCensus1950ImageBytes(
  imagePath: string,
  options: {
    readonly width: number | null;
    readonly refresh: boolean;
    readonly ttlHours: number;
    readonly timeoutSec: number;
    readonly cacheRoot: string;
  },
  ctx: RecordCommandContext
): Promise<readonly [Buffer, boolean]> {
  const url = census1950ImageJpegUrl(imagePath, options.width);
  const [dataPath, lockPath] = census1950ImageCachePaths(imagePath, options.width, options.cacheRoot);
  if (!options.refresh) {
    const cached = readCachedCensus1950Image(dataPath, options.ttlHours, ctx.nowMs);
    if (cached !== null) {
      return [cached, true];
    }
  }
  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const cached = readCachedCensus1950Image(dataPath, options.ttlHours, ctx.nowMs);
        if (cached !== null) {
          return [cached, true] as const;
        }
      }
      const fetched = requireJpegBytes(await census1950FetchJpeg(url, ctx, options.timeoutSec));
      atomicWriteFileSync(dataPath, fetched);
      return [fetched, false] as const;
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function storeCensus1950Image(
  imagePath: string,
  options: {
    readonly outPath: string;
    readonly width: number | null;
    readonly refresh: boolean;
    readonly ttlHours: number;
    readonly timeoutSec: number;
    readonly cacheRoot: string;
  },
  ctx: RecordCommandContext
): Promise<Census1950ImageRecord> {
  const dest = resolveCensus1950ImageOutput(options.outPath, imagePath, ctx.cwd);
  const [data, cacheHit] = await loadCensus1950ImageBytes(imagePath, options, ctx);
  const jpeg = requireJpegBytes(data);
  atomicWriteFileSync(dest, jpeg);
  return {
    image: imagePath,
    url: census1950ImageJpegUrl(imagePath, options.width),
    path: dest,
    bytes: jpeg.length,
    width: options.width,
    cache_hit: cacheHit,
  };
}
