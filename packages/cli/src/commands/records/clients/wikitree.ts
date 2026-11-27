import { CliValidationError } from '../../../errors.js';
import { resolveSubcommandAlias } from '../runtime/args.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp, SUBCOMMAND_ALIASES } from './wikitree/cliSpecs.js';
import { runAncestors, runBio, runPerson, runSearch } from './wikitree/commands.js';

export { normalizeProfileKey, resolveSearchName } from './wikitree/domain.js';

export const runWikitreeCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const subcmd = resolveSubcommandAlias(args[0], SUBCOMMAND_ALIASES);
    const rest = args.slice(1);
    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'person':
        return await runPerson(rest, ctx);
      case 'ancestors':
        return await runAncestors(rest, ctx);
      case 'bio':
        return await runBio(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${args[0]}'. Run 'kinloom wikitree --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
