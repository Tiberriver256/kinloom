#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dispatchCoreCommand } from './cli/coreCommands.js';
import { dispatchLiveAndUtilityCommand } from './cli/liveAndUtilityCommands.js';
import {
  dispatchPluginOrUnknownCommand,
  loadSitePlugins,
  ROOT_HELP,
  runGuideCliCommand,
  tryDispatchRecordCommand,
  tryHandleCommandHelpOrGuideFlag,
  tryHandleHelpInvocation,
} from './cli/pluginAndGuideCommands.js';
import { dispatchResearchOpsCommand } from './cli/researchOpsCommands.js';
import { type CliDispatchContext, type CliIo, DEFAULT_IO, type RunCliOptions } from './cli/types.js';
import {
  type CliExitCode,
  CliValidationError,
  EXIT_ERROR,
  formatConflictDetails,
  KinloomApiError,
} from './errors.js';

export { type CliIo, ROOT_HELP, type RunCliOptions };

export async function runCli(argv: readonly string[], options?: RunCliOptions): Promise<CliExitCode> {
  const io = options?.io ?? DEFAULT_IO;
  const ctx: CliDispatchContext = {
    io,
    rawIo: options?.io,
    cwd: options?.cwd ?? process.cwd(),
    fetchImpl: options?.fetchImpl,
    plugins: options?.plugins,
  };

  const loadedPlugins = await loadSitePlugins(ctx.cwd, io, options?.plugins);

  const rootHelpExit = tryHandleHelpInvocation(argv, io, loadedPlugins.merged);
  if (rootHelpExit !== undefined) {
    return rootHelpExit;
  }

  const [command, ...rest] = argv;

  // Dispatch record, archive-search, guide, and scan/OCR commands before generic --help parsing
  // so subcommand --help (e.g. `kinloom ia grep --help`) and `--script-help` pass through intact.
  const recordExit = await tryDispatchRecordCommand(command, rest, ctx);
  if (recordExit !== undefined) {
    return recordExit;
  }

  const commandHelpOrGuideExit = tryHandleCommandHelpOrGuideFlag(command, rest, io, loadedPlugins.merged);
  if (commandHelpOrGuideExit !== undefined) {
    return commandHelpOrGuideExit;
  }

  try {
    if (command === 'guide') {
      return runGuideCliCommand(rest, io);
    }

    const coreExit = await dispatchCoreCommand(command, rest, ctx);
    if (coreExit !== undefined) {
      return coreExit;
    }

    const researchOpsExit = await dispatchResearchOpsCommand(command, rest, ctx);
    if (researchOpsExit !== undefined) {
      return researchOpsExit;
    }

    const liveOrUtilityExit = await dispatchLiveAndUtilityCommand(command, rest, ctx);
    if (liveOrUtilityExit !== undefined) {
      return liveOrUtilityExit;
    }

    return await dispatchPluginOrUnknownCommand(command, rest, ctx, loadedPlugins);
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      io.stderr(`Validation error: ${err.message}`);
      for (const issue of err.issues) {
        io.stderr(`  - ${issue}`);
      }
      return err.exitCode;
    }

    if (err instanceof KinloomApiError) {
      io.stderr(`API error (${err.status} ${err.code}): ${err.message}`);
      if (err.conflict) {
        io.stderr(formatConflictDetails(err.conflict));
      }
      return err.exitCode;
    }

    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${message}`);
    return EXIT_ERROR;
  }
}

function isExecutedDirectly(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryArg);
  } catch {
    return fileURLToPath(import.meta.url) === entryArg;
  }
}

if (isExecutedDirectly()) {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
    throw err;
  });
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
