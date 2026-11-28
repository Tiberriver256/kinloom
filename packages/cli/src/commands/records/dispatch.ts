import { performance } from 'node:perf_hooks';
import { isTelemetrySuppressedByParent, type OpsIo, recordTelemetryEvent } from '../ops/telemetry.js';
import { classifyRecordCommandIntent, renderRecordCommandHelp } from './help.js';
import { type RecordCommandSpec, resolveRecordCommand } from './registry.js';
import { createRecordContext, DEFAULT_RECORD_IO, type ExecFileFn } from './runtime/types.js';

const SAFE_SUBCMD_TOKEN_RE = /^[a-z][a-z0-9_-]*$/i;

function isSafeSubcmdToken(token: string | undefined): token is string {
  return Boolean(token && SAFE_SUBCMD_TOKEN_RE.test(token));
}

function extractOcrTelemetryMode(args: readonly string[]): string | undefined {
  let mode: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
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
  mode: 'guide' | 'native'
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

export interface RunRecordCommandOptions {
  io?: OpsIo | undefined;
  fetchImpl?: typeof fetch | undefined;
  execFileImpl?: ExecFileFn | undefined;
  sleepFn?: ((ms: number) => Promise<void>) | undefined;
  nowMs?: (() => number) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  telemetryFilePath?: string;
  forceTelemetry?: boolean;
}

export interface RunRecordCommandResult {
  readonly command: string;
  readonly mode: 'guide' | 'native';
  readonly exitCode: number;
  readonly bytesOut: number;
}

export async function runRecordCommand(
  commandName: string,
  args: readonly string[],
  options?: RunRecordCommandOptions
): Promise<RunRecordCommandResult> {
  const spec = resolveRecordCommand(commandName);
  const io = options?.io ?? DEFAULT_RECORD_IO;
  if (!spec) {
    io.stderr(`Unknown record command '${commandName}'.`);
    return {
      command: commandName,
      mode: 'guide',
      exitCode: 2,
      bytesOut: 0,
    };
  }

  const startMs = performance.now();
  const intent = classifyRecordCommandIntent(spec, args);
  const shouldRecordTelemetry = Boolean(options?.forceTelemetry) || !isTelemetrySuppressedByParent();

  if (intent.mode === 'render-guide') {
    const rendered = renderRecordCommandHelp(spec);
    io.stdout(rendered);
    const bytesOut = Buffer.byteLength(`${rendered}\n`, 'utf8');
    if (shouldRecordTelemetry) {
      recordTelemetryEvent(
        {
          cmd: `records:${spec.command}`,
          subcmd: buildTelemetrySubcmd(spec, args, 'guide'),
          duration_ms: performance.now() - startMs,
          exit_code: 0,
          bytes_out: bytesOut,
        },
        { filePath: options?.telemetryFilePath, force: options?.forceTelemetry }
      );
    }
    return {
      command: spec.command,
      mode: 'guide',
      exitCode: 0,
      bytesOut,
    };
  }

  if (spec.kind === 'guide-only') {
    throw new Error(`Guide-only command '${spec.command}' cannot execute a handler.`);
  }

  const ctx = createRecordContext({
    io,
    env: options?.env ?? process.env,
    cwd: options?.cwd ?? process.cwd(),
    fetchImpl: options?.fetchImpl ?? globalThis.fetch,
    execFileImpl: options?.execFileImpl,
    sleepFn: options?.sleepFn,
    nowMs: options?.nowMs,
  });
  const handler = await spec.loadHandler();
  const outcome = await handler(intent.scriptArgs, ctx);
  if (shouldRecordTelemetry) {
    recordTelemetryEvent(
      {
        cmd: `records:${spec.command}`,
        subcmd: buildTelemetrySubcmd(spec, intent.scriptArgs, 'native'),
        duration_ms: performance.now() - startMs,
        exit_code: outcome.exitCode,
        bytes_out: outcome.bytesOut,
        cache_hit: outcome.cacheHit,
      },
      { filePath: options?.telemetryFilePath, force: options?.forceTelemetry }
    );
  }
  return {
    command: spec.command,
    mode: 'native',
    exitCode: outcome.exitCode,
    bytesOut: outcome.bytesOut,
  };
}
