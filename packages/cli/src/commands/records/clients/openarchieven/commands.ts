import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { atomicWriteFileSync, sha256Hex } from '../../runtime/cache.js';
import { isPlainRecord, resolveUserPathFromContext } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  DOWNLOAD_PARSE_SPEC,
  renderDownloadHelp,
  renderSearchHelp,
  renderShowHelp,
  renderUrlHelp,
  SEARCH_PARSE_SPEC,
  SHOW_PARSE_SPEC,
  URL_PARSE_SPEC,
} from './cliSpecs.js';
import {
  buildDirectScanCandidates,
  extractScansFromShow,
  fmtEventdate,
  formatA2aRecord,
  isCompleteRecordRef,
  isDirectScanUrl,
  isSourceType,
  parseRecordRef,
  type ScanImage,
  scanFilename,
  validateScanUrl,
  WEB_BASE,
} from './domain.js';
import {
  type CachePolicyOptions,
  downloadScanCandidates,
  getCacheDir,
  loadSearch,
  loadShow,
  resolveTtlHours,
  searchWindow,
} from './transport.js';

function isExistingDir(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(targetPath: string): boolean {
  try {
    fs.statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }

  const nameArg = parsed.positionals[0];
  const nameOpt = getStringOption(parsed, 'nameOpt');
  const firstName = getStringOption(parsed, 'firstName');
  const lastName = getStringOption(parsed, 'lastName');
  const place = getStringOption(parsed, 'place');
  const birthPlace = getStringOption(parsed, 'birthPlace');
  const eventType = getStringOption(parsed, 'eventType');
  const sourceType = getStringOption(parsed, 'sourceType');
  const year = getStringOption(parsed, 'year');
  const archive = getStringOption(parsed, 'archive');
  const relation = getStringOption(parsed, 'relation');
  const country = getStringOption(parsed, 'country');
  const lang = getStringOption(parsed, 'lang') ?? 'nl';
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const start = getNumberOption(parsed, 'start') ?? 0;
  const page = getNumberOption(parsed, 'page');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');

  const combinedParts = [firstName, lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(' ');
  let rawName = (nameOpt || nameArg || combinedParts).trim();
  if (!rawName) {
    throw new CliValidationError('Provide a name via --name, --first/--last, or a positional argument.');
  }
  if (year) {
    rawName = `${rawName} ${year.trim()}`;
  }

  const startFromUser = parsed.provided.has('start');
  const [numberShow, effectiveStart] = searchWindow(limit, start, page, startFromUser);

  const params: Record<string, string | number> = {
    name: rawName,
    number_show: numberShow,
    start: effectiveStart,
    lang,
  };
  if (place) {
    params.eventplace = place;
  }
  if (birthPlace) {
    params.birthplace = birthPlace;
  }
  if (sourceType) {
    params.sourcetype = sourceType;
  }
  if (eventType) {
    if (isSourceType(eventType) && !('sourcetype' in params)) {
      params.sourcetype = eventType;
    } else {
      params.eventtype = eventType;
    }
  }
  if (archive) {
    params.archive = archive;
  }
  if (relation) {
    params.relationtype = relation;
  }
  if (country) {
    params.country_code = country;
  }

  const ttlHours = resolveTtlHours(cliTtl, ctx);
  const cacheDir = getCacheDir(ctx);
  const { data, cacheHit } = await loadSearch(ctx, cacheDir, params, { refresh, ttlHours });

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...data, cache_hit: Boolean(cacheHit) });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const resp = isPlainRecord(data.response) ? data.response : {};
  const total = typeof resp.number_found === 'number' ? resp.number_found : 0;
  const docs = Array.isArray(resp.docs) ? resp.docs : [];
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `Found ${total} records (showing ${docs.length} from offset ${effectiveStart})${marker}`,
  ];
  for (const rawDoc of docs) {
    if (!isPlainRecord(rawDoc)) {
      continue;
    }
    const code = typeof rawDoc.archive_code === 'string' ? rawDoc.archive_code : '';
    const ident = typeof rawDoc.identifier === 'string' ? rawDoc.identifier : '';
    const person =
      typeof rawDoc.personname === 'string' && rawDoc.personname ? rawDoc.personname : '(unnamed)';
    const role = typeof rawDoc.relationtype === 'string' ? rawDoc.relationtype : '';
    const stype =
      (typeof rawDoc.sourcetype === 'string' && rawDoc.sourcetype) ||
      (typeof rawDoc.eventtype === 'string' && rawDoc.eventtype) ||
      '';
    const dateStr = fmtEventdate(rawDoc.eventdate);
    const places = rawDoc.eventplace;
    const placeStr = Array.isArray(places)
      ? places.map((p) => String(p)).join(', ')
      : places !== undefined && places !== null
        ? String(places)
        : '';
    const url = typeof rawDoc.url === 'string' && rawDoc.url ? rawDoc.url : `${WEB_BASE}/${code}:${ident}`;
    lines.push(`- ${code}:${ident} | ${person} (${role}) | ${stype} | ${dateStr} | ${placeStr}`);
    lines.push(`  ${url}`);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runShow(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SHOW_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderShowHelp()) };
  }

  const archive = parsed.positionals[0];
  const identifier = parsed.positionals[1];
  const lang = getStringOption(parsed, 'lang') ?? 'nl';
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');

  const [code, ident] = parseRecordRef(archive, identifier);
  const ttlHours = resolveTtlHours(cliTtl, ctx);
  const cacheDir = getCacheDir(ctx);

  const { data, cacheHit } = await loadShow(ctx, cacheDir, code, ident, lang, {
    refresh,
    ttlHours,
  });

  if (asJson) {
    const payload = isPlainRecord(data)
      ? { ...data, cache_hit: Boolean(cacheHit) }
      : { records: data, cache_hit: Boolean(cacheHit) };
    const bytesOut = emitJsonStdout(ctx.io, payload);
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const records = Array.isArray(data) ? data : data !== undefined && data !== null ? [data] : [];
  if (records.length === 0) {
    const bytesOut = emitStdout(ctx.io, 'No record data returned.');
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const blocks: string[] = [];
  for (let idx = 0; idx < records.length; idx += 1) {
    const rec = records[idx];
    if (!isPlainRecord(rec)) {
      continue;
    }
    let formatted = formatA2aRecord(code, ident, rec);
    if (idx === 0 && cacheHit) {
      const nlIdx = formatted.indexOf('\n');
      formatted =
        nlIdx === -1
          ? `${formatted} [cache]`
          : `${formatted.slice(0, nlIdx)} [cache]${formatted.slice(nlIdx)}`;
    }
    blocks.push(formatted);
  }

  const bytesOut = emitStdout(ctx.io, blocks.join('\n\n'));
  return { exitCode: 0, bytesOut, cacheHit };
}

async function runDirectScanDownload(
  ctx: RecordCommandContext,
  cacheDir: string,
  rawUrl: string,
  options: {
    readonly dest: string | undefined;
    readonly listOnly: boolean;
    readonly preview: boolean;
    readonly asJson: boolean;
    readonly cachePolicy: CachePolicyOptions;
  }
): Promise<RecordCommandOutcome> {
  const directUrl = validateScanUrl(rawUrl.trim());
  if (options.listOnly) {
    const rows = [{ index: 1, order: 1, label: '', url: directUrl }];
    if (options.asJson) {
      const bytesOut = emitJsonStdout(ctx.io, {
        url: directUrl,
        scans: rows,
        cache_hit: false,
      });
      return { exitCode: 0, bytesOut, cacheHit: false };
    }
    const bytesOut = emitStdout(ctx.io, `1. order=1\n   ${directUrl}`);
    return { exitCode: 0, bytesOut, cacheHit: false };
  }

  if (!options.dest) {
    throw new CliValidationError(
      'Pass --out FILE (or a positional output path) to download a direct scan URL.'
    );
  }

  const destPath = resolveUserPathFromContext(options.dest, ctx);
  if (!isExistingDir(destPath)) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
  }

  const candidates = buildDirectScanCandidates(directUrl, options.preview);
  const {
    body,
    ext,
    resolvedUrl,
    cacheHit: fileHit,
  } = await downloadScanCandidates(ctx, cacheDir, candidates, options.cachePolicy);

  const outFile = isExistingDir(destPath)
    ? path.join(destPath, `scan-${sha256Hex(resolvedUrl).slice(0, 8)}.${ext}`)
    : destPath;
  atomicWriteFileSync(outFile, body);

  const item = {
    index: 1,
    order: 1,
    label: '',
    url: resolvedUrl,
    path: outFile,
    bytes: body.length,
    cache_hit: fileHit,
  };
  if (options.asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      url: resolvedUrl,
      files: [item],
      cache_hit: Boolean(fileHit),
    });
    return { exitCode: 0, bytesOut, cacheHit: fileHit };
  }
  const marker = fileHit ? ' [cache]' : '';
  const bytesOut = emitStdout(ctx.io, `scan 1: ${item.path} (${item.bytes} bytes)${marker}`);
  return { exitCode: 0, bytesOut, cacheHit: fileHit };
}

export async function runDownload(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DOWNLOAD_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDownloadHelp()) };
  }

  const archive = parsed.positionals[0];
  let identifier: string | undefined = parsed.positionals[1];
  const scanIndex = getNumberOption(parsed, 'scanIndex') ?? 1;
  const downloadAll = getBooleanOption(parsed, 'downloadAll');
  const listOnly = getBooleanOption(parsed, 'listOnly');
  const preview = getBooleanOption(parsed, 'preview');
  let dest = getStringOption(parsed, 'dest');
  const asJson = getBooleanOption(parsed, 'asJson');
  const lang = getStringOption(parsed, 'lang') ?? 'nl';
  const refresh = getBooleanOption(parsed, 'refresh');
  const cliTtl = getNumberOption(parsed, 'cacheTtlHours');

  if (identifier && !dest && isCompleteRecordRef(archive)) {
    dest = identifier;
    identifier = undefined;
  }

  const cachePolicy: CachePolicyOptions = {
    refresh,
    ttlHours: resolveTtlHours(cliTtl, ctx),
  };
  const cacheDir = getCacheDir(ctx);

  if (!identifier && isDirectScanUrl(archive)) {
    return runDirectScanDownload(ctx, cacheDir, archive, {
      dest,
      listOnly,
      preview,
      asJson,
      cachePolicy,
    });
  }

  const [code, ident] = parseRecordRef(archive, identifier);
  const { data, cacheHit: showHit } = await loadShow(ctx, cacheDir, code, ident, lang, cachePolicy);
  const scans = extractScansFromShow(data);

  if (listOnly) {
    const rows = scans.map((scan) => ({
      index: scan.index,
      order: scan.order,
      label: scan.label,
      url: scan.chosenUrl(preview),
    }));
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, {
        archive: code,
        identifier: ident,
        scans: rows,
        cache_hit: Boolean(showHit),
      });
      return { exitCode: 0, bytesOut, cacheHit: showHit };
    }
    const marker = showHit ? ' [cache]' : '';
    const lines: string[] = [`Scans for ${code}:${ident} (${rows.length})${marker}`];
    if (rows.length === 0) {
      lines.push('No scans.');
    } else {
      for (const row of rows) {
        const orderStr = row.order === null ? '-' : String(row.order);
        const labelStr = row.label ? ` ${row.label}` : '';
        lines.push(`${row.index}. order=${orderStr}${labelStr}`);
        lines.push(`   ${row.url}`);
      }
    }
    const bytesOut = emitStdout(ctx.io, lines.join('\n'));
    return { exitCode: 0, bytesOut, cacheHit: showHit };
  }

  if (scans.length === 0) {
    throw new RecordRuntimeError(
      `No scans are available for ${code}:${ident}. The record has no a2a_SourceAvailableScans image URL.`
    );
  }
  if (!dest) {
    if (downloadAll) {
      throw new CliValidationError('Pass --out-dir DIR (or --out DIR) when using --all.');
    }
    throw new CliValidationError('Pass --out FILE for one scan, or --all --out-dir DIR for every scan.');
  }

  let selected: readonly ScanImage[] = scans;
  if (!downloadAll) {
    const match = scans.find((scan) => scan.index === scanIndex);
    if (!match) {
      throw new RecordRuntimeError(
        `Scan index ${scanIndex} is outside 1-${scans.length} for ${code}:${ident}.`
      );
    }
    selected = [match];
  }

  const destPath = resolveUserPathFromContext(dest, ctx);
  if (downloadAll) {
    if (pathExists(destPath) && !isExistingDir(destPath)) {
      throw new RecordRuntimeError(`--out-dir must be a directory. ${destPath} is a file.`);
    }
    fs.mkdirSync(destPath, { recursive: true });
  } else if (!isExistingDir(destPath)) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
  }

  const files: Array<{
    readonly index: number;
    readonly order: number | null;
    readonly label: string;
    readonly url: string;
    readonly path: string;
    readonly bytes: number;
    readonly cache_hit: boolean;
  }> = [];
  const fileHits: boolean[] = [];

  for (const scan of selected) {
    const candidates = scan.candidateUrls(preview);
    const {
      body,
      ext,
      resolvedUrl,
      cacheHit: fileHit,
    } = await downloadScanCandidates(ctx, cacheDir, candidates, cachePolicy);
    const filename = scanFilename(code, ident, scan.index, ext);
    const outFile = downloadAll || isExistingDir(destPath) ? path.join(destPath, filename) : destPath;
    atomicWriteFileSync(outFile, body);
    fileHits.push(fileHit);
    files.push({
      index: scan.index,
      order: scan.order,
      label: scan.label,
      url: resolvedUrl,
      path: outFile,
      bytes: body.length,
      cache_hit: fileHit,
    });
  }

  const overallHit = Boolean(showHit && fileHits.every(Boolean));
  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      archive: code,
      identifier: ident,
      files,
      cache_hit: overallHit,
    });
    return { exitCode: 0, bytesOut, cacheHit: overallHit };
  }

  const lines = files.map((item) => {
    const marker = item.cache_hit ? ' [cache]' : '';
    return `scan ${item.index}: ${item.path} (${item.bytes} bytes)${marker}`;
  });
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode: 0, bytesOut, cacheHit: overallHit };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const name = getStringOption(parsed, 'name');
  const place = getStringOption(parsed, 'place');
  const year = getStringOption(parsed, 'year');
  const record = getStringOption(parsed, 'record');

  if (record) {
    const [code, ident] = parseRecordRef(record, undefined);
    const bytesOut = emitStdout(ctx.io, `${WEB_BASE}/${code}:${ident}`);
    return { exitCode: 0, bytesOut };
  }
  if (!name) {
    throw new CliValidationError('Pass --name or --record.');
  }
  const q = year ? `${name.trim()} ${year.trim()}` : name.trim();
  const params = new URLSearchParams([['name', q]]);
  if (place) {
    params.append('eventplace', place.trim());
  }
  const bytesOut = emitStdout(ctx.io, `${WEB_BASE}/search.php?${params.toString()}`);
  return { exitCode: 0, bytesOut };
}
