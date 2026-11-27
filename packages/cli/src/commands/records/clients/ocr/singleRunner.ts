import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { atomicWriteFileSync, atomicWriteJsonSync, withAdvisoryLock } from '../../runtime/cache.js';
import { readJsonRecordIfValid } from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';
import { runCursiveOcr, runPrintedOcr } from './engines.js';
import { parseTesseractTsv } from './imageAndTsv.js';
import {
  type CursiveEffort,
  type CursiveProvider,
  DEFAULT_CURSIVE_TIMEOUT_S,
  DEFAULT_PRINTED_TIMEOUT_S,
  modeSlug,
  type OcrLayoutRecord,
  type OcrMode,
  type OcrTextRecord,
} from './types.js';

const OcrWordBoxSchema = z.object({
  text: z.string(),
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
  conf: z.number(),
});

const OcrLineBoxSchema = z.object({
  text: z.string(),
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
  conf: z.number(),
  page: z.number(),
  block: z.number(),
  par: z.number(),
  line: z.number(),
  words: z.array(OcrWordBoxSchema),
});

const OcrLayoutRecordSchema = z.object({
  sha256: z.string(),
  psm: z.number(),
  image_width: z.number(),
  image_height: z.number(),
  lines: z.array(OcrLineBoxSchema),
  cached: z.boolean().optional(),
  cache_hit: z.boolean().optional(),
  cache_path: z.string().optional(),
  find: z.string().optional(),
});

const OcrTextRecordSchema = z.object({
  sha256: z.string(),
  mode: z.string(),
  engine: z.string(),
  created_at: z.string(),
  elapsed_ms: z.number(),
  text: z.string(),
  source_hint: z.string(),
  meta: z.record(z.string(), z.unknown()),
  cached: z.boolean().optional(),
  cache_hit: z.boolean().optional(),
  cache_path: z.string().optional(),
  lookup_ms: z.number().optional(),
});

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
    if (parsed === null) {
      return null;
    }
    const validated = OcrLayoutRecordSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
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
    if (parsed === null) {
      return null;
    }
    const validated = OcrTextRecordSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
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
