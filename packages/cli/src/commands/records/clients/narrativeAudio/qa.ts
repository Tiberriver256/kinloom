import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  type CommandParseSpec,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  type OptionSpec,
  parseCommandArgs,
} from '../../runtime/args.js';
import { isPlainRecord, resolveUserPathFromContext } from '../../runtime/primitives.js';
import {
  type ExecFileFn,
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { defaultExecFile, findExecutableOnPath } from './synthesis.js';

export interface AudioQaThresholds {
  readonly minDurationSeconds: number;
  readonly maxDurationSeconds: number;
  readonly minRmsDb: number;
  readonly maxPeakDb: number;
}

export interface AudioQaFileResult {
  readonly file: string;
  readonly ok: boolean;
  readonly format: string | null;
  readonly codec: string | null;
  readonly sample_rate: number | null;
  readonly channels: number | null;
  readonly duration_seconds: number | null;
  readonly peak_db: number | null;
  readonly rms_db: number | null;
  readonly issues: readonly string[];
}

export interface AudioQaSummary {
  readonly ok: boolean;
  readonly mode: 'qa';
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly min_duration: number;
  readonly max_duration: number;
  readonly min_rms_db: number;
  readonly max_peak_db: number;
  readonly files: readonly AudioQaFileResult[];
}

export const DEFAULT_QA_MIN_DURATION = 1;
export const DEFAULT_QA_MAX_DURATION = 3600;
export const DEFAULT_QA_MIN_RMS_DB = -50;
export const DEFAULT_QA_MAX_PEAK_DB = -0.1;

export const QA_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'minDuration',
    kind: 'number',
    flags: ['--min-duration'],
    min: 0,
    metavar: 'SECONDS',
    help: `Minimum allowed audio duration in seconds (default: ${DEFAULT_QA_MIN_DURATION}).`,
  },
  {
    key: 'maxDuration',
    kind: 'number',
    flags: ['--max-duration'],
    min: 0,
    metavar: 'SECONDS',
    help: `Maximum allowed audio duration in seconds (default: ${DEFAULT_QA_MAX_DURATION}).`,
  },
  {
    key: 'minRmsDb',
    kind: 'number',
    flags: ['--min-rms-db'],
    metavar: 'DB',
    help: `Minimum overall RMS level in dBFS before flagging silence (default: ${DEFAULT_QA_MIN_RMS_DB}).`,
  },
  {
    key: 'maxPeakDb',
    kind: 'number',
    flags: ['--max-peak-db'],
    metavar: 'DB',
    help: `Maximum overall peak level in dBFS before flagging clipping (default: ${DEFAULT_QA_MAX_PEAK_DB}).`,
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit structured JSON output.',
  },
];

export const QA_PARSE_SPEC: CommandParseSpec = {
  options: QA_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'files_or_dir...',
};

export function renderQaHelp(): string {
  return formatCommandUsage({
    usage:
      'kinloom narrative-audio qa <files-or-dir...> [--min-duration <sec>] [--max-duration <sec>] [--json]',
    summary:
      'Verify valid MP3/WAV streams, duration bounds, and silence/clipping via ffprobe before R2 upload.',
    options: QA_OPTIONS,
  });
}

function isSupportedAudioExt(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.mp3') || lower.endsWith('.wav');
}

function walkAudioDirectory(dirPath: string, out: string[]): void {
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkAudioDirectory(full, out);
    } else if (entry.isFile() && isSupportedAudioExt(entry.name)) {
      out.push(full);
    }
  }
}

export function collectAudioTargets(
  rawTargets: readonly string[],
  ctx: RecordCommandContext
): readonly string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const rawTarget of rawTargets) {
    const abs = resolveUserPathFromContext(rawTarget, ctx);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new CliValidationError(`Audio path not found: ${rawTarget}`);
    }
    if (stat.isDirectory()) {
      const found: string[] = [];
      walkAudioDirectory(abs, found);
      for (const file of found) {
        if (!seen.has(file)) {
          seen.add(file);
          resolved.push(file);
        }
      }
    } else if (!seen.has(abs)) {
      seen.add(abs);
      resolved.push(abs);
    }
  }

  if (resolved.length === 0) {
    throw new CliValidationError('No .mp3 or .wav files found in the specified path(s).');
  }
  return resolved;
}

function escapeLavfiValue(filePath: string): string {
  return filePath
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
    .replaceAll(',', '\\,');
}

function parseFiniteNumeric(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDbLevel(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? null : value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '-inf' || trimmed === '-infinity') {
    return Number.NEGATIVE_INFINITY;
  }
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatErrorDetail(err: unknown): string {
  if (isPlainRecord(err) && Buffer.isBuffer(err['stderr'])) {
    const text = err['stderr'].toString('utf8').trim();
    if (text) return text;
  }
  return err instanceof Error ? err.message : String(err);
}

function isValidMp3OrWavStream(formatName: string | null, codecName: string | null): boolean {
  const formatTokens = (formatName ?? '')
    .toLowerCase()
    .split(',')
    .map((t) => t.trim());
  const codec = (codecName ?? '').toLowerCase();
  return (
    codec === 'mp3' ||
    formatTokens.includes('mp3') ||
    codec.startsWith('pcm_') ||
    formatTokens.includes('wav')
  );
}

function makeFailedQaResult(filePath: string, issue: string): AudioQaFileResult {
  return {
    file: filePath,
    ok: false,
    format: null,
    codec: null,
    sample_rate: null,
    channels: null,
    duration_seconds: null,
    peak_db: null,
    rms_db: null,
    issues: [issue],
  };
}

export async function probeAudioFile(options: {
  readonly filePath: string;
  readonly thresholds: AudioQaThresholds;
  readonly execFn: ExecFileFn;
  readonly env: NodeJS.ProcessEnv;
}): Promise<AudioQaFileResult> {
  let streamProbeRaw: string;
  try {
    const res = await options.execFn(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', options.filePath],
      { env: options.env }
    );
    streamProbeRaw = res.stdout.toString('utf8');
  } catch (err: unknown) {
    if (isPlainRecord(err) && err['code'] === 'ENOENT') {
      throw new RecordRuntimeError('ffprobe not found on PATH');
    }
    return makeFailedQaResult(options.filePath, `ffprobe failed: ${formatErrorDetail(err)}`);
  }

  let parsedProbe: unknown;
  try {
    parsedProbe = JSON.parse(streamProbeRaw);
  } catch {
    return makeFailedQaResult(options.filePath, 'ffprobe returned invalid JSON');
  }

  if (!isPlainRecord(parsedProbe)) {
    return makeFailedQaResult(options.filePath, 'ffprobe returned unexpected non-object JSON');
  }

  const issues: string[] = [];
  const formatRec = isPlainRecord(parsedProbe['format']) ? parsedProbe['format'] : undefined;
  const formatName =
    formatRec && typeof formatRec['format_name'] === 'string' && formatRec['format_name'].trim()
      ? formatRec['format_name'].trim()
      : null;

  const streams = Array.isArray(parsedProbe['streams']) ? parsedProbe['streams'] : [];
  const audioStream = streams.find(
    (s): s is Record<string, unknown> => isPlainRecord(s) && s['codec_type'] === 'audio'
  );

  let codecName: string | null = null;
  let sampleRate: number | null = null;
  let channels: number | null = null;

  if (!audioStream) {
    issues.push('no audio stream found');
  } else {
    codecName =
      typeof audioStream['codec_name'] === 'string' && audioStream['codec_name'].trim()
        ? audioStream['codec_name'].trim()
        : null;
    sampleRate = parseFiniteNumeric(audioStream['sample_rate']);
    channels = parseFiniteNumeric(audioStream['channels']);

    if (!isValidMp3OrWavStream(formatName, codecName)) {
      issues.push(
        `unsupported audio format/codec (format=${formatName ?? 'unknown'}, codec=${codecName ?? 'unknown'}): expected MP3 or WAV`
      );
    }
    if (sampleRate === null || sampleRate <= 0) {
      issues.push('invalid or missing sample_rate');
    }
    if (channels === null || channels <= 0) {
      issues.push('invalid or missing channels');
    }
  }

  const durationSeconds =
    parseFiniteNumeric(formatRec?.['duration']) ??
    (audioStream ? parseFiniteNumeric(audioStream['duration']) : null);
  if (durationSeconds === null || durationSeconds <= 0) {
    issues.push('missing or non-positive audio duration');
  } else {
    if (durationSeconds < options.thresholds.minDurationSeconds) {
      issues.push(
        `duration ${durationSeconds.toFixed(2)}s is below minimum ${options.thresholds.minDurationSeconds}s`
      );
    }
    if (durationSeconds > options.thresholds.maxDurationSeconds) {
      issues.push(
        `duration ${durationSeconds.toFixed(2)}s exceeds maximum ${options.thresholds.maxDurationSeconds}s`
      );
    }
  }

  let peakDb: number | null = null;
  let rmsDb: number | null = null;

  if (audioStream) {
    try {
      const astatsRes = await options.execFn(
        'ffprobe',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `amovie=${escapeLavfiValue(options.filePath)},astats=metadata=1:reset=0`,
          '-show_entries',
          'frame_tags=lavfi.astats.Overall.Peak_level,lavfi.astats.Overall.RMS_level',
          '-of',
          'json',
        ],
        { env: options.env }
      );
      const parsedStats: unknown = JSON.parse(astatsRes.stdout.toString('utf8'));
      const frames =
        isPlainRecord(parsedStats) && Array.isArray(parsedStats['frames']) ? parsedStats['frames'] : [];
      let lastTags: Record<string, unknown> | undefined;
      for (let i = frames.length - 1; i >= 0; i -= 1) {
        const frame = frames[i];
        if (isPlainRecord(frame) && isPlainRecord(frame['tags'])) {
          lastTags = frame['tags'];
          break;
        }
      }
      if (!lastTags) {
        issues.push('astats returned no audio level metadata');
      } else {
        peakDb = parseDbLevel(lastTags['lavfi.astats.Overall.Peak_level']);
        rmsDb = parseDbLevel(lastTags['lavfi.astats.Overall.RMS_level']);

        if (peakDb === Number.NEGATIVE_INFINITY || rmsDb === Number.NEGATIVE_INFINITY) {
          issues.push('audio is completely silent');
        } else {
          if (rmsDb !== null && rmsDb < options.thresholds.minRmsDb) {
            issues.push(
              `audio is near-silent (RMS ${rmsDb.toFixed(1)} dBFS < ${options.thresholds.minRmsDb} dBFS)`
            );
          }
          if (peakDb !== null && peakDb >= options.thresholds.maxPeakDb) {
            issues.push(
              `audio is clipping (peak ${peakDb.toFixed(2)} dBFS >= ${options.thresholds.maxPeakDb} dBFS)`
            );
          }
        }
      }
    } catch (err: unknown) {
      if (isPlainRecord(err) && err['code'] === 'ENOENT') {
        throw new RecordRuntimeError('ffprobe not found on PATH');
      }
      issues.push(`silence/clipping probe failed: ${formatErrorDetail(err)}`);
    }
  }

  return {
    file: options.filePath,
    ok: issues.length === 0,
    format: formatName,
    codec: codecName,
    sample_rate: sampleRate,
    channels,
    duration_seconds: durationSeconds,
    peak_db: peakDb !== null && Number.isFinite(peakDb) ? peakDb : null,
    rms_db: rmsDb !== null && Number.isFinite(rmsDb) ? rmsDb : null,
    issues,
  };
}

export async function runQa(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, QA_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderQaHelp()) };
  }

  const minDurationSeconds = getNumberOption(parsed, 'minDuration') ?? DEFAULT_QA_MIN_DURATION;
  const maxDurationSeconds = getNumberOption(parsed, 'maxDuration') ?? DEFAULT_QA_MAX_DURATION;
  const minRmsDb = getNumberOption(parsed, 'minRmsDb') ?? DEFAULT_QA_MIN_RMS_DB;
  const maxPeakDb = getNumberOption(parsed, 'maxPeakDb') ?? DEFAULT_QA_MAX_PEAK_DB;
  const jsonOutput = getBooleanOption(parsed, 'json');

  if (minDurationSeconds > maxDurationSeconds) {
    throw new CliValidationError(
      `--min-duration (${minDurationSeconds}) must be less than or equal to --max-duration (${maxDurationSeconds}).`
    );
  }

  const targets = collectAudioTargets(parsed.positionals, ctx);

  if (ctx.execFileImpl === undefined && findExecutableOnPath('ffprobe', ctx.env) === null) {
    throw new RecordRuntimeError('ffprobe not found on PATH');
  }
  const execFn = ctx.execFileImpl ?? defaultExecFile;
  const thresholds: AudioQaThresholds = {
    minDurationSeconds,
    maxDurationSeconds,
    minRmsDb,
    maxPeakDb,
  };

  const results: AudioQaFileResult[] = [];
  for (const filePath of targets) {
    results.push(await probeAudioFile({ filePath, thresholds, execFn, env: ctx.env }));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const summary: AudioQaSummary = {
    ok: failed === 0,
    mode: 'qa',
    total: results.length,
    passed,
    failed,
    min_duration: minDurationSeconds,
    max_duration: maxDurationSeconds,
    min_rms_db: minRmsDb,
    max_peak_db: maxPeakDb,
    files: results,
  };

  const bytesOut = jsonOutput
    ? emitJsonStdout(ctx.io, summary)
    : emitStdout(
        ctx.io,
        [
          `Narrative Audio QA: ${passed}/${results.length} passed (${failed} failed)`,
          ...results.map((r) =>
            r.ok
              ? `  PASS  ${r.file} (${Number(r.duration_seconds).toFixed(1)}s, ${r.codec}, peak ${Number(r.peak_db).toFixed(1)} dBFS, rms ${Number(r.rms_db).toFixed(1)} dBFS)`
              : `  FAIL  ${r.file}: ${r.issues.join('; ')}`
          ),
        ].join('\n')
      );

  return { exitCode: failed === 0 ? 0 : 1, bytesOut };
}
