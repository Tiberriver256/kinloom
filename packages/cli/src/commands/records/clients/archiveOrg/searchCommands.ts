import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { atomicWriteFileSync } from '../../runtime/cache.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  DOWNLOAD_OPTIONS,
  DOWNLOAD_PARSE_SPEC,
  FULLTEXT_OPTIONS,
  FULLTEXT_PARSE_SPEC,
  GET_OPTIONS,
  GET_PARSE_SPEC,
  LOOKUP_OPTIONS,
  LOOKUP_PARSE_SPEC,
  SEARCH_OPTIONS,
  SEARCH_PARSE_SPEC,
  URL_OPTIONS,
  URL_PARSE_SPEC,
} from './cliSpecs.js';
import {
  emptyPageIndex,
  ensureDownloadedFile,
  ensureItemCache,
  ensureItemMetadata,
  getMetadataFiles,
  readPageIndex,
} from './itemCache.js';
import {
  describeLeaf,
  flattenFields,
  leafFromScandataLeaf,
  resolvePrintedPageToLeaf,
  resolveSearchQuery,
  validateLeafInIndex,
} from './pageAndGrep.js';
import { cachedQueryJson, getCacheRoot, resolveQueryTtlHours } from './transport.js';
import {
  ADVANCED_SEARCH,
  ArchiveNotFoundError,
  DEFAULT_TIMEOUT_SECONDS,
  DOWNLOAD_TIMEOUT_SECONDS,
  encodeQueryPairs,
  FULLTEXT_SEARCH,
  type ItemFileEntry,
  type ItemMetadataPayload,
  itemUrl,
  jsonWithCacheHit,
  pageDetailsUrl,
  pageImageUrl,
  parseLeafInt,
  quotePathSegment,
  SEARCH_TIMEOUT_SECONDS,
  shortText,
  validateIdentifier,
  validatePositiveTimeout,
  validateRelativeItemPath,
} from './types.js';

export async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia search [QUERY...] [options]',
          summary: 'Search items with a Lucene query.',
          options: SEARCH_OPTIONS,
        })
      ),
    };
  }

  const rows = getNumberOption(parsed, 'rows') ?? 10;
  const page = getNumberOption(parsed, 'page') ?? 1;
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? SEARCH_TIMEOUT_SECONDS);
  if (rows < 1) {
    throw new CliValidationError(`--rows/--limit must be >= 1, got ${rows}.`);
  }
  if (page < 1) {
    throw new CliValidationError(`--page must be >= 1, got ${page}.`);
  }

  const query = resolveSearchQuery(parsed.positionals, getStringOption(parsed, 'queryFlag'), {
    mediatype: getStringOption(parsed, 'mediatype'),
    collections: getStringListOption(parsed, 'collections'),
  });
  const chosen = flattenFields(getStringListOption(parsed, 'fields'));
  const sorts = [...getStringListOption(parsed, 'sorts')];
  const ttlHours = resolveQueryTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const params: (readonly [string, string])[] = [
    ['q', query],
    ['output', 'json'],
    ['rows', String(rows)],
  ];
  if (page > 1) {
    params.push(['page', String(page)]);
  }
  for (const field of chosen) {
    params.push(['fl[]', field]);
  }
  for (const sort of sorts) {
    params.push(['sort[]', sort]);
  }
  const qs = encodeQueryPairs(params);
  const canonicalParams: Record<string, unknown> = {
    kind: 'search',
    query,
    fields: chosen,
    rows,
    page,
    sorts,
  };

  const [data, cached] = await cachedQueryJson('search', canonicalParams, `${ADVANCED_SEARCH}?${qs}`, ctx, {
    ttlHours,
    refresh,
    timeout,
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cached));
    return { exitCode: 0, bytesOut, cacheHit: cached };
  }

  const response = isPlainRecord(data.response) ? data.response : {};
  const status = cached ? 'cache-hit' : 'fetched';
  const lines: string[] = [`${String(response.numFound ?? '')} items (${status})`];
  const docs = Array.isArray(response.docs) ? response.docs : [];
  for (const rawDoc of docs) {
    const doc = isPlainRecord(rawDoc) ? rawDoc : {};
    const identifier = String(doc.identifier ?? '');
    const title = String(doc.title ?? '');
    const creator = String(doc.creator ?? '');
    const date = String(doc.date ?? '');
    const mediatypeOut = String(doc.mediatype ?? '');
    lines.push(`${identifier} | ${title} | ${creator} | ${date} | ${mediatypeOut} | ${itemUrl(identifier)}`);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cached };
}

export async function runGet(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia get <IDENTIFIER> [options]',
          summary: "Read an item's metadata and file list by identifier (aliases: metadata, show).",
          options: GET_OPTIONS,
        })
      ),
    };
  }

  const identifier = validateIdentifier(parsed.positionals[0]);
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const showFiles = getBooleanOption(parsed, 'files');

  let data: ItemMetadataPayload;
  let cached: boolean;
  try {
    [data, cached] = await ensureItemMetadata(identifier, ctx, { timeout, refresh });
  } catch (err: unknown) {
    if (err instanceof ArchiveNotFoundError) {
      throw new RecordRuntimeError(`No item with identifier ${identifier}`);
    }
    throw err;
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cached));
    return { exitCode: 0, bytesOut, cacheHit: cached };
  }

  const meta = isPlainRecord(data.metadata) ? data.metadata : {};
  const status = cached ? 'cache-hit' : 'fetched';
  const lines: string[] = [
    String(meta.title || identifier),
    `  Identifier: ${String(meta.identifier ?? '')}`,
  ];
  if (meta.creator) {
    lines.push(`  Creator: ${String(meta.creator)}`);
  }
  if (meta.date) {
    lines.push(`  Date: ${String(meta.date)}`);
  }
  if (meta.mediatype) {
    lines.push(`  Mediatype: ${String(meta.mediatype)}`);
  }
  if (meta.collection) {
    const col = Array.isArray(meta.collection)
      ? meta.collection.map(String).join(', ')
      : String(meta.collection);
    lines.push(`  Collection: ${col}`);
  }
  if (meta.description) {
    lines.push(`  Description: ${shortText(meta.description)}`);
  }
  const fileList = getMetadataFiles(data);
  lines.push(`  Files: ${fileList.length} | ${itemUrl(identifier)} (${status})`);
  if (showFiles) {
    for (const entry of fileList) {
      const size = entry.size ?? '';
      lines.push(`    ${String(entry.name ?? '')} | ${String(entry.format ?? '')} | ${String(size)} bytes`);
    }
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cached };
}

export async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia download <IDENTIFIER> [FILES...] [options]',
          summary: 'Download files of an item, or list them with no FILE given.',
          options: DOWNLOAD_OPTIONS,
        })
      ),
    };
  }

  const identifier = validateIdentifier(parsed.positionals[0]);
  const requestedFiles = parsed.positionals.slice(1);
  const outArg = getStringOption(parsed, 'out') ?? '.';
  const listOnly = getBooleanOption(parsed, 'listOnly');
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DOWNLOAD_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const cacheRoot = getCacheRoot(ctx);
  const filesRoot = path.join(cacheRoot, identifier, 'files');

  const validatedNames: (readonly [string, string])[] = [];
  if (!listOnly && requestedFiles.length > 0) {
    for (const name of requestedFiles) {
      const [rel] = validateRelativeItemPath(name, filesRoot);
      validatedNames.push([name, rel]);
    }
  }

  let data: ItemMetadataPayload;
  let metaCached: boolean;
  try {
    [data, metaCached] = await ensureItemMetadata(identifier, ctx, {
      cacheRoot,
      timeout,
      refresh,
    });
  } catch (err: unknown) {
    if (err instanceof ArchiveNotFoundError) {
      throw new RecordRuntimeError(`No item with identifier ${identifier}`);
    }
    throw err;
  }

  const fileList = getMetadataFiles(data);
  if (listOnly || requestedFiles.length === 0) {
    const lines = fileList.map(
      (entry) =>
        `${String(entry.name ?? '')} | ${String(entry.format ?? '')} | ${String(entry.size ?? '')} bytes`
    );
    const bytesOut = emitStdout(ctx.io, lines.join('\n'));
    return { exitCode: 0, bytesOut, cacheHit: metaCached };
  }

  const byName = new Map<string, ItemFileEntry>();
  for (const entry of fileList) {
    if (typeof entry.name === 'string' && entry.name.length > 0) {
      byName.set(entry.name, entry);
    }
  }

  const outDir = path.resolve(ctx.cwd, outArg);
  fs.mkdirSync(outDir, { recursive: true });
  const lines: string[] = [];
  let allCached = metaCached;

  for (const [name, rel] of validatedNames) {
    const fileEntry = byName.get(name);
    if (!fileEntry) {
      throw new RecordRuntimeError(`File not in item ${identifier}: ${name}`);
    }
    const [content, , cached] = await ensureDownloadedFile(identifier, name, fileList, fileEntry, ctx, {
      cacheRoot,
      timeout,
      refresh,
    });
    allCached = allCached && cached;
    const dest = path.join(outDir, path.basename(rel));
    atomicWriteFileSync(dest, content);
    const displayDest = path.isAbsolute(outArg) ? dest : path.join(outArg, path.basename(rel));
    const status = cached ? 'cache-hit' : 'fetched';
    lines.push(`${displayDest} (${content.length} bytes, ${status})`);
  }

  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: allCached };
}

export async function runFulltext(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, FULLTEXT_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia fulltext [QUERY...] [options]',
          summary: 'Search OCR full text across digitized books and periodicals.',
          options: FULLTEXT_OPTIONS,
        })
      ),
    };
  }

  const rows = getNumberOption(parsed, 'rows') ?? 10;
  const page = getNumberOption(parsed, 'page') ?? 1;
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? SEARCH_TIMEOUT_SECONDS);
  if (rows < 1) {
    throw new CliValidationError(`--rows/--limit must be >= 1, got ${rows}.`);
  }
  if (page < 1) {
    throw new CliValidationError(`--page must be >= 1, got ${page}.`);
  }

  const query = resolveSearchQuery(parsed.positionals, getStringOption(parsed, 'queryFlag'));
  const ttlHours = resolveQueryTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const qs = encodeQueryPairs([
    ['user_query', query],
    ['service_backend', 'fts'],
    ['hits_per_page', String(rows)],
    ['page', String(page)],
  ]);
  const canonicalParams: Record<string, unknown> = {
    kind: 'fulltext',
    query,
    rows,
    page,
  };

  const [data, cached] = await cachedQueryJson('fulltext', canonicalParams, `${FULLTEXT_SEARCH}?${qs}`, ctx, {
    ttlHours,
    refresh,
    timeout,
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(data, cached));
    return { exitCode: 0, bytesOut, cacheHit: cached };
  }

  const resp = isPlainRecord(data.response) ? data.response : {};
  const body = isPlainRecord(resp.body) ? resp.body : {};
  const hitsBlock = isPlainRecord(body.hits) ? body.hits : {};
  const total = hitsBlock.total ?? 0;
  const hits = Array.isArray(hitsBlock.hits) ? hitsBlock.hits : [];
  const status = cached ? 'cache-hit' : 'fetched';
  const lines: string[] = [`${String(total)} full-text matches (showing ${hits.length}, ${status})`];

  for (const rawHit of hits) {
    const hit = isPlainRecord(rawHit) ? rawHit : {};
    const fields = isPlainRecord(hit.fields) ? hit.fields : {};
    const identifier = String(fields.identifier ?? '');
    const title = String(fields.title ?? '');
    const year = String(fields.year ?? fields.date ?? '');
    const highlight = isPlainRecord(hit.highlight) ? hit.highlight : {};
    const snippets = Array.isArray(highlight.text) ? highlight.text : [];
    const firstSnippet =
      snippets.length > 0 && typeof snippets[0] === 'string'
        ? shortText(snippets[0].replaceAll('{{{', '').replaceAll('}}}', ''), 200)
        : '';
    lines.push(`- ${identifier} | ${title} | ${year} | ${itemUrl(identifier)}`);
    if (firstSnippet) {
      lines.push(`  OCR: ${firstSnippet}`);
    }
  }

  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cached };
}

export async function runLookup(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, LOOKUP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia lookup <IDENTIFIER> [options]',
          summary: 'Resolve printed page <-> BookReader leaf <-> scandata leaf from cached page_index.json.',
          options: LOOKUP_OPTIONS,
        })
      ),
    };
  }

  const identifier = validateIdentifier(parsed.positionals[0]);
  const printedPage = getStringOption(parsed, 'printedPage');
  const leafFlagRaw = getStringOption(parsed, 'leaf');
  const leafArg = leafFlagRaw !== undefined ? parseLeafInt(leafFlagRaw) : undefined;
  const scandataLeaf = getNumberOption(parsed, 'scandataLeaf');
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  const selectors = [printedPage, leafArg, scandataLeaf].filter((v) => v !== undefined);
  if (selectors.length !== 1) {
    throw new CliValidationError(
      'Pass exactly one of --printed-page <p>, --leaf <n>, or --scandata-leaf <n>.'
    );
  }

  const cacheEntry = await ensureItemCache(identifier, ctx, {
    needDjvu: false,
    cacheRoot: getCacheRoot(ctx),
    timeout,
    refresh,
  });
  const pageIndex = readPageIndex(cacheEntry.pageIndexPath) ?? emptyPageIndex();

  let leaf: number;
  if (printedPage !== undefined) {
    [leaf] = resolvePrintedPageToLeaf(pageIndex, printedPage);
  } else if (leafArg !== undefined) {
    leaf = leafArg;
  } else {
    leaf = leafFromScandataLeaf(pageIndex, scandataLeaf as number);
  }
  validateLeafInIndex(pageIndex, leaf);

  const info = describeLeaf(pageIndex, leaf);
  const payload: Record<string, unknown> = {
    identifier,
    cached: cacheEntry.cached,
    ...info,
    image_url: pageImageUrl(identifier, leaf, { scale: 2 }),
    details_url: pageDetailsUrl(identifier, leaf),
  };

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, cacheEntry.cached));
    return { exitCode: 0, bytesOut, cacheHit: cacheEntry.cached };
  }

  const pp = info.printed_page ? info.printed_page : '?';
  const sc = info.scandata_leaf !== null ? String(info.scandata_leaf) : '?';
  const lines = [
    `${identifier}: printed page ${pp} | BookReader leaf n${leaf} | scandata leaf ${sc}`,
    `  image: ${String(payload.image_url)}`,
    `  details: ${String(payload.details_url)}`,
  ];
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cacheEntry.cached };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia url [QUERY...] [options]',
          summary: 'Print the website advanced-search URL for a query.',
          options: URL_OPTIONS,
        })
      ),
    };
  }
  const full = resolveSearchQuery(parsed.positionals, getStringOption(parsed, 'queryFlag'), {
    mediatype: getStringOption(parsed, 'mediatype'),
    collections: getStringListOption(parsed, 'collections'),
  });
  const bytesOut = emitStdout(ctx.io, `${ADVANCED_SEARCH}?q=${quotePathSegment(full)}`);
  return { exitCode: 0, bytesOut };
}
