import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CliValidationError } from '../../../errors.js';
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  downscaleForCursiveOcr,
  downscaleForOcr,
  emitJsonStdout,
  emitStdout,
  resolveCacheDir,
  sha256Hex,
  withAdvisoryLock,
  type ExecFileFn,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
} from '../runtime/index.js';

export const DEFAULT_CURSIVE_EFFORT = 'low';
export const DEFAULT_VISION_CLI = 'agy';
export const DEFAULT_CURSIVE_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_PRINTED_TIMEOUT_S = 30;
export const DEFAULT_CURSIVE_TIMEOUT_S = 90;
export const DEFAULT_MAX_WORKERS = 4;
export const MAX_WORKERS_CAP = 8;
export const DEFAULT_PRINTED_MAX_DIM = 3500;
export const CURSIVE_MAX_INPUT_BYTES = 350 * 1024;
export const CURSIVE_TARGET_KB = 285;
export const CURSIVE_TARGET_MAX_WIDTH = 2400;

export const VALID_MODES = ['printed', 'cursive'] as const;
export type OcrMode = (typeof VALID_MODES)[number];

export const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type CursiveEffort = (typeof VALID_EFFORTS)[number];

export const VALID_PROVIDERS = ['auto', 'cli', 'gemini'] as const;
export type CursiveProvider = (typeof VALID_PROVIDERS)[number];

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
  '.bmp',
  '.gif',
]);

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const HTML_SNIFF_PREFIXES: readonly string[] = [
  '<!doctype',
  '<html',
  '<head',
  '<body',
  '<title',
];

const TESSERACT_INVALID_IMAGE_MARKERS: readonly string[] = [
  'error in pixread',
  'unsupported image',
  'could not read',
  'unknown format',
  'cannot read input file',
  'error, cannot open',
  'image file cannot be read',
];

export const DEFAULT_CURSIVE_PROMPT =
  'Call read_file ONCE on {image_path}. Do not run shell commands, do not write files, ' +
  'and do not invoke subagents. Transcribe verbatim all handwritten cursive text visible on ' +
  'this archival document: first the sheet/page header (state, county, township/city, date, ' +
  'ED/page/sheet numbers), then each legible household/person row with line number, ' +
  'dwelling/family numbers, full name, relation, sex, color/race, age, occupation, property ' +
  'values, and birthplace. Mark genuinely illegible words or characters as [?]; never invent ' +
  'or extrapolate obscured rows.';

const DEFAULT_GEMINI_CURSIVE_PROMPT =
  'Transcribe verbatim all handwritten cursive text visible on this archival document: ' +
  'first the sheet/page header (state, county, township/city, date, ED/page/sheet numbers), ' +
  'then each legible household/person row with line number, dwelling/family numbers, full name, ' +
  'relation, sex, color/race, age, occupation, property values, and birthplace. Mark genuinely ' +
  'illegible words or characters as [?]; never invent or extrapolate obscured rows.';

let workSeq = 0;

export class InputImageError extends CliValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InputImageError';
  }
}

export class OcrTimeoutError extends Error {
  readonly errorCode = 'OCR_TIMEOUT' as const;
  readonly timeoutSeconds: number;
  readonly file: string;

  constructor(message: string, timeoutSeconds: number, file: string) {
    super(message);
    this.name = 'OcrTimeoutError';
    this.timeoutSeconds = timeoutSeconds;
    this.file = file;
  }

  toStructuredError(): OcrTimeoutPayload {
    return {
      error_code: this.errorCode,
      timeout_seconds: this.timeoutSeconds,
      file: this.file,
      message: this.message,
    };
  }
}

export interface OcrTimeoutPayload {
  readonly error_code: 'OCR_TIMEOUT';
  readonly timeout_seconds: number;
  readonly file: string;
  readonly message: string;
}

export interface OcrWordBox {
  readonly text: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly conf: number;
}

export interface OcrLineBox {
  readonly text: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly conf: number;
  readonly page: number;
  readonly block: number;
  readonly par: number;
  readonly line: number;
  readonly words: readonly OcrWordBox[];
}

export interface ParsedTsvLayout {
  readonly image_width: number;
  readonly image_height: number;
  readonly lines: OcrLineBox[];
}

export interface OcrLayoutRecord extends ParsedTsvLayout {
  readonly sha256: string;
  readonly psm: number;
  readonly cached?: boolean;
  readonly cache_hit?: boolean;
  readonly cache_path?: string;
  readonly find?: string;
}

export interface OcrTextRecord {
  readonly sha256: string;
  readonly mode: string;
  readonly engine: string;
  readonly created_at: string;
  readonly elapsed_ms: number;
  readonly text: string;
  readonly source_hint: string;
  readonly meta: Record<string, unknown>;
  readonly cached?: boolean;
  readonly cache_hit?: boolean;
  readonly cache_path?: string;
  readonly lookup_ms?: number;
}

export interface ParsedOcrOptions {
  readonly helpRequested: boolean;
  readonly images: readonly string[];
  readonly mode: OcrMode;
  readonly provider: CursiveProvider;
  readonly psm: number;
  readonly effort: CursiveEffort;
  readonly cacheDir?: string;
  readonly timeout?: number;
  readonly workers: number;
  readonly maxDim: number;
  readonly prompt?: string;
  readonly force: boolean;
  readonly json: boolean;
  readonly boxes: boolean;
  readonly tsv: boolean;
  readonly find?: string;
}

export interface ParsedBatchOptions {
  readonly helpRequested: boolean;
  readonly inputs: readonly string[];
  readonly grep?: string;
  readonly ignoreCase: boolean;
  readonly concurrency: number;
  readonly timeout?: number;
  readonly mode: OcrMode;
  readonly provider: CursiveProvider;
  readonly psm: number;
  readonly effort: CursiveEffort;
  readonly prompt?: string;
  readonly maxDim: number;
  readonly cacheDir?: string;
  readonly force: boolean;
  readonly json: boolean;
}

export interface BatchGrepMatch {
  readonly file: string;
  readonly path: string;
  readonly line_number: number;
  readonly text: string;
}

export interface BatchFileResult {
  readonly file: string;
  readonly path: string;
  readonly status: 'ok' | 'timeout' | 'failed';
  readonly cached: boolean;
  readonly cache_hit: boolean;
  readonly text?: string;
  readonly sha256?: string;
  readonly mode?: string;
  readonly engine?: string;
  readonly elapsed_ms?: number;
  readonly meta?: Record<string, unknown>;
  readonly matches?: readonly { readonly line_number: number; readonly text: string }[];
  readonly error_code?: string;
  readonly timeout_seconds?: number;
  readonly message?: string;
}

interface ScaleInfo {
  readonly original_width: number;
  readonly original_height: number;
  readonly scaled_width: number;
  readonly scaled_height: number;
}

interface SubprocessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveVisionCli(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.KINLOOM_OCR_CLI ?? '').trim();
  return configured || DEFAULT_VISION_CLI;
}

export function resolveOcrCacheDir(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  return resolveCacheDir({
    flagValue,
    env,
    envVars: ['KINLOOM_OCR_CACHE_DIR'],
    defaultSubdir: 'kinloom-ocr',
    useXdgCacheHome: true,
  });
}

export function modeSlug(
  mode: OcrMode,
  psm: number,
  effort: CursiveEffort,
  customPrompt: string | undefined
): string {
  if (mode === 'printed') {
    return `printed_psm${psm}`;
  }
  const base = `cursive_hydrogen_${effort}`;
  if (customPrompt) {
    const digest = sha256Hex(customPrompt).slice(0, 8);
    return `${base}_p${digest}`;
  }
  return base;
}

export function formatOcrUsage(env: NodeJS.ProcessEnv = process.env): string {
  const cacheDefault = resolveOcrCacheDir(undefined, env);
  const cliDefault = resolveVisionCli(env);
  return [
    'Usage: kinloom ocr <image> [image ...] [options]',
    '       kinloom ocr batch <glob-or-dir> [more-paths...] [options]',
    '',
    'Options:',
    '  -m, --mode <printed|cursive>      OCR mode (default: printed; aliases: --printed, --cursive)',
    '  --provider <auto|cli|gemini>      Backend for --mode cursive (default: auto)',
    '  --psm <int>                       Tesseract PSM for --mode printed (default: 6)',
    `  --effort <low|medium|high|xhigh>  Reasoning effort for --mode cursive (default: ${DEFAULT_CURSIVE_EFFORT})`,
    `  --cache-dir <dir>                 Cache directory (default: ${cacheDefault})`,
    `  -t, --timeout <seconds>           Per-image subprocess timeout (default: ${DEFAULT_PRINTED_TIMEOUT_S} printed, ${DEFAULT_CURSIVE_TIMEOUT_S} cursive)`,
    `  --workers, --concurrency <int>    Parallel worker count for multi-file batches (default: ${DEFAULT_MAX_WORKERS}, max: ${MAX_WORKERS_CAP})`,
    `  --max-dim <px>                    Cap longest printed scan edge before Tesseract (default: ${DEFAULT_PRINTED_MAX_DIM}, 0 disables)`,
    '  --prompt <text>                   Custom prompt for --mode cursive (supports {image_path})',
    '  --force, --refresh, --no-cache    Bypass cache and recompute OCR',
    '  --json                            Emit structured JSON output (or {files: [...]} for multiple images)',
    '  --boxes                           Emit JSON line/word pixel boxes (printed mode only)',
    '  --tsv                             Emit raw Tesseract TSV (printed mode only)',
    '  --find <regex>                    Case-insensitive line filter; implies --boxes',
    '  -h, --help                        Show this help message',
    '',
    'Subcommands:',
    '  batch                             Bounded-concurrency directory/glob OCR with optional --grep',
    '',
    'Environment:',
    `  KINLOOM_OCR_CACHE_DIR             Override cache directory (default: ${cacheDefault})`,
    `  KINLOOM_OCR_CLI                   Vision CLI executable for --mode cursive (default: ${cliDefault})`,
    '  KINLOOM_OCR_MODEL                 Override model name passed to --mode cursive',
    '  GEMINI_API_KEY / GOOGLE_API_KEY   API key for direct Gemini cursive OCR (--provider gemini or fallback)',
  ].join('\n');
}

export function formatOcrBatchUsage(env: NodeJS.ProcessEnv = process.env): string {
  const cacheDefault = resolveOcrCacheDir(undefined, env);
  return [
    'Usage: kinloom ocr batch <glob-or-dir> [more-paths...] [options]',
    '',
    'Run bounded-concurrency OCR across directories, globs, or image files.',
    'Always enforces OMP_THREAD_LIMIT=1 and per-page timeout isolation.',
    '',
    'Options:',
    '  --grep <regex>                    Filter/annotate matching OCR lines across files',
    '  -i, --ignore-case                 Case-insensitive --grep matching',
    `  --concurrency, --workers <int>    Max concurrent OCR jobs (default: ${DEFAULT_MAX_WORKERS}, max: ${MAX_WORKERS_CAP})`,
    `  -t, --timeout <seconds>           Per-page timeout in seconds (default: ${DEFAULT_PRINTED_TIMEOUT_S} printed, ${DEFAULT_CURSIVE_TIMEOUT_S} cursive)`,
    '  -m, --mode <printed|cursive>      OCR mode (default: printed; aliases: --printed, --cursive)',
    '  --provider <auto|cli|gemini>      Backend for --mode cursive (default: auto)',
    '  --psm <int>                       Tesseract PSM for --mode printed (default: 6)',
    `  --effort <low|medium|high|xhigh>  Reasoning effort for --mode cursive (default: ${DEFAULT_CURSIVE_EFFORT})`,
    '  --prompt <text>                   Custom prompt for --mode cursive',
    `  --max-dim <px>                    Cap longest printed scan edge before Tesseract (default: ${DEFAULT_PRINTED_MAX_DIM}, 0 disables)`,
    `  --cache-dir <dir>                 Cache directory (default: ${cacheDefault})`,
    '  --force, --refresh, --no-cache    Bypass cache and recompute OCR',
    '  --json                            Emit structured JSON summary',
    '  -h, --help                        Show this help message',
  ].join('\n');
}

function parsePositiveTimeout(raw: string): number {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed.length === 0 || !Number.isFinite(parsed) || parsed <= 0) {
    throw new CliValidationError(
      `Invalid --timeout '${raw}': must be a finite positive number in seconds.`
    );
  }
  return parsed;
}

function parsePositiveWorkers(raw: string, flagName: string): number {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new CliValidationError(`Invalid ${flagName} '${raw}': must be a positive integer.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliValidationError(`Invalid ${flagName} '${raw}': must be a positive integer.`);
  }
  return Math.min(parsed, MAX_WORKERS_CAP);
}

function parsePsm(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new CliValidationError(`Invalid --psm '${raw}': must be an integer (0-13).`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 13) {
    throw new CliValidationError(`Invalid --psm '${raw}': must be between 0 and 13.`);
  }
  return parsed;
}

function parseMaxDim(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new CliValidationError(
      `Invalid --max-dim '${raw}': must be a non-negative integer in pixels.`
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliValidationError(
      `Invalid --max-dim '${raw}': must be a non-negative integer in pixels.`
    );
  }
  return parsed;
}

function parseModeValue(raw: string): OcrMode {
  if (raw === 'printed' || raw === 'cursive') {
    return raw;
  }
  throw new CliValidationError(`Invalid --mode '${raw}': choose from ${VALID_MODES.join(', ')}.`);
}

function parseEffortValue(raw: string): CursiveEffort {
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh') {
    return raw;
  }
  throw new CliValidationError(
    `Invalid --effort '${raw}': choose from ${VALID_EFFORTS.join(', ')}.`
  );
}

function parseProviderValue(raw: string): CursiveProvider {
  if (raw === 'auto' || raw === 'cli' || raw === 'gemini') {
    return raw;
  }
  throw new CliValidationError(
    `Invalid --provider '${raw}': choose from ${VALID_PROVIDERS.join(', ')}.`
  );
}

export function parseOcrArgs(argv: readonly string[]): ParsedOcrOptions {
  const images: string[] = [];
  let mode: OcrMode = 'printed';
  let provider: CursiveProvider = 'auto';
  let psm = 6;
  let effort: CursiveEffort = DEFAULT_CURSIVE_EFFORT;
  let cacheDir: string | undefined;
  let timeout: number | undefined;
  let workers = DEFAULT_MAX_WORKERS;
  let maxDim = DEFAULT_PRINTED_MAX_DIM;
  let prompt: string | undefined;
  let force = false;
  let json = false;
  let boxes = false;
  let tsv = false;
  let find: string | undefined;

  const shortAliases: Record<string, string> = {
    '-m': '--mode',
    '-t': '--timeout',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      return {
        helpRequested: true,
        images,
        mode,
        provider,
        psm,
        effort,
        cacheDir,
        timeout,
        workers,
        maxDim,
        prompt,
        force,
        json,
        boxes,
        tsv,
        find,
      };
    }
    if (arg === '--force' || arg === '--refresh' || arg === '--no-cache') {
      force = true;
      continue;
    }
    if (arg === '--printed') {
      mode = 'printed';
      continue;
    }
    if (arg === '--cursive') {
      mode = 'cursive';
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--boxes') {
      boxes = true;
      continue;
    }
    if (arg === '--tsv') {
      tsv = true;
      continue;
    }
    if (arg === '--') {
      images.push(...argv.slice(i + 1));
      break;
    }

    let normalized = arg;
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const shortKey = arg.slice(0, eqIdx);
        const shortVal = arg.slice(eqIdx + 1);
        if (shortKey in shortAliases) {
          normalized = `${shortAliases[shortKey]}=${shortVal}`;
        } else {
          throw new CliValidationError(`Unknown option: ${arg}`);
        }
      } else if (arg in shortAliases) {
        normalized = shortAliases[arg];
      } else if (!fs.existsSync(arg)) {
        throw new CliValidationError(`Unknown option: ${arg}`);
      }
    }

    if (normalized.startsWith('--')) {
      const eqIdx = normalized.indexOf('=');
      let key: string;
      let val: string;
      if (eqIdx !== -1) {
        key = normalized.slice(0, eqIdx);
        val = normalized.slice(eqIdx + 1);
      } else {
        key = normalized;
        if (i + 1 >= argv.length) {
          throw new CliValidationError(`Option ${key} requires a value.`);
        }
        i += 1;
        val = argv[i];
      }

      switch (key) {
        case '--mode':
          mode = parseModeValue(val);
          break;
        case '--provider':
          provider = parseProviderValue(val);
          break;
        case '--psm':
          psm = parsePsm(val);
          break;
        case '--effort':
          effort = parseEffortValue(val);
          break;
        case '--cache-dir':
          cacheDir = val;
          break;
        case '--timeout':
          timeout = parsePositiveTimeout(val);
          break;
        case '--workers':
        case '--concurrency':
          workers = parsePositiveWorkers(val, key);
          break;
        case '--max-dim':
          maxDim = parseMaxDim(val);
          break;
        case '--prompt':
          prompt = val;
          break;
        case '--find':
          try {
            new RegExp(val, 'i');
          } catch (err: unknown) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new CliValidationError(`Invalid --find regex '${val}': ${detail}`);
          }
          find = val;
          boxes = true;
          break;
        default:
          throw new CliValidationError(`Unknown option: ${key}`);
      }
      continue;
    }

    images.push(arg);
  }

  if (images.length === 0) {
    throw new CliValidationError('Missing required positional argument: <image>.');
  }
  if (boxes && tsv) {
    throw new CliValidationError('--tsv cannot be combined with --boxes or --find.');
  }
  if ((boxes || tsv) && mode !== 'printed') {
    throw new CliValidationError('--boxes, --tsv, and --find require --mode printed.');
  }

  return {
    helpRequested: false,
    images,
    mode,
    provider,
    psm,
    effort,
    cacheDir,
    timeout,
    workers,
    maxDim,
    prompt,
    force,
    json,
    boxes,
    tsv,
    find,
  };
}

export function parseOcrBatchArgs(argv: readonly string[]): ParsedBatchOptions {
  const inputs: string[] = [];
  let grep: string | undefined;
  let ignoreCase = false;
  let concurrency = DEFAULT_MAX_WORKERS;
  let timeout: number | undefined;
  let mode: OcrMode = 'printed';
  let provider: CursiveProvider = 'auto';
  let psm = 6;
  let effort: CursiveEffort = DEFAULT_CURSIVE_EFFORT;
  let prompt: string | undefined;
  let maxDim = DEFAULT_PRINTED_MAX_DIM;
  let cacheDir: string | undefined;
  let force = false;
  let json = false;

  const shortAliases: Record<string, string> = {
    '-m': '--mode',
    '-t': '--timeout',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      return {
        helpRequested: true,
        inputs,
        grep,
        ignoreCase,
        concurrency,
        timeout,
        mode,
        provider,
        psm,
        effort,
        prompt,
        maxDim,
        cacheDir,
        force,
        json,
      };
    }
    if (arg === '-i' || arg === '--ignore-case') {
      ignoreCase = true;
      continue;
    }
    if (arg === '--force' || arg === '--refresh' || arg === '--no-cache') {
      force = true;
      continue;
    }
    if (arg === '--printed') {
      mode = 'printed';
      continue;
    }
    if (arg === '--cursive') {
      mode = 'cursive';
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--') {
      inputs.push(...argv.slice(i + 1));
      break;
    }

    let normalized = arg;
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const shortKey = arg.slice(0, eqIdx);
        const shortVal = arg.slice(eqIdx + 1);
        if (shortKey in shortAliases) {
          normalized = `${shortAliases[shortKey]}=${shortVal}`;
        } else {
          throw new CliValidationError(`Unknown option: ${arg}`);
        }
      } else if (arg in shortAliases) {
        normalized = shortAliases[arg];
      } else if (!fs.existsSync(arg)) {
        throw new CliValidationError(`Unknown option: ${arg}`);
      }
    }

    if (normalized.startsWith('--')) {
      const eqIdx = normalized.indexOf('=');
      let key: string;
      let val: string;
      if (eqIdx !== -1) {
        key = normalized.slice(0, eqIdx);
        val = normalized.slice(eqIdx + 1);
      } else {
        key = normalized;
        if (i + 1 >= argv.length) {
          throw new CliValidationError(`Option ${key} requires a value.`);
        }
        i += 1;
        val = argv[i];
      }

      switch (key) {
        case '--grep':
          try {
            new RegExp(val);
          } catch (err: unknown) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new CliValidationError(`Invalid --grep regex '${val}': ${detail}`);
          }
          grep = val;
          break;
        case '--concurrency':
        case '--workers':
          concurrency = parsePositiveWorkers(val, key);
          break;
        case '--timeout':
          timeout = parsePositiveTimeout(val);
          break;
        case '--mode':
          mode = parseModeValue(val);
          break;
        case '--provider':
          provider = parseProviderValue(val);
          break;
        case '--psm':
          psm = parsePsm(val);
          break;
        case '--effort':
          effort = parseEffortValue(val);
          break;
        case '--prompt':
          prompt = val;
          break;
        case '--max-dim':
          maxDim = parseMaxDim(val);
          break;
        case '--cache-dir':
          cacheDir = val;
          break;
        default:
          throw new CliValidationError(`Unknown option: ${key}`);
      }
      continue;
    }

    inputs.push(arg);
  }

  if (inputs.length === 0) {
    throw new CliValidationError('Missing required positional argument: <glob-or-dir>.');
  }

  return {
    helpRequested: false,
    inputs,
    grep,
    ignoreCase,
    concurrency,
    timeout,
    mode,
    provider,
    psm,
    effort,
    prompt,
    maxDim,
    cacheDir,
    force,
    json,
  };
}

function readJpegDimensions(data: Buffer): readonly [number, number] | null {
  const n = data.length;
  if (n < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return null;
  }
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let pos = 2;
  while (pos < n) {
    while (pos < n && data[pos] !== 0xff) {
      pos += 1;
    }
    while (pos < n && data[pos] === 0xff) {
      pos += 1;
    }
    if (pos >= n) {
      break;
    }
    const marker = data[pos];
    pos += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (pos + 2 > n) {
      break;
    }
    const segLen = data.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > n) {
      break;
    }
    if (sofMarkers.has(marker)) {
      if (pos + 7 > n) {
        return null;
      }
      const height = data.readUInt16BE(pos + 3);
      const width = data.readUInt16BE(pos + 5);
      return width > 0 && height > 0 ? [width, height] : null;
    }
    pos += segLen;
  }
  return null;
}

function readTiffDimensions(data: Buffer): readonly [number, number] | null {
  if (data.length < 8) {
    return null;
  }
  let littleEndian: boolean;
  if (data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00) {
    littleEndian = true;
  } else if (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a) {
    littleEndian = false;
  } else {
    return null;
  }
  const readU16 = (off: number): number =>
    littleEndian ? data.readUInt16LE(off) : data.readUInt16BE(off);
  const readU32 = (off: number): number =>
    littleEndian ? data.readUInt32LE(off) : data.readUInt32BE(off);

  const ifdOffset = readU32(4);
  if (ifdOffset + 2 > data.length) {
    return null;
  }
  const numEntries = readU16(ifdOffset);
  let width: number | null = null;
  let height: number | null = null;
  let pos = ifdOffset + 2;
  for (let i = 0; i < numEntries; i += 1) {
    if (pos + 12 > data.length) {
      break;
    }
    const tag = readU16(pos);
    const fieldType = readU16(pos + 2);
    const count = readU32(pos + 4);
    if ((tag === 256 || tag === 257) && count >= 1) {
      let val: number | null = null;
      if (fieldType === 3) {
        val = readU16(pos + 8);
      } else if (fieldType === 4) {
        val = readU32(pos + 8);
      }
      if (val !== null) {
        if (tag === 256) {
          width = val;
        } else {
          height = val;
        }
      }
      if (width !== null && height !== null) {
        return width > 0 && height > 0 ? [width, height] : null;
      }
    }
    pos += 12;
  }
  return null;
}

function readWebpDimensions(data: Buffer): readonly [number, number] | null {
  if (
    data.length < 30 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const chunk = data.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && data.length >= 30) {
    const width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
    const height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
    return [width, height];
  }
  if (
    chunk === 'VP8 ' &&
    data.length >= 30 &&
    data[23] === 0x9d &&
    data[24] === 0x01 &&
    data[25] === 0x2a
  ) {
    const width = data.readUInt16LE(26) & 0x3fff;
    const height = data.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? [width, height] : null;
  }
  if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return [width, height];
  }
  return null;
}

export function readImageDimensions(rawBytes: Buffer): readonly [number, number] | null {
  if (
    rawBytes.length >= 24 &&
    rawBytes[0] === 0x89 &&
    rawBytes[1] === 0x50 &&
    rawBytes[2] === 0x4e &&
    rawBytes[3] === 0x47 &&
    rawBytes[4] === 0x0d &&
    rawBytes[5] === 0x0a &&
    rawBytes[6] === 0x1a &&
    rawBytes[7] === 0x0a
  ) {
    const w = rawBytes.readUInt32BE(16);
    const h = rawBytes.readUInt32BE(20);
    return w > 0 && h > 0 ? [w, h] : null;
  }
  if (rawBytes.length >= 10) {
    const sig6 = rawBytes.toString('ascii', 0, 6);
    if (sig6 === 'GIF87a' || sig6 === 'GIF89a') {
      const w = rawBytes.readUInt16LE(6);
      const h = rawBytes.readUInt16LE(8);
      return w > 0 && h > 0 ? [w, h] : null;
    }
  }
  if (rawBytes.length >= 26 && rawBytes[0] === 0x42 && rawBytes[1] === 0x4d) {
    const w = Math.abs(rawBytes.readInt32LE(18));
    const h = Math.abs(rawBytes.readInt32LE(22));
    return w > 0 && h > 0 ? [w, h] : null;
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 0xff && rawBytes[1] === 0xd8) {
    return readJpegDimensions(rawBytes);
  }
  if (
    rawBytes.length >= 4 &&
    ((rawBytes[0] === 0x49 && rawBytes[1] === 0x49 && rawBytes[2] === 0x2a && rawBytes[3] === 0x00) ||
      (rawBytes[0] === 0x4d && rawBytes[1] === 0x4d && rawBytes[2] === 0x00 && rawBytes[3] === 0x2a))
  ) {
    return readTiffDimensions(rawBytes);
  }
  if (
    rawBytes.length >= 12 &&
    rawBytes.toString('ascii', 0, 4) === 'RIFF' &&
    rawBytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return readWebpDimensions(rawBytes);
  }
  return null;
}

export function validateImageFile(imgPath: string): Buffer {
  if (!fs.existsSync(imgPath)) {
    throw new InputImageError(`image file not found: ${imgPath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(imgPath);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new InputImageError(`cannot read image file ${imgPath}: ${detail}`);
  }
  if (!stat.isFile()) {
    throw new InputImageError(`image path is not a regular file: ${imgPath}`);
  }
  let rawBytes: Buffer;
  try {
    rawBytes = fs.readFileSync(imgPath);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new InputImageError(`cannot read image file ${imgPath}: ${detail}`);
  }
  if (rawBytes.length === 0) {
    throw new InputImageError(`image file is empty (0 bytes): ${imgPath}`);
  }
  const headText = rawBytes
    .subarray(0, Math.min(512, rawBytes.length))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/^[ \t\r\n]+/, '');
  if (headText.startsWith('%PDF-')) {
    throw new InputImageError(
      `file is a PDF, not an image: ${imgPath} (render pages first with 'kinloom prep-scan pdf-pages').`
    );
  }
  const headLower = headText.toLowerCase();
  if (HTML_SNIFF_PREFIXES.some((prefix) => headLower.startsWith(prefix))) {
    throw new InputImageError(`file is HTML, not an image: ${imgPath}`);
  }
  return rawBytes;
}

export function rescaleTesseractTsv(
  tsv: string,
  origWidth: number,
  origHeight: number,
  scaledWidth: number,
  scaledHeight: number
): string {
  if (
    origWidth <= 0 ||
    origHeight <= 0 ||
    scaledWidth <= 0 ||
    scaledHeight <= 0 ||
    (origWidth === scaledWidth && origHeight === scaledHeight)
  ) {
    return tsv;
  }

  const lines = tsv.split(/\r?\n/);
  if (lines.length === 0 || !lines[0]) {
    return tsv;
  }
  const header = lines[0].split('\t');
  const idxLevel = header.indexOf('level');
  const idxLeft = header.indexOf('left');
  const idxTop = header.indexOf('top');
  const idxWidth = header.indexOf('width');
  const idxHeight = header.indexOf('height');
  if (
    idxLevel === -1 ||
    idxLeft === -1 ||
    idxTop === -1 ||
    idxWidth === -1 ||
    idxHeight === -1
  ) {
    return tsv;
  }
  const minCols = Math.max(idxLevel, idxLeft, idxTop, idxWidth, idxHeight) + 1;
  const sx = origWidth / scaledWidth;
  const sy = origHeight / scaledHeight;
  const outLines: string[] = [lines[0]];

  for (let i = 1; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (!rawLine.trim()) {
      continue;
    }
    const cols = rawLine.split('\t');
    if (cols.length < minCols) {
      outLines.push(rawLine);
      continue;
    }
    const level = Number.parseInt(cols[idxLevel], 10);
    const left = Number.parseInt(cols[idxLeft], 10);
    const top = Number.parseInt(cols[idxTop], 10);
    const width = Number.parseInt(cols[idxWidth], 10);
    const height = Number.parseInt(cols[idxHeight], 10);
    if (
      !Number.isFinite(level) ||
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      outLines.push(rawLine);
      continue;
    }

    if (level === 1) {
      cols[idxLeft] = '0';
      cols[idxTop] = '0';
      cols[idxWidth] = String(origWidth);
      cols[idxHeight] = String(origHeight);
    } else {
      const x0 = Math.max(0, Math.min(origWidth, Math.round(left * sx)));
      const y0 = Math.max(0, Math.min(origHeight, Math.round(top * sy)));
      const x1 = Math.max(x0, Math.min(origWidth, Math.round((left + width) * sx)));
      const y1 = Math.max(y0, Math.min(origHeight, Math.round((top + height) * sy)));
      let newW = x1 - x0;
      let newH = y1 - y0;
      if (width > 0 && newW === 0 && x0 < origWidth) {
        newW = 1;
      }
      if (height > 0 && newH === 0 && y0 < origHeight) {
        newH = 1;
      }
      cols[idxLeft] = String(x0);
      cols[idxTop] = String(y0);
      cols[idxWidth] = String(newW);
      cols[idxHeight] = String(newH);
    }
    outLines.push(cols.join('\t'));
  }

  const trailing = tsv.endsWith('\n') ? '\n' : '';
  return `${outLines.join('\n')}${trailing}`;
}

export function parseTesseractTsv(tsv: string): ParsedTsvLayout {
  const rows = tsv
    .split(/\r?\n/)
    .filter((row) => row.trim().length > 0)
    .map((row) => row.split('\t'));

  if (rows.length === 0 || rows[0][0] !== 'level') {
    throw new Error('tesseract TSV output is missing its header row.');
  }

  const header = rows[0];
  let imageWidth = 0;
  let imageHeight = 0;
  const lineMap = new Map<
    string,
    {
      readonly page: number;
      readonly block: number;
      readonly par: number;
      readonly line: number;
      readonly words: OcrWordBox[];
    }
  >();

  for (let i = 1; i < rows.length; i += 1) {
    const raw = rows[i];
    if (raw.length < header.length - 1) {
      continue;
    }
    const rec: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      rec[header[c]] = raw[c] ?? '';
    }
    const level = Number.parseInt(rec.level ?? '', 10);
    const left = Number.parseInt(rec.left ?? '', 10);
    const top = Number.parseInt(rec.top ?? '', 10);
    const width = Number.parseInt(rec.width ?? '', 10);
    const height = Number.parseInt(rec.height ?? '', 10);
    const right = left + width;
    const bottom = top + height;

    if (level === 1) {
      imageWidth = Math.max(imageWidth, right);
      imageHeight = Math.max(imageHeight, bottom);
      continue;
    }
    const text = (rec.text ?? '').trim();
    if (level !== 5 || !text) {
      continue;
    }
    const conf = Number.parseFloat(rec.conf ?? '-1');
    const page = Number.parseInt(rec.page_num ?? '0', 10);
    const block = Number.parseInt(rec.block_num ?? '0', 10);
    const par = Number.parseInt(rec.par_num ?? '0', 10);
    const lineNum = Number.parseInt(rec.line_num ?? '0', 10);
    const key = `${page}:${block}:${par}:${lineNum}`;
    let group = lineMap.get(key);
    if (!group) {
      group = { page, block, par, line: lineNum, words: [] };
      lineMap.set(key, group);
    }
    group.words.push({
      text,
      x0: left,
      y0: top,
      x1: right,
      y1: bottom,
      conf,
    });
  }

  const outLines: OcrLineBox[] = [];
  for (const group of lineMap.values()) {
    const { words, page, block, par, line } = group;
    const validConfs = words.map((w) => w.conf).filter((c) => c >= 0);
    const avgConf =
      validConfs.length > 0
        ? Math.round((validConfs.reduce((a, b) => a + b, 0) / validConfs.length) * 100) / 100
        : -1;
    outLines.push({
      text: words.map((w) => w.text).join(' '),
      x0: Math.min(...words.map((w) => w.x0)),
      y0: Math.min(...words.map((w) => w.y0)),
      x1: Math.max(...words.map((w) => w.x1)),
      y1: Math.max(...words.map((w) => w.y1)),
      conf: avgConf,
      page,
      block,
      par,
      line,
      words,
    });
  }

  return {
    image_width: imageWidth,
    image_height: imageHeight,
    lines: outLines,
  };
}

export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv
): string | null {
  if (name.includes(path.sep) || (process.platform === 'win32' && name.includes('/'))) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return fs.statSync(name).isFile() ? name : null;
    } catch {
      return null;
    }
  }
  const pathVar = env.PATH ?? process.env.PATH ?? '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Try next PATH entry.
    }
  }
  return null;
}

function isTesseractInvalidImageError(detail: string): boolean {
  const lowered = detail.toLowerCase();
  return TESSERACT_INVALID_IMAGE_MARKERS.some((marker) => lowered.includes(marker));
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 0) {
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to killing the child pid directly.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited.
  }
}

async function runSubprocessWithTimeout(params: {
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutSeconds: number;
  readonly fileForError: string;
  readonly timeoutLabel: string;
  readonly execFileImpl?: ExecFileFn;
}): Promise<SubprocessOutput> {
  const { bin, args, env, cwd, timeoutSeconds, fileForError, timeoutLabel, execFileImpl } = params;
  const timeoutMs = Math.max(10, Math.round(timeoutSeconds * 1000));

  if (execFileImpl) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const execPromise = execFileImpl(bin, args, {
        env,
        cwd,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new OcrTimeoutError(
              `${timeoutLabel} timed out after ${timeoutSeconds}s on ${path.basename(fileForError)} ` +
                '(increase --timeout or use --mode cursive for handwritten pages).',
              timeoutSeconds,
              fileForError
            )
          );
        }, timeoutMs);
        timer.unref();
      });
      const res = await Promise.race([execPromise, timeoutPromise]);
      return {
        exitCode: 0,
        stdout: res.stdout.toString('utf8'),
        stderr: res.stderr.toString('utf8'),
      };
    } catch (err: unknown) {
      if (err instanceof OcrTimeoutError) {
        throw err;
      }
      if (isPlainRecord(err)) {
        const killed = err.killed === true;
        const signal = typeof err.signal === 'string' ? err.signal : undefined;
        const code = err.code;
        if (killed || signal === 'SIGKILL' || signal === 'SIGTERM' || code === 'ETIMEDOUT') {
          throw new OcrTimeoutError(
            `${timeoutLabel} timed out after ${timeoutSeconds}s on ${path.basename(fileForError)} ` +
              '(increase --timeout or use --mode cursive for handwritten pages).',
            timeoutSeconds,
            fileForError
          );
        }
        if (typeof code === 'number') {
          const outBuf = err.stdout;
          const errBuf = err.stderr;
          const stdout = Buffer.isBuffer(outBuf)
            ? outBuf.toString('utf8')
            : typeof outBuf === 'string'
              ? outBuf
              : '';
          const stderr = Buffer.isBuffer(errBuf)
            ? errBuf.toString('utf8')
            : typeof errBuf === 'string'
              ? errBuf
              : err instanceof Error
                ? err.message
                : '';
          return { exitCode: code, stdout, stderr };
        }
      }
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return new Promise<SubprocessOutput>((resolve, reject) => {
    const child = spawn(bin, [...args], {
      env,
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanupTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (killEscalationTimer !== undefined) {
        clearTimeout(killEscalationTimer);
      }
    };

    const timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      killProcessTree(child.pid, 'SIGTERM');
      killEscalationTimer = setTimeout(() => {
        killProcessTree(child.pid, 'SIGKILL');
        if (!settled) {
          settled = true;
          reject(
            new OcrTimeoutError(
              `${timeoutLabel} timed out after ${timeoutSeconds}s on ${path.basename(fileForError)} ` +
                '(increase --timeout or use --mode cursive for handwritten pages).',
              timeoutSeconds,
              fileForError
            )
          );
        }
      }, 250);
      killEscalationTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      if (timedOut) {
        reject(
          new OcrTimeoutError(
            `${timeoutLabel} timed out after ${timeoutSeconds}s on ${path.basename(fileForError)} ` +
              '(increase --timeout or use --mode cursive for handwritten pages).',
            timeoutSeconds,
            fileForError
          )
        );
        return;
      }
      resolve({
        exitCode: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function preparePrintedImage(
  imgPath: string,
  rawBytes: Buffer,
  workDir: string,
  maxDim: number
): Promise<{
  readonly sendPath: string;
  readonly cleanupDir: string | null;
  readonly scaleInfo: ScaleInfo | null;
}> {
  if (maxDim <= 0) {
    return { sendPath: imgPath, cleanupDir: null, scaleInfo: null };
  }
  const dims = readImageDimensions(rawBytes);
  if (dims === null) {
    return { sendPath: imgPath, cleanupDir: null, scaleInfo: null };
  }
  const [origW, origH] = dims;
  if (origW <= 0 || origH <= 0 || Math.max(origW, origH) <= maxDim) {
    return { sendPath: imgPath, cleanupDir: null, scaleInfo: null };
  }

  workSeq += 1;
  const jobDir = path.join(
    workDir,
    `printed_${process.pid}_${workSeq}_${process.hrtime.bigint()}`
  );
  try {
    const downscaled = await downscaleForOcr(imgPath, maxDim);
    if (!downscaled.downscaled || downscaled.width <= 0 || downscaled.height <= 0) {
      return { sendPath: imgPath, cleanupDir: null, scaleInfo: null };
    }
    fs.mkdirSync(jobDir, { recursive: true });
    const outPath = path.join(jobDir, 'scaled.png');
    fs.writeFileSync(outPath, downscaled.buffer);
    return {
      sendPath: outPath,
      cleanupDir: jobDir,
      scaleInfo: {
        original_width: downscaled.origWidth,
        original_height: downscaled.origHeight,
        scaled_width: downscaled.width,
        scaled_height: downscaled.height,
      },
    };
  } catch {
    fs.rmSync(jobDir, { recursive: true, force: true });
    return { sendPath: imgPath, cleanupDir: null, scaleInfo: null };
  }
}

async function runPrintedOcr(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly psm: number;
  readonly timeoutSeconds: number;
  readonly tsv: boolean;
  readonly workDir: string;
  readonly maxDim: number;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly output: string; readonly meta: Record<string, unknown> }> {
  const { imgPath, rawBytes, psm, timeoutSeconds, tsv, workDir, maxDim, ctx } = params;

  const tesseractBin = ctx.execFileImpl
    ? 'tesseract'
    : resolveExecutable('tesseract', ctx.env);
  if (!tesseractBin) {
    throw new Error(
      'tesseract executable not found on PATH. Install tesseract-ocr ' +
        '(for example `apt install tesseract-ocr` or `brew install tesseract`).'
    );
  }

  const prepared = await preparePrintedImage(imgPath, rawBytes, workDir, maxDim);
  try {
    // Mandatory single-threaded OpenMP env so parallel OCR never thrashes CPU cores.
    const tesseractEnv: NodeJS.ProcessEnv = {
      ...ctx.env,
      OMP_THREAD_LIMIT: '1',
      OMP_NUM_THREADS: '1',
    };
    const tessArgs = [
      prepared.sendPath,
      'stdout',
      '--psm',
      String(psm),
      ...(tsv ? ['tsv'] : []),
    ];
    const proc = await runSubprocessWithTimeout({
      bin: tesseractBin,
      args: tessArgs,
      env: tesseractEnv,
      timeoutSeconds,
      fileForError: imgPath,
      timeoutLabel: 'tesseract',
      execFileImpl: ctx.execFileImpl,
    });

    if (proc.exitCode !== 0) {
      const detail = (proc.stderr || proc.stdout).trim();
      if (isTesseractInvalidImageError(detail)) {
        throw new InputImageError(
          `invalid or unreadable image ${path.basename(imgPath)}: ${detail.slice(0, 300)}`
        );
      }
      throw new Error(`tesseract exited ${proc.exitCode}: ${detail.slice(0, 300)}`);
    }

    let out = tsv ? proc.stdout : proc.stdout.trim();
    if (tsv && prepared.scaleInfo !== null) {
      out = rescaleTesseractTsv(
        out,
        prepared.scaleInfo.original_width,
        prepared.scaleInfo.original_height,
        prepared.scaleInfo.scaled_width,
        prepared.scaleInfo.scaled_height
      );
    }
    const meta: Record<string, unknown> = {
      psm,
      omp_thread_limit: 1,
      timeout_s: timeoutSeconds,
    };
    if (prepared.scaleInfo !== null) {
      meta.downscaled = true;
      meta.original_size = [
        prepared.scaleInfo.original_width,
        prepared.scaleInfo.original_height,
      ];
      meta.scaled_size = [prepared.scaleInfo.scaled_width, prepared.scaleInfo.scaled_height];
    }
    return { output: out, meta };
  } finally {
    if (prepared.cleanupDir !== null) {
      fs.rmSync(prepared.cleanupDir, { recursive: true, force: true });
    }
  }
}

function inferImageMimeType(filePath: string, rawBytes: Buffer): string {
  if (
    rawBytes.length >= 8 &&
    rawBytes[0] === 0x89 &&
    rawBytes[1] === 0x50 &&
    rawBytes[2] === 0x4e &&
    rawBytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 0xff && rawBytes[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (
    rawBytes.length >= 12 &&
    rawBytes.toString('ascii', 0, 4) === 'RIFF' &&
    rawBytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/jpeg';
}

async function prepareCursiveBuffer(
  imgPath: string,
  rawBytes: Buffer
): Promise<{ readonly buffer: Buffer; readonly mimeType: string; readonly downscaled: boolean }> {
  if (rawBytes.length <= CURSIVE_MAX_INPUT_BYTES) {
    return {
      buffer: rawBytes,
      mimeType: inferImageMimeType(imgPath, rawBytes),
      downscaled: false,
    };
  }
  try {
    const res = await downscaleForCursiveOcr(imgPath, {
      triggerBytes: CURSIVE_MAX_INPUT_BYTES,
      targetKb: CURSIVE_TARGET_KB,
      maxWidth: CURSIVE_TARGET_MAX_WIDTH,
    });
    return {
      buffer: res.buffer,
      mimeType: res.downscaled ? 'image/jpeg' : inferImageMimeType(imgPath, res.buffer),
      downscaled: res.downscaled,
    };
  } catch {
    return {
      buffer: rawBytes,
      mimeType: inferImageMimeType(imgPath, rawBytes),
      downscaled: false,
    };
  }
}

async function runCursiveGeminiOcr(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly effort: CursiveEffort;
  readonly timeoutSeconds: number;
  readonly customPrompt?: string;
  readonly apiKey: string;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly text: string; readonly meta: Record<string, unknown>; readonly engine: string }> {
  const { imgPath, rawBytes, effort, timeoutSeconds, customPrompt, apiKey, ctx } = params;
  const model = (ctx.env.KINLOOM_OCR_MODEL ?? '').trim() || DEFAULT_CURSIVE_GEMINI_MODEL;
  const prepared = await prepareCursiveBuffer(imgPath, rawBytes);
  const prompt = customPrompt
    ? customPrompt.replaceAll('{image_path}', path.basename(imgPath))
    : DEFAULT_GEMINI_CURSIVE_PROMPT;

  const controller = new AbortController();
  const timeoutMs = Math.max(10, Math.round(timeoutSeconds * 1000));
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timer.unref();

  try {
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
    const response = await ctx.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: prepared.mimeType,
                  data: prepared.buffer.toString('base64'),
                },
              },
              { text: prompt },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`gemini OCR HTTP ${response.status}: ${bodyText.slice(0, 400)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error(`gemini OCR returned non-JSON response: ${bodyText.slice(0, 300)}`);
    }
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
      throw new Error('gemini OCR returned no candidates.');
    }
    const firstCandidate = parsed.candidates[0];
    const content = isPlainRecord(firstCandidate) ? firstCandidate.content : undefined;
    const parts = isPlainRecord(content) && Array.isArray(content.parts) ? content.parts : [];
    const text = parts
      .map((part) => (isPlainRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (!text) {
      throw new Error('gemini OCR returned an empty transcription response.');
    }
    const usage = isPlainRecord(parsed.usageMetadata) ? parsed.usageMetadata : {};
    return {
      text,
      engine: `gemini:${model}`,
      meta: {
        provider: 'gemini',
        model,
        effort,
        sent_bytes: prepared.buffer.length,
        downscaled: prepared.downscaled,
        total_tokens: typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : undefined,
      },
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OcrTimeoutError(
        `gemini timed out after ${timeoutSeconds}s on ${path.basename(imgPath)} ` +
          '(pass a higher --timeout to override).',
        timeoutSeconds,
        imgPath
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function runCursiveCliOcr(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly effort: CursiveEffort;
  readonly timeoutSeconds: number;
  readonly cacheDir: string;
  readonly customPrompt?: string;
  readonly cliName: string;
  readonly cliBin: string;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly text: string; readonly meta: Record<string, unknown>; readonly engine: string }> {
  const {
    imgPath,
    rawBytes,
    effort,
    timeoutSeconds,
    cacheDir,
    customPrompt,
    cliName,
    cliBin,
    ctx,
  } = params;

  const model = (ctx.env.KINLOOM_OCR_MODEL ?? '').trim() || `gemini-4-hydrogen-${effort}`;
  const prepared = await prepareCursiveBuffer(imgPath, rawBytes);

  let sendPath = imgPath;
  let cleanupDir: string | null = null;
  if (prepared.downscaled) {
    workSeq += 1;
    cleanupDir = path.join(
      cacheDir,
      '.work',
      `cursive_${process.pid}_${workSeq}_${process.hrtime.bigint()}`
    );
    fs.mkdirSync(cleanupDir, { recursive: true });
    sendPath = path.join(cleanupDir, 'preview.jpg');
    fs.writeFileSync(sendPath, prepared.buffer);
  }

  try {
    const template = customPrompt ?? DEFAULT_CURSIVE_PROMPT;
    const prompt = template.includes('{image_path}')
      ? template.replaceAll('{image_path}', sendPath)
      : `Call read_file ONCE on ${sendPath}. ${template}`;
    const addDir = path.dirname(sendPath);
    const cliArgs = [
      '--model',
      model,
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--add-dir',
      addDir,
      '--output-format',
      'json',
      '--print-timeout',
      `${timeoutSeconds}s`,
      `-p=${prompt}`,
    ];

    const proc = await runSubprocessWithTimeout({
      bin: cliBin,
      args: cliArgs,
      env: ctx.env,
      cwd: addDir,
      timeoutSeconds,
      fileForError: imgPath,
      timeoutLabel: cliName,
      execFileImpl: ctx.execFileImpl,
    });

    if (proc.exitCode !== 0) {
      const detail = (proc.stderr || proc.stdout).trim();
      throw new Error(`${cliName} exited ${proc.exitCode}: ${detail.slice(0, 400)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(proc.stdout);
    } catch {
      throw new Error(`${cliName} returned non-JSON stdout: ${proc.stdout.slice(0, 300)}`);
    }
    if (!isPlainRecord(payload) || payload.status !== 'SUCCESS') {
      const status = isPlainRecord(payload) ? String(payload.status) : 'unknown';
      throw new Error(`${cliName} returned status=${status}: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    const text = typeof payload.response === 'string' ? payload.response.trim() : '';
    if (!text) {
      throw new Error(`${cliName} returned an empty transcription response.`);
    }
    const usage = isPlainRecord(payload.usage) ? payload.usage : {};
    return {
      text,
      engine: `${cliName}:${model}`,
      meta: {
        cli: cliName,
        model,
        effort,
        sent_bytes: prepared.buffer.length,
        duration_seconds: payload.duration_seconds,
        thinking_tokens: usage.thinking_tokens,
        output_tokens: usage.output_tokens,
      },
    };
  } finally {
    if (cleanupDir !== null) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    }
  }
}

async function runCursiveOcr(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly effort: CursiveEffort;
  readonly provider: CursiveProvider;
  readonly timeoutSeconds: number;
  readonly cacheDir: string;
  readonly customPrompt?: string;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly text: string; readonly meta: Record<string, unknown>; readonly engine: string }> {
  const { imgPath, rawBytes, effort, provider, timeoutSeconds, cacheDir, customPrompt, ctx } =
    params;

  const geminiKey = (ctx.env.GEMINI_API_KEY ?? ctx.env.GOOGLE_API_KEY ?? '').trim();
  const cliName = resolveVisionCli(ctx.env);
  const cliBin = ctx.execFileImpl ? cliName : resolveExecutable(cliName, ctx.env);

  if (provider === 'gemini') {
    if (!geminiKey) {
      throw new Error(
        'GEMINI_API_KEY or GOOGLE_API_KEY must be set when using --provider gemini.'
      );
    }
    return runCursiveGeminiOcr({
      imgPath,
      rawBytes,
      effort,
      timeoutSeconds,
      customPrompt,
      apiKey: geminiKey,
      ctx,
    });
  }

  if (provider === 'cli') {
    if (!cliBin) {
      throw new Error(
        `Vision CLI '${cliName}' not found on PATH. Install '${cliName}' ` +
          'or set KINLOOM_OCR_CLI to a compatible vision CLI executable.'
      );
    }
    return runCursiveCliOcr({
      imgPath,
      rawBytes,
      effort,
      timeoutSeconds,
      cacheDir,
      customPrompt,
      cliName,
      cliBin,
      ctx,
    });
  }

  // auto: prefer configured vision CLI if available, otherwise fall back to Gemini API when key is set.
  if (cliBin) {
    return runCursiveCliOcr({
      imgPath,
      rawBytes,
      effort,
      timeoutSeconds,
      cacheDir,
      customPrompt,
      cliName,
      cliBin,
      ctx,
    });
  }
  if (geminiKey) {
    return runCursiveGeminiOcr({
      imgPath,
      rawBytes,
      effort,
      timeoutSeconds,
      customPrompt,
      apiKey: geminiKey,
      ctx,
    });
  }
  throw new Error(
    `Vision CLI '${cliName}' not found on PATH and no GEMINI_API_KEY/GOOGLE_API_KEY is set. ` +
      `Install '${cliName}', set KINLOOM_OCR_CLI, or set GEMINI_API_KEY.`
  );
}

async function runLayoutData(params: {
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
    try {
      if (!fs.statSync(boxesPath).isFile()) {
        return null;
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(boxesPath, 'utf8'));
      if (isPlainRecord(parsed) && Array.isArray(parsed.lines)) {
        return parsed as unknown as OcrLayoutRecord;
      }
      return null;
    } catch {
      return null;
    }
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

async function runOcrData(params: {
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
    try {
      if (!fs.statSync(cacheFile).isFile()) {
        return null;
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (isPlainRecord(parsed) && typeof parsed.text === 'string') {
        return parsed as unknown as OcrTextRecord;
      }
      return null;
    } catch {
      return null;
    }
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

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from<R>({ length: items.length });
  let nextIdx = 0;

  const runners: Promise<void>[] = [];
  for (let w = 0; w < limit; w += 1) {
    runners.push(
      (async () => {
        while (true) {
          const idx = nextIdx;
          nextIdx += 1;
          if (idx >= items.length) {
            return;
          }
          results[idx] = await worker(items[idx], idx);
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
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

async function runOcrBatchCommand(
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
  const grepRegex =
    opts.grep !== undefined ? new RegExp(opts.grep, opts.ignoreCase ? 'i' : '') : undefined;

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
  const allCached = fileResults.length > 0 && succeeded === fileResults.length && cacheHits === fileResults.length;

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

export function createDefaultExecFile(): ExecFileFn {
  return (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        { ...options, encoding: 'buffer' },
        (error, stdout, stderr) => {
          if (error) {
            const errObj = error as Error & { stdout?: Buffer; stderr?: Buffer };
            errObj.stdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
            errObj.stderr = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
            reject(errObj);
            return;
          }
          resolve({
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
            stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
          });
        }
      );
    });
}

export const runOcrCommand: RecordHandler = async (
  args,
  ctx
): Promise<RecordCommandOutcome> => {
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

    const resolvedImages: {
      readonly rawArg: string;
      readonly imgPath: string;
      readonly rawBytes: Buffer;
      readonly sha256HexStr: string;
    }[] = [];

    for (const rawArg of opts.images) {
      const imgPath = path.isAbsolute(rawArg) ? rawArg : path.resolve(ctx.cwd, rawArg);
      const rawBytes = validateImageFile(imgPath);
      const digest = sha256Hex(rawBytes);
      resolvedImages.push({ rawArg, imgPath, rawBytes, sha256HexStr: digest });
    }

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

      if (!multi) {
        const single = completed[0].data;
        if (opts.tsv) {
          const bytesOut = emitStdout(ctx.io, String(single));
          return { exitCode: 0, bytesOut, cacheHit: allCached };
        }
        const bytesOut = emitJsonStdout(ctx.io, single);
        return { exitCode: 0, bytesOut, cacheHit: allCached };
      }

      if (opts.tsv) {
        const sections = completed.map(
          (c) => `=== ${c.rawArg} ===\n${String(c.data).trimEnd()}`
        );
        const bytesOut = emitStdout(ctx.io, sections.join('\n\n'));
        return { exitCode: 0, bytesOut, cacheHit: allCached };
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

    if (!multi) {
      const singleRec = completed[0].record;
      if (opts.json) {
        const bytesOut = emitJsonStdout(ctx.io, singleRec);
        return { exitCode: 0, bytesOut, cacheHit: allCached };
      }
      const bytesOut = emitStdout(ctx.io, singleRec.text);
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
    const bytesOut = emitStdout(ctx.io, sections.join('\n\n'));
    return { exitCode: 0, bytesOut, cacheHit: allCached };
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
