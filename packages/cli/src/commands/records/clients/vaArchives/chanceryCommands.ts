import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { atomicWriteFileSync } from '../../runtime/cache.js';
import { atomicCopyFileSync, resolveUserPathFromContext } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  CHANCERY_CASE_SPEC,
  CHANCERY_DOWNLOAD_SPEC,
  CHANCERY_LOCALITIES_SPEC,
  CHANCERY_SEARCH_SPEC,
  renderChanceryCaseHelp,
  renderChanceryDownloadHelp,
  renderChanceryLocalitiesHelp,
  renderChancerySearchHelp,
} from './cliSpecs.js';
import {
  CHANCERY_AVAILABLE,
  CHANCERY_DETAIL,
  CHANCERY_IMAGES,
  CHANCERY_SEARCH,
  CHANCERY_ZIP,
  type ChanceryCaseDetail,
  type ChanceryImagesInfo,
  type ChancerySearchRecord,
  formatChanceryRecordText,
  parsePageSpec,
} from './domain.js';
import { parseCasePage, parseImagesPage, parseLocalitiesPage, parseSearchPage } from './parsers.js';
import { emitTrackedJson, fetchFile, fetchText, makeState } from './transport.js';

export async function runChancerySearch(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CHANCERY_SEARCH_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderChancerySearchHelp()) };
  }

  const rawMatch = (getStringOption(parsed, 'match') ?? 'Starts').trim().toLowerCase();
  const matchMap: Readonly<Record<string, string>> = {
    exact: 'Exact',
    starts: 'Starts',
    includes: 'Includes',
  };
  const matchMode = matchMap[rawMatch];
  if (!matchMode) {
    throw new CliValidationError(
      `Invalid value '${rawMatch}' for '--match'. Expected one of: Exact, Starts, Includes.`
    );
  }

  const locality = getStringOption(parsed, 'locality') ?? 'All';
  const surname2 = getStringOption(parsed, 'surname2');
  const plaintiffLast = getStringOption(parsed, 'plaintiffLast') ?? '';
  const plaintiffFirst = getStringOption(parsed, 'plaintiffFirst') ?? '';
  const defendantLast = getStringOption(parsed, 'defendantLast') ?? '';
  const defendantFirst = getStringOption(parsed, 'defendantFirst') ?? '';
  const yearFrom = getStringOption(parsed, 'yearFrom') ?? '';
  const yearTo = getStringOption(parsed, 'yearTo') ?? '';
  const indexNumber = getStringOption(parsed, 'indexNumber') ?? '';
  const localCaseNumber = getStringOption(parsed, 'localCaseNumber') ?? '';
  const enslaved = getBooleanOption(parsed, 'enslaved');
  const free = getBooleanOption(parsed, 'free');
  const plats = getBooleanOption(parsed, 'plats');
  const pagesSpec = getStringOption(parsed, 'pages') ?? '1';
  const asJson = getBooleanOption(parsed, 'asJson');

  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const allRecords: ChancerySearchRecord[] = [];
  let total = 0;

  for (const surname of parsed.positionals) {
    const form: Record<string, string> = {
      surname1: surname,
      sn1select: matchMode,
      plnlstName: plaintiffLast,
      plselect: matchMode,
      plnfrstName: plaintiffFirst,
      pfselect: matchMode,
      deflstName: defendantLast,
      dlselect: matchMode,
      deffrstName: defendantFirst,
      dfselect: matchMode,
      strDate1: yearFrom,
      strDate2: yearTo,
      txtIndexNum: indexNumber,
      txtLclCFN: localCaseNumber,
      Submit: 'Search',
      LOC: locality,
    };
    if (surname2) {
      form['surname2'] = surname2;
      form['sn2select'] = matchMode;
    }
    if (enslaved) {
      form['chkEnslaved'] = 'on';
    }
    if (free) {
      form['chkFree'] = 'on';
    }
    if (plats) {
      form['chkPlat'] = 'on';
    }

    const firstHtml = await fetchText(state, CHANCERY_SEARCH, {
      method: 'POST',
      data: form,
      allowedHosts: ['old.lva.virginia.gov'],
    });
    const parsedPage = parseSearchPage(firstHtml);
    total += parsedPage.total;

    const totalPages = Math.max(Math.ceil(total / 20), 1);
    const wanted =
      pagesSpec.trim().toLowerCase() === 'all'
        ? Array.from({ length: totalPages }, (_v, idx) => idx + 1)
        : parsePageSpec(pagesSpec, totalPages);

    for (const pn of wanted) {
      if (pn === 1) {
        allRecords.push(...parsedPage.records);
        continue;
      }
      const nextHtml = await fetchText(state, CHANCERY_SEARCH, {
        method: 'POST',
        data: { ...form, intPage: String(pn) },
        allowedHosts: ['old.lva.virginia.gov'],
      });
      allRecords.push(...parseSearchPage(nextHtml).records);
    }
  }

  if (asJson) {
    return emitTrackedJson(state, {
      total,
      returned: allRecords.length,
      records: allRecords,
    });
  }

  const lines: string[] = [`${total} record(s); showing ${allRecords.length}:`];
  for (const rec of allRecords) {
    lines.push(formatChanceryRecordText(rec), '');
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

export async function runChanceryCase(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CHANCERY_CASE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderChanceryCaseHelp()) };
  }

  const cfn = parsed.positionals[0];
  const includeImages = getBooleanOption(parsed, 'images');
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const detailHtml = await fetchText(state, CHANCERY_DETAIL, {
    params: { CFN: cfn },
    allowedHosts: ['old.lva.virginia.gov'],
  });
  const detail: ChanceryCaseDetail = {
    ...parseCasePage(detailHtml),
    cfn,
    case_url: `${CHANCERY_DETAIL}?CFN=${cfn}`,
  };
  if (includeImages) {
    const imgsHtml = await fetchText(state, CHANCERY_IMAGES, {
      params: { CFN: cfn },
      allowedHosts: ['old.lva.virginia.gov'],
    });
    detail.images = parseImagesPage(imgsHtml);
  }

  if (asJson) {
    return emitTrackedJson(state, { ...detail });
  }

  const lines: string[] = [
    `${cfn}  ${detail.locality}  index ${detail.index_number} (original case no. ${detail.original_case_number || 'n/a'})`,
    `Plaintiff(s): ${detail.plaintiffs.join('; ') || 'n/a'}`,
    `Defendant(s): ${detail.defendants.join('; ') || 'n/a'}`,
    `Surname(s): ${detail.surnames.join(', ') || 'n/a'}`,
    `Wills: ${detail.wills || 'n/a'}  Plat: ${detail.plat || 'n/a'}  Format: ${detail.format || 'n/a'}`,
    detail.case_url ?? '',
  ];
  if (detail.images) {
    lines.push(`Images: ${detail.images.total_pages} page(s)`);
    for (const u of detail.images.page_pdfs) {
      lines.push(`  ${u}`);
    }
    lines.push(`ZIP: ${detail.images.zip_url}`);
  }
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

export async function runChanceryDownload(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CHANCERY_DOWNLOAD_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderChanceryDownloadHelp()) };
  }

  const cfn = parsed.positionals[0];
  if (!/^[0-9]+(?:-[0-9]+)*$/.test(cfn)) {
    throw new CliValidationError(
      `Invalid CFN (expected locality-year-number digits): ${JSON.stringify(cfn)}`
    );
  }

  const outDirOpt = getStringOption(parsed, 'outDir');
  const outDir = resolveUserPathFromContext(outDirOpt ?? `va-chancery-${cfn}`, ctx);
  const pagesSpec = getStringOption(parsed, 'pages') ?? 'all';
  const asZip = getBooleanOption(parsed, 'asZip');
  const overwrite = getBooleanOption(parsed, 'overwrite');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  fs.mkdirSync(outDir, { recursive: true });
  const detailHtml = await fetchText(state, CHANCERY_DETAIL, {
    params: { CFN: cfn },
    allowedHosts: ['old.lva.virginia.gov'],
  });
  const detail: ChanceryCaseDetail = {
    ...parseCasePage(detailHtml),
    cfn,
    case_url: `${CHANCERY_DETAIL}?CFN=${cfn}`,
  };

  let imgs: ChanceryImagesInfo | undefined;
  if (!asZip) {
    const imgsHtml = await fetchText(state, CHANCERY_IMAGES, {
      params: { CFN: cfn },
      allowedHosts: ['old.lva.virginia.gov'],
    });
    imgs = parseImagesPage(imgsHtml);
    detail.images = imgs;
  }

  const metaDest = path.join(outDir, 'metadata.json');
  atomicWriteFileSync(metaDest, JSON.stringify(detail, null, 1));

  const lines: string[] = [];
  if (asZip) {
    const zipUrl = imgs?.zip_url || `${CHANCERY_ZIP}?cfn=${cfn}`;
    const dest = path.join(outDir, `${cfn}.zip`);
    if (fs.existsSync(dest) && !overwrite) {
      lines.push(`exists, skipping: ${dest}`);
    } else {
      const cached = await fetchFile(state, zipUrl, ['old.lva.virginia.gov']);
      atomicCopyFileSync(cached, dest);
      lines.push(`saved ${dest} (${fs.statSync(dest).size} bytes)`);
    }
    return {
      exitCode: 0,
      bytesOut: emitStdout(ctx.io, lines.join('\n')),
      cacheHit: state.tracker.allHits(),
    };
  }

  const totalPages = imgs?.total_pages ?? 0;
  const pagePdfs = imgs?.page_pdfs ?? [];
  const wanted = parsePageSpec(pagesSpec, totalPages);
  for (const n of wanted) {
    const pageUrl = pagePdfs[n - 1];
    if (!pageUrl) {
      continue;
    }
    const rawName = path.basename(new URL(pageUrl).pathname);
    const sanitized = rawName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
    const fileName = sanitized || `${String(n).padStart(4, '0')}.pdf`;
    const dest = path.join(outDir, fileName);
    if (fs.existsSync(dest) && !overwrite) {
      lines.push(`exists, skipping: ${fileName}`);
      continue;
    }
    const cached = await fetchFile(state, pageUrl, ['old.lva.virginia.gov']);
    atomicCopyFileSync(cached, dest);
    lines.push(`saved ${dest} (${fs.statSync(dest).size} bytes)`);
  }
  lines.push(`metadata: ${metaDest}`);
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}

export async function runChanceryLocalities(
  argv: readonly string[],
  ctx: RecordCommandContext,
  globalRefresh: boolean
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, CHANCERY_LOCALITIES_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderChanceryLocalitiesHelp()) };
  }

  const statusFilter = getStringOption(parsed, 'status');
  const asJson = getBooleanOption(parsed, 'asJson');
  const state = makeState(
    ctx,
    globalRefresh,
    getBooleanOption(parsed, 'refresh'),
    getNumberOption(parsed, 'cacheTtlHours')
  );

  const html = await fetchText(state, CHANCERY_AVAILABLE, {
    allowedHosts: ['old.lva.virginia.gov'],
  });
  let rows = parseLocalitiesPage(html);
  if (statusFilter) {
    const needle = statusFilter.toLowerCase();
    rows = rows.filter((r) => r.viewing_status.toLowerCase().includes(needle));
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, rows, 1),
      cacheHit: state.tracker.allHits(),
    };
  }

  const lines = rows.map(
    (r) => `${r.locality.padEnd(20)} ${r.region.padEnd(22)} ${r.time_frame.padEnd(14)} ${r.viewing_status}`
  );
  lines.push(`${rows.length} localities`);
  return {
    exitCode: 0,
    bytesOut: emitStdout(ctx.io, lines.join('\n')),
    cacheHit: state.tracker.allHits(),
  };
}
