import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { encodeUrlPathPreservingSlashes } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  PORTAL_ITEM_SPEC,
  PORTAL_SEARCH_SPEC,
  renderPortalItemHelp,
  renderPortalSearchHelp,
  renderTdaHelp,
  renderUrlHelp,
  TDA_SPEC,
  URL_SPEC,
} from './cliSpecs.js';
import {
  buildPortalQuery,
  entryMatchesFilters,
  GLO_LAND,
  normalizeArk,
  PORTAL_BASE,
  PORTAL_OPENSEARCH,
  parseIsoDate,
  TDA_BASE,
  type TexasOpenSearchEntry,
  TSLAC_HOME,
  TSLAC_RANGERS,
} from './domain.js';
import {
  cachedOpenSearchPage,
  cachedPortalItem,
  cachedTdaRss,
  getTexasArchivesCacheDir,
  resolveTexasArchivesTtl,
} from './transport.js';

export async function runPortalSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PORTAL_SEARCH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPortalSearchHelp()) };
  }

  const county = getStringOption(parsed, 'county');
  const rawDateFrom = getStringOption(parsed, 'dateFrom');
  const rawDateTo = getStringOption(parsed, 'dateTo');
  const dateFrom = rawDateFrom ? parseIsoDate(rawDateFrom, '--date-from') : undefined;
  const dateTo = rawDateTo ? parseIsoDate(rawDateTo, '--date-to') : undefined;
  const typeFilter = getStringOption(parsed, 'typeFilter');
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const pages = getNumberOption(parsed, 'pages') ?? 3;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTexasArchivesTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getTexasArchivesCacheDir(ctx);

  const q = buildPortalQuery(parsed.positionals.join(' '), county);
  const matched: TexasOpenSearchEntry[] = [];
  let totalReported = 0;
  const pageHits: boolean[] = [];

  for (let page = 1; page <= pages; page += 1) {
    if (matched.length >= limit) {
      break;
    }
    const { value: batch, cacheHit } = await cachedOpenSearchPage(ctx, cacheDir, q, page, ttlHours, refresh);
    pageHits.push(cacheHit);
    totalReported = batch.total;
    if (batch.entries.length === 0 && page > 1) {
      break;
    }
    for (const entry of batch.entries) {
      if (entryMatchesFilters({ ...entry, subjects: [] }, county, typeFilter, dateFrom, dateTo)) {
        matched.push(entry);
      }
      if (matched.length >= limit) {
        break;
      }
    }
  }

  const allCached = pageHits.length > 0 && pageHits.every(Boolean);
  const searchUrl = `${PORTAL_BASE}/search/?${new URLSearchParams({ q, t: 'fulltext' }).toString()}`;
  const payload = {
    query: q,
    opensearch_total: totalReported,
    returned: matched.length,
    records: matched,
    search_url: searchUrl,
    note: 'HTML search requires a browser (ALTCHA). Filters apply to OpenSearch fields only.',
    cache_hit: allCached,
  };

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, payload, 1),
      cacheHit: allCached,
    };
  }

  const marker = allCached ? ' [cache]' : '';
  const lines: string[] = [
    `${totalReported} OpenSearch hit(s) for '${q}'; showing ${matched.length} after filters:${marker}`,
    `${searchUrl}  (browser)`,
  ];
  for (const rec of matched) {
    lines.push(rec.title || '(no title)');
    lines.push(`  ${rec.date || ''}  [${rec.type || ''}]  ${rec.creator || ''}`.trimEnd());
    lines.push(`  ${rec.ark}  ${rec.url}`);
    lines.push('');
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit: allCached };
}

export async function runPortalItem(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PORTAL_ITEM_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPortalItemHelp()) };
  }

  const ark = normalizeArk(parsed.positionals[0]);
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTexasArchivesTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getTexasArchivesCacheDir(ctx);

  const { value: data, cacheHit } = await cachedPortalItem(ctx, cacheDir, ark, ttlHours, refresh);

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...data, cache_hit: cacheHit }, 1),
      cacheHit,
    };
  }

  const title = data.titles[0] ?? '(no title)';
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${title}${marker}`, `  ${data.ark}`];
  if (data.creators.length > 0) {
    lines.push(`  Creator(s): ${data.creators.slice(0, 6).join('; ')}`);
  }
  if (data.dates.length > 0) {
    lines.push(`  Date(s): ${data.dates.slice(0, 6).join('; ')}`);
  }
  if (data.types.length > 0) {
    lines.push(`  Type(s): ${data.types.join(', ')}`);
  }
  if (data.subjects.length > 0) {
    lines.push(`  Subject(s): ${data.subjects.slice(0, 8).join('; ')}`);
  }
  lines.push(`  ${data.url}`);
  if (data.browser_note) {
    lines.push(`  ${data.browser_note}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runTda(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TDA_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderTdaHelp()) };
  }

  const query = parsed.positionals[0];
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTexasArchivesTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getTexasArchivesCacheDir(ctx);

  const { value: data, cacheHit } = await cachedTdaRss(ctx, cacheDir, query, ttlHours, refresh);

  const results = data.results.slice(0, limit);
  const quoted = encodeUrlPathPreservingSlashes(query);
  const payload = {
    search_url: `${TDA_BASE}/?s=${quoted}`,
    feed_url: `${TDA_BASE}/search/${quoted}/feed/rss2/`,
    returned: results.length,
    results,
    cache_hit: cacheHit,
  };

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, payload, 1),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`TDA search: ${payload.search_url}${marker}`];
  if (results.length === 0) {
    lines.push('No results in the RSS feed (feed returns at most ~25 items per query).');
  } else {
    for (const item of results) {
      lines.push(`- ${item.title}`);
      lines.push(`  ${item.url}`);
    }
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const portal = getBooleanOption(parsed, 'portal');
  const tda = getBooleanOption(parsed, 'tda');
  const glo = getBooleanOption(parsed, 'glo');
  const rangers = getBooleanOption(parsed, 'rangers');
  const tslac = getBooleanOption(parsed, 'tslac');
  const showAll = !(portal || tda || glo || rangers || tslac);
  const q = parsed.positionals[0] || 'Houston';

  const lines: string[] = [];
  if (portal || showAll) {
    lines.push(
      'Portal to Texas History (browser; ALTCHA on HTML):',
      `  ${PORTAL_BASE}/search/?${new URLSearchParams({ q, t: 'fulltext' }).toString()}`,
      'Portal OpenSearch JSON (CLI uses this):',
      `  ${PORTAL_OPENSEARCH}?${new URLSearchParams({ q, format: 'json' }).toString()}`
    );
  }
  if (tda || showAll) {
    lines.push('Texas Digital Archive:', `  ${TDA_BASE}/?s=${encodeUrlPathPreservingSlashes(q)}`);
  }
  if (glo || showAll) {
    lines.push(
      'Texas General Land Office Land Grant Search (browser-only; SPA):',
      `  ${GLO_LAND}`,
      '  Texas was not a public-land state; state grants are indexed here, not BLM GLO patents.'
    );
  }
  if (rangers || showAll) {
    lines.push(
      'TSLAC Texas Rangers:',
      `  ${TSLAC_RANGERS}`,
      '  Ranger muster rolls: open records request or in-person at TSLAC.'
    );
  }
  if (tslac || showAll) {
    lines.push('Texas State Library and Archives Commission:', `  ${TSLAC_HOME}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}
