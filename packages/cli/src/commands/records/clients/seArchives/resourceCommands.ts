import fs from 'node:fs';
import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { atomicWriteFileSync, cachedJsonCall } from '../../runtime/cache.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  CENSUS_SPEC,
  COLLECTION_SPEC,
  DOWNLOAD_SPEC,
  MANIFEST_SPEC,
  RECORD_SPEC,
  renderCensusHelp,
  renderCollectionHelp,
  renderDownloadHelp,
  renderManifestHelp,
  renderRecordHelp,
} from './cliSpecs.js';
import {
  ALLOWED_DOWNLOAD_HOSTS,
  BILDVISNING_BASE,
  buildIiifImageUrl,
  CENSUS_YEAR_FLAGS,
  type DownloadResult,
  detectImageFormat,
  FOLKRAKNINGAR_URL,
  getCacheDir,
  type IiifCollectionResult,
  type IiifManifestResult,
  isIiifCollectionResult,
  isIiifManifestResult,
  isRegisterDetailResult,
  KYRKOARKIV_URL,
  looksLikeHtmlPayload,
  normalizeBildid,
  parseArchiveId,
  parseRegisterId,
  type RegisterDetailResult,
  resolveSafeOutputPath,
  resolveTtlHours,
} from './domain.js';
import { formatCollectionText, formatManifestText, formatRegisterDetailText } from './parsers.js';
import {
  fetchIiifCollection,
  fetchIiifManifest,
  fetchRegisterDetail,
  requestWithRetry,
} from './transport.js';

export async function runRecord(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, RECORD_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRecordHelp()) };
  }
  const cleanId = parseRegisterId(parsed.positionals[0]);
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<RegisterDetailResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'register:detail',
    payload: { id: cleanId },
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchRegisterDetail(ctx, cleanId),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isRegisterDetailResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatRegisterDetailText(cleanId, result, cacheHit)),
    cacheHit,
  };
}

export async function runCollection(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, COLLECTION_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCollectionHelp()) };
  }
  const cleanId = parseArchiveId(parsed.positionals[0]);
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<IiifCollectionResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'iiif:collection',
    payload: { archive_id: cleanId },
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchIiifCollection(ctx, cleanId),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isIiifCollectionResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatCollectionText(cleanId, result, cacheHit)),
    cacheHit,
  };
}

export async function runManifest(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, MANIFEST_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderManifestHelp()) };
  }
  const limit = getNumberOption(parsed, 'limit') ?? 30;
  if (limit < 1) {
    throw new CliValidationError('--limit must be >= 1.');
  }
  const [volId] = normalizeBildid(parsed.positionals[0]);
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const { value: result, cacheHit } = await cachedJsonCall<IiifManifestResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'iiif:manifest',
    payload: { bildid: volId },
    ttlHours,
    refresh: getBooleanOption(parsed, 'refresh'),
    fetch: () => fetchIiifManifest(ctx, volId),
    cacheable: (r) => Boolean(r.verified),
    validateCached: isIiifManifestResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, formatManifestText(volId, result, limit, cacheHit)),
    cacheHit,
  };
}

export async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDownloadHelp()) };
  }
  const target = parsed.positionals[0];
  const out = getStringOption(parsed, 'out') ?? '';
  const page = getNumberOption(parsed, 'page');
  const width = getNumberOption(parsed, 'width');
  const full = getBooleanOption(parsed, 'full');
  const overwrite = getBooleanOption(parsed, 'overwrite');
  const asJson = getBooleanOption(parsed, 'asJson');

  const [url, pageId] = buildIiifImageUrl(target, { page, width, full });
  const dest = resolveSafeOutputPath(out, `${pageId}.jpg`, ctx.env);

  let info: DownloadResult;
  if (fs.existsSync(dest) && !overwrite) {
    const data = fs.readFileSync(dest);
    const fmt = detectImageFormat(data);
    if (!fmt) {
      throw new RecordRuntimeError(
        `Existing file at ${dest} is not a valid image; pass --overwrite to replace.`
      );
    }
    info = {
      page_id: pageId,
      url,
      bildvisning_url: `${BILDVISNING_BASE}/${pageId}`,
      path: dest,
      bytes: data.length,
      format: fmt,
      skipped: true,
      cache_hit: true,
    };
  } else {
    const res = await requestWithRetry(ctx, {
      url,
      allowedHosts: ALLOWED_DOWNLOAD_HOSTS,
      headers: { Accept: 'image/jpeg,image/png,image/*;q=0.9' },
    });
    const contentType = res.headers.get('content-type') ?? '';
    const payload = res.bytes;
    if (payload.length === 0) {
      throw new RecordRuntimeError(`Refusing empty response body from ${url}`);
    }
    if (looksLikeHtmlPayload(payload, contentType)) {
      throw new RecordRuntimeError(
        `Refusing to save HTML response (Content-Type: ${contentType || 'unknown'}) as an image from ${url}`
      );
    }
    const fmt = detectImageFormat(payload);
    if (!fmt) {
      throw new RecordRuntimeError(
        `Refusing non-image payload (Content-Type: ${contentType || 'unknown'}) from ${url}`
      );
    }
    atomicWriteFileSync(dest, payload);
    info = {
      page_id: pageId,
      url,
      bildvisning_url: `${BILDVISNING_BASE}/${pageId}`,
      path: dest,
      bytes: payload.length,
      format: fmt,
      skipped: false,
      cache_hit: false,
    };
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, info),
      cacheHit: info.cache_hit,
    };
  }
  const verb = info.skipped ? 'Exists (skip)' : 'Downloaded';
  const lines = [
    `${verb}: ${info.path} (${info.bytes.toLocaleString('en-US')} bytes, ${info.format})`,
    `  Source: ${info.url}`,
    `  Viewer: ${info.bildvisning_url}`,
  ];
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: info.cache_hit,
  };
}

export function runCensus(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, CENSUS_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCensusHelp()) };
  }

  const surname = (getStringOption(parsed, 'surname') ?? '').trim();
  const given = (getStringOption(parsed, 'given') ?? '').trim();
  const birthYear = getNumberOption(parsed, 'birthYear');
  const parish = (getStringOption(parsed, 'parish') ?? '').trim();
  const year = getNumberOption(parsed, 'year');

  const query = new URLSearchParams({ AvanceradSok: 'False' });
  let hasFilter = false;
  if (surname) {
    query.set('Efternamn', surname);
    hasFilter = true;
  }
  if (given) {
    query.set('Fornamn', given);
    hasFilter = true;
  }
  if (birthYear !== undefined) {
    if (birthYear < 1700 || birthYear > 1930) {
      throw new CliValidationError('--birth-year must be between 1700 and 1930.');
    }
    query.set('Fodelsear', String(birthYear));
    hasFilter = true;
  }
  if (parish) {
    query.set('Hemforsamling', parish);
    hasFilter = true;
  }
  if (year !== undefined) {
    const flag = CENSUS_YEAR_FLAGS[year];
    if (!flag) {
      const valid = Object.keys(CENSUS_YEAR_FLAGS).join(', ');
      throw new CliValidationError(`Unsupported census --year ${year}; choose from: ${valid}.`);
    }
    query.set(flag, 'true');
    hasFilter = true;
  }

  const censusUrl = hasFilter ? `${FOLKRAKNINGAR_URL}?${query.toString()}` : FOLKRAKNINGAR_URL;
  const churchUrl = parish
    ? `${KYRKOARKIV_URL}?${new URLSearchParams({ Arkiv: parish, AvanceradSok: 'False' }).toString()}`
    : KYRKOARKIV_URL;

  const payload = {
    name: 'Riksarkivet Folkräkningar (Swedish National Censuses 1860-1930)',
    status: 'browser-only',
    reason: 'sok.riksarkivet.se redirects automated HTTP clients to /captcha.',
    census_url: censusUrl,
    church_archives_url: churchUrl,
    open_census_years: Object.keys(CENSUS_YEAR_FLAGS).map((k) => Number(k)),
  };

  if (getBooleanOption(parsed, 'asJson')) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const lines = [
    'Riksarkivet Folkräkningar (browser only):',
    `  Census search URL: ${censusUrl}`,
    `  Parish church archives URL: ${churchUrl}`,
    '  Open census years on sok.riksarkivet.se: 1860, 1870, 1880, 1890, 1900, 1910, 1930',
    '  Note: sok.riksarkivet.se web search endpoints enforce a CAPTCHA for automated clients.',
    '  Use `se-archives search`, `births`, `marriages`, `collection`, `manifest`, and `download`',
    '  for the open public data.riksarkivet.se and lbiiif.riksarkivet.se APIs.',
  ];
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}
