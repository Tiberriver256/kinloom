import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { runWithConcurrency } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { defaultBrowserSearchMany } from './browserFallback.js';
import {
  apiSearchOne,
  canonicalSearchParams,
  getCacheRoot,
  loadOrFetchFullRecordsWithHits,
  readCachedSearch,
  writeCachedSearch,
} from './catalogTransport.js';
import {
  DOWNLOAD_OPTIONS,
  DOWNLOAD_PARSE_SPEC,
  extractCommonSearchOptions,
  GET_OPTIONS,
  GET_PARSE_SPEC,
  SEARCH_OPTIONS,
  SEARCH_PARSE_SPEC,
  URL_OPTIONS,
  URL_PARSE_SPEC,
} from './cliSpecs.js';
import { downloadDirectUrl, downloadRecordObjects } from './downloads.js';
import {
  buildQueryParams,
  encodeCatalogUrl,
  formatRecordText,
  hasParentTraversal,
  isDirectDownloadUrl,
  projectRecord,
  resolveQueryTtlHours,
  resolveUserPath,
  validateNaid,
} from './queryAndRecords.js';
import {
  API_MAX_WORKERS,
  DEFAULT_BROWSER_TIMEOUT_S,
  DEFAULT_DOWNLOAD_TIMEOUT,
  type NaraBrowserOverrides,
  type NaraSearchPayload,
} from './types.js';

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara url [QUERY] [options]',
          summary: 'Build and print a verified NARA Catalog search URL.',
          options: URL_OPTIONS,
        })
      ),
    };
  }
  const query = parsed.positionals[0] ?? null;
  const filters = extractCommonSearchOptions(parsed);
  const forApi = getBooleanOption(parsed, 'forApi');
  const params = buildQueryParams(query, { ...filters, forApi });
  const bytesOut = emitStdout(ctx.io, encodeCatalogUrl(params, forApi));
  return { exitCode: 0, bytesOut };
}

export async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext,
  overrides: NaraBrowserOverrides
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara search [QUERIES...] [options]',
          summary: 'Search the NARA Catalog. Accepts one or multiple queries.',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }

  const queries: readonly (string | null)[] = parsed.positionals.length > 0 ? parsed.positionals : [null];
  const filters = extractCommonSearchOptions(parsed);
  const apiKey = getStringOption(parsed, 'apiKey') ?? ctx.env.NARA_API_KEY;
  const forceBrowser = getBooleanOption(parsed, 'forceBrowser');
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? DEFAULT_BROWSER_TIMEOUT_S;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(timeoutSec)} (must be > 0).`);
  }
  const browserTimeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
  const asJson = getBooleanOption(parsed, 'asJson');

  const useApi = Boolean(apiKey) && !forceBrowser;
  const ttlHours = resolveQueryTtlHours(cliTtl, ctx.env);
  const cacheRoot = getCacheRoot(ctx);

  // Validate query parameters before consulting cache.
  buildQueryParams(queries[0], { ...filters, forApi: useApi });

  const canonicalList = queries.map((q) => canonicalSearchParams(q, filters));
  const slots: (NaraSearchPayload | null)[] = Array.from({ length: queries.length }, () => null);
  const hitFlags: boolean[] = Array.from({ length: queries.length }, () => false);
  const missIndices: number[] = [];

  for (let idx = 0; idx < canonicalList.length; idx += 1) {
    if (!refresh) {
      const cached = readCachedSearch(canonicalList[idx], cacheRoot, ttlHours, ctx.nowMs);
      if (cached !== null) {
        slots[idx] = cached;
        hitFlags[idx] = true;
        continue;
      }
    }
    missIndices.push(idx);
  }

  const browserSearch =
    overrides.browserSearchMany ??
    ((pairs, cmdCtx, limitMs) =>
      defaultBrowserSearchMany(pairs, cmdCtx, limitMs, {
        launcher: overrides.launcher,
        closeTimeoutMs: overrides.closeTimeoutMs,
        killGraceMs: overrides.killGraceMs,
      }));

  if (missIndices.length > 0) {
    const missQueries = missIndices.map((idx) => queries[idx]);
    if (useApi && apiKey) {
      const activeKey = apiKey;
      const outcomes = await runWithConcurrency(missQueries, API_MAX_WORKERS, (q) =>
        apiSearchOne(q, activeKey, filters, ctx)
      );

      const fallbackSlots: number[] = [];
      const fallbackPairs: (readonly [string | null, string])[] = [];
      for (let i = 0; i < missIndices.length; i += 1) {
        const slotIdx = missIndices[i];
        const [entry, webUrl] = outcomes[i];
        if (entry === null) {
          fallbackSlots.push(slotIdx);
          fallbackPairs.push([queries[slotIdx], webUrl]);
        } else {
          slots[slotIdx] = entry;
          await writeCachedSearch(canonicalList[slotIdx], entry, cacheRoot, ctx);
        }
      }

      if (fallbackPairs.length > 0) {
        const fallbackResults = await browserSearch(fallbackPairs, ctx, browserTimeoutMs);
        for (let i = 0; i < fallbackSlots.length; i += 1) {
          const slotIdx = fallbackSlots[i];
          const fbEntry = fallbackResults[i];
          if (fbEntry) {
            slots[slotIdx] = fbEntry;
            await writeCachedSearch(canonicalList[slotIdx], fbEntry, cacheRoot, ctx);
          }
        }
      }
    } else {
      const urlPairs: (readonly [string | null, string])[] = missQueries.map((q) => [
        q,
        encodeCatalogUrl(buildQueryParams(q, { ...filters, forApi: false }), false),
      ]);
      const fetched = await browserSearch(urlPairs, ctx, browserTimeoutMs);
      for (let i = 0; i < missIndices.length; i += 1) {
        const slotIdx = missIndices[i];
        const entry = fetched[i];
        if (entry) {
          slots[slotIdx] = entry;
          await writeCachedSearch(canonicalList[slotIdx], entry, cacheRoot, ctx);
        }
      }
    }
  }

  const payloads: { readonly entry: NaraSearchPayload; readonly isHit: boolean }[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    const entry = slots[i];
    if (entry !== null) {
      payloads.push({ entry, isHit: hitFlags[i] });
    }
  }

  const allCacheHit = payloads.length > 0 && payloads.every((p) => p.isHit);

  if (asJson) {
    const jsonPayloads = payloads.map(({ entry, isHit }) => ({ ...entry, cache_hit: isHit }));
    const bytesOut = emitJsonStdout(ctx.io, jsonPayloads.length === 1 ? jsonPayloads[0] : jsonPayloads);
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  }

  const lines: string[] = [];
  for (let pIdx = 0; pIdx < payloads.length; pIdx += 1) {
    if (pIdx > 0) {
      lines.push('');
    }
    const payload = payloads[pIdx].entry;
    const hdr = payload.query ? `Query: ${payload.query} | ` : '';
    lines.push(`${hdr}Total: ${payload.total} | ${payload.searchUrl}`);
    for (let idx = 0; idx < payload.results.length; idx += 1) {
      const rec = payload.results[idx];
      const metaParts = [
        rec.level,
        rec.rg !== undefined ? `RG ${rec.rg}` : undefined,
        rec.objectCount ? `${rec.objectCount} files` : undefined,
      ].filter((part): part is string => Boolean(part));
      const meta = metaParts.join(' | ');
      const series = rec.series ? ` [${rec.series}]` : '';
      const numStr = String(idx + 1).padStart(2, ' ');
      lines.push(`  ${numStr}. NAID ${rec.naId} (${meta}): ${rec.title ?? ''}${series}`);
    }
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
}

export async function runGet(
  argv: readonly string[],
  ctx: RecordCommandContext,
  overrides: NaraBrowserOverrides
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara get <NAID...> [options]',
          summary: 'Inspect one or more NARA records by NAID (compact metadata by default).',
          options: GET_OPTIONS,
        })
      ),
    };
  }

  const naids = parsed.positionals;
  const apiKey = getStringOption(parsed, 'apiKey') ?? ctx.env.NARA_API_KEY;
  const forceBrowser = getBooleanOption(parsed, 'forceBrowser');
  const objects = getBooleanOption(parsed, 'objects');
  const pages = getStringOption(parsed, 'pages') ?? 'all';
  const text = getBooleanOption(parsed, 'text');
  const refresh = getBooleanOption(parsed, 'refresh');
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? DEFAULT_BROWSER_TIMEOUT_S;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(timeoutSec)} (must be > 0).`);
  }
  const browserTimeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
  const asJson = getBooleanOption(parsed, 'asJson');

  const cacheRoot = getCacheRoot(ctx);
  const [fullRecords, hitFlags] = await loadOrFetchFullRecordsWithHits(
    naids,
    { apiKey, forceBrowser, includeText: text, refresh, cacheRoot, browserTimeoutMs },
    ctx,
    overrides
  );

  const records = fullRecords.map((rec) =>
    rec.error ? rec : projectRecord(rec, { includeObjects: objects, includeText: text, pageSpec: pages })
  );

  const allCacheHit = hitFlags.length > 0 && hitFlags.every(Boolean);

  if (asJson) {
    const jsonRecords = records.map((rec, idx) => ({ ...rec, cache_hit: hitFlags[idx] }));
    const bytesOut = emitJsonStdout(ctx.io, jsonRecords.length === 1 ? jsonRecords[0] : jsonRecords);
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  }

  const textOutput = records.map((rec) => formatRecordText(rec)).join('\n\n');
  const bytesOut = emitStdout(ctx.io, textOutput);
  return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
}

export async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext,
  overrides: NaraBrowserOverrides
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom nara download <NAID_OR_URL> [options]',
          summary: 'Download digitized files for a NARA record (NAID) or a direct NARA/S3 URL.',
          options: DOWNLOAD_OPTIONS,
        })
      ),
    };
  }

  const target = parsed.positionals[0];
  const rawOutDir = getStringOption(parsed, 'outDir');
  const pages = getStringOption(parsed, 'pages') ?? 'all';
  const metadata = getBooleanOption(parsed, 'metadata');
  const overwrite = getBooleanOption(parsed, 'overwrite');
  const refresh = getBooleanOption(parsed, 'refresh');
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? DEFAULT_DOWNLOAD_TIMEOUT;
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');
  const apiKey = getStringOption(parsed, 'apiKey') ?? ctx.env.NARA_API_KEY;
  const forceBrowser = getBooleanOption(parsed, 'forceBrowser');
  const asJson = getBooleanOption(parsed, 'asJson');

  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(timeoutSec)} (must be > 0).`);
  }

  const cacheRoot = getCacheRoot(ctx);
  if (isDirectDownloadUrl(target)) {
    const ttlHours = resolveQueryTtlHours(cliTtl, ctx.env);
    return downloadDirectUrl(
      target,
      { outPath: rawOutDir, overwrite, refresh, timeoutSec, ttlHours, asJson, cacheRoot },
      ctx
    );
  }

  const cleanId = validateNaid(target);
  const ttlOverride = cliTtl !== undefined ? resolveQueryTtlHours(cliTtl, ctx.env) : null;

  const [fullRecords, metaHits] = await loadOrFetchFullRecordsWithHits(
    [cleanId],
    {
      apiKey,
      forceBrowser,
      includeText: false,
      refresh,
      cacheRoot,
      browserTimeoutMs: Math.max(1, Math.round(timeoutSec * 1000)),
    },
    ctx,
    overrides
  );
  const fullRec = fullRecords[0];
  const metaCacheHit = metaHits[0] ?? false;
  if (!fullRec) {
    throw new RecordRuntimeError(`NAID ${cleanId}: Record not found.`);
  }
  if (fullRec.error) {
    throw new RecordRuntimeError(`NAID ${cleanId}: ${fullRec.error}`);
  }

  const rec = projectRecord(fullRec, { includeObjects: true, includeText: false, pageSpec: pages });
  const selectedObjs = rec.objects ?? [];
  const totalCount = rec.objectCount ?? selectedObjs.length;
  if (selectedObjs.length === 0) {
    throw new RecordRuntimeError(
      `NAID ${cleanId} (${rec.title ?? ''}) has no matching digital objects for '${pages}'.`
    );
  }

  if (rawOutDir !== undefined && hasParentTraversal(rawOutDir) && !path.isAbsolute(rawOutDir)) {
    throw new RecordRuntimeError(`Unsafe output directory containing '..': ${rawOutDir}`);
  }
  const targetDir = rawOutDir ? resolveUserPath(rawOutDir, ctx.cwd) : path.join(ctx.cwd, `nara-${cleanId}`);

  return downloadRecordObjects(
    cleanId,
    rec,
    selectedObjs,
    {
      targetDir,
      cacheRoot,
      totalCount,
      metaCacheHit,
      metadata,
      overwrite,
      refresh,
      timeoutSec,
      ttlOverride,
      asJson,
    },
    ctx
  );
}
