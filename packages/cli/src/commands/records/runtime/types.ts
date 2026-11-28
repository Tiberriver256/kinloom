import type { ExecFileOptions } from 'node:child_process';
import type { OpsIo } from '../../ops/telemetry.js';

export interface ExecFileResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: ExecFileOptions
) => Promise<ExecFileResult>;

export interface RecordCommandContext {
  readonly io: OpsIo;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly execFileImpl?: ExecFileFn | undefined;
  readonly sleepFn: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
}

export interface RecordCommandOutcome {
  readonly exitCode: number;
  readonly bytesOut: number;
  readonly cacheHit?: boolean | undefined;
}

export type RecordHandler = (
  args: readonly string[],
  ctx: RecordCommandContext
) => Promise<RecordCommandOutcome>;

export class RecordRuntimeError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'RecordRuntimeError';
    this.exitCode = exitCode;
  }
}

export const DEFAULT_RECORD_IO: OpsIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createRecordContext(
  overrides: { [K in keyof RecordCommandContext]?: RecordCommandContext[K] | undefined } = {}
): RecordCommandContext {
  return {
    io: overrides.io ?? DEFAULT_RECORD_IO,
    env: overrides.env ?? process.env,
    cwd: overrides.cwd ?? process.cwd(),
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    execFileImpl: overrides.execFileImpl,
    sleepFn: overrides.sleepFn ?? defaultSleep,
    nowMs: overrides.nowMs ?? (() => Date.now()),
  };
}

export function emitStdout(io: OpsIo, text: string): number {
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  io.stdout(normalized);
  return Buffer.byteLength(`${normalized}\n`, 'utf8');
}

export function emitJsonStdout(io: OpsIo, value: unknown, indent = 2): number {
  const serialized = JSON.stringify(value, null, indent);
  io.stdout(serialized);
  return Buffer.byteLength(`${serialized}\n`, 'utf8');
}
