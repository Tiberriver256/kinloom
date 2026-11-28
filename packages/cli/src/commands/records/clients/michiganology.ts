import { CliValidationError } from '../../../errors.js';
import { resolveSubcommandAlias } from '../runtime/args.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './michiganology/cliSpecs.js';
import { runCollections, runDownload, runGet, runSearch, runUrl } from './michiganology/commands.js';
import { SUBCOMMAND_ALIASES } from './michiganology/domain.js';

export {
  COLLECTIONS,
  type MichiganologySearchItem,
  parseItemHtml,
  parseSearchHtml,
  sanitizeServerFilename,
  validateMichiganologyUrl,
} from './michiganology/domain.js';

export const runMichiganologyCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [rawSubcmd = '', ...rest] = args;
    const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);

    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'get':
        return await runGet(rest, ctx);
      case 'download':
        return await runDownload(rest, ctx);
      case 'collections':
        return runCollections(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(
          `No such command '${rawSubcmd}'. Run 'kinloom michiganology --script-help'.`
        );
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
