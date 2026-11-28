import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { atomicWriteFileSync } from '../../runtime/cache.js';
import { atomicCopyFileSync, isPlainRecord } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  DOWNLOAD_PARSE_SPEC,
  PAGE_PARSE_SPEC,
  renderDownloadHelp,
  renderPageHelp,
  renderSearchHelp,
  renderUrlHelp,
  SEARCH_PARSE_SPEC,
  URL_PARSE_SPEC,
} from './cliSpecs.js';
import {
  buildResourceUrl,
  buildSearchParams,
  type ChronamAssetKind,
  COLLECTION_BASE,
  compactResult,
  DEFAULT_TIMEOUT,
  DOWNLOAD_TIMEOUT,
  type DownloadedFileRecord,
  extractSeqFromUrl,
  firstValue,
  formatTextField,
  type PageAssets,
  resolveDates,
  resolvePageAssets,
  resolveQuery,
  resolveSafeChild,
  resolveTtlHours,
  resourceUrlJson,
  safeOutputFilename,
  searchCacheable,
} from './domain.js';
import { cachedDownloadFile, cachedGetJson } from './transport.js';

export async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }

  const query = resolveQuery(parsed.positionals, getStringOption(parsed, 'termsOpt'));
  const dates = resolveDates(
    getStringOption(parsed, 'dates'),
    getStringOption(parsed, 'dateFrom'),
    getStringOption(parsed, 'dateTo')
  );
  const level = getStringOption(parsed, 'level') ?? 'page';
  const state = getStringOption(parsed, 'state');
  const lccn = getStringOption(parsed, 'lccn');
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const page = getNumberOption(parsed, 'page') ?? 1;
  const timeout = getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT;
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);

  const params = buildSearchParams(query, { dates, level, limit, page, state, lccn });
  const { data, cacheHit } = await cachedGetJson(ctx, COLLECTION_BASE, params, {
    timeout,
    refresh,
    ttlHours,
    cacheable: searchCacheable,
  });

  const rawResults = Array.isArray(data['results']) ? data['results'] : [];
  const results = rawResults.filter(isPlainRecord);
  const searchObj = isPlainRecord(data['search']) ? data['search'] : undefined;
  const hits = searchObj?.['hits'];

  if (hits && results.length === 0) {
    ctx.io.stderr(
      `Warning: loc.gov reported ${String(hits)} total hits but returned 0 rows on page ${page}. ` +
        'Check --page or retry once if loc.gov dropped facet results.'
    );
  } else if (!hits) {
    ctx.io.stderr(
      'Note: 0 hits. loc.gov sometimes returns a transient empty answer; empty results are ' +
        'never cached, so one rerun confirms a true zero.'
    );
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      hits: hits ?? null,
      cache_hit: cacheHit,
      results: results.map((item) => compactResult(item)),
    });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const lines: string[] = [
    `hits: ${formatTextField(hits)} (showing ${results.length} on this page)${cacheHit ? ' [cache]' : ''}`,
  ];
  for (const item of results) {
    const c = compactResult(item);
    lines.push(
      `- ${formatTextField(c['date'])} | ${formatTextField(c['title'])} | ${formatTextField(c['state'])} | ${formatTextField(c['url'])}`
    );
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runGetPage(
  cmdName: 'get' | 'page',
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PAGE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPageHelp(cmdName)) };
  }

  let resourceUrl = parsed.positionals[0];
  const lccn = getStringOption(parsed, 'lccn');
  const date = getStringOption(parsed, 'date');
  const edition = getStringOption(parsed, 'edition') ?? '1';
  const seq = getStringOption(parsed, 'seq') ?? '1';
  const timeout = getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT;
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);

  if (!resourceUrl) {
    if (!lccn || !date) {
      throw new CliValidationError('Give a resource URL or both --lccn and --date.');
    }
    resourceUrl = buildResourceUrl(lccn, date, edition, seq);
  }

  const jsonUrl = resourceUrlJson(resourceUrl);
  const { data, cacheHit } = await cachedGetJson(ctx, jsonUrl, undefined, {
    timeout,
    refresh,
    ttlHours,
  });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...data, cache_hit: cacheHit });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const item = isPlainRecord(data['item']) ? data['item'] : {};
  const resource = isPlainRecord(data['resource']) ? data['resource'] : {};
  const titleVal = resource['title'] || item['title'];
  const lccnVal = firstValue(item['number_lccn']) || item['lccn'];
  const lines: string[] = [
    `title: ${formatTextField(titleVal)}${cacheHit ? ' [cache]' : ''}`,
    `date: ${formatTextField(item['date'])}`,
    `lccn: ${formatTextField(lccnVal)}`,
    `place: ${formatTextField(firstValue(item['location_city']))}, ${formatTextField(firstValue(item['location_state']))}`,
    `url: ${resourceUrl}`,
  ];
  const assets = resolvePageAssets(data);
  const assetFields: readonly (readonly [string, keyof PageAssets])[] = [
    ['pdf', 'pdf'],
    ['image', 'image'],
    ['jp2', 'jp2'],
    ['fulltext_file', 'text'],
    ['iiif_manifest_url', 'iiif_manifest_url'],
  ];
  for (const [label, key] of assetFields) {
    const val = assets[key];
    if (val) {
      lines.push(`${label}: ${val}`);
    }
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDownloadHelp()) };
  }

  let resourceUrl = parsed.positionals[0];
  const lccn = getStringOption(parsed, 'lccn');
  const date = getStringOption(parsed, 'date');
  const edition = getStringOption(parsed, 'edition') ?? '1';
  const seqOpt = getStringOption(parsed, 'seq');
  const outOpt = getStringOption(parsed, 'out') ?? '.';
  const pdf = getBooleanOption(parsed, 'pdf');
  const image = getBooleanOption(parsed, 'image');
  const imageWidth = getNumberOption(parsed, 'imageWidth');
  const jp2 = getBooleanOption(parsed, 'jp2');
  const text = getBooleanOption(parsed, 'text');
  const timeout = getNumberOption(parsed, 'timeout') ?? DOWNLOAD_TIMEOUT;
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);

  let resolvedSeq: string;
  if (!resourceUrl) {
    if (!lccn || !date) {
      throw new CliValidationError('Give a resource URL or both --lccn and --date.');
    }
    resolvedSeq = seqOpt || '1';
    resourceUrl = buildResourceUrl(lccn, date, edition, resolvedSeq);
  } else {
    resolvedSeq = seqOpt || extractSeqFromUrl(resourceUrl, '1');
  }

  const resourceJsonUrl = resourceUrlJson(resourceUrl);
  const outParts = outOpt.split(/[\\/]+/);
  if (outParts.includes('..') && !path.isAbsolute(outOpt)) {
    throw new RecordRuntimeError(`Unsafe output directory containing '..': ${outOpt}`);
  }
  const outdir = path.isAbsolute(outOpt) ? outOpt : path.resolve(ctx.cwd, outOpt);
  fs.mkdirSync(outdir, { recursive: true });

  const { data, cacheHit: metaHit } = await cachedGetJson(ctx, resourceJsonUrl, undefined, {
    timeout,
    refresh,
    ttlHours,
  });

  const item = isPlainRecord(data['item']) ? data['item'] : {};
  const itemLccn = firstValue(item['number_lccn']);
  const itemDate = item['date'];
  const stem = safeOutputFilename(
    `${itemLccn ? String(itemLccn) : 'loc'}_${itemDate ? String(itemDate) : 'nodate'}_sp${resolvedSeq}`
  );
  const assets = resolvePageAssets(data, { imageWidth });

  const jobs: [ChronamAssetKind, string, string][] = [];
  if (pdf && assets.pdf) {
    jobs.push(['pdf', assets.pdf, `${stem}.pdf`]);
  } else if (pdf && !image && assets.image) {
    jobs.push(['image', assets.image, `${stem}.jpg`]);
  }
  if (image && assets.image) {
    jobs.push(['image', assets.image, `${stem}.jpg`]);
  }
  if (jp2 && assets.jp2) {
    jobs.push(['jp2', assets.jp2, `${stem}.jp2`]);
  }
  if (text && assets.text) {
    jobs.push(['text', assets.text, `${stem}.alto.xml`]);
  }

  if (jobs.length === 0) {
    ctx.io.stderr('No downloadable resources found for this page.');
    return { exitCode: 1, bytesOut: 0, cacheHit: metaHit };
  }

  const downloadedFiles: DownloadedFileRecord[] = [];
  const textLines: string[] = [];
  let totalBytes = 0;

  for (const [kind, assetUrl, filename] of jobs) {
    const safeName = safeOutputFilename(filename);
    const dest = resolveSafeChild(outdir, safeName);
    const {
      cachePath,
      nbytes,
      contentType,
      cacheHit: fileHit,
    } = await cachedDownloadFile(ctx, assetUrl, { timeout, refresh, ttlHours, kind });
    atomicCopyFileSync(cachePath, dest);
    totalBytes += nbytes;
    downloadedFiles.push({
      kind,
      url: assetUrl,
      path: dest,
      bytes: nbytes,
      content_type: contentType,
      cache_hit: fileHit,
    });
    if (!asJson) {
      const marker = fileHit ? ' [cache]' : '';
      textLines.push(`${kind}: ${dest} (${nbytes} bytes)${marker}`);
    }
  }

  const metaName = safeOutputFilename(`${stem}.metadata.json`);
  const metaPath = resolveSafeChild(outdir, metaName);
  atomicWriteFileSync(
    metaPath,
    JSON.stringify(
      {
        resource_url: resourceUrl,
        item,
        resources: data['resources'] ?? null,
      },
      null,
      2
    )
  );

  const allHit = Boolean(metaHit && downloadedFiles.length > 0 && downloadedFiles.every((f) => f.cache_hit));

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      resource_url: resourceUrl,
      out_dir: outdir,
      metadata_path: metaPath,
      metadata_cache_hit: metaHit,
      bytes: totalBytes,
      cache_hit: allHit,
      files: downloadedFiles,
    });
    return { exitCode: 0, bytesOut, cacheHit: allHit };
  }

  textLines.push(`metadata: ${metaPath}`);
  const bytesOut = emitStdout(ctx.io, textLines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: allHit };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const query = resolveQuery(parsed.positionals, getStringOption(parsed, 'termsOpt'));
  const dates = resolveDates(
    getStringOption(parsed, 'dates'),
    getStringOption(parsed, 'dateFrom'),
    getStringOption(parsed, 'dateTo')
  );
  const level = getStringOption(parsed, 'level') ?? 'page';
  const state = getStringOption(parsed, 'state');
  const lccn = getStringOption(parsed, 'lccn');

  const params = buildSearchParams(query, { dates, level, limit: 10, page: 1, state, lccn });
  const browserParams = params.filter(([k]) => k !== 'fo' && k !== 'at' && k !== 'c' && k !== 'sp');
  const qs = new URLSearchParams(browserParams).toString();
  const bytesOut = emitStdout(ctx.io, `${COLLECTION_BASE}?${qs}`);
  return { exitCode: 0, bytesOut };
}
