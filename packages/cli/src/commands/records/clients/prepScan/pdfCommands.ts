import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { CliValidationError } from '../../../../errors.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { atomicWriteFileSync, withAdvisoryLock } from '../../runtime/cache.js';
import { defaultExecFile } from '../../runtime/http.js';
import { encodeCompactJpeg, orientedDimensions, type SavedImageInfo } from '../../runtime/image.js';
import {
  isPlainRecord,
  resolveUserPathFromContext,
  runWithConcurrency,
  sha256FileSync,
} from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { PDF_GREP_PARSE_SPEC, PDF_PAGES_PARSE_SPEC, renderSubcommandHelp } from './cliSpecs.js';
import {
  DEFAULT_PDF_TIMEOUT_S,
  formatPageSpec,
  normalizePdfFormat,
  normalizePrepScanArgv,
  PDF_PAGE_MAX_WORKERS,
  PDF_PAGE_NUM_RE,
  PDFINFO_PAGES_RE,
  type PdfImageFormat,
  parsePageSpec,
  roundKb,
} from './geometry.js';
import {
  buildContactStripFromItems,
  defaultCacheRoot,
  type LoadedRgbImage,
  loadRgbFromFile,
} from './imageOps.js';

function extractExecErrorDetails(err: unknown): {
  readonly code: number | string | null | undefined;
  readonly killed: boolean;
  readonly detail: string;
} {
  if (typeof err === 'object' && err !== null) {
    const obj = err as {
      code?: number | string | null;
      killed?: boolean;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      message?: string;
    };
    const stderrStr = Buffer.isBuffer(obj.stderr)
      ? obj.stderr.toString('utf8')
      : typeof obj.stderr === 'string'
        ? obj.stderr
        : '';
    const stdoutStr = Buffer.isBuffer(obj.stdout)
      ? obj.stdout.toString('utf8')
      : typeof obj.stdout === 'string'
        ? obj.stdout
        : '';
    const detail = (stderrStr || stdoutStr || obj.message || String(err)).trim();
    return { code: obj.code, killed: Boolean(obj.killed), detail };
  }
  return { code: undefined, killed: false, detail: String(err) };
}

async function getPdfPageCount(pdfPath: string, ctx: RecordCommandContext): Promise<number | null> {
  const execFn = ctx.execFileImpl ?? defaultExecFile;
  try {
    const { stdout } = await execFn('pdfinfo', [pdfPath], { timeout: 15_000, env: ctx.env });
    const match = PDFINFO_PAGES_RE.exec(stdout.toString('utf8'));
    if (match) {
      const count = Number.parseInt(match[1], 10);
      if (count > 0) {
        return count;
      }
    }
  } catch {
    // pdfinfo unavailable or failed; fall back to pdftoppm validation.
  }
  return null;
}

function pdfPageCachePaths(
  pdfSha256: string,
  pageNum: number,
  dpi: number,
  fmt: PdfImageFormat,
  cacheRoot: string
): { readonly cachePath: string; readonly lockPath: string } {
  const dir = path.join(cacheRoot, 'pdf-pages');
  const filename = `${pdfSha256}_p${pageNum}_dpi${dpi}.${fmt}`;
  return {
    cachePath: path.join(dir, filename),
    lockPath: path.join(dir, `.${filename}.lock`),
  };
}

function readNonEmptyFile(filePath: string): Buffer | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0) {
      return fs.readFileSync(filePath);
    }
  } catch {
    // Cache miss.
  }
  return null;
}

export async function renderOrLoadPdfPage(
  pdfPath: string,
  pdfSha256: string,
  pageNum: number,
  dpi: number,
  fmt: PdfImageFormat,
  cacheRoot: string,
  refresh: boolean,
  ctx: RecordCommandContext
): Promise<{ readonly data: Buffer; readonly cacheHit: boolean }> {
  const { cachePath, lockPath } = pdfPageCachePaths(pdfSha256, pageNum, dpi, fmt, cacheRoot);
  if (!refresh) {
    const cached = readNonEmptyFile(cachePath);
    if (cached !== null) {
      return { data: cached, cacheHit: true };
    }
  }

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!refresh) {
        const cached = readNonEmptyFile(cachePath);
        if (cached !== null) {
          return { data: cached, cacheHit: true };
        }
      }

      const execFn = ctx.execFileImpl ?? defaultExecFile;
      const cacheDir = path.dirname(cachePath);
      fs.mkdirSync(cacheDir, { recursive: true });
      const stageDir = path.join(
        cacheDir,
        `.stage_${process.pid}_${process.hrtime.bigint()}_${Math.random().toString(36).slice(2, 8)}`
      );
      fs.mkdirSync(stageDir, { recursive: true });
      try {
        const prefix = path.join(stageDir, `p${pageNum}`);
        const fmtFlag = fmt === 'png' ? '-png' : '-jpeg';
        try {
          await execFn(
            'pdftoppm',
            [fmtFlag, '-r', String(dpi), '-f', String(pageNum), '-l', String(pageNum), pdfPath, prefix],
            { timeout: DEFAULT_PDF_TIMEOUT_S * 1000, env: ctx.env }
          );
        } catch (err: unknown) {
          const info = extractExecErrorDetails(err);
          if (info.code === 'ENOENT') {
            throw new RecordRuntimeError(
              'pdftoppm executable not found on PATH. Install poppler-utils ' +
                '(for example `apt install poppler-utils` or `brew install poppler`).'
            );
          }
          if (info.killed) {
            throw new RecordRuntimeError(
              `pdftoppm timed out after ${DEFAULT_PDF_TIMEOUT_S}s on page ${pageNum}.`
            );
          }
          throw new RecordRuntimeError(
            `pdftoppm failed (exit ${String(info.code ?? 1)}) on page ${pageNum}: ${info.detail.slice(0, 300)}`
          );
        }

        const renderedFiles = fs
          .readdirSync(stageDir)
          .filter((name) => PDF_PAGE_NUM_RE.test(name))
          .toSorted()
          .map((name) => path.join(stageDir, name))
          .filter((full) => fs.statSync(full).isFile());

        if (renderedFiles.length === 0 || fs.statSync(renderedFiles[0]).size === 0) {
          throw new CliValidationError(
            `Page ${pageNum} is out of range or could not be rendered from ${path.basename(pdfPath)}.`
          );
        }
        fs.renameSync(renderedFiles[0], cachePath);
        return { data: fs.readFileSync(cachePath), cacheHit: false };
      } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function cmdPdfPages(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), PDF_PAGES_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('pdf-pages')) };
  }

  const dpi = getNumberOption(parsed, 'dpi') ?? 150;
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const fmt = normalizePdfFormat(getStringOption(parsed, 'format') ?? 'jpg');
  const requestedPages = parsePageSpec(getStringOption(parsed, 'pages') ?? '');
  const pdfPath = resolveUserPathFromContext(parsed.positionals[0], ctx);
  const outDir = resolveUserPathFromContext(getStringOption(parsed, 'outDir') ?? '', ctx);
  const stripOpt = getStringOption(parsed, 'strip');
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'json');

  if (!fs.existsSync(pdfPath) || !fs.statSync(pdfPath).isFile()) {
    ctx.io.stderr(`Error: PDF file not found: ${pdfPath}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  const pageCount = await getPdfPageCount(pdfPath, ctx);
  if (pageCount !== null) {
    const outOfBounds = requestedPages.filter((p) => p > pageCount);
    if (outOfBounds.length > 0) {
      throw new CliValidationError(
        `Page(s) ${outOfBounds.join(', ')} out of range for ${path.basename(pdfPath)} ` +
          `(PDF has ${pageCount} page(s): 1..${pageCount}).`
      );
    }
  }

  const pdfSha256 = sha256FileSync(pdfPath);
  const cacheRoot = defaultCacheRoot(ctx);
  fs.mkdirSync(outDir, { recursive: true });

  interface PdfPageRecord {
    readonly page: number;
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
    readonly kb: number;
    readonly cache_hit: boolean;
    readonly preview: SavedImageInfo;
  }

  const pageRecords = await runWithConcurrency(
    requestedPages,
    PDF_PAGE_MAX_WORKERS,
    async (pageNum): Promise<PdfPageRecord> => {
      const { data: pageData, cacheHit: pageCacheHit } = await renderOrLoadPdfPage(
        pdfPath,
        pdfSha256,
        pageNum,
        dpi,
        fmt,
        cacheRoot,
        refresh,
        ctx
      );
      const padNum = String(pageNum).padStart(3, '0');
      const destPage = path.join(outDir, `page-${padNum}.${fmt}`);
      atomicWriteFileSync(destPage, pageData);
      const previewPath = path.join(outDir, `page-${padNum}.preview.jpg`);

      const meta = await sharp(pageData, { limitInputPixels: false }).metadata();
      const { width: origW, height: origH } = orientedDimensions(meta);
      const savedPrev = await encodeCompactJpeg(pageData, previewPath, { maxWidth, maxKb });
      return {
        page: pageNum,
        path: destPage,
        width: origW,
        height: origH,
        bytes: pageData.length,
        kb: roundKb(pageData.length),
        cache_hit: pageCacheHit,
        preview: savedPrev,
      };
    }
  );

  let stripInfo: SavedImageInfo | undefined;
  if (stripOpt) {
    const stripItems: Array<{ readonly label: string; readonly image: LoadedRgbImage }> = [];
    for (const rec of pageRecords) {
      const im = await loadRgbFromFile(rec.preview.path);
      stripItems.push({
        label: `[p.${String(rec.page).padStart(3, '0')}] ${path.basename(pdfPath)}`,
        image: im,
      });
    }
    stripInfo = await buildContactStripFromItems(
      stripItems,
      resolveUserPathFromContext(stripOpt, ctx),
      maxWidth,
      maxKb
    );
  }

  const allCacheHit = pageRecords.length > 0 && pageRecords.every((r) => r.cache_hit);
  const payload = {
    pdf: pdfPath,
    dpi,
    format: fmt,
    requested_pages: requestedPages,
    missing_pages: [] as number[],
    pages: pageRecords,
    ...(stripInfo ? { strip: stripInfo } : {}),
    cache_hit: allCacheHit,
  };

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload), cacheHit: allCacheHit };
  }
  const lines = pageRecords.map(
    (rec) =>
      `p.${String(rec.page).padStart(3, '0')}  ${rec.path} (${rec.kb.toFixed(1)} KB)  ` +
      `preview: ${rec.preview.path} (${rec.preview.kb.toFixed(1)} KB)`
  );
  if (stripInfo) {
    lines.push(
      `strip: ${stripInfo.path}  ${stripInfo.width}x${stripInfo.height}  ${stripInfo.kb.toFixed(1)} KB`
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit: allCacheHit };
}

function readCachedPdfPages(cachePath: string): string[] | null {
  try {
    if (!fs.statSync(cachePath).isFile()) {
      return null;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!isPlainRecord(parsed)) {
      return null;
    }
    const pages = parsed.pages;
    if (!Array.isArray(pages) || !pages.every((p): p is string => typeof p === 'string')) {
      return null;
    }
    return pages;
  } catch {
    return null;
  }
}

async function extractPdfPagesText(pdfPath: string, ctx: RecordCommandContext): Promise<string[]> {
  const execFn = ctx.execFileImpl ?? defaultExecFile;
  try {
    const { stdout } = await execFn('pdftotext', ['-enc', 'UTF-8', pdfPath, '-'], {
      timeout: 600_000,
      env: ctx.env,
    });
    const pages = stdout.toString('utf8').split('\f');
    if (pages.length > 0 && pages[pages.length - 1].trim().length === 0) {
      pages.pop();
    }
    return pages;
  } catch (err: unknown) {
    const info = extractExecErrorDetails(err);
    if (info.code === 'ENOENT') {
      throw new RecordRuntimeError(
        'pdftotext not found on PATH. Install poppler-utils ' +
          '(for example `apt install poppler-utils` or `brew install poppler`).'
      );
    }
    throw new RecordRuntimeError(`pdftotext failed (exit ${String(info.code ?? 1)}): ${info.detail}`);
  }
}

async function loadPdfPageTexts(
  pdfPath: string,
  refresh: boolean,
  ctx: RecordCommandContext
): Promise<{ readonly pages: string[]; readonly cacheHit: boolean }> {
  const digest = sha256FileSync(pdfPath);
  const dir = path.join(defaultCacheRoot(ctx), 'pdf-text');
  const dataPath = path.join(dir, `${digest}.json`);
  const lockPath = path.join(dir, `${digest}.lock`);

  if (!refresh) {
    const cached = readCachedPdfPages(dataPath);
    if (cached !== null) {
      return { pages: cached, cacheHit: true };
    }
  }

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!refresh) {
        const cached = readCachedPdfPages(dataPath);
        if (cached !== null) {
          return { pages: cached, cacheHit: true };
        }
      }
      const pages = await extractPdfPagesText(pdfPath, ctx);
      atomicWriteFileSync(dataPath, `${JSON.stringify({ pages }, null, 2)}\n`);
      return { pages, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function cmdPdfGrep(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), PDF_GREP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('pdf-grep')) };
  }

  const pdfPath = resolveUserPathFromContext(parsed.positionals[0], ctx);
  const pattern = getStringOption(parsed, 'pattern') ?? '';
  const ignoreCase = getBooleanOption(parsed, 'ignoreCase');
  const contextLen = getNumberOption(parsed, 'context') ?? 200;
  const limit = getNumberOption(parsed, 'limit') ?? 25;
  const refresh = getBooleanOption(parsed, 'refresh');
  const asJson = getBooleanOption(parsed, 'json');

  if (!fs.existsSync(pdfPath) || !fs.statSync(pdfPath).isFile()) {
    ctx.io.stderr(`Error: PDF file not found: ${pdfPath}`);
    return { exitCode: 1, bytesOut: 0 };
  }
  if (limit < 1 || contextLen < 0) {
    throw new CliValidationError('--limit must be >= 1 and --context must be >= 0.');
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid --pattern regex '${pattern}': ${msg}`);
  }

  const { pages: pageTexts, cacheHit } = await loadPdfPageTexts(pdfPath, refresh, ctx);

  interface PdfGrepMatch {
    readonly page: number;
    readonly line: number;
    readonly match: string;
    readonly snippet: string;
  }

  const matches: PdfGrepMatch[] = [];
  const hitPages: number[] = [];
  let total = 0;

  for (let pIdx = 0; pIdx < pageTexts.length; pIdx += 1) {
    const pageNo = pIdx + 1;
    const text = pageTexts[pIdx];
    let pageHit = false;
    let offset = 0;
    const lines = text.split('\n');
    for (let lIdx = 0; lIdx < lines.length; lIdx += 1) {
      const lineNo = lIdx + 1;
      const line = lines[lIdx];
      regex.lastIndex = 0;
      for (;;) {
        const m = regex.exec(line);
        if (!m) {
          break;
        }
        if (m[0].length === 0) {
          regex.lastIndex += 1;
          if (regex.lastIndex > line.length) {
            break;
          }
          continue;
        }
        total += 1;
        pageHit = true;
        if (matches.length < limit) {
          const start = offset + m.index;
          const end = start + m[0].length;
          const snippet = text
            .slice(Math.max(0, start - contextLen), end + contextLen)
            .trim()
            .replace(/\s+/g, ' ');
          matches.push({ page: pageNo, line: lineNo, match: m[0], snippet });
        }
      }
      offset += line.length + 1;
    }
    if (pageHit) {
      hitPages.push(pageNo);
    }
  }

  const pagesArg = formatPageSpec(hitPages);
  const truncated = total > matches.length;
  const result = {
    pdf: pdfPath,
    pattern,
    ignore_case: ignoreCase,
    page_count: pageTexts.length,
    match_count: total,
    returned: matches.length,
    truncated,
    pages: hitPages,
    pages_arg: pagesArg,
    matches,
    cache_hit: cacheHit,
  };

  let bytesOut: number;
  if (asJson) {
    bytesOut = emitJsonStdout(ctx.io, result);
  } else {
    const outLines = matches.map((m) => `p.${m.page} L${m.line}: ${m.snippet}`);
    const summary =
      `${total} match(es) on ${hitPages.length} of ${pageTexts.length} page(s)` +
      (truncated ? `; showing first ${matches.length} (raise --limit)` : '');
    outLines.push(summary);
    if (pagesArg) {
      outLines.push(`next: kinloom prep-scan pdf-pages ${pdfPath} --pages ${pagesArg} --out-dir <dir>`);
    }
    bytesOut = emitStdout(ctx.io, outLines.join('\n'));
  }

  return { exitCode: total > 0 ? 0 : 1, bytesOut, cacheHit };
}
