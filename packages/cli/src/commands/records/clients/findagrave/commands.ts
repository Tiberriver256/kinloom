import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { atomicWriteFileSync, withAdvisoryLock } from '../../runtime/cache.js';
import { atomicCopyFileSync, isPlainRecord, resolveSafeChildPath } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  CEMETERY_PARSE_SPEC,
  GET_PARSE_SPEC,
  PHOTO_PARSE_SPEC,
  PLACE_PARSE_SPEC,
  renderCemeteryHelp,
  renderGetHelp,
  renderPhotoHelp,
  renderPlaceHelp,
  renderSearchHelp,
  renderUrlHelp,
  SEARCH_PARSE_SPEC,
  URL_PARSE_SPEC,
} from './cliSpecs.js';
import {
  CEMETERY_QUERY,
  enrichCemetery,
  enrichMemorial,
  fmtCemetery,
  formatCemeteriesText,
  formatMemorialsLines,
  formatPlacesText,
  formatSearchText,
  getCacheRoot,
  type JsonRecord,
  memorialUrl,
  normalizeYearFilter,
  type PhotoSavedItem,
  PLACE_QUERY,
  photoBytesAccepted,
  primaryName,
  resolveCacheTtlHours,
  resolvePositionalName,
  SEARCH_QUERY,
  safePhotoFilename,
  sanitizePrefix,
  validateEntityId,
  validatePhotoUrl,
  WEBSITE_BASE,
} from './domain.js';
import {
  cachedGqlQuery,
  fetchPhotoBytes,
  loadOrFetchCemeteryById,
  loadOrFetchMemorialsWithHits,
  photoCacheFresh,
  storePhotoCache,
} from './transport.js';

export async function runSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SEARCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSearchHelp()) };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const page = getNumberOption(parsed, 'page');
  const offset = getNumberOption(parsed, 'offset');
  if (page !== undefined && offset !== undefined) {
    throw new CliValidationError('Pass either --page or --offset, not both.');
  }

  const [firstName, lastName] = resolvePositionalName(
    parsed.positionals,
    getStringOption(parsed, 'firstName'),
    getStringOption(parsed, 'lastName'),
    getStringOption(parsed, 'fullName')
  );
  const birthYear = getNumberOption(parsed, 'birthYear');
  const deathYear = getNumberOption(parsed, 'deathYear');
  const yearRange = getNumberOption(parsed, 'yearRange');
  const normBirthFilter = normalizeYearFilter(
    getStringOption(parsed, 'birthYearFilter'),
    '--birth-year-filter'
  );
  const normDeathFilter = normalizeYearFilter(
    getStringOption(parsed, 'deathYearFilter'),
    '--death-year-filter'
  );
  const cemeteryIds = getStringListOption(parsed, 'cemeteryId');
  const locationId = getStringOption(parsed, 'locationId');
  const bio = getStringOption(parsed, 'bio');
  const text = getStringOption(parsed, 'text');
  const relative = getStringOption(parsed, 'relative');
  const exact = getBooleanOption(parsed, 'exact');
  const includeMaiden = getBooleanOption(parsed, 'includeMaiden');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const pageSize = Math.min(limit, 50);
  const resolvedOffset = offset !== undefined ? offset : page !== undefined ? (page - 1) * pageSize : 0;

  const searchInput: JsonRecord = {};
  if (firstName) {
    searchInput.firstName = firstName;
  }
  if (lastName) {
    searchInput.lastName = lastName;
  }
  if (birthYear !== undefined) {
    searchInput.birthYear = birthYear;
  }
  if (deathYear !== undefined) {
    searchInput.deathYear = deathYear;
  }
  if (yearRange !== undefined) {
    if (birthYear !== undefined) {
      searchInput.birthYearRange = yearRange;
    }
    if (deathYear !== undefined) {
      searchInput.deathYearRange = yearRange;
    }
  }
  if (normBirthFilter) {
    searchInput.birthYearFilter = normBirthFilter;
  }
  if (normDeathFilter) {
    searchInput.deathYearFilter = normDeathFilter;
  }
  if (cemeteryIds.length > 0) {
    searchInput.cemeteryIds = cemeteryIds.map((cid) => validateEntityId(cid, 'cemetery id'));
  }
  if (locationId) {
    searchInput.locationId = locationId;
  }
  if (bio) {
    searchInput.bio = bio;
  }
  if (text) {
    searchInput.fullText = text;
  }
  if (relative) {
    searchInput.linkedToName = relative;
  }
  if (exact) {
    searchInput.exactName = true;
  }
  searchInput.includeMaidenName = includeMaiden;
  searchInput.from = resolvedOffset;
  searchInput.size = pageSize;

  const { data, cacheHit } = await cachedGqlQuery(
    ctx,
    'search',
    searchInput,
    SEARCH_QUERY,
    { s: searchInput },
    { cacheRoot, ttlHours, refresh }
  );

  const rawResult = isPlainRecord(data.memorialSearch) ? data.memorialSearch : {};
  const rawMemorials = Array.isArray(rawResult.memorials) ? rawResult.memorials : [];
  const memorials = rawMemorials
    .filter((m): m is JsonRecord => isPlainRecord(m))
    .map((m) => enrichMemorial(m));
  const result: JsonRecord = { ...rawResult, memorials };

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const bytesOut = emitStdout(ctx.io, formatSearchText(result.total, memorials));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runGet(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, GET_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderGetHelp()) };
  }

  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const full = getBooleanOption(parsed, 'full');
  const photos = getBooleanOption(parsed, 'photos');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const { memorials, hits, allHit } = await loadOrFetchMemorialsWithHits(ctx, parsed.positionals, {
    cacheRoot,
    ttlHours,
    refresh,
  });

  if (asJson) {
    const emitted = memorials.map((mem, idx) => ({
      ...mem,
      cache_hit: Boolean(hits[idx]),
    }));
    const bytesOut = emitJsonStdout(ctx.io, emitted);
    return { exitCode: 0, bytesOut, cacheHit: allHit };
  }

  const lines = formatMemorialsLines(memorials, { full, photos });
  const bytesOut = lines.length > 0 ? emitStdout(ctx.io, lines.join('\n')) : 0;
  return { exitCode: 0, bytesOut, cacheHit: allHit };
}

export async function runCemetery(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CEMETERY_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCemeteryHelp()) };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const offset = getNumberOption(parsed, 'offset') ?? 0;
  const name = getStringOption(parsed, 'name');
  const cemeteryIdOpt = getStringOption(parsed, 'cemeteryId');
  const place = getStringOption(parsed, 'place');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const resolvedId = cemeteryIdOpt ?? parsed.positionals[0];
  let result: JsonRecord;
  let cacheHit: boolean;
  let cemeteriesList: JsonRecord[];

  if (resolvedId) {
    const loaded = await loadOrFetchCemeteryById(ctx, resolvedId, {
      cacheRoot,
      ttlHours,
      refresh,
    });
    result = loaded.result;
    cacheHit = loaded.cacheHit;
    cemeteriesList = (Array.isArray(result.cemeteries) ? result.cemeteries : []).filter(
      (c): c is JsonRecord => isPlainRecord(c)
    );
  } else {
    if (!name) {
      throw new CliValidationError('Pass a cemetery id, --id, or --name.');
    }
    const searchInput: JsonRecord = { name };
    if (place) {
      searchInput.containingLocationName = place;
    }
    searchInput.from = offset;
    searchInput.size = Math.min(limit, 100);
    const queried = await cachedGqlQuery(
      ctx,
      'cemetery_search',
      searchInput,
      CEMETERY_QUERY,
      { s: searchInput },
      { cacheRoot, ttlHours, refresh }
    );
    cacheHit = queried.cacheHit;
    const rawResult = isPlainRecord(queried.data.cemeteries) ? queried.data.cemeteries : {};
    const rawCems = Array.isArray(rawResult.cemeteries) ? rawResult.cemeteries : [];
    cemeteriesList = rawCems.map((c) => enrichCemetery(c)).filter((c): c is JsonRecord => isPlainRecord(c));
    result = { ...rawResult, cemeteries: cemeteriesList };
  }

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const bytesOut = emitStdout(ctx.io, formatCemeteriesText(result.total, cemeteriesList));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runPlace(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PLACE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPlaceHelp()) };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 10;
  const nameOpt = getStringOption(parsed, 'name');
  const posName = parsed.positionals
    .filter((p) => p.length > 0)
    .join(' ')
    .trim();
  if (posName && nameOpt) {
    throw new CliValidationError('Pass either a positional place name or --name, not both.');
  }
  const resolvedName = (nameOpt ?? posName).trim();
  if (!resolvedName) {
    throw new CliValidationError('Pass a place name positionally or with --name.');
  }

  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const searchInput: JsonRecord = { name: resolvedName, size: Math.min(limit, 50) };
  const { data, cacheHit } = await cachedGqlQuery(
    ctx,
    'place',
    searchInput,
    PLACE_QUERY,
    { s: searchInput },
    { cacheRoot, ttlHours, refresh }
  );
  const result = isPlainRecord(data.locationsByTypeahead) ? data.locationsByTypeahead : {};

  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, { ...result, cache_hit: cacheHit });
    return { exitCode: 0, bytesOut, cacheHit };
  }

  const bytesOut = emitStdout(ctx.io, formatPlacesText(result));
  return { exitCode: 0, bytesOut, cacheHit };
}

export async function runPhoto(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PHOTO_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPhotoHelp()) };
  }

  const rawOut = getStringOption(parsed, 'out') ?? '.';
  if (rawOut.includes('\0')) {
    throw new CliValidationError(`Invalid --out path: '${rawOut}'`);
  }
  if (!path.isAbsolute(rawOut) && rawOut.split(/[\\/]/).includes('..')) {
    throw new RecordRuntimeError(`Unsafe output directory containing '..': ${rawOut}`);
  }
  const outDir = path.isAbsolute(rawOut) ? rawOut : path.resolve(ctx.cwd, rawOut);

  const cleanId = validateEntityId(parsed.positionals[0], 'memorial id');
  const stemPrefix = sanitizePrefix(getStringOption(parsed, 'prefix'));
  const photoType = getStringOption(parsed, 'photoType');
  const allTypes = getBooleanOption(parsed, 'allTypes');
  const saveMetadata = getBooleanOption(parsed, 'saveMetadata');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'asJson');
  const ttlHours = resolveCacheTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx.env);
  const cacheRoot = getCacheRoot(ctx.env);

  const { memorials, allHit: memorialCacheHit } = await loadOrFetchMemorialsWithHits(ctx, [cleanId], {
    cacheRoot,
    ttlHours,
    refresh,
  });

  if (memorials.length === 0) {
    ctx.io.stderr(`No memorial found with id ${cleanId}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  const memorial = memorials[0];
  const photosObj = isPlainRecord(memorial.photos) ? memorial.photos : {};
  let photoList = (Array.isArray(photosObj.photos) ? photosObj.photos : []).filter((p): p is JsonRecord =>
    isPlainRecord(p)
  );
  if (photoType && !allTypes) {
    photoList = photoList.filter((p) => p.type === photoType);
  }

  if (photoList.length === 0) {
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, {
        memorial_id: cleanId,
        files: [],
        cache_hit: memorialCacheHit,
      });
      return { exitCode: 0, bytesOut, cacheHit: memorialCacheHit };
    }
    const bytesOut = emitStdout(ctx.io, 'No photos found.');
    return { exitCode: 0, bytesOut, cacheHit: memorialCacheHit };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const photosCacheDir = path.join(cacheRoot, 'photos', cleanId);
  const savedItems: PhotoSavedItem[] = [];
  const fileHits: boolean[] = [];
  let rejected = false;
  let bytesOut = 0;

  for (const item of photoList) {
    const url = validatePhotoUrl(typeof item.path === 'string' ? item.path : '');
    const cacheFilename = safePhotoFilename(item.id, url);
    const cachedPath = resolveSafeChildPath(photosCacheDir, cacheFilename);
    const dest = resolveSafeChildPath(outDir, `${stemPrefix}${cacheFilename}`);

    const copyCached = (fromCache: boolean): number => {
      atomicCopyFileSync(cachedPath, dest);
      const size = fs.statSync(dest).size;
      if (!asJson) {
        const suffixNote = fromCache ? ', cached' : '';
        bytesOut += emitStdout(ctx.io, `${dest} (${size} bytes${suffixNote})`);
      }
      return size;
    };

    let fromCache = false;
    let size = 0;

    if (!refresh && photoCacheFresh(cachedPath, ttlHours, ctx.nowMs)) {
      fromCache = true;
      size = copyCached(true);
    } else {
      const lockPath = resolveSafeChildPath(
        path.join(cacheRoot, '_locks'),
        `photo_${cleanId}_${cacheFilename}.lock`
      );
      let itemRejected = false;
      await withAdvisoryLock(
        lockPath,
        async () => {
          if (!refresh && photoCacheFresh(cachedPath, ttlHours, ctx.nowMs)) {
            fromCache = true;
            return;
          }
          const { content, contentType } = await fetchPhotoBytes(ctx, url);
          if (!photoBytesAccepted(content, contentType)) {
            rejected = true;
            itemRejected = true;
            const photoLabel = item.id !== null && item.id !== undefined ? String(item.id) : url;
            ctx.io.stderr(`Rejected non-image body for photo ${photoLabel}`);
            return;
          }
          storePhotoCache(cachedPath, content, contentType);
        },
        { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
      );
      if (itemRejected || !fs.existsSync(cachedPath)) {
        continue;
      }
      size = copyCached(fromCache);
    }

    fileHits.push(fromCache);
    savedItems.push({
      id: item.id ?? null,
      type: item.type ?? null,
      caption: item.caption ?? null,
      url,
      file: path.basename(dest),
      bytes: size,
      cache_hit: fromCache,
    });
  }

  let metadataPath: string | undefined;
  if (saveMetadata) {
    const metaPath = resolveSafeChildPath(outDir, `${stemPrefix}${cleanId}.metadata.json`);
    const metaPayload = {
      memorial_id: String(memorial.id ?? ''),
      name: primaryName(memorial),
      url: memorialUrl(String(memorial.id ?? '')),
      cemetery: fmtCemetery(memorial.cemetery),
      plot: memorial.plot ?? null,
      photos: savedItems.map((item) => ({
        id: item.id,
        type: item.type,
        caption: item.caption,
        url: item.url,
        file: item.file,
      })),
    };
    atomicWriteFileSync(metaPath, `${JSON.stringify(metaPayload, null, 2)}\n`);
    metadataPath = metaPath;
    if (!asJson) {
      bytesOut += emitStdout(ctx.io, `${metaPath} (metadata)`);
    }
  }

  const cacheHit =
    memorialCacheHit && !rejected && fileHits.every(Boolean) && fileHits.length === photoList.length;

  if (asJson) {
    const payload: JsonRecord = {
      memorial_id: cleanId,
      files: savedItems,
      cache_hit: cacheHit,
    };
    if (metadataPath !== undefined) {
      payload.metadata_file = metadataPath;
    }
    bytesOut += emitJsonStdout(ctx.io, payload);
  }

  if (rejected) {
    return { exitCode: 1, bytesOut, cacheHit };
  }
  return { exitCode: 0, bytesOut, cacheHit };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, URL_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderUrlHelp()) };
  }

  const firstName = getStringOption(parsed, 'firstName');
  const lastName = getStringOption(parsed, 'lastName');
  const birthYear = getNumberOption(parsed, 'birthYear');
  const deathYear = getNumberOption(parsed, 'deathYear');

  const params = new URLSearchParams();
  if (firstName) {
    params.append('firstname', firstName);
  }
  if (lastName) {
    params.append('lastname', lastName);
  }
  if (birthYear !== undefined) {
    params.append('birthyear', String(birthYear));
  }
  if (deathYear !== undefined) {
    params.append('deathyear', String(deathYear));
  }

  const base = `${WEBSITE_BASE}/memorial/search`;
  const qs = params.toString();
  const output = qs.length > 0 ? `${base}?${qs}` : base;
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, output) };
}
