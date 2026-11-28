import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  type CommandParseSpec,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  type OptionSpec,
  parseCommandArgs,
} from '../runtime/args.js';
import {
  atomicWriteFileSync,
  readBinaryCache,
  resolveCacheDir,
  sha256Hex,
  ttlHoursToMs,
  withAdvisoryLock,
} from '../runtime/cache.js';
import {
  assertSafeUrl,
  DEFAULT_RETRY_STATUSES,
  DEFAULT_USER_AGENT,
  defaultExecFile,
  httpRequest,
  SsrfBlockedError,
} from '../runtime/http.js';
import {
  handleRecordCommandError,
  hasMagicPrefix,
  isPlainRecord,
  looksLikeHtmlBuffer,
  resolveEnvCacheTtlHours,
  resolveUserPathFromContext,
} from '../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
} from '../runtime/types.js';

export const DEFAULT_PDF_GREP_TTL_HOURS = 168;
export const DEFAULT_PDF_GREP_TIMEOUT_S = 60;
const PDF_MAGIC = Buffer.from('%PDF');

export const PDF_GREP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'patterns',
    kind: 'string',
    flags: ['--pattern', '-e', '-p'],
    multiple: true,
    required: true,
    metavar: 'REGEX',
    help: 'Regular expression to search for (repeatable).',
  },
  {
    key: 'ignoreCase',
    kind: 'boolean',
    flags: ['-i', '--ignore-case'],
    help: 'Case-insensitive regex matching.',
  },
  {
    key: 'context',
    kind: 'integer',
    flags: ['-C', '--context'],
    min: 0,
    default: 160,
    metavar: 'CHARS',
    help: 'Context characters on each side of a match (default: 160).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['-n', '--limit'],
    min: 1,
    default: 25,
    metavar: 'N',
    help: 'Maximum matches returned per PDF source (default: 25).',
  },
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages'],
    metavar: 'SPEC',
    help: "Optional 1-based page filter (e.g. '1-5,10').",
  },
  {
    key: 'cacheDir',
    kind: 'string',
    flags: ['--cache-dir'],
    metavar: 'DIR',
    help: 'Override disk cache directory (default: ~/.cache/kinloom-pdf-grep, env KINLOOM_PDF_GREP_CACHE_DIR).',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours for remote URL downloads (default: 168, env KINLOOM_PDF_GREP_CACHE_TTL_HOURS).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass disk cache for URL downloads and pdftotext extraction.',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_PDF_GREP_TIMEOUT_S,
    metavar: 'SECONDS',
    help: `Timeout in seconds for HTTP downloads and pdftotext (default: ${DEFAULT_PDF_GREP_TIMEOUT_S}).`,
  },
  {
    key: 'asJson',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit deterministic structured JSON output.',
  },
];

export const PDF_GREP_PARSE_SPEC: CommandParseSpec = {
  options: PDF_GREP_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'url-or-path',
};

export interface PdfGrepMatch {
  readonly page: number;
  readonly line: number;
  readonly match: string;
  readonly snippet: string;
}

export interface PdfGrepSourceResult {
  readonly source: string;
  readonly kind: 'file' | 'url';
  readonly sha256: string;
  readonly page_count: number;
  readonly match_count: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly pages: readonly number[];
  readonly cache_hit: boolean;
  readonly matches: readonly PdfGrepMatch[];
}

export function renderPdfGrepHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom pdf-grep <url-or-path...> --pattern <regex> [options]',
    summary: 'Download or read PDFs with SHA-256 disk caching and grep extracted pdftotext output.',
    options: PDF_GREP_OPTIONS,
    notes: [
      'Examples:',
      '  kinloom pdf-grep ./roll-1880.pdf --pattern "Lincoln|Stout" -i --json',
      '  kinloom pdf-grep https://example.org/doc.pdf ./local.pdf --pattern "Sangamon" --pages 1-20 --json',
    ],
  });
}

export function isHttpUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw.trim());
}

export function parsePageFilter(raw: string | undefined): Set<number> | null {
  const cleaned = (raw ?? '').trim().toLowerCase();
  if (!cleaned || cleaned === 'all') {
    return null;
  }
  const pages = new Set<number>();
  for (const part of cleaned.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const range = /^(\d+)-(\d+)$/.exec(seg);
    if (range) {
      const start = Number.parseInt(range[1] as string, 10);
      const end = Number.parseInt(range[2] as string, 10);
      if (start < 1 || end < start) {
        throw new CliValidationError(`Invalid --pages range '${seg}'.`);
      }
      for (let p = start; p <= end; p += 1) {
        pages.add(p);
      }
      continue;
    }
    if (/^\d+$/.test(seg)) {
      const p = Number.parseInt(seg, 10);
      if (p < 1) {
        throw new CliValidationError(`Invalid --pages value '${seg}'.`);
      }
      pages.add(p);
      continue;
    }
    throw new CliValidationError(`Invalid --pages segment '${seg}'; expected e.g. '1-5,10'.`);
  }
  return pages;
}

function getPdfGrepCacheDir(flagValue: string | undefined, ctx: RecordCommandContext): string {
  return resolveCacheDir({
    flagValue,
    env: ctx.env,
    envVars: ['KINLOOM_PDF_GREP_CACHE_DIR'],
    defaultSubdir: 'kinloom-pdf-grep',
  });
}

function assertValidPdfBytes(bytes: Buffer, label: string): void {
  if (bytes.length === 0) {
    throw new RecordRuntimeError(`PDF source '${label}' is empty (0 bytes).`);
  }
  if (looksLikeHtmlBuffer(bytes, 512)) {
    throw new RecordRuntimeError(`PDF source '${label}' returned HTML, not a PDF.`);
  }
  if (!hasMagicPrefix(bytes, PDF_MAGIC)) {
    throw new RecordRuntimeError(`PDF source '${label}' does not start with a valid %PDF header.`);
  }
}

async function resolvePdfInput(
  rawSource: string,
  cacheDir: string,
  options: { readonly refresh: boolean; readonly ttlHours: number; readonly timeoutMs: number },
  ctx: RecordCommandContext
): Promise<{
  readonly kind: 'file' | 'url';
  readonly pdfPath: string;
  readonly sha256: string;
  readonly downloadCacheHit: boolean;
}> {
  if (isHttpUrl(rawSource)) {
    try {
      assertSafeUrl(rawSource, { allowedSchemes: ['https:', 'http:'], blockPrivateIps: true });
    } catch (err: unknown) {
      throw new CliValidationError(err instanceof SsrfBlockedError ? err.message : String(err));
    }

    const urlKey = sha256Hex(rawSource);
    const pdfPath = path.join(cacheDir, 'downloads', `${urlKey}.pdf`);
    const lockPath = path.join(cacheDir, 'downloads', `${urlKey}.lock`);
    const ttlMs = ttlHoursToMs(options.ttlHours);

    return withAdvisoryLock(
      lockPath,
      async () => {
        if (!options.refresh) {
          const cached = readBinaryCache(pdfPath, ttlMs, ctx.nowMs);
          if (cached.hit) {
            assertValidPdfBytes(cached.value, rawSource);
            return {
              kind: 'url',
              pdfPath,
              sha256: sha256Hex(cached.value),
              downloadCacheHit: true,
            };
          }
        }
        const res = await httpRequest(rawSource, {
          method: 'GET',
          headers: { Accept: 'application/pdf,*/*;q=0.1' },
          userAgent: DEFAULT_USER_AGENT,
          timeoutMs: options.timeoutMs,
          maxAttempts: 3,
          baseBackoffMs: 400,
          retryStatuses: DEFAULT_RETRY_STATUSES,
          urlPolicy: { allowedSchemes: ['https:', 'http:'], blockPrivateIps: true },
          fetchImpl: ctx.fetchImpl,
          sleepFn: ctx.sleepFn,
          nowMs: ctx.nowMs,
          throwOnHttpError: false,
        });
        if (res.status >= 400) {
          throw new RecordRuntimeError(`HTTP ${res.status} downloading PDF from ${res.url}`);
        }
        assertValidPdfBytes(res.bytes, rawSource);
        atomicWriteFileSync(pdfPath, res.bytes);
        return {
          kind: 'url',
          pdfPath,
          sha256: sha256Hex(res.bytes),
          downloadCacheHit: false,
        };
      },
      { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
    );
  }

  const localPath = resolveUserPathFromContext(rawSource, ctx);
  if (!fs.existsSync(localPath)) {
    throw new CliValidationError(`PDF file not found: ${localPath}`);
  }
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) {
    throw new CliValidationError(`PDF path is not a regular file: ${localPath}`);
  }
  const bytes = fs.readFileSync(localPath);
  assertValidPdfBytes(bytes, localPath);
  return {
    kind: 'file',
    pdfPath: localPath,
    sha256: sha256Hex(bytes),
    downloadCacheHit: true,
  };
}

function readCachedExtractedPages(cachePath: string): string[] | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!isPlainRecord(raw)) return null;
    const pages = raw['pages'];
    if (!Array.isArray(pages) || !pages.every((item): item is string => typeof item === 'string')) {
      return null;
    }
    return pages;
  } catch {
    return null;
  }
}

function extractExecFailure(err: unknown): {
  readonly code: number | string | null | undefined;
  readonly killed: boolean;
  readonly detail: string;
} {
  if (typeof err === 'object' && err !== null) {
    const obj = err as {
      code?: number | string | null;
      killed?: boolean;
      stderr?: Buffer | string;
      message?: string;
    };
    const stderr = Buffer.isBuffer(obj.stderr)
      ? obj.stderr.toString('utf8')
      : typeof obj.stderr === 'string'
        ? obj.stderr
        : '';
    return {
      code: obj.code,
      killed: Boolean(obj.killed),
      detail: (stderr || obj.message || String(err)).trim(),
    };
  }
  return { code: undefined, killed: false, detail: String(err) };
}

async function loadCachedPdfText(
  pdfPath: string,
  sha256: string,
  cacheDir: string,
  options: { readonly refresh: boolean; readonly timeoutMs: number },
  ctx: RecordCommandContext
): Promise<{ readonly pages: string[]; readonly cacheHit: boolean }> {
  const textDir = path.join(cacheDir, 'text');
  const dataPath = path.join(textDir, `${sha256}.json`);
  const lockPath = path.join(textDir, `${sha256}.lock`);

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!options.refresh) {
        const cached = readCachedExtractedPages(dataPath);
        if (cached !== null) {
          return { pages: cached, cacheHit: true };
        }
      }
      const execFn = ctx.execFileImpl ?? defaultExecFile;
      try {
        const { stdout } = await execFn('pdftotext', ['-enc', 'UTF-8', pdfPath, '-'], {
          timeout: options.timeoutMs,
          env: ctx.env,
        });
        const pages = stdout.toString('utf8').split('\f');
        if (pages.length > 0 && pages[pages.length - 1]?.trim().length === 0) {
          pages.pop();
        }
        atomicWriteFileSync(dataPath, `${JSON.stringify({ sha256, pages }, null, 2)}\n`);
        return { pages, cacheHit: false };
      } catch (err: unknown) {
        const info = extractExecFailure(err);
        if (info.code === 'ENOENT') {
          throw new RecordRuntimeError(
            'pdftotext not found on PATH. Install poppler-utils (for example `apt install poppler-utils`).'
          );
        }
        if (info.killed) {
          throw new RecordRuntimeError(
            `pdftotext timed out after ${Math.round(options.timeoutMs / 1000)}s on ${path.basename(pdfPath)}.`
          );
        }
        throw new RecordRuntimeError(`pdftotext failed (exit ${String(info.code ?? 1)}): ${info.detail}`);
      }
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export function grepPagesText(
  pageTexts: readonly string[],
  regex: RegExp,
  options: { readonly pageFilter: Set<number> | null; readonly contextLen: number; readonly limit: number }
): { readonly matches: PdfGrepMatch[]; readonly hitPages: number[]; readonly total: number } {
  const matches: PdfGrepMatch[] = [];
  const hitPages: number[] = [];
  let total = 0;

  for (let pIdx = 0; pIdx < pageTexts.length; pIdx += 1) {
    const pageNo = pIdx + 1;
    if (options.pageFilter && !options.pageFilter.has(pageNo)) {
      continue;
    }
    const text = pageTexts[pIdx] as string;
    let pageHit = false;
    let offset = 0;
    const lines = text.split('\n');
    for (let lIdx = 0; lIdx < lines.length; lIdx += 1) {
      const lineNo = lIdx + 1;
      const line = lines[lIdx] as string;
      regex.lastIndex = 0;
      for (;;) {
        const m = regex.exec(line);
        if (!m) break;
        if (m[0].length === 0) {
          regex.lastIndex += 1;
          if (regex.lastIndex > line.length) break;
          continue;
        }
        total += 1;
        pageHit = true;
        if (matches.length < options.limit) {
          const start = offset + m.index;
          const end = start + m[0].length;
          const snippet = text
            .slice(Math.max(0, start - options.contextLen), end + options.contextLen)
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

  return { matches, hitPages, total };
}

export const runPdfGrepCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPdfGrepHelp()) };
    }
    const parsed = parseCommandArgs(args, PDF_GREP_PARSE_SPEC);
    if (parsed.helpRequested) {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPdfGrepHelp()) };
    }

    const rawPatterns = getStringListOption(parsed, 'patterns')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (rawPatterns.length === 0) {
      throw new CliValidationError('Provide at least one non-empty --pattern <regex>.');
    }
    const combinedPattern =
      rawPatterns.length === 1 ? (rawPatterns[0] as string) : rawPatterns.map((p) => `(?:${p})`).join('|');
    const ignoreCase = getBooleanOption(parsed, 'ignoreCase');
    const contextLen = getNumberOption(parsed, 'context') ?? 160;
    const limit = getNumberOption(parsed, 'limit') ?? 25;
    const pageFilter = parsePageFilter(getStringOption(parsed, 'pages'));
    const refresh = getBooleanOption(parsed, 'refresh');
    const asJson = getBooleanOption(parsed, 'asJson');
    const timeoutS = getNumberOption(parsed, 'timeout') ?? DEFAULT_PDF_GREP_TIMEOUT_S;
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
      throw new CliValidationError(`--timeout must be a positive number of seconds, got '${timeoutS}'.`);
    }

    let regex: RegExp;
    try {
      regex = new RegExp(combinedPattern, ignoreCase ? 'gi' : 'g');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliValidationError(`Invalid --pattern regex '${combinedPattern}': ${msg}`);
    }

    const cacheDir = getPdfGrepCacheDir(getStringOption(parsed, 'cacheDir'), ctx);
    const ttlHours = resolveEnvCacheTtlHours(
      getNumberOption(parsed, 'cacheTtlHours'),
      ctx.env,
      'KINLOOM_PDF_GREP_CACHE_TTL_HOURS',
      DEFAULT_PDF_GREP_TTL_HOURS
    );
    const timeoutMs = Math.round(timeoutS * 1000);

    const sources: PdfGrepSourceResult[] = [];
    for (const rawSource of parsed.positionals) {
      const resolved = await resolvePdfInput(rawSource, cacheDir, { refresh, ttlHours, timeoutMs }, ctx);
      const extracted = await loadCachedPdfText(
        resolved.pdfPath,
        resolved.sha256,
        cacheDir,
        { refresh, timeoutMs },
        ctx
      );
      const { matches, hitPages, total } = grepPagesText(extracted.pages, regex, {
        pageFilter,
        contextLen,
        limit,
      });
      sources.push({
        source: rawSource,
        kind: resolved.kind,
        sha256: resolved.sha256,
        page_count: extracted.pages.length,
        match_count: total,
        returned: matches.length,
        truncated: total > matches.length,
        pages: hitPages,
        cache_hit: resolved.downloadCacheHit && extracted.cacheHit,
        matches,
      });
    }

    const totalMatches = sources.reduce((sum, s) => sum + s.match_count, 0);
    const allCacheHit = sources.every((s) => s.cache_hit);

    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, {
        pattern: combinedPattern,
        ignore_case: ignoreCase,
        source_count: sources.length,
        total_matches: totalMatches,
        cache_hit: allCacheHit,
        sources,
      });
      return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
    }

    const lines: string[] = [];
    for (const src of sources) {
      const marker = src.cache_hit ? ' [cache]' : '';
      lines.push(
        `=== ${src.source} (${src.match_count} match(es) across ${src.pages.length}/${src.page_count} page(s))${marker} ===`
      );
      for (const m of src.matches) {
        lines.push(`  p.${m.page} L${m.line}: ${m.snippet}`);
      }
    }
    const bytesOut = emitStdout(ctx.io, lines.join('\n'));
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
