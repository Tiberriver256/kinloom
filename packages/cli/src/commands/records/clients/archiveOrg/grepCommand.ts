import fs from 'node:fs';
import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { runWithConcurrency } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { GREP_OPTIONS, GREP_PARSE_SPEC } from './cliSpecs.js';
import { emptyPageIndex, ensureItemCache, readPageIndex } from './itemCache.js';
import { grepCachedItem } from './pageAndGrep.js';
import { getCacheRoot } from './transport.js';
import {
  DEFAULT_TIMEOUT_SECONDS,
  type GrepHit,
  type ItemCacheEntry,
  jsonWithCacheHit,
  looksLikeIdentifierToken,
  MAX_WORKERS,
  validateIdentifier,
  validatePositiveTimeout,
} from './types.js';

export async function runGrep(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const t0 = ctx.nowMs();
  const parsed = parseCommandArgs(argv, GREP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom ia grep [IDENTIFIERS...] [options]',
          summary: 'Search cached full-text OCR inside one or more items with exact page mapping.',
          options: GREP_OPTIONS,
        })
      ),
    };
  }

  const contextChars = getNumberOption(parsed, 'context') ?? 240;
  const limit = getNumberOption(parsed, 'limit') ?? 25;
  const timeout = validatePositiveTimeout(getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_SECONDS);
  if (contextChars < 0) {
    throw new CliValidationError(`--context must be >= 0, got ${contextChars}.`);
  }
  if (limit < 0) {
    throw new CliValidationError(`--limit must be >= 0, got ${limit}.`);
  }

  let rawPatterns = [...getStringListOption(parsed, 'patterns')];
  let rawItems = [...getStringListOption(parsed, 'itemFlags')].filter((item) => item.length > 0);
  let posArgs = parsed.positionals.filter((tok) => tok.length > 0);

  if (rawPatterns.length === 0) {
    if (rawItems.length > 0 && posArgs.length === 1) {
      rawPatterns = [posArgs[0]];
      posArgs = [];
    } else if (rawItems.length === 0 && posArgs.length === 2) {
      const firstIsId = looksLikeIdentifierToken(posArgs[0]);
      const secondIsId = looksLikeIdentifierToken(posArgs[1]);
      if (firstIsId && !secondIsId) {
        rawItems = [posArgs[0]];
        rawPatterns = [posArgs[1]];
        posArgs = [];
      } else if (secondIsId && !firstIsId) {
        rawPatterns = [posArgs[0]];
        rawItems = [posArgs[1]];
        posArgs = [];
      }
    }
    if (rawPatterns.length === 0) {
      throw new CliValidationError(
        "Pass --pattern <regex> (or -e / -q <regex>) and at least one item identifier. Example: archive-org grep <item_id> -e '<regex>'."
      );
    }
  }

  rawItems.push(...posArgs);
  if (rawItems.length === 0) {
    throw new CliValidationError(
      'Pass at least one Internet Archive item identifier (positional or --item/--id).'
    );
  }

  const pattern = rawPatterns.length === 1 ? rawPatterns[0] : rawPatterns.map((p) => `(?:${p})`).join('|');
  const ignoreCase = getBooleanOption(parsed, 'ignoreCase');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');

  try {
    // Validate regex syntax up front before any network calls.
    void new RegExp(pattern, ignoreCase ? 'gi' : 'g');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid regex pattern '${pattern}': ${msg}`);
  }

  const seenIds = new Set<string>();
  const identifiers: string[] = [];
  for (const rawItem of rawItems) {
    const itemId = validateIdentifier(rawItem);
    if (!seenIds.has(itemId)) {
      seenIds.add(itemId);
      identifiers.push(itemId);
    }
  }

  const cacheRoot = getCacheRoot(ctx);
  const cacheEntries: ItemCacheEntry[] = [];
  const itemErrors: { readonly identifier: string; readonly error: string }[] = [];

  if (identifiers.length === 1) {
    const entry = await ensureItemCache(identifiers[0], ctx, {
      needDjvu: true,
      cacheRoot,
      timeout,
      refresh,
    });
    cacheEntries.push(entry);
  } else {
    const results = await runWithConcurrency(identifiers, MAX_WORKERS, async (itemId) => {
      try {
        const entry = await ensureItemCache(itemId, ctx, {
          needDjvu: true,
          cacheRoot,
          timeout,
          refresh,
        });
        return { ok: true as const, itemId, entry };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, itemId, error: msg };
      }
    });
    for (const res of results) {
      if (res.ok) {
        cacheEntries.push(res.entry);
      } else {
        itemErrors.push({ identifier: res.itemId, error: res.error });
      }
    }
    if (cacheEntries.length === 0) {
      const detail = itemErrors.map((e) => `${e.identifier}: ${e.error}`).join('; ');
      throw new RecordRuntimeError(detail);
    }
  }

  const allHits: GrepHit[] = [];
  const itemSummaries: Record<string, unknown>[] = [];
  let remaining = Math.max(0, limit);
  let totalMatches = 0;
  let allCached = itemErrors.length === 0;

  for (const entry of cacheEntries) {
    const wasCached = entry.cached;
    allCached = allCached && wasCached;
    const pageIndex = readPageIndex(entry.pageIndexPath) ?? emptyPageIndex();
    const djvuText = fs.readFileSync(entry.djvuPath).toString('utf8');
    const [hits, itemTotal] = grepCachedItem(entry.identifier, djvuText, pageIndex, pattern, ignoreCase, {
      contextChars,
      limit: remaining,
    });
    for (const h of hits) {
      h.cached = wasCached;
    }
    allHits.push(...hits);
    remaining = Math.max(0, limit - allHits.length);
    totalMatches += itemTotal;
    itemSummaries.push({
      identifier: entry.identifier,
      cached: wasCached,
      matches: itemTotal,
      returned: hits.length,
      cache_dir: entry.itemDir,
    });
  }

  const elapsedMs = Math.round((ctx.nowMs() - t0) * 100) / 100;
  const payload: Record<string, unknown> = {
    pattern,
    ignore_case: ignoreCase,
    cached: allCached,
    elapsed_ms: elapsedMs,
    total_matches: totalMatches,
    returned: allHits.length,
    items: itemSummaries,
    hits: allHits,
  };
  if (itemErrors.length > 0) {
    payload.errors = itemErrors;
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, jsonWithCacheHit(payload, allCached));
    return { exitCode: 0, bytesOut, cacheHit: allCached };
  }

  const status = allCached ? 'cache-hit' : 'fetched';
  const lines: string[] = [
    `${totalMatches} matches across ${cacheEntries.length} item(s) (showing ${allHits.length}, ${status}, ${elapsedMs} ms)`,
  ];
  for (const hit of allHits) {
    const pp = hit.printed_page ? `p.${hit.printed_page}` : 'p.?';
    const lf = hit.leaf !== null ? `n${hit.leaf}` : 'n?';
    lines.push(`- ${hit.identifier} | ${lf} (${pp}) | ${hit.image_url ?? hit.details_url}`);
    lines.push(`  ${hit.snippet}`);
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  for (const err of itemErrors) {
    ctx.io.stderr(`warning: ${err.identifier}: ${err.error}`);
  }
  return { exitCode: 0, bytesOut, cacheHit: allCached };
}
