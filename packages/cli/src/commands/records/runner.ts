import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { recordTelemetryEvent, type OpsIo } from '../ops/telemetry.js';
import type {
  AssetScriptCommandSpec,
  RecordCommandSpec,
  SkillScriptCommandSpec,
} from './registry.js';
import { resolveRecordScriptPath, type ResolveRootsOptions } from './resolve.js';

export interface ScriptInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export type RecordSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface LegacyRunnerOptions extends ResolveRootsOptions {
  io?: OpsIo;
  spawnImpl?: RecordSpawnFn;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  telemetryFilePath?: string;
  forceTelemetry?: boolean;
}

export interface LegacyScriptResult {
  readonly command: string;
  readonly mode: 'script';
  readonly exitCode: number;
  readonly bytesOut: number;
}

function readFirstLine(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(256);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const snippet = buf.toString('utf8', 0, bytesRead);
    const nlIndex = snippet.indexOf('\n');
    return (nlIndex === -1 ? snippet : snippet.slice(0, nlIndex)).trim();
  } finally {
    fs.closeSync(fd);
  }
}

export function resolveScriptInvocation(
  scriptPath: string,
  scriptArgs: readonly string[]
): ScriptInvocation {
  const firstLine = readFirstLine(scriptPath);
  if (firstLine.startsWith('#!')) {
    const shebang = firstLine.slice(2).trim();
    const tokens = shebang.split(/\s+/).filter(Boolean);

    if (tokens.includes('uv') && tokens.includes('run')) {
      const uvIdx = tokens.indexOf('uv');
      const uvArgs = tokens.slice(uvIdx + 1);
      return {
        command: 'uv',
        args: [...uvArgs, scriptPath, ...scriptArgs],
      };
    }

    const pyIdx = tokens.findIndex((t) => t === 'python3' || t.endsWith('/python3'));
    if (pyIdx !== -1) {
      const pyFlags = tokens.slice(pyIdx + 1);
      return {
        command: 'python3',
        args: [...pyFlags, scriptPath, ...scriptArgs],
      };
    }
  }

  return {
    command: scriptPath,
    args: [...scriptArgs],
  };
}

const SAFE_SUBCMD_TOKEN_RE = /^[a-z][a-z0-9_-]*$/i;

/** Full JSON.parse above this size would stall the process on a large stdout. */
const CACHE_HIT_PARSE_MAX_BYTES = 256 * 1024;
const CACHE_HIT_EDGE_BYTES = 8 * 1024;
const UV_OFFLINE_STDERR_TAIL_BYTES = 8 * 1024;

const UV_OFFLINE_CACHE_MISS_PATTERNS: readonly RegExp[] = [
  /packages were unavailable because the network was disabled/i,
  /when the network is disabled,\s*registry packages may only be read from the cache/i,
  /network connectivity is disabled,\s*but the requested data wasn't found in the cache/i,
  /no solution found when resolving (?:script|`--with`) dependencies/i,
  /no interpreter found\b.*\buv is set to offline mode/i,
  /cannot perform a network request in offline mode/i,
];

export function isUvOfflineCacheMiss(stderr: string): boolean {
  if (stderr.length === 0) {
    return false;
  }
  const normalized = stderr.replace(/\s+/g, ' ');
  return UV_OFFLINE_CACHE_MISS_PATTERNS.some((pattern) => pattern.test(normalized));
}

class StderrTailWindow {
  private tail: Buffer = Buffer.alloc(0);

  push(buf: Buffer): void {
    if (buf.length === 0) {
      return;
    }
    if (buf.length >= UV_OFFLINE_STDERR_TAIL_BYTES) {
      this.tail = buf.subarray(buf.length - UV_OFFLINE_STDERR_TAIL_BYTES);
      return;
    }
    const combined = this.tail.length === 0 ? buf : Buffer.concat([this.tail, buf]);
    this.tail =
      combined.length > UV_OFFLINE_STDERR_TAIL_BYTES
        ? combined.subarray(combined.length - UV_OFFLINE_STDERR_TAIL_BYTES)
        : combined;
  }

  text(): string {
    return this.tail.toString('utf8');
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function startsLikeJson(text: string): boolean {
  const sample = text.slice(0, 64).replace(/^\uFEFF/, '');
  for (let i = 0; i < sample.length; i += 1) {
    const ch = sample[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      continue;
    }
    return ch === '{' || ch === '[';
  }
  return false;
}

function booleanCacheHitField(record: Record<string, unknown>): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'cache_hit')) {
    return undefined;
  }
  const hit = record.cache_hit;
  return typeof hit === 'boolean' ? hit : undefined;
}

function readCacheHitValue(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    const flags: boolean[] = [];
    for (const item of value) {
      if (!isJsonRecord(item)) {
        continue;
      }
      const hit = booleanCacheHitField(item);
      if (hit !== undefined) {
        flags.push(hit);
      }
    }
    if (flags.length === 0) {
      return undefined;
    }
    return flags.every((flag) => flag);
  }
  if (!isJsonRecord(value)) {
    return undefined;
  }
  return booleanCacheHitField(value);
}

function matchCacheHitLiteral(text: string): boolean | undefined {
  const re = /"cache_hit"\s*:\s*(true|false)\b/g;
  let last: string | undefined;
  for (const match of text.matchAll(re)) {
    last = match[1];
  }
  if (last === 'true') {
    return true;
  }
  if (last === 'false') {
    return false;
  }
  return undefined;
}

/**
 * Read a top-level boolean cache_hit from record-command JSON.
 * Non-JSON and binary stdout return undefined. Outputs larger than
 * CACHE_HIT_PARSE_MAX_BYTES are scanned only at the head and the tail.
 */
export function extractRecordCacheHit(stdout: string): boolean | undefined {
  if (stdout.length === 0 || !startsLikeJson(stdout)) {
    return undefined;
  }
  if (Buffer.byteLength(stdout) > CACHE_HIT_PARSE_MAX_BYTES) {
    const edge =
      stdout.length <= CACHE_HIT_EDGE_BYTES * 2
        ? stdout
        : stdout.slice(0, CACHE_HIT_EDGE_BYTES) + stdout.slice(-CACHE_HIT_EDGE_BYTES);
    return matchCacheHitLiteral(edge);
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    return readCacheHitValue(parsed);
  } catch {
    return undefined;
  }
}

class CacheHitWindow {
  private total = 0;
  private overflow = false;
  private chunks: Buffer[] = [];
  private held = 0;
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);

  push(buf: Buffer): void {
    this.total += buf.length;
    if (!this.overflow) {
      this.chunks.push(buf);
      this.held += buf.length;
      if (this.held > CACHE_HIT_PARSE_MAX_BYTES) {
        const all = Buffer.concat(this.chunks);
        this.head = all.subarray(0, CACHE_HIT_EDGE_BYTES);
        this.tail = all.subarray(Math.max(0, all.length - CACHE_HIT_EDGE_BYTES));
        this.chunks = [];
        this.overflow = true;
      }
      return;
    }
    const combined = Buffer.concat([this.tail, buf]);
    this.tail =
      combined.length > CACHE_HIT_EDGE_BYTES
        ? combined.subarray(combined.length - CACHE_HIT_EDGE_BYTES)
        : combined;
  }

  finish(): boolean | undefined {
    if (this.total === 0) {
      return undefined;
    }
    if (!this.overflow) {
      return extractRecordCacheHit(Buffer.concat(this.chunks).toString('utf8'));
    }
    const headText = this.head.toString('utf8');
    if (!startsLikeJson(headText)) {
      return undefined;
    }
    return matchCacheHitLiteral(headText + this.tail.toString('utf8'));
  }
}

function asBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function isSafeSubcmdToken(token: string | undefined): token is string {
  return Boolean(token && SAFE_SUBCMD_TOKEN_RE.test(token));
}

function extractOcrTelemetryMode(args: readonly string[]): string | undefined {
  let mode: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--mode') {
      const next = args[i + 1];
      if (isSafeSubcmdToken(next)) {
        mode = next.toLowerCase();
      }
      i += 1;
    } else if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (isSafeSubcmdToken(value)) {
        mode = value.toLowerCase();
      }
    }
  }
  return mode;
}

export function buildTelemetrySubcmd(
  spec: RecordCommandSpec,
  args: readonly string[],
  mode: 'guide' | 'script'
): string {
  if (mode === 'guide') {
    return `${spec.command} help`;
  }
  if (spec.command === 'ocr') {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return 'ocr';
    }
    const ocrMode = extractOcrTelemetryMode(args) ?? 'printed';
    return `ocr ${ocrMode}`;
  }
  const firstArg = args[0];
  if (isSafeSubcmdToken(firstArg)) {
    return `${spec.command} ${firstArg}`;
  }
  return spec.command;
}

function formatSpawnErrorMessage(
  err: NodeJS.ErrnoException,
  invocation: ScriptInvocation,
  commandName: string
): string {
  if (err.code === 'ENOENT') {
    if (invocation.command === 'uv') {
      return `Error: 'uv' is required to run 'kinloom ${commandName}' (install uv from https://docs.astral.sh/uv/).`;
    }
    if (invocation.command === 'python3') {
      return `Error: 'python3' is required to run 'kinloom ${commandName}'.`;
    }
    return `Error: executable '${invocation.command}' not found for 'kinloom ${commandName}'.`;
  }
  return `Error: failed to launch 'kinloom ${commandName}': ${err.message}`;
}

interface SpawnAttemptResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: boolean;
  readonly bytesOut: number;
  readonly cacheHit: boolean | undefined;
  readonly stderrTail: string;
  readonly capturedStdout: string;
  readonly capturedStderr: string;
}

function executeSpawnAttempt(params: {
  spawnFn: RecordSpawnFn;
  invocation: ScriptInvocation;
  commandName: string;
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  captureOutput: boolean;
  inspectStderr: boolean;
  io: OpsIo;
}): Promise<SpawnAttemptResult> {
  const { spawnFn, invocation, commandName, cwd, env, captureOutput, inspectStderr, io } = params;
  return new Promise<SpawnAttemptResult>((resolve) => {
    let bytesOut = 0;
    const cacheHitWindow = new CacheHitWindow();
    const stderrTail = inspectStderr ? new StderrTailWindow() : undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawnFn(invocation.command, [...invocation.args], {
      cwd,
      env,
      stdio:
        captureOutput || inspectStderr
          ? ['inherit', 'pipe', 'pipe']
          : ['inherit', 'pipe', 'inherit'],
    });

    const forwardSigInt = () => {
      if (!child.killed) {
        child.kill('SIGINT');
      }
    };
    const forwardSigTerm = () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    };

    process.on('SIGINT', forwardSigInt);
    process.on('SIGTERM', forwardSigTerm);

    const cleanupSignals = () => {
      process.off('SIGINT', forwardSigInt);
      process.off('SIGTERM', forwardSigTerm);
    };

    const resolveExitCode = (code: number | null, signal: NodeJS.Signals | null): number => {
      if (typeof code === 'number') {
        return code;
      }
      if (signal === 'SIGINT') {
        return 130;
      }
      if (signal === 'SIGTERM') {
        return 143;
      }
      return 1;
    };

    if (captureOutput) {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const buf = asBuffer(chunk);
        bytesOut += buf.length;
        stdoutChunks.push(buf);
        cacheHitWindow.push(buf);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const buf = asBuffer(chunk);
        stderrChunks.push(buf);
        stderrTail?.push(buf);
      });
    } else {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const buf = asBuffer(chunk);
        bytesOut += buf.length;
        cacheHitWindow.push(buf);
        if (!process.stdout.write(buf)) {
          child.stdout?.pause();
          process.stdout.once('drain', () => {
            child.stdout?.resume();
          });
        }
      });
      if (inspectStderr) {
        child.stderr?.on('data', (chunk: Buffer | string) => {
          const buf = asBuffer(chunk);
          stderrTail?.push(buf);
          if (!process.stderr.write(buf)) {
            child.stderr?.pause();
            process.stderr.once('drain', () => {
              child.stderr?.resume();
            });
          }
        });
      }
    }

    child.on('close', (code, signal) => {
      cleanupSignals();
      resolve({
        exitCode: resolveExitCode(code, signal),
        signal,
        spawnError: false,
        bytesOut,
        cacheHit: cacheHitWindow.finish(),
        stderrTail: stderrTail?.text() ?? '',
        capturedStdout: captureOutput ? Buffer.concat(stdoutChunks).toString('utf8') : '',
        capturedStderr: captureOutput ? Buffer.concat(stderrChunks).toString('utf8') : '',
      });
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanupSignals();
      io.stderr(formatSpawnErrorMessage(err, invocation, commandName));
      resolve({
        exitCode: 1,
        signal: null,
        spawnError: true,
        bytesOut,
        cacheHit: undefined,
        stderrTail: '',
        capturedStdout: '',
        capturedStderr: '',
      });
    });
  });
}

export async function executeLegacyScriptCommand(
  spec: SkillScriptCommandSpec | AssetScriptCommandSpec,
  scriptArgs: readonly string[],
  options: LegacyRunnerOptions | undefined,
  startMs: number,
  shouldRecordTelemetry: boolean,
  io: OpsIo
): Promise<LegacyScriptResult> {
  const scriptPath = resolveRecordScriptPath(spec, options);
  const invocation = resolveScriptInvocation(scriptPath, scriptArgs);
  const spawnFn: RecordSpawnFn = options?.spawnImpl ?? spawn;
  const captureOutput = options?.io !== undefined;

  const callerEnv: NodeJS.ProcessEnv = options?.env ?? process.env;
  const childBaseEnv: NodeJS.ProcessEnv = {
    ...callerEnv,
    KINLOOM_TELEMETRY_ACTIVE: '1',
    KINLOOM_TELEMETRY_PARENT: '1',
  };
  const tryOfflineFirst = invocation.command === 'uv' && callerEnv.UV_OFFLINE === undefined;

  const firstAttemptEnv: NodeJS.ProcessEnv = tryOfflineFirst
    ? { ...childBaseEnv, UV_OFFLINE: '1' }
    : childBaseEnv;

  let finalAttempt = await executeSpawnAttempt({
    spawnFn,
    invocation,
    commandName: spec.command,
    cwd: options?.cwd,
    env: firstAttemptEnv,
    captureOutput,
    inspectStderr: tryOfflineFirst,
    io,
  });

  if (
    tryOfflineFirst &&
    !finalAttempt.spawnError &&
    finalAttempt.signal === null &&
    finalAttempt.exitCode !== 0 &&
    finalAttempt.bytesOut === 0 &&
    isUvOfflineCacheMiss(finalAttempt.stderrTail)
  ) {
    const retryEnv: NodeJS.ProcessEnv = { ...childBaseEnv };
    delete retryEnv.UV_OFFLINE;
    finalAttempt = await executeSpawnAttempt({
      spawnFn,
      invocation,
      commandName: spec.command,
      cwd: options?.cwd,
      env: retryEnv,
      captureOutput,
      inspectStderr: false,
      io,
    });
  }

  if (captureOutput && !finalAttempt.spawnError) {
    if (finalAttempt.capturedStdout.length > 0) {
      io.stdout(finalAttempt.capturedStdout.replace(/\r?\n$/, ''));
    }
    if (finalAttempt.capturedStderr.length > 0) {
      io.stderr(finalAttempt.capturedStderr.replace(/\r?\n$/, ''));
    }
  }

  const { exitCode, bytesOut, cacheHit } = finalAttempt;

  if (shouldRecordTelemetry) {
    recordTelemetryEvent(
      {
        cmd: `records:${spec.command}`,
        subcmd: buildTelemetrySubcmd(spec, scriptArgs, 'script'),
        duration_ms: performance.now() - startMs,
        exit_code: exitCode,
        bytes_out: bytesOut,
        cache_hit: cacheHit,
      },
      { filePath: options?.telemetryFilePath, force: options?.forceTelemetry }
    );
  }

  return {
    command: spec.command,
    mode: 'script',
    exitCode,
    bytesOut,
  };
}

export {
  runRecordCommand,
  type RunRecordCommandOptions,
  type RunRecordCommandResult,
} from './dispatch.js';
