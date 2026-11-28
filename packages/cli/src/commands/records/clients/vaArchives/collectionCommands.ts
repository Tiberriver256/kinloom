import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import {
  atomicCopyFileSync,
  encodeUrlPathPreservingSlashes,
  isPlainRecord,
  resolveUserPathFromContext,
} from '../../runtime/primitives.js';
import {
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  CATALOG_SPEC,
  DUNMORE_SPEC,
  GRANT_TIF_SPEC,
  ROSETTA_SPEC,
  renderCatalogHelp,
  renderDunmoreHelp,
  renderGrantTifHelp,
  renderRosettaHelp,
  renderUrlHelp,
  URL_SPEC,
} from './cliSpecs.js';
import {
  CHANCERY_BASE,
  CHANCERY_DETAIL,
  DUNMORE_CGI,
  type DunmoreImage,
  extForContentType,
  LVA_IMAGE_HOST,
  normalizeLvaImageUrl,
  PRIMO_BASE,
  PRIMO_PNXS,
  PRIMO_VID,
  validateFlId,
  validateIeId,
} from './domain.js';
import { mapPnxsRecord, parseDunmoreDrawer } from './parsers.js';
import {
  downloadRosettaFile,
  emitTrackedJson,
  fetchFile,
  fetchText,
  isCacheMetaValid,
  makeState,
  resolveRosetta,
  saveImage,
  warmRosettaSession,
} from './transport.js';

export async function runCatalog(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CATALOG_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCatalogHelp()) };
  }

  const query = parsed.positionals[0];
  const field = getStringOption(parsed, 'field') ?? 'any';
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const rawText = await fetchText(state, PRIMO_PNXS, {
    params: {
      q: `${field},contains,${query}`,
      vid: PRIMO_VID,
      scope: 'MyInstitution',
      lang: 'en',
      limit: String(limit),
      offset: String(offset),
    },
    allowedHosts: ['lva.primo.exlibrisgroup.com'],
  });
  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Invalid Primo PNXS JSON: ${message}`);
  }
  const obj = isPlainRecord(data) ? data : {};
  const info = isPlainRecord(obj['info']) ? obj['info'] : {};
  const docs = Array.isArray(obj['docs']) ? obj['docs'] : [];
  const records = docs.map((d) => mapPnxsRecord(d));

  if (asJson) {
    return emitTrackedJson(state, {
      total: info['total'] ?? null,
      first: info['first'] ?? null,
      last: info['last'] ?? null,
      records,
    });
  }

  const lines: string[] = [
    `${String(info['total'] ?? 0)} result(s); showing ${String(info['first'] ?? 0)}-${String(info['last'] ?? 0)}:`,
  ];
  for (const rec of records) {
    lines.push(rec.title || '(no title)');
    lines.push(`  ${rec.creator} ${rec.date} [${rec.type}]`.trimEnd());
    lines.push(`  ${rec.record_url}`);
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const chanceryCase = getStringOption(parsed, 'chanceryCase');
  const catalogQuery = getStringOption(parsed, 'catalogQuery');
  const chronicle = getBooleanOption(parsed, 'chronicle');
  const land = getBooleanOption(parsed, 'land');
  const arvas = getBooleanOption(parsed, 'arvas');
  const chancery = getBooleanOption(parsed, 'chancery');

  const lines: string[] = [];
  if (chanceryCase) {
    lines.push(`${CHANCERY_DETAIL}?CFN=${chanceryCase}`);
  }
  if (catalogQuery) {
    lines.push(
      `${PRIMO_BASE}/discovery/search?vid=${encodeURIComponent(PRIMO_VID)}&query=any,contains,${encodeUrlPathPreservingSlashes(catalogQuery)}&lang=en`
    );
  }
  if (chancery) {
    lines.push('https://www.lva.virginia.gov/collections/chancery', `${CHANCERY_BASE}/`);
  }
  if (chronicle) {
    lines.push(
      'https://www.virginiachronicle.com/  (free; search in the browser -- Cloudflare blocks curl/headless Chromium, verified 2026-11-24)'
    );
  }
  if (land) {
    lines.push(
      'https://lva-virginia.libguides.com/land-grants',
      'https://image.lva.virginia.gov/LONN/LO.html  (Virginia Land Office Patents and Grants Index, browse by volume)'
    );
  }
  if (arvas) {
    lines.push(
      'https://arvasarchive.org/  (browser-only; plain HTTP returns an empty 202, verified 2026-11-24)'
    );
  }
  if (lines.length === 0) {
    lines.push(
      'https://www.lva.virginia.gov/collections',
      'https://www.lva.virginia.gov/collections/digital-collections'
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

export async function runGrantTif(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean,
  commandName: 'grant-tif' | 'lva-tif'
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GRANT_TIF_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderGrantTifHelp(commandName)) };
  }

  let url: string;
  try {
    url = normalizeLvaImageUrl(parsed.positionals[0] ?? '');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(message);
  }

  const outOpt = getStringOption(parsed, 'out');
  const outPath = outOpt ? resolveUserPathFromContext(outOpt, ctx) : undefined;
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const cachedPath = await fetchFile(state, url, [LVA_IMAGE_HOST]);
  const result: Record<string, unknown> = {
    url,
    cache_path: cachedPath,
    bytes: fs.statSync(cachedPath).size,
  };

  if (outPath) {
    const mode = await saveImage(cachedPath, outPath);
    result['out'] = outPath;
    result['mode'] = mode;
  }

  if (asJson) {
    return emitTrackedJson(state, result);
  }

  const text = outPath
    ? `saved ${String(result['out'])} (${String(result['mode'])}) from ${url}`
    : `cached ${url} -> ${cachedPath} (${String(result['bytes'])} bytes); pass --out FILE to save it`;
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, text),
    cacheHit: state.tracker.allHits(),
  };
}

export async function runDunmore(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, DUNMORE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderDunmoreHelp()) };
  }

  const [drawer = '', card = ''] = parsed.positionals;
  if (!/^\d{1,5}\/W\d{1,6}$/.test(drawer)) {
    throw new CliValidationError(`Invalid drawer (expected e.g. 0001/W0001): ${JSON.stringify(drawer)}`);
  }
  if (!/^\d{1,6}$/.test(card)) {
    throw new CliValidationError(`Invalid card number: ${JSON.stringify(card)}`);
  }

  const pageNo = getNumberOption(parsed, 'pageNo');
  const outOpt = getStringOption(parsed, 'out');
  const outPath = outOpt ? resolveUserPathFromContext(outOpt, ctx) : undefined;
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const html = await fetchText(state, DUNMORE_CGI, {
    params: { dir: drawer, card },
    allowedHosts: [LVA_IMAGE_HOST],
  });
  const drawerParsed = parseDunmoreDrawer(html);
  if (drawerParsed.images.length === 0) {
    throw new RecordRuntimeError("No page images found on the Dunmore's War drawer page.");
  }

  let chosen: DunmoreImage | undefined;
  if (pageNo !== undefined) {
    chosen = drawerParsed.images.find((im) => im.page === pageNo);
    if (!chosen) {
      throw new RecordRuntimeError(`Page ${pageNo} is not listed for this card.`);
    }
  } else {
    chosen = drawerParsed.images.find((im) => im.current) ?? drawerParsed.images[0];
  }

  const result: Record<string, unknown> = {
    ...drawerParsed,
    drawer,
    card,
    source_url: `${DUNMORE_CGI}?dir=${drawer}&card=${card}`,
    selected: chosen,
  };

  if (outPath && chosen) {
    const cachedPath = await fetchFile(state, chosen.url, [LVA_IMAGE_HOST]);
    const mode = await saveImage(cachedPath, outPath);
    result['out'] = outPath;
    result['mode'] = mode;
  }

  if (asJson) {
    return emitTrackedJson(state, result);
  }

  const lines: string[] = [
    `Dunmore's War drawer ${drawer} card ${card}: page ${String(drawerParsed.current_page ?? 'unknown')}`,
  ];
  for (const im of drawerParsed.images) {
    const mark = im === chosen ? '*' : ' ';
    lines.push(` ${mark} page ${String(im.page ?? '?')}: ${im.url}`);
  }
  if (outPath) {
    lines.push(`saved ${String(result['out'])} (${String(result['mode'])})`);
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

export async function runDownloadRosetta(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, ROSETTA_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRosettaHelp()) };
  }

  const ie = validateIeId(parsed.positionals[0] ?? '');
  const rawFl = getStringOption(parsed, 'flId');
  const flId = rawFl !== undefined ? validateFlId(rawFl) : undefined;
  const fileIndex = getNumberOption(parsed, 'fileIndex');
  const listOnly = getBooleanOption(parsed, 'listOnly');
  const outOpt = getStringOption(parsed, 'out');
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const info = await resolveRosetta(state, ie);
  const files = info.files;

  if (listOnly) {
    if (asJson) {
      const { session: _session, ...withoutSession } = info;
      return emitTrackedJson(state, withoutSession);
    }
    const lines = files.map((f, idx) => {
      const star = f.fl === info.initial ? '*' : ' ';
      return ` ${star} ${idx + 1}. ${f.fl}  ${f.title}`;
    });
    return {
      exitCode: 0,
      bytesOut: emitStdout(ctx.io, lines.join('\n')),
      cacheHit: state.tracker.allHits(),
    };
  }

  let fl: string;
  if (flId !== undefined) {
    if (!files.some((f) => f.fl === flId)) {
      throw new RecordRuntimeError(`${flId} is not a file of ${ie}; see --list.`);
    }
    fl = flId;
  } else if (fileIndex !== undefined) {
    if (fileIndex < 1 || fileIndex > files.length) {
      throw new CliValidationError(`--file must be 1..${files.length}`);
    }
    fl = files[fileIndex - 1]?.fl ?? '';
  } else {
    fl = info.initial ?? files[0]?.fl ?? '';
  }

  const expectedBinPath = path.join(state.cacheRoot, 'rosetta', ie, `${fl}.bin`);
  const binAlreadyCached = !state.refresh && isCacheMetaValid(expectedBinPath, null, ctx.nowMs) !== undefined;
  if (!info.session && !binAlreadyCached) {
    await warmRosettaSession(state, ie);
  }

  const { path: cachedPath, meta } = await downloadRosettaFile(state, ie, fl);
  const destPath = outOpt
    ? resolveUserPathFromContext(outOpt, ctx)
    : path.resolve(ctx.cwd, `${ie}_${fl}${extForContentType(meta.content_type)}`);
  atomicCopyFileSync(cachedPath, destPath);
  const bytes = fs.statSync(destPath).size;

  const result: Record<string, unknown> = {
    ie,
    fl,
    content_type: meta.content_type,
    out: destPath,
    bytes,
    cache_path: cachedPath,
  };

  if (asJson) {
    return emitTrackedJson(state, result);
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, `saved ${destPath} (${bytes} bytes, ${meta.content_type}) from ${ie}/${fl}`),
    cacheHit: state.tracker.allHits(),
  };
}
