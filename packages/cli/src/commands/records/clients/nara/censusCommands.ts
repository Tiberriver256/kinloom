import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { withAdvisoryLock } from '../../runtime/cache.js';
import { HttpStatusError } from '../../runtime/http.js';
import {
  atomicWriteCompactJson,
  IncompleteDownloadError,
  isPlainRecord,
  runWithConcurrency,
} from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { getCacheRoot } from './catalogTransport.js';
import {
  canonicalCensus1950Query,
  census1950CachePaths,
  census1950FetchJson,
  census1950SearchUrl,
  isExistingDirectory,
  parseCensus1950ImageSource,
  readCachedCensus1950,
  resolveCensus1950ImageOutput,
  storeCensus1950Image,
} from './census1950.js';
import {
  CENSUS1950_IMAGE_OPTIONS,
  CENSUS1950_IMAGE_PARSE_SPEC,
  CENSUS1950_OPTIONS,
  CENSUS1950_PARSE_SPEC,
} from './cliSpecs.js';
import { resolveQueryTtlHours, resolveUserPath } from './queryAndRecords.js';
import {
  CENSUS1950_DEFAULT_LIMIT,
  CENSUS1950_IMAGE_ATTEMPTS,
  CENSUS1950_IMAGE_FETCH_WORKERS,
  CENSUS1950_IMAGE_MAX_PER_CALL,
  CENSUS1950_IMAGE_TIMEOUT,
  CENSUS1950_JPEG_SUFFIXES,
  CENSUS1950_TRANSIENT_STATUS,
  type Census1950ApiPayload,
  type Census1950ImageRecord,
} from './types.js';

function emitCensus1950(
  data: Census1950ApiPayload,
  cacheHit: boolean,
  asJson: boolean,
  ctx: RecordCommandContext
): number {
  if (asJson) {
    return emitJsonStdout(ctx.io, {
      cache_hit: cacheHit,
      total: data.total ?? null,
      page: data.page ?? null,
      size: data.size ?? null,
      results: data.results ?? [],
    });
  }
  let header = `1950 Census population schedules: ${String(data.total ?? 0)} hit(s)`;
  if (cacheHit) {
    header += ' [cache]';
  }
  const lines: string[] = [header];
  for (const row of data.results ?? []) {
    if (!isPlainRecord(row)) {
      continue;
    }
    const image = row.image;
    const rowParts = [
      String(row.abbr || row.state || ''),
      String(row.county || ''),
      row.ed ? `ED ${String(row.ed)}` : '',
      row.scheduleId ? `schedule ${String(row.scheduleId)}` : '',
      typeof image === 'string' && image ? `image ${image}` : '',
    ].filter((part) => part.length > 0);
    lines.push(rowParts.join(' '));
    const names = Array.isArray(row.names) ? row.names : [];
    for (const person of names) {
      if (isPlainRecord(person) && person.name) {
        const prefix = person.row ? `${String(person.row)}: ` : '';
        lines.push(`  ${prefix}${String(person.name)}`);
      }
    }
  }
  return emitStdout(ctx.io, lines.join('\n'));
}

export async function runCensus1950(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CENSUS1950_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara census1950 [NAME...] [options]',
          summary: 'Search 1950 Census population schedules on 1950census.archives.gov.',
          options: CENSUS1950_OPTIONS,
        })
      ),
    };
  }

  const posName = parsed.positionals
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(' ')
    .trim();
  const flagName = getStringOption(parsed, 'name');
  if (posName && flagName?.trim()) {
    throw new CliValidationError('Pass either a positional name or --name/--surname, not both.');
  }
  const resolvedName = flagName?.trim() ? flagName : posName || undefined;

  const canonical = canonicalCensus1950Query({
    state: getStringOption(parsed, 'state'),
    county: getStringOption(parsed, 'county'),
    name: resolvedName,
    ed: getStringOption(parsed, 'ed'),
    limit: getNumberOption(parsed, 'limit') ?? CENSUS1950_DEFAULT_LIMIT,
    page: getNumberOption(parsed, 'page') ?? 1,
  });

  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveQueryTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx);
  const [dataPath, lockPath] = census1950CachePaths(canonical, cacheRoot);

  if (!refresh) {
    const cached = readCachedCensus1950(dataPath, ttlHours, ctx.nowMs);
    if (cached !== null) {
      const bytesOut = emitCensus1950(cached, true, asJson, ctx);
      return { exitCode: 0, bytesOut, cacheHit: true };
    }
  }

  const result = await withAdvisoryLock(
    lockPath,
    async () => {
      if (!refresh) {
        const cached = readCachedCensus1950(dataPath, ttlHours, ctx.nowMs);
        if (cached !== null) {
          return { data: cached, cacheHit: true } as const;
        }
      }
      const fetched = await census1950FetchJson(census1950SearchUrl(canonical), ctx);
      atomicWriteCompactJson(dataPath, {
        cached_at: ctx.nowMs() / 1000,
        params: canonical,
        data: fetched,
      });
      return { data: fetched, cacheHit: false } as const;
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );

  const bytesOut = emitCensus1950(result.data, result.cacheHit, asJson, ctx);
  return { exitCode: 0, bytesOut, cacheHit: result.cacheHit };
}

export async function runCensus1950Image(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CENSUS1950_IMAGE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara census1950-image <IMAGE_OR_URL...> [options]',
          summary: 'Download one or more 1950 Census schedule JPEGs from the NARA IIIF server.',
          options: CENSUS1950_IMAGE_OPTIONS,
        })
      ),
    };
  }

  const imageOrUrls = parsed.positionals;
  const outPath = getStringOption(parsed, 'outPath') ?? '.';
  const width = getNumberOption(parsed, 'width') ?? null;
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? CENSUS1950_IMAGE_TIMEOUT;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');

  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(timeoutSec)} (must be > 0).`);
  }
  if (imageOrUrls.length > CENSUS1950_IMAGE_MAX_PER_CALL) {
    throw new CliValidationError(
      `Pass at most ${CENSUS1950_IMAGE_MAX_PER_CALL} images per census1950-image call (got ${imageOrUrls.length}).`
    );
  }

  const imagePaths = imageOrUrls.map((raw) => parseCensus1950ImageSource(raw));
  const batch = imagePaths.length > 1;
  const resolvedOut = resolveUserPath(outPath, ctx.cwd);
  const looksLikeJpg =
    CENSUS1950_JPEG_SUFFIXES.has(path.extname(outPath).toLowerCase()) && !isExistingDirectory(resolvedOut);
  if (batch && looksLikeJpg) {
    throw new CliValidationError(
      '--out is a .jpg file, but this command received multiple images. Pass a directory, for example --out ./schedules.'
    );
  }
  for (const imagePath of imagePaths) {
    resolveCensus1950ImageOutput(outPath, imagePath, ctx.cwd);
  }

  const ttlHours = resolveQueryTtlHours(cliTtl, ctx.env);
  const cacheRoot = getCacheRoot(ctx);

  let records: Census1950ImageRecord[];
  try {
    const storeOptions = { outPath, width, refresh, ttlHours, timeoutSec, cacheRoot };
    if (!batch) {
      records = [await storeCensus1950Image(imagePaths[0], storeOptions, ctx)];
    } else {
      records = await runWithConcurrency(imagePaths, CENSUS1950_IMAGE_FETCH_WORKERS, (imagePath) =>
        storeCensus1950Image(imagePath, storeOptions, ctx)
      );
    }
  } catch (err: unknown) {
    if (err instanceof HttpStatusError) {
      if (err.status === 404) {
        throw new RecordRuntimeError(
          `1950 Census schedule image not found (HTTP 404) for ${err.url}. Verify the exact image path or sheet number via \`nara census1950\`.`
        );
      }
      if (CENSUS1950_TRANSIENT_STATUS.has(err.status)) {
        throw new RecordRuntimeError(
          `1950 Census IIIF server returned HTTP ${err.status} for ${err.url} after ${CENSUS1950_IMAGE_ATTEMPTS} attempts. Retry shortly or pass --width 2400.`
        );
      }
      throw new RecordRuntimeError(`HTTP ${err.status} downloading 1950 Census image ${err.url}`);
    }
    if (err instanceof IncompleteDownloadError) {
      throw new RecordRuntimeError(
        `1950 Census image download failed after ${CENSUS1950_IMAGE_ATTEMPTS} attempts: ${err.message}. Retry shortly or pass --width 2400.`
      );
    }
    throw err;
  }

  const allCacheHit = records.length > 0 && records.every((item) => item.cache_hit);

  if (!batch) {
    const rec = records[0];
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, rec);
      return { exitCode: 0, bytesOut, cacheHit: rec.cache_hit };
    }
    const verb = rec.cache_hit ? 'Cached' : 'Downloaded';
    const bytesOut = emitStdout(ctx.io, `${verb}: ${rec.path} (${rec.bytes.toLocaleString('en-US')} bytes)`);
    return { exitCode: 0, bytesOut, cacheHit: rec.cache_hit };
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      count: records.length,
      files: records,
      cache_hit: allCacheHit,
    });
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  }

  const lines = records.map((item) => {
    const verb = item.cache_hit ? 'Cached' : 'Downloaded';
    return `${verb}: ${item.path} (${item.bytes.toLocaleString('en-US')} bytes)`;
  });
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
}
