import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../runtime/cache.js';
import { runWithConcurrency } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import { formatOcrBatchUsage, parseOcrBatchArgs } from './cliArgs.js';
import { validateImageFile } from './imageAndTsv.js';
import { runOcrData } from './singleRunner.js';
import {
  type BatchFileResult,
  type BatchGrepMatch,
  IMAGE_EXTENSIONS,
  InputImageError,
  OcrTimeoutError,
  resolveOcrCacheDir,
} from './types.js';

export { runLayoutData, runOcrData } from './singleRunner.js';

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
            if (lineText !== undefined && grepRegex.test(lineText)) {
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
