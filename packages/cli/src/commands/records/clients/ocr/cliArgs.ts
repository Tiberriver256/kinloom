import fs from 'node:fs';
import { CliValidationError } from '../../../../errors.js';
import {
  type CursiveEffort,
  type CursiveProvider,
  DEFAULT_CURSIVE_EFFORT,
  DEFAULT_CURSIVE_TIMEOUT_S,
  DEFAULT_MAX_WORKERS,
  DEFAULT_PRINTED_MAX_DIM,
  DEFAULT_PRINTED_TIMEOUT_S,
  MAX_WORKERS_CAP,
  type OcrMode,
  type ParsedBatchOptions,
  type ParsedOcrOptions,
  resolveOcrCacheDir,
  resolveVisionCli,
  VALID_EFFORTS,
  VALID_MODES,
  VALID_PROVIDERS,
} from './types.js';

const SHORT_ALIASES: Record<string, string> = {
  '-m': '--mode',
  '-t': '--timeout',
};

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
    throw new CliValidationError(`Invalid --timeout '${raw}': must be a finite positive number in seconds.`);
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
    throw new CliValidationError(`Invalid --max-dim '${raw}': must be a non-negative integer in pixels.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliValidationError(`Invalid --max-dim '${raw}': must be a non-negative integer in pixels.`);
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
  throw new CliValidationError(`Invalid --effort '${raw}': choose from ${VALID_EFFORTS.join(', ')}.`);
}

function parseProviderValue(raw: string): CursiveProvider {
  if (raw === 'auto' || raw === 'cli' || raw === 'gemini') {
    return raw;
  }
  throw new CliValidationError(`Invalid --provider '${raw}': choose from ${VALID_PROVIDERS.join(', ')}.`);
}

function normalizeShortOption(arg: string): string {
  if (!arg.startsWith('-') || arg.startsWith('--') || arg.length <= 1) {
    return arg;
  }
  const eqIdx = arg.indexOf('=');
  if (eqIdx !== -1) {
    const shortKey = arg.slice(0, eqIdx);
    const shortVal = arg.slice(eqIdx + 1);
    if (shortKey in SHORT_ALIASES) {
      return `${SHORT_ALIASES[shortKey]}=${shortVal}`;
    }
    throw new CliValidationError(`Unknown option: ${arg}`);
  }
  const alias = SHORT_ALIASES[arg];
  if (alias !== undefined) {
    return alias;
  }
  if (!fs.existsSync(arg)) {
    throw new CliValidationError(`Unknown option: ${arg}`);
  }
  return arg;
}

function extractLongOption(
  normalized: string,
  argv: readonly string[],
  index: number
): { readonly key: string; readonly val: string; readonly nextIndex: number } {
  const eqIdx = normalized.indexOf('=');
  if (eqIdx !== -1) {
    return {
      key: normalized.slice(0, eqIdx),
      val: normalized.slice(eqIdx + 1),
      nextIndex: index,
    };
  }
  if (index + 1 >= argv.length) {
    throw new CliValidationError(`Option ${normalized} requires a value.`);
  }
  return {
    key: normalized,
    val: argv[index + 1] ?? '',
    nextIndex: index + 1,
  };
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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
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

    const normalized = normalizeShortOption(arg);
    if (normalized.startsWith('--')) {
      const extracted = extractLongOption(normalized, argv, i);
      i = extracted.nextIndex;
      const { key, val } = extracted;

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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
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

    const normalized = normalizeShortOption(arg);
    if (normalized.startsWith('--')) {
      const extracted = extractLongOption(normalized, argv, i);
      i = extracted.nextIndex;
      const { key, val } = extracted;

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
