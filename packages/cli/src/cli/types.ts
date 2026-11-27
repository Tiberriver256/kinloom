import { type ParseArgsConfig, parseArgs } from 'node:util';
import { type CliExitCode, CliValidationError, EXIT_ERROR } from '../errors.js';
import type { KinloomCliPlugin } from '../plugins.js';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface RunCliOptions {
  io?: CliIo;
  fetchImpl?: typeof fetch;
  cwd?: string;
  plugins?: readonly KinloomCliPlugin[];
}

export interface CliDispatchContext {
  io: CliIo;
  rawIo?: CliIo;
  cwd: string;
  fetchImpl?: typeof fetch;
  plugins?: readonly KinloomCliPlugin[];
}

export const DEFAULT_IO: CliIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export function requireStringFlag(value: string | undefined, flagName: string): string {
  if (!value?.trim()) {
    throw new CliValidationError(`Missing required option \`${flagName}\`.`);
  }
  return value.trim();
}

export function parseOptionalPositiveInt(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new CliValidationError(`Option \`${flagName}\` must be a positive integer.`);
  }
  return parsed;
}

export function parseOptionalPositiveNumber(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliValidationError(`Option \`${flagName}\` must be a positive number.`);
  }
  return parsed;
}

export function safeParseArgs<const T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(message);
  }
}

export function writeRenderedOutput(io: CliIo, rendered: string): void {
  const trimmed = rendered.replace(/\r?\n$/, '');
  if (trimmed.length > 0) {
    io.stdout(trimmed);
  }
}

export function normalizeExitCode(code: number): CliExitCode {
  if (code === 0 || code === 1 || code === 2 || code === 3) {
    return code;
  }
  return EXIT_ERROR;
}
