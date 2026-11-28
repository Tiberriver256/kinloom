import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import { sha256Hex } from '../runtime/cache.js';
import { runWithConcurrency } from '../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandOutcome,
  type RecordHandler,
} from '../runtime/types.js';
import { formatOcrUsage, parseOcrArgs } from './ocr/cliArgs.js';
import { validateImageFile } from './ocr/imageAndTsv.js';
import { runLayoutData, runOcrBatchCommand, runOcrData } from './ocr/pipeline.js';
import {
  DEFAULT_PRINTED_TIMEOUT_S,
  type OcrLayoutRecord,
  OcrTimeoutError,
  resolveOcrCacheDir,
} from './ocr/types.js';

export { runWithConcurrency } from '../runtime/primitives.js';
export { formatOcrBatchUsage, formatOcrUsage, parseOcrArgs, parseOcrBatchArgs } from './ocr/cliArgs.js';
export { createDefaultExecFile, resolveExecutable } from './ocr/engines.js';
export {
  parseTesseractTsv,
  readImageDimensions,
  rescaleTesseractTsv,
  validateImageFile,
} from './ocr/imageAndTsv.js';
export { expandBatchInputs } from './ocr/pipeline.js';
export {
  type BatchFileResult,
  type BatchGrepMatch,
  CURSIVE_MAX_INPUT_BYTES,
  CURSIVE_TARGET_KB,
  CURSIVE_TARGET_MAX_WIDTH,
  type CursiveEffort,
  type CursiveProvider,
  DEFAULT_CURSIVE_EFFORT,
  DEFAULT_CURSIVE_GEMINI_MODEL,
  DEFAULT_CURSIVE_PROMPT,
  DEFAULT_CURSIVE_TIMEOUT_S,
  DEFAULT_MAX_WORKERS,
  DEFAULT_PRINTED_MAX_DIM,
  DEFAULT_PRINTED_TIMEOUT_S,
  DEFAULT_VISION_CLI,
  IMAGE_EXTENSIONS,
  InputImageError,
  MAX_WORKERS_CAP,
  modeSlug,
  type OcrLayoutRecord,
  type OcrLineBox,
  type OcrMode,
  type OcrTextRecord,
  OcrTimeoutError,
  type OcrTimeoutPayload,
  type OcrWordBox,
  type ParsedBatchOptions,
  type ParsedOcrOptions,
  type ParsedTsvLayout,
  resolveOcrCacheDir,
  resolveVisionCli,
  VALID_EFFORTS,
  VALID_MODES,
  VALID_PROVIDERS,
} from './ocr/types.js';

export const runOcrCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  let emitJsonError = false;
  try {
    if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, formatOcrUsage(ctx.env)) };
    }

    if (args[0] === 'batch') {
      return await runOcrBatchCommand(args.slice(1), ctx);
    }

    const opts = parseOcrArgs(args);
    if (opts.helpRequested) {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, formatOcrUsage(ctx.env)) };
    }
    emitJsonError = opts.json || opts.boxes;

    const resolvedImages = opts.images.map((rawArg) => {
      const imgPath = path.isAbsolute(rawArg) ? rawArg : path.resolve(ctx.cwd, rawArg);
      const rawBytes = validateImageFile(imgPath);
      return { rawArg, imgPath, rawBytes, sha256HexStr: sha256Hex(rawBytes) };
    });

    const cacheDir = resolveOcrCacheDir(opts.cacheDir, ctx.env);
    const multi = resolvedImages.length > 1;
    const poolWorkers = Math.min(opts.workers, resolvedImages.length);

    if (opts.boxes || opts.tsv) {
      const timeoutSeconds = opts.timeout ?? DEFAULT_PRINTED_TIMEOUT_S;
      const completed = await runWithConcurrency(resolvedImages, poolWorkers, async (item) => {
        const { data, cached } = await runLayoutData({
          imgPath: item.imgPath,
          rawBytes: item.rawBytes,
          sha256HexStr: item.sha256HexStr,
          cacheDir,
          psm: opts.psm,
          maxDim: opts.maxDim,
          timeoutSeconds,
          force: opts.force,
          tsvOnly: opts.tsv,
          find: opts.find,
          ctx,
        });
        return { rawArg: item.rawArg, imgPath: item.imgPath, data, cached };
      });

      const hits = completed.map((c) => c.cached);
      const allCached = hits.length > 0 && hits.every(Boolean);

      if (!multi && completed[0] !== undefined) {
        const single = completed[0].data;
        const bytesOut = opts.tsv ? emitStdout(ctx.io, String(single)) : emitJsonStdout(ctx.io, single);
        return { exitCode: 0, bytesOut, cacheHit: allCached };
      }

      if (opts.tsv) {
        const sections = completed.map((c) => `=== ${c.rawArg} ===\n${String(c.data).trimEnd()}`);
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, sections.join('\n\n')), cacheHit: allCached };
      }

      const filesOut = completed.map((c) => ({
        file: c.rawArg,
        path: c.imgPath,
        ...(c.data as OcrLayoutRecord),
      }));
      const bytesOut = emitJsonStdout(ctx.io, {
        files: filesOut,
        count: filesOut.length,
        cache_hits: hits.filter(Boolean).length,
        cache_hit: allCached,
      });
      return { exitCode: 0, bytesOut, cacheHit: allCached };
    }

    const completed = await runWithConcurrency(resolvedImages, poolWorkers, async (item) => {
      const { record, cached } = await runOcrData({
        imgPath: item.imgPath,
        rawBytes: item.rawBytes,
        sha256HexStr: item.sha256HexStr,
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
      return { rawArg: item.rawArg, imgPath: item.imgPath, record, cached };
    });

    const hits = completed.map((c) => c.cached);
    const allCached = hits.length > 0 && hits.every(Boolean);

    if (!multi && completed[0] !== undefined) {
      const singleRec = completed[0].record;
      const bytesOut = opts.json ? emitJsonStdout(ctx.io, singleRec) : emitStdout(ctx.io, singleRec.text);
      return { exitCode: 0, bytesOut, cacheHit: allCached };
    }

    if (opts.json) {
      const filesOut = completed.map((c) => ({
        file: c.rawArg,
        path: c.imgPath,
        ...c.record,
      }));
      const bytesOut = emitJsonStdout(ctx.io, {
        files: filesOut,
        count: filesOut.length,
        cache_hits: hits.filter(Boolean).length,
        cache_hit: allCached,
      });
      return { exitCode: 0, bytesOut, cacheHit: allCached };
    }

    const sections = completed.map((c) => `=== ${c.rawArg} ===\n${c.record.text}`);
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, sections.join('\n\n')), cacheHit: allCached };
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof OcrTimeoutError) {
      ctx.io.stderr(`Error: ${err.message}`);
      if (emitJsonError) {
        const bytesOut = emitJsonStdout(ctx.io, err.toStructuredError());
        return { exitCode: 1, bytesOut, cacheHit: false };
      }
      return { exitCode: 1, bytesOut: 0, cacheHit: false };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
