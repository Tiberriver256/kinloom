import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { atomicWriteFileSync } from '../../runtime/cache.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  COLLECTIONS_SPEC,
  DOWNLOAD_SPEC,
  GET_SPEC,
  renderCollectionsHelp,
  renderDownloadHelp,
  renderGetHelp,
  renderSearchHelp,
  renderUrlHelp,
  SEARCH_SPEC,
  URL_SPEC,
} from './cliSpecs.js';
import {
  BASE,
  COLLECTIONS,
  DEFAULT_DOWNLOAD_TIMEOUT_SEC,
  DEFAULT_TEXT_TIMEOUT_SEC,
  DOWNLOAD_FILE_EXTS,
  encodeQueryPlus,
  resolveItemRef,
  validateTimeout,
  validateUserFilename,
} from './domain.js';
import {
  cachedDownload,
  cachedItem,
  cachedSearch,
  resolveDownloadDest,
  resolveMichiganologyTtl,
} from './transport.js';

export async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }
  const parts = parsed.positionals.map((p) => p.trim()).filter(Boolean);
  const queryOpt = getStringOption(parsed, 'queryOpt')?.trim();
  if (queryOpt) {
    parts.unshift(queryOpt);
  }
  const query = parts.join(' ').trim();
  if (!query) {
    throw new CliValidationError('Missing search query. Example: michiganology search Lincoln');
  }
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const budget = validateTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TEXT_TIMEOUT_SEC);
  const ttlHours = resolveMichiganologyTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const { value: data, cacheHit } = await cachedSearch(ctx, query, budget, ttlHours, refresh);

  const sliced = data.results.slice(0, limit);
  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        query,
        total: data.total,
        results: sliced,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `Query: ${query}  |  Total results: ${data.total !== null ? data.total : 'unknown'}${marker}`,
  ];
  if (sliced.length === 0) {
    lines.push('No results on the first page.');
  } else {
    for (const item of sliced) {
      lines.push(`- ${item.title}\n  ${item.url}`);
    }
    lines.push(`(${sliced.length} of ${data.total} shown; first page only)`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runGet(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderGetHelp()) };
  }
  const [itemId, itemUrl] = resolveItemRef(parsed.positionals[0] ?? '');
  const budget = validateTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TEXT_TIMEOUT_SEC);
  const ttlHours = resolveMichiganologyTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const { value: data, cacheHit } = await cachedItem(ctx, itemId, itemUrl, budget, ttlHours, refresh);

  const metadata: Record<string, string | string[]> = {};
  for (const [key, val] of data.fields) {
    const prev = metadata[key];
    if (prev !== undefined) {
      metadata[key] = Array.isArray(prev) ? [...prev, val] : [prev, val];
    } else {
      metadata[key] = val;
    }
  }
  const payload = {
    id: itemId,
    title: data.title,
    url: itemUrl,
    download_url: data.download_url,
    metadata,
    cache_hit: cacheHit,
  };
  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload), cacheHit };
  }
  const lines: string[] = [`Item ${itemId}: ${data.title}${cacheHit ? ' [cache]' : ''}`, `  URL: ${itemUrl}`];
  if (data.download_url) {
    lines.push(`  Download: ${data.download_url}`);
  }
  for (const [key, val] of data.fields) {
    lines.push(`  ${key}: ${val}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDownloadHelp()) };
  }
  const [itemId] = resolveItemRef(parsed.positionals[0] ?? '');
  if (!itemId.startsWith('IO_')) {
    throw new RecordRuntimeError(
      `${itemId} is a folder/collection object (SO_); pass an IO_ item URL or ID to download.`
    );
  }
  const out = getStringOption(parsed, 'out') ?? '.';
  const filename = getStringOption(parsed, 'filename');
  if (filename !== undefined) {
    validateUserFilename(filename);
  }
  if (out.includes('\0')) {
    throw new CliValidationError(`Invalid --out path: '${out}'`);
  }
  if (
    filename === undefined &&
    DOWNLOAD_FILE_EXTS.has(path.extname(out).toLowerCase()) &&
    out.split(/[\\/]+/).includes('..')
  ) {
    throw new CliValidationError(`Unsafe --out path containing '..': '${out}'`);
  }

  const budget = validateTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_DOWNLOAD_TIMEOUT_SEC);
  const ttlHours = resolveMichiganologyTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const { data: fetched, cacheHit } = await cachedDownload(ctx, itemId, refresh, ttlHours, budget);
  const dest = resolveDownloadDest(out, filename, fetched.filename, ctx);
  atomicWriteFileSync(dest, fetched.body);

  const payload = {
    item_id: itemId,
    path: dest,
    bytes: fetched.body.length,
    filename: fetched.filename,
    content_type: fetched.content_type,
    cache_hit: cacheHit,
  };
  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload), cacheHit };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, `${dest} (${fetched.body.length} bytes)`),
    cacheHit,
  };
}

export function runCollections(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, COLLECTIONS_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCollectionsHelp()) };
  }
  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(
        ctx.io,
        COLLECTIONS.map(([name, url]) => ({ name, url }))
      ),
    };
  }
  const text = COLLECTIONS.map(([name, url]) => `- ${name}\n  ${url}`).join('\n');
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }
  const query = parsed.positionals
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, `${BASE}/?s=${encodeQueryPlus(query)}`),
  };
}
