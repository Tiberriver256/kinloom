import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { launchOptionalChromium } from '../../runtime/browser.js';
import { cachedJsonCall, cacheKeyFor, readSchemaCacheEntry } from '../../runtime/cache.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  GET_SPEC,
  renderGetHelp,
  renderSearchHelp,
  renderUrlHelp,
  SEARCH_SPEC,
  URL_SPEC,
} from './cliSpecs.js';
import {
  ALL_SOURCES,
  buildUrl,
  CACHE_SCHEMA,
  type CaArchivesOverrides,
  type CaExhibitsItem,
  type CaPortalItem,
  type CaSearchableSource,
  type CaSource,
  type CaSourceEntry,
  type CaSourceOutput,
  DEFAULT_SEARCH_TIMEOUT_SEC,
  exhibitsUrl,
  formatSourceText,
  getCacheDir,
  isCaExhibitsItem,
  isCaPortalItem,
  isCaSourceEntry,
  isSourceCacheable,
  isTimeoutFailure,
  makeTimedOutEntry,
  portalUrl,
  resolveTtl,
  SEARCHABLE_SOURCES,
} from './domain.js';
import {
  browserSearch,
  fetchExhibitsItem,
  fetchPortalItem,
  searchExhibits,
  searchPortal,
  writeSchemaCacheEntry,
} from './transport.js';

export async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext,
  overrides: CaArchivesOverrides = {}
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }

  const q = parsed.positionals.join(' ');
  const selectedSources = getStringListOption(parsed, 'sources') as readonly CaSearchableSource[];
  const wanted: readonly CaSearchableSource[] =
    selectedSources.length > 0 ? selectedSources : SEARCHABLE_SOURCES;
  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? DEFAULT_SEARCH_TIMEOUT_SEC;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new CliValidationError(`Invalid --timeout value: ${String(timeoutSec)} (must be > 0).`);
  }
  const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getCacheDir(ctx);
  const payload = { query: q, limit };

  const out: Partial<Record<CaSearchableSource, CaSourceOutput>> = {};
  const browserSources = wanted.filter(
    (src): src is 'oac' | 'calisphere' => src === 'oac' || src === 'calisphere'
  );
  const uncachedBrowser: ('oac' | 'calisphere')[] = [];

  for (const src of browserSources) {
    if (!refresh) {
      const key = cacheKeyFor(`search:${src}`, payload);
      const entryPath = path.join(cacheDir, `${key}.json`);
      const hit = readSchemaCacheEntry<CaSourceEntry>(
        entryPath,
        ttlHours,
        CACHE_SCHEMA,
        ctx.nowMs,
        isCaSourceEntry
      );
      if (hit !== undefined) {
        out[src] = { ...hit, cache_hit: true };
        continue;
      }
    }
    uncachedBrowser.push(src);
  }

  if (uncachedBrowser.length > 0) {
    const fetched = await browserSearch(
      ctx,
      uncachedBrowser,
      q,
      limit,
      timeoutMs,
      overrides.launcher ?? launchOptionalChromium,
      {
        closeTimeoutMs: overrides.closeTimeoutMs,
        killGraceMs: overrides.killGraceMs,
      }
    );
    for (const src of uncachedBrowser) {
      const entry = fetched[src];
      if (!entry) {
        continue;
      }
      if (isSourceCacheable(entry)) {
        await writeSchemaCacheEntry(ctx, cacheDir, `search:${src}`, payload, entry);
      }
      out[src] = { ...entry, cache_hit: false };
    }
  }

  if (wanted.includes('portal')) {
    try {
      const { value, cacheHit } = await cachedJsonCall<CaSourceEntry>({
        cacheDir,
        kind: 'search:portal',
        payload,
        ttlHours,
        refresh,
        schema: CACHE_SCHEMA,
        fetch: () => searchPortal(ctx, q, limit, timeoutMs),
        cacheable: isSourceCacheable,
        validateCached: isCaSourceEntry,
        nowMs: ctx.nowMs,
        sleepFn: ctx.sleepFn,
      });
      out.portal = { ...value, cache_hit: cacheHit };
    } catch (err: unknown) {
      if (isTimeoutFailure(err) && wanted.length > 1) {
        const message = err instanceof Error ? err.message : String(err);
        out.portal = { ...makeTimedOutEntry('portal', portalUrl(q), message), cache_hit: false };
      } else {
        throw err;
      }
    }
  }

  if (wanted.includes('exhibits')) {
    try {
      const { value, cacheHit } = await cachedJsonCall<CaSourceEntry>({
        cacheDir,
        kind: 'search:exhibits',
        payload,
        ttlHours,
        refresh,
        schema: CACHE_SCHEMA,
        fetch: () => searchExhibits(ctx, q, limit, timeoutMs),
        cacheable: isSourceCacheable,
        validateCached: isCaSourceEntry,
        nowMs: ctx.nowMs,
        sleepFn: ctx.sleepFn,
      });
      out.exhibits = { ...value, cache_hit: cacheHit };
    } catch (err: unknown) {
      if (isTimeoutFailure(err) && wanted.length > 1) {
        const message = err instanceof Error ? err.message : String(err);
        out.exhibits = { ...makeTimedOutEntry('exhibits', exhibitsUrl(q, limit), message), cache_hit: false };
      } else {
        throw err;
      }
    }
  }

  const ordered: CaSourceOutput[] = [];
  for (const src of wanted) {
    const entry = out[src];
    if (entry) {
      ordered.push(entry);
    }
  }
  const timedOutSources = ordered.filter((entry) => entry.timed_out === true).map((entry) => entry.source);
  for (const entry of ordered) {
    if (entry.timed_out && entry.error) {
      ctx.io.stderr(`Warning: ${entry.source} timed out: ${entry.error}`);
    }
  }
  const allTimedOut = ordered.length > 0 && timedOutSources.length === ordered.length;
  const allCached = ordered.length > 0 && ordered.every((entry) => entry.cache_hit);
  const exitCode = allTimedOut ? 1 : 0;

  if (asJson) {
    const jsonPayload =
      timedOutSources.length > 0
        ? { query: q, cache_hit: allCached, timed_out_sources: timedOutSources, sources: ordered }
        : { query: q, cache_hit: allCached, sources: ordered };
    return {
      exitCode,
      bytesOut: emitJsonStdout(ctx.io, jsonPayload),
      cacheHit: allCached,
    };
  }

  const lines: string[] = [];
  for (const entry of ordered) {
    lines.push(...formatSourceText(entry), '');
  }
  return {
    exitCode,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: allCached,
  };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const q = parsed.positionals.join(' ');
  const selected = getStringListOption(parsed, 'sources') as readonly CaSource[];
  const wanted: readonly CaSource[] = selected.length > 0 ? selected : ALL_SOURCES;

  const lines = wanted.map((src) => `${src}: ${buildUrl(src, q)}`);
  if (wanted.includes('cdnc')) {
    lines.push('note: CDNC is behind a Cloudflare challenge; open the URL in a browser.');
  }
  if (wanted.includes('minerva')) {
    lines.push('note: Minerva is a catalog you search in the browser; this is its launch URL.');
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
  };
}

export async function runGet(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderGetHelp()) };
  }

  const portalId = getStringOption(parsed, 'portalId');
  const exhibitsId = getStringOption(parsed, 'exhibitsId');
  if (Boolean(portalId) === Boolean(exhibitsId)) {
    throw new CliValidationError('Pass exactly one of --portal ID or --exhibits ID.');
  }

  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const cacheDir = getCacheDir(ctx);

  let data: CaPortalItem | CaExhibitsItem;
  let cacheHit: boolean;

  if (portalId) {
    const res = await cachedJsonCall<CaPortalItem>({
      cacheDir,
      kind: 'get:portal',
      payload: { id: portalId },
      ttlHours,
      refresh,
      schema: CACHE_SCHEMA,
      fetch: () => fetchPortalItem(ctx, portalId),
      cacheable: (r) => Boolean(r.title && r.title !== '(no title)'),
      validateCached: isCaPortalItem,
      nowMs: ctx.nowMs,
      sleepFn: ctx.sleepFn,
    });
    data = res.value;
    cacheHit = res.cacheHit;
  } else {
    const targetId = exhibitsId ?? '';
    const res = await cachedJsonCall<CaExhibitsItem>({
      cacheDir,
      kind: 'get:exhibits',
      payload: { id: targetId },
      ttlHours,
      refresh,
      schema: CACHE_SCHEMA,
      fetch: () => fetchExhibitsItem(ctx, targetId),
      cacheable: (r) => Boolean(r.id),
      validateCached: isCaExhibitsItem,
      nowMs: ctx.nowMs,
      sleepFn: ctx.sleepFn,
    });
    data = res.value;
    cacheHit = res.cacheHit;
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...data, cache_hit: cacheHit }),
      cacheHit,
    };
  }

  const lines: string[] = [];
  let first = true;
  for (const [key, val] of Object.entries(data)) {
    if (val) {
      const suffix = first && cacheHit ? ' [cache]' : '';
      lines.push(`${key}: ${String(val)}${suffix}`);
      first = false;
    }
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit,
  };
}
