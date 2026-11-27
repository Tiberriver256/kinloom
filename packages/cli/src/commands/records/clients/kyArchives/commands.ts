import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { cachedJsonCall } from '../../runtime/cache.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  CDM_ITEM_SPEC,
  CDM_SPEC,
  COLLECTIONS_SPEC,
  LAND_PATENT_SPEC,
  LAND_SPEC,
  PRESERVICA_SPEC,
  renderCdmHelp,
  renderCdmItemHelp,
  renderCdmUrlHelp,
  renderCollectionsHelp,
  renderLandHelp,
  renderLandPatentHelp,
  renderPreservicaHelp,
  renderUrlsHelp,
  SINGLE_QUERY_SPEC,
} from './cliSpecs.js';
import {
  buildCdmWebUrl,
  buildKyUrlsLines,
  CACHE_SCHEMA,
  CDM_BASE,
  type CdmSearchPayload,
  getKyCacheDir,
  isCdmSearchPayload,
  isKyLandPayload,
  isKyPreservicaPayload,
  type KyLandPayload,
  type KyPreservicaPayload,
  resolveKyTtl,
} from './domain.js';
import {
  fetchCdm,
  fetchCdmItem,
  fetchCollections,
  fetchLand,
  fetchLandPatent,
  fetchPreservica,
} from './transport.js';

function emitLandResults(
  ctx: RecordCommandContext,
  data: KyLandPayload,
  asJson: boolean,
  cacheHit: boolean
): RecordCommandOutcome {
  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        totalResults: data.totalResults,
        results: data.results,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${data.totalResults} patent(s) found${marker}`];
  for (const r of data.results) {
    lines.push(
      `- Patent #${r.patent}: ${r.grantee} (${r.county} Co., grant ${r.grant_date}, survey ${r.survey_date}, ${r.acreage} acres)`
    );
    lines.push(
      `  Grant Book & Pg: ${r.grant_book_page}; watercourse: ${r.watercourse}; survey name: ${r.survey_name}`
    );
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit,
  };
}

export async function runCdm(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, CDM_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCdmHelp()) };
  }
  const query = parsed.positionals[0];
  const alias = getStringOption(parsed, 'alias') ?? 'all';
  const field = getStringOption(parsed, 'field') ?? 'all';
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveKyTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const { value: data, cacheHit } = await cachedJsonCall<CdmSearchPayload>({
    cacheDir: getKyCacheDir(ctx),
    kind: 'cdm',
    payload: { query, alias, field, limit },
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: () => fetchCdm(ctx, query, alias, field, limit),
    cacheable: (r) => r.verified,
    validateCached: isCdmSearchPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        totalResults: data.totalResults,
        items: data.items,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${data.totalResults} result(s) for '${query}' in KHS Digital Collections${marker}`,
  ];
  for (const it of data.items) {
    const dateVal = typeof it.fields.date === 'string' ? it.fields.date : '';
    const dateSuffix = dateVal ? ` (${dateVal})` : '';
    lines.push(
      `- [${String(it.collectionAlias ?? '')}:${String(it.itemId ?? '')}] ${String(it.title ?? '')}${dateSuffix}`
    );
    lines.push(`  ${CDM_BASE}/digital${String(it.itemLink ?? '')}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runCdmItem(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, CDM_ITEM_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCdmItemHelp()) };
  }
  const [alias, itemId] = parsed.positionals;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveKyTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const { value: data, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
    cacheDir: getKyCacheDir(ctx),
    kind: 'cdm-item',
    payload: { alias, item_id: itemId },
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: () => fetchCdmItem(ctx, alias, itemId),
    cacheable: (r) =>
      (Array.isArray(r.fields) && r.fields.length > 0) || Boolean(r.title) || Boolean(r.contentType),
    validateCached: isPlainRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...data, cache_hit: cacheHit }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${CDM_BASE}/digital/singleitem/collection/${alias}/id/${itemId}${marker}`];
  if (Array.isArray(data.fields)) {
    for (const rawField of data.fields) {
      if (!isPlainRecord(rawField)) {
        continue;
      }
      const label = String(rawField.label ?? rawField.key ?? '');
      lines.push(`${label}: ${String(rawField.value ?? '')}`);
    }
  }
  if (data.contentType) {
    lines.push(`Content-Type: ${String(data.contentType)}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runCollections(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, COLLECTIONS_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCollectionsHelp()) };
  }
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveKyTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const { value: data, cacheHit } = await cachedJsonCall<Record<string, unknown>>({
    cacheDir: getKyCacheDir(ctx),
    kind: 'collections',
    payload: {},
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: () => fetchCollections(ctx),
    cacheable: (r) => Array.isArray(r.cards) && r.cards.length > 0,
    validateCached: isPlainRecord,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  const cards = Array.isArray(data.cards) ? data.cards : [];
  const totalCollections = typeof data.totalCollections === 'number' ? data.totalCollections : cards.length;

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        totalCollections,
        cards,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${totalCollections} collections${marker}`];
  for (const card of cards) {
    if (isPlainRecord(card)) {
      lines.push(`- ${String(card.alias ?? '')}: ${String(card.title ?? '')}`);
    }
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export function runCdmUrl(rest: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(rest, SINGLE_QUERY_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCdmUrlHelp()) };
  }
  const query = parsed.positionals[0];
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, buildCdmWebUrl(query)),
  };
}

export async function runLand(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, LAND_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderLandHelp()) };
  }
  const term = parsed.positionals[0];
  const by = getStringOption(parsed, 'by') ?? 'grantee';
  const limit = getStringOption(parsed, 'limit') ?? '10';
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveKyTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const { value: data, cacheHit } = await cachedJsonCall<KyLandPayload>({
    cacheDir: getKyCacheDir(ctx),
    kind: 'land',
    payload: { term, by, limit },
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: () => fetchLand(ctx, term, by, limit),
    cacheable: (r) => r.verified,
    validateCached: isKyLandPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return emitLandResults(ctx, data, asJson, cacheHit);
}

export async function runLandPatent(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, LAND_PATENT_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderLandPatentHelp()) };
  }
  const number = parsed.positionals[0];
  const book = getStringOption(parsed, 'book');
  const page = getStringOption(parsed, 'page');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveKyTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const { value: data, cacheHit } = await cachedJsonCall<KyLandPayload>({
    cacheDir: getKyCacheDir(ctx),
    kind: 'land-patent',
    payload: { number, book: book ?? '', page: page ?? '' },
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: () => fetchLandPatent(ctx, number, book, page),
    cacheable: (r) => r.verified,
    validateCached: isKyLandPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return emitLandResults(ctx, data, asJson, cacheHit);
}

export async function runPreservica(
  rest: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(rest, PRESERVICA_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPreservicaHelp()) };
  }
  const query = parsed.positionals[0];
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveKyTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const { value: data, cacheHit } = await cachedJsonCall<KyPreservicaPayload>({
    cacheDir: getKyCacheDir(ctx),
    kind: 'preservica',
    payload: { query, limit },
    ttlHours,
    refresh,
    schema: CACHE_SCHEMA,
    fetch: () => fetchPreservica(ctx, query, limit),
    cacheable: (r) => r.verified,
    validateCached: isKyPreservicaPayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        search_url: data.search_url,
        feed_url: data.feed_url,
        results: data.results,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`KDLA Preservica search: ${data.search_url}${marker}`];
  if (data.results.length === 0) {
    lines.push('No results in the search feed.');
  } else {
    for (const item of data.results) {
      lines.push(`- ${item.title}`);
      lines.push(`  ${item.url}`);
    }
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export function runUrls(rest: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(rest, SINGLE_QUERY_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlsHelp()) };
  }
  const query = parsed.positionals[0];
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, buildKyUrlsLines(query).join('\n')) };
}
