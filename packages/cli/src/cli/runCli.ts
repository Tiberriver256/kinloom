import {
  type CliExitCode,
  CliValidationError,
  EXIT_ERROR,
  formatConflictDetails,
  KinloomApiError,
} from '../errors.js';
import { type CliIo, DEFAULT_IO } from '../io.js';
import { CliPluginValidationError } from '../plugins.js';
import { dispatchBuiltInCliCommand, ROOT_HELP } from './builtinCommands.js';
import {
  dispatchPluginOrUnknownCommand,
  loadSitePlugins,
  tryDispatchRecordCommand,
  tryHandleCommandHelpOrGuideFlag,
  tryHandleHelpInvocation,
} from './pluginAndGuideCommands.js';
import type { CliDispatchContext, RunCliOptions } from './types.js';

export { type CliIo, DEFAULT_IO, ROOT_HELP, type RunCliOptions };

export async function runCli(argv: readonly string[], options?: RunCliOptions): Promise<CliExitCode> {
  const io = options?.io ?? DEFAULT_IO;
  const ctx: CliDispatchContext = {
    io,
    rawIo: options?.io,
    cwd: options?.cwd ?? process.cwd(),
    fetchImpl: options?.fetchImpl,
    plugins: options?.plugins,
    screenshotBrowserFactory: options?.screenshotBrowserFactory,
    execWrangler: options?.execWrangler,
  };

  try {
    const loadedPlugins = await loadSitePlugins(ctx.cwd, io, options?.plugins);

    const rootHelpExit = tryHandleHelpInvocation(argv, io, loadedPlugins.merged);
    if (rootHelpExit !== undefined) {
      return rootHelpExit;
    }

    const [command = '', ...rest] = argv;

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

    const builtInExit = await dispatchBuiltInCliCommand(command, rest, ctx);
    if (builtInExit !== undefined) {
      return builtInExit;
    }

    return await dispatchPluginOrUnknownCommand(command, rest, ctx, loadedPlugins);
  } catch (err: unknown) {
    if (err instanceof CliPluginValidationError) {
      io.stderr(`Plugin validation error: ${err.message}`);
      return err.exitCode;
    }

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
