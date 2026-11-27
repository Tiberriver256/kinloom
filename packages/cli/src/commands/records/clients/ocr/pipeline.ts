import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  sha256Hex,
  withAdvisoryLock,
} from '../../runtime/cache.js';
import { readJsonRecordIfValid, runWithConcurrency } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import { formatOcrBatchUsage, parseOcrBatchArgs } from './cliArgs.js';
import { runCursiveOcr, runPrintedOcr } from './engines.js';
import { parseTesseractTsv, validateImageFile } from './imageAndTsv.js';
import {
  type BatchFileResult,
  type BatchGrepMatch,
  type CursiveEffort,
  type CursiveProvider,
  DEFAULT_CURSIVE_TIMEOUT_S,
  DEFAULT_PRINTED_TIMEOUT_S,
  IMAGE_EXTENSIONS,
  InputImageError,
  modeSlug,
  type OcrLayoutRecord,
  type OcrMode,
  type OcrTextRecord,
  OcrTimeoutError,
  resolveOcrCacheDir,
} from './types.js';

export async function runLayoutData(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly sha256HexStr: string;
  readonly cacheDir: string;
  readonly psm: number;
  readonly maxDim: number;
  readonly timeoutSeconds: number;
  readonly force: boolean;
  readonly tsvOnly: boolean;
  readonly find?: string;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly data: string | OcrLayoutRecord; readonly cached: boolean }> {
  const {
    imgPath,
    rawBytes,
    sha256HexStr,
    cacheDir,
    psm,
    maxDim,
    timeoutSeconds,
    force,
    tsvOnly,
    find,
    ctx,
  } = params;

  const base = path.join(cacheDir, `${sha256HexStr}_printed_psm${psm}`);
  const tsvPath = `${base}.tsv`;
  const boxesPath = `${base}.boxes.json`;
  const lockPath = path.join(cacheDir, '.locks', `${sha256HexStr}_printed_psm${psm}.layout.lock`);
  const workDir = path.join(cacheDir, '.work');

  const readCachedTsv = (): string | null => {
    if (force || !fs.existsSync(tsvPath)) {
      return null;
    }
    try {
      return fs.statSync(tsvPath).isFile() ? fs.readFileSync(tsvPath, 'utf8') : null;
    } catch {
      return null;
    }
  };

  const readCachedBoxes = (): OcrLayoutRecord | null => {
    if (force || !fs.existsSync(boxesPath)) {
      return null;
    }
    const parsed = readJsonRecordIfValid(boxesPath);
    if (parsed !== null && Array.isArray(parsed.lines)) {
      return parsed as unknown as OcrLayoutRecord;
    }
    return null;
  };

  if (tsvOnly) {
    const existing = readCachedTsv();
    if (existing !== null) {
      return { data: existing.endsWith('\n') ? existing : `${existing}\n`, cached: true };
    }
    return withAdvisoryLock(
      lockPath,
      async () => {
        const lockedExisting = readCachedTsv();
        if (lockedExisting !== null) {
          return {
            data: lockedExisting.endsWith('\n') ? lockedExisting : `${lockedExisting}\n`,
            cached: true,
          };
        }
        const { output: tsv } = await runPrintedOcr({
          imgPath,
          rawBytes,
          psm,
          timeoutSeconds,
          tsv: true,
          workDir,
          maxDim,
          ctx,
        });
        atomicWriteFileSync(tsvPath, tsv);
        return { data: tsv.endsWith('\n') ? tsv : `${tsv}\n`, cached: false };
      },
      { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
    );
  }

  let boxes = readCachedBoxes();
  let cached = boxes !== null;
  if (boxes === null) {
    const computed = await withAdvisoryLock(
      lockPath,
      async () => {
        const lockedBoxes = readCachedBoxes();
        if (lockedBoxes !== null) {
          return { boxes: lockedBoxes, cached: true };
        }
        let tsv = readCachedTsv();
        let wasCached = false;
        if (tsv !== null) {
          wasCached = true;
        } else {
          const fresh = await runPrintedOcr({
            imgPath,
            rawBytes,
            psm,
            timeoutSeconds,
            tsv: true,
            workDir,
            maxDim,
            ctx,
          });
          tsv = fresh.output;
          atomicWriteFileSync(tsvPath, tsv);
          wasCached = false;
        }
        const parsed = parseTesseractTsv(tsv);
        const record: OcrLayoutRecord = {
          sha256: sha256HexStr,
          psm,
          image_width: parsed.image_width,
          image_height: parsed.image_height,
          lines: parsed.lines,
        };
        atomicWriteJsonSync(boxesPath, record);
        return { boxes: record, cached: wasCached };
      },
      { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
    );
    boxes = computed.boxes;
    cached = computed.cached;
  }

  let filteredLines = boxes.lines;
  if (find !== undefined) {
    const rx = new RegExp(find, 'i');
    filteredLines = boxes.lines.filter((line) => rx.test(line.text));
  }

  const out: OcrLayoutRecord = {
    ...boxes,
    lines: filteredLines,
    cached,
    cache_hit: cached,
    cache_path: boxesPath,
    ...(find !== undefined ? { find } : {}),
  };
  return { data: out, cached };
}

export async function runOcrData(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly sha256HexStr: string;
  readonly cacheDir: string;
  readonly mode: OcrMode;
  readonly provider: CursiveProvider;
  readonly psm: number;
  readonly maxDim: number;
  readonly effort: CursiveEffort;
  readonly customPrompt?: string;
  readonly timeout?: number;
  readonly force: boolean;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly record: OcrTextRecord; readonly cached: boolean }> {
  const {
    imgPath,
    rawBytes,
    sha256HexStr,
    cacheDir,
    mode,
    provider,
    psm,
    maxDim,
    effort,
    customPrompt,
    timeout,
    force,
    ctx,
  } = params;

  const tItem = performance.now();
  const slug = modeSlug(mode, psm, effort, customPrompt);
  const cacheFile = path.join(cacheDir, `${sha256HexStr}_${slug}.json`);
  const lockFile = path.join(cacheDir, '.locks', `${sha256HexStr}_${slug}.lock`);
  const workDir = path.join(cacheDir, '.work');

  const tryReadCache = (): OcrTextRecord | null => {
    if (force || !fs.existsSync(cacheFile)) {
      return null;
    }
    const parsed = readJsonRecordIfValid(cacheFile);
    if (parsed !== null && typeof parsed.text === 'string') {
      return parsed as unknown as OcrTextRecord;
    }
    return null;
  };

  const cachedRec = tryReadCache();
  if (cachedRec !== null) {
    const lookupMs = Math.round((performance.now() - tItem) * 100) / 100;
    return {
      record: {
        ...cachedRec,
        cached: true,
        cache_hit: true,
        cache_path: cacheFile,
        lookup_ms: lookupMs,
      },
      cached: true,
    };
  }

  return withAdvisoryLock(
    lockFile,
    async () => {
      const lockedCached = tryReadCache();
      if (lockedCached !== null) {
        const lookupMs = Math.round((performance.now() - tItem) * 100) / 100;
        return {
          record: {
            ...lockedCached,
            cached: true,
            cache_hit: true,
            cache_path: cacheFile,
            lookup_ms: lookupMs,
          },
          cached: true,
        };
      }

      const timeoutSeconds =
        timeout ?? (mode === 'printed' ? DEFAULT_PRINTED_TIMEOUT_S : DEFAULT_CURSIVE_TIMEOUT_S);
      const tOcr = performance.now();

      let text: string;
      let meta: Record<string, unknown>;
      let engine: string;

      if (mode === 'printed') {
        const res = await runPrintedOcr({
          imgPath,
          rawBytes,
          psm,
          timeoutSeconds,
          tsv: false,
          workDir,
          maxDim,
          ctx,
        });
        text = res.output;
        meta = res.meta;
        engine = 'tesseract';
      } else {
        const res = await runCursiveOcr({
          imgPath,
          rawBytes,
          effort,
          provider,
          timeoutSeconds,
          cacheDir,
          customPrompt,
          ctx,
        });
        text = res.text;
        meta = res.meta;
        engine = res.engine;
      }

      const elapsedMs = Math.round(performance.now() - tOcr);
      const record: OcrTextRecord = {
        sha256: sha256HexStr,
        mode: slug,
        engine,
        created_at: new Date(ctx.nowMs()).toISOString(),
        elapsed_ms: elapsedMs,
        text,
        source_hint: path.basename(imgPath),
        meta,
      };
      atomicWriteJsonSync(cacheFile, record);
      return {
        record: {
          ...record,
          cached: false,
          cache_hit: false,
          cache_path: cacheFile,
          lookup_ms: Math.round((performance.now() - tItem) * 100) / 100,
        },
        cached: false,
      };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

function hasGlobMeta(input: string): boolean {
  return /[*?[\]{}]/.test(input);
}

function collectImagesRecursively(dirPath: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          found.push(full);
        }
      }
    }
  };
  walk(dirPath);
  return found;
}

export function expandBatchInputs(
  inputs: readonly string[],
  cwd: string
): { readonly raw: string; readonly absPath: string }[] {
  const results: { readonly raw: string; readonly absPath: string }[] = [];
  const seen = new Set<string>();

  const addFile = (raw: string, absPath: string): void => {
    if (seen.has(absPath)) {
      return;
    }
    seen.add(absPath);
    results.push({ raw, absPath });
  };

  for (const input of inputs) {
    if (hasGlobMeta(input)) {
      const matches = fs.globSync(input, { cwd });
      const resolvedMatches = matches
        .map((m) => (path.isAbsolute(m) ? m : path.resolve(cwd, m)))
        .filter((abs) => {
          try {
            return fs.statSync(abs).isFile();
          } catch {
            return false;
          }
        })
        .sort((a, b) => a.localeCompare(b));
      for (const abs of resolvedMatches) {
        addFile(abs, abs);
      }
      continue;
    }

    const abs = path.isAbsolute(input) ? input : path.resolve(cwd, input);
    if (!fs.existsSync(abs)) {
      throw new InputImageError(`image path not found: ${input}`);
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const dirImages = collectImagesRecursively(abs);
      for (const filePath of dirImages) {
        addFile(filePath, filePath);
      }
    } else if (stat.isFile()) {
      addFile(input, abs);
    } else {
      throw new InputImageError(`image path is not a regular file or directory: ${input}`);
    }
  }

  return results;
}

export async function runOcrBatchCommand(
  args: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const opts = parseOcrBatchArgs(args);
  if (opts.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, formatOcrBatchUsage(ctx.env)) };
  }

  const expanded = expandBatchInputs(opts.inputs, ctx.cwd);
  if (expanded.length === 0) {
    throw new InputImageError(`no image files matched: ${opts.inputs.join(', ')}`);
  }

  const cacheDir = resolveOcrCacheDir(opts.cacheDir, ctx.env);
  const grepRegex = opts.grep !== undefined ? new RegExp(opts.grep, opts.ignoreCase ? 'i' : '') : undefined;

  const fileResults = await runWithConcurrency(
    expanded,
    opts.concurrency,
    async (item): Promise<BatchFileResult> => {
      let rawBytes: Buffer;
      try {
        rawBytes = validateImageFile(item.absPath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          file: item.raw,
          path: item.absPath,
          status: 'failed',
          cached: false,
          cache_hit: false,
          error_code: 'INVALID_IMAGE',
          message,
        };
      }

      const digest = sha256Hex(rawBytes);
      try {
        const { record, cached } = await runOcrData({
          imgPath: item.absPath,
          rawBytes,
          sha256HexStr: digest,
          cacheDir,
          mode: opts.mode,
          provider: opts.provider,
          psm: opts.psm,
          maxDim: opts.maxDim,
          effort: opts.effort,
          customPrompt: opts.prompt,
          timeout: opts.timeout,
          force: opts.force,
          ctx,
        });

        let lineMatches: { readonly line_number: number; readonly text: string }[] | undefined;
        if (grepRegex !== undefined) {
          lineMatches = [];
          const lines = record.text.split(/\r?\n/);
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
            const lineText = lines[lineIdx];
            if (grepRegex.test(lineText)) {
              lineMatches.push({ line_number: lineIdx + 1, text: lineText });
            }
          }
        }

        return {
          file: item.raw,
          path: item.absPath,
          status: 'ok',
          cached,
          cache_hit: cached,
          text: record.text,
          sha256: record.sha256,
          mode: record.mode,
          engine: record.engine,
          elapsed_ms: record.elapsed_ms,
          meta: record.meta,
          ...(lineMatches !== undefined ? { matches: lineMatches } : {}),
        };
      } catch (err: unknown) {
        if (err instanceof OcrTimeoutError) {
          return {
            file: item.raw,
            path: item.absPath,
            status: 'timeout',
            cached: false,
            cache_hit: false,
            error_code: err.errorCode,
            timeout_seconds: err.timeoutSeconds,
            message: err.message,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          file: item.raw,
          path: item.absPath,
          status: 'failed',
          cached: false,
          cache_hit: false,
          error_code: err instanceof InputImageError ? 'INVALID_IMAGE' : 'OCR_ERROR',
          message,
        };
      }
    }
  );

  const succeeded = fileResults.filter((f) => f.status === 'ok').length;
  const timedOut = fileResults.filter((f) => f.status === 'timeout').length;
  const failed = fileResults.filter((f) => f.status === 'failed').length;
  const cacheHits = fileResults.filter((f) => f.status === 'ok' && f.cached).length;
  const allCached =
    fileResults.length > 0 && succeeded === fileResults.length && cacheHits === fileResults.length;

  const allMatches: BatchGrepMatch[] = [];
  for (const res of fileResults) {
    if (res.matches) {
      for (const m of res.matches) {
        allMatches.push({
          file: res.file,
          path: res.path,
          line_number: m.line_number,
          text: m.text,
        });
      }
    }
  }

  const exitCode = timedOut > 0 || failed > 0 ? 1 : 0;

  if (opts.json) {
    const payload = {
      mode: opts.mode,
      total: fileResults.length,
      succeeded,
      timed_out: timedOut,
      failed,
      cache_hits: cacheHits,
      cache_hit: allCached,
      grep: opts.grep ?? null,
      matched_count: allMatches.length,
      matches: allMatches,
      files: fileResults,
    };
    const bytesOut = emitJsonStdout(ctx.io, payload);
    return { exitCode, bytesOut, cacheHit: allCached };
  }

  const lines: string[] = [
    `Batch OCR (${opts.mode}): ${succeeded}/${fileResults.length} succeeded, ${timedOut} timed out, ${failed} failed, ${cacheHits} cache hits`,
  ];
  if (opts.grep !== undefined) {
    lines.push(`Grep '${opts.grep}': ${allMatches.length} match(es)`);
    for (const m of allMatches) {
      lines.push(`  ${m.file}:${m.line_number}: ${m.text}`);
    }
  }
  for (const res of fileResults) {
    if (res.status !== 'ok') {
      lines.push(`  [${res.status.toUpperCase()}] ${res.file}: ${res.message ?? res.error_code ?? 'error'}`);
    }
  }
  const bytesOut = emitStdout(ctx.io, lines.join('\n'));
  return { exitCode, bytesOut, cacheHit: allCached };
}
