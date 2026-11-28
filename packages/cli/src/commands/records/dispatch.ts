import { performance } from 'node:perf_hooks';
import { isTelemetrySuppressedByParent, type OpsIo, recordTelemetryEvent } from '../ops/telemetry.js';
import { classifyRecordCommandIntent, formatRecordCommandsHelp, renderRecordCommandHelp } from './help.js';
import {
  RECORD_COMMAND_CATEGORIES,
  RECORD_COMMAND_SPECS,
  type RecordCommandSpec,
  resolveRecordCommand,
} from './registry.js';
import {
  createRecordContext,
  DEFAULT_RECORD_IO,
  type ExecFileFn,
  emitJsonStdout,
  emitStdout,
} from './runtime/types.js';

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

export function formatRecordsDiscoveryHelp(): string {
  return `Usage: kinloom records [command] [args...]

Discover or invoke all federal, state, international, directory, and media/OCR record commands.

${formatRecordCommandsHelp()}

Examples:
  kinloom records                                List all record commands by category
  kinloom records --help                         Show this usage and command catalog
  kinloom records --json                         Emit the record command catalog as JSON
  kinloom records nara aad --help                Forward directly to \`kinloom nara aad --help\`
  kinloom records openarchieven search --help    Forward directly to \`kinloom openarchieven search --help\`

Options:
  --json      Emit the grouped record command catalog as JSON
  -h, --help  Show this help message`;
}

export function buildRecordsCatalogJson(): {
  readonly categories: readonly { readonly id: string; readonly heading: string }[];
  readonly commands: readonly {
    readonly command: string;
    readonly aliases: readonly string[];
    readonly category: string;
    readonly kind: 'native' | 'guide-only';
    readonly summary: string;
  }[];
} {
  return {
    categories: RECORD_COMMAND_CATEGORIES.map((cat) => ({ id: cat.id, heading: cat.heading })),
    commands: RECORD_COMMAND_SPECS.map((spec) => ({
      command: spec.command,
      aliases: [...spec.aliases],
      category: spec.category,
      kind: spec.kind,
      summary: spec.summary,
    })),
  };
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
  const io = options?.io ?? DEFAULT_RECORD_IO;
  if (commandName.trim() === 'records') {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      const bytesOut = emitStdout(io, formatRecordsDiscoveryHelp());
      return { command: 'records', mode: 'guide', exitCode: 0, bytesOut };
    }
    if (args.length === 1 && args[0] === '--json') {
      const bytesOut = emitJsonStdout(io, buildRecordsCatalogJson());
      return { command: 'records', mode: 'native', exitCode: 0, bytesOut };
    }
    const target = args[0];
    if (target !== undefined && !target.startsWith('-')) {
      return runRecordCommand(target, args.slice(1), options);
    }
    io.stderr(`Unknown option '${target ?? ''}'. Run \`kinloom records --help\` for available commands.`);
    return { command: 'records', mode: 'guide', exitCode: 2, bytesOut: 0 };
  }

  const spec = resolveRecordCommand(commandName);
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
