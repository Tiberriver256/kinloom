import { performance } from 'node:perf_hooks';
import { isTelemetrySuppressedByParent, type OpsIo, recordTelemetryEvent } from '../ops/telemetry.js';
import { classifyRecordCommandIntent, renderRecordCommandHelp } from './help.js';
import { resolveRecordCommand } from './registry.js';
import type { ResolveRootsOptions } from './resolve.js';
import { buildTelemetrySubcmd, executeLegacyScriptCommand, type RecordSpawnFn } from './runner.js';
import { createRecordContext, DEFAULT_RECORD_IO, type ExecFileFn } from './runtime/types.js';

export interface RunRecordCommandOptions extends ResolveRootsOptions {
  io?: OpsIo;
  spawnImpl?: RecordSpawnFn;
  fetchImpl?: typeof fetch;
  execFileImpl?: ExecFileFn;
  sleepFn?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  telemetryFilePath?: string;
  forceTelemetry?: boolean;
}

export interface RunRecordCommandResult {
  readonly command: string;
  readonly mode: 'guide' | 'script' | 'native';
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
    const rendered = renderRecordCommandHelp(spec, options);
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

  if (spec.kind === 'skill-guide') {
    throw new Error(`Guide-only command '${spec.command}' cannot execute a script.`);
  }

  if (spec.kind === 'native') {
    const ctx = createRecordContext({
      io,
      env: options?.env ?? process.env,
      cwd: options?.cwd ?? process.cwd(),
      fetchImpl: options?.fetchImpl ?? globalThis.fetch,
      execFileImpl: options?.execFileImpl,
      sleepFn: options?.sleepFn,
      nowMs: options?.nowMs,
    });
    const outcome = await spec.handler(intent.scriptArgs, ctx);
    if (shouldRecordTelemetry) {
      recordTelemetryEvent(
        {
          cmd: `records:${spec.command}`,
          subcmd: buildTelemetrySubcmd(spec, intent.scriptArgs, 'script'),
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

  return executeLegacyScriptCommand(spec, intent.scriptArgs, options, startMs, shouldRecordTelemetry, io);
}
