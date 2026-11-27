import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { atomicWriteFileSync } from '../../runtime/cache.js';
import { runWithConcurrency } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { PAGE_OPTIONS, PAGE_PARSE_SPEC, TEXT_OPTIONS, TEXT_PARSE_SPEC } from './cliSpecs.js';
import { emptyPageIndex, ensureItemCache, ensurePageImageCache, readPageIndex } from './itemCache.js';
import {
  describeLeaf,
  pageSuffixAndUrl,
  parseLeafSpec,
  parsePrintedPageSpec,
  parsePrintedRange,
  resolvePrintedPageToLeaf,
  segmentForLeaf,
  validateLeafInIndex,
} from './pageAndGrep.js';
import { getCacheRoot } from './transport.js';
import {
  DEFAULT_TIMEOUT_SECONDS,
  IMAGE_EXTS,
  jsonWithCacheHit,
  PAGE_BATCH_WORKERS,
  type PageJob,
  pageDetailsUrl,
  pageImageUrl,
  parseLeafInt,
  validateIdentifier,
  validatePositiveTimeout,
  type WrittenPageRow,
} from './types.js';

export { runGrep } from './grepCommand.js';

function formatPageStatusLine(row: WrittenPageRow): string {
  const extra = row.printed_page !== null ? ` [p.${row.printed_page} -> n${row.leaf}]` : ` [n${row.leaf}]`;
  const status = row.page_cached ? 'cache-hit' : 'fetched';
  return `${row.path} (${row.bytes} bytes)${extra} (${status})`;
}

export async function runPage(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const t0 = ctx.nowMs();
  const parsed = parseCommandArgs(argv, PAGE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia page <IDENTIFIER> [LEAF] [options]',
          summary: 'Download one or more rendered page JPEGs by printed page number or BookReader leaf.',
          options: PAGE_OPTIONS,
        })
      ),
    };
  }

  const identifier = validateIdentifier(parsed.positionals[0]);
  const leafPosRaw = parsed.positionals.length > 1 ? parsed.positionals[1] : undefined;
  const leafFromPos = leafPosRaw !== undefined ? parseLeafInt(leafPosRaw) : undefined;
  const leafFlagRaw = getStringOption(parsed, 'leaf');
  const leafFromFlag = leafFlagRaw !== undefined ? parseLeafInt(leafFlagRaw) : undefined;
  const printedPage = getStringOption(parsed, 'printedPage');
  const leavesSpec = getStringOption(parsed, 'leaves');
  const printedPagesSpec = getStringOption(parsed, 'printedPages');
  const scale = getNumberOption(parsed, 'scale');
  const width = getNumberOption(parsed, 'width');
  const concurrency = getNumberOption(parsed, 'concurrency') ?? PAGE_BATCH_WORKERS;
  const outArg = getStringOption(parsed, 'out') ?? '.';
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  if (scale !== undefined && scale < 1) {
    throw new CliValidationError(`--scale must be >= 1, got ${scale}.`);
  }
  if (width !== undefined && width < 1) {
    throw new CliValidationError(`--width must be >= 1, got ${width}.`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new CliValidationError(`--concurrency must be an integer between 1 and 8, got ${concurrency}.`);
  }

  if (printedPage !== undefined && (leafFromPos !== undefined || leafFromFlag !== undefined)) {
    throw new CliValidationError('Pass either --printed-page or --leaf (not both).');
  }
  if (leafFromPos !== undefined && leafFromFlag !== undefined) {
    throw new CliValidationError('Pass either positional <leaf> or --leaf (not both).');
  }
  if (leavesSpec !== undefined && printedPagesSpec !== undefined) {
    throw new CliValidationError('Pass either --leaves or --printed-pages, not both.');
  }
  const singleNames = [
    leafFromPos !== undefined ? 'positional <leaf>' : undefined,
    leafFromFlag !== undefined ? '--leaf' : undefined,
    printedPage !== undefined ? '--printed-page' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (leavesSpec !== undefined && singleNames.length > 0) {
    throw new CliValidationError(`Pass either --leaves or ${singleNames.join(' or ')}, not both.`);
  }
  if (printedPagesSpec !== undefined && singleNames.length > 0) {
    throw new CliValidationError(`Pass either --printed-pages or ${singleNames.join(' or ')}, not both.`);
  }

  const cacheRoot = getCacheRoot(ctx);
  const jobs: PageJob[] = [];
  let indexCached: boolean | null = null;

  const loadIndex = async () => {
    const cacheEntry = await ensureItemCache(identifier, ctx, {
      needDjvu: false,
      cacheRoot,
      timeout,
      refresh,
    });
    indexCached = cacheEntry.cached;
    return readPageIndex(cacheEntry.pageIndexPath) ?? emptyPageIndex();
  };

  if (printedPagesSpec !== undefined) {
    const labels = parsePrintedPageSpec(printedPagesSpec);
    const pageIndex = await loadIndex();
    for (const label of labels) {
      const [leaf] = resolvePrintedPageToLeaf(pageIndex, label);
      validateLeafInIndex(pageIndex, leaf);
      const info = describeLeaf(pageIndex, leaf);
      const [suffix, url] = pageSuffixAndUrl(identifier, leaf, scale, width);
      jobs.push({ leaf, scandata_leaf: info.scandata_leaf, printed_page: info.printed_page, suffix, url });
    }
  } else if (leavesSpec !== undefined) {
    for (const leaf of parseLeafSpec(leavesSpec)) {
      const [suffix, url] = pageSuffixAndUrl(identifier, leaf, scale, width);
      jobs.push({ leaf, scandata_leaf: null, printed_page: null, suffix, url });
    }
  } else if (printedPage !== undefined) {
    const pageIndex = await loadIndex();
    const [targetLeaf, scandataLeaf] = resolvePrintedPageToLeaf(pageIndex, printedPage);
    const [suffix, url] = pageSuffixAndUrl(identifier, targetLeaf, scale, width);
    jobs.push({ leaf: targetLeaf, scandata_leaf: scandataLeaf, printed_page: printedPage, suffix, url });
  } else {
    const targetLeaf = leafFromFlag !== undefined ? leafFromFlag : leafFromPos;
    if (targetLeaf === undefined) {
      throw new CliValidationError(
        'Specify a target page with --printed-page <str>, --leaf <int>, positional <leaf>, --leaves, or --printed-pages.'
      );
    }
    if (targetLeaf < 0) {
      throw new CliValidationError(`Leaf index must be >= 0, got ${targetLeaf}.`);
    }
    const [suffix, url] = pageSuffixAndUrl(identifier, targetLeaf, scale, width);
    jobs.push({ leaf: targetLeaf, scandata_leaf: null, printed_page: null, suffix, url });
  }

  const outResolved = path.resolve(ctx.cwd, outArg);
  const outExt = path.extname(outResolved).toLowerCase();
  const outIsExistingDir = (() => {
    try {
      return fs.statSync(outResolved).isDirectory();
    } catch {
      return false;
    }
  })();

  if (jobs.length > 1 && IMAGE_EXTS.has(outExt) && !outIsExistingDir) {
    throw new CliValidationError(
      `--out ${outArg} is a single image file. Pass a directory when fetching ${jobs.length} pages.`
    );
  }

  const fetched = await runWithConcurrency(jobs, concurrency, (job) =>
    ensurePageImageCache(identifier, job.leaf, job.suffix, job.url, ctx, {
      cacheRoot,
      timeout,
      refresh,
    })
  );

  const singleFileOut = jobs.length === 1 && IMAGE_EXTS.has(outExt) && !outIsExistingDir;
  if (!singleFileOut) {
    fs.mkdirSync(outResolved, { recursive: true });
  }

  const written: WrittenPageRow[] = jobs.map((job, idx) => {
    const [content, pageCachePath, pageCached] = fetched[idx];
    const dest = singleFileOut
      ? outResolved
      : path.join(outResolved, `${identifier}_n${job.leaf}_${job.suffix}.jpg`);
    if (path.resolve(dest) !== path.resolve(pageCachePath)) {
      atomicWriteFileSync(dest, content);
    }
    return {
      leaf: job.leaf,
      scandata_leaf: job.scandata_leaf,
      printed_page: job.printed_page,
      url: job.url,
      path: dest,
      cache_path: pageCachePath,
      bytes: content.length,
      page_cached: pageCached,
    };
  });

  if (written.length === 1) {
    const row = written[0];
    const elapsedMs = Math.round((ctx.nowMs() - t0) * 100) / 100;
    const pageHit = indexCached === null ? row.page_cached : Boolean(row.page_cached && indexCached);
    const payload: Record<string, unknown> = {
      identifier,
      leaf: row.leaf,
      scandata_leaf: row.scandata_leaf,
      printed_page: row.printed_page,
      url: row.url,
      path: row.path,
      cache_path: row.cache_path,
      bytes: row.bytes,
      index_cached: indexCached,
      page_cached: row.page_cached,
      elapsed_ms: elapsedMs,
    };
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, pageHit));
      return { exitCode: 0, bytesOut, cacheHit: pageHit };
    }
    const bytesOut = emitStdout(ctx.io, formatPageStatusLine(row));
    return { exitCode: 0, bytesOut, cacheHit: pageHit };
  }

  const cacheHit = written.every((row) => row.page_cached) && indexCached !== false;
  const pagesPayload = written.map((row) => ({
    leaf: row.leaf,
    scandata_leaf: row.scandata_leaf,
    printed_page: row.printed_page,
    url: row.url,
    path: row.path,
    bytes: row.bytes,
    page_cached: row.page_cached,
  }));
  const payload: Record<string, unknown> = {
    identifier,
    count: pagesPayload.length,
    pages: pagesPayload,
  };
  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, cacheHit));
    return { exitCode: 0, bytesOut, cacheHit };
  }
  const bytesOut = emitStdout(ctx.io, written.map(formatPageStatusLine).join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runText(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TEXT_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia text [IDENTIFIER] [PAGE] [options]',
          summary:
            'Print cached OCR text for a printed page, leaf, or printed-page range (no JPEG download).',
          options: TEXT_OPTIONS,
        })
      ),
    };
  }

  const itemFlag = getStringOption(parsed, 'itemFlag');
  const posId = parsed.positionals[0];
  let pagePos = parsed.positionals[1];
  let rawId = itemFlag ?? posId;
  if (itemFlag && posId && pagePos === undefined) {
    pagePos = posId;
    rawId = itemFlag;
  }
  if (!rawId) {
    throw new CliValidationError('Pass an Internet Archive item identifier (positional or --item/--id).');
  }
  const identifier = validateIdentifier(rawId);

  let printedPage = getStringOption(parsed, 'printedPage');
  const leafFlagRaw = getStringOption(parsed, 'leaf');
  let leafArg = leafFlagRaw !== undefined ? parseLeafInt(leafFlagRaw) : undefined;
  let pagesArg = getStringOption(parsed, 'pages');
  const leavesArg = getStringOption(parsed, 'leaves');
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  if (pagePos !== undefined) {
    const explicit = [printedPage, leafArg, pagesArg, leavesArg].filter((v) => v !== undefined);
    if (explicit.length > 0) {
      throw new CliValidationError(
        'Pass either a positional page/leaf or one of --printed-page/--page, --leaf, --pages, or --leaves, not both.'
      );
    }
    const token = pagePos.trim();
    if (/^[nN]\d+$/.test(token)) {
      leafArg = Number.parseInt(token.slice(1), 10);
    } else if (token.includes('-') || token.includes(',')) {
      pagesArg = token;
    } else {
      printedPage = token;
    }
  }

  const selectors = [printedPage, leafArg, pagesArg, leavesArg].filter((v) => v !== undefined);
  if (selectors.length !== 1) {
    throw new CliValidationError(
      'Pass exactly one of --printed-page/--page <p>, --leaf <n>, --pages <p1-p2>, or --leaves <n1-n2>.'
    );
  }

  const cacheEntry = await ensureItemCache(identifier, ctx, {
    needDjvu: true,
    cacheRoot: getCacheRoot(ctx),
    timeout,
    refresh,
  });
  const pageIndex = readPageIndex(cacheEntry.pageIndexPath) ?? emptyPageIndex();
  const djvuText = fs.readFileSync(cacheEntry.djvuPath).toString('utf8');

  let leaves: number[];
  if (printedPage !== undefined) {
    const [leaf] = resolvePrintedPageToLeaf(pageIndex, printedPage);
    leaves = [leaf];
  } else if (leafArg !== undefined) {
    leaves = [leafArg];
  } else if (leavesArg !== undefined) {
    leaves = parseLeafSpec(leavesArg);
  } else {
    leaves = parsePrintedRange(pageIndex, pagesArg ?? '');
  }

  for (const leaf of leaves) {
    validateLeafInIndex(pageIndex, leaf);
  }

  if (pageIndex.segment_mode === 'flat') {
    throw new RecordRuntimeError(
      `Item ${identifier} OCR text has no page breaks; per-page text is unavailable. Use \`grep\` or \`download\` for the full text.`
    );
  }

  const segments = djvuText.split('\x0c');
  const pagesOut: {
    readonly leaf: number;
    readonly scandata_leaf: number | null;
    readonly printed_page: string | null;
    readonly text: string;
    readonly image_url: string;
    readonly details_url: string;
  }[] = [];

  for (const leaf of leaves) {
    const info = describeLeaf(pageIndex, leaf);
    const segIdx = segmentForLeaf(pageIndex, leaf, info.scandata_leaf);
    if (segIdx === null || segIdx < 0 || segIdx >= segments.length) {
      throw new RecordRuntimeError(
        `No OCR text segment found for leaf n${leaf} in ${identifier} (djvu.txt has ${segments.length} pages).`
      );
    }
    pagesOut.push({
      ...info,
      text: segments[segIdx].replace(/^\n+|\n+$/g, ''),
      image_url: pageImageUrl(identifier, leaf, { scale: 2 }),
      details_url: pageDetailsUrl(identifier, leaf),
    });
  }

  const payload: Record<string, unknown> = {
    identifier,
    cached: cacheEntry.cached,
    pages: pagesOut,
  };
  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, cacheEntry.cached));
    return { exitCode: 0, bytesOut, cacheHit: cacheEntry.cached };
  }

  const lines: string[] = [];
  for (let idx = 0; idx < pagesOut.length; idx += 1) {
    const page = pagesOut[idx];
    if (idx > 0) {
      lines.push('');
    }
    const pp = page.printed_page ? `p.${page.printed_page}` : 'p.?';
    const sc = page.scandata_leaf !== null ? `, scandata leaf ${page.scandata_leaf}` : '';
    lines.push(`== ${identifier} | n${page.leaf} (${pp}${sc})`);
    lines.push(`   image: ${page.image_url}`);
    lines.push(`   details: ${page.details_url}`);
    lines.push(page.text);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: cacheEntry.cached };
}
