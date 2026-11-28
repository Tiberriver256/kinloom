import { CliValidationError } from '../../../errors.js';
import { resolveSubcommandAlias } from '../runtime/args.js';
import { isBrokenPipeError } from '../runtime/primitives.js';
import {
  emitStdout,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
} from '../runtime/types.js';
import {
  renderDownloadHelp,
  renderRootHelp,
  renderSearchHelp,
  renderShowHelp,
  renderUrlHelp,
  SUBCOMMAND_ALIASES,
} from './openarchieven/cliSpecs.js';
import { runDownload, runSearch, runShow, runUrl } from './openarchieven/commands.js';

export { validateApiUrl, validateScanUrl } from './openarchieven/domain.js';
export { searchWindow } from './openarchieven/transport.js';

function renderSubcommandHelpByName(rawSubcmd: string | undefined): string {
  if (!rawSubcmd) {
    return renderRootHelp();
  }
  const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);
  switch (subcmd) {
    case 'search':
      return renderSearchHelp();
    case 'show':
      return renderShowHelp();
    case 'download':
      return renderDownloadHelp();
    case 'url':
      return renderUrlHelp();
    default:
      throw new CliValidationError(`No such command '${rawSubcmd}'. Run 'kinloom openarchieven --help'.`);
  }
}

export const runOpenarchievenCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [rawSubcmd = '', ...rest] = args;
    const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);
    switch (subcmd) {
      case 'help':
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelpByName(rest[0])) };
      case 'search':
        return await runSearch(rest, ctx);
      case 'show':
        return await runShow(rest, ctx);
      case 'download':
        return await runDownload(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${rawSubcmd}'. Run 'kinloom openarchieven --help'.`);
    }
  } catch (err: unknown) {
    if (isBrokenPipeError(err)) {
      return { exitCode: 0, bytesOut: 0 };
    }
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof RecordRuntimeError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: err.exitCode, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
