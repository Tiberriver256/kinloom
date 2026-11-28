import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  ARCHIVE_OPTIONS,
  ARCHIVE_SPEC,
  ARCHIVES_OPTIONS,
  ARCHIVES_SPEC,
  EVENT_OPTIONS,
  EVENT_SPEC,
  HISKI_OPTIONS,
  HISKI_SPEC,
  PARISHES_OPTIONS,
  PARISHES_SPEC,
  URL_OPTIONS,
  URL_SPEC,
} from './cliSpecs.js';
import {
  ASTIA_SEARCH_URL,
  BOOK_ALIASES,
  BOOK_LABELS,
  DIGI_NEWSPAPERS_URL,
  DIGIHAKEMISTO_BASE,
  DIGIHAKEMISTO_PRESETS,
  FINNA_SEARCH_URL,
  HISKI_ENDPOINT,
  hiskiMaxkpl,
  normalizeOptionalValueFlags,
  PARISH_CODE_RE,
  parseArchiveId,
  parseEventRef,
  resolveTtlHours,
  SSHY_BASE_URL,
  validateYears,
} from './domain.js';
import {
  fetchCachedDigihakemistoArchive,
  fetchCachedDigihakemistoSearch,
  fetchCachedHiskiEvent,
  fetchCachedHiskiSearch,
  loadParishes,
  resolveParishSpec,
} from './transport.js';

export async function runParishes(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PARISHES_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives parishes [options]',
          summary: 'List or filter HisKi Finnish parishes and 4-digit codes.',
          options: PARISHES_OPTIONS,
        })
      ),
    };
  }
  const query = getStringOption(parsed, 'query');
  const limit = getNumberOption(parsed, 'limit');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  if (limit !== undefined && limit < 1) {
    throw new CliValidationError('--limit must be >= 1.');
  }

  const { parishes: allParishes, cacheHit } = await loadParishes(ctx, refresh, ttlHours);
  const total = allParishes.length;
  let parishes = allParishes;
  if (query) {
    const needle = query.trim().toLowerCase();
    parishes = parishes.filter((p) => p.name.toLowerCase().includes(needle) || needle === p.code);
  }
  if (limit !== undefined) {
    parishes = parishes.slice(0, limit);
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        query: query ?? null,
        total,
        returned: parishes.length,
        parishes,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`Showing ${parishes.length} of ${total} HisKi parish(es):${marker}`];
  for (const p of parishes) {
    lines.push(`  ${p.code}  ${p.name}  ${p.url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runHiski(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, HISKI_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives hiski [options]',
          summary: 'Search HisKi parish baptisms, marriages, burials, and moves.',
          options: HISKI_OPTIONS,
        })
      ),
    };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 30;
  if (limit < 1 || limit > 1000) {
    throw new CliValidationError('--limit must be between 1 and 1000.');
  }

  const rawBook = getStringOption(parsed, 'book') ?? 'christened';
  const bookCode = BOOK_ALIASES[rawBook.trim().toLowerCase()];
  if (!bookCode) {
    throw new CliValidationError(
      `Unsupported --book '${rawBook}'; choose christened, married, buried, moved-in, moved-out, or all.`
    );
  }

  const [fy, ty] = validateYears(getStringOption(parsed, 'fromYear'), getStringOption(parsed, 'toYear'));
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const srk = await resolveParishSpec(ctx, getStringOption(parsed, 'parish') ?? '*', refresh, ttlHours);

  if (srk === '*' && bookCode === 'kaikki') {
    throw new CliValidationError(
      "HisKi does not support nationwide ('*') searches with --book all; pick --book christened, married, buried, moved-in, or moved-out, or specify a --parish."
    );
  }

  const formData: Record<string, string> = {
    komento: 'haku',
    srk,
    kirja: bookCode,
    kieli: 'en',
    maxkpl: hiskiMaxkpl(limit),
  };
  if (fy) formData['alkuvuosi'] = fy;
  if (ty) formData['loppuvuosi'] = ty;

  const village = getStringOption(parsed, 'village')?.trim();
  if (village) formData['ikyla'] = village;

  const given = getStringOption(parsed, 'given')?.trim();
  const fatherGiven = getStringOption(parsed, 'fatherGiven')?.trim();
  const fatherPatronymic = getStringOption(parsed, 'fatherPatronymic')?.trim();
  const surname = getStringOption(parsed, 'surname')?.trim();
  const motherGiven = getStringOption(parsed, 'motherGiven')?.trim();
  const motherSurname = getStringOption(parsed, 'motherSurname')?.trim();

  if (bookCode === 'kastetut') {
    if (given) formData['etunimi'] = given;
    if (fatherGiven) formData['ietunimi'] = fatherGiven;
    if (fatherPatronymic) formData['ipatronyymi'] = fatherPatronymic;
    if (surname) formData['isukunimi'] = surname;
    if (motherGiven) formData['aetunimi'] = motherGiven;
    if (motherSurname) formData['asukunimi'] = motherSurname;
  } else {
    if (given) {
      formData['ietunimi'] = given;
    } else if (fatherGiven) {
      formData['ietunimi'] = fatherGiven;
    }
    if (fatherPatronymic) formData['ipatronyymi'] = fatherPatronymic;
    if (surname) formData['isukunimi'] = surname;
    if (motherGiven) formData['aetunimi'] = motherGiven;
    if (motherSurname) formData['asukunimi'] = motherSurname;
  }

  const filterKeys = [
    'etunimi',
    'ietunimi',
    'ipatronyymi',
    'isukunimi',
    'aetunimi',
    'asukunimi',
    'ikyla',
    'alkuvuosi',
    'loppuvuosi',
  ];
  if (!filterKeys.some((k) => k in formData)) {
    throw new CliValidationError(
      'Provide at least one filter (--surname, --given, --village, --from-year, etc.).'
    );
  }

  const { value: result, cacheHit } = await fetchCachedHiskiSearch(ctx, formData, srk, refresh, ttlHours);
  const records = result.records.slice(0, limit);
  const totalReported = result.total_reported || records.length;

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        parish: srk,
        book: BOOK_LABELS[bookCode] ?? bookCode,
        total_reported: totalReported,
        returned: records.length,
        records,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `HisKi ${BOOK_LABELS[bookCode] ?? bookCode} (parish=${srk}): ${totalReported} found, showing ${records.length}:${marker}`,
  ];
  for (const rec of records) {
    const parishTag = rec.parish ? `${rec.parish} (${rec.parish_code})` : rec.parish_code;
    if (rec.book_code === 'kastetut') {
      const dateS = String(rec['born'] || rec['christened'] || '');
      lines.push(
        `- ${dateS} | ${parishTag} | Child: ${String(rec['child'] ?? '')} | Parents: ${String(rec['father'] ?? '')} & ${String(rec['mother'] ?? '')}`
      );
    } else if (rec.book_code === 'vihityt') {
      const dateS = String(rec['married'] || rec['announced'] || '');
      lines.push(`- ${dateS} | ${parishTag} | ${String(rec['groom'] ?? '')} & ${String(rec['bride'] ?? '')}`);
    } else if (rec.book_code === 'haudatut') {
      const dateS = String(rec['died'] || rec['buried'] || '');
      lines.push(
        `- ${dateS} | ${parishTag} | ${String(rec['person'] ?? '')} | Cause: ${String(rec['cause'] ?? '')}`
      );
    } else {
      const dateS = String(rec['arrival'] || rec['departure'] || '');
      lines.push(
        `- ${dateS} | ${parishTag} | ${String(rec['person'] ?? '')} | Place: ${String(rec['other_place'] ?? '')}`
      );
    }
    lines.push(`  ${rec.event_url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runEvent(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, EVENT_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives event <EVENT_REF> [options]',
          summary: 'Inspect one HisKi event detail page (with SSHY scan link).',
          options: EVENT_OPTIONS,
        })
      ),
    };
  }
  const [parishCode, bookCode, rowId] = parseEventRef(parsed.positionals[0] ?? '');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const { value: detail, cacheHit } = await fetchCachedHiskiEvent(
    ctx,
    { parishCode, bookCode, rowId },
    refresh,
    ttlHours
  );

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...detail, cache_hit: cacheHit }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${detail.parish} (${detail.parish_code}) - ${detail.book} #${detail.row_id}${marker}`,
  ];
  for (const [k, v] of Object.entries(detail.fields)) {
    lines.push(`  ${k}: ${v}`);
  }
  if (detail.sshy_url) {
    lines.push(`  SSHY scan link: ${detail.sshy_url}`);
  }
  if (detail.permalink_url) {
    lines.push(`  Permalink: ${detail.permalink_url}`);
  }
  lines.push(`  Event URL: ${detail.event_url}`);
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runArchivesSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, ARCHIVES_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives archives [QUERY] [options]',
          summary: 'Search National Archives of Finland (Astia) via Digihakemisto.',
          options: ARCHIVES_OPTIONS,
        })
      ),
    };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 30;
  if (limit < 1 || limit > 500) {
    throw new CliValidationError('--limit must be between 1 and 500.');
  }
  const preset = getStringOption(parsed, 'preset');
  const query = preset ? DIGIHAKEMISTO_PRESETS[preset] : (parsed.positionals[0] ?? '').trim();
  if (!query) {
    throw new CliValidationError(
      'Provide QUERY or --preset (parishes, henkikirjat, court, inventories, say).'
    );
  }

  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const digitizedOnly = getBooleanOption(parsed, 'digitized');

  const { value: data, cacheHit } = await fetchCachedDigihakemistoSearch(ctx, query, refresh, ttlHours);

  let archives = [...data.archives];
  if (digitizedOnly) {
    archives = archives.filter((a) => a.digitized);
  }
  const total = archives.length;
  archives = archives.slice(0, limit);

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        query,
        total,
        returned: archives.length,
        archives,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `Digihakemisto "${query}": ${total} match(es), showing ${archives.length}:${marker}`,
  ];
  for (const arch of archives) {
    const flag = arch.digitized ? '[digitized]' : '[not-digitized]';
    lines.push(`- ${arch.id} ${flag} ${arch.title}`);
    if (arch.comment) {
      lines.push(`  ${arch.comment}`);
    }
    lines.push(`  ${arch.digihakemisto_url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export async function runArchiveInspect(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, ARCHIVE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives archive <ARCHIVE_ID> [options]',
          summary: 'Inspect one Digihakemisto/Astia archive series or volume list.',
          options: ARCHIVE_OPTIONS,
        })
      ),
    };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 50;
  if (limit < 1 || limit > 500) {
    throw new CliValidationError('--limit must be between 1 and 500.');
  }
  const archiveId = parseArchiveId(parsed.positionals[0] ?? '');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const digitizedOnly = getBooleanOption(parsed, 'digitized');

  const { value: detail, cacheHit } = await fetchCachedDigihakemistoArchive(
    ctx,
    archiveId,
    refresh,
    ttlHours
  );

  let children = [...detail.children];
  if (digitizedOnly) {
    children = children.filter((c) => c.digitized);
  }
  const totalChildren = children.length;
  children = children.slice(0, limit);

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        ...detail,
        total_children: totalChildren,
        returned_children: children.length,
        children,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${detail.id}  ${detail.title}${marker}`];
  if (detail.astia_url) {
    lines.push(`  Astia: ${detail.astia_url}`);
  }
  for (const note of detail.notes) {
    lines.push(`  Note: ${note}`);
  }
  lines.push(`  Children: ${children.length} of ${totalChildren}`);
  for (const child of children) {
    const flag = child.digitized ? '[digitized]' : '[not-digitized]';
    lines.push(`  - ${child.id} ${flag} ${child.title}`);
    if (child.comment) {
      lines.push(`    ${child.comment}`);
    }
    lines.push(`    ${child.digihakemisto_url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

export function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const normalized = normalizeOptionalValueFlags(argv, new Set(['--hiski', '--digihakemisto']));
  const parsed = parseCommandArgs(normalized, URL_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives url [options]',
          summary: 'Build verified browser URLs for Finna, Astia, HisKi, Digihakemisto, Digi, SSHY.',
          options: URL_OPTIONS,
        })
      ),
    };
  }

  const lines: string[] = [];
  const finna = getStringOption(parsed, 'finna');
  if (finna) {
    lines.push(
      `${FINNA_SEARCH_URL}?${new URLSearchParams({ lookfor: finna.trim(), type: 'AllFields' }).toString()}`
    );
  }
  if (getBooleanOption(parsed, 'astia')) {
    lines.push(ASTIA_SEARCH_URL);
  }
  if (parsed.provided.has('hiski')) {
    const code = (getStringOption(parsed, 'hiski') ?? '').trim();
    if (code && PARISH_CODE_RE.test(code)) {
      lines.push(`${HISKI_ENDPOINT}?en+${code}`);
    } else {
      lines.push(`${HISKI_ENDPOINT}?en`);
    }
  }
  if (parsed.provided.has('digihakemisto')) {
    lines.push(`${DIGIHAKEMISTO_BASE}/`);
  }
  const digi = getStringOption(parsed, 'digi');
  if (digi) {
    lines.push(`${DIGI_NEWSPAPERS_URL}?${new URLSearchParams({ query: digi.trim() }).toString()}`);
  }
  if (getBooleanOption(parsed, 'sshy')) {
    lines.push(SSHY_BASE_URL);
  }

  if (lines.length === 0) {
    lines.push(
      `HisKi:         ${HISKI_ENDPOINT}?en`,
      `Digihakemisto: ${DIGIHAKEMISTO_BASE}/`,
      `Astia (NARC):  ${ASTIA_SEARCH_URL}`,
      `Finna:         ${FINNA_SEARCH_URL}`,
      `SSHY:          ${SSHY_BASE_URL}`,
      `Digi (NLF):    ${DIGI_NEWSPAPERS_URL}`
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}
