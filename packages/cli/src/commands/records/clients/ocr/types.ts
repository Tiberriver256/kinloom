import { CliValidationError } from '../../../../errors.js';
import { resolveCacheDir, sha256Hex } from '../../runtime/cache.js';

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

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const TESSERACT_INVALID_IMAGE_MARKERS: readonly string[] = [
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

export const DEFAULT_GEMINI_CURSIVE_PROMPT =
  'Transcribe verbatim all handwritten cursive text visible on this archival document: ' +
  'first the sheet/page header (state, county, township/city, date, ED/page/sheet numbers), ' +
  'then each legible household/person row with line number, dwelling/family numbers, full name, ' +
  'relation, sex, color/race, age, occupation, property values, and birthplace. Mark genuinely ' +
  'illegible words or characters as [?]; never invent or extrapolate obscured rows.';

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

export interface ScaleInfo {
  readonly original_width: number;
  readonly original_height: number;
  readonly scaled_width: number;
  readonly scaled_height: number;
}

export interface SubprocessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function resolveVisionCli(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.KINLOOM_OCR_CLI ?? '').trim();
  return configured || DEFAULT_VISION_CLI;
}

export function resolveOcrCacheDir(flagValue: string | undefined, env: NodeJS.ProcessEnv): string {
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
